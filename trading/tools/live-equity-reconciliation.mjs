// Read-only diagnostic. Writes nothing, places nothing, submits nothing.
//
// Reported with two screenshots taken a minute apart: Polymarket showed the account at
// $103.68 with $26.84 available to trade; the dashboard showed equity $98.87 and "$0.00
// free cash". Refreshing the page did not reconcile them.
//
// Three different things could produce that, and they need different fixes, so this
// separates them by measurement rather than argument:
//
//   1. STALENESS. The dashboard reads a snapshot file published by the last executor run.
//      A page refresh re-reads that file; it does not re-ask Polymarket. So if the account
//      moved after the last run, the two must differ, and the fix is cadence, not code.
//   2. COVERAGE. A position Polymarket counts and the snapshot does not (or the reverse)
//      moves equity by that position's whole value.
//   3. DEFINITION. equityUsdc is built as collateral + own sum of position values +
//      pending redeem, while Polymarket publishes its own /value figure for the same
//      account. If those disagree on identical positions, the arithmetic is the problem.
//
// It also checks the free-cash figure directly, because the dashboard subtracts resting
// BUY notional from collateral -- the same deduction already measured as double counting
// in the executor, where equity = collateral + positions was found to hold exactly.
import { readFile } from "node:fs/promises";

const DATA_API = process.env.POLYMARKET_DATA_API || "https://data-api.polymarket.com";
const PUBLISHED_STATE_URL = process.env.LIVE_STATE_URL
  || "https://osobnizkusenosti.cz/trading/api.php?action=state&target=live";
const FRESH_STATE_PATH = process.env.LIVE_STATE_PATH || "data/live-state.json";

const num = (value, fallback = null) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};
const money = (value) => (value == null ? "-" : `$${value.toFixed(4)}`);
const signed = (value) => (value == null ? "-" : `${value >= 0 ? "+" : ""}${value.toFixed(4)}`);

