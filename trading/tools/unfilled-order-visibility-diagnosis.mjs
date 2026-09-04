// Read-only diagnostic. Writes nothing, publishes nothing, needs no secrets.
//
// Reported: the "Unfilled ... limit orders" panel shows "0 UNFILLED / 0 WOULD WIN / 0 WOULD
// LOSE" and "No limit order has expired or been cancelled without filling into a position
// yet" -- on several portfolios at once, on an account that demonstrably cancels and expires
// bids (the executor's own restore list held 64 of them).
//
// This is about the rows being ABSENT, not ungraded: tools/unfilled-limit-order-evaluation-
// diagnosis.mjs already covers why a present row carries no would-be P/L.
//
// A row has to survive three gates to appear, and each drops it silently:
//
//   1. the sync has to publish it at all, in liveState.unfilledLimitOrders (live) or the
//      portfolio's own trades (paper);
//   2. isUnfilledLimitOrder() has to accept it -- it demands a status of exactly
//      LIMIT_ORDER_EXPIRED or LIVE_LIMIT_ORDER_UNFILLED and no partial fill;
//   3. for live, belongsToLivePortfolio() has to attribute it to the open portfolio, which
//      is decided by the execution logs rather than by anything on the row.
//
// So it counts the rows at each gate, per portfolio, using the dashboard's own functions
// extracted from app.js -- what the browser computes, not a re-derivation of it.
const HOST = process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading";

const text = (value) => String(value == null ? "" : value).trim();

async function fetchJson(url) {
  const response = await fetch(url);
  const body = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 140)}`);
  return JSON.parse(body);
}

function functionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} was not found in app.js`);
  let depth = 0;
  for (let index = source.indexOf("{", source.indexOf(")", start)); index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`function ${name} is unbalanced`);
}

