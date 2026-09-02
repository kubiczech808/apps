// Read-only diagnostic. Writes nothing, publishes nothing, needs no secrets.
//
// Asked about one event: "Map Handicap: GL (-1.5) vs Nuclear TigeRES (+1.5)" closed at
// -1.52 USD, and a 175% stop loss should have produced a LARGER loss than that if it had
// fired -- so the suspicion is that the market did not resolve to 0 or 1 at all but was
// voided, paying 0.50 a share, and that nothing here is broken.
//
// That is testable rather than arguable. Polymarket pays a voided market 0.50 a share, so
// a position of N shares bought at price p loses exactly N * (p - 0.50) -- independent of
// anything on our side. This reports:
//
//   * what our state recorded for the trade: entry, shares, cost, status, realised P/L,
//     finalOutcomePrice, and whether a stop was armed;
//   * what Gamma says the market actually resolved to (with closed=true, which is the only
//     query that reaches a settled market);
//   * the loss a 0.50 settlement implies from our own recorded economics, against the loss
//     actually booked;
//   * the stop-loss risk target and trigger price the configured multiple implies, so
//     "the stop would have lost more" is a number rather than an impression.
const HOST = process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading";
const GAMMA = process.env.POLYMARKET_GAMMA_API || "https://gamma-api.polymarket.com";
const EVENT_SLUG = process.env.EVENT_SLUG || "cs2-ntr-gl1-2026-09-02";
const MATCH_TEXT = (process.env.MATCH_TEXT || "map handicap").toLowerCase();
const STOP_LOSS_MULTIPLIER = Number(process.env.STOP_LOSS_MULTIPLIER || 1.75);

async function fetchJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

