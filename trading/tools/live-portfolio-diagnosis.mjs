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
  const response = await fetch(url, { headers: { "User-Agent": "LivePortfolioDiagnosis/1.0" } });
  const text = await response.text();
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
}

const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (invokedDirectly) {
  await main();
}

export { functionSource, attributionFor };