async function getJson(url, label) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${label} HTTP ${response.status}`);
  return response.json();
}

// Copied from the dashboard so the diagnosis describes the dashboard.
const TERMINAL_ORDER_STATUSES = new Set([
  "CANCELED", "CANCELLED", "CANCELLED_BY_USER", "FILLED", "MATCHED", "EXPIRED",
  "ORDER_STATUS_CANCELED", "ORDER_STATUS_CANCELLED", "ORDER_STATUS_FILLED", "ORDER_STATUS_EXPIRED",
]);
function reservedByOpenOrders(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((order) => !String(order?.side || "").toUpperCase().includes("SELL"))
    .filter((order) => !TERMINAL_ORDER_STATUSES.has(String(order?.rawStatus || order?.status || "").toUpperCase()))
    .reduce((sum, order) => sum + (num(order?.notionalUsdc ?? order?.totalCostUsdc ?? order?.stakeUsdc, 0) ?? 0), 0);
}

function describeState(label, state) {
  const portfolio = state?.portfolio || {};
  const positions = Array.isArray(state?.positions) ? state.positions : [];
  const marketValue = num(portfolio.marketValueUsdc);
  const summed = positions.reduce((sum, row) => sum + (num(row.currentValueUsdc, 0) ?? 0), 0);
  console.log(`${label}`);
  console.log(`  generatedAt                 ${state?.generatedAt || "-"}`);
  console.log(`  portfolio.equityUsdc        ${money(num(portfolio.equityUsdc))}`);
  console.log(`  portfolio.cashUsdc          ${money(num(portfolio.cashUsdc))}`);
  console.log(`  balanceAllowance collateral ${money(num(state?.balanceAllowance?.collateral?.balanceUsdc))}`);
  console.log(`  portfolio.marketValueUsdc   ${money(marketValue)}   (${positions.length} positions)`);
  console.log(`  sum of position values      ${money(summed)}`);
  console.log(`  portfolio.pendingRedeemUsdc ${money(num(portfolio.pendingRedeemUsdc))}`);
  console.log(`  equitySource                ${state?.sync?.equitySource || state?.portfolio?.equitySource || "-"}`);
  return { portfolio, positions, marketValue, summed };
}

function positionsByToken(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = String(row?.tokenId || row?.asset || row?.assetId || row?.conditionId || "");
    if (key) map.set(key, row);
  }
  return map;
}

async function main() {
  const now = new Date();
  console.log(`Live equity reconciliation at ${now.toISOString()}\n`);

  const published = await getJson(PUBLISHED_STATE_URL, "published live state");
  const fresh = JSON.parse(await readFile(FRESH_STATE_PATH, "utf8"));

  const publishedView = describeState("PUBLISHED SNAPSHOT (what the dashboard renders)", published);
  console.log();
  const freshView = describeState("FRESH SYNC (this run, straight from Polymarket)", fresh);

  const address = String(fresh?.account?.address || published?.account?.address || "").toLowerCase();
  console.log(`\naccount address               ${address || "-"}`);

  // 1. STALENESS -- how old the published snapshot is, and how much the account moved since.
  const publishedAt = Date.parse(published?.generatedAt || "");
  const ageMinutes = Number.isFinite(publishedAt) ? (now.getTime() - publishedAt) / 60000 : null;
  const publishedEquity = num(publishedView.portfolio.equityUsdc);
  const freshEquity = num(freshView.portfolio.equityUsdc);
  const stalenessGap = publishedEquity != null && freshEquity != null ? freshEquity - publishedEquity : null;
  console.log(`\n1. STALENESS`);
  console.log(`   published snapshot age     ${ageMinutes == null ? "-" : `${ageMinutes.toFixed(1)} min`}`);
  console.log(`   equity now - equity shown  ${signed(stalenessGap)}`);
  console.log(`   -> a page refresh re-reads the published file; it does not re-ask Polymarket,`);
  console.log(`      so anything here is cadence, not arithmetic.`);

  // 2. + 3. Against Polymarket's own figures for the same wallet, right now.
  let liveValue = null;
  let livePositions = [];
  if (address) {
    const valueRows = await getJson(`${DATA_API}/value?user=${address}`, "polymarket /value").catch(() => []);
    liveValue = num((Array.isArray(valueRows) ? valueRows : [])
      .find((row) => String(row.user || "").toLowerCase() === address)?.value);
    livePositions = await getJson(`${DATA_API}/positions?user=${address}&limit=500`, "polymarket /positions")
      .catch(() => []);
    if (!Array.isArray(livePositions)) livePositions = [];
  }
  const liveSum = livePositions.reduce((sum, row) => sum + (num(row.currentValue ?? row.value, 0) ?? 0), 0);
  const collateral = num(fresh?.balanceAllowance?.collateral?.balanceUsdc);

  console.log(`\n2. WHAT POLYMARKET SAYS RIGHT NOW`);
  console.log(`   /value for this account    ${money(liveValue)}`);
  console.log(`   sum of /positions values   ${money(liveSum)}   (${livePositions.length} positions)`);
  console.log(`   CLOB collateral balance    ${money(collateral)}`);
  console.log(`   collateral + /value        ${money(collateral != null && liveValue != null ? collateral + liveValue : null)}`);
  console.log(`   collateral + position sum  ${money(collateral != null ? collateral + liveSum : null)}`);
  console.log(`   -> Polymarket's own app shows account total and "available to trade"; the`);
  console.log(`      first should match one of the two sums above, the second the collateral.`);

  // 3. COVERAGE -- which positions each side counts.
  const freshMap = positionsByToken(freshView.positions);
  const liveMap = positionsByToken(livePositions);
  const missingFromSnapshot = [...liveMap.entries()].filter(([token]) => !freshMap.has(token));
  const missingFromLive = [...freshMap.entries()].filter(([token]) => !liveMap.has(token));
  console.log(`\n3. COVERAGE`);
  console.log(`   positions Polymarket has that the sync does not: ${missingFromSnapshot.length}`);
  for (const [token, row] of missingFromSnapshot.slice(0, 10)) {
    console.log(`     ${money(num(row.currentValue ?? row.value))}  ${String(row.title || row.question || token).slice(0, 70)}`);
  }
  console.log(`   positions the sync has that Polymarket does not: ${missingFromLive.length}`);
  for (const [token, row] of missingFromLive.slice(0, 10)) {
    console.log(`     ${money(num(row.currentValueUsdc))}  ${String(row.question || token).slice(0, 70)}`);
  }
  const missingValue = missingFromSnapshot.reduce((sum, [, row]) => sum + (num(row.currentValue ?? row.value, 0) ?? 0), 0);
  if (missingValue > 0.005) {
    console.log(`   -> ${money(missingValue)} of position value is missing from the snapshot entirely.`);
  }

  // 3b. WHY each dropped position was dropped. The sync takes /positions and splits it:
  // anything Polymarket flags redeemable/claimable/resolved becomes a closed trade, the
  // rest stays an open position -- and both halves additionally drop anything whose key
  // already appears in the trade/activity history. A settled winner is still HELD until
  // it is redeemed, and Polymarket keeps counting it, so whichever branch takes it must
  // put its value back into equity or the account is understated by exactly that much.
  // These are the sync's own predicates, copied so the split can be attributed.
  const officiallyResolved = (row) => Boolean(row.redeemable || row.claimable || row.resolved);
  const hasRedeemableValue = (row) => {
    const value = num(row.currentValue ?? row.currentValueUsdc, 0) ?? 0;
    const price = num(row.curPrice ?? row.currentPrice);
    return value > 0.000001 || (price != null && price >= 0.995);
  };
  const buckets = {
    resolvedWithValue: [],
    resolvedWorthless: [],
    unresolvedButDropped: [],
  };
  for (const [, row] of missingFromSnapshot) {
    if (!officiallyResolved(row)) buckets.unresolvedButDropped.push(row);
    else if (hasRedeemableValue(row)) buckets.resolvedWithValue.push(row);
    else buckets.resolvedWorthless.push(row);
  }
  const bucketValue = (list) => list.reduce((sum, row) => sum + (num(row.currentValue ?? row.value, 0) ?? 0), 0);
  console.log(`\n3b. WHY THE SNAPSHOT DROPPED THEM`);
  for (const [name, list, note] of [
    ["resolved, still held, still worth money", buckets.resolvedWithValue,
      "these are redeemable winnings -- held in the wallet, counted by Polymarket"],
    ["resolved and worth nothing", buckets.resolvedWorthless, "correctly worth 0"],
    ["NOT resolved, yet dropped anyway", buckets.unresolvedButDropped,
      "an open position the snapshot lost -- its key matched the closed-trade history"],
  ]) {
    console.log(`   ${list.length.toString().padStart(3)} ${name}: ${money(bucketValue(list))}  (${note})`);
    for (const row of [...list].sort((a, b) => (num(b.currentValue ?? b.value, 0) ?? 0) - (num(a.currentValue ?? a.value, 0) ?? 0)).slice(0, 6)) {
      console.log(`        ${money(num(row.currentValue ?? row.value))}  size ${num(row.size, 0)?.toFixed(2)} @ ${num(row.curPrice)?.toFixed(4) ?? "-"}  ${String(row.title || "").slice(0, 58)}`);
    }
  }
  // 3c. For an unresolved position the snapshot dropped, the suppressing rule is a key
  // match against the closed-trade history. That rule is right for a position that was
  // sold and is only lagging in /positions, and wrong for a later re-entry on the same
  // token -- and the two are told apart by WHEN. So print both clocks: if the position
  // opened after the close that suppresses it, the close cannot describe it.
  if (buckets.unresolvedButDropped.length) {
    const keysOf = (item) => {
      const keys = new Set();
      const tokenId = String(item.tokenId || item.assetId || item.asset || "").trim();
      const conditionId = String(item.conditionId || item.market || "").trim();
      const norm = (value) => String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
      const outcome = norm(item.outcome || item.side);
      const question = norm(item.question || item.title || item.market);
      if (tokenId) keys.add(`token:${tokenId}`);
      if (conditionId && outcome) keys.add(`condition:${conditionId}:${outcome}`);
      if (question && outcome) keys.add(`question:${question}:${outcome}`);
      return keys;
    };
    const closed = Array.isArray(fresh?.closedTrades) ? fresh.closedTrades : [];
    console.log(`\n3c. THE SUPPRESSING HISTORY ROWS, WITH TIMES`);
    for (const row of buckets.unresolvedButDropped) {
      const positionKeys = keysOf(row);
      const opened = row.createdAt || row.timestamp || null;
      console.log(`   position  ${String(row.title || "").slice(0, 60)}`);
      console.log(`     size ${num(row.size, 0)?.toFixed(4)} @ ${num(row.curPrice)?.toFixed(4)}  value ${money(num(row.currentValue ?? row.value))}`);
      console.log(`     opened at ${opened || "(no timestamp on the /positions row)"}`);
      console.log(`     position keys: ${[...positionKeys].map((k) => k.slice(0, 46)).join(" | ")}`);
      const matches = closed
        .map((trade) => ({ trade, shared: [...keysOf(trade)].filter((key) => positionKeys.has(key)) }))
        .filter((entry) => entry.shared.length);
      if (!matches.length) console.log(`     no closed-trade row shares a key -- something else dropped it`);
      for (const { trade, shared } of matches.slice(0, 6)) {
        console.log(`     closed-trade  ${trade.status || "-"}  closedAt ${trade.closedAt || trade.resolvedAt || "-"}`
          + `  openedAt ${trade.openedAt || "-"}  shares ${num(trade.shares ?? trade.size, 0)?.toFixed(4)}`);
        // WHICH key matched is the whole question. `token:` and `condition:` identify one
        // market outcome and nothing else. `question:` is a fallback for rows with no ids,
        // and question text like "Games Total: O/U 2.5" or "O/U 2.5 Rounds" recurs across
        // completely unrelated fixtures -- so a match on that alone is a collision, not a
        // history of this position.
        console.log(`       matched on: ${shared.map((k) => k.split(":")[0]).join(", ")}`);
        console.log(`       its token ${String(trade.tokenId || "-").slice(0, 20)}… vs position ${String(row.asset || row.tokenId || "-").slice(0, 20)}…`);
      }
    }
  }

  console.log(`   published pendingRedeemUsdc ${money(num(publishedView.portfolio.pendingRedeemUsdc))}`);
  console.log(`   -> if the first bucket is non-zero while pendingRedeemUsdc is 0, that value`);
  console.log(`      is counted nowhere: not in marketValueUsdc, not in pending redeem.`);

  // 4. VALUATION -- same position, different number.
  console.log(`\n4. VALUATION ON THE POSITIONS BOTH SIDES HOLD`);
  let valuationGap = 0;
  const rows = [];
  for (const [token, liveRow] of liveMap) {
    const ours = freshMap.get(token);
    if (!ours) continue;
    const theirs = num(liveRow.currentValue ?? liveRow.value, 0) ?? 0;
    const mine = num(ours.currentValueUsdc, 0) ?? 0;
    valuationGap += theirs - mine;
    if (Math.abs(theirs - mine) > 0.005) {
      rows.push({ token, theirs, mine, title: String(ours.question || liveRow.title || token).slice(0, 60) });
    }
  }
  rows.sort((a, b) => Math.abs(b.theirs - b.mine) - Math.abs(a.theirs - a.mine));
  for (const row of rows.slice(0, 10)) {
    console.log(`   ${signed(row.theirs - row.mine)}  polymarket ${money(row.theirs)} vs sync ${money(row.mine)}  ${row.title}`);
  }
  console.log(`   total valuation difference ${signed(valuationGap)}${rows.length ? "" : "  (identical on every shared position)"}`);

  // 5. FREE CASH -- the dashboard's own formula against the account.
  const openOrders = Array.isArray(fresh?.openOrders) ? fresh.openOrders : [];
  const reservation = reservedByOpenOrders(openOrders);
  const dashboardFreeCash = collateral == null ? null : Math.max(0, collateral - reservation);
  console.log(`\n5. FREE CASH`);
  console.log(`   collateral                 ${money(collateral)}`);
  console.log(`   resting BUY notional       ${money(reservation)}   (${openOrders.length} open orders)`);
  console.log(`   dashboard shows            ${money(dashboardFreeCash)}   (collateral - resting notional, floored at 0)`);
  console.log(`   -> Polymarket's "available to trade" is the collateral figure. If the two`);
  console.log(`      disagree, the deduction is the difference: a resting bid is a claim on`);
  console.log(`      collateral at match time, not money already spent.`);

  // The identity that settles whether the deduction is double counting, printed again here
  // so this diagnosis stands on its own rather than on a note from an earlier one.
  if (collateral != null && freshView.marketValue != null && freshEquity != null) {
    const identity = collateral + freshView.marketValue;
    console.log(`\n   identity check: collateral + positions = ${money(identity)} vs equity ${money(freshEquity)}`);
    console.log(`   gap ${signed(freshEquity - identity)} -- at ~0 the collateral is already the whole`);
    console.log(`   uncommitted balance, so subtracting resting orders from it counts them twice.`);
  }
}

main().catch((error) => {
  console.log(`\n!! reconciliation stopped early: ${error?.message || error}`);
  process.exitCode = 1;
});
