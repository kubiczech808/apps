// Read-only diagnostic. Places no orders, writes nothing, needs no secrets.
//
// Asked for: the closed trades of a live portfolio running a 25%-of-net-win stop loss,
// and what to set differently so the portfolio is at least as profitable while catching
// the LOST trades that give back the whole stake.
//
// The arithmetic here is not re-derived. It imports the SAME functions the RPi exit worker
// runs -- equalRiskExitPlan, effectiveStopFloor, stopGapFloorPrice, netExitValue -- so a
// number in this report is the number that would actually be in force. Re-implementing the
// stop maths in a diagnosis tool is how a tool comes to describe a system that does not
// exist.
//
// What it can measure, and what it cannot. Closed trades carry the entry, the stake, the
// resolution and the realised P/L, so the loss that a given floor WOULD have capped is
// exact. They do not carry the price path, so "would this winner have been stopped out on
// the way up" is not answerable from them and is reported as exposure rather than as a
// number. The declined-stop annotations are the evidence for what the stop actually did.
import {
  equalRiskExitPlan,
  effectiveStopFloor,
  stopGapFloorPrice,
  netExitValue,
} from "./rpi-live-exit-worker.mjs";

const HOST = process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading";
const PORTFOLIO_MATCH = String(process.env.PORTFOLIO_MATCH || "underway")
  .split(";").map((text) => text.trim().toLowerCase()).filter(Boolean);
const MULTIPLIERS = String(process.env.MULTIPLIER_GRID || "0.25,0.5,0.75,1,1.5,2,3")
  .split(",").map((text) => Number(text.trim())).filter((value) => Number.isFinite(value) && value > 0);
const PROBABILITY_FLOORS = String(process.env.PROBABILITY_FLOOR_GRID || "0,0.35,0.49,0.6,0.7,0.8")
  .split(",").map((text) => Number(text.trim())).filter((value) => Number.isFinite(value) && value >= 0);
const GAP_TOLERANCES = String(process.env.GAP_TOLERANCE_GRID || "0.5,0.7,0.85,1")
  .split(",").map((text) => Number(text.trim())).filter((value) => Number.isFinite(value) && value > 0);
const TRADE_ROWS = Number(process.env.TRADE_ROWS || 80);

async function fetchJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

const num = (value, fallback = null) => {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const usd = (value) => (value == null ? "     -" : `${value < 0 ? "-" : "+"}${Math.abs(value).toFixed(2).padStart(5)}`);
const pct = (value) => (value == null ? "   - " : `${(value * 100).toFixed(1).padStart(5)}%`);
const px = (value) => (value == null ? "  -  " : value.toFixed(4));
const clip = (value, width) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, width).padEnd(width);

// One closed trade, reduced to the fields every question below is answered from.
function normalizeTrade(row) {
  const cost = num(row.totalCostUsdc ?? row.stakeUsdc);
  const shares = num(row.shares ?? row.size);
  const entry = num(row.entryPrice) ?? (cost != null && shares > 0 ? cost / shares : null);
  const exitPrice = num(row.exitPrice ?? row.finalOutcomePrice);
  return {
    question: row.question || row.market || "",
    outcome: row.outcome || "",
    portfolioId: row.portfolioId || "",
    tokenId: String(row.tokenId || row.assetId || ""),
    openedAt: row.openedAt || row.date || null,
    closedAt: row.closedAt || row.resolvedAt || null,
    entry,
    exitPrice,
    shares,
    cost,
    netGainIfWin: num(row.netGainIfWinUsdc) ?? (shares != null && cost != null ? shares - cost : null),
    realizedPnl: num(row.realizedPnlUsdc ?? row.pnlUsdc),
    exitReason: row.exitReason || null,
    exitStopPrice: num(row.exitStopPrice ?? row.stopPrice),
    declineKind: row.declineKind || null,
    unsoldShares: num(row.unsoldShares),
    status: row.status || null,
  };
}

