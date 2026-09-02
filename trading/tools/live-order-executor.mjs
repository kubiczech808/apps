#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

function envNumber(name, fallback = null) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function optionalProbability(value) {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const normalized = numeric > 1 ? numeric / 100 : numeric;
  return normalized >= 0.01 && normalized <= 1 ? normalized : null;
}

function envTokenIdSet(name) {
  return new Set(String(process.env[name] || "")
    .split(",")
    .map((tokenId) => tokenId.trim())
    .filter((tokenId) => /^\d{8,100}$/.test(tokenId)));
}

function normalizePortfolioMarketType(value, legacyMultichoice = false) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["all", "binary", "multi"].includes(normalized)) return normalized;
  return legacyMultichoice ? "multi" : "all";
}

const PAPER_STATE_URL = process.env.PAPER_STATE_URL || "https://osobnizkusenosti.cz/trading/api.php?action=state&target=paper&summary=dashboard";
const PAPER_SCRAPED_STATE_URL = process.env.PAPER_SCRAPED_STATE_URL || "https://osobnizkusenosti.cz/trading/api.php?action=state&target=paper&summary=execution";
const LIVE_STATE_URL = process.env.LIVE_STATE_URL || "https://osobnizkusenosti.cz/trading/api.php?action=state&target=live";
const LIVE_EXECUTION_STATE_URL = process.env.LIVE_EXECUTION_STATE_URL || "https://osobnizkusenosti.cz/trading/api.php?action=state&target=live-execution";
const LIVE_ENTRY_CLAIM_URL = process.env.LIVE_ENTRY_CLAIM_URL || "https://osobnizkusenosti.cz/trading/api.php?action=live-entry-claim";
const TRADING_TRIGGER_KEY = process.env.TRADING_TRIGGER_KEY || "";
const GAMMA_API = process.env.POLYMARKET_GAMMA_API || "https://gamma-api.polymarket.com";
const CLOB_HOST = process.env.POLYMARKET_HOST || "https://clob.polymarket.com";
const CHAIN_ID = Number(process.env.POLYMARKET_CHAIN_ID || 137);
const MIN_PROBABILITY = envNumber("LIVE_MIN_PROBABILITY", envNumber("PAPER_MIN_PROBABILITY", 0.95));
const configuredMaxProbability = optionalProbability(process.env.LIVE_MAX_PROBABILITY);
const MAX_PROBABILITY = configuredMaxProbability != null && configuredMaxProbability >= MIN_PROBABILITY
  ? configuredMaxProbability
  : null;
const PORTFOLIO_MARKET_TYPE = normalizePortfolioMarketType(
  process.env.LIVE_MARKET_TYPE,
  String(process.env.LIVE_REQUIRE_MOST_PROBABLE || "").toLowerCase() === "true",
);
const EXCLUDE_OVER_UNDER_MARKETS = String(process.env.LIVE_EXCLUDE_OVER_UNDER_MARKETS || "").toLowerCase() === "true";
// The AI probability pipeline was retired, so scoring always uses the
// Polymarket outcome probability. LIVE_PROBABILITY_SOURCE is deliberately
// ignored: an older stored portfolio config must not resurrect "ai".
const PROBABILITY_SOURCE = "polymarket";
const MIN_ANNUAL_RETURN = envNumber("LIVE_MIN_ANNUAL_RETURN", envNumber("PAPER_MIN_ANNUAL_RETURN", 0.05));
// Use a conservative one-day floor for p.a. comparisons. A short-lived
// market can still be selected, but a few remaining minutes must not dominate
// every candidate solely through annualization.
// One hour, matching the paper bot and the UI. See the note there: a one-day floor
// flattened every same-day and live market to one potential p.a., so the shortlist
// could not rank a running event ahead of one later in the day.
const ONE_HOUR_IN_DAYS = 1 / 24;
const MIN_ANNUALIZATION_DAYS = Math.max(ONE_HOUR_IN_DAYS, envNumber("LIVE_MIN_ANNUALIZATION_DAYS", ONE_HOUR_IN_DAYS));
const OPPORTUNITY_MIN_PROBABILITY = envNumber("LIVE_OPPORTUNITY_MIN_PROBABILITY", envNumber("PAPER_OPPORTUNITY_MIN_PROBABILITY", 0.6));
const OPPORTUNITY_MIN_EDGE = envNumber("LIVE_OPPORTUNITY_MIN_EDGE", envNumber("PAPER_OPPORTUNITY_MIN_EDGE", 0.04));
const OPPORTUNITY_MIN_ANNUAL_RETURN = envNumber("LIVE_OPPORTUNITY_MIN_ANNUAL_RETURN", envNumber("PAPER_OPPORTUNITY_MIN_ANNUAL_RETURN", 0.3));
const MAX_SPREAD = envNumber("LIVE_MAX_SPREAD", envNumber("PAPER_MAX_SPREAD", 0.08));
const MIN_VOLUME_24H = envNumber("LIVE_CONFIG_MIN_LIQUIDITY_USDC", envNumber("LIVE_MIN_VOLUME_24H", envNumber("PAPER_MIN_VOLUME_24H", 100)));
const MIN_NET_YIELD = Math.max(0, envNumber("LIVE_MIN_NET_YIELD", 0));
const EFFECTIVELY_CERTAIN_MARKET_PROBABILITY = 0.9995;
const MANUAL_SHORTLIST_TOKEN_IDS = [...new Set(String(process.env.LIVE_EXECUTION_CANDIDATE_TOKEN_IDS || "")
  .split(",")
  .map((tokenId) => tokenId.trim())
  .filter((tokenId) => /^\d{8,100}$/.test(tokenId)))]
  .slice(0, 120);
const HAS_MANUAL_SHORTLIST = MANUAL_SHORTLIST_TOKEN_IDS.length > 0;
const EXCLUDED_CANDIDATE_TOKEN_IDS = envTokenIdSet("LIVE_EXCLUDED_CANDIDATE_TOKEN_IDS");
const MAX_ORDER_FRACTION = envNumber("MAX_ORDER_FRACTION", envNumber("LIVE_MAX_ORDER_FRACTION", 0.05));
const LIVE_STAKE_USDC = envNumber("LIVE_STAKE_USDC", envNumber("LIVE_FIXED_STAKE_USDC", NaN));
const MAX_ORDER_NOTIONAL_USDC = envNumber("MAX_ORDER_NOTIONAL_USDC", envNumber("LIVE_MAX_ORDER_NOTIONAL_USDC", Infinity));
const CANDIDATE_SCAN_LIMIT = envNumber("LIVE_CANDIDATE_SCAN_LIMIT", 120);
const REJECTED_CANDIDATE_LOG_LIMIT = envNumber("LIVE_REJECTED_CANDIDATE_LOG_LIMIT", 16);
const MAX_RESOLUTION_DAYS = envNumber("LIVE_MAX_RESOLUTION_DAYS", 7);
const SELECTION_ORDER = process.env.LIVE_SELECTION_ORDER === "highest_reward_risk_first" ? "highest_reward_risk_first" : "highest_ev_pa_first";
const ORDER_SIZE_MODE = String(process.env.LIVE_ORDER_SIZE_MODE || "stake_fraction").toLowerCase();
const USE_LIMIT_ORDERS = String(process.env.USE_LIMIT_ORDERS ?? "true").toLowerCase() !== "false";
const CROSS_PORTFOLIO_RISK_DIVERSIFICATION = String(process.env.LIVE_CROSS_PORTFOLIO_RISK_DIVERSIFICATION ?? "true").toLowerCase() !== "false";
const POST_ONLY = String(process.env.POLYMARKET_POST_ONLY ?? "true").toLowerCase() !== "false";
const DRY_RUN = String(process.env.POLYMARKET_DRY_RUN ?? "true").toLowerCase() !== "false";
const SIGNATURE_TYPE = Number(process.env.POLYMARKET_SIGNATURE_TYPE || 1);
const DEFAULT_FUNDER = "0x3252de913d9323667f21f4d88fa1f996fc282293";
const FUNDER_ADDRESS = process.env.POLYMARKET_FUNDER_ADDRESS || process.env.POLYMARKET_ADDRESS || DEFAULT_FUNDER;
const EXECUTION_STATE_PATH = process.env.LIVE_EXECUTION_STATE_PATH || "";
const IDLE_CASH_MAX_USDC = Number(process.env.LIVE_IDLE_CASH_MAX_USDC || 5);
const IDLE_CASH_GRACE_HOURS = Number(process.env.LIVE_IDLE_CASH_GRACE_HOURS || 24);
const SKIP_SCHEDULED_EXECUTION = String(process.env.LIVE_SKIP_SCHEDULED_EXECUTION || "").toLowerCase() === "true";
// Automation is a portfolio switch, not a workflow one: the schedule keeps firing so
// a manual run is always available, but an automatic run does nothing while it is off.
const AUTOMATION_ENABLED = String(process.env.LIVE_AUTOMATION_ENABLED ?? "true").toLowerCase() !== "false";
// Archiving is narrower than automation being off: it only stops resting new bids.
// Withdrawing an expired resting order and refreshing the account snapshot both run
// unconditionally above this flag, so an archived portfolio still keeps whatever it
// is already holding under watch -- archiving is "stop growing it", not "stop
// watching it". Only the fixed-entry (5050) batch reads this; the other live
// portfolio has no archive switch at all.
const ARCHIVED = String(process.env.LIVE_ARCHIVED ?? "false").toLowerCase() === "true";
// What starts an automatic run: this workflow's own cron, or the scan finishing.
const EXECUTION_TRIGGER = String(process.env.LIVE_EXECUTION_TRIGGER || "cron").toLowerCase() === "after_scrape"
  ? "after_scrape"
  : "cron";
// Cron execution has an explicit cadence, independent of how often the workflow is
// scheduled. An after-scrape portfolio is deliberately not held to this interval.
const EXECUTION_CRON_MINUTES = EXECUTION_TRIGGER === "after_scrape"
  ? 0
  : Math.max(30, envNumber("LIVE_EXECUTION_CRON_MINUTES", 60) || 60);
const IS_MANUAL_RUN = String(process.env.LIVE_RUN_SOURCE || "").toUpperCase() === "MANUAL";
// The "5050" portfolio. Instead of buying the single best candidate at the current
// market price, it rests a bid at a fixed point on the 0..1 scale across every
// candidate that clears its probability bar. Most never fill, and that is the
// design: the ones that do were bought far below what the market thought they were
// worth. It deliberately does not rotate and deliberately does not stop at the
// capital it has: the exchange's collateral is what actually bounds it.
const FIXED_ENTRY_STRATEGY = String(process.env.LIVE_STRATEGY || "").trim().toLowerCase() === "fixed_entry";
// The legacy Live strategy and each user-created live strategy share a wallet but
// never a decision log. The workflow supplies this stable owner id for custom runs.
const LIVE_PORTFOLIO_ID = process.env.LIVE_PORTFOLIO_ID || (FIXED_ENTRY_STRATEGY ? "live-5050" : "live");
const FIXED_ENTRY_PRICE = envNumber("LIVE_FIXED_ENTRY_PRICE", 0.5);
const FIXED_ENTRY_STAKE_USDC = Math.max(0, envNumber("LIVE_FIXED_ENTRY_STAKE_USDC", 0) || 0);
// Resting a bid is one sequential round trip to the exchange, measured at roughly four
// seconds each on the runner, so a batch of fifty spent over three minutes in that loop
// alone. The pass is bounded instead: bids are placed best-first until the budget is
// spent, and the remainder waits for the next run rather than stretching this one -- it
// is the same candidate set, so nothing is lost, only deferred. Zero disables the bound.
// Timed from the start of the placement loop, which is the only part that grows with the
// number of events; the setup around it is fixed cost.
const FIXED_ENTRY_BUDGET_MS = Math.max(0, envNumber("LIVE_FIXED_ENTRY_BUDGET_MS", 40000) || 0);
function envTagSet(name) {
  return new Set(
    String(process.env[name] || "")
      .split(/[,\s]+/)
      .map((tag) => tag.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, ""))
      .filter(Boolean),
  );
}

// Which Polymarket tags this strategy may bid on. Empty means every tag, so the setting
// can be cleared and not only narrowed.
const FIXED_ENTRY_ALLOWED_TAGS = envTagSet("LIVE_FIXED_ENTRY_ALLOWED_TAGS");
// Whole tags this portfolio refuses, whatever else a market carrying one has going for
// it. Unlike the allow-list above this is a setting of every portfolio, so it is applied
// in the shared prefilter and both live strategies inherit it. Empty excludes nothing,
// which is also what an unset variable means -- so no special case is needed to clear it.
const EXCLUDED_MARKET_TAGS = envTagSet("LIVE_EXCLUDED_MARKET_TAGS");
// A populated whitelist overrides exclusions. Its entries remain in the saved config
// when inactive so clearing this list restores the prior exclusion policy.
const INCLUDE_ONLY_MARKET_TAGS = envTagSet("LIVE_INCLUDE_ONLY_MARKET_TAGS");
const FIXED_ENTRY_PROGRESS_EVERY = Math.max(1, envNumber("LIVE_FIXED_ENTRY_PROGRESS_EVERY", 5) || 5);
const OPEN_ORDER_REVIEW_AFTER_HOURS = envNumber("LIVE_OPEN_ORDER_REVIEW_AFTER_HOURS", 2);
const OPEN_ORDER_CANCEL_AFTER_HOURS = envNumber("LIVE_OPEN_ORDER_CANCEL_AFTER_HOURS", 8);
const OPEN_ORDER_REPRICE_THRESHOLD = envNumber("LIVE_OPEN_ORDER_REPRICE_THRESHOLD", 0.015);
const OPEN_ORDER_BETTER_CANDIDATE_EV_USDC = envNumber("LIVE_OPEN_ORDER_BETTER_CANDIDATE_EV_USDC", 0.02);
// A rotation exit is a FAK taker order: it fills against the bid at once or is killed.
// Anything still resting after this long never filled, and it reserves the position's
// shares while it sits there, so it is cancelled and re-closed at the current bid rather
// than waited on. Deliberately short -- there is nothing to wait for.
const ROTATION_EXIT_STALE_MINUTES = envNumber("LIVE_ROTATION_EXIT_STALE_MINUTES", 2);
const ROTATION_CANDIDATE_SCAN_LIMIT = envNumber("LIVE_ROTATION_CANDIDATE_SCAN_LIMIT", 10);
// A runaway guard, not a selection rule. The real bound is "worth rotating out
// of at all"; a low cap here silently decided how many holdings got looked at.
const ROTATION_POSITION_SCAN_LIMIT = envNumber("LIVE_ROTATION_POSITION_SCAN_LIMIT", 25);
// A rotation must improve the configured portfolio metric by at least the
// portfolio's minimum net profit. This keeps the exit fee and required return
// threshold in one place instead of using an unrelated dollar EV margin.
const ROTATION_MIN_PRIORITY_IMPROVEMENT = Math.max(
  MIN_NET_YIELD,
  envNumber("LIVE_ROTATION_MIN_PRIORITY_IMPROVEMENT", MIN_NET_YIELD),
);
// Potential p.a. can become enormous close to resolution while representing only a
// few cents. It must never justify realizing a larger dollar loss. Every rotation
// therefore has to improve the best possible net P/L as well: the replacement's
// after-fee win must cover the exit loss, preserve the current position's maximum
// win, and add this minimum dollar margin. The configured minimum net yield is also
// applied to the capital at risk, so larger positions require a proportionally
// larger improvement.
const ROTATION_MIN_NET_PNL_IMPROVEMENT_USDC = Math.max(
  0,
  envNumber("LIVE_ROTATION_MIN_NET_PNL_IMPROVEMENT_USDC", 0.05),
);
// Once a position is past its end date it is waiting on settlement, and its ranking
// metric is meaningless there: the horizon is gone while the upside is not. If it
// still has more than this much left to collect, it is protected from rotation and
// simply held until it settles, however much better a candidate looks. Once the
// remaining gain falls to this much or less there is nothing worth waiting for, so
// the capital is released rather than parked until settlement.
const ROTATION_PROTECT_REMAINING_GAIN_USDC = Math.max(
  0,
  envNumber("LIVE_ROTATION_PROTECT_REMAINING_GAIN_USDC", 0.02),
);
// Kept for reporting only: how close the current sell P/L already is to the maximum
// win, as an absolute amount and as a fraction of cost.
const ROTATION_NEAR_MAX_WIN_GAP = Math.max(
  0,
  envNumber("LIVE_ROTATION_NEAR_MAX_WIN_GAP", 0.01),
);
// The exchange minimum is a market property, not a fixed dollar amount: `mos` shares
// cost price * mos, so 5 shares are $4.95 at 0.99 but $2.50 at 0.50. When the
// portfolio percentage lands below that, the stake is raised to exactly the market's
// minimum rather than refusing to trade. This ceiling stops an unusual `mos` from
// dragging the stake somewhere the portfolio never agreed to.
const MIN_ORDER_STAKE_CEILING_USDC = Math.max(0, envNumber("LIVE_MIN_ORDER_STAKE_CEILING_USDC", 10));
const ROTATION_TIE_EPSILON = 0.000001;
const LIVE_AUTO_ROTATE = String(process.env.LIVE_AUTO_ROTATE ?? "true").toLowerCase() !== "false";
const OPEN_STATUSES = new Set(["OPEN", "PENDING_RESOLUTION", "MARKET_NOT_FOUND", "ORDER_STATUS_LIVE", "LIVE"]);
// A rotation is two executor passes in one workflow run: the first sells, the
// second buys the replacement. Set on that second pass so both legs are recorded
// as the single rotation they are, instead of two rows where the sell is the one
// that gets dropped.
const ROTATION_COMPLETION_RUN = String(process.env.LIVE_ROTATION_COMPLETION || "").toLowerCase() === "true";
const ROTATION_EXIT_ACTIONS = new Set(["ROTATION_EXIT_SUBMITTED", "ROTATION_EXIT_REPRICED", "DRY_RUN_ROTATION_EXIT"]);

