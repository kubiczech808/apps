// Read-only diagnostic. Writes nothing, publishes nothing, needs no secrets.
//
// Reported: a resting bid on an event that is STILL RUNNING has been cancelled. Free
// capital is available again and the order would have filled itself, so the cancellation
// cost the portfolio the trade. The rule is that an order stays until the event resolves;
// the only defensible exception is that the account tried to place or hold it while the
// capital was not there.
//
// An order is never marked cancelled by our own state on purpose: the sync compares the
// CLOB's open orders against the previous snapshot and records what left the book
// (vanishedOpenOrders -> unfilledLimitOrderHistory). So "cancelled" only ever means "gone
// from the book", and the question this answers is WHO removed it:
//
//   1. our executor -- withdrawExpiredOpenOrders (only on a resolved market), or a review
//      that chose REPLACE / CANCEL_FOR_BETTER_CANDIDATE, which cancels to submit something
//      else in the same pass;
//   2. Polymarket -- which cancels a resting order whose collateral is no longer covered,
//      and when a market stops accepting orders;
//   3. nobody: it filled, and the row is a misread.
//
// The run log records every decision the executor made per token, so (1) is provable rather
// than inferred. Gamma says whether the market is resolved at all, which is the only
// condition our own code accepts as terminal.
const HOST = process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading";
const GAMMA = process.env.POLYMARKET_GAMMA_API || "https://gamma-api.polymarket.com";
const CLOB = process.env.POLYMARKET_CLOB_API || "https://clob.polymarket.com";
// The event the user pointed at. Overridable, because the next one will be different.
const EVENT = process.env.EVENT_SLUG || "cs2-pha-og1-2026-09-03";

const text = (value) => String(value == null ? "" : value).trim();
const lower = (value) => text(value).toLowerCase();