const num = (value) => {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

function parseArrayField(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const matchesEvent = (row) => {
  const haystack = [row?.eventSlug, row?.slug, row?.question, row?.url, row?.title]
    .map((value) => String(value || "").toLowerCase())
    .join(" | ");
  return haystack.includes(EVENT_SLUG.toLowerCase()) || haystack.includes(MATCH_TEXT);
};

function describeTrade(label, row) {
  console.log(`\n-- ${label}`);
  console.log(`   question           ${row.question || "(none)"}`);
  console.log(`   outcome            ${row.outcome || "(none)"}`);
  console.log(`   status             ${row.status || "(none)"}`);
  console.log(`   slug / eventSlug   ${row.slug || "-"} / ${row.eventSlug || "-"}`);
  console.log(`   tokenId            ${row.tokenId || row.assetId || "-"}`);
  const entry = num(row.entryPrice ?? row.price);
  const shares = num(row.shares ?? row.size);
  const cost = num(row.totalCostUsdc ?? row.stakeUsdc);
  const reward = num(row.netGainIfWinUsdc);
  const realized = num(row.realizedPnlUsdc ?? row.pnlUsdc);
  console.log(`   entry price        ${entry ?? "-"}`);
  console.log(`   shares             ${shares ?? "-"}`);
  console.log(`   cost (stake)       ${cost ?? "-"}`);
  console.log(`   net gain if won    ${reward ?? "-"}`);
  console.log(`   realised P/L       ${realized ?? "-"}`);
  console.log(`   finalOutcomePrice  ${num(row.finalOutcomePrice) ?? "(none)"}`);
  console.log(`   exit price / value ${num(row.exitPrice) ?? "-"} / ${num(row.exitValueUsdc ?? row.currentValueUsdc) ?? "-"}`);
  console.log(`   stop loss          status ${row.stopLossStatus || "(none)"}`
    + `  multiplier ${num(row.stopLossRiskMultiplier) ?? "(none)"}`
    + `  stopPrice ${num(row.stopLossPrice) ?? "(none)"}`
    + `  triggeredAt ${row.stopLossTriggeredAt || "(none)"}`);
  console.log(`   riskTargetUsdc     ${num(row.riskTargetUsdc) ?? "(none)"}`);
  console.log(`   note               ${String(row.statusNote || "").slice(0, 200) || "(none)"}`);

  // A voided Polymarket market pays 0.50 a share. That figure comes from the position's
  // own size and entry, so it is a prediction this diagnostic can be wrong about -- which
  // is the point of printing it next to what was actually booked.
  if (shares != null && entry != null) {
    const voidLoss = shares * (entry - 0.5);
    console.log(`\n   if the market paid 0.50 a share:`);
    console.log(`     implied P/L      ${(-voidLoss).toFixed(4)}`);
    if (realized != null) {
      console.log(`     booked P/L       ${realized.toFixed(4)}`);
      console.log(`     -> ${Math.abs(realized - -voidLoss) < 0.02 ? "MATCHES a 0.50 settlement" : "does NOT match a 0.50 settlement"}`);
    }
  }

  // equalRiskStopPlan: riskTarget = min(cost, netGainIfWin * multiplier). The stop is the
  // price whose net exit value leaves at most that much of the cost lost, so a stop that
  // fires books riskTarget -- and if riskTarget exceeds what actually happened, the stop
  // firing would have been the worse outcome.
  if (cost != null && reward != null && reward > 0) {
    const riskTarget = Math.min(cost, reward * STOP_LOSS_MULTIPLIER);
    console.log(`\n   stop loss at ${(STOP_LOSS_MULTIPLIER * 100).toFixed(0)}% of the win:`);
    console.log(`     risk target      ${riskTarget.toFixed(4)}  (min of cost ${cost.toFixed(4)} and ${STOP_LOSS_MULTIPLIER} x reward ${reward.toFixed(4)})`);
    console.log(`     a fired stop books a loss of about that much`);
    if (realized != null) {
      const actualLoss = -realized;
      console.log(`     actual loss      ${actualLoss.toFixed(4)}`);
      console.log(`     -> the stop would have lost ${(riskTarget - actualLoss).toFixed(4)} ${riskTarget > actualLoss ? "MORE" : "LESS"} than what happened`);
      if (riskTarget > actualLoss) {
        console.log(`     -> so the position never fell far enough to arm it; not firing was correct`);
      }
    }
  }
}

async function main() {
  console.log(`Single event outcome diagnosis at ${new Date().toISOString()}`);
  console.log(`Read-only: nothing is written, no credentials are used.`);
  console.log(`event slug: ${EVENT_SLUG}   text match: "${MATCH_TEXT}"   stop multiplier: ${STOP_LOSS_MULTIPLIER}`);

  console.log(`\n=== WHAT GAMMA SAYS THE MARKET RESOLVED TO`);
  // A settled market is only reachable with closed=true; the unfiltered query answers with
  // nothing once it settles.
  const queries = [
    ["event slug + closed=true", `${GAMMA}/markets?slug=${encodeURIComponent(EVENT_SLUG)}&closed=true`],
    ["events by slug", `${GAMMA}/events?slug=${encodeURIComponent(EVENT_SLUG)}`],
    ["events by slug + closed=true", `${GAMMA}/events?slug=${encodeURIComponent(EVENT_SLUG)}&closed=true`],
  ];
  const gammaMarkets = [];
  for (const [label, url] of queries) {
    let payload = null;
    try {
      payload = await fetchJson(url);
    } catch (error) {
      console.log(`   ${label.padEnd(30)} threw: ${String(error.message).slice(0, 80)}`);
      continue;
    }
    const rows = Array.isArray(payload) ? payload : [];
    const markets = rows.flatMap((row) => (Array.isArray(row?.markets) ? row.markets : [row]));
    console.log(`   ${label.padEnd(30)} ${markets.length} market(s)`);
    for (const market of markets) if (market?.question) gammaMarkets.push(market);
  }

  const seen = new Set();
  for (const market of gammaMarkets) {
    const key = String(market.id || market.slug || market.question);
    if (seen.has(key)) continue;
    seen.add(key);
    const prices = parseArrayField(market.outcomePrices).map((value) => num(value));
    const outcomes = parseArrayField(market.outcomes).map(String);
    console.log(`\n   "${String(market.question || "").slice(0, 78)}"`);
    console.log(`     closed ${JSON.stringify(market.closed)}   active ${JSON.stringify(market.active)}`
      + `   umaResolutionStatus ${JSON.stringify(market.umaResolutionStatus ?? null)}`);
    console.log(`     outcomes       ${JSON.stringify(outcomes)}`);
    console.log(`     outcomePrices  ${JSON.stringify(prices)}`);
    // 0.5/0.5 is how Polymarket reports a voided or tied market: each share pays 0.50.
    const halved = prices.length === 2 && prices.every((price) => price != null && Math.abs(price - 0.5) < 0.01);
    const terminal = prices.some((price) => price != null && (price >= 0.995 || price <= 0.005));
    console.log(`     -> ${halved
      ? "VOIDED / TIED: both outcomes pay 0.50, so every holder loses the premium above 0.50"
      : (terminal ? "resolved to a normal 0/1 winner" : "no terminal price published")}`);
  }
  if (!gammaMarkets.length) console.log(`   !! Gamma returned no market for this slug at all`);

  console.log(`\n=== WHAT OUR STATE RECORDED`);
  const live = await fetchJson(`${HOST}/api.php?action=state&target=live&t=${Date.now()}`);
  const liveState = live?.state || live || {};
  const liveRows = [
    ...(Array.isArray(liveState.closedTrades) ? liveState.closedTrades : []),
    ...(Array.isArray(liveState.positions) ? liveState.positions : []),
    ...(Array.isArray(liveState.unfilledLimitOrders) ? liveState.unfilledLimitOrders : []),
  ].filter(matchesEvent);
  console.log(`   live rows matching: ${liveRows.length}`);
  liveRows.forEach((row, index) => describeTrade(`LIVE #${index + 1}`, row));

  const overview = await fetchJson(`${HOST}/api.php?action=state&target=paper&summary=portfolio-overview&t=${Date.now()}`);
  const overviewState = overview?.state || overview || {};
  const ids = Object.keys(overviewState.paperPortfolios || {});
  console.log(`\n   scanning ${ids.length} paper portfolio(s)`);
  let paperHits = 0;
  for (const id of ids) {
    const payload = await fetchJson(`${HOST}/api.php?action=state&target=paper&summary=dashboard&strategy_id=${encodeURIComponent(id)}&t=${Date.now()}`);
    const rows = (payload?.state || payload || {}).paperPortfolios?.[id]?.trades || [];
    const hits = (Array.isArray(rows) ? rows : []).filter(matchesEvent);
    if (!hits.length) continue;
    paperHits += hits.length;
    hits.forEach((row, index) => describeTrade(`PAPER ${id} #${index + 1}`, row));
  }
  if (!paperHits) console.log(`   no paper portfolio holds a row for this event`);
}

main().catch((error) => {
  console.log(`\n!! diagnosis stopped early: ${error?.message || error}`);
  process.exitCode = 1;
});