// A rotation's sell leg is submitted FAK and fills unconditionally. Its buy leg was a
// post-only limit resting at the bid, which made the swap certain on one side and
// optional on the other: the position was sold for sure, and the replacement bought only
// if someone happened to cross to us.
//
// Reported case: a holding with 0.2174 USDC of remaining upside was sold to buy a market
// resolving in fourteen minutes. The bid never filled, the market resolved, and the run
// banked 0.01 USDC instead of either outcome it was choosing between. A rotation that
// completes only one leg is strictly worse than not rotating at all, so the entry crosses
// the spread on a completion run -- paying the spread and the taker fee is the price of
// the swap actually happening, and it is charged in the economics below rather than
// assumed away.
const ROTATION_TAKER_ENTRY = String(process.env.LIVE_ROTATION_TAKER_ENTRY ?? "true").toLowerCase() !== "false";
const ROTATION_ENTRY_CROSSES_SPREAD = ROTATION_COMPLETION_RUN && ROTATION_TAKER_ENTRY;
let previousExecutionState = null;

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function number(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function annualizationDays(value) {
  const days = number(value);
  if (days == null) return null;
  return Math.max(MIN_ANNUALIZATION_DAYS, days);
}

function annualizeReturn(value, days) {
  const numeric = number(value);
  if (numeric == null) return null;
  const horizon = annualizationDays(days);
  return horizon == null ? numeric : numeric * (365 / horizon);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function parseJsonField(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value !== "") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

async function fetchJson(url, label = url) {
  const response = await fetch(url, {
    headers: { "User-Agent": "osobnizkusenosti-live-order-executor" },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${label} HTTP ${response.status}${body ? `: ${body.slice(0, 180)}` : ""}`);
  }
  return response.json();
}

// The order book and the public account snapshot are both eventually consistent. A
// successful CLOB BUY can be invisible to a second runner long enough for it to sign
// the very same order. The host keeps the atomic, wallet-wide claim; failing to reach
// it must block a live BUY rather than turn a transient hosting error into exposure.
async function liveEntryClaimRequest(operation, order, claimId) {
  if (!TRADING_TRIGGER_KEY) throw new Error("live entry guard is not configured");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(LIVE_ENTRY_CLAIM_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-trading-trigger-key": TRADING_TRIGGER_KEY,
        "user-agent": "osobnizkusenosti-live-order-executor",
      },
      body: JSON.stringify({
        operation,
        tokenId: String(order.tokenId || ""),
        side: "BUY",
        portfolioId: LIVE_PORTFOLIO_ID,
        claimId,
      }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      throw new Error(payload?.error || `live entry guard HTTP ${response.status}`);
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

function definitelyRejectedOrderResponse(response) {
  if (!response || successfulOrderResponse(response)) return false;
  const status = String(response.status || "").toLowerCase();
  if (status === "exception" || /timeout|network|fetch|socket|econn|abort/i.test(orderResponseError(response))) return false;
  return true;
}

async function submitLiveEntryWithMakerPrecisionRecovery(order) {
  if (String(order.side || "BUY").toUpperCase() === "SELL") {
    return submitOrderWithMakerPrecisionRecovery(order);
  }
  const claimId = randomUUID();
  const claim = await liveEntryClaimRequest("claim", order, claimId);
  if (claim.claimed !== true) {
    const response = {
      status: "duplicate_guard",
      success: false,
      error: claim.reason || "A live BUY for this outcome was already submitted or is awaiting confirmation.",
    };
    return { order, response, attempts: [{ order, response, precisionRecovery: false }], entryClaim: claim };
  }
  const submission = await submitOrderWithMakerPrecisionRecovery(order);
  if (successfulOrderResponse(submission.response)) {
    try {
      await liveEntryClaimRequest("confirm", submission.order, claimId);
    } catch (error) {
      // The claim remains held after a successful CLOB order. That is intentional:
      // confirmation is bookkeeping, whereas releasing it after an uncertain result
      // would re-open the exact duplication window this guard closes.
      console.warn(`live entry guard confirmation deferred: ${error?.message || String(error)}`);
    }
  } else if (definitelyRejectedOrderResponse(submission.response)) {
    try {
      await liveEntryClaimRequest("release", submission.order, claimId);
    } catch (error) {
      console.warn(`live entry guard release deferred: ${error?.message || String(error)}`);
    }
  }
  return { ...submission, entryClaim: claim };
}

async function loadJsonResource(location, label = location) {
  const source = String(location || "");
  if (/^https?:\/\//i.test(source)) {
    return fetchJson(`${source}${source.includes("?") ? "&" : "?"}t=${Date.now()}`, label);
  }
  const path = source.startsWith("file://") ? new URL(source) : source;
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw);
}

// The execution endpoint serves the catalogue one page at a time: decoding the whole
// thing into a single response is what used to exhaust the hosting memory limit. One page
// is not the catalogue, though. Measured on production: 4998 rows in scope, 1200 served,
// truncated -- and 4749 of the active markets resolve inside the two days this portfolio
// trades, of which only 1170 arrived. The rest were not rejected by any rule, they simply
// never reached the run. Walking the pages keeps each response the same size the host can
// afford while the shortlist is chosen from the entire scope.
const EXECUTION_SCOPE_MAX_PAGES = Math.max(1, envNumber("LIVE_EXECUTION_SCOPE_MAX_PAGES", 6));

async function loadScopedExecutionCatalogue(location, label = location, fetchPage = loadJsonResource) {
  const first = await fetchPage(location, label);
  const source = String(location || "");
  if (!/^https?:\/\//i.test(source)) return first;
  const limit = Number(first?.executionScopeLimit);
  // An endpoint with no page width is one that has not been redeployed yet, and it would
  // ignore an offset and hand back this same page again. Take what it gave rather than
  // concatenating the first page to itself.
  if (!Number.isFinite(limit) || limit <= 0) return first;
  const rows = Array.isArray(first?.marketObservations) ? [...first.marketObservations] : [];
  let truncated = first?.executionScopeTruncated === true;
  let offset = Number(first?.executionScopeOffset) || 0;
  let pages = 1;
  while (truncated && pages < EXECUTION_SCOPE_MAX_PAGES) {
    const wanted = offset + limit;
    const page = await fetchPage(
      `${source}${source.includes("?") ? "&" : "?"}offset=${wanted}`,
      `${label} page ${pages + 1}`,
    );
    const pageRows = Array.isArray(page?.marketObservations) ? page.marketObservations : [];
    // A page that came back empty, or from an offset other than the one asked for, means
    // the walk is not advancing. Stop instead of looping on the same rows.
    if (!pageRows.length || Number(page?.executionScopeOffset) !== wanted) break;
    rows.push(...pageRows);
    truncated = page?.executionScopeTruncated === true;
    offset = wanted;
    pages += 1;
  }
  return {
    ...first,
    marketObservations: rows,
    executionScopePagesLoaded: pages,
    executionScopeTruncated: truncated,
  };
}

async function loadOptionalJsonResource(location, label = location) {
  try {
    return await loadJsonResource(location, label);
  } catch {
    return null;
  }
}

function hoursSince(value, now = new Date()) {
  const time = Date.parse(value || "");
  if (!Number.isFinite(time)) return null;
  return Math.max(0, (now.getTime() - time) / 3600000);
}

function probabilitySourceLabel() {
  return PROBABILITY_SOURCE === "polymarket" ? "Polymarket probability" : "AI probability";
}

function selectedProbability(item) {
  return number(PROBABILITY_SOURCE === "polymarket" ? (item?.marketProbability ?? item?.marketPrice) : item?.aiProbability);
}

function selectedExpectedValue(item) {
  return number(PROBABILITY_SOURCE === "polymarket" ? item?.netGainIfWinUsdc : item?.expectedValueUsdc);
}

function selectedAnnualizedReturn(item) {
  if (PROBABILITY_SOURCE !== "polymarket") return number(item?.annualizedReturn);
  const gain = number(item?.netGainIfWinUsdc);
  const cost = number(item?.totalCostUsdc ?? item?.stakeUsdc);
  const days = localDaysToResolution(item);
  if (gain == null || cost == null || cost <= 0) return null;
  const netYield = gain / cost;
  return annualizeReturn(netYield, days);
}

// The scheduled/end date from Gamma is not a tradeability signal. Use a return
// measured directly from the current entry economics for filtering and ranking;
// the annualized figure remains display-only context.
function selectedReturnYield(item) {
  if (PROBABILITY_SOURCE === "polymarket") return netYieldAfterFees(item);
  const expectedValue = number(item?.expectedValueUsdc);
  const cost = number(item?.totalCostUsdc ?? item?.stakeUsdc);
  return expectedValue != null && cost != null && cost > 0 ? expectedValue / cost : null;
}

function returnMetricLabel() {
  return PROBABILITY_SOURCE === "polymarket" ? "Potential p.a." : "EV p.a.";
}

function hasOpenSellOrderForToken(liveState, tokenId) {
  const target = String(tokenId || "");
  return (Array.isArray(liveState?.openOrders) ? liveState.openOrders : []).some((order) => {
    const orderToken = String(order.tokenId || order.assetId || "");
    return orderToken === target && String(order.side || "").toUpperCase().includes("SELL");
  });
}

function liveCashMonitoring(previousExecution, cash, now = new Date()) {
  const previousMonitoring = previousExecution?.monitoring || {};
  const previousCash = number(
    previousExecution?.account?.availableCashUsdc
    ?? previousExecution?.account?.cashUsdc,
  );
  const cashAboveLimit = Number.isFinite(cash) && cash > IDLE_CASH_MAX_USDC;
  const idleCashSince = cashAboveLimit
    ? (previousCash != null && previousCash > IDLE_CASH_MAX_USDC ? previousMonitoring.idleCashSince : null) || now.toISOString()
    : null;
  const idleHours = idleCashSince ? hoursSince(idleCashSince, now) : 0;
  return {
    idleCashLimitUsdc: IDLE_CASH_MAX_USDC,
    idleCashGraceHours: IDLE_CASH_GRACE_HOURS,
    cashAboveIdleLimit: cashAboveLimit,
    idleCashSince,
    idleCashHours: idleHours == null ? null : Number(idleHours.toFixed(2)),
    idleCashOverdue: cashAboveLimit && Number(idleHours || 0) >= IDLE_CASH_GRACE_HOURS,
  };
}

function apiUrl(base, path, params = {}) {
  const url = new URL(path, base);
  Object.entries(params).forEach(([key, value]) => {
    if (value != null && value !== "") url.searchParams.set(key, String(value));
  });
  return url;
}

function normalizedSlug(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function eventSlugKey(slug) {
  const text = normalizedSlug(slug);
  const dated = text.match(/^(.+?-\d{4}-\d{2}-\d{2})(?:-|$)/);
  return dated ? dated[1] : "";
}

function tagQuestion(question) {
  const text = String(question || "").toLowerCase();
  const tags = [];
  if (/\b(bitcoin|btc|ethereum|eth|crypto|solana|xrp)\b/.test(text)) tags.push("crypto");
  if (/\b(fed|rate|inflation|cpi|jobs|unemployment|gdp)\b/.test(text)) tags.push("macro");
  if (/\b(election|president|senate|congress|minister|vote|referendum)\b/.test(text)) tags.push("politics");
  if (/\b(nba|nfl|mlb|nhl|ufc|world cup|champions|match|game|tournament)\b/.test(text)) tags.push("sports");
  if (/\b(will|by|before|on|in 2026|in 2027)\b/.test(text)) tags.push("clear-resolution");
  return tags.length ? tags : ["general"];
}

function cleanTeamName(value) {
  let text = String(value || "")
    .replace(/\b(the|a|an)\b/gi, " ")
    .replace(/\b(on|in|at|by|before|after)\b.*$/i, " ")
    .replace(/\b(to advance|advance|win|wins|winner|draw|end|team)\b.*$/i, " ")
    .replace(/\s+/g, " ")
    .trim();
  text = text.replace(/^will\s+/i, "").replace(/[?:,]+$/g, "").trim();
  return text;
}

function addTeam(teams, value) {
  const cleaned = cleanTeamName(value);
  const key = normalizedSlug(cleaned).replace(/-/g, " ");
  if (!key || key.length < 2 || /^(yes|no|over|under|draw|other|none)$/.test(key)) return;
  teams.set(key, cleaned.replace(/\b\w/g, (char) => char.toUpperCase()));
}

function extractTeams(question) {
  const text = String(question || "");
  const teams = new Map();
  const exact = text.match(/^Exact Score:\s*(.+?)\s+\d+\s*-\s*\d+\s*(.+?)\?/i);
  if (exact) {
    addTeam(teams, exact[1]);
    addTeam(teams, exact[2]);
  }
  const versus = text.match(/^(.+?)\s+vs\.?\s+(.+?)(?::|\s+end\b|\s+go\b|\s+O\/U\b|\?|$)/i);
  if (versus) {
    addTeam(teams, versus[1]);
    addTeam(teams, versus[2]);
  }
  const spread = text.match(/^Spread:\s*(.+?)\s*\(/i);
  if (spread) addTeam(teams, spread[1]);
  const winner = text.match(/^Will\s+(.+?)\s+win(?:\s+on\b|\s+the\b|\?|$)/i);
  if (winner && !/\bvs\.?\b/i.test(winner[1])) addTeam(teams, winner[1]);
  return teams;
}

function topicRiskClusters({ question, slug, eventSlug }) {
  const text = normalizedSlug(`${question || ""} ${slug || ""} ${eventSlug || ""}`).replace(/-/g, " ");
  const clusters = [];
  const cryptoAssets = [
    { key: "bitcoin", label: "Bitcoin", pattern: /\b(bitcoin|btc)\b/ },
    { key: "ethereum", label: "Ethereum", pattern: /\b(ethereum|ether|eth)\b/ },
    { key: "solana", label: "Solana", pattern: /\bsolana\b/ },
    { key: "xrp", label: "XRP", pattern: /\b(xrp|ripple)\b/ },
  ];
  for (const asset of cryptoAssets) {
    if (asset.pattern.test(text)) {
      clusters.push([`topic:${asset.key}`, `Topic: ${asset.label}`]);
    }
  }
  if (/\b(iran|iranian|hormuz|kharg|strait of hormuz|israel|israeli|tehran|nuclear)\b/.test(text)) {
    clusters.push(["topic:iran-war", "Topic: Iran war / Gulf escalation"]);
  }
  if (/\b(fed|federal reserve|interest rates?|rate cut|rate hike|bps|fomc)\b/.test(text)) {
    const month = text.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/)?.[1] || "meeting";
    const year = text.match(/\b(20\d{2})\b/)?.[1] || "";
    clusters.push([`topic:fed-${month}${year ? `-${year}` : ""}`, `Topic: Fed ${month}${year ? ` ${year}` : ""} meeting`]);
  }
  return clusters;
}

function riskProfile({ question, slug, eventSlug, outcome, tags }) {
  const keys = new Set();
  const labels = new Map();
  const addKey = (key, label) => {
    if (!key) return;
    keys.add(key);
    if (label) labels.set(key, label);
  };
  const marketSlug = normalizedSlug(slug);
  if (marketSlug) addKey(`market:${marketSlug}`, `Market: ${marketSlug}`);
  const normalizedEventSlug = normalizedSlug(eventSlug);
  if (normalizedEventSlug) addKey(`event:${normalizedEventSlug}`, `Event: ${normalizedEventSlug}`);
  const eventKey = eventSlugKey(eventSlug || slug);
  if (eventKey) addKey(`event:${eventKey}`, `Event: ${eventKey}`);
  for (const [key, label] of topicRiskClusters({ question, slug, eventSlug })) addKey(key, label);
  const teams = extractTeams(question);
  for (const [teamKey, label] of teams) addKey(`team:${teamKey}`, `Team: ${label}`);
  if (teams.size >= 2) {
    const pair = [...teams.keys()].sort().join("-vs-");
    const pairLabel = [...teams.values()].sort().join(" vs ");
    addKey(`match:${pair}`, `Match: ${pairLabel}`);
  }
  const tagList = Array.isArray(tags) ? tags : tagQuestion(question);
  return {
    keys: [...keys],
    labels: [...keys].map((key) => labels.get(key) || key),
    category: tagList.includes("sports") ? "sports" : tagList[0] || "general",
    primaryEntity: [...teams.values()][0] || String(outcome || ""),
  };
}

function inferredEndDateFromQuestion(question, fallbackDate = null) {
  const match = String(question || "").match(/\b(?:by|on|before|through)\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:,\s*(\d{4}))?/i);
  if (!match) return null;
  const months = {
    january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
    july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  };
  const fallback = new Date(fallbackDate || Date.now());
  const year = Number(match[3]) || (Number.isFinite(fallback.getTime()) ? fallback.getUTCFullYear() : new Date().getUTCFullYear());
  const inferred = new Date(Date.UTC(year, months[match[1].toLowerCase()], Number(match[2]), 23, 59, 59));
  return Number.isFinite(inferred.getTime()) ? inferred.toISOString() : null;
}

function correctedEndDate(question, rawEndDate, fallbackDate = null) {
  const inferred = inferredEndDateFromQuestion(question, rawEndDate || fallbackDate);
  if (!inferred) return rawEndDate || null;
  const rawTime = Date.parse(rawEndDate || "");
  const inferredTime = Date.parse(inferred);
  if (!Number.isFinite(rawTime) || inferredTime > rawTime) return inferred;
  return rawEndDate || inferred;
}

const SPORTS_MARKET_HINT = /\b(atp|wta|nba|nfl|mlb|nhl|ufc|fifa|world[- ]cup|soccer|football|tennis|baseball|basketball|hockey|esports|e[- ]?sports|lol|match|game|tournament|spread|moneyline|winner)\b/i;

function isSportsMarket(market = {}) {
  const events = Array.isArray(market.events) ? market.events : [];
  const text = [
    market.slug,
    market.eventSlug,
    market.question,
    market.category,
    market.categorySlug,
    market.sportsMarketType,
    market.marketType,
    market.tags,
    ...events.flatMap((event) => [event?.slug, event?.title, event?.category, event?.categorySlug, event?.tags]),
  ].filter(Boolean).join(" ");
  return Boolean(
    market.gameStartTime
    || market.eventStartTime
    || market.gameId
    || market.sportsMarketType
    || market.teamAID
    || market.teamBID
    || SPORTS_MARKET_HINT.test(text),
  );
}

function parseSportsDate(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const dateOnly = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    const date = new Date(Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]), 23, 59, 59));
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  const time = Date.parse(text);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function sportsDateFromSlug(value) {
  const match = String(value || "").match(/(?:^|[-_])((?:19|20)\d{2})-(\d{2})-(\d{2})(?:$|[-_])/);
  if (!match) return null;
  return parseSportsDate(`${match[1]}-${match[2]}-${match[3]}`);
}

function sportsScheduledEventDate(market = {}) {
  if (!isSportsMarket(market)) return null;
  const events = Array.isArray(market.events) ? market.events : [];
  const candidates = [
    market.gameStartTime,
    market.eventStartTime,
    ...events.flatMap((event) => [event?.gameStartTime, event?.eventStartTime, event?.startDateIso, event?.startDate]),
  ];
  for (const candidate of candidates) {
    const parsed = parseSportsDate(candidate);
    if (parsed) return parsed;
  }
  return sportsDateFromSlug(market.slug) || sportsDateFromSlug(market.eventSlug) || sportsDateFromSlug(events.find((event) => event?.slug)?.slug) || null;
}

function marketDateContext(market = {}, fallbackDate = null) {
  const rawResolutionEndDate = market.resolutionEndDate || market.endDate || null;
  const resolutionEndDate = correctedEndDate(market.question || "", rawResolutionEndDate, fallbackDate);
  const scheduledEventDate = sportsScheduledEventDate(market);
  const scheduledTime = Date.parse(scheduledEventDate || "");
  const resolutionTime = Date.parse(resolutionEndDate || "");
  const useScheduledDate = Boolean(scheduledEventDate)
    && (!Number.isFinite(resolutionTime) || (Number.isFinite(scheduledTime) && scheduledTime < resolutionTime));
  return {
    endDate: useScheduledDate ? scheduledEventDate : resolutionEndDate,
    scheduledEventDate: scheduledEventDate || null,
    resolutionEndDate: resolutionEndDate || null,
    endDateSource: useScheduledDate ? "sports-event-start" : "polymarket-resolution-window",
    sportsEventStarted: useScheduledDate && Number.isFinite(scheduledTime) && scheduledTime <= Date.now(),
  };
}

// Signed: a market whose end date has passed is overdue, not a day from resolving. The
// one-day floor that used to live here was reported as the row's days-left, so an expired
// market presented a full day of runway. Every annualization downstream applies its own
// MIN_ANNUALIZATION_DAYS floor, so the returns this feeds are unchanged.
function daysToEnd(endDate) {
  const end = Date.parse(endDate || "");
  if (!Number.isFinite(end)) return null;
  return (end - Date.now()) / 86400000;
}

// A terminal market state comes from Polymarket, never from Gamma's scheduled date.
// A missing book or a price at certainty without that state can be transient, so it is
// rejected for this pass but remains eligible for a later fresh revalidation.
function finishedAwaitingResolutionRejection({ marketClosed, acceptingOrders, price, marketProbability } = {}) {
  if (marketClosed !== true && acceptingOrders !== false) return null;
  const numericPrice = Number(price);
  if (!Number.isFinite(numericPrice) || numericPrice <= 0 || numericPrice >= 1) {
    return "Polymarket reports this market is closed or no longer accepting orders;"
      + " its order book no longer quotes an executable price, so no order could be placed";
  }
  const numericProbability = Number(marketProbability);
  if (Number.isFinite(numericProbability) && numericProbability >= EFFECTIVELY_CERTAIN_MARKET_PROBABILITY) {
    return "Polymarket reports this market is closed or no longer accepting orders;"
      + ` its price has settled at ${(numericProbability * 100).toFixed(1)}% with no executable upside left,`
      + " so no order could be placed";
  }
  return null;
}

function bestBook(book) {
  const bids = Array.isArray(book.bids) ? book.bids : [];
  const asks = Array.isArray(book.asks) ? book.asks : [];
  const bidPrices = bids.map((level) => Number(level.price)).filter(Number.isFinite);
  const askPrices = asks.map((level) => Number(level.price)).filter(Number.isFinite);
  return {
    bestBid: bidPrices.length ? Math.max(...bidPrices) : null,
    bestAsk: askPrices.length ? Math.min(...askPrices) : null,
    spread: bidPrices.length && askPrices.length ? Math.max(0, Math.min(...askPrices) - Math.max(...bidPrices)) : null,
  };
}

function validProbability(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 && numeric < 1 ? numeric : null;
}

function marketProbabilityForToken(market, tokenIndex, book = {}, fallback = null) {
  const prices = parseJsonField(market?.outcomePrices);
  const fromGamma = validProbability(prices[tokenIndex]);
  if (fromGamma != null) return fromGamma;
  if (book.bestBid != null && book.bestAsk != null) {
    const midpoint = validProbability((Number(book.bestBid) + Number(book.bestAsk)) / 2);
    if (midpoint != null) return midpoint;
  }
  return validProbability(fallback);
}

function hasStaleBinarySideQuote(item) {
  const hasBinaryMetadata = Boolean(item?.binaryYesTokenId || item?.binaryNoTokenId)
    || (validProbability(item?.binaryYesMarketProbability) != null && validProbability(item?.binaryNoMarketProbability) != null);
  if (!hasBinaryMetadata) return false;
  const entry = validProbability(item.marketPrice);
  const selectedMarketProbability = validProbability(item.marketProbability);
  // A large mismatch immediately after a recorded side flip means the row
  // still combines one token's entry price with the opposite token's outcome.
  return entry != null && selectedMarketProbability != null && Math.abs(entry - selectedMarketProbability) >= 0.1;
}

function roundToTick(value, tick, direction = "nearest") {
  const scale = Math.round(1 / tick);
  if (!Number.isFinite(scale) || scale <= 0) return Number(value.toFixed(4));
  const raw = value * scale;
  const rounded = direction === "down" ? Math.floor(raw) : direction === "up" ? Math.ceil(raw) : Math.round(raw);
  return Number((rounded / scale).toFixed(String(tick).split(".")[1]?.length || 4));
}

function feeRateForEvaluation(evaluation) {
  const value = Number(evaluation.feeRate);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function takerFee(shares, price, feeRate) {
  if (!Number.isFinite(feeRate) || feeRate <= 0) return 0;
  return Number((shares * feeRate * price * (1 - price)).toFixed(5));
}

function marketEventSlug(market) {
  const events = Array.isArray(market.events) ? market.events : [];
  return events.find((event) => event?.slug)?.slug || market.eventSlug || market.slug || "";
}

function latestUniqueEvaluations(evaluations, limit = Infinity) {
  const byToken = new Map();
  const ordered = [...evaluations].sort((a, b) => candidateEvaluatedAtTime(b) - candidateEvaluatedAtTime(a));
  for (const item of ordered) {
    const tokenId = String(item.tokenId || "");
    if (!tokenId || byToken.has(tokenId)) continue;
    byToken.set(tokenId, item);
    if (byToken.size >= limit) break;
  }
  return [...byToken.values()];
}

// Time remaining right now, not the time that remained when the row was scraped.
//
// This used to return the stored daysToResolution whenever it existed, and that value is
// captured at scrape time. A market stored with 1.00 day left and executed twelve hours
// later still reported 1.00 day, so its potential p.a. was annualized over twice the real
// horizon and came out at half its true value. The error grows with the age of the row,
// so ranking systematically favoured freshly scraped candidates and disagreed with the
// dashboard, which recomputes from endDate. That is the inconsistency between the
// shortlist shown and the order actually placed.
//
// The stored value is only a fallback for a row whose end date is unusable.
function localDaysToResolution(item) {
  const end = Date.parse(item?.endDate || item?.resolutionEndDate || "");
  if (Number.isFinite(end)) return (end - Date.now()) / 86400000;
  const stored = number(item?.daysToResolution);
  return stored != null ? stored : Infinity;
}

function candidateEvaluatedAtTime(item) {
  return Date.parse(item?.evaluatedAt || item?.lastSeenAt || item?.observedAt || item?.marketDataUpdatedAt || item?.firstEvaluatedAt || "") || 0;
}

function netYieldAfterFees(item = {}) {
  const stored = number(item.netYield);
  if (stored != null) return stored;
  const gain = number(item.netGainIfWinUsdc);
  const cost = number(item.totalCostUsdc ?? item.stakeUsdc);
  if (gain == null || cost == null || cost <= 0) return null;
  return gain / cost;
}

function marketProbabilityRoundsToCertain(item = {}) {
  const marketProbability = number(item.marketProbability ?? item.marketPrice);
  return marketProbability != null && marketProbability >= EFFECTIVELY_CERTAIN_MARKET_PROBABILITY;
}

function binaryOutcomeQuotesAreBothZero(item = {}) {
  const hasBinaryMetadata = Boolean(item?.binaryYesTokenId || item?.binaryNoTokenId)
    || String(item?.marketType || "").toLowerCase() === "binary"
    || Number(item?.outcomeCount) === 2;
  if (!hasBinaryMetadata) return false;
  const yesRaw = item?.binaryYesMarketProbability;
  const noRaw = item?.binaryNoMarketProbability;
  if (yesRaw == null || noRaw == null || yesRaw === "" || noRaw === "") return false;
  const yes = number(yesRaw);
  const no = number(noRaw);
  return yes === 0 && no === 0;
}

// Traded volume, the figure Polymarket shows on a market ("$37.9K Vol."). Gamma's
// `liquidity` is order-book depth -- a different number, which is why the dashboard never
// matched the site. `liquidity` stays the last fallback so rows stored before volume was
// captured keep working until they are refreshed instead of all reading zero.
function candidateVolumeUsdc(item = {}) {
  for (const candidate of [item.volumeUsdc, item.volume24hr, item.firstVolume24hr, item.liquidity]) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
  }
  return 0;
}

// Kept identical, rule for rule and in this order, to observation_market_type() in api.php
// and candidateMarketType() in assets/app.js. Those two agree; this one did not, and the
// disagreement was the whole of a reported fault.
//
// Reported: the dashboard listed two candidates as READY -- 78.0% and 81.5%, $303k and
// $275k of volume, resolving the next day -- while every run logged "none of the candidates
// passed the fresh Polymarket verification". They never reached verification. The run that
// was measured revalidated exactly ONE of 1200 rows, and dropped 213 of them for
// "market type multi does not match live portfolio market type binary".
//
// "US Open ATP: Yibing Wu vs Adam Walton", outcome "Yibing Wu", is the shape. The other two
// implementations match "vs" and call it binary -- two named sides settle it. This one had
// no "vs" rule at all: the outcome is not yes/no/over/under and the question does not open
// with "Will", so it fell through to multi. With the portfolio set to binary, every
// two-sided fixture on the board was invisible to the executor and visible on the screen.
//
// A stored `marketType` is deliberately no longer trusted either. Neither of the other two
// reads one, and a row carrying a value computed by the rule above would have kept its
// wrong answer for as long as it was retained.
const MULTI_OUTCOME_FIELD = new RegExp([
  "(exact|correct)[-\\s]?score",
  "\\belections?\\b", "\\bprimary\\b", "\\bcaucus\\b", "\\bballot\\b", "\\breferend",
  "\\bnominee\\b", "\\bnomination\\b", "\\baward\\b", "\\boscars?\\b", "\\bgrammys?\\b",
  "\\bnobel\\b", "\\bballon\\b", "\\bmvp\\b",
  "group[-\\s]winner", "\\btop[-\\s]scorer\\b", "\\boutright\\b", "winner[-\\s]of\\b",
  "\\bnext\\s+(president|prime\\s+minister|pope|chancellor|leader|ceo)\\b",
].join("|"), "i");

const BRACKET_RANGE_QUESTION = /(?<![\d-])\d{1,3}\s?-\s?\d{1,3}(?![\d-])|(?<![\d-])\d{1,4}\+/;

const TWO_SIDED_EVENT = new RegExp([
  "\\bvs\\.?\\b", "\\bv\\.\\b", "\\s@\\s",
  "\\bhandicap\\b", "\\bspread\\b", "\\bmoneyline\\b", "\\bpuck\\s?line\\b", "\\brun\\s?line\\b",
  "over\\s?/\\s?under", "\\bo\\s?/\\s?u\\b",
].join("|"), "i");

const TWO_SIDED_OUTCOMES = new Set([
  "yes", "no", "over", "under", "up", "down", "even", "odd", "home", "away", "draw", "tie",
]);

function candidateMarketType(item = {}) {
  const source = item?.candidate || {};
  const question = String(item?.question || source?.question || "");
  const slug = String(item?.eventSlug || source?.eventSlug || item?.slug || source?.slug || "");
  const haystack = `${slug} ${question}`;
  const outcome = String(item?.outcome || source?.outcome || "").trim().toLowerCase();
  const outcomeCount = Number(item?.outcomeCount ?? source?.outcomeCount);

  if (MULTI_OUTCOME_FIELD.test(haystack)) return "multi";
  if (BRACKET_RANGE_QUESTION.test(question)) return "multi";
  if (TWO_SIDED_EVENT.test(haystack)) return "binary";
  if (TWO_SIDED_OUTCOMES.has(outcome)) return "binary";
  if (Number.isFinite(outcomeCount) && outcomeCount > 2) return "multi";
  if (/^(which|who|what|how many)\b/i.test(question)) return "multi";
  if (/\bwins?\b[^?]*\b(cup|league|championship|title|tournament|final|open|series|medal|division|conference|playoffs?)\b/i.test(question)) {
    return "multi";
  }
  if (/^(will|is|are|can|does|do|did|has|have|was|were)\b/i.test(question)) return "binary";
  return /^(yes|no)$/i.test(outcome) ? "binary" : "multi";
}

function isOverUnderMarket(item = {}) {
  const source = item?.candidate || {};
  const question = String(item?.question || source?.question || "");
  const slug = String(item?.eventSlug || source?.eventSlug || item?.slug || source?.slug || "");
  const outcome = String(item?.outcome || source?.outcome || "").trim().toLowerCase();
  const text = `${slug} ${question}`;
  if (/(?:\bo\s*\/\s*u\b|over\s*\/\s*under|over\s+under|\btotal(?:\s+(?:goals?|points?|runs?|maps?|rounds?|kills?|games?|sets?))?\s*(?:o\s*\/\s*u\s*)?\d+(?:[.,]\d+)?\b)/i.test(text)) return true;
  if (/(?:^|[-_])(?:o[-_]?u|over[-_]?under|total[-_]\d)/i.test(slug)) return true;
  return (outcome === "over" || outcome === "under")
    && /(?:\bo\s*\/\s*u\b|\bover\b|\bunder\b|\btotal\b|\b\d+(?:[.,]\d+)?\b)/i.test(question);
}

function prefilterLiveCandidate(item) {
  const reasons = [];
  const tokenId = String(item?.tokenId || "");
  const status = String(item?.status || "").toUpperCase();
  const qualificationProbability = selectedProbability(item);
  const days = localDaysToResolution(item);
  const liquidity = number(item?.liquidity, 0);

  if (!tokenId) reasons.push("missing token id");
  const marketType = candidateMarketType(item);
  if (PORTFOLIO_MARKET_TYPE !== "all" && marketType !== PORTFOLIO_MARKET_TYPE) {
    reasons.push(`market type ${marketType} does not match live portfolio market type ${PORTFOLIO_MARKET_TYPE}`);
  }
  if (EXCLUDE_OVER_UNDER_MARKETS && isOverUnderMarket(item)) {
    reasons.push("Over/Under market is excluded by this live portfolio");
  }
  if (EXCLUDED_CANDIDATE_TOKEN_IDS.has(tokenId)) reasons.push("manually excluded from this live portfolio");
  // Applied in the shared prefilter so both live strategies share the same shortlist.
  if (INCLUDE_ONLY_MARKET_TAGS.size && !marketMatchesIncludeOnlyTags(item)) {
    reasons.push(`outside included tags (${[...INCLUDE_ONLY_MARKET_TAGS].join(", ")})`);
  } else {
    const excludedTags = excludedMarketTagsOn(item);
    if (excludedTags.length) {
      reasons.push(`excluded tag${excludedTags.length > 1 ? "s" : ""} ${excludedTags.join(", ")}`);
    }
  }
  if (status === "ERROR") {
    reasons.push("stored status ERROR");
  } else if (["RESOLVED", "CLOSED", "FINALIZED", "SETTLED"].includes(status)) {
    reasons.push(`stored status ${status}`);
  }
  if (item?.marketClosed === true || item?.closed === true || item?.resolved === true || item?.isResolved === true) {
    reasons.push("stored market is already closed/resolved");
  }
  if (item?.acceptingOrders === false) reasons.push("stored market is not accepting orders");
  if (binaryOutcomeQuotesAreBothZero(item)) reasons.push("stored binary YES/NO quotes are both 0%; market appears resolved");
  if (hasStaleBinarySideQuote(item)) {
    reasons.push("stored binary side quote is stale; waiting for a refreshed selected-token quote");
  }
  if (marketProbabilityRoundsToCertain(item)) {
    reasons.push("stored market probability rounds to 100.0%; no executable upside remains");
  }
  if (!Number.isFinite(qualificationProbability)) {
    reasons.push(`missing ${probabilitySourceLabel().toLowerCase()}`);
  } else if (qualificationProbability < MIN_PROBABILITY) {
    reasons.push(`${probabilitySourceLabel()} ${(qualificationProbability * 100).toFixed(1)}% below live threshold ${(MIN_PROBABILITY * 100).toFixed(1)}%`);
  } else if (MAX_PROBABILITY != null && qualificationProbability > MAX_PROBABILITY) {
    reasons.push(`${probabilitySourceLabel()} ${(qualificationProbability * 100).toFixed(1)}% above live maximum ${(MAX_PROBABILITY * 100).toFixed(1)}%`);
  }
  const returnYield = selectedReturnYield(item);
  if (!Number.isFinite(returnYield)) {
    reasons.push(`missing ${probabilitySourceLabel()} net return`);
  } else if (returnYield <= 0) {
    reasons.push(`${probabilitySourceLabel()} net return ${(returnYield * 100).toFixed(1)}% is non-profitable after fees`);
  }
  const candidateNetYield = netYieldAfterFees(item);
  if (candidateNetYield == null || candidateNetYield < MIN_NET_YIELD) {
    reasons.push(`net profit ${candidateNetYield == null ? "-" : `${(candidateNetYield * 100).toFixed(1)}%`} below ${(MIN_NET_YIELD * 100).toFixed(1)}% after fees`);
  }
  const candidateVolume = candidateVolumeUsdc(item);
  if (candidateVolume < MIN_VOLUME_24H) {
    reasons.push(`volume ${candidateVolume.toFixed(2)} USDC below live minimum ${MIN_VOLUME_24H.toFixed(2)} USDC`);
  }
  // A portfolio's resolution horizon is a capital-turnover preference, not a
  // tradeability signal -- unlike the terminal-state checks above, which correctly
  // moved off Gamma's scheduled date onto Polymarket's own reported status, this ceiling
  // is deliberately date-derived: it caps how long this portfolio is willing to hold
  // capital in a still-perfectly-tradable market. The two are independent, so this stays
  // even though a stale/estimated date is no longer used to decide whether a market has
  // ended.
  if (Number.isFinite(MAX_RESOLUTION_DAYS) && Number.isFinite(days) && days > MAX_RESOLUTION_DAYS) {
    reasons.push(`stored resolution ${days.toFixed(2)} days exceeds live max ${MAX_RESOLUTION_DAYS} days`);
  }
  return {
    passed: reasons.length === 0,
    reasons,
    days,
  };
}

function sortLivePrefilterCandidates(rows = []) {
  return [...rows].sort((a, b) => {
    if (SELECTION_ORDER === "highest_reward_risk_first") {
      const aRatio = number(a.riskReward, number(a.netGainIfWinUsdc) && number(a.totalCostUsdc) ? number(a.netGainIfWinUsdc) / number(a.totalCostUsdc) : -Infinity);
      const bRatio = number(b.riskReward, number(b.netGainIfWinUsdc) && number(b.totalCostUsdc) ? number(b.netGainIfWinUsdc) / number(b.totalCostUsdc) : -Infinity);
      if (bRatio !== aRatio) return bRatio - aRatio;
    }
    const aYield = selectedReturnYield(a) ?? -Infinity;
    const bYield = selectedReturnYield(b) ?? -Infinity;
    if (bYield !== aYield) return bYield - aYield;
    const aEv = selectedExpectedValue(a) ?? -Infinity;
    const bEv = selectedExpectedValue(b) ?? -Infinity;
    if (bEv !== aEv) return bEv - aEv;
    const aProbability = selectedProbability(a) ?? -Infinity;
    const bProbability = selectedProbability(b) ?? -Infinity;
    if (bProbability !== aProbability) return bProbability - aProbability;
    return candidateEvaluatedAtTime(b) - candidateEvaluatedAtTime(a);
  });
}

function prefilterReasonCountKey(reason) {
  const text = String(reason || "");
  if (/(AI|Polymarket) probability .* below live threshold/i.test(text)) return "selected probability below live threshold";
  // These three also carry a per-candidate number (a percentage or a USDC amount) baked
  // into the reason text. Left ungrouped, every distinct value became its own bucket --
  // for liquidity specifically this turned a single homogeneous rejection reason into
  // thousands of one-off entries and was the dominant contributor to run-log size.
  if (/annualized return .* is non-profitable after fees/i.test(text)) return "annualized return non-profitable after fees";
  if (/^net profit .* below .* after fees/i.test(text)) return "net profit below live minimum after fees";
  if (/^liquidity .* below live minimum .* USDC/i.test(text)) return "volume below live minimum";
  if (/^volume .* below live minimum .* USDC/i.test(text)) return "volume below live minimum";
  if (/stored resolution .* exceeds live max/i.test(text)) return "stored resolution exceeds live max days";
  if (/outside live revalidation scan limit/i.test(text)) return "outside live revalidation scan limit after short-expiry ranking";
  // Each of these carries its own overlap keys, so grouping strips them back down to one
  // count per reason instead of one bucket per distinct event/match combination.
  if (/^same live event or match already open/i.test(text)) return "same live event or match already open";
  if (/^correlated live exposure/i.test(text)) return "correlated live exposure";
  return text || "unknown prevalidation reason";
}

function incrementReason(counts, reason) {
  const key = prefilterReasonCountKey(reason);
  counts[key] = number(counts[key], 0) + 1;
}

function prepareLiveCandidatePool(evaluations = [], liveState = null) {
  const uniqueEvaluations = latestUniqueEvaluations(evaluations);
  const reasonCounts = {};
  let prefilterRejectedCount = 0;
  const prefilterPassed = [];

  // Built from this same row set so a candidate never needs a network fetch to learn
  // that a position already open on its event/match would reject it anyway.
  const evaluationByTokenForRisk = new Map(
    uniqueEvaluations.map((item) => [String(item.tokenId || ""), item]).filter(([tokenId]) => tokenId),
  );
  const held = liveState ? heldRiskItems(liveState, evaluationByTokenForRisk) : [];

  for (const item of uniqueEvaluations) {
    const result = prefilterLiveCandidate(item);
    const riskReason = result.passed ? earlyRiskBlockReason(item, held) : null;
    if (result.passed && !riskReason) {
      prefilterPassed.push({
        ...item,
        daysToResolution: Number.isFinite(result.days) ? Number(result.days.toFixed(2)) : item.daysToResolution,
      });
      continue;
    }
    for (const reason of result.reasons) incrementReason(reasonCounts, reason);
    if (riskReason) incrementReason(reasonCounts, riskReason);
    prefilterRejectedCount += 1;
  }

  const ranked = sortLivePrefilterCandidates(prefilterPassed);
  const rankedByToken = new Map(ranked.map((item) => [String(item.tokenId || ""), item]));
  const requestedShortlist = HAS_MANUAL_SHORTLIST
    ? MANUAL_SHORTLIST_TOKEN_IDS.map((tokenId) => rankedByToken.get(tokenId)).filter(Boolean)
    : [];
  const missingManualShortlistTokenIds = HAS_MANUAL_SHORTLIST
    ? MANUAL_SHORTLIST_TOKEN_IDS.filter((tokenId) => !rankedByToken.has(tokenId))
    : [];
  // A browser can hold a shortlist for a few seconds while a scraping batch replaces
  // its local rows, so some token ids may no longer be in the ranked pool.
  //
  // This used to be all-or-nothing: a single missing id discarded the entire requested
  // shortlist and the run silently evaluated the executor's own top-N instead. With a
  // shortlist of ~120 ids that is close to guaranteed, which is why candidates sitting
  // in the dashboard as READY never appeared in the run log at all -- they were never
  // evaluated, and nothing said so.
  //
  // The surviving ids are now used as-is, in the order the browser asked for. Falling
  // back to the ranked pool only happens when none of them survived, because then there
  // is genuinely no shortlist left to honour.
  const manualShortlistFallback = HAS_MANUAL_SHORTLIST && requestedShortlist.length === 0;
  const usesRequestedShortlist = HAS_MANUAL_SHORTLIST && !manualShortlistFallback;
  if (usesRequestedShortlist && missingManualShortlistTokenIds.length) {
    incrementReason(
      reasonCounts,
      `not in the current scraped catalogue when the run started (${missingManualShortlistTokenIds.length} of ${MANUAL_SHORTLIST_TOKEN_IDS.length} requested)`,
    );
  }
  const selected = usesRequestedShortlist
    ? requestedShortlist
    : ranked.slice(0, Math.max(0, CANDIDATE_SCAN_LIMIT));
  const skippedByLimit = usesRequestedShortlist
    ? []
    : ranked.slice(Math.max(0, CANDIDATE_SCAN_LIMIT));
  if (skippedByLimit.length) {
    incrementReason(reasonCounts, `outside live revalidation scan limit after short-expiry ranking (${CANDIDATE_SCAN_LIMIT})`);
  }

  return {
    uniqueEvaluations,
    candidates: selected,
    diagnostics: {
      storedEvaluations: evaluations.length,
      uniqueEvaluations: uniqueEvaluations.length,
      prefilterPassed: prefilterPassed.length,
      selectedForRevalidation: selected.length,
      scanLimit: CANDIDATE_SCAN_LIMIT,
      skippedByScanLimit: skippedByLimit.length,
      prefilterRejected: prefilterRejectedCount,
      manualShortlist: HAS_MANUAL_SHORTLIST,
      manualShortlistTokenCount: MANUAL_SHORTLIST_TOKEN_IDS.length,
      manualShortlistMatched: requestedShortlist.length,
      manualShortlistMissingTokenIds: missingManualShortlistTokenIds,
      manualShortlistFallback,
      reasonCounts,
      rejectedSample: [],
      skippedByLimitSample: [],
      executionShortlist: selected.slice(0, Math.min(20, HAS_MANUAL_SHORTLIST ? MANUAL_SHORTLIST_TOKEN_IDS.length : CANDIDATE_SCAN_LIMIT)).map(liveBatchCandidateSummary),
    },
  };
}

// The CLOB token id is the thing an order is actually placed against, and Gamma indexes
// markets by it, so it identifies the market unambiguously. The stored slug does not: for
// several scraped rows -- esports fixtures especially -- `slug` holds the parent EVENT
// slug (slug === eventSlug), and /markets?slug=<event-slug> matches nothing. That made
// live revalidation report "market not found in Gamma" and reject candidates the scrape
// had just found with six-figure liquidity, so a real, tradable market looked dead.
// Slug stays as the fallback for rows that have no token id.
async function fetchMarket(evaluation) {
  const tokenId = String(evaluation?.tokenId || "").trim();
  if (tokenId) {
    const byToken = await fetchMarketByToken(tokenId).catch(() => null);
    if (byToken) return byToken;
  }
  const slug = evaluation.slug || evaluation.marketSlug;
  if (!slug) return null;
  const markets = await fetchJson(apiUrl(GAMMA_API, "/markets", { slug }), `Gamma market ${slug}`);
  if (!Array.isArray(markets) || !markets.length) return null;
  // A slug can resolve to several markets (an event's sub-markets share a prefix), so
  // prefer the one that actually carries this token over whichever came back first.
  if (tokenId) {
    const owning = markets.find((market) => parseJsonField(market?.clobTokenIds).map(String).includes(tokenId));
    if (owning) return owning;
  }
  return markets[0];
}

async function fetchMarketByToken(tokenId) {
  if (!tokenId) return null;
  const markets = await fetchJson(apiUrl(GAMMA_API, "/markets", { clob_token_ids: tokenId }), `Gamma market token ${tokenId}`);
  return Array.isArray(markets) ? markets[0] : null;
}

async function hydrateLiveOpenOrderMetadata(liveState) {
  const openOrders = Array.isArray(liveState?.openOrders) ? liveState.openOrders : [];
  if (!openOrders.length) return liveState;
  const enrichedOrders = await Promise.all(openOrders.map(async (order) => {
    const tokenId = String(order?.tokenId || order?.assetId || "");
    // Older account snapshots contained a label and an event slug but omitted
    // the Gamma fixture time. Hydrate such orders as well: the date is needed
    // for the same conservative one-day P.A. calculation used by rotation.
    if (!tokenId) return order;
    try {
      const market = await fetchMarketByToken(tokenId);
      // Gamma answered and listed nothing for this token. That is a delisted market, not
      // a lookup that failed, and the two have to stay distinguishable: only the former
      // is grounds for withdrawing the bid resting on it.
      if (!market) return { ...order, marketListed: false };
      const tokenIds = parseJsonField(market.clobTokenIds).map(String);
      const outcomes = parseJsonField(market.outcomes).map(String);
      const tokenIndex = tokenIds.indexOf(tokenId);
      const eventSlug = marketEventSlug(market);
      const dates = marketDateContext(market, order.createdAt || liveState?.generatedAt || null);
      return {
        ...order,
        question: order.question || market.question || "",
        outcome: order.outcome || outcomes[tokenIndex] || "",
        slug: order.slug || market.slug || "",
        eventSlug: order.eventSlug || eventSlug,
        conditionId: order.conditionId || market.conditionId || order.market || null,
        market: order.market || market.conditionId || null,
        url: order.url || (eventSlug ? `https://polymarket.com/event/${eventSlug}` : ""),
        endDate: dates.endDate || order.endDate || null,
        endDateSource: dates.endDateSource || order.endDateSource || null,
        scheduledEventDate: dates.scheduledEventDate || order.scheduledEventDate || null,
        resolutionEndDate: dates.resolutionEndDate || order.resolutionEndDate || null,
        // The fallback is for a date that cannot be parsed at all. It must not clamp a
        // stored horizon that is legitimately negative, or an expired order would come
        // back as a day of runway the moment its date went missing.
        daysToResolution: daysToEnd(dates.endDate || order.endDate) ?? number(order.daysToResolution, null),
        // What the exchange still thinks of this market, recorded on the order itself. A
        // resting buy holds its collateral until it is cancelled, so an order on a market
        // that has stopped trading is money the portfolio cannot see it has.
        marketListed: true,
        marketClosed: market.closed === true,
        marketArchived: market.archived === true,
        marketResolved: market.resolved === true || market.isResolved === true,
        marketAcceptingOrders: market.acceptingOrders !== false,
        marketMetadataSource: "gamma-clob-token",
      };
    } catch {
      // The account sync retries metadata lookups. A failure here must not
      // make the order disappear or weaken the direct token safeguard.
      return order;
    }
  }));
  return { ...liveState, openOrders: enrichedOrders };
}

// Why a resting bid should be withdrawn, or "" to leave it alone.
//
// A resting limit BUY is a standing bid. It must never be used as a source of capital
// for another order, repriced, or cancelled because a scheduled date has passed. Only
// Polymarket's own resolved state is terminal; unknown metadata leaves it untouched.
// Exported for backwards-compatible diagnostics; resolution no longer uses a clock.
const EXPIRED_ORDER_GRACE_HOURS = 0;
function expiredOrderWithdrawalReason(order, now = Date.now()) {
  if (String(order?.side || "BUY").toUpperCase().includes("SELL")) return "";
  if (order?.marketResolved === true || order?.resolved === true || order?.isResolved === true) {
    return "the market is resolved on Polymarket";
  }
  return "";
}

// Cancels those orders and hands back a state without them, so the capital they were
// holding is spendable in this same run rather than at the next one.
async function withdrawExpiredOpenOrders({ liveState, tradingConfig }) {
  const openOrders = Array.isArray(liveState?.openOrders) ? liveState.openOrders : [];
  // `cancelOrder` reports a dry run as a success, which is right for the log and wrong
  // for the state: nothing was actually withdrawn, so the collateral is still held and
  // this run must not go on to spend it.
  const previewOnly = DRY_RUN || !hasFlag("confirm-live");
  const withdrawn = [];
  const failed = [];
  const remaining = [];
  for (const order of openOrders) {
    const reason = expiredOrderWithdrawalReason(order);
    if (!reason) {
      remaining.push(order);
      continue;
    }
    const response = await cancelOrder(order, tradingConfig).catch((error) => ({ error: error?.message || String(error) }));
    const summary = {
      tokenId: String(order.tokenId || order.assetId || ""),
      orderId: order.id || order.orderID || order.orderId || null,
      question: order.question || "",
      outcome: order.outcome || "",
      price: number(order.price, null),
      notionalUsdc: number(order.notionalUsdc, number(order.price, 0) * number(order.remainingSize, 0)),
      resolutionEndDate: order.resolutionEndDate || null,
      reason,
      response: compactOrderResponse(response),
    };
    if (successfulCancelResponse(response, summary.orderId)) {
      withdrawn.push({ ...summary, previewOnly });
      if (previewOnly) remaining.push(order);
      continue;
    }
    // A cancel that did not take leaves the order where it is, collateral and all. It
    // must stay in the state, or this run would spend capital the exchange still holds.
    failed.push(summary);
    remaining.push(order);
  }
  const releasedUsdc = previewOnly
    ? 0
    : withdrawn.reduce((total, item) => total + number(item.notionalUsdc, 0), 0);
  for (const item of withdrawn) {
    console.log(`${previewOnly ? "would withdraw" : "withdrew"} resting bid at ${number(item.price, 0).toFixed(4)}`
      + ` on "${item.question}": ${item.reason}`);
  }
  for (const item of failed) {
    console.log(`could not withdraw resting bid on "${item.question}" (${item.reason}): ${item.response}`);
  }
  return {
    liveState: remaining.length === openOrders.length ? liveState : { ...liveState, openOrders: remaining },
    withdrawn,
    failed,
    previewOnly,
    releasedUsdc: Number(releasedUsdc.toFixed(5)),
  };
}

