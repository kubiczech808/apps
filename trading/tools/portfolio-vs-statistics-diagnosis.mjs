// Read-only diagnostic. Writes nothing, places nothing.
//
// Reported: league-of-legends shows 90.5% accuracy and +13.9% ROI in the tag statistics
// while the portfolio itself is an extreme failure. Either the statistics are inflated, the
// portfolio is picking the wrong subset of what they measure, or the two are measuring
// different things entirely.
//
// The decisive question is what price each one assumes. A market observation carries only
// Gamma's outcome price -- firstMarketProbability, effectively a mid -- and no orderbook at
// all, so the statistics simulate buying at the mid and paying a fee. The portfolio walks
// the real ask ladder (simulateMarketBuy) or rests a limit order, so it pays the ask plus
// slippage. On esports markets whose spreads run 30-55 points that is not a rounding
// difference.
//
// Every closed trade records both numbers: marketProbability (what the statistics would
// have used) and entryPrice (what was actually paid). So this reprices the portfolio's own
// realised trades at the statistics' price, keeping the outcomes fixed. If that alone flips
// the result, the gap is execution and not selection -- and no threshold banding or volume
// filter would have found it.
const HOST = process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading";
const STRATEGY_ID = process.env.PAPER_DIAGNOSIS_STRATEGY_ID || "leagueoflegends";

async function fetchJson(url, attempts = 2) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      const text = await response.text();
      try {
        return { ok: response.ok, status: response.status, body: JSON.parse(text) };
      } catch {
        return { ok: false, status: response.status, error: text.slice(0, 200) };
      }
    } catch (error) {
      if (attempt < attempts) continue;
      return { ok: false, status: 0, error: `read failed: ${error?.message || error}` };
    }
  }
  return { ok: false, status: 0, error: "read failed" };
}

const WON_STATUSES = new Set(["WON"]);
const LOST_STATUSES = new Set(["LOST", "STOP_LOSS", "STOP_GAP"]);
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
const avg = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
const pct = (value) => (value == null ? "  n/a " : `${(value * 100).toFixed(1)}%`);
const usd = (value) => (value == null ? "n/a" : `$${value.toFixed(2)}`);

