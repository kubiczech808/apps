// Read-only diagnostic. Writes nothing, publishes nothing, needs no secrets.
//
// Reported: closed positions disappear from a live portfolio's Closed list over time, and
// the portfolio's statistics stop adding up -- named for "70-80 sports, esports".
//
// Live rows carry no portfolio of their own. Every live portfolio shares one wallet and,
// apart from 5050, prices its bids the same way off the book, so nothing about a row says
// who placed it. Ownership is re-derived on every render from the execution RUN LOG: a
// token named by a portfolio's log belongs to that portfolio.
//
// The run log is a rolling window. If a row's order has aged out of it, liveTokenOwnerMode
// returns null, and belongsToLivePortfolio then refuses the row for a custom live portfolio
// by design -- it prices exactly as base Live does, so no price could tell the two apart.
// The row does not vanish from the account; it silently moves to base Live, taking its
// stake and its P/L out of the portfolio whose statistics are being read.
//
// That is a hypothesis until measured, so this prints, per live portfolio:
//   how many closed rows it claims now
//   how many rows no log claims at all, and what those are worth
//   how far back each log actually reaches, in runs and in days
//   and, for every unclaimed row, whether its token was ever logged by anyone
//
// The last line is what separates "aged out of the window" from "never recorded", because
// the fix is different for each.
const HOST = process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading";