async function fetchClobMarket(conditionId) {
  if (!conditionId) return null;
  return fetchJson(new URL(`/clob-markets/${conditionId}`, CLOB_HOST), `CLOB market ${conditionId}`);
}

function liveCashUsdc(liveState) {
  const collateral = number(liveState?.balanceAllowance?.collateral?.balanceUsdc);
  if (collateral != null) return collateral;
  const cash = number(liveState?.portfolio?.cashUsdc);
  if (cash != null) return cash;
  return number(liveState?.portfolio?.equityUsdc, 0);
}

// `identity` narrows the sum to the orders this portfolio placed. Passing null keeps the
// whole-wallet total, which is what the shared-account views want.
function activeBuyOrderReservationUsdc(liveState, identity = null) {
  const terminalStatuses = new Set([
    "CANCELED",
    "CANCELLED",
    "CANCELLED_BY_USER",
    "FILLED",
    "MATCHED",
    "EXPIRED",
    "ORDER_STATUS_CANCELED",
    "ORDER_STATUS_CANCELLED",
    "ORDER_STATUS_FILLED",
    "ORDER_STATUS_EXPIRED",
  ]);
  return (Array.isArray(liveState?.openOrders) ? liveState.openOrders : [])
    .filter((order) => {
      const side = String(order?.side || "BUY").toUpperCase();
      if (side.includes("SELL")) return false;
      const status = String(order?.status || order?.rawStatus || "").toUpperCase();
      if (terminalStatuses.has(status)) return false;
      if (identity && !orderWasSubmittedByThisPortfolio(order, identity)) return false;
      return number(order?.remainingSize ?? order?.originalSize ?? order?.size, 0) > 0.000001;
    })
    .reduce((sum, order) => {
      const notional = number(
        order?.notionalUsdc,
        number(order?.price, 0) * number(order?.remainingSize ?? order?.originalSize ?? order?.size, 0),
      );
      return sum + Math.max(0, number(notional, 0));
    }, 0);
}

// Which resting orders this portfolio put on the shared wallet. Every accepted
// submission is in its own run log, so the exchange's order id is the exact key; the
// token is the fallback for an accepted attempt whose response carried no id. Token
// matching is deliberately not the primary key -- both live portfolios draw from one
// candidate pool, so a token this portfolio once tried and had refused can be the very
// token the other one is now resting a bid on.
function ownSubmittedOrderIdentity(executionState) {
  const orderIds = new Set();
  const tokenIds = new Set();
  const runs = [executionState, ...(Array.isArray(executionState?.runLog) ? executionState.runLog : [])];
  for (const run of runs) {
    for (const attempt of (Array.isArray(run?.attempts) ? run.attempts : [])) {
      if (!successfulOrderResponse(attempt?.response)) continue;
      const orderId = String(attempt?.response?.orderID || attempt?.response?.orderId || "").trim();
      if (orderId) orderIds.add(orderId);
      else {
        const tokenId = String(attempt?.tokenId || "").trim();
        if (tokenId) tokenIds.add(tokenId);
      }
    }
  }
  return { orderIds, tokenIds };
}

function orderWasSubmittedByThisPortfolio(order, identity) {
  for (const key of [order?.id, order?.orderId, order?.orderID]) {
    const value = String(key || "").trim();
    if (value && identity.orderIds.has(value)) return true;
  }
  if (!identity.tokenIds.size) return false;
  for (const key of [order?.tokenId, order?.assetId, order?.asset]) {
    const value = String(key || "").trim();
    if (value && identity.tokenIds.has(value)) return true;
  }
  return false;
}

// Capital available for a new order: the account total minus what is held in open
// POSITIONS. That is the owner's rule, and the account confirms it is the right one.
//
// This used to subtract the portfolio's own resting BUY notional as well, on the belief --
// stated in a comment, never measured -- that CLOB collateral is the balance "before" the
// notional locked by pending buys. Measured on the live account
// (tools/live-capital-diagnosis.mjs): collateral 32.3788, positions 60.4041, equity
// 92.7829, and equity minus (collateral + positions) is exactly 0.0000. So the collateral
// figure is already the whole uncommitted balance, and resting bids are not escrowed
// against it -- Polymarket checks collateral when an order matches, not when it rests.
// Subtracting 39.9657 of resting notional from 32.3788 of real cash clamped the result to
// zero and skipped every candidate with "available USDC cannot cover Polymarket's current
// minimum order size", while the wallet held 32 USDC that nothing had spent.
//
// Since collateral already excludes nothing but what is genuinely gone, cash is exactly
// "total minus open positions" and needs no further deduction. The consequence is worth
// stating rather than discovering: this portfolio may now rest orders totalling more than
// its cash -- it already does, 39.97 resting against 32.38 -- so if several fill at once
// the later fills come back refused for collateral. That refusal costs a run rather than
// money, it is an outcome this executor already handles and counts, and it is the
// exchange's call to make rather than a reason to decline to ask.
function availableLiveCashUsdc(liveState, grossCash = liveCashUsdc(liveState)) {
  return Math.max(0, number(grossCash, 0));
}

function daysValue(item) {
  // An absent horizon is unknown, not zero. `Number(null)` is 0, so reading it straight
  // would sort a row whose end date could not be parsed ahead of everything as the most
  // urgent thing on the book -- the opposite of what the Infinity fallback intends.
  if (item?.daysToResolution == null) return Infinity;
  const days = Number(item.daysToResolution);
  return Number.isFinite(days) ? days : Infinity;
}

function compareShorterHorizon(a, b) {
  const delta = daysValue(a) - daysValue(b);
  return Number.isFinite(delta) ? delta : 0;
}

// The portfolio's selection rule is the source of truth for every replacement
// decision as well as for the initial shortlist. The ranking uses the return at
// the executable price, not a date-derived annualization horizon.
function compareLiveCandidatePriority(a, b) {
  if (SELECTION_ORDER === "highest_reward_risk_first") {
    const aRatio = Number(a?.riskReward || 0);
    const bRatio = Number(b?.riskReward || 0);
    if (bRatio !== aRatio) return bRatio - aRatio;
  }
  const aYield = selectedReturnYield(a) ?? -Infinity;
  const bYield = selectedReturnYield(b) ?? -Infinity;
  if (bYield !== aYield) return bYield - aYield;
  return (selectedExpectedValue(b) ?? -Infinity) - (selectedExpectedValue(a) ?? -Infinity);
}

function sortLiveEligibleCandidates(rows = []) {
  return [...rows]
    .filter((item) => Number.isFinite(selectedReturnYield(item)) && selectedReturnYield(item) > 0)
    .filter((item) => Number.isFinite(selectedExpectedValue(item)) && selectedExpectedValue(item) > 0)
    .sort(compareLiveCandidatePriority);
}

function openOrderAgeHours(order) {
  const timestamp = Date.parse(order.createdAt || order.insertTime || order.created_at || "");
  if (!Number.isFinite(timestamp)) return Infinity;
  return Math.max(0, (Date.now() - timestamp) / 3600000);
}

function liveStateWithoutOpenOrder(liveState, order) {
  const orderId = String(order.id || order.orderID || order.orderId || "");
  const tokenId = String(order.tokenId || order.assetId || "");
  return {
    ...liveState,
    openOrders: (Array.isArray(liveState?.openOrders) ? liveState.openOrders : []).filter((item) => {
      const itemId = String(item.id || item.orderID || item.orderId || "");
      const itemToken = String(item.tokenId || item.assetId || "");
      if (orderId && itemId === orderId) return false;
      return !(tokenId && itemToken === tokenId);
    }),
  };
}

function liveStateWithoutPosition(liveState, position) {
  const tokenId = String(position.tokenId || position.assetId || "");
  const positionId = String(position.id || "");
  return {
    ...liveState,
    positions: (Array.isArray(liveState?.positions) ? liveState.positions : []).filter((item) => {
      const itemToken = String(item.tokenId || item.assetId || "");
      const itemId = String(item.id || "");
      if (positionId && itemId === positionId) return false;
      return !(tokenId && itemToken === tokenId);
    }),
  };
}

// The one number this run needs from the paper state. The catalogue behind it is never
// read -- candidates come from the scraped Polymarket state -- so the run asks for the
// summary that carries the manifest and no rows, and takes the count from there.
//
// Reported as "paper state HTTP 500": the unnamed summary decodes and re-encodes every
// stored evaluation. Measured against the real api.php, 20,000 evaluations peak at 94 MB
// and 40,000 exhaust the host's 128 MB, while the manifest-only summary costs 2 MB at
// 60,000. The run was downloading a catalogue it does not use, until the catalogue grew
// past the host.
function storedEvaluationCount(paperState) {
  const declared = Number(paperState?.stateSegments?.evaluations?.counts?.evaluations);
  if (Number.isFinite(declared)) return declared;
  // A state written before segmentation carries the rows inline, and counting them is
  // then the only way to answer.
  return Array.isArray(paperState?.evaluations) ? paperState.evaluations.length : 0;
}

function liveTradingConfig(liveState) {
  return {
    funderAddress: liveState?.account?.trading?.funderAddress || liveState?.accountDiscovery?.selectedFunderAddress || FUNDER_ADDRESS,
    signatureType: number(liveState?.account?.trading?.signatureType ?? liveState?.accountDiscovery?.selectedSignatureType, SIGNATURE_TYPE),
  };
}

function openLiveRiskItems(liveState, evaluationByToken = new Map()) {
  const positions = Array.isArray(liveState?.positions) ? liveState.positions : [];
  const openOrders = Array.isArray(liveState?.openOrders) ? liveState.openOrders : [];
  return [...positions, ...openOrders]
    .filter((item) => {
      const status = String(item.status || item.rawStatus || "OPEN").toUpperCase();
      return OPEN_STATUSES.has(status) || !["WON", "LOST", "CLOSED", "REDEEMED", "CANCELED", "CANCELLED"].includes(status);
    })
    .map((item) => {
      const source = evaluationByToken.get(String(item.tokenId || item.assetId || ""));
      return source ? {
        ...source,
        ...item,
        question: item.question || source.question,
        outcome: item.outcome || source.outcome,
        slug: item.slug || source.slug,
        eventSlug: item.eventSlug || source.eventSlug,
        tags: Array.isArray(item.tags) && item.tags.length ? item.tags : source.tags,
        sourceEvaluation: source,
      } : item;
    });
}

function riskBlock(candidate, liveState, evaluationByToken = new Map()) {
  const candidateKeys = new Set(candidate.riskGroupKeys || []);
  for (const item of openLiveRiskItems(liveState, evaluationByToken)) {
    if (String(item.tokenId || item.assetId || "") === String(candidate.tokenId || "")) {
      return { reason: "duplicate token already open", overlap: [String(candidate.tokenId)] };
    }
    const itemRisk = riskProfile({
      question: item.question || "",
      slug: item.slug || "",
      eventSlug: item.eventSlug || "",
      outcome: item.outcome || "",
      tags: item.tags || tagQuestion(item.question || ""),
    });
    const overlap = itemRisk.keys.filter((key) => candidateKeys.has(key));
    const sameEventOrMatch = overlap.filter((key) => key.startsWith("event:") || key.startsWith("match:"));
    // Multiple outcomes or sub-markets of one event/match are never separate
    // diversification buckets. This stays enabled even when broader topic
    // diversification across live portfolios is switched off.
    if (sameEventOrMatch.length) {
      return { reason: "same live event or match already open", overlap: sameEventOrMatch.slice(0, 4) };
    }
    if (!CROSS_PORTFOLIO_RISK_DIVERSIFICATION) continue;
    if (overlap.length) return { reason: "correlated live exposure", overlap: overlap.slice(0, 4) };
  }
  return null;
}

// Risk keys for every currently open position/order, computed once per run rather than
// once per candidate. Used stored metadata when it exists (the merge in
// openLiveRiskItems() already attaches it from the matching evaluation); recomputing
// from question/tags is the same deterministic profile riskBlock() would derive anyway.
function heldRiskItems(liveState, evaluationByToken = new Map()) {
  return openLiveRiskItems(liveState, evaluationByToken).map((item) => {
    const keys = Array.isArray(item.riskGroupKeys) && item.riskGroupKeys.length
      ? item.riskGroupKeys
      : riskProfile({
        question: item.question || "",
        slug: item.slug || "",
        eventSlug: item.eventSlug || "",
        outcome: item.outcome || "",
        tags: item.tags || tagQuestion(item.question || ""),
      }).keys;
    return { tokenId: String(item.tokenId || item.assetId || ""), keys };
  });
}

// A cheaper version of riskBlock() that judges a candidate purely from data already on
// its stored row -- riskGroupKeys, populated by the scan/evaluation that produced it --
// against the same stored data for open positions. No book fetch, no live re-evaluation.
//
// This exists because a candidate that obviously collides with an already-open position
// on the same event or match used to reach a live CLOB book fetch and a full evaluation
// before riskBlock() rejected it during revalidation. With dozens of scraped rows sharing
// one event (every "Exact Score" sub-market of the same match, for instance), that meant
// paying for a network round trip per row only to reject nearly all of them for a reason
// that was knowable up front. It also meant the browser's own READY/RISK-BLOCKED split
// disagreed with what the executor actually tried: rows the dashboard already marked
// RISK-BLOCKED were still being sent through revalidation.
//
// The stored riskGroupKeys can be absent or stale (an event's keys generally do not
// change, but nothing here assumes they never could), so this is a fast-path only.
// riskBlock() still runs during revalidation as the authoritative check.
function earlyRiskBlockReason(candidate, held) {
  const candidateKeys = Array.isArray(candidate?.riskGroupKeys) ? candidate.riskGroupKeys : [];
  if (!candidateKeys.length || !held.length) return null;
  const tokenId = String(candidate?.tokenId || "");
  const candidateKeySet = new Set(candidateKeys);
  for (const item of held) {
    if (item.tokenId && item.tokenId === tokenId) {
      return "duplicate token already open";
    }
    const overlap = item.keys.filter((key) => candidateKeySet.has(key));
    const sameEventOrMatch = overlap.filter((key) => key.startsWith("event:") || key.startsWith("match:"));
    if (sameEventOrMatch.length) {
      return `same live event or match already open: ${sameEventOrMatch.slice(0, 4).join(", ")}`;
    }
    if (CROSS_PORTFOLIO_RISK_DIVERSIFICATION && overlap.length) {
      return `correlated live exposure: ${overlap.slice(0, 4).join(", ")}`;
    }
  }
  return null;
}

function openPositionsForRotation(liveState) {
  return (Array.isArray(liveState?.positions) ? liveState.positions : [])
    .filter((position) => {
      const status = String(position.status || "OPEN").toUpperCase();
      if (!OPEN_STATUSES.has(status) && ["WON", "LOST", "CLOSED", "REDEEMED", "SOLD"].includes(status)) return false;
      const tokenId = String(position.tokenId || position.assetId || "");
      return number(position.shares ?? position.size ?? position.balance, 0) > 0
        && tokenId
        && !hasOpenSellOrderForToken(liveState, tokenId);
    });
}

function positionExitValue(position) {
  const explicit = number(position.currentValueUsdc ?? position.valueUsdc ?? position.marketValueUsdc);
  const price = number(position.currentPrice ?? position.markPrice ?? position.price);
  const shares = number(position.shares ?? position.size);
  const derived = price != null && shares != null ? price * shares : null;
  // Some account snapshots briefly expose currentValueUsdc as zero while the
  // mark and share balance are already available. Prefer the usable mark value
  // so a zero-cash rotation is not skipped just because the snapshot lagged.
  if (derived != null && derived > 0 && (explicit == null || explicit <= 0)) return derived;
  return explicit ?? derived;
}

function positionAtExitPrice(position, exitPrice) {
  const price = number(exitPrice);
  const shares = number(position?.shares ?? position?.size);
  if (price == null || price <= 0 || shares == null || shares <= 0) return position;
  return {
    ...position,
    currentPrice: price,
    markPrice: price,
    currentValueUsdc: price * shares,
    rotationExitQuotePrice: price,
    rotationExitQuoteAt: new Date().toISOString(),
  };
}

async function positionWithFreshExitQuote(position) {
  const tokenId = String(position?.tokenId || position?.assetId || "");
  if (!tokenId) throw new Error("position has no token id for a fresh exit quote");
  const book = bestBook(await fetchJson(
    new URL(`/book?token_id=${tokenId}`, CLOB_HOST),
    `CLOB rotation quote ${tokenId}`,
  ));
  if (book.bestBid == null || book.bestBid <= 0) {
    throw new Error("fresh Polymarket best bid is not available");
  }
  return positionAtExitPrice(position, book.bestBid);
}

function positionCost(position) {
  const direct = number(position.totalCostUsdc ?? position.stakeUsdc ?? position.maxLossUsdc ?? position.initialValue);
  if (direct != null) return direct;
  const entry = number(position.entryPrice ?? position.avgPrice ?? position.averagePrice);
  const shares = number(position.shares ?? position.size);
  return entry != null && shares != null ? entry * shares : 0;
}

function positionSourceEvaluation(position, evaluationByToken = new Map()) {
  return evaluationByToken.get(String(position.tokenId || position.assetId || "")) || null;
}

function positionExitFee(position, evaluationByToken = new Map()) {
  // Rotation exits are intentionally marketable (the sell is submitted with
  // postOnly=false), even when replacement buys use post-only limits. Always
  // include the taker fee here so a rotation is not approved on overstated
  // proceeds.
  const source = positionSourceEvaluation(position, evaluationByToken);
  const shares = number(position.shares ?? position.size);
  const price = number(
    position.currentPrice
      ?? position.markPrice
      ?? position.price
      ?? (number(position.currentValueUsdc ?? position.valueUsdc ?? position.marketValueUsdc) != null && shares > 0
        ? number(position.currentValueUsdc ?? position.valueUsdc ?? position.marketValueUsdc) / shares
        : null),
  );
  if (shares == null || price == null) return 0;
  return takerFee(shares, price, feeRateForEvaluation({ feeRate: position.feeRate ?? source?.feeRate }));
}

function positionRotationEconomics(position, evaluationByToken = new Map()) {
  const source = positionSourceEvaluation(position, evaluationByToken);
  const grossExitValue = positionExitValue(position);
  const exitFee = positionExitFee(position, evaluationByToken);
  const netExitValue = grossExitValue == null ? null : Math.max(0, grossExitValue - exitFee);
  const cost = positionCost(position);
  const shares = number(position.shares ?? position.size);
  const probability = PROBABILITY_SOURCE === "polymarket"
    ? number(position.currentPrice ?? position.markPrice ?? position.price ?? source?.marketProbability ?? source?.marketPrice)
    : number(source?.aiProbability);
  const expectedPayout = shares != null && probability != null ? shares * probability : null;
  const realizedPnlIfExit = netExitValue == null ? null : netExitValue - cost;
  // For a Polymarket-probability portfolio the stored market price is not an
  // expected payout. It is the amount currently recoverable per share. The
  // relevant comparison is therefore the remaining win upside (one dollar per
  // winning share minus the net exit value), not shares * mark - cost. The
  // latter only describes today's mark-to-cost P/L and made a held position
  // look artificially risk-free during rotation reviews.
  const holdPotentialPnl = PROBABILITY_SOURCE === "polymarket" && shares != null && netExitValue != null
    ? shares - netExitValue
    : null;
  const holdExpectedPnl = PROBABILITY_SOURCE === "polymarket" && shares != null && cost != null
    ? shares - cost
    : (expectedPayout == null ? null : expectedPayout - cost);
  const continuationExpectedValue = expectedPayout != null && netExitValue != null
    ? expectedPayout - netExitValue
    : null;
  const storedDays = number(position.daysToResolution ?? source?.daysToResolution);
  const endTime = Date.parse(position.endDate || source?.endDate || "");
  const days = storedDays != null
    ? Math.max(MIN_ANNUALIZATION_DAYS, storedDays)
    : (Number.isFinite(endTime)
      ? Math.max(MIN_ANNUALIZATION_DAYS, (endTime - Date.now()) / 86400000)
      : MIN_ANNUALIZATION_DAYS);
  // The annualization floor is deliberately applied to `days` above, so it cannot be
  // used to compare horizons: every sub-hour position would look like an hour. This
  // is the real remaining time, which may be zero or negative when settlement is due.
  const rawRemainingDays = Number.isFinite(endTime)
    ? (endTime - Date.now()) / 86400000
    : (Number.isFinite(storedDays) ? storedDays : null);
  const currentSellPnl = realizedPnlIfExit ?? number(position.unrealizedPnlUsdc);
  const maximumWinPnl = number(
    position.netGainIfWinUsdc
      ?? source?.netGainIfWinUsdc
      ?? (shares != null && cost != null ? shares - cost : null),
  );
  const winPnlGapUsdc = currentSellPnl != null && maximumWinPnl != null
    ? Math.abs(maximumWinPnl - currentSellPnl)
    : null;
  const winPnlGapPct = winPnlGapUsdc != null && cost != null && cost > 0
    ? winPnlGapUsdc / cost
    : null;
  // Unlike the absolute gap used for the "safe to close" check below, this
  // keeps the direction. It answers the rotation question directly: how much
  // profit can this position still add if it is held to a winning settlement?
  const remainingPotentialGainUsdc = currentSellPnl != null && maximumWinPnl != null
    ? maximumWinPnl - currentSellPnl
    : null;
  const resolutionPast = Number.isFinite(endTime) && endTime <= Date.now();
  const resolutionDueOrUnknown = !Number.isFinite(endTime) || resolutionPast;
  const nearMaximumWin = winPnlGapPct != null && winPnlGapPct <= ROTATION_NEAR_MAX_WIN_GAP;
  const noDaysLeft = resolutionDueOrUnknown;
  // Measured on the directional remaining gain after exit fees, not on an absolute
  // gap, so a position that can still add real profit is told apart from one with
  // nothing left to collect.
  const upsideExhausted = remainingPotentialGainUsdc != null
    && remainingPotentialGainUsdc <= ROTATION_PROTECT_REMAINING_GAIN_USDC;
  // Protected only while awaiting settlement with real upside still outstanding. A
  // missing end date does not count as elapsed: sports rows often carry unreliable
  // dates, and treating unknown as past would strand capital indefinitely.
  const settlementLocked = resolutionPast && !upsideExhausted;
  const continuationAnnualizedReturn = continuationExpectedValue != null && netExitValue != null && netExitValue > 0
    ? annualizeReturn(continuationExpectedValue / netExitValue, days)
    : null;
  return {
    source,
    grossExitValue,
    exitFee,
    netExitValue,
    cost,
    expectedPayout,
    realizedPnlIfExit,
    holdPotentialPnl,
    holdExpectedPnl,
    continuationExpectedValue,
    continuationAnnualizedReturn,
    daysToResolution: days,
    currentSellPnl,
    maximumWinPnl,
    winPnlGapUsdc,
    winPnlGapPct,
    remainingPotentialGainUsdc,
    resolutionPast,
    rawRemainingDays,
    noDaysLeft,
    nearMaximumWin,
    upsideExhausted,
    settlementLocked,
  };
}

function rotationNetProfitGuard({ economics = {}, candidate = {}, capitalBaseUsdc = null } = {}) {
  const realizedPnlIfExit = number(economics.realizedPnlIfExit);
  const currentMaximumPnl = number(economics.maximumWinPnl ?? economics.holdExpectedPnl);
  const replacementMaximumPnl = number(candidate.netGainIfWinUsdc);
  const capitalBase = Math.max(
    0,
    number(capitalBaseUsdc, 0),
    number(economics.cost, 0),
    number(candidate.totalCostUsdc ?? candidate.orderNotionalUsdc, 0),
  );
  const requiredImprovementUsdc = Math.max(
    ROTATION_MIN_NET_PNL_IMPROVEMENT_USDC,
    capitalBase * ROTATION_MIN_PRIORITY_IMPROVEMENT,
  );
  const rotatedMaximumPnl = realizedPnlIfExit != null && replacementMaximumPnl != null
    ? realizedPnlIfExit + replacementMaximumPnl
    : null;
  const maximumPnlDelta = rotatedMaximumPnl != null && currentMaximumPnl != null
    ? rotatedMaximumPnl - currentMaximumPnl
    : null;
  const exitLossUsdc = realizedPnlIfExit == null ? null : Math.max(0, -realizedPnlIfExit);
  const replacementProfitAfterExitLossUsdc = replacementMaximumPnl != null && exitLossUsdc != null
    ? replacementMaximumPnl - exitLossUsdc
    : null;
  const allowed = maximumPnlDelta != null
    && maximumPnlDelta + ROTATION_TIE_EPSILON >= requiredImprovementUsdc;
  return {
    allowed,
    realizedPnlIfExitUsdc: realizedPnlIfExit,
    exitLossUsdc,
    currentMaximumPnlUsdc: currentMaximumPnl,
    replacementMaximumPnlUsdc: replacementMaximumPnl,
    replacementProfitAfterExitLossUsdc,
    rotatedMaximumPnlUsdc: rotatedMaximumPnl,
    maximumPnlDeltaUsdc: maximumPnlDelta,
    requiredImprovementUsdc,
    capitalBaseUsdc: capitalBase,
  };
}

function positionHoldExpectedValue(position, evaluationByToken = new Map()) {
  const economics = positionRotationEconomics(position, evaluationByToken);
  if (economics.continuationExpectedValue != null) return economics.continuationExpectedValue;
  const pnl = number(position.unrealizedPnlUsdc);
  return pnl != null ? pnl : 0;
}

function positionHoldAnnualizedReturn(position, evaluationByToken = new Map()) {
  const economics = positionRotationEconomics(position, evaluationByToken);
  const days = number(economics.daysToResolution, MIN_ANNUALIZATION_DAYS);
  if (PROBABILITY_SOURCE === "polymarket"
    && economics.holdPotentialPnl != null
    && economics.netExitValue != null
    && economics.netExitValue > 0) {
    return annualizeReturn(economics.holdPotentialPnl / economics.netExitValue, days);
  }
  if (economics.holdExpectedPnl != null && economics.cost > 0) {
    return annualizeReturn(economics.holdExpectedPnl / economics.cost, days);
  }
  if (economics.continuationAnnualizedReturn != null) return economics.continuationAnnualizedReturn;
  return selectedAnnualizedReturn(economics.source) ?? 0;
}

function positionHoldRiskReward(position, evaluationByToken = new Map()) {
  const economics = positionRotationEconomics(position, evaluationByToken);
  if (PROBABILITY_SOURCE === "polymarket"
    && economics.holdPotentialPnl != null
    && economics.netExitValue != null
    && economics.netExitValue > 0) {
    return economics.holdPotentialPnl / economics.netExitValue;
  }
  const source = positionSourceEvaluation(position, evaluationByToken);
  const sourceRatio = number(source?.riskReward);
  if (sourceRatio != null) return sourceRatio;
  const gain = number(source?.netGainIfWinUsdc);
  const cost = number(source?.totalCostUsdc ?? source?.stakeUsdc ?? position.totalCostUsdc ?? position.stakeUsdc);
  return gain != null && cost != null && cost > 0 ? gain / cost : 0;
}

function rotationPriority(position, evaluationByToken = new Map(), options = {}) {
  if (SELECTION_ORDER === "highest_reward_risk_first") {
    return { metric: "R/R", value: positionHoldRiskReward(position, evaluationByToken) };
  }
  const holdAnnualizedReturn = number(options.holdAnnualizedReturn);
  return {
    metric: returnMetricLabel(),
    value: holdAnnualizedReturn != null
      ? holdAnnualizedReturn
      : positionHoldAnnualizedReturn(position, evaluationByToken),
  };
}

function rotationPositionEntries(liveState, evaluationByToken = new Map()) {
  const entries = openPositionsForRotation(liveState).map((position) => {
    const economics = positionRotationEconomics(position, evaluationByToken);
    return {
      position,
      exitValue: economics.netExitValue,
      holdEv: positionHoldExpectedValue(position, evaluationByToken),
      measuredAnnualizedReturn: positionHoldAnnualizedReturn(position, evaluationByToken),
      economics,
    };
  });
  // A resolution date in the past is not a one-day investment horizon. Use
  // the weakest still-measurable live position as its conservative Win P.A.
  // reference, then distinguish pending settlements by the profit that is
  // genuinely still left to gain rather than by a fabricated annualization.
  const measuredReturns = entries
    .filter((item) => !item.economics.resolutionPast)
    .map((item) => item.measuredAnnualizedReturn)
    .filter(Number.isFinite);
  const pendingResolutionReferenceAnnualizedReturn = measuredReturns.length
    ? Math.min(...measuredReturns)
    : 0;

  return entries.map((item) => {
    const usesPendingResolutionReference = item.economics.resolutionPast;
    const holdAnnualizedReturn = usesPendingResolutionReference
      ? pendingResolutionReferenceAnnualizedReturn
      : item.measuredAnnualizedReturn;
    return {
      ...item,
      holdAnnualizedReturn,
      pendingResolutionReferenceAnnualizedReturn: usesPendingResolutionReference
        ? pendingResolutionReferenceAnnualizedReturn
        : null,
      usesPendingResolutionReference,
      priority: rotationPriority(item.position, evaluationByToken, { holdAnnualizedReturn }),
      tieBreak: Math.random(),
    };
  });
}

function candidateRotationPriority(candidate) {
  if (SELECTION_ORDER === "highest_reward_risk_first") {
    const storedRiskReward = number(candidate?.riskReward);
    const gain = number(candidate?.netGainIfWinUsdc);
    const cost = number(candidate?.totalCostUsdc);
    return {
      metric: "R/R",
      value: storedRiskReward != null
        ? storedRiskReward
        : (gain != null && cost != null && cost > 0 ? gain / cost : null),
    };
  }
  return {
    metric: returnMetricLabel(),
    value: selectedAnnualizedReturn(candidate),
  };
}

function rotationPositionSummary(position, evaluationByToken = new Map(), extra = {}) {
  const economics = positionRotationEconomics(position, evaluationByToken);
  const exitValue = economics.netExitValue;
  const cost = economics.cost;
  const holdEv = positionHoldExpectedValue(position, evaluationByToken);
  const measuredAnnualizedReturn = positionHoldAnnualizedReturn(position, evaluationByToken);
  const holdAnnualizedReturn = number(extra.holdAnnualizedReturn, measuredAnnualizedReturn);
  const priority = extra.priority || rotationPriority(position, evaluationByToken, { holdAnnualizedReturn });
  return {
    question: position.question || position.market || "",
    outcome: position.outcome || position.side || "",
    tokenId: position.tokenId || position.assetId || null,
    status: position.status || "OPEN",
    shares: number(position.shares ?? position.size),
    entryPrice: number(position.entryPrice),
    currentPrice: number(position.currentPrice),
    costUsdc: cost,
    estimatedExitValueUsdc: exitValue == null ? null : Number(exitValue.toFixed(5)),
    estimatedExitFeeUsdc: Number(economics.exitFee.toFixed(5)),
    unrealizedPnlUsdc: number(position.unrealizedPnlUsdc),
    currentSellPnlUsdc: economics.currentSellPnl == null ? null : Number(economics.currentSellPnl.toFixed(5)),
    maximumWinPnlUsdc: economics.maximumWinPnl == null ? null : Number(economics.maximumWinPnl.toFixed(5)),
    winPnlGapUsdc: economics.winPnlGapUsdc == null ? null : Number(economics.winPnlGapUsdc.toFixed(5)),
    winPnlGapPct: economics.winPnlGapPct == null ? null : Number(economics.winPnlGapPct.toFixed(5)),
    remainingPotentialGainUsdc: economics.remainingPotentialGainUsdc == null ? null : Number(economics.remainingPotentialGainUsdc.toFixed(5)),
    resolutionPast: economics.resolutionPast,
    noDaysLeft: economics.noDaysLeft,
    settlementLocked: economics.settlementLocked,
    upsideExhausted: economics.upsideExhausted,
    nearMaximumWin: economics.nearMaximumWin,
    realizedPnlIfExitUsdc: economics.realizedPnlIfExit == null ? null : Number(economics.realizedPnlIfExit.toFixed(5)),
    potentialWinIfHeldUsdc: economics.holdPotentialPnl == null ? null : Number(economics.holdPotentialPnl.toFixed(5)),
    holdExpectedValueUsdc: Number(holdEv.toFixed(5)),
    holdExpectedPnlUsdc: economics.holdExpectedPnl == null ? null : Number(economics.holdExpectedPnl.toFixed(5)),
    measuredAnnualizedReturn: Number(measuredAnnualizedReturn.toFixed(5)),
    holdAnnualizedReturn: Number(holdAnnualizedReturn.toFixed(5)),
    pendingResolutionReferenceAnnualizedReturn: number(extra.pendingResolutionReferenceAnnualizedReturn),
    usesPendingResolutionReference: Boolean(extra.usesPendingResolutionReference),
    rotationPriorityMetric: priority.metric,
    rotationPriorityValue: Number(priority.value.toFixed(5)),
    url: position.url || `https://polymarket.com/event/${position.eventSlug || position.slug || ""}`,
    ...extra,
  };
}

function holdingResolutionMs(item, evaluationByToken = new Map()) {
  const source = positionSourceEvaluation(item, evaluationByToken) || {};
  const time = Date.parse(item?.endDate || source.endDate || "");
  return Number.isFinite(time) ? time : null;
}

// The latest resolution among everything currently held or resting. A rotation
// candidate settling after it pushes the portfolio's payout further out than
// anything it could replace, so it is not a rotation at all -- and the
// per-position horizon check would refuse it anyway, after paying for a live
// revalidation. Filtering here keeps that work off candidates that cannot win.
function latestHoldingResolutionMs(liveState, evaluationByToken = new Map()) {
  const holdings = [
    ...openPositionsForRotation(liveState),
    ...(Array.isArray(liveState?.openOrders) ? liveState.openOrders : [])
      .filter((order) => !String(order.side || "").toUpperCase().includes("SELL")),
  ];
  const times = holdings
    .map((item) => holdingResolutionMs(item, evaluationByToken))
    .filter((time) => time != null);
  return times.length ? Math.max(...times) : null;
}

