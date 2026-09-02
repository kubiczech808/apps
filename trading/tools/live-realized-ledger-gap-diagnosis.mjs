// Read-only diagnostic. Writes nothing, publishes nothing, needs no secrets.
//
// The equity chart draws one straight segment because portfolioEquityHistory() discards
// every intermediate step when the closed-trade ledger disagrees with the account's
// realised P/L:
//
//   const settledLedgerMatchesBalance = !hasAuthoritativeRealizedPnl
//     || Math.abs(settledPnl - authoritativeRealizedPnl) < 0.01;
//   const chartEvents = settledLedgerMatchesBalance ? settledEvents : [];
//
// A previous pass measured that gap at 173.01 on the live account, but it summed
// closedTrades AND trades together, which the dashboard does not do -- so part of that
// number may have been the diagnostic's own double count. This one mirrors the app
// exactly and reports each source separately, then breaks the remaining gap down far
// enough to say whether it is an excludable subset or a genuinely wrong ledger.
//
// Two different figures both claim to be "realised P/L", and which one the chart trusts
// matters, so both are printed:
//
//   portfolio.realizedPnlUsdc          what live-account-sync's portfolioSummary computed
//                                      (positions' realised + closed trades' realised)
//   equity - deposited - openPnl       what app.js computes at line 9700 and passes to
//                                      the chart as the authoritative figure
const HOST = process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading";

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

// isClosedTrade in app.js, quoted so this reads the same rows the chart reads.
const CLOSED = ["WON", "LOST", "CLOSED", "REDEEMED", "SOLD", "REDEEM_REQUIRED", "RESOLVED", "STOP_LOSS", "STOP_GAP", "LIMIT_ORDER_EXPIRED", "LIVE_LIMIT_ORDER_UNFILLED"];
const isClosedTrade = (trade) => CLOSED.includes(String(trade?.status || "").toUpperCase());
const closedAt = (trade) => trade?.resolvedAt || trade?.closedAt || trade?.closedTime || null;
const pnlOf = (trade) => num(trade?.realizedPnlUsdc ?? trade?.pnlUsdc);
const sum = (rows) => rows.reduce((total, row) => total + (pnlOf(row) ?? 0), 0);

function tally(label, rows, keyOf) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (!groups.has(key)) groups.set(key, { count: 0, pnl: 0 });
    const group = groups.get(key);
    group.count += 1;
    group.pnl += pnlOf(row) ?? 0;
  }
  console.log(`   -- ${label} --`);
  for (const [key, group] of [...groups.entries()].sort((a, b) => a[1].pnl - b[1].pnl)) {
    console.log(`      ${String(key).slice(0, 40).padEnd(42)} ${String(group.count).padStart(4)} rows  ${group.pnl >= 0 ? "+" : ""}${group.pnl.toFixed(4)}`);
  }
}

