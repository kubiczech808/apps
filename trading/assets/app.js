const state = {
  mode: "paper-conservative",
  page: "portfolios",
  botState: null,
  liveState: null,
  evaluationSort: {
    key: "evaluatedAt",
    direction: "desc",
  },
  tradeSort: {
    open: {
      key: "openedAt",
      direction: "desc",
    },
    closed: {
      key: "resolvedAt",
      direction: "desc",
    },
    live: {
      key: "openedAt",
      direction: "desc",
    },
    liveClosed: {
      key: "resolvedAt",
      direction: "desc",
    },
  },
  evaluationStatus: "EVALUATED",
  opportunityView: "scraped",
  scrapedSort: {
    key: "observedAt",
    direction: "desc",
  },
  scrapedMarketStateBusy: false,
  scrapedMarketStateLoaded: false,
  scrapedMarketStateSummary: "",
  scrapedMarketStateError: "",
  scrapedMarketObservations: [],
  scrapedMarketScan: {},
  scrapedMarketScanHistory: [],
  scrapeHistoryPage: -1,
  scrapeHistoryTotal: 0,
  scrapeHistoryHasMore: false,
  scrapeHistoryBusy: false,
  scrapeHistoryError: "",
  // Keyed by paper strategy id. Each portfolio's runLog is capped in the live state, so
  // this holds whatever the "Load older runs" button has paged in beyond that cap, kept
  // separate per portfolio so switching portfolios never mixes one's history into another's.
  portfolioRunLogHistory: {},
  scrapedScanTag: "",
  scrapedScanBusy: false,
  // Live per-category counts from Polymarket, and when they were fetched. Absent until
  // the first successful round, which is what makes the picker render plain names.
  scanCategoryCounts: null,
  scanCategoryCountsAt: 0,
  scanCategoryCountsPending: false,
  scrapedScanStatus: "",
  scrapedScanPreferenceSaveTimer: null,
  scrapedRefreshKeys: new Set(),
  scrapedRefreshErrors: new Map(),
  evaluationProbabilityFilter: 0,
  evaluationDaysFilter: null,
  evaluationNetYieldFilter: 0,
  evaluationLiquidityFilter: 0,
  scrapedTaxonomyFilter: null,
  // The rows behind one row of the performance tables, fetched from the archive itself.
  // The scraped catalogue the browser holds is a capped page of that archive, so a
  // taxonomy view built from it can only ever show a fraction of what the statistic
  // counted -- 12 of 937 for league-of-legends when this was measured.
  scrapedTaxonomyRows: null,
  scrapedTaxonomyRowsKey: "",
  scrapedTaxonomyRowsPending: "",
  scrapedTaxonomyRowsError: "",
  scrapedMarketTypeFilter: "all",
  // Keep explicit deep-link filters authoritative during asynchronous catalogue loads.
  scrapedRouteFilter: null,
  // The scraped catalogue has its own multi-select status filter. `evaluationStatus`
  // belongs to the retired AI evaluation view and must not make a taxonomy deep-link
  // silently discard resolved observations.
  scrapedStatuses: ["SCRAPED"],
  eligibilityThreshold: null,
  eligibilityThresholdKey: "",
  riskAllocation: null,
  riskAllocationKey: "",
  limitOrders: null,
  limitOrdersKey: "",
  liveExecutionArmed: false,
  liveExecutionState: null,
  portfolioConfig: null,
  portfolioConfigSaveTimer: null,
  parameterDraft: null,
  parameterDraftMode: "",
  // The id a portfolio being created will be stored under, or "" while an existing
  // portfolio is merely being edited.
  parameterDraftCreate: "",
  // Portfolio creation can either create a new paper account or configure the existing
  // connected live account. Live execution is backed by fixed workflows, so this is a
  // type choice for the create flow, not a hidden third live account.
  parameterDraftCreateType: "",
  parameterDraftCreatePrefill: null,
  // The last paper portfolio snapshot seen, kept across tab switches so the overview
  // still has numbers while a live tab is open and only the live state is loaded.
  portfolioOverview: null,
  portfolioOverviewAt: 0,
  portfolioOverviewPending: false,
  // Whether this page load has already settled which portfolio to open. Set once the
  // richest one has been picked, and also the moment the reader picks a tab themselves,
  // so the automatic choice can never fight a deliberate click.
  portfolioPreselectDone: false,
  parameterDraftSystem: null,
  parameterCapitalContext: null,
  stateFetchErrors: {},
  executionBusy: null,
  autoLiveSyncBusy: false,
  openedTradesRefreshBusy: false,
  dashboardLoadSeq: 0,
  fullBotStateBusy: false,
  candidateBotStateBusy: false,
  candidateRefreshBusy: false,
  botStateFull: false,
  settingsSection: "evaluation-log",
  calculationSource: "all",
  calculationMarket: "all",
  calculationOpenFilter: "all",
  calculationTab: "parameters",
  calculationMinOpen: "",
  calculationMinTrades: "",
  calculationMinVolume: "",
  calculationSort: {
    key: "roi",
    direction: "desc",
  },
  // Categories and tags are separate Gamma taxonomies and each table keeps its own
  // sort order.
  taxonomySort: {
    category: { key: "roi", direction: "desc" },
    tag: { key: "roi", direction: "desc" },
  },
  displayedRunLog: [],
  runLogFilters: [],
  // The execution GitHub says is running right now, per workflow target, so the run log
  // can show it before the run has published anything of its own.
  runningExecutions: {},
  // What the log already carried when that run appeared, so a row published later is
  // recognisable as this run's own.
  runningExecutionWatermark: null,
  // How many candidate rows the table is currently showing. The list used to stop at
  // 80 with nothing to say it had, so a portfolio with more candidates than that
  // simply hid the rest. It grows as the table is scrolled, and resets only when the
  // portfolio changes -- a poll refresh must not pull back what has been opened up.
  candidateVisibleCount: 0,
  candidateVisibleMode: "",
  // The scraped catalogue can contain thousands of rows. Keep it progressively
  // renderable without pretending that the first screenful is the whole result.
  scrapedVisibleCount: 0,
  scrapedVisibleScope: "",
  scrapedFilteredCount: 0,
  userNavRefreshTimer: null,
  openedOpportunityKey: "",
};

const ELIGIBILITY_THRESHOLD_STORAGE_KEY = "tradingEligibilityProbabilityThreshold";
const EVALUATION_PROBABILITY_FILTER_STORAGE_KEY = "tradingEvaluationProbabilityFilter";
const EVALUATION_DAYS_FILTER_STORAGE_KEY = "tradingEvaluationDaysFilter";
const EVALUATION_NET_YIELD_FILTER_STORAGE_KEY = "tradingEvaluationNetYieldFilter";
const EVALUATION_LIQUIDITY_FILTER_STORAGE_KEY = "tradingEvaluationLiquidityFilter";
const CALCULATION_TAB_STORAGE_KEY = "tradingCalculationTab";
const CALCULATION_MIN_OPEN_STORAGE_KEY = "tradingCalculationMinOpen";
const CALCULATION_MIN_TRADES_STORAGE_KEY = "tradingCalculationMinTrades";
const CALCULATION_MIN_VOLUME_STORAGE_KEY = "tradingCalculationMinVolume";
const SCRAPED_TAXONOMY_KIND_QUERY_PARAM = "taxonomy";
const SCRAPED_TAXONOMY_VALUE_QUERY_PARAM = "taxonomyValue";
const SCRAPED_STATUS_QUERY_PARAM = "statuses";
const SCRAPED_PROBABILITY_QUERY_PARAM = "probability";
const SCRAPED_MAX_DAYS_QUERY_PARAM = "maxDays";
const SCRAPED_MARKET_TYPE_QUERY_PARAM = "marketType";
const RISK_ALLOCATION_STORAGE_KEY = "tradingStakeUsdc";
const LEGACY_RISK_ALLOCATION_STORAGE_KEY = "tradingRiskAllocationFraction";
const LIMIT_ORDERS_STORAGE_KEY = "tradingUseLimitOrders";
const MODE_STORAGE_KEY = "tradingDashboardMode";
const LIVE_EXECUTION_STORAGE_KEY = "tradingLiveExecutionArmed";
const RUN_LOG_FILTER_STORAGE_PREFIX = "tradingRunLogStatusFilter";
const STATE_CACHE_PREFIX = "tradingStateCache:";
const DEFAULT_ELIGIBILITY_THRESHOLD = 0.95;
const MIN_ELIGIBILITY_THRESHOLD = 0.01;
const MAX_ELIGIBILITY_THRESHOLD = 0.99;
const MIN_PORTFOLIO_EV_PA = 0.05;
const DEFAULT_RISK_ALLOCATION = 5;
const MIN_RISK_ALLOCATION = 0.01;
const MAX_RISK_ALLOCATION = 1000;
const DEFAULT_MAX_RESOLUTION_DAYS = 7;
// Annualizing a few minutes as if the trade could be repeated continuously is
// misleading, so potential p.a. is floored. The floor is one hour rather than one
// day: the strategy targets markets resolving the same day or already running, and
// a one-day floor gave all of them the same p.a., so the ranking could not prefer a
// live event over one still hours away. Keep the actual horizon visible beside it.
const MIN_ANNUALIZATION_DAYS = 1 / 24;
const LIVE_STATE_REFRESH_MS = 15000;
// How often an open dashboard may ask the server to DISPATCH a live account sync, which
// is a full GitHub Actions run: npm install, Polymarket API calls, FTP upload.
//
// This was 30s, polled on the 15s state-refresh interval, so a single open tab dispatched
// a workflow every 30 seconds -- ~120 runs an hour. That saturated the account's runner
// capacity: deploy, market scan, paper bot and live execution then sat queued with no
// runner assigned and GitHub killed each after 15 minutes. Re-reading the published state
// is what keeps the UI current (LIVE_STATE_REFRESH_MS, a static JSON fetch, unchanged);
// dispatching a run is only worth it occasionally, on top of the 15-minute cron.
const LIVE_SYNC_REQUEST_MS = 600000;
// An explicit "Refresh values" click is a deliberate request, so it may dispatch sooner --
// but not so often that holding the button down can flood the queue again.
const LIVE_SYNC_MANUAL_SECONDS = 120;
const USER_NAV_REFRESH_DEBOUNCE_MS = 250;
// How often the dashboard asks GitHub whether an execution is running. This reads run
// status only -- it dispatches nothing -- so unlike the sync request above it costs the
// runners nothing, and 15s is close enough to live for a run that takes about a minute.
const EXECUTION_WATCH_MS = 15000;
const APP_BASE_PATH = "/trading/";

const els = {
  shell: document.querySelector("[data-app-shell]"),
  pageLinks: document.querySelectorAll("[data-page-link]"),
  pageSections: document.querySelectorAll("[data-page-section]"),
  botAction: document.querySelector("[data-bot-action]"),
  botInlineAction: document.querySelector("[data-bot-inline-action]"),
  portfolioTitle: document.querySelector("[data-portfolio-title]"),
  primaryPanelTitle: document.querySelector("[data-primary-panel-title]"),
  openedTradesRefresh: document.querySelector("[data-opened-trades-refresh]"),
  secondaryPanelTitle: document.querySelector("[data-secondary-panel-title]"),
  botStatus: document.querySelector("[data-bot-status]"),
  accountSummary: document.querySelector("[data-account-summary]"),
  portfolioRules: document.querySelector("[data-portfolio-rules]"),
  botTrades: document.querySelector("[data-bot-trades]"),
  closedTrades: document.querySelector("[data-closed-trades]"),
  closedTradesExport: document.querySelector("[data-closed-trades-export]"),
  closedSummary: document.querySelector("[data-closed-summary]"),
  botEvaluations: document.querySelector("[data-bot-evaluations]"),
  evaluationSummary: document.querySelector("[data-evaluation-summary]"),
  evaluationFilterCount: document.querySelector("[data-evaluation-filter-count]"),
  runLog: document.querySelector("[data-run-log]"),
  runLogSummary: document.querySelector("[data-run-log-summary]"),
  runLogTitle: document.querySelector("[data-run-log-title]"),
  runLogFilterControl: document.querySelector("[data-run-log-filter-control]"),
  runLogFilterToggle: document.querySelector("[data-run-log-filter-toggle]"),
  runLogFilterMenu: document.querySelector("[data-run-log-filter-menu]"),
  portfolioCandidates: document.querySelector("[data-portfolio-candidates]"),
  portfolioCandidatesRefresh: document.querySelector("[data-portfolio-candidates-refresh]"),
  portfolioCandidatesSummary: document.querySelector("[data-portfolio-candidates-summary]"),
  portfolioCandidatesTitle: document.querySelector("[data-portfolio-candidates-title]"),
  settingsPageEyebrow: document.querySelector("[data-settings-page-eyebrow]"),
  settingsPageTitle: document.querySelector("[data-settings-page-title]"),
  opportunityPanelTitle: document.querySelector("[data-opportunity-panel-title]"),
  scrapedScanTag: document.querySelector("[data-scraped-scan-tag]"),
  scrapedScanButton: document.querySelector("[data-scraped-scan]"),
  scrapedScanStatus: document.querySelector("[data-scraped-scan-status]"),
  settingsSectionButtons: document.querySelectorAll("[data-settings-section]"),
  settingsPanels: document.querySelectorAll("[data-settings-panel]"),
  calculationSourceButtons: document.querySelectorAll("[data-calculation-source]"),
  calculationMarketButtons: document.querySelectorAll("[data-calculation-market]"),
  calculationOpenButtons: document.querySelectorAll("[data-calculation-open]"),
  calculationTabButtons: document.querySelectorAll("[data-calculation-tab]"),
  calculationMinFilters: document.querySelectorAll("[data-calculation-min-filter]"),
  calculationReport: document.querySelector("[data-calculation-report]"),
  systemStatus: document.querySelector("[data-system-status]"),
  evaluationProbabilityFilter: document.querySelector("[data-evaluation-probability-filter]"),
  evaluationDaysFilter: document.querySelector("[data-evaluation-days-filter]"),
  tradabilityFilterControls: document.querySelectorAll("[data-tradability-filter]"),
  evaluationNetYieldFilter: document.querySelector("[data-evaluation-net-yield-filter]"),
  evaluationLiquidityFilter: document.querySelector("[data-evaluation-liquidity-filter]"),
  scrapedTaxonomyFilter: document.querySelector("[data-scraped-taxonomy-filter]"),
  scrapedMarketTypeFilter: document.querySelector("[data-scraped-market-type-filter]"),
  scrapedStatusOptions: document.querySelectorAll("[data-scraped-status]"),
  scrapedStatusLabels: document.querySelectorAll("[data-scraped-status-label]"),
  portfolioName: document.querySelector("[data-portfolio-name]"),
  portfolioNameLabel: document.querySelector("[data-portfolio-name-label]"),
  portfolioAccountTypeRow: document.querySelector("[data-create-portfolio-type-row]"),
  portfolioAccountType: document.querySelector("[data-portfolio-account-type]"),
  portfolioAccountTypeLabel: document.querySelector("[data-portfolio-account-type-label]"),
  portfolioAccountTypeNote: document.querySelector("[data-portfolio-account-type-note]"),
  eligibilityThreshold: document.querySelector("[data-eligibility-threshold]"),
  eligibilityThresholdLabel: document.querySelector("[data-eligibility-threshold-label]"),
  riskAllocation: document.querySelector("[data-risk-allocation]"),
  riskAllocationLabel: document.querySelector("[data-risk-allocation-label]"),
  riskAllocationValue: document.querySelector("[data-risk-allocation-value]"),
  riskAllocationNote: document.querySelector("[data-risk-allocation-note]"),
  maxResolutionDays: document.querySelector("[data-max-resolution-days]"),
  maxResolutionDaysLabel: document.querySelector("[data-max-resolution-days-label]"),
  selectionOrder: document.querySelector("[data-selection-order]"),
  selectionOrderLabel: document.querySelector("[data-selection-order-label]"),
  minLiquidity: document.querySelector("[data-min-liquidity]"),
  minLiquidityLabel: document.querySelector("[data-min-liquidity-label]"),
  minNetYield: document.querySelector("[data-min-net-yield]"),
  minNetYieldLabel: document.querySelector("[data-min-net-yield-label]"),
  executionTrigger: document.querySelector("[data-execution-trigger]"),
  executionTriggerLabel: document.querySelector("[data-execution-trigger-label]"),
  autoRotatePositions: document.querySelector("[data-auto-rotate-positions]"),
  autoRotatePositionsLabel: document.querySelector("[data-auto-rotate-positions-label]"),
  stopLossRiskMultiplier: document.querySelector("[data-stop-loss-risk-multiplier]"),
  stopLossRiskMultiplierLabel: document.querySelector("[data-stop-loss-risk-multiplier-label]"),
  executionCronRow: document.querySelector("[data-execution-cron-row]"),
  executionCronMinutes: document.querySelector("[data-execution-cron-minutes]"),
  executionCronMinutesLabel: document.querySelector("[data-execution-cron-minutes-label]"),
  fixedEntryRows: document.querySelectorAll("[data-fixed-entry-row]"),
  // Paper-only: Polymarket has no conditional stop order, so live portfolios have no
  // equivalent setting to show this row for.
  paperOnlyRows: document.querySelectorAll("[data-paper-only-row]"),
  fixedEntryPrice: document.querySelector("[data-fixed-entry-price]"),
  fixedEntryPriceLabel: document.querySelector("[data-fixed-entry-price-label]"),
  fixedEntryTags: document.querySelector("[data-fixed-entry-tags]"),
  fixedEntryTagsLabel: document.querySelector("[data-fixed-entry-tags-label]"),
  includeOnlyTags: document.querySelector("[data-include-only-tags]"),
  includeOnlyTagsLabel: document.querySelector("[data-include-only-tags-label]"),
  excludedTags: document.querySelector("[data-excluded-tags]"),
  excludedTagsLabel: document.querySelector("[data-excluded-tags-label]"),
  excludedTagsRow: document.querySelector("[data-excluded-tags-row]"),
  portfolioMarketType: document.querySelector("[data-portfolio-market-type]"),
  portfolioMarketTypeLabel: document.querySelector("[data-portfolio-market-type-label]"),
  crossLiveRisk: document.querySelector("[data-cross-live-risk]"),
  capitalStatus: document.querySelector("[data-capital-status]"),
  limitOrders: document.querySelector("[data-limit-orders]"),
  executionButtons: document.querySelectorAll("[data-one-time-execution]"),
  executionStatus: document.querySelector("[data-execution-status]"),
  accountSyncPolicy: document.querySelector("[data-account-sync-policy]"),
  nextAccountSync: document.querySelector("[data-next-account-sync]"),
  evaluationStatusButtons: document.querySelectorAll("[data-evaluation-status]"),
  evaluationControls: document.querySelector("[data-evaluation-controls]"),
  opportunityViewButtons: document.querySelectorAll("[data-opportunity-view]"),
  opportunityFilterControls: document.querySelectorAll("[data-opportunity-filter]"),
  evaluationOnlyControls: document.querySelectorAll("[data-evaluation-only]"),
  scrapedOnlyControls: document.querySelectorAll("[data-scraped-only]"),
  parameterModal: document.querySelector("[data-parameter-modal]"),
  parameterModalClose: document.querySelector("[data-parameter-modal-close]"),
  parameterModalConfirm: document.querySelector("[data-parameter-modal-confirm]"),
  parameterModalArchive: document.querySelector("[data-parameter-modal-archive]"),
  createPortfolio: document.querySelector("[data-create-portfolio]"),
  archivedPortfolios: document.querySelector("[data-archived-portfolios]"),
  portfolioOverview: document.querySelector("[data-portfolio-overview]"),
  modeSwitch: document.querySelector("[data-mode-switch]"),
  modeButtons: document.querySelectorAll("[data-mode-toggle]"),
  liveActivation: document.querySelector("[data-live-activation]"),
  tabButtons: document.querySelectorAll("[data-tab-target]"),
  tabPanels: document.querySelectorAll("[data-tab-panel]"),
  portfolioEquity: document.querySelector("[data-portfolio-equity]"),
  portfolioLastRun: document.querySelector("[data-portfolio-last-run]"),
  portfolioTotalPl: document.querySelector("[data-portfolio-total-pl]"),
  portfolioTotalPlPct: document.querySelector("[data-portfolio-total-pl-pct]"),
  portfolioAnnualized: document.querySelector("[data-portfolio-annualized]"),
  portfolioPeriod: document.querySelector("[data-portfolio-period]"),
  portfolioRealized: document.querySelector("[data-portfolio-realized]"),
  portfolioRealizedPct: document.querySelector("[data-portfolio-realized-pct]"),
  portfolioAccuracy: document.querySelector("[data-portfolio-accuracy]"),
  portfolioAccuracyNote: document.querySelector("[data-portfolio-accuracy-note]"),
  portfolioOpenPl: document.querySelector("[data-portfolio-open-pl]"),
  portfolioOpenPlPct: document.querySelector("[data-portfolio-open-pl-pct]"),
  portfolioRisk: document.querySelector("[data-portfolio-risk]"),
  portfolioFree: document.querySelector("[data-portfolio-free]"),
  portfolioEquityChart: document.querySelector("[data-portfolio-equity-chart]"),
  portfolioMetricsLayout: document.querySelector("[data-portfolio-metrics-layout]"),
};

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function appPath(path) {
  const value = String(path || "");
  if (/^(?:https?:)?\/\//i.test(value) || value.startsWith("/")) return value;
  return `${APP_BASE_PATH}${value.replace(/^\.?\//, "")}`;
}

function money(value, digits = 2) {
  if (!Number.isFinite(value)) return "-";
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

function probability(value) {
  if (!Number.isFinite(value)) return "-";
  return `${(value * 100).toFixed(1)}%`;
}

function percent(value) {
  if (!Number.isFinite(value)) return "-";
  return `${(value * 100).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

function signedMoney(value, digits = 2) {
  if (!Number.isFinite(value)) return "-";
  return `${value >= 0 ? "+" : ""}${money(value, digits)}`;
}

function signedPercent(value) {
  if (!Number.isFinite(value)) return "-";
  return `${value >= 0 ? "+" : ""}${percent(value)}`;
}

// Under a day, tenths of a day are a unit nobody reads in their head: "0.2 d" has
// to be converted before it means anything, and "< 0.1 d" covered everything from
// two hours down to two minutes. Below one day this switches to hours, and below
// one hour to minutes, so the number arrives in the unit it is thought about in.
// Past the end date reads as a negative horizon -- how long the market is overdue by --
// rather than as "due now" or, worse, the one-day floor the executor used to store. The
// same units apply either way, so an hour overdue is "-1.0 h", not "-0.0 d".
function compactDays(value) {
  if (!Number.isFinite(value)) return "-";
  const sign = value < 0 ? "-" : "";
  const size = Math.abs(value);
  if (size >= 1) return `${sign}${size.toFixed(1)} d`;
  const hours = size * 24;
  if (hours >= 1) return `${sign}${hours.toFixed(1)} h`;
  const minutes = Math.round(hours * 60);
  return minutes >= 1 ? `${sign}${minutes} min` : "< 1 min";
}

function shortAddress(value) {
  const text = String(value || "");
  return /^0x[a-fA-F0-9]{40}$/.test(text) ? `${text.slice(0, 6)}...${text.slice(-4)}` : text || "-";
}

function pnlClass(value) {
  return Number(value) >= 0 ? "positive" : "negative";
}

function storedMode() {
  try {
    const value = localStorage.getItem(MODE_STORAGE_KEY);
    if (normalizeMode(value) === value) return value;
    return "paper-conservative";
  } catch {
    return "paper-conservative";
  }
}

function saveMode(mode) {
  try {
    localStorage.setItem(MODE_STORAGE_KEY, normalizeMode(mode));
  } catch {
    // Ignore localStorage failures; the mode switch still works for this page load.
  }
}

function normalizeRunLogFilter(value) {
  const normalized = String(value || "ALL").trim().toUpperCase();
  return normalized || "ALL";
}

function normalizeRunLogFilters(value) {
  let values = value;
  if (typeof values === "string") {
    try {
      values = JSON.parse(values);
    } catch {
      values = [values];
    }
  }
  if (!Array.isArray(values)) values = [values];
  return [...new Set(values
    .map(normalizeRunLogFilter)
    .filter((action) => action !== "ALL"))];
}

function runLogFilterStorageKey(mode = state.mode) {
  return `${RUN_LOG_FILTER_STORAGE_PREFIX}:${normalizeMode(mode)}`;
}

function storedRunLogFilter(mode = state.mode) {
  try {
    return normalizeRunLogFilters(localStorage.getItem(runLogFilterStorageKey(mode)));
  } catch {
    return [];
  }
}

function saveRunLogFilter(value, mode = state.mode) {
  try {
    localStorage.setItem(runLogFilterStorageKey(mode), JSON.stringify(normalizeRunLogFilters(value)));
  } catch {
    // The filter remains active for this page load if local storage is unavailable.
  }
}

// The four shipped paper portfolios. Created ones are stored beside them and are named
// the same way, so this list is only what the application ships with, never the set of
// portfolios that exist.
const BUILT_IN_PAPER_STRATEGY_IDS = ["conservative", "highReward", "moreProbable", "equal"];
const CUSTOM_PAPER_STRATEGY_ID = /^[a-z][a-zA-Z0-9]{1,30}$/;

function normalizeMode(mode) {
  if (mode === "live" || mode === "live-5050") return mode;
  const paperMode = /^paper-(.+)$/.exec(String(mode || ""));
  const strategyId = paperMode?.[1];
  // A created portfolio's mode is only real while the portfolio is: a bookmark or a
  // stored last-open tab pointing at a deleted one falls back rather than showing a
  // dashboard with no portfolio behind it.
  if (strategyId && (BUILT_IN_PAPER_STRATEGY_IDS.includes(strategyId)
    || (CUSTOM_PAPER_STRATEGY_ID.test(strategyId) && Boolean((state.portfolioConfig?.paper || {})[strategyId])))) {
    return mode;
  }
  return "paper-conservative";
}

// 5050 is a live portfolio: same wallet, same positions and orders, so it shares
// every live view. What differs is its config and the run log it writes, because
// the two portfolios decide separately.
const LIVE_MODES = new Set(["live", "live-5050"]);

function isLiveMode() {
  return LIVE_MODES.has(state.mode);
}

function isFixedEntryMode(mode = state.mode) {
  return normalizeMode(mode) === "live-5050";
}

function liveConfigKeyForMode(mode = state.mode) {
  return isFixedEntryMode(mode) ? "live5050" : "live";
}

function liveExecutionStateFile(mode = state.mode) {
  return isFixedEntryMode(mode) ? "data/live-5050-execution-state.json" : "data/live-execution-state.json";
}

function paperStrategyIdFromMode(mode = state.mode) {
  const strategyId = /^paper-(.+)$/.exec(String(mode || ""))?.[1];
  if (!strategyId) return "conservative";
  if (BUILT_IN_PAPER_STRATEGY_IDS.includes(strategyId)) return strategyId;
  return CUSTOM_PAPER_STRATEGY_ID.test(strategyId) ? strategyId : "conservative";
}

const BUILT_IN_PAPER_LABELS = {
  conservative: "Conservative",
  highReward: "High reward",
  moreProbable: "More probable",
  equal: "Equal",
};

function paperModeLabel(mode = state.mode) {
  const strategyId = paperStrategyIdFromMode(mode);
  // A created portfolio has no shipped name to fall back to, so its id is the label
  // until the user gives it one.
  return BUILT_IN_PAPER_LABELS[strategyId] || strategyId;
}

// Paper portfolios in the order they are shown, archived ones left out. Created
// portfolios follow the shipped ones so the tabs the user knows do not move when one
// is added.
function paperStrategyIds({ includeArchived = false } = {}) {
  // Reported: archived portfolios flashed into the overview while it loaded. Falling back
  // to the shipped defaults here was the cause -- they name the four built-in portfolios
  // with nothing archived, so for one frame an archived portfolio was listed and a created
  // one was not. Which portfolios exist, and which are archived, cannot be guessed: nothing
  // is listed until the saved config is known (from its cache on any repeat visit), so the
  // gap is a moment of no rows instead of a moment of wrong ones.
  const config = state.portfolioConfig || readCachedPortfolioConfig();
  if (!config) return [];
  const paper = config.paper || {};
  const custom = Object.keys(paper)
    .filter((id) => !BUILT_IN_PAPER_STRATEGY_IDS.includes(id) && CUSTOM_PAPER_STRATEGY_ID.test(id))
    .sort((left, right) => left.localeCompare(right));
  return [...BUILT_IN_PAPER_STRATEGY_IDS, ...custom]
    .filter((id) => includeArchived || paper[id]?.archived !== true);
}

function portfolioIsArchived(mode = state.mode) {
  const normalized = normalizeMode(mode);
  // Unlike the plain live portfolio, 5050 may be archived -- withdrawing an expired
  // resting order and refreshing the account snapshot are unconditional in the
  // executor, so archiving it only stops new bids, nothing already held goes dark.
  if (normalized === "live-5050") return (state.portfolioConfig || {}).live5050?.archived === true;
  if (LIVE_MODES.has(normalized)) return false;
  const paper = (state.portfolioConfig || {}).paper || {};

  return paper[paperStrategyIdFromMode(normalized)]?.archived === true;
}

// One portfolio's equity, wherever this page happens to have it. The dashboard payload
// carries the selected portfolio in full; the cheap overview summary carries every
// portfolio's headline numbers, which is what a live tab leaves loaded. Returns null when
// the number is genuinely not known yet, so callers can order those last rather than
// treating "not loaded" as zero.
function portfolioEquityUsdc(mode = state.mode) {
  const normalized = normalizeMode(mode);
  if (LIVE_MODES.has(normalized)) {
    const equity = Number(state.liveState?.portfolio?.equityUsdc);
    return Number.isFinite(equity) ? equity : null;
  }
  // Same per-portfolio merge the overview table uses, so the tab order and the table can
  // never disagree about which portfolios have numbers.
  const equity = Number(overviewPortfolioNumbers(paperStrategyIdFromMode(normalized))?.equityUsdc);
  return Number.isFinite(equity) ? equity : null;
}

// Asked for: order the portfolios by equity, largest first. Sorting a copy and falling
// back to the incoming order keeps it stable, so portfolios whose equity is not loaded
// yet (and portfolios level with each other) do not shuffle between renders.
function byEquityDescending(modes) {
  const order = new Map(modes.map((mode, index) => [mode, index]));
  return [...modes].sort((left, right) => {
    const leftEquity = portfolioEquityUsdc(left);
    const rightEquity = portfolioEquityUsdc(right);
    if (leftEquity === rightEquity) return order.get(left) - order.get(right);
    if (leftEquity == null) return 1;
    if (rightEquity == null) return -1;
    return rightEquity - leftEquity || order.get(left) - order.get(right);
  });
}

// Asked for: the portfolio holding the most equity is the one that opens. It runs once
// per page load, as soon as any equity is actually known, and never after the reader has
// picked a tab -- so it decides the first view without overriding a deliberate choice.
// Equity arrives with the state, not with the markup, so this cannot be decided at
// startup: the stored mode opens first and this corrects it on the first payload.
function preselectRichestPortfolio() {
  if (state.portfolioPreselectDone) return;
  const [richest] = dashboardModes();
  // Nothing loaded yet: leave the flag clear so the next payload gets a turn.
  if (!richest || portfolioEquityUsdc(richest) == null) return;
  state.portfolioPreselectDone = true;
  if (normalizeMode(richest) === normalizeMode(state.mode)) return;
  state.mode = normalizeMode(richest);
  saveMode(state.mode);
  state.runLogFilters = storedRunLogFilter(state.mode);
  // The dashboard payload carries the trades of the selected portfolio only, so the
  // switch has to refetch rather than re-render what is already in hand.
  loadDashboardState();
}

// Every mode the dashboard can show, in tab order: richest portfolio first.
function dashboardModes() {
  const liveModes = ["live", "live-5050"].filter((mode) => !portfolioIsArchived(mode));
  return byEquityDescending([...paperStrategyIds().map((id) => `paper-${id}`), ...liveModes]);
}

function defaultPortfolioNameForMode(mode = state.mode) {
  const normalizedMode = normalizeMode(mode);
  if (LIVE_MODES.has(normalizedMode)) return isFixedEntryMode(normalizedMode) ? "5050" : "Live";
  return paperModeLabel(normalizedMode);
}

function normalizePortfolioName(value, fallback = "") {
  const normalized = String(value ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return normalized || fallback;
}

function portfolioNameForMode(mode = state.mode, configOverride = null) {
  const fallback = defaultPortfolioNameForMode(mode);
  const config = configOverride || portfolioConfigForMode(mode);
  return normalizePortfolioName(config?.displayName, fallback);
}

function portfolioUsesCustomName(mode = state.mode, configOverride = null) {
  const configured = normalizePortfolioName((configOverride || portfolioConfigForMode(mode))?.displayName, "");
  return configured !== "" && configured !== defaultPortfolioNameForMode(mode);
}

function portfolioNavigationLabelForMode(mode = state.mode, configOverride = null) {
  const name = portfolioNameForMode(mode, configOverride);
  if (portfolioUsesCustomName(mode, configOverride)) return name;
  return LIVE_MODES.has(normalizeMode(mode)) ? name : `Paper - ${name}`;
}

function portfolioTitleForMode(mode = state.mode, configOverride = null) {
  const normalizedMode = normalizeMode(mode);
  if (portfolioUsesCustomName(normalizedMode, configOverride)) {
    return portfolioNameForMode(normalizedMode, configOverride);
  }
  if (LIVE_MODES.has(normalizedMode)) {
    return isFixedEntryMode(normalizedMode) ? "5050 - fixed-entry bids" : "Live Polymarket account";
  }
  return `Paper - ${portfolioNameForMode(normalizedMode, configOverride)}`;
}

function defaultPortfolioConfig() {
  return {
    paper: {
      conservative: {
        displayName: "Conservative",
        minProbability: 0.95,
        stakeUsdc: 5,
        maxOrderFraction: 0.05,
        maxResolutionDays: 7,
        selectionOrder: "highest_ev_pa_first",
        minLiquidityUsdc: null,
        minNetYield: 0,
        executionTrigger: "cron",
        executionCronMinutes: 60,
        automationEnabled: true,
        autoRotatePositions: true,
        useLimitOrders: false,
        stopLossEnabled: false,
        stopLossRiskMultiplier: 0,
        marketType: "all",
        requireMostProbableOutcome: false,
        probabilitySource: "polymarket",
        excludedCandidateTokenIds: [],
      },
      highReward: {
        displayName: "High reward",
        minProbability: 0.6,
        stakeUsdc: 5,
        maxOrderFraction: 0.05,
        maxResolutionDays: DEFAULT_MAX_RESOLUTION_DAYS,
        selectionOrder: "highest_reward_risk_first",
        minLiquidityUsdc: null,
        minNetYield: 0,
        executionTrigger: "cron",
        executionCronMinutes: 60,
        automationEnabled: true,
        autoRotatePositions: true,
        useLimitOrders: false,
        stopLossEnabled: false,
        stopLossRiskMultiplier: 0,
        marketType: "all",
        requireMostProbableOutcome: false,
        probabilitySource: "polymarket",
        excludedCandidateTokenIds: [],
      },
      moreProbable: {
        displayName: "More probable",
        minProbability: 0.6,
        stakeUsdc: 5,
        maxOrderFraction: 0.05,
        maxResolutionDays: 7,
        selectionOrder: "highest_reward_risk_first",
        minLiquidityUsdc: 500000,
        minNetYield: 0,
        executionTrigger: "cron",
        executionCronMinutes: 60,
        automationEnabled: true,
        autoRotatePositions: true,
        useLimitOrders: false,
        stopLossEnabled: false,
        stopLossRiskMultiplier: 0,
        marketType: "multi",
        requireMostProbableOutcome: true,
        probabilitySource: "polymarket",
        excludedCandidateTokenIds: [],
      },
      equal: {
        displayName: "Equal",
        minProbability: 0.75,
        stakeUsdc: 5,
        maxOrderFraction: 0.05,
        maxResolutionDays: 7,
        selectionOrder: "highest_ev_pa_first",
        minLiquidityUsdc: 20000,
        minNetYield: 0,
        executionTrigger: "after_scrape",
        executionCronMinutes: 0,
        automationEnabled: true,
        autoRotatePositions: false,
        useLimitOrders: false,
        // The mechanism this portfolio is named for. It is now a parameter any paper
        // portfolio may turn on, but Equal is where it ships enabled.
        stopLossEnabled: true,
        stopLossRiskMultiplier: 1.5,
        marketType: "all",
        requireMostProbableOutcome: false,
        probabilitySource: "polymarket",
        excludedCandidateTokenIds: [],
      },
    },
    live: {
      displayName: "Live",
      minProbability: 0.95,
      stakeUsdc: 5,
      maxOrderFraction: 0.05,
      maxResolutionDays: DEFAULT_MAX_RESOLUTION_DAYS,
      selectionOrder: "highest_ev_pa_first",
      minLiquidityUsdc: 100,
      minNetYield: 0,
      executionTrigger: "cron",
      executionCronMinutes: 60,
      automationEnabled: true,
      autoRotatePositions: true,
      stopLossEnabled: false,
      stopLossRiskMultiplier: 0,
      useLimitOrders: true,
      marketType: "all",
      requireMostProbableOutcome: false,
      probabilitySource: "polymarket",
      excludedCandidateTokenIds: [],
    },
    // 5050 rests a bid at a fixed point on the 0..1 scale across everything that
    // clears its probability bar, instead of buying the best candidate at the
    // market. Most bids never fill; the ones that do were bought far below what
    // the market thought they were worth.
    live5050: {
      displayName: "5050",
      minProbability: 0.9,
      fixedEntryPrice: 0.5,
      stakePerOrderUsdc: null,
      stakeUsdc: 5,
      maxOrderFraction: 0.05,
      maxResolutionDays: 30,
      selectionOrder: "highest_ev_pa_first",
      minLiquidityUsdc: 100,
      minNetYield: 0,
      executionTrigger: "cron",
      executionCronMinutes: 60,
      automationEnabled: false,
      autoRotatePositions: false,
      stopLossEnabled: false,
      stopLossRiskMultiplier: 0,
      useLimitOrders: true,
      marketType: "all",
      requireMostProbableOutcome: false,
      probabilitySource: "polymarket",
      excludedCandidateTokenIds: [],
    },
    system: {
      crossLivePortfolioRiskDiversification: true,
    },
  };
}

function normalizeSelectionOrder(value) {
  return value === "highest_reward_risk_first" ? "highest_reward_risk_first" : "highest_ev_pa_first";
}

function normalizePortfolioMarketType(value, legacyMultichoice = false) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["all", "binary", "multi"].includes(normalized)) return normalized;
  return legacyMultichoice ? "multi" : "all";
}

function portfolioMarketTypeLabel(value) {
  const normalized = normalizePortfolioMarketType(value);
  if (normalized === "binary") return "Yes/No";
  if (normalized === "multi") return "Multi-outcome";
  return "All markets";
}

// The AI probability pipeline was retired, so every portfolio scores on the
// Polymarket outcome probability regardless of what an older config stored.
function normalizeProbabilitySource() {
  return "polymarket";
}

function normalizeExecutionTrigger(value) {
  return value === "after_scrape" ? "after_scrape" : "cron";
}

function executionTriggerLabel(value) {
  return normalizeExecutionTrigger(value) === "after_scrape"
    ? "After each completed market scan"
    : "Scheduled cron";
}

const EXECUTION_CRON_CHOICES = [30, 60, 120, 240, 480, 720, 1440];

function normalizeExecutionCronMinutes(value) {
  const minutes = Number(value);
  return EXECUTION_CRON_CHOICES.includes(minutes) ? minutes : 60;
}

function executionCronMinutesLabel(value) {
  const minutes = normalizeExecutionCronMinutes(value);
  if (minutes < 60) return `${minutes} minutes`;
  const hours = minutes / 60;
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

// Absent means on. A portfolio saved before this switch existed must keep trading
// rather than silently stop because a field it never had reads as false.
// The price every 5050 bid rests at, as a fraction of the 0..1 scale. Clamped
// inside the tradable band: 0 and 1 are not prices a limit order can hold.
function normalizeFixedEntryPrice(value) {
  const price = Number(value);
  if (!Number.isFinite(price) || price <= 0 || price >= 1) return 0.5;
  return Number(price.toFixed(2));
}

// A list of Polymarket tags saved on a portfolio: the tags 5050 may bid on, or the tags a
// portfolio refuses outright. Both are the same shape and are typed into the same kind of
// box. Accepts a saved list or a comma/space separated string, and normalizes to slugs the
// same way the tag picker does -- a tag entered as "E-Sports" has to match the `esports` a
// market actually carries.
function normalizeMarketTagList(value) {
  const source = Array.isArray(value)
    ? value
    : String(value ?? "").split(/[,\s]+/);
  const tags = [];
  for (const raw of source) {
    const tag = normalizedScrapedScanTag(raw);
    if (tag && !tags.includes(tag)) tags.push(tag);
    if (tags.length >= 40) break;
  }
  return tags;
}

// Gamma returns tags both as plain strings and as {label,slug} objects, and a market
// carries them under more than one field depending on which pass recorded it.
function marketTagSlugsOf(item = {}) {
  const slugs = new Set();
  for (const list of [item.polymarketTags, item.tags, item.firstTags]) {
    for (const raw of (Array.isArray(list) ? list : [])) {
      const tag = normalizedScrapedScanTag(
        raw && typeof raw === "object" ? (raw.slug || raw.label || raw.name || "") : raw,
      );
      if (tag) slugs.add(tag);
    }
  }
  for (const key of [item.riskCategory, item.category]) {
    const tag = normalizedScrapedScanTag(key);
    if (tag) slugs.add(tag);
  }
  return slugs;
}

function marketCarriesAnyTag(item, tags = []) {
  if (!tags.length) return false;
  const slugs = marketTagSlugsOf(item);
  return tags.some((tag) => slugs.has(tag));
}

// An empty allow-list means every tag is allowed; an empty exclusion list excludes
// nothing. Same question underneath, opposite default -- hence the two wrappers.
function marketMatchesAllowedTags(item, allowedTags = []) {
  return !allowedTags.length || marketCarriesAnyTag(item, allowedTags);
}

// Which of a portfolio's excluded tags this market carries, so the shortlist can say
// which one rejected it rather than just that something did.
function marketExcludedByTags(item, excludedTags = []) {
  if (!excludedTags.length) return [];
  const slugs = marketTagSlugsOf(item);
  return excludedTags.filter((tag) => slugs.has(tag));
}

function automationIsEnabled(config = {}) {
  return config.automationEnabled !== false;
}

function automaticRotationIsEnabled(config = {}) {
  return config.autoRotatePositions !== false;
}

function normalizeStopLossRiskMultiplier(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(3, Number(numeric.toFixed(2))));
}

function stopLossRiskMultiplier(config = {}) {
  if (config.stopLossRiskMultiplier != null) {
    return normalizeStopLossRiskMultiplier(config.stopLossRiskMultiplier, 0);
  }
  return config.stopLossEnabled === true ? 1 : 0;
}

// The paper synthetic stop Equal was built around. Off by default for every portfolio
// except Equal, which carries it in its own shipped default -- unlike rotation, most
// portfolios have never had this behavior, so absent must not read as on.
function stopLossIsEnabled(config = {}) {
  return stopLossRiskMultiplier(config) > 0;
}

function stopLossRiskLabel(config = {}) {
  const multiplier = stopLossRiskMultiplier(config);
  return multiplier > 0 ? `${percent(multiplier)} of net win` : "Off";
}

function probabilitySourceLabel(value) {
  return normalizeProbabilitySource(value) === "polymarket" ? "Polymarket probability" : "AI probability";
}

function portfolioProbability(item, config = {}) {
  return normalizeProbabilitySource(config.probabilitySource) === "polymarket"
    // Match the executor: Gamma's listing quote can be stale, while marketPrice
    // is the executable CLOB entry shown in the candidate and trade tables.
    ? Number(item.marketPrice)
    : Number(item.aiProbability);
}

function marketProbabilityRoundsToCertain(item = {}) {
  const marketProbability = Number(item.marketProbability ?? item.marketPrice);
  return Number.isFinite(marketProbability) && marketProbability >= 0.9995;
}

function portfolioExpectedValue(item, config = {}) {
  const value = normalizeProbabilitySource(config.probabilitySource) === "polymarket"
    ? Number(item.netGainIfWinUsdc)
    : binarySideQuoteIsStale(item)
      ? expectedValue(item)
      : Number(item.expectedValueUsdc);
  return Number.isFinite(value) ? value : null;
}

function portfolioAnnualizedReturn(item, config = {}) {
  const value = normalizeProbabilitySource(config.probabilitySource) === "polymarket"
    ? potentialAnnualizedReturn(item)
    : binarySideQuoteIsStale(item)
      ? annualizedExpectedReturn(item)
      : Number(item.annualizedReturn);
  return Number.isFinite(value) ? value : null;
}

function portfolioReturnMetricLabel(config = {}) {
  return normalizeProbabilitySource(config.probabilitySource) === "polymarket" ? "Potential p.a." : "EV p.a.";
}

function selectionOrderLabel(value, config = {}) {
  return normalizeSelectionOrder(value) === "highest_reward_risk_first" ? "Reward/risk" : portfolioReturnMetricLabel(config);
}

function normalizeOptionalDays(value) {
  if (value === "" || value == null) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.min(365, Math.max(1, Math.round(numeric)));
}

function resolutionDaysForMode(mode = state.mode) {
  return normalizeOptionalDays(portfolioConfigForMode(mode).maxResolutionDays) || DEFAULT_MAX_RESOLUTION_DAYS;
}

function normalizeOptionalMoney(value) {
  if (value === "" || value == null) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return Math.round(numeric * 100) / 100;
}

function portfolioConfigForMode(mode = state.mode) {
  const defaults = defaultPortfolioConfig();
  const config = state.portfolioConfig || {};
  if (LIVE_MODES.has(normalizeMode(mode))) {
    const key = liveConfigKeyForMode(mode);
    const saved = config[key] || {};
    const merged = {
      ...defaults[key],
      ...saved,
    };
    const marketType = normalizePortfolioMarketType(
      saved.marketType,
      saved.requireMostProbableOutcome ?? defaults[key].requireMostProbableOutcome,
    );
    return { ...merged, marketType, requireMostProbableOutcome: marketType === "multi" };
  }
  const strategyId = paperStrategyIdFromMode(mode);
  const saved = (config.paper || {})[strategyId] || {};
  // A created portfolio has no shipped defaults to fall back to, so it starts from the
  // same base the API applies when it stores one.
  const strategyDefaults = defaults.paper[strategyId] || customPaperPortfolioDefaults(strategyId);
  const merged = {
    ...strategyDefaults,
    ...saved,
  };
  const marketType = normalizePortfolioMarketType(
    saved.marketType,
    saved.requireMostProbableOutcome ?? strategyDefaults.requireMostProbableOutcome,
  );
  return { ...merged, marketType, requireMostProbableOutcome: marketType === "multi" };
}

// Mirrors custom_paper_portfolio_defaults() in api.php. A created portfolio starts from
// the most permissive shipped profile and is executed through the same automation path
// as shipped paper portfolios unless the user explicitly switches it off.
function customPaperPortfolioDefaults(strategyId) {
  return {
    ...defaultPortfolioConfig().paper.highReward,
    displayName: strategyId,
    minProbability: 0.5,
    minLiquidityUsdc: null,
    autoRotatePositions: false,
    automationEnabled: true,
    archived: false,
    custom: true,
  };
}

function normalizePortfolioAccountType(value) {
  return value === "live" ? "live" : "paper";
}

function portfolioAccountTypeLabel(value) {
  return normalizePortfolioAccountType(value) === "live" ? "Live" : "Paper";
}

function portfolioAccountTypeNote(value) {
  return normalizePortfolioAccountType(value) === "live"
    ? "Live uses the connected Polymarket account and updates the existing Live portfolio."
    : "Paper keeps its own simulated account and does not touch the live wallet.";
}

function updatePortfolioConfigForMode(mode, updates) {
  const normalizedMode = normalizeMode(mode);
  const base = state.portfolioConfig || defaultPortfolioConfig();
  // Each live portfolio writes to its own slot. Matching only "live" here sent every
  // 5050 setting -- the automation switch and the order price alike -- into the
  // conservative paper portfolio, so changing one portfolio changed another.
  if (LIVE_MODES.has(normalizedMode)) {
    const key = liveConfigKeyForMode(normalizedMode);
    state.portfolioConfig = {
      ...base,
      [key]: {
        ...portfolioConfigForMode(normalizedMode),
        ...updates,
      },
    };
    return;
  }
  const strategyId = paperStrategyIdFromMode(normalizedMode);
  state.portfolioConfig = {
    ...base,
    paper: {
      ...(base.paper || {}),
      [strategyId]: {
        ...portfolioConfigForMode(normalizedMode),
        ...updates,
      },
    },
  };
}

function normalizedExcludedCandidateTokenIds(value) {
  const tokens = Array.isArray(value) ? value : [];
  return [...new Set(tokens
    .map((token) => String(token || "").trim())
    .filter((token) => /^\d{8,100}$/.test(token)))]
    .slice(0, 500);
}

function excludedCandidateTokenIdsForMode(mode = state.mode) {
  return normalizedExcludedCandidateTokenIds(portfolioConfigForMode(mode).excludedCandidateTokenIds);
}

async function setPortfolioCandidateExcluded(mode, tokenId, excluded) {
  const normalizedTokenId = String(tokenId || "").trim();
  if (!/^\d{8,100}$/.test(normalizedTokenId)) return;
  const previous = excludedCandidateTokenIdsForMode(mode);
  const next = excluded
    ? [...new Set([...previous, normalizedTokenId])]
    : previous.filter((value) => value !== normalizedTokenId);
  updatePortfolioConfigForMode(mode, { excludedCandidateTokenIds: next });
  renderPortfolioCandidates();
  try {
    await savePortfolioConfigNow();
    setExecutionStatus(excluded ? "candidate excluded from this portfolio" : "candidate restored to this portfolio shortlist");
  } catch (error) {
    updatePortfolioConfigForMode(mode, { excludedCandidateTokenIds: previous });
    renderPortfolioCandidates();
    setExecutionStatus(error.message || "candidate exclusion could not be saved", "error");
  }
}

function storedLiveExecutionArmed() {
  for (const storageName of ["localStorage", "sessionStorage"]) {
    try {
      const storage = window[storageName];
      const value = storage.getItem(LIVE_EXECUTION_STORAGE_KEY);
      if (value === "true") return true;
    } catch {
      // Continue with the next browser storage fallback.
    }
  }
  try {
    const cookieValue = document.cookie
      .split(";")
      .map((entry) => entry.trim())
      .find((entry) => entry.startsWith(`${LIVE_EXECUTION_STORAGE_KEY}=`))
      ?.split("=")[1];
    if (cookieValue === "true") return true;
  } catch {
    // Storage remains optional; the live confirmation still protects dispatch.
  }
  return false;
}

function saveLiveExecutionArmed(value) {
  const serialized = value ? "true" : "false";
  for (const storageName of ["localStorage", "sessionStorage"]) {
    try {
      const storage = window[storageName];
      storage.setItem(LIVE_EXECUTION_STORAGE_KEY, serialized);
    } catch {
      // A restricted mobile browser may reject one storage area; keep trying.
    }
  }
  try {
    const sharedDomain = /(^|\.)osobnizkusenosti\.cz$/i.test(window.location.hostname)
      ? "; Domain=.osobnizkusenosti.cz"
      : "";
    document.cookie = `${LIVE_EXECUTION_STORAGE_KEY}=${serialized}; Path=/; Max-Age=7776000; SameSite=Lax; Secure${sharedDomain}`;
  } catch {
    // The browser storage values above remain the fallback outside production.
  }
}

function setExecutionStatus(text, tone = "") {
  if (!els.executionStatus) return;
  els.executionStatus.textContent = text;
  els.executionStatus.classList.toggle("error", tone === "error");
  els.executionStatus.classList.toggle("muted", tone !== "error");
}

function systemConfig() {
  const defaults = defaultPortfolioConfig().system;
  return {
    ...defaults,
    ...((state.portfolioConfig || {}).system || {}),
  };
}

function updateSystemConfig(updates) {
  const base = state.portfolioConfig || defaultPortfolioConfig();
  state.portfolioConfig = {
    ...base,
    system: {
      ...systemConfig(),
      ...updates,
    },
  };
}

function stateCacheKey(target, summary = "full") {
  return `${STATE_CACHE_PREFIX}${target}:${summary || "full"}`;
}

// The saved portfolio config, cached like the state is. Which portfolios exist and which
// are archived cannot be guessed: until it is known, defaultPortfolioConfig() answers with
// the four shipped portfolios and nothing archived, so an archived portfolio rendered for
// one frame and a created one was missing for the same frame. Caching it means the answer
// is already there on the first paint of every visit after the first.
function readCachedPortfolioConfig() {
  try {
    const raw = localStorage.getItem(`${STATE_CACHE_PREFIX}portfolio-config`);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" && parsed.paper && typeof parsed.paper === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function writeCachedPortfolioConfig(config) {
  try {
    if (config && typeof config === "object" && config.paper && typeof config.paper === "object") {
      localStorage.setItem(`${STATE_CACHE_PREFIX}portfolio-config`, JSON.stringify(config));
    }
  } catch {
    // Ignore cache write failures; the in-memory config still stands.
  }
}

function readCachedState(target, summary = "full") {
  try {
    const raw = localStorage.getItem(stateCacheKey(target, summary));
    if (!raw) return null;
    const payload = JSON.parse(raw);
    const data = payload && typeof payload.data === "object" ? payload.data : null;
    if (target === "paper" && data) {
      const detailsMode = String(data.evaluationDetailsMode || "");
      if (summary === "candidates") {
        return detailsMode === "compact" && Array.isArray(data.evaluations) ? data : null;
      }
      if (detailsMode === "compact" || !data.paperPortfolios) {
        return null;
      }
    }
    return data;
  } catch {
    return null;
  }
}

function writeCachedState(target, data, summary = "full") {
  try {
    localStorage.setItem(stateCacheKey(target, summary), JSON.stringify({
      cachedAt: new Date().toISOString(),
      data,
    }));
  } catch {
    // Ignore cache write failures; the live in-memory state still remains.
  }
}

function rememberStateFetchError(target, error) {
  state.stateFetchErrors[target] = {
    message: error?.message || String(error || "state refresh failed"),
    at: new Date().toISOString(),
  };
}

function clearStateFetchError(target) {
  delete state.stateFetchErrors[target];
}

function stateWarningHtml(target, label) {
  const warning = state.stateFetchErrors[target];
  if (!warning) return "";
  const time = warning.at ? formatDate(warning.at) : "-";
  return `
    <div class="sync-warning">
      Showing last saved ${escapeHtml(label)} data. Latest refresh failed at ${escapeHtml(time)}: ${escapeHtml(warning.message)}
    </div>
  `;
}

// The button on a portfolio's dashboard runs THAT portfolio. 5050 is a live mode,
// so answering "live" for it started the main live portfolio's workflow instead --
// a different algorithm, against real money.
function currentExecutionTarget() {
  if (isFixedEntryMode()) return "live-5050";
  return isLiveMode() ? "live" : state.mode;
}

function oneTimeExecutionTarget(button) {
  if (!button) return currentExecutionTarget();
  if (button.dataset.oneTimeExecution === "current") return currentExecutionTarget();
  return button.dataset.oneTimeExecution === "live" ? "live" : "paper";
}

function isPaperExecutionTarget(target) {
  return target === "paper" || String(target || "").startsWith("paper-");
}

function executionTargetLabel(target) {
  if (target === "live-5050") return "5050";
  if (target === "live") return "live";
  // portfolioNameForMode, not paperModeLabel: the latter only ever reads the shipped
  // built-in name, so a renamed portfolio (Equal -> Stop loss) still read as its old name
  // in the run-once button, the execution-progress modal, and the workflow-started toast.
  if (isPaperExecutionTarget(target)) return portfolioNameForMode(target === "paper" ? state.mode : target);
  return "paper";
}

function syncExecutionButtons() {
  els.executionButtons.forEach((button) => {
    const target = oneTimeExecutionTarget(button);
    const busy = state.executionBusy === target;
    button.disabled = Boolean(state.executionBusy);
    button.classList.toggle("live", isLiveMode());
    const labels = target === "live"
      ? ["Run live once", "Starting live..."]
      : target === "live-5050"
      ? ["Run 5050 once", "Starting 5050..."]
      : [`Run ${executionTargetLabel(target)} once`, `Starting ${executionTargetLabel(target)}...`];
    const [idleLabel, busyLabel] = labels;
    button.textContent = busy ? busyLabel : idleLabel;
  });
}

const PORTFOLIO_TAB_ROUTE_SEGMENTS = {
  "daily-picks": "opened",
  "closed-trades": "closed",
  "portfolio-candidates": "candidates",
  "run-log": "run-log",
};

function portfolioTabFromRouteSegment(segment) {
  const normalized = String(segment || "").trim().toLowerCase();
  return Object.entries(PORTFOLIO_TAB_ROUTE_SEGMENTS)
    .find(([, value]) => value === normalized)?.[0] || "daily-picks";
}

function portfolioTabRoutePath(tab = "daily-picks") {
  const segment = PORTFOLIO_TAB_ROUTE_SEGMENTS[tab] || PORTFOLIO_TAB_ROUTE_SEGMENTS["daily-picks"];
  return `/trading/portfolios/${segment}/`;
}

function opportunityRoutePath(view = "scraped") {
  const normalized = normalizeOpportunityView(view);
  return normalized === "scan-log"
    ? "/trading/opportunities/scraped/scan-log/"
    : `/trading/opportunities/${normalized}/`;
}

function normalizeScrapedTaxonomyKind(value) {
  const kind = String(value || "").trim().toLowerCase();
  return kind === "category" || kind === "tag" ? kind : "";
}

function normalizeScrapedTaxonomyLabel(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .slice(0, 160);
}

function normalizedScrapedTaxonomyFilter(value = null) {
  const kind = normalizeScrapedTaxonomyKind(value?.kind);
  const label = normalizeScrapedTaxonomyLabel(value?.label);
  return kind && label ? { kind, label } : null;
}

function scrapedTaxonomyRouteFilter(search = window.location.search) {
  const params = new URLSearchParams(search || "");
  return normalizedScrapedTaxonomyFilter({
    kind: params.get(SCRAPED_TAXONOMY_KIND_QUERY_PARAM),
    label: params.get(SCRAPED_TAXONOMY_VALUE_QUERY_PARAM),
  });
}

function normalizeScrapedStatuses(values, fallback = ["SCRAPED"]) {
  const allowed = new Set(["SCRAPED", "RESOLVED"]);
  const source = Array.isArray(values) ? values : String(values || "").split(",");
  const normalized = [...new Set(source.map((value) => String(value || "").trim().toUpperCase()).filter((value) => allowed.has(value)))];
  return normalized.length ? normalized : [...fallback];
}

function scrapedStatusesFromRoute(search = window.location.search) {
  const params = new URLSearchParams(search || "");
  return normalizeScrapedStatuses(params.get(SCRAPED_STATUS_QUERY_PARAM));
}

function scrapedStatusesAreExplicitInRoute(search = window.location.search) {
  return new URLSearchParams(search || "").has(SCRAPED_STATUS_QUERY_PARAM);
}

function normalizeScrapedMarketType(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return ["all", "binary", "multi"].includes(normalized) ? normalized : "all";
}

function scrapedRuleFiltersFromRoute(search = window.location.search) {
  const params = new URLSearchParams(search || "");
  const probabilityRaw = Number(params.get(SCRAPED_PROBABILITY_QUERY_PARAM));
  const daysRaw = params.get(SCRAPED_MAX_DAYS_QUERY_PARAM);
  const marketTypeExplicit = params.has(SCRAPED_MARKET_TYPE_QUERY_PARAM);
  return {
    probabilityFilter: Number.isFinite(probabilityRaw)
      ? normalizeEvaluationProbabilityFilter(probabilityRaw / 100)
      : null,
    daysFilter: daysRaw == null ? null : normalizeEvaluationDaysFilter(daysRaw),
    marketType: normalizeScrapedMarketType(params.get(SCRAPED_MARKET_TYPE_QUERY_PARAM)),
    marketTypeExplicit,
    hasRuleFilters: params.has(SCRAPED_PROBABILITY_QUERY_PARAM)
      || params.has(SCRAPED_MAX_DAYS_QUERY_PARAM)
      || marketTypeExplicit,
  };
}

function setScrapedStatuses(statuses, { render = true } = {}) {
  state.scrapedStatuses = normalizeScrapedStatuses(statuses);
  els.scrapedStatusOptions.forEach((input) => {
    input.checked = state.scrapedStatuses.includes(input.value);
  });
  if (render) renderBotEvaluations();
}

function scrapedTaxonomyOpportunityPath(filter = state.scrapedTaxonomyFilter, options = {}) {
  const normalized = normalizedScrapedTaxonomyFilter(filter);
  const statuses = normalizeScrapedStatuses(options.statuses || (normalized
    ? ["SCRAPED", "RESOLVED"]
    : state.scrapedStatuses));
  const rule = options.rule || null;
  const query = new URLSearchParams();
  if (normalized) {
    query.set(SCRAPED_TAXONOMY_KIND_QUERY_PARAM, normalized.kind);
    query.set(SCRAPED_TAXONOMY_VALUE_QUERY_PARAM, normalized.label);
  }
  if (Object.hasOwn(options, "statuses") || statuses.length !== 1 || statuses[0] !== "SCRAPED") {
    query.set(SCRAPED_STATUS_QUERY_PARAM, statuses.join(","));
  }
  if (rule) {
    const probabilityFilter = normalizeEvaluationProbabilityFilter(rule.probabilityFilter);
    const daysFilter = normalizeEvaluationDaysFilter(rule.daysFilter);
    const marketType = normalizeScrapedMarketType(rule.marketType);
    if (probabilityFilter > 0) query.set(SCRAPED_PROBABILITY_QUERY_PARAM, String(Math.round(probabilityFilter * 100)));
    if (daysFilter != null) query.set(SCRAPED_MAX_DAYS_QUERY_PARAM, String(daysFilter));
    if (marketType !== "all") query.set(SCRAPED_MARKET_TYPE_QUERY_PARAM, marketType);
  }
  if (![...query.keys()].length) return opportunityRoutePath("scraped");
  return `${opportunityRoutePath("scraped")}?${query.toString()}`;
}

function scrapedRuleOpportunityPath(row, taxonomyFilter = null) {
  return scrapedTaxonomyOpportunityPath(taxonomyFilter, {
    statuses: ["SCRAPED"],
    rule: {
      probabilityFilter: Number(row?.threshold || 0),
      daysFilter: row?.maxResolutionDays,
      marketType: row?.marketType,
    },
  });
}

function scrapedResolvedRuleOpportunityPath(row, taxonomyFilter = null) {
  return scrapedTaxonomyOpportunityPath(taxonomyFilter, {
    statuses: ["RESOLVED"],
    rule: {
      probabilityFilter: Number(row?.threshold || 0),
      daysFilter: row?.maxResolutionDays,
      marketType: row?.marketType,
    },
  });
}

function scrapedTaxonomyProbabilityRule(row) {
  const minimumProbability = Number(row?.minimumProbability);
  return Number.isFinite(minimumProbability) && minimumProbability > 0
    ? { probabilityFilter: minimumProbability }
    : null;
}

function scrapedTaxonomyOpenOpportunityPath(kind, label, row = null) {
  return scrapedTaxonomyOpportunityPath({ kind, label }, {
    statuses: ["SCRAPED"],
    rule: scrapedTaxonomyProbabilityRule(row),
  });
}

function scrapedTaxonomyResolvedOpportunityPath(kind, label, row = null) {
  return scrapedTaxonomyOpportunityPath({ kind, label }, {
    statuses: ["RESOLVED"],
    rule: scrapedTaxonomyProbabilityRule(row),
  });
}

function currentRouteState() {
  const path = window.location.pathname.replace(/\/+$/, "/");
  if (/(?:^|\/)opportunities\/scraped\/scan-log\/$/.test(path)) {
    return {
      page: "opportunities",
      tab: "settings-runs",
      settingsSection: "evaluation-log",
      evaluationStatus: "EVALUATED",
      opportunityView: "scan-log",
    };
  }
  const opportunityRoute = path.match(/(?:^|\/)opportunities(?:\/([^/]+))?\/$/);
  if (opportunityRoute) {
    const opportunityView = normalizeOpportunityView(opportunityRoute[1]);
    return {
      page: "opportunities",
      tab: "settings-runs",
      settingsSection: "evaluation-log",
      evaluationStatus: "EVALUATED",
      opportunityView,
      scrapedTaxonomyFilter: opportunityView === "scraped" ? scrapedTaxonomyRouteFilter() : null,
      scrapedStatuses: opportunityView === "scraped" ? scrapedStatusesFromRoute() : ["SCRAPED"],
      scrapedStatusesExplicit: opportunityView === "scraped" ? scrapedStatusesAreExplicitInRoute() : false,
      scrapedRuleFilters: opportunityView === "scraped" ? scrapedRuleFiltersFromRoute() : null,
    };
  }
  if (path.endsWith("/trading/settings/") || path.endsWith("/settings/")) {
    return {
      page: "settings",
      tab: "settings-runs",
      settingsSection: "calculations",
    };
  }
  const portfolioRoute = path.match(/(?:^|\/)portfolios(?:\/([^/]+))?\/$/);
  if (portfolioRoute) {
    return {
      page: "portfolios",
      tab: portfolioTabFromRouteSegment(portfolioRoute[1]),
    };
  }
  return {
    page: "portfolios",
    tab: "daily-picks",
  };
}

function routePath(page, tab = "daily-picks") {
  const normalized = ["settings", "opportunities", "portfolios"].includes(page) ? page : "portfolios";
  if (normalized === "portfolios") return portfolioTabRoutePath(tab);
  if (normalized === "opportunities") return opportunityRoutePath(tab);
  return `/trading/${normalized}/`;
}

function pageOwnsSection(section, page = state.page) {
  return String(section.dataset.pageSection || "")
    .split(/\s+/)
    .filter(Boolean)
    .includes(page);
}

function syncPageSections() {
  els.pageSections.forEach((section) => {
    const visible = pageOwnsSection(section);
    section.hidden = !visible;
    section.setAttribute("aria-hidden", visible ? "false" : "true");
  });
}

function setPage(page) {
  state.page = ["settings", "opportunities", "portfolios"].includes(page) ? page : "portfolios";
  if (els.shell) {
    els.shell.classList.toggle("page-portfolios", state.page === "portfolios");
    els.shell.classList.toggle("page-settings", state.page === "settings");
    els.shell.classList.toggle("page-opportunities", state.page === "opportunities");
  }
  syncPageSections();
  els.pageLinks.forEach((item) => {
    item.classList.toggle("active", item.dataset.pageLink === state.page);
    item.setAttribute("aria-current", item.dataset.pageLink === state.page ? "page" : "false");
  });
  if (els.settingsPageEyebrow) {
    els.settingsPageEyebrow.textContent = state.page === "opportunities" ? "Market evaluation" : "Settings";
  }
  syncOpportunityPageHeading();
}

function activateTab(target, { syncRoute = false, replace = false } = {}) {
  els.tabButtons.forEach((item) => {
    item.classList.toggle("active", item.dataset.tabTarget === target);
  });
  els.tabPanels.forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.tabPanel === target);
  });
  if (target === "portfolio-candidates") {
    renderPortfolioCandidates();
    refreshPortfolioCandidates({ quiet: true });
  }
  if (syncRoute && state.page === "portfolios") {
    const targetPath = portfolioTabRoutePath(target);
    const currentPath = `${window.location.pathname}${window.location.search}`;
    if (currentPath !== targetPath) {
      window.history[replace ? "replaceState" : "pushState"]({ page: "portfolios", tab: target }, "", targetPath);
    }
  }
}

function refreshDashboardAfterUserNavigation() {
  window.clearTimeout(state.userNavRefreshTimer);
  state.userNavRefreshTimer = window.setTimeout(() => {
    loadDashboardState({ skipAutoLiveSync: true });
    // Each portfolio watches its own workflow, so a freshly opened tab must ask rather
    // than wait out the interval and show nothing while a run of its own is going.
    pollRunningExecution(currentExecutionTarget());
  }, USER_NAV_REFRESH_DEBOUNCE_MS);
}

function setSettingsSection(section) {
  state.settingsSection = section || "evaluation-log";
  els.settingsSectionButtons.forEach((item) => {
    item.classList.toggle("active", item.dataset.settingsSection === state.settingsSection);
  });
  els.settingsPanels.forEach((panel) => {
    panel.hidden = panel.dataset.settingsPanel !== state.settingsSection;
  });
}

function setEvaluationStatus(status) {
  state.evaluationStatus = status || "EVALUATED";
  els.evaluationStatusButtons.forEach((item) => {
    item.classList.toggle("active", item.dataset.evaluationStatus === state.evaluationStatus);
  });
  renderBotEvaluations();
}

// The evaluated view is retired: it showed the AI pipeline's own verdicts, and nothing
// produces those any more. Old links and stored routes still say "evaluated", so they are
// answered with the scraped list rather than a blank page.
function normalizeOpportunityView(view) {
  return view === "scan-log" ? view : "scraped";
}

function syncOpportunityPageHeading() {
  const title = state.page === "opportunities"
    ? (state.opportunityView === "scraped" ? "Scraped opportunities" : state.opportunityView === "scan-log" ? "Scraping log" : "Evaluated opportunities")
    : "Automation settings";
  if (els.settingsPageTitle) els.settingsPageTitle.textContent = title;
  if (els.opportunityPanelTitle) els.opportunityPanelTitle.textContent = title;
}

function syncOpportunityViewControls() {
  const scraped = state.opportunityView === "scraped";
  const scanLog = state.opportunityView === "scan-log";
  els.opportunityViewButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.opportunityView === state.opportunityView);
  });
  els.evaluationOnlyControls.forEach((element) => {
    element.hidden = scraped || scanLog;
  });
  els.scrapedOnlyControls.forEach((element) => {
    element.hidden = !scraped;
  });
  els.opportunityFilterControls.forEach((element) => {
    element.hidden = scanLog;
  });
  // Days left, net yield and liquidity all describe whether a market can be traded
  // now. When the multi-select contains only settled rows, they can only ever
  // empty the list, so hide them instead of letting a leftover value silently do so.
  els.tradabilityFilterControls.forEach((element) => {
    element.hidden = scanLog || tradabilityFiltersAreIrrelevant();
  });
  const scrapedCounts = scraped ? scrapedOpportunityStatusCounts() : null;
  els.scrapedStatusLabels.forEach((label) => {
    if (!scrapedCounts) return;
    const status = label.dataset.scrapedStatusLabel;
    const count = status === "RESOLVED" ? scrapedCounts.resolved : scrapedCounts.scraped;
    label.textContent = `${status === "RESOLVED" ? "Resolved" : "Scraped"} (${formatInteger(count) || count})`;
  });
  els.scrapedStatusOptions.forEach((input) => {
    input.checked = state.scrapedStatuses.includes(input.value);
  });
  renderScrapedScanControls();
  syncScrapedTaxonomyFilterControl();
  syncScrapedMarketTypeFilterControl();
  if (scraped) loadScanCategoryCounts();
}

function normalizedScrapedScanTag(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

// A slug naming one fixture groups exactly one opportunity. The performance tables drop
// these, so the catalogue must not offer them either -- picking one would produce a view
// that no statistic in the application ever counted.
const PER_FIXTURE_TAXONOMY_LABEL = /^(?:market|event|team|match|topic|entity)\s*:|-(?:19|20)\d{2}-\d{2}-\d{2}(?:-|$)/i;

function taxonomyValuesFromRecord(item, kind) {
  // Scrape-time relations first, exactly as scrapedSimulationTaxonomy() reads them when
  // it builds the Category and Tag performance tables. The two used to disagree -- the catalogue
  // preferred today's Gamma relation -- so a market re-tagged after it was scraped was
  // counted in one group and listed in another.
  const fields = kind === "category"
    ? ["firstPolymarketCategories", "polymarketCategories"]
    : ["firstPolymarketTags", "polymarketTags"];
  const source = fields.map((field) => item?.[field]).find((value) => Array.isArray(value) && value.length);
  const entries = Array.isArray(source) ? source : [];
  const values = new Set();
  for (const entry of entries) {
    const raw = entry && typeof entry === "object"
      ? (entry.slug || entry.label || entry.name || "")
      : entry;
    const label = normalizeScrapedTaxonomyLabel(raw);
    if (label && !PER_FIXTURE_TAXONOMY_LABEL.test(label)) values.add(label);
  }
  return values;
}

// The filter the archive is queried with, or null when no taxonomy is selected. The key
// it produces is what tells a completed fetch from a stale one.
function scrapedTaxonomyDrilldownRequest() {
  const taxonomy = normalizedScrapedTaxonomyFilter(state.scrapedTaxonomyFilter);
  if (!taxonomy) return null;
  const routeFilter = state.scrapedRouteFilter;
  const probabilityFilter = routeFilter ? routeFilter.probabilityFilter : currentEvaluationProbabilityFilter();
  return {
    kind: taxonomy.kind,
    value: taxonomy.label,
    statuses: normalizeScrapedStatuses(routeFilter ? routeFilter.statuses : state.scrapedStatuses),
    probability: Math.round(Math.max(0, Number(probabilityFilter) || 0) * 100),
  };
}

function scrapedTaxonomyDrilldownKey(request) {
  return request ? JSON.stringify(request) : "";
}

// The rows the statistics counted, read straight from the stored archive. The catalogue
// the browser holds is capped at the most recent 3,000 resolved rows, so a tag view built
// from it lists a fraction of its own headline number.
async function loadScrapedTaxonomyRows() {
  const request = scrapedTaxonomyDrilldownRequest();
  const key = scrapedTaxonomyDrilldownKey(request);
  if (!key) {
    if (state.scrapedTaxonomyRowsKey || state.scrapedTaxonomyRows) {
      state.scrapedTaxonomyRows = null;
      state.scrapedTaxonomyRowsKey = "";
      state.scrapedTaxonomyRowsError = "";
    }
    return;
  }
  if (state.scrapedTaxonomyRowsKey === key || state.scrapedTaxonomyRowsPending === key) return;
  state.scrapedTaxonomyRowsPending = key;
  state.scrapedTaxonomyRowsError = "";
  try {
    const payload = await fetchApiJson("api.php?action=taxonomy-observations&target=paper"
      + `&kind=${encodeURIComponent(request.kind)}`
      + `&value=${encodeURIComponent(request.value)}`
      + `&statuses=${encodeURIComponent(request.statuses.join(","))}`
      + `&probability=${encodeURIComponent(String(request.probability))}`);
    if (state.scrapedTaxonomyRowsPending !== key) return;
    state.scrapedTaxonomyRows = {
      rows: Array.isArray(payload.marketObservations) ? payload.marketObservations : [],
      matched: Number(payload.matched) || 0,
      truncated: payload.truncated === true,
    };
  } catch (error) {
    if (state.scrapedTaxonomyRowsPending !== key) return;
    state.scrapedTaxonomyRows = null;
    state.scrapedTaxonomyRowsError = error?.message || "the stored archive could not be read";
  } finally {
    if (state.scrapedTaxonomyRowsPending === key) {
      // Recorded either way, so a failure is reported once rather than retried on
      // every render until the selection changes.
      state.scrapedTaxonomyRowsKey = key;
      state.scrapedTaxonomyRowsPending = "";
      renderScrapedOpportunities();
    }
  }
}

function scrapedTaxonomyFilterMatches(item, filter = state.scrapedTaxonomyFilter) {
  const normalized = normalizedScrapedTaxonomyFilter(filter);
  if (!normalized) return true;
  const values = taxonomyValuesFromRecord(item, normalized.kind);
  if (normalized.kind === "category" && normalized.label === "uncategorized") return values.size === 0;
  if (normalized.kind === "tag" && normalized.label === "untagged") return values.size === 0;
  return values.has(normalized.label);
}

function scrapedTaxonomyFilterValue(filter = state.scrapedTaxonomyFilter) {
  const normalized = normalizedScrapedTaxonomyFilter(filter);
  return normalized ? `${normalized.kind}:${normalized.label}` : "";
}

function scrapedTaxonomyFilterFromValue(value) {
  const [kind, ...labelParts] = String(value || "").split(":");
  return normalizedScrapedTaxonomyFilter({ kind, label: labelParts.join(":") });
}

function scrapedTaxonomyFilterOptions() {
  const options = { category: new Set(), tag: new Set() };
  const report = state.botState?.latestCalculationReport
    || (Array.isArray(state.botState?.calculationReports) ? state.botState.calculationReports[0] : null);
  for (const kind of ["category", "tag"]) {
    for (const row of taxonomyRows(report, kind)) {
      const label = normalizeScrapedTaxonomyLabel(row?.label);
      if (label) options[kind].add(label);
    }
  }
  for (const item of scrapedMarketObservations()) {
    for (const kind of ["category", "tag"]) {
      for (const label of taxonomyValuesFromRecord(item, kind)) options[kind].add(label);
    }
  }
  const selected = normalizedScrapedTaxonomyFilter();
  if (selected) options[selected.kind].add(selected.label);
  return Object.fromEntries(Object.entries(options).map(([kind, values]) => [
    kind,
    [...values].sort((left, right) => left.localeCompare(right)),
  ]));
}

function taxonomyFilterDisplayLabel(kind, label) {
  if (kind === "category" && label === "uncategorized") return "Uncategorized";
  if (kind === "tag" && label === "untagged") return "Untagged";
  return scrapedScanTagLabel(label);
}

function syncScrapedTaxonomyFilterControl() {
  if (!els.scrapedTaxonomyFilter) return;
  const options = scrapedTaxonomyFilterOptions();
  const selected = scrapedTaxonomyFilterValue();
  const group = (kind, label) => options[kind].length ? `
    <optgroup label="${label}">
      ${options[kind].map((value) => `<option value="${escapeHtml(`${kind}:${value}`)}">${escapeHtml(taxonomyFilterDisplayLabel(kind, value))}</option>`).join("")}
    </optgroup>` : "";
  els.scrapedTaxonomyFilter.innerHTML = [
    '<option value="">All categories and tags</option>',
    group("category", "Categories"),
    group("tag", "Tags"),
  ].join("");
  els.scrapedTaxonomyFilter.value = selected;
}

function syncScrapedMarketTypeFilterControl() {
  state.scrapedMarketTypeFilter = normalizeScrapedMarketType(state.scrapedMarketTypeFilter);
  if (els.scrapedMarketTypeFilter) {
    els.scrapedMarketTypeFilter.value = state.scrapedMarketTypeFilter;
  }
}

function resetScrapedOpportunityFilters() {
  state.evaluationProbabilityFilter = 0;
  state.evaluationDaysFilter = null;
  state.evaluationNetYieldFilter = 0;
  state.evaluationLiquidityFilter = 0;
  state.scrapedMarketTypeFilter = "all";
  saveEvaluationProbabilityFilter(0);
  saveEvaluationDaysFilter(null);
  saveEvaluationNetYieldFilter(0);
  saveEvaluationLiquidityFilter(0);
  persistScrapedScanPreferences();
  syncEvaluationProbabilityFilterControl();
  syncEvaluationDaysFilterControl();
  syncEvaluationNetYieldFilterControl();
  syncEvaluationLiquidityFilterControl();
  syncScrapedMarketTypeFilterControl();
}

function applyScrapedTaxonomyRouteFilter(filter, statuses = ["SCRAPED"], ruleFilters = null, statusesExplicit = false) {
  state.scrapedTaxonomyFilter = normalizedScrapedTaxonomyFilter(filter);
  const normalizedStatuses = normalizeScrapedStatuses(statuses);
  state.scrapedRouteFilter = {
    statuses: normalizedStatuses,
    probabilityFilter: ruleFilters?.hasRuleFilters ? (ruleFilters.probabilityFilter ?? 0) : 0,
    daysFilter: ruleFilters?.hasRuleFilters ? ruleFilters.daysFilter : null,
    marketType: ruleFilters?.hasRuleFilters ? normalizeScrapedMarketType(ruleFilters.marketType) : "all",
    marketTypeExplicit: Boolean(ruleFilters?.marketTypeExplicit),
  };
  setScrapedStatuses(normalizedStatuses, { render: false });
  if (ruleFilters?.hasRuleFilters) {
    state.evaluationProbabilityFilter = ruleFilters.probabilityFilter ?? 0;
    state.evaluationDaysFilter = ruleFilters.daysFilter;
    state.evaluationNetYieldFilter = 0;
    state.evaluationLiquidityFilter = 0;
    state.scrapedMarketTypeFilter = normalizeScrapedMarketType(ruleFilters.marketType);
    syncEvaluationProbabilityFilterControl();
    syncEvaluationDaysFilterControl();
    syncEvaluationNetYieldFilterControl();
    syncEvaluationLiquidityFilterControl();
  } else if (state.scrapedTaxonomyFilter) {
    // A taxonomy link is an exploration of all recorded markets in that group, not a
    // continuation of the previous screen's personal scan constraints.
    resetScrapedOpportunityFilters();
    const openOnly = statusesExplicit && state.scrapedStatuses.length === 1 && state.scrapedStatuses[0] === "SCRAPED";
    if (!openOnly) setScrapedStatuses(["SCRAPED", "RESOLVED"], { render: false });
    state.scrapedMarketTypeFilter = "all";
  }
  syncScrapedTaxonomyFilterControl();
  syncScrapedMarketTypeFilterControl();
}

// The categories this picker offers, in Polymarket's own top-level sense. Every slug here
// is one the scanner already knows a Gamma tag id for, so a scan of it resolves without a
// lookup.
//
// This list used to be derived from the tags found on already-scraped rows, which was
// circular: only sports and esports are scraped on the schedule, so the box filled up with
// per-league slugs off those events -- uslc, bra3, uru1, chl2, setkamemd -- while politics
// and geopolitics could never appear, because you cannot scan a category until you have
// already scanned it. A fixed list breaks the loop and is what makes the box a category
// picker rather than a report of what happens to be stored.
const MARKET_SCAN_CATEGORIES = [
  "politics",
  "geopolitics",
  "sports",
  "esports",
  "crypto",
  "finance",
  "business",
  "technology",
  "science",
  "news",
  "weather",
  "video-games",
  "music",
  "movies",
];

// Gamma's own tag ids for those categories, so the count below costs one request each
// rather than a lookup first.
const MARKET_SCAN_CATEGORY_TAG_IDS = {
  politics: "2",
  geopolitics: "100265",
  sports: "1",
  esports: "64",
  crypto: "21",
  finance: "120",
  business: "107",
  technology: "22",
  science: "74",
  news: "38",
  weather: "84",
  "video-games": "3",
  music: "100",
  movies: "53",
};

// What the picker's number means: how many events Polymarket lists right now that match
// what the scheduled scan actually takes. The stored count was replaced by it because
// "how many we already have" answers a question nobody was asking -- the useful one is
// whether there is anything there worth scanning.
//
// The scan's filters are applied deliberately. Measured against Gamma, sports has 12,312
// open events and 191 that clear the scan's liquidity floor inside its window; a raw total
// would report twelve thousand markets the scan will never fetch by design.
//
// Measured cost for all fourteen categories in parallel: 303ms. The budget given was two
// seconds for the whole picker, and it is enforced rather than assumed -- a number that
// arrives late is worse than no number, so on timeout, failure, or a browser that refuses
// the cross-origin read, the label stays a plain category name.
const SCAN_CATEGORY_COUNT_BUDGET_MS = 2000;
const SCAN_CATEGORY_COUNT_TTL_MS = 5 * 60 * 1000;
const SCAN_CATEGORY_LIQUIDITY_MIN = 40000;
const SCAN_CATEGORY_WINDOW_DAYS = 2;

async function loadScanCategoryCounts() {
  const now = Date.now();
  if (state.scanCategoryCountsAt && now - state.scanCategoryCountsAt < SCAN_CATEGORY_COUNT_TTL_MS) return;
  if (state.scanCategoryCountsPending) return;
  state.scanCategoryCountsPending = true;

  // One controller for the whole picker: the budget is on the row of numbers arriving
  // together, not on each request separately.
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), SCAN_CATEGORY_COUNT_BUDGET_MS);
  const endDateMin = new Date(now - 6 * 3600000).toISOString();
  const endDateMax = new Date(now + SCAN_CATEGORY_WINDOW_DAYS * 86400000).toISOString();
  const counts = new Map();
  try {
    await Promise.all(MARKET_SCAN_CATEGORIES.map(async (category) => {
      const tagId = MARKET_SCAN_CATEGORY_TAG_IDS[category];
      if (!tagId) return;
      const url = "https://gamma-api.polymarket.com/events/pagination"
        + `?tag_id=${encodeURIComponent(tagId)}&closed=false&limit=1`
        + `&liquidity_min=${SCAN_CATEGORY_LIQUIDITY_MIN}`
        + `&end_date_min=${encodeURIComponent(endDateMin)}`
        + `&end_date_max=${encodeURIComponent(endDateMax)}`;
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) return;
        const body = await response.json();
        const total = Number(body?.pagination?.totalResults);
        if (Number.isFinite(total)) counts.set(category, total);
      } catch {
        // One category failing leaves the others their numbers; it just gets no bracket.
      }
    }));
  } finally {
    clearTimeout(deadline);
    state.scanCategoryCountsPending = false;
  }
  // Only overwrite when something came back, so a failed refresh keeps the last good row
  // rather than blanking every bracket.
  if (counts.size) {
    state.scanCategoryCounts = counts;
    state.scanCategoryCountsAt = Date.now();
    renderScrapedScanControls();
  }
}

// Categories in their listed order, not by how much of each is stored: a picker that
// reorders itself as scraping progresses is one you have to re-read every time.
function scrapedScanTagOptions() {
  const counts = state.scanCategoryCounts;
  return MARKET_SCAN_CATEGORIES.map((tag) => [tag, counts?.has(tag) ? Number(counts.get(tag)) : null]);
}

function scrapedScanTagLabel(tag) {
  return String(tag || "")
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function renderScrapedScanControls() {
  if (!els.scrapedScanTag) return;
  const options = scrapedScanTagOptions();
  const availableTags = new Set(options.map(([tag]) => tag));
  if (state.scrapedScanTag && !availableTags.has(state.scrapedScanTag)) state.scrapedScanTag = "";
  els.scrapedScanTag.innerHTML = [
    '<option value="">All tags</option>',
    // A category with nothing stored is the normal state for one never scanned, and the
    // whole point of offering it -- so it reads as "nothing yet" rather than "(0 stored)",
    // which looks like an empty category rather than an unvisited one.
    // No bracket at all when the count did not arrive inside the budget. That is the
    // stated fallback: a plain category name rather than a stale or invented number.
    ...options.map(([tag, count]) => {
      const label = escapeHtml(scrapedScanTagLabel(tag));
      const suffix = count == null ? "" : ` (${formatInteger(count) || count} on Polymarket)`;
      return `<option value="${escapeHtml(tag)}">${label}${suffix}</option>`;
    }),
  ].join("");
  els.scrapedScanTag.value = state.scrapedScanTag;
  if (els.scrapedScanButton) {
    els.scrapedScanButton.disabled = state.scrapedScanBusy;
    els.scrapedScanButton.hidden = state.scrapedScanBusy;
    els.scrapedScanButton.textContent = "Scan Polymarket";
  }
  if (els.scrapedScanStatus) {
    els.scrapedScanStatus.hidden = !state.scrapedScanBusy && !state.scrapedScanStatus;
    els.scrapedScanStatus.textContent = state.scrapedScanStatus || (state.scrapedScanBusy ? "Scanning..." : "");
    els.scrapedScanStatus.className = `scraped-scan-status${state.scrapedScanStatus?.startsWith("Error") ? " error" : ""}`;
  }
}

function normalizeMinimumNetYield(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
  return Math.min(10, Math.round(numeric * 1000) / 1000);
}

function setOpportunityView(view, { syncRoute = false, replace = false } = {}) {
  if (syncRoute) state.scrapedRouteFilter = null;
  state.opportunityView = normalizeOpportunityView(view);
  syncOpportunityPageHeading();
  syncOpportunityViewControls();
  renderBotEvaluations();
  if (state.opportunityView === "scraped" || state.opportunityView === "scan-log") ensureScrapedMarketState();
  if (state.opportunityView === "scan-log") loadScrapeRunHistory({ reset: true });
  if (syncRoute && state.page === "opportunities") {
    const targetPath = state.opportunityView === "scraped"
      ? scrapedTaxonomyOpportunityPath()
      : opportunityRoutePath(state.opportunityView);
    const currentPath = `${window.location.pathname}${window.location.search}`;
    if (currentPath !== targetPath) {
      window.history[replace ? "replaceState" : "pushState"]({ page: "opportunities", opportunityView: state.opportunityView }, "", targetPath);
    }
  }
}

function activatePage(page, { replace = false, preserveSearch = false } = {}) {
  const nextPage = ["settings", "opportunities", "portfolios"].includes(page) ? page : "portfolios";
  if (nextPage === "opportunities" && !preserveSearch) {
    // The main navigation opens the neutral catalogue. Taxonomy links carry their
    // own query string and use a full navigation, so they keep their explicit scope.
    state.scrapedTaxonomyFilter = null;
  }
  setPage(nextPage);
  if (nextPage === "opportunities") {
    setSettingsSection("evaluation-log");
    setEvaluationStatus("EVALUATED");
    activateTab("settings-runs");
    ensureFullBotState();
    if (state.opportunityView === "scraped" || state.opportunityView === "scan-log") ensureScrapedMarketState();
  } else if (nextPage === "settings") {
    setSettingsSection("calculations");
    activateTab("settings-runs");
  } else {
    activateTab("daily-picks");
  }

  const nextPath = routePath(
    nextPage,
    nextPage === "portfolios" ? "daily-picks" : nextPage === "opportunities" ? state.opportunityView : undefined,
  );
  const targetPath = preserveSearch ? `${nextPath}${window.location.search}` : nextPath;
  const currentPath = `${window.location.pathname}${window.location.search}`;
  if (currentPath !== targetPath) {
    const method = replace ? "replaceState" : "pushState";
    window.history[method]({ page: nextPage }, "", targetPath);
  }
}

function applyInitialRoute() {
  const route = currentRouteState();
  setPage(route.page);
  if (route.opportunityView === "scraped") {
    applyScrapedTaxonomyRouteFilter(
      route.scrapedTaxonomyFilter,
      route.scrapedStatuses,
      route.scrapedRuleFilters,
      route.scrapedStatusesExplicit,
    );
  }
  if (route?.opportunityView) setOpportunityView(route.opportunityView);
  if (route?.settingsSection) setSettingsSection(route.settingsSection);
  if (route?.evaluationStatus) setEvaluationStatus(route.evaluationStatus);
  activateTab(route?.tab || "daily-picks");
}

function syncLiveActivationUi() {
  if (!els.liveActivation) return;
  els.liveActivation.hidden = false;
  els.liveActivation.classList.toggle("armed", state.liveExecutionArmed);
  els.liveActivation.setAttribute("aria-pressed", state.liveExecutionArmed ? "true" : "false");
  els.liveActivation.textContent = state.liveExecutionArmed ? "Live execution armed" : "Activate live execution";
  els.liveActivation.title = state.liveExecutionArmed
    ? "Live one-time execution is enabled on this browser. Tap to disable it."
    : "Enable the live one-time execution gate on this browser.";
}

function toggleLiveExecutionGate() {
  state.liveExecutionArmed = !state.liveExecutionArmed;
  saveLiveExecutionArmed(state.liveExecutionArmed);
  syncLiveActivationUi();
  if (isLiveMode() && state.liveState) renderLiveState(state.liveState);
  setExecutionStatus(
    state.liveExecutionArmed ? "live execution gate activated on this browser" : "live execution gate deactivated",
    state.liveExecutionArmed ? "" : "error",
  );
}

// The tab row is data, not markup: portfolios can be created, archived and restored, so
// the buttons are rebuilt whenever that set changes rather than shipped as fixed HTML.
function syncModeButtons() {
  if (!els.modeSwitch) return;
  const modes = dashboardModes();
  // A mode the user is standing on stays reachable even if it has just been archived,
  // so archiving from its own tab does not leave the dashboard with no tab selected.
  if (!modes.includes(state.mode)) modes.splice(modes.length - 2, 0, state.mode);
  const signature = modes.map((mode) => `${mode}:${portfolioNavigationLabelForMode(mode)}`).join("|");
  if (els.modeSwitch.dataset.modeSignature === signature) return;
  els.modeSwitch.dataset.modeSignature = signature;
  els.modeSwitch.innerHTML = modes.map((mode) => `
    <button class="mode-button" type="button" data-mode-toggle="${escapeHtml(mode)}">${escapeHtml(portfolioNavigationLabelForMode(mode))}</button>
  `).join("");
  els.modeButtons = els.modeSwitch.querySelectorAll("[data-mode-toggle]");
}

function syncModeUi() {
  preselectRichestPortfolio();
  const live = isLiveMode();
  syncModeButtons();
  els.modeButtons.forEach((button) => {
    const buttonMode = normalizeMode(button.dataset.modeToggle);
    const isCurrent = button.dataset.modeToggle === state.mode;
    button.classList.toggle("active", isCurrent);
    // A live portfolio trades the real wallet. Portfolios are renameable, so the name
    // alone cannot be what tells them apart.
    button.classList.toggle("mode-button-live", LIVE_MODES.has(buttonMode));
    button.textContent = portfolioNavigationLabelForMode(buttonMode);
    // Not only a class: which portfolio is open decides whether what the tables show is
    // correct or a bug, so it is stated to assistive tech rather than left to colour.
    if (isCurrent) button.setAttribute("aria-current", "true");
    else button.removeAttribute("aria-current");
  });
  els.tabButtons.forEach((button) => {
    if (button.dataset.paperLabel || button.dataset.liveLabel) {
      button.textContent = live ? button.dataset.liveLabel : button.dataset.paperLabel;
    }
  });
  if (els.portfolioTitle) {
    els.portfolioTitle.textContent = portfolioTitleForMode();
  }
  // Hooked here rather than on the dashboard rerender: both the paper and the live
  // render paths call this, including on the first load, which the rerender does not
  // sit on top of -- so the overview and the archived list would have stayed empty
  // until something else changed.
  renderPortfolioOverview();
  renderArchivedPortfolios();
  // Fetched when the open tab does not already carry every portfolio's numbers. That is
  // always true on a live tab, and also true on a paper tab whose payload came up short of
  // a portfolio -- which used to leave that row reading "-" with nothing to fill it in.
  if (live || !overviewCoversEveryPortfolio()) loadPortfolioOverview();
  // 5050 is a live portfolio but not the Live one, and both tabs used to head their
  // tables "Opened live trades" -- so the two read identically while showing different
  // portfolios' rows. The same fix the run-log title already carries: name the portfolio.
  const portfolioLabel = portfolioUsesCustomName()
    ? portfolioNameForMode()
    : (isFixedEntryMode() ? "5050" : (live ? "live" : paperModeLabel()));
  if (els.primaryPanelTitle) els.primaryPanelTitle.textContent = `Opened ${portfolioLabel} trades`;
  if (els.secondaryPanelTitle) els.secondaryPanelTitle.textContent = `Closed ${portfolioLabel} trades`;
  if (els.evaluationControls) els.evaluationControls.style.display = "";
  if (els.accountSummary) els.accountSummary.hidden = !live;
  if (els.botStatus) els.botStatus.hidden = live;
  syncLiveActivationUi();
  syncExecutionButtons();
}

function formatDate(value) {
  const text = String(value || "");
  const dateOnly = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) return `${dateOnly[3]}. ${dateOnly[2]}. ${dateOnly[1]}`;

  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text || "-";
  return new Intl.DateTimeFormat("cs-CZ", {
    timeZone: "Europe/Prague",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString("cs-CZ") : null;
}

function nextHourlyMinute(minute, from = new Date()) {
  const next = new Date(from);
  next.setSeconds(0, 0);
  next.setMinutes(minute);
  if (next <= from) next.setHours(next.getHours() + 1);
  return next;
}

function nextMinuteFromSet(minutes, from = new Date()) {
  const sorted = [...minutes].sort((a, b) => a - b);
  for (const minute of sorted) {
    const candidate = new Date(from);
    candidate.setSeconds(0, 0);
    candidate.setMinutes(minute);
    if (candidate > from) return candidate;
  }
  const next = new Date(from);
  next.setSeconds(0, 0);
  next.setHours(next.getHours() + 1);
  next.setMinutes(sorted[0]);
  return next;
}

function compactTimeUntil(date, from = new Date()) {
  const diffMs = date.getTime() - from.getTime();
  if (!Number.isFinite(diffMs) || diffMs <= 0) return "now";
  const minutes = Math.ceil(diffMs / 60000);
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `in ${hours}h ${rest}m` : `in ${hours}h`;
}

function scheduleLabel(date) {
  return `${formatDate(date.toISOString())} (${compactTimeUntil(date)})`;
}

function updateSchedulePanel() {
  if (els.accountSyncPolicy) {
    els.accountSyncPolicy.textContent = "On page load";
  }
  if (els.nextAccountSync) {
    els.nextAccountSync.textContent = `scheduled backup ${scheduleLabel(nextMinuteFromSet([5, 20, 35, 50]))}`;
  }
}

function decimalOdds(price) {
  const value = Number(price);
  if (!Number.isFinite(value) || value <= 0) return null;
  return 1 / value;
}

function odds(value) {
  if (!Number.isFinite(value)) return "-";
  return `${value.toFixed(2)}x`;
}

function sortDirectionIndicator(direction) {
  const descending = direction === "desc";
  const label = descending ? "Razeno sestupne" : "Razeno vzestupne";
  return `<span class="sort-arrow" aria-hidden="true" title="${label}">${descending ? "↓" : "↑"}</span>`;
}

function sortArrow(key) {
  if (state.evaluationSort.key !== key) return "";
  return sortDirectionIndicator(state.evaluationSort.direction);
}

function calculationSortArrow(key) {
  if (state.calculationSort.key !== key) return "";
  return sortDirectionIndicator(state.calculationSort.direction);
}

function evaluationStake(item) {
  const stake = Number(item.stakeUsdc || 5);
  return Number.isFinite(stake) && stake > 0 ? stake : 5;
}

function binarySideQuoteIsStale(item) {
  const binaryYes = Number(item?.binaryYesMarketProbability);
  const binaryNo = Number(item?.binaryNoMarketProbability);
  const hasBinaryMetadata = Boolean(item?.binaryYesTokenId || item?.binaryNoTokenId)
    || (Number.isFinite(binaryYes) && binaryYes > 0 && binaryYes < 1 && Number.isFinite(binaryNo) && binaryNo > 0 && binaryNo < 1);
  if (!hasBinaryMetadata) return false;
  const entry = Number(item.marketPrice ?? item.entryPrice);
  const selectedMarketProbability = Number(item.marketProbability);
  return Number.isFinite(entry)
    && entry > 0
    && entry < 1
    && Number.isFinite(selectedMarketProbability)
    && selectedMarketProbability > 0
    && selectedMarketProbability < 1
    && Math.abs(entry - selectedMarketProbability) >= 0.1;
}

function evaluationEntryPrice(item) {
  if (binarySideQuoteIsStale(item)) return Number(item.marketProbability);
  return Number(item.marketPrice ?? item.entryPrice);
}

function evaluationTradingFee(item) {
  if (currentLimitOrders()) return 0;
  if (binarySideQuoteIsStale(item)) {
    const stake = evaluationStake(item);
    const price = evaluationEntryPrice(item);
    const feeRate = Number(item.feeRate || 0);
    if (Number.isFinite(stake) && Number.isFinite(price) && price > 0 && price < 1 && Number.isFinite(feeRate) && feeRate > 0) {
      return (stake / price) * feeRate * price * (1 - price);
    }
  }
  const fee = Number(item.takerFeeUsdc || 0);
  return Number.isFinite(fee) && fee > 0 ? fee : 0;
}

function evaluationShares(item) {
  if (binarySideQuoteIsStale(item)) {
    const stake = evaluationStake(item);
    const price = evaluationEntryPrice(item);
    return Number.isFinite(price) && price > 0 ? stake / price : null;
  }
  const shares = Number(item.executableShares || item.shares);
  if (Number.isFinite(shares) && shares > 0) return shares;
  const stake = evaluationStake(item);
  const price = evaluationEntryPrice(item);
  const decimal = decimalOdds(price);
  return decimal == null ? null : stake * decimal;
}

function evaluationTotalCost(item) {
  return evaluationStake(item) + evaluationTradingFee(item);
}

function gainIfWin(item) {
  const shares = evaluationShares(item);
  if (!Number.isFinite(shares)) return null;
  return shares - evaluationTotalCost(item);
}

function expectedValue(item) {
  const aiProbability = Number(item.aiProbability);
  const shares = evaluationShares(item);
  if (!Number.isFinite(aiProbability) || !Number.isFinite(shares)) return null;
  return (aiProbability * shares) - evaluationTotalCost(item);
}

function marketExpectedValueFromQuote(item) {
  const marketProbability = Number(item.marketProbability ?? item.marketPrice);
  const shares = evaluationShares(item);
  if (!Number.isFinite(marketProbability) || !Number.isFinite(shares)) return null;
  return (marketProbability * shares) - evaluationTotalCost(item);
}

function netYield(item) {
  const gain = gainIfWin(item);
  const cost = evaluationTotalCost(item);
  if (!Number.isFinite(gain) || !Number.isFinite(cost) || cost <= 0) return null;
  return gain / cost;
}

function evaluationRiskReward(item) {
  const risk = evaluationTotalCost(item);
  const reward = gainIfWin(item);
  if (!Number.isFinite(risk) || !Number.isFinite(reward) || risk <= 0 || reward <= 0) return null;
  return reward / risk;
}

function annualizedExpectedReturn(item) {
  const ev = expectedValue(item);
  const cost = evaluationTotalCost(item);
  if (!Number.isFinite(ev) || !Number.isFinite(cost) || cost <= 0) return null;
  const roi = ev / cost;
  const days = daysToResolution(item);
  return annualizeReturn(roi, days);
}

function marketAnnualizedExpectedReturn(item) {
  const ev = marketExpectedValueFromQuote(item);
  const cost = evaluationTotalCost(item);
  if (!Number.isFinite(ev) || !Number.isFinite(cost) || cost <= 0) return null;
  const roi = ev / cost;
  const days = evaluationDaysLeft(item);
  return annualizeReturn(roi, days);
}

function potentialAnnualizedReturn(item) {
  const yieldValue = netYield(item);
  const days = evaluationDaysLeft(item);
  if (!Number.isFinite(yieldValue)) return null;
  return annualizeReturn(yieldValue, days);
}

// Anything resolving sooner than the minimum capital cycle is annualized over
// that floor, not over its real horizon. Without the floor a 0.1 d hold would
// report five figures and a 0.0 d hold would be unbounded, so the cap is
// deliberate. It does mean every sub-cycle candidate with the same net yield
// reports the same p.a., which is unreadable unless the row says so: the number
// cannot otherwise be reconciled with the "Days left" column beside it.
function annualizationHorizonNote(item) {
  const days = evaluationDaysLeft(item);
  if (!Number.isFinite(days)) return "annualized over the minimum capital cycle; resolution date is unknown";
  const horizon = annualizationDays(days);
  if (!Number.isFinite(horizon) || horizon <= days) {
    return `annualized over ${days.toFixed(2)} days to resolution`;
  }
  return `annualized over the ${horizon} day minimum capital cycle, not the ${days.toFixed(2)} days to resolution, `
    + "because capital cannot be recycled faster than settlement allows; candidates that resolve sooner than that "
    + "therefore share one p.a. for a given net yield and are ranked by the shorter horizon instead";
}

function annualizationDays(value) {
  const days = Number(value);
  if (!Number.isFinite(days)) return null;
  return Math.max(MIN_ANNUALIZATION_DAYS, days);
}

function annualizeReturn(value, days) {
  if (!Number.isFinite(value)) return null;
  const horizon = annualizationDays(days);
  return horizon == null ? value : value * (365 / horizon);
}

function daysToResolution(item) {
  const value = Number(item.daysToResolution);
  return Number.isFinite(value) ? value : null;
}

function evaluationEndDate(item) {
  return tradeEndDate({
    ...item,
    openedAt: item.openedAt || item.evaluatedAt,
    date: item.date || item.evaluatedAt,
  });
}

function evaluationDaysLeft(item) {
  const endDate = evaluationEndDate(item);
  const remaining = daysUntil(endDate);
  if (Number.isFinite(remaining)) return remaining;
  return daysToResolution(item);
}

function evaluationResolvedByMarket(item) {
  const status = String(item?.status || "").trim().toUpperCase();
  if (["RESOLVED", "CLOSED", "FINALIZED", "SETTLED"].includes(status)) return true;
  if (binaryOutcomeQuotesAreBothZero(item)) return true;
  const resolutionStatus = String(item?.resolutionStatus || item?.umaResolutionStatus || "").trim().toUpperCase();
  if (["RESOLVED", "CLOSED", "FINAL", "FINALIZED", "SETTLED", "FINAL_PRICE_AVAILABLE", "NOT_ACCEPTING_ORDERS", "PENDING_RESULT"].includes(resolutionStatus)) {
    return true;
  }
  if (item?.marketClosed === true || item?.closed === true || item?.resolved === true || item?.isResolved === true) return true;
  if (item?.acceptingOrders === false) return true;
  const resolvedAt = Date.parse(item?.resolvedAt || item?.closedTime || item?.closedAt || item?.resolutionTime || "");
  return Number.isFinite(resolvedAt) && resolvedAt <= Date.now();
}

function binaryOutcomeQuotesAreBothZero(item) {
  // A multi-outcome event can still be represented by individual Yes/No CLOB books.
  // This count is only a robust settlement fallback, never the portfolio type selector.
  const hasBinaryMetadata = Boolean(item?.binaryYesTokenId || item?.binaryNoTokenId)
    || String(item?.marketType || "").toLowerCase() === "binary"
    || Number(item?.outcomeCount) === 2;
  if (!hasBinaryMetadata) return false;
  const yesRaw = item?.binaryYesMarketProbability;
  const noRaw = item?.binaryNoMarketProbability;
  if (yesRaw == null || noRaw == null || yesRaw === "" || noRaw === "") return false;
  const yes = Number(yesRaw);
  const no = Number(noRaw);
  return Number.isFinite(yes) && Number.isFinite(no) && yes === 0 && no === 0;
}

function evaluationEnded(item) {
  if (evaluationResolvedByMarket(item)) return true;
  const end = Date.parse(evaluationEndDate(item) || "");
  return Number.isFinite(end) && end <= Date.now();
}

function polymarketUrl(item) {
  const explicitUrl = String(item?.url || item?.marketUrl || "").trim();
  if (/^https:\/\/polymarket\.com\//i.test(explicitUrl)) return explicitUrl;
  const slug = String(item?.eventSlug || item?.slug || "").trim();
  if (/^[a-z0-9-]+$/i.test(slug)) return `https://polymarket.com/event/${slug}`;
  return "https://polymarket.com/";
}

function opportunityKey(item) {
  const tokenId = String(item?.tokenId || item?.clobTokenId || item?.assetId || item?.asset || "").trim();
  if (tokenId) return `token:${tokenId}`;
  const id = String(item?.id || "").trim();
  if (id) return id;
  const slug = String(item?.eventSlug || item?.slug || "").trim().toLowerCase();
  const outcome = String(item?.outcome || "").trim().toLowerCase();
  return slug && outcome ? `market:${slug}:${outcome}` : "";
}

function opportunityDetailUrl(itemOrKey) {
  const key = typeof itemOrKey === "string" ? itemOrKey : opportunityKey(itemOrKey);
  const url = new URL(opportunityRoutePath("scraped"), window.location.origin);
  if (key) url.searchParams.set("event", key);
  return url.pathname + url.search;
}

function absoluteOpportunityDetailUrl(itemOrKey) {
  return `${window.location.origin}${opportunityDetailUrl(itemOrKey)}`;
}

function currentOpportunityKeyFromUrl() {
  return new URLSearchParams(window.location.search).get("event") || "";
}

function findOpportunityByKey(key) {
  const wanted = String(key || "");
  if (!wanted) return null;
  const evaluations = Array.isArray(state.botState?.evaluations) ? state.botState.evaluations : [];
  return evaluations.find((item) => opportunityKey(item) === wanted)
    || evaluations.find((item) => String(item.id || "") === wanted)
    || null;
}

function shortIdentifier(value) {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= 18) return text;
  return `${text.slice(0, 8)}...${text.slice(-6)}`;
}

function marketAnchor(item) {
  const question = String(item?.question || "").trim();
  const outcome = String(item?.outcome || "-").trim() || "-";
  const explicitUrl = String(item?.url || item?.marketUrl || "").trim();
  const slug = String(item?.eventSlug || item?.slug || "").trim();
  const hasMarketUrl = /^https:\/\/polymarket\.com\//i.test(explicitUrl) || /^[a-z0-9-]+$/i.test(slug);
  const content = `<strong>${escapeHtml(outcome)}</strong>${question ? `<span>${escapeHtml(question)}</span>` : ""}`;
  if (!hasMarketUrl) return `<div class="market-link">${content}</div>`;
  return `<a class="market-link" href="${escapeHtml(polymarketUrl(item))}" target="_blank" rel="noopener noreferrer">${content}</a>`;
}

function tradePnlValue(trade) {
  if (isClosedTrade(trade)) return Number(trade.realizedPnlUsdc);
  return Number(trade.unrealizedPnlUsdc);
}

function tradePnlPct(trade) {
  if (isClosedTrade(trade)) return Number(trade.realizedPnlPct);
  return Number(trade.unrealizedPnlPct);
}

function isClosedTrade(trade) {
  return ["WON", "LOST", "CLOSED", "REDEEMED", "SOLD", "REDEEM_REQUIRED", "RESOLVED", "STOP_LOSS", "STOP_GAP", "LIMIT_ORDER_EXPIRED"].includes(String(trade.status || "").toUpperCase());
}

function closedTradePredictionResult(trade) {
  const status = String(trade.status || "").toUpperCase();
  if (["WON", "REDEEMED", "REDEEM_REQUIRED"].includes(status)) return true;
  // A stop loss firing is realizing a loss by design -- the position moved against the
  // pick badly enough to force an exit -- so it counts as a miss regardless of what the
  // market eventually resolves to, the same as an outright LOST.
  if (["LOST", "STOP_LOSS", "STOP_GAP"].includes(status)) return false;
  // No position was ever bought, so there is no prediction to grade -- neither a win
  // nor a loss, just excluded, the same as a sale with no settlement price yet.
  if (status === "LIMIT_ORDER_EXPIRED") return null;

  // A sale or rotation measures execution performance, not prediction accuracy. Count
  // it only after Polymarket publishes the selected outcome's final settlement price.
  const finalOutcomePrice = trade.finalOutcomePrice == null || trade.finalOutcomePrice === ""
    ? null
    : Number(trade.finalOutcomePrice);
  if (Number.isFinite(finalOutcomePrice)) {
    if (finalOutcomePrice >= 0.995) return true;
    if (finalOutcomePrice <= 0.005) return false;
  }
  return null;
}

function closedAccuracyStats(closedTrades) {
  const rows = Array.isArray(closedTrades) ? closedTrades.filter(isClosedTrade) : [];
  const resolvedResults = rows
    .map(closedTradePredictionResult)
    .filter((result) => result != null);
  const correct = resolvedResults.filter(Boolean).length;
  const total = resolvedResults.length;
  return {
    correct,
    total,
    excluded: Math.max(0, rows.length - total),
    rate: total ? correct / total : null,
  };
}

function renderClosedAccuracy(closedTrades, rebaseExcludedCount = 0) {
  const stats = closedAccuracyStats(closedTrades);
  if (els.portfolioAccuracy) {
    els.portfolioAccuracy.textContent = stats.rate == null ? "-" : probability(stats.rate);
    els.portfolioAccuracy.className = stats.rate == null ? "" : (stats.rate >= 0.5 ? "positive" : "negative");
  }
  if (els.portfolioAccuracyNote) {
    const parts = [`${stats.correct} / ${stats.total} resolved`];
    if (stats.excluded) parts.push(`${stats.excluded} early exits excluded`);
    // Trades closed before a capital rebase: still real history, kept in Closed positions,
    // just not weighed into performance measured "since" the rebase.
    if (rebaseExcludedCount) parts.push(`${rebaseExcludedCount} pre-reset trades excluded`);
    els.portfolioAccuracyNote.textContent = parts.join(" · ");
  }
}

function inferredDateFromQuestion(trade) {
  const question = String(trade.question || "");
  const match = question.match(/\b(?:by|on|before|through)\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:,\s*(\d{4}))?/i);
  if (!match) return null;
  const months = {
    january: 0,
    february: 1,
    march: 2,
    april: 3,
    may: 4,
    june: 5,
    july: 6,
    august: 7,
    september: 8,
    october: 9,
    november: 10,
    december: 11,
  };
  const opened = new Date(trade.openedAt || trade.date || Date.now());
  const fallbackEnd = new Date(trade.endDate || opened);
  const year = Number(match[3]) || (Number.isFinite(fallbackEnd.getTime()) ? fallbackEnd.getUTCFullYear() : opened.getUTCFullYear());
  const month = months[match[1].toLowerCase()];
  const day = Number(match[2]);
  if (!Number.isInteger(month) || !Number.isFinite(day)) return null;
  const inferred = new Date(Date.UTC(year, month, day, 23, 59, 59));
  if (!Number.isFinite(inferred.getTime())) return null;
  return inferred.toISOString();
}

function tradeEndDate(trade) {
  const stored = trade.endDate || trade.closedTime || trade.resolvedAt || null;
  const inferred = inferredDateFromQuestion(trade);
  if (!inferred) {
    if (stored || isClosedTrade(trade) || trade.mode !== "LIVE_ORDER") return stored;
    // A CLOB order without Gamma timing must still have a stable, conservative
    // holding horizon. The account sync replaces this with Gamma's exact
    // fixture time as soon as it is available.
    const createdAt = Date.parse(trade.openedAt || trade.date || "");
    const fallback = (Number.isFinite(createdAt) ? createdAt : Date.now()) + (24 * 60 * 60 * 1000);
    return new Date(fallback).toISOString();
  }
  const storedTime = Date.parse(stored || "");
  const inferredTime = Date.parse(inferred);
  if (!Number.isFinite(storedTime)) return inferred;
  if (!isClosedTrade(trade) && inferredTime > storedTime) return inferred;
  return stored;
}

function daysBetween(startValue, endValue) {
  const start = Date.parse(startValue || "");
  const end = Date.parse(endValue || "");
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, (end - start) / 86400000);
}

// Signed, for the same reason as the executor's daysToEnd: clamping at zero made every
// overdue market look like it was resolving right now. Each annualization below guards
// non-positive horizons with MIN_ANNUALIZATION_DAYS already, so the returns are unchanged.
function daysUntil(value) {
  const end = Date.parse(value || "");
  if (!Number.isFinite(end)) return null;
  return (end - Date.now()) / 86400000;
}

function tradeHoldingDays(trade) {
  const end = isClosedTrade(trade) ? (trade.resolvedAt || trade.closedTime || trade.lastCheckedAt || new Date().toISOString()) : new Date().toISOString();
  return daysBetween(trade.openedAt || trade.date, end);
}

function annualizedForPeriod(returnPct, days) {
  if (!Number.isFinite(returnPct) || !Number.isFinite(days) || days <= 0) return null;
  return returnPct * (365 / Math.max(days, MIN_ANNUALIZATION_DAYS));
}

function tradePotentialGain(trade) {
  const netGain = Number(trade.netGainIfWinUsdc);
  if (Number.isFinite(netGain)) return netGain;
  const shares = Number(trade.shares);
  const stake = Number(trade.stakeUsdc || 0);
  const fee = Number(trade.takerFeeUsdc || 0);
  if (Number.isFinite(shares) && shares > 0) return shares - stake - fee;
  return null;
}

function tradeCostBasis(trade) {
  return Number(trade.totalCostUsdc || trade.maxLossUsdc || trade.stakeUsdc || 0);
}

function tradePotentialGainPct(trade) {
  const gain = tradePotentialGain(trade);
  const basis = tradeCostBasis(trade);
  return basis > 0 && Number.isFinite(gain) ? gain / basis : null;
}

function tradeRiskReward(trade) {
  const risk = tradeCostBasis(trade);
  const reward = tradePotentialGain(trade);
  if (!Number.isFinite(risk) || !Number.isFinite(reward) || risk <= 0 || reward <= 0) return null;
  return reward / risk;
}

function riskReward(value) {
  if (!Number.isFinite(value)) return "-";
  return `${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}:1`;
}

function riskRewardClass(value) {
  if (!Number.isFinite(value)) return "";
  if (value >= 1) return "positive";
  if (value >= 0.33) return "";
  return "negative";
}

function tradePotentialAnnualized(trade) {
  const storedPendingReference = Number(trade.pendingResolutionAnnualizedReference);
  const resolutionTime = Date.parse(tradeEndDate(trade) || "");
  const resolutionPast = Number.isFinite(resolutionTime) && resolutionTime <= Date.now();
  // The scheduled end has passed, so a one-day annualization would be made
  // up. The live rotation ledger supplies the weakest still-measurable open
  // Win P.A. as a conservative reference for comparing settlement-pending
  // positions by their genuinely remaining nominal gain.
  if (!isClosedTrade(trade) && resolutionPast && Number.isFinite(storedPendingReference)) {
    return storedPendingReference;
  }
  if (!isClosedTrade(trade)) {
    const shares = Number(trade.shares ?? trade.size);
    const explicitValue = Number(trade.currentValueUsdc ?? trade.marketValueUsdc ?? trade.valueUsdc);
    const currentPrice = Number(trade.currentPrice ?? trade.markPrice ?? trade.price);
    const cost = tradeCostBasis(trade);
    const unrealizedPnl = Number(trade.unrealizedPnlUsdc);
    // The current mark already includes the unrealized P/L. Prefer the value
    // from the fresh account snapshot, then reconstruct it from mark or cost
    // plus unrealized P/L when a source omits currentValueUsdc.
    const currentValue = Number.isFinite(explicitValue) && explicitValue > 0
      ? explicitValue
      : (Number.isFinite(currentPrice) && Number.isFinite(shares) && shares > 0
        ? currentPrice * shares
        : (Number.isFinite(cost) && Number.isFinite(unrealizedPnl) ? cost + unrealizedPnl : null));
    const endDate = tradeEndDate(trade);
    const remainingDays = daysUntil(endDate);
    if (Number.isFinite(shares) && shares > 0 && Number.isFinite(currentValue) && currentValue > 0) {
      const remainingPotentialPct = (shares - currentValue) / currentValue;
      // A position can remain open while Polymarket awaits official settlement
      // after its scheduled end. Its remaining upside is still real, but is
      // compared with the portfolio's conservative one-day floor rather than
      // disappearing from the rotation calculation.
      const horizon = Number.isFinite(remainingDays) && remainingDays > 0
        ? remainingDays
        : MIN_ANNUALIZATION_DAYS;
      return annualizedForPeriod(remainingPotentialPct, horizon);
    }
  }
  const gainPct = tradePotentialGainPct(trade);
  const endDate = tradeEndDate(trade);
  const remainingDays = daysUntil(endDate);
  const storedDays = Number(trade.daysToResolution);
  const awaitingSettlement = String(trade.status || "").toUpperCase() === "PENDING_RESOLUTION";
  const totalPlannedDays = daysBetween(trade.openedAt || trade.date, endDate);
  // A stale or partial account snapshot can omit the live mark/share value.
  // Keep settlement-pending positions comparable by annualizing their known
  // remaining win with the synchronized horizon instead of returning a dash.
  const fallbackHorizon = Number.isFinite(remainingDays) && remainingDays > 0
    ? remainingDays
    : (Number.isFinite(storedDays) && storedDays > 0
      ? storedDays
      : (awaitingSettlement ? MIN_ANNUALIZATION_DAYS : totalPlannedDays));
  return annualizedForPeriod(gainPct, fallbackHorizon);
}

function decoratePendingLiveAnnualization(trades = []) {
  const currentOpenReturns = trades
    .filter((trade) => trade.mode === "LIVE" && !isClosedTrade(trade))
    .filter((trade) => {
      const end = Date.parse(tradeEndDate(trade) || "");
      return !Number.isFinite(end) || end > Date.now();
    })
    .map((trade) => tradePotentialAnnualized(trade))
    .filter(Number.isFinite);
  const reference = currentOpenReturns.length ? Math.min(...currentOpenReturns) : 0;
  return trades.map((trade) => {
    const end = Date.parse(tradeEndDate(trade) || "");
    const resolutionPast = Number.isFinite(end) && end <= Date.now();
    if (trade.mode !== "LIVE" || isClosedTrade(trade) || !resolutionPast) return trade;
    return {
      ...trade,
      pendingResolutionAnnualizedReference: reference,
    };
  });
}

// Polymarket's own date for the market. Deliberately never falls back to
// closedTime or resolvedAt: those are when we exited or booked the result, and
// using them made every closed row repeat its own Closed timestamp in the
// Resolution column. Horizon maths keeps using tradeEndDate, which may fall back.
function tradeResolutionDate(trade) {
  for (const value of [trade?.endDate, trade?.resolutionEndDate, trade?.scheduledEventDate]) {
    if (Number.isFinite(Date.parse(value || ""))) return value;
  }
  return null;
}

function resolutionCell(trade) {
  const endDate = tradeEndDate(trade);
  const resolutionDate = tradeResolutionDate(trade);
  const remaining = isClosedTrade(trade) ? null : daysUntil(endDate);
  const storedDays = Number(trade.daysToResolution);
  const awaitingSettlement = !isClosedTrade(trade)
    && String(trade.status || "").toUpperCase() === "PENDING_RESOLUTION";
  const days = Number.isFinite(remaining) && remaining > 0
    ? remaining
    : (Number.isFinite(storedDays) ? storedDays : (awaitingSettlement ? MIN_ANNUALIZATION_DAYS : null));
  const inferred = inferredDateFromQuestion(trade);
  const inferredNote = inferred && trade.endDate && Date.parse(inferred) > Date.parse(trade.endDate) ? "from question" : "";
  return `
    ${escapeHtml(resolutionDate ? formatDate(resolutionDate) : "-")}
    <span>${isClosedTrade(trade)
      ? (resolutionDate ? "Polymarket resolution" : "no Polymarket date")
      : (awaitingSettlement
        ? `awaiting settlement, ${compactDays(days)}`
        : `${compactDays(days)} left${inferredNote ? `, ${inferredNote}` : ""}`)}</span>
  `;
}

function holdingCell(trade) {
  const heldDays = tradeHoldingDays(trade);
  return `
    ${compactDays(heldDays)}
    <span>${isClosedTrade(trade) ? "closed holding" : "open holding"}</span>
  `;
}

function potentialGainCell(trade) {
  const gain = tradePotentialGain(trade);
  return `<span class="${pnlClass(gain)}">${signedMoney(gain)}</span>`;
}

function potentialPctCell(trade) {
  const gainPct = tradePotentialGainPct(trade);
  return `<span class="${pnlClass(gainPct)}">${signedPercent(gainPct)}</span>`;
}

function potentialAnnualizedCell(trade) {
  const annualized = tradePotentialAnnualized(trade);
  return `<span class="${pnlClass(annualized)}">${signedPercent(annualized)}</span>`;
}

function numericOrNull(value) {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function tradeAiProbability(trade) {
  const fromTrade = numericOrNull(trade.aiProbability);
  if (fromTrade != null) return fromTrade;
  const fromAnalysis = numericOrNull(trade.aiAnalysis?.probability);
  if (fromAnalysis != null) return fromAnalysis;
  return numericOrNull(trade.sourceEvaluation?.aiProbability);
}

function tradeAnalysisThesis(trade) {
  return trade.probabilityThesis
    || trade.aiAnalysis?.thesis
    || trade.sourceEvaluation?.probabilityThesis
    || trade.sourceEvaluation?.aiAnalysis?.thesis
    || "";
}

function cloneAnalysisSnapshot(item = {}) {
  return {
    ...item,
    aiAnalysis: item.aiAnalysis ? { ...item.aiAnalysis } : item.aiAnalysis,
  };
}

function originalAnalysisSnapshot(item = {}) {
  const snapshot = cloneAnalysisSnapshot(item);
  const history = Array.isArray(item.updateHistory) ? item.updateHistory : [];
  for (const entry of history) {
    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    for (const change of changes) {
      if (!change?.field) continue;
      snapshot[change.field] = change.from;
      if (change.field === "rawProbability") {
        snapshot.aiAnalysis = { ...(snapshot.aiAnalysis || {}), rawProbability: change.from };
      }
      if (change.field === "aiProbability") {
        snapshot.aiAnalysis = { ...(snapshot.aiAnalysis || {}), probability: change.from };
      }
      if (change.field === "probabilityThesis") {
        snapshot.aiAnalysis = { ...(snapshot.aiAnalysis || {}), thesis: change.from };
      }
    }
  }
  return {
    ...snapshot,
    evaluatedAt: item.firstEvaluatedAt || history[history.length - 1]?.previousEvaluatedAt || snapshot.evaluatedAt || snapshot.date || "",
  };
}

function firstAnalysisDate(item = {}) {
  return item.firstEvaluatedAt || item.evaluatedAt || item.openedAt || item.date || "";
}

function reassessmentDate(item = {}, originalDate = "") {
  const candidates = [item.lastSeenAt, item.evaluatedAt, item.updatedAt].filter(Boolean);
  const originalTime = Date.parse(originalDate || "");
  for (const value of candidates) {
    const candidateTime = Date.parse(value || "");
    if (!Number.isFinite(candidateTime)) continue;
    if (!Number.isFinite(originalTime) || Math.abs(candidateTime - originalTime) > 1000) return value;
  }
  return "";
}

function analysisProbability(item = {}) {
  const direct = numericOrNull(item.aiProbability);
  if (direct != null) return direct;
  return numericOrNull(item.aiAnalysis?.probability);
}

function analysisRawProbability(item = {}) {
  const direct = numericOrNull(item.rawProbability);
  if (direct != null) return direct;
  return numericOrNull(item.aiAnalysis?.rawProbability);
}

function analysisThesis(item = {}) {
  return item.probabilityThesis || item.aiAnalysis?.thesis || "";
}

function analysisModel(item = {}) {
  return item.analysisModel
    || item.aiAnalysis?.model
    || item.sourceEvaluation?.analysisModel
    || item.sourceEvaluation?.aiAnalysis?.model
    || item.postMortem?.model
    || item.aiModel
    || "";
}

function analysisModelLabel(item = {}) {
  return analysisModel(item) || "not recorded";
}

function analysisProbabilityRationale(item = {}) {
  return item.aiAnalysis?.probabilityRationale
    || item.aiAnalysis?.researchSummary
    || item.probabilityThesis
    || item.aiAnalysis?.thesis
    || item.analysisSummary
    || "";
}

function analysisPointRationale(item = {}) {
  return item.aiAnalysis?.probabilityPointRationale || "";
}

function analysisFinalConclusion(item = {}) {
  return item.aiAnalysis?.finalHumanConclusion || "";
}

function analysisProbabilityBridge(item = {}) {
  return item.aiAnalysis?.probabilityBridge || "";
}

function formatAnalysisKeyFact(fact) {
  if (!fact || typeof fact !== "object") return normalizedDetailText(fact);
  const source = normalizedDetailText(fact.source || fact.authority || fact.publisher || "");
  const date = normalizedDetailText(fact.date || fact.asOf || "");
  const text = normalizedDetailText(fact.fact || fact.summary || fact.text || "");
  const impact = normalizedDetailText(fact.impact || fact.effect || "");
  const effect = Number(fact.probabilityEffectPts);
  const effectText = Number.isFinite(effect) ? `${effect >= 0 ? "+" : ""}${effect.toFixed(1)} pp` : "";
  return [
    source || "public source",
    date ? `(${date})` : "",
    text ? `- ${text}` : "",
    impact ? `Impact: ${impact}.` : "",
    effectText ? `Calibration: ${effectText}.` : "",
  ].filter(Boolean).join(" ");
}

function analysisKeyFacts(item = {}) {
  const facts = Array.isArray(item.aiAnalysis?.keyFacts) ? item.aiAnalysis.keyFacts : [];
  return facts.map(formatAnalysisKeyFact).filter(Boolean).slice(0, 5).join(" ");
}

function analysisMarketComparison(item = {}) {
  if (item.aiAnalysis?.marketComparisonSummary) return item.aiAnalysis.marketComparisonSummary;
  const ai = Number(analysisProbability(item));
  const market = Number(item.marketPrice ?? item.entryPrice ?? item.aiAnalysis?.marketImpliedProbability);
  if (!Number.isFinite(ai) || !Number.isFinite(market)) return "";
  const difference = ai - market;
  const direction = difference >= 0 ? "above" : "below";
  const rationale = normalizedDetailText(analysisProbabilityRationale(item));
  return [
    `AI probability ${probability(ai)} is ${Math.abs(difference * 100).toFixed(1)} pts ${direction} Polymarket entry ${probability(market)}.`,
    rationale ? `Reason: ${rationale}` : "",
  ].filter(Boolean).join(" ");
}

function normalizedDetailText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function sameDetailValue(a, b, type = "text") {
  if (type === "number") {
    const left = Number(a);
    const right = Number(b);
    if (!Number.isFinite(left) && !Number.isFinite(right)) return true;
    if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
    return Math.abs(left - right) < 0.000001;
  }
  return normalizedDetailText(a) === normalizedDetailText(b);
}

function detailNumber(label, current, original, formatter) {
  const currentValue = Number(current);
  if (!Number.isFinite(currentValue)) return `${label}: -`;
  const changed = !sameDetailValue(currentValue, original, "number");
  const suffix = changed ? "" : " (unchanged)";
  return `${label}: ${formatter(currentValue)}${suffix}`;
}

function detailText(label, current, original) {
  const text = normalizedDetailText(current);
  if (!text) return `${label}: -`;
  if (sameDetailValue(current, original, "text")) return `${label}: same as original`;
  return `${label}: ${text}`;
}

function selectionClassificationLabel(value) {
  const type = String(value || "").trim().toUpperCase();
  if (!type) return "";
  if (type === "HIGH_CONFIDENCE") return "High-confidence candidate";
  if (type === "EDGE_OPPORTUNITY") return "Edge-opportunity candidate";
  if (type === "EDGE_OPPORTUNITY_BELOW_LIVE_THRESHOLD") return "Edge opportunity below live threshold";
  if (type === "REJECTED") return "Not selected by trading rules";
  if (type === "RESOLVED") return "Resolved / no longer selectable";
  if (type === "UNKNOWN") return "Unknown";
  return type.toLowerCase().replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function selectionClassificationNote(item = {}) {
  const type = String(item.thesisType || "").trim().toUpperCase();
  if (type === "REJECTED") {
    return "This does not mean the AI thinks the event is unlikely; it means the opportunity did not pass trading rules such as threshold, EV, spread, liquidity, depth, resolution date, capital, or diversification.";
  }
  if (type === "EDGE_OPPORTUNITY_BELOW_LIVE_THRESHOLD") {
    return "The AI may see an edge, but live trading still requires the configured AI probability threshold before execution.";
  }
  return "";
}

function detailModel(label, current, original) {
  const text = normalizedDetailText(current) || "not recorded";
  if (sameDetailValue(text, original || "not recorded", "text")) return `${label}: ${text} (unchanged)`;
  return `${label}: ${text}`;
}

function detailEvidence(label, current, original) {
  const currentText = Array.isArray(current) ? current.join(" ") : current;
  const originalText = Array.isArray(original) ? original.join(" ") : original;
  return detailText(label, currentText, originalText);
}

function currentAnalysisSnapshot(item = {}) {
  return cloneAnalysisSnapshot(item);
}

function structuredAnalysisDetails(item = {}, options = {}) {
  const source = item.sourceEvaluation || {};
  const originalBase = Object.keys(source).length ? source : item;
  const original = originalAnalysisSnapshot(originalBase);
  const current = currentAnalysisSnapshot({ ...original, ...source, ...item });
  const originalAi = original.aiAnalysis || {};
  const currentAi = current.aiAnalysis || {};
  const originalSelectionClassification = selectionClassificationLabel(original.thesisType);
  const currentSelectionClassification = selectionClassificationLabel(current.thesisType);
  const originalSelectionNote = selectionClassificationNote(original);
  const currentSelectionNote = selectionClassificationNote(current);
  const risk = Array.isArray(current.riskGroupLabels) && current.riskGroupLabels.length
    ? current.riskGroupLabels.join(", ")
    : "-";
  const reasons = Array.isArray(current.rejectReasons) && current.rejectReasons.length
    ? current.rejectReasons.join("; ")
    : (options.filterNote || "No portfolio filter note recorded.");
  const errorReason = evaluationErrorReason(current);
  const originalDate = firstAnalysisDate(original);
  const currentDate = reassessmentDate(current, originalDate);
  const originalLines = [
    options.title || `${current.outcome || "-"} - ${current.question || "-"}`,
    `Original analysis time: ${originalDate ? formatDate(originalDate) : "-"}`,
    `AI probability: ${probability(analysisProbability(original))}`,
    `Raw probability: ${probability(analysisRawProbability(original))}`,
    original.marketPrice != null || original.entryPrice != null ? `Market entry: ${probability(Number(original.marketPrice ?? original.entryPrice))}` : "",
    original.edge != null ? `Edge: ${signedPercent(Number(original.edge))}` : "",
    original.expectedValueUsdc != null ? `Expected value: ${signedMoney(Number(original.expectedValueUsdc), 4)}` : "",
    Number.isFinite(potentialAnnualizedReturn(original)) ? `Potential p.a.: ${signedPercent(potentialAnnualizedReturn(original))}` : "",
    Number.isFinite(annualizedExpectedReturn(original)) ? `AI EV p.a.: ${signedPercent(annualizedExpectedReturn(original))}` : "",
    original.netGainIfWinUsdc != null ? `Win if correct: ${signedMoney(Number(original.netGainIfWinUsdc), 4)}` : "",
    original.riskReward != null ? `R/R: ${riskReward(Number(original.riskReward))}` : "",
    original.liquidity != null ? `Liquidity: ${money(Number(original.liquidity || 0))}` : "",
    original.volume24hr != null ? `24h volume: ${money(Number(original.volume24hr || 0))}` : "",
    original.endDate ? `End date: ${formatDate(original.endDate)}` : "",
    original.daysToResolution != null ? `Days to resolution: ${Number.isFinite(Number(original.daysToResolution)) ? Number(original.daysToResolution).toFixed(2) : "-"}` : "",
    originalSelectionClassification ? `Selection classification: ${originalSelectionClassification}` : "",
    originalSelectionNote ? `Selection note: ${originalSelectionNote}` : "",
    `AI model: ${analysisModelLabel(original)}`,
    originalAi.probabilityMethod ? `Probability method: ${originalAi.probabilityMethod}` : "",
    originalAi.sourceQuality ? `Source quality: ${originalAi.sourceQuality}` : "",
    analysisFinalConclusion(original) ? `Final conclusion: ${analysisFinalConclusion(original)}` : "",
    analysisMarketComparison(original) ? `AI vs Polymarket: ${analysisMarketComparison(original)}` : "",
    analysisProbabilityRationale(original) ? `Why this probability: ${analysisProbabilityRationale(original)}` : "",
    analysisPointRationale(original) ? `Why these percentage points: ${analysisPointRationale(original)}` : "",
    analysisProbabilityBridge(original) ? `Probability bridge: ${analysisProbabilityBridge(original)}` : "",
    analysisKeyFacts(original) ? `Key facts: ${analysisKeyFacts(original)}` : "",
    `Thesis: ${analysisThesis(original) || "-"}`,
    originalAi.researchSummary ? `Research summary: ${originalAi.researchSummary}` : "",
    original.analysisSummary ? `AI analysis: ${original.analysisSummary}` : "",
    Array.isArray(originalAi.evidence) && originalAi.evidence.length ? `Evidence: ${originalAi.evidence.join(" ")}` : "",
    Array.isArray(originalAi.counterEvidence) && originalAi.counterEvidence.length ? `Counter: ${originalAi.counterEvidence.join(" ")}` : "",
    Array.isArray(originalAi.groundingQueries) && originalAi.groundingQueries.length ? `Search queries: ${originalAi.groundingQueries.join("; ")}` : "",
    Array.isArray(originalAi.groundingSources) && originalAi.groundingSources.length ? `Sources: ${originalAi.groundingSources.map((source) => source.title || source.uri).join("; ")}` : "",
  ].filter(Boolean);
  const currentLines = [
    `Current reassessment time: ${currentDate ? formatDate(currentDate) : "No later reassessment recorded"}`,
    detailNumber("AI probability", analysisProbability(current), analysisProbability(original), probability),
    detailNumber("Raw probability", analysisRawProbability(current), analysisRawProbability(original), probability),
    current.marketPrice != null || current.entryPrice != null ? detailNumber("Market entry", Number(current.marketPrice ?? current.entryPrice), Number(original.marketPrice ?? original.entryPrice), probability) : "",
    current.currentPrice != null ? `Current mark: ${probability(Number(current.currentPrice))}` : "",
    current.unrealizedPnlUsdc != null ? `Current P/L: ${signedMoney(Number(current.unrealizedPnlUsdc))} / ${signedPercent(Number(current.unrealizedPnlPct))}` : "",
    current.edge != null ? detailNumber("Edge", Number(current.edge), Number(original.edge), signedPercent) : "",
    current.expectedValueUsdc != null ? detailNumber("Expected value", Number(current.expectedValueUsdc), Number(original.expectedValueUsdc), (value) => signedMoney(value, 4)) : "",
    Number.isFinite(potentialAnnualizedReturn(current)) ? detailNumber("Potential p.a.", potentialAnnualizedReturn(current), potentialAnnualizedReturn(original), signedPercent) : "",
    Number.isFinite(annualizedExpectedReturn(current)) ? detailNumber("AI EV p.a.", annualizedExpectedReturn(current), annualizedExpectedReturn(original), signedPercent) : "",
    current.netGainIfWinUsdc != null ? detailNumber("Win if correct", Number(current.netGainIfWinUsdc), Number(original.netGainIfWinUsdc), (value) => signedMoney(value, 4)) : "",
    current.riskReward != null ? detailNumber("R/R", Number(current.riskReward), Number(original.riskReward), riskReward) : "",
    rowVolumeUsdc(current) > 0 ? detailNumber("Volume", rowVolumeUsdc(current), rowVolumeUsdc(original), money) : "",
    current.volume24hr != null ? detailNumber("24h volume", Number(current.volume24hr || 0), Number(original.volume24hr || 0), money) : "",
    current.endDate ? detailText("End date", formatDate(current.endDate), original.endDate ? formatDate(original.endDate) : "") : "",
    current.daysToResolution != null ? detailNumber("Days to resolution", Number(current.daysToResolution), Number(original.daysToResolution), (value) => value.toFixed(2)) : "",
    currentSelectionClassification ? detailText("Selection classification", currentSelectionClassification, originalSelectionClassification) : "",
    currentSelectionNote ? detailText("Selection note", currentSelectionNote, originalSelectionNote) : "",
    detailModel("AI model", analysisModelLabel(current), analysisModelLabel(original)),
    currentAi.probabilityMethod ? detailText("Probability method", currentAi.probabilityMethod, originalAi.probabilityMethod) : "",
    currentAi.sourceQuality ? detailText("Source quality", currentAi.sourceQuality, originalAi.sourceQuality) : "",
    analysisFinalConclusion(current) ? detailText("Final conclusion", analysisFinalConclusion(current), analysisFinalConclusion(original)) : "",
    analysisMarketComparison(current) ? detailText("AI vs Polymarket", analysisMarketComparison(current), analysisMarketComparison(original)) : "",
    analysisProbabilityRationale(current) ? detailText("Why this probability", analysisProbabilityRationale(current), analysisProbabilityRationale(original)) : "",
    analysisPointRationale(current) ? detailText("Why these percentage points", analysisPointRationale(current), analysisPointRationale(original)) : "",
    analysisProbabilityBridge(current) ? detailText("Probability bridge", analysisProbabilityBridge(current), analysisProbabilityBridge(original)) : "",
    analysisKeyFacts(current) ? detailText("Key facts", analysisKeyFacts(current), analysisKeyFacts(original)) : "",
    detailText("Current thesis", analysisThesis(current), analysisThesis(original)),
    currentAi.researchSummary ? detailText("Research summary", currentAi.researchSummary, originalAi.researchSummary) : "",
    current.analysisSummary ? detailText("Current AI analysis", current.analysisSummary, original.analysisSummary) : "",
    detailEvidence("Evidence", currentAi.evidence, originalAi.evidence),
    detailEvidence("Counter", currentAi.counterEvidence, originalAi.counterEvidence),
    detailEvidence("Search queries", currentAi.groundingQueries, originalAi.groundingQueries),
    detailEvidence("Sources", Array.isArray(currentAi.groundingSources) ? currentAi.groundingSources.map((source) => source.title || source.uri) : [], Array.isArray(originalAi.groundingSources) ? originalAi.groundingSources.map((source) => source.title || source.uri) : []),
    `Risk groups: ${risk}`,
    `Portfolio filter notes: ${reasons}`,
    current.rotationReview?.note ? `Rotation review: ${current.rotationReview.note}` : "",
    current.rotationEntryReason ? `Opened after rotation: ${current.rotationEntryReason}` : "",
    current.postMortem?.model ? detailModel("Post-mortem AI model", current.postMortem.model, original.postMortem?.model || "") : "",
    current.postMortem?.thesisReview ? `Post-mortem: ${current.postMortem.thesisReview}` : "",
    `Polymarket: ${current.url || polymarketUrl(current)}`,
  ].filter(Boolean);
  return [
    ...(errorReason ? [
      "ERROR REASON",
      errorReason,
      current.errorType ? `Error type: ${current.errorType}` : "",
      "",
    ].filter(Boolean) : []),
    "Original AI probability decision",
    ...originalLines,
    "",
    "Current reassessment",
    ...currentLines,
  ].join("\n");
}

function tradeAnalysisDetails(trade) {
  return structuredAnalysisDetails(trade, {
    title: `${trade.outcome || "-"} - ${trade.question || "-"}`,
  });
}

function tradeAnalysisCell(trade) {
  const prob = tradeAiProbability(trade);
  const details = tradeAnalysisDetails(trade);
  return `
    <strong>${probability(prob)}</strong>
    <span class="analysis-popover">
      <button class="info-button" type="button" aria-label="Show original AI analysis">i</button>
      <span class="analysis-tooltip" role="tooltip">${escapeHtml(details)}</span>
    </span>
  `;
}

function postMortemLine(trade) {
  if (trade.rotationReview?.note) return trade.rotationReview.note;
  if (trade.rotationEntryReason) return trade.rotationEntryReason;
  const review = trade.postMortem;
  if (!review) return "";
  const error = Number(review.predictionError);
  const errorText = Number.isFinite(error) ? `error ${signedPercent(error)}` : "";
  return [review.conclusion, errorText].filter(Boolean).join(" ");
}

function tradeSortValue(trade, key) {
  if (key === "openedAt") return Date.parse(trade.openedAt || trade.date || "") || 0;
  if (key === "market") return `${trade.outcome || ""} ${trade.question || ""}`.toLowerCase();
  if (key === "entryPrice") return Number(trade.entryPrice);
  if (key === "currentPrice") return Number(trade.currentPrice);
  if (key === "aiProbability") return tradeAiProbability(trade);
  if (key === "resolution") return Date.parse(tradeEndDate(trade) || "") || 0;
  if (key === "potentialGain") return tradePotentialGain(trade);
  if (key === "potentialPct") return tradePotentialGainPct(trade);
  if (key === "riskReward") return tradeRiskReward(trade);
  if (key === "potentialAnnualized") return tradePotentialAnnualized(trade);
  if (key === "pnl") return tradePnlValue(trade);
  if (key === "pnlPct") return tradePnlPct(trade);
  if (key === "stake") return Number(trade.stakeUsdc || 0);
  if (key === "status") return String(trade.status || "");
  if (key === "resolvedAt") return Date.parse(trade.resolvedAt || trade.closedTime || trade.lastCheckedAt || "") || 0;
  return "";
}

function sortedTrades(trades, tableKey) {
  const sort = state.tradeSort[tableKey] || state.tradeSort.open;
  const direction = sort.direction === "asc" ? 1 : -1;
  return [...trades].sort((a, b) => {
    const aValue = tradeSortValue(a, sort.key);
    const bValue = tradeSortValue(b, sort.key);
    const aMissing = aValue == null || Number.isNaN(aValue);
    const bMissing = bValue == null || Number.isNaN(bValue);
    if (aMissing && bMissing) return 0;
    if (aMissing) return 1;
    if (bMissing) return -1;
    if (typeof aValue === "number" && typeof bValue === "number") return (aValue - bValue) * direction;
    return String(aValue).localeCompare(String(bValue)) * direction;
  });
}

function tradeSortArrow(tableKey, key) {
  const sort = state.tradeSort[tableKey] || state.tradeSort.open;
  if (sort.key !== key) return "";
  return sortDirectionIndicator(sort.direction);
}

const TRADE_HEADER_INFO = {
  market: "Market links directly to Polymarket. Row-specific risk notes and AI thesis are available from the AI probability info popup.",
  currentPrice: "Entry price is the primary value. The percentage in parentheses is the current mark/final price move relative to entry; hover it to see the exact current price.",
  aiProbability: "Original AI probability and thesis from the evaluation that selected this opportunity.",
  resolution: "Expected or observed resolution/end date for the market.",
  potentialGain: "Nominal profit if the selected outcome resolves in our favor; percent return is shown below it.",
  riskReward: "Reward divided by risk. Higher means more upside per dollar at risk.",
  potentialAnnualized: "Potential return annualized by days to resolution.",
  pnl: "Current or realized profit/loss for the row.",
  stake: "USDC committed to the position or order.",
  status: "Closed trade result/status.",
};

const EVALUATION_HEADER_INFO = {
  status: "Evaluated means the market was analyzed. Portfolio eligibility is derived from the active portfolio rules and selected threshold.",
  market: "Market links directly to Polymarket. Risk grouping is used internally for diversification.",
  endDate: "Final day used for resolution timing. If the question implies a later date, that corrected date is used.",
  daysLeft: "Days remaining until the final day/resolution date.",
  marketPrice: "Executable entry estimate, using the current order book rather than midpoint.",
  gainIfWin: "Profit at the standard $5 evaluation stake, after the currently selected fee mode.",
  netYield: "Profit if correct divided by evaluation stake/cost, after expected trading fees.",
  potentialAnnualizedReturn: "Return if correct annualized by time to resolution, after fees. This is not probability-weighted expected value.",
  riskReward: "Reward divided by risk at the evaluated entry.",
  aiProbability: "AI-estimated probability for the selected outcome.",
  annualizedReturn: "Probability-weighted expected value annualized by days to resolution, after fees. With Polymarket probability equal to entry price, fees normally make this negative.",
  updates: "How many times this market/outcome was evaluated. Click row info for changes.",
  analysis: "AI thesis, evidence, counter-evidence, and portfolio filter notes.",
};

function headerInfoButton(info) {
  if (!info) return "";
  return `
    <span class="analysis-popover header-info">
      <button class="info-button" type="button" aria-label="Show column info">i</button>
      <span class="analysis-tooltip" role="tooltip">${escapeHtml(info)}</span>
    </span>
  `;
}

function tradeHeader(tableKey, key, label) {
  const sort = state.tradeSort[tableKey] || state.tradeSort.open;
  const active = sort.key === key ? " active" : "";
  return `<th><div class="th-content"><button class="sort-button${active}" type="button" data-trade-sort="${key}" data-trade-table="${tableKey}">${label}${tradeSortArrow(tableKey, key)}</button>${headerInfoButton(TRADE_HEADER_INFO[key])}</div></th>`;
}

function tradeTypeBadge(trade) {
  // "Waiting" is only true while the market can still fill it. Once the event is over the
  // bid is holding collateral for nothing, and the next execution pass withdraws it --
  // so say that, rather than showing it as an ordinary order still in play.
  if (trade.mode === "LIVE_ORDER") {
    return trade.marketEnded
      ? '<span class="order-chip warning">Market ended &middot; withdrawing</span>'
      : '<span class="order-chip">Limit order waiting</span>';
  }
  if (trade.mode === "LIVE_RECONCILIATION") return '<span class="order-chip warning">Sync gap</span>';
  // The paper twin of the live chip above: a resting simulated buy, not yet a
  // position. "Expired" is its own case rather than falling through to the closed-
  // trade chips below -- nothing was ever bought, so it is not a settled position.
  if (String(trade.status || "").toUpperCase() === "LIMIT_ORDER_WAITING") return '<span class="order-chip">Limit order waiting</span>';
  if (String(trade.status || "").toUpperCase() === "LIMIT_ORDER_EXPIRED") return '<span class="order-chip warning">Limit order expired &middot; unfilled</span>';
  if (String(trade.status || "").toUpperCase() === "REDEEM_REQUIRED") return '<span class="order-chip warning">Redeem needed</span>';
  if (String(trade.status || "").toUpperCase() === "PENDING_RESOLUTION") return '<span class="order-chip warning">Pending resolution</span>';
  if (String(trade.status || "").toUpperCase() === "STOP_LOSS") return '<span class="order-chip warning">Protective exit</span>';
  if (String(trade.status || "").toUpperCase() === "STOP_BREACH") return '<span class="order-chip warning">Stop breached · no floor exit</span>';
  if (String(trade.status || "").toUpperCase() === "STOP_GAP") return '<span class="order-chip warning">Stop gap · cap missed</span>';
  if (isClosedTrade(trade) && trade.mode === "LIVE") return '<span class="order-chip filled">Settled position</span>';
  if (trade.mode === "LIVE") return '<span class="order-chip filled">Open position</span>';
  if (trade.strategyLabel) return `<span class="order-chip paper">${escapeHtml(trade.strategyLabel)}</span>`;
  return "";
}

function tradePriceCell(trade, showStatus = false) {
  const currentLabel = showStatus ? "Final price" : "Current mark";
  const entry = Number(trade.entryPrice);
  const current = Number(trade.currentPrice);
  const change = Number.isFinite(entry) && entry > 0 && Number.isFinite(current)
    ? (current / entry) - 1
    : null;
  const comparison = Number.isFinite(current)
    ? `${currentLabel}: ${probability(current)}; entry: ${probability(entry)}`
    : "Current price is unavailable.";
  return `
    <span class="trade-price-summary" title="${escapeHtml(comparison)}">
      ${probability(entry)}
      ${Number.isFinite(change) ? `<span class="${pnlClass(change)}">(${signedPercent(change)})</span>` : ""}
    </span>
  `;
}

function tradeWinCell(trade) {
  return `
    ${potentialGainCell(trade)}
    <span>${potentialPctCell(trade)}</span>
  `;
}

function renderTradeRows(trades, emptyText, options = {}) {
  const tableKey = options.tableKey || "open";
  const showStatus = options.showStatus !== false;
  if (!trades.length) return `<div class="empty">${escapeHtml(emptyText)}</div>`;
  const rows = sortedTrades(trades, tableKey);
  const tableClass = showStatus ? "closed-trades-table" : "opened-trades-table";
  return `
    <div class="ledger-scroll" tabindex="0" aria-label="Scrollable trade table">
    <table class="ledger-wide-table ${tableClass}">
      <thead>
        <tr>
          ${tradeHeader(tableKey, "potentialGain", "Win")}
          ${showStatus ? tradeHeader(tableKey, "status", "Result") : ""}
          ${tradeHeader(tableKey, "pnl", "P/L")}
          ${tradeHeader(tableKey, "market", "Market")}
          ${tradeHeader(tableKey, "potentialAnnualized", "Win p.a.")}
          ${tradeHeader(tableKey, "resolution", "Resolution")}
          ${tradeHeader(tableKey, showStatus ? "resolvedAt" : "openedAt", showStatus ? "Closed" : "Opened")}
          ${tradeHeader(tableKey, "currentPrice", showStatus ? "Entry / final" : "Entry / mark")}
          ${tradeHeader(tableKey, "stake", "Stake")}
          ${tradeHeader(tableKey, "riskReward", "R/R")}
        </tr>
      </thead>
      <tbody>
        ${rows.map((trade) => `
          <tr>
            <td data-label="Win">${tradeWinCell(trade)}</td>
            ${showStatus ? `<td data-label="Result">
              ${escapeHtml(trade.status || "OPEN")}
            </td>` : ""}
            <td data-label="P/L" class="${pnlClass(tradePnlValue(trade))}">
              ${signedMoney(tradePnlValue(trade))}
            </td>
            <td class="trade-market-cell" data-label="Market">
              ${tradeTypeBadge(trade)}
              ${marketAnchor(trade)}
            </td>
            <td data-label="Win p.a.">${potentialAnnualizedCell(trade)}</td>
            <td data-label="Resolution">${resolutionCell(trade)}</td>
            <td data-label="${showStatus ? "Closed" : "Opened"}">${escapeHtml(formatDate(showStatus ? (trade.resolvedAt || trade.closedTime || trade.lastCheckedAt || "") : (trade.openedAt || trade.date || "")))}</td>
            <td data-label="${showStatus ? "Entry / final" : "Entry / mark"}">${tradePriceCell(trade, showStatus)}</td>
            <td data-label="Stake">${money(Number(trade.stakeUsdc || 0))}</td>
            <td data-label="R/R"><span class="${riskRewardClass(tradeRiskReward(trade))}">${riskReward(tradeRiskReward(trade))}</span></td>
          </tr>
        `).join("")}
      </tbody>
    </table>
    </div>
  `;
}

function closedTradesForCurrentPortfolio() {
  if (isLiveMode()) {
    return liveClosedTrades(state.liveState).map(decorateLiveTradeForTable);
  }
  const portfolioState = selectedPaperPortfolio(state.botState);
  return paperPortfolioTrades(portfolioState).filter(isClosedTrade);
}

function csvSafeCell(value) {
  if (value == null) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  const text = String(value).replace(/\r?\n|\r/g, " ").trim();
  const safeText = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safeText.replace(/"/g, '""')}"`;
}

function csvNumber(value, multiplier = 1, digits = 6) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  return Number((number * multiplier).toFixed(digits));
}

function closedTradeCsvRow(trade) {
  const result = closedTradePredictionResult(trade);
  const closedAt = trade.resolvedAt || trade.closedTime || trade.lastCheckedAt || "";
  const resolutionAt = tradeResolutionDate(trade) || tradeEndDate(trade) || "";
  return {
    portfolio: portfolioNavigationLabelForMode(state.mode),
    status: trade.status || "",
    prediction_result: result == null ? "" : (result ? "correct" : "incorrect"),
    outcome: trade.outcome || "",
    market: trade.question || "",
    polymarket_url: polymarketUrl(trade),
    opened_at: formatDate(trade.openedAt || trade.date || ""),
    opened_at_iso: trade.openedAt || trade.date || "",
    closed_at: formatDate(closedAt),
    closed_at_iso: closedAt,
    resolution_at: formatDate(resolutionAt),
    resolution_at_iso: resolutionAt,
    entry_price_pct: csvNumber(trade.entryPrice, 100, 4),
    final_or_mark_price_pct: csvNumber(trade.currentPrice, 100, 4),
    price_change_pct: (() => {
      const entry = Number(trade.entryPrice);
      const current = Number(trade.currentPrice);
      return Number.isFinite(entry) && entry > 0 && Number.isFinite(current)
        ? csvNumber((current / entry) - 1, 100, 4)
        : "";
    })(),
    stake_usdc: csvNumber(trade.stakeUsdc || 0, 1, 6),
    total_cost_usdc: csvNumber(tradeCostBasis(trade), 1, 6),
    shares: csvNumber(trade.shares ?? trade.size, 1, 6),
    win_if_correct_usdc: csvNumber(tradePotentialGain(trade), 1, 6),
    win_if_correct_pct: csvNumber(tradePotentialGainPct(trade), 100, 4),
    win_pa_pct: csvNumber(tradePotentialAnnualized(trade), 100, 4),
    realized_pl_usdc: csvNumber(tradePnlValue(trade), 1, 6),
    realized_pl_pct: csvNumber(tradePnlPct(trade), 100, 4),
    risk_reward: csvNumber(tradeRiskReward(trade), 1, 6),
    final_probability_pct: csvNumber(trade.finalOutcomePrice, 100, 4),
    token_id: trade.tokenId || trade.clobTokenId || trade.assetId || "",
    order_id: trade.orderId || trade.id || "",
    event_slug: trade.eventSlug || trade.slug || "",
    strategy_id: trade.strategyId || "",
    strategy_label: trade.strategyLabel || "",
    mode: trade.mode || "",
    notes: postMortemLine(trade),
  };
}

function downloadCsv(filename, rows) {
  const blob = new Blob([`\uFEFF${rows.join("\n")}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function exportClosedTradesCsv() {
  const tableKey = isLiveMode() ? "liveClosed" : "closed";
  const trades = sortedTrades(closedTradesForCurrentPortfolio(), tableKey);
  if (!trades.length) {
    if (els.closedSummary) els.closedSummary.textContent = "0 closed / nothing to export";
    return;
  }
  const rows = trades.map(closedTradeCsvRow);
  const headers = Object.keys(rows[0]);
  const csvRows = [
    headers.map(csvSafeCell).join(","),
    ...rows.map((row) => headers.map((header) => csvSafeCell(row[header])).join(",")),
  ];
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const portfolioSlug = portfolioNavigationLabelForMode(state.mode)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "portfolio";
  downloadCsv(`trading-${portfolioSlug}-closed-trades-${stamp}.csv`, csvRows);
}

function portfolioPeriodDays(botState, trades) {
  const timestamps = trades
    .map((trade) => Date.parse(trade.openedAt || trade.date || ""))
    .filter(Number.isFinite);
  if (!timestamps.length) return null;
  const start = Math.min(...timestamps);
  const end = Date.parse(botState.generatedAt || "") || Date.now();
  return Math.max(1, (end - start) / 86400000);
}

function annualizedPortfolioReturn(portfolio, days) {
  const totalPct = Number(portfolio.totalPnlPct);
  if (!Number.isFinite(totalPct) || !Number.isFinite(days) || days <= 0) return null;
  return totalPct * (365 / days);
}

function chartTimestamp(value) {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) ? timestamp : null;
}

function equityChartBucket(timestamp, scale) {
  const date = new Date(timestamp);
  if (scale === "month") return new Date(date.getFullYear(), date.getMonth(), 1).getTime();
  if (scale === "week") {
    const weekStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const day = (weekStart.getDay() + 6) % 7;
    weekStart.setDate(weekStart.getDate() - day);
    return weekStart.getTime();
  }
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function equityChartScale(start, end) {
  const days = Math.max(0, (end - start) / 86400000);
  if (days > 350) return "month";
  if (days > 90) return "week";
  return "day";
}

function equityChartDate(timestamp, scale) {
  const date = new Date(timestamp);
  if (scale === "month") {
    return new Intl.DateTimeFormat("cs-CZ", {
      timeZone: "Europe/Prague",
      month: "2-digit",
      year: "numeric",
    }).format(date);
  }
  return new Intl.DateTimeFormat("cs-CZ", {
    timeZone: "Europe/Prague",
    day: "2-digit",
    month: "2-digit",
  }).format(date);
}

// The state has transaction-level P/L rather than periodic account snapshots. Rebuild a
// compact realized-equity path from settled trades without publishing a second,
// ever-growing history file.
function portfolioEquityHistory(trades, equity, openPnl, generatedAt = "") {
  const timelineTrades = Array.isArray(trades) ? trades : [];
  const openedAt = timelineTrades
    .map((trade) => chartTimestamp(trade.openedAt || trade.date))
    .filter((timestamp) => timestamp != null);
  if (!openedAt.length || !Number.isFinite(equity)) return null;

  const firstOpenedAt = Math.min(...openedAt);
  // A state file can be a few minutes old while the dashboard is open. The final point
  // is always "today", not the timestamp of that older snapshot.
  const now = Math.max(chartTimestamp(generatedAt) || 0, Date.now());
  const durationDays = Math.max(0, (now - firstOpenedAt) / 86400000);
  if (durationDays < 3) return null;
  const scale = equityChartScale(firstOpenedAt, now);
  const settledEvents = timelineTrades
    .filter(isClosedTrade)
    .map((trade) => ({
      timestamp: chartTimestamp(trade.resolvedAt || trade.closedTime || trade.lastCheckedAt),
      pnl: Number(trade.realizedPnlUsdc ?? trade.pnlUsdc),
    }))
    .filter((event) => event.timestamp != null && event.timestamp <= now && Number.isFinite(event.pnl));
  const settledPnl = settledEvents.reduce((sum, event) => sum + event.pnl, 0);
  const currentOpenPnl = Number.isFinite(openPnl) ? openPnl : 0;
  // The chart deliberately excludes unrealized P/L. Its final point is therefore the
  // current equity minus open-position P/L, not a mark that could vanish next minute.
  const realizedEquity = equity - currentOpenPnl;
  const openingEquity = realizedEquity - settledPnl;
  const changesByBucket = new Map();
  settledEvents.forEach((event) => {
    const bucket = Math.max(firstOpenedAt, equityChartBucket(event.timestamp, scale));
    changesByBucket.set(bucket, (changesByBucket.get(bucket) || 0) + event.pnl);
  });

  let runningEquity = openingEquity;
  const points = [{ timestamp: firstOpenedAt, value: runningEquity }];
  [...changesByBucket.entries()]
    .sort(([left], [right]) => left - right)
    .forEach(([timestamp, change]) => {
      runningEquity += change;
      points.push({ timestamp, value: runningEquity });
    });
  // The final point is realized equity only. It still updates to today even when no
  // trade settled in the latest period.
  if (now > points[points.length - 1].timestamp || Math.abs(points[points.length - 1].value - realizedEquity) > 0.0001) {
    points.push({ timestamp: now, value: realizedEquity });
  }
  return { points, scale, openingEquity, durationDays };
}

function renderPortfolioEquityChart({ trades = [], equity, openPnl = 0, generatedAt = "" } = {}) {
  if (!els.portfolioEquityChart) return;
  const history = portfolioEquityHistory(trades, equity, openPnl, generatedAt);
  if (!history || history.points.length < 2) {
    els.portfolioEquityChart.hidden = true;
    els.portfolioEquityChart.innerHTML = "";
    els.portfolioMetricsLayout?.classList.remove("has-equity-chart");
    return;
  }

  els.portfolioEquityChart.hidden = false;
  els.portfolioMetricsLayout?.classList.add("has-equity-chart");

  const width = 520;
  const height = 196;
  const padding = { top: 18, right: 14, bottom: 32, left: 58 };
  const values = history.points.map((point) => point.value);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const spread = Math.max(0.01, rawMax - rawMin);
  const minValue = rawMin - (spread * 0.14);
  const maxValue = rawMax + (spread * 0.14);
  const start = history.points[0].timestamp;
  const end = history.points[history.points.length - 1].timestamp;
  const timeSpread = Math.max(1, end - start);
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const x = (timestamp) => padding.left + (Math.max(0, Math.min(1, (timestamp - start) / timeSpread)) * plotWidth);
  const y = (value) => padding.top + ((maxValue - value) / (maxValue - minValue)) * plotHeight;
  const line = history.points.map((point) => `${x(point.timestamp).toFixed(1)},${y(point.value).toFixed(1)}`).join(" ");
  const area = `${padding.left},${(padding.top + plotHeight).toFixed(1)} ${line} ${(padding.left + plotWidth).toFixed(1)},${(padding.top + plotHeight).toFixed(1)}`;
  const grid = [0, 0.5, 1].map((ratio) => {
    const value = maxValue - ((maxValue - minValue) * ratio);
    const position = y(value);
    return `<g><line x1="${padding.left}" y1="${position.toFixed(1)}" x2="${(padding.left + plotWidth).toFixed(1)}" y2="${position.toFixed(1)}"></line><text x="${padding.left - 8}" y="${(position + 4).toFixed(1)}" text-anchor="end">${escapeHtml(money(value))}</text></g>`;
  }).join("");
  const labelIndexes = [...new Set([0, Math.floor((history.points.length - 1) / 2), history.points.length - 1])];
  const labels = labelIndexes.map((index) => {
    const point = history.points[index];
    return `<text x="${x(point.timestamp).toFixed(1)}" y="${height - 9}" text-anchor="${index === 0 ? "start" : (index === history.points.length - 1 ? "end" : "middle")}">${escapeHtml(equityChartDate(point.timestamp, history.scale))}</text>`;
  }).join("");
  const last = history.points[history.points.length - 1];
  const direction = last.value >= history.openingEquity ? "positive" : "negative";
  const scaleLabel = history.scale === "day" ? "daily" : (history.scale === "week" ? "weekly" : "monthly");
  els.portfolioEquityChart.innerHTML = `
    <div class="portfolio-equity-chart-head">
      <span class="label">Equity history</span>
      <span>${escapeHtml(`${scaleLabel} - realized`)}</span>
    </div>
    <div class="equity-history-stage">
      <svg class="equity-history-svg ${direction}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Realized portfolio equity from the first trade to today" tabindex="0">
      <g class="equity-history-grid">${grid}</g>
      <polygon class="equity-history-area" points="${area}"></polygon>
      <polyline class="equity-history-line" points="${line}"></polyline>
      <circle class="equity-history-point" cx="${x(last.timestamp).toFixed(1)}" cy="${y(last.value).toFixed(1)}" r="4"></circle>
      <g class="equity-history-labels">${labels}</g>
      </svg>
      <div class="equity-history-tooltip" hidden></div>
    </div>
  `;

  const svg = els.portfolioEquityChart.querySelector(".equity-history-svg");
  const tooltip = els.portfolioEquityChart.querySelector(".equity-history-tooltip");
  const showTooltip = (clientX) => {
    if (!svg || !tooltip) return;
    const bounds = svg.getBoundingClientRect();
    const viewX = ((clientX - bounds.left) / Math.max(1, bounds.width)) * width;
    const nearest = history.points.reduce((best, point) => (
      Math.abs(x(point.timestamp) - viewX) < Math.abs(x(best.timestamp) - viewX) ? point : best
    ), history.points[0]);
    const left = Math.max(4, Math.min(96, (x(nearest.timestamp) / width) * 100));
    tooltip.textContent = `${formatDate(nearest.timestamp)} - ${money(nearest.value)}`;
    tooltip.style.left = `${left}%`;
    tooltip.hidden = false;
  };
  svg?.addEventListener("pointermove", (event) => showTooltip(event.clientX));
  svg?.addEventListener("pointerdown", (event) => showTooltip(event.clientX));
  svg?.addEventListener("pointerleave", () => { if (tooltip) tooltip.hidden = true; });
}

function compactToken(tokenId) {
  const token = String(tokenId || "");
  if (!token) return "";
  if (token.length <= 18) return token;
  return `${token.slice(0, 10)}...${token.slice(-6)}`;
}

function cleanErrorMessage(message) {
  return String(message || "")
    .replace(/^Orderbook fetch failed:\s*/i, "")
    .replace(/^Polymarket CLOB orderbook fetch failed:\s*/i, "")
    .trim();
}

function evaluationErrorReason(item = {}) {
  const status = String(item.status || "").toUpperCase();
  const type = String(item.errorType || "").toUpperCase();
  const aiPending = item.selectionStatus === "AI_PENDING" || item.aiAnalysis?.aiModelStatus === "QUOTA_LIMITED";
  if (status !== "ERROR" && !type && !item.errorReason && !aiPending) return "";
  if (aiPending) {
    return "Gemini grounded analysis is pending after a quota/rate-limit response. This row is not eligible until the AI memo is completed.";
  }

  const reasons = Array.isArray(item.rejectReasons)
    ? item.rejectReasons.map(cleanErrorMessage).filter(Boolean)
    : [];
  const rawMessage = cleanErrorMessage(item.errorReason || reasons[0] || item.analysisSummary || "");
  const joined = `${type} ${rawMessage} ${item.analysisSummary || ""}`;
  const token = compactToken(item.tokenId);

  if (/CLOB_ORDERBOOK_NOT_FOUND|HTTP 404|\/book\?token_id=|orderbook.*not found/i.test(joined)) {
    return [
      "CLOB orderbook unavailable (HTTP 404).",
      token ? `token_id ${token}` : "",
      "Price/liquidity economics could not be evaluated; the market token is likely closed, stale, migrated, or not exposed by CLOB.",
    ].filter(Boolean).join(" ");
  }

  if (/orderbook|clob|book\?/i.test(joined)) {
    return [
      "CLOB orderbook fetch failed.",
      token ? `token_id ${token}` : "",
      rawMessage || "No detailed exchange error was returned.",
    ].filter(Boolean).join(" ");
  }

  return rawMessage || "Unknown evaluation error.";
}

function errorReasonBadge(item) {
  const reason = evaluationErrorReason(item);
  if (!reason) return "";
  return `<strong class="error-reason-badge">ERROR: ${escapeHtml(reason)}</strong>`;
}

function evaluationStatusCell(item) {
  const label = evaluationStatusLabel(item);
  const reason = evaluationErrorReason(item);
  return `
    <span class="status-stack">
      <strong>${escapeHtml(label)}</strong>
      ${reason ? `<span class="status-error-reason">${escapeHtml(reason)}</span>` : ""}
    </span>
  `;
}

function analysisBadge(item) {
  const riskReason = item.selectionStatus === "RISK_BLOCKED"
    ? (item.riskBlockedReason || "risk-blocked by an open correlated paper trade")
    : "";
  const reasons = evaluationReasons(item, riskReason).join("; ") || "passes selected filters";
  const details = structuredAnalysisDetails(item, {
    title: `${item.outcome || "-"} - ${item.question || "-"}`,
    filterNote: [
      `Evaluation status: ${evaluationStatusLabel(item)}`,
      `Stored pipeline status: ${item.status || "-"}`,
      `Selected AI probability threshold: ${probability(currentEligibilityThreshold())}`,
      `Analysis URL: ${absoluteOpportunityDetailUrl(item)}`,
      reasons,
    ].join(" / "),
  });
  const detailUrl = opportunityDetailUrl(item);
  return `
    ${errorReasonBadge(item)}
    <span class="analysis-popover">
      <button class="info-button" type="button" aria-label="Show analysis details">i</button>
      <span class="analysis-tooltip" role="tooltip">${escapeHtml(details)}</span>
    </span>
    <a class="analysis-detail-link" href="${escapeHtml(detailUrl)}" data-opportunity-detail="${escapeHtml(opportunityKey(item))}">detail</a>
  `;
}

function evaluationStatusLabel(item) {
  const status = portfolioEvaluationStatus(item);
  if (status === "ERROR") return "ERROR";
  if (status === "RESOLVED") return "RESOLVED";
  return "EVALUATED";
}

function evaluationStatusClass(item) {
  const status = portfolioEvaluationStatus(item);
  if (status === "ERROR") return "negative";
  if (status === "RESOLVED") return "muted";
  if (status === "EVALUATED") return "positive";
  return "";
}

function evaluationFilterLabel(value) {
  if (value === "EVALUATED") return "evaluated";
  if (value === "RESOLVED") return "resolved";
  if (value === "ERROR") return "error";
  return "evaluated";
}

function normalizeEvaluationProbabilityFilter(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.min(Math.max(numeric, 0), 0.99);
}

function storedEvaluationProbabilityFilter() {
  try {
    return normalizeEvaluationProbabilityFilter(Number(localStorage.getItem(EVALUATION_PROBABILITY_FILTER_STORAGE_KEY)));
  } catch {
    return 0;
  }
}

function saveEvaluationProbabilityFilter(value) {
  try {
    localStorage.setItem(EVALUATION_PROBABILITY_FILTER_STORAGE_KEY, String(normalizeEvaluationProbabilityFilter(value)));
  } catch {
    // Display-only preference; ignore storage failures.
  }
}

function currentEvaluationProbabilityFilter() {
  return normalizeEvaluationProbabilityFilter(state.evaluationProbabilityFilter);
}

function syncEvaluationProbabilityFilterControl() {
  const value = currentEvaluationProbabilityFilter();
  state.evaluationProbabilityFilter = value;
  if (els.evaluationProbabilityFilter) {
    els.evaluationProbabilityFilter.value = String(Math.round(value * 100));
  }
}

function eligibilityThresholdStorageKey(mode = state.mode) {
  const normalizedMode = normalizeMode(mode);
  const parts = [ELIGIBILITY_THRESHOLD_STORAGE_KEY, normalizedMode];
  if (LIVE_MODES.has(normalizedMode)) {
    const address = state.liveState?.account?.address || state.liveState?.account?.proxyWallet || "";
    if (address) parts.push(String(address).toLowerCase());
  }
  return parts.join(":");
}

function accountScopedStorageKey(baseKey) {
  const parts = [baseKey, state.mode];
  if (isLiveMode()) {
    const address = state.liveState?.account?.address || state.liveState?.account?.proxyWallet || "";
    if (address) parts.push(String(address).toLowerCase());
  }
  return parts.join(":");
}

function riskAllocationStorageKey() {
  return accountScopedStorageKey(RISK_ALLOCATION_STORAGE_KEY);
}

function limitOrdersStorageKey() {
  return accountScopedStorageKey(LIMIT_ORDERS_STORAGE_KEY);
}

function storedEligibilityThreshold(mode = state.mode) {
  try {
    const scopedKey = eligibilityThresholdStorageKey(mode);
    const scopedValue = normalizeEligibilityThreshold(Number(localStorage.getItem(scopedKey)));
    if (scopedValue != null) return scopedValue;
    return null;
  } catch {
    return null;
  }
}

function saveEligibilityThreshold(value, mode = state.mode) {
  try {
    const key = eligibilityThresholdStorageKey(mode);
    localStorage.setItem(key, String(value));
    state.eligibilityThresholdKey = key;
  } catch {
    // Ignore localStorage failures; the control still works for this page load.
  }
}

function refreshEligibilityThreshold() {
  const key = eligibilityThresholdStorageKey();
  if (state.eligibilityThresholdKey === key && state.eligibilityThreshold != null) {
    syncEligibilityThresholdControl();
    return;
  }
  state.eligibilityThreshold = portfolioConfigForMode(state.mode).minProbability ?? storedEligibilityThreshold() ?? thresholdDefaultForMode(state.mode);
  state.eligibilityThresholdKey = key;
  syncEligibilityThresholdControl();
}

function normalizeRiskAllocation(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  if (numeric < MIN_RISK_ALLOCATION || numeric > MAX_RISK_ALLOCATION) return null;
  return Number(numeric.toFixed(2));
}

function riskAllocationInputValue(value) {
  const stake = Number(value);
  if (!Number.isFinite(stake)) return "";
  return stake.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}

function storedRiskAllocation() {
  try {
    const scopedKey = riskAllocationStorageKey();
    const scopedValue = normalizeRiskAllocation(Number(localStorage.getItem(scopedKey)));
    if (scopedValue != null) return scopedValue;
    const legacyFraction = Number(localStorage.getItem(LEGACY_RISK_ALLOCATION_STORAGE_KEY));
    if (Number.isFinite(legacyFraction) && legacyFraction > 0 && legacyFraction <= 0.5) {
      return normalizeRiskAllocation(legacyFraction * 100);
    }
    return null;
  } catch {
    return null;
  }
}

function saveRiskAllocation(value) {
  try {
    const key = riskAllocationStorageKey();
    localStorage.setItem(key, String(value));
    state.riskAllocationKey = key;
  } catch {
    // Ignore localStorage failures; the control still works for this page load.
  }
}

function currentRiskAllocation() {
  const configured = Number(state.riskAllocation);
  return normalizeRiskAllocation(configured) ?? DEFAULT_RISK_ALLOCATION;
}

function refreshRiskAllocation() {
  const key = riskAllocationStorageKey();
  if (state.riskAllocationKey === key && state.riskAllocation != null) {
    syncRiskAllocationControl();
    return;
  }
  const config = portfolioConfigForMode(state.mode);
  state.riskAllocation = config.stakeUsdc ?? storedRiskAllocation() ?? DEFAULT_RISK_ALLOCATION;
  state.riskAllocationKey = key;
  syncRiskAllocationControl();
}

function syncCapitalStatus({ availableCapital = null, baseCapital = null, stake = null, cadenceLabel = "next scheduled run" } = {}) {
  if (!els.capitalStatus) return;
  const available = Number(availableCapital);
  const orderStake = Number(stake);
  if (!Number.isFinite(available) || !Number.isFinite(orderStake) || orderStake <= 0) {
    els.capitalStatus.textContent = "Capital status is not available yet.";
    els.capitalStatus.className = "capital-status muted";
    return;
  }
  const appliedStake = Math.min(available, orderStake);
  const cappedByCash = available + 0.000001 < orderStake;
  const idleAfterNext = Math.max(0, available - appliedStake);
  const base = Number(baseCapital);
  const baseText = Number.isFinite(base) ? ` / base ${money(base)}` : "";
  if (cappedByCash) {
    els.capitalStatus.textContent = `K dispozici pro ${cadenceLabel}: ${money(available)}; nastaveny maximalni stake je ${money(orderStake)}${baseText}, ale dalsi order pouzije maximalne dostupnych ${money(appliedStake)} vcetne odhadovanych poplatku.`;
    els.capitalStatus.className = "capital-status warning";
    return;
  }
  els.capitalStatus.textContent = `K dispozici pro ${cadenceLabel}: ${money(available)}; dalsi obchodni davka ${money(appliedStake)}${baseText}; po dalsim obchodu zustane cca ${money(idleAfterNext)}.`;
  els.capitalStatus.className = idleAfterNext > appliedStake ? "capital-status warning" : "capital-status positive";
}

function normalizeEvaluationDaysFilter(value) {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.min(numeric, 3650) : null;
}

function storedEvaluationDaysFilter() {
  try {
    return normalizeEvaluationDaysFilter(localStorage.getItem(EVALUATION_DAYS_FILTER_STORAGE_KEY));
  } catch {
    return null;
  }
}

function saveEvaluationDaysFilter(value) {
  try {
    const normalized = normalizeEvaluationDaysFilter(value);
    if (normalized == null) localStorage.removeItem(EVALUATION_DAYS_FILTER_STORAGE_KEY);
    else localStorage.setItem(EVALUATION_DAYS_FILTER_STORAGE_KEY, String(normalized));
  } catch {
    // Display-only preference; ignore storage failures.
  }
}

function currentEvaluationDaysFilter() {
  return normalizeEvaluationDaysFilter(state.evaluationDaysFilter);
}

function syncEvaluationDaysFilterControl() {
  const value = currentEvaluationDaysFilter();
  state.evaluationDaysFilter = value;
  if (els.evaluationDaysFilter) els.evaluationDaysFilter.value = value == null ? "" : String(value);
}

function storedEvaluationNetYieldFilter() {
  try {
    return normalizeMinimumNetYield(Number(localStorage.getItem(EVALUATION_NET_YIELD_FILTER_STORAGE_KEY)));
  } catch {
    return 0;
  }
}

function saveEvaluationNetYieldFilter(value) {
  try {
    localStorage.setItem(EVALUATION_NET_YIELD_FILTER_STORAGE_KEY, String(normalizeMinimumNetYield(value)));
  } catch {
    // Display-only preference; ignore storage failures.
  }
}

function currentEvaluationNetYieldFilter() {
  return normalizeMinimumNetYield(state.evaluationNetYieldFilter);
}

function syncEvaluationNetYieldFilterControl() {
  const value = currentEvaluationNetYieldFilter();
  state.evaluationNetYieldFilter = value;
  if (els.evaluationNetYieldFilter) els.evaluationNetYieldFilter.value = (value * 100).toFixed(1);
}

function syncRiskAllocationControl(availableCapital = null, sourceLabel = "available capital", options = {}) {
  const value = currentRiskAllocation();
  const available = Number(availableCapital);
  const stake = value;
  if (els.riskAllocation) {
    els.riskAllocation.value = riskAllocationInputValue(value);
  }
  if (els.riskAllocationLabel) {
    els.riskAllocationLabel.textContent = money(value);
  }
  if (els.riskAllocationValue) {
    els.riskAllocationValue.textContent = Number.isFinite(stake) ? money(stake) : "-";
  }
  if (els.riskAllocationNote) {
    els.riskAllocationNote.textContent = "fixed per-trade cap, independent of equity";
  }
  syncCapitalStatus({
    availableCapital: Number.isFinite(available) ? available : null,
    baseCapital: null,
    stake,
    cadenceLabel: options.cadenceLabel || "next scheduled run",
  });
}

function defaultLimitOrdersForMode(mode = state.mode) {
  return LIVE_MODES.has(normalizeMode(mode));
}

function storedLimitOrders() {
  try {
    const key = limitOrdersStorageKey();
    const scoped = localStorage.getItem(key);
    if (scoped === "true") return true;
    if (scoped === "false") return false;
    const legacy = localStorage.getItem(LIMIT_ORDERS_STORAGE_KEY);
    if (legacy === "true") return true;
    if (legacy === "false") return false;
    return null;
  } catch {
    return null;
  }
}

function saveLimitOrders(value) {
  try {
    const key = limitOrdersStorageKey();
    localStorage.setItem(key, value ? "true" : "false");
    state.limitOrdersKey = key;
  } catch {
    // Ignore localStorage failures; the control still works for this page load.
  }
}

function currentLimitOrders(mode = state.mode) {
  const configured = portfolioConfigForMode(mode).useLimitOrders;
  return typeof configured === "boolean" ? configured : defaultLimitOrdersForMode(mode);
}

function refreshLimitOrders() {
  const key = limitOrdersStorageKey();
  // Saved portfolio configuration is the source of truth. Local storage remains a
  // harmless record for older browser sessions, but it must never override a saved
  // mode or make the summary disagree with the executor.
  state.limitOrders = currentLimitOrders(state.mode);
  state.limitOrdersKey = key;
  syncLimitOrdersControl();
}

function syncLimitOrdersControl() {
  if (els.limitOrders) {
    els.limitOrders.checked = currentLimitOrders();
  }
}

function parameterCapitalContextForMode(mode = state.mode) {
  if (LIVE_MODES.has(normalizeMode(mode))) {
    const portfolio = state.liveState?.portfolio || {};
    const openOrderRisk = Array.isArray(state.liveState?.openOrders)
      ? state.liveState.openOrders.reduce((sum, order) => sum + Number(order.notionalUsdc || 0), 0)
      : 0;
    const freeCash = Math.max(0, Number(portfolio.cashUsdc || 0) - openOrderRisk);
    const equity = Number.isFinite(Number(portfolio.equityUsdc))
      ? Number(portfolio.equityUsdc)
      : Number(portfolio.marketValueUsdc);
    const openPnl = Number(portfolio.openPnlUsdc);
    return {
      availableCapital: Number.isFinite(freeCash) ? freeCash : null,
      baseCapital: Number.isFinite(equity) ? Math.max(0, equity - (Number.isFinite(openPnl) ? openPnl : 0)) : null,
      sourceLabel: "live portfolio equity excl. unrealized P/L",
      cadenceLabel: "next live execution",
    };
  }
  const strategy = paperStrategyIdFromMode(mode);
  const portfolio = state.botState?.paperPortfolios?.[strategy]?.portfolio || state.botState?.portfolio || {};
  const freeCapital = Number(portfolio.freeCapitalUsdc ?? portfolio.initialUsdc ?? 100);
  const realizedPnl = Number(portfolio.realizedPnlUsdc || 0);
  return {
    availableCapital: Number.isFinite(freeCapital) ? freeCapital : null,
    baseCapital: Number(portfolio.initialUsdc ?? 100) + realizedPnl,
    sourceLabel: "paper portfolio equity",
    cadenceLabel: "next paper execution",
  };
}

function syncDraftRiskAllocationControl(value, context = {}) {
  const normalized = normalizeRiskAllocation(value) ?? DEFAULT_RISK_ALLOCATION;
  const available = Number(context.availableCapital);
  const stake = normalized;
  const editingRiskAllocation = parameterDraftActive() && document.activeElement === els.riskAllocation;
  if (els.riskAllocation && !editingRiskAllocation) els.riskAllocation.value = riskAllocationInputValue(normalized);
  if (els.riskAllocationLabel) els.riskAllocationLabel.textContent = money(normalized);
  if (els.riskAllocationValue) els.riskAllocationValue.textContent = Number.isFinite(stake) ? money(stake) : "-";
  if (els.riskAllocationNote) els.riskAllocationNote.textContent = "fixed per-trade cap, independent of equity";
  syncCapitalStatus({
    availableCapital: Number.isFinite(available) ? available : null,
    baseCapital: null,
    stake,
    cadenceLabel: context.cadenceLabel || "next scheduled run",
  });
}

function syncPortfolioParameterControls(configOverride = null, options = {}) {
  const mode = options.mode || state.mode;
  const config = configOverride || portfolioConfigForMode(mode);
  const maxDays = normalizeOptionalDays(config.maxResolutionDays) || DEFAULT_MAX_RESOLUTION_DAYS;
  const liquidity = normalizeOptionalMoney(config.minLiquidityUsdc);
  const minNetYield = normalizeMinimumNetYield(config.minNetYield);
  const order = normalizeSelectionOrder(config.selectionOrder);
  const isLive = LIVE_MODES.has(normalizeMode(mode));
  const threshold = normalizeEligibilityThreshold(config.minProbability) ?? thresholdDefaultForMode(mode);
  const allocation = normalizeRiskAllocation(config.stakeUsdc) ?? DEFAULT_RISK_ALLOCATION;
  const limitOrders = config.useLimitOrders ?? isLive;
  const capitalContext = options.capitalContext || parameterCapitalContextForMode(mode);
  if (els.portfolioName && document.activeElement !== els.portfolioName) {
    els.portfolioName.value = portfolioNameForMode(mode, config);
  }
  if (els.portfolioNameLabel) els.portfolioNameLabel.textContent = portfolioNameForMode(mode, config);
  const createType = normalizePortfolioAccountType(state.parameterDraftCreateType);
  if (els.portfolioAccountTypeRow) {
    els.portfolioAccountTypeRow.hidden = !state.parameterDraftCreate;
  }
  if (els.portfolioAccountType) {
    els.portfolioAccountType.value = createType;
  }
  if (els.portfolioAccountTypeLabel) {
    els.portfolioAccountTypeLabel.textContent = portfolioAccountTypeLabel(createType);
  }
  if (els.portfolioAccountTypeNote) {
    els.portfolioAccountTypeNote.textContent = portfolioAccountTypeNote(createType);
  }
  if (els.eligibilityThreshold) els.eligibilityThreshold.value = String(Math.round(threshold * 100));
  if (els.eligibilityThresholdLabel) els.eligibilityThresholdLabel.textContent = probability(threshold);
  syncDraftRiskAllocationControl(allocation, capitalContext);
  if (els.limitOrders) els.limitOrders.checked = Boolean(limitOrders);
  if (els.maxResolutionDays) els.maxResolutionDays.value = String(maxDays);
  if (els.maxResolutionDaysLabel) els.maxResolutionDaysLabel.textContent = `${maxDays} d`;
  if (els.selectionOrder) els.selectionOrder.value = order;
  if (els.selectionOrderLabel) els.selectionOrderLabel.textContent = selectionOrderLabel(order, config);
  if (els.minLiquidity) els.minLiquidity.value = liquidity == null ? "" : String(liquidity);
  if (els.minLiquidityLabel) els.minLiquidityLabel.textContent = liquidity == null ? "none" : money(liquidity);
  if (els.minNetYield) els.minNetYield.value = (minNetYield * 100).toFixed(1);
  if (els.minNetYieldLabel) els.minNetYieldLabel.textContent = percent(minNetYield);
  const trigger = normalizeExecutionTrigger(config.executionTrigger);
  const effectiveTrigger = trigger;
  if (els.executionTrigger) {
    els.executionTrigger.value = effectiveTrigger;
    els.executionTrigger.disabled = false;
    els.executionTrigger.title = "After-scan runs once after a completed market scan; it is not a continuous worker.";
  }
  if (els.executionTriggerLabel) {
    els.executionTriggerLabel.textContent = executionTriggerLabel(effectiveTrigger);
  }
  const autoRotatePositions = automaticRotationIsEnabled(config);
  if (els.autoRotatePositions) els.autoRotatePositions.checked = autoRotatePositions;
  if (els.autoRotatePositionsLabel) els.autoRotatePositionsLabel.textContent = autoRotatePositions ? "On" : "Off";
  const stopLossMultiplier = stopLossRiskMultiplier(config);
  if (els.stopLossRiskMultiplier) els.stopLossRiskMultiplier.value = String(Math.round(stopLossMultiplier * 100));
  if (els.stopLossRiskMultiplierLabel) els.stopLossRiskMultiplierLabel.textContent = stopLossRiskLabel(config);
  // Paper-only: live portfolios have no equivalent to this mechanism, keyed on the
  // portfolio being edited rather than the open tab, like the 5050 rows below.
  els.paperOnlyRows?.forEach((row) => row.toggleAttribute("hidden", LIVE_MODES.has(normalizeMode(mode))));
  if (els.parameterModalArchive) {
    // Only an existing paper portfolio can be archived. A live one holds real positions
    // and open orders, and hiding those would hide real exposure; one being created does
    // not exist yet.
    const archivable = !LIVE_MODES.has(normalizeMode(mode)) && !state.parameterDraftCreate;
    els.parameterModalArchive.hidden = !archivable;
    els.parameterModalArchive.dataset.portfolioId = archivable ? paperStrategyIdFromMode(mode) : "";
  }
  const cronMinutes = normalizeExecutionCronMinutes(config.executionCronMinutes);
  if (els.executionCronMinutes) els.executionCronMinutes.value = String(cronMinutes);
  if (els.executionCronMinutesLabel) els.executionCronMinutesLabel.textContent = executionCronMinutesLabel(cronMinutes);
  // The interval only means anything for the cron trigger; "after each scraping
  // batch" has its own cadence.
  els.executionCronRow?.toggleAttribute("hidden", effectiveTrigger !== "cron");
  const fixedEntryPrice = normalizeFixedEntryPrice(config.fixedEntryPrice);
  if (els.fixedEntryPrice) els.fixedEntryPrice.value = String(Math.round(fixedEntryPrice * 100));
  if (els.fixedEntryPriceLabel) els.fixedEntryPriceLabel.textContent = percent(fixedEntryPrice);
  const allowedTags = normalizeMarketTagList(config.allowedMarketTags);
  // Not overwritten while it has focus, or normalizing would fight the typing.
  if (els.fixedEntryTags && document.activeElement !== els.fixedEntryTags) {
    els.fixedEntryTags.value = allowedTags.join(", ");
  }
  if (els.fixedEntryTagsLabel) els.fixedEntryTagsLabel.textContent = allowedTags.length ? allowedTags.join(", ") : "every tag";
  // These steer only the fixed-entry strategy, so they are meaningless anywhere else.
  // Keyed on the mode this call is for, like every other line in this function. Reading
  // state.mode instead made the 5050 rows follow the open tab rather than the portfolio
  // being edited, so the order price could be hidden on the panel that owns it.
  els.fixedEntryRows?.forEach((row) => row.toggleAttribute("hidden", !isFixedEntryMode(mode)));
  // A nonempty allow-list is the active tag policy. The stored exclusions are preserved
  // but inactive until the allow-list is cleared.
  const includeOnlyTags = normalizeMarketTagList(config.includeOnlyMarketTags);
  if (els.includeOnlyTags && document.activeElement !== els.includeOnlyTags) {
    els.includeOnlyTags.value = includeOnlyTags.join(", ");
  }
  if (els.includeOnlyTagsLabel) els.includeOnlyTagsLabel.textContent = includeOnlyTags.length ? includeOnlyTags.join(", ") : "every tag";
  els.excludedTagsRow?.toggleAttribute("hidden", includeOnlyTags.length > 0);
  const excludedTags = normalizeMarketTagList(config.excludedMarketTags);
  if (els.excludedTags && document.activeElement !== els.excludedTags) {
    els.excludedTags.value = excludedTags.join(", ");
  }
  if (els.excludedTagsLabel) els.excludedTagsLabel.textContent = excludedTags.length ? excludedTags.join(", ") : "none";
  const marketType = normalizePortfolioMarketType(config.marketType, config.requireMostProbableOutcome);
  if (els.portfolioMarketType) els.portfolioMarketType.value = marketType;
  if (els.portfolioMarketTypeLabel) els.portfolioMarketTypeLabel.textContent = portfolioMarketTypeLabel(marketType);
  if (els.crossLiveRisk) {
    els.crossLiveRisk.checked = (options.systemConfig || systemConfig()).crossLivePortfolioRiskDiversification !== false;
  }
}

function rerenderCurrentDashboard() {
  if (isLiveMode() && state.liveState) {
    renderLiveState(state.liveState);
  } else if (state.botState) {
    renderBotState(state.botState);
  } else {
    syncEligibilityThresholdControl();
    syncRiskAllocationControl();
    syncLimitOrdersControl();
    syncPortfolioParameterControls();
  }
  renderBotEvaluations();
  renderPortfolioCandidates();
}

function openParameterModal(trigger) {
  if (!els.parameterModal) return;
  const mode = state.mode;
  state.parameterDraftMode = mode;
  state.parameterDraftCreate = "";
  state.parameterDraftCreateType = "";
  state.parameterDraftCreatePrefill = null;
  state.parameterDraft = { ...portfolioConfigForMode(mode) };
  state.parameterDraftSystem = { ...systemConfig() };
  state.parameterCapitalContext = parameterCapitalContextForMode(mode);
  syncPortfolioParameterControls(state.parameterDraft, {
    mode,
    systemConfig: state.parameterDraftSystem,
    capitalContext: state.parameterCapitalContext,
  });
  els.parameterModal.hidden = false;
  document.body.classList.add("modal-open");
  els.parameterModalClose?.focus();
  if (trigger) {
    openParameterModal.lastTrigger = trigger;
  }
}

// A statistics row states the rule it was measured under. These attributes carry that
// rule onto the create button so the portfolio that opens is already set to trade the
// row the user clicked, rather than a blank form they must copy the numbers into.
function portfolioPrefillAttributes(prefill = {}) {
  const attributes = [];
  for (const [key, value] of Object.entries(prefill)) {
    if (value == null || value === "") continue;
    attributes.push(`data-prefill-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}="${escapeHtml(String(value))}"`);
  }
  return attributes.join(" ");
}

function portfolioPrefillFromDataset(dataset = {}) {
  const read = (key) => dataset[`prefill${key[0].toUpperCase()}${key.slice(1)}`];
  const prefill = {};
  const name = read("name");
  if (name) prefill.displayName = normalizePortfolioName(name, "");
  const probability = Number(read("probability"));
  if (Number.isFinite(probability) && probability > 0 && probability < 1) prefill.minProbability = probability;
  const days = Number(read("days"));
  if (Number.isFinite(days) && days > 0) prefill.maxResolutionDays = Math.round(days);
  const marketType = read("marketType");
  if (["all", "binary", "multi"].includes(marketType)) {
    prefill.marketType = marketType;
    prefill.requireMostProbableOutcome = marketType === "multi";
  }
  const tag = read("tag");
  // A tag row measured one tag, so the portfolio that reproduces it trades that tag and
  // nothing else. Categories are not a tradable filter, so they only name the portfolio.
  if (tag) prefill.includeOnlyMarketTags = [tag];
  return prefill;
}

// A created portfolio needs an id that survives being a state key, a dashboard mode and
// a workflow input. The name the user types is only its label; this is derived from it
// so the stored key stays readable, and falls back to a counter when it cannot be.
function newPaperPortfolioId(name) {
  const existing = new Set(Object.keys((state.portfolioConfig || defaultPortfolioConfig()).paper || {}));
  const base = String(name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "")
    .replace(/^[^a-z]+/, "")
    .slice(0, 24)
    .toLowerCase();
  const seed = CUSTOM_PAPER_STRATEGY_ID.test(base) ? base : "portfolio";
  if (!existing.has(seed) && CUSTOM_PAPER_STRATEGY_ID.test(seed)) return seed;
  for (let suffix = 2; suffix < 200; suffix += 1) {
    const candidate = `${seed}${suffix}`;
    if (!existing.has(candidate)) return candidate;
  }
  return "";
}

function createPortfolioDraftForType(type, strategyId, prefill = {}, displayName = "") {
  const accountType = normalizePortfolioAccountType(type);
  const { displayName: ignoredDisplayName, ...rest } = prefill || {};
  const label = normalizePortfolioName(displayName || prefill?.displayName, accountType === "live" ? "Live" : "New portfolio");
  if (accountType === "live") {
    return {
      mode: "live",
      draft: {
        ...portfolioConfigForMode("live"),
        ...rest,
        displayName: label,
      },
      capitalContext: parameterCapitalContextForMode("live"),
    };
  }
  return {
    mode: `paper-${strategyId}`,
    draft: {
      ...customPaperPortfolioDefaults(strategyId),
      ...rest,
      displayName: label,
    },
    capitalContext: parameterCapitalContextForMode("paper-conservative"),
  };
}

function switchCreatePortfolioType(type) {
  if (!state.parameterDraftCreate) return;
  const accountType = normalizePortfolioAccountType(type);
  state.parameterDraftCreateType = accountType;
  const label = normalizePortfolioName(els.portfolioName?.value || state.parameterDraft?.displayName, accountType === "live" ? "Live" : "New portfolio");
  const next = createPortfolioDraftForType(
    accountType,
    state.parameterDraftCreate,
    state.parameterDraftCreatePrefill || {},
    label,
  );
  state.parameterDraftMode = next.mode;
  state.parameterDraft = next.draft;
  state.parameterCapitalContext = next.capitalContext;
  syncPortfolioParameterControls(next.draft, {
    mode: next.mode,
    systemConfig: state.parameterDraftSystem || systemConfig(),
    capitalContext: next.capitalContext,
  });
}

/**
 * Open the parameters form for a portfolio that does not exist yet. `prefill` carries
 * whatever the caller already knows -- a statistics row passes the rule it was measured
 * under -- so the created portfolio trades what that row describes.
 */
function openCreatePortfolioModal(prefill = {}, trigger = null) {
  if (!els.parameterModal) return;
  const label = normalizePortfolioName(prefill.displayName, "") || "New portfolio";
  const strategyId = newPaperPortfolioId(label);
  if (!strategyId) {
    setExecutionStatus("no room for another portfolio", "error");
    return;
  }
  state.parameterDraftCreateType = "paper";
  state.parameterDraftCreatePrefill = { ...prefill, displayName: label };
  const next = createPortfolioDraftForType("paper", strategyId, state.parameterDraftCreatePrefill, label);
  state.parameterDraftMode = next.mode;
  state.parameterDraftCreate = strategyId;
  state.parameterDraft = next.draft;
  state.parameterDraftSystem = { ...systemConfig() };
  state.parameterCapitalContext = next.capitalContext;
  syncPortfolioParameterControls(next.draft, {
    mode: state.parameterDraftMode,
    systemConfig: state.parameterDraftSystem,
    capitalContext: state.parameterCapitalContext,
  });
  els.parameterModal.hidden = false;
  document.body.classList.add("modal-open");
  els.portfolioName?.focus();
  els.portfolioName?.select();
  if (trigger) openParameterModal.lastTrigger = trigger;
}

// Every portfolio's headline numbers in one place, above the selector: with many
// portfolios, choosing which to open is a decision made from these and not from names.
// One portfolio's headline numbers from whichever loaded payload actually carries them.
//
// Reported: the table showed numbers for the shipped portfolios and "-" for the created
// ones, and some never filled in at all. It used to pick one source for the whole table --
// state.botState if present, state.portfolioOverview otherwise -- so a dashboard payload
// that was short of a portfolio (a stale cache served after a failed fetch, or a read that
// raced replication) left that row blank with a complete summary sitting unused beside it.
// Both payloads describe the same portfolios, so the choice belongs per row, not per table.
function overviewPortfolioNumbers(strategyId) {
  return state.botState?.paperPortfolios?.[strategyId]?.portfolio
    || state.portfolioOverview?.[strategyId]?.portfolio
    || null;
}

// Whether the loaded state covers every portfolio the table is going to list. When it does
// not, the cheap all-portfolio summary is worth fetching even on a paper tab, which is what
// stops a row staying blank until something else happens to refresh the page.
function overviewCoversEveryPortfolio() {
  return paperStrategyIds().every((id) => overviewPortfolioNumbers(id));
}

function renderPortfolioOverview() {
  if (!els.portfolioOverview) return;
  const live = state.liveState?.portfolio || null;
  // One row per portfolio, in the same order as the tabs. The live portfolios used to be
  // collapsed into a single combined account row on the grounds that they share one
  // Polymarket wallet -- but they are separate portfolios with separate rules and
  // separate decisions, and the combined row was not a portfolio at all: it could not be
  // opened as one, and it read as an account that does not exist. What they really share
  // is the account capital, so each keeps its own row under its own name and the sharing
  // is stated on the row instead of being hidden by merging them.
  const rows = dashboardModes().map((mode) => {
    if (LIVE_MODES.has(normalizeMode(mode))) {
      return {
        mode,
        name: portfolioNameForMode(mode),
        equity: live ? Number(live.equityUsdc) : null,
        risk: live ? Number(live.marketValueUsdc) : null,
        free: live ? Number(live.cashUsdc) : null,
        live: true,
      };
    }
    const portfolio = overviewPortfolioNumbers(paperStrategyIdFromMode(mode));
    return {
      mode,
      name: portfolioNameForMode(mode),
      equity: portfolio ? Number(portfolio.equityUsdc) : null,
      risk: portfolio ? Number(portfolio.openRiskUsdc) : null,
      free: portfolio ? Number(portfolio.freeCapitalUsdc) : null,
      live: false,
    };
  });
  // Only worth saying when there is in fact more than one live portfolio on the account.
  const sharedWallet = rows.filter((row) => row.live).length > 1;
  els.portfolioOverview.hidden = false;
  const cell = (value) => (Number.isFinite(value) ? money(value) : "-");
  els.portfolioOverview.innerHTML = `
    <table class="portfolio-summary">
      <thead>
        <tr><th>Portfolio</th><th>Equity</th><th>Risk / free</th></tr>
      </thead>
      <tbody>
        ${rows.map((row) => `
          <tr class="${row.mode === state.mode ? "portfolio-summary-current" : ""}${row.live ? " portfolio-summary-live" : ""}">
            <td data-label="Portfolio"><button class="portfolio-summary-link" type="button" data-mode-toggle="${escapeHtml(row.mode)}">${escapeHtml(row.name)}</button>${row.live && sharedWallet ? ' <span class="portfolio-summary-note" title="These live portfolios trade one Polymarket account, so they report the same account capital.">shared account</span>' : ""}</td>
            <td data-label="Equity">${cell(row.equity)}</td>
            <td data-label="Risk / free">${cell(row.risk)} / ${cell(row.free)}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

// The paper numbers above have to survive a live tab being open, where only the live
// state is loaded. This is the cheap dashboard summary, not the catalogue.
async function loadPortfolioOverview({ force = false } = {}) {
  if (state.portfolioOverviewPending) return;
  if (!force && state.portfolioOverviewAt && Date.now() - state.portfolioOverviewAt < 60000) return;
  state.portfolioOverviewPending = true;
  try {
    const payload = await fetchApiJson("api.php?action=state&target=paper&summary=portfolio-overview");
    const portfolios = (payload.state || payload)?.paperPortfolios;
    if (portfolios && typeof portfolios === "object") {
      state.portfolioOverview = portfolios;
      state.portfolioOverviewAt = Date.now();
      renderPortfolioOverview();
    }
  } catch {
    // A summary that fails to refresh keeps its last good numbers rather than blanking.
  } finally {
    state.portfolioOverviewPending = false;
  }
}

function renderArchivedPortfolios() {
  if (!els.archivedPortfolios) return;
  const config = state.portfolioConfig || defaultPortfolioConfig();
  const paper = config.paper || {};
  const archived = Object.entries(paper).filter(([, row]) => row?.archived === true);
  // 5050 shares the live wallet's positions and orders, not a paper portfolio's own
  // stored account, so it carries no equity/trades detail of its own here -- only
  // whether new bids are currently paused, which is the one thing archiving it changes.
  if (config.live5050?.archived === true) archived.push(["live-5050", config.live5050]);
  els.archivedPortfolios.hidden = archived.length === 0;
  if (!archived.length) {
    els.archivedPortfolios.innerHTML = "";
    return;
  }
  els.archivedPortfolios.innerHTML = `
    <div class="system-status-head">
      <div>
        <p class="eyebrow">Portfolios</p>
        <h3>Archived</h3>
      </div>
    </div>
    <p class="calculation-note">These portfolios are not shown on the dashboard and are not executed. Every trade, run log and statistic they hold is kept, and restoring one brings it back exactly as it was.</p>
    <ul class="archived-portfolio-list">
      ${archived.map(([id, row]) => {
        const stored = id === "live-5050" ? null : state.botState?.paperPortfolios?.[id];
        const detail = id === "live-5050"
          ? "new bids paused; existing orders and positions are still watched"
          : (stored?.portfolio
            ? `${money(Number(stored.portfolio.equityUsdc))} equity / ${formatInteger((stored.trades || []).length) || 0} trades`
            : "no stored account yet");
        return `
          <li>
            <span><strong>${escapeHtml(normalizePortfolioName(row?.displayName, id === "live-5050" ? "5050" : id))}</strong> <span class="muted">${escapeHtml(detail)}</span></span>
            <button class="execution-button" type="button" data-restore-portfolio="${escapeHtml(id)}">Restore</button>
          </li>
        `;
      }).join("")}
    </ul>
  `;
}

// Archiving is deliberately not a delete: the portfolio stops being executed and leaves
// the dashboard, and everything it traded stays exactly where it is. 5050 is the one
// live portfolio this applies to -- its config lives at a different key from a paper
// portfolio's, keyed by mode rather than by strategy id, so it is handled separately.
async function setPortfolioArchived(strategyId, archived) {
  const config = state.portfolioConfig || defaultPortfolioConfig();
  if (strategyId === "live-5050") {
    const saved = config.live5050;
    if (!saved) return;
    state.portfolioConfig = { ...config, live5050: { ...saved, archived } };
    if (archived && state.mode === "live-5050") {
      state.mode = "live";
      saveMode(state.mode);
    }
  } else {
    const saved = (config.paper || {})[strategyId];
    if (!saved) return;
    state.portfolioConfig = {
      ...config,
      paper: { ...(config.paper || {}), [strategyId]: { ...saved, archived } },
    };
    // Archiving the open tab would leave the dashboard on a portfolio that is no longer
    // listed, so move to the first one that still is.
    if (archived && paperStrategyIdFromMode(state.mode) === strategyId && !isLiveMode()) {
      const next = paperStrategyIds()[0];
      state.mode = next ? `paper-${next}` : "live";
      saveMode(state.mode);
    }
  }
  try {
    await savePortfolioConfigNow();
    setExecutionStatus(archived ? "portfolio archived" : "portfolio restored");
  } catch (error) {
    setExecutionStatus(error.message || "portfolio archive failed", "error");
  }
  syncModeUi();
  renderArchivedPortfolios();
  loadDashboardState();
}

function closeParameterModal() {
  if (!els.parameterModal || els.parameterModal.hidden) return;
  els.parameterModal.hidden = true;
  document.body.classList.remove("modal-open");
  state.parameterDraft = null;
  state.parameterDraftMode = "";
  state.parameterDraftCreate = "";
  state.parameterDraftCreateType = "";
  state.parameterDraftCreatePrefill = null;
  state.parameterDraftSystem = null;
  state.parameterCapitalContext = null;
  refreshEligibilityThreshold();
  refreshRiskAllocation();
  refreshLimitOrders();
  syncPortfolioParameterControls();
  if (openParameterModal.lastTrigger instanceof HTMLElement) {
    openParameterModal.lastTrigger.focus();
  }
  openParameterModal.lastTrigger = null;
}

async function confirmParameterModal() {
  if (!els.parameterModal || els.parameterModal.hidden) return;
  const draftMode = state.parameterDraftMode || state.mode;
  const draft = state.parameterDraft ? { ...state.parameterDraft } : { ...portfolioConfigForMode(draftMode) };
  const draftSystem = state.parameterDraftSystem ? { ...state.parameterDraftSystem } : systemConfig();
  if (els.parameterModalConfirm) {
    els.parameterModalConfirm.disabled = true;
    els.parameterModalConfirm.textContent = "Saving...";
  }
  const creating = state.parameterDraftCreate;
  const creatingType = normalizePortfolioAccountType(state.parameterDraftCreateType);
  try {
    if (creating) {
      // The portfolio comes into existence here, on Save -- not when the form was
      // opened. Closing the form without saving leaves the config exactly as it was.
      if (creatingType === "live") {
        updatePortfolioConfigForMode("live", { ...draft, archived: false });
      } else {
        const base = state.portfolioConfig || defaultPortfolioConfig();
        state.portfolioConfig = {
          ...base,
          paper: {
            ...(base.paper || {}),
            [creating]: { ...customPaperPortfolioDefaults(creating), ...draft, archived: false, custom: true },
          },
        };
      }
    } else {
      updatePortfolioConfigForMode(draftMode, draft);
    }
    updateSystemConfig(draftSystem);
    const threshold = normalizeEligibilityThreshold(draft.minProbability);
    const allocation = normalizeRiskAllocation(draft.stakeUsdc);
    if (threshold != null) {
      state.eligibilityThreshold = threshold;
      saveEligibilityThreshold(threshold, draftMode);
    }
    if (allocation != null) {
      state.riskAllocation = allocation;
      saveRiskAllocation(allocation);
    }
    if (typeof draft.useLimitOrders === "boolean") {
      state.limitOrders = draft.useLimitOrders;
      saveLimitOrders(draft.useLimitOrders);
    }
    await savePortfolioConfigNow();
    setExecutionStatus(creating ? (creatingType === "live" ? "live portfolio configured" : "portfolio created") : "portfolio parameters saved");
    const createdMode = creating ? (creatingType === "live" ? "live" : `paper-${creating}`) : "";
    closeParameterModal();
    if (createdMode) {
      // Open what was just created: a new portfolio that stays hidden behind the tab
      // you were already on reads as a save that did not work.
      state.mode = createdMode;
      saveMode(createdMode);
      syncModeUi();
      loadDashboardState();
      return;
    }
    rerenderCurrentDashboard();
  } catch (error) {
    setExecutionStatus(error.message || "portfolio parameter save failed", "error");
  } finally {
    if (els.parameterModalConfirm) {
      els.parameterModalConfirm.disabled = false;
      els.parameterModalConfirm.textContent = "Save and close";
    }
  }
}

function parameterDraftActive() {
  return Boolean(els.parameterModal && !els.parameterModal.hidden && state.parameterDraft);
}

function updateParameterDraft(updates = {}, systemUpdates = null) {
  if (!parameterDraftActive()) return false;
  state.parameterDraft = {
    ...state.parameterDraft,
    ...updates,
  };
  if (systemUpdates) {
    state.parameterDraftSystem = {
      ...(state.parameterDraftSystem || systemConfig()),
      ...systemUpdates,
    };
  }
  syncPortfolioParameterControls(state.parameterDraft, {
    mode: state.parameterDraftMode || state.mode,
    systemConfig: state.parameterDraftSystem || systemConfig(),
    capitalContext: state.parameterCapitalContext || parameterCapitalContextForMode(state.parameterDraftMode || state.mode),
  });
  return true;
}

function parameterDraftInputIsEmpty(input) {
  return parameterDraftActive() && input && input.value === "";
}

function analysisModal() {
  let modal = document.querySelector("[data-analysis-modal]");
  if (modal) return modal;
  modal = document.createElement("div");
  modal.className = "analysis-modal-backdrop";
  modal.dataset.analysisModal = "";
  modal.hidden = true;
  modal.innerHTML = `
    <section class="analysis-modal" role="dialog" aria-modal="true" aria-labelledby="analysis-modal-title">
      <div class="analysis-modal-head">
        <h2 id="analysis-modal-title">Analysis detail</h2>
        <button class="analysis-modal-close" type="button" data-analysis-modal-close aria-label="Close analysis detail">x</button>
      </div>
      <div class="analysis-modal-body" data-analysis-modal-body></div>
    </section>
  `;
  document.body.appendChild(modal);
  return modal;
}

function linkifyEscapedHtml(escaped) {
  return escaped.replace(/https?:\/\/[^\s<>"']+/g, (url) => {
    const cleanUrl = url.replace(/[),.;]+$/g, "");
    const suffix = url.slice(cleanUrl.length);
    return `<a href="${escapeHtml(cleanUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(cleanUrl)}</a>${escapeHtml(suffix)}`;
  });
}

function analysisStatusClass(value) {
  const status = String(value || "").toUpperCase();
  if (["ERROR", "REJECTED", "SKIP", "LOST", "RISK_BLOCKED"].includes(status)) return "negative";
  if (["ELIGIBLE", "EVALUATED", "OPENED", "SUBMITTED", "DRY_RUN_READY", "WON"].includes(status)) return "positive";
  if (["RESOLVED", "SOLD", "PENDING_RESOLUTION"].includes(status)) return "muted";
  return "";
}

function renderAnalysisInline(value) {
  let html = linkifyEscapedHtml(escapeHtml(value || "-"));
  html = html.replace(/\b(ERROR|REJECTED|SKIP|LOST|RISK_BLOCKED|ELIGIBLE|EVALUATED|OPENED|SUBMITTED|DRY_RUN_READY|WON|RESOLVED|SOLD|PENDING_RESOLUTION)\b/g, (status) => {
    const statusClass = analysisStatusClass(status);
    return `<span class="analysis-status ${statusClass}">${escapeHtml(status)}</span>`;
  });
  html = html.replace(/\b(same as original|unchanged)\b/gi, (text) => `<span class="analysis-unchanged">${escapeHtml(text)}</span>`);
  return html;
}

function renderAnalysisLine(line) {
  const text = String(line || "").trim();
  if (!text) return "";
  const bullet = text.match(/^[-*]\s+(.+)$/);
  if (bullet) return `<li>${renderAnalysisInline(bullet[1])}</li>`;
  const kv = parseAnalysisKv(text);
  if (kv) {
    return `
      <div class="analysis-kv">
        <strong>${escapeHtml(kv.label)}:</strong>
        <span>${renderAnalysisInline(kv.value || "-")}</span>
      </div>
    `;
  }
  return `<p>${renderAnalysisInline(text)}</p>`;
}

function parseAnalysisKv(line) {
  const match = String(line || "").trim().match(/^([^:\n]{2,72}):\s*(.*)$/);
  return match ? { label: match[1].trim(), value: match[2] || "-" } : null;
}

function normalizedAnalysisField(label) {
  const text = String(label || "").trim();
  if (/^(original analysis time|current reassessment time)$/i.test(text)) return "Analysis time";
  if (/^current thesis$/i.test(text)) return "Thesis";
  if (/^thesis type$/i.test(text)) return "Selection classification";
  if (/^current ai analysis$/i.test(text)) return "AI analysis";
  return text.replace(/^(Original|Current)\s+/i, "");
}

function analysisComparisonRows(originalSection, currentSection) {
  const order = [];
  const rows = new Map();
  const addLine = (line, side) => {
    const kv = parseAnalysisKv(line);
    if (!kv) {
      const text = String(line || "").trim();
      if (!text) return;
      const label = side === "original" ? "Market" : "Current note";
      if (!rows.has(label)) {
        rows.set(label, { label, original: "", current: "" });
        order.push(label);
      }
      rows.get(label)[side] = text;
      return;
    }
    const label = normalizedAnalysisField(kv.label);
    if (!rows.has(label)) {
      rows.set(label, { label, original: "", current: "" });
      order.push(label);
    }
    rows.get(label)[side] = kv.value || "-";
  };
  (originalSection?.lines || []).forEach((line) => addLine(line, "original"));
  (currentSection?.lines || []).forEach((line) => addLine(line, "current"));
  return order.map((label) => rows.get(label)).filter(Boolean);
}

function renderAnalysisComparison(originalSection, currentSection) {
  const rows = analysisComparisonRows(originalSection, currentSection);
  if (!rows.length) return "";
  return `
    <section class="analysis-detail-section comparison">
      <h3>Original vs Current</h3>
      <div class="analysis-comparison-wrap">
        <div class="analysis-comparison-grid" role="table" aria-label="Original and current analysis comparison">
          <div class="analysis-comparison-head" role="row">
            <strong role="columnheader">Field</strong>
            <strong role="columnheader">Original</strong>
            <strong role="columnheader">Current</strong>
          </div>
          ${rows.map((row) => `
            <div class="analysis-comparison-row" role="row">
              <strong role="rowheader">${escapeHtml(row.label)}</strong>
              <span role="cell">${renderAnalysisInline(row.original || "-")}</span>
              <span role="cell">${renderAnalysisInline(row.current || "-")}</span>
            </div>
          `).join("")}
        </div>
      </div>
    </section>
  `;
}

function executionCandidateRejectionReason(item = {}) {
  const reasons = [
    ...(Array.isArray(item.rejectReasons) ? item.rejectReasons : []),
    ...(Array.isArray(item.portfolioRejectReasons) ? item.portfolioRejectReasons : []),
    item.riskBlockedReason,
    item.sizingNote,
  ].map((reason) => String(reason || "").trim()).filter(Boolean);
  if (reasons.length) return reasons.join("; ");
  const status = String(item.status || "").trim();
  return status && status.toUpperCase() !== "ELIGIBLE"
    ? `status ${status}`
    : "No rejection reason was recorded.";
}

function executionCandidatesNotUsed(batch = {}) {
  const candidates = Array.isArray(batch.eligibleCandidates) && batch.eligibleCandidates.length
    ? batch.eligibleCandidates
    : (Array.isArray(batch.topCandidates) ? batch.topCandidates : []);
  const rejected = Array.isArray(batch.topRejected) ? batch.topRejected : [];
  const revalidated = Array.isArray(batch.revalidatedCandidates) && batch.revalidatedCandidates.length
    ? batch.revalidatedCandidates
    : [...candidates, ...rejected];
  const minimumLiquidity = Number(batch.settings?.minVolume24hr ?? batch.settings?.minLiquidityUsdc);
  return (rejected.length
    ? rejected
    : revalidated.filter((item) => String(item.status || "").toUpperCase() !== "ELIGIBLE"))
    .filter((item) => {
      const liquidity = Number(item?.liquidity);
      return !Number.isFinite(minimumLiquidity) || minimumLiquidity <= 0 || !Number.isFinite(liquidity) || liquidity >= minimumLiquidity;
    })
    .slice(0, 12);
}

function executionCandidatePotentialPa(item = {}, probabilitySource = "ai") {
  if (item.executionQuoteVerified === false || String(item.selectionStatus || "").toUpperCase() === "REVALIDATION_FAILED") {
    return NaN;
  }
  const suppliedPotential = item.potentialAnnualizedReturn == null ? NaN : Number(item.potentialAnnualizedReturn);
  if (Number.isFinite(suppliedPotential)) return suppliedPotential;
  if (normalizeProbabilitySource(probabilitySource) !== "polymarket") return Number(item.annualizedReturn);
  const netYield = item.netYield == null || item.netYield === "" ? NaN : Number(item.netYield);
  const days = Number(item.daysToResolution);
  return Number.isFinite(netYield) && Number.isFinite(days)
    ? annualizeReturn(netYield, days)
    : Number(item.annualizedReturn);
}

function renderExecutionCandidatesNotUsedTable(candidates = [], probabilitySource = "ai") {
  if (!candidates.length) return "";
  const usesPolymarketProbability = normalizeProbabilitySource(probabilitySource) === "polymarket";
  // Scoring is always the Polymarket probability now, so the column has one name. The
  // flag above still gates which columns appear, but it can no longer be false.
  const probabilityLabel = "Mkt prob.";
  return `
    <div class="analysis-candidate-table-wrap" tabindex="0" aria-label="Rejected execution candidates table">
      <table class="analysis-candidate-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Market</th>
            <th>${probabilityLabel}</th>
            <th>Volume</th>
            <th>Net yield</th>
            <th>Potential p.a.</th>
            <th>Why not</th>
          </tr>
        </thead>
        <tbody>
          ${candidates.map((item, index) => {
            const question = item.question || "-";
            const outcome = item.outcome || "-";
            const url = String(item.url || "").trim();
            const selectedProbability = Number(usesPolymarketProbability ? item.marketPrice : item.aiProbability);
            const liquidity = rowVolumeUsdc(item);
            // Number(null) is 0. An unavailable CLOB quote must not be shown as
            // an exact break-even, because it cannot be selected for an order.
            const netYield = item.netYield == null || item.netYield === "" ? NaN : Number(item.netYield);
            const potentialPa = executionCandidatePotentialPa(item, probabilitySource);
            return `
              <tr>
                <td data-label="#">${index + 1}</td>
                <td data-label="Market"><strong>${escapeHtml(outcome)}</strong><span>${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(question)}</a>` : escapeHtml(question)}</span></td>
                <td data-label="${probabilityLabel}">${Number.isFinite(selectedProbability) ? probability(selectedProbability) : "-"}</td>
                <td data-label="Volume">${Number.isFinite(liquidity) ? money(liquidity) : "-"}</td>
                <td data-label="Net yield" class="${pnlClass(netYield)}">${Number.isFinite(netYield) ? signedPercent(netYield) : "-"}</td>
                <td data-label="Potential p.a." class="${pnlClass(potentialPa)}">${Number.isFinite(potentialPa) ? signedPercent(potentialPa) : "-"}</td>
                <td data-label="Why not">${escapeHtml(executionCandidateRejectionReason(item))}</td>
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderAnalysisModalHtml(text, options = {}) {
  const lines = String(text || "No analysis detail available.").split(/\r?\n/);
  const sectionTitles = new Set([
    "ERROR REASON",
    "Original AI probability decision",
    "Current reassessment",
    "Run summary",
    "Order placed",
    "Candidates not used",
    "Open orders",
    "Position rotation",
    "Risk diversification",
    "Capital",
    "Portfolio run row",
    "Rules:",
    "Capital:",
    "Portfolio filter diagnostics:",
    "Filter reason counts:",
    "Excluded sample:",
    "Risk-blocked candidates:",
    "Open order review:",
    "Position rotation review:",
    "Revalidated candidates checked:",
    "Eligible candidates checked:",
    "Rejected candidates checked:",
    "Selected:",
  ]);
  const sections = [];
  let current = { title: "Analysis", lines: [] };
  const pushCurrent = () => {
    if (current.lines.some((line) => String(line || "").trim()) || current.title !== "Analysis") {
      sections.push(current);
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (sectionTitles.has(trimmed)) {
      pushCurrent();
      current = { title: trimmed.replace(/:$/, ""), lines: [] };
      continue;
    }
    current.lines.push(line);
  }
  pushCurrent();
  const originalSection = sections.find((section) => section.title === "Original AI probability decision");
  const currentSection = sections.find((section) => section.title === "Current reassessment");
  const visibleSections = sections.filter((section) => !["Original AI probability decision", "Current reassessment"].includes(section.title));
  const comparisonHtml = originalSection || currentSection ? renderAnalysisComparison(originalSection, currentSection) : "";

  return `
    <div class="analysis-detail-sections${options.singleColumn ? " single-column" : ""}">
      ${visibleSections.map((section) => `
        <section class="analysis-detail-section ${section.title === "ERROR REASON" ? "error" : ""} ${section.title === "Analysis" ? "overview" : ""}">
          <h3>${escapeHtml(section.title)}</h3>
          ${section.title === "Candidates not used" && Array.isArray(options.executionCandidatesNotUsed)
            ? renderExecutionCandidatesNotUsedTable(options.executionCandidatesNotUsed, options.executionProbabilitySource)
            : `<div class="analysis-detail-lines">${section.lines.map(renderAnalysisLine).filter(Boolean).join("")}</div>`}
        </section>
      `).join("")}
      ${comparisonHtml}
    </div>
  `;
}

function openAnalysisModal(text, trigger, options = {}) {
  const modal = analysisModal();
  modal.querySelector(".analysis-modal")?.classList.add("analysis-detail-modal");
  const title = modal.querySelector("#analysis-modal-title");
  if (title) title.textContent = options.title || "Analysis detail";
  const body = modal.querySelector("[data-analysis-modal-body]");
  if (body) body.innerHTML = renderAnalysisModalHtml(text || "No analysis detail available.", options);
  modal.dataset.opportunityKey = options.opportunityKey || "";
  modal.hidden = false;
  document.body.classList.add("modal-open");
  modal.querySelector("[data-analysis-modal-close]")?.focus();
  if (trigger) {
    modal.dataset.returnFocus = "true";
    analysisModal.lastTrigger = trigger;
  }
}

function closeAnalysisModal() {
  const modal = document.querySelector("[data-analysis-modal]");
  if (!modal || modal.hidden) return;
  const opportunityKey = modal.dataset.opportunityKey || "";
  modal.querySelector(".analysis-modal")?.classList.remove("analysis-detail-modal");
  modal.hidden = true;
  modal.dataset.opportunityKey = "";
  document.body.classList.remove("modal-open");
  if (opportunityKey && currentOpportunityKeyFromUrl() === opportunityKey) {
    window.history.replaceState({ page: "opportunities", opportunityView: "scraped" }, "", routePath("opportunities", "scraped"));
    state.openedOpportunityKey = "";
  }
  if (analysisModal.lastTrigger instanceof HTMLElement) {
    analysisModal.lastTrigger.focus();
  }
  analysisModal.lastTrigger = null;
}

function executionModal() {
  let modal = document.querySelector("[data-execution-modal]");
  if (modal) return modal;
  modal = document.createElement("div");
  modal.className = "analysis-modal-backdrop execution-modal-backdrop";
  modal.dataset.executionModal = "";
  modal.hidden = true;
  modal.innerHTML = `
    <section class="analysis-modal execution-modal" role="dialog" aria-modal="true" aria-labelledby="execution-modal-title">
      <div class="analysis-modal-head">
        <h2 id="execution-modal-title">Execution progress</h2>
        <button class="analysis-modal-close" type="button" data-execution-modal-close aria-label="Close execution progress">x</button>
      </div>
      <div class="analysis-modal-body execution-modal-body" data-execution-modal-body></div>
    </section>
  `;
  document.body.appendChild(modal);
  return modal;
}

function openExecutionModal(target) {
  const modal = executionModal();
  modal.hidden = false;
  modal.dataset.target = target;
  modal.dataset.done = "false";
  document.body.classList.add("modal-open");
  renderExecutionSteps([{ tone: "active", text: `${target === "live" ? "Live" : executionTargetLabel(target)} run requested` }]);
  modal.querySelector("[data-execution-modal-close]")?.focus();
}

function closeExecutionModal() {
  const modal = document.querySelector("[data-execution-modal]");
  if (!modal || modal.hidden) return;
  modal.hidden = true;
  document.body.classList.remove("modal-open");
}

function renderExecutionSteps(steps) {
  const modal = executionModal();
  const body = modal.querySelector("[data-execution-modal-body]");
  if (!body) return;
  body.innerHTML = `
    <div class="execution-steps">
      ${[...steps].reverse().map((step) => `
        <div class="execution-step ${escapeHtml(step.tone || "")}">
          <strong>${escapeHtml(step.title || step.text || "")}</strong>
          ${step.detail ? `<span>${escapeHtml(step.detail)}</span>` : ""}
        </div>
      `).join("")}
    </div>
  `;
  body.scrollTop = 0;
}

function addExecutionStep(steps, title, detail = "", tone = "") {
  const next = [...steps, { title, detail, tone }];
  renderExecutionSteps(next);
  return next;
}

// Replaces the most recent step with this title instead of appending another copy.
// Used for progress that is polled repeatedly and only the current value matters.
function upsertExecutionStep(steps, title, detail = "", tone = "") {
  let index = -1;
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    if (steps[i]?.title === title) {
      index = i;
      break;
    }
  }
  if (index < 0) return addExecutionStep(steps, title, detail, tone);
  const next = [...steps];
  next[index] = { title, detail, tone };
  renderExecutionSteps(next);
  return next;
}

// The per-portfolio execution state was cached in memory only, so every reload
// started with nothing and the run log read "no runs recorded yet" until the fetch
// landed -- and stayed that way for the whole session if it failed. History that
// vanishes on a refresh is worse than history that is a minute stale, so the last
// known log is kept on the device and used until a successful fetch replaces it.
const LIVE_EXECUTION_CACHE_KEY = "trading:liveExecutionByMode";

function cachedLiveExecutionByMode() {
  try {
    const raw = localStorage.getItem(LIVE_EXECUTION_CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function rememberLiveExecutionState(mode, value) {
  if (!value || typeof value !== "object") return;
  try {
    const cache = cachedLiveExecutionByMode();
    // Store only what the run log renders, so a large batch cannot overflow the quota.
    cache[mode] = {
      generatedAt: value.generatedAt || null,
      action: value.action || null,
      reason: value.reason || null,
      // The run's identity has to survive too. Without it a render from this cache --
      // which is what the first paint after a reload uses -- rebuilt the top-level row
      // as a run of its own, so the newest entry appeared twice and was labelled Live
      // even on the 5050 tab. Only the fields the row needs, not the whole batch.
      batchLog: value.batchLog
        ? {
          id: value.batchLog.id || null,
          runAt: value.batchLog.runAt || null,
          action: value.batchLog.action || null,
          reason: value.batchLog.reason || null,
          strategyId: value.batchLog.strategyId || null,
          strategyLabel: value.batchLog.strategyLabel || null,
          counts: value.batchLog.counts || null,
          placementBudgetMs: value.batchLog.placementBudgetMs ?? null,
        }
        : null,
      runLog: Array.isArray(value.runLog) ? value.runLog.slice(0, 60) : [],
    };
    localStorage.setItem(LIVE_EXECUTION_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // A full or unavailable store must never break a render.
  }
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

// A hidden tab has its timers throttled to roughly one per minute, so a poll
// scheduled before the switch can sit idle long after the work finished. Waking on
// the return to the tab makes the first thing the user sees the current state
// rather than a stale one.
function sleepUntilVisible(ms) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      document.removeEventListener("visibilitychange", onVisible);
      resolve();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") finish();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.setTimeout(finish, ms);
  });
}

function runMatchesStart(run, startedAt) {
  const created = Date.parse(run?.createdAt || "");
  const start = Date.parse(startedAt || "");
  // GitHub creates the run shortly after dispatch. Allow a little clock skew,
  // but never attach a manual action to a previous completed workflow.
  return !Number.isFinite(start) || !Number.isFinite(created) || created >= start - 10000;
}

function workflowStatusText(run) {
  if (!run) return "waiting for GitHub workflow to appear";
  if (run.status === "completed") return `completed${run.conclusion ? ` / ${run.conclusion}` : ""}`;
  return run.status || "queued";
}

async function waitForWorkflowRun(target, startedAt, steps) {
  let latest = null;
  let lastError = null;
  for (let attempt = 0; attempt < 32; attempt += 1) {
    try {
      const status = await fetchApiJson(`api.php?action=workflow-status&target=${encodeURIComponent(target)}&since=${encodeURIComponent(startedAt)}`);
      latest = (status.runs || []).find((run) => runMatchesStart(run, startedAt)) || null;
      lastError = null;
    } catch (error) {
      // A transient status read must not abandon a run that is already executing.
      lastError = error;
    }
    const elapsed = Math.max(0, Math.round((Date.now() - Date.parse(startedAt || "")) / 1000));
    const detail = [
      lastError ? `status unavailable (${lastError.message})` : workflowStatusText(latest),
      `${elapsed}s elapsed`,
      latest?.htmlUrl || "",
    ].filter(Boolean).join(" / ");
    // One line that updates in place. Appending on every 4s poll produced a wall of
    // identical "Workflow update in_progress / url" entries that buried the steps
    // that actually said something.
    steps = upsertExecutionStep(steps, "Workflow status", detail, latest?.status === "completed" ? "done" : "active");
    if (latest?.status === "completed") return { run: latest, steps };
    await sleep(4000);
  }
  return { run: latest, steps };
}

function paperExecutionDecision(payload, strategyId = "") {
  const requestedStrategyId = strategyId || paperStrategyIdFromMode();
  const portfolio = payload?.paperPortfolios?.[requestedStrategyId];
  if (portfolio?.lastDecision) return portfolio.lastDecision;
  const runs = Array.isArray(payload?.evaluationRunLog) ? payload.evaluationRunLog : [];
  for (const run of runs) {
    const decision = (Array.isArray(run.decisions) ? run.decisions : []).find((item) => item.strategyId === requestedStrategyId);
    if (decision) return { ...decision, runAt: run.runAt || payload.generatedAt };
  }
  return strategyId ? null : (payload?.lastDecision || null);
}

// The ranked shortlist as this browser sees it at dispatch, so the popup can say
// which candidates are in play and on what numbers before the runner reports back.
function executionShortlistPreview(target, limit = 5) {
  const mode = target === "live-5050" ? "live-5050" : (target === "live" ? "live" : (isPaperExecutionTarget(target) ? target : state.mode));
  let rows = [];
  try {
    rows = portfolioCandidateRows(mode) || [];
  } catch {
    return "";
  }
  if (!rows.length) return "";
  const lines = rows.slice(0, limit).map((item, index) => {
    const parts = [
      Number.isFinite(potentialAnnualizedReturn(item)) ? `potential p.a. ${signedPercent(potentialAnnualizedReturn(item))}` : "",
      Number.isFinite(netYield(item)) ? `net yield ${percent(netYield(item))}` : "",
      Number.isFinite(evaluationDaysLeft(item)) ? `${compactDays(evaluationDaysLeft(item))} left` : "",
    ].filter(Boolean).join(" / ");
    const label = `${item.question || "Untitled market"} / ${item.outcome || "-"}`;
    return `${index + 1}. ${label}${parts ? ` — ${parts}` : ""}`;
  });
  const remainder = rows.length > limit ? `\n(+${rows.length - limit} more in the shortlist)` : "";
  const metric = normalizeProbabilitySource(portfolioConfigForMode(mode).probabilitySource) === "polymarket"
    ? "Potential p.a."
    : "EV p.a.";
  // renderExecutionSteps() escapes the detail, so this returns plain text.
  return `Ranked by ${metric}; the runner revalidates in this order and takes the first `
    + `that still passes.\n${lines.join("\n")}${remainder}`;
}

// The economics of one candidate, in the terms the shortlist is ranked by, so the
// progress popup answers "which candidate, and on what numbers" rather than just
// naming it.
function executionCandidateEconomics(candidate = {}) {
  const parts = [];
  const potentialPa = Number(candidate.potentialAnnualizedReturn);
  if (Number.isFinite(potentialPa)) parts.push(`potential p.a. ${percent(potentialPa)}`);
  const netYield = Number(candidate.netYield);
  if (Number.isFinite(netYield)) parts.push(`net yield ${percent(netYield)}`);
  const daysLeft = Number(candidate.daysToResolution);
  if (Number.isFinite(daysLeft)) parts.push(`${compactDays(daysLeft)} left`);
  const win = Number(candidate.netGainIfWinUsdc);
  if (Number.isFinite(win)) parts.push(`win ${money(win)}`);
  const stake = Number(candidate.orderNotionalUsdc ?? candidate.totalCostUsdc);
  if (Number.isFinite(stake) && stake > 0) parts.push(`stake ${money(stake)}`);
  const marketProbability = Number(candidate.marketProbability);
  if (Number.isFinite(marketProbability)) parts.push(`mkt ${probability(marketProbability)}`);
  return parts.join(" / ");
}

// The position a rotation gives up, in the same terms, so the trade-off is legible.
function executionPositionEconomics(position = {}) {
  const parts = [];
  const holdPa = Number(position.holdAnnualizedReturn ?? position.measuredAnnualizedReturn);
  if (Number.isFinite(holdPa)) parts.push(`potential p.a. ${percent(holdPa)}`);
  const sellPnl = Number(position.currentSellPnlUsdc ?? position.realizedPnlIfExitUsdc);
  if (Number.isFinite(sellPnl)) parts.push(`P/L on close ${money(sellPnl)}`);
  const unrealized = Number(position.unrealizedPnlUsdc);
  if (Number.isFinite(unrealized)) parts.push(`open P/L ${money(unrealized)}`);
  const remaining = Number(position.remainingPotentialGainUsdc);
  if (Number.isFinite(remaining)) parts.push(`${money(remaining)} still to collect`);
  const potentialWin = Number(position.potentialWinIfHeldUsdc);
  if (Number.isFinite(potentialWin)) parts.push(`win if held ${money(potentialWin)}`);
  return parts.join(" / ");
}

function liveExecutionSummary(execution) {
  if (!execution || typeof execution !== "object") return "Live execution state is not available yet.";
  const selected = execution.selected || {};
  const response = execution.response || {};
  const monitoring = execution.monitoring || {};
  const batchLog = execution.batchLog || {};
  const rotationExit = execution.rotationExit || batchLog.rotationExit || null;
  const attempts = Array.isArray(execution.attempts) ? execution.attempts : [];
  const lastAttempt = attempts[attempts.length - 1] || {};
  const idleCashLimit = Number(monitoring.idleCashLimitUsdc);
  const idleCashHours = Number(monitoring.idleCashHours);
  const selectedEconomics = executionCandidateEconomics(selected);
  const replacedPosition = rotationExit?.position || null;
  const counts = batchLog.counts || {};
  const lines = [
    `Action: ${execution.action || "-"}`,
    execution.reason ? `Reason: ${execution.reason}` : "",
    // The runner already phrases the rotation trade-off in full sentences; that is
    // the most useful single line the popup can show, so it is not re-derived here.
    batchLog.humanReason ? `Decision: ${batchLog.humanReason}` : "",
    Number.isFinite(idleCashLimit)
      ? `Idle cash: ${monitoring.idleCashOverdue ? "overdue" : "monitored"} / limit ${money(idleCashLimit)} / ${Number.isFinite(idleCashHours) ? `${idleCashHours.toFixed(1)}h` : "-"}`
      : "",
    selected.question ? `Selected: ${selected.question} / ${selected.outcome || "-"}` : "",
    selectedEconomics ? `Selected economics: ${selectedEconomics}` : "",
    replacedPosition?.question
      ? `Replacing: ${replacedPosition.question} / ${replacedPosition.outcome || "-"}`
      : "",
    replacedPosition ? `Replaced economics: ${executionPositionEconomics(replacedPosition)}` : "",
    // When nothing was selected, the counts explain why far better than the action.
    !selected.question && Number.isFinite(Number(counts.scannedCandidates))
      ? `Considered: ${counts.scannedCandidates} scanned / ${counts.revalidatedCandidates ?? "-"} revalidated`
        + ` / ${counts.eligibleCandidates ?? "-"} eligible / ${counts.positionsReviewedForRotation ?? 0} positions reviewed for rotation`
      : "",
    selected.orderType ? `Order: ${selected.orderType} ${selected.orderSize || "-"} @ ${probability(Number(selected.orderPrice))}` : "",
    response.orderID ? `Order ID: ${response.orderID}` : "",
    response.status ? `Polymarket status: ${response.status}` : "",
    lastAttempt.rejectReason ? `Last reject: ${lastAttempt.rejectReason}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

// A result state that is not published yet is the normal state of the world while
// the runner is still working: the live executor writes live-execution-state.json
// at the end of its run, and the very first poll can land before that upload, or
// before the file has ever existed. Letting that read throw turned "waiting" into
// "Execution failed / State file is not available yet" and hid the real outcome,
// so every attempt tolerates its own failure and only the last one is reported.
async function waitForExecutionResult(target, startedAt, steps, options = {}) {
  // Each live portfolio publishes its own execution state; watching the wrong one
  // would report another portfolio's run as this one's result.
  const stateTarget = target === "live-5050" ? "live-5050-execution" : (target === "live" ? "live-execution" : "paper");
  let lastError = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    let payload = null;
    try {
      // The unnamed summary decodes the whole evaluation archive on the way out, which is
      // what made this poll answer "paper state HTTP 500" on a 128 MB host. The decision
      // it reads lives in the core state, so the dashboard view carries it.
      const summary = stateTarget === "paper" ? "&summary=dashboard" : "";
      payload = await fetchApiJson(`api.php?action=state&target=${stateTarget}${summary}`);
    } catch (error) {
      lastError = error;
      await sleep(3000);
      continue;
    }
    lastError = null;
    const paperDecision = target === "paper" ? paperExecutionDecision(payload, options.paperStrategyId) : null;
    const generated = Date.parse(target === "paper"
      ? (paperDecision?.runAt || payload.generatedAt || payload.lastDecision?.runAt || "")
      : (payload.generatedAt || payload.lastDecision?.runAt || ""));
    const start = Date.parse(startedAt || "");
    if (!Number.isFinite(start) || (Number.isFinite(generated) && generated >= start - 120000)) {
      const detail = target === "live"
        ? liveExecutionSummary(payload)
        : `Paper ${portfolioNameForMode(paperModeFromStrategyId(options.paperStrategyId))} action: ${paperDecision?.action || "-"} / ${paperDecision?.reason || "-"}`;
      steps = addExecutionStep(steps, "Execution result", detail, "done");
      return { payload, steps };
    }
    await sleep(3000);
  }
  // Still nothing after the whole window. That is worth reporting, but it is not
  // an execution failure: the workflow conclusion reported separately is what says
  // whether the run itself succeeded.
  const detail = lastError
    ? `The result state could not be read while waiting (${lastError.message}). `
      + "The workflow conclusion above is authoritative; the dashboard keeps refreshing."
    : "Result state has not updated yet; dashboard will keep refreshing.";
  steps = addExecutionStep(steps, "Execution result", detail, "active");
  return { payload: null, steps };
}

function currentEligibilityThreshold() {
  const configured = Number(state.eligibilityThreshold);
  const normalizedConfigured = normalizeEligibilityThreshold(configured);
  if (normalizedConfigured != null) return normalizedConfigured;
  return thresholdForMode(state.mode);
}

function normalizeEligibilityThreshold(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  if (numeric < MIN_ELIGIBILITY_THRESHOLD || numeric > MAX_ELIGIBILITY_THRESHOLD) return null;
  return numeric;
}

// The inverse of paperStrategyIdFromMode. A fixed list here answered "conservative" for
// every created portfolio, so its rules panel, run-log title and execution result would
// all have described a different portfolio's settings.
function paperModeFromStrategyId(strategyId) {
  const id = String(strategyId || "");
  return BUILT_IN_PAPER_STRATEGY_IDS.includes(id) || CUSTOM_PAPER_STRATEGY_ID.test(id)
    ? `paper-${id}`
    : "paper-conservative";
}

function portfolioForMode(mode = state.mode) {
  if (LIVE_MODES.has(normalizeMode(mode))) return state.liveState?.portfolio || {};
  const portfolios = paperPortfolioList(state.botState || {});
  const strategyId = paperStrategyIdFromMode(mode);
  const selected = portfolios.find((item) => item.id === strategyId) || selectedPaperPortfolio(state.botState || {});
  return {
    ...selected,
    ...(selected?.portfolio || {}),
  };
}

function thresholdDefaultForMode(mode = state.mode) {
  const normalizedMode = normalizeMode(mode);
  const portfolioThreshold = Number(portfolioForMode(normalizedMode)?.minProbability);
  const fallback = normalizedMode === "paper-highReward" || normalizedMode === "paper-moreProbable"
    ? 0.6
    : normalizedMode === "paper-equal"
      ? 0.75
    : DEFAULT_ELIGIBILITY_THRESHOLD;
  return normalizeEligibilityThreshold(portfolioThreshold) ?? fallback;
}

function thresholdForMode(mode = state.mode) {
  return portfolioConfigForMode(mode).minProbability ?? storedEligibilityThreshold(mode) ?? thresholdDefaultForMode(mode);
}

function syncEligibilityThresholdControl() {
  const value = currentEligibilityThreshold();
  state.eligibilityThreshold = value;
  if (els.eligibilityThreshold) {
    els.eligibilityThreshold.value = String(Math.round(value * 100));
  }
  if (els.eligibilityThresholdLabel) {
    els.eligibilityThresholdLabel.textContent = probability(value);
  }
}

function isProbabilityRejectReason(reason) {
  return /probability .*below|below .*probability|high-confidence threshold|edge-opportunity threshold/i.test(String(reason || ""));
}

function nonProbabilityRejectReasons(item) {
  return (Array.isArray(item.rejectReasons) ? item.rejectReasons : [])
    .filter((reason) => !isProbabilityRejectReason(reason))
    .filter((reason) => !/end date|past|closed|accepting orders/i.test(String(reason || "")));
}

function adjustedEvaluationStatus(item) {
  const original = String(item.status || "-").toUpperCase();
  if (original === "ERROR") return "ERROR";
  if (original === "RESOLVED" || evaluationEnded(item)) return "RESOLVED";
  return "EVALUATED";
}

function portfolioEvaluationStatus(item) {
  if (item?.selectionStatus === "AI_PENDING" || item?.aiAnalysis?.aiModelStatus === "QUOTA_LIMITED") return "ERROR";
  const status = adjustedEvaluationStatus(item);
  if (status === "ERROR") return "ERROR";
  if (status === "RESOLVED") return "RESOLVED";
  return "EVALUATED";
}

function evaluationReasons(item, riskReason = "") {
  const aiProbability = Number(item.aiProbability);
  const threshold = currentEligibilityThreshold();
  const reasons = [];
  if (riskReason) reasons.push(riskReason);
  if (portfolioEvaluationStatus(item) === "RESOLVED") {
    reasons.push("market is closed, no longer accepting orders, or past its end date; excluded from new trade selection and waiting for/following resolution sync");
  }
  if (Number.isFinite(aiProbability) && aiProbability < threshold) {
    reasons.push(`portfolio filter: AI probability ${probability(aiProbability)} below selected ${probability(threshold)}`);
  }
  reasons.push(...nonProbabilityRejectReasons(item));
  if (Number.isFinite(aiProbability) && aiProbability >= threshold) {
    reasons.push(`portfolio filter: AI probability passes selected ${probability(threshold)} threshold`);
  }
  return reasons.filter(Boolean);
}

function dashboardLoadIsStale(options = {}) {
  const requestId = Number(options.requestId);
  const hasRequestId = Number.isFinite(requestId) && requestId > 0;
  return (hasRequestId && requestId !== state.dashboardLoadSeq)
    || (options.requestedMode && normalizeMode(state.mode) !== normalizeMode(options.requestedMode));
}

function renderKnownStateForMode(mode = state.mode) {
  if (LIVE_MODES.has(normalizeMode(mode))) {
    // This paints before the fresh fetch resolves, so point the run log at the
    // portfolio being opened first. Otherwise it renders the previous portfolio's
    // execution history for as long as the load takes.
    state.liveExecutionByMode = state.liveExecutionByMode || cachedLiveExecutionByMode();
    state.liveExecutionState = state.liveExecutionByMode[normalizeMode(mode)] || null;
    if (state.liveState) renderLiveState(state.liveState);
    return;
  }
  if (state.botState) renderBotState(state.botState);
}

function botStateIsFull(botState) {
  const detailsMode = String(botState?.evaluationDetailsMode || "");
  return Boolean(botState) && detailsMode !== "compact" && detailsMode !== "dashboard" && detailsMode !== "portfolio-overview";
}

function shouldLoadFullBotState() {
  return state.page === "opportunities";
}

function activeTabTarget() {
  return document.querySelector("[data-tab-target].active")?.dataset.tabTarget || "";
}

function shouldLoadCandidateBotState() {
  return state.page === "portfolios";
}

function shouldRenderCandidateBotState() {
  return state.page === "portfolios" && activeTabTarget() === "portfolio-candidates";
}

function candidateBotStateIsLoaded() {
  const detailsMode = String(state.botState?.evaluationDetailsMode || "");
  return detailsMode === "compact" || botStateIsFull(state.botState);
}

function botStateWithPreservedEvaluations(botState) {
  if (!botState || typeof botState !== "object") return botState;
  const detailsMode = String(botState.evaluationDetailsMode || "");
  if (detailsMode === "compact") {
    return {
      ...state.botState,
      ...botState,
      evaluations: Array.isArray(botState.evaluations) ? botState.evaluations : [],
      evaluationDetailsMode: "compact",
    };
  }
  if (detailsMode !== "dashboard" || !candidateBotStateIsLoaded()) return botState;
  return {
    ...state.botState,
    ...botState,
    evaluations: state.botState?.evaluations || [],
    evaluationDetailsMode: state.botState?.evaluationDetailsMode || botState.evaluationDetailsMode,
  };
}

async function ensureCandidateBotState(options = {}) {
  if (state.botStateFull || state.candidateBotStateBusy || !shouldLoadCandidateBotState()) return;
  if (candidateBotStateIsLoaded()) return;
  state.candidateBotStateBusy = true;
  try {
    const botState = await fetchJsonWithTimeout("data/paper-state.json", { summary: "candidates" }, 15000);
    if (dashboardLoadIsStale(options)) return;
    state.botState = botStateWithPreservedEvaluations(botState);
    state.botStateFull = state.botStateFull || botStateIsFull(botState);
    if (shouldRenderCandidateBotState()) {
      renderPortfolioCandidates();
    }
    if (isLiveMode() && state.liveState) {
      // The live snapshot renders first; enrich its rows once the shared evaluations arrive.
      renderLiveState(state.liveState);
    }
  } catch (error) {
    rememberStateFetchError("paper", error);
    if (shouldRenderCandidateBotState()) renderPortfolioCandidates();
  } finally {
    state.candidateBotStateBusy = false;
  }
}

function syncPortfolioCandidateRefreshControl() {
  if (!els.portfolioCandidatesRefresh) return;
  const busy = Boolean(state.candidateRefreshBusy || state.candidateBotStateBusy);
  els.portfolioCandidatesRefresh.disabled = busy;
  els.portfolioCandidatesRefresh.textContent = busy ? "Refreshing..." : "Refresh shortlist";
}

async function refreshPortfolioCandidates(options = {}) {
  if (state.candidateRefreshBusy || state.candidateBotStateBusy) return;
  state.candidateRefreshBusy = true;
  state.scrapedMarketStateError = "";
  syncPortfolioCandidateRefreshControl();
  if (activeTabTarget() === "portfolio-candidates" && els.portfolioCandidates) {
    els.portfolioCandidates.innerHTML = '<div class="empty">Loading the latest portfolio execution shortlist...</div>';
    if (els.portfolioCandidatesSummary) els.portfolioCandidatesSummary.textContent = "refreshing";
  }
  if (!options.quiet) setExecutionStatus("refreshing execution shortlist");
  try {
    // Always load the latest persisted scraped snapshot. It supplies current
    // market probability and order-book economics for both AI and Polymarket
    // probability portfolios; the selected source still controls eligibility.
    const [botState, liveState, scrapedState] = await Promise.all([
      fetchJsonWithTimeout("data/paper-state.json", { summary: "candidates" }, 15000),
      isLiveMode() ? fetchJsonWithTimeout("data/live-state.json", {}, 15000) : Promise.resolve(null),
      fetchJsonWithTimeout("data/paper-state.json", { summary: "execution" }, 15000),
    ]);
    state.botState = botStateWithPreservedEvaluations(botState);
    state.botStateFull = state.botStateFull || botStateIsFull(botState);
    storeScrapedMarketState(scrapedState, "execution");
    if (Array.isArray(state.botState?.evaluations) && Array.isArray(scrapedState?.marketObservations)) {
      state.botState = {
        ...state.botState,
        evaluations: mergeCurrentMarketEconomics(state.botState.evaluations, scrapedState.marketObservations),
      };
    }
    if (liveState) {
      renderLiveState(liveState);
    } else {
      renderPortfolioCandidates();
    }
    if (!options.quiet) setExecutionStatus("shortlist refreshed with current market quotes and calculated values");
  } catch (error) {
    if (!options.quiet) setExecutionStatus(error.message || "shortlist refresh failed", "error");
    renderPortfolioCandidates();
  } finally {
    state.candidateRefreshBusy = false;
    syncPortfolioCandidateRefreshControl();
  }
}

async function ensureFullBotState(options = {}) {
  if (state.botStateFull || state.fullBotStateBusy || !shouldLoadFullBotState()) return;
  state.fullBotStateBusy = true;
  try {
    const botState = await fetchJson("data/paper-state.json");
    if (dashboardLoadIsStale(options)) return;
    state.botStateFull = botStateIsFull(botState);
    if (LIVE_MODES.has(normalizeMode(state.mode))) {
      state.botState = botStateWithPreservedEvaluations(botState);
      if (state.liveState) renderLiveState(state.liveState);
      return;
    }
    renderBotState(botState);
  } catch (error) {
    rememberStateFetchError("paper", error);
    if (state.botState) {
      renderKnownStateForMode(state.mode);
    }
  } finally {
    state.fullBotStateBusy = false;
  }
}

function scrapedMarketStateIsLoaded() {
  // The compact dashboard response deliberately omits raw observations. An empty
  // array must not be treated as a successfully loaded scraped-market dataset.
  return state.scrapedMarketStateLoaded;
}

function scrapedMarketObservations() {
  if (state.scrapedMarketStateLoaded) return state.scrapedMarketObservations;
  const observations = Array.isArray(state.botState?.marketObservations) ? state.botState.marketObservations : [];
  return observations.filter((item) => !scrapedObservationIsError(item));
}

function scrapedObservationIsError(item) {
  const status = String(item?.status || item?.selectionStatus || "").trim().toUpperCase();
  return status === "ERROR";
}

function scrapedMarketScan() {
  if (state.scrapedMarketStateLoaded) return state.scrapedMarketScan || {};
  return state.botState?.marketScan || {};
}

function storeScrapedMarketState(scrapedState = {}, summary = "scraped") {
  // The scraped view requires an explicit observations array. A compact
  // dashboard response intentionally omits it, and must never clear a loaded
  // catalogue just because a caller requested the wrong response summary.
  if (!Array.isArray(scrapedState.marketObservations)) {
    state.scrapedMarketStateError = "Scraped state response did not include market observations.";
    return false;
  }
  state.scrapedMarketObservations = scrapedState.marketObservations.filter((item) => !scrapedObservationIsError(item));
  // Retained totals, when the backend reports them, so the tab counts describe the
  // archive rather than the slice that fitted in this response.
  state.scrapedObservationTotals = scrapedState.observationTotals
    && typeof scrapedState.observationTotals === "object"
    ? scrapedState.observationTotals
    : null;
  state.scrapedMarketScan = scrapedState.marketScan && typeof scrapedState.marketScan === "object"
    ? scrapedState.marketScan
    : {};
  if (state.scrapeHistoryPage < 0) {
    state.scrapedMarketScanHistory = Array.isArray(scrapedState.marketScanHistory)
      ? scrapedState.marketScanHistory
      : [];
  }
  state.scrapedMarketStateSummary = summary;
  state.scrapedMarketStateError = "";
  state.scrapedMarketStateLoaded = true;
  return true;
}

async function ensureScrapedMarketState(options = {}) {
  const summary = options.summary || (shouldRenderCandidateBotState() ? "execution" : "scraped");
  if ((!options.force && scrapedMarketStateIsLoaded() && state.scrapedMarketStateSummary === summary) || state.scrapedMarketStateBusy) return;
  state.scrapedMarketStateBusy = true;
  state.scrapedMarketStateError = "";
  if ((state.opportunityView === "scraped" || state.opportunityView === "scan-log") && els.botEvaluations) {
    els.botEvaluations.innerHTML = '<div class="empty">Loading scraped Polymarket opportunities...</div>';
  }
  try {
    const scrapedState = await fetchJsonWithTimeout("data/paper-state.json", { summary }, 10000);
    if (dashboardLoadIsStale(options)) return;
    storeScrapedMarketState(scrapedState, summary);
    if (state.opportunityView === "scraped" || state.opportunityView === "scan-log") renderBotEvaluations();
    if (isLiveMode() && state.liveState) {
      // Open CLOB orders only expose a token ID. Re-render after scraped market
      // metadata arrives so the table can resolve its human market title.
      renderLiveState(state.liveState);
    } else if (shouldRenderCandidateBotState()) {
      renderPortfolioCandidates();
    }
  } catch (error) {
    state.scrapedMarketStateError = error?.message || "Scraped Polymarket data could not be loaded.";
    rememberStateFetchError("paper", error);
    if ((state.opportunityView === "scraped" || state.opportunityView === "scan-log") && els.botEvaluations) {
      els.botEvaluations.innerHTML = `<div class="empty">${escapeHtml(error.message || "Scraped opportunities are not available yet.")}</div>`;
    }
    if (shouldRenderCandidateBotState()) renderPortfolioCandidates();
  } finally {
    state.scrapedMarketStateBusy = false;
  }
}

async function loadBotState(options = {}) {
  try {
    const requestedMode = options.requestedMode || state.mode;
    const botState = await fetchJson("data/paper-state.json", {
      summary: "dashboard",
      strategyId: paperStrategyIdFromMode(requestedMode),
    });
    if (dashboardLoadIsStale(options) || isLiveMode()) return;
    const mergedBotState = botStateWithPreservedEvaluations(botState);
    state.botStateFull = botStateIsFull(mergedBotState);
    renderBotState(mergedBotState);
    ensureCandidateBotState();
    ensureFullBotState(options);
  } catch (error) {
    if (dashboardLoadIsStale(options) || isLiveMode()) return;
    if (state.botState) {
      rememberStateFetchError("paper", error);
      renderBotState(state.botState);
      return;
    }
    if (els.botAction) els.botAction.textContent = "offline";
    if (els.botInlineAction) els.botInlineAction.textContent = "offline";
    if (els.portfolioRules) els.portfolioRules.innerHTML = "";
    els.botStatus.hidden = false;
    els.botStatus.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
    els.botTrades.innerHTML = '<div class="empty">Autonomous paper portfolio state is not available yet.</div>';
    if (els.closedTrades) els.closedTrades.innerHTML = '<div class="empty">Closed paper trades are not available yet.</div>';
    if (els.closedSummary) els.closedSummary.textContent = "offline";
    els.botEvaluations.innerHTML = '<div class="empty">No common evaluation log loaded.</div>';
  }
}

async function fetchJson(path, options = {}) {
  const statePath = String(path || "");
  const stateTarget = statePath === "data/live-state.json" ? "live" : (statePath === "data/paper-state.json" ? "paper" : "");
  const summary = options.summary ? `&summary=${encodeURIComponent(options.summary)}` : "";
  const strategyId = stateTarget === "paper" && options.strategyId
    ? `&strategy_id=${encodeURIComponent(options.strategyId)}`
    : "";
  const cacheSummary = options.strategyId
    ? `${options.summary || "full"}:${options.strategyId}`
    : (options.summary || "full");
  const url = stateTarget
    ? appPath(`api.php?action=state&target=${stateTarget}${summary}${strategyId}&t=${Date.now()}`)
    : appPath(`${statePath}?t=${Date.now()}`);
  try {
    const fetchOptions = { cache: "no-store" };
    if (options.signal) fetchOptions.signal = options.signal;
    const statePayload = await fetch(url, fetchOptions);
    if (!statePayload.ok) throw new Error(`${path} HTTP ${statePayload.status}`);
    const payload = await statePayload.json();
    if (stateTarget) {
      writeCachedState(stateTarget, payload, cacheSummary);
      clearStateFetchError(stateTarget);
    }
    return payload;
  } catch (error) {
    if (stateTarget) {
      rememberStateFetchError(stateTarget, error);
      const cached = readCachedState(stateTarget, cacheSummary);
      if (cached) return cached;
    }
    throw error;
  }
}

async function fetchJsonWithTimeout(path, options = {}, timeoutMs = 15000) {
  if (typeof AbortController === "undefined") return fetchJson(path, options);
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchJson(path, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`${path} timed out after ${Math.round(timeoutMs / 1000)} seconds`);
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function fetchApiJson(url, options = {}) {
  const requestUrl = appPath(url);
  const response = await fetch(`${requestUrl}${requestUrl.includes("?") ? "&" : "?"}t=${Date.now()}`, {
    cache: "no-store",
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `${url} HTTP ${response.status}`);
  }
  return payload;
}

async function loadPortfolioConfig() {
  try {
    const payload = await fetchApiJson("api.php?action=portfolio-config");
    state.portfolioConfig = payload.config || defaultPortfolioConfig();
    writeCachedPortfolioConfig(state.portfolioConfig);
  } catch {
    state.portfolioConfig = state.portfolioConfig || defaultPortfolioConfig();
  }
  return state.portfolioConfig;
}

async function savePortfolioConfigNow() {
  window.clearTimeout(state.portfolioConfigSaveTimer);
  const payload = await fetchApiJson("api.php?action=portfolio-config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ config: state.portfolioConfig || defaultPortfolioConfig() }),
  });
  state.portfolioConfig = payload.config || state.portfolioConfig || defaultPortfolioConfig();
  return state.portfolioConfig;
}

function savePortfolioConfigSoon() {
  window.clearTimeout(state.portfolioConfigSaveTimer);
  state.portfolioConfigSaveTimer = window.setTimeout(async () => {
    try {
      await savePortfolioConfigNow();
      setExecutionStatus("portfolio parameters saved");
    } catch (error) {
      setExecutionStatus(error.message || "portfolio parameter save failed", "error");
    }
  }, 350);
}

async function requestLiveAccountSync(options = {}) {
  if (state.autoLiveSyncBusy) return;
  state.autoLiveSyncBusy = true;
  const quiet = Boolean(options.quiet);
  const minSeconds = Math.max(30, Math.round(Number(options.minSeconds || LIVE_SYNC_REQUEST_MS / 1000)));
  if (!quiet) setExecutionStatus("syncing live account");
  try {
    const response = await fetch(appPath(`api.php?action=live-sync&minSeconds=${encodeURIComponent(minSeconds)}`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error || `live sync HTTP ${response.status}`);
    }
    if (payload.action === "DISPATCH") {
      if (!quiet) setExecutionStatus("live sync started");
    } else {
      if (!quiet) setExecutionStatus("live account current");
    }
  } catch (error) {
    if (!quiet) setExecutionStatus(error.message || "live sync failed", "error");
  } finally {
    state.autoLiveSyncBusy = false;
  }
}

function syncOpenedTradesRefreshButton() {
  if (!els.openedTradesRefresh) return;
  els.openedTradesRefresh.disabled = state.openedTradesRefreshBusy;
  els.openedTradesRefresh.textContent = state.openedTradesRefreshBusy ? "Refreshing..." : "Refresh values";
}

async function waitForFreshLiveSnapshot(previousGeneratedAt = "") {
  let latest = state.liveState || null;
  const previousTime = Date.parse(previousGeneratedAt || "");
  for (let attempt = 0; attempt < 15; attempt += 1) {
    latest = await fetchJson("data/live-state.json");
    const currentTime = Date.parse(latest?.generatedAt || "");
    if (!Number.isFinite(previousTime) || (Number.isFinite(currentTime) && currentTime > previousTime)) {
      return latest;
    }
    await sleep(2000);
  }
  return latest;
}

async function refreshOpenedTradesValues() {
  if (state.openedTradesRefreshBusy) return;
  state.openedTradesRefreshBusy = true;
  syncOpenedTradesRefreshButton();
  setExecutionStatus("refreshing opened-trade values");
  try {
    if (isLiveMode()) {
      const previousGeneratedAt = state.liveState?.generatedAt || "";
      // Request the account sync first, then wait for the resulting snapshot
      // so Win p.a. is calculated from current marks and current P/L.
      await requestLiveAccountSync({ quiet: true, minSeconds: LIVE_SYNC_MANUAL_SECONDS });
      const liveState = await waitForFreshLiveSnapshot(previousGeneratedAt);
      if (liveState) renderLiveState(liveState);
      setExecutionStatus("opened-trade values recalculated");
    } else {
      const botState = await fetchJson("data/paper-state.json", {
        summary: "dashboard",
        strategyId: paperStrategyIdFromMode(),
      });
      state.botState = botStateWithPreservedEvaluations(botState);
      state.botStateFull = botStateIsFull(state.botState);
      renderBotState(state.botState);
      setExecutionStatus("opened-trade values recalculated");
    }
  } catch (error) {
    setExecutionStatus(error.message || "opened-trade refresh failed", "error");
  } finally {
    state.openedTradesRefreshBusy = false;
    syncOpenedTradesRefreshButton();
  }
}

// Deliberately empty of per-strategy parameters. Every portfolio's settings are read
// from portfolio-config.json by the workflow's "Load portfolio config" step, which
// appends them to GITHUB_ENV and so overrides the job env for every later step -- these
// inputs could never take effect. Sending them anyway produced GitHub 422s two ways:
// "Unexpected inputs provided" once the workflow stopped declaring them, and, while it
// did declare them, a file over the hard ceiling of 25 workflow_dispatch inputs, which
// GitHub refuses to parse at all -- that took every dispatch and the whole schedule down.
// A portfolio's parameters are saved, not dispatched.
function paperThresholdPayload() {
  return {};
}

function liveWorkflowPayload() {
  const config = portfolioConfigForMode("live");
  const shortlistTokenIds = portfolioCandidateRows("live")
    .map((item) => String(item?.tokenId || item?.clobTokenId || item?.assetId || ""))
    .filter((tokenId) => /^\d{8,100}$/.test(tokenId))
    .slice(0, 120);
  return {
    ...config,
    min_probability: config.minProbability,
    stake_usdc: config.stakeUsdc,
    use_limit_orders: config.useLimitOrders,
    manual_run_once: true,
    live_run_source: "MANUAL",
    live_execution_candidate_token_ids: shortlistTokenIds.join(","),
    cross_live_portfolio_risk_diversification: systemConfig().crossLivePortfolioRiskDiversification !== false,
  };
}

async function fetchFreshState(target, summary = "") {
  const summaryQuery = summary ? `&summary=${encodeURIComponent(summary)}` : "";
  const response = await fetch(appPath(`api.php?action=state&target=${target}${summaryQuery}&t=${Date.now()}`), {
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`${target} state HTTP ${response.status}`);
  return response.json();
}

async function freshLiveWorkflowPayload() {
  // A live click must submit precisely the same scraped shortlist the user sees,
  // never a stale dashboard cache or the AI-evaluation dataset.
  const [scrapedState, liveState] = await Promise.all([
    fetchFreshState("paper", "scraped"),
    fetchFreshState("live"),
  ]);
  storeScrapedMarketState(scrapedState);
  state.liveState = liveState;
  // The refetch above replaces the rows the shortlist is built from, so without
  // re-rendering here the table keeps showing the previous catalogue while the run
  // evaluates the newly fetched one -- and the run log then lists markets the user never
  // saw. Short-dated sports and esports markets turn over within minutes, so the two
  // drift apart easily. Re-render first, so what is on screen is what was submitted,
  // which is the guarantee this function's own comment promises.
  if (state.page === "opportunities") renderBotEvaluations();
  else rerenderCurrentDashboard();
  // Refreshing the shortlist is part of running, not a precondition the user has to
  // satisfy first: the refetch and re-render above already did it. If it comes back
  // empty there is still nothing to refuse -- with no shortlist supplied the executor
  // scans for candidates itself, exactly as a scheduled run does.
  return liveWorkflowPayload();
}

async function triggerOneTimeExecution(target) {
  target = (target === "live" || target === "live-5050")
    ? target
    : (isPaperExecutionTarget(target) ? target : "paper");
  const live = target === "live" || target === "live-5050";
  const paperStrategyId = live ? "" : paperStrategyIdFromMode(target === "paper" ? state.mode : target);
  const startedAt = new Date().toISOString();
  openExecutionModal(target);
  let steps = [
    {
      title: target === "live-5050" ? "5050 execution requested" : (live ? "Live execution requested" : "Paper execution requested"),
      detail: live ? `Started ${formatDate(startedAt)}` : `${executionTargetLabel(target)} / started ${formatDate(startedAt)}`,
      tone: "active",
    },
  ];
  renderExecutionSteps(steps);

  if (state.executionBusy) {
    steps = addExecutionStep(steps, "Execution already running", `${state.executionBusy === "live" ? "Live" : "Paper"} workflow is still in progress. Wait for it to finish before starting another one.`, "error");
    setExecutionStatus("execution already running", "error");
    return;
  }

  if (live && !state.liveExecutionArmed) {
    // Re-read durable browser state before refusing a real click. This covers
    // navigation between the www and apex host without weakening confirmation.
    state.liveExecutionArmed = storedLiveExecutionArmed();
    syncLiveActivationUi();
  }
  if (live && !state.liveExecutionArmed) {
    steps = addExecutionStep(steps, "Live gate is inactive on this browser", "Open Settings and activate the live execution gate once on this device. Scheduled server automation still uses stored secrets; this only protects manual live clicks from the browser UI.", "error");
    setExecutionStatus("live execution blocked: gate inactive", "error");
    return;
  }
  if (live) {
    // The armed gate is an explicit, durable confirmation. Native confirm()
    // dialogs are inconsistently suppressed on mobile and can falsely look as
    // though GitHub cancelled a workflow before it was even dispatched.
    steps = addExecutionStep(steps, target === "live-5050" ? "5050 execution confirmed" : "Live execution confirmed", `The live execution gate is active on this browser. Dispatching ${target === "live-5050" ? "the 5050 workflow, which runs over its own candidate scan" : "GitHub workflow with the current portfolio parameters"}.`, "done");
  }

  state.executionBusy = target;
  syncExecutionButtons();
  setExecutionStatus(target === "live-5050" ? "starting 5050 workflow" : (live ? "starting live workflow" : "starting paper workflow"));

  try {
    await savePortfolioConfigNow();
    // 5050 takes no shortlist: its workflow has no such input and it scans for
    // candidates itself, so building and announcing one would be a fiction.
    const sendsShortlist = target === "live";
    const workflowPayload = sendsShortlist ? await freshLiveWorkflowPayload() : null;
    if (target === "live-5050") {
      steps = addExecutionStep(
        steps,
        "Running the 5050 algorithm",
        `Every candidate that clears this portfolio\u2019s bar will be bid at ${percent(normalizeFixedEntryPrice(portfolioConfigForMode("live-5050").fixedEntryPrice))}. The run scans for them itself rather than taking the list on screen.`,
        "done",
      );
    }
    if (sendsShortlist) {
      // Name the shortlist that was actually submitted, so the run log can be checked
      // against it instead of taken on trust.
      const submitted = String(workflowPayload.live_execution_candidate_token_ids || "")
        .split(",").filter(Boolean).length;
      steps = addExecutionStep(
        steps,
        "Shortlist submitted",
        `${submitted} candidate${submitted === 1 ? "" : "s"} from the refreshed list on screen were sent for live verification.`,
        "done",
      );
    }
    const response = await fetch(appPath("api.php?action=workflow"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target,
        manual_run_once: true,
        ...(!live ? {
          paper_strategy_id: paperStrategyId,
          max_order_fraction: currentRiskAllocation(),
          ...paperThresholdPayload(),
        } : {
          ...workflowPayload,
        }),
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error || `workflow HTTP ${response.status}`);
    }
    steps = addExecutionStep(steps, "Workflow dispatched", payload.workflow || payload.message || "GitHub Actions accepted the request", "done");
    setExecutionStatus(`${executionTargetLabel(target)} workflow started`);
    // The runner publishes its decision only at the end of the run, so until then
    // the most informative thing available is the shortlist this browser just sent
    // and the ranking numbers behind it. Without this the popup showed nothing but
    // a workflow status while the interesting minute passed.
    const submittedShortlist = executionShortlistPreview(target);
    if (submittedShortlist) {
      steps = addExecutionStep(steps, "Candidates submitted for revalidation", submittedShortlist, "done");
    }
    const liveUsesPolymarketProbability = normalizeProbabilitySource(portfolioConfigForMode("live").probabilitySource) === "polymarket";
    steps = addExecutionStep(steps, "Execution check running", live
      ? (liveUsesPolymarketProbability
        ? "The runner refreshes the account and current Polymarket quotes, recalculates fees and profitability for the ordered shortlist, then submits only the first candidate that still passes. No AI analysis is requested."
        : "The runner refreshes account and market data, checks candidates against their stored AI assessment and risk diversification, then submits only if criteria still pass.")
      : "The evaluation engine scans markets, prioritizes new opportunities, updates known evaluations, and may open one paper trade.", "active");
    const workflow = await waitForWorkflowRun(target, startedAt, steps);
    steps = workflow.steps;
    const result = await waitForExecutionResult(target, startedAt, steps, { paperStrategyId });
    steps = result.steps;
    if (workflow.run?.conclusion && workflow.run.conclusion !== "success") {
      const actualResult = live ? "The recorded live trading result is shown above; a post-trade maintenance step failed after it." : "The recorded paper decision is shown above.";
      const failureDetail = workflow.run.failureDetail ? ` Failed step: ${workflow.run.failureDetail}.` : "";
      steps = addExecutionStep(steps, "Workflow finished with warning", `Conclusion: ${workflow.run.conclusion}.${failureDetail} ${actualResult}`, "error");
      setExecutionStatus(`${executionTargetLabel(target)} workflow ${workflow.run.conclusion}`, "error");
    }
    steps = addExecutionStep(steps, "Dashboard refreshed", "Open positions and limit orders are shown in the tables below.", "done");
    if (!workflow.run?.conclusion || workflow.run.conclusion === "success") {
      setExecutionStatus(`${executionTargetLabel(target)} workflow completed`);
    }
    await loadDashboardState();
  } catch (error) {
    steps = addExecutionStep(steps, "Execution failed", error.message || "workflow failed", "error");
    setExecutionStatus(error.message || "workflow failed", "error");
  } finally {
    state.executionBusy = null;
    syncExecutionButtons();
  }
}

async function triggerManualOpportunityEvaluation(item, trigger = null) {
  if (!item || state.executionBusy) return;
  const startedAt = new Date().toISOString();
  const target = "paper-evaluation";
  openExecutionModal("paper");
  let steps = [{
    title: "Manual evaluation requested",
    detail: `${item.outcome || "Outcome"} - ${item.question || "Selected Polymarket opportunity"}`,
    tone: "active",
  }];
  renderExecutionSteps(steps);
  state.executionBusy = target;
  syncExecutionButtons();
  try {
    const response = await fetch(appPath("api.php?action=workflow"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target,
        evaluation_only: true,
        evaluation_token_id: item.tokenId || item.clobTokenId || "",
        evaluation_market_slug: item.slug || item.eventSlug || "",
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) throw new Error(payload.error || `workflow HTTP ${response.status}`);
    steps = addExecutionStep(steps, "Workflow dispatched", payload.workflow || "GitHub Actions accepted the request", "done");
    steps = addExecutionStep(steps, "Gemini evaluation running", "Only this Polymarket outcome is being reviewed. No paper or live order will be opened.", "active");
    const workflow = await waitForWorkflowRun(target, startedAt, steps);
    steps = workflow.steps;
    if (workflow.run?.conclusion && workflow.run.conclusion !== "success") {
      steps = addExecutionStep(steps, "Workflow finished with warning", `Conclusion: ${workflow.run.conclusion}`, "error");
      return;
    }
    const refreshed = await fetchJson("data/paper-state.json", {
      summary: "dashboard",
      strategyId: paperStrategyIdFromMode(),
    });
    state.botStateFull = botStateIsFull(refreshed);
    state.botState = refreshed;
    renderBotState(refreshed);
    steps = addExecutionStep(steps, "Evaluation saved", "The analysis and any changed values are now in the evaluation log.", "done");
  } catch (error) {
    steps = addExecutionStep(steps, "Evaluation failed", error.message || "manual evaluation failed", "error");
  } finally {
    state.executionBusy = null;
    syncExecutionButtons();
  }
}

async function waitForScrapedRefreshWorkflow(startedAt) {
  let latest = null;
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const status = await fetchApiJson(`api.php?action=workflow-status&target=paper-refresh&since=${encodeURIComponent(startedAt)}`);
    latest = (status.runs || []).find((run) => runMatchesStart(run, startedAt)) || null;
    if (latest?.status === "completed") return latest;
    await sleep(3000);
  }
  return latest;
}

// The scan runs on the runner, so it finishes whether or not this page is open.
// Only the waiting happens here, and it used to give up in about three minutes
// (64 attempts, 3s apart) -- shorter than a large scan -- and abort the whole run on
// a single failed poll. Both reported an error for a scan that was running fine.
//
// The budget is wall-clock rather than a poll count, because a backgrounded tab has
// its timers throttled to roughly one per minute: counting attempts spent the budget
// on far less real time exactly when the user had switched away.
async function waitForScrapedScanWorkflow(startedAt, { budgetMs = 25 * 60 * 1000 } = {}) {
  const deadline = Date.now() + budgetMs;
  let latest = null;
  let consecutiveFailures = 0;
  while (Date.now() < deadline) {
    try {
      const status = await fetchApiJson(`api.php?action=workflow-status&target=paper-scan&since=${encodeURIComponent(startedAt)}`);
      latest = (status.runs || []).find((run) => runMatchesStart(run, startedAt)) || latest;
      consecutiveFailures = 0;
      if (latest?.status === "completed") return latest;
      state.scrapedScanStatus = latest ? `Scan ${workflowStatusText(latest)}` : "Scan queued...";
    } catch {
      // A poll that fails says nothing about the run. Keep waiting; only give up on
      // the answer, never on the scan.
      consecutiveFailures += 1;
      state.scrapedScanStatus = `Scan running; status check failed ${consecutiveFailures}x, still waiting...`;
    }
    renderScrapedScanControls();
    await sleepUntilVisible(consecutiveFailures > 3 ? 15000 : 5000);
  }
  return latest;
}

function scanHistoryIds(scrapedState) {
  return new Set((Array.isArray(scrapedState?.marketScanHistory) ? scrapedState.marketScanHistory : [])
    .map((item) => String(item?.id || item?.runAt || ""))
    .filter(Boolean));
}

function newestScanTime(scrapedState) {
  const scanHistory = Array.isArray(scrapedState?.marketScanHistory) ? scrapedState.marketScanHistory : [];
  const times = [scrapedState?.marketScan?.lastScanAt, ...scanHistory.map((item) => item?.runAt)]
    .map((value) => Date.parse(value || ""))
    .filter((value) => Number.isFinite(value));
  return times.length ? Math.max(...times) : null;
}

// Compares the published state against the snapshot taken before the scan was
// dispatched, never against the browser clock. Every timestamp involved is written
// by the runner, so a browser running a few minutes fast or slow used to reject a
// publication that had plainly landed.
function scrapedScanWasPublishedAfter(scrapedState, baseline = {}) {
  const scanHistory = Array.isArray(scrapedState?.marketScanHistory)
    ? scrapedState.marketScanHistory
    : [];
  const previousScanIds = baseline.scanIds instanceof Set ? baseline.scanIds : new Set();
  if (scanHistory.some((item) => {
    const id = String(item?.id || item?.runAt || "");
    return id && !previousScanIds.has(id);
  })) {
    return true;
  }
  // No new id yet. A state replacement can still be recognised by its newest scan
  // timestamp moving forward relative to the pre-dispatch snapshot.
  const newest = newestScanTime(scrapedState);
  if (newest == null) return false;
  if (baseline.newestScanTime == null) return true;
  return newest > baseline.newestScanTime;
}

async function loadScrapeRunHistory({ reset = false } = {}) {
  if (state.scrapeHistoryBusy || (!reset && !state.scrapeHistoryHasMore)) return;
  const page = reset ? 0 : state.scrapeHistoryPage + 1;
  state.scrapeHistoryBusy = true;
  state.scrapeHistoryError = "";
  if (state.page === "opportunities" && state.opportunityView === "scan-log") renderScrapeRunLog();
  try {
    const payload = await fetchApiJson(`api.php?action=scan-history&page=${page}&page_size=100`);
    const incoming = Array.isArray(payload.records) ? payload.records : [];
    const merged = new Map((reset ? [] : state.scrapedMarketScanHistory)
      .map((item) => [String(item?.id || item?.runAt || ""), item])
      .filter(([key]) => key));
    incoming.forEach((item) => {
      const key = String(item?.id || item?.runAt || "");
      if (key) merged.set(key, item);
    });
    state.scrapedMarketScanHistory = [...merged.values()]
      .sort((a, b) => (Date.parse(b?.runAt || "") || 0) - (Date.parse(a?.runAt || "") || 0));
    state.scrapeHistoryPage = Number(payload.page ?? page);
    state.scrapeHistoryTotal = Number(payload.total ?? state.scrapedMarketScanHistory.length);
    state.scrapeHistoryHasMore = Boolean(payload.hasMore);
  } catch (error) {
    state.scrapeHistoryError = error?.message || "Scraping history could not be loaded.";
  } finally {
    state.scrapeHistoryBusy = false;
    if (state.page === "opportunities" && state.opportunityView === "scan-log") renderScrapeRunLog();
  }
}

function portfolioRunLogHistoryState(strategyId) {
  if (!strategyId) return null;
  if (!state.portfolioRunLogHistory[strategyId]) {
    state.portfolioRunLogHistory[strategyId] = { records: null, page: -1, total: 0, hasMore: false, busy: false, error: "" };
  }
  return state.portfolioRunLogHistory[strategyId];
}

// Every portfolio's runLog is capped in the live state (see PORTFOLIO_RUN_LOG_LIMIT in the
// bot), so "load more" pages back through the per-portfolio archive the paper-bot workflow
// appends to after every run -- the same shape as loadScrapeRunHistory, kept per strategy id
// so paging one portfolio's history never touches another's.
async function loadPortfolioRunLogHistory(strategyId, { reset = false } = {}) {
  const entry = portfolioRunLogHistoryState(strategyId);
  if (!entry || entry.busy || (!reset && entry.page >= 0 && !entry.hasMore)) return;
  const page = reset ? 0 : entry.page + 1;
  entry.busy = true;
  entry.error = "";
  rerenderRunLogInPlace();
  try {
    const payload = await fetchApiJson(`api.php?action=portfolio-run-log&strategy_id=${encodeURIComponent(strategyId)}&page=${page}&page_size=24`);
    const incoming = Array.isArray(payload.records) ? payload.records : [];
    const known = reset || !Array.isArray(entry.records)
      ? (state.botState?.paperPortfolios?.[strategyId]?.runLog || [])
      : entry.records;
    const merged = new Map(known.map((item) => [String(item?.runAt || ""), item]).filter(([key]) => key));
    incoming.forEach((item) => {
      const key = String(item?.runAt || "");
      if (key) merged.set(key, item);
    });
    entry.records = [...merged.values()].sort((a, b) => (Date.parse(b?.runAt || "") || 0) - (Date.parse(a?.runAt || "") || 0));
    entry.page = Number(payload.page ?? page);
    entry.total = Number(payload.total ?? entry.records.length);
    entry.hasMore = Boolean(payload.hasMore);
  } catch (error) {
    entry.error = error?.message || "Run log history could not be loaded.";
  } finally {
    entry.busy = false;
    rerenderRunLogInPlace();
  }
}

function publishedScanSummary(scrapedState, startedAt, selectedTag = "", previousScanIds = new Set()) {
  const startedAtMs = Date.parse(startedAt || "");
  const recentRuns = Array.isArray(scrapedState?.marketScanHistory)
    ? scrapedState.marketScanHistory
    : [];
  const run = recentRuns.find((item) => {
    const id = String(item?.id || item?.runAt || "");
    return id && !previousScanIds.has(id);
  }) || recentRuns.find((item) => {
    const runAt = Date.parse(item?.runAt || "");
    return Number.isFinite(runAt) && (!Number.isFinite(startedAtMs) || runAt >= startedAtMs - 180000);
  });
  const label = scrapedScanTagLabel(run?.scanTag || selectedTag || "all tags");
  if (!run) return `Updated ${formatDate(scrapedState?.marketScan?.lastScanAt || "")}`;
  // A failed scan now publishes a run of its own, so name what went wrong rather than
  // reporting the zero counts it recorded as though they were a result.
  const runError = String(run.error || "").trim();
  if (runError || String(run.status || "").toUpperCase() === "ERROR") {
    return `${label}: scan failed - ${runError || "no markets were scanned"}`;
  }
  const added = Number(run.newObservationCount || 0);
  const updated = Number(run.updatedObservationCount || 0);
  const retained = Number(run.retainedObservationCount || 0);
  return `${label}: ${formatInteger(added)} new / ${formatInteger(updated)} updated (${formatInteger(retained)} saved from this scan)`;
}

async function waitForScrapedScanPublication(baseline = {}) {
  let lastError = null;
  let lastState = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const scrapedState = await fetchJson("data/paper-state.json", { summary: "scraped" });
      lastError = null;
      lastState = scrapedState;
      if (scrapedScanWasPublishedAfter(scrapedState, baseline)) return { state: scrapedState, confirmed: true };
    } catch (error) {
      lastError = error;
    }
    state.scrapedScanStatus = "Publishing scan results...";
    renderScrapedScanControls();
    await sleep(2000);
  }
  if (lastError) throw lastError;
  // The workflow itself succeeded, so the scan did run and its data is on the way.
  // Returning the last readable state keeps the catalogue usable and reports a
  // wait rather than an error, which is what this used to get wrong.
  if (lastState) return { state: lastState, confirmed: false };
  throw new Error("The scan workflow finished, but no scraped state could be read afterwards.");
}

// A scan that fetches nothing now fails its workflow, but it publishes its history row
// first. Reading that row back turns "the workflow failed" into the actual reason.
async function publishedScanFailureReason(baseline = {}) {
  const previousScanIds = baseline.scanIds instanceof Set ? baseline.scanIds : new Set();
  try {
    const scrapedState = await fetchJson("data/paper-state.json", { summary: "scraped" });
    const runs = Array.isArray(scrapedState?.marketScanHistory) ? scrapedState.marketScanHistory : [];
    const run = runs.find((item) => {
      const id = String(item?.id || item?.runAt || "");
      return id && !previousScanIds.has(id);
    });
    const reason = String(run?.error || "").trim();
    return reason ? `Scan failed: ${reason}` : "";
  } catch {
    return "";
  }
}

async function triggerOneTimeMarketScan() {
  if (state.scrapedScanBusy) return;
  state.scrapedScanBusy = true;
  state.scrapedScanStatus = "Starting scan...";
  renderScrapedScanControls();
  let baseline = { scanIds: new Set(), newestScanTime: null };
  try {
    const before = await fetchJson("data/paper-state.json", { summary: "scraped" });
    baseline = { scanIds: scanHistoryIds(before), newestScanTime: newestScanTime(before) };
  } catch {
    // With no snapshot every published scan id counts as new, which is the safe
    // direction: the wait can only end early, never hang on a stale comparison.
  }
  const dispatchScan = async () => {
    await fetchApiJson("api.php?action=workflow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target: "paper-scan",
        market_scan_tag: state.scrapedScanTag,
        market_scan_liquidity_min: currentEvaluationLiquidityFilter(),
        market_scan_max_days: currentEvaluationDaysFilter(),
      }),
    });
  };
  let startedAt = new Date().toISOString();
  try {
    await dispatchScan();
    state.scrapedScanStatus = "Scan queued...";
    renderScrapedScanControls();
    let workflow = await waitForScrapedScanWorkflow(startedAt);
    // The scan shares a concurrency group with the paper bot because both publish
    // paper-state.json and must never overlap. In that group GitHub keeps one run
    // in progress and one pending, and evicts the pending one as soon as a third
    // is queued -- so a manual scan can be cancelled seconds after dispatch without
    // ever running. Nothing failed and nothing was scanned; the run just lost its
    // place in the queue, so take it again rather than reporting an error.
    if (workflow?.status === "completed" && workflow.conclusion === "cancelled") {
      state.scrapedScanStatus = "Scan was queued behind another job; re-queuing...";
      renderScrapedScanControls();
      startedAt = new Date().toISOString();
      await dispatchScan();
      workflow = await waitForScrapedScanWorkflow(startedAt);
    }
    if (!workflow || workflow.status !== "completed") {
      // Still running is not a failure. The runner will finish and publish on its
      // own, so say so and fall through to the publication check rather than
      // reporting an error for a scan that is working.
      state.scrapedScanStatus = "Scan is still running on the server; its results will appear when it publishes.";
      renderScrapedScanControls();
      const { state: pending, confirmed: pendingConfirmed } = await waitForScrapedScanPublication(baseline);
      if (pendingConfirmed) storeScrapedMarketState(pending, "scraped");
      if (state.page === "opportunities") renderBotEvaluations();
      else rerenderCurrentDashboard();
      return;
    }
    if (workflow.conclusion !== "success") {
      const reason = await publishedScanFailureReason(baseline);
      throw new Error(reason || `Scan workflow finished with ${workflow.conclusion || "an unknown error"}.`);
    }
    state.scrapedScanStatus = "Publishing scan results...";
    renderScrapedScanControls();
    const { state: refreshed, confirmed } = await waitForScrapedScanPublication(baseline);
    if (!storeScrapedMarketState(refreshed, "scraped")) {
      throw new Error("The refreshed scan response did not include scraped opportunities.");
    }
    state.scrapedScanStatus = confirmed
      ? publishedScanSummary(refreshed, startedAt, state.scrapedScanTag, baseline.scanIds)
      : "Scan completed. Its results are still being published; reload in a moment to see them.";
    if (state.page === "opportunities") renderBotEvaluations();
    else rerenderCurrentDashboard();
  } catch (error) {
    state.scrapedScanStatus = `Error: ${error?.message || "scan failed"}`;
  } finally {
    state.scrapedScanBusy = false;
    renderScrapedScanControls();
    if (state.page === "opportunities") renderBotEvaluations();
  }
}

async function triggerScrapedOpportunityRefresh(item) {
  const key = scrapedRefreshKey(item);
  const slug = String(item?.slug || item?.eventSlug || "").trim();
  if (!key || !slug || state.scrapedRefreshKeys.has(key)) return;

  state.scrapedRefreshKeys.add(key);
  state.scrapedRefreshErrors.delete(key);
  if (state.page === "opportunities" && (state.opportunityView === "scraped" || state.opportunityView === "scan-log")) renderBotEvaluations();

  const startedAt = new Date().toISOString();
  try {
    await fetchApiJson("api.php?action=workflow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target: "paper-refresh",
        refresh_market_slug: slug,
      }),
    });
    const workflow = await waitForScrapedRefreshWorkflow(startedAt);
    if (!workflow || workflow.status !== "completed") {
      throw new Error("Refresh is still queued in the background. Try again in a moment.");
    }
    if (workflow.conclusion !== "success") {
      throw new Error(`Refresh workflow finished with ${workflow.conclusion || "an unknown error"}.`);
    }
    const refreshed = await fetchJson("data/paper-state.json", { summary: "scraped" });
    storeScrapedMarketState(refreshed);
  } catch (error) {
    state.scrapedRefreshErrors.set(key, error?.message || "Could not refresh this Polymarket market.");
  } finally {
    state.scrapedRefreshKeys.delete(key);
    if (state.page === "opportunities" && (state.opportunityView === "scraped" || state.opportunityView === "scan-log")) renderBotEvaluations();
  }
}

async function loadLiveState(options = {}) {
  try {
    // Both live execution logs are loaded regardless of which tab is open: the split
    // between the two portfolios is decided by what 5050 placed, so the Live tab
    // needs 5050's log to know what is not its own.
    const [liveResult, botResult, executionResult, fixedEntryResult] = await Promise.allSettled([
      fetchJson("data/live-state.json"),
      fetchJson("data/paper-state.json", { summary: "portfolio-overview" }),
      fetchJson(liveExecutionStateFile(options.requestedMode || state.mode)),
      fetchJson("data/live-5050-execution-state.json"),
    ]);
    if (dashboardLoadIsStale(options) || !isLiveMode()) return;
    if (liveResult.status === "rejected") throw liveResult.reason;
    if (botResult.status === "fulfilled") {
      state.botState = botStateWithPreservedEvaluations(botResult.value);
      state.botStateFull = botStateIsFull(state.botState);
    }
    // Keyed by portfolio, because the two live portfolios keep separate run logs and
    // a failed fetch must not leave the other one's on screen. 5050's file does not
    // exist until its first run publishes one, so that fetch legitimately 404s -- and
    // keeping the previous value there meant 5050 displayed Live's execution history.
    const executionMode = normalizeMode(options.requestedMode || state.mode);
    state.liveExecutionByMode = state.liveExecutionByMode || cachedLiveExecutionByMode();
    if (executionResult.status === "fulfilled") {
      state.liveExecutionByMode[executionMode] = executionResult.value;
      rememberLiveExecutionState(executionMode, executionResult.value);
    } else if (!(executionMode in state.liveExecutionByMode)) {
      // No log of its own yet is "nothing to show", never "show the other one".
      state.liveExecutionByMode[executionMode] = null;
    }
    state.liveExecutionState = state.liveExecutionByMode[executionMode] || null;
    // Absent is not empty: a failed fetch must not silently reassign every 5050
    // position to the Live tab, so the last known log is kept.
    if (fixedEntryResult.status === "fulfilled") state.live5050ExecutionState = fixedEntryResult.value;
    const liveState = liveResult.value;
    renderLiveState(liveState);
    // CLOB open orders expose only token/condition IDs. Load the shared scraped
    // catalog in the background so opened-order rows can show their market,
    // outcome and resolution metadata instead of an incomplete placeholder.
    ensureScrapedMarketState(options);
    ensureCandidateBotState();
    ensureFullBotState(options);
    if (!options.skipAutoLiveSync) {
      requestLiveAccountSync();
    }
    if (botResult.status === "rejected") {
      els.botEvaluations.innerHTML = `<div class="empty">Common evaluation log is not available: ${escapeHtml(botResult.reason?.message || String(botResult.reason))}</div>`;
    }
  } catch (error) {
    if (dashboardLoadIsStale(options) || !isLiveMode()) return;
    if (state.liveState) {
      rememberStateFetchError("live", error);
      renderLiveState(state.liveState);
      return;
    }
    state.liveExecutionState = null;
    syncModeUi();
    if (els.botAction) els.botAction.textContent = "offline";
    if (els.botInlineAction) els.botInlineAction.textContent = "offline";
    els.portfolioEquity.textContent = "-";
    els.portfolioLastRun.textContent = "Live sync not available";
    els.portfolioTotalPl.textContent = "-";
    els.portfolioTotalPlPct.textContent = "-";
    if (els.portfolioAnnualized) els.portfolioAnnualized.textContent = "-";
    if (els.portfolioPeriod) els.portfolioPeriod.textContent = "No live data";
    els.portfolioRealized.textContent = "-";
    els.portfolioRealizedPct.textContent = "-";
    renderClosedAccuracy([]);
    els.portfolioOpenPl.textContent = "-";
    els.portfolioOpenPlPct.textContent = "-";
    els.portfolioRisk.textContent = "-";
    els.portfolioFree.textContent = "-";
    if (els.accountSummary) {
      els.accountSummary.hidden = false;
      els.accountSummary.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
    }
    els.botStatus.innerHTML = "";
    els.botStatus.hidden = true;
    els.botTrades.innerHTML = '<div class="empty">Live Polymarket account state is not available yet.</div>';
    if (els.closedTrades) els.closedTrades.innerHTML = '<div class="empty">Closed live trades are not available yet.</div>';
    if (els.closedSummary) els.closedSummary.textContent = "offline";
    if (state.botState) {
      renderBotEvaluations();
    } else {
      els.botEvaluations.innerHTML = '<div class="empty">Common evaluation log is not available yet.</div>';
    }
  }
}

async function loadDashboardState(options = {}) {
  const requestedMode = normalizeMode(state.mode);
  const requestId = ++state.dashboardLoadSeq;
  syncModeUi();
  renderKnownStateForMode(requestedMode);
  if (!state.portfolioConfig) {
    await loadPortfolioConfig();
    if (dashboardLoadIsStale({ requestId, requestedMode })) return;
  }
  return LIVE_MODES.has(requestedMode)
    ? loadLiveState({ ...options, requestId, requestedMode })
    : loadBotState({ ...options, requestId, requestedMode });
}

function paperPortfolioList(botState) {
  const portfolios = botState?.paperPortfolios && typeof botState.paperPortfolios === "object"
    ? Object.values(botState.paperPortfolios)
    : [];
  if (portfolios.length) return portfolios;
  return [{
    id: "conservative",
    label: "Conservative",
    selectionMetric: "EV p.a.",
    description: "Prioritizes eligible opportunities by EV p.a. and expected value.",
    portfolio: botState?.portfolio || {},
    trades: Array.isArray(botState?.trades) ? botState.trades : [],
    lastDecision: botState?.lastDecision || null,
  }];
}

function selectedPaperPortfolio(botState) {
  const portfolios = paperPortfolioList(botState);
  const strategyId = paperStrategyIdFromMode();
  if (!strategyId) return portfolios[0] || {};
  const found = portfolios.find((item) => item.id === strategyId);
  if (found) return found;
  // A portfolio just created has no entry in the bot's state until it runs once -- the
  // dashboard only saves its config. Falling back to portfolios[0] here handed a brand
  // new portfolio Conservative's entire live state (equity, trades, run log) instead of
  // the fresh, empty one it actually has; every render fallback below (?? 100, || 0,
  // empty arrays) already renders this correctly once it is not silently someone else's.
  const config = portfolioConfigForMode(`paper-${strategyId}`) || {};
  return {
    id: strategyId,
    label: normalizePortfolioName(config.displayName, strategyId),
    description: "",
    selectionMetric: "",
    portfolio: {},
    trades: [],
    runLog: [],
    lastDecision: null,
  };
}

function paperPortfolioTrades(portfolioState) {
  return (Array.isArray(portfolioState?.trades) ? portfolioState.trades : [])
    .map((trade) => ({
      ...trade,
      strategyId: trade.strategyId || portfolioState.id,
      strategyLabel: trade.strategyLabel || portfolioState.label,
    }));
}

function stakeSizingRuleValue(mode, portfolio = {}) {
  const normalizedMode = normalizeMode(mode);
  const config = portfolioConfigForMode(normalizedMode);
  const stake = normalizeRiskAllocation(config.stakeUsdc) ?? DEFAULT_RISK_ALLOCATION;
  return `${money(stake)} fixed per trade`;
}

function portfolioRuleRows(portfolio = {}) {
  const mode = portfolio.id ? paperModeFromStrategyId(portfolio.id) : state.mode;
  const config = portfolioConfigForMode(mode);
  const threshold = thresholdForMode(mode);
  const maxResolutionDays = resolutionDaysForMode(mode);
  const minLiquidityUsdc = Number(config.minLiquidityUsdc);
  const minNetYield = normalizeMinimumNetYield(config.minNetYield);
  const returnMetric = portfolioReturnMetricLabel(config);
  const priority = config.selectionOrder === "highest_reward_risk_first"
    ? `Highest reward/risk, then shorter resolution and ${returnMetric}`
    : `Highest ${returnMetric}, then shorter resolution and net gain`;
  const resolution = `Max ${maxResolutionDays.toLocaleString("en-US", { maximumFractionDigits: 0 })} days`;
  const rows = [
    ["Probability threshold", `${probabilitySourceLabel(config.probabilitySource)} >= ${percent(threshold)}`],
    ["Stake sizing", stakeSizingRuleValue(mode, portfolio)],
    ["Resolution filter", resolution],
    ["Trade priority", priority],
    ["Market type", portfolioMarketTypeLabel(config.marketType)],
    ["Execution trigger", normalizeExecutionTrigger(config.executionTrigger) === "cron"
      ? `${executionTriggerLabel(config.executionTrigger)} · ${executionCronMinutesLabel(config.executionCronMinutes)}`
      : executionTriggerLabel(config.executionTrigger)],
  ];
  if (Number.isFinite(minLiquidityUsdc)) rows.push(["Volume filter", `>= ${money(minLiquidityUsdc)}`]);
  rows.push(["Minimum net profit", `>= ${percent(minNetYield)} after fees`]);
  rows.push(["Rotation", automaticRotationIsEnabled(config) ? "On" : "Off"]);
  // Any paper portfolio can turn this on now; Equal is only where it ships enabled.
  rows.push(["Stop loss", stopLossRiskLabel(config)]);
  // The parameter modal already saves this for paper portfolios (the checkbox has no
  // paper-only hide), but this card never showed it -- reading like the setting was
  // live-only, when it is only this row that was missing.
  rows.push(["Order mode", config.useLimitOrders ? "Limit orders" : "Market orders"]);
  // Only when something is actually excluded: a row reading "none" on every portfolio
  // that never touched the setting is noise in a list meant to be read at a glance.
  const includeOnlyTags = normalizeMarketTagList(config.includeOnlyMarketTags);
  const excludedTags = normalizeMarketTagList(config.excludedMarketTags);
  if (includeOnlyTags.length) rows.push(["Included tags", includeOnlyTags.join(", ")]);
  else if (excludedTags.length) rows.push(["Excluded tags", excludedTags.join(", ")]);
  return rows;
}

function livePortfolioRuleRows() {
  // Both live portfolios render through here, so the rules shown must be the ones
  // the open tab is actually steered by.
  const mode = isFixedEntryMode() ? "live-5050" : "live";
  const config = portfolioConfigForMode(mode);
  const useLimitOrders = config.useLimitOrders === true;
  const maxResolutionDays = resolutionDaysForMode(mode);
  const minLiquidityUsdc = normalizeOptionalMoney(config.minLiquidityUsdc);
  const minNetYield = normalizeMinimumNetYield(config.minNetYield);
  const includeOnlyTags = normalizeMarketTagList(config.includeOnlyMarketTags);
  const excludedTags = normalizeMarketTagList(config.excludedMarketTags);
  const returnMetric = portfolioReturnMetricLabel(config);
  const priority = config.selectionOrder === "highest_reward_risk_first"
    ? `Highest reward/risk, then shorter resolution and ${returnMetric}`
    : `Highest ${returnMetric}, then shorter resolution and net gain`;
  return [
    ["Probability threshold", `${probabilitySourceLabel(config.probabilitySource)} >= ${percent(currentEligibilityThreshold())}`],
    ["Stake sizing", stakeSizingRuleValue("live", state.liveState?.portfolio)],
    ["Resolution filter", `Max ${maxResolutionDays} days`],
    ["Trade priority", priority],
    ["Market type", portfolioMarketTypeLabel(config.marketType)],
    ["Execution trigger", normalizeExecutionTrigger(config.executionTrigger) === "cron"
      ? `${executionTriggerLabel(config.executionTrigger)} · ${executionCronMinutesLabel(config.executionCronMinutes)}`
      : executionTriggerLabel(config.executionTrigger)],
    // Both portfolios state their order price. 5050's is a setting; the live portfolio's
    // is taken from the book, and saying so is what stops the row's absence reading as a
    // parameter that failed to display -- which is how it was reported.
    ["Order price", isFixedEntryMode()
      ? `every qualifying candidate is bid at ${percent(normalizeFixedEntryPrice(config.fixedEntryPrice))}`
      : (useLimitOrders
        ? "taken from the book: rested at the best bid, not a configured price"
        : "taken from the book: bought at the market ask, not a configured price")],
    ...(isFixedEntryMode() ? [
      ["Tag filter", normalizeMarketTagList(config.allowedMarketTags).join(", ") || "every tag"],
    ] : []),
    // Shown only when set, for the same reason as on the paper dashboards.
    ...(includeOnlyTags.length ? [["Included tags", includeOnlyTags.join(", ")]] : (excludedTags.length ? [["Excluded tags", excludedTags.join(", ")]] : [])),
    ["Volume filter", minLiquidityUsdc == null ? "none" : `>= ${money(minLiquidityUsdc)}`],
    ["Minimum net profit", `>= ${percent(minNetYield)} after fees`],
    ["Rotation", automaticRotationIsEnabled(config) ? "On" : "Off"],
    ["Order mode", useLimitOrders ? "Limit orders" : "Market orders"],
    ["Cross-live risk", systemConfig().crossLivePortfolioRiskDiversification !== false ? "Block correlated exposure" : "Allow correlated exposure"],
  ];
}

function evaluationUpdateMs(item) {
  return Math.max(
    Date.parse(item?.evaluatedAt || "") || 0,
    Date.parse(item?.lastSeenAt || "") || 0,
    Date.parse(item?.observedAt || "") || 0,
    Date.parse(item?.marketDataUpdatedAt || "") || 0,
    Date.parse(item?.updatedAt || "") || 0,
    Date.parse(item?.executionRevalidation?.checkedAt || "") || 0,
  );
}

// The execution run's own verdict, straight from live-execution-state.json.
//
// A verdict also gets merged back into the scraped rows as `executionRevalidation`, but
// that path is a read-modify-write of a large file over FTP that the market scan writes
// too, so an update can be lost to a concurrent upload or land on a row the scan has
// since replaced with a newer `evaluatedAt` -- and then the shortlist quietly shows a
// market as READY that execution has already rejected. This state is written and
// uploaded by the execution run itself, so it needs neither the merge nor luck.
function liveExecutionVerdictByToken() {
  const updates = Array.isArray(state.liveExecutionState?.revalidationUpdates)
    ? state.liveExecutionState.revalidationUpdates
    : [];
  const byToken = new Map();
  for (const update of updates) {
    const token = String(update?.tokenId || "").trim();
    if (!token) continue;
    const previous = byToken.get(token);
    if (previous && (Date.parse(previous.checkedAt || "") || 0) > (Date.parse(update.checkedAt || "") || 0)) continue;
    byToken.set(token, update);
  }
  return byToken;
}

// Whose verdict this is. Both live portfolios persist their revalidation onto the same
// evaluation rows, so a verdict has to say which one made it or they read each other's --
// and what one portfolio cannot execute the other often can, because they price
// differently, size differently, and hold different cash.
//
// An unstamped verdict is from before the field existed. It is ignored rather than
// guessed at: honouring it keeps a possibly foreign rejection sticky forever, while
// ignoring it costs at most one run, after which the portfolio has stamped its own.
function executionVerdictIsOwn(verdict, mode) {
  if (!verdict) return false;
  const owner = String(verdict.portfolio || "");
  return owner === (isFixedEntryMode(mode) ? "live-5050" : "live");
}

function latestLiveExecutionVerdict(item, mode = state.mode) {
  const merged = item?.executionRevalidation && typeof item.executionRevalidation === "object"
    && executionVerdictIsOwn(item.executionRevalidation, mode)
    ? item.executionRevalidation
    : null;
  const token = String(item?.tokenId || item?.clobTokenId || item?.assetId || "").trim();
  const published = token ? liveExecutionVerdictByToken().get(token) || null : null;
  if (!merged) return published;
  if (!published) return merged;
  return (Date.parse(published.checkedAt || "") || 0) >= (Date.parse(merged.checkedAt || "") || 0)
    ? published
    : merged;
}

function latestUniquePortfolioEvaluations(evaluations = []) {
  const byKey = new Map();
  const ordered = [...evaluations].sort((a, b) => evaluationUpdateMs(b) - evaluationUpdateMs(a));
  for (const item of ordered) {
    const key = String(item?.tokenId || item?.clobTokenId || item?.assetId || item?.id || opportunityKey(item) || "");
    if (!key || byKey.has(key)) continue;
    byKey.set(key, item);
  }
  return [...byKey.values()];
}

function mergeCurrentMarketEconomics(evaluations = [], observations = []) {
  const byToken = new Map(
    (Array.isArray(observations) ? observations : [])
      .map((item) => [String(item?.tokenId || item?.clobTokenId || item?.assetId || ""), item])
      .filter(([token, item]) => token && item),
  );
  if (!byToken.size) return evaluations;

  return (Array.isArray(evaluations) ? evaluations : []).map((item) => {
    const token = String(item?.tokenId || item?.clobTokenId || item?.assetId || "");
    const fresh = byToken.get(token);
    if (!fresh) return item;

    const current = { ...item };
    const copyIfPresent = (key) => {
      if (fresh[key] != null && fresh[key] !== "") current[key] = fresh[key];
    };
    [
      "marketProbability",
      "marketPrice",
      "bestAsk",
      "bestBid",
      "spread",
      "slippage",
      "liquidity",
      "volume24hr",
      "endDate",
      "scheduledEventDate",
      "resolutionEndDate",
      "daysToResolution",
      "marketDataUpdatedAt",
      "observedAt",
      "feeRate",
    ].forEach(copyIfPresent);

    const cost = evaluationTotalCost(current);
    const shares = evaluationShares(current);
    const win = gainIfWin(current);
    const marketValue = marketExpectedValueFromQuote(current);
    const aiValue = expectedValue(current);
    const days = daysToResolution(current);
    const yieldValue = Number.isFinite(win) && Number.isFinite(cost) && cost > 0 ? win / cost : null;
    const rewardRisk = Number.isFinite(win) && Number.isFinite(cost) && cost > 0 && win > 0 ? win / cost : null;
    const annualized = Number.isFinite(aiValue) && Number.isFinite(cost) && cost > 0
      ? annualizeReturn(aiValue / cost, days)
      : null;
    const marketRoi = Number.isFinite(marketValue) && Number.isFinite(cost) && cost > 0 ? marketValue / cost : null;
    const marketAnnualized = Number.isFinite(marketRoi)
      ? annualizeReturn(marketRoi, days)
      : null;
    const potentialAnnualized = Number.isFinite(yieldValue)
      ? annualizeReturn(yieldValue, days)
      : null;

    return {
      ...current,
      executableShares: Number.isFinite(shares) ? Number(shares.toFixed(6)) : current.executableShares,
      totalCostUsdc: Number.isFinite(cost) ? Number(cost.toFixed(5)) : current.totalCostUsdc,
      netGainIfWinUsdc: Number.isFinite(win) ? Number(win.toFixed(5)) : current.netGainIfWinUsdc,
      netYield: Number.isFinite(yieldValue) ? Number(yieldValue.toFixed(6)) : current.netYield,
      riskReward: Number.isFinite(rewardRisk) ? Number(rewardRisk.toFixed(6)) : current.riskReward,
      expectedValueUsdc: Number.isFinite(aiValue) ? Number(aiValue.toFixed(5)) : current.expectedValueUsdc,
      annualizedReturn: Number.isFinite(annualized) ? Number(annualized.toFixed(6)) : current.annualizedReturn,
      marketExpectedValueUsdc: Number.isFinite(marketValue) ? Number(marketValue.toFixed(5)) : current.marketExpectedValueUsdc,
      marketExpectedRoi: Number.isFinite(marketRoi) ? Number(marketRoi.toFixed(6)) : current.marketExpectedRoi,
      marketAnnualizedReturn: Number.isFinite(marketAnnualized) ? Number(marketAnnualized.toFixed(6)) : current.marketAnnualizedReturn,
      potentialAnnualizedReturn: Number.isFinite(potentialAnnualized) ? Number(potentialAnnualized.toFixed(6)) : current.potentialAnnualizedReturn,
    };
  });
}

function candidateMarketType(item = {}) {
  const storedType = normalizeScrapedMarketType(item.marketType);
  if (storedType !== "all") return storedType;
  const question = String(item.question || "");
  const slug = String(item.eventSlug || item.slug || "");
  if (/(^|[-\s])(exact-score|correct-score|winner|group-winner|nominee|award|primary|election)([-\s]|$)/i.test(`${slug} ${question}`)) {
    return "multi";
  }
  if (/^(which|who|what|how many)\b/i.test(question)) return "multi";
  if (/^(yes|no)$/i.test(String(item.outcome || "")) && /^(will|is|are|can|does|do|did|has|have|was|were)\b/i.test(question)) {
    return "binary";
  }
  return "multi";
}

function scrapedMarketType(item = {}) {
  return candidateMarketType(item);
}

// Traded volume, the figure Polymarket shows on a market ("$37.9K Vol."). Gamma's
// `liquidity` is order-book depth -- a different number, which is why the tables never
// matched the site. `liquidity` remains the last fallback so rows stored before volume
// was captured keep showing something until they are refreshed.
function rowVolumeUsdc(item = {}) {
  for (const candidate of [item?.volumeUsdc, item?.volume24hr, item?.firstVolume24hr, item?.liquidity]) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
  }
  return 0;
}

function firstScrapedVolumeUsdc(item = {}) {
  for (const candidate of [item?.firstVolumeUsdc, item?.firstVolume24hr, item?.volumeUsdc, item?.volume24hr, item?.firstLiquidity, item?.liquidity]) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric) && numeric >= 0) return numeric;
  }
  return null;
}

function resolvedScrapedVolumeUsdc(item = {}) {
  for (const candidate of [item?.resolvedVolumeUsdc, item?.resolvedVolume24hr]) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric) && numeric >= 0) return numeric;
  }
  return null;
}

function scrapedVolumeCell(item = {}) {
  const first = firstScrapedVolumeUsdc(item);
  if (scrapedObservationStatus(item) !== "RESOLVED") return money(first ?? rowVolumeUsdc(item));
  const resolved = resolvedScrapedVolumeUsdc(item);
  if (!Number.isFinite(resolved)) {
    return `<strong>${money(first ?? rowVolumeUsdc(item))}</strong><span>scraped; resolution snapshot unavailable</span>`;
  }
  return `<strong>${money(resolved)}</strong><span>resolved; scraped ${money(first ?? 0)}</span>`;
}

function portfolioCandidateFilterReasons(item, mode = state.mode) {
  const config = portfolioConfigForMode(mode);
  const normalizedMode = normalizeMode(mode);
  const reasons = [];
  const storedStatus = String(item.status || "").toUpperCase();
  const displayStatus = portfolioEvaluationStatus(item);
  const probabilitySource = normalizeProbabilitySource(config.probabilitySource);
  const selectedProbability = portfolioProbability(item, config);
  const maxDays = resolutionDaysForMode(normalizedMode);
  const days = evaluationDaysLeft(item);
  const liquidity = rowVolumeUsdc(item);
  const minLiquidity = normalizeOptionalMoney(config.minLiquidityUsdc);
  const minNetYield = normalizeMinimumNetYield(config.minNetYield);
  const threshold = normalizeEligibilityThreshold(config.minProbability) ?? thresholdDefaultForMode(normalizedMode);
  const annualizedReturn = portfolioAnnualizedReturn(item, config);
  const returnMetric = portfolioReturnMetricLabel(config);
  const aiPending = item.selectionStatus === "AI_PENDING" || item.aiAnalysis?.aiModelStatus === "QUOTA_LIMITED";
  const executionCheck = latestLiveExecutionVerdict(item, mode);
  // A re-scrape used to invalidate the execution verdict, because a newer `evaluatedAt`
  // made it look stale. But a scrape only refreshes Gamma's listing: it cannot know that
  // the market is gone from Gamma, that the book has no usable ask, or that live
  // liquidity is a fraction of the listed figure -- those are exactly what execution
  // measured. So the verdict stands until execution itself replaces it, and only a
  // retryable one (capital, diversification) lets the row back into the shortlist.
  const executionCheckIsCurrent = Boolean(executionCheck);

  // Above every mode-specific rule, and above 5050's early return, because a tag policy
  // disqualifies the market whatever else is true of it. A whitelist wins over exclusion.
  const includeOnlyTags = normalizeMarketTagList(config.includeOnlyMarketTags);
  const excludedTags = normalizeMarketTagList(config.excludedMarketTags);
  if (includeOnlyTags.length && !marketMatchesAllowedTags(item, includeOnlyTags)) {
    reasons.push(`outside included tags (${includeOnlyTags.join(", ")})`);
  } else {
    const hitExclusions = marketExcludedByTags(item, excludedTags);
    if (hitExclusions.length) {
      reasons.push(`excluded tag${hitExclusions.length > 1 ? "s" : ""} ${hitExclusions.join(", ")}`);
    }
  }

  if (displayStatus !== "EVALUATED") reasons.push(`status ${displayStatus}`);
  if (probabilitySource === "ai" && normalizedMode !== "live" && storedStatus !== "ELIGIBLE") {
    reasons.push(`base status ${storedStatus || "UNKNOWN"} is not ELIGIBLE`);
  }
  if (probabilitySource === "polymarket" && ["ERROR", "RESOLVED", "CLOSED", "FINALIZED", "SETTLED"].includes(storedStatus)) {
    reasons.push(`base status ${storedStatus || "UNKNOWN"} is not executable`);
  }
  if (binarySideQuoteIsStale(item)) {
    reasons.push("binary YES/NO side changed and its quote is being refreshed");
  }
  if (marketProbabilityRoundsToCertain(item)) {
    reasons.push("market probability rounds to 100.0%; no executable upside remains");
  }
  if (!Number.isFinite(selectedProbability)) {
    reasons.push(`missing ${probabilitySourceLabel(probabilitySource).toLowerCase()}`);
  } else if (selectedProbability < threshold) {
    reasons.push(`${probabilitySourceLabel(probabilitySource)} ${probability(selectedProbability)} below ${probability(threshold)}`);
  }
  // 5050 does not buy at the market, it rests a bid at a fixed price, so the
  // market-price economics below are the wrong test: a candidate trading at 95c has
  // a poor yield if bought there and an excellent one if filled at 50c. What decides
  // it is whether the market is still above the entry price -- the same rule the
  // executor applies -- so the shortlist and the run agree on who qualifies.
  if (isFixedEntryMode(mode)) {
    const entryPrice = normalizeFixedEntryPrice(config.fixedEntryPrice);
    const allowedTags = normalizeMarketTagList(config.allowedMarketTags);
    if (allowedTags.length && !marketMatchesAllowedTags(item, allowedTags)) {
      reasons.push(`outside this portfolio's tags (${allowedTags.join(", ")})`);
    }
    const ask = Number(item.bestAsk ?? item.marketPrice ?? item.marketProbability);
    if (Number.isFinite(ask) && ask <= entryPrice) {
      reasons.push(`already asks ${probability(ask)}, at or below the ${probability(entryPrice)} entry price`);
    }
    if (Number.isFinite(minLiquidity) && liquidity < minLiquidity) {
      reasons.push(`volume ${money(liquidity)} below ${money(minLiquidity)}`);
    }
    if (Number.isFinite(days) && Number.isFinite(maxDays) && days > maxDays) {
      reasons.push(`resolves in ${compactDays(days)}, beyond ${maxDays} days`);
    }
    if (Number.isFinite(days) && days <= 0) reasons.push("event end date is in the past");
    return reasons;
  }
  if (!Number.isFinite(annualizedReturn)) {
    reasons.push(`missing usable ${returnMetric}`);
  } else if (annualizedReturn <= 0) {
    reasons.push(`${returnMetric} ${signedPercent(annualizedReturn)} is non-profitable after fees`);
  } else if (probabilitySource !== "polymarket" && annualizedReturn < MIN_PORTFOLIO_EV_PA) {
    reasons.push(`${returnMetric} ${signedPercent(annualizedReturn)} below ${signedPercent(MIN_PORTFOLIO_EV_PA)}`);
  }
  const candidateNetYield = netYield(item);
  if (!Number.isFinite(candidateNetYield) || candidateNetYield < minNetYield) {
    reasons.push(`net profit ${Number.isFinite(candidateNetYield) ? signedPercent(candidateNetYield) : "-"} below ${percent(minNetYield)} after fees`);
  }
  if (probabilitySource === "ai" && aiPending) reasons.push("grounded Gemini analysis is pending");
  // A live execution verdict can be temporary: capital or diversification may
  // block this run while the same market remains a valid future candidate.
  // Keep those rows in the shortlist so the next run can retry them after the
  // blocking condition changes. Permanent market/quote failures still filter
  // the row out here.
  if (executionCheckIsCurrent && String(executionCheck.status || "").toUpperCase() !== "READY" && !executionCheck.retryable) {
    const detail = Array.isArray(executionCheck.rejectReasons) && executionCheck.rejectReasons[0]
      ? `: ${executionCheck.rejectReasons[0]}`
      : "";
    reasons.push(`latest live revalidation ${String(executionCheck.status || "REJECTED").toLowerCase()}${detail}`);
  }
  if (!Number.isFinite(days)) {
    reasons.push("missing resolution date");
  } else if (days <= 0 && String(item.endDateSource || "") !== "sports-event-start") {
    // Its own resolution window has passed, so it cannot be opened: evaluation already
    // reports "event end date is in the past" and rejects it. Listing it anyway meant a
    // shortlist of finished fixtures and a run that could only skip.
    //
    // A sports row whose date is the kickoff is deliberately excluded from this: past
    // kickoff means the match is in play, not over, and those stay tradable. The live
    // market check is what retires them.
    reasons.push("event end date is in the past");
  } else if (days > maxDays) {
    reasons.push(`resolution ${days.toFixed(2)} days exceeds max ${maxDays}`);
  }
  if (minLiquidity != null && liquidity < minLiquidity) {
    reasons.push(`volume ${money(liquidity)} below ${money(minLiquidity)}`);
  }
  const requiredMarketType = normalizePortfolioMarketType(config.marketType, config.requireMostProbableOutcome);
  if (requiredMarketType !== "all" && candidateMarketType(item) !== requiredMarketType) {
    reasons.push(`market type ${portfolioMarketTypeLabel(candidateMarketType(item))} does not match ${portfolioMarketTypeLabel(requiredMarketType)}`);
  }
  return reasons;
}

function activeExposureRowsForMode(mode = state.mode) {
  if (LIVE_MODES.has(normalizeMode(mode))) {
    return [
      ...livePositions(state.liveState),
      ...liveOpenOrders(state.liveState),
    ].map((row) => {
      const metadata = liveMarketMetadataForTrade(row);
      if (!metadata) return row;
      return {
        ...metadata,
        ...row,
        question: row.question || metadata.question || "",
        outcome: row.outcome || metadata.outcome || "",
        slug: row.slug || metadata.slug || "",
        eventSlug: row.eventSlug || metadata.eventSlug || metadata.slug || "",
        riskGroupKeys: Array.isArray(row.riskGroupKeys) && row.riskGroupKeys.length
          ? row.riskGroupKeys
          : metadata.riskGroupKeys,
      };
    });
  }
  const portfolioState = selectedPaperPortfolio(state.botState || {});
  return paperPortfolioTrades(portfolioState).filter((trade) => !isClosedTrade(trade));
}

function normalizedRiskSlug(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function eventRiskKey(value) {
  const slug = normalizedRiskSlug(value);
  if (!slug) return "";
  // Polymarket often appends a time or an outcome suffix to one event family.
  return slug.replace(/-20\d{2}-\d{2}-\d{2}(?:-.*)?$/, "");
}

function inferredRiskKeysForRow(row) {
  const slug = normalizedRiskSlug(row?.slug);
  const eventSlug = normalizedRiskSlug(row?.eventSlug || row?.eventId);
  const eventKey = eventRiskKey(row?.eventSlug || row?.slug);
  const text = normalizedRiskSlug(`${row?.question || ""} ${row?.slug || ""} ${row?.eventSlug || ""}`).replace(/-/g, " ");
  const keys = new Set();
  if (slug) keys.add(`market:${slug}`);
  if (eventSlug) keys.add(`event:${eventSlug}`);
  if (eventKey) keys.add(`event:${eventKey}`);
  if (/\b(bitcoin|btc)\b/.test(text)) keys.add("topic:bitcoin");
  if (/\b(ethereum|ether|eth)\b/.test(text)) keys.add("topic:ethereum");
  if (/\bsolana\b/.test(text)) keys.add("topic:solana");
  if (/\b(xrp|ripple)\b/.test(text)) keys.add("topic:xrp");
  if (/\b(iran|iranian|hormuz|kharg|strait of hormuz|israel|israeli|tehran|nuclear)\b/.test(text)) {
    keys.add("topic:iran-war");
  }
  const fed = text.match(/\b(fed|federal reserve|interest rates?|rate cut|rate hike|bps|fomc)\b/);
  if (fed) {
    const month = text.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/)?.[1] || "meeting";
    const year = text.match(/\b(20\d{2})\b/)?.[1] || "";
    keys.add(`topic:fed-${month}${year ? `-${year}` : ""}`);
  }
  return [...keys];
}

function riskKeysForRow(row, evaluationByToken = new Map()) {
  const token = String(row?.tokenId || row?.assetId || row?.asset || "");
  const evaluation = token ? evaluationByToken.get(token) : null;
  const direct = Array.isArray(row?.riskGroupKeys) ? row.riskGroupKeys : [];
  const evaluated = Array.isArray(evaluation?.riskGroupKeys) ? evaluation.riskGroupKeys : [];
  return [...new Set([
    ...direct.map(String),
    ...evaluated.map(String),
    ...inferredRiskKeysForRow(row),
  ].filter(Boolean))];
}

function candidateRiskBlockReason(item, activeRows = [], evaluationByToken = new Map()) {
  const token = String(item?.tokenId || item?.assetId || "");
  const keys = new Set(riskKeysForRow(item, evaluationByToken));
  for (const row of activeRows) {
    const rowToken = String(row?.tokenId || row?.assetId || row?.asset || "");
    if (token && rowToken && token === rowToken) return "duplicate token already open";
    const overlap = riskKeysForRow(row, evaluationByToken).filter((key) => keys.has(key));
    const sameEventOrMatch = overlap.filter((key) => key.startsWith("event:") || key.startsWith("match:"));
    if (sameEventOrMatch.length) return `same event or match already open: ${sameEventOrMatch.slice(0, 2).join(", ")}`;
    if (overlap.length) return `risk overlap: ${overlap.slice(0, 3).join(", ")}`;
  }
  return "";
}

function portfolioCandidateSortValue(item, key, mode = state.mode) {
  const config = portfolioConfigForMode(mode);
  if (key === "riskReward") return evaluationRiskReward(item) ?? -Infinity;
  if (key === "annualizedReturn") return portfolioAnnualizedReturn(item, config) ?? -Infinity;
  if (key === "expectedValue") return portfolioExpectedValue(item, config) ?? -Infinity;
  if (key === "aiProbability") return Number(item.aiProbability);
  if (key === "days") return evaluationDaysLeft(item);
  return 0;
}

function sortPortfolioCandidates(rows = [], mode = state.mode) {
  const config = portfolioConfigForMode(mode);
  const primary = config.selectionOrder === "highest_reward_risk_first" ? "riskReward" : "annualizedReturn";
  const sorted = [...rows].sort((a, b) => {
    const aPrimary = portfolioCandidateSortValue(a, primary, mode);
    const bPrimary = portfolioCandidateSortValue(b, primary, mode);
    if (bPrimary !== aPrimary) return bPrimary - aPrimary;
    const aDays = portfolioCandidateSortValue(a, "days", mode);
    const bDays = portfolioCandidateSortValue(b, "days", mode);
    if (Number.isFinite(aDays) && Number.isFinite(bDays) && aDays !== bDays) return aDays - bDays;
    const aEv = portfolioCandidateSortValue(a, "expectedValue", mode);
    const bEv = portfolioCandidateSortValue(b, "expectedValue", mode);
    if (bEv !== aEv) return bEv - aEv;
    return (Date.parse(b.evaluatedAt || "") || 0) - (Date.parse(a.evaluatedAt || "") || 0);
  });
  return [
    ...sorted.filter((item) => !item.portfolioRiskBlockReason),
    ...sorted.filter((item) => item.portfolioRiskBlockReason),
  ];
}

function portfolioCandidateDiagnostics(mode = state.mode) {
  const config = portfolioConfigForMode(mode);
  const baseEvaluations = Array.isArray(state.botState?.evaluations) ? state.botState.evaluations : [];
  const usesPolymarketProbability = normalizeProbabilitySource(config.probabilitySource) === "polymarket";
  const scrapedObservations = usesPolymarketProbability
    ? scrapedMarketObservations()
    : [];
  // A Polymarket-probability portfolio must use only scraped order-book data.
  // Mixing in AI evaluations makes the visible shortlist disagree with live execution.
  const evaluations = latestUniquePortfolioEvaluations(usesPolymarketProbability ? scrapedObservations : baseEvaluations);
  const evaluationByToken = new Map(evaluations.map((item) => [String(item.tokenId || ""), item]).filter(([token]) => token));
  // 5050 bids the whole qualifying set at once, so it must see every order already
  // working -- not only the ones attributed to it. Attribution comes from its run
  // log, which does not exist until its first run publishes one, so checking against
  // it left the exposure set empty and every candidate reading READY however many
  // bids were resting. The executor checks the raw wallet for exactly this reason: a
  // duplicate is a duplicate however it got there. Matching that here also makes the
  // event rule visible, since one bid per event means the other sub-markets of that
  // event are different tokens and only collide on the event key.
  const activeRows = isFixedEntryMode(mode)
    ? [
      ...(Array.isArray(state.liveState?.positions) ? state.liveState.positions : []),
      ...(Array.isArray(state.liveState?.openOrders) ? state.liveState.openOrders : []),
    ].map((row) => {
      const metadata = liveMarketMetadataForTrade(row);
      return metadata ? { ...metadata, ...row } : row;
    })
    : activeExposureRowsForMode(mode);
  const manuallyExcludedTokenIds = new Set(excludedCandidateTokenIdsForMode(mode));
  const ready = [];
  const riskBlocked = [];
  const manuallyExcluded = [];
  const filteredReasonCounts = new Map();

  for (const item of evaluations) {
    const tokenId = String(item?.tokenId || item?.clobTokenId || item?.assetId || "");
    if (tokenId && manuallyExcludedTokenIds.has(tokenId)) {
      manuallyExcluded.push({ ...item, manuallyExcluded: true });
      continue;
    }
    const reasons = portfolioCandidateFilterReasons(item, mode);
    if (reasons.length) {
      for (const reason of reasons) {
        filteredReasonCounts.set(reason, (filteredReasonCounts.get(reason) || 0) + 1);
      }
      continue;
    }
    const row = {
      ...item,
      annualizedReturn: portfolioAnnualizedReturn(item, config),
      expectedValueUsdc: portfolioExpectedValue(item, config),
      portfolioRiskBlockReason: candidateRiskBlockReason(item, activeRows, evaluationByToken),
    };
    if (row.portfolioRiskBlockReason) riskBlocked.push(row);
    else ready.push(row);
  }

  return {
    ready: sortPortfolioCandidates(ready, mode),
    riskBlocked: sortPortfolioCandidates(riskBlocked, mode),
    manuallyExcluded: sortPortfolioCandidates(manuallyExcluded, mode),
    filteredReasonCounts,
  };
}

function portfolioCandidateRows(mode = state.mode) {
  return portfolioCandidateDiagnostics(mode).ready;
}

// One screenful at a time. Every candidate is reachable -- the table extends itself as
// it is scrolled, and the button below it does the same for anyone not using a mouse.
const CANDIDATE_PAGE_SIZE = 80;

function candidateVisibleCount(mode = state.mode) {
  if (state.candidateVisibleMode !== normalizeMode(mode)) {
    state.candidateVisibleMode = normalizeMode(mode);
    state.candidateVisibleCount = CANDIDATE_PAGE_SIZE;
  }
  return Math.max(CANDIDATE_PAGE_SIZE, Number(state.candidateVisibleCount) || CANDIDATE_PAGE_SIZE);
}

// Re-rendering replaces the table, so the scroll position has to be carried across or
// the list jumps back to the top on every extension -- which would make scrolling to
// the end impossible.
function showMoreCandidates() {
  // The total is read from the last render rather than recomputed: this runs on scroll,
  // and rebuilding the diagnostics filters the whole catalogue.
  if (candidateVisibleCount() >= Number(state.candidateTotalCount || 0)) return false;
  const scroller = els.portfolioCandidates?.querySelector(".ledger-scroll");
  const offset = scroller ? scroller.scrollTop : 0;
  state.candidateVisibleCount = candidateVisibleCount() + CANDIDATE_PAGE_SIZE;
  renderPortfolioCandidates();
  const nextScroller = els.portfolioCandidates?.querySelector(".ledger-scroll");
  if (nextScroller) nextScroller.scrollTop = offset;
  return true;
}

function renderPortfolioCandidateRows(rows = [], mode = state.mode, diagnostics = null) {
  const manuallyExcluded = diagnostics?.manuallyExcluded || [];
  const riskBlocked = diagnostics?.riskBlocked || [];
  const visibleRows = [...rows, ...riskBlocked, ...manuallyExcluded];
  if (!visibleRows.length) {
    const config = portfolioConfigForMode(mode);
    const riskBlocked = diagnostics?.riskBlocked?.length || 0;
    const probabilitySource = normalizeProbabilitySource(config.probabilitySource);
    const nonProfitable = [...(diagnostics?.filteredReasonCounts || new Map()).entries()]
      .filter(([reason]) => reason.includes("non-profitable after fees"))
      .reduce((sum, [, count]) => sum + count, 0);
    const details = [
      riskBlocked ? `${riskBlocked} otherwise matching ${riskBlocked === 1 ? "opportunity is" : "opportunities are"} excluded because it overlaps an open position.` : "",
      probabilitySource === "polymarket" && nonProfitable
        ? `${nonProfitable} scraped market quote${nonProfitable === 1 ? " is" : "s are"} non-profitable after fees at the current entry price.`
        : "",
    ].filter(Boolean).join(" ");
    return `<div class="empty">No opportunities currently pass this portfolio shortlist.${details ? ` ${escapeHtml(details)}` : " The next scan will refresh market data and newly analyzed opportunities."}</div>`;
  }
  const shown = Math.min(visibleRows.length, candidateVisibleCount(mode));
  const remaining = visibleRows.length - shown;
  const live = LIVE_MODES.has(normalizeMode(mode));
  const config = portfolioConfigForMode(mode);
  const usesPolymarketPotential = normalizeProbabilitySource(config.probabilitySource) === "polymarket";
  const useLiveMarketColumnOrder = live && usesPolymarketPotential;
  // Scoring is always the Polymarket probability now, so the column has one name. The
  // flag above still gates which columns appear, but it can no longer be false.
  const probabilityLabel = "Mkt prob.";
  const returnMetric = portfolioReturnMetricLabel(config);
  return `
    <div class="ledger-scroll" tabindex="0" aria-label="Scrollable execution candidates table">
    <table class="ledger-wide-table">
      <thead>
        <tr>
          <th>Win</th>
          <th>Days left</th>
          <th>Market</th>
          <th>Precheck</th>
          ${useLiveMarketColumnOrder ? `
            <th>${returnMetric}</th>
            <th>Net yield %</th>
            <th>Volume</th>
            <th>R/R</th>
            <th>${probabilityLabel}</th>
            <th>End date</th>
          ` : `
            <th>End date</th>
            <th>${probabilityLabel}</th>
            ${usesPolymarketPotential ? "" : "<th>Mkt entry</th>"}
            <th>${returnMetric}</th>
            ${usesPolymarketPotential ? "" : "<th>EV</th>"}
            <th>Net yield %</th>
            <th>R/R</th>
            <th>Volume</th>
          `}
          <th>Analysis</th>
          <th>Added / updated</th>
        </tr>
      </thead>
      <tbody>
        ${visibleRows.slice(0, shown).map((item) => {
          const excluded = Boolean(item.manuallyExcluded);
          const riskBlockedRow = Boolean(item.portfolioRiskBlockReason);
          // A retryable verdict from the previous run is not a precheck state of
          // its own. Every execution revalidates each shortlisted candidate from
          // scratch, and the shortlist is dispatched without consulting this
          // column, so a past temporary capital or diversification block says
          // nothing about whether the row can trade now. It used to render as
          // WAITING, which read like a gate that does not exist. The reason the
          // previous run did not take it stays visible in the run log.
          // Only a state that is not already the badge. READY on a live portfolio used to
          // carry "will verify live quote, fees and ranking", which is what every live
          // execution does to every candidate -- it said nothing about this row, on every
          // row, and the column is narrow enough that it crowded out what does.
          const status = excluded
            ? "excluded manually for this portfolio"
            : (riskBlockedRow
              ? "excluded by diversification rules"
              : (!live ? "ready for next paper execution" : ""));
          const precheck = excluded ? "EXCLUDED" : (riskBlockedRow ? "RISK-BLOCKED" : "READY");
          const selectedProbability = portfolioProbability(item, config);
          const selectedAnnualizedReturn = portfolioAnnualizedReturn(item, config);
          const selectedExpectedValue = portfolioExpectedValue(item, config);
          return `
            <tr>
              <td data-label="Win">${gainCell(item)}</td>
              <td data-label="Days left">${evaluationDaysLeftCell(item)}</td>
              <td data-label="Market">${marketAnchor(item)}</td>
              <td data-label="Precheck" class="${excluded ? "negative" : (riskBlockedRow ? "warning" : "positive")}">
                <strong>${precheck}</strong>
                ${status ? `<span>${escapeHtml(status)}</span>` : ""}
                <label class="candidate-exclusion-control" title="Exclude this candidate from this portfolio's future executions">
                  <input type="checkbox" data-portfolio-candidate-exclude data-portfolio-mode="${escapeHtml(mode)}" data-candidate-token-id="${escapeHtml(String(item.tokenId || item.clobTokenId || item.assetId || ""))}" ${excluded ? "checked" : ""}>
                  <span>Exclude</span>
                </label>
              </td>
              ${useLiveMarketColumnOrder ? `
                <td data-label="${returnMetric}" title="${escapeHtml(annualizationHorizonNote(item))}"><span class="${pnlClass(selectedAnnualizedReturn)}">${signedPercent(selectedAnnualizedReturn)}</span></td>
                <td data-label="Net yield %">${netYieldCell(item)}</td>
                <td data-label="Volume">${money(rowVolumeUsdc(item))}</td>
                <td data-label="R/R">${evaluationRiskRewardCell(item)}</td>
                <td data-label="${probabilityLabel}">${probability(selectedProbability)}</td>
                <td data-label="End date">${evaluationEndDateCell(item)}</td>
              ` : `
                <td data-label="End date">${evaluationEndDateCell(item)}</td>
                <td data-label="${probabilityLabel}">${probability(selectedProbability)}</td>
                ${usesPolymarketPotential ? "" : `<td data-label="Mkt entry">${probability(evaluationEntryPrice(item))}</td>`}
                <td data-label="${returnMetric}" title="${escapeHtml(annualizationHorizonNote(item))}"><span class="${pnlClass(selectedAnnualizedReturn)}">${signedPercent(selectedAnnualizedReturn)}</span></td>
                ${usesPolymarketPotential ? "" : `<td data-label="EV">${signedMoney(selectedExpectedValue, 4)}</td>`}
                <td data-label="Net yield %">${netYieldCell(item)}</td>
                <td data-label="R/R">${evaluationRiskRewardCell(item)}</td>
                <td data-label="Volume">${money(rowVolumeUsdc(item))}</td>
              `}
              <td data-label="Analysis">${analysisBadge(item)}</td>
              <td data-label="Added / updated">${candidateAddedOrUpdatedCell(item)}</td>
            </tr>
          `;
        }).join("")}
      </tbody>
    </table>
    </div>
    ${remaining ? `<div class="table-load-more"><button class="execution-button" type="button" data-candidates-load-more>Show ${formatInteger(Math.min(remaining, CANDIDATE_PAGE_SIZE))} more (${formatInteger(remaining)} of ${formatInteger(visibleRows.length)} still hidden)</button></div>` : ""}
  `;
}

function storedEvaluationLiquidityFilter() {
  try {
    const value = Number(localStorage.getItem(EVALUATION_LIQUIDITY_FILTER_STORAGE_KEY));
    return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) / 100 : 0;
  } catch {
    return 0;
  }
}

function saveEvaluationLiquidityFilter(value) {
  try {
    const normalized = Number(value);
    localStorage.setItem(
      EVALUATION_LIQUIDITY_FILTER_STORAGE_KEY,
      String(Number.isFinite(normalized) && normalized >= 0 ? Math.round(normalized * 100) / 100 : 0),
    );
  } catch {
    // Display-only preference; ignore storage failures.
  }
}

function currentEvaluationLiquidityFilter() {
  const value = Number(state.evaluationLiquidityFilter);
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) / 100 : 0;
}

function syncEvaluationLiquidityFilterControl() {
  const value = currentEvaluationLiquidityFilter();
  state.evaluationLiquidityFilter = value;
  if (els.evaluationLiquidityFilter) els.evaluationLiquidityFilter.value = value > 0 ? String(value) : "";
}

function renderPortfolioCandidates() {
  if (!els.portfolioCandidates) return;
  syncPortfolioCandidateRefreshControl();
  const mode = state.mode;
  if (!state.botState) {
    els.portfolioCandidates.innerHTML = '<div class="empty">Common evaluation log is not loaded yet.</div>';
    if (els.portfolioCandidatesSummary) els.portfolioCandidatesSummary.textContent = "0 candidates";
    return;
  }
  const config = portfolioConfigForMode(mode);
  if (normalizeProbabilitySource(config.probabilitySource) === "polymarket" && !scrapedMarketStateIsLoaded()) {
    if (state.scrapedMarketStateError) {
      els.portfolioCandidates.innerHTML = `<div class="empty">Scraped Polymarket economics could not be loaded: ${escapeHtml(state.scrapedMarketStateError)}. Use “Refresh shortlist” to try again.</div>`;
      if (els.portfolioCandidatesSummary) els.portfolioCandidatesSummary.textContent = "scraped data unavailable";
      return;
    }
    ensureScrapedMarketState({ summary: "execution" });
    els.portfolioCandidates.innerHTML = '<div class="empty">Loading the focused scraped market shortlist...</div>';
    if (els.portfolioCandidatesSummary) els.portfolioCandidatesSummary.textContent = "loading scraped";
    return;
  }
  const hasEvaluations = Array.isArray(state.botState.evaluations) && state.botState.evaluations.length > 0;
  if (!hasEvaluations && state.botState.evaluationDetailsMode === "dashboard") {
    if (shouldLoadCandidateBotState()) ensureCandidateBotState();
    els.portfolioCandidates.innerHTML = '<div class="empty">Loading portfolio execution shortlist...</div>';
    if (els.portfolioCandidatesSummary) els.portfolioCandidatesSummary.textContent = "loading";
    return;
  }
  const diagnostics = portfolioCandidateDiagnostics(mode);
  const rows = diagnostics.ready;
  const label = portfolioNavigationLabelForMode(mode);
  if (els.portfolioCandidatesTitle) els.portfolioCandidatesTitle.textContent = `${label} execution candidates`;
  const blocked = diagnostics.riskBlocked.length;
  const excluded = diagnostics.manuallyExcluded.length;
  state.candidateTotalCount = rows.length + blocked + excluded;
  if (els.portfolioCandidatesSummary) {
    // The counts are the whole set. The table pages through it, so say how much of it
    // is on screen rather than letting the totals imply everything is listed.
    const total = state.candidateTotalCount;
    const shown = Math.min(total, candidateVisibleCount(mode));
    const paged = shown < total ? ` - showing ${formatInteger(shown)} of ${formatInteger(total)}` : "";
    els.portfolioCandidatesSummary.textContent = `${rows.length} ready${blocked ? ` / ${blocked} risk-blocked` : ""}${excluded ? ` / ${excluded} excluded` : ""}${paged}`;
  }
  els.portfolioCandidates.innerHTML = renderPortfolioCandidateRows(rows, mode, diagnostics);
}

// Rendered into each portfolio's own rules card, so the state shown is always the
// state of the portfolio whose settings are on screen. The card is rebuilt on every
// render, so the click is handled by delegation rather than a bound listener that
// would be lost with the element.
function automationBadgeMarkup() {
  const on = automationIsEnabled(portfolioConfigForMode(state.mode));
  return `<button class="automation-toggle${on ? "" : " is-off"}" type="button" data-automation-toggle aria-pressed="${on ? "true" : "false"}" title="Turn automatic execution for this portfolio on or off">
    <span class="automation-dot" aria-hidden="true"></span>
    <span data-automation-toggle-label>${on ? "ON" : "OFF"}</span>
  </button>`;
}

// Reported: archiving existed only inside the parameter-edit modal, so a user looking
// for a way to deactivate a portfolio next to the edit icon found nothing there at all.
// Only an existing paper portfolio can be archived -- a live one holds real positions and
// open orders, and archiving here always means an already-existing one, never a draft.
function renderPortfolioRulesCard(title, rows, archiveStrategyId = null) {
  return `
    <div class="portfolio-rules-card">
      <div class="portfolio-rules-head">
        <strong>${escapeHtml(title)}</strong>
        ${automationBadgeMarkup()}
        <button class="portfolio-rules-edit" type="button" data-portfolio-parameters-edit aria-label="Edit portfolio parameters" title="Edit portfolio parameters">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M12 20h9"></path>
            <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z"></path>
          </svg>
        </button>
        ${archiveStrategyId ? `
          <button class="portfolio-rules-archive" type="button" data-portfolio-archive-direct="${escapeHtml(archiveStrategyId)}" aria-label="Archive portfolio" title="Archive portfolio">
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M3 7h18"></path>
              <path d="M5 7v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7"></path>
              <path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3"></path>
              <path d="M10 12v5"></path>
              <path d="M14 12v5"></path>
            </svg>
          </button>
        ` : ""}
      </div>
      <div class="portfolio-rule-list">
        ${rows.map(([label, value]) => `
          <div class="portfolio-rule-row">
            <span>${escapeHtml(label)}</span>
            <em>${escapeHtml(value)}</em>
          </div>
        `).join("")}
      </div>
    </div>
  `;
}

function renderBotState(botState) {
  state.botState = Array.isArray(botState?.marketObservations)
    ? botState
    : {
        ...botState,
        ...(Array.isArray(state.botState?.marketObservations)
          ? {
              marketObservations: state.botState.marketObservations,
              marketScan: state.botState.marketScan || {},
            }
          : {}),
      };
  syncModeUi();
  renderSystemStatus(state.liveState);
  if (els.accountSummary) {
    els.accountSummary.hidden = true;
    els.accountSummary.innerHTML = "";
  }
  els.botStatus.hidden = false;
  refreshEligibilityThreshold();
  refreshRiskAllocation();
  refreshLimitOrders();
  const portfolioState = selectedPaperPortfolio(botState);
  const decision = portfolioState.lastDecision || botState.lastDecision || {};
  const portfolio = portfolioState.portfolio || botState.portfolio || {};
  const learning = botState.learningProfile || {};
  const trades = paperPortfolioTrades(portfolioState);
  const closedTrades = trades.filter(isClosedTrade);
  const openTrades = trades.filter((trade) => !isClosedTrade(trade));
  const periodDays = portfolioPeriodDays(botState, trades);
  const annualized = annualizedPortfolioReturn(portfolio, periodDays);
  const totalPnl = Number(portfolio.totalPnlUsdc || 0);
  const totalPnlPct = Number(portfolio.totalPnlPct || 0);
  const realizedPnl = Number(portfolio.realizedPnlUsdc || 0);
  const realizedPnlPct = Number(portfolio.realizedPnlPct || 0);
  // After a capital rebase these tiles read "since the reset". Every trade stays in
  // Closed positions and equity keeps counting its real historical P/L, as designed --
  // only what these tiles measure starts at the reset. Equity, free capital and sizing
  // above still use the true totals.
  //
  // Reported: equity read 109.46 while Total P/L read -37.92, which cannot both describe
  // the same account. The bot now measures the reset as what it is -- equity set to a
  // target outright -- so all three tiles are differences from that same moment and add
  // up again. Open P/L therefore also switches to its since-the-reset figure here; using
  // the raw current unrealized alongside two since-the-reset numbers is what let the
  // three stop summing.
  const capitalAdjustmentAt = portfolio.capitalAdjustmentAt || portfolioState.capitalAdjustmentAt || null;
  const totalPnlDisplay = capitalAdjustmentAt ? Number(portfolio.totalPnlSinceAdjustmentUsdc || 0) : totalPnl;
  const totalPnlDisplayPct = capitalAdjustmentAt ? Number(portfolio.totalPnlSinceAdjustmentPct || 0) : totalPnlPct;
  const realizedPnlDisplay = capitalAdjustmentAt ? Number(portfolio.realizedPnlSinceAdjustmentUsdc || 0) : realizedPnl;
  const realizedPnlDisplayPct = capitalAdjustmentAt ? Number(portfolio.realizedPnlSinceAdjustmentPct || 0) : realizedPnlPct;
  const openPnl = capitalAdjustmentAt && portfolio.openPnlSinceAdjustmentUsdc != null
    ? Number(portfolio.openPnlSinceAdjustmentUsdc || 0)
    : Number(portfolio.openPnlUsdc || 0);
  const openPnlPct = capitalAdjustmentAt && portfolio.openPnlSinceAdjustmentPct != null
    ? Number(portfolio.openPnlSinceAdjustmentPct || 0)
    : Number(portfolio.openPnlPct || 0);
  const freeCapital = Number(portfolio.freeCapitalUsdc ?? portfolio.initialUsdc ?? 100);
  const paperCapitalBase = Number(portfolio.initialUsdc ?? 100) + realizedPnl;
  syncRiskAllocationControl(freeCapital, "paper portfolio equity", {
    baseCapital: paperCapitalBase,
    cadenceLabel: "next paper execution",
  });

  if (els.botAction) els.botAction.textContent = decision.action || "waiting";
  if (els.botInlineAction) els.botInlineAction.textContent = decision.action || "waiting";
  els.portfolioEquity.textContent = money(Number(portfolio.equityUsdc ?? portfolio.initialUsdc ?? 100));
  els.portfolioEquity.className = pnlClass(totalPnl);
  els.portfolioLastRun.textContent = `Last run ${botState.generatedAt ? formatDate(botState.generatedAt) : "-"}`;
  els.portfolioTotalPl.textContent = signedMoney(totalPnlDisplay);
  els.portfolioTotalPl.className = pnlClass(totalPnlDisplay);
  els.portfolioTotalPlPct.textContent = signedPercent(totalPnlDisplayPct);
  if (els.portfolioAnnualized) {
    els.portfolioAnnualized.textContent = signedPercent(annualized);
    els.portfolioAnnualized.className = pnlClass(annualized);
  }
  if (els.portfolioPeriod) {
    els.portfolioPeriod.textContent = periodDays == null ? "No trades yet" : `since first trade, ${periodDays.toFixed(1)} days`;
  }
  els.portfolioRealized.textContent = signedMoney(realizedPnlDisplay);
  els.portfolioRealized.className = pnlClass(realizedPnlDisplay);
  els.portfolioRealizedPct.textContent = signedPercent(realizedPnlDisplayPct);
  // Closed positions itself (below) always lists every trade -- only the accuracy stat
  // stops counting ones closed before the rebase.
  const accuracyTrades = capitalAdjustmentAt
    ? closedTrades.filter((trade) => {
        const resolvedTime = Date.parse(trade.resolvedAt || "");
        return Number.isFinite(resolvedTime) && resolvedTime >= Date.parse(capitalAdjustmentAt);
      })
    : closedTrades;
  renderClosedAccuracy(accuracyTrades, closedTrades.length - accuracyTrades.length);
  els.portfolioOpenPl.textContent = signedMoney(openPnl);
  els.portfolioOpenPl.className = pnlClass(openPnl);
  els.portfolioOpenPlPct.textContent = signedPercent(openPnlPct);
  els.portfolioRisk.textContent = money(Number(portfolio.openRiskUsdc || 0));
  els.portfolioFree.textContent = `${money(freeCapital)} free`;
  renderPortfolioEquityChart({
    trades,
    equity: Number(portfolio.equityUsdc ?? portfolio.initialUsdc ?? 100),
    openPnl: Number(portfolio.openPnlUsdc || 0),
    generatedAt: botState.generatedAt,
  });

  if (els.portfolioRules) {
    els.portfolioRules.innerHTML = `
    <div class="bot-summary">
      ${renderPortfolioRulesCard(portfolioState.label || "Paper portfolio", portfolioRuleRows({ ...portfolioState, ...portfolio }), portfolioState.id)}
    </div>
  `;
  }
  const paperWarning = stateWarningHtml("paper", "paper portfolio");
  els.botStatus.innerHTML = paperWarning;
  els.botStatus.hidden = !paperWarning;

  els.botTrades.innerHTML = renderTradeRows(openTrades.slice(0, 12), "Zatim zadne otevrene autonomni paper obchody.", {
    tableKey: "open",
    showStatus: false,
  });
  if (els.closedSummary) {
    const closedPnl = closedTrades.reduce((sum, trade) => sum + Number(trade.realizedPnlUsdc || 0), 0);
    els.closedSummary.textContent = `${closedTrades.length} closed / ${signedMoney(closedPnl)}`;
  }
  if (els.closedTrades) {
    els.closedTrades.innerHTML = renderTradeRows(closedTrades, "Zatim zadne ukoncene paper obchody.", {
      tableKey: "closed",
      showStatus: true,
    });
  }

  renderBotEvaluations();
  renderPortfolioCandidates();
  renderRunLog();
  renderCalculationReport();
  openOpportunityFromCurrentUrl();
}

// The two live portfolios trade one Polymarket account, so the wallet cannot tell
// them apart -- but each records what it placed. A token is 5050's if 5050 submitted
// an order for it; everything else belongs to the main live portfolio. Without this
// each portfolio would show the other's rows, and 5050 rests dozens of bids at once.
function submittedTokenIds(executionState) {
  const tokens = new Set();
  const rows = [
    executionState || {},
    ...(Array.isArray(executionState?.runLog) ? executionState.runLog : []),
  ];
  for (const row of rows) {
    for (const attempt of (Array.isArray(row?.attempts) ? row.attempts : [])) {
      const action = String(attempt?.action || "").toUpperCase();
      if (action.includes("REJECT") || action.startsWith("DRY_RUN")) continue;
      const tokenId = String(attempt?.tokenId || "");
      if (tokenId) tokens.add(tokenId);
    }
  }
  return tokens;
}

function fixedEntryTokenIds() {
  return submittedTokenIds(state.live5050ExecutionState);
}

// Attribution must never hide a row from both portfolios: anything 5050 did not
// place shows under Live, which is also the safe direction for a token whose
// origin is unknown.
// 5050's own orders were invisible on its tab until its run log published, because
// attribution read only that log -- and the log is written at the end of a run,
// after the orders are already on the book. The price is the second, independent
// signal: 5050 rests every bid at exactly its configured entry price, which is far
// from the market by construction, so a resting order at that price is its own.
// Every price 5050 is known to rest bids at: what it is configured at now, what its last
// run actually used, and every price its run log records it ordering. One value is not
// enough. The setting moves -- 0.50 to 0.51 to 0.52 -- and a bid rested at the old one
// stops matching the moment it does, which is how a 52c order came to be filed under
// Live. Rejected attempts count here: a refused bid still says what price this portfolio
// bids at, even though it claims no token.
function fixedEntryPriceSignatures() {
  const prices = new Set();
  const add = (value) => {
    const price = Number(value);
    if (Number.isFinite(price) && price > 0 && price < 1) prices.add(Number(price.toFixed(4)));
  };
  const fixedEntryConfig = portfolioConfigForMode("live-5050");
  add(normalizeFixedEntryPrice(fixedEntryConfig.fixedEntryPrice));
  // Every price this portfolio has rested bids at, not only the one set right now.
  // Without it, changing the setting orphaned everything bought at the old price: the
  // rows stayed on the account but stopped being recognised as 5050's, so its positions
  // and closed trades moved to the live portfolio's tab and its own read empty. The run
  // log below is the finer record, but it is trimmed and -- as production showed -- may
  // not be published at all, so this is what has to hold on its own.
  for (const price of (Array.isArray(fixedEntryConfig.fixedEntryPriceHistory)
    ? fixedEntryConfig.fixedEntryPriceHistory
    : [])) {
    add(price);
  }
  const execution = state.live5050ExecutionState || {};
  for (const row of [execution, ...(Array.isArray(execution.runLog) ? execution.runLog : [])]) {
    add(row?.fixedEntry?.entryPrice);
    for (const attempt of (Array.isArray(row?.attempts) ? row.attempts : [])) {
      if (String(attempt?.action || "").toUpperCase().startsWith("DRY_RUN")) continue;
      add(attempt?.orderPrice);
    }
  }
  return prices;
}

// How far a recorded price may sit from one 5050 rested a bid at and still be its own.
//
// A cent, not half of one. A resting maker bid fills at its own price, but what is stored
// is the cost-weighted average of every fill, so two partials either side of a settings
// change average out to something between them: production carries a closed 5050 trade at
// 0.5100 against a 0.50 bid, which a half-cent window missed and handed to the live
// portfolio. The window stays far from anything live can produce -- it buys at the market
// against a probability bar in the nineties, and the lowest entry price among the
// account's 43 closed trades is 0.75, more than ten cents clear of 5050's highest.
const FIXED_ENTRY_PRICE_TOLERANCE = 0.02;

function matchesFixedEntryPrice(value) {
  const price = Number(value);
  if (!Number.isFinite(price)) return false;
  for (const entry of fixedEntryPriceSignatures()) {
    if (Math.abs(price - entry) < FIXED_ENTRY_PRICE_TOLERANCE) return true;
  }
  return false;
}

// 5050's own orders were invisible on its tab until its run log published, because
// attribution read only that log -- and the log is written at the end of a run, after the
// orders are already on the book. The price is the second, independent signal: 5050 rests
// every bid at one price, far from the market by construction, so a resting order at any
// price it bids at is its own.
function restsAtFixedEntryPrice(row) {
  return matchesFixedEntryPrice(row?.price ?? row?.orderPrice ?? row?.limitPrice);
}

// A row that filled is not an order, and must not be attributed like one. 5050 buys at
// exactly one price, so what a position or a closed trade was actually bought at says
// which portfolio bought it. The token cannot: both portfolios draw from one candidate
// pool, and 5050 rests a bid on nearly everything that clears its bar -- so claiming a
// fill by token handed Live's positions and closed history to 5050 whenever 5050 had an
// unfilled bid resting on the same market, which is the ordinary case rather than a rare
// one. An unknown buy price stays with Live, the same safe direction as an unknown token.
function isFilledPortfolioRow(row) {
  return Number.isFinite(Number(row?.entryPrice ?? row?.avgPrice ?? row?.averagePrice))
    || Number(row?.shares ?? row?.sharesBought) > 0
    || isClosedTrade(row || {});
}

// What 5050 actually ordered, per token, from its own run log. The current configured
// price is not enough on its own: it changes, and a fill from when it was 0.50 stops
// matching the moment it is set to 0.51 -- which handed 5050's own filled positions to
// Live. The log remembers the price each bid was rested at, whatever the setting is now.
function fixedEntryOrderPricesByToken() {
  const prices = new Map();
  const execution = state.live5050ExecutionState || {};
  const rows = [execution, ...(Array.isArray(execution.runLog) ? execution.runLog : [])];
  for (const row of rows) {
    for (const attempt of (Array.isArray(row?.attempts) ? row.attempts : [])) {
      const action = String(attempt?.action || "").toUpperCase();
      if (action.includes("REJECT") || action.startsWith("DRY_RUN")) continue;
      const tokenId = String(attempt?.tokenId || "");
      const price = Number(attempt?.orderPrice);
      if (!tokenId || !Number.isFinite(price)) continue;
      if (!prices.has(tokenId)) prices.set(tokenId, new Set());
      prices.get(tokenId).add(Number(price.toFixed(4)));
    }
  }
  return prices;
}

// Reported live: a trade opened and shown under Live closed under 90 -> 50% instead.
// This used to fall back to matchesFixedEntryPrice(paid) -- any price 5050 is configured
// at now or has ever been configured at, whether or not this token has anything to do
// with it -- when no per-token order was on record. Live prices its own buys off market
// probability, and 5050's configured prices (0.50, 0.65) are ordinary enough numbers that
// Live lands on them too: every misattributed trade had loggedTokenPrices=[] -- no order
// from 5050 on that token at all -- while paying almost exactly 0.50 or 0.65. The
// per-token order log is the one signal that is actually about this token; without a
// match there, the row stays with Live, the documented safe default for an unknown fill.
function boughtAtFixedEntryPrice(row) {
  const paid = Number(row?.entryPrice ?? row?.avgPrice ?? row?.averagePrice);
  if (!Number.isFinite(paid)) return false;
  // Same window as the signature match above, and for the same reason: an averaged fill
  // price drifts by cents, not by half-cents.
  const matches = (price) => Math.abs(paid - price) < FIXED_ENTRY_PRICE_TOLERANCE;
  const ordered = fixedEntryOrderPricesByToken().get(String(row?.tokenId || row?.assetId || ""));
  return Boolean(ordered && [...ordered].some(matches));
}

function belongsToActiveLivePortfolio(row) {
  const tokenId = String(row?.tokenId || row?.assetId || "");
  if (!tokenId) return !isFixedEntryMode();
  const owned = isFilledPortfolioRow(row)
    ? boughtAtFixedEntryPrice(row)
    : (fixedEntryTokenIds().has(tokenId) || restsAtFixedEntryPrice(row));
  return isFixedEntryMode() ? owned : !owned;
}

function livePositions(liveState) {
  return Array.isArray(liveState?.positions)
    ? liveState.positions.filter((trade) => !isClosedTrade(trade)).filter(belongsToActiveLivePortfolio)
    : [];
}

function liveOpenOrders(liveState) {
  return Array.isArray(liveState?.openOrders) ? liveState.openOrders.filter(belongsToActiveLivePortfolio) : [];
}

// History belongs to whichever portfolio placed the trade. Only the account itself
// -- the equity, the cash, the balance -- is genuinely shared, because there is one
// wallet. Everything a portfolio did is its own.
function liveActivity(liveState) {
  return (Array.isArray(liveState?.activity) ? liveState.activity : []).filter(belongsToActiveLivePortfolio);
}

function liveClosedTrades(liveState) {
  const rows = Array.isArray(liveState?.closedTrades)
    ? liveState.closedTrades
    : (Array.isArray(liveState?.trades?.closed) ? liveState.trades.closed : []);
  return rows.filter(belongsToActiveLivePortfolio);
}

function evaluationByTokenId(tokenId) {
  const token = String(tokenId || "");
  if (!token) return null;
  const evaluations = Array.isArray(state.botState?.evaluations) ? state.botState.evaluations : [];
  const scraped = scrapedMarketObservations();
  return [...evaluations, ...scraped]
    .find((item) => String(item.tokenId || item.clobTokenId || item.assetId || "") === token) || null;
}

function liveMarketMetadataForTrade(item = {}) {
  const evaluations = Array.isArray(state.botState?.evaluations) ? state.botState.evaluations : [];
  const scraped = scrapedMarketObservations();
  const execution = state.liveExecutionState || {};
  const executionRows = [
    execution.selected,
    ...(Array.isArray(execution.revalidationUpdates) ? execution.revalidationUpdates : []),
    ...(Array.isArray(execution.attempts) ? execution.attempts : []),
    ...(Array.isArray(execution.runLog)
      ? execution.runLog.flatMap((run) => [run?.selected, ...(Array.isArray(run?.revalidationUpdates) ? run.revalidationUpdates : [])])
      : []),
  ].filter(Boolean);
  const sources = [...executionRows, ...scraped, ...evaluations];
  const tokenIds = new Set([
    item.tokenId,
    item.clobTokenId,
    item.assetId,
    item.asset,
    item.tokenID,
  ].map((value) => String(value || "").trim()).filter(Boolean));
  const marketIds = new Set([
    item.marketId,
    item.conditionId,
    item.market,
  ].map((value) => String(value || "").trim().toLowerCase()).filter(Boolean));
  const tokenMatch = sources.find((candidate) => tokenIds.has(String(
    candidate.tokenId || candidate.clobTokenId || candidate.assetId || candidate.asset || "",
  ).trim()));
  if (tokenMatch) return tokenMatch;
  const marketMatch = sources.find((candidate) => marketIds.has(String(
    candidate.marketId || candidate.conditionId || candidate.market || "",
  ).trim().toLowerCase()));
  if (marketMatch) return marketMatch;
  return null;
}

function normalizedMatchText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function evaluationByTrade(item) {
  const byToken = evaluationByTokenId(item?.tokenId || item?.assetId || item?.asset);
  if (byToken) return byToken;

  const evaluations = Array.isArray(state.botState?.evaluations) ? state.botState.evaluations : [];
  const scraped = scrapedMarketObservations();
  const sources = [...scraped, ...evaluations];
  const outcome = normalizedMatchText(item?.outcome || item?.side);
  const slug = normalizedMatchText(item?.eventSlug || item?.slug);
  const question = normalizedMatchText(item?.question || item?.title || item?.market);
  if (!outcome) return null;

  return sources.find((candidate) => {
    const candidateOutcome = normalizedMatchText(candidate.outcome);
    if (candidateOutcome !== outcome) return false;
    const candidateSlug = normalizedMatchText(candidate.eventSlug || candidate.slug);
    if (slug && candidateSlug && slug === candidateSlug) return true;
    const candidateQuestion = normalizedMatchText(candidate.question);
    return question && candidateQuestion && question === candidateQuestion;
  }) || null;
}

function decorateLiveTradeForTable(trade) {
  const source = trade.sourceEvaluation || liveMarketMetadataForTrade(trade) || evaluationByTrade(trade);
  if (!source) {
    return {
      ...trade,
      analysisSummary: trade.analysisSummary || "No matching AI evaluation was found for this live Polymarket row. Treat this as an audit gap until the order/execution ledger links it back to an evaluated candidate.",
    };
  }
  const hasQuestion = String(trade.question || "").trim() && String(trade.question || "").trim() !== "-";
  const hasOutcome = String(trade.outcome || "").trim() && String(trade.outcome || "").trim() !== "-";
  return {
    ...trade,
    question: hasQuestion ? trade.question : (source.question || trade.question || ""),
    outcome: hasOutcome ? trade.outcome : (source.outcome || trade.outcome || "-"),
    slug: trade.slug || source.slug || source.eventSlug || "",
    eventSlug: trade.eventSlug || source.eventSlug || source.slug || "",
    url: trade.url || polymarketUrl(source),
    endDate: trade.endDate || source.endDate || source.resolutionDate || null,
    daysToResolution: trade.daysToResolution ?? source.daysToResolution ?? null,
    currentPrice: Number.isFinite(Number(trade.currentPrice)) ? trade.currentPrice : (source.marketPrice ?? null),
    aiProbability: numericOrNull(trade.aiProbability) ?? numericOrNull(source.aiProbability),
    rawProbability: numericOrNull(trade.rawProbability) ?? numericOrNull(source.rawProbability),
    thesisType: source.thesisType,
    annualizedReturn: trade.annualizedReturn ?? source.annualizedReturn,
    expectedValueUsdc: trade.expectedValueUsdc ?? source.expectedValueUsdc,
    edge: trade.edge ?? source.edge,
    sourceEvaluation: source,
    aiAnalysis: trade.aiAnalysis || source.aiAnalysis || null,
    probabilityThesis: trade.probabilityThesis || source.probabilityThesis || source.aiAnalysis?.thesis || "",
    analysisModel: trade.analysisModel || source.analysisModel || source.aiAnalysis?.model || "",
    analysisSummary: [
      trade.analysisSummary || "",
      source.analysisSummary ? `Original AI evaluation: ${source.analysisSummary}` : "",
    ].filter(Boolean).join(" "),
  };
}

// Mirrors expiredOrderWithdrawalReason() in tools/live-order-executor.mjs, which is what
// actually withdraws these bids. It is repeated here rather than shared because the
// dashboard is a static page with no access to the executor -- so a test asserts the two
// read the same fields and use the same grace, which is the only way they can drift.
//
// A row this returns true for is not a bet that is still running. It is money reserved
// against a fill that can no longer happen for a reason worth having, and it is why a bid
// on a LoL match played hours earlier read as LIMIT ORDER WAITING with nothing to say
// that the match was over.
const EXPIRED_ORDER_GRACE_HOURS = 2;

function orderMarketHasEnded(order) {
  if (order?.marketClosed === true || order?.marketArchived === true) return true;
  if (order?.marketAcceptingOrders === false) return true;
  const resolutionEnd = Date.parse(order?.resolutionEndDate || "");
  if (!Number.isFinite(resolutionEnd)) return false;
  const hoursPast = (Date.now() - resolutionEnd) / 3600000;
  // The scheduled kickoff is deliberately not used: a match under way is not over, and
  // that is what `endDate` holds for sports.
  if (order?.marketListed === false && hoursPast > 0) return true;
  return hoursPast > EXPIRED_ORDER_GRACE_HOURS;
}

function normalizeLiveOpenOrderForTable(order) {
  const source = liveMarketMetadataForTrade(order) || evaluationByTrade(order);
  const price = Number(order.price);
  const remainingSize = Number(order.remainingSize ?? order.originalSize ?? 0);
  const notional = Number(order.notionalUsdc);
  const stake = Number.isFinite(notional) ? notional : (Number.isFinite(price) ? price * remainingSize : 0);
  const tokenId = order.tokenId || order.assetId || order.asset || order.tokenID || null;
  return {
    id: `open-order-${order.id}`,
    orderId: order.id || order.orderID || order.orderId || null,
    mode: "LIVE_ORDER",
    status: "LIMIT ORDER",
    marketEnded: orderMarketHasEnded(order),
    question: source?.question || order.question || order.title || "Market title is synchronizing",
    outcome: source?.outcome || order.outcome || order.side || "-",
    slug: source?.slug || source?.eventSlug || order.slug || order.eventSlug || "",
    eventSlug: source?.eventSlug || source?.slug || order.eventSlug || order.slug || "",
    url: source ? polymarketUrl(source) : (order.url || order.marketUrl || ""),
    tokenId,
    marketId: source?.marketId || order.marketId || null,
    conditionId: source?.conditionId || order.conditionId || order.market || null,
    date: order.createdAt || null,
    openedAt: order.createdAt || null,
    openedAtSource: order.createdAt ? "open-orders-api" : "unknown",
    endDate: order.endDate || order.resolutionEndDate || source?.endDate || source?.resolutionEndDate || order.resolutionDate || null,
    daysToResolution: order.daysToResolution ?? source?.daysToResolution ?? null,
    entryPrice: price,
    currentPrice: Number(order.currentPrice ?? price ?? source?.marketPrice ?? source?.marketPriceProbability),
    shares: remainingSize,
    stakeUsdc: stake,
    totalCostUsdc: stake,
    netGainIfWinUsdc: Number.isFinite(remainingSize) ? remainingSize - stake : null,
    unrealizedPnlUsdc: 0,
    unrealizedPnlPct: 0,
    aiProbability: numericOrNull(source?.aiProbability ?? order.aiProbability),
    rawProbability: numericOrNull(source?.rawProbability),
    thesisType: source?.thesisType || "",
    annualizedReturn: source?.annualizedReturn,
    expectedValueUsdc: source?.expectedValueUsdc,
    edge: source?.edge,
    sourceEvaluation: source || null,
    aiAnalysis: source?.aiAnalysis || null,
    probabilityThesis: source?.probabilityThesis || source?.aiAnalysis?.thesis || "",
    analysisModel: source?.analysisModel || source?.aiAnalysis?.model || "",
    analysisSummary: [
      source?.analysisSummary || source?.probabilityThesis || "",
      `Open ${order.side || ""} limit order ${shortIdentifier(order.id || order.orderID || order.orderId)}, ${remainingSize.toLocaleString("en-US", { maximumFractionDigits: 4 })} shares at ${probability(price)}.`,
      `Created ${order.createdAt ? formatDate(order.createdAt) : "-"}.`,
      `Matched ${Number(order.sizeMatched || 0).toLocaleString("en-US", { maximumFractionDigits: 4 })} shares.`,
    ].join(" "),
  };
}

function liveAccountName(account = {}) {
  const profile = account.profile || {};
  return profile.displayName || profile.pseudonym || account.label || shortAddress(account.address);
}

function liveAccountSubtitle(account = {}) {
  const profile = account.profile || {};
  const parts = [
    profile.xUsername ? `X @${profile.xUsername}` : "",
    profile.verifiedBadge ? "verified" : "",
    account.connectionMode || "public API sync",
  ];
  return parts.filter(Boolean).join(" / ") || "public profile not published";
}

function liveAccountProfileLine(account = {}) {
  const profile = account.profile || {};
  return [
    profile.pseudonym ? `pseudonym ${profile.pseudonym}` : "",
    profile.displayUsernamePublic === false ? "username hidden" : "",
    account.loginMethod || "",
  ].filter(Boolean).join(" / ");
}

function renderSystemStatus(liveState = state.liveState) {
  if (!els.systemStatus) return;
  if (!liveState) {
    els.systemStatus.hidden = false;
    els.systemStatus.innerHTML = `
      <div class="system-status-head">
        <div>
          <p class="eyebrow">System</p>
          <h3>Live account sync</h3>
        </div>
        <span class="pill muted">not loaded</span>
      </div>
      <div class="empty">Live account system details will appear after the live portfolio state is loaded.</div>
    `;
    return;
  }

  const account = liveState.account || {};
  const portfolio = liveState.portfolio || {};
  const sync = liveState.sync || {};
  const pendingRedeem = Number(portfolio.pendingRedeemUsdc);
  const rows = [
    ["Synced account", liveAccountName(account)],
    ["Address", account.address || "-"],
    ["Last sync", liveState.generatedAt ? formatDate(liveState.generatedAt) : "-"],
    ["Connection", account.connectionMode || "-"],
    ["Equity source", portfolio.equitySource || "-"],
    ["Pending redeem", Number.isFinite(pendingRedeem) ? money(pendingRedeem) : "-"],
    ["Sync status", sync.status || "-"],
  ];

  els.systemStatus.hidden = false;
  els.systemStatus.innerHTML = `
    <div class="system-status-head">
      <div>
        <p class="eyebrow">System</p>
        <h3>Live account sync</h3>
      </div>
      <span class="pill muted">${escapeHtml(liveState.generatedAt ? formatDate(liveState.generatedAt) : "-")}</span>
    </div>
    <div class="system-status-grid">
      ${rows.map(([label, value]) => `
        <div>
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(value)}</strong>
        </div>
      `).join("")}
    </div>
  `;
}

function renderLiveState(liveState) {
  state.liveState = liveState;
  syncModeUi();
  refreshEligibilityThreshold();
  refreshRiskAllocation();
  refreshLimitOrders();

  const account = liveState.account || {};
  const portfolio = liveState.portfolio || {};
  const balanceAllowance = liveState.balanceAllowance || {};
  const collateral = balanceAllowance.collateral || {};
  const positions = livePositions(liveState).map(decorateLiveTradeForTable);
  const openOrders = liveOpenOrders(liveState);
  const openOrderRows = openOrders.map(normalizeLiveOpenOrderForTable);
  const openedRows = decoratePendingLiveAnnualization([
    ...positions,
    ...openOrderRows,
  ]);
  const activity = liveActivity(liveState);
  const closedTrades = liveClosedTrades(liveState).map(decorateLiveTradeForTable);
  const sync = liveState.sync || {};
  const reconciliation = liveState.reconciliation || {};
  const reconciliationGaps = Number(reconciliation.orphanedCount || 0);
  const sources = Array.isArray(sync.sources) ? sync.sources : [];
  const marketValue = Number(portfolio.marketValueUsdc);
  const cash = Number(portfolio.cashUsdc);
  const openOrderRisk = openOrderRows.reduce((sum, order) => sum + Number(order.totalCostUsdc || order.stakeUsdc || 0), 0);
  // Both risk and free cash are this portfolio's own. There is one wallet, so the
  // exchange does reserve collateral for the other portfolio's resting bids too -- but
  // 5050 rests many at once, and counting those here reported the Live portfolio as
  // having nothing to trade with while the account was otherwise idle. Each portfolio is
  // now shown what its own commitments leave it, which is what its executor sizes from.
  const TERMINAL_ORDER_STATUSES = new Set(["CANCELED", "CANCELLED", "FILLED", "MATCHED", "EXPIRED"]);
  const reservedByOrders = (rows) => rows
    .filter((order) => !String(order.side || "").toUpperCase().includes("SELL"))
    // A cancelled or filled row still present in the snapshot reserves nothing.
    .filter((order) => !TERMINAL_ORDER_STATUSES.has(String(order.rawStatus || order.status || "").toUpperCase()))
    .reduce((sum, order) => {
      const reserved = Number(order.notionalUsdc ?? order.totalCostUsdc ?? order.stakeUsdc);
      return sum + (Number.isFinite(reserved) ? reserved : 0);
    }, 0);
  const walletOrderRisk = reservedByOrders(Array.isArray(liveState?.openOrders) ? liveState.openOrders : []);
  const ownOrderReservation = reservedByOrders(openOrderRows);
  const freeCash = Number.isFinite(cash) ? Math.max(0, cash - ownOrderReservation) : null;
  // What the rest of the wallet has locked, so the tile can say why the exchange may
  // still refuse an order this figure says is affordable.
  const otherPortfolioReservation = Math.max(0, walletOrderRisk - ownOrderReservation);
  // Positions carry wallet-wide risk in the account snapshot, so a per-portfolio view
  // has to add up its own rather than borrow that total.
  const ownPositionRisk = positions.reduce((sum, row) => {
    const committed = Number(row.totalCostUsdc ?? row.stakeUsdc ?? row.maxLossUsdc);
    return sum + (Number.isFinite(committed) ? committed : 0);
  }, 0);
  const pendingRedeem = Number(portfolio.pendingRedeemUsdc);
  const executionState = state.liveExecutionState || {};
  const monitoring = executionState.monitoring || {};
  const idleCashLimit = Number(monitoring.idleCashLimitUsdc);
  const idleCashHours = Number(monitoring.idleCashHours);
  const idleCashOverdue = Boolean(monitoring.idleCashOverdue);
  const idleCashStatus = idleCashOverdue ? "Overdue" : (monitoring.cashAboveIdleLimit ? "Grace period" : "OK");
  const idleCashDetail = Number.isFinite(idleCashLimit)
    ? `${Number.isFinite(cash) ? money(cash) : "-"} cash / limit ${money(idleCashLimit)} / idle ${Number.isFinite(idleCashHours) ? `${idleCashHours.toFixed(1)}h` : "-"}`
    : "live execution monitor not available yet";
  const equity = Number.isFinite(Number(portfolio.equityUsdc))
    ? Number(portfolio.equityUsdc)
    : (Number.isFinite(marketValue) ? marketValue : 0);
  const deposited = Number(portfolio.depositedUsdc);
  const rawTotalPnl = Number(portfolio.totalPnlUsdc);
  const rawTotalPnlPct = Number(portfolio.totalPnlPct);
  const rawRealizedPnl = Number(portfolio.realizedPnlUsdc);
  const rawRealizedPnlPct = Number(portfolio.realizedPnlPct);
  const rawOpenPnl = Number(portfolio.openPnlUsdc);
  const rawOpenPnlPct = Number(portfolio.openPnlPct);
  const hasOriginalValue = Number.isFinite(deposited) && deposited > 0;
  // The account snapshot's equity is authoritative. Its public activity feed
  // can be temporarily incomplete, so derive the headline and the realized
  // remainder from equity to avoid a false red total P/L during a sync.
  const totalPnl = hasOriginalValue ? equity - deposited : rawTotalPnl;
  const totalPnlPct = hasOriginalValue ? totalPnl / deposited : rawTotalPnlPct;
  const openPnl = Number.isFinite(rawOpenPnl) ? rawOpenPnl : 0;
  const openPnlPct = hasOriginalValue ? openPnl / deposited : rawOpenPnlPct;
  const rawRealized = hasOriginalValue ? totalPnl - openPnl : rawRealizedPnl;
  const rawRealizedPct = hasOriginalValue ? rawRealized / deposited : rawRealizedPnlPct;
  // Equity is the one figure the two live portfolios genuinely share, because there
  // is one wallet. Every P/L number above is account-level, which is the main
  // portfolio's whole history -- so 5050 derives its own from the trades it made.
  // With no trades yet that is zero, which is the truth rather than a borrowed one.
  const fixedEntry = isFixedEntryMode();
  const usdc = (value) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : 0;
  };
  const ownRealized = closedTrades.reduce((sum, trade) => sum + usdc(trade.realizedPnlUsdc ?? trade.pnlUsdc), 0);
  const ownOpen = positions.reduce((sum, trade) => sum + usdc(trade.openPnlUsdc ?? trade.unrealizedPnlUsdc), 0);
  const ownStake = [...positions, ...closedTrades]
    .reduce((sum, trade) => sum + usdc(trade.totalCostUsdc ?? trade.stakeUsdc), 0);
  const realizedPnl = fixedEntry ? ownRealized : rawRealized;
  const openPnlValue = fixedEntry ? ownOpen : openPnl;
  const totalPnlValue = fixedEntry ? ownRealized + ownOpen : totalPnl;
  // Against what this portfolio actually put at risk, not against a deposit it
  // does not have of its own.
  const ownBasePct = (value) => (ownStake > 0 ? value / ownStake : null);
  const realizedPnlPct = fixedEntry ? ownBasePct(ownRealized) : rawRealizedPct;
  const depositedLine = Number.isFinite(deposited)
    ? `Original value ${money(deposited)}`
    : "Original value not available";
  const redeemLine = Number.isFinite(pendingRedeem) && pendingRedeem > 0.000001
    ? `includes ${money(pendingRedeem)} pending redeem`
    : "";
  const liveSizingCapitalBase = Number.isFinite(equity) ? Math.max(0, equity - (Number.isFinite(openPnl) ? openPnl : 0)) : null;
  syncRiskAllocationControl(freeCash, "live portfolio equity excl. unrealized P/L", {
    baseCapital: liveSizingCapitalBase,
    cadenceLabel: "next live execution",
  });

  if (els.botAction) els.botAction.textContent = "live";
  if (els.botInlineAction) els.botInlineAction.textContent = `${positions.length} positions / ${openOrders.length} orders`;
  els.portfolioEquity.textContent = money(equity);
  els.portfolioEquity.className = pnlClass(totalPnlValue);
  els.portfolioLastRun.innerHTML = `
    <small class="metric-note">${escapeHtml(depositedLine)}</small>
    ${redeemLine ? `<small class="metric-note">${escapeHtml(redeemLine)}</small>` : ""}
  `;
  els.portfolioTotalPl.textContent = signedMoney(totalPnlValue);
  els.portfolioTotalPl.className = pnlClass(totalPnlValue);
  els.portfolioTotalPlPct.textContent = signedPercent(fixedEntry ? ownBasePct(ownRealized + ownOpen) : totalPnlPct);
  if (els.portfolioAnnualized) {
    els.portfolioAnnualized.textContent = "-";
    els.portfolioAnnualized.className = "";
  }
  if (els.portfolioPeriod) els.portfolioPeriod.textContent = "P/L % vs Original value";
  els.portfolioRealized.textContent = signedMoney(realizedPnl);
  els.portfolioRealized.className = pnlClass(realizedPnl);
  els.portfolioRealizedPct.textContent = signedPercent(realizedPnlPct);
  renderClosedAccuracy(closedTrades);
  els.portfolioOpenPl.textContent = signedMoney(openPnlValue);
  els.portfolioOpenPl.className = pnlClass(openPnlValue);
  els.portfolioOpenPlPct.textContent = signedPercent(fixedEntry ? ownBasePct(ownOpen) : openPnlPct);
  // Risk is what the open portfolio has committed, so both halves must come from
  // its own rows. openRiskUsdc totals every position in the wallet, so pairing it
  // with this portfolio's orders reported the other portfolio's positions as this
  // one's -- wrong on the Live tab and the 5050 tab alike, in opposite directions.
  els.portfolioRisk.textContent = money(ownPositionRisk + openOrderRisk);
  // Naming the other portfolio's share keeps the figure honest: the exchange reserves
  // for the whole wallet, so this much of it is spoken for even though this portfolio
  // does not count it against itself.
  els.portfolioFree.textContent = freeCash == null
    ? "cash not available"
    : `${money(freeCash)} free cash${otherPortfolioReservation > 0.01 ? ` (${money(otherPortfolioReservation)} locked by the other portfolio)` : ""}`;
  renderPortfolioEquityChart({
    trades: [...closedTrades, ...positions],
    equity,
    openPnl: openPnlValue,
    generatedAt: liveState.generatedAt,
  });

  if (els.accountSummary) {
    els.accountSummary.hidden = true;
    els.accountSummary.innerHTML = "";
  }
  renderSystemStatus(liveState);
  if (els.portfolioRules) {
    els.portfolioRules.innerHTML = `
    <div class="bot-summary">
      ${renderPortfolioRulesCard(isFixedEntryMode() ? "5050 portfolio" : "Live portfolio", livePortfolioRuleRows(), isFixedEntryMode() ? "live-5050" : null)}
    </div>
  `;
  }
  const liveWarning = [
    stateWarningHtml("live", "live account"),
    stateWarningHtml("paper", "common evaluation log"),
    stateWarningHtml("live-execution", "live execution monitor"),
  ].filter(Boolean).join("");
  els.botStatus.innerHTML = liveWarning;
  els.botStatus.hidden = !liveWarning;

  els.botTrades.innerHTML = renderTradeRows(openedRows, "Zatim zadne otevrene live pozice ani limit objednavky na napojenem Polymarket uctu.", {
    tableKey: "live",
    showStatus: false,
  });
  if (els.closedSummary) {
    const closedPnl = closedTrades.reduce((sum, trade) => sum + Number(trade.realizedPnlUsdc || 0), 0);
    els.closedSummary.textContent = `${closedTrades.length} closed / ${activity.length} events / ${signedMoney(closedPnl)}`;
  }
  if (els.closedTrades) {
    els.closedTrades.innerHTML = renderTradeRows(closedTrades, "Zatim zadne ukoncene live obchody na napojenem Polymarket uctu.", {
      tableKey: "liveClosed",
      showStatus: true,
    });
  }
  renderBotEvaluations();
  renderPortfolioCandidates();
  renderRunLog();
  renderCalculationReport();
  openOpportunityFromCurrentUrl();
}

function evaluationSortValue(item, key) {
  if (key === "evaluatedAt") return Date.parse(item.evaluatedAt || "") || 0;
  if (key === "status") return portfolioEvaluationStatus(item);
  if (key === "market") return `${item.outcome || ""} ${item.question || ""}`.toLowerCase();
  if (key === "endDate") return Date.parse(evaluationEndDate(item) || "") || 0;
  if (key === "daysLeft") return evaluationDaysLeft(item);
  if (key === "marketPrice") return Number(item.marketPrice);
  if (key === "odds") return decimalOdds(item.marketPrice);
  if (key === "gainIfWin") return gainIfWin(item);
  if (key === "netYield") return netYield(item);
  if (key === "riskReward") return evaluationRiskReward(item);
  if (key === "aiProbability") return Number(item.aiProbability);
  if (key === "potentialAnnualizedReturn") return potentialAnnualizedReturn(item);
  if (key === "updates") return Number(item.evaluationCount || 1);
  if (key === "analysis") return `${evaluationReasons(item).join("; ")} ${item.analysisSummary || ""}`.toLowerCase();
  return "";
}

function sortedEvaluations(evaluations) {
  const direction = state.evaluationSort.direction === "asc" ? 1 : -1;
  const key = state.evaluationSort.key;
  return [...evaluations].sort((a, b) => {
    const aValue = evaluationSortValue(a, key);
    const bValue = evaluationSortValue(b, key);
    const aMissing = aValue == null || Number.isNaN(aValue);
    const bMissing = bValue == null || Number.isNaN(bValue);
    if (aMissing && bMissing) return 0;
    if (aMissing) return 1;
    if (bMissing) return -1;
    if (typeof aValue === "number" && typeof bValue === "number") return (aValue - bValue) * direction;
    return String(aValue).localeCompare(String(bValue)) * direction;
  });
}

function filteredEvaluations(evaluations) {
  const statusFiltered = state.evaluationStatus === "ALL"
    ? evaluations
    : evaluations.filter((item) => portfolioEvaluationStatus(item) === state.evaluationStatus);
  const minProbability = currentEvaluationProbabilityFilter();
  const maxDays = currentEvaluationDaysFilter();
  const minNetYield = currentEvaluationNetYieldFilter();
  return statusFiltered.filter((item) => {
    const aiProbability = Number(item.aiProbability);
    if (minProbability > 0 && (!Number.isFinite(aiProbability) || aiProbability < minProbability)) return false;
    const days = evaluationDaysLeft(item);
    if (maxDays != null && (!Number.isFinite(days) || days > maxDays)) return false;
    const yieldValue = netYield(item);
    if (minNetYield > 0 && (!Number.isFinite(yieldValue) || yieldValue < minNetYield)) return false;
    return true;
  });
}

function sortableHeader(key, label) {
  const active = state.evaluationSort.key === key ? " active" : "";
  return `<th><div class="th-content"><button class="sort-button${active}" type="button" data-evaluation-sort="${key}">${label}${sortArrow(key)}</button>${headerInfoButton(EVALUATION_HEADER_INFO[key])}</div></th>`;
}

function gainCell(item) {
  const gain = gainIfWin(item);
  return `<span class="${Number(gain) >= 0 ? "positive" : "negative"}">${signedMoney(gain)}</span>`;
}

function netYieldCell(item) {
  const value = netYield(item);
  return `<span class="${pnlClass(value)}">${signedPercent(value)}</span>`;
}

function evaluationRiskRewardCell(item) {
  const value = evaluationRiskReward(item);
  return `<span class="${riskRewardClass(value)}">${riskReward(value)}</span>`;
}

function evaluationEndDateCell(item) {
  const endDate = evaluationEndDate(item);
  return `<span>${escapeHtml(endDate ? formatDate(endDate) : "-")}</span>`;
}

// firstAnalysisDate/reassessmentDate already carry this same "added vs updated" distinction
// for the Analysis modal's original/current comparison; reused here rather than a second
// notion of the same thing so a candidate that has been reassessed shows the reassessment,
// not just when it first entered the shortlist.
function candidateAddedOrUpdatedCell(item) {
  const added = firstAnalysisDate(item);
  const updated = reassessmentDate(item, added);
  const label = updated ? `Updated ${formatDate(updated)}` : (added ? `Added ${formatDate(added)}` : "-");
  return `<span>${escapeHtml(label)}</span>`;
}

function evaluationDaysLeftCell(item) {
  const days = evaluationDaysLeft(item);
  return Number.isFinite(days) ? compactDays(days) : "-";
}

function evaluatedPotentialAnnualizedCell(item) {
  const annualized = potentialAnnualizedReturn(item);
  return `<span class="${pnlClass(annualized)}">${signedPercent(annualized)}</span>`;
}

function updateHistoryCell(item) {
  const count = Number(item.evaluationCount || 1);
  const history = Array.isArray(item.updateHistory) ? item.updateHistory : [];
  const detail = [
    `Evaluations: ${count}`,
    item.firstEvaluatedAt ? `First: ${formatDate(item.firstEvaluatedAt)}` : "",
    item.lastSeenAt ? `Last: ${formatDate(item.lastSeenAt)}` : "",
    ...history.slice(0, 8).map((entry) => {
      const changes = Array.isArray(entry.changes) ? entry.changes : [];
      const lines = changes.slice(0, 8).map((change) => `${change.field}: ${change.from ?? "-"} -> ${change.to ?? "-"}`);
      return [`${formatDate(entry.changedAt || "")}:`, ...lines].join("\n");
    }),
  ].filter(Boolean).join("\n\n");

  return `
    <span>${count.toLocaleString("en-US")}</span>
    ${history.length ? `
      <span class="analysis-popover">
        <button class="info-button" type="button" aria-label="Show evaluation update history">i</button>
        <span class="analysis-tooltip" role="tooltip">${escapeHtml(detail)}</span>
      </span>
    ` : ""}
  `;
}

// A settled book prints 0 or 1, which would otherwise replace the market
// probability the row carried while it was still tradable and make every resolved
// entry read 0% or 100%. Keep showing the last live quote; the settlement outcome
// is reported separately through finalOutcomePrice and the resolution status.
// The price a scraped row is counted at by the statistics, mirroring
// scrapedSimulationProbability in the bot exactly. A settlement print of 0 or 1 is not a
// quote, so any genuinely live number on the row beats it, whichever field it sits in --
// and the first one recorded is the one a simulated entry would have paid.
function scrapedEntryProbability(item) {
  for (const candidate of [
    item?.firstMarketProbability,
    item?.lastLiveMarketProbability,
    item?.marketProbability,
    item?.marketPrice,
  ]) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric) && numeric > 0 && numeric < 1) return numeric;
  }
  return null;
}

function scrapedDisplayProbability(item) {
  const current = Number(item?.marketProbability ?? item?.marketPrice);
  const looksSettled = !Number.isFinite(current) || current <= 0 || current >= 1;
  if (!looksSettled) return current;
  // A settled row has no current price worth showing, so it shows the one it is counted
  // at -- which is also the one the probability filter now applies to it, so a row can no
  // longer display a number the filter it passed disagrees with.
  const entry = scrapedEntryProbability(item);
  return entry == null ? current : entry;
}

// The Resolved tab lists markets that no longer trade, so every tradability filter
// has nothing left to select on there.
function tradabilityFiltersAreIrrelevant() {
  return state.opportunityView === "scraped" && !state.scrapedStatuses.includes("SCRAPED");
}

function scrapedObservationStatus(item) {
  const status = String(item?.status || item?.selectionStatus || "").trim().toUpperCase();
  if (["RESOLVED", "CLOSED", "FINALIZED", "SETTLED"].includes(status) || evaluationEnded(item)) return "RESOLVED";
  return "SCRAPED";
}

function scrapedObservationFilterStatus(item) {
  return scrapedObservationStatus(item);
}

function scrapedObservationStatusClass(item) {
  const status = scrapedObservationStatus(item);
  return status === "SCRAPED" ? "positive" : "muted";
}

function scrapedSortValue(item, key) {
  if (key === "observedAt") return Date.parse(item.observedAt || item.marketDataUpdatedAt || "") || 0;
  if (key === "status") return scrapedObservationStatus(item);
  if (key === "market") return `${item.outcome || ""} ${item.question || ""}`.toLowerCase();
  if (key === "endDate") return Date.parse(item.endDate || "") || 0;
  if (key === "daysLeft") return evaluationDaysLeft(item);
  if (key === "marketProbability") return Number(scrapedDisplayProbability(item));
  if (key === "netGainIfWinUsdc") return gainIfWin(item);
  if (key === "netYield") return netYield(item);
  if (key === "potentialAnnualizedReturn") return potentialAnnualizedReturn(item);
  if (key === "marketAnnualizedReturn") return marketAnnualizedExpectedReturn(item);
  if (key === "marketExpectedValueUsdc") return marketExpectedValueFromQuote(item);
  if (key === "liquidity") return rowVolumeUsdc(item);
  return "";
}

function sortedScrapedObservations(rows = []) {
  const direction = state.scrapedSort.direction === "asc" ? 1 : -1;
  if (state.scrapedSort.key === "marketAnnualizedReturn") {
    state.scrapedSort.key = "potentialAnnualizedReturn";
  }
  const key = state.scrapedSort.key;
  return [...rows].sort((a, b) => {
    const aValue = scrapedSortValue(a, key);
    const bValue = scrapedSortValue(b, key);
    const aMissing = aValue == null || Number.isNaN(aValue);
    const bMissing = bValue == null || Number.isNaN(bValue);
    if (aMissing && bMissing) return 0;
    if (aMissing) return 1;
    if (bMissing) return -1;
    if (typeof aValue === "number" && typeof bValue === "number") return (aValue - bValue) * direction;
    return String(aValue).localeCompare(String(bValue)) * direction;
  });
}

function scrapedSortableHeader(key, label) {
  const active = state.scrapedSort.key === key ? " active" : "";
  const arrow = state.scrapedSort.key === key ? sortDirectionIndicator(state.scrapedSort.direction) : "";
  return `<th><div class="th-content"><button class="sort-button${active}" type="button" data-scraped-sort="${key}">${label}${arrow}</button></div></th>`;
}

function scrapedRefreshKey(item) {
  return String(item?.marketKey || opportunityKey(item) || item?.id || "").trim();
}

function findScrapedOpportunityByKey(key) {
  const wanted = String(key || "").trim();
  if (!wanted) return null;
  return scrapedMarketObservations().find((item) => scrapedRefreshKey(item) === wanted)
    || scrapedMarketObservations().find((item) => opportunityKey(item) === wanted)
    || null;
}

function scrapedRefreshControl(item) {
  const key = scrapedRefreshKey(item);
  if (!key || !item?.slug) return "-";
  const refreshing = state.scrapedRefreshKeys.has(key);
  const error = state.scrapedRefreshErrors.get(key);
  const title = refreshing
    ? "Refreshing this market from Polymarket..."
    : (error ? `Last refresh failed: ${error}` : "Refresh this market from Polymarket");
  return `
    <button
      class="scraped-refresh-button${refreshing ? " is-refreshing" : ""}${error ? " has-error" : ""}"
      type="button"
      data-scraped-refresh="${escapeHtml(key)}"
      aria-label="${escapeHtml(title)}"
      title="${escapeHtml(title)}"
      ${refreshing ? "disabled" : ""}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M20 11a8 8 0 1 0 2.2 5.5"></path>
        <path d="M20 4v7h-7"></path>
      </svg>
    </button>
  `;
}

function finalOutcomeCell(item) {
  const finalPrice = Number(item?.finalOutcomePrice);
  if (!Number.isFinite(finalPrice)) return "-";
  // finalOutcomePrice applies to the selected outcome shown in the Market column:
  // 1 means the simulated bet won, 0 means it lost. Do not infer this from the
  // original Yes/No book probabilities, which only describe the live quote.
  if (finalPrice >= 0.995) {
    return '<span class="positive"><strong>Won</strong><br><span>100.0%</span></span>';
  }
  if (finalPrice <= 0.005) {
    return '<span class="negative"><strong>Lost</strong><br><span>0.0%</span></span>';
  }
  return `<span>Final ${probability(finalPrice)}</span>`;
}

const SCRAPED_PAGE_SIZE = 250;

function scrapedVisibleCount(scope = "") {
  if (state.scrapedVisibleScope !== scope) {
    state.scrapedVisibleScope = scope;
    state.scrapedVisibleCount = SCRAPED_PAGE_SIZE;
  }
  return Math.max(SCRAPED_PAGE_SIZE, Number(state.scrapedVisibleCount) || SCRAPED_PAGE_SIZE);
}

function showMoreScrapedOpportunities() {
  if (scrapedVisibleCount(state.scrapedVisibleScope) >= Number(state.scrapedFilteredCount || 0)) return false;
  const scroller = els.botEvaluations?.querySelector(".ledger-scroll");
  const offset = scroller ? scroller.scrollTop : 0;
  state.scrapedVisibleCount = scrapedVisibleCount(state.scrapedVisibleScope) + SCRAPED_PAGE_SIZE;
  renderScrapedOpportunities();
  const nextScroller = els.botEvaluations?.querySelector(".ledger-scroll");
  if (nextScroller) nextScroller.scrollTop = offset;
  return true;
}

function renderScrapedOpportunities() {
  syncScrapedTaxonomyFilterControl();
  const catalogue = scrapedMarketObservations();
  const drilldownRequest = scrapedTaxonomyDrilldownRequest();
  const drilldownKey = scrapedTaxonomyDrilldownKey(drilldownRequest);
  // Served by the archive query, which already applied this taxonomy, these statuses and
  // this probability floor -- with the very predicates the performance tables count with.
  // Re-filtering them here could only make the list disagree with its own headline again.
  const drilldown = drilldownKey && state.scrapedTaxonomyRowsKey === drilldownKey
    ? state.scrapedTaxonomyRows
    : null;
  if (drilldownKey) loadScrapedTaxonomyRows();
  const observations = drilldown ? drilldown.rows : catalogue;
  const routeFilter = state.scrapedRouteFilter;
  const probabilityFilter = routeFilter ? routeFilter.probabilityFilter : currentEvaluationProbabilityFilter();
  const daysFilter = routeFilter ? routeFilter.daysFilter : currentEvaluationDaysFilter();
  const minNetYield = currentEvaluationNetYieldFilter();
  const minLiquidity = currentEvaluationLiquidityFilter();
  // `normalizedScrapedTaxonomyFilter()` only normalizes the value it receives.
  // Pass the stored route/UI selection explicitly; omitting it made every deep
  // linked taxonomy page quietly behave as if it had selected All.
  const taxonomyFilter = normalizedScrapedTaxonomyFilter(state.scrapedTaxonomyFilter);
  // A route filter is also created for ordinary status/taxonomy routes. It must not
  // override a market-type value selected in the live UI unless the URL explicitly
  // carried marketType (for example a link from the parameter report).
  const marketTypeFilter = routeFilter?.marketTypeExplicit
    ? normalizeScrapedMarketType(routeFilter.marketType)
    : normalizeScrapedMarketType(state.scrapedMarketTypeFilter);
  const selectedStatuses = routeFilter ? routeFilter.statuses : normalizeScrapedStatuses(state.scrapedStatuses);
  const statusFiltered = drilldown
    ? observations
    : observations.filter((item) => selectedStatuses.includes(scrapedObservationFilterStatus(item)));
  const filtered = statusFiltered.filter((item) => {
    // Taxonomy, status and entry price were all applied by the archive query for a
    // drill-down, with the statistics' own definitions. Re-deriving them here could only
    // reintroduce the disagreement. The filters below are the user's own further
    // narrowing, so they still apply.
    if (!drilldown && !scrapedTaxonomyFilterMatches(item, taxonomyFilter)) return false;
    if (marketTypeFilter !== "all" && scrapedMarketType(item) !== marketTypeFilter) return false;
    // Filtered on the price the statistics count this row at, not on today's quote.
    // These links come from the performance tables, and a count that does not match the
    // rows behind it is the report disagreeing with its own evidence. A resolved row is
    // settled anyway, so its current price was never the meaningful number.
    const isResolved = scrapedObservationStatus(item) === "RESOLVED";
    if (!drilldown) {
      const filterProbability = Number(isResolved ? scrapedEntryProbability(item) : scrapedDisplayProbability(item));
      if (probabilityFilter > 0 && (!Number.isFinite(filterProbability) || filterProbability < probabilityFilter)) return false;
      // The simulation cannot price a row with no live quote ever recorded, so it counts
      // none -- and a resolved list that shows them would again outnumber its own statistic.
      if (isResolved && scrapedEntryProbability(item) == null) return false;
    }
    // A resolved market no longer trades, so the tradability filters must not apply
    // to it. A missing "days left", a days ceiling, a stale net yield or a collapsed
    // post-settlement liquidity would each empty the Resolved tab on their own.
    if (scrapedObservationStatus(item) === "RESOLVED") return true;
    const days = evaluationDaysLeft(item);
    if (!Number.isFinite(days)) return false;
    if (daysFilter != null && days > daysFilter) return false;
    const yieldValue = netYield(item);
    if (minNetYield > 0 && (!Number.isFinite(yieldValue) || yieldValue < minNetYield)) return false;
    const liquidity = rowVolumeUsdc(item);
    return minLiquidity <= 0 || (Number.isFinite(liquidity) && liquidity >= minLiquidity);
  });
  const scope = JSON.stringify({
    statuses: selectedStatuses,
    taxonomy: taxonomyFilter,
    probabilityFilter,
    daysFilter,
    minNetYield,
    minLiquidity,
    marketTypeFilter,
    sort: state.scrapedSort,
  });
  const visibleLimit = scrapedVisibleCount(scope);
  const sorted = sortedScrapedObservations(filtered);
  const visible = sorted.slice(0, visibleLimit);
  const remaining = Math.max(0, sorted.length - visible.length);
  state.scrapedFilteredCount = sorted.length;
  const scan = scrapedMarketScan();
  const scrapedCount = catalogue.filter((item) => scrapedObservationFilterStatus(item) === "SCRAPED").length;
  const resolvedCount = catalogue.filter((item) => scrapedObservationFilterStatus(item) === "RESOLVED").length;
  // The archive query reports how many rows matched even when it returns fewer, so a
  // capped response still states the number the statistic it came from is showing. That
  // only holds while nothing was narrowed further here; once the user adds a filter of
  // their own, the honest number is what survived it.
  const matchedCount = drilldown && filtered.length === drilldown.rows.length
    ? drilldown.matched
    : filtered.length;
  if (els.evaluationFilterCount) {
    const filteredCount = formatInteger(matchedCount) || matchedCount;
    const visibleCount = formatInteger(visible.length) || visible.length;
    els.evaluationFilterCount.textContent = matchedCount > visible.length
      ? `${visibleCount} of ${filteredCount} shown`
      : `${filteredCount} shown`;
  }
  if (els.evaluationSummary) {
    const lastScan = scan.lastScanAt ? formatDate(scan.lastScanAt) : "pending";
    els.evaluationSummary.textContent = [
      `${formatInteger(matchedCount) || matchedCount} shown`,
      `${formatInteger(catalogue.length) || catalogue.length} retained`,
      `${formatInteger(scrapedCount) || scrapedCount} scraped`,
      `${formatInteger(resolvedCount) || resolvedCount} resolved`,
      scan.lastBatchCount != null ? `${formatInteger(scan.lastBatchCount)} in last batch` : null,
      scan.lastPreferredCount != null ? `${formatInteger(scan.lastPreferredCount)} preferred outcomes` : null,
      scan.lastShortHorizonCount != null ? `${formatInteger(scan.lastShortHorizonCount)} <= ${formatInteger(scan.preferredMaxResolutionDays || DEFAULT_MAX_RESOLUTION_DAYS)}d` : null,
      scan.lastCategoryCount != null ? `${formatInteger(scan.lastCategoryCount)} categories sampled` : null,
      scan.minResolutionMinutes != null
        ? `min ${formatInteger(scan.minResolutionMinutes) || scan.minResolutionMinutes} min buffer`
        : scan.minResolutionHours != null
          ? `min ${formatInteger(scan.minResolutionHours) || scan.minResolutionHours}h`
          : null,
      `last scan ${lastScan}`,
      scan.lastScanError ? `scan error: ${scan.lastScanError}` : null,
    ].filter(Boolean).join(" / ");
  }

  // A taxonomy view is never rendered from the catalogue the browser holds. That
  // catalogue is a capped page of the archive, so listing its subset is exactly how a
  // group reporting 937 trades came to show 12 of them.
  if (drilldownKey && !drilldown) {
    els.botEvaluations.innerHTML = state.scrapedTaxonomyRowsError
      ? `<div class="empty">The stored archive could not be read: ${escapeHtml(state.scrapedTaxonomyRowsError)}</div>`
      : '<div class="empty">Reading every stored opportunity in this group from the archive...</div>';
    return;
  }
  if (!observations.length) {
    els.botEvaluations.innerHTML = drilldown
      ? '<div class="empty">No stored opportunity is grouped under this category or tag at this probability.</div>'
      : '<div class="empty">No scraped Polymarket opportunities are available yet. The next market scan will add them here.</div>';
    return;
  }
  if (!visible.length) {
    els.botEvaluations.innerHTML = '<div class="empty">No scraped opportunities match the selected category, tag, probability, days-left, net-yield, or volume filters.</div>';
    return;
  }

  els.botEvaluations.innerHTML = `
    <div class="ledger-scroll" tabindex="0" aria-label="Scrollable scraped opportunities table">
      <table class="ledger-wide-table">
        <thead>
          <tr>
            ${scrapedSortableHeader("market", "Market")}
            ${scrapedSortableHeader("daysLeft", "Days left")}
            ${scrapedSortableHeader("marketProbability", "Mkt prob.")}
            ${scrapedSortableHeader("netGainIfWinUsdc", "Win @ $5")}
            ${scrapedSortableHeader("netYield", "Net yield %")}
            ${scrapedSortableHeader("potentialAnnualizedReturn", "Potential p.a.")}
            ${scrapedSortableHeader("liquidity", "Volume")}
            ${scrapedSortableHeader("observedAt", "Scraped")}
            ${scrapedSortableHeader("status", "Status")}
            ${scrapedSortableHeader("endDate", "End date")}
            <th>Final</th>
            <th><span class="table-action-heading" title="Refresh this one scraped market from Polymarket">Update</span></th>
          </tr>
        </thead>
        <tbody>
          ${visible.map((item) => `
            <tr>
              <td data-label="Market">${marketAnchor(item)}</td>
              <td data-label="Days left">${evaluationDaysLeftCell(item)}</td>
              <td data-label="Mkt prob.">${probability(Number(scrapedDisplayProbability(item)))}</td>
              <td data-label="Win @ $5">${gainCell(item)}</td>
              <td data-label="Net yield %">${netYieldCell(item)}</td>
              <td data-label="Potential p.a."><span class="${pnlClass(potentialAnnualizedReturn(item))}">${signedPercent(potentialAnnualizedReturn(item))}</span></td>
              <td data-label="Volume">${scrapedVolumeCell(item)}</td>
              <td data-label="Scraped">${escapeHtml(formatDate(item.observedAt || item.marketDataUpdatedAt || ""))}</td>
              <td data-label="Status" class="${scrapedObservationStatusClass(item)}"><strong>${scrapedObservationStatus(item)}</strong></td>
              <td data-label="End date">${evaluationEndDateCell(item)}</td>
              <td data-label="Final">${finalOutcomeCell(item)}</td>
              <td data-label="Update">${scrapedRefreshControl(item)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
    ${remaining ? `<div class="table-load-more"><button class="execution-button" type="button" data-scraped-load-more>Load more (${formatInteger(remaining) || remaining} remaining)</button></div>` : ""}
    ${drilldown?.truncated ? `<p class="calculation-note">${escapeHtml(
      `${formatInteger(matchedCount) || matchedCount} stored opportunities are in this group. `
      + `The newest ${formatInteger(drilldown.rows.length) || drilldown.rows.length} are listed; `
      + "the statistics above are computed over all of them.",
    )}</p>` : ""}
  `;
}

function scanLogCounts(value) {
  if (!value || typeof value !== "object") return "-";
  const entries = Object.entries(value)
    .filter(([, count]) => Number(count) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, 8);
  return entries.length
    ? entries.map(([label, count]) => `${label} (${formatInteger(count) || count})`).join(", ")
    : "-";
}

function scrapedOpportunityStatusCounts() {
  const counts = { all: 0, scraped: 0, resolved: 0 };
  for (const item of scrapedMarketObservations()) {
    counts.all += 1;
    const status = scrapedObservationStatus(item);
    if (status === "SCRAPED") counts.scraped += 1;
    else if (status === "RESOLVED") counts.resolved += 1;
  }
  // The backend reports what it actually retains. Counting only the rows that
  // survived response truncation made the tab labels drift downwards as the
  // archive grew, which read as records disappearing.
  const totals = state.scrapedObservationTotals;
  if (totals && Number.isFinite(Number(totals.resolved)) && Number(totals.resolved) > counts.resolved) {
    counts.all += Number(totals.resolved) - counts.resolved;
    counts.resolved = Number(totals.resolved);
  }
  return counts;
}

function scanLogReasonCounts(value, minimumMinutes = null) {
  const labels = {
    outside_selected_tag: "outside selected tag",
    no_valid_preferred_outcome_or_quote: "no valid preferred outcome/quote",
    settled_outcome_probability: "outcome already at 0% or 100%",
    resolved_or_closed: "market already resolved, closed, or not accepting orders",
    probability_below_scan_minimum: "probability below scan minimum",
    missing_resolution_date: "missing resolution date",
    too_close_to_resolution: Number.isFinite(Number(minimumMinutes))
      ? `less than ${Number(minimumMinutes)} min execution buffer`
      : "too close to resolution",
    outside_resolution_horizon: "outside resolution horizon",
    net_yield_below_scan_minimum: "net yield below scan minimum",
    liquidity_below_scan_minimum: "liquidity below scan minimum",
    scan_failed_before_retention: "scan failed before retention",
  };
  const entries = Object.entries(value && typeof value === "object" ? value : {})
    .filter(([, count]) => Number(count) > 0);
  return entries.length
    ? entries.map(([reason, count]) => `${labels[reason] || reason} (${formatInteger(count) || count})`).join(", ")
    : "Breakdown not recorded for this run";
}

function scanAuditActionClass(action) {
  const normalized = String(action || "").toUpperCase();
  if (normalized === "INSERT") return "positive";
  if (normalized === "UPDATE") return "muted";
  return "negative";
}

function renderScanAuditModal(payload = {}) {
  const run = payload?.run && typeof payload.run === "object" ? payload.run : {};
  const apiCalls = Array.isArray(payload?.apiCalls) ? payload.apiCalls : [];
  const markets = Array.isArray(payload?.markets) ? payload.markets : [];
  const status = String(run.status || "UNKNOWN").toUpperCase();
  return `
    <div class="analysis-detail-sections single-column scan-audit-detail">
      <section class="analysis-detail-section overview">
        <h3>Scan summary</h3>
        <div class="analysis-kv"><strong>Run:</strong><span>${escapeHtml(formatDate(run.runAt || ""))}</span></div>
        <div class="analysis-kv"><strong>Trigger:</strong><span>${escapeHtml(run.trigger || "AUTO")}</span></div>
        <div class="analysis-kv"><strong>Status:</strong><span class="analysis-status ${analysisStatusClass(status)}">${escapeHtml(status)}</span></div>
        <div class="analysis-kv"><strong>Markets:</strong><span>${formatInteger(markets.length) || "0"} recorded from ${formatInteger(apiCalls.length) || "0"} API calls</span></div>
        ${run.error ? `<div class="analysis-kv"><strong>Error:</strong><span class="negative">${escapeHtml(run.error)}</span></div>` : ""}
      </section>
      <section class="analysis-detail-section">
        <h3>Gamma Events API calls</h3>
        <div class="analysis-candidate-table-wrap">
          <table class="analysis-candidate-table scan-audit-api-table">
            <thead><tr><th>#</th><th>Scope</th><th>Parameters</th><th>Events / markets</th><th>Status</th></tr></thead>
            <tbody>${apiCalls.length ? apiCalls.map((call, index) => {
              const parameters = Object.entries(call?.parameters && typeof call.parameters === "object" ? call.parameters : {})
                .map(([key, value]) => {
                  if (key === "limit") return `page_size=${value} (all pages)`;
                  if (key === "after_cursor") return "after_cursor=previous page";
                  return `${key}=${value}`;
                })
                .join(" / ");
              const href = /^https:\/\//i.test(String(call?.url || "")) ? String(call.url) : "";
              const callStatus = String(call?.status || "UNKNOWN").toUpperCase();
              return `<tr>
                <td>${formatInteger(call?.sequence ?? index + 1) || index + 1}</td>
                <td><strong>${escapeHtml(call?.label || call?.scope || "Polymarket markets")}</strong>${call?.category ? `<small class="table-secondary">${escapeHtml(call.category)}</small>` : ""}</td>
                <td>${href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(parameters || href)}</a>` : escapeHtml(parameters || "-")}</td>
                <td>${Number.isFinite(Number(call?.returnedMarketCount))
                  ? `${formatInteger(call?.returnedEventCount ?? call?.returnedCount) || "0"} / ${formatInteger(call?.returnedMarketCount) || "0"}`
                  : (formatInteger(call?.returnedCount) || "0")}</td>
                <td class="${callStatus === "SUCCESS" ? "positive" : "negative"}"><strong>${escapeHtml(callStatus)}</strong>${call?.error ? `<small class="table-secondary">${escapeHtml(call.error)}</small>` : ""}</td>
              </tr>`;
            }).join("") : '<tr><td colspan="5">No API-call audit was recorded for this older run.</td></tr>'}</tbody>
          </table>
        </div>
      </section>
      <section class="analysis-detail-section">
        <h3>Markets obtained from returned events</h3>
        <div class="analysis-candidate-table-wrap">
          <table class="analysis-candidate-table scan-audit-market-table">
            <thead><tr><th>Market</th><th>Outcome</th><th>Probability</th><th>Days left</th><th>Volume</th><th>Categories</th><th>Result</th><th>Reason</th></tr></thead>
            <tbody>${markets.length ? markets.map((market) => {
              const href = /^https:\/\//i.test(String(market?.url || "")) ? String(market.url) : "";
              const action = String(market?.action || "NOT_SAVED").toUpperCase();
              const recordedDays = Number(market?.daysToEnd);
              const daysLeft = Number.isFinite(recordedDays)
                ? recordedDays
                : daysUntil(market?.endDate);
              const liquidity = rowVolumeUsdc(market);
              return `<tr>
                <td>${href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer"><strong>${escapeHtml(market?.question || "Untitled Polymarket market")}</strong></a>` : `<strong>${escapeHtml(market?.question || "Untitled Polymarket market")}</strong>`}</td>
                <td>${escapeHtml(market?.outcome || "-")}</td>
                <td>${Number.isFinite(Number(market?.marketProbability)) ? probability(Number(market.marketProbability)) : "-"}</td>
                <td>${compactDays(daysLeft)}</td>
                <td>${Number.isFinite(liquidity) ? money(liquidity) : "-"}</td>
                <td>${escapeHtml(Array.isArray(market?.categories) ? market.categories.join(", ") : market?.categories || "-")}</td>
                <td class="${scanAuditActionClass(action)}"><strong>${escapeHtml(action.replace("_", " "))}</strong></td>
                <td>${escapeHtml(market?.reason || "-")}</td>
              </tr>`;
            }).join("") : '<tr><td colspan="8">No market rows were returned by this scan.</td></tr>'}</tbody>
          </table>
        </div>
      </section>
    </div>
  `;
}

async function openScrapeRunAudit(run, trigger) {
  const runId = String(run?.id || "").trim();
  if (!runId) return;
  openAnalysisModal("Loading scraping audit...", trigger, {
    title: "Scraping run detail",
    singleColumn: true,
  });
  const modal = analysisModal();
  const body = modal.querySelector("[data-analysis-modal-body]");
  try {
    const payload = await fetchApiJson(`api.php?action=scan-audit&run_id=${encodeURIComponent(runId)}`);
    if (!modal.hidden && body) body.innerHTML = renderScanAuditModal(payload);
  } catch (error) {
    if (!modal.hidden && body) {
      body.innerHTML = `<div class="error">${escapeHtml(error?.message || "Scraping audit could not be loaded.")}</div>`;
    }
  }
}

function persistScrapedScanPreferences() {
  if (state.scrapedScanPreferenceSaveTimer) {
    clearTimeout(state.scrapedScanPreferenceSaveTimer);
  }
  state.scrapedScanPreferenceSaveTimer = window.setTimeout(async () => {
    try {
      await fetchApiJson("api.php?action=scan-preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          liquidityMin: currentEvaluationLiquidityFilter(),
          maxDays: currentEvaluationDaysFilter(),
        }),
      });
    } catch {
      // The local value remains usable for this manual scan; a later change retries persistence.
    } finally {
      state.scrapedScanPreferenceSaveTimer = null;
    }
  }, 350);
}

function renderScrapeRunLog() {
  const history = (Array.isArray(state.scrapedMarketScanHistory) ? state.scrapedMarketScanHistory : [])
    .slice()
    .sort((a, b) => (Date.parse(b.runAt || "") || 0) - (Date.parse(a.runAt || "") || 0));
  const latest = history[0] || scrapedMarketScan();
  if (els.evaluationFilterCount) {
    const total = Number.isFinite(state.scrapeHistoryTotal) && state.scrapeHistoryTotal > 0
      ? state.scrapeHistoryTotal
      : history.length;
    els.evaluationFilterCount.textContent = `${formatInteger(total) || total} recorded scraping runs`;
  }
  if (els.evaluationSummary) {
    els.evaluationSummary.textContent = [
      `${formatInteger(history.length) || history.length} runs recorded`,
      latest?.runAt ? `last run ${formatDate(latest.runAt)}` : "last run pending",
      latest?.status ? `last status ${String(latest.status).toLowerCase()}` : null,
      latest?.retainedObservationCount != null ? `${formatInteger(latest.retainedObservationCount)} rows retained last run` : null,
      latest?.error ? `last error: ${latest.error}` : null,
    ].filter(Boolean).join(" / ");
  }
  if (!history.length && state.scrapeHistoryBusy) {
    els.botEvaluations.innerHTML = '<div class="empty">Loading complete scraping history...</div>';
    return;
  }
  if (!history.length) {
    els.botEvaluations.innerHTML = '<div class="empty">No scraping runs have been recorded yet. The next scheduled market scan will appear here.</div>';
    return;
  }

  els.botEvaluations.innerHTML = `
    <div class="ledger-scroll" tabindex="0" aria-label="Scrollable Polymarket scraping run log">
      <table class="ledger-wide-table scraping-run-log-table">
        <thead>
          <tr>
            <th>Run time</th>
            <th>Trigger</th>
            <th>New / updated</th>
            <th>Categories</th>
            <th>Status</th>
            <th>API calls</th>
            <th>Markets pulled</th>
            <th>Rows retained</th>
            <th>Resolved</th>
            <th>Not retained</th>
            <th>Why not retained</th>
            <th>Tags</th>
            <th>Error</th>
          </tr>
        </thead>
        <tbody>
          ${history.map((run) => {
            const status = String(run.status || "UNKNOWN").toUpperCase();
            const statusClass = status === "ERROR" ? "negative" : status === "SUCCESS" ? "positive" : "";
            const auditAvailable = Boolean(run.auditAvailable);
            return `
              <tr class="${auditAvailable ? "scrape-run-row" : ""}" ${auditAvailable ? `data-scrape-run-audit="${escapeHtml(run.id || "")}" tabindex="0" role="button" aria-label="Open scraping audit for ${escapeHtml(formatDate(run.runAt || ""))}"` : ""}>
                <td data-label="Run time"><strong>${escapeHtml(formatDate(run.runAt || ""))}</strong><small class="table-secondary">${auditAvailable ? "Open audit" : "Summary retained"}</small></td>
                <td data-label="Trigger"><strong>${escapeHtml(run.trigger || "AUTO")}</strong></td>
                <td data-label="New / updated">${formatInteger(run.newObservationCount) || "0"} / ${formatInteger(run.updatedObservationCount) || "0"}</td>
                <td data-label="Categories"><strong>${escapeHtml(scanLogCounts(run.categoryCounts))}</strong>${Array.isArray(run.requestedCategories) && run.requestedCategories.length ? `<small class="table-secondary">API sweep: ${escapeHtml(run.requestedCategories.join(", "))}</small>` : ""}</td>
                <td data-label="Status" class="${statusClass}"><strong>${escapeHtml(status)}</strong></td>
                <td data-label="API calls">${formatInteger(run.apiCalls) || "0"}</td>
                <td data-label="Markets pulled"><strong>${formatInteger(run.rawMarketCount ?? run.loadedMarketCount) || "0"}</strong><small class="table-secondary">${formatInteger(run.loadedMarketCount) || "0"} unique / all returned pages / ${formatInteger((run.requestedCategories || []).length) || "0"} category scopes</small></td>
                <td data-label="Rows retained"><strong>${formatInteger(run.retainedObservationCount) || "0"}</strong><small class="table-secondary">${formatInteger(run.shortHorizonCount) || "0"} within preferred horizon</small></td>
                <td data-label="Resolved">${formatInteger(run.resolvedObservationCount) || "0"}</td>
                <td data-label="Not retained">${formatInteger(run.notRetainedCount) || "0"}</td>
                <td data-label="Why not retained"><small>${escapeHtml(scanLogReasonCounts(run.notRetainedReasonCounts, run.minResolutionMinutes))}</small></td>
                <td data-label="Tags">${escapeHtml(scanLogCounts(run.tagCounts))}</td>
                <td data-label="Error" class="${run.error ? "negative" : ""}">${escapeHtml(run.error || "-")}</td>
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    </div>
    ${state.scrapeHistoryError ? `<div class="empty negative">${escapeHtml(state.scrapeHistoryError)}</div>` : ""}
    ${state.scrapeHistoryHasMore ? `<div class="table-load-more"><button class="execution-button" type="button" data-scrape-history-load-more ${state.scrapeHistoryBusy ? "disabled" : ""}>${state.scrapeHistoryBusy ? "Loading..." : "Load older runs"}</button></div>` : ""}
  `;
}

function renderBotEvaluations() {
  syncOpportunityViewControls();
  if (state.opportunityView === "scan-log") {
    renderScrapeRunLog();
    return;
  }
  if (state.opportunityView === "scraped") {
    renderScrapedOpportunities();
    return;
  }
  const evaluations = Array.isArray(state.botState?.evaluations) ? state.botState.evaluations : [];
  const evaluatedCount = evaluations.filter((item) => portfolioEvaluationStatus(item) === "EVALUATED").length;
  const resolvedCount = evaluations.filter((item) => portfolioEvaluationStatus(item) === "RESOLVED").length;
  const errorCount = evaluations.filter((item) => portfolioEvaluationStatus(item) === "ERROR").length;
  const filtered = filteredEvaluations(evaluations);
  const filteredCount = filtered.length;
  const probabilityFilter = currentEvaluationProbabilityFilter();
  const daysFilter = currentEvaluationDaysFilter();
  const minNetYield = currentEvaluationNetYieldFilter();

  if (els.evaluationFilterCount) {
    const countText = formatInteger(filteredCount) || String(filteredCount);
    const filters = [
      probabilityFilter > 0 ? `AI >= ${(probabilityFilter * 100).toFixed(0)}%` : "",
      daysFilter != null ? `days <= ${daysFilter}` : "",
      minNetYield > 0 ? `net yield >= ${(minNetYield * 100).toFixed(1)}%` : "",
    ].filter(Boolean);
    els.evaluationFilterCount.textContent = filters.length
      ? `${countText} matching ${filters.join(" / ")}`
      : `${countText} matching current filters`;
  }

  if (els.evaluationSummary) {
    const stats = state.botState?.evaluationStats || {};
    const retainedLimit = formatInteger(stats.retainedLimit);
    const totalEvaluated = formatInteger(stats.totalRunEvaluatedCount);
    const lastRunEvaluated = formatInteger(stats.lastRunEvaluatedCount);
    const aiUsage = state.botState?.aiUsage || stats.aiUsage || {};
    const aiEvaluation = state.botState?.aiEvaluation || {};
    const aiUsageText = Number.isFinite(Number(aiUsage.requestsLast24Hours))
      ? `AI usage ${formatInteger(aiUsage.requestsLastMinute || 0)}/min / ${formatInteger(aiUsage.requestsLastHour || 0)}/h / ${formatInteger(aiUsage.requestsLast24Hours)} of ${formatInteger(aiUsage.maxRequestsPer24Hours)} in 24h; capacity ${formatInteger(aiUsage.estimatedDailyCapacity)}/day`
      : "AI usage pending";
    const aiQuotaBackoffText = aiEvaluation.lastStatus === "QUOTA_BACKOFF" || aiUsage.quotaBlockedUntil
      ? `AI evaluation paused until ${formatDate(aiEvaluation.nextRetryAt || aiUsage.quotaBlockedUntil)}`
      : aiEvaluation.lastRunAt
        ? `AI last run ${formatDate(aiEvaluation.lastRunAt)} / ${formatInteger(aiEvaluation.lastEvaluatedCount || 0)} evaluated`
        : "AI evaluation has not run yet";
    const retainedText = `${formatInteger(evaluations.length) || evaluations.length}${retainedLimit ? ` / ${retainedLimit} retained cap` : " retained"}`;
    els.evaluationSummary.textContent = [
      `${formatInteger(filteredCount) || filteredCount} shown`,
      `${formatInteger(evaluatedCount) || evaluatedCount} active evaluated`,
      `${formatInteger(resolvedCount) || resolvedCount} resolved`,
      `${formatInteger(errorCount) || errorCount} errors`,
      retainedText,
      totalEvaluated ? `${totalEvaluated} evaluated by runs` : null,
      lastRunEvaluated ? `${lastRunEvaluated} last run` : null,
      aiUsageText,
      aiQuotaBackoffText,
    ].filter(Boolean).join(" / ");
  }

  if (!evaluations.length) {
    els.botEvaluations.innerHTML = '<div class="empty">Zatim zadna vyhodnoceni.</div>';
    return;
  }

  const visibleEvaluations = sortedEvaluations(filtered).slice(0, 80);

  if (!visibleEvaluations.length) {
    els.botEvaluations.innerHTML = `<div class="empty">No ${evaluationFilterLabel(state.evaluationStatus)} markets match the selected evaluation filters.</div>`;
    return;
  }

  els.botEvaluations.innerHTML = `
    <div class="ledger-scroll" tabindex="0" aria-label="Scrollable evaluated opportunities table">
    <table class="ledger-wide-table">
      <thead>
        <tr>
          ${sortableHeader("evaluatedAt", "Time")}
          ${sortableHeader("status", "Status")}
          ${sortableHeader("market", "Market")}
          ${sortableHeader("endDate", "End date")}
          ${sortableHeader("daysLeft", "Days left")}
          ${sortableHeader("marketPrice", "Mkt entry")}
          ${sortableHeader("odds", "Odds")}
          ${sortableHeader("gainIfWin", "Win @ $5")}
          ${sortableHeader("netYield", "Net yield %")}
          ${sortableHeader("riskReward", "R/R")}
          ${sortableHeader("potentialAnnualizedReturn", "Potential p.a.")}
          ${sortableHeader("updates", "Updates")}
          ${sortableHeader("analysis", "Analysis")}
        </tr>
      </thead>
      <tbody>
        ${visibleEvaluations.map((item) => `
          <tr>
            <td data-label="Time">${escapeHtml(formatDate(item.evaluatedAt || ""))}</td>
            <td data-label="Status" class="${evaluationStatusClass(item)}">${evaluationStatusCell(item)}</td>
            <td data-label="Market">
              ${marketAnchor(item)}
            </td>
            <td data-label="End date">${evaluationEndDateCell(item)}</td>
            <td data-label="Days left">${evaluationDaysLeftCell(item)}</td>
            <td data-label="Mkt entry">
              ${probability(Number(item.marketPrice))}
            </td>
            <td data-label="Odds">${odds(decimalOdds(item.marketPrice))}</td>
            <td data-label="Win @ $5">${gainCell(item)}</td>
            <td data-label="Net yield %">${netYieldCell(item)}</td>
            <td data-label="R/R">${evaluationRiskRewardCell(item)}</td>
            <td data-label="Potential p.a.">${evaluatedPotentialAnnualizedCell(item)}</td>
            <td data-label="Updates">${updateHistoryCell(item)}</td>
            <td data-label="Analysis">
              ${analysisBadge(item)}
              ${item.tokenId ? `<button class="manual-evaluation-button" type="button" data-manual-evaluation="${escapeHtml(opportunityKey(item))}" title="Run Gemini evaluation for this Polymarket outcome">Evaluate now</button>` : ""}
            </td>
          </tr>
        `).join("")}
      </tbody>
    </table>
    </div>
  `;
}

function runEventDetail(event) {
  const reasons = Array.isArray(event.rejectReasons) && event.rejectReasons.length
    ? event.rejectReasons.join("; ")
    : "No portfolio filter note recorded.";
  return structuredAnalysisDetails(event, {
    title: `${event.outcome || "-"} - ${event.question || "-"}`,
    filterNote: [
      `Evaluation result: ${runEventResultLabel(event)}`,
      `Portfolio filter status at run time: ${event.portfolioFilterStatus || event.status || "-"}`,
      "Portfolio eligibility is applied separately by the active portfolio rules.",
      `Analysis URL: ${absoluteOpportunityDetailUrl(event)}`,
      reasons,
    ].join(" / "),
  });
}

function openOpportunityDetail(item, trigger = null, { push = true } = {}) {
  if (!item) return false;
  const key = opportunityKey(item);
  if (!key) return false;
  if (push) {
    window.history.pushState({ page: "opportunities", event: key }, "", opportunityDetailUrl(key));
  }
  activatePage("opportunities", { replace: true, preserveSearch: true });
  state.openedOpportunityKey = key;
  openAnalysisModal(runEventDetail(item), trigger, { opportunityKey: key });
  return true;
}

function openOpportunityFromCurrentUrl() {
  const key = currentOpportunityKeyFromUrl();
  if (!key || key === state.openedOpportunityKey) return;
  const item = findOpportunityByKey(key);
  if (item) {
    openOpportunityDetail(item, null, { push: false });
  }
}

function runEventResultLabel(event) {
  const result = String(event.evaluationResult || "").toUpperCase();
  if (result === "ERROR") return "ERROR";
  const status = String(event.status || "").toUpperCase();
  if (status === "ERROR") return "ERROR";
  return "EVALUATED";
}

function runEventResultClass(event) {
  return runEventResultLabel(event) === "ERROR" ? "negative" : "positive";
}

function tradeBatchDetail(batch) {
  if (!batch) return "No trade batch detail available.";
  const settings = batch.settings || {};
  const capital = batch.capital || {};
  const counts = batch.counts || {};
  const selected = batch.selected;
  const candidates = Array.isArray(batch.eligibleCandidates) && batch.eligibleCandidates.length
    ? batch.eligibleCandidates
    : (Array.isArray(batch.topCandidates) ? batch.topCandidates : []);
  const blocked = Array.isArray(batch.riskBlocked) ? batch.riskBlocked : [];
  const rejected = Array.isArray(batch.topRejected) ? batch.topRejected : [];
  const revalidated = Array.isArray(batch.revalidatedCandidates) && batch.revalidatedCandidates.length
    ? batch.revalidatedCandidates
    : [...candidates, ...rejected];
  const openOrderReviews = Array.isArray(batch.openOrderReviews) ? batch.openOrderReviews : [];
  const rotationReview = batch.rotationReview || null;
  const rotationComparison = Array.isArray(batch.rotationComparison) ? batch.rotationComparison : [];
  const diversificationDiagnostics = batch.diversificationDiagnostics || null;
  const portfolioFilter = batch.portfolioFilter || {};
  const prevalidationFilter = batch.prevalidationFilter || {};
  const usesPolymarketProbability = normalizeProbabilitySource(settings.probabilitySource) === "polymarket";
  const probabilityMetricLabel = usesPolymarketProbability ? "Mkt" : "AI";
  const returnMetricLabel = usesPolymarketProbability ? "Potential p.a." : "EV p.a.";
  const candidateSelectedAnnualizedReturn = (item) => {
    if (!usesPolymarketProbability) return Number(item.annualizedReturn);
    const net = Number(item.netYield);
    const days = Number(item.daysToResolution);
    if (!Number.isFinite(net)) return Number(item.annualizedReturn);
    return annualizeReturn(net, days);
  };
  const candidateSelectedValue = (item) => usesPolymarketProbability
    ? Number(item.netGainIfWinUsdc)
    : Number(item.expectedValueUsdc);
  const candidateMetricLine = (item) => [
    `${probabilityMetricLabel} ${probability(Number(usesPolymarketProbability ? item.marketProbability : item.aiProbability))}`,
    `entry ${probability(Number(item.marketPrice ?? item.orderPrice))}`,
    item.netGainIfWinUsdc != null ? `win ${signedMoney(Number(item.netGainIfWinUsdc), 4)}` : "",
    item.netYield != null ? `win ${signedPercent(Number(item.netYield))}` : "",
    item.riskReward != null ? `R/R ${riskReward(Number(item.riskReward))}` : "",
    `${returnMetricLabel} ${signedPercent(candidateSelectedAnnualizedReturn(item))}`,
    `${usesPolymarketProbability ? "Potential" : "EV"} ${signedMoney(candidateSelectedValue(item), 4)}`,
    item.daysToResolution != null ? `resolution ${Number(item.daysToResolution).toFixed(2)}d` : "",
    rowVolumeUsdc(item) > 0 ? `volume ${money(rowVolumeUsdc(item))}` : "",
  ].filter(Boolean).join(" / ");
  const comparisonMetricLine = (comparison) => {
    if (!comparison) return "";
    const metric = String(comparison.metricLabel || "EV p.a.");
    const display = (value) => metric === "R/R"
      ? riskReward(Number(value))
      : signedPercent(Number(value));
    const delta = comparison.metricDelta == null ? "-" : `${comparison.metricDelta >= 0 ? "+" : ""}${display(comparison.metricDelta)}`;
    const days = Number.isFinite(Number(comparison.currentDaysToResolution)) && Number.isFinite(Number(comparison.replacementDaysToResolution))
      ? `; resolution ${Number(comparison.currentDaysToResolution).toFixed(2)}d -> ${Number(comparison.replacementDaysToResolution).toFixed(2)}d`
      : "";
    const exitPnl = Number.isFinite(Number(comparison.currentRealizedPnlIfExitUsdc))
      ? `; exit P/L after fees ${signedMoney(Number(comparison.currentRealizedPnlIfExitUsdc), 4)}`
      : "";
    return `${metric}: ${display(comparison.currentMetric)} -> ${display(comparison.replacementMetric)} (${delta}); expected value ${signedMoney(Number(comparison.currentExpectedValue), 4)} -> ${signedMoney(Number(comparison.replacementExpectedValue), 4)}${days}${exitPnl} (${comparison.replacementRanksAhead ? "replacement ranks ahead" : "current order ranks ahead"})`;
  };
  const filterReasonLines = portfolioFilter.reasonCounts && typeof portfolioFilter.reasonCounts === "object"
    ? Object.entries(portfolioFilter.reasonCounts)
        .sort((a, b) => Number(b[1]) - Number(a[1]))
        .map(([reason, count]) => `- ${count}x ${reason}`)
        .join("\n")
    : "-";
  const candidateLines = candidates.length
    ? candidates.map((item, index) => [
        `${index + 1}. ${item.outcome || "-"} - ${item.question || "-"}`,
        `   ${candidateMetricLine(item)}`,
        item.selectionDecision ? `   Decision: ${item.selectionDecision}` : "",
        item.riskBlockedReason ? `   Risk blocked: ${item.riskBlockedReason}` : "",
        Array.isArray(item.rejectReasons) && item.rejectReasons.length ? `   Notes: ${item.rejectReasons.join("; ")}` : "",
        opportunityKey(item) ? `   Analysis: ${absoluteOpportunityDetailUrl(item)}` : "",
        item.url ? `   Polymarket: ${item.url}` : "",
      ].filter(Boolean).join("\n")).join("\n\n")
    : "No eligible candidates passed this portfolio filter.";
  const rejectionReasonLine = (item) => {
    const reasons = [
      ...(Array.isArray(item.rejectReasons) ? item.rejectReasons : []),
      ...(Array.isArray(item.portfolioRejectReasons) ? item.portfolioRejectReasons : []),
      item.riskBlockedReason,
      item.sizingNote,
    ].map((reason) => String(reason || "").trim()).filter(Boolean);
    if (reasons.length) return reasons.join("; ");
    const status = String(item.status || "").trim();
    return status && status.toUpperCase() !== "ELIGIBLE"
      ? `status ${status}`
      : "No rejection reason was recorded.";
  };
  const rejectedLines = rejected.length
    ? rejected.map((item, index) => [
        `${index + 1}. ${item.outcome || "-"} - ${item.question || "-"}`,
        `   ${candidateMetricLine(item)}`,
        `   Why not: ${rejectionReasonLine(item)}`,
        opportunityKey(item) ? `   Analysis: ${absoluteOpportunityDetailUrl(item)}` : "",
        item.url ? `   Polymarket: ${item.url}` : "",
      ].filter(Boolean).join("\n")).join("\n\n")
    : "-";
  const executionShortlist = Array.isArray(prevalidationFilter.executionShortlist) ? prevalidationFilter.executionShortlist : [];
  const executionShortlistLines = executionShortlist.length
    ? executionShortlist.map((item, index) => [
        `${index + 1}. ${item.outcome || "-"} - ${item.question || "-"}`,
        `   ${candidateMetricLine(item)}`,
        opportunityKey(item) ? `   Analysis: ${absoluteOpportunityDetailUrl(item)}` : "",
        item.url ? `   Polymarket: ${item.url}` : "",
      ].filter(Boolean).join("\n")).join("\n\n")
    : "-";
  const revalidatedLines = revalidated.length
    ? revalidated.map((item, index) => [
        `${index + 1}. ${item.outcome || "-"} - ${item.question || "-"}`,
        `   Status: ${item.status || "-"}`,
        `   ${candidateMetricLine(item)}`,
        String(item.status || "").toUpperCase() === "ELIGIBLE" ? "   Why: passes current execution criteria" : `   Why not: ${rejectionReasonLine(item)}`,
        opportunityKey(item) ? `   Analysis: ${absoluteOpportunityDetailUrl(item)}` : "",
        item.url ? `   Polymarket: ${item.url}` : "",
      ].filter(Boolean).join("\n")).join("\n\n")
    : "-";
  const blockedLines = blocked.length
    ? blocked.map((item) => `- ${item.outcome || "-"} / ${item.question || "-"}: ${item.riskBlockedReason || "risk overlap"}`).join("\n")
    : "-";
  const orderReviewLines = openOrderReviews.length
    ? openOrderReviews.map((item, index) => [
        `${index + 1}. ${item.action || "-"} / ${item.outcome || "-"} / ${item.question || item.tokenId || "-"}`,
        `   Order: ${item.orderId || "-"} / price ${probability(Number(item.price))} / remaining ${Number(item.remainingSize || 0).toLocaleString("en-US", { maximumFractionDigits: 4 })} / age ${Number(item.ageHours || 0).toFixed(1)}h`,
        item.priceDelta != null ? `   Reprice delta: ${(Number(item.priceDelta) * 100).toFixed(1)} pts` : "",
        item.selectionComparison ? `   Priority comparison: ${comparisonMetricLine(item.selectionComparison)}` : "",
        `   Reason: ${item.reason || "-"}`,
        item.betterCandidate ? `   Better candidate: ${item.betterCandidate.outcome || "-"} - ${item.betterCandidate.question || "-"} / EV ${signedMoney(Number(item.betterCandidate.expectedValueUsdc), 4)}` : "",
        item.cancelResponse ? `   Cancel response: ${JSON.stringify(item.cancelResponse).slice(0, 240)}` : "",
        item.replaceResponse ? `   Replace response: ${JSON.stringify(item.replaceResponse).slice(0, 240)}` : "",
      ].filter(Boolean).join("\n")).join("\n\n")
    : "-";
  const diversificationLines = diversificationDiagnostics
    ? [
        `Open positions considered: ${Number(diversificationDiagnostics.openTrades || 0)}`,
        `Occupied categories: ${Object.keys(diversificationDiagnostics.occupiedCategories || {}).join(", ") || "-"}`,
        `Occupied tags: ${Object.keys(diversificationDiagnostics.occupiedTags || {}).join(", ") || "-"}`,
        "",
        "Priority markets for broader pre-evaluation:",
        ...(Array.isArray(diversificationDiagnostics.topDiversifiedMarkets)
          ? diversificationDiagnostics.topDiversifiedMarkets.slice(0, 8).map((item, index) => [
              `${index + 1}. ${item.question || item.slug || "-"}`,
              `   Category/tags: ${item.category || "-"} / ${(item.tags || []).join(", ") || "-"}`,
              `   Diversification score: ${Number(item.diversificationScore || 0).toFixed(1)}`,
              Array.isArray(item.reasons) && item.reasons.length ? `   Why: ${item.reasons.join("; ")}` : "",
            ].filter(Boolean).join("\n"))
          : []),
      ].filter(Boolean).join("\n")
    : "-";
  const rotationReviewLines = rotationReview
    ? [
        `Action: ${rotationReview.action || "-"}`,
        `Reason: ${rotationReview.reason || "-"}`,
        rotationReview.best?.position ? [
          `Best position to sell: ${rotationReview.best.position.outcome || "-"} - ${rotationReview.best.position.question || "-"}`,
          `   Estimated exit: ${money(Number(rotationReview.best.position.estimatedExitValueUsdc || 0))} / current P/L ${signedMoney(Number(rotationReview.best.position.unrealizedPnlUsdc || 0), 4)}`,
          rotationReview.best.position.estimatedExitFeeUsdc != null ? `   Estimated exit fee: ${money(Number(rotationReview.best.position.estimatedExitFeeUsdc))} / net P/L if exited: ${signedMoney(Number(rotationReview.best.position.realizedPnlIfExitUsdc || 0), 4)}` : "",
          rotationReview.best.position.rotationPriorityValue != null ? `   Rotation priority (${rotationReview.best.position.rotationPriorityMetric || "EV p.a."}): ${rotationReview.best.position.rotationPriorityMetric === "R/R" ? `${Number(rotationReview.best.position.rotationPriorityValue).toFixed(2)}:1` : signedPercent(Number(rotationReview.best.position.rotationPriorityValue))}` : "",
          rotationReview.best.position.usesPendingResolutionReference ? `   Pending settlement reference: ${signedPercent(Number(rotationReview.best.position.pendingResolutionReferenceAnnualizedReturn || 0))}; remaining potential gain ${signedMoney(Number(rotationReview.best.position.remainingPotentialGainUsdc || 0), 4)}` : "",
          rotationReview.best.position.url ? `   Polymarket: ${rotationReview.best.position.url}` : "",
        ].filter(Boolean).join("\n") : "",
        rotationReview.best?.candidate ? [
          `Replacement candidate: ${rotationReview.best.candidate.outcome || "-"} - ${rotationReview.best.candidate.question || "-"}`,
          `   ${candidateMetricLine(rotationReview.best.candidate)}`,
          rotationReview.best.candidate.url ? `   Polymarket: ${rotationReview.best.candidate.url}` : "",
        ].filter(Boolean).join("\n") : "",
        rotationReview.best?.evDeltaUsdc != null ? `Expected value improvement: ${signedMoney(Number(rotationReview.best.evDeltaUsdc), 4)}` : "",
        Array.isArray(rotationReview.reviews) && rotationReview.reviews.length ? [
          "Reviewed positions:",
          rotationReview.reviews.slice(0, 8).map((item, index) => {
            const position = item.position || item;
            const candidate = item.candidate || null;
            return [
              `${index + 1}. ${position.outcome || item.outcome || "-"} - ${position.question || item.question || "-"}`,
              position.rotationPriorityValue != null ? `   Rotation priority (${position.rotationPriorityMetric || "EV p.a."}): ${position.rotationPriorityMetric === "R/R" ? `${Number(position.rotationPriorityValue).toFixed(2)}:1` : signedPercent(Number(position.rotationPriorityValue))}` : "",
              position.usesPendingResolutionReference ? `   Settlement-pending reference: ${signedPercent(Number(position.pendingResolutionReferenceAnnualizedReturn || 0))}; remaining potential gain ${signedMoney(Number(position.remainingPotentialGainUsdc || 0), 4)}` : "",
              position.estimatedExitFeeUsdc != null ? `   Net P/L if exited now: ${signedMoney(Number(position.realizedPnlIfExitUsdc || 0), 4)} after estimated ${money(Number(position.estimatedExitFeeUsdc))} exit fee` : "",
              `   Action: ${item.action || "-"}`,
              `   Reason: ${item.reason || "-"}`,
              item.cashAfterExitUsdc != null ? `   Cash after exit: ${money(Number(item.cashAfterExitUsdc))}` : "",
              item.evDeltaUsdc != null ? `   EV delta: ${signedMoney(Number(item.evDeltaUsdc), 4)}` : "",
              item.rotatedExpectedPnlUsdc != null ? `   Expected P/L: hold ${signedMoney(Number(item.holdExpectedPnlUsdc || 0), 4)} / rotate ${signedMoney(Number(item.rotatedExpectedPnlUsdc || 0), 4)}` : "",
              candidate ? `   Candidate: ${candidate.outcome || "-"} - ${candidate.question || "-"} / EV ${signedMoney(Number(candidate.expectedValueUsdc || 0), 4)}` : "",
            ].filter(Boolean).join("\n");
          }).join("\n\n"),
        ].join("\n") : "",
      ].filter(Boolean).join("\n")
    : "-";
  const rotationComparisonLines = rotationComparison.length
    ? rotationComparison.slice(0, 12).map((item, index) => {
        const metric = String(item.current?.metricLabel || item.candidate?.metricLabel || returnMetricLabel);
        const formatMetric = (value) => metric === "R/R"
          ? riskReward(Number(value))
          : signedPercent(Number(value));
        const current = item.current || {};
        const candidate = item.candidate || null;
        const currentText = `${current.label || "current exposure"} (${formatMetric(current.metricValue)}, ${Number.isFinite(Number(current.daysToResolution)) ? `${Number(current.daysToResolution).toFixed(2)}d` : "-"}, potential win ${money(Number(current.potentialWinUsdc || 0))})`;
        const candidateText = candidate
          ? `${candidate.label || "replacement candidate"} (${formatMetric(candidate.metricValue)}, ${Number.isFinite(Number(candidate.daysToResolution)) ? `${Number(candidate.daysToResolution).toFixed(2)}d` : "-"}, potential win ${money(Number(candidate.potentialWinUsdc || 0))})`
          : "no executable replacement";
        const improvement = item.metricDelta == null ? "" : `; improvement ${formatMetric(item.metricDelta)} (minimum ${formatMetric(Number(item.minimumImprovement || 0))})`;
        const result = item.expectedValueDeltaUsdc == null ? "" : `; expected P/L delta ${signedMoney(Number(item.expectedValueDeltaUsdc), 4)}`;
        const pendingReference = current.usesPendingResolutionReference
          ? `; pending-settlement reference ${formatMetric(current.pendingResolutionReferenceAnnualizedReturn)}, remaining potential gain ${signedMoney(Number(current.remainingPotentialGainUsdc || 0), 4)}`
          : "";
        return `${index + 1}. ${item.kind === "order" ? "Order" : "Position"}: ${currentText} -> ${candidateText}${improvement}${result}${pendingReference}; ${item.action || "reviewed"}`;
      }).join("\n")
    : "-";

  const normalizeDetailText = (value) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  const action = String(batch.action || "-").toUpperCase();
  const primaryReason = String(batch.humanReason || batch.reason || batch.explanation || "-").trim();
  const explanation = String(batch.explanation || "").trim();
  const reviewedCandidates = executionCandidatesNotUsed(batch);
  const reviewedCandidateLines = reviewedCandidates.map((item, index) => {
    const name = `${item.outcome || "-"} - ${item.question || "-"}`;
    const reason = executionCandidateRejectionReason(item);
    return `${index + 1}. ${name}${reason ? ` — ${reason}` : ""}`;
  }).join("\n");
  const orderReviewSummary = openOrderReviews.map((item, index) => {
    const name = item.question || item.outcome || item.tokenId || "open order";
    return `${index + 1}. ${item.action || "REVIEWED"}: ${name}${item.reason ? ` — ${item.reason}` : ""}`;
  }).join("\n");
  // rotationReviewLines already carries the per-position breakdown built above --
  // action, reason, cash-after-exit, EV delta, and the candidate tried for every
  // reviewed position (rotationReview.reviews), not just the outer summary. It used
  // to be computed and then never referenced: this section showed only "Decision: X
  // / Reason: Y" with no way to see which positions were even considered or why
  // each one's replacement attempt failed, which is exactly what made a working
  // rotation review indistinguishable from a skipped one.
  const rotationSummary = rotationReview
    ? rotationReviewLines
    : (rotationComparison.length ? rotationComparisonLines : "");
  const capitalText = [
    Number.isFinite(Number(capital.availableUsdc)) ? `${money(Number(capital.availableUsdc))} available` : "",
    Number.isFinite(Number(capital.requiredStakeUsdc)) ? `${money(Number(capital.requiredStakeUsdc))} required` : "",
    capital.insufficientCapital ? "capital insufficient" : "",
  ].filter(Boolean).join(" / ");
  const capitalRelevant = capitalText && (
    capital.insufficientCapital
    || /cash|capital|stake|fund|minimum order/i.test(`${batch.reason || ""} ${batch.explanation || ""}`)
    || action.includes("ROTATION")
  );
  // A batch pass works through many events, and a time budget can stop it part way. How
  // far it got is the first thing to know about such a run -- otherwise a pass that
  // handled a fifth of the batch is indistinguishable from one where a fifth was all
  // there was. Only shown for runs that report it, so single-order runs are unchanged.
  const batchProgressText = Number.isFinite(Number(counts.processedEvents)) && Number(counts.targetedOrders) > 0
    ? [
      `${formatInteger(Number(counts.processedEvents))} of ${formatInteger(Number(counts.targetedOrders))} events processed`
        + `${Number.isFinite(Number(counts.placementElapsedMs)) ? ` in ${(Number(counts.placementElapsedMs) / 1000).toFixed(1)}s` : ""}`,
      Number(counts.deferredForBudget) > 0
        ? `${formatInteger(Number(counts.deferredForBudget))} left for the next run: the ${(Number(counts.placementBudgetMs || 0) / 1000).toFixed(0)}s placement budget was spent`
          + `${Number(counts.placementPerOrderMs) > 0 ? ` at ${(Number(counts.placementPerOrderMs) / 1000).toFixed(1)}s per bid` : ""}`
        : "the whole batch was worked through",
    ].filter(Boolean).join("\n")
    : "";
  const riskText = Number(counts.skippedForRisk || 0) > 0 || blocked.length
    ? `${Number(counts.skippedForRisk || blocked.length || 0)} candidate(s) blocked by risk diversification`
    : "";
  const lines = [
    "Run summary",
    `Portfolio: ${batch.strategyLabel || batch.strategyId || "-"}`,
    `Run time: ${batch.runAt ? formatDate(batch.runAt) : "-"}`,
    `Action: ${action}`,
    `Reason: ${primaryReason}`,
  ];
  if (explanation && normalizeDetailText(explanation) !== normalizeDetailText(primaryReason)) {
    lines.push(`Note: ${explanation}`);
  }
  if (selected) {
    lines.push(
      "",
      "Order placed",
      `${selected.outcome || "-"} - ${selected.question || "-"}`,
      candidateMetricLine(selected),
      selected.url ? `Market: ${selected.url}` : "",
    );
  }
  if (batchProgressText) lines.push("", "Batch progress", batchProgressText);
  if (reviewedCandidateLines) lines.push("", "Candidates not used", reviewedCandidateLines);
  if (orderReviewSummary) lines.push("", "Open orders", orderReviewSummary);
  if (rotationSummary) lines.push("", "Position rotation", rotationSummary);
  if (riskText) lines.push("", "Risk diversification", riskText);
  if (capitalRelevant) lines.push("", "Capital", capitalText);
  return lines.filter((line, index) => line || index === 0).join("\n");
}

function normalizeLiveExecutionRun(execution) {
  if (!execution || typeof execution !== "object") return null;
  if (execution.batchLog) {
    const generatedAt = execution.generatedAt || execution.batchLog.generatedAt;
    return {
      ...execution.batchLog,
      // The executor stamps this id now, but states published before it did carry a
      // batchLog with none. This is the same fallback the executor applies when it
      // stores the run's own log entry, so the two are one run to the dedupe rather
      // than two rows for the same decision.
      id: execution.batchLog.id || `live-trade-batch-${generatedAt || execution.batchLog.runAt || ""}`,
      generatedAt,
      response: execution.response || execution.batchLog.response,
      attempts: Array.isArray(execution.attempts) ? execution.attempts : execution.batchLog.attempts,
    };
  }
  const runAt = execution.generatedAt || execution.runAt || "";
  const settings = execution.settings || {};
  const account = execution.account || {};
  const selected = execution.selected ? liveBatchCandidateSummaryFromExecution(execution.selected) : null;
  const rejected = Array.isArray(execution.topRejected) ? execution.topRejected.map(liveBatchCandidateSummaryFromExecution) : [];
  return {
    id: `live-execution-${runAt || execution.action || "latest"}`,
    runAt,
    generatedAt: runAt,
    // Whichever live portfolio is on screen owns this row. Hard-coding Live labelled
    // 5050's own runs as the other portfolio's.
    strategyId: isFixedEntryMode() ? "live-5050" : "live",
    strategyLabel: isFixedEntryMode() ? "5050" : "Live",
    selectionMetric: portfolioReturnMetricLabel(settings),
    action: execution.action || "-",
    reason: execution.reason || "-",
    explanation: execution.reason || "Live execution state was recorded before detailed batch logs were introduced.",
    settings: {
      minProbability: settings.minProbability,
      minAnnualReturn: settings.minAnnualReturn,
      maxSpread: settings.maxSpread,
      minVolume24hr: settings.minVolume24hr,
      minNetYield: settings.minNetYield,
      maxOrderFraction: account.maxOrderFraction,
      useLimitOrders: settings.useLimitOrders,
      crossPortfolioRiskDiversification: settings.crossPortfolioRiskDiversification,
    },
    capital: {
      availableUsdc: account.cashUsdc,
      portfolioValueUsdc: account.portfolioValueUsdc,
      requiredStakeUsdc: account.maxNotionalUsdc,
      insufficientCapital: Number(account.cashUsdc) + 0.000001 < Number(account.maxNotionalUsdc),
    },
    counts: {
      scannedCandidates: settings.scannedCandidates,
      revalidatedCandidates: settings.revalidatedCandidates,
      eligibleCandidates: settings.eligibleCandidates,
      rejectedCandidates: rejected.length,
    },
    selected,
    topCandidates: selected ? [selected] : [],
    topRejected: rejected,
    response: execution.response || null,
    attempts: Array.isArray(execution.attempts) ? execution.attempts : [],
  };
}

function liveBatchCandidateSummaryFromExecution(item = {}) {
  return {
    question: item.question || item.candidate?.question || "-",
    outcome: item.outcome || item.candidate?.outcome || "-",
    tokenId: item.tokenId || item.candidate?.tokenId || null,
    url: item.url || item.candidate?.url || polymarketUrl(item),
    aiProbability: item.aiProbability ?? item.candidate?.aiProbability,
    marketPrice: item.marketPrice ?? item.currentPrice ?? item.orderPrice ?? item.candidate?.marketPrice,
    annualizedReturn: item.annualizedReturn ?? item.candidate?.annualizedReturn,
    expectedValueUsdc: item.expectedValueUsdc ?? item.candidate?.expectedValueUsdc,
    netGainIfWinUsdc: item.netGainIfWinUsdc ?? item.candidate?.netGainIfWinUsdc,
    netYield: item.netYield ?? item.candidate?.netYield,
    riskReward: item.riskReward ?? item.candidate?.riskReward,
    rejectReasons: item.rejectReasons || item.candidate?.rejectReasons || [],
    riskBlockedReason: item.riskBlockedReason || "",
  };
}

function liveRunLogRows() {
  const rows = [];
  // live-state.json carries the main live portfolio's own runs. 5050 decides
  // separately, so its tab shows only what its own executor recorded.
  const fromLiveState = !isFixedEntryMode() && Array.isArray(state.liveState?.runLog) ? state.liveState.runLog : [];
  const fromExecutionState = Array.isArray(state.liveExecutionState?.runLog) ? state.liveExecutionState.runLog : [];
  rows.push(...fromLiveState);
  rows.push(...fromExecutionState);
  const executionRun = normalizeLiveExecutionRun(state.liveExecutionState);
  // The top-level state is the same decision as the newest run-log entry, so it is only
  // added when the log does not already carry it. Matching on id alone was not enough:
  // the device cache keeps a reduced shape, and a render from it rebuilt the row as a
  // different run -- which is how the newest entry came to be listed twice.
  if (executionRun && !rows.some((row) => isSameLiveRun(row, executionRun))) rows.unshift(executionRun);
  return mergeUniqueByRun(rows)
    .filter((row) => !isCadenceWaitRun(row))
    // Recovery rows only prove that an old GitHub workflow existed. They do
    // not contain a preserved trading decision, so showing them as portfolio
    // runs is misleading and provides no actionable audit detail.
    .filter((row) => !isHistoryRecoveryRun(row))
    .slice(0, 120);
}

function isCadenceWaitRun(row = {}) {
  const batch = row.batchLog || row;
  const action = String(row.action || batch.action || "").toUpperCase();
  const reason = String(row.reason || batch.reason || "");
  return action === "CADENCE_WAIT" || /cadence poll is not due|polling skipped: no live execution review is due/i.test(reason);
}

function isHistoryRecoveryRun(row = {}) {
  const batch = row.batchLog || row;
  const action = String(row.action || batch.action || "").trim().toUpperCase();
  const id = String(row.id || batch.id || "");
  return action === "HISTORY_RECOVERED"
    || row.historicalRecovery === true
    || batch.historicalRecovery === true
    || id.startsWith("github-live-history-");
}

// Two rows are the same decision when they share an id, or -- for the stored shapes that
// carry none -- when they are within a couple of seconds of each other. The timestamps
// differ by milliseconds because they came from separate clock reads of one run, and no
// portfolio decides twice inside two seconds, so the tolerance cannot merge real runs.
function isSameLiveRun(left, right) {
  if (!left || !right) return false;
  const leftId = String(left.id || "");
  const rightId = String(right.id || "");
  // Equal ids settle it. Unequal ones do not: one of the two may be an id this file
  // synthesized for a stored shape that carried none, which is not evidence of a
  // different run -- believing it is what kept the duplicate on screen.
  if (leftId && rightId && leftId === rightId) return true;
  const leftAt = Date.parse(left.runAt || left.generatedAt || "");
  const rightAt = Date.parse(right.runAt || right.generatedAt || "");
  if (!Number.isFinite(leftAt) || !Number.isFinite(rightAt)) return false;
  return Math.abs(leftAt - rightAt) <= 2000;
}

function runLogTimestamp(row = {}) {
  const timestamp = Date.parse(row.runAt || row.generatedAt || row.createdAt || "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function sortRunLogRows(rows = []) {
  return [...rows].sort((left, right) => runLogTimestamp(right) - runLogTimestamp(left));
}

function mergeUniqueByRun(rows = []) {
  const seen = new Set();
  const merged = [];
  for (const row of sortRunLogRows(rows)) {
    const key = row?.id || `${row?.runAt || ""}:${row?.strategyId || ""}:${row?.action || ""}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(row);
  }
  return merged;
}

function currentPortfolioRunLog() {
  if (isLiveMode()) return withRunningExecutionRow(liveRunLogRows());
  const portfolio = selectedPaperPortfolio(state.botState || {});
  const live = Array.isArray(portfolio.runLog) ? portfolio.runLog : [];
  // Once "load more" has paged in older history, merge it with whatever the live state's
  // own capped runLog carries right now -- a run finishing after that page loaded must
  // still show up without forcing another click, and de-duping by runAt means the overlap
  // between the two never double-counts.
  const historyEntry = portfolioRunLogHistoryState(portfolio.id);
  let source = live;
  if (historyEntry && Array.isArray(historyEntry.records)) {
    const merged = new Map(historyEntry.records.map((item) => [String(item?.runAt || ""), item]).filter(([key]) => key));
    live.forEach((item) => {
      const key = String(item?.runAt || "");
      if (key) merged.set(key, item);
    });
    source = sortRunLogRows([...merged.values()]);
  }
  const rows = sortRunLogRows(source.filter((row) => !isCadenceWaitRun(row)));
  return withRunningExecutionRow(rows);
}

// A run that has started but not yet published anything of its own. Read from GitHub
// rather than published by the run at its start: a run that dies, is cancelled, or never
// gets a runner would leave a "RUNNING" row on the hosting forever, and this way the row
// disappears exactly when GitHub says the run is over. It also covers runs nobody
// dispatched from here -- cron and post-scrape -- which are now most of them.
async function pollRunningExecution(target) {
  if (!target) return;
  let running = null;
  try {
    const status = await fetchApiJson(
      `api.php?action=workflow-status&target=${encodeURIComponent(target)}&event=all`,
    );
    running = (status.runs || []).find((run) => run.status === "queued" || run.status === "in_progress") || null;
  } catch {
    // A failed status read says nothing about whether a run is going. Keeping the last
    // answer is better than flickering the row away on one bad response.
    return;
  }
  const previous = state.runningExecutions[target] || null;
  state.runningExecutions = { ...state.runningExecutions, [target]: running };
  const finished = previous && (!running || String(running.id) !== String(previous.id));
  // Only when the log's contents actually change. Re-rendering on every poll would throw
  // a reader who has scrolled back through the log to the top every fifteen seconds, and
  // an idle desk -- the usual case -- has nothing to redraw at all.
  if (running || finished) rerenderRunLogInPlace();
  // The run has ended, so its own row exists now -- but only in state we have not
  // re-read. One reload replaces the synthetic row with what the run actually decided.
  if (finished) await loadDashboardState({ skipAutoLiveSync: true });
}

// The run log is a scrollable list someone may be reading back through, and this redraws
// it while they are. Keeping the offset means the live row updates under them rather than
// yanking them to the top.
function rerenderRunLogInPlace() {
  const offset = els.runLog?.querySelector(".ledger-scroll")?.scrollTop || 0;
  renderRunLog();
  const scroller = els.runLog?.querySelector(".ledger-scroll");
  if (scroller) scroller.scrollTop = offset;
}

function runningExecutionRun() {
  return state.runningExecutions[currentExecutionTarget()] || null;
}

// The synthetic row. Shaped like a real run-log entry so the list, the filter and the
// source column need no special case; `humanReason` is what the message column renders.
function runningExecutionRow() {
  const run = runningExecutionRun();
  if (!run) return null;
  const startedAt = run.createdAt || null;
  const elapsedMs = Date.parse(startedAt || "");
  const elapsed = Number.isFinite(elapsedMs) ? Math.max(0, Math.round((Date.now() - elapsedMs) / 1000)) : null;
  const progress = run.progress || null;
  const where = progress?.step
    ? `${progress.step}${progress.stepCount ? ` (step ${progress.stepNumber} of ${progress.stepCount})` : ""}`
    : (run.status === "queued" ? "waiting for a runner" : "starting");
  return {
    id: `running-workflow-${run.id}`,
    action: run.status === "queued" ? "QUEUED" : "RUNNING",
    runAt: startedAt,
    // A dispatch is a person only when the dashboard asked; everything else is the
    // schedule. The run log's own rows are labelled the same way. dispatch-after-scan.mjs
    // chains a run onto a finished scrape with this exact same GitHub event, so the event
    // alone cannot tell the two apart -- only who triggered it can: that script always
    // runs as github-actions[bot], never as a person's own login.
    runSource: run.event === "workflow_dispatch" && run.triggeringActor !== "github-actions[bot]" ? "MANUAL" : "AUTO",
    runningExecution: true,
    htmlUrl: run.htmlUrl || null,
    humanReason: `Execution in progress: ${where}${elapsed == null ? "" : ` · ${formatDuration(elapsed)} elapsed`}.`,
  };
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return "-";
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function newestRunAt(rows = []) {
  let newest = 0;
  for (const row of rows) {
    const at = Date.parse(row?.runAt || row?.generatedAt || "");
    if (Number.isFinite(at) && at > newest) newest = at;
  }
  return newest;
}

// The run has published its own row once the log carries an entry newer than anything it
// carried when this run first appeared. Comparing against the run's own start time instead
// looks simpler and is wrong: a previous run can stamp its decision after this one was
// created -- it is queued the moment it is dispatched but waits for the shared runner --
// and that row would hide the running one before it had done anything.
//
// The watermark is taken from the rows themselves on the first render after the run
// appears, which is by definition before the run could have published.
function runningRowIsSuperseded(run, rows = []) {
  const key = String(run?.id || "");
  if (!key) return false;
  if (state.runningExecutionWatermark?.key !== key) {
    state.runningExecutionWatermark = { key, at: newestRunAt(rows) };
    return false;
  }
  return newestRunAt(rows) > state.runningExecutionWatermark.at;
}

function withRunningExecutionRow(rows = []) {
  const running = runningExecutionRow();
  if (!running || runningRowIsSuperseded(running, rows)) return rows;
  return [running, ...rows];
}

function runActionValue(run = {}) {
  const batch = run.batchLog || run;
  return normalizeRunLogFilter(run.action || batch.action || "UNKNOWN");
}

function runActionFilterLabel(action) {
  if (action === "ALL") return "All statuses";
  return String(action || "UNKNOWN").replaceAll("_", " ");
}

function syncRunLogFilterControl(runs = []) {
  if (!els.runLogFilterMenu || !els.runLogFilterToggle) return;
  const actions = [...new Set(runs.map(runActionValue))].sort((a, b) => a.localeCompare(b));
  const selected = normalizeRunLogFilters(state.runLogFilters);
  selected.forEach((action) => {
    if (!actions.includes(action)) actions.push(action);
  });
  actions.sort((a, b) => a.localeCompare(b));
  const allSelected = selected.length === 0;
  els.runLogFilterMenu.innerHTML = ["ALL", ...actions]
    .map((action) => {
      const checked = action === "ALL" ? allSelected : selected.includes(action);
      return `
        <label class="run-log-filter-option">
          <input type="checkbox" value="${escapeHtml(action)}" data-run-log-filter-option ${checked ? "checked" : ""}>
          <span>${escapeHtml(runActionFilterLabel(action))}</span>
        </label>
      `;
    })
    .join("");
  els.runLogFilterToggle.textContent = allSelected
    ? "All statuses"
    : (selected.length === 1 ? runActionFilterLabel(selected[0]) : `${selected.length} statuses`);
}

function setRunLogFilterMenuOpen(open) {
  if (!els.runLogFilterMenu || !els.runLogFilterToggle) return;
  els.runLogFilterMenu.hidden = !open;
  els.runLogFilterToggle.setAttribute("aria-expanded", open ? "true" : "false");
}

function runActionClass(action) {
  const value = String(action || "").toUpperCase();
  if (["OPEN", "OPENED", "SUBMIT", "SUBMITTED", "CANCELED_AND_SUBMITTED", "DRY_RUN_READY", "DRY_RUN_ROTATION_EXIT", "ROTATION_EXIT_SUBMITTED", "ROTATE", "ROTATED"].includes(value)) return "positive";
  if (["SKIP", "REJECTED", "CANCELED_REPLACEMENT_REJECTED", "ERROR"].includes(value)) return "negative";
  return "";
}

function runCapitalNote(run = {}) {
  const available = Number(run.availableCapitalUsdc ?? run.capital?.availableUsdc);
  const required = Number(run.requiredStakeUsdc ?? run.capital?.requiredStakeUsdc);
  const hasCapitalData = Number.isFinite(available) || Number.isFinite(required);
  const blocked = Boolean(run.insufficientCapital || run.capital?.insufficientCapital);
  const parts = [
    Number.isFinite(available) ? `${money(available)} available` : "",
    Number.isFinite(required) ? `${money(required)} required` : "",
    blocked ? "capital blocked" : (hasCapitalData ? "capital ok" : ""),
  ];
  return parts.filter(Boolean).join(" / ");
}

function humanRunReason(run = {}) {
  const batch = run.batchLog || run;
  const action = String(run.action || batch.action || "").toUpperCase();
  const reason = String(run.reason || batch.reason || "");
  if (batch.humanReason) return String(batch.humanReason);
  if (/live candidates blocked by available USDC/i.test(reason)) {
    return "No order placed: the revalidated candidate met the trading rules, but available USDC cannot cover Polymarket's current minimum order size.";
  }
  if (/no currently executable candidate after live revalidation/i.test(reason)) {
    return "No order placed: none of the candidates passed the fresh Polymarket verification.";
  }
  if (/live new-trade cadence blocked/i.test(reason)) {
    return `No new order placed: ${reason}. Existing orders were still reviewed.`;
  }
  if (action === "SKIP" && /no candidates passed/i.test(reason)) {
    return "No order placed: no candidate passed this portfolio's current rules.";
  }
  return reason || "-";
}

function runDecisionSummary(run = {}) {
  const batch = run.batchLog || run;
  const counts = batch.counts || {};
  const selected = batch.selected || run.selected || null;
  const evaluated = Number(run.evaluatedCount ?? counts.scannedCandidates ?? counts.revalidatedCandidates);
  const eligible = Number(run.eligibleCount ?? counts.rankedEligible ?? counts.eligibleCandidates);
  const riskSkipped = Number(run.riskSkippedCount ?? counts.skippedForRisk);
  const isLiveRun = String(run.strategyId || batch.strategyId || "").toLowerCase() === "live";
  const usesPolymarketProbability = normalizeProbabilitySource(batch.settings?.probabilitySource) === "polymarket";
  const countParts = [
    Number.isFinite(evaluated) ? `${evaluated} ${isLiveRun ? "market-checked" : "evaluated"}` : "",
    Number.isFinite(eligible) ? `${eligible} ${isLiveRun ? "passed" : "eligible"}` : "",
    Number.isFinite(riskSkipped) ? `${riskSkipped} risk skipped` : "",
  ].filter(Boolean).join(" / ");
  const selectedText = selected
    ? `${selected.outcome || "-"} ${selected.question || "-"} / ${usesPolymarketProbability ? "Mkt" : "AI"} ${probability(Number(usesPolymarketProbability ? selected.marketProbability : selected.aiProbability))} / win ${signedMoney(Number(selected.netGainIfWinUsdc), 4)} ${selected.netYield != null ? `(${signedPercent(Number(selected.netYield))})` : ""}`
    : "";
  return [humanRunReason(run), selectedText, countParts, runCapitalNote(run)].filter(Boolean).join(" / ");
}

function submittedOrderSummaryMarkup(run = {}) {
  const batch = run.batchLog || run;
  const action = String(run.action || batch.action || "").toUpperCase();
  const selected = batch.selected || run.selected || null;
  // Paper portfolios record a successful new position as OPENED, while live uses
  // SUBMITTED. Both have the same selected-candidate detail and must read the same
  // way in the compact run-log list.
  if (!selected || !["SUBMITTED", "CANCELED_AND_SUBMITTED", "OPENED", "ROTATED_OPENED"].includes(action)) return "";
  const settings = batch.settings || {};
  const probabilitySource = normalizeProbabilitySource(settings.probabilitySource);
  const selectedProbability = probabilitySource === "polymarket"
    ? Number(selected.marketProbability)
    : Number(selected.aiProbability);
  const days = Number(selected.daysToResolution);
  const netYield = Number(selected.netYield);
  const potentialPa = Number.isFinite(Number(selected.potentialAnnualizedReturn))
    ? Number(selected.potentialAnnualizedReturn)
    : (Number.isFinite(netYield)
      ? annualizeReturn(netYield, days)
      : Number(selected.annualizedReturn));
  const question = selected.question || selected.market || "-";
  const outcome = selected.outcome || "-";
  const daysText = Number.isFinite(days) ? `${days.toFixed(1)} days` : "- days";
  return `Placing order &quot;${escapeHtml(question)}&quot; with outcome <strong>${escapeHtml(outcome)}</strong> with net profit ${escapeHtml(signedMoney(Number(selected.netGainIfWinUsdc), 4))}, Potential p.a. ${escapeHtml(signedPercent(potentialPa))}, ${escapeHtml(daysText)} until resolution and probability ${escapeHtml(probability(selectedProbability))}.`;
}

function runLogMessageMarkup(run = {}) {
  return submittedOrderSummaryMarkup(run) || escapeHtml(humanRunReason(run));
}

function portfolioRunSource(run = {}) {
  const source = String(run.runSource || run.triggerSource || run.executionSource || "").trim().toUpperCase();
  if (source === "MANUAL" || run.manualRunOnce === true || run.batchLog?.manualRunOnce === true) return "MANUAL";
  if (source === "RECOVERED" || run.historicalRecovery === true) return "RECOVERED";
  return "AUTO";
}

function portfolioRunBatch(run = {}) {
  const batch = run.batchLog || run;
  return {
    ...batch,
    runAt: batch.runAt || run.runAt || run.generatedAt,
    strategyId: batch.strategyId || run.strategyId,
    strategyLabel: batch.strategyLabel || run.strategyLabel,
    action: batch.action || run.action,
    humanReason: batch.humanReason || humanRunReason(run),
  };
}

function openExecutionRunDetail(batch, trigger) {
  const normalizedBatch = batch || {};
  openAnalysisModal(tradeBatchDetail(normalizedBatch), trigger, {
    title: "Execution run log",
    singleColumn: true,
    executionCandidatesNotUsed: executionCandidatesNotUsed(normalizedBatch),
    executionProbabilitySource: normalizedBatch.settings?.probabilitySource,
  });
}

function renderRunLog() {
  if (!els.runLog) return;
  const allRuns = currentPortfolioRunLog();
  syncRunLogFilterControl(allRuns);
  const filters = normalizeRunLogFilters(state.runLogFilters);
  const runs = filters.length === 0
    ? allRuns
    : allRuns.filter((run) => filters.includes(runActionValue(run)));
  state.displayedRunLog = runs;
  // 5050 is a live mode but not the Live portfolio, and its log is its own -- titling it
  // "Live run log" said it belonged to the other one.
  const label = portfolioUsesCustomName() ? portfolioNameForMode() : (isFixedEntryMode() ? "5050" : (isLiveMode() ? "Live" : paperModeLabel()));
  if (els.runLogTitle) {
    els.runLogTitle.textContent = `${label} run log`;
  }
  const strategyId = isLiveMode() ? null : paperStrategyIdFromMode();
  const historyEntry = strategyId ? portfolioRunLogHistoryState(strategyId) : null;
  if (els.runLogSummary) {
    const totalKnown = historyEntry?.page >= 0 ? historyEntry.total : allRuns.length;
    els.runLogSummary.textContent = filters.length === 0
      ? `${runs.length} runs${totalKnown > allRuns.length ? ` of ${totalKnown}` : ""}`
      : `${runs.length} / ${allRuns.length} runs`;
  }
  // Paper portfolios can always page further back through their archive; a portfolio that
  // turns out to have no older history simply loses the button after its first click.
  const loadMoreVisible = Boolean(strategyId) && (!historyEntry || historyEntry.page < 0 || historyEntry.hasMore);
  const loadMoreMarkup = loadMoreVisible
    ? `<div class="table-load-more"><button class="execution-button" type="button" data-run-log-load-more ${historyEntry?.busy ? "disabled" : ""}>${historyEntry?.busy ? "Loading..." : "Load older runs"}</button></div>`
    : "";
  const historyErrorMarkup = historyEntry?.error ? `<div class="empty negative">${escapeHtml(historyEntry.error)}</div>` : "";
  if (!runs.length) {
    const actionText = filters.length === 0 ? "" : ` with selected statuses ${filters.map(runActionFilterLabel).join(", ")}`;
    els.runLog.innerHTML = `<div class="empty">No ${escapeHtml(label)} trading decision runs${escapeHtml(actionText)} recorded yet.</div>${historyErrorMarkup}${loadMoreMarkup}`;
    return;
  }

  els.runLog.innerHTML = `
    <div class="ledger-scroll run-log-scroll" tabindex="0" aria-label="Scrollable portfolio run log">
    <div class="trade-batches portfolio-run-list">
      ${runs.map((run, index) => {
        const batch = run.batchLog || run;
        const cells = `
            <span class="${runActionClass(run.action || batch.action)}">${escapeHtml(run.action || batch.action || "-")}</span>
            <strong>${escapeHtml(run.runAt || run.generatedAt ? formatDate(run.runAt || run.generatedAt) : "-")}</strong>
            <span>${runLogMessageMarkup(run)}</span>
            <span class="portfolio-run-source">${portfolioRunSource(run)}</span>
        `;
        // A run still going has no decision to open, so it is not a detail button. It
        // links to its GitHub run instead, which is the only place with more to say.
        if (run.runningExecution) {
          return run.htmlUrl
            ? `<a class="trade-batch portfolio-run-row portfolio-run-live" href="${escapeHtml(run.htmlUrl)}" target="_blank" rel="noopener noreferrer">${cells}</a>`
            : `<div class="trade-batch portfolio-run-row portfolio-run-live">${cells}</div>`;
        }
        return `
          <button class="trade-batch portfolio-run-row" type="button" data-portfolio-run="${index}">${cells}</button>
        `;
      }).join("")}
    </div>
    </div>
    ${historyErrorMarkup}
    ${loadMoreMarkup}
  `;
}

function normalizeCalculationMinimum(value) {
  const raw = String(value ?? "").trim().replace(",", ".");
  if (!raw) return "";
  const numeric = Number(raw);
  return Number.isFinite(numeric) && numeric >= 0 ? String(numeric) : "";
}

function storedCalculationPreference(key) {
  try {
    return localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

function saveCalculationPreference(key, value) {
  try {
    const normalized = normalizeCalculationMinimum(value);
    if (normalized) localStorage.setItem(key, normalized);
    else localStorage.removeItem(key);
  } catch {
    // The filter remains active for this page load if local storage is unavailable.
  }
}

function storedCalculationTab() {
  try {
    const value = localStorage.getItem(CALCULATION_TAB_STORAGE_KEY);
    return ["parameters", "category", "tag"].includes(value) ? value : "parameters";
  } catch {
    return "parameters";
  }
}

function saveCalculationTab(value) {
  try {
    localStorage.setItem(CALCULATION_TAB_STORAGE_KEY, ["parameters", "category", "tag"].includes(value) ? value : "parameters");
  } catch {
    // The selected tab remains active for this page load if local storage is unavailable.
  }
}

function calculationMinimumValue(value) {
  const normalized = normalizeCalculationMinimum(value);
  if (!normalized) return null;
  const numeric = Number(normalized);
  return Number.isFinite(numeric) ? numeric : null;
}

function calculationRowPassesFilters(row) {
  const minOpen = calculationMinimumValue(state.calculationMinOpen);
  const minTrades = calculationMinimumValue(state.calculationMinTrades);
  const minVolume = calculationMinimumValue(state.calculationMinVolume);
  const openCount = Number(row?.openCount || 0);
  const trades = Number(row?.trades || 0);
  const volume = Number(row?.avgVolumeUsdc ?? row?.avgLiquidity ?? 0);
  return (minOpen == null || openCount >= minOpen)
    && (minTrades == null || trades >= minTrades)
    && (minVolume == null || (Number.isFinite(volume) && volume >= minVolume));
}

function syncCalculationControls() {
  document.querySelectorAll("[data-calculation-tab]").forEach((button) => {
    const active = button.dataset.calculationTab === state.calculationTab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  els.calculationMinFilters.forEach((input) => {
    const key = input.dataset.calculationMinFilter;
    const value = key === "open"
      ? state.calculationMinOpen
      : key === "trades"
        ? state.calculationMinTrades
        : state.calculationMinVolume;
    if (input.value !== value) input.value = value;
  });
}

function calculationSourceLabel(source) {
  if (source === "ai") return "AI probability";
  if (source === "polymarket") return "Polymarket probability";
  if (source === "combined") return "AI + Polymarket";
  return source || "-";
}

function calculationMarketLabel(type) {
  if (type === "binary") return "Yes/No";
  if (type === "multi") return "Multi-outcome";
  return "All markets";
}

function calculationRows(report) {
  const rows = Array.isArray(report?.parameterSummaries) ? report.parameterSummaries : [];
  const filtered = rows.filter((row) => {
    if (state.calculationMarket !== "all" && row.marketType !== state.calculationMarket) return false;
    if (state.calculationOpenFilter === "open" && Number(row.openCount || 0) <= 0) return false;
    return calculationRowPassesFilters(row);
  });
  return sortedCalculationRows(filtered);
}

function calculationSortValue(row, key) {
  const numeric = (value) => {
    if (value == null || value === "") return null;
    const result = Number(value);
    return Number.isFinite(result) ? result : null;
  };
  if (key === "marketType") return calculationMarketLabel(row.marketType).toLowerCase();
  if (key === "threshold") return numeric(row.threshold);
  if (key === "maxResolutionDays") return numeric(row.maxResolutionDays);
  if (key === "openCount") return numeric(row.openCount ?? 0);
  if (key === "trades") return numeric(row.trades ?? 0);
  if (key === "accuracy") return numeric(row.winRate);
  if (key === "stake") return numeric(row.resolvedStakeUsdc ?? row.stakeUsdc ?? 0);
  if (key === "pnl") return numeric(row.pnlUsdc ?? 0);
  if (key === "roi") return numeric(row.roi);
  if (key === "avgProbability") return numeric(row.avgProbability);
  if (key === "avgVolumeUsdc") return numeric(row.avgVolumeUsdc ?? row.avgLiquidity);
  return "";
}

function sortedCalculationRows(rows) {
  const sort = state.calculationSort || { key: "roi", direction: "desc" };
  const direction = sort.direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const aValue = calculationSortValue(a, sort.key);
    const bValue = calculationSortValue(b, sort.key);
    const aMissing = aValue == null || Number.isNaN(aValue);
    const bMissing = bValue == null || Number.isNaN(bValue);
    if (aMissing && bMissing) return 0;
    if (aMissing) return 1;
    if (bMissing) return -1;
    if (typeof aValue === "number" && typeof bValue === "number") {
      const primary = (aValue - bValue) * direction;
      if (primary !== 0) return primary;
      if (sort.key === "roi") {
        const aPnl = calculationSortValue(a, "pnl");
        const bPnl = calculationSortValue(b, "pnl");
        if (typeof aPnl === "number" && typeof bPnl === "number" && aPnl !== bPnl) {
          return (aPnl - bPnl) * direction;
        }
      }
      return 0;
    }
    return String(aValue).localeCompare(String(bValue)) * direction;
  });
}

function calculationHeader(key, label) {
  const active = state.calculationSort.key === key ? " active" : "";
  return `<th><div class="th-content"><button class="sort-button${active}" type="button" data-calculation-sort="${key}">${label}${calculationSortArrow(key)}</button></div></th>`;
}

function taxonomySortState(kind) {
  return state.taxonomySort?.[kind] || { key: "roi", direction: "desc" };
}

function taxonomySortArrow(kind, key) {
  const sort = taxonomySortState(kind);
  if (sort.key !== key) return "";
  return sortDirectionIndicator(sort.direction);
}

function taxonomyHeader(kind, key, label, title = "") {
  const active = taxonomySortState(kind).key === key ? " active" : "";
  const tooltip = title ? ` title="${escapeHtml(title)}"` : "";
  return `<th><div class="th-content"><button class="sort-button${active}" type="button"`
    + ` data-taxonomy-sort="${kind}" data-taxonomy-sort-key="${key}"${tooltip}>`
    + `${label}${taxonomySortArrow(kind, key)}</button></div></th>`;
}

function taxonomySortValue(row, key) {
  const numeric = (value) => {
    if (value == null || value === "") return null;
    const result = Number(value);
    return Number.isFinite(result) ? result : null;
  };
  if (key === "label") return String(row.label || "").toLowerCase();
  if (key === "minimumProbability") return numeric(row.minimumProbability);
  if (key === "accuracy") return numeric(row.winRate);
  if (key === "stake") return numeric(row.resolvedStakeUsdc ?? row.stakeUsdc ?? 0);
  if (key === "pnl") return numeric(row.pnlUsdc ?? 0);
  if (key === "lastResolvedAt") return Date.parse(row.lastResolvedAt || "") || null;
  return numeric(row[key]);
}

function taxonomyRows(report, kind) {
  const legacyRows = Array.isArray(report?.categorySummaries) ? report.categorySummaries : [];
  const hasSplitTaxonomy = Number(report?.taxonomyVersion || 0) >= 2
    || Array.isArray(report?.tagSummaries);
  const directRows = kind === "tag" && hasSplitTaxonomy
    ? (Array.isArray(report?.tagSummaries) ? report.tagSummaries : [])
    : kind === "category" && !hasSplitTaxonomy
      // Legacy category rows were inferred from the first tag/risk group, so showing
      // them as real Gamma categories would preserve the duplicate this migration fixes.
      ? []
      : legacyRows;
  // Reports written before the taxonomy split stored both kinds in categorySummaries.
  // Rows written after it may omit kind because the parent collection is authoritative.
  const expandedRows = kind === "tag"
    ? directRows.flatMap((row) => {
      const summaries = Array.isArray(row?.minimumProbabilitySummaries)
        ? row.minimumProbabilitySummaries
        // Older reports remain useful until the next hourly calculation completes.
        : [{ minimumProbability: 0.5, ...row }];
      return summaries
        // Chosen outcomes below 50% are normalized to their inverse, so those
        // rows duplicate the 50%+ ladder and must not be rendered from old data.
        .filter((summary) => Number(summary?.minimumProbability) >= 0.5)
        .map((summary) => ({
        ...row,
        ...summary,
        minimumProbability: Number.isFinite(Number(summary?.minimumProbability))
          ? Number(summary.minimumProbability)
          : 0.5,
        }));
    })
    : directRows;
  const rows = expandedRows.filter((row) => (
    (!row?.kind || String(row.kind) === kind)
    && (state.calculationOpenFilter !== "open" || Number(row?.openCount || 0) > 0)
    && calculationRowPassesFilters(row)
  ));
  const sort = taxonomySortState(kind);
  const direction = sort.direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const aValue = taxonomySortValue(a, sort.key);
    const bValue = taxonomySortValue(b, sort.key);
    const aMissing = aValue == null || Number.isNaN(aValue);
    const bMissing = bValue == null || Number.isNaN(bValue);
    // Groups with no data always sort last, in either direction, so they never
    // occupy the top of the table just because a column is empty.
    if (aMissing && bMissing) return 0;
    if (aMissing) return 1;
    if (bMissing) return -1;
    if (typeof aValue === "number" && typeof bValue === "number") {
      const primary = (aValue - bValue) * direction;
      if (primary !== 0) return primary;
      if (sort.key === "roi") {
        const aPnl = taxonomySortValue(a, "pnl");
        const bPnl = taxonomySortValue(b, "pnl");
        if (typeof aPnl === "number" && typeof bPnl === "number" && aPnl !== bPnl) {
          return (aPnl - bPnl) * direction;
        }
      }
      return 0;
    }
    return String(aValue).localeCompare(String(bValue)) * direction;
  });
}

function renderTaxonomyPerformanceTable(report, kind, title, note) {
  const rows = taxonomyRows(report, kind);
  const label = kind === "category" ? "Category" : "Tag";
  const hasProbabilityBreakdown = kind === "tag";
  const coverage = report?.taxonomyCoverage?.[kind] || {};
  const total = Number(coverage.totalTrades || report?.resolvedSampleSize || report?.sampleSize || 0);
  const classified = Number(coverage.classifiedTrades || 0);
  const unclassified = Number(coverage.unclassifiedTrades || 0);
  const coverageNote = total
    ? ` All ${total} resolved opportunities are included; ${classified} carry at least one explicit Polymarket ${kind}, and ${unclassified} are shown as ${kind === "category" ? "Uncategorized" : "Untagged"}.`
    : "";
  return `
    <div class="calculation-section">
      <h3>${escapeHtml(title)}</h3>
      <p class="calculation-note">${escapeHtml(`${note}${coverageNote}`)}</p>
      <div class="calculation-table-wrap">
        <table class="calculation-table">
          <thead>
            <tr>
              ${taxonomyHeader(kind, "label", label)}
              ${hasProbabilityBreakdown ? taxonomyHeader(kind, "minimumProbability", "Min probability", "Minimum Polymarket probability captured when the opportunity was first scraped.") : ""}
              ${taxonomyHeader(kind, "openCount", "Open now", `Current scraped opportunities with this Polymarket ${kind}.`)}
              ${taxonomyHeader(kind, "trades", "Trades")}
              ${taxonomyHeader(kind, "accuracy", "Accuracy")}
              ${taxonomyHeader(kind, "stake", "Invested")}
              ${taxonomyHeader(kind, "pnl", "P/L")}
              ${taxonomyHeader(kind, "roi", "ROI", "Net P/L divided by all simulated capital invested in this group, including stored fees.")}
              ${taxonomyHeader(kind, "avgProbability", "Avg entry")}
              ${taxonomyHeader(kind, "avgVolumeUsdc", "Avg volume")}
              ${taxonomyHeader(kind, "lastResolvedAt", "Last resolved", "Most recent resolution in this group.")}
              <th><div class="th-content"><span class="table-action-heading" title="Create a paper portfolio set to trade this row">Portfolio</span></div></th>
            </tr>
          </thead>
          <tbody>
            ${rows.length ? rows.map((row) => `
              <tr>
                <td data-label="${label}"><strong><a class="taxonomy-opportunity-link" href="${escapeHtml(scrapedTaxonomyOpportunityPath({ kind, label: row.label }, { statuses: ["SCRAPED", "RESOLVED"], rule: scrapedTaxonomyProbabilityRule(row) }))}" title="Show current and resolved scraped opportunities in this ${kind}">${escapeHtml(row.label || "-")}</a></strong></td>
                ${hasProbabilityBreakdown ? `<td data-label="Min probability">${probability(Number(row.minimumProbability || 0))}</td>` : ""}
                <td data-label="Open now"><a class="taxonomy-opportunity-link" href="${escapeHtml(scrapedTaxonomyOpenOpportunityPath(kind, row.label, row))}" title="Show current open scraped opportunities in this ${kind}">${formatInteger(Number(row.openCount || 0))}</a></td>
                <td data-label="Trades"><a class="taxonomy-opportunity-link" href="${escapeHtml(scrapedTaxonomyResolvedOpportunityPath(kind, row.label, row))}" title="Show resolved scraped opportunities in this ${kind}">${formatInteger(Number(row.trades || 0))}</a></td>
                <td data-label="Accuracy">${Number(row.trades || 0) ? `${Number(row.wins || 0)} / ${Number(row.trades || 0)} (${probability(Number(row.winRate))})` : "-"}</td>
                <td data-label="Invested">${money(Number(row.resolvedStakeUsdc || row.stakeUsdc || 0))}</td>
                <td data-label="P/L" class="${pnlClass(Number(row.pnlUsdc || 0))}">${signedMoney(Number(row.pnlUsdc || 0))}</td>
                <td data-label="ROI" class="${pnlClass(Number(row.roi || 0))}">${row.roi == null ? "-" : signedPercent(Number(row.roi))}</td>
                <td data-label="Avg entry">${probability(Number(row.avgProbability))}</td>
                <td data-label="Avg volume">${Number.isFinite(Number(row.avgVolumeUsdc ?? row.avgLiquidity)) ? money(Number(row.avgVolumeUsdc ?? row.avgLiquidity)) : "-"}</td>
                <td data-label="Last resolved">${escapeHtml(row.lastResolvedAt ? formatDate(row.lastResolvedAt) : "-")}</td>
                <td data-label="Portfolio"><button class="execution-button table-inline-button" type="button" title="Create a paper portfolio that trades exactly this row" data-create-portfolio ${portfolioPrefillAttributes({
                  name: row.label,
                  probability: Number(row.minimumProbability) > 0 ? Number(row.minimumProbability) : "",
                  tag: kind === "tag" ? row.label : "",
                })}>+ Portfolio</button></td>
              </tr>
            `).join("") : `<tr><td colspan="${hasProbabilityBreakdown ? 12 : 11}">No ${kind} statistics are available yet.</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderCalculationReport() {
  if (!els.calculationReport) return;
  const report = state.botState?.latestCalculationReport
    || (Array.isArray(state.botState?.calculationReports) ? state.botState.calculationReports[0] : null);

  if (!report) {
    els.calculationReport.innerHTML = `
      <div class="empty">No calculation report yet. It is refreshed hourly from the stored scraped opportunities.</div>
    `;
    return;
  }

  const rows = calculationRows(report);
  const sample = Number(report.sampleSize || 0);
  const binary = Number(report.resolvedBinaryCount || 0);
  const multi = Number(report.resolvedMultiCount || 0);

  els.calculationReport.innerHTML = `
    <div class="calculation-summary">
      <div>
        <span class="label">Last calculation</span>
        <strong>${escapeHtml(report.generatedAt ? formatDate(report.generatedAt) : "-")}</strong>
        <span>${sample} resolved scraped opportunities</span>
      </div>
      <div>
        <span class="label">Simulation scope</span>
        <strong>${money(Number(report.stakeUsdc || 0))} fixed stake</strong>
        <span>first Polymarket probability and traded volume / ${binary} resolved Yes/No / ${multi} multi-outcome / market entry with fees</span>
      </div>
    </div>
    <div class="calculation-tabs" role="tablist" aria-label="Calculation reports">
      <button class="segment-button${state.calculationTab === "parameters" ? " active" : ""}" type="button" role="tab" aria-selected="${state.calculationTab === "parameters"}" data-calculation-tab="parameters">Best combinations</button>
      <button class="segment-button${state.calculationTab === "category" ? " active" : ""}" type="button" role="tab" aria-selected="${state.calculationTab === "category"}" data-calculation-tab="category">Category performance</button>
      <button class="segment-button${state.calculationTab === "tag" ? " active" : ""}" type="button" role="tab" aria-selected="${state.calculationTab === "tag"}" data-calculation-tab="tag">Tag performance</button>
    </div>
    <div class="calculation-tab-panel" data-calculation-tab-panel="parameters"${state.calculationTab === "parameters" ? "" : " hidden"}>
      <div class="calculation-section">
        <h3>Best parameter combinations</h3>
        <p class="calculation-note">This ranking is independent of Conservative, High reward and More probable portfolios. It tests probability threshold and resolution horizon only on opportunities with a known final Polymarket outcome. Every trade uses a fixed $5 stake plus stored fees. ROI is total net P/L divided by the total invested capital; the default order is highest ROI, then P/L.</p>
      <div class="calculation-table-wrap">
        <table class="calculation-table">
          <thead>
            <tr>
              ${calculationHeader("threshold", "Threshold")}
              ${calculationHeader("marketType", "Market type")}
              ${calculationHeader("maxResolutionDays", "Max days")}
              ${calculationHeader("openCount", "Open now")}
              ${calculationHeader("trades", "Trades")}
              ${calculationHeader("accuracy", "Accuracy")}
              ${calculationHeader("stake", "Invested")}
              ${calculationHeader("pnl", "P/L")}
              ${calculationHeader("roi", "ROI")}
              ${calculationHeader("avgProbability", "Avg entry")}
              ${calculationHeader("avgVolumeUsdc", "Avg volume")}
              <th><div class="th-content"><span class="table-action-heading" title="Create a paper portfolio set to trade this combination">Portfolio</span></div></th>
            </tr>
          </thead>
          <tbody>
            ${rows.length ? rows.map((row) => `
              <tr>
                <td>${probability(Number(row.threshold))}</td>
                <td>${escapeHtml(calculationMarketLabel(row.marketType))}</td>
                <td>${Number(row.maxResolutionDays || 0)} d</td>
                <td><a class="taxonomy-opportunity-link" href="${escapeHtml(scrapedRuleOpportunityPath(row))}" title="Show current open scraped opportunities matching this parameter combination">${formatInteger(Number(row.openCount || 0))}</a></td>
                <td><a class="taxonomy-opportunity-link" href="${escapeHtml(scrapedResolvedRuleOpportunityPath(row))}" title="Show resolved scraped opportunities matching this parameter combination">${formatInteger(Number(row.trades || 0))}</a></td>
                <td>${Number(row.trades || 0) ? `${Number(row.wins || 0)} / ${Number(row.trades || 0)} (${probability(Number(row.winRate))})` : "-"}</td>
                <td>${money(Number(row.resolvedStakeUsdc || row.stakeUsdc || 0))}</td>
                <td class="${pnlClass(Number(row.pnlUsdc || 0))}">${signedMoney(Number(row.pnlUsdc || 0))}</td>
                <td class="${pnlClass(Number(row.roi || 0))}">${row.roi == null ? "-" : signedPercent(Number(row.roi))}</td>
                <td>${probability(Number(row.avgProbability))}</td>
                <td>${Number.isFinite(Number(row.avgVolumeUsdc ?? row.avgLiquidity)) ? money(Number(row.avgVolumeUsdc ?? row.avgLiquidity)) : "-"}</td>
                <td><button class="execution-button table-inline-button" type="button" title="Create a paper portfolio that trades exactly this combination" data-create-portfolio ${portfolioPrefillAttributes({
                  name: `${Math.round(Number(row.threshold || 0) * 100)}% ${calculationMarketLabel(row.marketType)} ${Number(row.maxResolutionDays || 0)}d`,
                  probability: Number(row.threshold) > 0 ? Number(row.threshold) : "",
                  days: Number(row.maxResolutionDays) > 0 ? Number(row.maxResolutionDays) : "",
                  marketType: row.marketType || "all",
                })}>+ Portfolio</button></td>
              </tr>
            `).join("") : '<tr><td colspan="12">No resolved scraped opportunity simulation is available yet.</td></tr>'}
          </tbody>
        </table>
      </div>
      </div>
    </div>
    <div class="calculation-tab-panel" data-calculation-tab-panel="category"${state.calculationTab === "category" ? "" : " hidden"}>
      ${renderTaxonomyPerformanceTable(
        report,
        "category",
        "Category performance",
        "Only explicit Polymarket Gamma categories are counted here. Inferred risk groups and tags are excluded.",
      )}
    </div>
    <div class="calculation-tab-panel" data-calculation-tab-panel="tag"${state.calculationTab === "tag" ? "" : " hidden"}>
      ${renderTaxonomyPerformanceTable(
        report,
        "tag",
        "Tag performance",
        "Each tag is broken down by the minimum Polymarket probability captured when the opportunity was first scraped (50%, 60%, ... 90%).",
      )}
    </div>
  `;
}

els.tabButtons.forEach((button) => {
  button.addEventListener("click", (event) => {
    if (button.tagName === "A") return;
    const target = button.dataset.tabTarget;
    event.preventDefault();
    activateTab(target, { syncRoute: true });
    refreshDashboardAfterUserNavigation();
  });
});

els.pageLinks.forEach((link) => {
  link.addEventListener("click", (event) => {
    const page = link.dataset.pageLink;
    if (!page) return;
    event.preventDefault();
    activatePage(page);
    refreshDashboardAfterUserNavigation();
  });
});

window.addEventListener("popstate", () => {
  applyInitialRoute();
  if (currentOpportunityKeyFromUrl()) {
    openOpportunityFromCurrentUrl();
  } else {
    closeAnalysisModal();
  }
  refreshDashboardAfterUserNavigation();
});

els.settingsSectionButtons.forEach((button) => {
  button.addEventListener("click", () => {
    setSettingsSection(button.dataset.settingsSection || "evaluation-log");
  });
});

els.calculationSourceButtons.forEach((button) => {
  button.addEventListener("click", () => {
    state.calculationSource = button.dataset.calculationSource || "all";
    els.calculationSourceButtons.forEach((item) => {
      item.classList.toggle("active", item === button);
    });
    renderCalculationReport();
  });
});

els.calculationMarketButtons.forEach((button) => {
  button.addEventListener("click", () => {
    state.calculationMarket = button.dataset.calculationMarket || "all";
    els.calculationMarketButtons.forEach((item) => {
      item.classList.toggle("active", item === button);
    });
    renderCalculationReport();
  });
});

els.calculationOpenButtons.forEach((button) => {
  button.addEventListener("click", () => {
    state.calculationOpenFilter = button.dataset.calculationOpen === "open" ? "open" : "all";
    els.calculationOpenButtons.forEach((item) => {
      item.classList.toggle("active", item.dataset.calculationOpen === state.calculationOpenFilter);
    });
    renderCalculationReport();
  });
});

els.calculationMinFilters.forEach((input) => {
  input.addEventListener("input", () => {
    const value = normalizeCalculationMinimum(input.value);
    const key = input.dataset.calculationMinFilter;
    if (key === "open") {
      state.calculationMinOpen = value;
      saveCalculationPreference(CALCULATION_MIN_OPEN_STORAGE_KEY, value);
    } else if (key === "trades") {
      state.calculationMinTrades = value;
      saveCalculationPreference(CALCULATION_MIN_TRADES_STORAGE_KEY, value);
    } else if (key === "volume") {
      state.calculationMinVolume = value;
      saveCalculationPreference(CALCULATION_MIN_VOLUME_STORAGE_KEY, value);
    }
    renderCalculationReport();
  });
});

els.calculationReport?.addEventListener("click", (event) => {
  const tabButton = event.target.closest("[data-calculation-tab]");
  if (tabButton) {
    state.calculationTab = ["parameters", "category", "tag"].includes(tabButton.dataset.calculationTab)
      ? tabButton.dataset.calculationTab
      : "parameters";
    saveCalculationTab(state.calculationTab);
    renderCalculationReport();
    return;
  }

  const taxonomyButton = event.target.closest("[data-taxonomy-sort]");
  if (taxonomyButton) {
    const kind = taxonomyButton.dataset.taxonomySort;
    const key = taxonomyButton.dataset.taxonomySortKey;
    if (!state.taxonomySort[kind]) return;
    if (state.taxonomySort[kind].key === key) {
      state.taxonomySort[kind].direction = state.taxonomySort[kind].direction === "asc" ? "desc" : "asc";
    } else {
      state.taxonomySort[kind].key = key;
      // Text and horizon columns read naturally ascending; every performance
      // column is most useful with the best value first.
      state.taxonomySort[kind].direction = key === "label" ? "asc" : "desc";
    }
    renderCalculationReport();
    return;
  }

  const button = event.target.closest("[data-calculation-sort]");
  if (!button) return;
  const key = button.dataset.calculationSort;
  if (state.calculationSort.key === key) {
    state.calculationSort.direction = state.calculationSort.direction === "asc" ? "desc" : "asc";
  } else {
    state.calculationSort.key = key;
    state.calculationSort.direction = ["source", "marketType", "threshold"].includes(key) ? "asc" : "desc";
  }
  renderCalculationReport();
});

// Delegated, because the tab row is rebuilt whenever a portfolio is created, renamed,
// archived or restored. Handlers bound to the buttons themselves would only work until
// the first of those.
document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-mode-toggle]");
  if (!button) return;
  const mode = normalizeMode(button.dataset.modeToggle);
  // Even when it lands on the tab already open: the reader has now chosen, so the
  // richest-portfolio preselection must not move them somewhere else later.
  state.portfolioPreselectDone = true;
  if (state.mode === mode) return;
  state.mode = mode;
  saveMode(mode);
  state.runLogFilters = storedRunLogFilter(mode);
  setRunLogFilterMenuOpen(false);
  state.eligibilityThreshold = null;
  state.eligibilityThresholdKey = "";
  state.riskAllocation = null;
  state.riskAllocationKey = "";
  state.limitOrders = null;
  state.limitOrdersKey = "";
  loadDashboardState();
});

els.liveActivation?.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  toggleLiveExecutionGate();
});

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-live-activation]");
  if (!button || button === els.liveActivation) return;
  event.preventDefault();
  event.stopPropagation();
  toggleLiveExecutionGate();
});

els.executionButtons.forEach((button) => {
  button.dataset.executionBound = "true";
  button.addEventListener("click", (event) => {
    event.preventDefault();
    triggerOneTimeExecution(oneTimeExecutionTarget(button));
  });
});

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-one-time-execution]");
  if (!button || button.dataset.executionBound === "true") return;
  event.preventDefault();
  triggerOneTimeExecution(oneTimeExecutionTarget(button));
});

els.evaluationStatusButtons.forEach((button) => {
  button.addEventListener("click", () => {
    setEvaluationStatus(button.dataset.evaluationStatus);
  });
});

els.runLogFilterToggle?.addEventListener("click", () => {
  const open = Boolean(els.runLogFilterMenu?.hidden);
  setRunLogFilterMenuOpen(open);
});

els.runLogFilterMenu?.addEventListener("change", (event) => {
  const input = event.target.closest("[data-run-log-filter-option]");
  if (!input) return;
  const action = normalizeRunLogFilter(input.value);
  if (action === "ALL") {
    state.runLogFilters = [];
  } else {
    const next = new Set(normalizeRunLogFilters(state.runLogFilters));
    if (input.checked) next.add(action);
    else next.delete(action);
    state.runLogFilters = [...next];
  }
  saveRunLogFilter(state.runLogFilters);
  renderRunLog();
});

document.addEventListener("click", (event) => {
  if (!els.runLogFilterControl?.contains(event.target)) setRunLogFilterMenuOpen(false);
});

els.portfolioCandidates?.addEventListener("click", (event) => {
  if (!event.target.closest("[data-candidates-load-more]")) return;
  event.preventDefault();
  showMoreCandidates();
});

// `scroll` does not bubble, so it is caught in the capture phase on the panel. That
// keeps one listener alive across the re-renders that replace the table, instead of
// binding a new one to each freshly built scroll container.
els.portfolioCandidates?.addEventListener("scroll", (event) => {
  const scroller = event.target;
  if (!scroller?.classList?.contains("ledger-scroll")) return;
  // Extend one screenful before the end, so the next rows are already there by the
  // time the user reaches the bottom.
  if (scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - scroller.clientHeight) return;
  showMoreCandidates();
}, true);

els.opportunityViewButtons.forEach((button) => {
  button.addEventListener("click", () => {
    setOpportunityView(button.dataset.opportunityView, { syncRoute: true });
  });
});

els.scrapedScanTag?.addEventListener("change", () => {
  state.scrapedScanTag = normalizedScrapedScanTag(els.scrapedScanTag.value);
  state.scrapedScanStatus = "";
  renderScrapedScanControls();
});

els.scrapedScanButton?.addEventListener("click", () => {
  triggerOneTimeMarketScan();
});

els.evaluationProbabilityFilter?.addEventListener("input", () => {
  state.scrapedRouteFilter = null;
  const raw = Number(els.evaluationProbabilityFilter.value);
  const value = normalizeEvaluationProbabilityFilter(Number.isFinite(raw) ? raw / 100 : 0);
  state.evaluationProbabilityFilter = value;
  saveEvaluationProbabilityFilter(value);
  syncEvaluationProbabilityFilterControl();
  renderBotEvaluations();
});

els.evaluationDaysFilter?.addEventListener("input", () => {
  state.scrapedRouteFilter = null;
  const value = normalizeEvaluationDaysFilter(els.evaluationDaysFilter.value);
  state.evaluationDaysFilter = value;
  saveEvaluationDaysFilter(value);
  persistScrapedScanPreferences();
  syncEvaluationDaysFilterControl();
  renderBotEvaluations();
});

els.evaluationNetYieldFilter?.addEventListener("input", () => {
  state.scrapedRouteFilter = null;
  const raw = Number(els.evaluationNetYieldFilter.value);
  const value = normalizeMinimumNetYield(Number.isFinite(raw) ? raw / 100 : 0);
  state.evaluationNetYieldFilter = value;
  saveEvaluationNetYieldFilter(value);
  renderBotEvaluations();
});

els.evaluationLiquidityFilter?.addEventListener("input", () => {
  state.scrapedRouteFilter = null;
  const raw = Number(els.evaluationLiquidityFilter.value);
  const value = Number.isFinite(raw) && raw >= 0 ? Math.round(raw * 100) / 100 : 0;
  state.evaluationLiquidityFilter = value;
  saveEvaluationLiquidityFilter(value);
  persistScrapedScanPreferences();
  syncEvaluationLiquidityFilterControl();
  renderBotEvaluations();
});

els.scrapedStatusOptions.forEach((input) => {
  input.addEventListener("change", () => {
    state.scrapedRouteFilter = null;
    const selected = [...els.scrapedStatusOptions]
      .filter((option) => option.checked)
      .map((option) => option.value);
    setScrapedStatuses(selected);
    if (state.page === "opportunities" && state.opportunityView === "scraped") {
      const targetPath = scrapedTaxonomyOpportunityPath();
      const currentPath = `${window.location.pathname}${window.location.search}`;
      if (currentPath !== targetPath) {
        window.history.pushState({ page: "opportunities", opportunityView: "scraped" }, "", targetPath);
      }
    }
  });
});

els.scrapedTaxonomyFilter?.addEventListener("change", async () => {
  state.scrapedRouteFilter = null;
  state.scrapedTaxonomyFilter = scrapedTaxonomyFilterFromValue(els.scrapedTaxonomyFilter.value);
  syncScrapedTaxonomyFilterControl();
  // Keep the filter interaction asynchronous: use the already loaded catalogue when
  // available, otherwise fetch the scraped dataset before rendering the selection.
  if (state.page === "opportunities" && state.opportunityView === "scraped") {
    await ensureScrapedMarketState({ summary: "scraped" });
  }
  renderBotEvaluations();
  if (state.page === "opportunities" && state.opportunityView === "scraped") {
    const targetPath = scrapedTaxonomyOpportunityPath();
    const currentPath = `${window.location.pathname}${window.location.search}`;
    if (currentPath !== targetPath) {
      window.history.pushState({ page: "opportunities", opportunityView: "scraped" }, "", targetPath);
    }
  }
});

els.scrapedMarketTypeFilter?.addEventListener("change", () => {
  state.scrapedRouteFilter = null;
  state.scrapedMarketTypeFilter = normalizeScrapedMarketType(els.scrapedMarketTypeFilter.value);
  syncScrapedMarketTypeFilterControl();
  renderBotEvaluations();
  if (state.page === "opportunities" && state.opportunityView === "scraped") {
    const query = new URLSearchParams(window.location.search);
    if (state.scrapedMarketTypeFilter === "all") query.delete(SCRAPED_MARKET_TYPE_QUERY_PARAM);
    else query.set(SCRAPED_MARKET_TYPE_QUERY_PARAM, state.scrapedMarketTypeFilter);
    const targetPath = `${opportunityRoutePath("scraped")}${query.toString() ? `?${query.toString()}` : ""}`;
    const currentPath = `${window.location.pathname}${window.location.search}`;
    if (currentPath !== targetPath) {
      window.history.pushState({ page: "opportunities", opportunityView: "scraped" }, "", targetPath);
    }
  }
});

els.portfolioName?.addEventListener("input", () => {
  const value = String(els.portfolioName.value || "").slice(0, 80);
  if (updateParameterDraft({ displayName: value })) {
    if (els.portfolioNameLabel) els.portfolioNameLabel.textContent = value || "default name";
    return;
  }
  updatePortfolioConfigForMode(state.mode, { displayName: value });
  savePortfolioConfigSoon();
  syncModeUi();
});

els.portfolioAccountType?.addEventListener("change", () => {
  switchCreatePortfolioType(els.portfolioAccountType.value);
});

els.eligibilityThreshold?.addEventListener("input", () => {
  if (parameterDraftInputIsEmpty(els.eligibilityThreshold)) {
    if (els.eligibilityThresholdLabel) els.eligibilityThresholdLabel.textContent = "-";
    return;
  }
  const raw = Number(els.eligibilityThreshold.value);
  if (!Number.isFinite(raw)) return;
  const normalized = normalizeEligibilityThreshold(raw / 100);
  const value = normalized ?? currentEligibilityThreshold();
  if (updateParameterDraft({ minProbability: value })) return;
  state.eligibilityThreshold = value;
  updatePortfolioConfigForMode(state.mode, { minProbability: value });
  saveEligibilityThreshold(value);
  savePortfolioConfigSoon();
  syncEligibilityThresholdControl();
  rerenderCurrentDashboard();
});

els.riskAllocation?.addEventListener("input", () => {
  if (parameterDraftInputIsEmpty(els.riskAllocation)) {
    if (els.riskAllocationLabel) els.riskAllocationLabel.textContent = "-";
    if (els.riskAllocationValue) els.riskAllocationValue.textContent = "-";
    return;
  }
  const raw = Number(els.riskAllocation.value);
  if (!Number.isFinite(raw)) return;
  const normalized = normalizeRiskAllocation(raw);
  const value = normalized ?? currentRiskAllocation();
  if (updateParameterDraft({ stakeUsdc: value })) return;
  state.riskAllocation = value;
  updatePortfolioConfigForMode(state.mode, { stakeUsdc: value });
  saveRiskAllocation(value);
  savePortfolioConfigSoon();
  rerenderCurrentDashboard();
});

els.limitOrders?.addEventListener("change", () => {
  if (updateParameterDraft({ useLimitOrders: Boolean(els.limitOrders.checked) })) return;
  state.limitOrders = Boolean(els.limitOrders.checked);
  updatePortfolioConfigForMode(state.mode, { useLimitOrders: state.limitOrders });
  saveLimitOrders(state.limitOrders);
  savePortfolioConfigSoon();
  rerenderCurrentDashboard();
});

els.maxResolutionDays?.addEventListener("input", () => {
  if (parameterDraftInputIsEmpty(els.maxResolutionDays)) {
    if (els.maxResolutionDaysLabel) els.maxResolutionDaysLabel.textContent = "-";
    return;
  }
  const value = normalizeOptionalDays(els.maxResolutionDays.value) || DEFAULT_MAX_RESOLUTION_DAYS;
  if (updateParameterDraft({ maxResolutionDays: value })) return;
  updatePortfolioConfigForMode(state.mode, { maxResolutionDays: value });
  savePortfolioConfigSoon();
  syncPortfolioParameterControls();
  rerenderCurrentDashboard();
});

els.selectionOrder?.addEventListener("change", () => {
  const value = normalizeSelectionOrder(els.selectionOrder.value);
  if (updateParameterDraft({ selectionOrder: value })) return;
  updatePortfolioConfigForMode(state.mode, { selectionOrder: value });
  savePortfolioConfigSoon();
  syncPortfolioParameterControls();
  rerenderCurrentDashboard();
});

els.minLiquidity?.addEventListener("input", () => {
  const value = normalizeOptionalMoney(els.minLiquidity.value);
  if (updateParameterDraft({ minLiquidityUsdc: value })) return;
  updatePortfolioConfigForMode(state.mode, { minLiquidityUsdc: value });
  savePortfolioConfigSoon();
  syncPortfolioParameterControls();
  rerenderCurrentDashboard();
});

els.minNetYield?.addEventListener("input", () => {
  if (parameterDraftInputIsEmpty(els.minNetYield)) {
    if (els.minNetYieldLabel) els.minNetYieldLabel.textContent = "-";
    return;
  }
  const value = normalizeMinimumNetYield(Number(els.minNetYield.value) / 100);
  if (parameterDraftActive()) {
    state.parameterDraft = { ...state.parameterDraft, minNetYield: value };
    if (els.minNetYieldLabel) els.minNetYieldLabel.textContent = percent(value);
    return;
  }
  updatePortfolioConfigForMode(state.mode, { minNetYield: value });
  savePortfolioConfigSoon();
  syncPortfolioParameterControls();
  rerenderCurrentDashboard();
});

els.executionTrigger?.addEventListener("change", () => {
  const value = normalizeExecutionTrigger(els.executionTrigger.value);
  if (updateParameterDraft({ executionTrigger: value })) return;
  updatePortfolioConfigForMode(state.mode, { executionTrigger: value });
  savePortfolioConfigSoon();
  syncPortfolioParameterControls();
  rerenderCurrentDashboard();
});

els.executionCronMinutes?.addEventListener("change", () => {
  const value = normalizeExecutionCronMinutes(els.executionCronMinutes.value);
  if (updateParameterDraft({ executionCronMinutes: value })) return;
  updatePortfolioConfigForMode(state.mode, { executionCronMinutes: value });
  savePortfolioConfigSoon();
  syncPortfolioParameterControls();
  rerenderCurrentDashboard();
});

els.fixedEntryTags?.addEventListener("change", () => {
  const value = normalizeMarketTagList(els.fixedEntryTags.value);
  if (updateParameterDraft({ allowedMarketTags: value })) return;
  updatePortfolioConfigForMode(state.mode, { allowedMarketTags: value });
  savePortfolioConfigSoon();
  syncPortfolioParameterControls();
  rerenderCurrentDashboard();
});

els.excludedTags?.addEventListener("change", () => {
  const value = normalizeMarketTagList(els.excludedTags.value);
  if (updateParameterDraft({ excludedMarketTags: value })) return;
  updatePortfolioConfigForMode(state.mode, { excludedMarketTags: value });
  savePortfolioConfigSoon();
  syncPortfolioParameterControls();
  rerenderCurrentDashboard();
});

els.fixedEntryPrice?.addEventListener("change", () => {
  const value = normalizeFixedEntryPrice(Number(els.fixedEntryPrice.value) / 100);
  if (updateParameterDraft({ fixedEntryPrice: value })) return;
  updatePortfolioConfigForMode(state.mode, { fixedEntryPrice: value });
  savePortfolioConfigSoon();
  syncPortfolioParameterControls();
  rerenderCurrentDashboard();
});

document.addEventListener("click", (event) => {
  const toggle = event.target?.closest?.("[data-automation-toggle]");
  if (!toggle) return;
  // The badge lives inside the portfolio's rules card, which is rebuilt on every
  // render, so the handler is delegated rather than bound to an element that would
  // be replaced out from under it.
  const value = !automationIsEnabled(portfolioConfigForMode(state.mode));
  updatePortfolioConfigForMode(state.mode, { automationEnabled: value });
  savePortfolioConfigSoon();
  syncPortfolioParameterControls();
  rerenderCurrentDashboard();
});

els.portfolioMarketType?.addEventListener("change", () => {
  const marketType = normalizePortfolioMarketType(els.portfolioMarketType.value);
  const updates = { marketType, requireMostProbableOutcome: marketType === "multi" };
  if (updateParameterDraft(updates)) return;
  updatePortfolioConfigForMode(state.mode, updates);
  savePortfolioConfigSoon();
  syncPortfolioParameterControls();
  rerenderCurrentDashboard();
});

els.autoRotatePositions?.addEventListener("change", () => {
  const value = Boolean(els.autoRotatePositions.checked);
  if (updateParameterDraft({ autoRotatePositions: value })) return;
  updatePortfolioConfigForMode(state.mode, { autoRotatePositions: value });
  savePortfolioConfigSoon();
  syncPortfolioParameterControls();
  rerenderCurrentDashboard();
});

els.stopLossRiskMultiplier?.addEventListener("input", () => {
  if (parameterDraftInputIsEmpty(els.stopLossRiskMultiplier)) {
    if (els.stopLossRiskMultiplierLabel) els.stopLossRiskMultiplierLabel.textContent = "-";
    return;
  }
  const multiplier = normalizeStopLossRiskMultiplier(Number(els.stopLossRiskMultiplier.value) / 100, 0);
  const updates = {
    stopLossEnabled: multiplier > 0,
    stopLossRiskMultiplier: multiplier,
  };
  if (els.stopLossRiskMultiplierLabel) {
    els.stopLossRiskMultiplierLabel.textContent = multiplier > 0 ? `${percent(multiplier)} of net win` : "Off";
  }
  if (updateParameterDraft(updates)) return;
  updatePortfolioConfigForMode(state.mode, updates);
  savePortfolioConfigSoon();
  syncPortfolioParameterControls();
  rerenderCurrentDashboard();
});

els.includeOnlyTags?.addEventListener("change", () => {
  const value = normalizeMarketTagList(els.includeOnlyTags.value);
  if (updateParameterDraft({ includeOnlyMarketTags: value })) return;
  updatePortfolioConfigForMode(state.mode, { includeOnlyMarketTags: value });
  savePortfolioConfigSoon();
  syncPortfolioParameterControls();
  rerenderCurrentDashboard();
});

els.crossLiveRisk?.addEventListener("change", () => {
  const value = Boolean(els.crossLiveRisk.checked);
  if (updateParameterDraft({}, { crossLivePortfolioRiskDiversification: value })) return;
  updateSystemConfig({ crossLivePortfolioRiskDiversification: value });
  savePortfolioConfigSoon();
  syncPortfolioParameterControls();
});

els.botEvaluations?.addEventListener("click", (event) => {
  const loadMoreScraped = event.target.closest("[data-scraped-load-more]");
  if (loadMoreScraped) {
    event.preventDefault();
    showMoreScrapedOpportunities();
    return;
  }
  const loadMoreScrapeHistory = event.target.closest("[data-scrape-history-load-more]");
  if (loadMoreScrapeHistory) {
    loadScrapeRunHistory();
    return;
  }
  const scrapeRunRow = event.target.closest("[data-scrape-run-audit]");
  if (scrapeRunRow) {
    const runId = scrapeRunRow.dataset.scrapeRunAudit || "";
    const run = (Array.isArray(state.scrapedMarketScanHistory) ? state.scrapedMarketScanHistory : [])
      .find((item) => String(item?.id || "") === runId);
    if (run) openScrapeRunAudit(run, scrapeRunRow);
    return;
  }
  const scrapedRefreshButton = event.target.closest("[data-scraped-refresh]");
  if (scrapedRefreshButton) {
    event.preventDefault();
    event.stopPropagation();
    const item = findScrapedOpportunityByKey(scrapedRefreshButton.dataset.scrapedRefresh || "");
    triggerScrapedOpportunityRefresh(item);
    return;
  }
  const scrapedButton = event.target.closest("[data-scraped-sort]");
  if (scrapedButton) {
    const key = scrapedButton.dataset.scrapedSort;
    if (state.scrapedSort.key === key) {
      state.scrapedSort.direction = state.scrapedSort.direction === "asc" ? "desc" : "asc";
    } else {
      state.scrapedSort.key = key;
      state.scrapedSort.direction = ["market", "status"].includes(key) ? "asc" : "desc";
    }
    renderBotEvaluations();
    return;
  }
  const button = event.target.closest("[data-evaluation-sort]");
  if (!button) return;
  const key = button.dataset.evaluationSort;
  if (state.evaluationSort.key === key) {
    state.evaluationSort.direction = state.evaluationSort.direction === "asc" ? "desc" : "asc";
  } else {
    state.evaluationSort.key = key;
    state.evaluationSort.direction = ["marketPrice", "odds", "gainIfWin", "netYield", "aiProbability", "potentialAnnualizedReturn"].includes(key) ? "desc" : "asc";
  }
  renderBotEvaluations();
});

els.botEvaluations?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const scrapeRunRow = event.target.closest("[data-scrape-run-audit]");
  if (!scrapeRunRow) return;
  event.preventDefault();
  scrapeRunRow.click();
});

document.addEventListener("change", (event) => {
  const exclusion = event.target.closest("[data-portfolio-candidate-exclude]");
  if (!exclusion) return;
  setPortfolioCandidateExcluded(
    exclusion.dataset.portfolioMode || state.mode,
    exclusion.dataset.candidateTokenId || "",
    Boolean(exclusion.checked),
  );
});

document.addEventListener("click", (event) => {
  const shortlistRefreshButton = event.target.closest("[data-portfolio-candidates-refresh]");
  if (shortlistRefreshButton) {
    event.preventDefault();
    refreshPortfolioCandidates();
    return;
  }

  const parameterModal = event.target.closest("[data-parameter-modal]");
  if (parameterModal) {
    if (event.target.closest("[data-parameter-modal-confirm]")) {
      confirmParameterModal();
      return;
    }
    if (event.target === parameterModal || event.target.closest("[data-parameter-modal-close]")) {
      closeParameterModal();
    }
    return;
  }

  const execution = event.target.closest("[data-execution-modal]");
  if (execution) {
    if (event.target === execution || event.target.closest("[data-execution-modal-close]")) {
      closeExecutionModal();
    }
    return;
  }

  const runEventButton = event.target.closest("[data-run-event]");
  if (runEventButton) {
    event.preventDefault();
    const [runIndexRaw, eventIndexRaw] = String(runEventButton.dataset.runEvent || "").split(":");
    const run = (Array.isArray(state.botState?.evaluationRunLog) ? state.botState.evaluationRunLog : [])[Number(runIndexRaw)];
    const runEvent = Array.isArray(run?.events) ? run.events[Number(eventIndexRaw)] : null;
    openAnalysisModal(runEventDetail(runEvent || {}), runEventButton);
    return;
  }

  const manualEvaluationButton = event.target.closest("[data-manual-evaluation]");
  if (manualEvaluationButton) {
    event.preventDefault();
    event.stopPropagation();
    const item = findOpportunityByKey(manualEvaluationButton.dataset.manualEvaluation || "");
    triggerManualOpportunityEvaluation(item, manualEvaluationButton);
    return;
  }

  const portfolioRunButton = event.target.closest("[data-portfolio-run]");
  if (portfolioRunButton) {
    event.preventDefault();
    const run = state.displayedRunLog[Number(portfolioRunButton.dataset.portfolioRun)];
    openExecutionRunDetail(portfolioRunBatch(run || {}), portfolioRunButton);
    return;
  }

  const runLogLoadMoreButton = event.target.closest("[data-run-log-load-more]");
  if (runLogLoadMoreButton) {
    event.preventDefault();
    const strategyId = isLiveMode() ? null : paperStrategyIdFromMode();
    if (strategyId) loadPortfolioRunLogHistory(strategyId);
    return;
  }

  const runBatchButton = event.target.closest("[data-run-batch]");
  if (runBatchButton) {
    event.preventDefault();
    const [runIndexRaw, decisionIndexRaw] = String(runBatchButton.dataset.runBatch || "").split(":");
    const run = (Array.isArray(state.botState?.evaluationRunLog) ? state.botState.evaluationRunLog : [])[Number(runIndexRaw)];
    const decision = Array.isArray(run?.decisions) ? run.decisions[Number(decisionIndexRaw)] : null;
    openExecutionRunDetail(decision?.batchLog || decision || {}, runBatchButton);
    return;
  }

  const liveBatchButton = event.target.closest("[data-live-batch]");
  if (liveBatchButton) {
    event.preventDefault();
    openExecutionRunDetail(state.liveExecutionState?.batchLog || state.liveExecutionState || {}, liveBatchButton);
    return;
  }

  const parameterEditButton = event.target.closest("[data-portfolio-parameters-edit]");
  if (parameterEditButton) {
    event.preventDefault();
    openParameterModal(parameterEditButton);
    return;
  }

  // Asked for explicitly: a direct way to archive next to the edit icon, not only buried
  // inside the parameter modal. Same confirmation and action, no modal to open first.
  const directArchiveButton = event.target.closest("[data-portfolio-archive-direct]");
  if (directArchiveButton) {
    event.preventDefault();
    const strategyId = directArchiveButton.dataset.portfolioArchiveDirect || "";
    if (!strategyId) return;
    const isLive5050 = strategyId === "live-5050";
    const label = normalizePortfolioName(
      portfolioConfigForMode(isLive5050 ? strategyId : `paper-${strategyId}`).displayName,
      isLive5050 ? "5050" : strategyId,
    );
    // 5050 holds real positions and open orders, unlike a paper portfolio, so its
    // confirmation says plainly what keeps running: withdrawing an expired resting
    // order and refreshing the account snapshot are unconditional in the executor,
    // and only opening new bids actually stops.
    const confirmMessage = isLive5050
      ? `Archive "${label}"?\n\nIt disappears from the dashboard and stops resting new bids. Existing positions and open orders keep being watched and their expired orders withdrawn as normal. Every trade, run log and statistic it holds is kept, and you can restore it from Settings.`
      : `Archive "${label}"?\n\nIt disappears from the dashboard and stops trading. Every trade, run log and statistic it holds is kept, and you can restore it from Settings.`;
    if (!window.confirm(confirmMessage)) {
      return;
    }
    setPortfolioArchived(strategyId, true);
    return;
  }

  const createPortfolioButton = event.target.closest("[data-create-portfolio]");
  if (createPortfolioButton) {
    event.preventDefault();
    // A statistics row carries the rule it was measured under, so the created portfolio
    // trades what that row describes rather than a blank template.
    openCreatePortfolioModal(portfolioPrefillFromDataset(createPortfolioButton.dataset), createPortfolioButton);
    return;
  }

  const archiveButton = event.target.closest("[data-parameter-modal-archive]");
  if (archiveButton) {
    event.preventDefault();
    const strategyId = archiveButton.dataset.portfolioId || "";
    if (!strategyId) return;
    const label = normalizePortfolioName(portfolioConfigForMode(`paper-${strategyId}`).displayName, strategyId);
    // Asked for explicitly: archiving is a deliberate act, so it is confirmed before it
    // happens rather than offered as an undo afterwards.
    if (!window.confirm(`Archive "${label}"?\n\nIt disappears from the dashboard and stops trading. Every trade, run log and statistic it holds is kept, and you can restore it from Settings.`)) {
      return;
    }
    closeParameterModal();
    setPortfolioArchived(strategyId, true);
    return;
  }

  const restoreButton = event.target.closest("[data-restore-portfolio]");
  if (restoreButton) {
    event.preventDefault();
    setPortfolioArchived(restoreButton.dataset.restorePortfolio || "", false);
    return;
  }

  const opportunityDetailLink = event.target.closest("[data-opportunity-detail]");
  if (opportunityDetailLink) {
    event.preventDefault();
    const item = findOpportunityByKey(opportunityDetailLink.dataset.opportunityDetail || "");
    openOpportunityDetail(item, opportunityDetailLink, { push: true });
    return;
  }

  const infoButton = event.target.closest(".info-button");
  if (infoButton) {
    event.preventDefault();
    event.stopPropagation();
    const popover = infoButton.closest(".analysis-popover");
    const detail = popover?.querySelector(".analysis-tooltip")?.textContent || "";
    openAnalysisModal(detail, infoButton);
    return;
  }

  const modal = event.target.closest("[data-analysis-modal]");
  if (!modal) return;
  if (event.target === modal || event.target.closest("[data-analysis-modal-close]")) {
    closeAnalysisModal();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeExecutionModal();
    closeAnalysisModal();
    closeParameterModal();
  }
});

function handleTradeSort(event) {
  const button = event.target.closest("[data-trade-sort]");
  if (!button) return;
  const tableKey = button.dataset.tradeTable || "open";
  const key = button.dataset.tradeSort;
  state.tradeSort[tableKey] ||= { key, direction: "desc" };
  if (state.tradeSort[tableKey].key === key) {
    state.tradeSort[tableKey].direction = state.tradeSort[tableKey].direction === "asc" ? "desc" : "asc";
  } else {
    state.tradeSort[tableKey].key = key;
    state.tradeSort[tableKey].direction = ["market", "status"].includes(key) ? "asc" : "desc";
  }
  if (isLiveMode()) {
    if (!state.liveState) return;
    renderLiveState(state.liveState);
  } else {
    if (!state.botState) return;
    renderBotState(state.botState);
  }
}

els.botTrades?.addEventListener("click", handleTradeSort);
els.closedTrades?.addEventListener("click", handleTradeSort);
els.openedTradesRefresh?.addEventListener("click", refreshOpenedTradesValues);
els.closedTradesExport?.addEventListener("click", exportClosedTradesCsv);

state.mode = storedMode();
state.runLogFilters = storedRunLogFilter(state.mode);
state.calculationTab = storedCalculationTab();
state.calculationMinOpen = normalizeCalculationMinimum(storedCalculationPreference(CALCULATION_MIN_OPEN_STORAGE_KEY));
state.calculationMinTrades = normalizeCalculationMinimum(storedCalculationPreference(CALCULATION_MIN_TRADES_STORAGE_KEY));
state.calculationMinVolume = normalizeCalculationMinimum(storedCalculationPreference(CALCULATION_MIN_VOLUME_STORAGE_KEY));
state.liveExecutionArmed = storedLiveExecutionArmed();
state.evaluationProbabilityFilter = storedEvaluationProbabilityFilter();
state.evaluationDaysFilter = storedEvaluationDaysFilter();
state.evaluationNetYieldFilter = storedEvaluationNetYieldFilter();
state.evaluationLiquidityFilter = storedEvaluationLiquidityFilter();
syncEvaluationProbabilityFilterControl();
syncEvaluationDaysFilterControl();
syncEvaluationNetYieldFilterControl();
syncEvaluationLiquidityFilterControl();
syncCalculationControls();
persistScrapedScanPreferences();
applyInitialRoute();
updateSchedulePanel();
window.setInterval(updateSchedulePanel, 60000);
loadDashboardState().then(() => {
  if (isLiveMode()) requestLiveAccountSync({ quiet: true });
  pollRunningExecution(currentExecutionTarget());
});

// Reads run status only; it dispatches nothing, so unlike the sync request below it costs
// the runners nothing. The row it drives also re-renders on every poll, which is what
// keeps the elapsed time and the current step moving while the run is still going.
window.setInterval(() => {
  if (document.hidden) return;
  pollRunningExecution(currentExecutionTarget());
}, EXECUTION_WATCH_MS);

// Paced by LIVE_SYNC_REQUEST_MS, not by the state-refresh interval. Polling the dispatch
// endpoint every 15s only worked because the server throttled it; asking on the same slow
// cadence the server allows keeps the two from disagreeing again.
window.setInterval(() => {
  if (!isLiveMode()) return;
  requestLiveAccountSync({ quiet: true, minSeconds: LIVE_SYNC_REQUEST_MS / 1000 });
}, LIVE_SYNC_REQUEST_MS);
