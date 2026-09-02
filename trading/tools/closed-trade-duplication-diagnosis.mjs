// Read-only diagnosis. Fetches the two public Polymarket history feeds, needs no
// credentials, writes nothing anywhere and places no orders.
//
// The closed live trades list shows numbers that cannot all be true at once: a REDEEMED
// winner with a green "+$2.28 (+22.9%)" win figure and a red "-$3.84" P/L beside it, an
// entry of 81.4% whose final is rendered as -38.6% (i.e. exactly 50.0%), and a stake of
// $9.95 for a position Polymarket redeemed for $6.11.
//
// Those are not three faults. Work the arithmetic back and they collapse into one:
//
//   redeem proceeds  = shares held x $1.00            = 6.11  (Polymarket's own figure)
//   recorded stake   = 9.95                           = 2 x 4.97
//   recorded shares  = stake / entry = 9.95 / 0.814   = 12.22 = 2 x 6.11
//   exit price       = proceeds / shares = 6.11/12.22 = 0.50   <- the "final 50%"
//   P/L              = proceeds - stake = 6.11 - 9.95 = -3.84  <- the red loss on a win
//
// A winner redeems at $1.00 a share, so proceeds always equal the true share count. If
// the recorded share count is exactly twice that, the exit price is exactly 0.50 every
// time, for every market, whatever the entry was -- which is what the screenshot shows on
// four unrelated markets. So the hypothesis under test is: every BUY fill is being counted
// twice, and closedTradesFromHistory is doing correct arithmetic on doubled inputs.
//
// This tool tests that against production data rather than asserting it:
//
//   1. it fetches /trades and /activity exactly as live-account-sync.mjs does;
//   2. it groups the rows by the same identity key mergedPublicHistoryRows uses, and
//      reports where a fill appears more than once -- within one feed or across both;
//   3. for cross-feed near-duplicates (same tx, token and side) it prints both rows field
//      by field, so the field that makes two records of one fill look like two fills is
//      named rather than guessed;
//   4. it runs the real exported closedTradesFromHistory and reports, for every redeemed
//      row, the share/redeem ratio and the exit price -- so "exactly double" and "exactly
//      0.50" are measured across the whole account, not just the six rows on screen.
import { closedTradesFromHistory } from "./live-account-sync.mjs";

const DATA_API = process.env.POLYMARKET_DATA_API || "https://data-api.polymarket.com";
const GAMMA_API = process.env.POLYMARKET_GAMMA_API || "https://gamma-api.polymarket.com";
// The sync discovers which address actually holds the account, because the wallet that
// trades is often a proxy of the configured one. The repo default returned an empty
// history, so this resolves the same way instead of trusting one name.
const ADDRESS_CANDIDATES = [
  process.env.POLYMARKET_ADDRESS,
  process.env.POLYMARKET_FUNDER_ADDRESS,
  process.env.POLYMARKET_PROXY_WALLET_ADDRESS,
  process.env.POLYMARKET_DEPOSIT_WALLET_ADDRESS,
  "0x3252de913d9323667f21f4d88fa1f996fc282293",
];
// The wallet that trades is discovered from the signing key, which this tool deliberately
// does not have. The served live state records the address that discovery settled on, so
// the account is read from production rather than guessed -- and the same document holds
// the closed rows the dashboard is rendering, which is the other half of the comparison.
const LIVE_STATE_URL = process.env.LIVE_STATE_URL
  || "https://osobnizkusenosti.cz/trading/api.php?action=state&target=live";
const ACTIVITY_LIMIT = Number(process.env.LIVE_ACTIVITY_LIMIT || 50);
const TRADE_LIMIT = Number(process.env.LIVE_TRADE_LIMIT || 500);
// The markets the user screenshotted, so the report speaks to the rows they were looking
// at. Overridable, because the next odd row will be a different market.
const FILTER = new RegExp(process.env.MARKET_FILTER
  || "infinite|chongqing|cirstea|badosa|sassuolo|frosinone|b8 vs", "i");

