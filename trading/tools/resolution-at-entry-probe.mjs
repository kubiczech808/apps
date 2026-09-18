#!/usr/bin/env node
// Read-only. Public GETs against the published state. No keys, no writes, no orders.
//
// Reported on "70-80 esports": the Portfolio trade analysis table "Resolution at entry"
// shows <= 1 day as heavily loss-making and as almost every trade, while the rest read
// "Not recorded" -- "takze nevim, jestli byli opened v zapornem case zbyvajicim do
// resolution date / end date nebo jsou otevreny drive nez 1 den dopredu".
//
// There is a reason to doubt the table before tuning anything by it. The band reads
// trade.daysToResolution, and that field is RECOMPUTED on every mark of an open position
// (paper-trading-bot.mjs patches it from the market's current end date each pass). On a
// closed trade it therefore holds the horizon at the LAST mark, not at entry -- and for a
// resolved position that is approximately zero. If so, "<= 1 day" is not a band at all: it
// is every resolved trade, and the table is measuring nothing.
//
// So this reports, for one portfolio's closed trades:
//
//   1. which timing fields each trade actually carries, so "not recorded" can be told from
//      "recorded and wrong";
//   2. the horizon AT ENTRY, derived from the dates on the trade -- endDate minus openedAt,
//      and resolutionEndDate minus openedAt -- against the stored daysToResolution;
//   3. P&L by hour band, on the derived entry horizon, at several granularities, so the
//      bands can be chosen from the data rather than guessed.
const HOST = (process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading").replace(/\/+$/, "");
const PORTFOLIO = process.env.PROBE_PORTFOLIO || "70-80 esports";

async function get(path) {
  const response = await fetch(`${HOST}/${path}`, { headers: { Accept: "application/json" } });
  const text = await response.text();
  if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status}: ${text.slice(0, 160)}`);
  return JSON.parse(text);
}

const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
const money = (value) => `${value < 0 ? "-" : "+"}$${Math.abs(value).toFixed(2)}`;
const at = (value) => {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
};

// Hours from when the position was opened to when the market was due. Two candidates,
// because they are different dates on a sports fixture: endDate is substituted with the
// kickoff, resolutionEndDate is when the money actually comes back.
function entryHours(trade, field) {
  const opened = at(trade.openedAt || trade.date);
  const due = at(trade[field]);
  if (opened == null || due == null) return null;
  return (due - opened) / 3600000;
}

function bandStats(trades, hoursOf, edges) {
  const labels = [...edges.map((edge, index) =>
    index === 0 ? `<= ${edge} h` : `${edges[index - 1]}-${edge} h`), `> ${edges.at(-1)} h`];
  const rows = labels.map((label) => ({ label, trades: 0, wins: 0, pnl: 0, staked: 0 }));
  let unknown = 0;
  for (const trade of trades) {
    const hours = hoursOf(trade);
    if (hours == null) { unknown += 1; continue; }
    let index = edges.findIndex((edge) => hours <= edge);
    if (index === -1) index = edges.length;
    rows[index].trades += 1;
    rows[index].pnl += num(trade.realizedPnlUsdc) ?? 0;
    rows[index].staked += num(trade.totalCostUsdc) ?? num(trade.stakeUsdc) ?? 0;
    if ((num(trade.realizedPnlUsdc) ?? 0) > 0) rows[index].wins += 1;
  }
  return { rows, unknown };
}

function printBands(title, { rows, unknown }) {
  console.log(`\n   ${title}`);
  console.log("      band          trades   wins    staked        P/L       return");
  for (const row of rows) {
    if (!row.trades) continue;
    const ret = row.staked > 0 ? (row.pnl / row.staked) * 100 : 0;
    console.log(`      ${row.label.padEnd(13)}${String(row.trades).padStart(6)}`
      + `${String(row.wins).padStart(7)}`
      + `${`$${row.staked.toFixed(2)}`.padStart(11)}`
      + `${money(row.pnl).padStart(11)}`
      + `${`${ret >= 0 ? "+" : ""}${ret.toFixed(1)}%`.padStart(12)}`);
  }
  if (unknown) console.log(`      (${unknown} trade(s) with no usable date)`);
}

async function main() {
  console.log(`Resolution at entry, ${new Date().toISOString()}`);
  console.log("Read-only: nothing is written and no credentials are used.\n");

  // A portfolio can be paper or live, and the names differ from the ids: the first run of
  // this probe looked only at paperPortfolios and reported no match for "70-80 esports",
  // which is a LIVE portfolio stored under live-custom-underway. The saved config is what
  // maps a name to an id, so the search starts there and then looks in both states.
  const want = PORTFOLIO.toLowerCase();
  const config = await get("api.php?action=portfolio-config").catch(() => null);
  const named = [];
  for (const [id, entry] of Object.entries(config?.config?.livePortfolios || {})) {
    named.push({ id, name: String(entry?.displayName || id), live: true });
  }
  for (const [id, entry] of Object.entries(config?.config?.paper || {})) {
    named.push({ id, name: String(entry?.displayName || id), live: false });
  }
  const match = named.find((entry) => entry.name.toLowerCase().includes(want) || entry.id.toLowerCase().includes(want));
  if (!match) {
    console.log(`No portfolio matching "${PORTFOLIO}". Configured portfolios:`);
    for (const entry of named) console.log(`   ${entry.live ? "live " : "paper"}  ${entry.id.padEnd(28)} ${entry.name}`);
    return 0;
  }
  const { id, live } = match;
  const row = { displayName: `${match.name} (${live ? "live" : "paper"}, ${id})` };
  let trades = [];
  if (live) {
    // A live portfolio's trades are attributed on the live state rather than stored under
    // a paper portfolio, so they are read from there and filtered to this portfolio.
    const state = await get("api.php?action=state&target=live");
    const all = state?.trades || state?.state?.trades || state?.liveState?.trades || [];
    trades = all.filter((trade) => !trade?.portfolioId || String(trade.portfolioId) === id
      || String(trade.strategyId || "") === id);
  } else {
    const state = await get(`api.php?action=state&target=paper&summary=dashboard&strategy_id=${encodeURIComponent(id)}`);
    trades = ((state?.paperPortfolios || state?.state?.paperPortfolios || {})[id] || {}).trades || [];
  }
  const closed = trades.filter((trade) => String(trade.status || "").toUpperCase() !== "OPEN"
    && String(trade.status || "").toUpperCase() !== "LIMIT_ORDER_WAITING"
    && (trade.resolvedAt || trade.closedAt));
  console.log(`${row.displayName || id}: ${trades.length} trades, ${closed.length} closed\n`);
  if (!closed.length) return 0;

  // 1. Which fields are actually there.
  console.log("== timing fields present on the closed trades");
  for (const field of ["openedAt", "date", "endDate", "resolutionEndDate", "daysToResolution",
    "firstDaysToResolution", "resolvedAt", "closedAt"]) {
    const present = closed.filter((trade) => trade[field] != null && trade[field] !== "").length;
    console.log(`   ${field.padEnd(22)} ${String(present).padStart(4)} of ${closed.length}`);
  }

  // 2. What the stored field says against what the dates say.
  console.log("\n== stored daysToResolution vs the horizon the dates imply");
  const stored = closed.map((trade) => num(trade.daysToResolution)).filter((value) => value != null);
  if (stored.length) {
    const sorted = [...stored].sort((a, b) => a - b);
    const pick = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
    console.log(`   stored daysToResolution: min ${sorted[0].toFixed(2)} d, median ${pick(0.5).toFixed(2)} d,`
      + ` p90 ${pick(0.9).toFixed(2)} d, max ${sorted.at(-1).toFixed(2)} d`);
    console.log(`   of those, ${stored.filter((value) => value <= 1).length} sit at or below 1 day`
      + ` and ${stored.filter((value) => value < 0).length} are negative`);
  } else {
    console.log("   no closed trade carries it at all");
  }
  for (const field of ["endDate", "resolutionEndDate"]) {
    const hours = closed.map((trade) => entryHours(trade, field)).filter((value) => value != null);
    if (!hours.length) { console.log(`   ${field}: no trade can be dated from it`); continue; }
    const sorted = [...hours].sort((a, b) => a - b);
    const pick = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
    console.log(`   ${field} - openedAt: ${sorted.length} trades, min ${sorted[0].toFixed(1)} h,`
      + ` p10 ${pick(0.1).toFixed(1)} h, median ${pick(0.5).toFixed(1)} h,`
      + ` p90 ${pick(0.9).toFixed(1)} h, max ${sorted.at(-1).toFixed(1)} h`);
    console.log(`      negative (opened after the stated date): ${hours.filter((value) => value < 0).length}`);
  }

  // 3. The breakdowns. Asked for <=0, <=3, <=6, <=12, <=24, <=48 -- and a finer and a
  //    coarser one beside it, because the useful cut is whichever separates the returns.
  const source = closed.some((trade) => entryHours(trade, "resolutionEndDate") != null)
    ? "resolutionEndDate" : "endDate";
  console.log(`\n== P/L by horizon at entry (${source} - openedAt)`);
  const hoursOf = (trade) => entryHours(trade, source);
  printBands("as asked: 0 / 3 / 6 / 12 / 24 / 48", bandStats(closed, hoursOf, [0, 3, 6, 12, 24, 48]));
  printBands("finer near zero: 0 / 1 / 2 / 4 / 8 / 16 / 32", bandStats(closed, hoursOf, [0, 1, 2, 4, 8, 16, 32]));
  printBands("coarser: 0 / 6 / 24 / 72", bandStats(closed, hoursOf, [0, 6, 24, 72]));

  // And the same on the stored field, so the difference between the two is visible rather
  // than argued: this is what the dashboard's table is showing today.
  console.log("\n== the same, on the STORED daysToResolution (what the table shows today)");
  printBands("stored, in hours", bandStats(closed,
    (trade) => (num(trade.daysToResolution) == null ? null : num(trade.daysToResolution) * 24),
    [0, 3, 6, 12, 24, 48]));

  return 0;
}

main().then((code) => process.exit(code), (error) => {
  console.log(`\n!! probe stopped early: ${error?.message || error}`);
  process.exit(1);
});
