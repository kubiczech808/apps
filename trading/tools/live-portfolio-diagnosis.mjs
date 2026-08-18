// Read-only diagnostic. Answers one question: which live portfolio does the dashboard
// think each position, open order and closed trade belongs to, and why?
//
// It writes nothing, publishes nothing, touches no state file and needs no secrets. It
// exists because the two live portfolios share one Polymarket wallet, so every row in the
// published account snapshot has to be attributed to one of them by the dashboard -- and
// when that attribution is wrong a portfolio's positions simply are not on its tab, with
// nothing anywhere saying why.
//
// The attribution is not reimplemented here. The real functions are lifted out of
// assets/app.js and run as they are, so what this prints is what the dashboard decides,
// not a second opinion that could differ from it.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const HOST = process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading";
const SOURCES = {
  live: `${HOST}/api.php?action=state&target=live`,
  fixedEntryExecution: `${HOST}/api.php?action=state&target=live-5050-execution`,
  config: `${HOST}/api.php?action=portfolio-config`,
};
// The same two files read directly rather than through api.php. When the API reports a
// state as missing, this says whether the file is genuinely not on the hosting -- the
// upload never landed -- or is there and something between it and the API is at fault.
const STATIC_SOURCES = {
  liveExecutionFile: `${HOST}/data/live-execution-state.json`,
  fixedEntryExecutionFile: `${HOST}/data/live-5050-execution-state.json`,
};

async function fetchJson(url) {
  // A read-only diagnostic must never die on the thing it was sent to look at. The
  // scraped summary cut the connection instead of answering -- which is what a PHP fatal
  // looks like from out here, and is itself a result worth printing -- and the unhandled
  // rejection took the whole report down before it could say so.
  let response;
  let text;
  try {
    response = await fetch(url, { headers: { "User-Agent": "LivePortfolioDiagnosis/1.0" } });
    text = await response.text();
  } catch (error) {
    const cause = error?.cause?.code || error?.cause?.message || "";
    return { ok: false, status: "network", error: `${error?.message || error}${cause ? ` (${cause})` : ""}` };
  }
  if (!response.ok) return { ok: false, status: response.status, error: text.slice(0, 300) };
  try {
    return { ok: true, status: response.status, body: JSON.parse(text) };
  } catch (error) {
    return { ok: false, status: response.status, error: `unparseable JSON: ${String(error).slice(0, 200)}` };
  }
}