async function fetchJson(url, label) {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status}: ${text.slice(0, 160)}`);
  return JSON.parse(text);
}

const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
const money = (value) => (num(value) == null ? "    -   " : `${num(value) >= 0 ? " " : ""}${num(value).toFixed(2)}`.padStart(8));
// The dashboard's own CUSTOM_PAPER_STRATEGY_ID. Copied rather than approximated: a narrower
// pattern here silently drops portfolios from the report, which is exactly the kind of
// probe bug that produces a confident wrong answer.
const CUSTOM_ID = /^[a-z][a-zA-Z0-9]{1,30}$/;
// The dashboard's own tolerance for matching a fill back to the order that placed it.
const FIXED_ENTRY_PRICE_TOLERANCE = 0.02;

async function executionState(file) {
  try {
    return await fetchJson(`${HOST}/${file}`, file);
  } catch {
    return null;
  }
}

function ordersByToken(states) {
  const orders = new Map();
  const spans = new Map();
  for (const [mode, state] of states) {
    if (!state) continue;
    const records = [state, ...(Array.isArray(state.runLog) ? state.runLog : [])];
    const times = [];
    for (const record of records) {
      const at = String(record?.generatedAt || record?.runAt || state.generatedAt || "");
      if (at) times.push(at);
      for (const attempt of (Array.isArray(record?.attempts) ? record.attempts : [])) {
        const action = String(attempt?.action || "").toUpperCase();
        if (action.includes("REJECT") || action.startsWith("DRY_RUN")) continue;
        const tokenId = String(attempt?.tokenId || "");
        if (!tokenId) continue;
        if (!orders.has(tokenId)) orders.set(tokenId, []);
        orders.get(tokenId).push({ mode, price: num(attempt?.orderPrice), at });
      }
    }
    times.sort();
    spans.set(mode, {
      runs: Array.isArray(state.runLog) ? state.runLog.length : 0,
      oldest: times[0] || null,
      newest: times[times.length - 1] || null,
    });
  }
  return { orders, spans };
}

function newestOrder(orders) {
  return [...orders].sort((left, right) => (Date.parse(right.at || "") || 0) - (Date.parse(left.at || "") || 0))[0];
}

// The dashboard's liveTokenOwnerMode, restated over the same inputs.
function ownerMode(row, orders) {
  const tokenId = String(row?.tokenId || row?.assetId || "");
  if (!tokenId) return null;
  const rows = orders.get(tokenId) || [];
  if (!rows.length) return null;
  const paid = num(row?.entryPrice ?? row?.avgPrice ?? row?.averagePrice);
  if (paid == null) return null;
  const filled = rows.filter((order) => order.price != null && Math.abs(paid - order.price) < FIXED_ENTRY_PRICE_TOLERANCE);
  return filled.length ? newestOrder(filled).mode : null;
}

async function main() {
  const [configPayload, live] = await Promise.all([
    fetchJson(`${HOST}/api.php?action=portfolio-config`, "portfolio config"),
    fetchJson(`${HOST}/api.php?action=state&target=live`, "live state"),
  ]);
  // The endpoint answers {ok, config}. Reading livePortfolios off the ENVELOPE finds
  // nothing, and a report that silently covers only the two built-in portfolios looks
  // exactly like a report that found nothing wrong with the others.
  const config = (configPayload && typeof configPayload.config === "object" && configPayload.config) || configPayload || {};
  const livePortfolios = (config && typeof config.livePortfolios === "object" && config.livePortfolios) || {};
  const customIds = Object.keys(livePortfolios).filter((id) => CUSTOM_ID.test(id));
  if (!customIds.length) {
    console.log("!! no custom live portfolios found in the config -- the report below covers"
      + " only the built-in Live and 5050 portfolios, which is probably a bug in this probe\n");
  }
  const modes = [
    ["live", "data/live-execution-state.json"],
    ["live-5050", "data/live-5050-execution-state.json"],
    ...customIds.map((id) => [`live-custom-${id}`, `data/live-${id}-execution-state.json`]),
  ];
  const states = await Promise.all(modes.map(async ([mode, file]) => [mode, await executionState(file)]));
  const { orders, spans } = ordersByToken(states);

  // The durable half: every run's log, mirrored into the event store on every execution and
  // kept because the append is idempotent. The published state above is a 160-run window
  // onto the same thing, so this can only ever add claims, never contradict one.
  let ownership = null;
  try {
    ownership = await fetchJson(`${HOST}/api.php?action=live-order-ownership`, "live order ownership");
  } catch (error) {
    console.log(`!! the durable ownership endpoint failed: ${error?.message || error}\n`);
  }
  const windowOnly = new Map([...orders].map(([token, rows]) => [token, [...rows]]));
  for (const entry of (Array.isArray(ownership?.orders) ? ownership.orders : [])) {
    const tokenId = String(entry?.tokenId || "");
    if (!tokenId) continue;
    if (!orders.has(tokenId)) orders.set(tokenId, []);
    orders.get(tokenId).push({ mode: String(entry?.mode || ""), price: num(entry?.price), at: String(entry?.at || "") });
  }
  if (ownership) {
    console.log(`durable run-log history: storage ${ownership.storageActive ? "ACTIVE" : "INACTIVE"},`
      + ` oldest run ${ownership.oldestRunAt || "-"}, ${(ownership.orders || []).length} orders on record`);
    console.log(`   runs per portfolio: ${JSON.stringify(ownership.runsPerMode || {})}\n`);
  }

  const closed = Array.isArray(live?.closedTrades) ? live.closedTrades : [];
  console.log(`live state generated ${live?.generatedAt || "(unknown)"}`);
  console.log(`closed rows on the account: ${closed.length}`);
  console.log(`live portfolios: ${modes.map(([mode]) => mode).join(", ")}\n`);

  console.log("how far back each execution log reaches -- this window IS the attribution:");
  for (const [mode] of modes) {
    const span = spans.get(mode);
    if (!span) {
      console.log(`   ${mode.padEnd(26)} (no execution state published)`);
      continue;
    }
    const days = span.oldest && span.newest
      ? (Date.parse(span.newest) - Date.parse(span.oldest)) / 86400000
      : null;
    console.log(`   ${mode.padEnd(26)} ${String(span.runs).padStart(4)} runs   oldest ${span.oldest || "-"}`
      + `   span ${days == null ? "-" : `${days.toFixed(1)} days`}`);
  }

  const claimed = new Map(modes.map(([mode]) => [mode, []]));
  const unclaimedTokenless = [];
  const unclaimedAged = [];
  // What the 160-run window alone could claim, so the report says what the durable history
  // actually recovered rather than only what the total is now.
  let windowClaimed = 0;
  for (const row of closed) {
    const tokenId = String(row?.tokenId || row?.assetId || "");
    if (!tokenId) {
      unclaimedTokenless.push(row);
      continue;
    }
    if (ownerMode(row, windowOnly)) windowClaimed += 1;
    const owner = ownerMode(row, orders);
    if (owner && claimed.has(owner)) claimed.get(owner).push(row);
    else unclaimedAged.push(row);
  }

  console.log("\nclosed rows each portfolio can still claim from its log:");
  for (const [mode] of modes) {
    const rows = claimed.get(mode) || [];
    const pnl = rows.reduce((sum, row) => sum + (num(row.realizedPnlUsdc) || 0), 0);
    const label = mode.startsWith("live-custom-")
      ? `${mode} (${livePortfolios[mode.slice("live-custom-".length)]?.displayName || "?"})`
      : mode;
    console.log(`   ${label.padEnd(46)} ${String(rows.length).padStart(4)} rows   realized ${money(pnl)}`);
  }

  const lostPnl = unclaimedAged.reduce((sum, row) => sum + (num(row.realizedPnlUsdc) || 0), 0);
  const lostStake = unclaimedAged.reduce((sum, row) => sum + (num(row.totalCostUsdc ?? row.stakeUsdc) || 0), 0);
  console.log(`\n   claimable from the 160-run window alone: ${windowClaimed} rows`);
  console.log(`   claimable with the durable history:      ${closed.length - unclaimedAged.length - unclaimedTokenless.length} rows`);
  console.log(`\n   UNCLAIMED, with a token       ${String(unclaimedAged.length).padStart(4)} rows`
    + `   realized ${money(lostPnl)}   stake ${money(lostStake)}`);
  console.log(`   unclaimed, tokenless          ${String(unclaimedTokenless.length).padStart(4)} rows`
    + "   (these fall to base Live by design)");

  // The line the whole report exists for. A token nobody logs now but that a log DID name
  // has aged out of the window; a token no log ever named was never recorded at all.
  console.log("\nevery unclaimed row with a token -- was it ever logged, and by whom:");
  for (const row of unclaimedAged.slice(0, 40)) {
    const tokenId = String(row?.tokenId || row?.assetId || "");
    const logged = orders.get(tokenId) || [];
    const paid = num(row?.entryPrice ?? row?.avgPrice ?? row?.averagePrice);
    const verdict = !logged.length
      ? "NO LOG ENTRY ANYWHERE -- aged out of every window, or never recorded"
      : (paid == null
        ? "logged, but the row has no buy price to match on"
        : `logged by ${[...new Set(logged.map((order) => order.mode))].join(", ")} at`
          + ` ${logged.map((order) => (order.price == null ? "?" : order.price.toFixed(3))).join("/")}`
          + ` but the row paid ${paid.toFixed(3)} -- outside the ${FIXED_ENTRY_PRICE_TOLERANCE} tolerance`);
    console.log(`   ${String(row.closedAt || row.resolvedAt || "-").slice(0, 19)}`
      + ` ${String(row.question || "").slice(0, 44).padEnd(44)} ${String(row.outcome || "").padEnd(10)}`
      + ` paid ${paid == null ? "  -  " : paid.toFixed(3)} pnl ${money(row.realizedPnlUsdc)}`);
    console.log(`      token ${tokenId.slice(0, 18)}...  ${verdict}`);
  }
  if (unclaimedAged.length > 40) console.log(`   ... and ${unclaimedAged.length - 40} more`);

  // Whether the row already carries a durable owner. If it does, none of the above matters
  // and the defect is that the renderer is not reading it.
  const stamped = closed.filter((row) => row && row.portfolioId).length;
  console.log(`\nclosed rows carrying a durable portfolioId of their own: ${stamped} of ${closed.length}`);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
