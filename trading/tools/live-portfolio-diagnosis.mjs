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
  return new Function("state", "isFixedEntryMode", "portfolioConfigForMode", `
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

  for (const mode of ["live-5050", "live"]) {
    const api = await attributionFor(mode, { fixedEntryExecution: execution, config: portfolioConfig });
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
}

const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (invokedDirectly) {
  await main();
}

export { functionSource, attributionFor };
