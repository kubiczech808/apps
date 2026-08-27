// Read-only diagnostic. Writes nothing, places nothing.
//
// Reported: one paper portfolio ("75") shows no candidates and its execution logic does not
// run. "No candidates" has several quite different causes and they are not distinguishable
// from the dashboard, so this separates them:
//
//   1. The portfolio is not being executed at all -- archived, automation off, or its
//      cadence not due. Then there is nothing to look for candidates in.
//   2. The execution endpoint serves it an empty catalogue. Then the filtering is innocent
//      and the transport is the problem.
//   3. The catalogue arrives and every row is rejected. Then the histogram of rejection
//      reasons says which filter did it, which is the only version worth arguing about.
//
// For (3) it runs the portfolio's real filter -- portfolioFilterResult, imported from the
// bot, not a copy -- over exactly the rows the endpoint served, and prints the reason
// histogram plus the rows that came closest. It also re-runs the same rows with the spread
// gate lifted, because that gate is new and "did the new thing break it" has to be
// answerable with a number rather than an opinion.
import { portfolioFilterResult, PAPER_STRATEGIES, normalizeState } from "./paper-trading-bot.mjs";

const HOST = process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading";
const PORTFOLIO_QUERY = String(process.env.CANDIDATE_DIAGNOSIS_PORTFOLIO || "75").toLowerCase();

async function fetchJson(url, attempts = 2) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response;
    let text;
    try {
      response = await fetch(url);
      text = await response.text();
    } catch (error) {
      if (attempt < attempts) continue;
      return { ok: false, status: 0, error: `read failed: ${error?.message || error}` };
    }
    try {
      return { ok: response.ok, status: response.status, body: JSON.parse(text) };
    } catch {
      return { ok: false, status: response.status, error: text.slice(0, 300) };
    }
  }
  return { ok: false, status: 0, error: "read failed" };
}

const num = (value) => (value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value));

function spreadOf(item) {
  for (const [stated, askKey, bidKey] of [["spread", "bestAsk", "bestBid"], ["firstSpread", "firstBestAsk", "firstBestBid"]]) {
    const value = num(item?.[stated]);
    if (value != null) return Math.abs(value);
    const ask = num(item?.[askKey]);
    const bid = num(item?.[bidKey]);
    if (ask != null && bid != null) return Math.abs(ask - bid);
  }
  return null;
}