const number = (value, fallback = null) => {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const money = (value) => (value == null ? "-" : `${value < 0 ? "-" : "+"}$${Math.abs(value).toFixed(2)}`);
const pct = (value) => (value == null ? "-" : `${(value * 100).toFixed(1)}%`);

// The same User-Agent live-account-sync.mjs sends. Omitting it returned 200 with an empty
// array on the first run of this tool -- an answer indistinguishable from "this account has
// no history" unless the response is reported, which is why the status and a body sample
// are printed below rather than assumed.
async function fetchFeed(path, params) {
  const url = new URL(path, DATA_API);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const response = await fetch(url, {
    headers: { "User-Agent": "osobnizkusenosti-trading-live-sync" },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} on ${path}: ${text.slice(0, 200)}`);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${path} returned non-JSON (${text.length} bytes): ${text.slice(0, 200)}`);
  }
  const rows = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.data) ? parsed.data : []);
  console.log(`   ${path.padEnd(10)} HTTP ${response.status}   ${text.length} bytes`
    + `   ${Array.isArray(parsed) ? "array" : `object keys: ${Object.keys(parsed || {}).slice(0, 8).join(",") || "none"}`}`
    + `   -> ${rows.length} rows`);
  if (!rows.length) console.log(`      body: ${text.slice(0, 240)}`);
  return rows;
}

// Copied deliberately rather than imported: live-account-sync.mjs keeps this private, and
// a copy that drifts from the original is itself a finding this tool would surface.
function identity(item) {
  return [
    item.transactionHash || item.txHash || item.id || "",
    item.tokenId || item.conditionId || item.slug || "",
    String(item.side || item.type || "").toUpperCase(),
    item.timestamp || "",
    number(item.price, ""),
    number(item.size, ""),
    number(item.usdcValue, ""),
    String(item.outcome || "").trim().toLowerCase(),
  ].join(":");
}

// Addresses are public on-chain data, but a shortened form keeps the report readable and
// avoids pasting a wallet in full into a log that gets quoted around.
const shortAddress = (value) => {
  const text = String(value || "");
  return text.length > 12 ? `${text.slice(0, 6)}...${text.slice(-4)}` : text || "(none)";
};

async function proxyWalletFor(address) {
  const url = new URL("/public-profile", GAMMA_API);
  url.searchParams.set("address", address);
  try {
    const response = await fetch(url, { headers: { "User-Agent": "osobnizkusenosti-trading-live-sync" } });
    if (!response.ok) return null;
    const profile = await response.json();
    const proxy = String(profile?.proxyWallet || "").toLowerCase();
    return proxy && proxy !== address ? proxy : null;
  } catch {
    return null;
  }
}

