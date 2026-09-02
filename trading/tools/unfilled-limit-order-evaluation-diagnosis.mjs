// Read-only diagnostic. Writes nothing, publishes nothing, needs no secrets.
//
// Reported: the "Unfilled limit orders" tab never grades its rows -- on the live portfolio
// as well as the paper ones. Both sides now have a backfill pass that is supposed to do
// exactly that, so this asks which of their gates each stuck row is actually failing,
// rather than re-confirming that the rows are stuck.
//
// Live (refreshUnfilledLimitOrderOutcomes in live-account-sync.mjs) selects what to revisit
// with two conditions, and a row failing either one is never looked at again:
//
//   if (optionalNumber(order?.finalOutcomePrice) != null) return false;      // already graded
//   const end = Date.parse(order?.endDate || order?.resolutionEndDate || "");
//   return Number.isFinite(end) && end <= now;                               // due for a look
//
// The second is the one worth measuring. A row carrying no usable end date at all answers
// NaN here, which is neither finite nor <= now, so it is excluded permanently -- not
// deferred, excluded. And the batch is sorted by outcomeLastCheckedAt ascending, which a
// failed Gamma lookup never stamps: a row whose market cannot be resolved stays at the very
// front of that queue on every subsequent sync, so a handful of them can hold the whole
// 16-slot batch and starve every row behind them.
//
// Paper (refreshUnfilledLimitOrderOutcomes in paper-trading-bot.mjs) has no end-date gate,
// so its rows are reported separately: what matters there is whether the pass has run at
// all since it shipped, which outcomeLastCheckedAt answers directly.
const HOST = process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading";
const ONLY_STRATEGY_ID = process.env.PAPER_DIAGNOSIS_STRATEGY_ID || "";
const LIVE_REFRESH_BATCH = Number(process.env.LIVE_UNFILLED_REFRESH_LIMIT || 16);

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
  if (value == null || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const days = (ms) => (ms == null ? null : ms / 86400000);

function isUnfilledLimitOrder(order = {}) {
  const status = String(order.status || "").toUpperCase();
  if (status !== "LIMIT_ORDER_EXPIRED" && status !== "LIVE_LIMIT_ORDER_UNFILLED") return false;
  return !(Number(order.filledSize) > 0.000001 || order.partiallyFilled === true || order.everFilled === true);
}

function isGraded(order) {
  const price = num(order.finalOutcomePrice);
  return price != null && (price >= 0.995 || price <= 0.005);
}

// Exactly the live pass's own selection test, so what this reports is what that pass sees.
function liveRefreshEligibility(order, now) {
  if (num(order?.finalOutcomePrice) != null) return "already carries a price";
  const end = Date.parse(order?.endDate || order?.resolutionEndDate || "");
  if (!Number.isFinite(end)) return "NO USABLE END DATE -- permanently outside the queue";
  if (end > now) return "end date still ahead; not due yet";
  return "in the queue";
}

function report(label, rows, now, { liveGates = false } = {}) {
  console.log(`\n== ${label}: ${rows.length} unfilled limit order(s)`);
  if (!rows.length) return;

  const graded = rows.filter(isGraded);
  const ungraded = rows.filter((order) => !isGraded(order));
  const midRange = ungraded.filter((order) => num(order.finalOutcomePrice) != null);
  console.log(`   graded (would win / would lose decided)   ${graded.length}`);
  console.log(`   ungraded                                  ${ungraded.length}`);
  if (midRange.length) console.log(`     of which a non-terminal price was stored ${midRange.length}`);

  const checked = rows.filter((order) => order.outcomeLastCheckedAt);
  console.log(`   ever visited by the backfill pass         ${checked.length} of ${rows.length}`
    + `${checked.length ? ` (newest ${checked.map((o) => o.outcomeLastCheckedAt).sort().slice(-1)[0]})` : ""}`);

  if (liveGates) {
    const buckets = new Map();
    for (const order of ungraded) {
      const reason = liveRefreshEligibility(order, now);
      buckets.set(reason, (buckets.get(reason) || 0) + 1);
    }
    console.log(`   -- why each ungraded row is or is not in the live refresh queue --`);
    for (const [reason, count] of [...buckets.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`     ${String(count).padStart(4)}  ${reason}`);
    }
    const queued = ungraded
      .filter((order) => liveRefreshEligibility(order, now) === "in the queue")
      .sort((a, b) => (Date.parse(a.outcomeLastCheckedAt || "") || 0) - (Date.parse(b.outcomeLastCheckedAt || "") || 0));
    console.log(`   queue depth ${queued.length}, batch size ${LIVE_REFRESH_BATCH}`
      + `${queued.length > LIVE_REFRESH_BATCH ? ` -- ${queued.length - LIVE_REFRESH_BATCH} row(s) wait behind the front of it` : ""}`);
    // The head of that queue is what every sync spends its whole batch on. If these have
    // never been stamped, their Gamma lookup is failing and they are blocking the rest.
    for (const order of queued.slice(0, Math.min(LIVE_REFRESH_BATCH, 8))) {
      const age = days(now - (Date.parse(order.closedAt || order.detectedAt || order.openedAt || "") || now));
      console.log(`     head: tokenId=${String(order.tokenId || order.assetId || "-").slice(0, 24)}`
        + ` lastChecked=${order.outcomeLastCheckedAt || "NEVER"}`
        + ` endDate=${order.endDate || order.resolutionEndDate || "-"}`
        + ` age=${age == null ? "?" : age.toFixed(1)}d`);
      console.log(`           "${String(order.question || "").slice(0, 80)}"`);
    }
  }

  const sample = ungraded
    .sort((a, b) => (Date.parse(a.closedAt || a.detectedAt || "") || 0) - (Date.parse(b.closedAt || b.detectedAt || "") || 0))
    .slice(0, 5);
  if (sample.length && !liveGates) {
    console.log(`   -- oldest ungraded rows --`);
    for (const order of sample) {
      const age = days(now - (Date.parse(order.closedAt || order.resolvedAt || "") || now));
      console.log(`     lastChecked=${order.outcomeLastCheckedAt || "NEVER"}`
        + ` finalOutcomePrice=${order.finalOutcomePrice ?? "null"}`
        + ` age=${age == null ? "?" : age.toFixed(1)}d slug=${order.slug || "-"}`);
    }
  }
}

async function main() {
  const now = Date.now();
  console.log(`Unfilled limit order evaluation diagnosis at ${new Date().toISOString()}`);
  console.log("Read-only: nothing is written, no credentials are used.");

  // 1. LIVE. One wallet, so one list, shared by the live and 5050 portfolios.
  const live = await fetchJson(`${HOST}/api.php?action=state&target=live`);
  if (!live.ok) {
    console.log(`\n!! could not read live state: HTTP ${live.status} ${live.error || ""}`);
  } else {
    const liveState = live.body?.state || live.body || {};
    const rows = (Array.isArray(liveState.unfilledLimitOrders) ? liveState.unfilledLimitOrders : [])
      .filter(isUnfilledLimitOrder);
    console.log(`\nlive state generatedAt: ${liveState.generatedAt || "(none)"}`);
    report("LIVE (shared wallet)", rows, now, { liveGates: true });
  }

  // 2. PAPER, per portfolio.
  const overview = await fetchJson(`${HOST}/api.php?action=state&target=paper&summary=dashboard`);
  if (!overview.ok) {
    console.log(`\n!! could not read paper overview: HTTP ${overview.status} ${overview.error || ""}`);
    return;
  }
  const overviewState = overview.body?.state || overview.body || {};
  const allIds = Object.keys(overviewState.paperPortfolios || {});
  const ids = ONLY_STRATEGY_ID ? [ONLY_STRATEGY_ID] : allIds;
  console.log(`\npaper portfolios: ${ids.length} of ${allIds.length}`);

  let paperTotal = 0;
  let paperGraded = 0;
  let paperEverChecked = 0;
  for (const id of ids) {
    const result = await fetchJson(`${HOST}/api.php?action=state&target=paper&summary=dashboard&strategy_id=${encodeURIComponent(id)}`);
    if (!result.ok) {
      console.log(`   ${id}: HTTP ${result.status} ${result.error || ""}`);
      continue;
    }
    const state = result.body?.state || result.body || {};
    const trades = Array.isArray(state.paperPortfolios?.[id]?.trades) ? state.paperPortfolios[id].trades : [];
    const rows = trades.filter(isUnfilledLimitOrder);
    if (!rows.length) continue;
    paperTotal += rows.length;
    paperGraded += rows.filter(isGraded).length;
    paperEverChecked += rows.filter((order) => order.outcomeLastCheckedAt).length;
    console.log(`   ${id.padEnd(20)} unfilled=${String(rows.length).padStart(4)}`
      + `  graded=${String(rows.filter(isGraded).length).padStart(4)}`
      + `  everChecked=${String(rows.filter((order) => order.outcomeLastCheckedAt).length).padStart(4)}`);
  }
  console.log(`\n== PAPER TOTAL: ${paperTotal} unfilled, ${paperGraded} graded, ${paperEverChecked} ever visited by the backfill`);
  console.log(`   everChecked 0 means the paper pass has not run since it shipped -- the pass`);
  console.log(`   stamps outcomeLastCheckedAt whether or not the market had closed yet.`);
}

main();