function candidatePoolForRotation(baseCandidates = [], { latestResolutionMs = null } = {}) {
  return [...baseCandidates]
    .filter((item) => Number.isFinite(selectedProbability(item)))
    .filter((item) => Number.isFinite(selectedAnnualizedReturn(item)) && selectedAnnualizedReturn(item) > 0)
    .filter((item) => Number.isFinite(selectedExpectedValue(item)) && selectedExpectedValue(item) > 0)
    .filter((item) => {
      if (latestResolutionMs == null) return true;
      const end = Date.parse(item?.endDate || "");
      // An unknown end date is not a late one. Dropping it here would repeat the
      // mistake of treating missing data as a confident verdict.
      return !Number.isFinite(end) || end <= latestResolutionMs;
    })
    // Rotation must use exactly the portfolio's configured ordering. In
    // particular, high-reward portfolios must not silently fall back to EV p.a.
    .sort(compareLiveCandidatePriority)
    .slice(0, ROTATION_CANDIDATE_SCAN_LIMIT);
}

function restrictCandidatesToRotationPlan(candidates = [], previousState = null, completionRun = false) {
  if (!completionRun) return [...candidates];
  const rotationExit = previousState?.rotationExit || previousState?.batchLog?.rotationExit || null;
  const plannedTokenId = String(
    rotationExit?.candidateTokenId
      || rotationExit?.candidate?.tokenId
      || "",
  );
  const exitedTokenId = String(
    rotationExit?.position?.tokenId
      || rotationExit?.position?.assetId
      || rotationExit?.order?.tokenId
      || "",
  );
  if (!plannedTokenId || plannedTokenId === exitedTokenId) return [];
  const current = candidates.find((candidate) => String(candidate?.tokenId || "") === plannedTokenId);
  if (current) return [current];
  const fallback = rotationExit?.candidate;
  return fallback && String(fallback.tokenId || "") === plannedTokenId ? [fallback] : [];
}

function candidateRequiresSpecificPositionExit(candidate, position, liveState, evaluationByToken = new Map()) {
  const beforeExit = riskBlock(candidate, liveState, evaluationByToken);
  if (!beforeExit) return false;
  const afterExit = riskBlock(candidate, liveStateWithoutPosition(liveState, position), evaluationByToken);
  return !afterExit;
}

async function reviewPositionRotation({ liveState, evaluationByToken, baseCandidates, cash, maxNotional, restrictToRiskReplacement = false }) {
  const candidates = candidatePoolForRotation(baseCandidates, {
    latestResolutionMs: latestHoldingResolutionMs(liveState, evaluationByToken),
  });
  // A holding already earning more than the best available replacement cannot be
  // improved by rotating out of it, so reviewing it is wasted work. Everything
  // below that bar is fair game -- previously a fixed top-N slice decided how
  // much got looked at, which is why a single position was reviewed while other
  // holdings worth less than the candidate were never considered at all.
  const bestCandidateReturn = candidates.length ? selectedAnnualizedReturn(candidates[0]) : null;
  const worthRotatingOutOf = (entry) => {
    if (bestCandidateReturn == null) return true;
    const held = number(entry?.holdAnnualizedReturn);
    // Unknown stays reviewable; only a holding measurably above the candidate is skipped.
    return held == null || held < bestCandidateReturn;
  };
  // Kept so the log can say which of these actually stopped the rotation. All three
  // used to arrive as the same sentence, and "no open live position can be evaluated"
  // reads like a bug when the portfolio plainly has capital committed -- it cannot be
  // told apart from the rule below doing its job, which is the question actually asked
  // of this log.
  const heldPositions = rotationPositionEntries(liveState, evaluationByToken);
  const rejectedByReturnBar = heldPositions.filter((entry) => !worthRotatingOutOf(entry));
  const positions = rotationPositionEntries(liveState, evaluationByToken)
    // Review the weakest held position first according to this portfolio's own
    // selection rule. Settlement-pending positions share the conservative
    // reference Win P.A.; among that tie, exit the one with the least profit
    // still available before settlement. A true tie is intentionally mixed so
    // one stale row cannot monopolize every rotation run.
    .sort((a, b) => {
      if (a.priority.value !== b.priority.value) return a.priority.value - b.priority.value;
      const aRemaining = number(a.economics.remainingPotentialGainUsdc, Infinity);
      const bRemaining = number(b.economics.remainingPotentialGainUsdc, Infinity);
      const pendingReferenceTie = a.usesPendingResolutionReference && b.usesPendingResolutionReference;
      if (pendingReferenceTie && Math.abs(aRemaining - bRemaining) > ROTATION_TIE_EPSILON) {
        return aRemaining - bRemaining;
      }
      if (a.holdAnnualizedReturn !== b.holdAnnualizedReturn) return a.holdAnnualizedReturn - b.holdAnnualizedReturn;
      if (Math.abs(aRemaining - bRemaining) > ROTATION_TIE_EPSILON) return aRemaining - bRemaining;
      if (a.holdEv !== b.holdEv) return a.holdEv - b.holdEv;
      return a.tieBreak - b.tieBreak;
    })
    .filter(worthRotatingOutOf)
    .slice(0, ROTATION_POSITION_SCAN_LIMIT);
  const reviews = [];
  let best = null;

  if (!positions.length) {
    const restingBuyOrders = (Array.isArray(liveState?.openOrders) ? liveState.openOrders : [])
      .filter((order) => !String(order.side || "").toUpperCase().includes("SELL")).length;
    // Named separately because they mean different things to whoever reads this. The
    // first is "there is nothing here to rotate"; the second is this portfolio's own
    // rule declining to sell something that is already earning more than anything on
    // offer -- a decision, not an absence.
    const reason = !heldPositions.length
      ? `this portfolio holds no open position, so there is nothing to rotate out of${restingBuyOrders
        ? `; its committed capital is in ${restingBuyOrders} resting order(s), which the open-order review decides on separately`
        : ""}`
      : `all ${heldPositions.length} open position(s) already earn at least as much as the best candidate`
        + `${Number.isFinite(bestCandidateReturn) ? ` (${(bestCandidateReturn * 100).toFixed(1)}% p.a.)` : ""}`
        + `, so rotating out of any of them would lower the portfolio's return`;
    return {
      action: "NO_ROTATION_CANDIDATE",
      reason,
      positionsHeld: heldPositions.length,
      positionsBelowBestCandidate: heldPositions.length - rejectedByReturnBar.length,
      positionsAboveBestCandidate: rejectedByReturnBar.length,
      bestCandidateAnnualizedReturn: Number.isFinite(bestCandidateReturn) ? bestCandidateReturn : null,
      restingBuyOrders,
      reviews,
      best: null,
    };
  }

  for (const [positionRank, item] of positions.entries()) {
    const storedPosition = item.position;
    let position = storedPosition;
    try {
      // The account snapshot carries a mark, but a rotation realizes the bid. A stale
      // mark understated several live losses, so every position is repriced against
      // the executable book before it is allowed into the comparison.
      position = await positionWithFreshExitQuote(storedPosition);
    } catch (error) {
      reviews.push({
        ...rotationPositionSummary(storedPosition, evaluationByToken, {
          holdAnnualizedReturn: item.holdAnnualizedReturn,
          priority: item.priority,
          pendingResolutionReferenceAnnualizedReturn: item.pendingResolutionReferenceAnnualizedReturn,
          usesPendingResolutionReference: item.usesPendingResolutionReference,
        }),
        action: "NOT_SELLABLE_FOR_ROTATION",
        reason: `fresh executable exit quote unavailable: ${error?.message || String(error)}`,
      });
      continue;
    }
    const economics = positionRotationEconomics(position, evaluationByToken);
    const exitValue = economics.netExitValue;
    const holdEv = positionHoldExpectedValue(position, evaluationByToken);
    const measuredAnnualizedReturn = positionHoldAnnualizedReturn(position, evaluationByToken);
    const usesPendingResolutionReference = Boolean(item.usesPendingResolutionReference);
    const pendingResolutionReferenceAnnualizedReturn = item.pendingResolutionReferenceAnnualizedReturn;
    const holdAnnualizedReturn = usesPendingResolutionReference
      ? number(pendingResolutionReferenceAnnualizedReturn, measuredAnnualizedReturn)
      : measuredAnnualizedReturn;
    const priority = rotationPriority(position, evaluationByToken, { holdAnnualizedReturn });
    const baseReview = rotationPositionSummary(position, evaluationByToken, {
      holdAnnualizedReturn,
      priority,
      pendingResolutionReferenceAnnualizedReturn,
      usesPendingResolutionReference,
    });
    if (exitValue == null || exitValue <= 0) {
      reviews.push({
        ...baseReview,
        action: "NOT_SELLABLE_FOR_ROTATION",
        reason: "estimated exit value is not available",
      });
      continue;
    }
    const cashAfterExit = number(cash, 0) + exitValue;

    let bestForPosition = null;
    const rejectedCandidates = [];
    for (const evaluation of candidates) {
      if (String(evaluation.tokenId || "") === String(position.tokenId || position.assetId || "")) continue;
      if (restrictToRiskReplacement && !candidateRequiresSpecificPositionExit(evaluation, position, liveState, evaluationByToken)) {
        continue;
      }
      try {
        const revalidated = await revalidateEvaluation(
          evaluation,
          liveStateWithoutPosition(liveState, position),
          cashAfterExit,
          maxNotional,
          evaluationByToken,
          { forceTakerEntry: ROTATION_TAKER_ENTRY },
        );
        if (revalidated.status !== "ELIGIBLE") {
          rejectedCandidates.push(liveBatchCandidateSummary(revalidated));
          continue;
        }
        const candidateEv = number(revalidated.expectedValueUsdc, 0);
        const candidateAnnualizedReturn = number(revalidated.annualizedReturn, 0);
        const candidatePriority = candidateRotationPriority(revalidated);
        // Both paths now start from the same current portfolio state. The exit
        // P/L and estimated exit fee are included in the rotate path.
        const realizedPnlIfExit = economics.realizedPnlIfExit != null ? economics.realizedPnlIfExit : 0;
        const holdExpectedPnl = economics.holdExpectedPnl != null ? economics.holdExpectedPnl : holdEv;
        const rotatedExpectedPnl = realizedPnlIfExit + candidateEv;
        const evDelta = rotatedExpectedPnl - holdExpectedPnl;
        const candidateDays = number(revalidated.daysToResolution);
        const rotationCapitalBase = Math.max(number(economics.cost, 0), number(revalidated.totalCostUsdc, 0), 0.000001);
        const rotatedAnnualizedReturn = rotatedExpectedPnl != null && candidateDays != null && candidateDays > 0
          ? (rotatedExpectedPnl / rotationCapitalBase) * (365 / candidateDays)
          : candidateAnnualizedReturn;
        const currentPriority = priority.value;
        const replacementPriority = candidatePriority.metric === "R/R" ? candidatePriority.value : rotatedAnnualizedReturn;
        const priorityDelta = replacementPriority - currentPriority;
        const netProfitGuard = rotationNetProfitGuard({
          economics,
          candidate: revalidated,
          capitalBaseUsdc: rotationCapitalBase,
        });
        // Past its end date with real upside still outstanding: hold it. This is a hard
        // veto checked before the ranking metric, because the metric is exactly what
        // misleads here. The horizon is gone, so the remaining return looks poor while
        // the position is in fact waiting on money it is likely to collect.
        const settlementLocked = Boolean(economics.settlementLocked);
        // Nothing left to collect, so there is nothing to wait for either. The metric
        // cannot judge this case for the same reason, so a valid candidate may take the
        // capital without clearing the improvement threshold.
        const upsideExhausted = Boolean(economics.upsideExhausted)
          && Number.isFinite(candidateEv)
          && candidateEv > 0
          && Number.isFinite(candidatePriority.value)
          && candidatePriority.value > 0;
        // Selling a position that resolves sooner than its replacement swaps a nearer
        // payout for a more distant one. The running position is given up early and
        // its remaining profit forfeited, while the candidate will in all likelihood
        // still be there once the position has settled, so the swap gains nothing but
        // risk. Only a candidate that resolves sooner justifies it.
        const positionRemainingDays = number(economics.rawRemainingDays);
        const candidateResolvesLater = positionRemainingDays != null
          && candidateDays != null
          && candidateDays >= positionRemainingDays;
        // Potential p.a. is still the portfolio's ranking metric, but it is not money.
        // Close-to-resolution percentages can be huge for only a few cents, so the
        // replacement must also cover the actual exit loss and improve the maximum
        // after-fee dollar result. This prevents repeated small rotations from banking
        // losses that none of the replacement wins can recover.
        const rotationPreferred = !settlementLocked
          && netProfitGuard.allowed
          && (upsideExhausted
            || (!candidateResolvesLater
              && priorityDelta >= ROTATION_MIN_PRIORITY_IMPROVEMENT));
        const priorityComparison = {
          metricLabel: candidatePriority.metric,
          currentMetric: currentPriority,
          replacementMetric: replacementPriority,
          metricDelta: priorityDelta,
          minimumImprovement: ROTATION_MIN_PRIORITY_IMPROVEMENT,
          currentExpectedValue: holdExpectedPnl,
          replacementExpectedValue: rotatedExpectedPnl,
          replacementRanksAhead: priorityDelta > 0,
          currentDaysToResolution: number(economics.daysToResolution),
          replacementDaysToResolution: candidateDays,
          currentRealizedPnlIfExitUsdc: realizedPnlIfExit,
          currentExitFeeUsdc: economics.exitFee,
          settlementLocked,
          upsideExhausted,
          candidateResolvesLater,
          currentRemainingDays: positionRemainingDays,
          nearMaximumWin: Boolean(economics.nearMaximumWin),
          currentSellPnlUsdc: economics.currentSellPnl,
          maximumWinPnlUsdc: economics.maximumWinPnl,
          winPnlGapUsdc: economics.winPnlGapUsdc,
          winPnlGapPct: economics.winPnlGapPct,
          remainingPotentialGainUsdc: economics.remainingPotentialGainUsdc,
          pendingResolutionReferenceAnnualizedReturn,
          usesPendingResolutionReference,
          settlementLockThresholdUsdc: ROTATION_PROTECT_REMAINING_GAIN_USDC,
          replacementExpectedValueUsdc: candidateEv,
          replacementCapitalBaseUsdc: rotationCapitalBase,
          replacementNetYield: number(revalidated.netYield),
          netProfitGuard,
        };
        const review = {
          position: baseReview,
          positionOrder: {
            tokenId: position.tokenId || position.assetId,
            assetId: position.assetId || position.tokenId,
            shares: number(position.shares ?? position.size),
            size: number(position.size ?? position.shares),
            currentPrice: number(position.currentPrice ?? position.markPrice ?? position.price),
            price: number(position.price ?? position.currentPrice ?? position.markPrice),
            market: position.market || position.conditionId || null,
            conditionId: position.conditionId || null,
            question: position.question || position.market || "",
            outcome: position.outcome || position.side || "",
            eventSlug: position.eventSlug || position.slug || "",
            slug: position.slug || position.eventSlug || "",
          },
          candidate: liveBatchCandidateSummary(revalidated),
          candidateTokenId: revalidated.tokenId || null,
          positionRank,
          priorityComparison,
          action: rotationPreferred ? "ROTATION_AVAILABLE" : "HOLD_CURRENT_POSITION",
          reason: rotationPreferred
            ? (upsideExhausted
              ? `this position is only $${Number(economics.remainingPotentialGainUsdc ?? 0).toFixed(4)} short of its maximum win, within the $${ROTATION_PROTECT_REMAINING_GAIN_USDC.toFixed(2)} threshold, so there is nothing left worth waiting for; release the capital instead of holding until settlement`
              : `after estimated exit fees and current P/L, ${candidatePriority.metric} improves by ${(priorityDelta * 100).toFixed(1)} pts; expected result changes by ${evDelta >= 0 ? "+" : ""}${evDelta.toFixed(4)} USDC`)
            : (!netProfitGuard.allowed
              ? `after the executable sell loss, the replacement would improve maximum net P/L by ${Number(netProfitGuard.maximumPnlDeltaUsdc ?? 0).toFixed(4)} USDC, below the required ${Number(netProfitGuard.requiredImprovementUsdc ?? 0).toFixed(4)} USDC`
              : candidateResolvesLater && !settlementLocked
              ? `this position resolves in ${Number(positionRemainingDays ?? 0).toFixed(2)} days and the replacement not until ${Number(candidateDays ?? 0).toFixed(2)} days, so selling now would forfeit a nearer payout for a more distant one; the candidate should still be available once this settles`
              : settlementLocked
              ? `resolution is already past and this position still has $${Number(economics.remainingPotentialGainUsdc ?? 0).toFixed(4)} to collect, above the $${ROTATION_PROTECT_REMAINING_GAIN_USDC.toFixed(2)} threshold, so it is held until it settles even though ${candidatePriority.metric} would look ${(priorityDelta * 100).toFixed(1)} pts better elsewhere`
              : `after estimated exit fees and current P/L, ${candidatePriority.metric} changes by ${(priorityDelta * 100).toFixed(1)} pts and expected result changes by ${evDelta.toFixed(4)} USDC; minimum improvement is ${(ROTATION_MIN_PRIORITY_IMPROVEMENT * 100).toFixed(1)} pts`),
          cashAfterExitUsdc: Number(cashAfterExit.toFixed(5)),
          evDeltaUsdc: Number(evDelta.toFixed(5)),
          annualizedDelta: Number(priorityDelta.toFixed(5)),
          currentAnnualizedReturn: Number(currentPriority.toFixed(5)),
          replacementAnnualizedReturn: Number(replacementPriority.toFixed(5)),
          rotatedAnnualizedReturn: Number(rotatedAnnualizedReturn.toFixed(5)),
          rotatedExpectedPnlUsdc: Number(rotatedExpectedPnl.toFixed(5)),
          holdExpectedPnlUsdc: Number(holdExpectedPnl.toFixed(5)),
          rejectedCandidates,
        };
        if (!bestForPosition
          || priorityDelta > bestForPosition.annualizedDelta
          || (priorityDelta === bestForPosition.annualizedDelta && evDelta > bestForPosition.evDeltaUsdc)) {
          bestForPosition = review;
        }
      } catch (error) {
        reviews.push({
          ...baseReview,
          action: "ROTATION_REVALIDATION_ERROR",
          reason: error?.message || String(error),
        });
      }
    }

    if (bestForPosition) {
      reviews.push(bestForPosition);
      if (bestForPosition.action === "ROTATION_AVAILABLE" && (!best
        || bestForPosition.positionRank < best.positionRank
        || (bestForPosition.positionRank === best.positionRank
          && (bestForPosition.annualizedDelta > best.annualizedDelta
            || (bestForPosition.annualizedDelta === best.annualizedDelta && bestForPosition.evDeltaUsdc > best.evDeltaUsdc))))) {
        best = bestForPosition;
      }
    } else {
      const rejectedReasons = [...new Set(rejectedCandidates
        .flatMap((candidate) => Array.isArray(candidate.rejectReasons) ? candidate.rejectReasons : [])
        .filter(Boolean))]
        .slice(0, 3)
        .join("; ");
      reviews.push({
        ...baseReview,
        action: "NO_BETTER_CANDIDATE_AFTER_EXIT",
        reason: rejectedReasons
          ? `no replacement passed fresh verification after exit: ${rejectedReasons}`
          : "no currently eligible candidate would become executable after selling this position",
        cashAfterExitUsdc: Number(cashAfterExit.toFixed(5)),
        rejectedCandidates,
      });
    }
  }

  return {
    action: best ? "ROTATION_AVAILABLE" : "NO_ROTATION_CANDIDATE",
    reason: best
      ? (restrictToRiskReplacement
        ? "a risk-blocked replacement becomes executable only after selling the overlapping live position"
        : "a better candidate can replace the weakest live position after the sell is confirmed and cash is synced")
      : "selling reviewed open positions did not produce a better executable candidate",
    reviews,
    best,
  };
}

function rotationOpportunityLabel(item = {}) {
  const outcome = String(item.outcome || item.side || "").trim();
  const question = String(item.question || item.market || "").trim();
  return [outcome, question].filter(Boolean).join(" - ") || "unnamed opportunity";
}

function rotationComparisonRows(rotationReview = null, openOrderReviews = []) {
  const rows = [];
  for (const review of Array.isArray(rotationReview?.reviews) ? rotationReview.reviews : []) {
    const position = review.position || {};
    const candidate = review.candidate || null;
    const comparison = review.priorityComparison || {};
    rows.push({
      kind: "position",
      action: review.action || null,
      reason: review.reason || null,
      current: {
        label: rotationOpportunityLabel(position),
        metricLabel: position.rotationPriorityMetric || comparison.metricLabel || returnMetricLabel(),
        metricValue: number(position.rotationPriorityValue),
        daysToResolution: number(comparison.currentDaysToResolution),
        potentialWinUsdc: number(position.potentialWinIfHeldUsdc),
        unrealizedPnlUsdc: number(position.unrealizedPnlUsdc),
        winPnlGapUsdc: number(position.winPnlGapUsdc),
        winPnlGapPct: number(position.winPnlGapPct),
        remainingPotentialGainUsdc: number(position.remainingPotentialGainUsdc),
        pendingResolutionReferenceAnnualizedReturn: number(position.pendingResolutionReferenceAnnualizedReturn),
        usesPendingResolutionReference: Boolean(position.usesPendingResolutionReference),
        settlementLocked: Boolean(position.settlementLocked),
        upsideExhausted: Boolean(position.upsideExhausted),
      },
      candidate: candidate ? {
        label: rotationOpportunityLabel(candidate),
        metricLabel: comparison.metricLabel || returnMetricLabel(),
        metricValue: number(comparison.replacementMetric),
        daysToResolution: number(comparison.replacementDaysToResolution),
        potentialWinUsdc: number(candidate.netGainIfWinUsdc),
      } : null,
      metricDelta: number(comparison.metricDelta),
      expectedValueDeltaUsdc: number(review.evDeltaUsdc),
      minimumImprovement: number(comparison.minimumImprovement, ROTATION_MIN_PRIORITY_IMPROVEMENT),
    });
  }
  for (const review of Array.isArray(openOrderReviews) ? openOrderReviews : []) {
    const current = review.currentEvaluation || null;
    const candidate = review.betterCandidate || null;
    const comparison = review.selectionComparison || {};
    if (!current && !candidate) continue;
    rows.push({
      kind: "order",
      action: review.action || null,
      reason: review.reason || null,
      current: current ? {
        label: rotationOpportunityLabel(current),
        metricLabel: comparison.metricLabel || returnMetricLabel(),
        metricValue: number(comparison.currentMetric),
        daysToResolution: number(comparison.currentDaysToResolution),
        potentialWinUsdc: number(current.netGainIfWinUsdc),
      } : null,
      candidate: candidate ? {
        label: rotationOpportunityLabel(candidate),
        metricLabel: comparison.metricLabel || returnMetricLabel(),
        metricValue: number(comparison.replacementMetric),
        daysToResolution: number(comparison.replacementDaysToResolution),
        potentialWinUsdc: number(candidate.netGainIfWinUsdc),
      } : null,
      metricDelta: number(comparison.metricDelta),
      expectedValueDeltaUsdc: number(comparison.expectedValueDelta),
      minimumImprovement: ROTATION_MIN_PRIORITY_IMPROVEMENT,
    });
  }
  return rows;
}

function rotationHumanComparison(review) {
  const comparison = review?.priorityComparison;
  const position = review?.position;
  const candidate = review?.candidate;
  if (!comparison || !position || !candidate) return "";
  const metric = comparison.metricLabel || returnMetricLabel();
  const formatMetric = (value) => metric === "R/R"
    ? `${Number(value || 0).toFixed(2)}:1`
    : `${(Number(value || 0) * 100).toFixed(1)}%`;
  const formatDelta = (value) => {
    const numeric = Number(value || 0);
    return `${numeric >= 0 ? "+" : ""}${formatMetric(numeric)}`;
  };
  const days = (value) => Number.isFinite(Number(value)) ? `${Number(value).toFixed(2)}d` : "-";
  if (comparison.settlementLocked) {
    return `Hold ${rotationOpportunityLabel(position)} (resolution already past, current sell P/L ${Number(comparison.currentSellPnlUsdc || 0).toFixed(4)} USDC vs maximum win ${Number(comparison.maximumWinPnlUsdc || 0).toFixed(4)} USDC) because it still has ${Number(comparison.remainingPotentialGainUsdc || 0).toFixed(4)} USDC to collect, above the ${Number(comparison.settlementLockThresholdUsdc || 0).toFixed(2)} USDC threshold. ${rotationOpportunityLabel(candidate)} is not taken even though it shows ${formatMetric(comparison.replacementMetric)}.`;
  }
  if (comparison.upsideExhausted) {
    return `Close ${rotationOpportunityLabel(position)} now (${days(comparison.currentDaysToResolution)}, only ${Number(comparison.remainingPotentialGainUsdc || 0).toFixed(4)} USDC short of its maximum win) and replace it with ${rotationOpportunityLabel(candidate)} (${formatMetric(comparison.replacementMetric)}, ${days(comparison.replacementDaysToResolution)}, potential win ${Number(candidate.netGainIfWinUsdc || 0).toFixed(4)} USDC); there is nothing left worth waiting for.`;
  }
  return `Replace ${rotationOpportunityLabel(position)} (${formatMetric(comparison.currentMetric)}, ${days(comparison.currentDaysToResolution)}, potential win ${Number(position.potentialWinIfHeldUsdc || 0).toFixed(4)} USDC) with ${rotationOpportunityLabel(candidate)} (${formatMetric(comparison.replacementMetric)}, ${days(comparison.replacementDaysToResolution)}, potential win ${Number(candidate.netGainIfWinUsdc || 0).toFixed(4)} USDC); after fees the ${metric} improvement is ${formatDelta(comparison.metricDelta)} and expected P/L changes by ${Number(review.evDeltaUsdc || 0).toFixed(4)} USDC.`;
}

function scoreEconomics({ probability, qualificationProbability, returnYield, netYield, edge, spread, volume24hr, volumeUsdc, liquidity }) {
  const probabilityOk = qualificationProbability >= MIN_PROBABILITY
    && (MAX_PROBABILITY == null || qualificationProbability <= MAX_PROBABILITY);
  const opportunityOk = probability >= OPPORTUNITY_MIN_PROBABILITY
    && edge >= OPPORTUNITY_MIN_EDGE
    && returnYield > 0;
  const returnOk = Number.isFinite(returnYield) && returnYield > 0;
  const netYieldOk = Number.isFinite(netYield) && netYield >= MIN_NET_YIELD;
  const spreadOk = spread != null && spread <= MAX_SPREAD;
  // `minLiquidityUsdc` is a portfolio liquidity floor.  24h volume is useful
  // context but must not substitute for executable order-book liquidity.
  // The portfolio floor is a traded-volume floor, matching the figure Polymarket shows.
  const candidateVolume = candidateVolumeUsdc({ volumeUsdc, volume24hr, liquidity });
  const liquidityOk = candidateVolume >= MIN_VOLUME_24H;
  return {
    eligible: probabilityOk && returnOk && netYieldOk && spreadOk && liquidityOk,
    thesisType: probabilityOk ? "HIGH_CONFIDENCE" : (opportunityOk ? "EDGE_OPPORTUNITY_BELOW_LIVE_THRESHOLD" : "REJECTED"),
    rejectReasons: [
      probabilityOk ? null : (qualificationProbability < MIN_PROBABILITY
        ? `${probabilitySourceLabel()} ${(qualificationProbability * 100).toFixed(1)}% below live threshold ${(MIN_PROBABILITY * 100).toFixed(1)}%`
        : `${probabilitySourceLabel()} ${(qualificationProbability * 100).toFixed(1)}% above live maximum ${(MAX_PROBABILITY * 100).toFixed(1)}%`),
      returnOk ? null : `${probabilitySourceLabel()} net return is non-profitable after fees`,
      netYieldOk ? null : `net profit ${Number.isFinite(netYield) ? `${(netYield * 100).toFixed(1)}%` : "-"} below ${(MIN_NET_YIELD * 100).toFixed(1)}% after fees`,
      spreadOk ? null : `spread ${spread == null ? "n/a" : (spread * 100).toFixed(1) + " pts"} too wide`,
      liquidityOk ? null : `volume ${candidateVolume.toFixed(2)} USDC below live minimum ${MIN_VOLUME_24H.toFixed(2)} USDC`,
    ].filter(Boolean),
  };
}

// Whether the price that will actually be submitted sits inside the portfolio's
// probability band, and if not, why. Returns null when the price is fine.
//
// The band is a rule about what this portfolio enters at, but qualification checks it
// against the market probability -- Gamma's outcome price, or the midpoint of the book --
// while a post-only limit rests at the best bid. Those two numbers separate by the spread,
// so the rule was being applied to a different number from the one the order carried.
//
// Reported, and reproduced from the live configuration: with the band at 70-85 and
// LIVE_MAX_SPREAD at 8 points, a market qualifying at exactly 70 rests its bid at 67 and
// opens a position three points under the floor the portfolio advertises. A taker entry
// has the same fault mirrored, paying an ask that can sit above the ceiling. Nothing
// downstream catches it: the performance report buckets a trade by its entry price, so the
// portfolio's own report would file trades in bands it says it does not trade.
//
// The paper bot has always had this right -- portfolioProbabilityForStrategy() returns the
// best bid for a limit-order portfolio, so its band is checked against the real entry --
// which is why the two behaved differently on identical settings. This restores the parity.
//
// The price is deliberately not clamped up to the floor instead: raising a bid to satisfy a
// label spends more real money for the same position, and a rejection is reversible where a
// filled order is not.
function orderPriceBandRejection(price, { min, max = null, spread = null } = {}) {
  const entry = validProbability(price);
  const floor = Number(min);
  if (!Number.isFinite(floor)) return null;
  const ceiling = max == null ? null : Number(max);
  const withinFloor = entry != null && entry >= floor;
  const withinCeiling = entry != null && (ceiling == null || !Number.isFinite(ceiling) || entry <= ceiling);
  if (withinFloor && withinCeiling) return null;
  const band = ceiling == null || !Number.isFinite(ceiling)
    ? `at least ${(floor * 100).toFixed(1)}%`
    : `${(floor * 100).toFixed(1)}-${(ceiling * 100).toFixed(1)}%`;
  const shown = entry == null ? "-" : `${(entry * 100).toFixed(1)}%`;
  const spreadNote = Number.isFinite(Number(spread))
    ? ` on a ${(Number(spread) * 100).toFixed(1)}-point spread`
    : "";
  return `order price ${shown}${spreadNote} is outside the portfolio band ${band}`;
}

function orderPriceForBook(book, tick, { forceTakerEntry = false } = {}) {
  // Completing a rotation buys what the sell leg already paid for, so it takes the ask
  // instead of resting under it. Resting here is what left the swap half-done.
  if (!USE_LIMIT_ORDERS || ROTATION_ENTRY_CROSSES_SPREAD || forceTakerEntry) return book.bestAsk;
  if (book.bestBid != null && book.bestAsk != null && book.bestBid < book.bestAsk) return roundToTick(book.bestBid, tick, "down");
  if (book.bestAsk != null) return roundToTick(book.bestAsk - tick, tick, "down");
  return null;
}

function sharesForOrder({ price, minOrderSize, maxNotional, cash, feeRate = 0, forceTakerEntry = false }) {
  const targetStake = Math.max(0, number(maxNotional, 0));
  const availableCash = Math.max(0, number(cash, 0));
  const takerEntry = ROTATION_ENTRY_CROSSES_SPREAD || forceTakerEntry;
  const appliedFeeRate = USE_LIMIT_ORDERS && POST_ONLY && !takerEntry ? 0 : Math.max(0, number(feeRate, 0));
  const costPerShare = price * (1 + appliedFeeRate * (1 - price));
  const minNotional = price * minOrderSize;
  const minimumOrderFee = appliedFeeRate > 0 ? takerFee(minOrderSize, price, appliedFeeRate) : 0;
  const minimumOrderCost = minNotional + minimumOrderFee;
  const cashBelowExchangeMinimum = minimumOrderCost > 0
    && availableCash + 0.000001 < minimumOrderCost;
  // Derived from this market, not configured: exactly what `mos` shares cost at the
  // current price including the taker fee at that size. Applied only when free cash
  // actually covers it, so a genuine cash shortfall still goes to rotation review,
  // and only up to the ceiling, so an unusual `mos` cannot run away with the stake.
  const stakeFloorUsdc = minimumOrderCost > 0 && minimumOrderCost <= MIN_ORDER_STAKE_CEILING_USDC
    ? minimumOrderCost
    : 0;
  const stakeFloorApplied = stakeFloorUsdc > 0
    && targetStake + 0.000001 < stakeFloorUsdc
    && availableCash + 0.000001 >= stakeFloorUsdc;
  const effectiveStake = stakeFloorApplied ? stakeFloorUsdc : targetStake;
  // The portfolio percentage caps the cash committed, not the potential payout.
  // For taker orders, reserve the estimated fee inside that cap as well.
  const usableStake = Math.min(effectiveStake, availableCash);
  const stakeCapBelowExchangeMinimum = minimumOrderCost > 0
    && !cashBelowExchangeMinimum
    && !stakeFloorApplied
    && targetStake + 0.000001 < minimumOrderCost;
  let size = costPerShare > 0
    ? Math.floor((usableStake / costPerShare) * 10000) / 10000
    : 0;
  while (size > 0) {
    const notional = price * size;
    const fee = appliedFeeRate > 0 ? takerFee(size, price, appliedFeeRate) : 0;
    if (notional + fee <= usableStake + 0.000001) break;
    size = Math.max(0, Number((size - 0.0001).toFixed(4)));
  }
  const belowExchangeMinimum = size > 0 && size + 0.000001 < minOrderSize;
  const orderNotional = size > 0 ? price * size : 0;
  const makerPrecisionBlocked = USE_LIMIT_ORDERS && POST_ONLY && !takerEntry && size > 0 && orderNotional < 0.01 - 0.000001;

  return {
    size: size > 0 ? Number(size.toFixed(4)) : null,
    targetStake,
    effectiveStake,
    stakeFloorUsdc,
    stakeFloorApplied,
    stakeFloorCeilingUsdc: MIN_ORDER_STAKE_CEILING_USDC,
    availableCash,
    usableStake,
    minNotional,
    minimumOrderCost,
    orderNotional,
    makerPrecisionBlocked,
    // `mos` is an exchange acceptance requirement, not merely a display
    // hint. Only a genuine free-cash shortfall can justify rotating another
    // order or position; a configured stake cap must never be misreported as
    // unavailable cash.
    minimumFundingBlocked: cashBelowExchangeMinimum || stakeCapBelowExchangeMinimum || makerPrecisionBlocked || belowExchangeMinimum,
    cashBelowExchangeMinimum,
    stakeCapBelowExchangeMinimum,
    minSizeOverride: belowExchangeMinimum,
    sizingNote: size <= 0
      ? "no available cash for a positive stake"
      : (belowExchangeMinimum
        ? `sized to the available ${usableStake.toFixed(4)} USDC stake (below the displayed ${minOrderSize.toFixed(4)}-share exchange minimum; submission will verify acceptance)`
        : (stakeFloorApplied
          ? `raised from the configured ${targetStake.toFixed(4)} USDC stake to this market's ${stakeFloorUsdc.toFixed(4)} USDC minimum (${minOrderSize.toFixed(4)} shares at ${price.toFixed(4)}), which free cash covers`
          : (usableStake < targetStake
            ? "sized from available cash below the configured portfolio stake"
            : "sized from the configured portfolio stake"))),
  };
}