// Same brace-matching extractor the tests use: count from the end of the parameter list,
// or a `= {}` default parameter closes the count before the body has opened.
function functionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`missing ${name}`);
  const bodyStart = source.indexOf(") {\n", start);
  let depth = 0;
  for (let i = bodyStart + 2; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (!depth) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced ${name}`);
}

// The dashboard's own attribution chain, wired to a stubbed `state` and mode.
async function attributionFor(mode, { fixedEntryExecution, config }) {
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");
  const names = [
    "isClosedTrade",
    "normalizeFixedEntryPrice",
    "fixedEntryPriceSignatures",
    "matchesFixedEntryPrice",
    "restsAtFixedEntryPrice",
    "isFilledPortfolioRow",
    "fixedEntryOrderPricesByToken",
    "boughtAtFixedEntryPrice",
    "submittedTokenIds",
    "fixedEntryTokenIds",
    "belongsToActiveLivePortfolio",
  ];
  const body = names.map((name) => functionSource(app, name)).join("\n\n");
  // The price matcher reads a module constant, so it has to come across too. Without it
  // the whole report died inside the first attribution call.
  const tolerance = /const FIXED_ENTRY_PRICE_TOLERANCE = [\d.]+;/.exec(app)?.[0] || "";
  return new Function("state", "isFixedEntryMode", "portfolioConfigForMode", `
    ${tolerance}
    ${body}
    return { belongsToActiveLivePortfolio, boughtAtFixedEntryPrice, isFilledPortfolioRow,
      restsAtFixedEntryPrice, fixedEntryPriceSignatures, fixedEntryOrderPricesByToken };
  `)(
    { live5050ExecutionState: fixedEntryExecution, mode },
    () => mode === "live-5050",
    () => (config?.live5050 || {}),
  );
}

function rowLabel(row) {
  return [
    String(row?.question || row?.slug || row?.tokenId || "-").slice(0, 52),
    row?.outcome ? `(${row.outcome})` : "",
  ].filter(Boolean).join(" ");
}

function priceOf(row) {
  const value = Number(row?.entryPrice ?? row?.avgPrice ?? row?.averagePrice ?? row?.price ?? row?.orderPrice);
  return Number.isFinite(value) ? value.toFixed(4) : "-";
}

function reportSet(label, rows, api, mode) {
  const mine = [];
  const theirs = [];
  for (const row of rows) {
    (api.belongsToActiveLivePortfolio(row) ? mine : theirs).push(row);
  }
  console.log(`  ${label}: ${rows.length} rows -> ${mine.length} attributed to ${mode}, ${theirs.length} to the other`);
  for (const row of rows.slice(0, 12)) {
    const owned = api.belongsToActiveLivePortfolio(row);
    const filled = api.isFilledPortfolioRow(row);
    console.log(`    ${owned ? "MINE " : "other"} price=${priceOf(row)}`
      + ` status=${String(row?.status || "-")}`
      + ` filled=${filled}`
      + ` boughtAt5050Price=${filled ? api.boughtAtFixedEntryPrice(row) : "n/a"}`
      + ` restsAt5050Price=${filled ? "n/a" : api.restsAtFixedEntryPrice(row)}`
      + `  ${rowLabel(row)}`);
  }
  if (rows.length > 12) console.log(`    ... and ${rows.length - 12} more`);
}

// Reported: every category in the tag picker reads "nothing stored yet", when there are
// certainly stored markets. The picker counts tags across the rows the scraped summary
// returns, so the question is what that response actually contains -- how many rows, what
// the manifest says the totals are, and whether the rows still carry the tags the counting
// reads. Those three answers separate "the catalogue is gone" from "the response is fine
// and the counting looks at the wrong field".
async function reportScrapedCatalogue() {
  console.log(`\n== What the opportunities page is served`);
  const result = await fetchJson(`${HOST}/api.php?action=state&target=paper&summary=scraped`);
  if (!result.ok) {
    console.log(`   HTTP ${result.status}: ${String(result.error).slice(0, 200)}`);
    return;
  }
  const body = result.body || {};
  const rows = Array.isArray(body.marketObservations) ? body.marketObservations : [];
  console.log(`   generatedAt=${body.generatedAt || "(none)"} rows=${rows.length}`
    + ` totals=${JSON.stringify(body.observationTotals || {})}`);
  if (rows.length) console.log(`   first row keys: ${Object.keys(rows[0]).sort().join(", ")}`);

  // The list and the statistics read different fields in a different order, so both
  // orders are counted here. `tags` is the bot's own risk vocabulary (general/sports/...)
  // and is NOT what either side groups by -- counting it is what made the previous
  // measurement report "no such tag anywhere".
  const labelsOf = (row, fields) => {
    const source = fields.map((field) => row?.[field]).find((value) => Array.isArray(value) && value.length) || [];
    return source
      .map((entry) => (entry && typeof entry === "object" ? (entry.slug || entry.label || entry.name || "") : entry))
      .map((value) => String(value ?? "").trim().toLowerCase())
      .filter(Boolean);
  };
  const LIST_FIELDS = ["polymarketTags", "firstPolymarketTags", "tags", "firstTags"];
  const REPORT_FIELDS = ["firstPolymarketTags", "polymarketTags"];
  for (const [name, fields] of [["list order", LIST_FIELDS], ["report order", REPORT_FIELDS]]) {
    const counts = new Map();
    let carrying = 0;
    for (const row of rows) {
      const labels = labelsOf(row, fields);
      if (labels.length) carrying += 1;
      for (const label of labels) counts.set(label, (counts.get(label) || 0) + 1);
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    console.log(`   ${name}: ${carrying}/${rows.length} rows tagged | ${counts.size} distinct`
      + (top.length ? ` | top: ${top.map(([tag, n]) => `${tag}=${n}`).join(", ")}` : ""));
  }

  // Reported: Tag performance says 937 resolved trades for league-of-legends and its own
  // link lists 12. The statistic is computed by the bot over the whole stored archive;
  // the browser is served a capped page of it. This counts both sides of that.
  const tag = "league-of-legends";
  const resolved = rows.filter((row) => String(row?.status || row?.selectionStatus || "").toUpperCase() === "RESOLVED");
  const entryOf = (row) => {
    for (const candidate of [row?.firstMarketProbability, row?.lastLiveMarketProbability, row?.marketProbability, row?.marketPrice]) {
      const numeric = Number(candidate);
      if (Number.isFinite(numeric) && numeric > 0 && numeric < 1) return numeric;
    }
    return null;
  };
  console.log(`\n== The reported row, counted in what the browser is served`);
  console.log(`   rows served: ${rows.length} | resolved among them: ${resolved.length}`);
  for (const [name, fields] of [["list order", LIST_FIELDS], ["report order", REPORT_FIELDS]]) {
    const matched = resolved.filter((row) => labelsOf(row, fields).includes(tag));
    console.log(`   ${name}: resolved carrying "${tag}": ${matched.length}`
      + ` | priced: ${matched.filter((row) => entryOf(row) != null).length}`
      + ` | entry >= 50%: ${matched.filter((row) => (entryOf(row) ?? 0) >= 0.5).length}`);
  }
  console.log(`   manifest says resolved in total: ${JSON.stringify(body.observationTotals || {})}`);

  // And what the statistics themselves claim for the same group. The report lives in the
  // core state file, so the dashboard summary carries it without decoding any segment.
  const report = await fetchJson(`${HOST}/api.php?action=state&target=paper&summary=dashboard`);
  const state = report.body?.state || report.body || {};
  const calculation = state.latestCalculationReport
    || (Array.isArray(state.calculationReports) ? state.calculationReports[0] : null);
  const groups = Array.isArray(calculation?.tagSummaries) ? calculation.tagSummaries : [];
  const row = groups.find((entry) => String(entry?.label || "").toLowerCase() === tag);
  console.log(`   statistics report: ${calculation ? `generatedAt=${calculation.generatedAt} tagRows=${groups.length}`
    + ` resolvedSampleSize=${calculation.resolvedSampleSize} coverage=${JSON.stringify(calculation.taxonomyCoverage?.tag || {})}`
    : `not found (HTTP ${report.status})`}`);
  if (row) {
    console.log(`   statistics row: trades=${row.trades} resolved=${row.resolved} open=${row.openCount}`);
    for (const summary of (row.minimumProbabilitySummaries || [])) {
      console.log(`      minProbability=${summary.minimumProbability} trades=${summary.trades} open=${summary.openCount}`);
    }
  } else if (calculation) {
    console.log(`   statistics row: "${tag}" is not among the stored tag rows`);
  }

  // The link the user clicks now asks the archive for the rows behind that number rather
  // than filtering the capped page above. Every rung is compared, because each is its own
  // statistic with its own link -- one matching rung would not prove the rest do.
  console.log(`\n== What the "trades" link now serves, rung by rung`);
  for (const summary of (row?.minimumProbabilitySummaries || [])) {
    const percent = Math.round(Number(summary.minimumProbability) * 100);
    const [resolved, open] = await Promise.all(["RESOLVED", "SCRAPED"].map((status) => fetchJson(
      `${HOST}/api.php?action=taxonomy-observations&target=paper&kind=tag`
      + `&value=${encodeURIComponent(tag)}&statuses=${status}&probability=${percent}`,
    )));
    const line = (result, expected) => (result.ok
      ? `${result.body?.matched} (returned ${result.body?.returned}${result.body?.truncated ? ", capped" : ""})`
        + `${Number(result.body?.matched) === Number(expected) ? " ==" : " != "}${expected}`
      : `HTTP ${result.status}`);
    console.log(`   ${percent}%: resolved ${line(resolved, summary.trades)}`
      + ` | open ${line(open, summary.openCount)}`);
  }
}

// Reported: the "stop loss" portfolio still shows an old value for its rotation
// parameter rather than On/Off. Both sides of that are printed here -- the setting the
// browser reads from portfolio-config, and the strategy the bot actually ran with --
// because a stale display and a stale run are different faults with different fixes.
async function reportPaperPortfolioSettings() {
  console.log(`\n== Paper portfolio settings, as stored and as run`);
  const [config, state] = await Promise.all([
    fetchJson(`${HOST}/api.php?action=portfolio-config`),
    fetchJson(`${HOST}/api.php?action=state&target=paper&summary=dashboard`),
  ]);
  const paper = (config.ok ? config.body?.config?.paper : null) || {};
  const portfolios = ((state.ok ? (state.body?.state || state.body) : null) || {}).paperPortfolios || {};
  const ids = [...new Set([...Object.keys(paper), ...Object.keys(portfolios)])];
  if (!ids.length) console.log(`   nothing readable (config HTTP ${config.status}, state HTTP ${state.status})`);
  for (const id of ids) {
    const row = paper[id] || {};
    const live = portfolios[id] || {};
    // The published portfolio row, not a "strategy" sub-object -- normalizePaperPortfolio
    // stamps both flags directly onto .portfolio, and every prior probe reading
    // .strategy here printed "undefined" for every single portfolio because no such key
    // is ever published.
    const runPortfolio = live.portfolio || {};
    console.log(`   ${id}: name=${JSON.stringify(row.displayName ?? live.label ?? null)}`
      + ` autoRotatePositions=${JSON.stringify(row.autoRotatePositions)} (${typeof row.autoRotatePositions})`
      + ` stopLossEnabled=${JSON.stringify(row.stopLossEnabled)} (${typeof row.stopLossEnabled})`
      + ` automationEnabled=${JSON.stringify(row.automationEnabled)}`
      + ` executionTrigger=${JSON.stringify(row.executionTrigger)}`);
    console.log(`      as run: allowRotation=${JSON.stringify(runPortfolio.allowRotation)}`
      + ` equalRiskProtection=${JSON.stringify(runPortfolio.equalRiskProtection)}`
      + ` label=${JSON.stringify(live.label)}`
      + ` | portfolio initialUsdc=${runPortfolio.initialUsdc ?? "-"}`
      + ` equity=${runPortfolio.equityUsdc ?? "-"}`
      + ` trades=${(live.trades || []).length} resetAt=${live.resetAt || "never"}`);
    // Any key the browser could still be reading a legacy value from.
    const legacy = Object.keys(row).filter((key) => /rotat/i.test(key) && key !== "autoRotatePositions");
    if (legacy.length) console.log(`      legacy rotation keys in config: ${legacy.map((key) => `${key}=${JSON.stringify(row[key])}`).join(", ")}`);
  }
}

// One-off: checking what a mistaken reset on highReward left recoverable before writing
// any restore. Read-only -- prints the archive snapshot's shape and whether anything
// has traded since the reset, so a restore can be built to keep both.
async function reportResetRecovery(strategyId) {
  console.log(`\n== Reset recovery check for "${strategyId}"`);
  const result = await fetchJson(`${HOST}/api.php?action=state&target=paper&summary=dashboard`);
  if (!result.ok) {
    console.log(`   HTTP ${result.status}: ${String(result.error).slice(0, 200)}`);
    return;
  }
  const state = result.body?.state || result.body || {};
  const live = state.paperPortfolios?.[strategyId] || {};
  console.log(`   live now: resetAt=${live.resetAt || "none"} resetArchiveId=${live.resetArchiveId || "none"}`
    + ` trades=${(live.trades || []).length} runLog=${(live.runLog || []).length}`
    + ` equity=${live.portfolio?.equityUsdc ?? "-"}`);
  const archives = Array.isArray(state.paperPortfolioArchives) ? state.paperPortfolioArchives : [];
  console.log(`   archives stored: ${archives.length}`);
  const match = archives.find((entry) => entry.id === live.resetArchiveId)
    || archives.find((entry) => entry.strategyId === strategyId);
  if (!match) {
    console.log(`   no archive entry found for ${strategyId}`);
    return;
  }
  const snapshot = match.snapshot || {};
  console.log(`   archive "${match.id}": archivedAt=${match.archivedAt} reason=${JSON.stringify(match.reason)}`);
  console.log(`      snapshot: trades=${(snapshot.trades || []).length} runLog=${(snapshot.runLog || []).length}`
    + ` lastTradeDate=${snapshot.lastTradeDate || "-"} equity=${snapshot.portfolio?.equityUsdc ?? "-"}`
    + ` initialUsdc=${snapshot.portfolio?.initialUsdc ?? "-"}`);
  // A paper trade's id is built as `paper-{strategyId}-{today}-{tokenId}` -- same
  // strategy, same day, same market collide on purpose (one entry per market per day).
  // A reset re-opening a market it already held before the reset would print "0 new"
  // by id alone and silently lose the archived entry, so every live row is shown in
  // full against its id-matching archived row, not just counted.
  for (const trade of (live.trades || [])) {
    const archived = (snapshot.trades || []).find((entry) => entry.id === trade.id);
    console.log(`   live trade ${trade.id}: status=${trade.status} tokenId=${trade.tokenId}`
      + ` question=${JSON.stringify(String(trade.question || "").slice(0, 60))}`
      + ` openedAt=${trade.openedAt || trade.createdAt || "-"} entryPrice=${trade.entryPrice ?? "-"}`
      + ` stakeUsdc=${trade.stakeUsdc ?? "-"} realizedPnlUsdc=${trade.realizedPnlUsdc ?? "-"}`);
    if (archived) {
      console.log(`      matches an archived trade by id: status=${archived.status}`
        + ` openedAt=${archived.openedAt || archived.createdAt || "-"} entryPrice=${archived.entryPrice ?? "-"}`
        + ` stakeUsdc=${archived.stakeUsdc ?? "-"} realizedPnlUsdc=${archived.realizedPnlUsdc ?? "-"}`
        + ` -- ${trade.openedAt === archived.openedAt && trade.stakeUsdc === archived.stakeUsdc ? "looks like the same fill" : "DIFFERS -- likely a distinct fill sharing the id"}`);
    } else {
      console.log("      no archived trade shares this id");
    }
  }
}

async function main() {
  console.log(`Live portfolio attribution diagnosis at ${new Date().toISOString()}`);
  console.log("Read-only: nothing is written, no credentials are used.\n");

  const [live, fixedEntryExecution, config] = await Promise.all(
    [SOURCES.live, SOURCES.fixedEntryExecution, SOURCES.config].map(fetchJson),
  );
  for (const [name, result] of Object.entries({ live, fixedEntryExecution, config })) {
    if (!result.ok) console.log(`!! ${name}: HTTP ${result.status} ${result.error}`);
  }
  if (!live.ok) {
    console.log("The account snapshot could not be read; nothing else can be judged.");
    return;
  }

  const liveState = live.body?.state || live.body || {};
  const execution = fixedEntryExecution.ok ? (fixedEntryExecution.body?.state || fixedEntryExecution.body || {}) : null;
  const portfolioConfig = config.ok ? (config.body?.config || {}) : {};

  // "The dashboard has no updated data" is first of all a question about the snapshot's
  // own age, before it is a question about anything the dashboard computes.
  const generatedAt = liveState.generatedAt || liveState.sync?.generatedAt || null;
  const ageMinutes = generatedAt ? (Date.now() - Date.parse(generatedAt)) / 60000 : null;
  console.log(`== Account snapshot`);
  console.log(`   generatedAt: ${generatedAt || "(none)"}`
    + (ageMinutes == null ? "" : ` -- ${ageMinutes.toFixed(1)} minutes old`));
  console.log(`   positions: ${(liveState.positions || []).length}`
    + ` | openOrders: ${(liveState.openOrders || []).length}`
    + ` | closedTrades: ${(liveState.closedTrades || []).length}`
    + ` | activity: ${(liveState.activity || []).length}`);
  const portfolio = liveState.portfolio || {};
  console.log(`   equity=${portfolio.equityUsdc ?? "-"} cash=${portfolio.cashUsdc ?? "-"}`
    + ` marketValue=${portfolio.marketValueUsdc ?? "-"} realized=${portfolio.realizedPnlUsdc ?? "-"}`);

  console.log(`\n== 5050 execution state`);
  if (!execution) {
    console.log("   not published yet, so its logged order prices cannot back attribution");
  } else {
    console.log(`   generatedAt: ${execution.generatedAt || "(none)"}`
      + ` | runLog entries: ${(execution.runLog || []).length}`);
  }
  const fixedEntryConfig = portfolioConfig.live5050 || {};
  console.log(`   configured entry price: ${fixedEntryConfig.fixedEntryPrice ?? "(config unavailable)"}`);
  console.log(`   price history: [${(fixedEntryConfig.fixedEntryPriceHistory || []).join(", ") || "none recorded"}]`);

  for (const mode of ["live-5050", "live"]) {
    let api = null;
    try {
      api = await attributionFor(mode, { fixedEntryExecution: execution, config: portfolioConfig });
    } catch (error) {
      console.log(`\n== As the ${mode} tab sees it\n   attribution could not be evaluated: ${error?.message || error}`);
      continue;
    }
    console.log(`\n== As the ${mode} tab sees it`);
    if (mode === "live-5050") {
      console.log(`   prices it treats as its own: [${[...api.fixedEntryPriceSignatures()].join(", ") || "none"}]`);
      const logged = api.fixedEntryOrderPricesByToken();
      console.log(`   tokens with a logged 5050 order price: ${logged.size}`);
    }
    reportSet("positions", (liveState.positions || []).filter((row) => !["WON", "LOST", "CLOSED", "REDEEMED", "SOLD", "REDEEM_REQUIRED", "RESOLVED"].includes(String(row?.status || "").toUpperCase())), api, mode);
    reportSet("open orders", liveState.openOrders || [], api, mode);
    reportSet("closed trades", liveState.closedTrades || [], api, mode);
  }

  // Reported: a trade that showed as an opened Live position closed under 90 -> 50%
  // instead. reportSet's sample is only the first 12 rows regardless of which side of the
  // split they land on, so the minority side -- whichever trades actually flipped -- can
  // be entirely outside that sample. Every row 5050 claims, uncapped, with the reasoning.
  {
    const api = await attributionFor("live-5050", { fixedEntryExecution: execution, config: portfolioConfig });
    const claimedBy5050 = (liveState.closedTrades || []).filter((row) => api.belongsToActiveLivePortfolio(row));
    console.log(`\n== Every closed trade attributed to live-5050 (${claimedBy5050.length} total, uncapped)`);
    for (const row of claimedBy5050) {
      const tokenId = String(row?.tokenId || row?.assetId || "");
      const loggedPrices = [...(api.fixedEntryOrderPricesByToken().get(tokenId) || [])];
      console.log(`   tokenId=${tokenId} price=${priceOf(row)} status=${row?.status || "-"}`
        + ` openedAt=${row?.openedAt || "-"} closedAt=${row?.closedAt || row?.resolvedAt || "-"}`
        + ` loggedTokenPrices=[${loggedPrices.join(", ")}] boughtAt5050Price=${api.boughtAtFixedEntryPrice(row)}`
        + `  ${rowLabel(row)}`);
    }
  }

  // Reported: rows showing 50-51% turn up on the live portfolio, which trades against a
  // high probability bar and should never hold one. Two different columns can read as a
  // percentage -- the entry price and a leftover AI probability -- so both are counted
  // here, because which one it is decides whether this is misattribution or a stale
  // column from the retired scoring pipeline.
  console.log(`\n== Rows reading near 50%, and which field says so`);
  const near = (value) => Number.isFinite(Number(value)) && Number(value) >= 0.48 && Number(value) <= 0.53;
  for (const [label, rows] of [["closed trades", liveState.closedTrades || []], ["open orders", liveState.openOrders || []], ["positions", liveState.positions || []]]) {
    const byEntry = rows.filter((row) => near(row?.entryPrice ?? row?.avgPrice ?? row?.price ?? row?.orderPrice));
    const byAi = rows.filter((row) => near(row?.aiProbability ?? row?.aiAnalysis?.probability ?? row?.sourceEvaluation?.aiProbability));
    const withAnyAi = rows.filter((row) => Number.isFinite(Number(row?.aiProbability ?? row?.aiAnalysis?.probability ?? row?.sourceEvaluation?.aiProbability)));
    console.log(`   ${label}: ${rows.length} rows | entry price near 50%: ${byEntry.length}`
      + ` | AI probability near 50%: ${byAi.length} | carrying any AI probability at all: ${withAnyAi.length}`);
    for (const row of byEntry.slice(0, 8)) {
      console.log(`     entry=${priceOf(row)} marketProb=${row?.marketProbability ?? "-"} ai=${row?.aiProbability ?? "-"}`
        + ` status=${row?.status || "-"}  ${rowLabel(row)}`);
    }
    for (const row of withAnyAi.slice(0, 5)) {
      console.log(`     AI-carrying: ai=${row?.aiProbability ?? row?.aiAnalysis?.probability ?? row?.sourceEvaluation?.aiProbability}`
        + ` entry=${priceOf(row)}  ${rowLabel(row)}`);
    }
  }

  // Reported: a resting bid on a LoL match that has already been played still shows as
  // LIMIT ORDER WAITING and holds its collateral. Whether that order can be withdrawn
  // automatically depends entirely on what Gamma still says about its market, so ask.
  console.log(`\n== Open orders against what Gamma says about their markets`);
  for (const order of (liveState.openOrders || [])) {
    const tokenId = String(order?.tokenId || order?.assetId || "");
    const side = String(order?.side || "BUY").toUpperCase();
    const stored = order?.endDate || order?.resolutionEndDate || null;
    let market = null;
    if (tokenId) {
      const result = await fetchJson(`https://gamma-api.polymarket.com/markets?clob_token_ids=${encodeURIComponent(tokenId)}`);
      market = result.ok && Array.isArray(result.body) ? result.body[0] : null;
    }
    const hoursPast = stored ? (Date.now() - Date.parse(stored)) / 3600000 : null;
    // Spelled out either way round. Printing a signed "13.0h ago" for a date thirteen
    // hours in the future read as an expired order at a glance, which is the opposite
    // of what it says and exactly the misreading this section exists to prevent.
    const when = hoursPast == null || !Number.isFinite(hoursPast)
      ? ""
      : (hoursPast >= 0 ? ` (${hoursPast.toFixed(1)}h ago)` : ` (in ${Math.abs(hoursPast).toFixed(1)}h)`);
    console.log(`   ${side} price=${priceOf(order)} status=${order?.status || "-"}  ${rowLabel(order)}`);
    console.log(`     stored endDate=${stored || "(none)"}${when}`
      + ` daysToResolution=${order?.daysToResolution ?? "-"}`);
    console.log(market
      ? `     gamma: closed=${market.closed} active=${market.active} acceptingOrders=${market.acceptingOrders}`
        + ` archived=${market.archived} umaResolutionStatus=${market.umaResolutionStatus ?? "-"}`
        + ` endDate=${market.endDate ?? "-"} closedTime=${market.closedTime ?? "-"}`
      : `     gamma: no market answered for this token`);
  }

  // Whether the two execution state files are on the hosting at all. A 404 here and a 404
  // from the API mean the upload never landed; a 200 here with a 404 from the API would
  // mean the file is present and something else is wrong.
  console.log(`\n== Execution state files, read directly`);
  for (const [name, url] of Object.entries(STATIC_SOURCES)) {
    const result = await fetchJson(url);
    const generatedAt = result.ok ? (result.body?.generatedAt || "(no generatedAt)") : "";
    console.log(`   ${name}: HTTP ${result.status}`
      + (result.ok ? ` generatedAt=${generatedAt} runLog=${(result.body?.runLog || []).length}` : ` ${String(result.error).slice(0, 120)}`));
    if (result.ok) continue;
    // The publisher uploads to `<name>.uploading-N` and renames it into place, moving any
    // existing file to `<name>.previous` first. Those names are the difference between
    // "the transfer never happened" and "it happened and the rename did not" -- and both
    // read as a plain 404 on the final name, which is all this has said for days.
    for (const suffix of [".uploading-1", ".uploading-2", ".uploading-3", ".previous"]) {
      const probe = await fetchJson(`${url}${suffix}`);
      if (probe.ok) console.log(`     found leftover ${suffix}: the transfer landed and the rename into place did not`);
    }
  }

  // Last on purpose: only the tail of a runner log can be read back through the API, so
  // the section being investigated has to be the one that lands there.
  await reportPaperPortfolioSettings();
  await reportResetRecovery("highReward");
  await reportResetRecovery("equal");
}

const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (invokedDirectly) {
  await main();
}

export { functionSource, attributionFor };