// How a trade ended, in the terms the question is about. `full-stake` is the bucket the
// stop loss exists to empty.
function classify(trade) {
  const cost = trade.cost;
  const pnl = trade.realizedPnl;
  if (cost == null || pnl == null) return "unknown";
  if (pnl > 0.005) return "won";
  if (pnl >= -0.005) return "flat";
  // Within a cent of the whole stake: nothing was recovered.
  if (pnl <= -(cost - 0.01)) return "lost-full";
  return "lost-capped";
}

// What a given setting would put in force for this position, using the worker's own maths.
function floorFor(trade, multiplier, probabilityFloor) {
  const plan = equalRiskExitPlan({
    shares: trade.shares,
    totalCostUsdc: trade.cost,
    netGainIfWinUsdc: trade.netGainIfWin,
    stopLossRiskMultiplier: multiplier,
    feeRate: 0,
    feesEnabled: true,
  });
  const equalRiskFloor = plan.protectable ? plan.stopPrice : null;
  const floor = effectiveStopFloor({
    stopPrice: equalRiskFloor,
    probabilityFloor: probabilityFloor > 0 ? probabilityFloor : null,
  });
  return {
    plan,
    equalRiskFloor,
    floor,
    // Which of the two levels is actually in force. The equal-risk floor moves with the
    // entry; the probability floor does not, which is the whole reason it exists.
    source: floor == null ? "none"
      : (equalRiskFloor != null && floor === equalRiskFloor ? "equal-risk" : "probability"),
  };
}

// The loss a floor caps the trade at, if the sale happens AT the floor.
function lossAtFloor(trade, floor) {
  if (floor == null || trade.shares == null || trade.cost == null) return null;
  const proceeds = netExitValue({ shares: trade.shares, price: floor, feeRate: 0, feesEnabled: true });
  if (proceeds == null) return null;
  return trade.cost - proceeds;
}

