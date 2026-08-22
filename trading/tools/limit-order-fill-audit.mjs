// Read-only audit. Places nothing, writes nothing.
//
// The question: are resting limit orders checked validly and often enough that the moment a
// real order would have been filled is never missed?
//
// The fill test is a snapshot. limitOrderFillDecision compares the limit price against the
// *current* best ask, so a market that dips to the limit and comes back between two checks
// leaves no trace in the book -- and a real resting order would have been taken by that dip.
// Whether that actually happens is not a matter of opinion: the CLOB publishes traded prices,
// so for every waiting order this asks what the market's lowest traded price has been since
// the order was placed, and compares it against the limit. A minimum at or below the limit,
// on an order still sitting in WAITING, is a fill we missed.
//
// It also measures the cadence itself, because "often enough" needs a number: how long ago
// each waiting order was last looked at, and how many carry a failed book read.
const HOST = process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading";
const CLOB = process.env.POLYMARKET_CLOB_HOST || "https://clob.polymarket.com";
const MAX_PROBES = Math.max(1, Number(process.env.FILL_AUDIT_MAX_PROBES || 40));

async function fetchJson(url, attempts = 2) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      const text = await response.text();
      try {
        return { ok: response.ok, status: response.status, body: JSON.parse(text) };
      } catch {
        return { ok: false, status: response.status, error: text.slice(0, 200) };
      }
    } catch (error) {
      if (attempt < attempts) continue;
      return { ok: false, status: 0, error: `read failed: ${error?.message || error}` };
    }
  }
  return { ok: false, status: 0, error: "read failed" };
}

const minutesSince = (iso) => {
  const at = Date.parse(iso || "");
  return Number.isFinite(at) ? (Date.now() - at) / 60000 : null;
};

// The lowest price the market actually traded at over a window, which is what decides
// whether a resting buy would have been hit. fidelity is in minutes; 1 is the finest the
// CLOB serves, so a dip shorter than a minute can still hide -- worth knowing rather than
// pretending otherwise.
async function lowestTradedPrice(tokenId, sinceIso) {
  const startTs = Math.floor(Date.parse(sinceIso || "") / 1000);
  if (!Number.isFinite(startTs)) return { ok: false, note: "no start time on the order" };
  const endTs = Math.floor(Date.now() / 1000);
  const url = `${CLOB}/prices-history?market=${encodeURIComponent(tokenId)}`
    + `&startTs=${startTs}&endTs=${endTs}&fidelity=1`;
  const result = await fetchJson(url);
  if (!result.ok) return { ok: false, note: `HTTP ${result.status} ${result.error || ""}`.trim() };
  const history = Array.isArray(result.body?.history) ? result.body.history : null;
  if (!history) return { ok: false, note: `unexpected shape: ${JSON.stringify(result.body).slice(0, 120)}` };
  if (!history.length) return { ok: true, points: 0, low: null, lowAt: null };
  let low = Infinity;
  let lowAt = null;
  for (const point of history) {
    const price = Number(point?.p);
    if (!Number.isFinite(price)) continue;
    if (price < low) {
      low = price;
      lowAt = Number(point?.t);
    }
  }
  return {
    ok: true,
    points: history.length,
    low: Number.isFinite(low) ? low : null,
    lowAt: Number.isFinite(lowAt) ? new Date(lowAt * 1000).toISOString() : null,
  };
}

async function bestAskFor(tokenId) {
  const result = await fetchJson(`${CLOB}/book?token_id=${encodeURIComponent(tokenId)}`);
  if (!result.ok) return { ok: false, note: `HTTP ${result.status}` };
  const asks = Array.isArray(result.body?.asks) ? result.body.asks : [];
  // The book lists asks worst-first, so the best ask is the highest-indexed lowest price;
  // taking the minimum is order-independent and cannot be wrong about which end is which.
  let best = Infinity;
  for (const level of asks) {
    const price = Number(level?.price);
    const size = Number(level?.size);
    if (Number.isFinite(price) && Number.isFinite(size) && size > 0 && price < best) best = price;
  }
  return { ok: true, bestAsk: Number.isFinite(best) ? best : null };
}

