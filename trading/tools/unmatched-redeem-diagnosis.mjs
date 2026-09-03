// Read-only diagnostic. Writes nothing, publishes nothing, needs no secrets.
//
// Reported: some live portfolios show REDEEMED rows with nothing filled in -- no stake, no
// entry price, no win/loss, P/L +$0.00 -- and the question is whether they belong there at
// all.
//
// They come from retainUnmatchedRedeem() in live-account-sync.mjs. When Polymarket's
// activity feed reports a redemption whose original BUY is not in the retained /trades
// window, the sync keeps the redemption as a resolved winning position with the stake and
// P/L deliberately unknown, on the stated premise that the buy has "aged out" of a capped
// feed. That premise is the thing to test: a redemption from a few hours ago should still
// have its buy in the window, and if it does, these rows are a matching failure rather than
// an unavoidable gap.
//
// So this measures, per live portfolio:
//   1. how many closed rows are unmatched redeems, and how old they actually are;
//   2. whether a buy for the same market IS present in the retained history after all --
//      by token, by condition, by market slug, by question -- which is what decides
//      "aged out" versus "not matched";
//   3. what they do to the two numbers on screen: the closed P/L total and the
//      resolved-accuracy tile, where a REDEEMED status counts as a win.
const HOST = process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading";

