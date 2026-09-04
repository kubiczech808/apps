// Read-only diagnostic. Writes nothing, publishes nothing, needs no secrets.
//
// Reported, on counter-strike-2 and asked of every other paper portfolio too:
//
//   Action: SKIP
//   Reason: No order placed: no candidate passed this portfolio's current rules.
//   Note:   No counter-strike-2 trade was opened: no candidates passed counter-strike-2
//           portfolio filters.
//
// That message names no rule, but the bot already recorded which one. storedExecutionShortlist
// runs portfolioFilterResult over the whole candidate pool and keeps `reasonCounts`, a
// histogram of every rejection reason, in the run's batchLog.prevalidationFilter. So this
// reads the published run log rather than re-deriving anything: what it reports is what the
// bot decided at that moment.
//
// The distinction that matters when reading the output: a portfolio rejecting candidates on
// PRICE, EDGE or RETURN is working -- the market simply is not offering what it asks for,
// and that resolves itself. A portfolio whose every candidate dies on the same structural
// gate (a tag it cannot carry, a market type nothing matches, a horizon no market has) is
// stopped by its own configuration and will never trade until that is changed.
const HOST = process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading";
const ONLY = process.env.PAPER_DIAGNOSIS_STRATEGY_ID || "";
const RUNS_TO_READ = Number(process.env.PAPER_DIAGNOSIS_RUNS || 6);

const text = (value) => String(value == null ? "" : value).trim();