async function main() {
  console.log(`Live realised-ledger gap diagnosis at ${new Date().toISOString()}`);
  console.log("Read-only: nothing is written, no credentials are used.\n");

  const live = await fetchJson(`${HOST}/api.php?action=state&target=live&t=${Date.now()}`);
  const state = live?.state || live || {};
  const portfolio = state.portfolio || {};
  const closedTrades = Array.isArray(state.closedTrades) ? state.closedTrades : [];
  const positions = Array.isArray(state.positions) ? state.positions : [];
  const trades = Array.isArray(state.trades) ? state.trades : [];

  console.log("== the account's own figures");
  const equity = num(portfolio.equityUsdc);
  const deposited = num(portfolio.originalValueUsdc ?? portfolio.depositedUsdc);
  const openPnl = num(portfolio.openPnlUsdc) ?? 0;
  const syncRealized = num(portfolio.realizedPnlUsdc);
  console.log(`   equityUsdc                       ${equity}`);
  console.log(`   originalValue / deposited        ${deposited}`);
  console.log(`   openPnlUsdc                      ${openPnl}`);
  console.log(`   portfolio.realizedPnlUsdc        ${syncRealized}   <- computed by the sync from its own ledger`);
  const appRealized = equity != null && deposited != null ? equity - deposited - openPnl : null;
  console.log(`   equity - deposited - openPnl     ${appRealized == null ? "(n/a)" : appRealized.toFixed(4)}   <- what app.js passes the chart`);
  if (syncRealized != null && appRealized != null) {
    console.log(`   the two disagree by              ${Math.abs(syncRealized - appRealized).toFixed(4)}`);
  }

  console.log("\n== the state's trade arrays, separately");
  console.log(`   closedTrades                     ${closedTrades.length} rows, sum ${sum(closedTrades).toFixed(4)}`);
  console.log(`   positions                        ${positions.length} rows, sum ${sum(positions).toFixed(4)}`);
  console.log(`   trades                           ${trades.length} rows, sum ${sum(trades).toFixed(4)}`);
  // The previous pass added closedTrades and trades together. If they overlap, that alone
  // inflated the gap it reported.
  const closedIds = new Set(closedTrades.map((row) => String(row.id || row.tokenId || "")));
  const overlap = trades.filter((row) => closedIds.has(String(row.id || row.tokenId || "")));
  console.log(`   trades that are also closedTrades ${overlap.length} rows, sum ${sum(overlap).toFixed(4)}`);

  // Exactly what the chart is handed: [...closedTrades, ...positions], then filtered.
  const chartRows = [...closedTrades, ...positions].filter(isClosedTrade)
    .filter((row) => closedAt(row) && Number.isFinite(Date.parse(closedAt(row))))
    .filter((row) => pnlOf(row) != null);
  const chartSum = sum(chartRows);
  console.log(`\n== what the chart actually walks ([...closedTrades, ...positions], filtered)`);
  console.log(`   settlement events                ${chartRows.length} rows, sum ${chartSum.toFixed(4)}`);
  if (appRealized != null) {
    const gap = Math.abs(chartSum - appRealized);
    console.log(`   gap vs the chart's authority     ${gap.toFixed(4)} -> ${gap < 0.01 ? "MATCHES" : "DISAGREES"}`);
  }

  console.log("");
  tally("by status", chartRows, (row) => String(row.status || "?").toUpperCase());
  tally("by reconciliationOnly", chartRows, (row) => (row.reconciliationOnly === true ? "reconciliationOnly" : "real fill"));
  tally("by which P/L field carried the value", chartRows, (row) => (
    row.realizedPnlUsdc != null && row.realizedPnlUsdc !== "" ? "realizedPnlUsdc" : "pnlUsdc"
  ));
  tally("by settlement month", chartRows, (row) => String(closedAt(row)).slice(0, 7));

  // Double counting is the first thing to rule out, because the sync's own history merge
  // is what a parallel change is currently reworking.
  const byToken = new Map();
  for (const row of chartRows) {
    const key = `${String(row.tokenId || row.conditionId || row.question || "?")}`;
    if (!byToken.has(key)) byToken.set(key, []);
    byToken.get(key).push(row);
  }
  const repeated = [...byToken.entries()].filter(([, rows]) => rows.length > 1);
  const repeatedExtraPnl = repeated.reduce((total, [, rows]) => total + sum(rows.slice(1)), 0);
  console.log(`\n== repeated settlements for one token/market`);
  console.log(`   tokens settled more than once    ${repeated.length}`);
  console.log(`   P/L in all but the first of each ${repeatedExtraPnl.toFixed(4)}`);
  if (appRealized != null) {
    const withoutRepeats = chartSum - repeatedExtraPnl;
    console.log(`   ledger without those repeats     ${withoutRepeats.toFixed(4)}`
      + `  -> gap ${Math.abs(withoutRepeats - appRealized).toFixed(4)}`);
  }
  for (const [key, rows] of repeated.sort((a, b) => sum(b[1].slice(1)) - sum(a[1].slice(1))).slice(0, 6)) {
    console.log(`   ${String(rows[0].question || key).slice(0, 56)}`);
    for (const row of rows) {
      console.log(`      ${String(row.status || "?").padEnd(22)} ${String(closedAt(row)).slice(0, 19)}  `
        + `${(pnlOf(row) ?? 0) >= 0 ? "+" : ""}${(pnlOf(row) ?? 0).toFixed(4)}`
        + `  stake ${num(row.totalCostUsdc ?? row.stakeUsdc) ?? "-"}`
        + `${row.reconciliationOnly === true ? "  reconciliationOnly" : ""}`);
    }
  }

  console.log(`\n== largest single contributors`);
  for (const row of [...chartRows].sort((a, b) => (pnlOf(a) ?? 0) - (pnlOf(b) ?? 0)).slice(0, 8)) {
    console.log(`   ${(pnlOf(row) ?? 0).toFixed(4).padStart(11)}  ${String(row.status || "?").padEnd(22)}`
      + ` stake ${String(num(row.totalCostUsdc ?? row.stakeUsdc) ?? "-").padStart(7)}`
      + `  ${String(row.question || "").slice(0, 48)}`);
  }
}

main().catch((error) => {
  console.log(`\n!! diagnosis stopped early: ${error?.message || error}`);
  process.exitCode = 1;
});
