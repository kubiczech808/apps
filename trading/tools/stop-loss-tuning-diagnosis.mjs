// Read-only diagnostic. Places no orders, writes nothing, needs no secrets.
//
// Asked for: the closed trades of a live portfolio running a 25%-of-net-win stop loss,
// and what to set differently so the portfolio is at least as profitable while catching
// the LOST trades that give back the whole stake.
//
// The arithmetic here is not re-derived. It imports the SAME functions the RPi exit worker
// runs -- equalRiskExitPlan, effectiveStopFloor, stopGapFloorPrice, netExitValue -- so a
// number in this report is the number that would actually be in force. Re-implementing the
// stop maths in a diagnosis tool is how a tool comes to describe a system that does not
// exist.
//
// What it can measure, and what it cannot. Closed trades carry the entry, the stake, the
// resolution and the realised P/L, so the loss that a given floor WOULD have capped is
// exact. They do not carry the price path, so "would this winner have been stopped out on
// the way up" is not answerable from them and is reported as exposure rather than as a
// number. The declined-stop annotations are the evidence for what the stop actually did.
import { pathToFileURL } from "node:url";
import {
  equalRiskExitPlan,
  effectiveStopFloor,
  stopGapFloorPrice,
  netExitValue,
} from "./rpi-live-exit-worker.mjs";
// The market-shape classifier that this report's section 9 is built around is not
// re-derived here either, for the same reason the stop maths above is not: it is now a
// portfolio config field (excludedMarketShapes), enforced by the paper bot's own filter, and
// a second copy in a diagnosis tool is exactly how the two came to disagree before.
import { marketShape, MARKET_SHAPE_IDS } from "./paper-trading-bot.mjs";

const HOST = process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading";
const PORTFOLIO_MATCH = String(process.env.PORTFOLIO_MATCH || "underway")
  .split(";").map((text) => text.trim().toLowerCase()).filter(Boolean);
const MULTIPLIERS = String(process.env.MULTIPLIER_GRID || "0.25,0.5,0.75,1,1.5,2,3")
  .split(",").map((text) => Number(text.trim())).filter((value) => Number.isFinite(value) && value > 0);
const PROBABILITY_FLOORS = String(process.env.PROBABILITY_FLOOR_GRID || "0,0.35,0.49,0.6,0.7,0.8")
  .split(",").map((text) => Number(text.trim())).filter((value) => Number.isFinite(value) && value >= 0);
const GAP_TOLERANCES = String(process.env.GAP_TOLERANCE_GRID || "0.5,0.7,0.85,1")
  .split(",").map((text) => Number(text.trim())).filter((value) => Number.isFinite(value) && value > 0);
const TRADE_ROWS = Number(process.env.TRADE_ROWS || 80);