async function fetchJson(url) {
  const response = await fetch(url, { headers: { "User-Agent": "osobnizkusenosti-trading-live-sync" } });
  const body = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 140)}`);
  const payload = JSON.parse(body);
  if (Array.isArray(payload?.data)) return payload.data;
  return payload;
}

function mentionsEvent(row = {}) {
  const needle = lower(EVENT);
  return [row.eventSlug, row.slug, row.url, row.question, row.title]
    .some((value) => lower(value).includes(needle));
}

function describeOrder(row = {}) {
  return `price ${text(row.price ?? row.limitPrice) || "-"}`
    + `   size ${text(row.remainingSize ?? row.originalSize ?? row.size) || "-"}`
    + `   stake ${text(row.stakeUsdc ?? row.notionalUsdc ?? row.releasedCapitalUsdc) || "-"}`;
}

async function main() {
  console.log(`Cancelled-order diagnosis at ${new Date().toISOString()}`);
  console.log(`event ${EVENT}`);
  console.log(`Read-only: nothing is written, no credentials are used.\n`);

  const live = await fetchJson(`${HOST}/api.php?action=state&target=live`);
  const generatedAt = live?.generatedAt || "";
  console.log(`live state generated ${generatedAt}\n`);

  console.log(`== 1. what our own state holds for this event`);
  const buckets = [
    ["open orders (resting now)", live?.openOrders],
    ["unfilled limit orders (left the book)", live?.unfilledLimitOrders],
    ["positions", live?.positions],
    ["closed trades", live?.closedTrades],
    ["activity", live?.activity],
  ];
  const tokens = new Set();
  for (const [label, rows] of buckets) {
    const matched = (Array.isArray(rows) ? rows : []).filter(mentionsEvent);
    console.log(`   ${label.padEnd(40)} ${String(matched.length).padStart(3)} row(s)`);
    for (const row of matched) {
      const token = text(row.tokenId || row.assetId || row.asset);
      if (token) tokens.add(token);
      console.log(`      [${text(row.outcome) || "-"}] status ${text(row.status) || "-"}   ${describeOrder(row)}`);
      console.log(`         created ${text(row.createdAt || row.openedAt) || "-"}`
        + `   left the book ${text(row.closedAt || row.detectedAt) || "-"}`);
      if (text(row.reason)) console.log(`         reason recorded by the sync: ${text(row.reason)}`);
      if (text(row.statusNote)) console.log(`         status note: ${text(row.statusNote)}`);
      console.log(`         filled ${text(row.filledSize) || "0"}   released ${text(row.releasedCapitalUsdc) || "-"} USDC`
        + `   token ${token.slice(0, 22) || "-"}`);
    }
  }
  console.log(`\n   released-capital ledger this run: ${(live?.releasedOrderCapital?.vanished || []).length} vanished,`
    + ` ${text(live?.releasedOrderCapital?.freedCapitalUsdc) || 0} USDC freed`);

  console.log(`\n== 2. is the market actually over? (only a resolved market may end an order)`);
  let marketTokens = [];
  try {
    const events = await fetchJson(`${GAMMA}/events?slug=${encodeURIComponent(EVENT)}`);
    const event = Array.isArray(events) ? events[0] : events;
    if (!event) {
      console.log(`   Gamma returned no event for this slug.`);
    } else {
      console.log(`   event    closed ${event.closed === true}   archived ${event.archived === true}`
        + `   endDate ${text(event.endDate) || "-"}`);
      for (const market of (Array.isArray(event.markets) ? event.markets : [])) {
        const ids = (() => {
          try { return JSON.parse(market.clobTokenIds || "[]").map(String); } catch { return []; }
        })();
        marketTokens.push(...ids);
        console.log(`   market   "${text(market.question).slice(0, 52)}"`);
        console.log(`            closed ${market.closed === true}   resolved ${market.resolved === true || market.isResolved === true}`
          + `   acceptingOrders ${market.acceptingOrders !== false}`
          + `   endDate ${text(market.endDate) || "-"}`);
        console.log(`            umaResolutionStatus ${text(market.umaResolutionStatus) || "-"}`
          + `   outcomePrices ${text(market.outcomePrices) || "-"}`);
      }
    }
  } catch (error) {
    console.log(`   Gamma lookup failed: ${String(error.message).slice(0, 90)}`);
  }

  // If the book is live and there is an ask to cross, the order really would have filled.
  console.log(`\n== 3. is the book still tradable right now?`);
  for (const token of [...new Set([...tokens, ...marketTokens])].slice(0, 4)) {
    try {
      const book = await fetchJson(`${CLOB}/book?token_id=${encodeURIComponent(token)}`);
      const bids = Array.isArray(book?.bids) ? book.bids : [];
      const asks = Array.isArray(book?.asks) ? book.asks : [];
      const bestBid = bids.map((row) => Number(row.price)).filter(Number.isFinite).sort((a, b) => b - a)[0];
      const bestAsk = asks.map((row) => Number(row.price)).filter(Number.isFinite).sort((a, b) => a - b)[0];
      console.log(`   ${token.slice(0, 22)}  bids ${bids.length}  asks ${asks.length}`
        + `  best bid ${bestBid ?? "-"}  best ask ${bestAsk ?? "-"}`);
    } catch (error) {
      console.log(`   ${token.slice(0, 22)}  book lookup failed: ${String(error.message).slice(0, 60)}`);
    }
  }

  console.log(`\n== 4. what our executor decided about it, from the run logs`);
  const modes = ["live", "live-5050", ...Object.keys((await fetchJson(`${HOST}/api.php?action=portfolio-config`).catch(() => ({})))?.config?.livePortfolios || {}).map((id) => `live-custom-${id}`)];
  for (const mode of modes) {
    const file = mode === "live" ? "live-execution-state.json" : `live-execution-state-${mode}.json`;
    let execution = null;
    try {
      execution = await fetchJson(`${HOST}/data/${file}`);
    } catch {
      continue;
    }
    const runs = [execution, ...(Array.isArray(execution?.runLog) ? execution.runLog : [])];
    const hits = [];
    for (const run of runs) {
      const at = text(run?.generatedAt || run?.runAt);
      for (const attempt of (Array.isArray(run?.attempts) ? run.attempts : [])) {
        if (mentionsEvent(attempt) || tokens.has(text(attempt.tokenId))) {
          hits.push({ at, kind: "attempt", action: text(attempt.action), reason: text(attempt.reason || attempt.statusNote), row: attempt });
        }
      }
      for (const review of (Array.isArray(run?.openOrderReviews) ? run.openOrderReviews : [])) {
        if (mentionsEvent(review) || tokens.has(text(review.tokenId))) {
          hits.push({ at, kind: "order review", action: text(review.action), reason: text(review.reason), row: review });
        }
      }
      for (const item of (Array.isArray(run?.expiredOrdersWithdrawnDetail) ? run.expiredOrdersWithdrawnDetail : [])) {
        if (mentionsEvent(item) || tokens.has(text(item.tokenId))) {
          hits.push({ at, kind: "expiry withdrawal", action: "WITHDRAW", reason: text(item.reason), row: item });
        }
      }
    }
    console.log(`\n   ${mode}: ${hits.length} log entr${hits.length === 1 ? "y" : "ies"} naming this event`);
    for (const hit of hits.slice(0, 12)) {
      console.log(`      ${(hit.at || "-").slice(0, 19)}  ${hit.kind.padEnd(18)} ${hit.action || "-"}`);
      if (hit.reason) console.log(`         ${hit.reason.slice(0, 190)}`);
      if (hit.row?.cancelResponse) console.log(`         cancelResponse: ${JSON.stringify(hit.row.cancelResponse).slice(0, 150)}`);
    }
  }

  console.log(`\n== what this means`);
  console.log(`   An entry under "order review" with action REPLACE or CANCEL_FOR_BETTER_CANDIDATE,`);
  console.log(`   or an "expiry withdrawal", is our own code taking the order off the book.`);
  console.log(`   No such entry, while section 1 shows it left the book, means Polymarket removed`);
  console.log(`   it -- which it does when the collateral behind a resting order stops being`);
  console.log(`   covered, and when a market stops accepting orders.`);
}

main().catch((error) => {
  console.log(`\n!! diagnosis stopped early: ${error?.message || error}`);
  process.exitCode = 1;
});
