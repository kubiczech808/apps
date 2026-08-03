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
  scrapedScanTag: "",
  scrapedScanBusy: false,
  scrapedScanStatus: "",
  scrapedScanPreferenceSaveTimer: null,
  scrapedRefreshKeys: new Set(),
  scrapedRefreshErrors: new Map(),
  evaluationProbabilityFilter: 0,
  evaluationDaysFilter: null,
  evaluationNetYieldFilter: 0,
  evaluationLiquidityFilter: 0,
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
  calculationSort: {
    key: "roi",
    direction: "desc",
  },
  displayedRunLog: [],
  runLogFilters: [],
  userNavRefreshTimer: null,
  openedOpportunityKey: "",
};

const ELIGIBILITY_THRESHOLD_STORAGE_KEY = "tradingEligibilityProbabilityThreshold";
const EVALUATION_PROBABILITY_FILTER_STORAGE_KEY = "tradingEvaluationProbabilityFilter";
const EVALUATION_DAYS_FILTER_STORAGE_KEY = "tradingEvaluationDaysFilter";
const EVALUATION_NET_YIELD_FILTER_STORAGE_KEY = "tradingEvaluationNetYieldFilter";
const EVALUATION_LIQUIDITY_FILTER_STORAGE_KEY = "tradingEvaluationLiquidityFilter";
const RISK_ALLOCATION_STORAGE_KEY = "tradingRiskAllocationFraction";
const LIMIT_ORDERS_STORAGE_KEY = "tradingUseLimitOrders";
const MODE_STORAGE_KEY = "tradingDashboardMode";
const LIVE_EXECUTION_STORAGE_KEY = "tradingLiveExecutionArmed";
const RUN_LOG_FILTER_STORAGE_PREFIX = "tradingRunLogStatusFilter";
const STATE_CACHE_PREFIX = "tradingStateCache:";
const DEFAULT_ELIGIBILITY_THRESHOLD = 0.95;
const MIN_ELIGIBILITY_THRESHOLD = 0.01;
const MAX_ELIGIBILITY_THRESHOLD = 0.99;
const MIN_PORTFOLIO_EV_PA = 0.05;
const DEFAULT_RISK_ALLOCATION = 0.05;
const MIN_RISK_ALLOCATION = 0.01;
const MAX_RISK_ALLOCATION = 0.5;
const DEFAULT_MAX_RESOLUTION_DAYS = 7;
// Annualizing a few minutes as if the trade could be repeated continuously is
// misleading. Keep the actual horizon visible, but use a conservative one-day
// floor for every potential p.a. comparison.
const MIN_ANNUALIZATION_DAYS = 1;
const LIVE_STATE_REFRESH_MS = 15000;
const LIVE_SYNC_REQUEST_MS = 30000;
const USER_NAV_REFRESH_DEBOUNCE_MS = 250;
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
  calculationReport: document.querySelector("[data-calculation-report]"),
  systemStatus: document.querySelector("[data-system-status]"),
  evaluationProbabilityFilter: document.querySelector("[data-evaluation-probability-filter]"),
  evaluationProbabilityFilterLabel: document.querySelector("[data-evaluation-probability-filter-label]"),
  evaluationDaysFilter: document.querySelector("[data-evaluation-days-filter]"),
  evaluationDaysFilterLabel: document.querySelector("[data-evaluation-days-filter-label]"),
  evaluationNetYieldFilter: document.querySelector("[data-evaluation-net-yield-filter]"),
  evaluationNetYieldFilterLabel: document.querySelector("[data-evaluation-net-yield-filter-label]"),
  evaluationLiquidityFilter: document.querySelector("[data-evaluation-liquidity-filter]"),
  evaluationLiquidityFilterLabel: document.querySelector("[data-evaluation-liquidity-filter-label]"),
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
  mostProbableOutcome: document.querySelector("[data-most-probable-outcome]"),
  polymarketProbability: document.querySelector("[data-polymarket-probability]"),
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
  portfolioRr: document.querySelector("[data-portfolio-rr]"),
  portfolioRrNote: document.querySelector("[data-portfolio-rr-note]"),
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