function livePortfolioValue(liveState, cash) {
  const portfolio = liveState?.portfolio || {};
  const equity = number(portfolio.equityUsdc);
  const openPnl = number(portfolio.openPnlUsdc, 0);
  if (equity != null && equity > 0) return Math.max(0, equity - openPnl);
  const marketValue = number(portfolio.marketValueUsdc, 0);
  if (cash != null && cash >= 0) return cash + marketValue;
  return marketValue;
}

async function revalidateEvaluation(
  evaluation,
  liveState,
  cash,
  maxNotional,
  evaluationByToken = new Map(),
  { forceTakerEntry = false } = {},
) {
  const market = await fetchMarket(evaluation);
  // Gamma knows this token neither by its id nor by its slug. Short-dated markets --
  // esports "Game 2 Winner"/"Map 2 Winner" legs especially -- are delisted once they
  // settle, so this is a market that no longer exists rather than one that failed a
  // threshold. `marketGone` marks it terminal so the stored row is closed out instead
  // of being re-fetched and re-rejected on every run for as long as it is retained.
  if (!market) {
    return {
      candidate: evaluation,
      eligible: false,
      marketGone: true,
      rejectReasons: ["market no longer listed in Gamma by token id or slug; treated as closed"],
    };
  }
  const outcomes = parseJsonField(market.outcomes).map(String);
  const tokenIds = parseJsonField(market.clobTokenIds).map(String);
  const tokenIndex = tokenIds.findIndex((tokenId) => tokenId === String(evaluation.tokenId || ""));
  if (tokenIndex < 0) {
    return {
      candidate: evaluation,
      eligible: false,
      marketGone: true,
      rejectReasons: ["token no longer belongs to Gamma market"],
    };
  }
  if (market.closed || market.active === false || market.acceptingOrders === false) {
    return {
      candidate: evaluation,
      eligible: false,
      marketGone: true,
      rejectReasons: ["market is not accepting orders"],
    };
  }

  const dateContext = marketDateContext({
    ...market,
    resolutionEndDate: market.endDate || evaluation.resolutionEndDate || evaluation.endDate || null,
  });
  // A scheduled date is display metadata only. The terminal checks above are
  // authoritative: a market may be traded while it is active and accepting
  // orders, even when Gamma's date is already in the past or missing.
  const awaitingResolutionWhileTradable = false;

  const clobMarket = await fetchClobMarket(market.conditionId).catch(() => null);
  const book = bestBook(await fetchJson(new URL(`/book?token_id=${evaluation.tokenId}`, CLOB_HOST), `CLOB book ${evaluation.tokenId}`));
  const tick = number(clobMarket?.mts ?? market.orderPriceMinTickSize ?? evaluation.tickSize, 0.01);
  const minOrderSize = number(clobMarket?.mos, 5);
  const takerEntry = ROTATION_ENTRY_CROSSES_SPREAD || forceTakerEntry;
  const price = orderPriceForBook(book, tick, { forceTakerEntry });
  if (!Number.isFinite(price) || price <= 0 || price >= 1) {
    return { candidate: evaluation, eligible: false, rejectReasons: ["no valid current entry price"] };
  }
  if (USE_LIMIT_ORDERS && POST_ONLY && !takerEntry && book.bestAsk != null && price >= book.bestAsk) {
    return { candidate: evaluation, eligible: false, rejectReasons: ["post-only limit would cross current ask"] };
  }
  // The probability band is a rule about what this portfolio enters at, and `price` is
  // what it would actually enter at -- which is not the number the band was checked
  // against. Qualification below uses the market probability: Gamma's outcome price, or
  // the midpoint of the book. A post-only limit rests at the best bid instead, and those
  // two numbers separate by the spread.
  //
  // Reported, and reproduced from the live configuration: with the band at 70-85 and
  // LIVE_MAX_SPREAD at 8 points, a market qualifying at exactly 70 can rest its bid at 67
  // and open a position three points under the floor the portfolio advertises. A taker
  // entry has the same fault mirrored -- it pays the ask, which can sit above the ceiling.
  // Nothing downstream catches it either: the performance report buckets a trade by its
  // entry price, so the portfolio's own report would file trades in bands it says it does
  // not trade.
  //
  // So the price that will really be submitted is checked against the same band. It is
  // deliberately not clamped up to the floor instead: raising a bid to satisfy a label
  // spends more real money for the same position, and a rejection is reversible where a
  // filled order is not.
  // A book too wide to trade is rejected for its spread, further down, by the one rule
  // that owns that limit. This check stands aside for it rather than answering first:
  // measured on a live run, the two candidates that reached here had spreads of 25 and 14
  // points against an 8-point limit, and both were reported as "outside the portfolio
  // band" -- true, but the band is a symptom of the spread and naming it sent the reader
  // after the wrong setting. The band rejection is for a book this portfolio would
  // otherwise trade, where the price really is the disqualifier.
  const spreadWithinLimit = Number.isFinite(Number(book.spread)) && Number(book.spread) <= MAX_SPREAD;
  const outOfBand = spreadWithinLimit
    ? orderPriceBandRejection(price, {
      min: MIN_PROBABILITY,
      max: MAX_PROBABILITY,
      spread: book.spread,
    })
    : null;
  if (outOfBand) {
    return {
      candidate: evaluation,
      eligible: false,
      status: "REJECTED",
      rejectReasons: [outOfBand],
      currentPrice: price,
      currentBestBid: book.bestBid,
      currentBestAsk: book.bestAsk,
      currentSpread: book.spread,
      minOrderSize,
    };
  }

  const estimatedFeeRate = feeRateForEvaluation(evaluation);
  const orderSizing = sharesForOrder({
    price,
    minOrderSize,
    maxNotional,
    cash,
    feeRate: estimatedFeeRate,
    forceTakerEntry,
  });
  const size = orderSizing.size;
  if (!Number.isFinite(size) || orderSizing.minimumFundingBlocked) {
    const minimumCost = Number(orderSizing.minimumOrderCost || orderSizing.minNotional || 0);
    const availableCash = Number(orderSizing.availableCash || 0);
    const targetStake = Number(orderSizing.targetStake || 0);
    const executionBlocker = orderSizing.cashBelowExchangeMinimum
      ? "CASH"
      : (orderSizing.stakeCapBelowExchangeMinimum
        ? "STAKE_CAP"
        : (orderSizing.makerPrecisionBlocked ? "MAKER_PRECISION" : "ORDER_SIZE"));
    const reason = orderSizing.cashBelowExchangeMinimum
      ? "Polymarket minimum order " + minOrderSize.toFixed(4) + " shares costs " + minimumCost.toFixed(4)
        + " USDC including fees, above the " + availableCash.toFixed(4)
        + " USDC available; rotation may release capital"
      : (orderSizing.stakeCapBelowExchangeMinimum
        ? "Polymarket minimum order " + minOrderSize.toFixed(4) + " shares costs " + minimumCost.toFixed(4) + " USDC, above this portfolio's fixed stake " + targetStake.toFixed(4) + " USDC and above the " + Number(orderSizing.stakeFloorCeilingUsdc || 0).toFixed(2) + " USDC stake-floor ceiling, so the stake was not raised to meet it; " + availableCash.toFixed(4) + " USDC remains free, so rotation is not needed"
        : (orderSizing.makerPrecisionBlocked
          ? "configured stake would produce a sub-cent maker amount; changing the stake or order mode is required"
          : (minimumCost > 0
            ? "minimum order " + minOrderSize.toFixed(4) + " shares costs " + minimumCost.toFixed(4) + " USDC, above the current executable stake"
            : orderSizing.sizingNote)));
    return {
      candidate: evaluation,
      eligible: false,
      rejectReasons: [reason],
      executionBlocker,
      currentPrice: price,
      minOrderSize,
      minOrderNotionalUsdc: Number(minimumCost.toFixed(5)),
    };
  }

  const tags = Array.isArray(evaluation.tags) && evaluation.tags.length ? evaluation.tags : tagQuestion(market.question || evaluation.question);
  const risk = riskProfile({
    question: market.question || evaluation.question,
    slug: market.slug || evaluation.slug,
    eventSlug: marketEventSlug(market),
    outcome: outcomes[tokenIndex] || evaluation.outcome,
    tags,
  });
  const block = riskBlock({ ...evaluation, riskGroupKeys: risk.keys }, liveState, evaluationByToken);
  if (block) {
    return {
      candidate: evaluation,
      eligible: false,
      rejectReasons: [`${block.reason}: ${block.overlap.join(", ")}`],
      currentPrice: price,
      minOrderSize,
    };
  }

  const aiProbability = number(evaluation.aiProbability);
  const marketProbability = marketProbabilityForToken(market, tokenIndex, book, evaluation.marketProbability ?? evaluation.marketPrice ?? price);
  if (marketProbability != null && marketProbability >= EFFECTIVELY_CERTAIN_MARKET_PROBABILITY) {
    return {
      candidate: evaluation,
      eligible: false,
      status: "REJECTED",
      rejectReasons: ["current market probability rounds to 100.0%; no executable upside remains"],
      currentPrice: price,
      marketProbability,
      minOrderSize,
    };
  }
  const probability = PROBABILITY_SOURCE === "polymarket" ? marketProbability : aiProbability;
  if (!Number.isFinite(probability)) {
    return {
      candidate: evaluation,
      eligible: false,
      rejectReasons: [`missing ${probabilitySourceLabel().toLowerCase()} required for EV calculation`],
      currentPrice: price,
      minOrderSize,
    };
  }
  const qualificationProbability = probability;
  const marketType = candidateMarketType({
    ...evaluation,
    question: market.question || evaluation.question,
    eventSlug: marketEventSlug(market) || evaluation.eventSlug,
    outcome: outcomes[tokenIndex] || evaluation.outcome,
  });
  if (PORTFOLIO_MARKET_TYPE !== "all" && marketType !== PORTFOLIO_MARKET_TYPE) {
    return {
      candidate: evaluation,
      eligible: false,
      status: "REJECTED",
      rejectReasons: [`current market type ${marketType} does not match live portfolio market type ${PORTFOLIO_MARKET_TYPE}`],
      currentPrice: price,
      marketProbability,
      minOrderSize,
    };
  }
  if (EXCLUDE_OVER_UNDER_MARKETS && isOverUnderMarket({
    ...evaluation,
    question: market.question || evaluation.question,
    eventSlug: marketEventSlug(market) || evaluation.eventSlug,
    outcome: outcomes[tokenIndex] || evaluation.outcome,
  })) {
    return {
      candidate: evaluation,
      eligible: false,
      status: "REJECTED",
      rejectReasons: ["current market is Over/Under and is excluded by this live portfolio"],
      currentPrice: price,
      marketProbability,
      minOrderSize,
    };
  }
  const endDate = dateContext.endDate;
  const days = daysToEnd(endDate);
  const volume24hr = number(market.volume24hr, number(evaluation.volume24hr, 0));
  const liquidity = number(market.liquidity, number(evaluation.liquidity, 0));
  // Traded volume as Polymarket reports it, refreshed from the live market so the stored
  // row stops showing a figure captured whenever it was last scraped.
  const volumeUsdc = number(market.volumeNum, number(market.volume, volume24hr));
  const notional = Number((price * size).toFixed(5));
  const fee = USE_LIMIT_ORDERS && POST_ONLY && !takerEntry ? 0 : takerFee(size, price, estimatedFeeRate);
  const totalCost = notional + fee;
  const expectedValue = Number.isFinite(aiProbability) ? aiProbability * size - notional - fee : null;
  const expectedRoi = Number.isFinite(expectedValue) && totalCost > 0 ? expectedValue / totalCost : null;
  const annualizedReturn = Number.isFinite(expectedRoi) ? annualizeReturn(expectedRoi, days) : null;
  const marketExpectedValue = marketProbability * size - notional - fee;
  const marketExpectedRoi = totalCost > 0 ? marketExpectedValue / totalCost : 0;
  const marketAnnualizedReturn = annualizeReturn(marketExpectedRoi, days);
  const netGainIfWin = size - notional - fee;
  const potentialRoi = totalCost > 0 ? netGainIfWin / totalCost : null;
  const potentialAnnualizedReturn = Number.isFinite(potentialRoi)
    ? annualizeReturn(potentialRoi, days)
    : null;
  const selectedExpectedValueUsdc = PROBABILITY_SOURCE === "polymarket" ? netGainIfWin : expectedValue;
  const selectedAnnualizedReturn = PROBABILITY_SOURCE === "polymarket" ? potentialAnnualizedReturn : annualizedReturn;
  const selectedReturnYield = PROBABILITY_SOURCE === "polymarket" ? potentialRoi : expectedRoi;
  const edge = Number.isFinite(aiProbability) ? aiProbability - price : marketProbability - price;
  const scored = scoreEconomics({
    probability: qualificationProbability,
    qualificationProbability,
    returnYield: selectedReturnYield,
    netYield: potentialRoi,
    edge: qualificationProbability - price,
    spread: book.spread,
    volume24hr,
    volumeUsdc,
    liquidity,
  });
  if (!Number.isFinite(selectedExpectedValueUsdc) || selectedExpectedValueUsdc <= 0 || !Number.isFinite(selectedReturnYield) || selectedReturnYield <= 0) {
    return {
      candidate: evaluation,
      eligible: false,
      rejectReasons: [`current ${returnMetricLabel()} is non-profitable after fees`],
      currentPrice: price,
      minOrderSize,
    };
  }

  return {
    ...evaluation,
    revalidatedAt: new Date().toISOString(),
    status: scored.eligible ? "ELIGIBLE" : "REJECTED",
    thesisType: scored.thesisType,
    rejectReasons: scored.rejectReasons,
    question: market.question || evaluation.question,
    slug: market.slug || evaluation.slug,
    eventSlug: marketEventSlug(market),
    outcome: outcomes[tokenIndex] || evaluation.outcome,
    marketType,
    endDate,
    scheduledEventDate: dateContext.scheduledEventDate,
    resolutionEndDate: dateContext.resolutionEndDate,
    endDateSource: dateContext.endDateSource,
    volumeUsdc: Number(volumeUsdc.toFixed(2)),
    currentBestBid: book.bestBid,
    currentBestAsk: book.bestAsk,
    currentSpread: book.spread,
    marketPrice: Number(price.toFixed(4)),
    orderPrice: Number(price.toFixed(4)),
    orderSize: Number(size.toFixed(4)),
    orderNotionalUsdc: notional,
    targetStakeUsdc: Number(orderSizing.targetStake.toFixed(5)),
    appliedStakeUsdc: Number(orderSizing.usableStake.toFixed(5)),
    minOrderSize,
    minOrderNotionalUsdc: Number(orderSizing.minNotional.toFixed(5)),
    maxNotionalBeforeMinimumOverrideUsdc: maxNotional,
    minSizeOverride: orderSizing.minSizeOverride,
    sizingNote: orderSizing.sizingNote,
    tickSize: tick,
    // Gamma may omit it; unknown must stay unknown so the CLOB gets asked.
    negRisk: typeof market.negRisk === "boolean" ? market.negRisk : undefined,
    aiProbability: Number.isFinite(aiProbability) ? Number(aiProbability.toFixed(4)) : null,
    marketProbability: Number(marketProbability.toFixed(4)),
    edge: Number(edge.toFixed(4)),
    daysToResolution: days == null ? null : Number(days.toFixed(2)),
    awaitingResolutionWhileTradable,
    expectedValueUsdc: Number(selectedExpectedValueUsdc.toFixed(4)),
    annualizedReturn: Number.isFinite(selectedAnnualizedReturn) ? Number(selectedAnnualizedReturn.toFixed(4)) : null,
    aiExpectedValueUsdc: Number.isFinite(expectedValue) ? Number(expectedValue.toFixed(4)) : null,
    aiAnnualizedReturn: Number.isFinite(annualizedReturn) ? Number(annualizedReturn.toFixed(4)) : null,
    marketExpectedValueUsdc: Number(marketExpectedValue.toFixed(4)),
    marketAnnualizedReturn: Number(marketAnnualizedReturn.toFixed(4)),
    potentialAnnualizedReturn: Number.isFinite(potentialAnnualizedReturn) ? Number(potentialAnnualizedReturn.toFixed(4)) : null,
    netGainIfWinUsdc: Number(netGainIfWin.toFixed(4)),
    netYield: Number.isFinite(potentialRoi) ? Number(potentialRoi.toFixed(6)) : null,
    riskReward: Number.isFinite(potentialRoi) ? Number(potentialRoi.toFixed(6)) : null,
    totalCostUsdc: Number(totalCost.toFixed(5)),
    tradingFeeUsdc: Number(fee.toFixed(5)),
    feeMode: USE_LIMIT_ORDERS && POST_ONLY && !takerEntry ? "post-only maker fee assumed 0" : "taker fee estimate",
    orderType: USE_LIMIT_ORDERS && !takerEntry ? "GTC" : "FAK",
    riskGroupKeys: risk.keys,
    riskGroupLabels: risk.labels,
    score: Number((selectedReturnYield + (PROBABILITY_SOURCE === "polymarket" ? qualificationProbability - price : edge)).toFixed(6)),
  };
}

// The stored run-log entry is history, retained for up to 160 runs. Spreading the
// whole batchLog into it duplicated `revalidatedCandidates` -- every candidate the
// run touched, unbounded now that a manual shortlist of ~120 rows is no longer
// discarded on one stale id -- into every one of those 160 stored entries. That is
// what made the published live-execution-state.json and this script's own console
// output balloon far past a size any log reader, human or otherwise, could fetch
// in one request. topCandidates and topRejected are already capped and cover the
// same ground for a past run's "Candidates not used" view (tradeBatchDetail() in
// the frontend already falls back to them when revalidatedCandidates is absent).
function compactLiveRunRecord(batchLog = {}) {
  const { revalidatedCandidates, ...rest } = batchLog;
  // Capped at 20 per run, but that is still 20 candidate summaries repeated across
  // every one of 160 stored runs -- the same shape of duplication as
  // revalidatedCandidates, just with a smaller cap. topCandidates/topRejected already
  // cover what a past run's shortlist looked like.
  if (rest.prevalidationFilter && "executionShortlist" in rest.prevalidationFilter) {
    const { executionShortlist, ...prevalidationRest } = rest.prevalidationFilter;
    return { ...rest, prevalidationFilter: prevalidationRest };
  }
  return rest;
}

// Closing a position and opening its replacement is one decision, so it belongs in
// one row. Recording it as two left the sell as a separate entry that shared the
// buy's identity and lost the dedupe, so the sell simply vanished from the run log
// -- the opposite of what an audit trail is for.
//
// The merged row deliberately keeps THIS pass's id and time. The dashboard also
// renders the top-level state as a row and dedupes it against the run log by
// batchLog id, so giving the merged row the sell's id would make it a second,
// losing row and the sell would disappear exactly as before.
function rotationLegMerge({ completionRun, previousState, exitEntry, runEntry, payload }) {
  if (!completionRun || !exitEntry) return null;
  if (!ROTATION_EXIT_ACTIONS.has(String(previousState?.action || "").toUpperCase())) return null;
  return {
    action: "ROTATED",
    reason: `${previousState.reason || "rotation exit accepted"}; ${payload?.reason || payload?.action || "replacement handled"}`,
    rotationExit: previousState.rotationExit || exitEntry.rotationExit || null,
    // Sell first, then buy -- the order they happened in.
    attempts: [...(exitEntry.attempts || []), ...(runEntry?.attempts || [])],
  };
}

