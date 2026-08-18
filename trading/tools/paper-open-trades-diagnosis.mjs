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

function extractConst(source, name) {
  const marker = `const ${name} = `;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`missing const ${name}`);
  const end = source.indexOf(";\n", start);
  if (end < 0) throw new Error(`const ${name} is not terminated`);
  return source.slice(start, end + 1);
}

async function daysLeftApi() {
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");
  const names = ["isClosedTrade", "inferredDateFromQuestion", "tradeEndDate", "daysUntil", "evaluationEndDate", "evaluationDaysLeft", "daysToResolution"];
  const body = names.map((name) => extractFunction(app, name)).join("\n\n");
  return new Function(`${body}\nreturn { evaluationEndDate, evaluationDaysLeft, tradeEndDate, daysUntil, isClosedTrade };`)();
}

// The bot's own end-date resolution, lifted from paper-trading-bot.mjs (not assets/app.js --
// that is the dashboard's display-only copy). This is what markOpenTrade() itself would
// compute right now for a given trade and its freshly fetched Gamma market, so a mismatch
// against the stored trade.endDate points at exactly where the staleness is introduced.
async function botDateApi() {
  const bot = await readFile(new URL("./paper-trading-bot.mjs", import.meta.url), "utf8");
  const consts = [extractConst(bot, "SPORTS_MARKET_HINT")];
  const names = [
    "inferredEndDateFromQuestion",
    "correctedEndDate",
    "isSportsMarket",
    "parseSportsDate",
    "sportsDateFromSlug",
    "sportsScheduledEventDateDetail",
    "marketDateContext",
    "daysToEnd",
  ];
  const body = [...consts, ...names.map((name) => extractFunction(bot, name))].join("\n\n");
  return new Function(`${body}\nreturn { marketDateContext, isSportsMarket, sportsScheduledEventDateDetail, correctedEndDate, daysToEnd };`)();
}

const OPEN_STATUSES = new Set(["OPEN", "PENDING_RESOLUTION", "MARKET_NOT_FOUND", "STOP_BREACH"]);

// Mirrors fetchMarketBySlug() in the bot exactly: same URL, same two-pass closed=true/false
// fallback. This is the live check for whether Gamma itself, right now, still reports the
// end date the bot stored -- not a second opinion, the actual source the bot reads from.
async function fetchMarketBySlug(slug) {
  if (!slug) return null;
  for (const closed of ["true", "false"]) {
    const url = new URL("https://gamma-api.polymarket.com/markets");
    url.searchParams.set("slug", slug);
    url.searchParams.set("closed", closed);
    const result = await fetchJson(url.toString());
    if (result.ok && Array.isArray(result.body) && result.body[0]) return result.body[0];
  }
  return null;
}

async function main() {
  console.log(`Paper open-trades days-left diagnosis at ${new Date().toISOString()}`);
  console.log("Read-only: nothing is written, no credentials are used.\n");

  const api = await daysLeftApi();
  const botApi = await botDateApi();
  // The unfiltered payload is too large for PHP to serve reliably (HTTP 500) -- the
  // dashboard summary strips evaluations/runLog/scan history, none of which this needs,
  // and leaves paperPortfolios[*].trades untouched.
  const paper = await fetchJson(`${HOST}/api.php?action=state&target=paper&summary=dashboard`);
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
    console.log(`     question="${String(trade.question || "").slice(0, 90)}" outcome=${trade.outcome || "-"} tokenId=${trade.tokenId || "-"} slug=${trade.slug || "-"}`);

    // The bot's own source, queried live, right now -- not a stored value, the actual
    // thing markOpenTrade() would read on its next refresh.
    if (trade.slug) {
      const market = await fetchMarketBySlug(trade.slug);
      if (!market) {
        console.log("     gamma (live): slug not found under either closed=true or closed=false");
      } else {
        console.log(`     gamma (live): endDate=${market.endDate || "-"} closed=${market.closed ?? "-"}`
          + ` active=${market.active ?? "-"} acceptingOrders=${market.acceptingOrders ?? "-"}`
          + ` umaResolutionStatus=${market.umaResolutionStatus || "-"}`);

        // Reproduces markOpenTrade()'s own dateContext call exactly (same synthetic
        // resolutionEndDate override), so this is what the bot would store on its very
        // next refresh cycle for this trade -- not a guess about its logic.
        const dateContext = botApi.marketDateContext(
          { ...market, resolutionEndDate: market.endDate || trade.resolutionEndDate || trade.endDate || null },
          trade.openedAt || trade.date,
        );
        const sports = botApi.isSportsMarket(market);
        const scheduled = botApi.sportsScheduledEventDateDetail(market);
        console.log(`     bot would compute now: endDate=${dateContext.endDate || "-"} source=${dateContext.endDateSource}`
          + ` resolutionEndDate=${dateContext.resolutionEndDate || "-"} scheduledEventDate=${dateContext.scheduledEventDate || "-"}`);
        console.log(`     isSportsMarket=${sports} scheduled.precise=${scheduled.precise}`
          + ` tags=${JSON.stringify(market.tags ?? null)} category=${market.category || "-"}`
          + ` slug=${market.slug || "-"} eventSlug=${market.eventSlug || "-"}`);
      }
    }
    console.log("");
  }

  if (!negative.length) {
    console.log("   none -- every open trade's computed end date is still in the future.");
  }
}

main();