async function fetchLiveState() {
  const url = `${LIVE_STATE_URL}${LIVE_STATE_URL.includes("?") ? "&" : "?"}diagnosisAt=${Date.now()}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`live state HTTP ${response.status}`);
  const payload = await response.json();
  return payload?.state && typeof payload.state === "object" ? payload.state : payload;
}

// Which of the candidates actually has a history. Probing with limit=1 keeps this cheap and
// makes "the account is elsewhere" a reported fact rather than a silent empty report.
async function resolveAccount(extra = []) {
  const seen = new Set();
  const candidates = [];
  for (const value of [...extra, ...ADDRESS_CANDIDATES]) {
    const address = String(value || "").trim().toLowerCase();
    if (!address || seen.has(address)) continue;
    seen.add(address);
    candidates.push(address);
  }
  for (const address of [...candidates]) {
    const proxy = await proxyWalletFor(address);
    if (proxy && !seen.has(proxy)) {
      seen.add(proxy);
      candidates.push(proxy);
    }
  }
  console.log(`== resolving which wallet holds the history (${candidates.length} candidates)`);
  for (const address of candidates) {
    const url = new URL("/trades", DATA_API);
    url.searchParams.set("user", address);
    url.searchParams.set("limit", "1");
    let rows = [];
    try {
      const response = await fetch(url, { headers: { "User-Agent": "osobnizkusenosti-trading-live-sync" } });
      const parsed = response.ok ? await response.json() : [];
      rows = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.data) ? parsed.data : []);
    } catch (error) {
      console.log(`   ${shortAddress(address)}   probe failed: ${error?.message || error}`);
      continue;
    }
    console.log(`   ${shortAddress(address)}   ${rows.length ? "HAS trade history" : "no trade history"}`);
    if (rows.length) return address;
  }
  return candidates[0] || "";
}

const isTradeRow = (item, source) => source === "trades" || String(item.type || "").toUpperCase().includes("TRADE");
const matchesFilter = (item) => FILTER.test(
  `${item?.question || ""} ${item?.title || ""} ${item?.slug || ""} ${item?.eventSlug || ""} ${item?.outcome || ""}`,
);
const describe = (item) => [
  `side=${item.side || item.type || "?"}`,
  `size=${JSON.stringify(item.size)}`,
  `price=${JSON.stringify(item.price)}`,
  `usdcValue=${JSON.stringify(item.usdcValue)}`,
  `ts=${JSON.stringify(item.timestamp)}`,
  `tx=${String(item.transactionHash || item.txHash || item.id || "").slice(0, 14)}`,
  `token=${String(item.tokenId || "").slice(0, 10)}`,
  `outcome=${JSON.stringify(item.outcome)}`,
].join("  ");

async function main() {
  console.log(`Closed-trade duplication diagnosis at ${new Date().toISOString()}`);
  console.log(`/activity limit ${ACTIVITY_LIMIT}   /trades limit ${TRADE_LIMIT}`);
  console.log(`Read-only: public feeds only, no credentials, nothing written, no orders.\n`);

  // The served state first: it names the account and carries the rows the dashboard draws,
  // so the screenshot's figures are read rather than reconstructed.
  let liveState = null;
  try {
    liveState = await fetchLiveState();
  } catch (error) {
    console.log(`!! could not read the served live state: ${error?.message || error}`);
  }
  const servedClosed = Array.isArray(liveState?.closedTrades) ? liveState.closedTrades : [];
  const stateAddress = String(liveState?.account?.address || "").toLowerCase();
  console.log(`== the served live state`);
  console.log(`   generatedAt      ${liveState?.generatedAt || "(none)"}`);
  console.log(`   account          ${shortAddress(stateAddress)}`);
  console.log(`   closedTrades     ${servedClosed.length}`);
  console.log(`   positions        ${Array.isArray(liveState?.positions) ? liveState.positions.length : "?"}`);

  const servedHits = servedClosed.filter(matchesFilter);
  // The full row, not a chosen subset. The doubled figures have to come from some field of
  // some source, and a report that only prints the fields I expected cannot show which.
  if (servedHits.length) {
    console.log(`\n== the served rows in full (the first ${Math.min(3, servedHits.length)})`);
    for (const row of servedHits.slice(0, 3)) console.log(`   ${JSON.stringify(row)}`);
  }
  console.log(`\n== what the dashboard is rendering for /${FILTER.source}/i (${servedHits.length} rows)`);
  for (const row of servedHits) {
    const shares = number(row.shares, 0);
    const redeemed = number(row.redeemedShares, 0);
    console.log(`\n   ${String(row.question || "?").slice(0, 88)}`);
    console.log(`      outcome ${row.outcome}   status ${row.status}   closedAtSource ${row.closedAtSource || "-"}`);
    console.log(`      stake ${money(number(row.stakeUsdc))}   shares ${shares.toFixed(4)}   redeemedShares ${redeemed.toFixed(4)}`
      + `   ratio ${redeemed > 0 ? (shares / redeemed).toFixed(4) : "-"}`);
    console.log(`      entry ${pct(number(row.entryPrice))}   exit ${pct(number(row.exitPrice))}`
      + `   proceeds ${money(number(row.exitValueUsdc))}   P/L ${money(number(row.realizedPnlUsdc))}`);
  }
  const servedRedeemed = servedClosed.filter((row) => String(row.status || "").toUpperCase() === "REDEEMED");
  const servedDoubled = servedRedeemed.filter((row) => number(row.redeemedShares, 0) > 0
    && Math.abs(number(row.shares, 0) / number(row.redeemedShares) - 2) < 0.02);
  const servedHalfExit = servedClosed.filter((row) => number(row.exitPrice) != null
    && Math.abs(number(row.exitPrice) - 0.5) < 0.005);
  const servedNegativeWins = servedRedeemed.filter((row) => number(row.realizedPnlUsdc, 0) < 0);
  console.log(`\n== the same three symptoms across every served closed row`);
  console.log(`   REDEEMED rows                                ${servedRedeemed.length} of ${servedClosed.length}`);
  console.log(`   ... shares exactly 2x the redeemed count     ${servedDoubled.length}`);
  console.log(`   exit price exactly 50.0%                     ${servedHalfExit.length}`);
  console.log(`   REDEEMED rows carrying a NEGATIVE P/L        ${servedNegativeWins.length}`);
  console.log(`   summed served P/L                            ${money(servedClosed.reduce((sum, row) => sum + number(row.realizedPnlUsdc, 0), 0))}`);

  const address = await resolveAccount(stateAddress ? [stateAddress] : []);
  console.log(`\n== feeds for ${shortAddress(address)}`);
  const [activity, trades] = await Promise.all([
    fetchFeed("/activity", { user: address, limit: ACTIVITY_LIMIT }),
    fetchFeed("/trades", { user: address, limit: TRADE_LIMIT }),
  ]);
  console.log(`   /trades   ${trades.length} rows`);
  console.log(`   /activity ${activity.length} rows`
    + `   (types: ${[...new Set(activity.map((row) => String(row.type || "?").toUpperCase()))].sort().join(", ") || "none"})`);

  // 1. Which fields does each feed actually carry? A field present in one and absent in
  //    the other cannot serve as identity, and that is the whole question here.
  const keysOf = (rows) => [...new Set(rows.flatMap((row) => Object.keys(row || {})))].sort();
  const tradeKeys = keysOf(trades);
  const activityKeys = keysOf(activity.filter((row) => isTradeRow(row, "activity")));
  console.log(`\n== the identity fields, feed by feed`);
  for (const field of ["transactionHash", "txHash", "id", "tokenId", "conditionId", "slug", "side", "type", "timestamp", "price", "size", "usdcValue", "outcome"]) {
    const inTrades = tradeKeys.includes(field);
    const inActivity = activityKeys.includes(field);
    const flag = inTrades === inActivity ? "  " : "!!";
    console.log(`   ${flag} ${field.padEnd(18)} /trades ${inTrades ? "yes" : "NO "}   /activity(TRADE) ${inActivity ? "yes" : "NO "}`);
  }

  // 2. Group by the production identity key and report multiplicity.
  const grouped = new Map();
  const append = (source, rows) => {
    for (const item of rows) {
      if (!isTradeRow(item, source)) continue;
      const key = identity(item);
      if (!grouped.has(key)) grouped.set(key, { trades: [], activity: [] });
      grouped.get(key)[source].push(item);
    }
  };
  append("trades", trades);
  append("activity", activity);

  let selectedRows = 0;
  let duplicatedWithinFeed = 0;
  let matchedAcrossFeeds = 0;
  for (const group of grouped.values()) {
    const selected = group.trades.length >= group.activity.length ? group.trades : group.activity;
    selectedRows += selected.length;
    if (selected.length > 1) duplicatedWithinFeed += 1;
    if (group.trades.length && group.activity.length) matchedAcrossFeeds += 1;
  }
  console.log(`\n== what mergedPublicHistoryRows does with them`);
  console.log(`   distinct identity keys                 ${grouped.size}`);
  console.log(`   keys seen in BOTH feeds (deduped)      ${matchedAcrossFeeds}`);
  console.log(`   keys whose winning feed had >1 row     ${duplicatedWithinFeed}  <- kept as separate fills`);
  console.log(`   rows handed to the grouping logic      ${selectedRows}`);

  // 3. Cross-feed near-duplicates: same fill, same tx, same side, different key. These are
  //    the ones that get counted twice, and the field-by-field print names the culprit.
  const nearKey = (item) => [
    String(item.transactionHash || item.txHash || item.id || ""),
    String(item.tokenId || item.conditionId || ""),
    String(item.side || "").toUpperCase(),
  ].join(":");
  const activityByNear = new Map();
  for (const item of activity) {
    if (!isTradeRow(item, "activity")) continue;
    const key = nearKey(item);
    if (!activityByNear.has(key)) activityByNear.set(key, []);
    activityByNear.get(key).push(item);
  }
  const mismatches = [];
  for (const item of trades) {
    const peers = activityByNear.get(nearKey(item)) || [];
    for (const peer of peers) {
      if (identity(item) === identity(peer)) continue;
      mismatches.push({ trade: item, peer });
    }
  }
  console.log(`\n== the same fill described differently by the two feeds: ${mismatches.length}`);
  console.log(`   (same transaction, token and side, but a different identity key, so both survive)`);
  for (const { trade, peer } of mismatches.slice(0, 10)) {
    console.log(`\n   ${String(trade.question || trade.title || "?").slice(0, 88)}`);
    console.log(`      /trades   ${describe(trade)}`);
    console.log(`      /activity ${describe(peer)}`);
    const differing = ["timestamp", "price", "size", "usdcValue", "outcome", "side"]
      .filter((field) => String(trade[field] ?? "") !== String(peer[field] ?? ""));
    console.log(`      differs on: ${differing.join(", ") || "(nothing in the compared fields)"}`);
  }

  // 3b. Every field name the feeds actually use, and the full rows for the markets in
  //     question. usdcValue read as undefined on the last run, which either means the money
  //     field is named something else or that these fills genuinely carry no value -- and
  //     that distinction decides where the doubled stake comes from.
  const fieldNames = (rows) => [...new Set(rows.flatMap((row) => Object.keys(row || {})))].sort();
  console.log(`\n== every field the feeds carry`);
  console.log(`   /trades   ${fieldNames(trades).join(", ") || "(none)"}`);
  console.log(`   /activity ${fieldNames(activity).join(", ") || "(none)"}`);

  // The open positions carry a cost basis of their own, and a closed row can be built from
  // a settled position rather than from trade history, so this is the other candidate source.
  let positions = [];
  try {
    positions = await fetchFeed("/positions", { user: address, limit: 200 });
  } catch (error) {
    console.log(`   /positions unavailable: ${error?.message || error}`);
  }
  console.log(`   /positions ${fieldNames(positions).join(", ") || "(none)"}`);

  // 4. The rows for the screenshotted markets, from the raw feeds.
  console.log(`\n== raw rows for /${FILTER.source}/i`);
  for (const row of positions.filter(matchesFilter).slice(0, 6)) {
    console.log(`\n   /positions ${JSON.stringify(row)}`);
  }
  for (const [label, rows] of [["/trades", trades], ["/activity", activity]]) {
    const hits = rows.filter(matchesFilter);
    console.log(`\n   ${label}: ${hits.length} rows`);
    for (const item of hits.slice(0, 40)) {
      console.log(`      ${String(item.question || item.title || "?").slice(0, 60).padEnd(60)} ${describe(item)}`);
    }
    for (const item of hits.slice(0, 3)) console.log(`      full: ${JSON.stringify(item)}`);
  }

  // 5. The real production function, on the real feeds.
  const closed = closedTradesFromHistory(trades, activity, new Date().toISOString());
  console.log(`\n== closedTradesFromHistory produced ${closed.length} rows`);
  const shown = closed.filter(matchesFilter);
  console.log(`   rows matching the filter: ${shown.length}`);
  for (const row of shown) {
    const ratio = number(row.redeemedShares) > 0 ? number(row.shares, 0) / number(row.redeemedShares) : null;
    console.log(`\n   ${String(row.question || "?").slice(0, 88)}`);
    console.log(`      outcome ${row.outcome}   status ${row.status}   closedAtSource ${row.closedAtSource}`);
    console.log(`      stake ${money(number(row.stakeUsdc))}   shares ${number(row.shares, 0).toFixed(4)}`
      + `   redeemedShares ${number(row.redeemedShares, 0).toFixed(4)}`
      + `   shares/redeemed ${ratio == null ? "-" : ratio.toFixed(4)}`);
    console.log(`      entry ${pct(number(row.entryPrice))}   exit ${pct(number(row.exitPrice))}`
      + `   proceeds ${money(number(row.exitValueUsdc))}   P/L ${money(number(row.realizedPnlUsdc))}`);
    if (ratio != null && Math.abs(ratio - 2) < 0.02) {
      const trueStake = number(row.stakeUsdc, 0) / 2;
      const trueProceeds = number(row.exitValueUsdc, 0);
      console.log(`      -> doubled. On the redeemed share count this trade was`
        + ` stake ${money(trueStake)}, proceeds ${money(trueProceeds)}, P/L ${money(trueProceeds - trueStake)}`);
    }
  }

  // 6. The blast radius, so the header total can be judged rather than assumed.
  const redeemed = closed.filter((row) => String(row.status || "").toUpperCase() === "REDEEMED");
  const withRedeemShares = redeemed.filter((row) => number(row.redeemedShares, 0) > 0);
  const doubled = withRedeemShares.filter((row) => Math.abs(number(row.shares, 0) / number(row.redeemedShares) - 2) < 0.02);
  const halfExit = closed.filter((row) => number(row.exitPrice) != null && Math.abs(number(row.exitPrice) - 0.5) < 0.005);
  const negativeWins = redeemed.filter((row) => number(row.realizedPnlUsdc, 0) < 0);
  const reportedPnl = closed.reduce((sum, row) => sum + number(row.realizedPnlUsdc, 0), 0);
  const correctedPnl = closed.reduce((sum, row) => {
    const redeemShares = number(row.redeemedShares, 0);
    const shares = number(row.shares, 0);
    if (redeemShares > 0 && Math.abs(shares / redeemShares - 2) < 0.02) {
      return sum + (number(row.exitValueUsdc, 0) - number(row.stakeUsdc, 0) / 2);
    }
    return sum + number(row.realizedPnlUsdc, 0);
  }, 0);
  console.log(`\n== blast radius across every closed row`);
  console.log(`   closed rows                                  ${closed.length}`);
  console.log(`   REDEEMED rows                                ${redeemed.length}`);
  console.log(`   REDEEMED with a redeemed share count         ${withRedeemShares.length}`);
  console.log(`   ... of those, shares exactly 2x redeemed     ${doubled.length}`);
  console.log(`   rows whose exit price is exactly 50.0%       ${halfExit.length}`);
  console.log(`   REDEEMED rows reporting a NEGATIVE P/L       ${negativeWins.length}  <- redeemed winners shown as losses`);
  console.log(`   summed P/L as reported                       ${money(reportedPnl)}`);
  console.log(`   summed P/L halving the doubled stakes        ${money(correctedPnl)}`);
  console.log(`\n   The second figure is not a proposed fix, only a measure of how far the`);
  console.log(`   first one is from the account: halving a stake is arithmetic on a symptom.`);
}

main().catch((error) => {
  console.log(`\n!! diagnosis stopped early: ${error?.message || error}`);
  process.exitCode = 1;
});