// A revalidation returns a rich row when it priced the market, and a thin
// {candidate, rejectReasons} one when it gave up early -- and it gives up early for
// reasons that only bind at the market price, such as "non-profitable after fees",
// which says nothing about a bid resting at half of it. So read through to the
// stored evaluation rather than treating an early return as a candidate with no
// facts, which is what left a 300-candidate scan with nothing to bid on.
// Gamma returns tags both as plain strings and as {label,slug} objects, and a market
// carries them under more than one field depending on which pass recorded it.
function marketTagSlugs(row = {}) {
  const source = row.candidate || {};
  const lists = [row.polymarketTags, row.tags, row.firstTags, source.polymarketTags, source.tags, source.firstTags];
  const slugs = new Set();
  for (const list of lists) {
    for (const raw of (Array.isArray(list) ? list : [])) {
      const text = String(raw && typeof raw === "object" ? (raw.slug || raw.label || raw.name || "") : (raw ?? ""))
        .trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
      if (text) slugs.add(text);
    }
  }
  for (const key of [row.riskCategory, source.riskCategory, row.category, source.category]) {
    const text = String(key || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
    if (text) slugs.add(text);
  }
  return slugs;
}

function marketTagIsAllowed(row = {}) {
  if (!FIXED_ENTRY_ALLOWED_TAGS.size) return true;
  const slugs = marketTagSlugs(row);
  for (const tag of FIXED_ENTRY_ALLOWED_TAGS) {
    if (slugs.has(tag)) return true;
  }
  return false;
}

function marketMatchesIncludeOnlyTags(row = {}) {
  if (!INCLUDE_ONLY_MARKET_TAGS.size) return true;
  const slugs = marketTagSlugs(row);
  return [...INCLUDE_ONLY_MARKET_TAGS].some((tag) => slugs.has(tag));
}

// Which of the portfolio's excluded tags this market carries, so a rejection can name
// the tag that caused it rather than only that one did.
function excludedMarketTagsOn(row = {}) {
  if (!EXCLUDED_MARKET_TAGS.size) return [];
  const slugs = marketTagSlugs(row);
  return [...EXCLUDED_MARKET_TAGS].filter((tag) => slugs.has(tag));
}

function fixedEntryRowFacts(row = {}) {
  const source = row.candidate || {};
  const pick = (key) => (row[key] != null ? row[key] : source[key]);
  const negRisk = pick("negRisk");
  return {
    tokenId: String(pick("tokenId") || ""),
    question: pick("question") || "",
    outcome: pick("outcome") || "",
    slug: pick("slug") || "",
    eventSlug: pick("eventSlug") || "",
    conditionId: pick("conditionId") || null,
    endDate: pick("endDate") || null,
    daysToResolution: number(pick("daysToResolution")),
    marketProbability: number(pick("marketProbability") ?? pick("marketPrice")),
    currentBestAsk: number(row.currentBestAsk ?? row.currentPrice ?? pick("marketPrice")),
    tickSize: number(pick("tickSize"), 0.01),
    minOrderSize: number(pick("minOrderSize"), 5),
    negRisk: typeof negRisk === "boolean" ? negRisk : undefined,
  };
}

// Reshape those facts into an order resting at the fixed entry price. The
// revalidation sized it against the current ask and the free cash; neither applies
// here, so only the market facts are kept -- tick size, neg risk, the exchange
// minimum -- and the price and size are rebuilt from the strategy.
function fixedEntryOrder(row, { price = FIXED_ENTRY_PRICE, stakeUsdc = FIXED_ENTRY_STAKE_USDC } = {}) {
  const tickSize = number(row.tickSize, 0.01);
  const limitPrice = roundToTick(price, tickSize, "down");
  if (!Number.isFinite(limitPrice) || limitPrice <= 0 || limitPrice >= 1) return null;
  const minOrderSize = number(row.minOrderSize, 5) ?? 5;
  const wanted = stakeUsdc > 0 ? Math.floor(stakeUsdc / limitPrice) : 0;
  let size = Math.max(minOrderSize, wanted);
  // Polymarket rejects a maker amount with more than two decimals, and price * size
  // is that amount. Round the size up until it lands on a clean cent.
  if (!hasTwoDecimalMakerAmount(limitPrice, size)) {
    const cents = Math.ceil(limitPrice * size * 100) / 100;
    size = Number((cents / limitPrice).toFixed(4));
  }
  const notional = Number((limitPrice * size).toFixed(5));
  return {
    ...row,
    orderPrice: limitPrice,
    orderSize: Number(size.toFixed(4)),
    orderNotionalUsdc: notional,
    totalCostUsdc: notional,
    orderType: "GTC",
    fixedEntryPrice: limitPrice,
  };
}

async function runFixedEntryBatch({ checked, liveState, tradingConfig, cash, availableCash, evaluationByToken = new Map(), expiredOrderSweep }) {
  const restingTokenIds = new Set((Array.isArray(liveState?.openOrders) ? liveState.openOrders : [])
    .filter((order) => !String(order.side || "").toUpperCase().includes("SELL"))
    .map((order) => String(order.tokenId || order.assetId || "")));
  const heldTokenIds = new Set(openPositionsForRotation(liveState)
    .map((position) => String(position.tokenId || position.assetId || "")));
  const positionTokenIds = heldTokenIds;

  // Diversification has to be enforced before the orders exist, not after they
  // fill. Resting bids fill asynchronously on Polymarket's book -- several sub-markets
  // of one match can be matched in the same instant -- and this process only ever
  // observes fills by polling, minutes apart. Cancelling siblings after the fact is
  // therefore a cleanup, never a guarantee: by the time a fill is visible, the others
  // may already have filled too. Resting at most one bid per event is a guarantee,
  // because an event with a single order cannot open two positions.
  const held = heldRiskItems(liveState, evaluationByToken);
  const claimedGroupKeys = new Set();
  const eventKeysOf = (row) => (Array.isArray(row?.riskGroupKeys) ? row.riskGroupKeys : [])
    .filter((key) => String(key).startsWith("event:") || String(key).startsWith("match:"));

  const skipped = [];
  const pool = [];
  for (const row of checked) {
    const facts = fixedEntryRowFacts(row);
    const note = (reason) => skipped.push({ tokenId: facts.tokenId, question: facts.question, reason });
    // Only findings that are still true at any price disqualify a candidate here.
    if (row.marketGone || row.status === "ERROR") {
      note(row.rejectReasons?.[0] || "market unavailable");
      continue;
    }
    if (!facts.tokenId) {
      note("no token id");
      continue;
    }
    // Checked before anything that costs a request: the portfolio is restricted to the
    // tags it was told to trade, so a market outside them is not a candidate at all.
    if (!marketTagIsAllowed(row)) {
      note(`outside this portfolio's tags (${[...FIXED_ENTRY_ALLOWED_TAGS].join(", ")})`);
      continue;
    }
    if (restingTokenIds.has(facts.tokenId)) {
      note("an order is already resting on this token");
      continue;
    }
    if (heldTokenIds.has(facts.tokenId)) {
      note("this token is already held");
      continue;
    }
    if (!Number.isFinite(facts.marketProbability) || facts.marketProbability < MIN_PROBABILITY
      || (MAX_PROBABILITY != null && facts.marketProbability > MAX_PROBABILITY)) {
      note(`probability ${Number.isFinite(facts.marketProbability) ? (facts.marketProbability * 100).toFixed(1) : "-"}% is outside ${MAX_PROBABILITY == null ? `the ${(MIN_PROBABILITY * 100).toFixed(1)}% minimum` : `${(MIN_PROBABILITY * 100).toFixed(1)}-${(MAX_PROBABILITY * 100).toFixed(1)}% range`}`);
      continue;
    }
    // Resting below the market is the entire point, so a candidate already trading
    // at or under the entry price offers nothing this strategy is trying to buy.
    if (Number.isFinite(facts.currentBestAsk) && facts.currentBestAsk <= FIXED_ENTRY_PRICE) {
      note(`already asks ${facts.currentBestAsk.toFixed(3)}, at or below the entry price`);
      continue;
    }
    // Already open on this event, from either portfolio.
    const heldCollision = earlyRiskBlockReason({ ...row.candidate, ...row, tokenId: facts.tokenId }, held);
    if (heldCollision) {
      note(heldCollision);
      continue;
    }
    const order = fixedEntryOrder(facts);
    if (!order) {
      note("entry price is not valid for this market's tick size");
      continue;
    }
    order.riskGroupKeys = eventKeysOf(row.candidate || row);
    pool.push(order);
  }

  // At one fixed price the yield is identical for every bid, so what separates them
  // is how likely each is to pay out and how soon -- not a p.a. that is the same
  // number across the whole batch.
  pool.sort((a, b) => {
    if (b.marketProbability !== a.marketProbability) return b.marketProbability - a.marketProbability;
    const aDays = number(a.daysToResolution, Infinity);
    const bDays = number(b.daysToResolution, Infinity);
    return aDays - bDays;
  });
  const diversified = [];
  for (const order of pool) {
    const keys = order.riskGroupKeys || [];
    // No event key means nothing to collide on; such a row is its own event.
    const collides = keys.some((key) => claimedGroupKeys.has(key));
    if (collides) {
      skipped.push({
        tokenId: order.tokenId,
        question: order.question,
        reason: `another bid in this batch already covers this event: ${keys.slice(0, 2).join(", ")}`,
      });
      continue;
    }
    keys.forEach((key) => claimedGroupKeys.add(key));
    diversified.push(order);
  }
  // No cap on how many bids may rest. The exchange already bounds this: every
  // resting buy reserves collateral, so the balance decides how many exist. A
  // configured ceiling only ever stopped the strategy short of what it could fund.
  const targets = diversified;
  const attempts = [];
  let accepted = 0;
  let rejectedForFunds = 0;
  // `targets` is already ordered best-first -- highest probability, soonest to resolve --
  // so a pass that runs out of budget defers the weakest bids, not an arbitrary tail.
  const placementStartedAt = Date.now();
  let placed = 0;
  let placementMs = 0;
  let deferredForBudget = 0;

  for (const order of targets) {
    if (DRY_RUN || !hasFlag("confirm-live")) {
      attempts.push(orderAttemptSummary(order, null, { action: "DRY_RUN_READY" }));
      continue;
    }
    // Stop before starting a bid the budget cannot pay for, priced from what this run
    // has actually measured rather than an assumed per-order cost. The first bid always
    // goes, so a budget can never produce a pass that places nothing.
    const averageMs = placed ? placementMs / placed : 0;
    if (FIXED_ENTRY_BUDGET_MS && placed && Date.now() - placementStartedAt + averageMs > FIXED_ENTRY_BUDGET_MS) {
      deferredForBudget = targets.length - placed;
      break;
    }
    const orderStartedAt = Date.now();
    const submission = await submitLiveEntryWithMakerPrecisionRecovery({ ...order, funderAddress: tradingConfig.funderAddress, signatureType: tradingConfig.signatureType });
    placementMs += Date.now() - orderStartedAt;
    placed += 1;
    const ok = successfulOrderResponse(submission.response);
    if (ok) accepted += 1;
    // Running past the capital on hand is intended, so the exchange refusing an
    // order for want of collateral is an expected outcome and not a run failure.
    // It is counted separately so the log distinguishes "we ran out" from a fault.
    const error = String(orderResponseError(submission.response) || "");
    if (!ok && /balance|allowance|insufficient|not enough/i.test(error)) rejectedForFunds += 1;
    attempts.push(orderAttemptSummary(submission.order, submission.response, {
      action: ok ? "SUBMITTED" : "REJECTED",
    }));
    // Progress on the runner's own log, so a pass in flight shows how far through the
    // batch it is instead of going quiet for however long the placements take. Every
    // fifth keeps a 300-bid pass to sixty lines rather than three hundred.
    if (placed % FIXED_ENTRY_PROGRESS_EVERY === 0 || placed === targets.length) {
      console.log(`5050 placement: ${placed}/${targets.length} events, ${accepted} rested, ${Math.round((Date.now() - placementStartedAt) / 1000)}s elapsed`);
    }
  }

  // Resting bids remain on the book until Polymarket fills them or resolves their
  // market. Do not reclaim their collateral here merely because another position is
  // now open: that turns a temporary cash shortfall into unexpected cancellation.
  const cancelledSiblings = [];

  // A dry run touches every target without placing anything, so it has worked through
  // the whole batch; a live run has worked through as many as it placed.
  const processedEvents = DRY_RUN || !hasFlag("confirm-live") ? targets.length : placed;
  const elapsedSeconds = Math.round((Date.now() - placementStartedAt) / 1000);
  const action = accepted > 0 ? "SUBMITTED" : (targets.length ? "SKIP" : "NO_CANDIDATES");
  // Said on both branches below, because a pass that rests nothing but recovers capital
  // from bids on finished events did something worth reporting, and the branch that
  // reports nothing resting is exactly the one where that capital had gone missing.
  const expiredNote = expiredOrderSweep.withdrawn.length
    ? `; withdrew ${expiredOrderSweep.withdrawn.length} resting bid(s) on markets that were already over, releasing ${expiredOrderSweep.releasedUsdc.toFixed(2)} USDC`
    : "";
  // The fraction leads, because this string is what the run log row shows: how far the
  // pass got through the batch is the first thing to know, ahead of what it rested.
  const reason = targets.length
    ? `processed ${processedEvents} of ${targets.length} events in ${elapsedSeconds}s; rested ${accepted} bid(s) at ${FIXED_ENTRY_PRICE.toFixed(2)}, one per event from ${pool.length} qualifying of ${checked.length} scanned${rejectedForFunds ? `; ${rejectedForFunds} refused for available collateral, which is expected once the capital is committed` : ""}${deferredForBudget ? `; ${deferredForBudget} event(s) wait for the next run after the ${(FIXED_ENTRY_BUDGET_MS / 1000).toFixed(0)}s placement budget` : ""}${cancelledSiblings.length ? `; withdrew ${cancelledSiblings.length} resting bid(s) on events that already opened` : ""}${expiredNote}`
    : `no candidate cleared the ${(MIN_PROBABILITY * 100).toFixed(1)}% bar for a resting bid at ${FIXED_ENTRY_PRICE.toFixed(2)}, from ${checked.length} scanned${expiredNote}`;

  await emitDecision({
    generatedAt: new Date().toISOString(),
    action,
    reason,
    strategy: "fixed_entry",
    fixedEntry: {
      entryPrice: FIXED_ENTRY_PRICE,
      stakePerOrderUsdc: FIXED_ENTRY_STAKE_USDC,
      considered: checked.length,
      qualified: pool.length,
      diversified: diversified.length,
      targeted: targets.length,
      accepted,
      rejectedForFunds,
      cancelledSiblings: cancelledSiblings.length,
      expiredOrdersWithdrawn: expiredOrderSweep.withdrawn.length,
      expiredOrderCashReleasedUsdc: expiredOrderSweep.releasedUsdc,
      // How far through the batch the pass got, and what it cost to get there -- so a
      // partial pass reads as "20 of 300" rather than as a run that simply took longer,
      // and the budget can be tuned against measurements rather than guesses.
      processedEvents,
      deferredForBudget,
      placementBudgetMs: FIXED_ENTRY_BUDGET_MS,
      placementElapsedMs: Date.now() - placementStartedAt,
      placementPerOrderMs: placed ? Math.round(placementMs / placed) : 0,
    },
    account: { cashUsdc: cash, availableCashUsdc: availableCash },
    // This pass revalidates every candidate against the exchange, and what it learns is
    // exactly what the shortlist needs: a market Gamma no longer lists is closed, a price
    // that moved is the new price. Without publishing them the verdicts died with the
    // run, so a market this pass found gone stayed READY in the candidate list and was
    // re-fetched and re-rejected by every pass after it.
    revalidationUpdates: checked
      .map((item) => liveRevalidationUpdate(item, new Date().toISOString()))
      .filter((item) => item.tokenId),
    attempts,
    batchLog: {
      action,
      reason,
      strategyId: "live-5050",
      strategyLabel: "5050",
      runAt: new Date().toISOString(),
      counts: {
        consideredCandidates: checked.length,
        qualifiedCandidates: pool.length,
        targetedOrders: targets.length,
        // How far through the batch this pass got, and what it cost. The dashboard
        // reads the run's counts, so the timings belong here as well as in the digest
        // block, or a partial pass renders as a small one with no way to tell.
        processedEvents,
        acceptedOrders: accepted,
        rejectedForCollateral: rejectedForFunds,
        expiredOrdersWithdrawn: expiredOrderSweep.withdrawn.length,
        expiredOrderCashReleasedUsdc: expiredOrderSweep.releasedUsdc,
        deferredForBudget,
        placementBudgetMs: FIXED_ENTRY_BUDGET_MS,
        placementElapsedMs: Date.now() - placementStartedAt,
        placementPerOrderMs: placed ? Math.round(placementMs / placed) : 0,
      },
      topRejected: skipped.slice(0, 12).map((item) => ({
        question: item.question,
        rejectReasons: [item.reason],
      })),
    },
  });
}

async function emitDecision(payload) {
  // Compact entries already stored from before this existed too, so the backlog
  // shrinks on the very next run instead of only stopping further growth and
  // waiting ~160 runs (about a day at this cadence) for it to age out on its own.
  const previousRunLog = (Array.isArray(previousExecutionState?.runLog)
    ? previousExecutionState.runLog
    : []).map(compactLiveRunRecord);
  const runEntry = {
    ...compactLiveRunRecord(payload.batchLog || {}),
    id: payload.batchLog?.id || `live-trade-batch-${payload.generatedAt || new Date().toISOString()}`,
    // One decision, one instant. generatedAt and batchLog.runAt were separate clock
    // reads milliseconds apart, so the same run carried two different times and
    // anything matching them up had to allow for the drift.
    runAt: payload.generatedAt || payload.batchLog?.runAt || new Date().toISOString(),
    generatedAt: payload.generatedAt || payload.batchLog?.runAt || new Date().toISOString(),
    strategyId: payload.batchLog?.strategyId || "live",
    strategyLabel: payload.batchLog?.strategyLabel || "Live",
    action: payload.action || payload.batchLog?.action || "-",
    reason: payload.reason || payload.batchLog?.reason || "-",
    explanation: payload.batchLog?.explanation || payload.reason || "-",
    response: payload.response || null,
    attempts: Array.isArray(payload.attempts) ? payload.attempts : [],
  };
  const rotation = rotationLegMerge({
    completionRun: ROTATION_COMPLETION_RUN,
    previousState: previousExecutionState,
    exitEntry: previousRunLog[0],
    runEntry,
    payload,
  });
  const mergedEntry = rotation ? { ...runEntry, ...rotation } : runEntry;
  const tail = rotation ? previousRunLog.slice(1) : previousRunLog;
  const nextRunLog = mergeRunLog([mergedEntry, ...tail], 160);
  const output = {
    ...payload,
    // Same decision at the top level, so the digest and the dashboard's "latest run"
    // row tell the same story as the log entry rather than only the buy half.
    ...(rotation || {}),
    // The dashboard renders this top-level state as a row and dedupes it against the run
    // log by batchLog id -- but only one of the emit sites ever set one. Every other run,
    // and every 5050 run because that is its only path, published a batchLog its own log
    // entry could not be matched to, so the newest run rendered twice. The identity is
    // stamped here rather than at each call site, which is what let it be forgotten.
    ...(payload.batchLog ? { batchLog: { ...payload.batchLog, id: mergedEntry.id, runAt: mergedEntry.runAt } } : {}),
    runLog: nextRunLog,
  };

  console.log(JSON.stringify(consoleDecisionSummary(output), null, 2));
  if (!EXECUTION_STATE_PATH) return;
  await mkdir(dirname(EXECUTION_STATE_PATH), { recursive: true });
  await writeFile(EXECUTION_STATE_PATH, `${JSON.stringify(output, null, 2)}\n`, "utf8");
}

// The published state (written above, unchanged) keeps full detail for the dashboard.
// The console dump is a separate, compact summary of the same run, because the runner
// logs are read back through a tool with a real size ceiling regardless of how much is
// requested -- a run with 100+ revalidated candidates in "ai" mode, each carrying an AI
// thesis, comfortably produces a dump too large to fetch in one request even with
// history already compacted. This carries everything needed to diagnose one run's
// decision (settings, capital, counts, the capped top candidates/rejects, every open
// order and rotation review, and the prefilter reason breakdown) without the unbounded
// revalidatedCandidates list or the 160-entry run-log history.
function consoleDecisionSummary(output = {}) {
  const batch = output.batchLog || {};
  return {
    generatedAt: output.generatedAt,
    action: output.action,
    reason: output.reason,
    account: output.account,
    monitoring: output.monitoring,
    settings: batch.settings || output.settings,
    capital: batch.capital,
    counts: batch.counts,
    selected: batch.selected || null,
    topCandidates: batch.topCandidates || [],
    topRejected: batch.topRejected || [],
    openOrderReviews: batch.openOrderReviews || [],
    rotationReview: output.rotationReview || batch.rotationReview || null,
    rotationComparison: batch.rotationComparison || [],
    // compactLiveRunRecord() already strips this field correctly (by omission, not
    // by an undefined value that JSON.stringify would hide but that a reader of the
    // in-memory object would still see).
    prevalidationFilter: batch.prevalidationFilter
      ? compactLiveRunRecord({ prevalidationFilter: batch.prevalidationFilter }).prevalidationFilter
      : null,
    response: output.response || null,
    attempts: output.attempts || [],
  };
}

function mergeRunLog(rows = [], limit = 160) {
  const seen = new Set();
  const merged = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const key = row.id || `${row.runAt || row.generatedAt || ""}:${row.strategyId || "live"}:${row.action || ""}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(row);
  }
  return merged
    .sort((a, b) => Date.parse(b.runAt || b.generatedAt || 0) - Date.parse(a.runAt || a.generatedAt || 0))
    .slice(0, limit);
}

async function submitOrder(order) {
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
  const funderAddress = order.funderAddress || FUNDER_ADDRESS;
  const signatureType = number(order.signatureType, SIGNATURE_TYPE);
  if (!privateKey || !funderAddress) throw new Error("POLYMARKET_PRIVATE_KEY and POLYMARKET_FUNDER_ADDRESS are required");
  const { client, Side, OrderType } = await authenticatedClobClient({ privateKey, funderAddress, signatureType });
  // Only pass what is actually known. The CLOB is authoritative for both of these
  // and the client resolves them per token when the option is absent
  // (`options?.negRisk ?? getNegRisk(tokenID)`), so a filled-in guess silently
  // replaces a correct lookup. negRisk in particular selects the exchange contract
  // used as the EIP-712 verifying contract: signing a neg-risk market against the
  // plain exchange makes the CLOB recompute a different order hash and reject the
  // order with "invalid POLY_1271 signature: signature does not match order hash".
  // That is why `Boolean(order.negRisk)` -- which turns "unknown" into a confident
  // false -- deadlocked every rotation exit out of a neg-risk market.
  const options = {};
  if (order.tickSize != null && order.tickSize !== "") options.tickSize = String(order.tickSize);
  if (typeof order.negRisk === "boolean") options.negRisk = order.negRisk;
  const side = String(order.side || "BUY").toUpperCase() === "SELL" ? Side.SELL : Side.BUY;
  const forceTaker = Boolean(order.forceTaker) || String(order.orderType || "").toUpperCase() === "FAK";
  // Exiting a position has to actually execute, so this tries the two taker paths the
  // client offers and keeps whichever the CLOB accepts.
  //
  // History, because both failure modes were live: createAndPostOrder(..., OrderType.FAK)
  // silently ignored the FAK -- that method only takes GTC or GTD -- so the exit rested
  // on the book as a limit sell, reserved the position's shares and deadlocked rotation.
  // Signing it with createOrder and posting FAK fixed the semantics but the CLOB rejected
  // it with "invalid POLY_1271 signature: signature does not match order hash", so the
  // sell never reached the book either.
  //
  // createMarketOrder is the client's own market-order builder and computes its own
  // payload, so it is the fallback when the limit-signed attempt is refused: a rejected
  // exit must not leave the position stranded. Both attempts are reported.
  if (side === Side.SELL && forceTaker) {
    const attempts = [];
    let limitSigned = null;
    try {
      const signedExit = await client.createOrder(
        {
          tokenID: order.tokenId,
          price: order.orderPrice,
          size: order.orderSize,
          side,
        },
        options,
      );
      limitSigned = await client.postOrder(signedExit, OrderType.FAK, false);
    } catch (error) {
      limitSigned = { error: error?.message || String(error), status: "exception" };
    }
    attempts.push({ path: "limit-signed-fak", response: limitSigned });
    if (successfulOrderResponse(limitSigned)) return { ...limitSigned, exitAttempts: attempts };

    let marketSigned = null;
    try {
      const marketOrder = await client.createMarketOrder(
        {
          tokenID: order.tokenId,
          price: order.orderPrice,
          amount: order.orderSize,
          side,
        },
        options,
      );
      marketSigned = await client.postOrder(marketOrder, OrderType.FAK);
    } catch (error) {
      marketSigned = { error: error?.message || String(error), status: "exception" };
    }
    attempts.push({ path: "market-order-fak", response: marketSigned });
    // Whichever ran last is the outcome; the attempt list explains how it got there.
    return { ...(marketSigned || {}), exitAttempts: attempts };
  }
  if (!USE_LIMIT_ORDERS || forceTaker) {
    const marketOrder = await client.createMarketOrder(
      {
        tokenID: order.tokenId,
        price: order.orderPrice,
        amount: side === Side.SELL ? order.orderSize : order.orderNotionalUsdc,
        side,
      },
      options,
    );
    return client.postOrder(marketOrder, OrderType.FAK);
  }
  const signedOrder = await client.createOrder(
    {
      tokenID: order.tokenId,
      price: order.orderPrice,
      size: order.orderSize,
      side,
    },
    options,
  );
  // Buy limits may be post-only, but a rotation exit must be a taker order so
  // released collateral can be used by the replacement on the next sync.
  return client.postOrder(signedOrder, OrderType.GTC, side === Side.SELL ? false : POST_ONLY);
}

async function submitOrderWithMakerPrecisionRecovery(order) {
  const attempts = [];
  let response = null;
  try {
    response = await submitOrder(order);
  } catch (error) {
    response = {
      error: error?.message || String(error),
      data: error?.response?.data || error?.data || null,
      status: "exception",
    };
  }
  attempts.push({ order, response, precisionRecovery: false });

  const side = String(order.side || "BUY").toUpperCase();
  const minOrderSize = number(order.minOrderSize);
  if (
    successfulOrderResponse(response)
    || !USE_LIMIT_ORDERS
    || side !== "BUY"
    || !isMakerAmountPrecisionError(response)
    || minOrderSize == null
  ) {
    return { order, response, attempts };
  }

  const price = number(order.orderPrice ?? order.marketPrice);
  const originalSize = number(order.orderSize);
  const safeSize = price != null && originalSize != null
    ? largestTwoDecimalMakerSafeSize({ price, size: originalSize, minOrderSize })
    : null;
  if (safeSize == null || safeSize >= originalSize - 0.000001) {
    return { order, response, attempts };
  }

  const adjustedOrder = resizeCandidateForMakerPrecision(order, safeSize);
  let adjustedResponse = null;
  try {
    adjustedResponse = await submitOrder(adjustedOrder);
  } catch (error) {
    adjustedResponse = {
      error: error?.message || String(error),
      data: error?.response?.data || error?.data || null,
      status: "exception",
    };
  }
  attempts.push({ order: adjustedOrder, response: adjustedResponse, precisionRecovery: true });
  return { order: adjustedOrder, response: adjustedResponse, attempts };
}

async function buildRotationExitOrder(position, evaluationByToken, tradingConfig) {
  const tokenId = String(position.tokenId || position.assetId || "");
  const orderSize = number(position.shares ?? position.size);
  if (!tokenId || orderSize == null || orderSize <= 0) throw new Error("rotation exit has no sellable token balance");
  const source = positionSourceEvaluation(position, evaluationByToken) || {};
  const book = bestBook(await fetchJson(new URL(`/book?token_id=${tokenId}`, CLOB_HOST), `CLOB rotation exit book ${tokenId}`));
  if (book.bestBid == null || book.bestBid <= 0) throw new Error("rotation exit has no executable bid in the order book");
  // `conditionId` is the documented key of /clob-markets. `market` is an
  // account-data fallback and can be absent or refer to an older identifier.
  const clobMarket = await fetchClobMarket(position.conditionId || source.conditionId || position.market).catch(() => null);
  const tickSize = number(clobMarket?.mts ?? source.tickSize, 0.01);
  const orderPrice = roundToTick(book.bestBid, tickSize, "down");
  return {
    question: position.question || source.question || "",
    outcome: position.outcome || source.outcome || "",
    tokenId,
    side: "SELL",
    orderType: "FAK",
    forceTaker: true,
    orderPrice,
    orderSize: Number(orderSize.toFixed(4)),
    orderNotionalUsdc: Number((orderPrice * orderSize).toFixed(5)),
    tickSize,
    // `/clob-markets/{conditionId}` answers in compact keys -- `mts` for the tick
    // size, `nr` for neg risk -- so the camelCase read here was always undefined
    // and every exit fell back to "not neg risk". Leave it undefined when unknown
    // so submitOrder can let the client ask the CLOB instead of guessing. The
    // stored evaluation is deliberately not used as a fallback: records written
    // before this fix carry exactly the wrong `false` we are trying to stop
    // trusting, and the client's own lookup is both correct and cached.
    negRisk: typeof clobMarket?.nr === "boolean" ? clobMarket.nr : undefined,
    funderAddress: tradingConfig.funderAddress,
    signatureType: tradingConfig.signatureType,
  };
}

async function authenticatedClobClient({ privateKey = process.env.POLYMARKET_PRIVATE_KEY, funderAddress = FUNDER_ADDRESS, signatureType = SIGNATURE_TYPE } = {}) {
  if (!privateKey || !funderAddress) throw new Error("POLYMARKET_PRIVATE_KEY and POLYMARKET_FUNDER_ADDRESS are required");
  const [{ ClobClient, Side, OrderType, SignatureTypeV2 }, { createWalletClient, custom }, { privateKeyToAccount }] =
    await Promise.all([
      import("@polymarket/clob-client-v2"),
      import("viem"),
      import("viem/accounts"),
    ]);
  const signatureTypeMap = {
    0: SignatureTypeV2.EOA,
    1: SignatureTypeV2.POLY_PROXY,
    2: SignatureTypeV2.GNOSIS_SAFE,
    3: SignatureTypeV2.POLY_1271,
  };
  const account = privateKeyToAccount(privateKey);
  const signer = createWalletClient({
    account,
    transport: custom({
      request: async ({ method }) => {
        throw new Error(`Unexpected JSON-RPC request while signing Polymarket order: ${method}`);
      },
    }),
  });
  const tempClient = new ClobClient({ host: CLOB_HOST, chain: CHAIN_ID, signer });
  const creds = await tempClient.createOrDeriveApiKey();
  const client = new ClobClient({
    host: CLOB_HOST,
    chain: CHAIN_ID,
    signer,
    creds,
    signatureType: signatureTypeMap[signatureType] ?? SignatureTypeV2.POLY_PROXY,
    funderAddress,
  });
  return { client, Side, OrderType };
}

async function cancelOrder(order, tradingConfig = {}) {
  const orderId = order.id || order.orderId || order.orderID;
  if (!orderId) return { error: "open order has no order id", status: "missing_order_id" };
  if (DRY_RUN || !hasFlag("confirm-live")) {
    return { status: "dry_run_cancel", orderID: orderId, success: true };
  }
  const { client } = await authenticatedClobClient({
    funderAddress: tradingConfig.funderAddress || FUNDER_ADDRESS,
    signatureType: number(tradingConfig.signatureType, SIGNATURE_TYPE),
  });
  if (typeof client.cancelOrder === "function") {
    const singleResponse = await client.cancelOrder({ orderID: orderId });
    if (successfulCancelResponse(singleResponse, orderId) || typeof client.cancelOrders !== "function") {
      return singleResponse;
    }
    const error = orderResponseError(singleResponse);
    if (!/invalid order payload/i.test(error)) return singleResponse;
  }
  if (typeof client.cancelOrders === "function") return client.cancelOrders([orderId]);
  throw new Error("CLOB client does not expose cancelOrder/cancelOrders");
}

function orderResponseError(response) {
  if (!response) return "";
  const error = response.error;
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error && typeof error === "object") {
    const nested = error.message || error.msg || error.reason || error.code;
    if (nested != null && String(nested).trim()) return String(nested).trim();
  }
  const direct = response.errorMsg || response.message || response.reason || response.statusReason;
  if (direct != null && String(direct).trim()) return String(direct).trim();
  if (response.data && typeof response.data === "object") {
    const nested = response.data.error || response.data.message || response.data.reason;
    if (nested != null && String(nested).trim()) return String(nested).trim();
  }
  return "";
}

function compactOrderResponse(response) {
  if (response == null) return "";
  try {
    const serialized = JSON.stringify(response);
    return serialized.length > 600 ? `${serialized.slice(0, 597)}...` : serialized;
  } catch {
    return String(response);
  }
}

function successfulOrderResponse(response) {
  if (!response || response.error || response.success === false || response.status === "error") return false;
  return ["live", "matched", "delayed", "unmatched"].includes(String(response.status || "").toLowerCase()) || response.success === true || Boolean(response.orderID);
}

function nonRetryableOrderFailure(response) {
  const text = orderResponseError(response).toLowerCase();
  const status = Number(response?.status);
  if (status === 401 || status === 403) return "account or region rejected the order";
  if (/region|restricted|geoblock|geo/.test(text)) return "account or region rejected the order";
  if (/auth|signature|api key|private key|unauthorized|forbidden/.test(text)) return "authentication/signing failed";
  if (/not enough balance|insufficient|allowance/.test(text)) return "insufficient balance or allowance";
  return "";
}

function orderAttemptSummary(candidate, response = null, extra = {}) {
  return {
    question: candidate.question,
    outcome: candidate.outcome,
    tokenId: candidate.tokenId,
    side: candidate.side || "BUY",
    orderType: candidate.orderType,
    orderPrice: candidate.orderPrice,
    orderSize: candidate.orderSize,
    orderNotionalUsdc: candidate.orderNotionalUsdc,
    totalCostUsdc: candidate.totalCostUsdc,
    // The current Gamma volume was read as part of revalidation immediately before
    // this order was signed. Preserve that entry snapshot; account history itself
    // cannot reconstruct the market volume that existed at this moment later on.
    entryVolumeUsdc: candidate.volumeUsdc == null || candidate.volumeUsdc === "" ? null : number(candidate.volumeUsdc),
    minSizeOverride: candidate.minSizeOverride,
    sizingNote: candidate.sizingNote,
    response,
    responseStatus: response?.status ?? null,
    responseError: orderResponseError(response) || null,
    responseSummary: compactOrderResponse(response) || null,
    // A rotation exit tries more than one taker path, and "the sell was
    // rejected" is not diagnosable without knowing which of them the CLOB
    // refused and why. Keep one short line per path.
    exitPaths: Array.isArray(response?.exitAttempts)
      ? response.exitAttempts.map((attempt) => ({
        path: attempt.path,
        error: orderResponseError(attempt.response) || null,
        status: attempt.response?.status ?? null,
      }))
      : undefined,
    ...extra,
  };
}

function hasTwoDecimalMakerAmount(price, size) {
  const makerAmount = Number(price) * Number(size);
  if (!Number.isFinite(makerAmount)) return false;
  const cents = Math.round(makerAmount * 100);
  return Math.abs(makerAmount * 100 - cents) <= 0.0000001;
}

function largestTwoDecimalMakerSafeSize({ price, size, minOrderSize = 0 }) {
  const maximumCents = Math.floor(Number(size) * 100 + 0.0000001);
  const minimumCents = Math.ceil(Number(minOrderSize) * 100 - 0.0000001);
  if (!Number.isFinite(maximumCents) || !Number.isFinite(minimumCents) || maximumCents < minimumCents) return null;

  // Polymarket's BUY maker amount is the USDC notional (price * shares).
  // Keep the original price and find the largest two-decimal share quantity
  // whose resulting maker amount has no fractional cent.
  for (let cents = maximumCents; cents >= minimumCents; cents -= 1) {
    const candidateSize = cents / 100;
    if (hasTwoDecimalMakerAmount(price, candidateSize)) return Number(candidateSize.toFixed(2));
  }
  return null;
}

function isMakerAmountPrecisionError(response) {
  const message = `${orderResponseError(response)} ${compactOrderResponse(response)}`.toLowerCase();
  return /invalid maker amount|invalid amounts.*maker amount|maker amount.*(?:accuracy|decimal|precision)/i.test(message);
}

function resizeCandidateForMakerPrecision(candidate, size) {
  const price = number(candidate.orderPrice ?? candidate.marketPrice);
  if (price == null || !Number.isFinite(size) || size <= 0) return candidate;

  const feeRate = feeRateForEvaluation(candidate);
  // Same rule as the sizing above: a rotation entry crosses the spread, so its resized
  // economics have to carry the taker fee too, or the row would disagree with the order.
  const fee = USE_LIMIT_ORDERS && POST_ONLY && !ROTATION_ENTRY_CROSSES_SPREAD ? 0 : takerFee(size, price, feeRate);
  const notional = Number((price * size).toFixed(5));
  const totalCost = notional + fee;
  const aiProbability = number(candidate.aiProbability);
  const marketProbability = number(candidate.marketProbability);
  const days = number(candidate.daysToResolution);
  const aiExpectedValue = aiProbability == null ? null : aiProbability * size - notional - fee;
  const marketExpectedValue = marketProbability == null ? null : marketProbability * size - notional - fee;
  const netGainIfWin = size - notional - fee;
  const potentialRoi = totalCost > 0 ? netGainIfWin / totalCost : null;
  const aiRoi = aiExpectedValue != null && totalCost > 0 ? aiExpectedValue / totalCost : null;
  const marketRoi = marketExpectedValue != null && totalCost > 0 ? marketExpectedValue / totalCost : null;
  const selectedExpectedValue = PROBABILITY_SOURCE === "polymarket" ? netGainIfWin : aiExpectedValue;
  const selectedRoi = PROBABILITY_SOURCE === "polymarket" ? potentialRoi : aiRoi;
  const annualizedReturn = selectedRoi == null ? null : annualizeReturn(selectedRoi, days);
  const potentialAnnualizedReturn = potentialRoi == null ? null : annualizeReturn(potentialRoi, days);
  const aiAnnualizedReturn = aiRoi == null ? null : annualizeReturn(aiRoi, days);
  const marketAnnualizedReturn = marketRoi == null ? null : annualizeReturn(marketRoi, days);

  return {
    ...candidate,
    orderSize: Number(size.toFixed(2)),
    orderNotionalUsdc: notional,
    appliedStakeUsdc: Number(totalCost.toFixed(5)),
    minOrderNotionalUsdc: Number((price * number(candidate.minOrderSize, 0)).toFixed(5)),
    expectedValueUsdc: selectedExpectedValue == null ? null : Number(selectedExpectedValue.toFixed(4)),
    annualizedReturn: annualizedReturn == null ? null : Number(annualizedReturn.toFixed(4)),
    aiExpectedValueUsdc: aiExpectedValue == null ? null : Number(aiExpectedValue.toFixed(4)),
    aiAnnualizedReturn: aiAnnualizedReturn == null ? null : Number(aiAnnualizedReturn.toFixed(4)),
    marketExpectedValueUsdc: marketExpectedValue == null ? null : Number(marketExpectedValue.toFixed(4)),
    marketAnnualizedReturn: marketAnnualizedReturn == null ? null : Number(marketAnnualizedReturn.toFixed(4)),
    potentialAnnualizedReturn: potentialAnnualizedReturn == null ? null : Number(potentialAnnualizedReturn.toFixed(4)),
    netGainIfWinUsdc: Number(netGainIfWin.toFixed(4)),
    netYield: potentialRoi == null ? null : Number(potentialRoi.toFixed(6)),
    riskReward: potentialRoi == null ? null : Number(potentialRoi.toFixed(6)),
    totalCostUsdc: Number(totalCost.toFixed(5)),
    tradingFeeUsdc: Number(fee.toFixed(5)),
    sizingNote: `maker amount precision recovery: reduced from ${Number(candidate.orderSize).toFixed(4)} to ${Number(size).toFixed(2)} shares at the same limit price`,
    makerPrecisionAdjusted: true,
    originalOrderSize: Number(Number(candidate.orderSize).toFixed(4)),
  };
}

function liveBatchCandidateSummary(item) {
  const source = item?.candidate || item || {};
  const gain = number(item?.netGainIfWinUsdc ?? source.netGainIfWinUsdc);
  const cost = number(item?.totalCostUsdc ?? item?.orderNotionalUsdc ?? source.totalCostUsdc ?? source.stakeUsdc);
  const daysToResolution = number(item?.daysToResolution ?? source.daysToResolution);
  const netYield = gain != null && cost != null && cost > 0 ? gain / cost : null;
  const potentialAnnualizedReturn = netYield != null
    ? annualizeReturn(netYield, daysToResolution)
    : null;
  const selectedAnnualizedReturn = PROBABILITY_SOURCE === "polymarket"
    ? potentialAnnualizedReturn
    : number(item?.annualizedReturn ?? source.annualizedReturn);
  const selectedExpectedValue = PROBABILITY_SOURCE === "polymarket"
    ? gain
    : number(item?.expectedValueUsdc ?? source.expectedValueUsdc);
  return {
    question: item?.question || source.question || "",
    outcome: item?.outcome || source.outcome || "",
    tokenId: item?.tokenId || source.tokenId || null,
    conditionId: item?.conditionId || source.conditionId || item?.market || source.market || null,
    slug: item?.slug || source.slug || "",
    eventSlug: item?.eventSlug || source.eventSlug || item?.slug || source.slug || "",
    riskGroupKeys: Array.isArray(item?.riskGroupKeys)
      ? item.riskGroupKeys
      : (Array.isArray(source.riskGroupKeys) ? source.riskGroupKeys : []),
    evaluatedAt: item?.evaluatedAt || source.evaluatedAt || null,
    status: item?.status || source.status || null,
    aiProbability: number(item?.aiProbability ?? source.aiProbability),
    marketProbability: number(item?.marketProbability ?? source.marketProbability ?? item?.marketPrice ?? source.marketPrice),
    marketPrice: number(item?.marketPrice ?? source.marketPrice ?? item?.currentPrice),
    annualizedReturn: selectedAnnualizedReturn,
    expectedValueUsdc: selectedExpectedValue,
    aiAnnualizedReturn: number(item?.aiAnnualizedReturn ?? source.aiAnnualizedReturn),
    aiExpectedValueUsdc: number(item?.aiExpectedValueUsdc ?? source.aiExpectedValueUsdc),
    marketAnnualizedReturn: number(item?.marketAnnualizedReturn ?? source.marketAnnualizedReturn),
    marketExpectedValueUsdc: number(item?.marketExpectedValueUsdc ?? source.marketExpectedValueUsdc),
    potentialAnnualizedReturn: potentialAnnualizedReturn == null ? null : number(potentialAnnualizedReturn),
    daysToResolution,
    liquidity: number(item?.liquidity ?? source.liquidity),
    // What the tables and the run log show: traded volume, the figure Polymarket itself
    // reports on the market. Liquidity stays alongside it for reference.
    volumeUsdc: candidateVolumeUsdc(item?.volumeUsdc != null ? item : source),
    netGainIfWinUsdc: gain,
    netYield: netYield == null ? null : number(netYield),
    riskReward: netYield == null ? null : number(netYield),
    orderPrice: number(item?.orderPrice),
    orderSize: number(item?.orderSize),
    orderNotionalUsdc: number(item?.orderNotionalUsdc),
    rejectReasons: Array.isArray(item?.rejectReasons) ? item.rejectReasons.slice(0, 6) : [],
    sizingNote: item?.sizingNote || null,
    url: `https://polymarket.com/event/${item?.eventSlug || source.eventSlug || item?.slug || source.slug || ""}`,
  };
}

// The paper evaluation is the durable AI record.  A live execution check only
// adds its current-market verdict so a stale shortlist cannot offer it again.
function liveRevalidationUpdate(item, checkedAt) {
  const source = item?.candidate || item || {};
  const status = String(item?.status || "REJECTED").toUpperCase();
  const rejectReasons = Array.isArray(item?.rejectReasons) ? item.rejectReasons.slice(0, 8) : [];
  const retryClass = rejectReasons.some((reason) => /correlated live exposure|duplicate token already open|risk overlap/i.test(String(reason || "")))
    ? "DIVERSIFICATION"
    : (rejectReasons.some((reason) => /no available cash|sub-cent maker amount|above cash|insufficient.*(?:cash|USDC|capital)|minimum order .*costs|below the displayed .*share.*minimum/i.test(String(reason || "")))
      ? "CAPITAL"
      : null);
  const numericFields = [
    "marketPrice",
    "marketProbability",
    "currentPrice",
    "annualizedReturn",
    "expectedValueUsdc",
    "aiAnnualizedReturn",
    "aiExpectedValueUsdc",
    "marketAnnualizedReturn",
    "marketExpectedValueUsdc",
    "daysToResolution",
    "liquidity",
    "volumeUsdc",
    "netGainIfWinUsdc",
    "totalCostUsdc",
    "orderPrice",
    "orderSize",
    "orderNotionalUsdc",
    "minOrderSize",
    "spread",
    "feeRate",
  ];
  const metrics = {};
  for (const field of numericFields) {
    const value = Number(item?.[field]);
    if (Number.isFinite(value)) metrics[field === "currentPrice" ? "marketPrice" : field] = value;
  }
  // A market that no longer exists can never come back, so it is reported as CLOSED
  // rather than merely rejected: the persist step closes the stored row out on this,
  // which takes it out of the candidate pool for good instead of leaving it to be
  // re-fetched and re-rejected every run.
  const marketGone = Boolean(item?.marketGone);
  return {
    tokenId: String(item?.tokenId || source.tokenId || ""),
    checkedAt,
    // Which portfolio checked. The verdicts are persisted onto the shared evaluation
    // rows, so without this the two live portfolios read each other's: whatever 5050
    // rejected disappeared from the main live portfolio's candidates too, and since
    // 5050 sweeps the whole pool after every scrape it emptied that list completely.
    portfolio: LIVE_PORTFOLIO_ID,
    status: status === "ELIGIBLE"
      ? "READY"
      : (status === "ERROR"
        ? "ERROR"
        : (marketGone ? "CLOSED" : (retryClass ? `WAITING_${retryClass}` : "REJECTED"))),
    retryable: Boolean(retryClass) && !marketGone,
    retryClass: marketGone ? null : retryClass,
    marketGone,
    // Distinguishes "this market is gone" from "this event is over but Polymarket has
    // not settled it yet". Both retire the row; only the second is still expecting a
    // result, and the stored row says which so the reason is legible later.
    awaitingResolution: Boolean(item?.awaitingResolution),
    rejectReasons,
    question: item?.question || source.question || "",
    outcome: item?.outcome || source.outcome || "",
    slug: item?.slug || source.slug || "",
    eventSlug: item?.eventSlug || source.eventSlug || item?.slug || source.slug || "",
    conditionId: item?.conditionId || source.conditionId || item?.market || source.market || null,
    riskGroupKeys: Array.isArray(item?.riskGroupKeys)
      ? item.riskGroupKeys
      : (Array.isArray(source.riskGroupKeys) ? source.riskGroupKeys : []),
    ...metrics,
  };
}

function successfulCancelResponse(response, orderId) {
  if (!response) return false;
  if (response.error || response.success === false || response.status === "error") return false;
  if (response.success === true) return true;
  if (Array.isArray(response.canceled) && response.canceled.map(String).includes(String(orderId))) return true;
  if (Array.isArray(response.cancelled) && response.cancelled.map(String).includes(String(orderId))) return true;
  if (response.not_canceled && Object.prototype.hasOwnProperty.call(response.not_canceled, String(orderId))) return false;
  if (response.notCanceled && Object.prototype.hasOwnProperty.call(response.notCanceled, String(orderId))) return false;
  if (String(response.status || "").toLowerCase().includes("cancel")) return true;
  return false;
}

function openOrderSummary(order, extra = {}) {
  return {
    orderId: order.id || order.orderID || order.orderId || null,
    tokenId: order.tokenId || order.assetId || null,
    question: order.question || order.market || "",
    outcome: order.outcome || "",
    price: number(order.price),
    remainingSize: number(order.remainingSize),
    notionalUsdc: number(order.notionalUsdc),
    createdAt: order.createdAt || null,
    ageHours: Number(openOrderAgeHours(order).toFixed(3)),
    orderSnapshot: {
      tokenId: order.tokenId || order.assetId || null,
      orderPrice: number(order.price),
      orderSize: number(order.remainingSize ?? order.size),
      orderType: order.orderType || "GTC",
      tickSize: order.tickSize || "0.01",
      // Unknown stays unknown here too, for the same reason as submitOrder.
      negRisk: typeof order.negRisk === "boolean" ? order.negRisk : undefined,
      question: order.question || order.market || "",
      outcome: order.outcome || "",
    },
    ...extra,
  };
}