// Sequential and retried, never concurrent. This runs against a 128 MB shared host that
// answers 500 when several state requests decode at once: the first attempt at this tool
// fired three in a Promise.all and got a 500 on a different one of the three each run,
// which reads as "the endpoint is broken" rather than "I asked for too much at once".
async function fetchJson(url, attempts = 4) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 2000 * (2 ** (attempt - 1))));
    try {
      const response = await fetch(url);
      const text = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
      return JSON.parse(text);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

const num = (value, fallback = null) => {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const usd = (value) => (value == null ? "     -" : `${value < 0 ? "-" : "+"}${Math.abs(value).toFixed(2).padStart(5)}`);
const pct = (value) => (value == null ? "   - " : `${(value * 100).toFixed(1).padStart(5)}%`);
const px = (value) => (value == null ? "  -  " : value.toFixed(4));
const clip = (value, width) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, width).padEnd(width);

// One closed trade, reduced to the fields every question below is answered from.
function normalizeTrade(row) {
  const cost = num(row.totalCostUsdc ?? row.stakeUsdc);
  const shares = num(row.shares ?? row.size);
  const entry = num(row.entryPrice) ?? (cost != null && shares > 0 ? cost / shares : null);
  const exitPrice = num(row.exitPrice ?? row.finalOutcomePrice);
  return {
    question: row.question || row.market || "",
    outcome: row.outcome || "",
    portfolioId: row.portfolioId || "",
    tokenId: String(row.tokenId || row.assetId || ""),
    openedAt: row.openedAt || row.date || null,
    closedAt: row.closedAt || row.resolvedAt || null,
    entry,
    exitPrice,
    shares,
    cost,
    netGainIfWin: num(row.netGainIfWinUsdc) ?? (shares != null && cost != null ? shares - cost : null),
    realizedPnl: num(row.realizedPnlUsdc ?? row.pnlUsdc),
    exitReason: row.exitReason || null,
    exitStopPrice: num(row.exitStopPrice ?? row.stopPrice),
    declineKind: row.declineKind || null,
    unsoldShares: num(row.unsoldShares),
    status: String(row.status || "").toUpperCase() || null,
    // The paper bot's own account of what the stop did, and the only place any of these
    // rows says so: ARMED on a LOST trade means the stop was watching and never fired,
    // DECLINED_GAPPED means the gap band refused it, FILLED_AT_FLOOR means it worked.
    stopLossStatus: row.stopLossStatus || null,
    stopLossPrice: num(row.stopLossPrice),
    closeReason: row.closeReason || null,
  };
}

// ---------------------------------------------------------------------------------
// Whose live trade is this? Mirrors the dashboard, deliberately literally.
//
// Live closed rows carry no portfolioId -- 473 of 473 on production -- and they cannot:
// every live portfolio draws on ONE wallet, so the account's history is the wallet's and
// not any one portfolio's. The dashboard answers ownership from each portfolio's own
// execution run log, which remembers the token it ordered and the price it rested the bid
// at; a closed row's paid entry price then matches the order that filled it.
//
// Without this the tool reported "0 closed trades" for a live portfolio whose dashboard tab
// shows hundreds -- which turns a live-vs-paper comparison into a comparison of paper
// against nothing. Kept as a near-transcription of app.js's liveOrdersByToken /
// liveTokenOwnerMode / belongsToLivePortfolio rather than tidied up: the two have to agree,
// because the report is only worth something if it splits the rows the same way the tab the
// person is looking at does.
const FIXED_ENTRY_PRICE_TOLERANCE = 0.02;

const priceMatches = (candidate, value) => candidate != null && value != null
  && Math.abs(value - candidate) < FIXED_ENTRY_PRICE_TOLERANCE;

// A token can appear in two portfolios' logs -- one traded it after the other closed out.
// The newest order owns it, the same rule api.php applies to the stop-loss policy.
function newestLiveOrder(orders) {
  return orders.reduce(
    (newest, order) => (!newest || String(order.at || "") >= String(newest.at || "") ? order : newest),
    null,
  );
}

// The catalogue id a live portfolio is known by here vs the mode the dashboard attributes
// under. They differ for exactly one portfolio and forgetting it silently empties that one.
export function liveModeForId(id) {
  return id === "live5050" ? "live-5050" : String(id);
}

export function buildLiveAttribution(executionByMode, config) {
  const ordersByToken = new Map();
  for (const [mode, execution] of Object.entries(executionByMode)) {
    if (!execution || typeof execution !== "object") continue;
    const records = [execution, ...(Array.isArray(execution.runLog) ? execution.runLog : [])];
    for (const record of records) {
      const at = String(record?.generatedAt || record?.runAt || execution.generatedAt || "");
      for (const attempt of (Array.isArray(record?.attempts) ? record.attempts : [])) {
        const action = String(attempt?.action || "").toUpperCase();
        // A rejected attempt never reached the book, so it never bought anything and must
        // not claim a fill. A dry run never even asked.
        if (action.includes("REJECT") || action.startsWith("DRY_RUN")) continue;
        const tokenId = String(attempt?.tokenId || "");
        if (!tokenId) continue;
        if (!ordersByToken.has(tokenId)) ordersByToken.set(tokenId, []);
        ordersByToken.get(tokenId).push({ mode, price: num(attempt?.orderPrice), at });
      }
    }
  }

  // 5050's own prices, per token and in general. It rests every bid at one configured
  // price far from the market, so price alone recognises its rows -- the one signal that
  // survives a run log that was trimmed or never published.
  const fixedByToken = new Map();
  const fixedPrices = new Set();
  const addFixed = (value) => {
    const price = num(value);
    if (price != null && price > 0 && price < 1) fixedPrices.add(Number(price.toFixed(4)));
  };
  addFixed(config?.live5050?.fixedEntryPrice);
  for (const price of (Array.isArray(config?.live5050?.fixedEntryPriceHistory)
    ? config.live5050.fixedEntryPriceHistory : [])) addFixed(price);
  const fixedExecution = executionByMode["live-5050"] || {};
  for (const record of [fixedExecution, ...(Array.isArray(fixedExecution.runLog) ? fixedExecution.runLog : [])]) {
    addFixed(record?.fixedEntry?.entryPrice);
    for (const attempt of (Array.isArray(record?.attempts) ? record.attempts : [])) {
      if (String(attempt?.action || "").toUpperCase().startsWith("DRY_RUN")) continue;
      addFixed(attempt?.orderPrice);
      const tokenId = String(attempt?.tokenId || "");
      const price = num(attempt?.orderPrice);
      if (!tokenId || price == null) continue;
      if (!fixedByToken.has(tokenId)) fixedByToken.set(tokenId, new Set());
      fixedByToken.get(tokenId).add(Number(price.toFixed(4)));
    }
  }
  return { ordersByToken, fixedByToken, fixedPrices };
}

export function liveTokenOwnerMode(row, attribution) {
  const tokenId = String(row?.tokenId || row?.assetId || "");
  if (!tokenId) return null;
  const orders = attribution.ordersByToken.get(tokenId) || [];
  if (!orders.length) return null;
  // Every row this tool attributes is a CLOSED trade, so it filled: the token alone cannot
  // say who bought it (all the portfolios rest bids on the same markets), but what it was
  // actually paid does, because that matches the order that filled.
  const paid = num(row?.entryPrice ?? row?.avgPrice ?? row?.averagePrice);
  if (paid == null) return null;
  const filled = orders.filter((order) => priceMatches(order.price, paid));
  return filled.length ? newestLiveOrder(filled).mode : null;
}

// Does 5050's own price signal claim this filled row? Per-token only: 5050's configured
// prices (0.50, 0.65) are ordinary enough that Live lands on them too, so a bare price
// match with no order from 5050 on that token used to steal Live's trades.
function boughtAtFixedEntryPrice(row, attribution) {
  const paid = num(row?.entryPrice ?? row?.avgPrice ?? row?.averagePrice);
  if (paid == null) return false;
  const ordered = attribution.fixedByToken.get(String(row?.tokenId || row?.assetId || ""));
  return Boolean(ordered && [...ordered].some((price) => priceMatches(price, paid)));
}

// app.js's belongsToLivePortfolio, closed-row branch. The asymmetry is the load-bearing
// part: a custom live portfolio claims ONLY what its own log names, while the base Live
// portfolio keeps everything unclaimed. So "Live 72-82" owning hundreds of rows is not the
// same kind of statement as a custom portfolio owning a handful -- one is a positive claim
// and the other is a default -- and the report has to say which it is.
export function belongsToLiveMode(row, mode, attribution) {
  const wantsFixedEntry = mode === "live-5050";
  const tokenId = String(row?.tokenId || row?.assetId || "");
  if (!tokenId) return { owned: !wantsFixedEntry, basis: "no-token" };
  const owner = liveTokenOwnerMode(row, attribution);
  if (owner) return { owned: owner === mode, basis: "run-log" };
  const looksLikeFixedEntry = boughtAtFixedEntryPrice(row, attribution);
  if (wantsFixedEntry) return { owned: looksLikeFixedEntry, basis: "fixed-price" };
  if (mode.startsWith("live-custom-")) return { owned: false, basis: "unclaimed" };
  return { owned: !looksLikeFixedEntry, basis: "fallback" };
}

// How a trade ended, in the terms the question is about. `full-stake` is the bucket the
// stop loss exists to empty.
function classify(trade) {
  const cost = trade.cost;
  const pnl = trade.realizedPnl;
  if (cost == null || pnl == null) return "unknown";
  if (pnl > 0.005) return "won";
  if (pnl >= -0.005) return "flat";
  // Within a cent of the whole stake: nothing was recovered.
  if (pnl <= -(cost - 0.01)) return "lost-full";
  return "lost-capped";
}

// What a given setting would put in force for this position, using the worker's own maths.
function floorFor(trade, multiplier, probabilityFloor) {
  const plan = equalRiskExitPlan({
    shares: trade.shares,
    totalCostUsdc: trade.cost,
    netGainIfWinUsdc: trade.netGainIfWin,
    stopLossRiskMultiplier: multiplier,
    feeRate: 0,
    feesEnabled: true,
  });
  const equalRiskFloor = plan.protectable ? plan.stopPrice : null;
  // entryPrice matters here: a probability floor at or above the entry is not a cap, it
  // liquidates on arming, and effectiveStopFloor now refuses to use it once it knows the
  // entry. Omitting it here would report a floor the fixed worker no longer applies.
  const floor = effectiveStopFloor({
    stopPrice: equalRiskFloor,
    probabilityFloor: probabilityFloor > 0 ? probabilityFloor : null,
    entryPrice: trade.entry,
  });
  return {
    plan,
    equalRiskFloor,
    floor,
    // Which of the two levels is actually in force. The equal-risk floor moves with the
    // entry; the probability floor does not, which is the whole reason it exists.
    source: floor == null ? "none"
      : (equalRiskFloor != null && floor === equalRiskFloor ? "equal-risk" : "probability"),
  };
}

// The loss a floor caps the trade at, if the sale happens AT the floor.
function lossAtFloor(trade, floor) {
  if (floor == null || trade.shares == null || trade.cost == null) return null;
  const proceeds = netExitValue({ shares: trade.shares, price: floor, feeRate: 0, feesEnabled: true });
  if (proceeds == null) return null;
  return trade.cost - proceeds;
}

async function main() {
  console.log(`Stop-loss tuning diagnosis at ${new Date().toISOString()}`);
  console.log("Read-only: no order is placed, nothing is written, no credentials are used.");
  console.log(`Portfolio match: ${PORTFOLIO_MATCH.join(", ") || "(all)"}\n`);

  // ---------------------------------------------------------------------------------
  // Both catalogues, always, whether or not the match needs them. A portfolio named like
  // the live ones can be a paper one -- the naming convention is the same -- and looking in
  // only one place is how "0 trades in the matched portfolio" gets read as "no data".
  console.log("== 1. every portfolio, and how its stop loss is configured right now");
  // The unnamed paper summary decodes the whole evaluation archive on the way out and
  // answers HTTP 500 on this host -- the dashboard carries the same note. So the overview
  // is fetched first, and the matched portfolio's trades are asked for by strategy_id:
  // `summary=dashboard` only includes trades for the ONE portfolio it is given.
  const configPayload = await fetchJson(`${HOST}/api.php?action=portfolio-config&t=${Date.now()}`);
  const livePayload = await fetchJson(`${HOST}/api.php?action=state&target=live&t=${Date.now()}`);
  const overviewPayload = await fetchJson(
    `${HOST}/api.php?action=state&target=paper&summary=portfolio-overview&t=${Date.now()}`,
  );
  const config = configPayload?.config || configPayload || {};
  const live = livePayload?.liveState || livePayload?.state || livePayload || {};
  const overview = overviewPayload?.botState || overviewPayload?.state || overviewPayload || {};
  const overviewPortfolios = overview?.paperPortfolios && typeof overview.paperPortfolios === "object"
    ? overview.paperPortfolios : {};

  // Trades for the paper portfolios whose name matches, one request each. Asking for every
  // portfolio's trades is what the 500 was about, so only the matches are fetched.
  const paperIds = Object.keys(config.paper || {}).filter((id) => {
    const name = String(config.paper?.[id]?.displayName || id);
    return !PORTFOLIO_MATCH.length
      || PORTFOLIO_MATCH.some((needle) => `${name} ${id}`.toLowerCase().includes(needle));
  });
  const paperPortfolios = { ...overviewPortfolios };
  for (const id of paperIds) {
    try {
      const payload = await fetchJson(
        `${HOST}/api.php?action=state&target=paper&summary=dashboard&strategy_id=${encodeURIComponent(id)}&t=${Date.now()}`,
      );
      const state = payload?.botState || payload?.state || payload || {};
      const row = state?.paperPortfolios?.[id];
      if (row) paperPortfolios[id] = row;
    } catch (error) {
      console.log(`   !! could not read paper portfolio ${id}: ${error?.message || error}`);
    }
  }

  const liveClosed = [
    ...(Array.isArray(live.closedTrades) ? live.closedTrades : []),
    ...(Array.isArray(live.trades?.closed) ? live.trades.closed : []),
  ];

  // Every live portfolio's execution run log, one request each and sequential for the same
  // reason as everything else here. This is what makes a live row attributable at all.
  const liveIds = [
    ...(config.live && typeof config.live === "object" ? [["live", config.live]] : []),
    ...(config.live5050 && typeof config.live5050 === "object" ? [["live5050", config.live5050]] : []),
    ...Object.entries(config.livePortfolios || {}).filter(([, row]) => row && typeof row === "object"),
  ];
  const executionByMode = {};
  for (const [rawId] of liveIds) {
    const id = rawId === "live" || rawId === "live5050" ? rawId : `live-custom-${rawId}`;
    const target = id === "live" ? "live-execution"
      : id === "live5050" ? "live-5050-execution"
        : `${id}-execution`;
    try {
      const payload = await fetchJson(`${HOST}/api.php?action=state&target=${target}&t=${Date.now()}`);
      executionByMode[liveModeForId(id)] = payload?.state || payload || null;
    } catch (error) {
      console.log(`   !! could not read execution log for ${id}: ${error?.message || error}`);
    }
  }
  const attribution = buildLiveAttribution(executionByMode, config);

  const catalogue = [
    ...liveIds
      .map(([rawId, row]) => {
        const id = rawId === "live" || rawId === "live5050" ? rawId : `live-custom-${rawId}`;
        const mode = liveModeForId(id);
        // Live closed rows carry no portfolioId, so the row itself cannot say whose it is.
        // Attributed exactly as the dashboard tab does, and the basis is kept per row so
        // section 2 can separate a positive run-log claim from the base portfolio's
        // catch-everything default. Reading those as the same thing is how "Live has 400
        // closed trades" gets mistaken for "Live placed 400 trades".
        const claimed = [];
        for (const trade of liveClosed) {
          const verdict = belongsToLiveMode(trade, mode, attribution);
          if (!verdict.owned) continue;
          const normalized = normalizeTrade(trade);
          normalized.attributionBasis = verdict.basis;
          claimed.push(normalized);
        }
        return { kind: "live", id, mode, name: String(row.displayName || id), row, closed: claimed };
      }),
    ...Object.entries(config.paper || {})
      .filter(([, row]) => row && typeof row === "object")
      .map(([id, row]) => ({
        kind: "paper", id, name: String(row.displayName || id), row,
        closed: (Array.isArray(paperPortfolios[id]?.trades) ? paperPortfolios[id].trades : [])
          .filter((trade) => {
            const status = String(trade?.status || "").toUpperCase();
            // A trade with a settled result. Unfilled limit orders never became positions
            // and would drag the P/L of a portfolio that never held them.
            if (["OPEN", "PENDING", "PENDING_FILL", "UNFILLED", "CANCELLED"].includes(status)) return false;
            return num(trade?.realizedPnlUsdc ?? trade?.pnlUsdc) != null;
          })
          .map(normalizeTrade),
      })),
  ];

  const matched = [];
  for (const entry of catalogue) {
    const isMatch = !PORTFOLIO_MATCH.length
      || PORTFOLIO_MATCH.some((needle) => `${entry.name} ${entry.id}`.toLowerCase().includes(needle));
    if (isMatch) matched.push(entry);
    console.log(`   ${isMatch ? "->" : "  "} ${entry.kind.padEnd(5)} ${clip(entry.id, 24)} "${clip(entry.name, 22)}"`
      + `  multiplier ${String(entry.row.stopLossRiskMultiplier ?? "-").padStart(5)}`
      + `  probFloor ${String(entry.row.stopLossProbabilityFloor ?? "-").padStart(5)}`
      + `  closeBid ${String(entry.row.settlementCloseBid ?? "-").padStart(5)}`
      + `  minProb ${String(entry.row.minProbability ?? "-").padStart(5)}`
      + `  stake ${String(entry.row.stakeUsdc ?? "-").padStart(5)}`
      + `  reverse ${entry.row.reverseOnStopLoss === true ? "yes" : "no"}`
      + `  archived ${entry.row.archived === true ? "YES" : "no"}`
      + `  closed ${String(entry.closed.length).padStart(4)}`);
    // The curated line above is what most runs need. The full row is printed only for a
    // match, and only here, because a live-vs-paper comparison lives or dies on fields
    // that line does not carry -- maxProbability, minLiquidityUsdc, marketType,
    // useLimitOrders, executionTrigger, excludeOverUnderMarkets, excludedMarketShapes --
    // and none of those are in the repo: portfolio-config.json is not tracked, so this is
    // the only way to see a portfolio's real settings without guessing at field names.
    if (isMatch) console.log(`        full config: ${JSON.stringify(entry.row)}`);
  }
  const logClaimed = liveClosed.filter((trade) => liveTokenOwnerMode(trade, attribution)).length;
  if (liveClosed.length) {
    console.log(`\n   live closed rows: ${liveClosed.length} on the account,`
      + ` ${logClaimed} claimed positively by a run log,`
      + ` ${liveClosed.length - logClaimed} unclaimed`);
    console.log(`   execution logs read: ${Object.entries(executionByMode)
      .map(([mode, execution]) => `${mode}=${Array.isArray(execution?.runLog) ? execution.runLog.length + 1 : (execution ? 1 : 0)}`)
      .join(" ")} run(s)`);
    console.log("   An unclaimed row falls to the base Live portfolio, which is what the dashboard");
    console.log("   does. That is a default, not evidence Live placed it -- run logs are trimmed.");
  }
  if (!matched.length) {
    console.log(`\n   !! nothing matched /${PORTFOLIO_MATCH.join("|")}/ -- pass PORTFOLIO_MATCH to pick one above`);
    return;
  }
  console.log("");
  console.log(`   matched: ${matched.map((entry) => `${entry.kind}:${entry.id} (${entry.closed.length})`).join(", ")}`);

  // One report per portfolio, never pooled. The first run matched three portfolios on
  // "underway" -- multipliers 0.25, 2 and 2 -- and pooled 473 trades into one P/L and one
  // "deployed setting" taken from whichever happened to be first. That is an average of
  // three different strategies, which is not a fact about any of them.
  const analysable = matched.filter((entry) => entry.closed.length);
  if (!analysable.length) {
    console.log("   !! no matched portfolio has a settled closed trade in this payload");
    return;
  }
  for (const entry of analysable) {
    console.log(`\n${"=".repeat(88)}`);
    console.log(`REPORT: ${entry.kind}:${entry.id} "${entry.name}"`
      + `  multiplier ${entry.row.stopLossRiskMultiplier ?? "-"}`
      + `  probFloor ${entry.row.stopLossProbabilityFloor ?? "-"}`
      + `  closeBid ${entry.row.settlementCloseBid ?? "-"}`
      + `  minProb ${entry.row.minProbability ?? "-"}`);
    console.log("=".repeat(88));
    await report(entry, live);
  }
  console.log("\nDone. Nothing was written.");
}

async function report(entry, live) {
  const trades = entry.closed;
  const matched = [entry];
  console.log("== 2. the closed trades");
  const openTimes = trades.map((trade) => trade.openedAt).filter(Boolean).sort();
  console.log(`   opened ${openTimes[0] || "?"} .. ${openTimes[openTimes.length - 1] || "?"}`);

  const buckets = new Map();
  for (const trade of trades) {
    const kind = classify(trade);
    trade.bucket = kind;
    const bucket = buckets.get(kind) || { count: 0, pnl: 0, stake: 0 };
    bucket.count += 1;
    bucket.pnl += trade.realizedPnl || 0;
    bucket.stake += trade.cost || 0;
    buckets.set(kind, bucket);
  }
  console.log("");
  console.log("   outcome        n    total P/L    staked   mean P/L");
  let totalPnl = 0;
  let totalStake = 0;
  for (const kind of ["won", "flat", "lost-capped", "lost-full", "unknown"]) {
    const bucket = buckets.get(kind);
    if (!bucket) continue;
    totalPnl += bucket.pnl;
    totalStake += bucket.stake;
    console.log(`   ${clip(kind, 12)} ${String(bucket.count).padStart(3)}`
      + `    ${usd(bucket.pnl)}    ${bucket.stake.toFixed(2).padStart(6)}`
      + `   ${usd(bucket.pnl / bucket.count)}`);
  }
  console.log(`   ${clip("TOTAL", 12)} ${String(trades.length).padStart(3)}`
    + `    ${usd(totalPnl)}    ${totalStake.toFixed(2).padStart(6)}`
    + `   ${usd(totalPnl / trades.length)}`);
  console.log(`   return on staked capital: ${pct(totalStake > 0 ? totalPnl / totalStake : null)}`);

  // For a live portfolio, how strong the ownership claim on these rows actually is. A
  // run-log claim is evidence; the base Live portfolio's fallback is a default. A report
  // that pools them reads as certainty it does not have.
  const bases = new Map();
  for (const trade of trades) {
    if (!trade.attributionBasis) continue;
    const basis = bases.get(trade.attributionBasis) || { count: 0, pnl: 0, stake: 0 };
    basis.count += 1;
    basis.pnl += trade.realizedPnl || 0;
    basis.stake += trade.cost || 0;
    bases.set(trade.attributionBasis, basis);
  }
  if (bases.size) {
    console.log("\n   how these rows came to be this portfolio's:");
    for (const [basis, stats] of [...bases].sort((a, b) => b[1].count - a[1].count)) {
      const label = basis === "run-log" ? "its own execution log names the token and price"
        : basis === "fallback" ? "unclaimed by any log -- base Live keeps it by default"
          : basis === "fixed-price" ? "recognised by 5050's own resting price"
            : basis;
      console.log(`      ${String(stats.count).padStart(3)}  ${usd(stats.pnl)} on ${stats.stake.toFixed(2).padStart(7)}`
        + `  ${pct(stats.stake > 0 ? stats.pnl / stats.stake : null)}  ${label}`);
    }
  }

  const exitReasons = new Map();
  for (const trade of trades) {
    const key = `${trade.exitReason || "(none)"}${trade.declineKind ? ` / ${trade.declineKind}` : ""}`;
    exitReasons.set(key, (exitReasons.get(key) || 0) + 1);
  }
  console.log("\n   how the position was closed, as recorded:");
  for (const [reason, count] of [...exitReasons].sort((a, b) => b[1] - a[1])) {
    console.log(`      ${String(count).padStart(3)}  ${reason}`);
  }
  console.log("");

  // ---------------------------------------------------------------------------------
  const deployed = matched[0].row;
  const liveMultiplier = num(deployed.stopLossRiskMultiplier, 0) || 0;
  const liveFloorSetting = num(deployed.stopLossProbabilityFloor, 0) || 0;
  console.log(`== 3. where the stop sits at the DEPLOYED setting`
    + ` (multiplier ${liveMultiplier}, probability floor ${liveFloorSetting}, gap band ${GAP_TOLERANCES[0]})`);
  console.log("   The window is the only price range a stop can execute in: it triggers at the");
  console.log("   floor and refuses any bid under the gap floor, so a market that jumps straight");
  console.log("   past the window cannot be stopped at all.\n");
  console.log("   bucket       entry   stopFloor  drop  gapFloor  window  riskCap   actual  market");
  const shown = trades.slice(0, TRADE_ROWS);
  for (const trade of shown) {
    const { floor, source } = floorFor(trade, liveMultiplier || 1, liveFloorSetting);
    const gapFloor = floor == null ? null : stopGapFloorPrice(floor, GAP_TOLERANCES[0]);
    const drop = floor != null && trade.entry != null ? trade.entry - floor : null;
    const window = floor != null && gapFloor != null ? floor - gapFloor : null;
    // A floor at or above the entry is not a cap on anything: it liquidates the position
    // when the stop is armed. Printing a negative "risk" for it would read as protection.
    const liquidates = floor != null && trade.entry != null && floor >= trade.entry;
    const loss = lossAtFloor(trade, floor);
    console.log(`   ${clip(trade.bucket, 11)} ${px(trade.entry)}   ${px(floor)}`
      + ` ${drop == null ? "  -  " : (drop * 100).toFixed(1).padStart(5)}`
      + `   ${px(gapFloor)}`
      + ` ${window == null ? "  -  " : (window * 100).toFixed(1).padStart(5)}`
      + `  ${liquidates ? "AT-ONCE" : usd(loss == null ? null : -loss)}`
      + `  ${usd(trade.realizedPnl)}  ${clip(trade.question, 40)} ${source === "probability" ? "[pf]" : ""}`);
  }
  if (trades.length > shown.length) console.log(`   ... ${trades.length - shown.length} more`);
  console.log("");

  // ---------------------------------------------------------------------------------
  console.log("== 4. what a different setting would have capped the LOST trades at");
  console.log("   Exact for the losses: a trade that resolved at 0 passed through every level, so");
  console.log("   the capped loss is arithmetic. NOT a promise it would have executed -- section 5");
  console.log("   is about whether the book was there, and the winners are section 6.\n");
  const lost = trades.filter((trade) => trade.bucket === "lost-full" || trade.bucket === "lost-capped");
  const wonTrades = trades.filter((trade) => trade.bucket === "won");
  const lostPnl = lost.reduce((sum, trade) => sum + (trade.realizedPnl || 0), 0);
  console.log(`   ${lost.length} losing trade(s), ${usd(lostPnl)} between them;`
    + ` ${wonTrades.length} winner(s), ${usd(wonTrades.reduce((sum, t) => sum + (t.realizedPnl || 0), 0))}`);
  console.log("");
  // One setting, priced against every closed trade. Two halves, and only one of them is
  // exact -- which is the whole reason they are reported apart.
  //
  //   The losses ARE exact. A trade that resolved at 0 passed through every level, so a
  //   floor above 0 caps it at arithmetic.
  //
  //   The winners split. A floor at or above the entry sells the position the moment it is
  //   armed, so the win is replaced by that sale -- exact, and usually a large cost. A floor
  //   below the entry only costs anything if the price dipped to it on the way, and closed
  //   trades carry no price path: that half is a BOUND, not a number.
  function evaluate(multiplier, probabilityFloor) {
    let cappedLosses = 0;
    let unprotectable = 0;
    let immediateLosses = 0;
    for (const trade of lost) {
      const { floor } = floorFor(trade, multiplier, probabilityFloor);
      if (floor == null) {
        unprotectable += 1;
        cappedLosses += trade.realizedPnl || 0;
        continue;
      }
      // A floor at or above the entry is not capping a loss: the position is sold as soon as
      // it is armed. Counting the resulting profit as a saving would flatter the setting for
      // a strategy that never holds anything, so the trade contributes nothing instead.
      if (trade.entry != null && floor >= trade.entry) {
        immediateLosses += 1;
        continue;
      }
      cappedLosses += Math.max(-(trade.cost || 0), -(lossAtFloor(trade, floor) ?? 0));
    }
    let winnersKept = 0;
    let winnersSoldAtOnce = 0;
    let soldAtOnceDelta = 0;
    let exposedPnl = 0;
    let exposedDelta = 0;
    let exposed = 0;
    for (const trade of wonTrades) {
      const { floor } = floorFor(trade, multiplier, probabilityFloor);
      const actual = trade.realizedPnl || 0;
      if (floor == null) { winnersKept += 1; continue; }
      if (trade.entry != null && floor >= trade.entry) {
        // Exact: armed above the entry, it sells at the floor instead of winning.
        winnersSoldAtOnce += 1;
        const proceeds = netExitValue({ shares: trade.shares, price: floor, feeRate: 0, feesEnabled: true });
        soldAtOnceDelta += ((proceeds ?? 0) - (trade.cost || 0)) - actual;
        continue;
      }
      // Unknown: it would only have been stopped if the price reached the floor.
      exposed += 1;
      exposedPnl += actual;
      exposedDelta += -(lossAtFloor(trade, floor) ?? 0) - actual;
    }
    const saving = cappedLosses - lostPnl;
    return {
      multiplier, probabilityFloor, cappedLosses, saving, unprotectable, immediateLosses,
      winnersKept, winnersSoldAtOnce, soldAtOnceDelta, exposed, exposedPnl, exposedDelta,
      // No winner ever dipped to its floor.
      best: totalPnl + saving + soldAtOnceDelta,
      // Every winner with a floor below its entry dipped to it and was stopped.
      worst: totalPnl + saving + soldAtOnceDelta + exposedDelta,
    };
  }

  console.log("   mult  probFloor   capped loss   saving   BEST P/L   WORST P/L   unprot  sells-at-once  exposed");
  const scenarios = [];
  for (const multiplier of MULTIPLIERS) {
    for (const probabilityFloor of PROBABILITY_FLOORS) {
      const scenario = evaluate(multiplier, probabilityFloor);
      scenarios.push(scenario);
      console.log(`   ${String(multiplier).padStart(4)}  ${String(probabilityFloor).padStart(9)}`
        + `   ${usd(scenario.cappedLosses)}   ${usd(scenario.saving)}`
        + `   ${usd(scenario.best)}   ${usd(scenario.worst)}`
        + `   ${String(scenario.unprotectable).padStart(6)}`
        + `  ${String(scenario.winnersSoldAtOnce + scenario.immediateLosses).padStart(13)}`
        + `  ${String(scenario.exposed).padStart(7)}`);
    }
  }
  console.log("");
  console.log("   BEST  = losses capped, and no winner ever dipped to its floor.");
  console.log("   WORST = losses capped, and EVERY winner whose floor is below its entry was stopped out.");
  console.log("   sells-at-once = floor at or above the entry: not a stop, it liquidates when armed.");
  console.log(`   actual P/L for comparison: ${usd(totalPnl)}`);
  console.log("");

  // ---------------------------------------------------------------------------------
  console.log("== 5. could the stop have executed? the gap band, measured against the losses");
  console.log("   A stop refuses any bid below tolerance x floor, snapped down to the cent grid.");
  console.log("   Widening the band widens the only window the stop can act in.\n");
  console.log("   mult  probFloor   gap    mean floor   mean gapFloor   mean window");
  for (const multiplier of MULTIPLIERS) {
    for (const probabilityFloor of PROBABILITY_FLOORS) {
      for (const tolerance of GAP_TOLERANCES) {
        const floors = [];
        const gapFloors = [];
        for (const trade of lost) {
          const { floor } = floorFor(trade, multiplier, probabilityFloor);
          if (floor == null) continue;
          floors.push(floor);
          gapFloors.push(stopGapFloorPrice(floor, tolerance) ?? 0);
        }
        if (!floors.length) continue;
        const mean = (list) => list.reduce((sum, value) => sum + value, 0) / list.length;
        const meanFloor = mean(floors);
        const meanGap = mean(gapFloors);
        console.log(`   ${String(multiplier).padStart(4)}  ${String(probabilityFloor).padStart(9)}`
          + `   ${String(tolerance).padStart(4)}   ${px(meanFloor)}       ${px(meanGap)}`
          + `        ${((meanFloor - meanGap) * 100).toFixed(1).padStart(5)}c`);
      }
    }
  }
  console.log("");

  // ---------------------------------------------------------------------------------
  console.log("== 6. what the floor costs the WINNERS");
  console.log("   sold-at-once is exact: the floor is at or above the entry, so the position is");
  console.log("   liquidated when armed and the win never happens. hair-trigger counts the ones");
  console.log("   whose floor is within a tenth of the entry -- ordinary movement reaches those,");
  console.log("   and how often is not measurable from a closed row.\n");
  console.log("   mult  probFloor   winners  sold-at-once  cost of that   hair-trigger  mean drop");
  for (const multiplier of MULTIPLIERS) {
    for (const probabilityFloor of PROBABILITY_FLOORS) {
      const scenario = evaluate(multiplier, probabilityFloor);
      let hairTrigger = 0;
      const drops = [];
      for (const trade of wonTrades) {
        const { floor } = floorFor(trade, multiplier, probabilityFloor);
        if (floor == null || trade.entry == null || floor >= trade.entry) continue;
        const drop = trade.entry - floor;
        drops.push(drop);
        if (drop < trade.entry * 0.1) hairTrigger += 1;
      }
      const mean = (list) => (list.length ? list.reduce((sum, value) => sum + value, 0) / list.length : null);
      const meanDrop = mean(drops);
      console.log(`   ${String(multiplier).padStart(4)}  ${String(probabilityFloor).padStart(9)}`
        + `   ${String(wonTrades.length).padStart(7)}  ${String(scenario.winnersSoldAtOnce).padStart(12)}`
        + `   ${usd(scenario.soldAtOnceDelta)}`
        + `   ${String(hairTrigger).padStart(12)}`
        + `  ${meanDrop == null ? "   - " : `${(meanDrop * 100).toFixed(1).padStart(5)}c`}`);
    }
  }
  console.log("");

  // ---------------------------------------------------------------------------------
  console.log("== 7. what the stop ACTUALLY did, in the rows' own words");
  console.log("   This is the decisive section. stopLossStatus is what the bot wrote down at the");
  console.log("   time: ARMED on a losing trade means the stop was watching and never fired,");
  console.log("   DECLINED_GAPPED means the gap band refused it, FILLED_AT_FLOOR means it worked.\n");
  const byStop = new Map();
  for (const trade of trades) {
    const key = `${String(trade.stopLossStatus || "(none)").padEnd(20)} status ${String(trade.status || "-").padEnd(12)}`;
    const row = byStop.get(key) || { count: 0, pnl: 0, buckets: new Map() };
    row.count += 1;
    row.pnl += trade.realizedPnl || 0;
    row.buckets.set(trade.bucket, (row.buckets.get(trade.bucket) || 0) + 1);
    byStop.set(key, row);
  }
  console.log("   stopLossStatus       trade status     n    total P/L   outcomes");
  for (const [key, row] of [...byStop].sort((a, b) => b[1].count - a[1].count)) {
    const outcomes = [...row.buckets].sort((a, b) => b[1] - a[1])
      .map(([bucket, count]) => `${bucket}:${count}`).join(" ");
    console.log(`   ${key} ${String(row.count).padStart(4)}   ${usd(row.pnl)}   ${outcomes}`);
  }

  // The bucket the whole question is about, named row by row: a full-stake loss whose stop
  // was armed and did not sell.
  const missed = trades.filter((trade) => trade.bucket === "lost-full"
    && ["ARMED", "DECLINED_GAPPED", "GAP_BEYOND_TARGET"].includes(String(trade.stopLossStatus || "").toUpperCase()));
  console.log(`\n   full-stake losses whose stop was armed and did not sell: ${missed.length}`
    + `  (${usd(missed.reduce((sum, trade) => sum + (trade.realizedPnl || 0), 0))})`);
  for (const trade of missed.slice(0, 16)) {
    console.log(`      ${clip(trade.question, 44)} ${clip(trade.outcome, 12)}`
      + ` entry ${px(trade.entry)} floor ${px(trade.stopLossPrice)}`
      + ` gapFloor ${px(trade.stopLossPrice == null ? null : stopGapFloorPrice(trade.stopLossPrice, GAP_TOLERANCES[0]))}`
      + ` P/L ${usd(trade.realizedPnl)}  ${trade.stopLossStatus}`);
  }
  // Open positions still carry live decline state, which is the freshest evidence of the
  // band refusing a stop -- a closed row has lost the book it was refused against.
  const openDeclined = (Array.isArray(live.positions) ? live.positions : [])
    .filter((row) => row?.stopDeclined || row?.declineKind || row?.exitReason === "stop-declined");
  if (openDeclined.length) {
    console.log(`\n   open positions currently declining to sell: ${openDeclined.length}`);
    for (const row of openDeclined.slice(0, 12)) {
      console.log(`      ${clip(row.question || row.market, 46)} ${clip(row.outcome, 14)}`
        + ` entry ${px(num(row.entryPrice))} now ${px(num(row.currentPrice))}`
        + ` kind ${row.declineKind || "-"} gapFloor ${row.gapFloor ?? "-"} worstBid ${row.worstBid ?? "-"}`);
    }
  }

  // Ranked on the WORST case, not the best: "at least as profitable" is a floor to clear,
  // and a setting whose downside is unknown has not cleared it. Only settings that liquidate
  // nothing on arming are eligible -- a floor above the entry is a different strategy, not a
  // better stop.
  const eligible = scenarios.filter((scenario) => scenario.unprotectable === 0
    && scenario.winnersSoldAtOnce === 0 && scenario.immediateLosses === 0);
  console.log("\n== 8. settings whose WORST case still beats doing nothing");
  const ranked = eligible.filter((scenario) => scenario.worst >= totalPnl)
    .sort((left, right) => right.worst - left.worst);
  if (!ranked.length) {
    console.log(`   none of the ${eligible.length} eligible setting(s) clears ${usd(totalPnl)}`
      + ` on its worst case; the best worst-case is`
      + ` ${usd(Math.max(...eligible.map((scenario) => scenario.worst)))}`);
  }
  for (const scenario of ranked.slice(0, 8)) {
    console.log(`   multiplier ${String(scenario.multiplier).padStart(4)}`
      + `  probability floor ${String(scenario.probabilityFloor).padStart(5)}`
      + `  ->  worst ${usd(scenario.worst)}  best ${usd(scenario.best)}`
      + `  (actual ${usd(totalPnl)}, ${scenario.exposed} winner(s) exposed)`);
  }

  // ---------------------------------------------------------------------------------
  console.log("\n== 9. by market shape: where a stop can work at all");
  console.log("   Every full-stake loss above whose stop was merely ARMED is a market that");
  console.log("   settles in one step -- an over/under, a draw-at-half, an exact score, a set or");
  console.log("   map leg. The price sits near the entry while the event runs and goes to 0 the");
  console.log("   instant a goal lands. There is no downward path for a stop to catch, at any");
  console.log("   setting, so this asks whether those markets pay for themselves.");
  console.log(`   Portfolio config carries excludedMarketShapes for exactly this: ${MARKET_SHAPE_IDS
    .filter((id) => id !== "outright").join(", ")}.\n`);
  const shapes = new Map();
  for (const trade of trades) {
    const shape = marketShape(trade);
    const row = shapes.get(shape) || {
      n: 0, pnl: 0, stake: 0, won: 0, lostFull: 0, lostFullPnl: 0,
      armedLost: 0, stopSold: 0, stopSoldPnl: 0,
    };
    row.n += 1;
    row.pnl += trade.realizedPnl || 0;
    row.stake += trade.cost || 0;
    if (trade.bucket === "won") row.won += 1;
    if (trade.bucket === "lost-full") {
      row.lostFull += 1;
      row.lostFullPnl += trade.realizedPnl || 0;
      if (String(trade.stopLossStatus || "").toUpperCase() === "ARMED") row.armedLost += 1;
    }
    if (["FILLED_AT_FLOOR", "FILLED_AFTER_GAP", "GAP_BEYOND_TARGET"].includes(String(trade.stopLossStatus || "").toUpperCase())) {
      row.stopSold += 1;
      row.stopSoldPnl += trade.realizedPnl || 0;
    }
    shapes.set(shape, row);
  }
  console.log("   shape            n   win%   total P/L   ROI     stop sold   full-stake   of those ARMED   full-stake P/L");
  for (const [shape, row] of [...shapes].sort((a, b) => a[1].pnl - b[1].pnl)) {
    console.log(`   ${clip(shape, 14)} ${String(row.n).padStart(3)}`
      + `  ${pct(row.n ? row.won / row.n : null)}`
      + `   ${usd(row.pnl)}   ${pct(row.stake > 0 ? row.pnl / row.stake : null)}`
      + `   ${String(row.stopSold).padStart(9)}   ${String(row.lostFull).padStart(10)}`
      + `   ${String(row.armedLost).padStart(14)}   ${usd(row.lostFullPnl)}`);
  }
  // The counterfactual that needs no price path at all: drop a shape and keep the rest.
  console.log("\n   dropping one shape and keeping every other trade exactly as it happened:");
  for (const [shape, row] of [...shapes].sort((a, b) => a[1].pnl - b[1].pnl)) {
    const without = totalPnl - row.pnl;
    const stakeWithout = totalStake - row.stake;
    console.log(`   without ${clip(shape, 14)} -> P/L ${usd(without)} on ${stakeWithout.toFixed(2).padStart(7)} staked`
      + `  = ${pct(stakeWithout > 0 ? without / stakeWithout : null)}`
      + `   (${row.lostFull} full-stake loss(es) removed, ${usd(-row.lostFullPnl)} of them)`);
  }
  console.log(`   keeping everything    -> P/L ${usd(totalPnl)} on ${totalStake.toFixed(2).padStart(7)} staked`
    + `  = ${pct(totalStake > 0 ? totalPnl / totalStake : null)}`);
}

// Guarded like the worker's, so importing this module to test marketShape does not fire a
// production read. Without it, checking the classifier against real question strings ran the
// whole report as a side effect.
const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
}