function compactDays(value) {
  if (!Number.isFinite(value)) return "-";
  if (value <= 0) return "due now";
  if (value > 0 && value < 0.1) return "< 0.1 d";
  if (value < 1) return `${Math.max(0, value).toFixed(1)} d`;
  return `${value.toFixed(1)} d`;
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
    if (value === "live" || value === "paper-highReward" || value === "paper-moreProbable" || value === "paper-conservative") return value;
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

function normalizeMode(mode) {
  if (mode === "live" || mode === "paper-highReward" || mode === "paper-moreProbable" || mode === "paper-conservative") return mode;
  return mode === "paper" ? "paper-conservative" : "paper-conservative";
}

function isLiveMode() {
  return state.mode === "live";
}

function paperStrategyIdFromMode(mode = state.mode) {
  if (mode === "paper-highReward") return "highReward";
  if (mode === "paper-moreProbable") return "moreProbable";
  return "conservative";
}

function paperModeLabel(mode = state.mode) {
  const strategyId = paperStrategyIdFromMode(mode);
  if (strategyId === "highReward") return "High reward";
  if (strategyId === "moreProbable") return "More probable";
  return "Conservative";
}

function defaultPortfolioConfig() {
  return {
    paper: {
      conservative: {
        minProbability: 0.95,
        maxOrderFraction: 0.05,
        maxResolutionDays: 7,
        selectionOrder: "highest_ev_pa_first",
        minLiquidityUsdc: null,
        minNetYield: 0,
        executionTrigger: "cron",
        requireMostProbableOutcome: false,
        probabilitySource: "ai",
        excludedCandidateTokenIds: [],
      },
      highReward: {
        minProbability: 0.6,
        maxOrderFraction: 0.05,
        maxResolutionDays: DEFAULT_MAX_RESOLUTION_DAYS,
        selectionOrder: "highest_reward_risk_first",
        minLiquidityUsdc: null,
        minNetYield: 0,
        executionTrigger: "cron",
        requireMostProbableOutcome: false,
        probabilitySource: "ai",
        excludedCandidateTokenIds: [],
      },
      moreProbable: {
        minProbability: 0.6,
        maxOrderFraction: 0.05,
        maxResolutionDays: 7,
        selectionOrder: "highest_reward_risk_first",
        minLiquidityUsdc: 500000,
        minNetYield: 0,
        executionTrigger: "cron",
        requireMostProbableOutcome: true,
        probabilitySource: "ai",
        excludedCandidateTokenIds: [],
      },
    },
    live: {
      minProbability: 0.95,
      maxOrderFraction: 0.05,
      maxResolutionDays: DEFAULT_MAX_RESOLUTION_DAYS,
      selectionOrder: "highest_ev_pa_first",
      minLiquidityUsdc: 100,
      minNetYield: 0,
      executionTrigger: "cron",
      useLimitOrders: true,
      requireMostProbableOutcome: false,
      probabilitySource: "ai",
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

function normalizeProbabilitySource(value) {
  return value === "polymarket" ? "polymarket" : "ai";
}

function normalizeExecutionTrigger(value) {
  return value === "after_scrape" ? "after_scrape" : "cron";
}

function executionTriggerLabel(value) {
  return normalizeExecutionTrigger(value) === "after_scrape"
    ? "After each scraping batch"
    : "Scheduled cron";
}

function probabilitySourceLabel(value) {
  return normalizeProbabilitySource(value) === "polymarket" ? "Polymarket probability" : "AI probability";
}

function portfolioProbability(item, config = {}) {
  return normalizeProbabilitySource(config.probabilitySource) === "polymarket"
    ? Number(item.marketProbability ?? item.marketPrice)
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
  if (normalizeMode(mode) === "live") {
    return {
      ...defaults.live,
      ...(config.live || {}),
    };
  }
  const strategyId = paperStrategyIdFromMode(mode);
  return {
    ...defaults.paper[strategyId],
    ...((config.paper || {})[strategyId] || {}),
  };
}

function updatePortfolioConfigForMode(mode, updates) {
  const normalizedMode = normalizeMode(mode);
  const base = state.portfolioConfig || defaultPortfolioConfig();
  if (normalizedMode === "live") {
    state.portfolioConfig = {
      ...base,
      live: {
        ...portfolioConfigForMode("live"),
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

function oneTimeExecutionTarget(button) {
  if (!button) return isLiveMode() ? "live" : state.mode;
  if (button.dataset.oneTimeExecution === "current") return isLiveMode() ? "live" : state.mode;
  return button.dataset.oneTimeExecution === "live" ? "live" : "paper";
}

function isPaperExecutionTarget(target) {
  return target === "paper" || String(target || "").startsWith("paper-");
}

function executionTargetLabel(target) {
  if (target === "live") return "live";
  if (isPaperExecutionTarget(target)) return paperModeLabel(target === "paper" ? state.mode : target);
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
    return {
      page: "opportunities",
      tab: "settings-runs",
      settingsSection: "evaluation-log",
      evaluationStatus: "EVALUATED",
      opportunityView: normalizeOpportunityView(opportunityRoute[1]),
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

function normalizeOpportunityView(view) {
  return view === "evaluated" || view === "scan-log" ? view : "scraped";
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
  const scrapedCounts = scraped ? scrapedOpportunityStatusCounts() : null;
  els.evaluationStatusButtons.forEach((button) => {
    const status = button.dataset.evaluationStatus;
    if (scraped) {
      const labels = {
        EVALUATED: `Scraped (${formatInteger(scrapedCounts.scraped)})`,
        RESOLVED: `Resolved (${formatInteger(scrapedCounts.resolved)})`,
        ERROR: `Error (${formatInteger(scrapedCounts.error)})`,
        ALL: `All (${formatInteger(scrapedCounts.all)})`,
      };
      button.textContent = labels[status] || status;
    } else {
      button.textContent = status === "EVALUATED" ? "Evaluated" : status === "ALL" ? "All evaluated" : button.textContent;
    }
  });
  renderScrapedScanControls();
}

function normalizedScrapedScanTag(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function scrapedScanTagOptions() {
  const counts = new Map();
  const addCount = (rawTag, count = 1) => {
    const tag = normalizedScrapedScanTag(rawTag);
    if (!tag || tag === "clear-resolution") return;
    counts.set(tag, Number(counts.get(tag) || 0) + Math.max(1, Number(count) || 1));
  };
  for (const item of scrapedMarketObservations()) {
    const tags = [
      ...(Array.isArray(item?.polymarketTags) ? item.polymarketTags : []),
      ...(Array.isArray(item?.tags) ? item.tags : []),
      item?.riskCategory,
    ];
    tags.forEach((rawTag) => addCount(rawTag));
  }
  for (const [tag, count] of Object.entries(state.scrapedMarketScan?.lastCategoryCounts || {})) {
    addCount(tag, count);
  }
  for (const [tag, count] of Object.entries(state.scrapedMarketScanHistory?.[0]?.tagCounts || {})) {
    addCount(tag, count);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
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
    ...options.map(([tag, count]) => `<option value="${escapeHtml(tag)}">${escapeHtml(scrapedScanTagLabel(tag))} (${formatInteger(count) || count})</option>`),
  ].join("");
  els.scrapedScanTag.value = state.scrapedScanTag;
  if (els.scrapedScanButton) {
    els.scrapedScanButton.disabled = state.scrapedScanBusy;
    els.scrapedScanButton.textContent = state.scrapedScanBusy ? "Scanning..." : "Scan Polymarket";
  }
  if (els.scrapedScanStatus) {
    els.scrapedScanStatus.textContent = state.scrapedScanStatus || "";
    els.scrapedScanStatus.className = `scraped-scan-status${state.scrapedScanStatus?.startsWith("Error") ? " error" : ""}`;
  }
}

function normalizeMinimumNetYield(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
  return Math.min(10, Math.round(numeric * 1000) / 1000);
}

function setOpportunityView(view, { syncRoute = false, replace = false } = {}) {
  state.opportunityView = normalizeOpportunityView(view);
  syncOpportunityPageHeading();
  syncOpportunityViewControls();
  renderBotEvaluations();
  if (state.opportunityView === "scraped" || state.opportunityView === "scan-log") ensureScrapedMarketState();
  if (syncRoute && state.page === "opportunities") {
    const targetPath = `${opportunityRoutePath(state.opportunityView)}${window.location.search}`;
    const currentPath = `${window.location.pathname}${window.location.search}`;
    if (currentPath !== targetPath) {
      window.history[replace ? "replaceState" : "pushState"]({ page: "opportunities", opportunityView: state.opportunityView }, "", targetPath);
    }
  }
}

function activatePage(page, { replace = false, preserveSearch = false } = {}) {
  const nextPage = ["settings", "opportunities", "portfolios"].includes(page) ? page : "portfolios";
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

function syncModeUi() {
  const live = isLiveMode();
  els.modeButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.modeToggle === state.mode);
  });
  els.tabButtons.forEach((button) => {
    if (button.dataset.paperLabel || button.dataset.liveLabel) {
      button.textContent = live ? button.dataset.liveLabel : button.dataset.paperLabel;
    }
  });
  if (els.portfolioTitle) els.portfolioTitle.textContent = live ? "Live Polymarket account" : `Paper - ${paperModeLabel()}`;
  if (els.primaryPanelTitle) els.primaryPanelTitle.textContent = live ? "Opened live trades" : `Opened ${paperModeLabel()} trades`;
  if (els.secondaryPanelTitle) els.secondaryPanelTitle.textContent = live ? "Closed live trades" : `Closed ${paperModeLabel()} trades`;
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
  const url = new URL(opportunityRoutePath("evaluated"), window.location.origin);
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
  return ["WON", "LOST", "CLOSED", "REDEEMED", "SOLD", "REDEEM_REQUIRED", "RESOLVED"].includes(String(trade.status || "").toUpperCase());
}

function closedTradeWasCorrect(trade) {
  const status = String(trade.status || "").toUpperCase();
  if (["WON", "REDEEMED"].includes(status)) return true;
  if (status === "LOST") return false;
  const realized = Number(trade.realizedPnlUsdc);
  if (Number.isFinite(realized)) return realized > 0;
  const finalPrice = Number(trade.finalPrice ?? trade.currentPrice);
  if (Number.isFinite(finalPrice)) return finalPrice >= 0.995;
  return false;
}

function closedAccuracyStats(closedTrades) {
  const rows = Array.isArray(closedTrades) ? closedTrades.filter(isClosedTrade) : [];
  const correct = rows.filter(closedTradeWasCorrect).length;
  const total = rows.length;
  return {
    correct,
    total,
    rate: total ? correct / total : null,
  };
}

function renderClosedAccuracy(closedTrades) {
  const stats = closedAccuracyStats(closedTrades);
  if (els.portfolioAccuracy) {
    els.portfolioAccuracy.textContent = stats.rate == null ? "-" : probability(stats.rate);
    els.portfolioAccuracy.className = stats.rate == null ? "" : (stats.rate >= 0.5 ? "positive" : "negative");
  }
  if (els.portfolioAccuracyNote) {
    els.portfolioAccuracyNote.textContent = `${stats.correct} / ${stats.total} closed`;
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
  if (!inferred) return stored;
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

function daysUntil(value) {
  const end = Date.parse(value || "");
  if (!Number.isFinite(end)) return null;
  return Math.max(0, (end - Date.now()) / 86400000);
}

function tradeHoldingDays(trade) {
  const end = isClosedTrade(trade) ? (trade.resolvedAt || trade.closedTime || trade.lastCheckedAt || new Date().toISOString()) : new Date().toISOString();
  return daysBetween(trade.openedAt || trade.date, end);
}

function annualizedForPeriod(returnPct, days) {
  if (!Number.isFinite(returnPct) || !Number.isFinite(days) || days <= 0) return null;
  return returnPct * (365 / Math.max(days, 1 / 24));
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

function averageRiskReward(items, mapper) {
  const values = items.map(mapper).filter(Number.isFinite);
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function tradePotentialAnnualized(trade) {
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
    if (Number.isFinite(shares) && shares > 0 && Number.isFinite(currentValue) && currentValue > 0
      && Number.isFinite(remainingDays) && remainingDays > 0) {
      const remainingPotentialPct = (shares - currentValue) / currentValue;
      return annualizedForPeriod(remainingPotentialPct, remainingDays);
    }
  }
  const gainPct = tradePotentialGainPct(trade);
  const endDate = tradeEndDate(trade);
  const totalPlannedDays = daysBetween(trade.openedAt || trade.date, endDate);
  return annualizedForPeriod(gainPct, totalPlannedDays);
}

function resolutionCell(trade) {
  const endDate = tradeEndDate(trade);
  const remaining = isClosedTrade(trade) ? null : daysUntil(endDate);
  const storedDays = Number(trade.daysToResolution);
  const days = Number.isFinite(remaining) && remaining > 0 ? remaining : storedDays;
  const inferred = inferredDateFromQuestion(trade);
  const inferredNote = inferred && trade.endDate && Date.parse(inferred) > Date.parse(trade.endDate) ? "from question" : "";
  return `
    ${escapeHtml(endDate ? formatDate(endDate) : "-")}
    <span>${isClosedTrade(trade) ? "resolved" : `${compactDays(days)} left${inferredNote ? `, ${inferredNote}` : ""}`}</span>
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
    current.liquidity != null ? detailNumber("Liquidity", Number(current.liquidity || 0), Number(original.liquidity || 0), money) : "",
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
  if (trade.mode === "LIVE_ORDER") return '<span class="order-chip">Limit order waiting</span>';
  if (trade.mode === "LIVE_RECONCILIATION") return '<span class="order-chip warning">Sync gap</span>';
  if (String(trade.status || "").toUpperCase() === "REDEEM_REQUIRED") return '<span class="order-chip warning">Redeem needed</span>';
  if (String(trade.status || "").toUpperCase() === "PENDING_RESOLUTION") return '<span class="order-chip warning">Pending resolution</span>';
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
  const showAiProbability = options.showAiProbability !== false;
  if (!trades.length) return `<div class="empty">${escapeHtml(emptyText)}</div>`;
  const rows = sortedTrades(trades, tableKey);
  return `
    <div class="ledger-scroll" tabindex="0" aria-label="Scrollable trade table">
    <table class="ledger-wide-table">
      <thead>
        <tr>
          ${tradeHeader(tableKey, showStatus ? "resolvedAt" : "openedAt", showStatus ? "Closed" : "Opened")}
          ${tradeHeader(tableKey, "market", "Market")}
          ${tradeHeader(tableKey, "currentPrice", showStatus ? "Entry / final" : "Entry / mark")}
          ${showAiProbability ? tradeHeader(tableKey, "aiProbability", "AI prob.") : ""}
          ${tradeHeader(tableKey, "resolution", "Resolution")}
          ${tradeHeader(tableKey, "potentialGain", "Win")}
          ${tradeHeader(tableKey, "riskReward", "R/R")}
          ${tradeHeader(tableKey, "potentialAnnualized", "Win p.a.")}
          ${showStatus ? tradeHeader(tableKey, "status", "Result") : ""}
          ${tradeHeader(tableKey, "pnl", "P/L")}
          ${tradeHeader(tableKey, "stake", "Stake")}
        </tr>
      </thead>
      <tbody>
        ${rows.map((trade) => `
          <tr>
            <td data-label="${showStatus ? "Closed" : "Opened"}">${escapeHtml(formatDate(showStatus ? (trade.resolvedAt || trade.closedTime || trade.lastCheckedAt || "") : (trade.openedAt || trade.date || "")))}</td>
            <td data-label="Market">
              ${tradeTypeBadge(trade)}
              ${marketAnchor(trade)}
            </td>
            <td data-label="${showStatus ? "Entry / final" : "Entry / mark"}">${tradePriceCell(trade, showStatus)}</td>
            ${showAiProbability ? `<td data-label="AI prob.">
              <strong>${probability(tradeAiProbability(trade))}</strong>
              <span class="analysis-popover">
                <button class="info-button" type="button" aria-label="Show original AI analysis">i</button>
                <span class="analysis-tooltip" role="tooltip">${escapeHtml(tradeAnalysisDetails(trade))}</span>
              </span>
            </td>` : ""}
            <td data-label="Resolution">${resolutionCell(trade)}</td>
            <td data-label="Win">${tradeWinCell(trade)}</td>
            <td data-label="R/R"><span class="${riskRewardClass(tradeRiskReward(trade))}">${riskReward(tradeRiskReward(trade))}</span></td>
            <td data-label="Win p.a.">${potentialAnnualizedCell(trade)}</td>
            ${showStatus ? `<td data-label="Result">
              ${escapeHtml(trade.status || "OPEN")}
            </td>` : ""}
            <td data-label="P/L" class="${pnlClass(tradePnlValue(trade))}">
              ${signedMoney(tradePnlValue(trade))}
            </td>
            <td data-label="Stake">${money(Number(trade.stakeUsdc || 0))}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
    </div>
  `;
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
  if (els.evaluationProbabilityFilterLabel) {
    els.evaluationProbabilityFilterLabel.textContent = `>= ${probability(value)}`;
  }
}

function eligibilityThresholdStorageKey(mode = state.mode) {
  const normalizedMode = normalizeMode(mode);
  const parts = [ELIGIBILITY_THRESHOLD_STORAGE_KEY, normalizedMode];
  if (normalizedMode === "live") {
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
  return numeric;
}

function riskAllocationInputValue(value) {
  const percentage = Number(value) * 100;
  if (!Number.isFinite(percentage)) return "";
  return percentage.toFixed(1).replace(/\.0$/, "");
}

function storedRiskAllocation() {
  try {
    const scopedKey = riskAllocationStorageKey();
    const scopedValue = normalizeRiskAllocation(Number(localStorage.getItem(scopedKey)));
    if (scopedValue != null) return scopedValue;
    const legacyValue = normalizeRiskAllocation(Number(localStorage.getItem(RISK_ALLOCATION_STORAGE_KEY)));
    return legacyValue;
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
  state.riskAllocation = portfolioConfigForMode(state.mode).maxOrderFraction ?? storedRiskAllocation() ?? DEFAULT_RISK_ALLOCATION;
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
  if (els.evaluationDaysFilterLabel) els.evaluationDaysFilterLabel.textContent = value == null ? "All" : `<= ${value} d`;
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
  if (els.evaluationNetYieldFilterLabel) els.evaluationNetYieldFilterLabel.textContent = `>= ${percent(value)}`;
}

function syncRiskAllocationControl(availableCapital = null, sourceLabel = "available capital", options = {}) {
  const value = currentRiskAllocation();
  const base = Number(options.baseCapital ?? availableCapital);
  const available = Number(availableCapital);
  const stake = Number.isFinite(base) ? base * value : null;
  if (els.riskAllocation) {
    els.riskAllocation.value = riskAllocationInputValue(value);
  }
  if (els.riskAllocationLabel) {
    els.riskAllocationLabel.textContent = probability(value);
  }
  if (els.riskAllocationValue) {
    els.riskAllocationValue.textContent = Number.isFinite(stake) ? money(stake) : "-";
  }
  if (els.riskAllocationNote) {
    els.riskAllocationNote.textContent = `maximum stake from ${sourceLabel}`;
  }
  syncCapitalStatus({
    availableCapital: Number.isFinite(available) ? available : null,
    baseCapital: Number.isFinite(base) ? base : null,
    stake,
    cadenceLabel: options.cadenceLabel || "next scheduled run",
  });
}

function defaultLimitOrdersForMode() {
  return isLiveMode();
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

function currentLimitOrders() {
  return typeof state.limitOrders === "boolean" ? state.limitOrders : defaultLimitOrdersForMode();
}

function refreshLimitOrders() {
  const key = limitOrdersStorageKey();
  if (state.limitOrdersKey === key && typeof state.limitOrders === "boolean") {
    syncLimitOrdersControl();
    return;
  }
  state.limitOrders = portfolioConfigForMode(state.mode).useLimitOrders ?? storedLimitOrders() ?? defaultLimitOrdersForMode();
  state.limitOrdersKey = key;
  syncLimitOrdersControl();
}

function syncLimitOrdersControl() {
  if (els.limitOrders) {
    els.limitOrders.checked = currentLimitOrders();
  }
}

function parameterCapitalContextForMode(mode = state.mode) {
  if (normalizeMode(mode) === "live") {
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
  const base = Number(context.baseCapital);
  const available = Number(context.availableCapital);
  const stake = Number.isFinite(base) ? base * normalized : null;
  const editingRiskAllocation = parameterDraftActive() && document.activeElement === els.riskAllocation;
  if (els.riskAllocation && !editingRiskAllocation) els.riskAllocation.value = riskAllocationInputValue(normalized);
  if (els.riskAllocationLabel) els.riskAllocationLabel.textContent = probability(normalized);
  if (els.riskAllocationValue) els.riskAllocationValue.textContent = Number.isFinite(stake) ? money(stake) : "-";
  if (els.riskAllocationNote) els.riskAllocationNote.textContent = `maximum stake from ${context.sourceLabel || "portfolio capital"}`;
  syncCapitalStatus({
    availableCapital: Number.isFinite(available) ? available : null,
    baseCapital: Number.isFinite(base) ? base : null,
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
  const isLive = normalizeMode(mode) === "live";
  const threshold = normalizeEligibilityThreshold(config.minProbability) ?? thresholdDefaultForMode(mode);
  const allocation = normalizeRiskAllocation(config.maxOrderFraction) ?? DEFAULT_RISK_ALLOCATION;
  const limitOrders = config.useLimitOrders ?? isLive;
  const capitalContext = options.capitalContext || parameterCapitalContextForMode(mode);
  if (els.eligibilityThreshold) els.eligibilityThreshold.value = String(Math.round(threshold * 100));
  if (els.eligibilityThresholdLabel) els.eligibilityThresholdLabel.textContent = probability(threshold);
  syncDraftRiskAllocationControl(allocation, capitalContext);
  if (els.limitOrders) els.limitOrders.checked = Boolean(limitOrders);
  if (els.polymarketProbability) els.polymarketProbability.checked = normalizeProbabilitySource(config.probabilitySource) === "polymarket";
  if (els.maxResolutionDays) els.maxResolutionDays.value = String(maxDays);
  if (els.maxResolutionDaysLabel) els.maxResolutionDaysLabel.textContent = `${maxDays} d`;
  if (els.selectionOrder) els.selectionOrder.value = order;
  if (els.selectionOrderLabel) els.selectionOrderLabel.textContent = selectionOrderLabel(order, config);
  if (els.minLiquidity) els.minLiquidity.value = liquidity == null ? "" : String(liquidity);
  if (els.minLiquidityLabel) els.minLiquidityLabel.textContent = liquidity == null ? "none" : money(liquidity);
  if (els.minNetYield) els.minNetYield.value = (minNetYield * 100).toFixed(1);
  if (els.minNetYieldLabel) els.minNetYieldLabel.textContent = percent(minNetYield);
  const trigger = normalizeExecutionTrigger(config.executionTrigger);
  if (els.executionTrigger) els.executionTrigger.value = trigger;
  if (els.executionTriggerLabel) els.executionTriggerLabel.textContent = executionTriggerLabel(trigger);
  if (els.mostProbableOutcome) {
    els.mostProbableOutcome.checked = Boolean(config.requireMostProbableOutcome);
    els.mostProbableOutcome.closest(".parameter-control")?.toggleAttribute("hidden", isLive);
  }
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

function closeParameterModal() {
  if (!els.parameterModal || els.parameterModal.hidden) return;
  els.parameterModal.hidden = true;
  document.body.classList.remove("modal-open");
  state.parameterDraft = null;
  state.parameterDraftMode = "";
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
  try {
    updatePortfolioConfigForMode(draftMode, draft);
    updateSystemConfig(draftSystem);
    const threshold = normalizeEligibilityThreshold(draft.minProbability);
    const allocation = normalizeRiskAllocation(draft.maxOrderFraction);
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
    setExecutionStatus("portfolio parameters saved");
    closeParameterModal();
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
  if (normalizeProbabilitySource(probabilitySource) !== "polymarket") return Number(item.annualizedReturn);
  const netYield = Number(item.netYield);
  const days = Number(item.daysToResolution);
  return Number.isFinite(netYield) && Number.isFinite(days)
    ? annualizeReturn(netYield, days)
    : Number(item.annualizedReturn);
}

function renderExecutionCandidatesNotUsedTable(candidates = [], probabilitySource = "ai") {
  if (!candidates.length) return "";
  const usesPolymarketProbability = normalizeProbabilitySource(probabilitySource) === "polymarket";
  const probabilityLabel = usesPolymarketProbability ? "Mkt prob." : "AI prob.";
  return `
    <div class="analysis-candidate-table-wrap" tabindex="0" aria-label="Rejected execution candidates table">
      <table class="analysis-candidate-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Market</th>
            <th>${probabilityLabel}</th>
            <th>Liquidity</th>
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
            const selectedProbability = Number(usesPolymarketProbability ? item.marketProbability : item.aiProbability);
            const liquidity = Number(item.liquidity);
            const netYield = Number(item.netYield);
            const potentialPa = executionCandidatePotentialPa(item, probabilitySource);
            return `
              <tr>
                <td data-label="#">${index + 1}</td>
                <td data-label="Market"><strong>${escapeHtml(outcome)}</strong><span>${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(question)}</a>` : escapeHtml(question)}</span></td>
                <td data-label="${probabilityLabel}">${Number.isFinite(selectedProbability) ? probability(selectedProbability) : "-"}</td>
                <td data-label="Liquidity">${Number.isFinite(liquidity) ? money(liquidity) : "-"}</td>
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
    window.history.replaceState({ page: "opportunities", opportunityView: "evaluated" }, "", routePath("opportunities", "evaluated"));
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

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
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
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const status = await fetchApiJson(`api.php?action=workflow-status&target=${encodeURIComponent(target)}&since=${encodeURIComponent(startedAt)}`);
    latest = (status.runs || []).find((run) => runMatchesStart(run, startedAt)) || null;
    const detail = latest?.htmlUrl ? `${workflowStatusText(latest)} / ${latest.htmlUrl}` : workflowStatusText(latest);
    steps = addExecutionStep(steps, attempt === 0 ? "Workflow status" : "Workflow update", detail, latest?.status === "completed" ? "done" : "active");
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

function liveExecutionSummary(execution) {
  if (!execution || typeof execution !== "object") return "Live execution state is not available yet.";
  const selected = execution.selected || {};
  const response = execution.response || {};
  const monitoring = execution.monitoring || {};
  const attempts = Array.isArray(execution.attempts) ? execution.attempts : [];
  const lastAttempt = attempts[attempts.length - 1] || {};
  const idleCashLimit = Number(monitoring.idleCashLimitUsdc);
  const idleCashHours = Number(monitoring.idleCashHours);
  const lines = [
    `Action: ${execution.action || "-"}`,
    execution.reason ? `Reason: ${execution.reason}` : "",
    Number.isFinite(idleCashLimit)
      ? `Idle cash: ${monitoring.idleCashOverdue ? "overdue" : "monitored"} / limit ${money(idleCashLimit)} / ${Number.isFinite(idleCashHours) ? `${idleCashHours.toFixed(1)}h` : "-"}`
      : "",
    selected.question ? `Selected: ${selected.question} / ${selected.outcome || "-"}` : "",
    selected.orderType ? `Order: ${selected.orderType} ${selected.orderSize || "-"} @ ${probability(Number(selected.orderPrice))}` : "",
    response.orderID ? `Order ID: ${response.orderID}` : "",
    response.status ? `Polymarket status: ${response.status}` : "",
    lastAttempt.rejectReason ? `Last reject: ${lastAttempt.rejectReason}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

async function waitForExecutionResult(target, startedAt, steps, options = {}) {
  const stateTarget = target === "live" ? "live-execution" : "paper";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const payload = await fetchApiJson(`api.php?action=state&target=${stateTarget}`);
    const paperDecision = target === "paper" ? paperExecutionDecision(payload, options.paperStrategyId) : null;
    const generated = Date.parse(target === "paper"
      ? (paperDecision?.runAt || payload.generatedAt || payload.lastDecision?.runAt || "")
      : (payload.generatedAt || payload.lastDecision?.runAt || ""));
    const start = Date.parse(startedAt || "");
    if (!Number.isFinite(start) || (Number.isFinite(generated) && generated >= start - 120000)) {
      const detail = target === "live"
        ? liveExecutionSummary(payload)
        : `Paper ${paperModeLabel(paperModeFromStrategyId(options.paperStrategyId))} action: ${paperDecision?.action || "-"} / ${paperDecision?.reason || "-"}`;
      steps = addExecutionStep(steps, "Execution result", detail, "done");
      return { payload, steps };
    }
    await sleep(3000);
  }
  steps = addExecutionStep(steps, "Execution result", "Result state has not updated yet; dashboard will keep refreshing.", "active");
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

function paperModeFromStrategyId(strategyId) {
  if (strategyId === "highReward") return "paper-highReward";
  if (strategyId === "moreProbable") return "paper-moreProbable";
  return "paper-conservative";
}

function portfolioForMode(mode = state.mode) {
  if (normalizeMode(mode) === "live") return state.liveState?.portfolio || {};
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
  if (normalizeMode(mode) === "live") {
    if (state.liveState) renderLiveState(state.liveState);
    return;
  }
  if (state.botState) renderBotState(state.botState);
}

function botStateIsFull(botState) {
  const detailsMode = String(botState?.evaluationDetailsMode || "");
  return Boolean(botState) && detailsMode !== "compact" && detailsMode !== "dashboard";
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
    if (normalizeMode(state.mode) === "live") {
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
  return Array.isArray(state.botState?.marketObservations) ? state.botState.marketObservations : [];
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
  state.scrapedMarketObservations = scrapedState.marketObservations;
  state.scrapedMarketScan = scrapedState.marketScan && typeof scrapedState.marketScan === "object"
    ? scrapedState.marketScan
    : {};
  state.scrapedMarketScanHistory = Array.isArray(scrapedState.marketScanHistory)
    ? scrapedState.marketScanHistory
    : [];
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
    const botState = await fetchJson("data/paper-state.json", { summary: "dashboard" });
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
  const cacheSummary = options.summary || "full";
  const url = stateTarget
    ? appPath(`api.php?action=state&target=${stateTarget}${summary}&t=${Date.now()}`)
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
      await requestLiveAccountSync({ quiet: true, minSeconds: LIVE_SYNC_REQUEST_MS / 1000 });
      const liveState = await waitForFreshLiveSnapshot(previousGeneratedAt);
      if (liveState) renderLiveState(liveState);
      setExecutionStatus("opened-trade values recalculated");
    } else {
      const botState = await fetchJson("data/paper-state.json");
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

function paperThresholdPayload() {
  const conservative = portfolioConfigForMode("paper-conservative");
  const highReward = portfolioConfigForMode("paper-highReward");
  const moreProbable = portfolioConfigForMode("paper-moreProbable");
  return {
    paper_conservative_min_probability: thresholdForMode("paper-conservative"),
    paper_high_reward_min_probability: thresholdForMode("paper-highReward"),
    paper_more_probable_min_probability: thresholdForMode("paper-moreProbable"),
    paper_conservative_max_order_fraction: conservative.maxOrderFraction,
    paper_high_reward_max_order_fraction: highReward.maxOrderFraction,
    paper_more_probable_max_order_fraction: moreProbable.maxOrderFraction,
    paper_conservative_max_resolution_days: conservative.maxResolutionDays,
    paper_high_reward_max_resolution_days: highReward.maxResolutionDays,
    paper_more_probable_max_resolution_days: moreProbable.maxResolutionDays,
    paper_conservative_selection_order: conservative.selectionOrder,
    paper_high_reward_selection_order: highReward.selectionOrder,
    paper_more_probable_selection_order: moreProbable.selectionOrder,
    paper_conservative_min_liquidity_usdc: conservative.minLiquidityUsdc,
    paper_high_reward_min_liquidity_usdc: highReward.minLiquidityUsdc,
    paper_more_probable_min_liquidity_usdc: moreProbable.minLiquidityUsdc,
    paper_conservative_require_most_probable: conservative.requireMostProbableOutcome,
    paper_high_reward_require_most_probable: highReward.requireMostProbableOutcome,
    paper_more_probable_require_most_probable: moreProbable.requireMostProbableOutcome,
  };
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
    max_order_fraction: config.maxOrderFraction,
    use_limit_orders: config.useLimitOrders,
    live_run_source: "MANUAL",
    live_execution_candidate_token_ids: shortlistTokenIds.join(","),
    live_execution_probability_source: normalizeProbabilitySource(config.probabilitySource),
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
  const payload = liveWorkflowPayload();
  if (!payload.live_execution_candidate_token_ids) {
    throw new Error("No current live execution candidates are available. Refresh the shortlist before starting a live order run.");
  }
  return payload;
}

async function triggerOneTimeExecution(target) {
  target = target === "live" ? "live" : (isPaperExecutionTarget(target) ? target : "paper");
  const live = target === "live";
  const paperStrategyId = live ? "" : paperStrategyIdFromMode(target === "paper" ? state.mode : target);
  const startedAt = new Date().toISOString();
  openExecutionModal(target);
  let steps = [
    {
      title: live ? "Live execution requested" : "Paper execution requested",
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
    steps = addExecutionStep(steps, "Live execution confirmed", "The live execution gate is active on this browser. Dispatching GitHub workflow with the current portfolio parameters.", "done");
  }

  state.executionBusy = target;
  syncExecutionButtons();
  setExecutionStatus(live ? "starting live workflow" : "starting paper workflow");

  try {
    await savePortfolioConfigNow();
    const workflowPayload = live ? await freshLiveWorkflowPayload() : null;
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
    setExecutionStatus(`${target} workflow started`);
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
      setExecutionStatus(`${target} workflow ${workflow.run.conclusion}`, "error");
    }
    steps = addExecutionStep(steps, "Dashboard refreshed", "Open positions and limit orders are shown in the tables below.", "done");
    if (!workflow.run?.conclusion || workflow.run.conclusion === "success") {
      setExecutionStatus(`${target} workflow completed`);
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
    const refreshed = await fetchJson("data/paper-state.json");
    state.botStateFull = true;
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

async function waitForScrapedScanWorkflow(startedAt) {
  let latest = null;
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const status = await fetchApiJson(`api.php?action=workflow-status&target=paper-scan&since=${encodeURIComponent(startedAt)}`);
    latest = (status.runs || []).find((run) => runMatchesStart(run, startedAt)) || null;
    if (latest?.status === "completed") return latest;
    state.scrapedScanStatus = latest ? `Scan ${workflowStatusText(latest)}` : "Scan queued...";
    renderScrapedScanControls();
    await sleep(3000);
  }
  return latest;
}

function scrapedScanWasPublishedAfter(scrapedState, startedAt) {
  const start = Date.parse(startedAt || "");
  if (!Number.isFinite(start)) return true;
  const scanTimes = [
    scrapedState?.marketScan?.lastScanAt,
    ...(Array.isArray(scrapedState?.marketScanHistory)
      ? scrapedState.marketScanHistory.slice(0, 3).map((item) => item?.runAt)
      : []),
  ];
  return scanTimes.some((value) => {
    const timestamp = Date.parse(value || "");
    return Number.isFinite(timestamp) && timestamp >= start - 10000;
  });
}

async function waitForScrapedScanPublication(startedAt) {
  let lastError = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const scrapedState = await fetchJson("data/paper-state.json", { summary: "scraped" });
      if (scrapedScanWasPublishedAfter(scrapedState, startedAt)) return scrapedState;
    } catch (error) {
      lastError = error;
    }
    state.scrapedScanStatus = "Publishing scan results...";
    renderScrapedScanControls();
    await sleep(2000);
  }
  if (lastError) throw lastError;
  throw new Error("The scan workflow finished, but its new scraped data has not been published yet.");
}

async function triggerOneTimeMarketScan() {
  if (state.scrapedScanBusy) return;
  state.scrapedScanBusy = true;
  state.scrapedScanStatus = "Starting scan...";
  renderScrapedScanControls();
  const startedAt = new Date().toISOString();
  try {
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
    state.scrapedScanStatus = "Scan queued...";
    renderScrapedScanControls();
    const workflow = await waitForScrapedScanWorkflow(startedAt);
    if (!workflow || workflow.status !== "completed") {
      throw new Error("Scan is still queued in the background. Try again in a moment.");
    }
    if (workflow.conclusion !== "success") {
      throw new Error(`Scan workflow finished with ${workflow.conclusion || "an unknown error"}.`);
    }
    state.scrapedScanStatus = "Publishing scan results...";
    renderScrapedScanControls();
    const refreshed = await waitForScrapedScanPublication(startedAt);
    if (!storeScrapedMarketState(refreshed, "scraped")) {
      throw new Error("The refreshed scan response did not include scraped opportunities.");
    }
    state.scrapedScanStatus = `Updated ${formatDate(refreshed.marketScan?.lastScanAt || "")}`;
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
    const [liveResult, botResult, executionResult] = await Promise.allSettled([
      fetchJson("data/live-state.json"),
      fetchJson("data/paper-state.json", { summary: "dashboard" }),
      fetchJson("data/live-execution-state.json"),
    ]);
    if (dashboardLoadIsStale(options) || !isLiveMode()) return;
    if (liveResult.status === "rejected") throw liveResult.reason;
    if (botResult.status === "fulfilled") {
      state.botState = botStateWithPreservedEvaluations(botResult.value);
      state.botStateFull = botStateIsFull(state.botState);
    }
    state.liveExecutionState = executionResult.status === "fulfilled" ? executionResult.value : state.liveExecutionState;
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
    if (els.portfolioRr) els.portfolioRr.textContent = "-";
    if (els.portfolioRrNote) els.portfolioRrNote.textContent = "live data not available";
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
  return requestedMode === "live"
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
  return portfolios.find((item) => item.id === strategyId) || portfolios[0] || {};
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
  const allocation = normalizeRiskAllocation(config.maxOrderFraction) ?? DEFAULT_RISK_ALLOCATION;
  const fallbackPortfolio = normalizedMode === "live"
    ? state.liveState?.portfolio
    : state.botState?.paperPortfolios?.[paperStrategyIdFromMode(normalizedMode)]?.portfolio;
  const equity = Number(portfolio?.equityUsdc ?? fallbackPortfolio?.equityUsdc);
  const equityLabel = normalizedMode === "live" ? "live equity" : "portfolio equity";
  const nominalStake = Number.isFinite(equity) ? Math.max(0, equity) * allocation : null;
  return `${probability(allocation)} of ${equityLabel}${Number.isFinite(nominalStake) ? ` (${money(nominalStake)})` : ""}`;
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
    ["Execution trigger", executionTriggerLabel(config.executionTrigger)],
  ];
  if (Number.isFinite(minLiquidityUsdc)) rows.push(["Liquidity filter", `>= ${money(minLiquidityUsdc)}`]);
  rows.push(["Minimum net profit", `>= ${percent(minNetYield)} after fees`]);
  if (config.requireMostProbableOutcome) rows.push(["Market type filter", "Only multichoice events"]);
  return rows;
}

function livePortfolioRuleRows() {
  const config = portfolioConfigForMode("live");
  const maxResolutionDays = resolutionDaysForMode("live");
  const minLiquidityUsdc = normalizeOptionalMoney(config.minLiquidityUsdc);
  const minNetYield = normalizeMinimumNetYield(config.minNetYield);
  const returnMetric = portfolioReturnMetricLabel(config);
  const priority = config.selectionOrder === "highest_reward_risk_first"
    ? `Highest reward/risk, then shorter resolution and ${returnMetric}`
    : `Highest ${returnMetric}, then shorter resolution and net gain`;
  return [
    ["Probability threshold", `${probabilitySourceLabel(config.probabilitySource)} >= ${percent(currentEligibilityThreshold())}`],
    ["Stake sizing", stakeSizingRuleValue("live", state.liveState?.portfolio)],
    ["Resolution filter", `Max ${maxResolutionDays} days`],
    ["Trade priority", priority],
    ["Execution trigger", executionTriggerLabel(config.executionTrigger)],
    ["Liquidity filter", minLiquidityUsdc == null ? "none" : `>= ${money(minLiquidityUsdc)}`],
    ["Minimum net profit", `>= ${percent(minNetYield)} after fees`],
    ["Order mode", currentLimitOrders() ? "Limit orders" : "Market orders"],
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
  if (item.marketType) return item.marketType;
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
  const liquidity = Number(item.liquidity || 0);
  const minLiquidity = normalizeOptionalMoney(config.minLiquidityUsdc);
  const minNetYield = normalizeMinimumNetYield(config.minNetYield);
  const threshold = normalizeEligibilityThreshold(config.minProbability) ?? thresholdDefaultForMode(normalizedMode);
  const annualizedReturn = portfolioAnnualizedReturn(item, config);
  const returnMetric = portfolioReturnMetricLabel(config);
  const aiPending = item.selectionStatus === "AI_PENDING" || item.aiAnalysis?.aiModelStatus === "QUOTA_LIMITED";
  const executionCheck = item.executionRevalidation && typeof item.executionRevalidation === "object"
    ? item.executionRevalidation
    : null;
  const executionCheckIsCurrent = executionCheck
    && (Date.parse(executionCheck.checkedAt || "") || 0) >= (Date.parse(item.evaluatedAt || "") || 0);

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
  } else if (days > maxDays) {
    reasons.push(`resolution ${days.toFixed(2)} days exceeds max ${maxDays}`);
  }
  if (minLiquidity != null && liquidity < minLiquidity) {
    reasons.push(`liquidity ${money(liquidity)} below ${money(minLiquidity)}`);
  }
  if (config.requireMostProbableOutcome && candidateMarketType(item) !== "multi") {
    reasons.push(`market type ${candidateMarketType(item)} is not multichoice`);
  }
  return reasons;
}

function activeExposureRowsForMode(mode = state.mode) {
  if (normalizeMode(mode) === "live") {
    return [
      ...(Array.isArray(state.liveState?.positions) ? state.liveState.positions : []),
      ...(Array.isArray(state.liveState?.openOrders) ? state.liveState.openOrders : []),
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
  const activeRows = activeExposureRowsForMode(mode);
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
  const live = normalizeMode(mode) === "live";
  const config = portfolioConfigForMode(mode);
  const usesPolymarketPotential = normalizeProbabilitySource(config.probabilitySource) === "polymarket";
  const useLiveMarketColumnOrder = live && usesPolymarketPotential;
  const probabilityLabel = usesPolymarketPotential ? "Mkt prob." : "AI prob.";
  const returnMetric = portfolioReturnMetricLabel(config);
  return `
    <div class="ledger-scroll" tabindex="0" aria-label="Scrollable execution candidates table">
    <table class="ledger-wide-table">
      <thead>
        <tr>
          <th>#</th>
          <th>Precheck</th>
          <th>Market</th>
          ${useLiveMarketColumnOrder ? `
            <th>Days left</th>
            <th>${returnMetric}</th>
            <th>Win</th>
            <th>Net yield %</th>
            <th>Liquidity</th>
            <th>R/R</th>
            <th>${probabilityLabel}</th>
            <th>End date</th>
          ` : `
            <th>End date</th>
            <th>Days left</th>
            <th>${probabilityLabel}</th>
            ${usesPolymarketPotential ? "" : "<th>Mkt entry</th>"}
            <th>${returnMetric}</th>
            ${usesPolymarketPotential ? "" : "<th>EV</th>"}
            <th>Win</th>
            <th>Net yield %</th>
            <th>R/R</th>
            <th>Liquidity</th>
          `}
          <th>Analysis</th>
        </tr>
      </thead>
      <tbody>
        ${visibleRows.slice(0, 80).map((item, index) => {
          const excluded = Boolean(item.manuallyExcluded);
          const riskBlockedRow = Boolean(item.portfolioRiskBlockReason);
          const retryableExecution = item.executionRevalidation?.retryable === true;
          const status = excluded
            ? "excluded manually for this portfolio"
            : (riskBlockedRow
            ? "excluded by diversification rules"
            : (retryableExecution
              ? (item.executionRevalidation.retryClass === "CAPITAL" ? "waiting for free capital; retry on the next execution" : "waiting for diversification capacity; retry on the next execution")
              : (!live
              ? "ready for next paper execution"
              : (usesPolymarketPotential
                ? "will verify live quote, fees and ranking"
                : "will verify live quote against stored AI assessment"))));
          const precheck = excluded ? "EXCLUDED" : (riskBlockedRow ? "RISK-BLOCKED" : (retryableExecution ? "WAITING" : "READY"));
          const selectedProbability = portfolioProbability(item, config);
          const selectedAnnualizedReturn = portfolioAnnualizedReturn(item, config);
          const selectedExpectedValue = portfolioExpectedValue(item, config);
          return `
            <tr>
              <td data-label="#">${index + 1}</td>
              <td data-label="Precheck" class="${excluded ? "negative" : (riskBlockedRow || retryableExecution ? "warning" : "positive")}">
                <strong>${precheck}</strong>
                <span>${escapeHtml(status)}</span>
                <label class="candidate-exclusion-control" title="Exclude this candidate from this portfolio's future executions">
                  <input type="checkbox" data-portfolio-candidate-exclude data-portfolio-mode="${escapeHtml(mode)}" data-candidate-token-id="${escapeHtml(String(item.tokenId || item.clobTokenId || item.assetId || ""))}" ${excluded ? "checked" : ""}>
                  <span>Exclude</span>
                </label>
              </td>
              <td data-label="Market">${marketAnchor(item)}</td>
              ${useLiveMarketColumnOrder ? `
                <td data-label="Days left">${evaluationDaysLeftCell(item)}</td>
                <td data-label="${returnMetric}"><span class="${pnlClass(selectedAnnualizedReturn)}">${signedPercent(selectedAnnualizedReturn)}</span></td>
                <td data-label="Win">${gainCell(item)}</td>
                <td data-label="Net yield %">${netYieldCell(item)}</td>
                <td data-label="Liquidity">${money(Number(item.liquidity || 0))}</td>
                <td data-label="R/R">${evaluationRiskRewardCell(item)}</td>
                <td data-label="${probabilityLabel}">${probability(selectedProbability)}</td>
                <td data-label="End date">${evaluationEndDateCell(item)}</td>
              ` : `
                <td data-label="End date">${evaluationEndDateCell(item)}</td>
                <td data-label="Days left">${evaluationDaysLeftCell(item)}</td>
                <td data-label="${probabilityLabel}">${probability(selectedProbability)}</td>
                ${usesPolymarketPotential ? "" : `<td data-label="Mkt entry">${probability(evaluationEntryPrice(item))}</td>`}
                <td data-label="${returnMetric}"><span class="${pnlClass(selectedAnnualizedReturn)}">${signedPercent(selectedAnnualizedReturn)}</span></td>
                ${usesPolymarketPotential ? "" : `<td data-label="EV">${signedMoney(selectedExpectedValue, 4)}</td>`}
                <td data-label="Win">${gainCell(item)}</td>
                <td data-label="Net yield %">${netYieldCell(item)}</td>
                <td data-label="R/R">${evaluationRiskRewardCell(item)}</td>
                <td data-label="Liquidity">${money(Number(item.liquidity || 0))}</td>
              `}
              <td data-label="Analysis">${analysisBadge(item)}</td>
            </tr>
          `;
        }).join("")}
      </tbody>
    </table>
    </div>
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
  if (els.evaluationLiquidityFilterLabel) els.evaluationLiquidityFilterLabel.textContent = value > 0 ? `>= ${money(value)}` : "All";
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
  const label = normalizeMode(mode) === "live" ? "Live" : `Paper - ${paperModeLabel(mode)}`;
  if (els.portfolioCandidatesTitle) els.portfolioCandidatesTitle.textContent = `${label} execution candidates`;
  if (els.portfolioCandidatesSummary) {
    const blocked = diagnostics.riskBlocked.length;
    const excluded = diagnostics.manuallyExcluded.length;
    els.portfolioCandidatesSummary.textContent = `${rows.length} ready${blocked ? ` / ${blocked} risk-blocked` : ""}${excluded ? ` / ${excluded} excluded` : ""}`;
  }
  els.portfolioCandidates.innerHTML = renderPortfolioCandidateRows(rows, mode, diagnostics);
}

function renderPortfolioRulesCard(title, rows) {
  return `
    <div class="portfolio-rules-card">
      <div class="portfolio-rules-head">
        <strong>${escapeHtml(title)}</strong>
        <button class="portfolio-rules-edit" type="button" data-portfolio-parameters-edit aria-label="Edit portfolio parameters" title="Edit portfolio parameters">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M12 20h9"></path>
            <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z"></path>
          </svg>
        </button>
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
  const portfolioRiskReward = averageRiskReward(trades, tradeRiskReward);
  const periodDays = portfolioPeriodDays(botState, trades);
  const annualized = annualizedPortfolioReturn(portfolio, periodDays);
  const totalPnl = Number(portfolio.totalPnlUsdc || 0);
  const totalPnlPct = Number(portfolio.totalPnlPct || 0);
  const realizedPnl = Number(portfolio.realizedPnlUsdc || 0);
  const realizedPnlPct = Number(portfolio.realizedPnlPct || 0);
  const openPnl = Number(portfolio.openPnlUsdc || 0);
  const openPnlPct = Number(portfolio.openPnlPct || 0);
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
  els.portfolioTotalPl.textContent = signedMoney(totalPnl);
  els.portfolioTotalPl.className = pnlClass(totalPnl);
  els.portfolioTotalPlPct.textContent = signedPercent(totalPnlPct);
  if (els.portfolioAnnualized) {
    els.portfolioAnnualized.textContent = signedPercent(annualized);
    els.portfolioAnnualized.className = pnlClass(annualized);
  }
  if (els.portfolioPeriod) {
    els.portfolioPeriod.textContent = periodDays == null ? "No trades yet" : `since first trade, ${periodDays.toFixed(1)} days`;
  }
  els.portfolioRealized.textContent = signedMoney(realizedPnl);
  els.portfolioRealized.className = pnlClass(realizedPnl);
  els.portfolioRealizedPct.textContent = signedPercent(realizedPnlPct);
  renderClosedAccuracy(closedTrades);
  els.portfolioOpenPl.textContent = signedMoney(openPnl);
  els.portfolioOpenPl.className = pnlClass(openPnl);
  els.portfolioOpenPlPct.textContent = signedPercent(openPnlPct);
  els.portfolioRisk.textContent = money(Number(portfolio.openRiskUsdc || 0));
  els.portfolioFree.textContent = `${money(freeCapital)} free`;
  if (els.portfolioRr) {
    els.portfolioRr.textContent = riskReward(portfolioRiskReward);
    els.portfolioRr.className = riskRewardClass(portfolioRiskReward);
  }
  if (els.portfolioRrNote) {
    els.portfolioRrNote.textContent = trades.length ? `avg all, ${trades.length} trades` : "no trades";
  }

  if (els.portfolioRules) {
    els.portfolioRules.innerHTML = `
    <div class="bot-summary">
      ${renderPortfolioRulesCard(portfolioState.label || "Paper portfolio", portfolioRuleRows({ ...portfolioState, ...portfolio }))}
    </div>
  `;
  }
  const paperWarning = stateWarningHtml("paper", "paper portfolio");
  els.botStatus.innerHTML = paperWarning;
  els.botStatus.hidden = !paperWarning;

  els.botTrades.innerHTML = renderTradeRows(openTrades.slice(0, 12), "Zatim zadne otevrene autonomni paper obchody.", {
    tableKey: "open",
    showStatus: false,
    showAiProbability: false,
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

function livePositions(liveState) {
  return Array.isArray(liveState?.positions) ? liveState.positions.filter((trade) => !isClosedTrade(trade)) : [];
}

function liveOpenOrders(liveState) {
  return Array.isArray(liveState?.openOrders) ? liveState.openOrders : [];
}

function liveActivity(liveState) {
  return Array.isArray(liveState?.activity) ? liveState.activity : [];
}

function liveClosedTrades(liveState) {
  if (Array.isArray(liveState?.closedTrades)) return liveState.closedTrades;
  if (Array.isArray(liveState?.trades?.closed)) return liveState.trades.closed;
  return [];
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
    endDate: source?.endDate || order.endDate || order.resolutionDate || null,
    daysToResolution: source?.daysToResolution ?? order.daysToResolution ?? null,
    entryPrice: price,
    currentPrice: Number(source?.marketPrice ?? source?.marketPriceProbability ?? order.currentPrice ?? price),
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
  const openedRows = [
    ...positions,
    ...openOrderRows,
  ];
  const activity = liveActivity(liveState);
  const closedTrades = liveClosedTrades(liveState).map(decorateLiveTradeForTable);
  const portfolioRiskReward = averageRiskReward([...openedRows, ...closedTrades], tradeRiskReward);
  const sync = liveState.sync || {};
  const reconciliation = liveState.reconciliation || {};
  const reconciliationGaps = Number(reconciliation.orphanedCount || 0);
  const sources = Array.isArray(sync.sources) ? sync.sources : [];
  const marketValue = Number(portfolio.marketValueUsdc);
  const cash = Number(portfolio.cashUsdc);
  const openOrderRisk = openOrderRows.reduce((sum, order) => sum + Number(order.totalCostUsdc || order.stakeUsdc || 0), 0);
  const freeCash = Number.isFinite(cash) ? Math.max(0, cash - openOrderRisk) : null;
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
  const realizedPnl = hasOriginalValue ? totalPnl - openPnl : rawRealizedPnl;
  const realizedPnlPct = hasOriginalValue ? realizedPnl / deposited : rawRealizedPnlPct;
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
  els.portfolioEquity.className = pnlClass(totalPnl);
  els.portfolioLastRun.innerHTML = `
    <small class="metric-note">${escapeHtml(depositedLine)}</small>
    ${redeemLine ? `<small class="metric-note">${escapeHtml(redeemLine)}</small>` : ""}
  `;
  els.portfolioTotalPl.textContent = signedMoney(totalPnl);
  els.portfolioTotalPl.className = pnlClass(totalPnl);
  els.portfolioTotalPlPct.textContent = signedPercent(totalPnlPct);
  if (els.portfolioAnnualized) {
    els.portfolioAnnualized.textContent = "-";
    els.portfolioAnnualized.className = "";
  }
  if (els.portfolioPeriod) els.portfolioPeriod.textContent = "P/L % vs Original value";
  els.portfolioRealized.textContent = signedMoney(realizedPnl);
  els.portfolioRealized.className = pnlClass(realizedPnl);
  els.portfolioRealizedPct.textContent = signedPercent(realizedPnlPct);
  renderClosedAccuracy(closedTrades);
  els.portfolioOpenPl.textContent = signedMoney(openPnl);
  els.portfolioOpenPl.className = pnlClass(openPnl);
  els.portfolioOpenPlPct.textContent = signedPercent(openPnlPct);
  els.portfolioRisk.textContent = money(Number(portfolio.openRiskUsdc || 0) + openOrderRisk);
  els.portfolioFree.textContent = freeCash == null ? "cash not available" : `${money(freeCash)} free cash`;
  if (els.portfolioRr) {
    els.portfolioRr.textContent = riskReward(portfolioRiskReward);
    els.portfolioRr.className = riskRewardClass(portfolioRiskReward);
  }
  if (els.portfolioRrNote) {
    const portfolioRows = openedRows.length + closedTrades.length;
    els.portfolioRrNote.textContent = portfolioRows ? `avg all, ${portfolioRows} rows` : "no rows";
  }

  if (els.accountSummary) {
    els.accountSummary.hidden = true;
    els.accountSummary.innerHTML = "";
  }
  renderSystemStatus(liveState);
  if (els.portfolioRules) {
    els.portfolioRules.innerHTML = `
    <div class="bot-summary">
      ${renderPortfolioRulesCard("Live portfolio", livePortfolioRuleRows())}
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
    showAiProbability: false,
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

function scrapedObservationStatus(item) {
  const status = String(item?.status || item?.selectionStatus || "").trim().toUpperCase();
  if (status === "ERROR") return "ERROR";
  if (["RESOLVED", "CLOSED", "FINALIZED", "SETTLED"].includes(status) || evaluationEnded(item)) return "RESOLVED";
  return "SCRAPED";
}

function scrapedObservationFilterStatus(item) {
  const status = scrapedObservationStatus(item);
  return status === "SCRAPED" ? "EVALUATED" : status;
}

function scrapedObservationStatusClass(item) {
  const status = scrapedObservationStatus(item);
  if (status === "ERROR") return "negative";
  return status === "SCRAPED" ? "positive" : "muted";
}

function scrapedSortValue(item, key) {
  if (key === "observedAt") return Date.parse(item.observedAt || item.marketDataUpdatedAt || "") || 0;
  if (key === "status") return scrapedObservationStatus(item);
  if (key === "market") return `${item.outcome || ""} ${item.question || ""}`.toLowerCase();
  if (key === "endDate") return Date.parse(item.endDate || "") || 0;
  if (key === "daysLeft") return evaluationDaysLeft(item);
  if (key === "marketProbability") return Number(item.marketProbability);
  if (key === "netGainIfWinUsdc") return gainIfWin(item);
  if (key === "netYield") return netYield(item);
  if (key === "potentialAnnualizedReturn") return potentialAnnualizedReturn(item);
  if (key === "riskReward") return evaluationRiskReward(item);
  if (key === "marketAnnualizedReturn") return marketAnnualizedExpectedReturn(item);
  if (key === "marketExpectedValueUsdc") return marketExpectedValueFromQuote(item);
  if (key === "liquidity") return Number(item.liquidity);
  if (key === "volume24hr") return Number(item.volume24hr);
  if (key === "outcomeCount") return Number(item.outcomeCount);
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

function binaryMarketProbabilityCell(item) {
  const hasYes = item?.binaryYesMarketProbability != null && item.binaryYesMarketProbability !== "";
  const hasNo = item?.binaryNoMarketProbability != null && item.binaryNoMarketProbability !== "";
  if (!hasYes && !hasNo) return "-";
  const yes = Number(item.binaryYesMarketProbability);
  const no = Number(item.binaryNoMarketProbability);
  if (!Number.isFinite(yes) || !Number.isFinite(no)) return "-";
  return `<span>Yes ${probability(yes)} / No ${probability(no)}</span>`;
}

function renderScrapedOpportunities() {
  const observations = scrapedMarketObservations();
  const probabilityFilter = currentEvaluationProbabilityFilter();
  const daysFilter = currentEvaluationDaysFilter();
  const minNetYield = currentEvaluationNetYieldFilter();
  const minLiquidity = currentEvaluationLiquidityFilter();
  const statusFiltered = state.evaluationStatus === "ALL"
    ? observations
    : observations.filter((item) => scrapedObservationFilterStatus(item) === state.evaluationStatus);
  const filtered = statusFiltered.filter((item) => {
    const marketProbability = Number(item.marketProbability);
    if (probabilityFilter > 0 && (!Number.isFinite(marketProbability) || marketProbability < probabilityFilter)) return false;
    const days = evaluationDaysLeft(item);
    if (!Number.isFinite(days)) return false;
    if (daysFilter != null && days > daysFilter) return false;
    const yieldValue = netYield(item);
    if (minNetYield > 0 && (!Number.isFinite(yieldValue) || yieldValue < minNetYield)) return false;
    const liquidity = Number(item.liquidity);
    return minLiquidity <= 0 || (Number.isFinite(liquidity) && liquidity >= minLiquidity);
  });
  const visible = sortedScrapedObservations(filtered).slice(0, 250);
  const scan = scrapedMarketScan();
  const scrapedCount = observations.filter((item) => scrapedObservationFilterStatus(item) === "EVALUATED").length;
  const errorCount = observations.filter((item) => scrapedObservationFilterStatus(item) === "ERROR").length;

  if (els.evaluationFilterCount) {
    const filters = [
      probabilityFilter > 0 ? `market >= ${(probabilityFilter * 100).toFixed(0)}%` : "",
      daysFilter != null ? `days <= ${daysFilter}` : "",
      minNetYield > 0 ? `net yield >= ${(minNetYield * 100).toFixed(1)}%` : "",
      minLiquidity > 0 ? `liquidity >= ${money(minLiquidity)}` : "",
    ].filter(Boolean);
    els.evaluationFilterCount.textContent = filters.length
      ? `${formatInteger(filtered.length) || filtered.length} scraped / ${filters.join(" / ")}`
      : `${formatInteger(filtered.length) || filtered.length} scraped markets`;
  }
  if (els.evaluationSummary) {
    const lastScan = scan.lastScanAt ? formatDate(scan.lastScanAt) : "pending";
    els.evaluationSummary.textContent = [
      `${formatInteger(filtered.length) || filtered.length} shown`,
      `${formatInteger(observations.length) || observations.length} retained`,
      `${formatInteger(scrapedCount) || scrapedCount} scraped`,
      errorCount ? `${formatInteger(errorCount) || errorCount} error` : null,
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

  if (!observations.length) {
    els.botEvaluations.innerHTML = '<div class="empty">No scraped Polymarket opportunities are available yet. The next market scan will add them here.</div>';
    return;
  }
  if (!visible.length) {
    els.botEvaluations.innerHTML = '<div class="empty">No scraped opportunities match the selected probability, days-left, or net-yield filters.</div>';
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
            ${scrapedSortableHeader("riskReward", "R/R")}
            ${scrapedSortableHeader("liquidity", "Liquidity")}
            ${scrapedSortableHeader("observedAt", "Scraped")}
            ${scrapedSortableHeader("status", "Status")}
            ${scrapedSortableHeader("endDate", "End date")}
            <th>Yes / No</th>
            ${scrapedSortableHeader("volume24hr", "24h volume")}
            ${scrapedSortableHeader("outcomeCount", "Outcomes")}
            <th><span class="table-action-heading" title="Refresh this one scraped market from Polymarket">Update</span></th>
          </tr>
        </thead>
        <tbody>
          ${visible.map((item) => `
            <tr>
              <td data-label="Market">${marketAnchor(item)}</td>
              <td data-label="Days left">${evaluationDaysLeftCell(item)}</td>
              <td data-label="Mkt prob.">${probability(Number(item.marketProbability))}</td>
              <td data-label="Win @ $5">${gainCell(item)}</td>
              <td data-label="Net yield %">${netYieldCell(item)}</td>
              <td data-label="Potential p.a."><span class="${pnlClass(potentialAnnualizedReturn(item))}">${signedPercent(potentialAnnualizedReturn(item))}</span></td>
              <td data-label="R/R">${evaluationRiskRewardCell(item)}</td>
              <td data-label="Liquidity">${money(Number(item.liquidity || 0))}</td>
              <td data-label="Scraped">${escapeHtml(formatDate(item.observedAt || item.marketDataUpdatedAt || ""))}</td>
              <td data-label="Status" class="${scrapedObservationStatusClass(item)}"><strong>${scrapedObservationStatus(item)}</strong></td>
              <td data-label="End date">${evaluationEndDateCell(item)}</td>
              <td data-label="Yes / No">${binaryMarketProbabilityCell(item)}</td>
              <td data-label="24h volume">${money(Number(item.volume24hr || 0))}</td>
              <td data-label="Outcomes">${formatInteger(Number(item.outcomeCount || 0)) || "-"}</td>
              <td data-label="Update">${scrapedRefreshControl(item)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
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
  const counts = { all: 0, scraped: 0, resolved: 0, error: 0 };
  for (const item of scrapedMarketObservations()) {
    counts.all += 1;
    const status = scrapedObservationStatus(item);
    if (status === "SCRAPED") counts.scraped += 1;
    else if (status === "RESOLVED") counts.resolved += 1;
    else if (status === "ERROR") counts.error += 1;
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

function scanLogInterval(current, previous) {
  const currentTime = Date.parse(current?.runAt || "");
  const previousTime = Date.parse(previous?.runAt || "");
  if (!Number.isFinite(currentTime) || !Number.isFinite(previousTime) || currentTime <= previousTime) return "-";
  const minutes = Math.round((currentTime - previousTime) / 60000);
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  if (hours < 48) return `${hours.toFixed(hours >= 10 ? 0 : 1)} h`;
  return `${(hours / 24).toFixed(1)} d`;
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
            <thead><tr><th>Market</th><th>Outcome</th><th>Probability</th><th>Categories</th><th>Result</th><th>Reason</th></tr></thead>
            <tbody>${markets.length ? markets.map((market) => {
              const href = /^https:\/\//i.test(String(market?.url || "")) ? String(market.url) : "";
              const action = String(market?.action || "NOT_SAVED").toUpperCase();
              return `<tr>
                <td>${href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer"><strong>${escapeHtml(market?.question || "Untitled Polymarket market")}</strong></a>` : `<strong>${escapeHtml(market?.question || "Untitled Polymarket market")}</strong>`}</td>
                <td>${escapeHtml(market?.outcome || "-")}</td>
                <td>${Number.isFinite(Number(market?.marketProbability)) ? probability(Number(market.marketProbability)) : "-"}</td>
                <td>${escapeHtml(Array.isArray(market?.categories) ? market.categories.join(", ") : market?.categories || "-")}</td>
                <td class="${scanAuditActionClass(action)}"><strong>${escapeHtml(action.replace("_", " "))}</strong></td>
                <td>${escapeHtml(market?.reason || "-")}</td>
              </tr>`;
            }).join("") : '<tr><td colspan="6">No market rows were returned by this scan.</td></tr>'}</tbody>
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
    els.evaluationFilterCount.textContent = `${formatInteger(history.length) || history.length} recorded scraping runs`;
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
            <th>Since previous</th>
            <th>Trigger</th>
            <th>Status</th>
            <th>API calls</th>
            <th>Markets pulled</th>
            <th>Rows retained</th>
            <th>New / updated</th>
            <th>Resolved</th>
            <th>Not retained</th>
            <th>Why not retained</th>
            <th>Categories</th>
            <th>Tags</th>
            <th>Error</th>
          </tr>
        </thead>
        <tbody>
          ${history.slice(0, 200).map((run, index) => {
            const status = String(run.status || "UNKNOWN").toUpperCase();
            const statusClass = status === "ERROR" ? "negative" : status === "SUCCESS" ? "positive" : "";
            return `
              <tr class="scrape-run-row" data-scrape-run-audit="${escapeHtml(run.id || "")}" tabindex="0" role="button" aria-label="Open scraping audit for ${escapeHtml(formatDate(run.runAt || ""))}">
                <td data-label="Run time"><strong>${escapeHtml(formatDate(run.runAt || ""))}</strong><small class="table-secondary">Open audit</small></td>
                <td data-label="Since previous">${escapeHtml(scanLogInterval(run, history[index + 1]))}</td>
                <td data-label="Trigger"><strong>${escapeHtml(run.trigger || "AUTO")}</strong></td>
                <td data-label="Status" class="${statusClass}"><strong>${escapeHtml(status)}</strong></td>
                <td data-label="API calls">${formatInteger(run.apiCalls) || "0"}</td>
                <td data-label="Markets pulled"><strong>${formatInteger(run.rawMarketCount ?? run.loadedMarketCount) || "0"}</strong><small class="table-secondary">${formatInteger(run.loadedMarketCount) || "0"} unique / all returned pages / ${formatInteger((run.requestedCategories || []).length) || "0"} category scopes</small></td>
                <td data-label="Rows retained"><strong>${formatInteger(run.retainedObservationCount) || "0"}</strong><small class="table-secondary">${formatInteger(run.shortHorizonCount) || "0"} within preferred horizon</small></td>
                <td data-label="New / updated">${formatInteger(run.newObservationCount) || "0"} / ${formatInteger(run.updatedObservationCount) || "0"}</td>
                <td data-label="Resolved">${formatInteger(run.resolvedObservationCount) || "0"}</td>
                <td data-label="Not retained">${formatInteger(run.notRetainedCount) || "0"}</td>
                <td data-label="Why not retained"><small>${escapeHtml(scanLogReasonCounts(run.notRetainedReasonCounts, run.minResolutionMinutes))}</small></td>
                <td data-label="Categories"><strong>${escapeHtml(scanLogCounts(run.categoryCounts))}</strong>${Array.isArray(run.requestedCategories) && run.requestedCategories.length ? `<small class="table-secondary">API sweep: ${escapeHtml(run.requestedCategories.join(", "))}</small>` : ""}</td>
                <td data-label="Tags">${escapeHtml(scanLogCounts(run.tagCounts))}</td>
                <td data-label="Error" class="${run.error ? "negative" : ""}">${escapeHtml(run.error || "-")}</td>
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    </div>
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
          ${sortableHeader("aiProbability", "AI prob.")}
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
            <td data-label="AI prob.">${probability(Number(item.aiProbability))}</td>
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
    item.liquidity != null ? `liquidity ${money(Number(item.liquidity))}` : "",
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
        return `${index + 1}. ${item.kind === "order" ? "Order" : "Position"}: ${currentText} -> ${candidateText}${improvement}${result}; ${item.action || "reviewed"}`;
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
  const rotationPosition = rotationReview?.best?.position || null;
  const rotationCandidate = rotationReview?.best?.candidate || null;
  const rotationSummary = rotationReview ? [
    rotationPosition && rotationCandidate
      ? `Replace ${rotationPosition.outcome || "-"} - ${rotationPosition.question || "-"} with ${rotationCandidate.outcome || "-"} - ${rotationCandidate.question || "-"}`
      : rotationReview.action ? `Decision: ${rotationReview.action}` : "",
    rotationReview.best?.priorityComparison ? comparisonMetricLine(rotationReview.best.priorityComparison) : "",
    rotationReview.reason ? `Reason: ${rotationReview.reason}` : "",
  ].filter(Boolean).join("\n") : (rotationComparison.length ? rotationComparisonLines : "");
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
    return {
      ...execution.batchLog,
      generatedAt: execution.generatedAt || execution.batchLog.generatedAt,
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
    strategyId: "live",
    strategyLabel: "Live",
    selectionMetric: settings.probabilitySource === "polymarket" ? "Potential p.a." : "EV p.a.",
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
  const fromLiveState = Array.isArray(state.liveState?.runLog) ? state.liveState.runLog : [];
  const fromExecutionState = Array.isArray(state.liveExecutionState?.runLog) ? state.liveExecutionState.runLog : [];
  rows.push(...fromLiveState);
  rows.push(...fromExecutionState);
  const executionRun = normalizeLiveExecutionRun(state.liveExecutionState);
  if (executionRun) rows.unshift(executionRun);
  return mergeUniqueByRun(rows)
    .filter((row) => !isCadenceWaitRun(row))
    .slice(0, 120);
}

function isCadenceWaitRun(row = {}) {
  const batch = row.batchLog || row;
  const action = String(row.action || batch.action || "").toUpperCase();
  const reason = String(row.reason || batch.reason || "");
  return action === "CADENCE_WAIT" || /cadence poll is not due|polling skipped: no live execution review is due/i.test(reason);
}

function mergeUniqueByRun(rows = []) {
  const seen = new Set();
  const merged = [];
  for (const row of rows) {
    const key = row?.id || `${row?.runAt || ""}:${row?.strategyId || ""}:${row?.action || ""}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(row);
  }
  return merged;
}

function currentPortfolioRunLog() {
  if (isLiveMode()) return liveRunLogRows();
  const portfolio = selectedPaperPortfolio(state.botState || {});
  return Array.isArray(portfolio.runLog) ? portfolio.runLog.filter((row) => !isCadenceWaitRun(row)) : [];
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
  if (!selected || !["SUBMITTED", "CANCELED_AND_SUBMITTED"].includes(action)) return "";
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
  const label = isLiveMode() ? "Live" : paperModeLabel();
  if (els.runLogTitle) {
    els.runLogTitle.textContent = `${label} run log`;
  }
  if (els.runLogSummary) {
    els.runLogSummary.textContent = filters.length === 0
      ? `${runs.length} runs`
      : `${runs.length} / ${allRuns.length} runs`;
  }
  if (!runs.length) {
    const actionText = filters.length === 0 ? "" : ` with selected statuses ${filters.map(runActionFilterLabel).join(", ")}`;
    els.runLog.innerHTML = `<div class="empty">No ${escapeHtml(label)} trading decision runs${escapeHtml(actionText)} recorded yet.</div>`;
    return;
  }

  els.runLog.innerHTML = `
    <div class="ledger-scroll run-log-scroll" tabindex="0" aria-label="Scrollable portfolio run log">
    <div class="trade-batches portfolio-run-list">
      ${runs.slice(0, 120).map((run, index) => {
        const batch = run.batchLog || run;
        return `
          <button class="trade-batch portfolio-run-row" type="button" data-portfolio-run="${index}">
            <span class="${runActionClass(run.action || batch.action)}">${escapeHtml(run.action || batch.action || "-")}</span>
            <strong>${escapeHtml(run.runAt || run.generatedAt ? formatDate(run.runAt || run.generatedAt) : "-")}</strong>
            <span>${runLogMessageMarkup(run)}</span>
            <span class="portfolio-run-source">${portfolioRunSource(run)}</span>
          </button>
        `;
      }).join("")}
    </div>
    </div>
  `;
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
    if (state.calculationMarket === "all") return true;
    return row.marketType === state.calculationMarket;
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
  if (key === "minLiquidityUsdc") return numeric(row.minLiquidityUsdc);
  if (key === "trades") return numeric(row.trades ?? 0);
  if (key === "resolved") return numeric(row.resolved ?? 0);
  if (key === "accuracy") return numeric(row.winRate);
  if (key === "pnl") return numeric(row.pnlUsdc ?? 0);
  if (key === "roi") return numeric(row.roi);
  if (key === "avgProbability") return numeric(row.avgProbability);
  if (key === "avgLiquidity") return numeric(row.avgLiquidity);
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
    if (typeof aValue === "number" && typeof bValue === "number") return (aValue - bValue) * direction;
    return String(aValue).localeCompare(String(bValue)) * direction;
  });
}

function calculationHeader(key, label) {
  const active = state.calculationSort.key === key ? " active" : "";
  return `<th><div class="th-content"><button class="sort-button${active}" type="button" data-calculation-sort="${key}">${label}${calculationSortArrow(key)}</button></div></th>`;
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
  const categories = Array.isArray(report.categorySummaries) ? report.categorySummaries : [];
  const sample = Number(report.sampleSize || 0);
  const resolvedSample = Number(report.resolvedSampleSize || 0);
  const pendingSample = Number(report.pendingSampleSize || Math.max(0, sample - resolvedSample));
  const binary = Number(report.resolvedBinaryCount || 0);
  const multi = Number(report.resolvedMultiCount || 0);

  els.calculationReport.innerHTML = `
    <div class="calculation-summary">
      <div>
        <span class="label">Last calculation</span>
        <strong>${escapeHtml(report.generatedAt ? formatDate(report.generatedAt) : "-")}</strong>
        <span>${sample} fresh scraped opportunities / ${resolvedSample} resolved / ${pendingSample} pending</span>
      </div>
      <div>
        <span class="label">Simulation scope</span>
        <strong>${money(Number(report.stakeUsdc || 0))} fixed stake</strong>
        <span>first Polymarket probability and liquidity / ${binary} resolved Yes/No / ${multi} multi-outcome / market entry with fees</span>
      </div>
    </div>
    <div class="calculation-section">
      <h3>Best parameter combinations</h3>
      <p class="calculation-note">This ranking is independent of Conservative, High reward and More probable portfolios. It tests threshold, resolution horizon and minimum liquidity directly on every scraped opportunity.</p>
      <div class="calculation-table-wrap">
        <table class="calculation-table">
          <thead>
            <tr>
              ${calculationHeader("threshold", "Threshold")}
              ${calculationHeader("marketType", "Market type")}
              ${calculationHeader("maxResolutionDays", "Max days")}
              ${calculationHeader("minLiquidityUsdc", "Min liquidity")}
              ${calculationHeader("trades", "Trades")}
              ${calculationHeader("resolved", "Resolved")}
              ${calculationHeader("accuracy", "Accuracy")}
              ${calculationHeader("pnl", "P/L")}
              ${calculationHeader("roi", "ROI")}
              ${calculationHeader("avgProbability", "Avg entry")}
              ${calculationHeader("avgLiquidity", "Avg liquidity")}
            </tr>
          </thead>
          <tbody>
            ${rows.length ? rows.slice(0, 80).map((row) => `
              <tr>
                <td>${probability(Number(row.threshold))}</td>
                <td>${escapeHtml(calculationMarketLabel(row.marketType))}</td>
                <td>${Number(row.maxResolutionDays || 0)} d</td>
                <td>${row.minLiquidityUsdc > 0 ? money(Number(row.minLiquidityUsdc)) : "All"}</td>
                <td>${Number(row.trades || 0)}</td>
                <td>${Number(row.resolved || 0)} / ${Number(row.pending || 0)} pending</td>
                <td>${Number(row.resolved || 0) ? `${Number(row.wins || 0)} / ${Number(row.resolved || 0)} (${probability(Number(row.winRate))})` : "-"}</td>
                <td class="${pnlClass(Number(row.pnlUsdc || 0))}">${signedMoney(Number(row.pnlUsdc || 0))}</td>
                <td class="${pnlClass(Number(row.roi || 0))}">${row.roi == null ? "-" : signedPercent(Number(row.roi))}</td>
                <td>${probability(Number(row.avgProbability))}</td>
                <td>${Number.isFinite(Number(row.avgLiquidity)) ? money(Number(row.avgLiquidity)) : "-"}</td>
              </tr>
            `).join("") : '<tr><td colspan="11">No scraped opportunity simulation is available yet.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
    <div class="calculation-section">
      <h3>Category and tag performance</h3>
      <p class="calculation-note">Each opportunity contributes to its inferred category and each available tag. Pending resolutions are shown separately and do not distort realized accuracy or ROI.</p>
      <div class="calculation-table-wrap">
        <table class="calculation-table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Category / tag</th>
              <th>Trades</th>
              <th>Resolved</th>
              <th>Accuracy</th>
              <th>P/L</th>
              <th>ROI</th>
              <th>Avg entry</th>
              <th>Avg liquidity</th>
            </tr>
          </thead>
          <tbody>
            ${categories.length ? categories.map((row) => `
              <tr>
                <td>${escapeHtml(row.kind || "-")}</td>
                <td><strong>${escapeHtml(row.label || "-")}</strong></td>
                <td>${Number(row.trades || 0)}</td>
                <td>${Number(row.resolved || 0)} / ${Number(row.pending || 0)} pending</td>
                <td>${Number(row.resolved || 0) ? `${Number(row.wins || 0)} / ${Number(row.resolved || 0)} (${probability(Number(row.winRate))})` : "-"}</td>
                <td class="${pnlClass(Number(row.pnlUsdc || 0))}">${signedMoney(Number(row.pnlUsdc || 0))}</td>
                <td class="${pnlClass(Number(row.roi || 0))}">${row.roi == null ? "-" : signedPercent(Number(row.roi))}</td>
                <td>${probability(Number(row.avgProbability))}</td>
                <td>${Number.isFinite(Number(row.avgLiquidity)) ? money(Number(row.avgLiquidity)) : "-"}</td>
              </tr>
            `).join("") : '<tr><td colspan="9">No category or tag statistics are available yet.</td></tr>'}
          </tbody>
        </table>
      </div>
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

els.calculationReport?.addEventListener("click", (event) => {
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

els.modeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const mode = normalizeMode(button.dataset.modeToggle);
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

els.opportunityViewButtons.forEach((button) => {
  button.addEventListener("click", () => {
    setOpportunityView(button.dataset.opportunityView, { syncRoute: true });
  });
});

els.scrapedScanTag?.addEventListener("change", () => {
  state.scrapedScanTag = normalizedScrapedScanTag(els.scrapedScanTag.value);
  renderScrapedScanControls();
});

els.scrapedScanButton?.addEventListener("click", () => {
  triggerOneTimeMarketScan();
});

els.evaluationProbabilityFilter?.addEventListener("input", () => {
  const raw = Number(els.evaluationProbabilityFilter.value);
  const value = normalizeEvaluationProbabilityFilter(Number.isFinite(raw) ? raw / 100 : 0);
  state.evaluationProbabilityFilter = value;
  saveEvaluationProbabilityFilter(value);
  syncEvaluationProbabilityFilterControl();
  renderBotEvaluations();
});

els.evaluationDaysFilter?.addEventListener("input", () => {
  const value = normalizeEvaluationDaysFilter(els.evaluationDaysFilter.value);
  state.evaluationDaysFilter = value;
  saveEvaluationDaysFilter(value);
  persistScrapedScanPreferences();
  syncEvaluationDaysFilterControl();
  renderBotEvaluations();
});

els.evaluationNetYieldFilter?.addEventListener("input", () => {
  const raw = Number(els.evaluationNetYieldFilter.value);
  const value = normalizeMinimumNetYield(Number.isFinite(raw) ? raw / 100 : 0);
  state.evaluationNetYieldFilter = value;
  saveEvaluationNetYieldFilter(value);
  if (els.evaluationNetYieldFilterLabel) els.evaluationNetYieldFilterLabel.textContent = `>= ${percent(value)}`;
  renderBotEvaluations();
});

els.evaluationLiquidityFilter?.addEventListener("input", () => {
  const raw = Number(els.evaluationLiquidityFilter.value);
  const value = Number.isFinite(raw) && raw >= 0 ? Math.round(raw * 100) / 100 : 0;
  state.evaluationLiquidityFilter = value;
  saveEvaluationLiquidityFilter(value);
  persistScrapedScanPreferences();
  syncEvaluationLiquidityFilterControl();
  renderBotEvaluations();
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
  const normalized = normalizeRiskAllocation(raw / 100);
  const value = normalized ?? currentRiskAllocation();
  if (updateParameterDraft({ maxOrderFraction: value })) return;
  state.riskAllocation = value;
  updatePortfolioConfigForMode(state.mode, { maxOrderFraction: value });
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

els.mostProbableOutcome?.addEventListener("change", () => {
  const value = Boolean(els.mostProbableOutcome.checked);
  if (updateParameterDraft({ requireMostProbableOutcome: value })) return;
  updatePortfolioConfigForMode(state.mode, { requireMostProbableOutcome: value });
  savePortfolioConfigSoon();
  syncPortfolioParameterControls();
  rerenderCurrentDashboard();
});

els.polymarketProbability?.addEventListener("change", () => {
  const probabilitySource = els.polymarketProbability.checked ? "polymarket" : "ai";
  if (updateParameterDraft({ probabilitySource })) return;
  updatePortfolioConfigForMode(state.mode, { probabilitySource });
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

state.mode = storedMode();
state.runLogFilters = storedRunLogFilter(state.mode);
state.liveExecutionArmed = storedLiveExecutionArmed();
state.evaluationProbabilityFilter = storedEvaluationProbabilityFilter();
state.evaluationDaysFilter = storedEvaluationDaysFilter();
state.evaluationNetYieldFilter = storedEvaluationNetYieldFilter();
state.evaluationLiquidityFilter = storedEvaluationLiquidityFilter();
syncEvaluationProbabilityFilterControl();
syncEvaluationDaysFilterControl();
syncEvaluationNetYieldFilterControl();
syncEvaluationLiquidityFilterControl();
persistScrapedScanPreferences();
applyInitialRoute();
updateSchedulePanel();
window.setInterval(updateSchedulePanel, 60000);
loadDashboardState().then(() => {
  if (isLiveMode()) requestLiveAccountSync({ quiet: true });
});

window.setInterval(() => {
  if (!isLiveMode()) return;
  requestLiveAccountSync({ quiet: true, minSeconds: LIVE_SYNC_REQUEST_MS / 1000 });
}, LIVE_STATE_REFRESH_MS);