// The "before" for a reprice has to belong to this order, and the only honest one on hand
// is what an earlier run recorded while reviewing the same order id. The stored evaluation
// is no use for it: the persist step overwrites its probability on every pass, so it always
// reads as "now". Returns null when this order has not been reviewed before, and the reason
// then reports only the current reading rather than inventing a comparison.
function previousOpenOrderReview(orderId) {
  const wanted = String(orderId || "");
  if (!wanted) return null;
  // Run-log entries spread the batchLog at their top level, and the newest is first.
  const batches = [
    previousExecutionState,
    ...(Array.isArray(previousExecutionState?.runLog) ? previousExecutionState.runLog : []),
  ];
  for (const batch of batches) {
    const reviews = Array.isArray(batch?.openOrderReviews) ? batch.openOrderReviews : [];
    const match = reviews.find((review) => String(review?.orderId || "") === wanted);
    if (match) return match;
  }
  return null;
}

// Reported of a run whose entire log read "Action: REPLACED / Reason: market moved away;
// raise limit price closer to current post-only level by 2.0 pts". Which event? Which
// order for which? What was the probability before, and what is it now? None of that was
// in the line -- and worse, "REPLACED" reads as though the portfolio had swapped one event
// for another. It had not. A reprice cancels and reposts OUR OWN bid on the SAME market and
// the SAME outcome at a different price; no event is exchanged for any other. The reason
// says which market, what moved, and by how much, so the claim can be checked rather than
// taken on trust.
function repriceReason({ order = {}, revalidated = {}, priceDelta = 0, ageHours = null, previous = null } = {}) {
  const label = [revalidated.outcome || order.outcome, revalidated.question || order.question || order.market]
    .filter(Boolean).join(" - ") || String(order.tokenId || order.assetId || "this market");
  const oldPrice = number(order.price);
  const newPrice = number(revalidated.orderPrice);
  const points = Math.abs(priceDelta * 100).toFixed(1);
  const direction = priceDelta > 0
    ? `the market moved away from our bid, so the limit rises by ${points} pts`
    : `the post-only level is ${points} pts lower, so the bid is reposted there`;
  const priceMove = oldPrice != null && newPrice != null
    ? `limit ${oldPrice.toFixed(4)} -> ${newPrice.toFixed(4)} USDC`
    : `limit repriced by ${points} pts`;
  // Probability then versus now. "Then" is the previous run's reading of this same order;
  // without one, only the current figure is claimed.
  const nowProbability = number(revalidated.marketProbability);
  const thenProbability = number(previous?.currentEvaluation?.marketProbability);
  const probabilityMove = nowProbability == null
    ? ""
    : (thenProbability == null
      ? `; market probability now ${(nowProbability * 100).toFixed(1)}%`
      : `; market probability ${(thenProbability * 100).toFixed(1)}% -> ${(nowProbability * 100).toFixed(1)}%`);
  const book = [
    number(revalidated.currentBestBid) == null ? "" : `bid ${number(revalidated.currentBestBid).toFixed(4)}`,
    number(revalidated.currentBestAsk) == null ? "" : `ask ${number(revalidated.currentBestAsk).toFixed(4)}`,
  ].filter(Boolean).join(" / ");
  const waited = Number.isFinite(Number(ageHours)) ? `, unfilled for ${Number(ageHours).toFixed(1)}h` : "";
  return `reprice of our own resting bid on the same market and outcome (no event was swapped): ${label}`
    + `; ${direction}: ${priceMove}${waited}${probabilityMove}${book ? `; current book ${book}` : ""}`;
}

// What the open-order review actually did, for the run's Note. The old text -- "Live batch
// reviewed existing open limit orders before opening a new position" -- was true of every
// outcome alike, so a REPLACED run said nothing about what had been replaced.
function openOrderActionExplanation(orderManagement = {}) {
  const selected = orderManagement.selected || null;
  const action = String(orderManagement.action || "").toUpperCase();
  const label = selected
    ? ([selected.outcome, selected.question].filter(Boolean).join(" - ") || String(selected.tokenId || "an open order"))
    : "an open order";
  const reviewed = Array.isArray(orderManagement.reviews) ? orderManagement.reviews.length : 0;
  const scope = reviewed
    ? `${reviewed} open limit order${reviewed === 1 ? " was" : "s were"} reviewed. `
    : "";
  if (action === "REPLACED") {
    return `${scope}The bid on ${label} was cancelled and immediately reposted at a new limit price.`
      + " This is the same market and the same outcome as before -- the portfolio's exposure did not"
      + " move to a different event.";
  }
  if (action === "CANCELED_FOR_BETTER_CANDIDATE") {
    const replacement = selected?.replacementCandidate || null;
    const replacementLabel = replacement
      ? ([replacement.outcome, replacement.question].filter(Boolean).join(" - ") || "a better-ranked candidate")
      : "a better-ranked candidate";
    return `${scope}The bid on ${label} was cancelled to release its capital for ${replacementLabel}.`
      + " This one does change which event the portfolio is bidding on.";
  }
  if (action === "CANCELED") {
    return `${scope}The bid on ${label} was cancelled and not replaced.`;
  }
  if (action.startsWith("REPLACE_REJECTED")) {
    return `${scope}The replacement bid on ${label} was refused by the exchange.`
      + (action.endsWith("RESTORE_FAILED")
        ? " Restoring the original order also failed, so that capital is currently unbid."
        : " The original order was restored, so nothing changed.");
  }
  return `${scope}Live batch reviewed existing open limit orders before opening a new position.`;
}

function selectionComparison(current, replacement) {
  const metricLabel = SELECTION_ORDER === "highest_reward_risk_first" ? "R/R" : returnMetricLabel();
  const currentMetric = SELECTION_ORDER === "highest_reward_risk_first"
    ? number(current?.riskReward)
    : selectedAnnualizedReturn(current);
  const replacementMetric = SELECTION_ORDER === "highest_reward_risk_first"
    ? number(replacement?.riskReward)
    : selectedAnnualizedReturn(replacement);
  const currentExpectedValue = selectedExpectedValue(current);
  const replacementExpectedValue = selectedExpectedValue(replacement);
  return {
    metricLabel,
    currentMetric,
    replacementMetric,
    metricDelta: Number.isFinite(currentMetric) && Number.isFinite(replacementMetric)
      ? replacementMetric - currentMetric
      : null,
    currentExpectedValue,
    replacementExpectedValue,
    expectedValueDelta: Number.isFinite(currentExpectedValue) && Number.isFinite(replacementExpectedValue)
      ? replacementExpectedValue - currentExpectedValue
      : null,
    replacementRanksAhead: compareLiveCandidatePriority(replacement, current) < 0,
    currentDaysToResolution: number(current?.daysToResolution),
    replacementDaysToResolution: number(replacement?.daysToResolution),
    currentRealizedPnlIfExitUsdc: number(current?.realizedPnlIfExitUsdc),
    replacementRealizedPnlIfExitUsdc: number(replacement?.realizedPnlIfExitUsdc),
  };
}

function selectionMetricDisplay(comparison, value) {
  if (!Number.isFinite(value)) return "-";
  return comparison?.metricLabel === "R/R"
    ? `${Number(value).toFixed(2)}:1`
    : `${(Number(value) * 100).toFixed(1)}%`;
}

async function restoreOpenOrder(review, tradingConfig = {}) {
  const snapshot = review?.orderSnapshot;
  if (!snapshot?.tokenId || snapshot.orderPrice == null || snapshot.orderSize == null || snapshot.orderSize <= 0) {
    return { status: "restore_unavailable", error: "original order snapshot is incomplete" };
  }
  const order = {
    ...snapshot,
    side: "BUY",
    funderAddress: tradingConfig.funderAddress,
    signatureType: tradingConfig.signatureType,
  };
  try {
    return DRY_RUN || !hasFlag("confirm-live")
      ? { status: "dry_run_restore", success: true }
      : await submitOrder(order);
  } catch (error) {
    return { status: "restore_exception", error: error?.message || String(error) };
  }
}

async function reviewOpenOrders({ liveState, evaluationByToken, eligible, rotationCandidates = [], cash, maxNotional, tradingConfig }) {
  const openOrders = Array.isArray(liveState?.openOrders) ? liveState.openOrders : [];
  const reviews = [];
  let selectedAction = null;

  for (const order of openOrders) {
    const orderId = order.id || order.orderID || order.orderId;
    const tokenId = String(order.tokenId || order.assetId || "");
    const ageHours = openOrderAgeHours(order);
    if (String(order.side || "").toUpperCase().includes("SELL")) {
      reviews.push(openOrderSummary(order, {
        action: "KEEP_ROTATION_EXIT_WAITING",
        reason: "live sell order is reducing an existing position; wait for account sync before a replacement buy",
        currentEvaluation: null,
        betterCandidate: null,
      }));
      continue;
    }
    const sourceEvaluation = evaluationByToken.get(tokenId);
    const lockedNotional = number(order.notionalUsdc, number(order.price, 0) * number(order.remainingSize, 0));
    const maxStakeBreached = Number.isFinite(lockedNotional)
      && Number.isFinite(maxNotional)
      && lockedNotional > maxNotional + 0.01;
    const effectiveCash = number(cash, 0) + number(lockedNotional, 0);
    const review = openOrderSummary(order, {
      action: "KEEP_WAITING",
      reason: "open order is still inside the minimum review window",
      currentEvaluation: null,
      betterCandidate: null,
      cancelResponse: null,
      replaceResponse: null,
    });

    // An order larger than the portfolio would now stake is the one that most needs
    // reviewing, not the one to exempt from it. The breach used to end the review right
    // here, so a portfolio whose value had fallen since the order was placed could never
    // compare it against anything: every order read "exceeds max stake; kept because no
    // replacement can be submitted atomically", no evaluation was attempted at all, and
    // the capital stayed locked while better-ranked candidates sat in the shortlist.
    //
    // Nothing about the breach actually blocks a replacement. Cancelling releases the
    // whole oversized notional, and the replacement is revalidated against the current
    // max stake, so it comes back correctly sized by construction. The breach is carried
    // on the review instead of ending it, so it still shows in the run log.
    review.maxStakeBreached = maxStakeBreached;
    const breachNote = maxStakeBreached
      ? ` (this order's ${lockedNotional.toFixed(4)} USDC is above the current max stake of ${maxNotional.toFixed(4)} USDC)`
      : "";
    if (!sourceEvaluation) {
      review.reason = (ageHours >= OPEN_ORDER_CANCEL_AFTER_HOURS
        ? "no current evaluation links to this open order and the order is stale; kept because no replacement can be submitted atomically in this review"
        : "no current evaluation links to this open order yet; kept waiting for a replacement decision") + breachNote;
    } else {
      try {
        const revalidated = await revalidateEvaluation(
          sourceEvaluation,
          liveStateWithoutOpenOrder(liveState, order),
          effectiveCash,
          maxNotional,
          evaluationByToken,
        );
        review.currentEvaluation = liveBatchCandidateSummary(revalidated);
        // When cash is locked in an open order, the normal eligible list can
        // be empty because it was sized against free cash. Revalidate a small
        // portfolio-ordered pool with this order's released notional so a
        // waiting order is compared against the same candidates that position
        // rotation sees.
        const alternativePool = eligible.length
          ? eligible.filter((candidate) => String(candidate.tokenId || "") !== tokenId)
          : candidatePoolForRotation(rotationCandidates).filter((candidate) => String(candidate.tokenId || "") !== tokenId);
        const alternativeCandidates = [];
        for (const alternative of alternativePool.slice(0, ROTATION_CANDIDATE_SCAN_LIMIT)) {
          if (eligible.length) {
            alternativeCandidates.push(alternative);
            continue;
          }
          try {
            const alternativeRevalidated = await revalidateEvaluation(
              alternative,
              liveStateWithoutOpenOrder(liveState, order),
              effectiveCash,
              maxNotional,
              evaluationByToken,
            );
            if (alternativeRevalidated.status === "ELIGIBLE") alternativeCandidates.push(alternativeRevalidated);
          } catch {
            // The current order remains protected when an alternative cannot be
            // freshly verified in this batch.
          }
        }
        const rankedAlternatives = sortLiveEligibleCandidates(alternativeCandidates);
        const bestOther = rankedAlternatives[0] || null;
        const comparison = bestOther ? selectionComparison(revalidated, bestOther) : null;
        // A replacement must rank ahead under the configured portfolio rule, by at
        // least the same minimum-improvement margin position rotation uses -- not by
        // a dollar EV margin. A shorter-horizon candidate can legitimately rank higher
        // on p.a. while paying fewer raw dollars; requiring absolute EV to improve too
        // meant a worse-ranked, longer-resting order was kept over one the portfolio's
        // own ranking metric preferred, for no reason but that it happened to pay more.
        const betterCandidate = bestOther
          && comparison?.replacementRanksAhead
          && Number(comparison.metricDelta || 0) >= ROTATION_MIN_PRIORITY_IMPROVEMENT
          ? bestOther
          : null;
        const betterCandidateCost = number(betterCandidate?.totalCostUsdc ?? betterCandidate?.orderNotionalUsdc);
        const freeCashCanFundBetterCandidate = betterCandidateCost != null
          && number(cash, 0) + 0.00001 >= betterCandidateCost;
        const betterCandidateNeedsReleasedCapital = betterCandidateCost != null && !freeCashCanFundBetterCandidate;
        const orderPrice = number(order.price);
        const newPrice = number(revalidated.orderPrice);
        const priceDelta = Number.isFinite(orderPrice) && Number.isFinite(newPrice) ? newPrice - orderPrice : 0;
        review.betterCandidate = betterCandidate ? liveBatchCandidateSummary(betterCandidate) : null;
        review.selectionComparison = comparison;
        review.priceDelta = Number(priceDelta.toFixed(4));

        if (revalidated.status !== "ELIGIBLE") {
          review.reason = `current revalidation no longer satisfies live rules: ${(revalidated.rejectReasons || []).join("; ") || "not eligible"}; existing order kept because no replacement can be submitted atomically in this review${breachNote}`;
        } else if (betterCandidate && betterCandidateNeedsReleasedCapital && !LIVE_AUTO_ROTATE) {
          // Automatic rotation is off, and cancelling a resting order to fund a different
          // one is a replacement whichever way it is labelled: the portfolio ends up
          // holding something it did not hold before, chosen by the machine. Reported
          // against a run whose settings said LIVE_AUTO_ROTATE=false while the digest
          // recorded CANCELED_FOR_BETTER_CANDIDATE -- the switch gated position rotation
          // only, and this path had never been gated at all.
          //
          // Everything else the review does still runs: expiry sweeps, keep-waiting, and
          // withdrawing an order whose market no longer qualifies. Only the machine's own
          // decision to swap one order for another is what the switch turns off.
          review.reason = `${comparison.metricLabel} priority would support replacing this order, but automatic rotation is off for this portfolio, so it is kept${breachNote}`;
        } else if (betterCandidate && betterCandidateNeedsReleasedCapital) {
          review.action = "CANCEL_FOR_BETTER_CANDIDATE";
          // Keep the freshly validated order payload. After the cancellation
          // succeeds, main() submits this exact replacement immediately and
          // restores the original order if that submission fails.
          review.replacementCandidate = betterCandidate;
          review.reason = `${comparison.metricLabel} priority supports replacement (${comparison.metricLabel} ${selectionMetricDisplay(comparison, comparison.currentMetric)} -> ${selectionMetricDisplay(comparison, comparison.replacementMetric)}, ${comparison.metricDelta >= 0 ? "+" : ""}${selectionMetricDisplay(comparison, comparison.metricDelta)}); expected value ${Number(comparison.currentExpectedValue).toFixed(4)} -> ${Number(comparison.replacementExpectedValue).toFixed(4)} USDC, so the replacement needs this order's locked capital`;
        } else if (betterCandidate) {
          review.reason = betterCandidateCost != null
            ? `${comparison.metricLabel} priority supports replacement, but ${number(cash, 0).toFixed(4)} USDC free cash already covers its ${betterCandidateCost.toFixed(4)} USDC cost; keep this independent order open (${comparison.metricLabel} ${selectionMetricDisplay(comparison, comparison.currentMetric)} -> ${selectionMetricDisplay(comparison, comparison.replacementMetric)})${breachNote}`
            : `${comparison.metricLabel} priority supports replacement, but the candidate has no current executable order cost; keep this independent order open${breachNote}`;
        } else if (comparison && !comparison.replacementRanksAhead && comparison.expectedValueDelta > OPEN_ORDER_BETTER_CANDIDATE_EV_USDC) {
          review.reason = `a candidate has higher absolute expected value (${Number(comparison.currentExpectedValue).toFixed(4)} -> ${Number(comparison.replacementExpectedValue).toFixed(4)} USDC) but ranks lower by ${comparison.metricLabel} (${selectionMetricDisplay(comparison, comparison.currentMetric)} vs ${selectionMetricDisplay(comparison, comparison.replacementMetric)}); keep the current order${breachNote}`;
        } else if (ageHours >= OPEN_ORDER_REVIEW_AFTER_HOURS && Math.abs(priceDelta) >= OPEN_ORDER_REPRICE_THRESHOLD) {
          review.action = "REPLACE";
          review.reason = repriceReason({
            order,
            revalidated,
            priceDelta,
            ageHours,
            previous: previousOpenOrderReview(orderId),
          });
          review.replacementCandidate = revalidated;
        } else if (ageHours >= OPEN_ORDER_CANCEL_AFTER_HOURS) {
          review.reason = `order has waited ${ageHours.toFixed(1)}h without fill; kept because cancelling without an immediate replacement is not allowed${breachNote}`;
        } else {
          review.action = "KEEP_WAITING";
          review.reason = `still eligible and price gap ${Math.abs(priceDelta * 100).toFixed(1)} pts is below reprice threshold${breachNote}`;
        }
      } catch (error) {
        review.reason = `open order revalidation failed: ${error?.message || String(error)}; existing order kept because no replacement can be submitted atomically in this review${breachNote}`;
      }
    }

    if (!selectedAction && review.action !== "KEEP_WAITING") {
      selectedAction = review;
    }
    reviews.push(review);
  }

  if (!selectedAction) {
    return { action: "NONE", reviews };
  }

  try {
    selectedAction.cancelResponse = await cancelOrder(selectedAction, tradingConfig);
    const canceled = successfulCancelResponse(selectedAction.cancelResponse, selectedAction.orderId);
    if (!canceled) {
      selectedAction.action = "CANCEL_REJECTED";
      selectedAction.reason = `cancel request did not confirm cancellation: ${JSON.stringify(selectedAction.cancelResponse)}`;
      return { action: selectedAction.action, selected: selectedAction, reviews };
    }
    if (selectedAction.action === "REPLACE" && selectedAction.replacementCandidate) {
      const replacementOrder = {
        ...selectedAction.replacementCandidate,
        funderAddress: tradingConfig.funderAddress,
        signatureType: tradingConfig.signatureType,
      };
      const replacementSubmission = DRY_RUN || !hasFlag("confirm-live")
        ? {
            order: replacementOrder,
            response: { status: "dry_run_replace", success: true },
            attempts: [{ order: replacementOrder, response: { status: "dry_run_replace", success: true }, precisionRecovery: false }],
          }
        : await submitLiveEntryWithMakerPrecisionRecovery(replacementOrder);
      selectedAction.replacementCandidate = replacementSubmission.order;
      selectedAction.replaceResponse = replacementSubmission.response;
      selectedAction.replacementAttempts = replacementSubmission.attempts.map((attempt) => orderAttemptSummary(
        attempt.order,
        attempt.response,
        {
          makerPrecisionRecovery: attempt.precisionRecovery,
          action: attempt.precisionRecovery
            ? (successfulOrderResponse(attempt.response) ? "PRECISION_RETRY_ACCEPTED" : "PRECISION_RETRY_REJECTED")
            : "REPLACE_ATTEMPT",
        },
      ));
      if (successfulOrderResponse(selectedAction.replaceResponse)) {
        selectedAction.action = "REPLACED";
      } else {
        selectedAction.restoreResponse = await restoreOpenOrder(selectedAction, tradingConfig);
        selectedAction.action = successfulOrderResponse(selectedAction.restoreResponse)
          ? "REPLACE_REJECTED_ORDER_RESTORED"
          : "REPLACE_REJECTED_ORDER_RESTORE_FAILED";
        selectedAction.reason = successfulOrderResponse(selectedAction.restoreResponse)
          ? `replacement order was rejected; original order was immediately restored: ${orderResponseError(selectedAction.replaceResponse) || "unknown replacement response"}`
          : `replacement order was rejected and restoring the original order also failed: ${orderResponseError(selectedAction.replaceResponse) || "unknown replacement response"}`;
      }
    } else {
      selectedAction.action = selectedAction.action === "CANCEL_FOR_BETTER_CANDIDATE" ? "CANCELED_FOR_BETTER_CANDIDATE" : "CANCELED";
    }
  } catch (error) {
    selectedAction.action = "ORDER_MANAGEMENT_ERROR";
    selectedAction.cancelResponse = { error: error?.message || String(error), status: "exception" };
  }

  return { action: selectedAction.action, selected: selectedAction, reviews };
}

