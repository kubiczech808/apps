// Read-only diagnostic. Writes nothing, publishes nothing, needs no secrets.
//
// Reported: the equity history chart draws one straight segment from the first day to
// today and shows nothing in between. The chart is not a sampled equity series -- it is
// derived from the closed-trade ledger by portfolioEquityHistory() in app.js, which walks
// settlements and steps the running equity at each one. A straight two-point line means
// that walk produced no intermediate steps, and there are only two ways that happens:
//
//   1. There are no settlements to step on (an empty or unusable closed ledger), or
//   2. this guard emptied them:
//        const settledLedgerMatchesBalance = !hasAuthoritativeRealizedPnl
//          || Math.abs(settledPnl - authoritativeRealizedPnl) < 0.01;
//        const chartEvents = settledLedgerMatchesBalance ? settledEvents : [];
//      -- the stored ledger's own sum disagreeing with the account's realised P/L by a
//      cent or more discards every step and keeps only baseline-to-current.
//
// This reports which, with the two numbers that decide it, and how many distinct days the
// settlements actually fall on -- which is the ceiling on how detailed any per-day curve
// could be from this data.
const HOST = process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading";
const PAPER_STRATEGY_ID = process.env.PAPER_DIAGNOSIS_STRATEGY_ID || "";

async function fetchJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

const num = (value) => {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const CLOSED = ["WON", "LOST", "CLOSED", "REDEEMED", "SOLD", "REDEEM_REQUIRED", "RESOLVED", "STOP_LOSS", "STOP_GAP", "LIMIT_ORDER_EXPIRED"];
const isClosedTrade = (trade) => CLOSED.includes(String(trade?.status || "").toUpperCase());
const isUnfilled = (trade) => {
  const status = String(trade?.status || "").toUpperCase();
  return status === "LIMIT_ORDER_EXPIRED" || status === "LIVE_LIMIT_ORDER_UNFILLED";
};
const closedAt = (trade) => trade?.resolvedAt || trade?.closedAt || trade?.closedTime || null;
const dayKey = (timestamp) => new Date(timestamp).toISOString().slice(0, 10);

function report(label, { trades, equity, openPnl, originalValue, realizedPnl }) {
  console.log(`\n== ${label}`);
  const rows = Array.isArray(trades) ? trades : [];
  console.log(`   trades in payload           ${rows.length}`);
  if (!rows.length) return;

  const openedTimes = rows.map((t) => Date.parse(t.openedAt || t.date || "")).filter(Number.isFinite);
  if (!openedTimes.length) {
    console.log(`   !! no parseable openedAt on any trade; the chart returns null before drawing`);
    return;
  }
  const first = Math.min(...openedTimes);
  const now = Date.now();
  const durationDays = (now - first) / 86400000;
  console.log(`   first opened                ${new Date(first).toISOString()} (${durationDays.toFixed(1)} days ago)`);
  if (durationDays < 3) console.log(`   !! under 3 days, so the chart is hidden entirely`);

  const settled = rows
    .filter(isClosedTrade)
    .map((trade) => ({ timestamp: Date.parse(closedAt(trade) || ""), pnl: num(trade.realizedPnlUsdc ?? trade.pnlUsdc) }))
    .filter((event) => Number.isFinite(event.timestamp) && event.timestamp <= now && event.pnl != null);
  const settledPnl = settled.reduce((sum, event) => sum + event.pnl, 0);
  console.log(`   closed trades               ${rows.filter(isClosedTrade).length}`
    + ` (of which unfilled orders ${rows.filter(isUnfilled).length})`);
  console.log(`   usable settlement events    ${settled.length}`);
  console.log(`   distinct settlement days    ${new Set(settled.map((e) => dayKey(e.timestamp))).size}`);

  const configuredOriginal = num(originalValue);
  const hasOriginal = configuredOriginal != null && configuredOriginal > 0;
  const authoritative = num(realizedPnl);
  const hasAuthoritative = hasOriginal && authoritative != null;
  console.log(`   configured original value   ${hasOriginal ? configuredOriginal : "(none)"}`);
  console.log(`   ledger sum (settledPnl)     ${settledPnl.toFixed(4)}`);
  console.log(`   authoritative realizedPnl   ${authoritative == null ? "(none)" : authoritative.toFixed(4)}`);

  if (!hasAuthoritative) {
    console.log(`   -> no authoritative figure to reconcile against, so every settlement is drawn.`);
  } else {
    const gap = Math.abs(settledPnl - authoritative);
    const matches = gap < 0.01;
    console.log(`   reconciliation gap          ${gap.toFixed(4)} -> ${matches ? "MATCHES" : "DISAGREES"} (threshold 0.01)`);
    if (!matches) {
      console.log(`   -> THIS is why the line is straight: chartEvents is emptied, so the walk`);
      console.log(`      draws only the opening baseline and today's realised equity.`);
    }
  }

  const drawnSteps = (!hasAuthoritative || Math.abs(settledPnl - authoritative) < 0.01) ? settled.length : 0;
  console.log(`   steps the chart would draw  ${drawnSteps}`);
  console.log(`   points on the chart         ${drawnSteps ? "1 baseline + up to one per settlement day + today" : "2 (baseline and today) -- a straight line"}`);

  if (settled.length) {
    const byDay = new Map();
    for (const event of settled) {
      const key = dayKey(event.timestamp);
      byDay.set(key, (byDay.get(key) || 0) + event.pnl);
    }
    const days = [...byDay.entries()].sort();
    console.log(`   -- realised change per day (the shape a per-day curve could have) --`);
    for (const [day, pnl] of days.slice(0, 12)) {
      console.log(`      ${day}  ${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)}`);
    }
    if (days.length > 12) console.log(`      ... and ${days.length - 12} more day(s)`);
  }
}

async function main() {
  console.log(`Equity history shape diagnosis at ${new Date().toISOString()}`);
  console.log("Read-only: nothing is written, no credentials are used.");

  const live = await fetchJson(`${HOST}/api.php?action=state&target=live&t=${Date.now()}`);
  const liveState = live?.state || live || {};
  const portfolio = liveState.portfolio || {};
  report("LIVE", {
    trades: [
      ...(Array.isArray(liveState.closedTrades) ? liveState.closedTrades : []),
      ...(Array.isArray(liveState.trades) ? liveState.trades : []),
    ],
    equity: num(portfolio.equityUsdc),
    openPnl: num(portfolio.openPnlUsdc) ?? 0,
    originalValue: num(portfolio.originalValueUsdc ?? portfolio.depositedUsdc),
    realizedPnl: num(portfolio.realizedPnlUsdc),
  });

  if (PAPER_STRATEGY_ID) {
    const paper = await fetchJson(`${HOST}/api.php?action=state&target=paper&summary=dashboard&strategy_id=${encodeURIComponent(PAPER_STRATEGY_ID)}&t=${Date.now()}`);
    const paperState = paper?.state || paper || {};
    const row = paperState.paperPortfolios?.[PAPER_STRATEGY_ID] || {};
    report(`PAPER ${PAPER_STRATEGY_ID}`, {
      trades: Array.isArray(row.trades) ? row.trades : [],
      equity: num(row.portfolio?.equityUsdc),
      openPnl: num(row.portfolio?.openPnlUsdc) ?? 0,
      originalValue: num(row.portfolio?.originalValueUsdc),
      realizedPnl: num(row.portfolio?.realizedPnlUsdc),
    });
  }
}

main().catch((error) => {
  console.log(`\n!! diagnosis stopped early: ${error?.message || error}`);
  process.exitCode = 1;
});