async function main() {
  console.log(`Portfolio versus statistics for ${STRATEGY_ID} at ${new Date().toISOString()}\n`);

  const config = await fetchJson(`${HOST}/api.php?action=portfolio-config`);
  const row = config.ok ? ((config.body?.config?.paper || {})[STRATEGY_ID] || null) : null;
  if (row) {
    console.log(`-- configuration --`);
    for (const key of [
      "displayName", "selectionMetric", "selectionOrder", "minProbability", "marketType",
      "maxResolutionDays", "minLiquidityUsdc", "minNetYield", "useLimitOrders",
      "stopLossEnabled", "allowRotation", "stakeUsdc", "maxFraction",
    ]) {
      console.log(`   ${key.padEnd(22)} ${row[key] ?? "-"}`);
    }
  }

  const served = await fetchJson(
    `${HOST}/api.php?action=state&target=paper&summary=dashboard&strategy_id=${encodeURIComponent(STRATEGY_ID)}`,
  );
  if (!served.ok) {
    console.log(`\n!! served state HTTP ${served.status} ${served.error || ""}`);
    return;
  }
  const entry = (served.body?.paperPortfolios || {})[STRATEGY_ID] || {};
  const portfolio = entry.portfolio || {};
  const trades = Array.isArray(entry.trades) ? entry.trades : [];
  const closed = trades.filter((trade) => WON_STATUSES.has(String(trade.status || ""))
    || LOST_STATUSES.has(String(trade.status || "")));

  console.log(`\n-- the portfolio as it actually traded --`);
  console.log(`   equity=${portfolio.equityUsdc ?? "-"} initial=${portfolio.initialUsdc ?? "-"}`
    + ` realized=${portfolio.realizedPnlUsdc ?? "-"} open=${portfolio.openPnlUsdc ?? "-"}`);
  console.log(`   closed trades: ${closed.length}`);
  if (!closed.length) return;

  const wins = closed.filter((trade) => WON_STATUSES.has(String(trade.status || "")));
  const realized = closed.reduce((sum, trade) => sum + (num(trade.realizedPnlUsdc) || 0), 0);
  const invested = closed.reduce((sum, trade) => sum + (num(trade.totalCostUsdc) ?? num(trade.stakeUsdc) ?? 0), 0);
  console.log(`   accuracy   : ${wins.length} / ${closed.length}`
    + ` (${((wins.length / closed.length) * 100).toFixed(1)}%)`);
  console.log(`   invested   : ${usd(invested)}   realized P/L: ${usd(realized)}`
    + `   ROI: ${invested ? pct(realized / invested) : "n/a"}`);

  // The two prices, side by side. The statistics enter at the mid; the portfolio paid the
  // ask through the ladder.
  const mids = closed.map((trade) => num(trade.marketProbability)).filter((value) => value != null);
  const entries = closed.map((trade) => num(trade.entryPrice)).filter((value) => value != null);
  const spreads = closed.map((trade) => num(trade.spread)).filter((value) => value != null);
  const slippages = closed.map((trade) => num(trade.slippage)).filter((value) => value != null);
  console.log(`\n-- what each side assumes it paid --`);
  console.log(`   avg mid (marketProbability, what the statistics use): ${pct(avg(mids))}`);
  console.log(`   avg entry actually paid (entryPrice)               : ${pct(avg(entries))}`);
  const gap = avg(entries) != null && avg(mids) != null ? avg(entries) - avg(mids) : null;
  console.log(`   gap paid over the mid                              : ${gap == null ? "n/a" : `${(gap * 100).toFixed(1)} points`}`);
  console.log(`   avg quoted spread=${pct(avg(spreads))} avg slippage=${pct(avg(slippages))}`);

  // The counterfactual: the portfolio's own trades and outcomes, priced the way the
  // statistics price them. Same stake, same fee model, same win/loss -- only the entry
  // differs. Whatever this recovers is the execution gap and nothing else.
  let repricedPnl = 0;
  let repricedCost = 0;
  let comparable = 0;
  for (const trade of closed) {
    const mid = num(trade.marketProbability);
    const stake = num(trade.stakeUsdc) ?? 5;
    if (mid == null || !(mid > 0) || !(mid < 1)) continue;
    comparable += 1;
    const feeRate = Math.max(0, num(trade.feeRate) || 0);
    const shares = stake / mid;
    const fee = shares * feeRate * mid * (1 - mid);
    const cost = stake + fee;
    repricedCost += cost;
    repricedPnl += WON_STATUSES.has(String(trade.status || "")) ? shares - cost : -cost;
  }
  console.log(`\n-- the same trades, the same outcomes, priced at the mid --`);
  console.log(`   comparable trades: ${comparable} of ${closed.length}`);
  console.log(`   repriced invested : ${usd(repricedCost)}   repriced P/L: ${usd(repricedPnl)}`
    + `   ROI: ${repricedCost ? pct(repricedPnl / repricedCost) : "n/a"}`);
  console.log(`   difference from what actually happened: ${usd(repricedPnl - realized)}`);

  // Limit orders only fill when the market comes down to the resting price, which is
  // precisely when the news has gone against the position. If the fills cluster on losers,
  // that is adverse selection and it is invisible to a statistic that assumes a market buy.
  console.log(`\n-- how each position was entered --`);
  const byFill = new Map();
  for (const trade of closed) {
    const key = `${trade.executionMode || "?"} / filledBy=${trade.filledBy || "-"}`;
    const bucket = byFill.get(key) || { total: 0, won: 0, pnl: 0 };
    bucket.total += 1;
    if (WON_STATUSES.has(String(trade.status || ""))) bucket.won += 1;
    bucket.pnl += num(trade.realizedPnlUsdc) || 0;
    byFill.set(key, bucket);
  }
  for (const [key, bucket] of [...byFill].sort((a, b) => b[1].total - a[1].total)) {
    console.log(`   ${key.padEnd(40)} n=${String(bucket.total).padStart(4)}`
      + ` won=${String(bucket.won).padStart(4)} (${((bucket.won / bucket.total) * 100).toFixed(1)}%)`
      + ` pnl=${usd(bucket.pnl)}`);
  }

  // Liquidity and volume of what the portfolio really bought, against the statistics' own
  // average -- the reported suspicion that a minimum-volume filter is missing.
  const liq = closed.map((trade) => num(trade.liquidity)).filter((value) => value != null);
  const vol = closed.map((trade) => num(trade.volume24hr)).filter((value) => value != null);
  console.log(`\n-- liquidity and volume of what was actually bought --`);
  console.log(`   avg liquidity=${usd(avg(liq))} median=${usd(liq.sort((a, b) => a - b)[Math.floor(liq.length / 2)])}`);
  console.log(`   avg volume24hr=${usd(avg(vol))} median=${usd(vol.sort((a, b) => a - b)[Math.floor(vol.length / 2)])}`);

  // Where the portfolio's entries actually sit relative to its own floor. A floor plus
  // "highest reward/risk first" is not a neutral sample of everything above the floor:
  // reward per dollar risked is greatest on the cheapest, least likely outcome, so the rule
  // buys at the floor by construction.
  {
    const floor = num(row?.minProbability);
    const entered = closed.map((trade) => num(trade.entryPrice)).filter((value) => value != null);
    console.log(`\n-- where the entries sit above the ${pct(floor)} floor --`);
    const bands = [[0.5, 0.6], [0.6, 0.65], [0.65, 0.7], [0.7, 0.8], [0.8, 0.9], [0.9, 1.01]];
    for (const [low, high] of bands) {
      const inBand = closed.filter((trade) => {
        const value = num(trade.entryPrice);
        return value != null && value >= low && value < high;
      });
      if (!inBand.length) continue;
      const bandWins = inBand.filter((trade) => WON_STATUSES.has(String(trade.status || ""))).length;
      const bandPnl = inBand.reduce((sum, trade) => sum + (num(trade.realizedPnlUsdc) || 0), 0);
      console.log(`   ${pct(low)}-${pct(high)}: n=${String(inBand.length).padStart(3)}`
        + ` won=${String(bandWins).padStart(3)} (${((bandWins / inBand.length) * 100).toFixed(1)}%)`
        + ` pnl=${usd(bandPnl)}`);
    }
    if (entered.length && floor != null) {
      const nearFloor = entered.filter((value) => value < floor + 0.05).length;
      console.log(`   within 5 points of the floor: ${nearFloor} of ${entered.length}`
        + ` (${((nearFloor / entered.length) * 100).toFixed(1)}%)`);
    }
  }

  // The volume the gate actually saw. rowVolumeUsdc prefers lifetime volume over 24h
  // volume, so a fixture that traded heavily weeks ago but is dead now clears a
  // "minimum volume" gate on history alone.
  {
    console.log(`\n-- what the ${row?.minLiquidityUsdc ?? "-"} volume gate was satisfied by --`);
    const rows = closed.map((trade) => ({
      lifetime: num(trade.volumeUsdc),
      day: num(trade.volume24hr),
      liq: num(trade.liquidity),
    }));
    const med = (values) => {
      const clean = values.filter((value) => value != null).sort((a, b) => a - b);
      return clean.length ? clean[Math.floor(clean.length / 2)] : null;
    };
    console.log(`   median lifetime volumeUsdc: ${usd(med(rows.map((item) => item.lifetime)))}`);
    console.log(`   median volume24hr         : ${usd(med(rows.map((item) => item.day)))}`);
    console.log(`   median liquidity          : ${usd(med(rows.map((item) => item.liq)))}`);
    const gate = num(row?.minLiquidityUsdc);
    if (gate != null) {
      const dayBelow = rows.filter((item) => item.day != null && item.day < gate).length;
      console.log(`   traded under the gate in the last 24h: ${dayBelow} of ${rows.length}`
        + ` -- these cleared it on lifetime volume, not on current activity`);
    }
  }

  // And the statistics row the report is about, for the same tag.
  const report = served.body?.latestCalculationReport;
  const tagRows = Array.isArray(report?.tagSummaries) ? report.tagSummaries : [];
  const matching = tagRows
    .filter((tagRow) => String(tagRow.tag || "").toLowerCase().includes("league"))
    .sort((a, b) => Number(b.resolved) - Number(a.resolved));
  console.log(`\n-- the statistics rows for this tag --`);
  if (!matching.length) console.log(`   no league tag row in the report (${tagRows.length} tag rows total)`);
  for (const tagRow of matching.slice(0, 8)) {
    console.log(`   ${String(tagRow.tag).padEnd(22)} floor=${pct(tagRow.threshold)}`
      + ` resolved=${String(tagRow.resolved).padStart(5)} wins=${String(tagRow.wins).padStart(5)}`
      + ` winRate=${pct(tagRow.winRate)} avgEntry=${pct(tagRow.avgProbability)}`
      + ` roi=${tagRow.roi ?? "-"} avgVolume=${usd(num(tagRow.avgVolumeUsdc))}`);
  }

  // The comparison that settles it. A threshold row is a floor, so its win rate belongs to
  // everything above that floor -- which averages far higher than the floor itself. The
  // band the portfolio actually buys in can be recovered by differencing adjacent floors:
  // rows at 60% and 65% differ by exactly the trades entered in [60%, 65%). No archive
  // fetch needed, and it says what a 60-65% entry really wins at.
  {
    const params = (Array.isArray(report?.parameterSummaries) ? report.parameterSummaries : [])
      .filter((paramRow) => paramRow.marketType === "all" && Number(paramRow.maxResolutionDays) === 7);
    const byThreshold = new Map();
    for (const paramRow of params) byThreshold.set(Number(paramRow.threshold), paramRow);
    const floors = [...byThreshold.keys()].sort((a, b) => a - b);
    console.log(`\n-- floors differenced into bands (marketType=all, maxDays=7) --`);
    if (floors.length < 2) {
      console.log(`   not enough threshold rows to difference (${floors.length})`);
    }
    for (let index = 0; index < floors.length - 1; index += 1) {
      const low = byThreshold.get(floors[index]);
      const high = byThreshold.get(floors[index + 1]);
      const resolved = Number(low.resolved) - Number(high.resolved);
      const wins = Number(low.wins) - Number(high.wins);
      if (!(resolved > 0)) continue;
      console.log(`   entry ${pct(floors[index])}-${pct(floors[index + 1])}:`
        + ` resolved=${String(resolved).padStart(6)} wins=${String(wins).padStart(6)}`
        + ` winRate=${pct(wins / resolved)}`
        + `   (floor row at ${pct(floors[index])} claims ${pct(low.winRate)} over ${low.resolved})`);
    }
  }
}

main().catch((error) => {
  console.log(`\n!! diagnosis stopped early: ${error?.message || error}`);
  process.exitCode = 1;
});
