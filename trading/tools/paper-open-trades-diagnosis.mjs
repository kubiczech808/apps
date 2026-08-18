// Read-only diagnostic. Answers one question: for a given paper portfolio, which open
// trades show a negative "days left", and is that because the market has genuinely
// resolved and the bot has not noticed, or because the end date itself is wrong?
//
// It writes nothing, publishes nothing, touches no state file and needs no secrets. The
// days-left figure is not reimplemented here -- the real functions are lifted out of
// assets/app.js and run as they are, so what this prints is what the dashboard shows, not
// a second opinion that could differ from it.
import { readFile } from "node:fs/promises";

const HOST = process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading";
const STRATEGY_ID = process.env.PAPER_DIAGNOSIS_STRATEGY_ID || "moreProbable";

async function fetchJson(url) {
  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    return { ok: false, status: 0, error: error?.message || String(error) };
  }
  const text = await response.text();
  try {
    return { ok: response.ok, status: response.status, body: JSON.parse(text) };
  } catch {
    return { ok: false, status: response.status, error: text.slice(0, 300) };
  }
}

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`missing ${name}`);
  let depth = 0;
  for (let index = source.indexOf("{", source.indexOf(")", start)); index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`function ${name} is unbalanced`);
}

async function daysLeftApi() {
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");
  const names = ["isClosedTrade", "inferredDateFromQuestion", "tradeEndDate", "daysUntil", "evaluationEndDate", "evaluationDaysLeft", "daysToResolution"];
  const body = names.map((name) => extractFunction(app, name)).join("\n\n");
  return new Function(`${body}\nreturn { evaluationEndDate, evaluationDaysLeft, tradeEndDate, daysUntil, isClosedTrade };`)();
}

const OPEN_STATUSES = new Set(["OPEN", "PENDING_RESOLUTION", "MARKET_NOT_FOUND", "STOP_BREACH"]);

async function main() {
  console.log(`Paper open-trades days-left diagnosis at ${new Date().toISOString()}`);
  console.log("Read-only: nothing is written, no credentials are used.\n");

  const api = await daysLeftApi();
  const paper = await fetchJson(`${HOST}/api.php?action=state&target=paper`);
  if (!paper.ok) {
    console.log(`!! could not read paper state: HTTP ${paper.status} ${paper.error || ""}`);
    return;
  }
  const state = paper.body?.state || paper.body || {};
  const portfolio = state.paperPortfolios?.[STRATEGY_ID];
  if (!portfolio) {
    console.log(`!! no portfolio "${STRATEGY_ID}" in state. Known: ${Object.keys(state.paperPortfolios || {}).join(", ") || "(none)"}`);
    return;
  }

  const trades = Array.isArray(portfolio.trades) ? portfolio.trades : [];
  const openTrades = trades.filter((trade) => OPEN_STATUSES.has(String(trade?.status || "").toUpperCase()));
  console.log(`== ${STRATEGY_ID} (${portfolio.label || "-"})`);
  console.log(`   generatedAt: ${state.generatedAt || "(none)"}`);
  console.log(`   trades: ${trades.length} total, ${openTrades.length} open (status in ${[...OPEN_STATUSES].join("/")})\n`);

  const negative = openTrades
    .map((trade) => ({ trade, daysLeft: api.evaluationDaysLeft(trade), endDate: api.evaluationEndDate(trade) }))
    .filter((row) => Number.isFinite(row.daysLeft) && row.daysLeft < 0)
    .sort((a, b) => a.daysLeft - b.daysLeft);

  console.log(`== Open trades with a negative days-left: ${negative.length} of ${openTrades.length}\n`);
  for (const { trade, daysLeft, endDate } of negative) {
    console.log(`   id=${trade.id} status=${trade.status} daysLeft=${daysLeft.toFixed(2)}`
      + ` endDate(computed)=${endDate || "-"} endDate(stored)=${trade.endDate || "-"}`
      + ` closedTime=${trade.closedTime || "-"} resolvedAt=${trade.resolvedAt || "-"}`);
    console.log(`     openedAt=${trade.openedAt || trade.date || "-"} lastCheckedAt=${trade.lastCheckedAt || "-"}`
      + ` resolutionStatus=${trade.resolutionStatus || "-"} umaResolutionStatus=${trade.umaResolutionStatus || "-"}`
      + ` marketClosed=${trade.marketClosed ?? "-"} closed=${trade.closed ?? "-"} resolved=${trade.resolved ?? "-"}`);
    console.log(`     question="${String(trade.question || "").slice(0, 90)}" outcome=${trade.outcome || "-"} tokenId=${trade.tokenId || "-"}`);
    console.log("");
  }

  if (!negative.length) {
    console.log("   none -- every open trade's computed end date is still in the future.");
  }
}

main();
