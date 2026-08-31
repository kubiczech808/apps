// Read-only diagnostic. Writes nothing, publishes nothing, needs no secrets.
//
// Reported: the "Unfilled limit orders" tab keeps showing rows that never move out of
// "awaiting" -- would-win/would-lose never gets decided for them.
//
// The live side already solved exactly this problem: refreshUnfilledLimitOrderOutcomes()
// in live-account-sync.mjs revisits unfilled orders in small batches, oldest-unchecked
// first, and only records finalOutcomePrice once Gamma reports market.closed === true.
// Until then it leaves the field null and tries again on the next sync -- so a live row
// eventually gets graded no matter how long the market takes to actually resolve.
//
// The paper side (markWaitingLimitOrder in paper-trading-bot.mjs) does something
// different: the moment a resting order's event ends (limitOrderEventEnded(), which fires
// on "not accepting orders any more" and does NOT require market.closed), it captures
// outcomeIndex >= 0 ? Number(parseOutcomePrices(market)[outcomeIndex]) : null as
// finalOutcomePrice, unconditionally, and the trade leaves OPEN_STATUSES for good. Every
// later pass returns it unchanged (markOpenTrade: "if (!OPEN_STATUSES.has(trade.status))
// return trade;") -- so whatever price Gamma reported at that single instant is what the
// row carries forever, correct final settlement or not, and there is no retry.
//
// This measures how many stored LIMIT_ORDER_EXPIRED rows are stuck with exactly that
// shape: a finalOutcomePrice that is not null and not near a terminal 0/1, sitting there
// long enough that "still settling" cannot explain it.
const HOST = process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading";
const ONLY_STRATEGY_ID = process.env.PAPER_DIAGNOSIS_STRATEGY_ID || "";

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

const num = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

function isUnfilledLimitOrder(order = {}) {
  const status = String(order.status || "").toUpperCase();
  if (status !== "LIMIT_ORDER_EXPIRED" && status !== "LIVE_LIMIT_ORDER_UNFILLED") return false;
  return !(Number(order.filledSize) > 0.000001 || order.partiallyFilled === true || order.everFilled === true);
}

function classify(order) {
  const price = num(order.finalOutcomePrice);
  if (order.cancelledForCapital === true) return "cancelled-for-capital";
  if (price == null) return "null";
  if (price >= 0.995 || price <= 0.005) return "terminal";
  return "stuck-mid-range";
}

function ageDays(order, now) {
  const at = Date.parse(order.closedAt || order.resolvedAt || order.lastCheckedAt || "");
  return Number.isFinite(at) ? (now - at) / 86400000 : null;
}

async function main() {
  console.log(`Paper unfilled-limit-order evaluation diagnosis at ${new Date().toISOString()}`);
  console.log("Read-only: nothing is written, no credentials are used.\n");

  const overview = await fetchJson(`${HOST}/api.php?action=state&target=paper&summary=dashboard`);
  if (!overview.ok) {
    console.log(`!! could not read paper overview: HTTP ${overview.status} ${overview.error || ""}`);
    return;
  }
  const overviewState = overview.body?.state || overview.body || {};
  const allIds = Object.keys(overviewState.paperPortfolios || {});
  const ids = ONLY_STRATEGY_ID ? [ONLY_STRATEGY_ID] : allIds;
  console.log(`portfolios: ${ids.length} of ${allIds.length}${ONLY_STRATEGY_ID ? ` (filtered to ${ONLY_STRATEGY_ID})` : ""}\n`);

  const now = Date.now();
  const totals = { "null": 0, "terminal": 0, "stuck-mid-range": 0, "cancelled-for-capital": 0 };
  const stuckSamples = [];

  for (const id of ids) {
    const result = await fetchJson(`${HOST}/api.php?action=state&target=paper&summary=dashboard&strategy_id=${encodeURIComponent(id)}`);
    if (!result.ok) {
      console.log(`   ${id}: HTTP ${result.status} ${result.error || ""}`);
      continue;
    }
    const state = result.body?.state || result.body || {};
    const portfolio = state.paperPortfolios?.[id];
    const trades = Array.isArray(portfolio?.trades) ? portfolio.trades : [];
    const unfilled = trades.filter(isUnfilledLimitOrder);
    if (!unfilled.length) continue;

    const byClass = { "null": 0, "terminal": 0, "stuck-mid-range": 0, "cancelled-for-capital": 0 };
    for (const order of unfilled) {
      const cls = classify(order);
      byClass[cls] += 1;
      totals[cls] += 1;
      if (cls === "stuck-mid-range" || (cls === "null" && order.cancelledForCapital !== true)) {
        stuckSamples.push({ id, order, cls, age: ageDays(order, now) });
      }
    }
    console.log(`   ${id.padEnd(20)} unfilled=${String(unfilled.length).padStart(4)}`
      + `  terminal=${String(byClass.terminal).padStart(3)}`
      + `  stuck-mid-range=${String(byClass["stuck-mid-range"]).padStart(3)}`
      + `  null=${String(byClass["null"]).padStart(3)}`
      + `  cancelled-for-capital=${String(byClass["cancelled-for-capital"]).padStart(3)}`);
  }

  console.log(`\n== TOTALS across ${ids.length} portfolio(s)`);
  console.log(`   terminal (evaluated, would-win/would-lose decided)  ${totals.terminal}`);
  console.log(`   stuck-mid-range (a price was captured, but it is`);
  console.log(`     nowhere near 0 or 1 -- never revisited since)      ${totals["stuck-mid-range"]}`);
  console.log(`   null, not cancelled-for-capital (no price ever`);
  console.log(`     captured, e.g. outcomeIndex was -1 at expiry)      ${stuckSamples.filter((s) => s.cls === "null").length}`);
  console.log(`   cancelled-for-capital (expected null by design,`);
  console.log(`     graded only via the browser's evaluationByTrade`);
  console.log(`     fallback, if that market is still in the catalogue) ${totals["cancelled-for-capital"]}`);

  const genuinelyStuck = stuckSamples.filter((s) => s.age == null || s.age > 1);
  console.log(`\n== SAMPLE: unfilled orders with no usable finalOutcomePrice, closed >1 day ago`);
  console.log(`   (these cannot be "still settling" -- markOpenTrade() will never look at them again`);
  console.log(`   because their status left OPEN_STATUSES the moment they expired)\n`);
  for (const { id, order, cls, age } of genuinelyStuck.slice(0, 20)) {
    console.log(`   [${id}] id=${order.id} cls=${cls} finalOutcomePrice=${order.finalOutcomePrice ?? "null"}`
      + ` ageDays=${age == null ? "?" : age.toFixed(1)} closedAt=${order.closedAt || order.resolvedAt || "-"}`);
    console.log(`     entryPrice=${order.entryPrice ?? "-"} question="${String(order.question || "").slice(0, 90)}"`);
    console.log(`     tokenId=${order.tokenId || "-"} slug=${order.slug || "-"}`);
  }
  if (!genuinelyStuck.length) {
    console.log("   none found.");
  }

  console.log(`\n-> if stuck-mid-range or null-not-cancelled is nonzero and their age is large,`);
  console.log(`   that is the "never evaluated" the owner is seeing: a price was frozen (or never`);
  console.log(`   captured) at the moment the order expired, the trade left OPEN_STATUSES, and`);
  console.log(`   nothing in the paper bot -- unlike the live side's refreshUnfilledLimitOrderOutcomes()`);
  console.log(`   -- ever revisits a closed trade to try again once the market actually resolves.`);
}

main();