async function main() {
  const [loadedLiveState, previousExecution] = await Promise.all([
    loadJsonResource(LIVE_STATE_URL, "live state"),
    loadOptionalJsonResource(LIVE_EXECUTION_STATE_URL, "previous live execution state"),
  ]);
  let liveState = await hydrateLiveOpenOrderMetadata(loadedLiveState);
  previousExecutionState = previousExecution;
  if (SKIP_SCHEDULED_EXECUTION) {
    console.log(JSON.stringify({
      action: "TRIGGER_WAIT",
      reason: "Live portfolio is configured to execute after each scraping batch; scheduled cron execution was skipped.",
      executionTrigger: "after_scrape",
    }, null, 2));
    return;
  }
  // Both of these are portfolio settings, so a manual run always overrides them --
  // turning automation off must not also take away the ability to run it by hand.
  if (!IS_MANUAL_RUN && !AUTOMATION_ENABLED) {
    console.log(JSON.stringify({
      action: "AUTOMATION_DISABLED",
      reason: "Automatic execution is switched off for this portfolio; only a manual run will trade.",
      automationEnabled: false,
    }, null, 2));
    return;
  }
  const minutesSincePreviousRun = previousExecution?.generatedAt
    ? (Date.now() - Date.parse(previousExecution.generatedAt)) / 60000
    : null;
  if (!IS_MANUAL_RUN
    && EXECUTION_CRON_MINUTES > 0
    && Number.isFinite(minutesSincePreviousRun)
    && minutesSincePreviousRun < EXECUTION_CRON_MINUTES) {
    console.log(JSON.stringify({
      action: "CADENCE_WAIT",
      reason: `Portfolio cadence is every ${EXECUTION_CRON_MINUTES} minutes and the last run was ${minutesSincePreviousRun.toFixed(1)} minutes ago; polling skipped: no live execution review is due.`,
      cadenceMinutes: EXECUTION_CRON_MINUTES,
    }, null, 2));
    return;
  }
  const [paperState, scrapedState] = await Promise.all([
    loadJsonResource(PAPER_STATE_URL, "paper state"),
    PROBABILITY_SOURCE === "polymarket"
      ? loadScopedExecutionCatalogue(PAPER_SCRAPED_STATE_URL, "scraped Polymarket state")
      : Promise.resolve(null),
  ]);
  // Before anything is measured against the book: a bid on a market that is over can
  // never fill for a reason worth having, and until it is withdrawn its collateral is
  // counted as committed. Sweeping first means the cash it was holding is spendable in
  // this run, and every figure below is taken after the sweep rather than before it.
  const tradingConfig = liveTradingConfig(liveState);
  const expiredOrderSweep = await withdrawExpiredOpenOrders({ liveState, tradingConfig });
  liveState = expiredOrderSweep.liveState;

  const cash = liveCashUsdc(liveState);
  // The wallet total is still reported, so the gap between what the account has locked
  // and what this portfolio locked stays visible in the run.
  const reservedOpenOrderUsdc = activeBuyOrderReservationUsdc(liveState);
  const ownReservedOpenOrderUsdc = activeBuyOrderReservationUsdc(
    liveState,
    ownSubmittedOrderIdentity(previousExecution),
  );
  // The reservations above stay reported so the run shows what the account has resting,
  // but they no longer reduce what this portfolio may spend: a resting bid is a claim on
  // collateral at match time, not money already gone.
  const availableCash = availableLiveCashUsdc(liveState, cash);
  const portfolioValue = livePortfolioValue(liveState, cash);
  const legacyFractionNotional = portfolioValue * MAX_ORDER_FRACTION;
  const configuredStakeUsdc = Number.isFinite(LIVE_STAKE_USDC) && LIVE_STAKE_USDC > 0
    ? LIVE_STAKE_USDC
    : legacyFractionNotional;
  const monitoring = liveCashMonitoring(previousExecution, availableCash);
  const regularMaxNotional = Math.min(configuredStakeUsdc, MAX_ORDER_NOTIONAL_USDC);
  const idleUtilizationNotional = monitoring.idleCashOverdue ? Math.max(0, availableCash - IDLE_CASH_MAX_USDC) : 0;
  const maxNotional = Number(regularMaxNotional.toFixed(5));
  const directMaxNotional = Number(Math.min(maxNotional, availableCash).toFixed(5));
  const storedEvaluations = storedEvaluationCount(paperState);
  const rawMarketObservations = Array.isArray(scrapedState?.marketObservations)
    ? scrapedState.marketObservations
    : [];
  // Candidates come from the scraped Polymarket catalogue. PROBABILITY_SOURCE is a
  // constant here, so the stored evaluations were never the source -- they were fetched,
  // in full, to print one count. The ternary that pretended otherwise is gone rather than
  // left as a branch that would silently produce an empty shortlist now that the paper
  // state is read as a summary that carries no catalogue.
  const rawCandidateRows = rawMarketObservations;
  const candidatePool = prepareLiveCandidatePool(rawCandidateRows, liveState);
  const latestEvaluations = candidatePool.uniqueEvaluations;
  const evaluationByToken = new Map(latestEvaluations.map((item) => [String(item.tokenId || ""), item]).filter(([tokenId]) => tokenId));
  const manualShortlistFallback = candidatePool.diagnostics.manualShortlistFallback === true;
  // A rotation is a single approved swap. After its sell leg, the completion pass
  // must revalidate and buy exactly that approved replacement. Re-running the general
  // shortlist here previously sold a position and then sometimes bought the same token
  // back minutes later, banking the loss with no economic benefit.
  const baseCandidates = restrictCandidatesToRotationPlan(
    candidatePool.candidates,
    previousExecution,
    ROTATION_COMPLETION_RUN,
  );

  const checked = [];
  for (const evaluation of baseCandidates) {
    try {
      checked.push(await revalidateEvaluation(evaluation, liveState, availableCash, directMaxNotional, evaluationByToken));
    } catch (error) {
      checked.push({
        candidate: {
          tokenId: evaluation.tokenId,
          question: evaluation.question,
          outcome: evaluation.outcome,
          evaluatedAt: evaluation.evaluatedAt,
        },
        eligible: false,
        status: "ERROR",
        rejectReasons: [error.message],
      });
    }
  }

  if (FIXED_ENTRY_STRATEGY) {
    // Expired-order withdrawal already ran above, unconditionally. Archiving stops
    // only what happens next: resting new bids.
    if (!IS_MANUAL_RUN && ARCHIVED) {
      console.log(JSON.stringify({
        action: "ARCHIVED",
        reason: "This portfolio is archived; automatic runs no longer rest new bids. Expired resting orders are still withdrawn and the account snapshot still refreshes.",
        archived: true,
      }, null, 2));
      return;
    }
    await runFixedEntryBatch({ checked, liveState, tradingConfig, cash, availableCash, evaluationByToken, expiredOrderSweep });
    return;
  }

  const allEligible = checked
    .filter((item) => item.status === "ELIGIBLE")
    .filter((item) => Number.isFinite(Number(item.annualizedReturn)) && Number(item.annualizedReturn) > 0)
    .filter((item) => Number.isFinite(Number(item.expectedValueUsdc)) && Number(item.expectedValueUsdc) > 0)
    .map((item) => ({
      ...item,
      funderAddress: tradingConfig.funderAddress,
      signatureType: tradingConfig.signatureType,
    }));
  const eligible = HAS_MANUAL_SHORTLIST && !manualShortlistFallback
    ? allEligible
    : sortLiveEligibleCandidates(allEligible);
  const cashSizingBlocked = checked.filter((item) => item.executionBlocker === "CASH");
  const stakeCapBlockedCandidates = checked.filter((item) => item.executionBlocker === "STAKE_CAP");
  const makerPrecisionBlockedCandidates = checked.filter((item) => item.executionBlocker === "MAKER_PRECISION");
  const riskBlockedCandidates = checked.filter((item) => (item.rejectReasons || [])
    .some((reason) => /^(correlated live exposure|duplicate token already open)/i.test(String(reason || ""))));
  // A rotation is justified only for a genuine free-cash shortfall. A minimum
  // order above the configured stake cap cannot be fixed by freeing more cash.
  const hasUsableFreeCash = availableCash > 0.01;
  const needsCapitalRotation = !eligible.length && cashSizingBlocked.length > 0;
  const needsRiskReplacement = !eligible.length && !needsCapitalRotation && riskBlockedCandidates.length > 0;
  // With automatic rotation off there is nothing this review can act on, so running it
  // spends exchange calls to fill the run log with replacements that will never happen --
  // which is what made a run with LIVE_AUTO_ROTATE=false read as though the executor were
  // trying to replace positions anyway. A risk replacement is the one exception: that is
  // a diversification breach being corrected rather than an optimisation, and it must
  // still be surfaced whatever the rotation switch says.
  const rotationReview = !ROTATION_COMPLETION_RUN
    && !eligible.length
    && (LIVE_AUTO_ROTATE || needsRiskReplacement)
    && (needsCapitalRotation || needsRiskReplacement)
    ? await reviewPositionRotation({
        liveState,
        evaluationByToken,
        baseCandidates,
        cash: availableCash,
        maxNotional,
        restrictToRiskReplacement: needsRiskReplacement,
      })
    : null;
  const rotationCandidatePool = candidatePoolForRotation(baseCandidates, {
    latestResolutionMs: latestHoldingResolutionMs(liveState, evaluationByToken),
  });
  const activeSellOrders = (Array.isArray(liveState.openOrders) ? liveState.openOrders : [])
    .filter((order) => String(order.side || "").toUpperCase().includes("SELL"));
  const directBest = eligible[0] || null;
  const directCandidateCost = directBest
    ? number(directBest.totalCostUsdc ?? directBest.orderNotionalUsdc)
    : null;
  const directCandidateCanUseFreeCapital = Boolean(directBest
    && Number.isFinite(directCandidateCost)
    && directCandidateCost <= availableCash + 0.00001);
  // Use free cash for a direct candidate before touching existing orders or
  // positions. An unrelated buy is allowed while a sell order is pending.
  const directCapitalPriority = directCandidateCanUseFreeCapital;
  // A pending BUY is not a fungible cash reserve. The executor used to cancel or
  // reprice it when a later candidate could use its collateral. That contradicts the
  // portfolio contract: an order stays until it fills or Polymarket resolves its
  // market. Expired/resolved withdrawals are handled above, independently.
  const orderManagement = { action: "NONE", reviews: [] };

  // A cancelled buy order releases capital immediately. Continue with the same
  // revalidated shortlist instead of leaving the portfolio idle until the next run.
  const canceledForBetterCandidate = orderManagement.action === "CANCELED_FOR_BETTER_CANDIDATE";
  const best = canceledForBetterCandidate && orderManagement.selected?.replacementCandidate
    ? orderManagement.selected.replacementCandidate
    : directBest;
  const bestCandidateCost = best
    ? number(best.totalCostUsdc ?? best.orderNotionalUsdc)
    : null;
  const releasedOrderNotional = canceledForBetterCandidate
    ? number(
      orderManagement.selected?.lockedNotionalUsdc
      ?? orderManagement.selected?.notionalUsdc
      ?? orderManagement.selected?.orderNotionalUsdc,
      0,
    )
    : 0;
  const availableCashAfterOrderManagement = availableCash + releasedOrderNotional;
  // What the next order would actually cost. With no sized candidate this used to be
  // min(maxNotional, availableCash), i.e. what the portfolio would like to spend capped by
  // its own cash -- so a run could report "$3.42 available / $3.40 required / capital
  // insufficient", which reads as a contradiction. The real requirement is the cheapest
  // exchange minimum among the candidates that could not be funded, fees included.
  const blockedMinimumOrderCosts = cashSizingBlocked
    .map((item) => number(item.minOrderNotionalUsdc, 0))
    .filter((cost) => cost > 0);
  const cheapestBlockedMinimumCost = blockedMinimumOrderCosts.length
    ? Math.min(...blockedMinimumOrderCosts)
    : null;
  const appliedDirectStake = best?.totalCostUsdc != null
    ? number(best.totalCostUsdc, 0)
    : (cheapestBlockedMinimumCost != null
      ? cheapestBlockedMinimumCost
      : Math.min(maxNotional, Math.max(0, availableCashAfterOrderManagement)));
  // Replacing an order that this run just cancelled is order management, not an
  // additional portfolio allocation. Continue with its released capital in
  // this same batch.
  const rotationAvailable = rotationReview?.action === "ROTATION_AVAILABLE";
  const rotationComparison = rotationComparisonRows(rotationReview, orderManagement.reviews);
  const rotationHumanReason = rotationAvailable ? rotationHumanComparison(rotationReview.best) : "";
  const actionReason = canceledForBetterCandidate
    ? "a waiting order released its locked capital and the better validated replacement is submitted immediately"
    : directCapitalPriority
    ? "free capital prioritized: best direct candidate is submitted before order or position rotation"
    : activeSellOrders.length
    ? "waiting for an existing live sell order to reduce position exposure before any replacement buy"
    : (rotationAvailable && LIVE_AUTO_ROTATE
      ? (needsRiskReplacement
        ? `${rotationHumanReason || "A risk-overlap replacement will sell the conflicting position before placing the replacement buy."}`
        : `${rotationHumanReason || "Cash is insufficient for a direct order, so the weakest position will be sold before the replacement buy."}`)
      : (best
        ? "best currently revalidated executable candidate"
        : (rotationAvailable
            ? "cash is insufficient for a new direct order; a sell-and-replace rotation candidate was identified"
            : (cashSizingBlocked.length
                ? `live candidates blocked by available USDC: ${cashSizingBlocked.length} cannot meet the current Polymarket minimum order size${cheapestBlockedMinimumCost != null ? ` (cheapest needs ${cheapestBlockedMinimumCost.toFixed(4)} USDC including fees, ${number(availableCashAfterOrderManagement, 0).toFixed(4)} USDC available)` : ""}`
                : (stakeCapBlockedCandidates.length
                  ? `free cash is sufficient, but ${stakeCapBlockedCandidates.length} live candidate${stakeCapBlockedCandidates.length === 1 ? " is" : "s are"} below Polymarket's minimum order size at the configured fixed stake`
                  : "no currently executable candidate after live revalidation")))));
  // The rest of the capital is either in positions, which position rotation decides on,
  // or in resting orders, which the open-order review decides on. Saying which, and what
  // that review concluded, is the difference between "the rules declined" and "something
  // is broken" -- the two this log could not tell apart.
  // Reported: a candidate stayed visible on the dashboard across several runs while every
  // one of those runs logged only "all revalidated candidates failed current execution
  // criteria". It had in fact been evaluated each time and found finished -- the match was
  // over and Polymarket had simply not settled it yet. That is worth saying in the run's
  // own note rather than leaving it to be dug out of a capped rejection list, and it also
  // records that the row has now been taken out of the candidate pool.
  const finishedAwaitingResolution = checked.filter((item) => item?.awaitingResolution);
  const finishedAwaitingResolutionNote = finishedAwaitingResolution.length
    ? ` ${finishedAwaitingResolution.length} candidate(s) were evaluated and found already finished,`
      + ` waiting only for Polymarket to publish a resolution: ${finishedAwaitingResolution
        .slice(0, 3)
        .map((item) => `${item.candidate?.question || item.question || item.candidate?.tokenId || "?"}`)
        .join("; ")}${finishedAwaitingResolution.length > 3 ? ", …" : ""}.`
      + " No order could be placed on them and they are now marked closed, so they drop out"
      + " of the candidate list for the next run."
    : "";
  const restingBuyOrderCount = (Array.isArray(liveState.openOrders) ? liveState.openOrders : [])
    .filter((order) => !String(order.side || "").toUpperCase().includes("SELL")).length;
  const heldPositionCount = openPositionsForRotation(liveState).length;
  const orderReviewOutcome = orderManagement?.reviews?.length
    ? `the open-order review looked at ${orderManagement.reviews.length} of them and chose ${orderManagement.action === "NONE" ? "to keep every one" : orderManagement.action}`
    : (restingBuyOrderCount ? "the open-order review did not run this pass" : "");
  const capitalLocationNote = restingBuyOrderCount || heldPositionCount
    ? ` The rest of this portfolio's capital is in ${heldPositionCount} position(s) and ${restingBuyOrderCount} resting order(s)${orderReviewOutcome ? `; ${orderReviewOutcome}` : ""}.`
    : "";
  const actionExplanation = canceledForBetterCandidate
    ? "The waiting order released its own locked capital only after a better candidate passed the portfolio comparison. The replacement is submitted in this same batch; if submission fails, the original order is restored."
    : directCapitalPriority
    ? "A currently executable candidate has available free capital. The batch submits it first; existing orders and positions are considered for rotation only when no direct allocation is possible."
    : activeSellOrders.length
    ? "A live sell order is open. The system waits for account sync to confirm the exit before it can revalidate and place a replacement buy."
    : (rotationAvailable && LIVE_AUTO_ROTATE
      ? (needsRiskReplacement
        ? "The replacement conflicts with the selected live position under diversification rules, so the system sells that position first and waits for account sync before buying the replacement."
        : "Available cash cannot support a direct order, so the system sells the selected weaker position first and waits for account sync before considering the replacement.")
      : (best
      ? "Live batch found an executable candidate after revalidation."
      : (rotationAvailable
            ? "No live order was submitted because opening the better candidate would first require selling an existing live position; this run records the rotation review but does not perform the sell/rebuy sequence automatically."
            : (cashSizingBlocked.length
                // Where the missing capital actually is, and what decided not to free it.
                // Without this the note says only that cash is short, while the rotation
                // block says there was no position to rotate -- and a reader is left
                // unable to tell a working rule from a broken one.
                ? `No live order was submitted because available USDC cannot cover the exchange minimum size for the revalidated candidate(s).${cheapestBlockedMinimumCost != null ? ` The cheapest of them needs ${cheapestBlockedMinimumCost.toFixed(4)} USDC including fees against ${number(availableCashAfterOrderManagement, 0).toFixed(4)} USDC available.` : ""}${capitalLocationNote}`
                : (stakeCapBlockedCandidates.length
                  ? "No live order was submitted because the configured fixed stake is below Polymarket's exchange minimum. Free cash was sufficient, so no order or position was rotated."
                  : `No live order was submitted because all revalidated candidates failed current execution criteria.${finishedAwaitingResolutionNote}`)))));
  const decision = {
    mode: DRY_RUN || !hasFlag("confirm-live") ? "validated-dry-run" : "live-submit",
    action: best ? (DRY_RUN || !hasFlag("confirm-live") ? "DRY_RUN_READY" : "SUBMIT") : "SKIP",
    reason: actionReason,
    generatedAt: new Date().toISOString(),
    account: {
      address: liveState?.account?.address || FUNDER_ADDRESS,
      funderAddress: tradingConfig.funderAddress,
      signatureType: tradingConfig.signatureType,
      cashUsdc: cash,
      // Both, so a run makes plain that the wallet has more locked than this portfolio
      // did -- the difference is the other live portfolio's resting bids.
      reservedOpenOrderUsdc: Number(reservedOpenOrderUsdc.toFixed(5)),
      ownReservedOpenOrderUsdc: Number(ownReservedOpenOrderUsdc.toFixed(5)),
      availableCashUsdc: Number(availableCash.toFixed(5)),
      portfolioValueUsdc: Number(portfolioValue.toFixed(5)),
      stakeUsdc: Number(configuredStakeUsdc.toFixed(5)),
      maxOrderFraction: MAX_ORDER_FRACTION,
      maxOrderNotionalCapUsdc: Number.isFinite(MAX_ORDER_NOTIONAL_USDC) ? MAX_ORDER_NOTIONAL_USDC : null,
      maxNotionalUsdc: maxNotional,
      regularMaxNotionalUsdc: Number(regularMaxNotional.toFixed(5)),
      idleUtilizationNotionalUsdc: Number(idleUtilizationNotional.toFixed(5)),
      openPositions: Array.isArray(liveState.positions) ? liveState.positions.length : 0,
      openOrders: Array.isArray(liveState.openOrders) ? liveState.openOrders.length : 0,
    },
    monitoring,
    settings: {
      useLimitOrders: USE_LIMIT_ORDERS,
      crossPortfolioRiskDiversification: CROSS_PORTFOLIO_RISK_DIVERSIFICATION,
      liveAutoRotate: LIVE_AUTO_ROTATE,
      postOnly: POST_ONLY,
      orderSizeMode: ORDER_SIZE_MODE,
      minProbability: MIN_PROBABILITY,
      maxProbability: MAX_PROBABILITY,
      marketType: PORTFOLIO_MARKET_TYPE,
      excludeOverUnderMarkets: EXCLUDE_OVER_UNDER_MARKETS,
      probabilitySource: PROBABILITY_SOURCE,
      minAnnualReturn: MIN_ANNUAL_RETURN,
      maxSpread: MAX_SPREAD,
      minVolume24hr: MIN_VOLUME_24H,
      minNetYield: MIN_NET_YIELD,
      maxResolutionDays: MAX_RESOLUTION_DAYS,
      selectionOrder: SELECTION_ORDER,
      stakeUsdc: Number(configuredStakeUsdc.toFixed(5)),
      maxOrderNotionalCapUsdc: Number.isFinite(MAX_ORDER_NOTIONAL_USDC) ? MAX_ORDER_NOTIONAL_USDC : null,
      idleCashMaxUsdc: IDLE_CASH_MAX_USDC,
      idleCashGraceHours: IDLE_CASH_GRACE_HOURS,
      freeCapitalPriority: true,
      hasUsableFreeCash,
      directCandidateCanUseFreeCapital,
      directCandidateCostUsdc: directCandidateCost,
      manualShortlistFallback,
      capitalUtilizationOverride: monitoring.idleCashOverdue,
      storedEvaluations,
      uniqueEvaluations: latestEvaluations.length,
      prefilterPassedCandidates: candidatePool.diagnostics.prefilterPassed,
      prefilterRejectedCandidates: candidatePool.diagnostics.prefilterRejected,
      skippedByScanLimit: candidatePool.diagnostics.skippedByScanLimit,
      scannedCandidates: baseCandidates.length,
      revalidatedCandidates: checked.length,
      eligibleCandidates: allEligible.length,
      capitalSizingBlockedCandidates: cashSizingBlocked.length,
      stakeCapBlockedCandidates: stakeCapBlockedCandidates.length,
      makerPrecisionBlockedCandidates: makerPrecisionBlockedCandidates.length,
      openOrderReviewAfterHours: OPEN_ORDER_REVIEW_AFTER_HOURS,
      openOrderCancelAfterHours: OPEN_ORDER_CANCEL_AFTER_HOURS,
      openOrderRepriceThreshold: OPEN_ORDER_REPRICE_THRESHOLD,
      rotationTrigger: needsRiskReplacement ? "risk-overlap" : (needsCapitalRotation ? "capital" : null),
      rotationMinimumPriorityImprovement: ROTATION_MIN_PRIORITY_IMPROVEMENT,
      rotationMinimumNetPnlImprovementUsdc: ROTATION_MIN_NET_PNL_IMPROVEMENT_USDC,
      rotationProtectRemainingGainUsdc: ROTATION_PROTECT_REMAINING_GAIN_USDC,
    },
    orderManagement,
    expiredOrderSweep,
    rotationReview,
    rotationExit: null,
    revalidationUpdates: checked
      .map((item) => liveRevalidationUpdate(item, new Date().toISOString()))
      .filter((item) => item.tokenId),
    selected: best,
    batchLog: {
      id: `live-trade-batch-${new Date().toISOString()}`,
      runAt: new Date().toISOString(),
      strategyId: "live",
      strategyLabel: "Live",
      runSource: String(process.env.LIVE_RUN_SOURCE || "AUTO").toUpperCase() === "MANUAL" ? "MANUAL" : "AUTO",
      manualRunOnce: String(process.env.LIVE_RUN_SOURCE || "").toUpperCase() === "MANUAL",
      selectionMetric: returnMetricLabel(),
      action: best ? (DRY_RUN || !hasFlag("confirm-live") ? "DRY_RUN_READY" : "SUBMIT") : "SKIP",
      reason: actionReason,
      explanation: actionExplanation,
      humanReason: rotationHumanReason || null,
      settings: {
        minProbability: MIN_PROBABILITY,
        maxProbability: MAX_PROBABILITY,
        marketType: PORTFOLIO_MARKET_TYPE,
        excludeOverUnderMarkets: EXCLUDE_OVER_UNDER_MARKETS,
        probabilitySource: PROBABILITY_SOURCE,
        minAnnualReturn: MIN_ANNUAL_RETURN,
        maxSpread: MAX_SPREAD,
        minVolume24hr: MIN_VOLUME_24H,
        minNetYield: MIN_NET_YIELD,
        maxResolutionDays: MAX_RESOLUTION_DAYS,
        executionTrigger: EXECUTION_TRIGGER,
        freeCapitalPriority: true,
        hasUsableFreeCash,
        directCandidateCanUseFreeCapital,
        directCandidateCostUsdc: directCandidateCost,
        manualShortlistFallback,
        selectionOrder: SELECTION_ORDER,
        useLimitOrders: USE_LIMIT_ORDERS,
        crossPortfolioRiskDiversification: CROSS_PORTFOLIO_RISK_DIVERSIFICATION,
        liveAutoRotate: LIVE_AUTO_ROTATE,
        stakeUsdc: Number(configuredStakeUsdc.toFixed(5)),
        maxOrderFraction: MAX_ORDER_FRACTION,
        rotationMinimumPriorityImprovement: ROTATION_MIN_PRIORITY_IMPROVEMENT,
        rotationMinimumNetPnlImprovementUsdc: ROTATION_MIN_NET_PNL_IMPROVEMENT_USDC,
        rotationProtectRemainingGainUsdc: ROTATION_PROTECT_REMAINING_GAIN_USDC,
      },
      capital: {
        availableUsdc: availableCash,
        grossCashUsdc: cash,
        reservedOpenOrderUsdc: Number(reservedOpenOrderUsdc.toFixed(5)),
        ownReservedOpenOrderUsdc: Number(ownReservedOpenOrderUsdc.toFixed(5)),
        portfolioValueUsdc: Number(portfolioValue.toFixed(5)),
        configuredStakeUsdc: Number(configuredStakeUsdc.toFixed(5)),
        targetStakeUsdc: maxNotional,
        requiredStakeUsdc: Number(appliedDirectStake.toFixed(5)),
        insufficientCapital: !best && (!Number.isFinite(maxNotional) || maxNotional <= 0 || cashSizingBlocked.length > 0),
        capitalSizingBlockedCandidates: cashSizingBlocked.length,
        stakeCapBlockedCandidates: stakeCapBlockedCandidates.length,
        // Capital this run recovered from bids on markets that were already over. It is
        // part of availableUsdc above, and it is reported separately because a portfolio
        // whose cash keeps disappearing into stranded orders is a thing to notice.
        expiredOrdersWithdrawn: expiredOrderSweep.withdrawn.length,
        expiredOrdersUnwithdrawable: expiredOrderSweep.failed.length,
        expiredOrderCashReleasedUsdc: expiredOrderSweep.releasedUsdc,
      },
      counts: {
        storedEvaluations,
        uniqueEvaluations: latestEvaluations.length,
        prefilterPassedCandidates: candidatePool.diagnostics.prefilterPassed,
        prefilterRejectedCandidates: candidatePool.diagnostics.prefilterRejected,
        // Why those were rejected, grouped. The count alone said a thousand candidates
        // were dropped before revalidation and nothing about which rule dropped them, so
        // a candidate visible on the dashboard but absent from the run could not be
        // explained from the log at all -- which is the question a skipped run raises.
        // This belongs in `counts` specifically: that is the object the run digest reads.
        prefilterRejectionReasons: candidatePool.diagnostics.reasonCounts,
        skippedByScanLimit: candidatePool.diagnostics.skippedByScanLimit,
        scannedCandidates: baseCandidates.length,
        revalidatedCandidates: checked.length,
        eligibleCandidates: allEligible.length,
        capitalSizingBlockedCandidates: cashSizingBlocked.length,
        stakeCapBlockedCandidates: stakeCapBlockedCandidates.length,
        makerPrecisionBlockedCandidates: makerPrecisionBlockedCandidates.length,
        rankedEligibleCandidates: eligible.length,
        // Candidates this run tried to execute and found already over: past their
        // scheduled end with nothing left to quote. They are counted separately from the
        // ordinary rejections because they are not a rule declining a trade -- the event
        // finished -- and because each one has just been retired from the candidate list.
        finishedAwaitingResolutionCandidates: finishedAwaitingResolution.length,
        openOrdersReviewed: orderManagement.reviews.length,
        positionsReviewedForRotation: rotationReview?.reviews?.length || 0,
        rotationAvailable,
        riskBlockedCandidates: riskBlockedCandidates.length,
        rejectedCandidates: checked.filter((item) => item.status !== "ELIGIBLE").length,
      },
      openOrderReviews: orderManagement.reviews,
      rotationComparison,
      rotationReview,
      prevalidationFilter: candidatePool.diagnostics,
      selected: best ? liveBatchCandidateSummary(best) : null,
      revalidatedCandidates: checked.map(liveBatchCandidateSummary),
      topCandidates: eligible.slice(0, 8).map(liveBatchCandidateSummary),
      topRejected: checked.filter((item) => item.status !== "ELIGIBLE").slice(0, REJECTED_CANDIDATE_LOG_LIMIT).map(liveBatchCandidateSummary),
    },
    topRejected: checked
      .filter((item) => item.status !== "ELIGIBLE")
      .slice(0, REJECTED_CANDIDATE_LOG_LIMIT)
      .map((item) => ({
        question: item.question || item.candidate?.question,
        outcome: item.outcome || item.candidate?.outcome,
        tokenId: item.tokenId || item.candidate?.tokenId,
        evaluatedAt: item.evaluatedAt || item.candidate?.evaluatedAt,
        rejectReasons: item.rejectReasons || [],
        currentPrice: item.currentPrice || item.marketPrice || null,
        minOrderSize: item.minOrderSize || null,
      })),
  };

  if (orderManagement.action !== "NONE" && !canceledForBetterCandidate) {
    await emitDecision({
      ...decision,
      action: orderManagement.action,
      reason: orderManagement.selected?.reason || "open order management action completed",
      batchLog: {
        ...decision.batchLog,
        action: orderManagement.action,
        reason: orderManagement.selected?.reason || "open order management action completed",
        // The old note said only that open orders had been reviewed, which left the reader
        // of a REPLACED run with no way to tell a reprice of our own bid from a swap of one
        // event for another -- the two read identically. It now names the action's subject.
        explanation: openOrderActionExplanation(orderManagement),
      },
      attempts: [orderManagement.selected],
    });
    return;
  }

  if (activeSellOrders.length && !best) {
    const pendingRotationExit = previousExecution?.rotationExit || null;
    // A rotation exit is submitted as FAK: it fills against the bid immediately or it is
    // killed. So a sell order still resting here means the exit never completed -- the
    // book moved away from the price it was posted at. Waiting cannot fix that: the
    // resting order reserves the position's shares, so the position can be neither sold
    // nor rotated, and every later run takes this same early return. That is a deadlock,
    // and it is what left a 93%-entry position frozen while the market traded at 25%.
    //
    // Cancel the stale order and close the position at the current bid instead, which is
    // what a market close means here. The run then reports ROTATION_EXIT_SUBMITTED, so
    // the workflow's immediate-replacement step buys the selected opportunity in the
    // same run rather than waiting for a fill that is not coming.
    const staleSellOrders = activeSellOrders
      .filter((order) => openOrderAgeHours(order) * 60 >= ROTATION_EXIT_STALE_MINUTES);
    if (staleSellOrders.length) {
      const repairs = [];
      for (const order of staleSellOrders) {
        const cancelResponse = DRY_RUN || !hasFlag("confirm-live")
          ? { status: "dry_run_cancel", success: true }
          : await cancelOrder(order, tradingConfig);
        if (!successfulCancelResponse(cancelResponse, order.id || order.orderID || order.orderId)) {
          repairs.push({ order, cancelResponse, response: null, action: "ROTATION_EXIT_CANCEL_FAILED" });
          continue;
        }
        // Re-price against the book as it stands now, not the price that failed.
        let exitOrder = null;
        let response = null;
        try {
          exitOrder = await buildRotationExitOrder(
            { ...order, shares: number(order.remainingSize ?? order.originalSize) },
            evaluationByToken,
            tradingConfig,
          );
          response = DRY_RUN || !hasFlag("confirm-live")
            ? { status: "dry_run_rotation_exit", success: true }
            : await submitOrder(exitOrder);
        } catch (error) {
          response = { status: "exception", error: error?.message || String(error) };
        }
        repairs.push({
          order: exitOrder || order,
          cancelResponse,
          response,
          action: successfulOrderResponse(response) ? "ROTATION_EXIT_REPRICED" : "ROTATION_EXIT_REPRICE_REJECTED",
        });
      }
      const repriced = repairs.filter((repair) => repair.action === "ROTATION_EXIT_REPRICED");
      const action = repriced.length
        ? (DRY_RUN || !hasFlag("confirm-live") ? "DRY_RUN_ROTATION_EXIT" : "ROTATION_EXIT_SUBMITTED")
        : "ROTATION_EXIT_REJECTED";
      const reason = repriced.length
        ? `stale rotation exit re-closed at the current bid after ${ROTATION_EXIT_STALE_MINUTES} minutes without a fill; the replacement buy follows in this run`
        : `stale rotation exit could not be re-closed: ${repairs.map((repair) => orderResponseError(repair.response) || orderResponseError(repair.cancelResponse) || repair.action).join("; ")}`;
      await emitDecision({
        ...decision,
        action,
        reason,
        rotationExit: repriced.length ? { ...(pendingRotationExit || {}), repricedAt: new Date().toISOString() } : pendingRotationExit,
        batchLog: {
          ...decision.batchLog,
          action,
          reason,
          explanation: "A rotation exit is a taker order, so a sell still resting on the book never filled. It was cancelled and re-closed against the current bid; leaving it would reserve the position's shares and block every later run.",
          rotationExit: repriced.length ? { ...(pendingRotationExit || {}), repricedAt: new Date().toISOString() } : pendingRotationExit,
        },
        attempts: repairs.map((repair) => orderAttemptSummary(repair.order, repair.response, {
          action: repair.action,
          cancelResponse: repair.cancelResponse,
        })),
      });
      return;
    }
    await emitDecision({
      ...decision,
      action: "ROTATION_EXIT_WAITING",
      reason: "waiting for the live sell order to fill before selecting a replacement",
      rotationExit: pendingRotationExit,
      batchLog: {
        ...decision.batchLog,
        action: "ROTATION_EXIT_WAITING",
        reason: "waiting for the live sell order to fill before selecting a replacement",
        explanation: "No replacement buy is allowed while the rotation exit remains open. The next account sync will release the token exposure once the sell fills.",
        rotationExit: pendingRotationExit,
      },
      attempts: activeSellOrders.map((order) => orderAttemptSummary({
        ...order,
        question: order.question || "Rotation exit",
        outcome: order.outcome || "",
        orderType: "GTC",
        orderPrice: order.price,
        orderSize: order.remainingSize,
        orderNotionalUsdc: order.notionalUsdc,
        side: "SELL",
      }, null, { action: "WAITING_FOR_SELL_FILL" })),
    });
    return;
  }

  if (rotationAvailable && LIVE_AUTO_ROTATE) {
    const rotation = rotationReview.best;
    let exitOrder = null;
    let response = null;
    let rotationBlockedReason = "";
    let finalProfitGuard = rotation.priorityComparison?.netProfitGuard || null;
    try {
      exitOrder = await buildRotationExitOrder(
        rotation.positionOrder || rotation.position,
        evaluationByToken,
        tradingConfig,
      );
      const quotedPosition = positionAtExitPrice(
        rotation.positionOrder || rotation.position,
        exitOrder.orderPrice,
      );
      const freshEconomics = positionRotationEconomics(quotedPosition, evaluationByToken);
      const candidateTokenId = String(rotation.candidateTokenId || rotation.candidate?.tokenId || "");
      const candidateSource = evaluationByToken.get(candidateTokenId) || rotation.candidate;
      const cashAfterFreshExit = availableCash + Math.max(0, number(freshEconomics.netExitValue, 0));
      const freshCandidate = await revalidateEvaluation(
        candidateSource,
        liveStateWithoutPosition(liveState, quotedPosition),
        cashAfterFreshExit,
        maxNotional,
        evaluationByToken,
        { forceTakerEntry: ROTATION_TAKER_ENTRY },
      );
      if (freshCandidate.status !== "ELIGIBLE") {
        rotationBlockedReason = `approved replacement failed the final live check: ${(freshCandidate.rejectReasons || ["not eligible"]).join("; ")}`;
      } else {
        finalProfitGuard = rotationNetProfitGuard({
          economics: freshEconomics,
          candidate: freshCandidate,
          capitalBaseUsdc: Math.max(
            number(freshEconomics.cost, 0),
            number(freshCandidate.totalCostUsdc, 0),
          ),
        });
        if (!finalProfitGuard.allowed) {
          rotationBlockedReason = `fresh bid/ask check rejected the rotation: maximum net P/L would improve by ${Number(finalProfitGuard.maximumPnlDeltaUsdc ?? 0).toFixed(4)} USDC, below the required ${Number(finalProfitGuard.requiredImprovementUsdc ?? 0).toFixed(4)} USDC`;
        } else {
          rotation.candidate = liveBatchCandidateSummary(freshCandidate);
          rotation.candidateTokenId = freshCandidate.tokenId || candidateTokenId;
          rotation.priorityComparison = {
            ...(rotation.priorityComparison || {}),
            netProfitGuard: finalProfitGuard,
            currentRealizedPnlIfExitUsdc: freshEconomics.realizedPnlIfExit,
            currentExitFeeUsdc: freshEconomics.exitFee,
            replacementExpectedValueUsdc: freshCandidate.netGainIfWinUsdc,
          };
        }
      }
      response = rotationBlockedReason
        ? { status: "rotation_guard_rejected", error: rotationBlockedReason }
        : (DRY_RUN || !hasFlag("confirm-live")
          ? { status: "dry_run_rotation_exit", success: true }
          : await submitOrder(exitOrder));
    } catch (error) {
      response = { status: "exception", error: error?.message || String(error) };
    }
    const accepted = successfulOrderResponse(response);
    const action = accepted
      ? (DRY_RUN || !hasFlag("confirm-live") ? "DRY_RUN_ROTATION_EXIT" : "ROTATION_EXIT_SUBMITTED")
      : (rotationBlockedReason ? "ROTATION_REVALIDATION_REJECTED" : "ROTATION_EXIT_REJECTED");
    const reason = accepted
      ? `${rotationHumanReason || "A weaker live position is being replaced by a better candidate."} Sell order submitted; the replacement buy will follow the next confirmed account sync.`
      : (rotationBlockedReason
        ? `${rotationBlockedReason}; the existing position was preserved`
        : `Rotation sell order was not accepted: ${orderResponseError(response) || "unknown Polymarket response"}; the existing position was preserved`);
    const explanation = accepted
      ? `The current best bid and replacement ask were refreshed immediately before the sell. After the exit loss, the replacement improves maximum net P/L by ${Number(finalProfitGuard?.maximumPnlDeltaUsdc ?? 0).toFixed(4)} USDC against a required ${Number(finalProfitGuard?.requiredImprovementUsdc ?? 0).toFixed(4)} USDC. The sell was submitted first; only this approved replacement may be bought by the completion pass.`
      : (rotationBlockedReason
        ? "The final executable bid/ask economics no longer covered the exit loss and required profit margin. No sell was submitted and the existing position was preserved."
        : "The selected replacement was not executed because its sell order was not accepted. No position or unrelated order was cancelled.");
    await emitDecision({
      ...decision,
      action,
      reason,
      rotationExit: accepted ? {
        position: rotation.position,
        candidate: rotation.candidate,
        candidateTokenId: rotation.candidateTokenId || rotation.candidate?.tokenId || null,
        order: exitOrder ? orderAttemptSummary(exitOrder, response, { action }) : null,
        submittedAt: new Date().toISOString(),
      } : null,
      batchLog: {
        ...decision.batchLog,
        action,
        reason,
        explanation,
        humanReason: rotationHumanReason || null,
        selected: rotation.candidate,
        rotationExit: accepted ? {
          position: rotation.position,
          candidate: rotation.candidate,
          candidateTokenId: rotation.candidateTokenId || rotation.candidate?.tokenId || null,
          order: exitOrder ? orderAttemptSummary(exitOrder, response, { action }) : null,
        } : null,
      },
      response,
      selected: rotation.candidate,
      attempts: [
        ...(exitOrder ? [orderAttemptSummary(exitOrder, response, { action, replacementCandidate: rotation.candidate })] : []),
      ],
    });
    return;
  }

  if (!best || DRY_RUN || !hasFlag("confirm-live")) {
    await emitDecision({ ...decision, attempts: best ? [orderAttemptSummary(best, null, { action: decision.action })] : [] });
    return;
  }

  const attempts = [];
  // A cancel-and-replace path validates its replacement with the capital that
  // the cancelled order releases. It therefore is not present in `eligible`,
  // which was intentionally checked against the pre-cancellation free cash.
  const submissionCandidates = canceledForBetterCandidate && best
    ? [best]
    : eligible;
  const restoreCanceledOrderIfNeeded = async () => {
    if (!canceledForBetterCandidate || !orderManagement.selected) return null;
    const restoreResponse = await restoreOpenOrder(orderManagement.selected, tradingConfig);
    orderManagement.selected.restoreResponse = restoreResponse;
    return restoreResponse;
  };
  for (const candidate of submissionCandidates) {
    const submission = await submitLiveEntryWithMakerPrecisionRecovery(candidate);
    const response = submission.response;
    const submittedCandidate = submission.order;
    const submissionAttempts = submission.attempts.map((attempt) => orderAttemptSummary(
      attempt.order,
      attempt.response,
      {
        makerPrecisionRecovery: attempt.precisionRecovery,
        action: attempt.precisionRecovery ? "PRECISION_RETRY" : "SUBMIT_ATTEMPT",
      },
    ));
    if (successfulOrderResponse(response)) {
      const action = canceledForBetterCandidate ? "CANCELED_AND_SUBMITTED" : "SUBMITTED";
      const precisionNote = submittedCandidate.makerPrecisionAdjusted
        ? ` The same limit price was kept and the share size was reduced to ${Number(submittedCandidate.orderSize).toFixed(2)} so Polymarket's maker amount has valid precision.`
        : "";
      const reason = canceledForBetterCandidate
        ? `waiting limit order cancelled and the better replacement order was accepted by Polymarket${precisionNote}`
        : `live order accepted by Polymarket${precisionNote}`;
      const explanation = canceledForBetterCandidate
        ? `The existing limit order was cancelled after the revalidated shortlist found a better candidate. The released capital was immediately used for the selected replacement order.${precisionNote}`
        : `Live batch revalidated candidates and Polymarket accepted the selected order.${precisionNote}`;
      await emitDecision({
        ...decision,
        action,
        reason,
        batchLog: {
          ...decision.batchLog,
          action,
          reason,
          explanation,
          selected: liveBatchCandidateSummary(submittedCandidate),
        },
        monitoring: {
          ...monitoring,
          lastSubmittedAt: new Date().toISOString(),
          estimatedCashAfterOrderUsdc: Number(Math.max(0, availableCashAfterOrderManagement - Number(submittedCandidate.totalCostUsdc || submittedCandidate.orderNotionalUsdc || 0)).toFixed(5)),
        },
        selected: submittedCandidate,
        response,
        attempts: [
          ...(canceledForBetterCandidate && orderManagement.selected ? [orderManagement.selected] : []),
          ...attempts,
          ...submissionAttempts.map((attempt) => ({
            ...attempt,
            action: attempt.makerPrecisionRecovery ? "PRECISION_RETRY_ACCEPTED" : action,
          })),
        ],
      });
      return;
    }

    const stopReason = nonRetryableOrderFailure(response);
    attempts.push(...submissionAttempts.map((attempt) => ({
      ...attempt,
      action: stopReason ? "STOP" : (attempt.makerPrecisionRecovery ? "PRECISION_RETRY_REJECTED" : "RETRY_NEXT"),
      rejectReason: orderResponseError(attempt.response) || "order was rejected",
      stopReason: attempt.response === response ? stopReason : null,
    })));
    if (stopReason) {
      const restoreResponse = await restoreCanceledOrderIfNeeded();
      const restored = restoreResponse && successfulOrderResponse(restoreResponse);
      const action = canceledForBetterCandidate ? "CANCELED_REPLACEMENT_REJECTED" : "REJECTED";
      const reason = canceledForBetterCandidate
        ? `replacement order was rejected: ${stopReason}; original order ${restored ? "was immediately restored" : "could not be restored"}`
        : stopReason;
      await emitDecision({
        ...decision,
        action,
        reason,
        batchLog: {
          ...decision.batchLog,
          action,
          reason,
          explanation: canceledForBetterCandidate
            ? `The replacement order was not opened after cancellation because submission stopped: ${stopReason}. The original order ${restored ? "was immediately restored" : "could not be restored"}.`
            : `Live order was not opened because submission stopped: ${stopReason}.`,
          selected: liveBatchCandidateSummary(submittedCandidate),
        },
        selected: submittedCandidate,
        response,
        attempts: [
          ...(canceledForBetterCandidate && orderManagement.selected ? [orderManagement.selected] : []),
          ...attempts,
        ],
      });
      process.exit(1);
    }
  }

  const restoreResponse = await restoreCanceledOrderIfNeeded();
  const restored = restoreResponse && successfulOrderResponse(restoreResponse);
  const action = canceledForBetterCandidate ? "CANCELED_REPLACEMENT_REJECTED" : "REJECTED";
  const submissionFailures = attempts
    .map((attempt, index) => {
      const label = `${index + 1}. ${attempt.outcome || "candidate"} ${attempt.question || ""}`.trim();
      const detail = attempt.responseError || attempt.responseSummary || "order was rejected";
      return `${label}: ${detail}`;
    })
    .join("; ");
  const reason = canceledForBetterCandidate
    ? `every replacement candidate was rejected by order submission${submissionFailures ? ` (${submissionFailures})` : ""}; original order ${restored ? "was immediately restored" : "could not be restored"}`
    : `all revalidated candidates were rejected by order submission${submissionFailures ? ` (${submissionFailures})` : ""}`;
  await emitDecision({
    ...decision,
    action,
    reason,
    batchLog: {
      ...decision.batchLog,
      action,
      reason,
      explanation: canceledForBetterCandidate
        ? `Every current replacement candidate failed during submission. The original order ${restored ? "was immediately restored" : "could not be restored"}.${submissionFailures ? ` Details: ${submissionFailures}` : ""}`
        : `Live order was not opened because every revalidated candidate failed during order submission.${submissionFailures ? ` Details: ${submissionFailures}` : ""}`,
    },
    response: attempts.at(-1)?.response || null,
    attempts: [
      ...(canceledForBetterCandidate && orderManagement.selected ? [orderManagement.selected] : []),
      ...attempts,
    ],
  });
  process.exit(1);
}

// Importing this module must never start a live execution run. Only a direct
// `node tools/live-order-executor.mjs` invocation executes.
const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (invokedDirectly) {
  main().catch(async (error) => {
    if (EXECUTION_STATE_PATH) {
      await emitDecision({
        mode: DRY_RUN || !hasFlag("confirm-live") ? "validated-dry-run" : "live-submit",
        action: "ERROR",
        reason: error?.message || String(error),
        generatedAt: new Date().toISOString(),
      }).catch(() => {});
    }
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
}

// Exported for tests only.
export {
  compareShorterHorizon,
  daysValue,
  MIN_ORDER_STAKE_CEILING_USDC,
  consoleDecisionSummary,
  annualizeReturn,
  localDaysToResolution,
  selectedAnnualizedReturn,
  ROTATION_PROTECT_REMAINING_GAIN_USDC,
  ROTATION_MIN_NET_PNL_IMPROVEMENT_USDC,
  positionRotationEconomics,
  rotationNetProfitGuard,
  orderPriceForBook,
  orderPriceBandRejection,
  candidateMarketType,
  finishedAwaitingResolutionRejection,
  repriceReason,
  openOrderActionExplanation,
  rotationComparisonRows,
  sharesForOrder,
  prepareLiveCandidatePool,
  liveRevalidationUpdate,
  heldRiskItems,
  earlyRiskBlockReason,
  compactLiveRunRecord,
  rotationLegMerge,
  candidatePoolForRotation,
  restrictCandidatesToRotationPlan,
  latestHoldingResolutionMs,
  fixedEntryOrder,
  fixedEntryRowFacts,
  expiredOrderWithdrawalReason,
  EXPIRED_ORDER_GRACE_HOURS,
  loadScopedExecutionCatalogue,
  EXECUTION_SCOPE_MAX_PAGES,
};