async function main() {
  console.log(`Stop-loss tuning diagnosis at ${new Date().toISOString()}`);
  console.log("Read-only: no order is placed, nothing is written, no credentials are used.");
  console.log(`Portfolio match: ${PORTFOLIO_MATCH.join(", ") || "(all)"}\n`);

  // ---------------------------------------------------------------------------------
  console.log("== 1. how every live portfolio's stop loss is configured right now");
  const configPayload = await fetchJson(`${HOST}/api.php?action=portfolio-config&t=${Date.now()}`);
  const config = configPayload?.config || configPayload || {};
  const rows = [
    ["live", config.live],
    ["live5050", config.live5050],
    ...Object.entries(config.livePortfolios || {}).map(([id, row]) => [`live-custom-${id}`, row]),
  ].filter(([, row]) => row && typeof row === "object");

  const matched = [];
  for (const [id, row] of rows) {
    const name = String(row.displayName || id);
    const isMatch = !PORTFOLIO_MATCH.length
      || PORTFOLIO_MATCH.some((needle) => `${name} ${id}`.toLowerCase().includes(needle));
    if (isMatch) matched.push({ id, name, row });
    console.log(`   ${isMatch ? "->" : "  "} ${clip(id, 26)} "${clip(name, 22)}"`
      + `  multiplier ${String(row.stopLossRiskMultiplier ?? "-").padStart(5)}`
      + `  probFloor ${String(row.stopLossProbabilityFloor ?? "-").padStart(5)}`
      + `  closeBid ${String(row.settlementCloseBid ?? "-").padStart(5)}`
      + `  minProb ${String(row.minProbability ?? "-").padStart(5)}`
      + `  stake ${String(row.stakeUsdc ?? "-").padStart(5)}`
      + `  reverse ${row.reverseOnStopLoss === true ? "yes" : "no"}`
      + `  archived ${row.archived === true ? "YES" : "no"}`);
  }
  if (!matched.length) {
    console.log(`\n   !! nothing matched /${PORTFOLIO_MATCH.join("|")}/ -- pass PORTFOLIO_MATCH to pick one of the ids above`);
    return;
  }
  const matchedIds = new Set(matched.map((entry) => entry.id));
  console.log("");

  // ---------------------------------------------------------------------------------
  console.log("== 2. the closed trades of the matched portfolio(s)");
  const statePayload = await fetchJson(`${HOST}/api.php?action=state&target=live&t=${Date.now()}`);
  const live = statePayload?.liveState || statePayload?.state || statePayload || {};
  const allClosed = [
    ...(Array.isArray(live.closedTrades) ? live.closedTrades : []),
    ...(Array.isArray(live.trades?.closed) ? live.trades.closed : []),
  ].map(normalizeTrade);
  const trades = allClosed.filter((trade) => matchedIds.has(trade.portfolioId));
  console.log(`   ${allClosed.length} closed trade(s) on the account, ${trades.length} in the matched portfolio(s)`);
  if (!trades.length) {
    const seen = [...new Set(allClosed.map((trade) => trade.portfolioId || "(none)"))];
    console.log(`   !! portfolioIds present on the closed rows: ${seen.join(", ")}`);
    return;
  }
  const openTimes = trades.map((trade) => trade.openedAt).filter(Boolean).sort();
  console.log(`   opened ${openTimes[0] || "?"} .. ${openTimes[openTimes.length - 1] || "?"}`);

  const buckets = new Map();
  for (const trade of trades) {
    const kind = classify(trade);
    trade.bucket = kind;
    const bucket = buckets.get(kind) || { count: 0, pnl: 0, stake: 0 };
    bucket.count += 1;
    bucket.pnl += trade.realizedPnl || 0;
    bucket.stake += trade.cost || 0;
    buckets.set(kind, bucket);
  }
  console.log("");
  console.log("   outcome        n    total P/L    staked   mean P/L");
  let totalPnl = 0;
  let totalStake = 0;
  for (const kind of ["won", "flat", "lost-capped", "lost-full", "unknown"]) {
    const bucket = buckets.get(kind);
    if (!bucket) continue;
    totalPnl += bucket.pnl;
    totalStake += bucket.stake;
    console.log(`   ${clip(kind, 12)} ${String(bucket.count).padStart(3)}`
      + `    ${usd(bucket.pnl)}    ${bucket.stake.toFixed(2).padStart(6)}`
      + `   ${usd(bucket.pnl / bucket.count)}`);
  }
  console.log(`   ${clip("TOTAL", 12)} ${String(trades.length).padStart(3)}`
    + `    ${usd(totalPnl)}    ${totalStake.toFixed(2).padStart(6)}`
    + `   ${usd(totalPnl / trades.length)}`);
  console.log(`   return on staked capital: ${pct(totalStake > 0 ? totalPnl / totalStake : null)}`);

  const exitReasons = new Map();
  for (const trade of trades) {
    const key = `${trade.exitReason || "(none)"}${trade.declineKind ? ` / ${trade.declineKind}` : ""}`;
    exitReasons.set(key, (exitReasons.get(key) || 0) + 1);
  }
  console.log("\n   how the position was closed, as recorded:");
  for (const [reason, count] of [...exitReasons].sort((a, b) => b[1] - a[1])) {
    console.log(`      ${String(count).padStart(3)}  ${reason}`);
  }
  console.log("");

  // ---------------------------------------------------------------------------------
  const deployed = matched[0].row;
  const liveMultiplier = num(deployed.stopLossRiskMultiplier, 0) || 0;
  const liveFloorSetting = num(deployed.stopLossProbabilityFloor, 0) || 0;
  console.log(`== 3. where the stop sits at the DEPLOYED setting`
    + ` (multiplier ${liveMultiplier}, probability floor ${liveFloorSetting}, gap band ${GAP_TOLERANCES[0]})`);
  console.log("   The window is the only price range a stop can execute in: it triggers at the");
  console.log("   floor and refuses any bid under the gap floor, so a market that jumps straight");
  console.log("   past the window cannot be stopped at all.\n");
  console.log("   bucket       entry   stopFloor  drop  gapFloor  window  riskCap   actual  market");
  const shown = trades.slice(0, TRADE_ROWS);
  for (const trade of shown) {
    const { floor, source } = floorFor(trade, liveMultiplier || 1, liveFloorSetting);
    const gapFloor = floor == null ? null : stopGapFloorPrice(floor, GAP_TOLERANCES[0]);
    const drop = floor != null && trade.entry != null ? trade.entry - floor : null;
    const window = floor != null && gapFloor != null ? floor - gapFloor : null;
    // A floor at or above the entry is not a cap on anything: it liquidates the position
    // when the stop is armed. Printing a negative "risk" for it would read as protection.
    const liquidates = floor != null && trade.entry != null && floor >= trade.entry;
    const loss = lossAtFloor(trade, floor);
    console.log(`   ${clip(trade.bucket, 11)} ${px(trade.entry)}   ${px(floor)}`
      + ` ${drop == null ? "  -  " : (drop * 100).toFixed(1).padStart(5)}`
      + `   ${px(gapFloor)}`
      + ` ${window == null ? "  -  " : (window * 100).toFixed(1).padStart(5)}`
      + `  ${liquidates ? "AT-ONCE" : usd(loss == null ? null : -loss)}`
      + `  ${usd(trade.realizedPnl)}  ${clip(trade.question, 40)} ${source === "probability" ? "[pf]" : ""}`);
  }
  if (trades.length > shown.length) console.log(`   ... ${trades.length - shown.length} more`);
  console.log("");

  // ---------------------------------------------------------------------------------
  console.log("== 4. what a different setting would have capped the LOST trades at");
  console.log("   Exact for the losses: a trade that resolved at 0 passed through every level, so");
  console.log("   the capped loss is arithmetic. NOT a promise it would have executed -- section 5");
  console.log("   is about whether the book was there, and the winners are section 6.\n");
  const lost = trades.filter((trade) => trade.bucket === "lost-full" || trade.bucket === "lost-capped");
  const wonTrades = trades.filter((trade) => trade.bucket === "won");
  const lostPnl = lost.reduce((sum, trade) => sum + (trade.realizedPnl || 0), 0);
  console.log(`   ${lost.length} losing trade(s), ${usd(lostPnl)} between them;`
    + ` ${wonTrades.length} winner(s), ${usd(wonTrades.reduce((sum, t) => sum + (t.realizedPnl || 0), 0))}`);
  console.log("");
  // One setting, priced against every closed trade. Two halves, and only one of them is
  // exact -- which is the whole reason they are reported apart.
  //
  //   The losses ARE exact. A trade that resolved at 0 passed through every level, so a
  //   floor above 0 caps it at arithmetic.
  //
  //   The winners split. A floor at or above the entry sells the position the moment it is
  //   armed, so the win is replaced by that sale -- exact, and usually a large cost. A floor
  //   below the entry only costs anything if the price dipped to it on the way, and closed
  //   trades carry no price path: that half is a BOUND, not a number.
  function evaluate(multiplier, probabilityFloor) {
    let cappedLosses = 0;
    let unprotectable = 0;
    let immediateLosses = 0;
    for (const trade of lost) {
      const { floor } = floorFor(trade, multiplier, probabilityFloor);
      if (floor == null) {
        unprotectable += 1;
        cappedLosses += trade.realizedPnl || 0;
        continue;
      }
      // A floor at or above the entry is not capping a loss: the position is sold as soon as
      // it is armed. Counting the resulting profit as a saving would flatter the setting for
      // a strategy that never holds anything, so the trade contributes nothing instead.
      if (trade.entry != null && floor >= trade.entry) {
        immediateLosses += 1;
        continue;
      }
      cappedLosses += Math.max(-(trade.cost || 0), -(lossAtFloor(trade, floor) ?? 0));
    }
    let winnersKept = 0;
    let winnersSoldAtOnce = 0;
    let soldAtOnceDelta = 0;
    let exposedPnl = 0;
    let exposedDelta = 0;
    let exposed = 0;
    for (const trade of wonTrades) {
      const { floor } = floorFor(trade, multiplier, probabilityFloor);
      const actual = trade.realizedPnl || 0;
      if (floor == null) { winnersKept += 1; continue; }
      if (trade.entry != null && floor >= trade.entry) {
        // Exact: armed above the entry, it sells at the floor instead of winning.
        winnersSoldAtOnce += 1;
        const proceeds = netExitValue({ shares: trade.shares, price: floor, feeRate: 0, feesEnabled: true });
        soldAtOnceDelta += ((proceeds ?? 0) - (trade.cost || 0)) - actual;
        continue;
      }
      // Unknown: it would only have been stopped if the price reached the floor.
      exposed += 1;
      exposedPnl += actual;
      exposedDelta += -(lossAtFloor(trade, floor) ?? 0) - actual;
    }
    const saving = cappedLosses - lostPnl;
    return {
      multiplier, probabilityFloor, cappedLosses, saving, unprotectable, immediateLosses,
      winnersKept, winnersSoldAtOnce, soldAtOnceDelta, exposed, exposedPnl, exposedDelta,
      // No winner ever dipped to its floor.
      best: totalPnl + saving + soldAtOnceDelta,
      // Every winner with a floor below its entry dipped to it and was stopped.
      worst: totalPnl + saving + soldAtOnceDelta + exposedDelta,
    };
  }

  console.log("   mult  probFloor   capped loss   saving   BEST P/L   WORST P/L   unprot  sells-at-once  exposed");
  const scenarios = [];
  for (const multiplier of MULTIPLIERS) {
    for (const probabilityFloor of PROBABILITY_FLOORS) {
      const scenario = evaluate(multiplier, probabilityFloor);
      scenarios.push(scenario);
      console.log(`   ${String(multiplier).padStart(4)}  ${String(probabilityFloor).padStart(9)}`
        + `   ${usd(scenario.cappedLosses)}   ${usd(scenario.saving)}`
        + `   ${usd(scenario.best)}   ${usd(scenario.worst)}`
        + `   ${String(scenario.unprotectable).padStart(6)}`
        + `  ${String(scenario.winnersSoldAtOnce + scenario.immediateLosses).padStart(13)}`
        + `  ${String(scenario.exposed).padStart(7)}`);
    }
  }
  console.log("");
  console.log("   BEST  = losses capped, and no winner ever dipped to its floor.");
  console.log("   WORST = losses capped, and EVERY winner whose floor is below its entry was stopped out.");
  console.log("   sells-at-once = floor at or above the entry: not a stop, it liquidates when armed.");
  console.log(`   actual P/L for comparison: ${usd(totalPnl)}`);
  console.log("");

  // ---------------------------------------------------------------------------------
  console.log("== 5. could the stop have executed? the gap band, measured against the losses");
  console.log("   A stop refuses any bid below tolerance x floor, snapped down to the cent grid.");
  console.log("   Widening the band widens the only window the stop can act in.\n");
  console.log("   mult  probFloor   gap    mean floor   mean gapFloor   mean window");
  for (const multiplier of MULTIPLIERS) {
    for (const probabilityFloor of PROBABILITY_FLOORS) {
      for (const tolerance of GAP_TOLERANCES) {
        const floors = [];
        const gapFloors = [];
        for (const trade of lost) {
          const { floor } = floorFor(trade, multiplier, probabilityFloor);
          if (floor == null) continue;
          floors.push(floor);
          gapFloors.push(stopGapFloorPrice(floor, tolerance) ?? 0);
        }
        if (!floors.length) continue;
        const mean = (list) => list.reduce((sum, value) => sum + value, 0) / list.length;
        const meanFloor = mean(floors);
        const meanGap = mean(gapFloors);
        console.log(`   ${String(multiplier).padStart(4)}  ${String(probabilityFloor).padStart(9)}`
          + `   ${String(tolerance).padStart(4)}   ${px(meanFloor)}       ${px(meanGap)}`
          + `        ${((meanFloor - meanGap) * 100).toFixed(1).padStart(5)}c`);
      }
    }
  }
  console.log("");

  // ---------------------------------------------------------------------------------
  console.log("== 6. what the floor costs the WINNERS");
  console.log("   sold-at-once is exact: the floor is at or above the entry, so the position is");
  console.log("   liquidated when armed and the win never happens. hair-trigger counts the ones");
  console.log("   whose floor is within a tenth of the entry -- ordinary movement reaches those,");
  console.log("   and how often is not measurable from a closed row.\n");
  console.log("   mult  probFloor   winners  sold-at-once  cost of that   hair-trigger  mean drop");
  for (const multiplier of MULTIPLIERS) {
    for (const probabilityFloor of PROBABILITY_FLOORS) {
      const scenario = evaluate(multiplier, probabilityFloor);
      let hairTrigger = 0;
      const drops = [];
      for (const trade of wonTrades) {
        const { floor } = floorFor(trade, multiplier, probabilityFloor);
        if (floor == null || trade.entry == null || floor >= trade.entry) continue;
        const drop = trade.entry - floor;
        drops.push(drop);
        if (drop < trade.entry * 0.1) hairTrigger += 1;
      }
      const mean = (list) => (list.length ? list.reduce((sum, value) => sum + value, 0) / list.length : null);
      const meanDrop = mean(drops);
      console.log(`   ${String(multiplier).padStart(4)}  ${String(probabilityFloor).padStart(9)}`
        + `   ${String(wonTrades.length).padStart(7)}  ${String(scenario.winnersSoldAtOnce).padStart(12)}`
        + `   ${usd(scenario.soldAtOnceDelta)}`
        + `   ${String(hairTrigger).padStart(12)}`
        + `  ${meanDrop == null ? "   - " : `${(meanDrop * 100).toFixed(1).padStart(5)}c`}`);
    }
  }
  console.log("");

  // ---------------------------------------------------------------------------------
  console.log("== 7. what the stop actually did, as the dashboard recorded it");
  const declined = trades.filter((trade) => trade.exitReason === "stop-declined" || trade.declineKind);
  const stopped = trades.filter((trade) => String(trade.exitReason || "").startsWith("stop"));
  console.log(`   ${stopped.length} closed trade(s) carry a stop exit reason, ${declined.length} a decline`);
  for (const trade of [...declined, ...stopped].slice(0, 20)) {
    console.log(`      ${clip(trade.question, 46)} ${clip(trade.outcome, 14)}`
      + ` entry ${px(trade.entry)} exit ${px(trade.exitPrice)} P/L ${usd(trade.realizedPnl)}`
      + ` reason ${trade.exitReason || "-"}${trade.declineKind ? `/${trade.declineKind}` : ""}`);
  }
  // Open positions still carry live decline state, which is the freshest evidence of the
  // band refusing a stop -- a closed row has lost the book it was refused against.
  const openDeclined = (Array.isArray(live.positions) ? live.positions : [])
    .filter((row) => row?.stopDeclined || row?.declineKind || row?.exitReason === "stop-declined");
  if (openDeclined.length) {
    console.log(`\n   open positions currently declining to sell: ${openDeclined.length}`);
    for (const row of openDeclined.slice(0, 12)) {
      console.log(`      ${clip(row.question || row.market, 46)} ${clip(row.outcome, 14)}`
        + ` entry ${px(num(row.entryPrice))} now ${px(num(row.currentPrice))}`
        + ` kind ${row.declineKind || "-"} gapFloor ${row.gapFloor ?? "-"} worstBid ${row.worstBid ?? "-"}`);
    }
  }

  // Ranked on the WORST case, not the best: "at least as profitable" is a floor to clear,
  // and a setting whose downside is unknown has not cleared it. Only settings that liquidate
  // nothing on arming are eligible -- a floor above the entry is a different strategy, not a
  // better stop.
  const eligible = scenarios.filter((scenario) => scenario.unprotectable === 0
    && scenario.winnersSoldAtOnce === 0 && scenario.immediateLosses === 0);
  console.log("\n== 8. settings whose WORST case still beats doing nothing");
  const ranked = eligible.filter((scenario) => scenario.worst >= totalPnl)
    .sort((left, right) => right.worst - left.worst);
  if (!ranked.length) {
    console.log(`   none of the ${eligible.length} eligible setting(s) clears ${usd(totalPnl)}`
      + ` on its worst case; the best worst-case is`
      + ` ${usd(Math.max(...eligible.map((scenario) => scenario.worst)))}`);
  }
  for (const scenario of ranked.slice(0, 8)) {
    console.log(`   multiplier ${String(scenario.multiplier).padStart(4)}`
      + `  probability floor ${String(scenario.probabilityFloor).padStart(5)}`
      + `  ->  worst ${usd(scenario.worst)}  best ${usd(scenario.best)}`
      + `  (actual ${usd(totalPnl)}, ${scenario.exposed} winner(s) exposed)`);
  }
  console.log("\nDone. Nothing was written.");
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