async function fetchJson(url) {
  const response = await fetch(url);
  const body = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 140)}`);
  return JSON.parse(body);
}

// Collapse the numbers so shapes group: "probability 62.0% below 70.0%" and "probability
// 41.0% below 70.0%" are one finding, not two hundred.
const shapeOf = (reason) => text(reason).replace(/-?\d[\d.,]*/g, "N");

// Which reasons are a configuration dead end rather than a market that did not suit today.
function isStructural(shape) {
  return /included tags|excluded tag|market type|over\/under|most probable|resolution|horizon|days/i.test(shape);
}

async function main() {
  console.log(`Paper portfolio skip reasons at ${new Date().toISOString()}`);
  console.log(`Read-only: nothing is written, no credentials are used.\n`);

  const config = await fetchJson(`${HOST}/api.php?action=portfolio-config&t=${Date.now()}`).catch(() => null);
  const paper = config?.config?.paper || {};
  const ids = Object.keys(paper).filter((id) => !ONLY || id === ONLY);
  if (!ids.length) {
    console.log(`no paper portfolios returned under config.paper${ONLY ? ` matching "${ONLY}"` : ""}.`);
    return;
  }
  console.log(`${ids.length} paper portfolio(s): ${ids.join(", ")}\n`);

  const stuck = [];
  for (const id of ids) {
    const settings = paper[id] || {};
    const label = text(settings.label) || id;
    let state = null;
    try {
      state = await fetchJson(
        `${HOST}/api.php?action=state&target=paper&summary=dashboard`
        + `&strategy_id=${encodeURIComponent(id)}&t=${Date.now()}`,
      );
    } catch (error) {
      console.log(`== ${label} (${id})\n   state unavailable: ${error.message}\n`);
      continue;
    }

    const portfolio = state?.paperPortfolios?.[id] || {};
    const runLog = Array.isArray(portfolio.runLog) ? portfolio.runLog : [];
    console.log(`== ${label} (${id})`);
    console.log(`   automation ${settings.automationEnabled ? "on" : "OFF"}`
      + `   archived ${settings.archived ? "yes" : "no"}`
      + `   cron ${settings.executionCronMinutes ?? "-"} min`
      + `   run log ${runLog.length} entr${runLog.length === 1 ? "y" : "ies"}`);
    if (settings.includeOnlyMarketTags) {
      console.log(`   includeOnlyMarketTags: ${JSON.stringify(settings.includeOnlyMarketTags)}`);
    }
    if (!runLog.length) {
      console.log(`   no runs recorded -- nothing has executed for this portfolio at all.\n`);
      continue;
    }

    const recent = runLog.slice(0, RUNS_TO_READ);
    const actions = new Map();
    for (const run of recent) actions.set(text(run.action) || "-", (actions.get(text(run.action) || "-") || 0) + 1);
    console.log(`   last ${recent.length} run(s): ${[...actions.entries()].map(([a, n]) => `${a} x${n}`).join(", ")}`);
    console.log(`   newest ${text(recent[0]?.generatedAt || recent[0]?.at)}  ${text(recent[0]?.reason).slice(0, 96)}`);

    // The histogram the bot itself kept, from the newest run that carries one.
    const withFilter = recent.find((run) => run?.batchLog?.prevalidationFilter?.reasonCounts
      && Object.keys(run.batchLog.prevalidationFilter.reasonCounts).length);
    const filter = withFilter?.batchLog?.prevalidationFilter
      || recent.find((run) => run?.batchLog?.prevalidationFilter)?.batchLog?.prevalidationFilter
      || null;
    if (!filter) {
      console.log(`   no prevalidationFilter recorded on these runs, so the pool cannot be read here.\n`);
      continue;
    }

    const pool = Number(filter.uniqueEvaluations ?? 0);
    const passed = Number(filter.portfolioPrefilterPassed ?? filter.prefilterPassed ?? 0);
    console.log(`   candidate pool ${pool}`
      + `   scanned observations ${filter.scannedMarketObservations ?? "-"}`
      + `   passed this portfolio's filter ${passed}`
      + `   revalidated ${filter.revalidatedCount ?? "-"}`
      + `   eligible after revalidation ${filter.revalidatedPortfolioEligible ?? "-"}`);

    const counts = filter.reasonCounts || {};
    const ranked = Object.entries(counts)
      .map(([reason, count]) => [shapeOf(reason), Number(count) || 0])
      .reduce((map, [shape, count]) => map.set(shape, (map.get(shape) || 0) + count), new Map());
    const sorted = [...ranked.entries()].sort((a, b) => b[1] - a[1]);
    if (!sorted.length) {
      console.log(`   no rejection reasons recorded on this run.`);
    } else {
      console.log(`   why every candidate was rejected:`);
      for (const [shape, count] of sorted.slice(0, 10)) {
        const flag = isStructural(shape) ? "!" : " ";
        const share = pool > 0 ? ` (${((count / pool) * 100).toFixed(0)}% of the pool)` : "";
        console.log(`   ${flag}${String(count).padStart(5)}  ${shape.slice(0, 92)}${share}`);
      }
    }

    // The finding that matters: a gate that rejected the ENTIRE pool is a portfolio that
    // cannot trade until its configuration changes, not one waiting for a better market.
    const blocking = sorted.filter(([shape, count]) => pool > 0 && count >= pool && isStructural(shape));
    if (blocking.length) {
      stuck.push({ id, label, pool, reasons: blocking.map(([shape]) => shape) });
      console.log(`   -> STUCK: every one of the ${pool} candidates fails a structural gate here,`);
      console.log(`      so no market can pass until the setting changes.`);
    } else if (pool === 0) {
      stuck.push({ id, label, pool, reasons: ["the candidate pool itself is empty"] });
      console.log(`   -> STUCK: the candidate pool is empty, so there is nothing to filter.`);
    }
    console.log("");
  }

  console.log(`== portfolios that cannot trade as configured`);
  if (!stuck.length) {
    console.log(`   none -- every portfolio is rejecting on price/edge/return, which the market fixes by itself.`);
    return;
  }
  for (const entry of stuck) {
    console.log(`   ${entry.label} (${entry.id}): ${entry.reasons.join("; ").slice(0, 120)}`);
  }
  console.log(`\n   These are configuration, not market conditions: they will keep logging`);
  console.log(`   "no candidates passed portfolio filters" indefinitely.`);
}

main().catch((error) => {
  console.log(`\n!! diagnosis stopped early: ${error?.message || error}`);
  process.exitCode = 1;
});
