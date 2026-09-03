// Read-only diagnostic. Writes nothing, publishes nothing, needs no secrets.
//
// Reported: the Realized figure on 80+ esports did not match the P/L of its own closed
// positions, and the same was to be checked on the others.
//
// It could not have matched. The tile read the ACCOUNT's realized P/L -- equity minus the
// original value minus open marks -- while the Closed trades table below it listed only the
// rows attributed to that portfolio. Only 5050 derived its own, under a comment written when
// Live and 5050 were the only two live portfolios: back then "everything else" was a single
// portfolio whose history happened to be the account's, so nothing looked wrong.
//
// This measures the gap per portfolio, using the dashboard's own attribution chain extracted
// from app.js, so what it reports is what the browser computes rather than a re-derivation.
// It prints, for every live portfolio: the account figure the tile used to show, the sum of
// that portfolio's own closed rows, and the difference. It also checks the sums add up --
// every closed row must belong to exactly one portfolio, or the attribution is losing or
// double-counting trades, which would be a worse bug than the one being fixed.
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
  console.log(`Per-portfolio realized reconciliation at ${new Date().toISOString()}`);
  console.log(`Read-only: nothing is written, no credentials are used.\n`);

  const [app, live, config] = await Promise.all([
    fetch(`${HOST}/assets/app.js`).then((response) => response.text()),
    fetchJson(`${HOST}/api.php?action=state&target=live`),
    fetchJson(`${HOST}/api.php?action=portfolio-config`).catch(() => null),
  ]);

  // The dashboard's own attribution, run here rather than reimplemented.
  const attribution = new Function("state", `
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
    ${functionSource(app, "isClosedTrade")}
    ${functionSource(app, "isUnfilledLimitOrder")}
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
    ${functionSource(app, "liveClosedTrades")}
    ${functionSource(app, "livePositions")}
    const normalizeFixedEntryPrice = (value) => Number(value);
    const portfolioConfigForMode = () => ({ fixedEntryPrice: 0.5 });
    return { allLiveModes, liveClosedTrades, livePositions, belongsToLivePortfolio, normalizeMode };
  `);

  // Every live portfolio's execution log, because attribution is decided by them.
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
  const api = attribution(state);

  const amount = (value) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : 0;
  };
  const closed = Array.isArray(live?.closedTrades) ? live.closedTrades : [];
  const portfolio = live?.portfolio || {};
  const equity = Number(portfolio.equityUsdc);
  const deposited = Number(portfolio.depositedUsdc ?? portfolio.originalValueUsdc);
  const openPnl = Number(portfolio.openPnlUsdc || 0);
  const accountRealized = Number.isFinite(equity) && Number.isFinite(deposited) && deposited > 0
    ? equity - deposited - openPnl
    : Number(portfolio.realizedPnlUsdc);

  console.log(`== the account, which every live tile used to show`);
  console.log(`   equity ${equity.toFixed(2)}   original value ${deposited.toFixed(2)}`
    + `   open P/L ${openPnl.toFixed(2)}`);
  console.log(`   account realized P/L  ${accountRealized.toFixed(2)} USDC`);
  console.log(`   closed rows stored    ${closed.length}\n`);

  console.log(`== per portfolio: what the tile showed, and what its own closed rows say`);
  const modes = api.allLiveModes();
  let attributedTotal = 0;
  const seen = new Map();
  for (const mode of modes) {
    const own = api.liveClosedTrades(live, mode);
    const positions = api.livePositions(live, mode);
    const realized = own.reduce((sum, row) => sum + amount(row.realizedPnlUsdc ?? row.pnlUsdc), 0);
    const stake = [...positions, ...own]
      .reduce((sum, row) => sum + amount(row.totalCostUsdc ?? row.stakeUsdc), 0);
    attributedTotal += realized;
    for (const row of own) {
      const key = text(row.id) || `${text(row.tokenId)}:${text(row.closedAt)}`;
      seen.set(key, (seen.get(key) || 0) + 1);
    }
    const gap = accountRealized - realized;
    console.log(`   ${mode.padEnd(24)} own realized ${realized.toFixed(2).padStart(9)} USDC`
      + `   from ${String(own.length).padStart(3)} closed row(s)`
      + `   stake ${stake.toFixed(2).padStart(8)}`);
    console.log(`   ${" ".repeat(24)} the tile showed ${accountRealized.toFixed(2)} instead`
      + `  -> off by ${gap >= 0 ? "+" : ""}${gap.toFixed(2)} USDC`);
  }

  console.log(`\n== do the parts add up?`);
  console.log(`   sum of every portfolio's own realized  ${attributedTotal.toFixed(2)} USDC`);
  console.log(`   account realized                       ${accountRealized.toFixed(2)} USDC`);
  console.log(`   difference                             ${(attributedTotal - accountRealized).toFixed(2)} USDC`);
  console.log(`   (the ledger and the wallet need not agree to the cent -- equity is measured,`);
  console.log(`    the ledger is reconstructed -- but a large gap means rows carry no P/L.)`);

  const unattributed = closed.filter((row) => !modes.some((mode) => api.belongsToLivePortfolio(row, mode)));
  const doubled = [...seen.entries()].filter(([, count]) => count > 1);
  console.log(`\n   closed rows belonging to no portfolio   ${unattributed.length}`);
  console.log(`   closed rows counted by more than one    ${doubled.length}`);
  if (unattributed.length || doubled.length) {
    console.log(`   -> attribution is losing or double-counting trades, which is worse than the`);
    console.log(`      tile showing the wrong number. Sample:`);
    for (const row of unattributed.slice(0, 5)) {
      console.log(`      unattributed: "${text(row.question).slice(0, 50)}" [${text(row.outcome)}]`
        + ` token ${text(row.tokenId).slice(0, 18) || "-"} P/L ${text(row.realizedPnlUsdc)}`);
    }
    for (const [key, count] of doubled.slice(0, 5)) {
      console.log(`      counted ${count}x: ${key.slice(0, 60)}`);
    }
  }

  const nullPnl = closed.filter((row) => row.realizedPnlUsdc == null).length;
  console.log(`\n   closed rows carrying no P/L at all     ${nullPnl}`);
  console.log(`   (these sum as zero, so they widen the gap above without being visible in it.)`);
}

main().catch((error) => {
  console.log(`\n!! reconciliation stopped early: ${error?.message || error}`);
  process.exitCode = 1;
});