async function main() {
  console.log(`Limit order fill audit at ${new Date().toISOString()}\n`);

  const config = await fetchJson(`${HOST}/api.php?action=portfolio-config`);
  const paper = config.ok ? (config.body?.config?.paper || {}) : {};

  const waiting = [];
  for (const id of Object.keys(paper)) {
    const served = await fetchJson(
      `${HOST}/api.php?action=state&target=paper&summary=dashboard&strategy_id=${encodeURIComponent(id)}`,
    );
    if (!served.ok) {
      console.log(`!! ${id}: served HTTP ${served.status} ${served.error || ""}`);
      continue;
    }
    const entry = (served.body?.paperPortfolios || {})[id] || {};
    for (const trade of (Array.isArray(entry.trades) ? entry.trades : [])) {
      if (String(trade?.status || "") === "LIMIT_ORDER_WAITING") waiting.push({ id, trade });
    }
  }
  console.log(`${waiting.length} resting order(s) across ${Object.keys(paper).length} portfolio(s)\n`);
  if (!waiting.length) return;

  // How often a waiting order is actually looked at. Every pass refreshes every portfolio's
  // trades, so this should track the pass cadence rather than a portfolio's execution
  // cadence -- and if it does not, that is the finding.
  {
    const ages = waiting
      .map(({ trade }) => minutesSince(trade.lastCheckedAt))
      .filter((value) => value != null)
      .sort((a, b) => a - b);
    console.log(`-- how long since each resting order was last checked --`);
    if (!ages.length) console.log(`   no order carries lastCheckedAt`);
    else {
      const at = (fraction) => ages[Math.min(ages.length - 1, Math.floor(ages.length * fraction))];
      console.log(`   min=${ages[0].toFixed(1)}min median=${at(0.5).toFixed(1)}min`
        + ` p90=${at(0.9).toFixed(1)}min max=${ages[ages.length - 1].toFixed(1)}min`);
      const stale = ages.filter((value) => value > 15).length;
      console.log(`   older than 15 minutes: ${stale} of ${ages.length}`);
    }
    const failed = waiting.filter(({ trade }) => /refresh failed/i.test(String(trade.statusNote || "")));
    console.log(`   carrying a failed read: ${failed.length}`);
    for (const { id, trade } of failed.slice(0, 5)) {
      console.log(`      ${id} ${String(trade.statusNote || "").slice(0, 110)}`);
    }
  }

  // The real question. For each order, the lowest price the market traded at since the
  // order was placed, against the price the order rests at.
  console.log(`\n-- did the market come down to the limit while we were not looking? --`);
  const probes = waiting.slice(0, MAX_PROBES);
  if (waiting.length > probes.length) {
    console.log(`   probing ${probes.length} of ${waiting.length}; raise FILL_AUDIT_MAX_PROBES for the rest`);
  }
  let missed = 0;
  let checked = 0;
  let unavailable = 0;
  for (const { id, trade } of probes) {
    const limitPrice = Number(trade.entryPrice);
    const placedAt = trade.openedAt || trade.date || trade.lastCheckedAt;
    const [history, book] = await Promise.all([
      lowestTradedPrice(trade.tokenId, placedAt),
      bestAskFor(trade.tokenId),
    ]);
    if (!history.ok) {
      unavailable += 1;
      console.log(`   ${id.padEnd(16)} limit=${limitPrice.toFixed(4)} -- history unavailable: ${history.note}`);
      continue;
    }
    checked += 1;
    const low = history.low;
    const wouldHaveFilled = Number.isFinite(low) && Number.isFinite(limitPrice) && low <= limitPrice;
    if (wouldHaveFilled) missed += 1;
    console.log(`   ${id.padEnd(16)} limit=${limitPrice.toFixed(4)}`
      + ` low=${low == null ? "  n/a " : low.toFixed(4)}`
      + ` ask=${book.ok && book.bestAsk != null ? book.bestAsk.toFixed(4) : " n/a "}`
      + ` points=${String(history.points).padStart(4)}`
      + ` since=${String(placedAt || "-").slice(0, 19)}`
      + (wouldHaveFilled ? `  <- MISSED FILL, low at ${String(history.lowAt || "?").slice(0, 19)}` : "")
      + `  ${String(trade.question || "").slice(0, 40)}`);
    // Which branch the refresh actually took on this row. Inferring that from the numbers
    // was where I went wrong once already: an empty ask side and a failed book read look
    // identical from outside, and only one of them is about liquidity.
    if (wouldHaveFilled) {
      console.log(`        lastChecked=${String(trade.lastCheckedAt || "-").slice(0, 19)}`
        + ` note="${String(trade.statusNote || "").slice(0, 130)}"`);
    }
  }
  console.log(`\n   probed=${checked} missedFill=${missed} historyUnavailable=${unavailable}`);
  if (checked) {
    console.log(`   ${((missed / checked) * 100).toFixed(1)}% of resting orders should already have filled`);
  }
}

main().catch((error) => {
  console.log(`\n!! audit stopped early: ${error?.message || error}`);
  process.exitCode = 1;
});