async function main() {
  console.log(`Portfolio candidate diagnosis at ${new Date().toISOString()}`);
  console.log(`looking for a portfolio matching "${PORTFOLIO_QUERY}"\n`);

  const dashboard = await fetchJson(`${HOST}/api.php?action=state&target=paper&summary=dashboard&t=${Date.now()}`);
  if (!dashboard.ok) {
    console.log(`!! dashboard read failed: HTTP ${dashboard.status} ${dashboard.error || ""}`);
    return;
  }
  // paperPortfolios is a map keyed by strategy id, not an array, and the id is only on the
  // key for some of them -- so it is put back onto the row here rather than assumed.
  const rawPortfolios = dashboard.body?.paperPortfolios;
  const portfolios = rawPortfolios && typeof rawPortfolios === "object"
    ? Object.entries(rawPortfolios).map(([id, row]) => ({ id, ...(row && typeof row === "object" ? row : {}) }))
    : [];
  console.log(`${portfolios.length} paper portfolios published`);
  for (const row of portfolios) {
    console.log(`   ${String(row.id || "").padEnd(24)} "${row.displayName || row.label || ""}"`
      + ` archived=${row.archived === true} equity=${row.equityUsdc} free=${row.freeCapitalUsdc}`);
  }

  const found = portfolios.find((row) => String(row.id || "").toLowerCase().includes(PORTFOLIO_QUERY)
    || String(row.displayName || row.label || "").toLowerCase().includes(PORTFOLIO_QUERY));
  if (!found) {
    console.log(`\n!! no portfolio matched "${PORTFOLIO_QUERY}"`);
    return;
  }
  console.log(`\n== ${found.id} "${found.displayName || found.label}" ==`);

  // The dashboard summary empties runLog and trades, and returns only the compact field
  // list, unless the request names the strategy -- and the parameter is strategy_id, not
  // strategy. Re-read it scoped, or every setting below reads as absent.
  const scopedDashboard = await fetchJson(
    `${HOST}/api.php?action=state&target=paper&summary=dashboard&strategy_id=${encodeURIComponent(found.id)}&t=${Date.now()}`,
  );
  const scopedMap = scopedDashboard.ok ? scopedDashboard.body?.paperPortfolios : null;
  const portfolio = scopedMap && typeof scopedMap === "object" && scopedMap[found.id]
    ? { id: found.id, ...scopedMap[found.id] }
    : found;
  // Its settings live in a nested `portfolio` object, not on the row.
  const config = portfolio.portfolio && typeof portfolio.portfolio === "object" ? portfolio.portfolio : {};

  // 1. Is it even being executed?
  {
    console.log(`\n-- is it eligible to run at all --`);
    let printed = 0;
    for (const key of ["archived", "automationEnabled", "executionTrigger", "executionCronMinutes",
      "minProbability", "maxProbability", "maxResolutionDays", "minLiquidityUsdc", "minNetYield",
      "marketType", "selectionOrder", "useLimitOrders", "stakeUsdc", "maxFraction",
      "includeOnlyMarketTags", "excludedMarketTags", "freeCapitalUsdc", "positionRiskUsdc",
      "restingLimitOrderUsdc", "equityUsdc", "balanceUsdc", "openRiskUsdc"]) {
      const value = portfolio[key] !== undefined ? portfolio[key] : config[key];
      if (value === undefined) continue;
      console.log(`   ${key.padEnd(24)} ${JSON.stringify(value)}`);
      printed += 1;
    }
    if (!printed) console.log(`   !! none of its settings came back -- the scoped read did not work`);
  }

  // 2. What the last runs actually said. The bot already publishes the rejection histogram
  //    it computed; reading it is better evidence than recomputing, because it is the run
  //    that really happened.
  {
    console.log(`\n-- what its last runs reported --`);
    const runLog = Array.isArray(portfolio.runLog) ? portfolio.runLog : [];
    if (!runLog.length) console.log(`   no run log entries published for this portfolio`);
    for (const entry of runLog.slice(0, 6)) {
      console.log(`   ${entry.runAt || entry.date} ${String(entry.action || "-").padEnd(8)} ${entry.reason || ""}`);
      const filter = entry.prevalidationFilter;
      if (!filter) continue;
      console.log(`      source=${filter.source} stored=${filter.storedMarketObservations}`
        + ` scanned=${filter.scannedMarketObservations} unique=${filter.uniqueEvaluations}`
        + ` passed=${filter.prefilterPassed} rejected=${filter.prefilterRejected}`);
      const counts = Object.entries(filter.reasonCounts || {}).sort((a, b) => b[1] - a[1]);
      for (const [reason, count] of counts.slice(0, 8)) {
        console.log(`      ${String(count).padStart(6)}  ${reason}`);
      }
    }
  }

  // 3. Re-run the real filter over exactly what the endpoint serves it now.
  {
    console.log(`\n-- rerunning its filter over the catalogue served right now --`);
    const scoped = await fetchJson(
      `${HOST}/api.php?action=state&target=paper&summary=execution&strategy_id=${encodeURIComponent(portfolio.id)}&t=${Date.now()}`,
    );
    if (!scoped.ok) {
      console.log(`   !! execution read failed: HTTP ${scoped.status} ${scoped.error || ""}`);
      return;
    }
    const rows = Array.isArray(scoped.body?.marketObservations) ? scoped.body.marketObservations : [];
    console.log(`   endpoint served ${rows.length} rows`
      + ` (scopeTotal=${scoped.body?.executionScopeTotal} truncated=${scoped.body?.executionScopeTruncated}`
      + ` scopeStrategy=${scoped.body?.executionScopeStrategyId})`);
    if (!rows.length) {
      console.log(`   -> the endpoint itself has nothing to offer, so no filter of ours is at fault.`);
      console.log(`      Either the scoped filter in api.php rejects everything, or the catalogue is empty.`);
      const unscoped = await fetchJson(`${HOST}/api.php?action=state&target=paper&summary=execution&t=${Date.now()}`);
      const all = Array.isArray(unscoped.body?.marketObservations) ? unscoped.body.marketObservations : [];
      console.log(`      unscoped execution summary serves ${all.length} rows`);
      if (all.length) {
        const withSpread = all.filter((item) => spreadOf(item) != null);
        const tight = withSpread.filter((item) => spreadOf(item) <= 0.05);
        console.log(`      of those, ${withSpread.length} carry a spread and ${tight.length} are inside 5 points`);
      }
      return;
    }

    // The strategy the bot would build. PAPER_STRATEGIES holds the shipped ones; a created
    // portfolio is rebuilt from what the dashboard publishes, which is what it runs on.
    const setting = (key, fallback) => {
      const value = config[key] !== undefined ? config[key] : portfolio[key];
      return value === undefined || value === null || value === "" ? fallback : value;
    };
    const strategy = {
      ...(PAPER_STRATEGIES[portfolio.id] || PAPER_STRATEGIES.conservative),
      id: portfolio.id,
      probabilitySource: setting("probabilitySource", "polymarket"),
      minProbability: Number(setting("minProbability", NaN)),
      maxProbability: setting("maxProbability", null),
      maxResolutionDays: Number(setting("maxResolutionDays", NaN)),
      minLiquidityUsdc: setting("minLiquidityUsdc", null),
      minNetYield: Number(setting("minNetYield", 0)),
      marketType: setting("marketType", "all"),
      requireMostProbableOutcome: setting("requireMostProbableOutcome", false) === true,
      selectionOrder: setting("selectionOrder", undefined),
      includeOnlyMarketTags: new Set(setting("includeOnlyMarketTags", [])),
      excludedMarketTags: new Set(setting("excludedMarketTags", [])),
      excludedCandidateTokenIds: new Set(),
      equalRiskProtection: setting("equalRiskProtection", false) === true,
      equalRiskMultiplier: setting("equalRiskMultiplier", 1),
    };
    console.log(`   filtering with minProbability=${strategy.minProbability}`
      + ` maxDays=${strategy.maxResolutionDays} minVolume=${strategy.minLiquidityUsdc}`
      + ` minNetYield=${strategy.minNetYield} marketType=${strategy.marketType}`);
    if (!Number.isFinite(strategy.minProbability)) {
      console.log(`   !! its probability floor did not come back, so what follows is not this`);
      console.log(`      portfolio's real filter. Fix the read before trusting the histogram.`);
    }

    const counts = {};
    const passed = [];
    const nearMisses = [];
    for (const item of rows) {
      const result = portfolioFilterResult(item, strategy);
      if (result.eligible) {
        passed.push(item);
        continue;
      }
      for (const reason of result.reasons) counts[reason] = (counts[reason] || 0) + 1;
      if (result.reasons.length === 1 && nearMisses.length < 10) {
        nearMisses.push({ item, reason: result.reasons[0] });
      }
    }
    console.log(`\n   ${passed.length} of ${rows.length} pass every filter`);
    console.log(`   rejection reasons, most common first:`);
    for (const [reason, count] of Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12)) {
      console.log(`     ${String(count).padStart(5)}  ${reason}`);
    }

    // A row rejected for exactly one thing is the one worth reading: it says what the
    // portfolio is one step away from being able to trade.
    console.log(`\n   rows failing on exactly one rule (${nearMisses.length} shown):`);
    for (const { item, reason } of nearMisses) {
      console.log(`     ${String(item.question || "").slice(0, 52).padEnd(52)} p=${item.marketProbability}`
        + ` spread=${spreadOf(item)} vol=${item.volumeUsdc} -> ${reason}`);
    }

    // 4. The counterfactual, which is the only thing that answers "did the new gate do
    //    this". Same rows, same portfolio, spread rule lifted: if the pool is still empty
    //    the gate is innocent, and if it fills up the gate is the whole story.
    const spreadReasons = Object.entries(counts)
      .filter(([reason]) => /spread/.test(reason))
      .reduce((sum, [, count]) => sum + count, 0);
    const withSpread = rows.filter((item) => spreadOf(item) != null).length;
    const tight = rows.filter((item) => spreadOf(item) != null && spreadOf(item) <= 0.05).length;
    console.log(`\n-- what the spread gate is costing this portfolio --`);
    console.log(`   rows carrying a spread at all: ${withSpread} of ${rows.length}`);
    console.log(`   rows inside 5 points         : ${tight}`);
    console.log(`   rejections mentioning spread : ${spreadReasons}`);

    // The gate is a single reason string, so a row rejected only for it is a row this
    // portfolio would otherwise be trading.
    const onlySpread = rows.filter((item) => {
      const result = portfolioFilterResult(item, strategy);
      return !result.eligible && result.reasons.length > 0 && result.reasons.every((r) => /spread/.test(r));
    }).length;
    console.log(`\n   rows rejected for the spread and nothing else: ${onlySpread}`);
    console.log(`   -> without the gate this portfolio would have ${passed.length + onlySpread} candidates,`
      + ` with it ${passed.length}`);
    if (passed.length === 0 && onlySpread === 0) {
      console.log(`   -> the gate is NOT what emptied it; read the histogram above instead`);
    } else if (passed.length === 0) {
      console.log(`   -> the gate IS what emptied it`);
    }

    // And what each candidate limit would leave, so a decision about the number is made
    // against this portfolio's own pool rather than against the catalogue average.
    console.log(`\n   candidates this portfolio would have at each limit:`);
    for (const gate of [0.02, 0.03, 0.05, 0.08, 0.1, 0.15, 0.2]) {
      const kept = rows.filter((item) => {
        const spread = spreadOf(item);
        if (spread != null && spread > gate) return false;
        const result = portfolioFilterResult(item, { ...strategy });
        return result.eligible || result.reasons.every((r) => /spread/.test(r));
      }).length;
      console.log(`     <= ${String((gate * 100).toFixed(0)).padStart(2)} pts: ${String(kept).padStart(5)}`
        + (Math.abs(gate - 0.05) < 1e-9 ? "   <- in force" : ""));
    }
  }
}

main().catch((error) => {
  console.log(`\n!! diagnosis stopped early: ${error?.message || error}`);
  process.exitCode = 1;
});