async function fetchJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 160)}`);
  return JSON.parse(text);
}

const text = (value) => String(value == null ? "" : value).trim();
const questionKey = (item) => text(item?.question)
  .normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
  .replace(/[^a-z0-9]+/g, " ").trim();

// What actually makes one of these rows a problem is that it has no cost basis. The sync's
// markers are a hint, not the definition: mergeClosedTradeHistory deliberately preserves
// closedAtSource, so a row first seen as an unmatched redemption keeps that label for life
// even after a later run finds its buy and prices it. Reading the label alone reported 52
// broken rows when 46 of them were whole.
function isUnmatchedRedeem(row = {}) {
  const priced = row.stakeUsdc != null || row.entryPrice != null;
  if (priced) return false;
  if (row.reconciliationOnly === true) return true;
  if (text(row.openedAtSource) === "redeem-activity-unmatched") return true;
  if (text(row.closedAtSource) === "redeem-activity-unmatched") return true;
  return text(row.status).toUpperCase() === "REDEEMED";
}

const hours = (from, to) => (Date.parse(to) - Date.parse(from)) / 3600000;

function buyIndex(rows) {
  const byToken = new Set();
  const byCondition = new Set();
  const bySlug = new Set();
  const byQuestion = new Set();
  for (const row of rows) {
    const side = text(row?.side || row?.type).toUpperCase();
    // A redeem is not a buy, and neither is a sale; only an acquisition can be the missing
    // half of an unmatched redemption.
    if (side.includes("REDEEM") || side.includes("SELL")) continue;
    if (text(row?.tokenId)) byToken.add(text(row.tokenId));
    if (text(row?.conditionId)) byCondition.add(text(row.conditionId));
    for (const slug of [row?.slug, row?.eventSlug]) if (text(slug)) bySlug.add(text(slug));
    if (questionKey(row)) byQuestion.add(questionKey(row));
  }
  return { byToken, byCondition, bySlug, byQuestion };
}

function matchedBy(index, row) {
  const hits = [];
  if (text(row.tokenId) && index.byToken.has(text(row.tokenId))) hits.push("token");
  if (text(row.conditionId) && index.byCondition.has(text(row.conditionId))) hits.push("condition");
  if ((text(row.slug) && index.bySlug.has(text(row.slug)))
    || (text(row.eventSlug) && index.bySlug.has(text(row.eventSlug)))) hits.push("slug");
  if (questionKey(row) && index.byQuestion.has(questionKey(row))) hits.push("question");
  return hits;
}

async function main() {
  console.log(`Unmatched-redeem diagnosis at ${new Date().toISOString()}`);
  console.log(`Read-only: nothing is written, no credentials are used.\n`);

  const live = await fetchJson(`${HOST}/api.php?action=state&target=live`);
  const closed = Array.isArray(live?.closedTrades) ? live.closedTrades : [];
  const activity = Array.isArray(live?.activity) ? live.activity : [];
  const history = Array.isArray(live?.tradeHistory) ? live.tradeHistory : [];
  const generatedAt = live?.generatedAt || new Date().toISOString();

  const unmatched = closed.filter(isUnmatchedRedeem);
  console.log(`== 1. how many of the stored closed rows are unmatched redeems`);
  console.log(`   closed trades stored              ${String(closed.length).padStart(5)}`);
  console.log(`   of those, unmatched redeems       ${String(unmatched.length).padStart(5)}`
    + `${closed.length ? `  (${((unmatched.length / closed.length) * 100).toFixed(1)}%)` : ""}`);
  console.log(`   retained trade history rows       ${String(history.length).padStart(5)}`);
  console.log(`   retained activity rows            ${String(activity.length).padStart(5)}`);
  if (!unmatched.length) {
    console.log(`\n   Nothing to explain: no closed row is an unmatched redeem.`);
    return;
  }

  // The premise under test. "Aged out" predicts these are the OLDEST closes; the screenshot
  // showed two from the same morning.
  const ages = unmatched
    .map((row) => hours(row.closedAt || row.resolvedAt || row.date, generatedAt))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  if (ages.length) {
    console.log(`\n== 2. how old they are (hours before this snapshot)`);
    console.log(`   newest ${ages[0].toFixed(1)} h   median ${ages[Math.floor(ages.length / 2)].toFixed(1)} h`
      + `   oldest ${ages[ages.length - 1].toFixed(1)} h`);
    const fresh = ages.filter((age) => age < 48).length;
    console.log(`   closed within the last 48 h: ${fresh} of ${ages.length}`);
    console.log(`   ("aged out of the feed window" predicts these are the OLDEST rows.)`);
  }

  console.log(`\n== 3. is the original buy really absent from the retained history?`);
  const index = buyIndex([...history, ...activity]);
  console.log(`   buy-side keys in hand: ${index.byToken.size} tokens, ${index.byCondition.size} conditions,`
    + ` ${index.bySlug.size} slugs, ${index.byQuestion.size} questions`);
  const tally = new Map();
  for (const row of unmatched) {
    const hits = matchedBy(index, row);
    const label = hits.length ? hits.join("+") : "(nothing matches)";
    tally.set(label, (tally.get(label) || 0) + 1);
  }
  for (const [label, count] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(count).padStart(4)}  a buy is findable by ${label}`);
  }

  console.log(`\n== 4. a sample, with what the row carries`);
  for (const row of unmatched.slice(0, 8)) {
    const hits = matchedBy(index, row);
    console.log(`\n   "${text(row.question).slice(0, 62)}"  [${text(row.outcome) || "-"}]`);
    console.log(`      status ${text(row.status)}   closed ${text(row.closedAt || row.resolvedAt)}`
      + `   ${hours(row.closedAt || row.resolvedAt || row.date, generatedAt).toFixed(1)} h ago`);
    console.log(`      stake ${row.stakeUsdc ?? "null"}   entry ${row.entryPrice ?? "null"}`
      + `   shares ${row.shares ?? "null"}   redeemed ${row.redeemedShares ?? "null"}`
      + `   exitValue ${row.exitValueUsdc ?? "null"}   realizedPnl ${row.realizedPnlUsdc ?? "null"}`);
    console.log(`      token ${text(row.tokenId).slice(0, 20) || "-"}   condition ${text(row.conditionId).slice(0, 20) || "-"}`
      + `   slug ${text(row.slug) || "-"}`);
    console.log(`      a buy is findable by: ${hits.length ? hits.join(", ") : "nothing"}`);
  }

  // What they do to the two numbers on screen. REDEEMED counts as a win in
  // closedTradePredictionResult(), including for a row with no stake and no P/L.
  console.log(`\n== 5. what they do to the numbers on screen`);
  const sum = (rows) => rows.reduce((total, row) => total + Number(row.realizedPnlUsdc || 0), 0);
  console.log(`   closed P/L with them     ${sum(closed).toFixed(2)} USDC`);
  console.log(`   closed P/L without them  ${sum(closed.filter((row) => !isUnmatchedRedeem(row))).toFixed(2)} USDC`);
  console.log(`   (they carry realizedPnlUsdc = null, so the total is unchanged -- but the`);
  console.log(`    row prints that null as +$0.00 and its entry/final as 0.0%.)`);

  const graded = (rows) => {
    let wins = 0;
    let losses = 0;
    for (const row of rows) {
      const status = text(row.status).toUpperCase();
      if (["WON", "REDEEMED", "REDEEM_REQUIRED"].includes(status)) wins += 1;
      else if (["LOST", "STOP_LOSS", "STOP_GAP"].includes(status)) losses += 1;
    }
    return { wins, losses, pct: wins + losses ? (wins / (wins + losses)) * 100 : null };
  };
  const withThem = graded(closed);
  const withoutThem = graded(closed.filter((row) => !isUnmatchedRedeem(row)));
  console.log(`   resolved accuracy with them     ${withThem.wins}W / ${withThem.losses}L`
    + `${withThem.pct == null ? "" : ` = ${withThem.pct.toFixed(1)}%`}`);
  console.log(`   resolved accuracy without them  ${withoutThem.wins}W / ${withoutThem.losses}L`
    + `${withoutThem.pct == null ? "" : ` = ${withoutThem.pct.toFixed(1)}%`}`);
  console.log(`   (a REDEEMED status counts as a win, so every one of these is scored a win`);
  console.log(`    while its own row shows no verdict at all.)`);
}

main().catch((error) => {
  console.log(`\n!! diagnosis stopped early: ${error?.message || error}`);
  process.exitCode = 1;
});