async function main() {
  console.log(`Unfilled limit order visibility at ${new Date().toISOString()}`);
  console.log(`Read-only: nothing is written, no credentials are used.\n`);

  const [app, live, config] = await Promise.all([
    fetch(`${HOST}/assets/app.js`).then((response) => response.text()),
    fetchJson(`${HOST}/api.php?action=state&target=live&t=${Date.now()}`),
    fetchJson(`${HOST}/api.php?action=portfolio-config&t=${Date.now()}`).catch(() => null),
  ]);

  const rows = Array.isArray(live?.unfilledLimitOrders) ? live.unfilledLimitOrders : [];
  console.log(`== gate 1: what the sync published`);
  console.log(`   liveState.unfilledLimitOrders: ${rows.length} row(s)`);
  if (!rows.length) {
    console.log(`   -> nothing is published, so no filter is at fault. unfilledLimitOrderHistory`);
    console.log(`      only ever adds rows from releasedOrderCapital.vanished, which is the`);
    console.log(`      orders that left the book BETWEEN two syncs. A cull while no sync was`);
    console.log(`      running, or a previousState that lost the ledger, leaves it empty.`);
  }

  // The dashboard's own chain, run rather than reimplemented.
  const api = new Function("state", `
    const CUSTOM_PAPER_STRATEGY_ID = /^[a-z][a-zA-Z0-9]{1,30}$/;
    const BUILT_IN_PAPER_STRATEGY_IDS = [];
    const draftedCustomLivePortfolioId = () => null;
    ${/const FIXED_ENTRY_PRICE_TOLERANCE = [\d.]+;/.exec(app)[0]}
    ${functionSource(app, "memoizedByIdentity")}
    ${functionSource(app, "normalizeMode")}
    ${functionSource(app, "customLivePortfolioIdFromMode")}
    ${functionSource(app, "isFixedEntryMode")}
    ${functionSource(app, "isLivePortfolioMode")}
    ${functionSource(app, "scrapedObservationIsError")}
    ${functionSource(app, "scrapedMarketObservations")}
    ${functionSource(app, "isUnfilledLimitOrder")}
    ${functionSource(app, "isClosedTrade")}
    ${functionSource(app, "isFilledPortfolioRow")}
    ${functionSource(app, "fixedEntryPriceSignatures")}
    ${functionSource(app, "matchesFixedEntryPrice")}
    ${functionSource(app, "restsAtFixedEntryPrice")}
    ${functionSource(app, "fixedEntryOrderPricesByToken")}
    ${functionSource(app, "boughtAtFixedEntryPrice")}
    ${functionSource(app, "allLiveModes")}
    ${functionSource(app, "liveOrdersByToken")}
    ${functionSource(app, "newestLiveOrder")}
    ${functionSource(app, "liveTokenOwnerMode")}
    ${functionSource(app, "belongsToLivePortfolio")}
    ${functionSource(app, "liveUnfilledLimitOrders")}
    const normalizeFixedEntryPrice = (value) => Number(value);
    const portfolioConfigForMode = () => ({ fixedEntryPrice: 0.5 });
    return { allLiveModes, liveUnfilledLimitOrders, belongsToLivePortfolio,
      isUnfilledLimitOrder, normalizeMode, liveTokenOwnerMode };
  `);

  const customIds = Object.keys(config?.config?.livePortfolios || {});
  const files = [
    ["live", "data/live-execution-state.json"],
    ["live-5050", "data/live-5050-execution-state.json"],
    ...customIds.map((id) => [`live-custom-${id}`, `data/live-${id}-execution-state.json`]),
  ];
  const liveExecutionByMode = {};
  for (const [mode, file] of files) {
    try {
      liveExecutionByMode[mode] = await fetchJson(`${HOST}/${file}`);
    } catch {
      liveExecutionByMode[mode] = null;
    }
  }

  const state = {
    mode: "live",
    portfolioConfig: config?.config || { livePortfolios: {} },
    botState: { evaluations: [], marketObservations: [] },
    scrapedMarketStateLoaded: true,
    scrapedMarketObservations: [],
    liveExecutionByMode,
    live5050ExecutionState: liveExecutionByMode["live-5050"] || null,
    liveState: live,
  };
  const dash = api(state);

  console.log(`\n== gate 2: isUnfilledLimitOrder()`);
  const accepted = rows.filter((row) => dash.isUnfilledLimitOrder(row));
  console.log(`   accepted ${accepted.length} of ${rows.length}`);
  const statuses = new Map();
  for (const row of rows) {
    const key = `${text(row.status) || "(no status)"}`
      + `${Number(row.filledSize) > 0.000001 ? " +partial-fill" : ""}`;
    statuses.set(key, (statuses.get(key) || 0) + 1);
  }
  for (const [status, count] of [...statuses.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(count).padStart(5)}  ${status}`);
  }
  if (rows.length && !accepted.length) {
    console.log(`   -> every published row is refused here. The panel's emptiness is this gate,`);
    console.log(`      and the status the sync wrote does not match what the dashboard demands.`);
  }

  console.log(`\n== gate 3: belongsToLivePortfolio(), per portfolio`);
  const modes = dash.allLiveModes();
  let attributedTotal = 0;
  for (const mode of modes) {
    const own = dash.liveUnfilledLimitOrders(live, mode);
    attributedTotal += own.length;
    const label = config?.config?.livePortfolios?.[dash.normalizeMode(mode).replace(/^live-custom-/, "")]?.label;
    console.log(`   ${mode.padEnd(26)} ${String(own.length).padStart(4)} row(s)`
      + `${label ? `   "${label}"` : ""}`);
  }
  console.log(`   ${"".padEnd(26)} ---- attributed ${attributedTotal} of ${accepted.length} accepted`);

  const orphans = accepted.filter((row) => !modes.some((mode) => dash.belongsToLivePortfolio(row, mode)));
  console.log(`\n   rows belonging to no portfolio: ${orphans.length}`);
  if (orphans.length) {
    console.log(`   -> these are published and accepted, and no tab can show them. Attribution`);
    console.log(`      is decided by the execution logs, not by the row, so a bid whose run log`);
    console.log(`      no longer carries its submission becomes invisible everywhere.`);
    for (const row of orphans.slice(0, 6)) {
      console.log(`      "${text(row.question).slice(0, 46)}" [${text(row.outcome)}]`);
      console.log(`        token ${text(row.tokenId).slice(0, 20) || "-"}`
        + `  price ${row.price ?? "-"}  stake ${row.stakeUsdc ?? "-"}`
        + `  owner ${dash.liveTokenOwnerMode(text(row.tokenId)) || "(none)"}`);
      console.log(`        closedAt ${text(row.closedAt) || "-"}  createdAt ${text(row.createdAt) || "-"}`);
    }
  }

  console.log(`\n== how many submissions each execution log still carries`);
  console.log(`   Attribution reads these, so a short log is a portfolio that cannot claim`);
  console.log(`   its own older bids.`);
  for (const [mode, payload] of Object.entries(liveExecutionByMode)) {
    const runs = Array.isArray(payload?.runs) ? payload.runs : [];
    const submissions = runs.reduce((sum, run) => sum
      + (Array.isArray(run?.attempts) ? run.attempts.filter((a) => a?.orderId || a?.response?.orderID).length : 0), 0);
    console.log(`   ${mode.padEnd(26)} ${payload ? `${String(runs.length).padStart(4)} run(s), ${submissions} submission(s)` : "no log published"}`);
  }
}

main().catch((error) => {
  console.log(`\n!! diagnosis stopped early: ${error?.message || error}`);
  process.exitCode = 1;
});
