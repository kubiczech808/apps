#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

function envNumber(name, fallback = null) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function envBool(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return String(value).toLowerCase() === "true";
}

function envSelectionOrder(name, fallback = "highest_ev_pa_first") {
  return process.env[name] === "highest_reward_risk_first" ? "highest_reward_risk_first" : fallback;
}

function envProbabilitySource(name, fallback = "ai") {
  return process.env[name] === "polymarket" ? "polymarket" : fallback;
}

function envTokenIdSet(name) {
  return new Set(String(process.env[name] || "")
    .split(",")
    .map((tokenId) => tokenId.trim())
    .filter((tokenId) => /^\d{8,100}$/.test(tokenId)));
}

const OUTPUT_PATH = process.env.PAPER_STATE_PATH || "data/paper-state.json";
const REMOTE_STATE_URL = process.env.PAPER_STATE_URL || "";
const PORTFOLIO_USDC = envNumber("PAPER_PORTFOLIO_USDC", 100);
const MAX_FRACTION = envNumber("PAPER_MAX_FRACTION", 0.05);
const MIN_PROBABILITY = envNumber("PAPER_MIN_PROBABILITY", 0.95);
const CONSERVATIVE_MIN_PROBABILITY = envNumber("PAPER_CONSERVATIVE_MIN_PROBABILITY", MIN_PROBABILITY);
const HIGH_REWARD_MIN_PROBABILITY = envNumber("PAPER_HIGH_REWARD_MIN_PROBABILITY", 0.6);
const MORE_PROBABLE_STRATEGY_MIN_PROBABILITY = envNumber("PAPER_MORE_PROBABLE_MIN_PROBABILITY", 0.6);
const MIN_ANNUAL_RETURN = envNumber("PAPER_MIN_ANNUAL_RETURN", 0.05);
const OPPORTUNITY_MIN_PROBABILITY = envNumber("PAPER_OPPORTUNITY_MIN_PROBABILITY", 0.6);
const OPPORTUNITY_MIN_EDGE = envNumber("PAPER_OPPORTUNITY_MIN_EDGE", 0.04);
const OPPORTUNITY_MIN_ANNUAL_RETURN = envNumber("PAPER_OPPORTUNITY_MIN_ANNUAL_RETURN", 0.3);
const MAX_EVALUATIONS_PER_RUN = envNumber("PAPER_MAX_EVALUATIONS_PER_RUN", 80);
const MAX_SPREAD = envNumber("PAPER_MAX_SPREAD", 0.08);
const MIN_VOLUME_24H = envNumber("PAPER_MIN_VOLUME_24H", 100);
const MAX_HISTORY = envNumber("PAPER_MAX_HISTORY", 5000);
const MARKET_SCAN_BATCH_SIZE = envNumber("PAPER_MARKET_SCAN_BATCH_SIZE", 100);
const MARKET_SCAN_MAX_OBSERVATIONS = envNumber("PAPER_MARKET_SCAN_MAX_OBSERVATIONS", 5000);
const MARKET_SCAN_MAX_OFFSET = envNumber("PAPER_MARKET_SCAN_MAX_OFFSET", 5000);
const MARKET_SCAN_PREFETCH_BATCHES = envNumber("PAPER_MARKET_SCAN_PREFETCH_BATCHES", 2);
const MARKET_SCAN_PREFERRED_MAX_RESOLUTION_DAYS = envNumber("PAPER_MARKET_SCAN_PREFERRED_MAX_RESOLUTION_DAYS", envNumber("PAPER_MAX_RESOLUTION_DAYS", 7));
const MARKET_SCAN_MIN_PROBABILITY = envNumber("PAPER_MARKET_SCAN_MIN_PROBABILITY", 0.5);
const MARKET_SCAN_MIN_RESOLUTION_HOURS = envNumber("PAPER_MARKET_SCAN_MIN_RESOLUTION_HOURS", 1);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";
const GEMINI_SEARCH_GROUNDING = String(process.env.GEMINI_SEARCH_GROUNDING ?? "true").toLowerCase() !== "false";
const REQUIRE_GEMINI = envBool("PAPER_REQUIRE_GEMINI", false);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const PRIMARY_AI_PROVIDER = (process.env.PAPER_PRIMARY_AI_PROVIDER || "gemini").toLowerCase();
const AI_ANALYSIS_LIMIT = envNumber("PAPER_AI_ANALYSIS_LIMIT", 2);
const AI_REQUEST_DELAY_MS = envNumber("PAPER_AI_REQUEST_DELAY_MS", 7000);
const AI_MIN_INTERVAL_SECONDS = envNumber("PAPER_AI_MIN_INTERVAL_SECONDS", 7);
const AI_MAX_REQUESTS_PER_MINUTE = envNumber("PAPER_AI_MAX_REQUESTS_PER_MINUTE", 10);
const AI_MAX_INPUT_TOKENS_PER_MINUTE = envNumber("PAPER_AI_MAX_INPUT_TOKENS_PER_MINUTE", 250000);
const AI_MAX_REQUESTS_PER_HOUR = envNumber("PAPER_AI_MAX_REQUESTS_PER_HOUR", 600);
const AI_MAX_REQUESTS_PER_DAY = envNumber("PAPER_AI_MAX_REQUESTS_PER_DAY", 1500);
const AI_EXECUTION_RESERVE_REQUESTS = envNumber("PAPER_AI_EXECUTION_RESERVE_REQUESTS", 100);
const AI_USAGE_HISTORY_LIMIT = envNumber("PAPER_AI_USAGE_HISTORY_LIMIT", 500);
const AI_POSTMORTEM_LIMIT = envNumber("PAPER_AI_POSTMORTEM_LIMIT", 8);
const AI_STOP_ON_QUOTA_ERROR = String(process.env.PAPER_AI_STOP_ON_QUOTA_ERROR ?? "true").toLowerCase() !== "false";
const AI_CRITIC_ENABLED = envBool("PAPER_AI_CRITIC_ENABLED", false);
const GROUNDED_AI_ANALYSIS_VERSION = "grounded-public-memo-v1";
const DEFAULT_MAX_RESOLUTION_DAYS = envNumber("PAPER_MAX_RESOLUTION_DAYS", envNumber("PAPER_SHORT_HORIZON_DAYS", 7));
const MORE_PROBABLE_MIN_LIQUIDITY_USDC = envNumber("PAPER_MORE_PROBABLE_MIN_LIQUIDITY_USDC", 500000);
const ROTATION_MIN_SCORE_IMPROVEMENT = envNumber("PAPER_ROTATION_MIN_SCORE_IMPROVEMENT", 0.15);
const ROTATION_MIN_EV_USDC_IMPROVEMENT = envNumber("PAPER_ROTATION_MIN_EV_USDC_IMPROVEMENT", 0.02);
const ROTATION_MIN_HOLD_HOURS = envNumber("PAPER_ROTATION_MIN_HOLD_HOURS", 6);
const REFRESH_ONLY = String(process.env.PAPER_REFRESH_ONLY || "").toLowerCase() === "true";
const REPORT_ONLY = String(process.env.PAPER_REPORT_ONLY || "").toLowerCase() === "true";
const MANUAL_RUN_ONCE = envBool("PAPER_MANUAL_RUN_ONCE", false);
const EVALUATION_ONLY = envBool("PAPER_EVALUATION_ONLY", false);
const EVALUATION_TOKEN_ID = String(process.env.PAPER_EVALUATION_TOKEN_ID || "").trim();
const EVALUATION_MARKET_SLUG = String(process.env.PAPER_EVALUATION_MARKET_SLUG || "").trim();
const SCHEDULED_CADENCE_POLL = envBool("PAPER_SCHEDULED_CADENCE_POLL", false);
const CONTINUOUS_EVALUATION = envBool("PAPER_CONTINUOUS_EVALUATION", false);
const EVALUATION_RESOLUTION_SYNC_LIMIT = envNumber("PAPER_EVALUATION_RESOLUTION_SYNC_LIMIT", 120);
const PAPER_STRATEGY_ID = ["conservative", "highReward", "moreProbable"].includes(process.env.PAPER_STRATEGY_ID)
  ? process.env.PAPER_STRATEGY_ID
  : "";
const TZ = "Europe/Prague";
const OPEN_STATUSES = new Set(["OPEN", "PENDING_RESOLUTION", "MARKET_NOT_FOUND"]);
const REPORT_THRESHOLDS = [0.5, 0.6, 0.7, 0.8, 0.9, 0.95];
const PAPER_STRATEGIES = {
  conservative: {
    id: "conservative",
    label: "Conservative",
    selectionMetric: "EV p.a.",
    minProbability: CONSERVATIVE_MIN_PROBABILITY,
    maxFraction: envNumber("PAPER_CONSERVATIVE_MAX_FRACTION", MAX_FRACTION),
    maxResolutionDays: envNumber("PAPER_CONSERVATIVE_MAX_RESOLUTION_DAYS", DEFAULT_MAX_RESOLUTION_DAYS),
    minLiquidityUsdc: envNumber("PAPER_CONSERVATIVE_MIN_LIQUIDITY_USDC", null),
    minNetYield: envNumber("PAPER_CONSERVATIVE_MIN_NET_YIELD", 0),
    tradeCadenceHours: envNumber("PAPER_CONSERVATIVE_TRADE_CADENCE_HOURS", 1),
    requireMostProbableOutcome: envBool("PAPER_CONSERVATIVE_REQUIRE_MOST_PROBABLE", false),
    probabilitySource: envProbabilitySource("PAPER_CONSERVATIVE_PROBABILITY_SOURCE"),
    excludedCandidateTokenIds: envTokenIdSet("PAPER_CONSERVATIVE_EXCLUDED_CANDIDATE_TOKEN_IDS"),
    selectionOrder: envSelectionOrder("PAPER_CONSERVATIVE_SELECTION_ORDER", "highest_ev_pa_first"),
    description: `Requires the configured probability source to meet ${(CONSERVATIVE_MIN_PROBABILITY * 100).toFixed(0)}% and resolution within ${DEFAULT_MAX_RESOLUTION_DAYS} days, then selects the highest EV p.a.`,
  },
  highReward: {
    id: "highReward",
    label: "High reward",
    selectionMetric: "Reward / risk",
    minProbability: HIGH_REWARD_MIN_PROBABILITY,
    maxFraction: envNumber("PAPER_HIGH_REWARD_MAX_FRACTION", MAX_FRACTION),
    maxResolutionDays: envNumber("PAPER_HIGH_REWARD_MAX_RESOLUTION_DAYS", DEFAULT_MAX_RESOLUTION_DAYS),
    minLiquidityUsdc: envNumber("PAPER_HIGH_REWARD_MIN_LIQUIDITY_USDC", null),
    minNetYield: envNumber("PAPER_HIGH_REWARD_MIN_NET_YIELD", 0),
    tradeCadenceHours: envNumber("PAPER_HIGH_REWARD_TRADE_CADENCE_HOURS", 1),
    requireMostProbableOutcome: envBool("PAPER_HIGH_REWARD_REQUIRE_MOST_PROBABLE", false),
    probabilitySource: envProbabilitySource("PAPER_HIGH_REWARD_PROBABILITY_SOURCE"),
    excludedCandidateTokenIds: envTokenIdSet("PAPER_HIGH_REWARD_EXCLUDED_CANDIDATE_TOKEN_IDS"),
    selectionOrder: envSelectionOrder("PAPER_HIGH_REWARD_SELECTION_ORDER", "highest_reward_risk_first"),
    description: `Requires the configured probability source to meet ${(HIGH_REWARD_MIN_PROBABILITY * 100).toFixed(0)}% and resolution within ${DEFAULT_MAX_RESOLUTION_DAYS} days, then prioritizes eligible opportunities by highest reward against risk.`,
  },
  moreProbable: {
    id: "moreProbable",
    label: "More probable",
    selectionMetric: "Reward / risk",
    minProbability: MORE_PROBABLE_STRATEGY_MIN_PROBABILITY,
    maxFraction: envNumber("PAPER_MORE_PROBABLE_MAX_FRACTION", MAX_FRACTION),
    maxResolutionDays: envNumber("PAPER_MORE_PROBABLE_MAX_RESOLUTION_DAYS", DEFAULT_MAX_RESOLUTION_DAYS),
    minLiquidityUsdc: envNumber("PAPER_MORE_PROBABLE_MIN_LIQUIDITY_USDC", MORE_PROBABLE_MIN_LIQUIDITY_USDC),
    minNetYield: envNumber("PAPER_MORE_PROBABLE_MIN_NET_YIELD", 0),
    tradeCadenceHours: envNumber("PAPER_MORE_PROBABLE_TRADE_CADENCE_HOURS", 1),
    requireMostProbableOutcome: envBool("PAPER_MORE_PROBABLE_REQUIRE_MOST_PROBABLE", true),
    probabilitySource: envProbabilitySource("PAPER_MORE_PROBABLE_PROBABILITY_SOURCE"),
    excludedCandidateTokenIds: envTokenIdSet("PAPER_MORE_PROBABLE_EXCLUDED_CANDIDATE_TOKEN_IDS"),
    selectionOrder: envSelectionOrder("PAPER_MORE_PROBABLE_SELECTION_ORDER", "highest_reward_risk_first"),
    description: `Requires the configured probability source to meet ${(MORE_PROBABLE_STRATEGY_MIN_PROBABILITY * 100).toFixed(0)}%, resolution within ${DEFAULT_MAX_RESOLUTION_DAYS} days, deep liquidity, and multichoice-style event markets.`,
  },
};

function executionStrategies() {
  if (MANUAL_RUN_ONCE && PAPER_STRATEGY_ID && PAPER_STRATEGIES[PAPER_STRATEGY_ID]) {
    return [PAPER_STRATEGIES[PAPER_STRATEGY_ID]];
  }
  return Object.values(PAPER_STRATEGIES);
}

const LEDGER_RECOVERY_ANCHORS = [
  {
    reason: "Recovered after static deploy overwrote bot-generated paper-state.json",
    id: "paper-2026-07-17-77899117691320282255084926855068126399522814425967645821251701722727475314950",
    sourceEvaluationId: "2941983-1-1784239888264",
    openedAt: "2026-07-16T22:11:30.509Z",
    date: "2026-07-17",
    tokenId: "77899117691320282255084926855068126399522814425967645821251701722727475314950",
    question: "Exact Score: France 0 - 0 England?",
    slug: "fifwc-fra-eng-2026-07-18-exact-score-0-0",
    eventSlug: "fifwc-fra-eng-2026-07-18-exact-score",
    outcome: "No",
    entryPrice: 0.964,
    shares: 5.1867,
    takerFeeUsdc: 0.009,
    totalCostUsdc: 5.009,
    netGainIfWinUsdc: 0.1777,
    maxLossUsdc: 5.009,
  },
  {
    reason: "Recovered after static deploy overwrote bot-generated paper-state.json",
    id: "paper-2026-07-18-46234664383113214034787313853742859435218314985155582830237659971348787896010",
    sourceEvaluationId: "2507607-1-1784325742533",
    openedAt: "2026-07-17T22:02:25.422Z",
    date: "2026-07-18",
    tokenId: "46234664383113214034787313853742859435218314985155582830237659971348787896010",
    question: "Kharg Island no longer under Iranian control by July 31?",
    slug: "kharg-island-no-longer-under-iranian-control-by-july-31",
    eventSlug: "kharg-island-no-longer-under-iranian-control-by-march-31",
    outcome: "No",
    entryPrice: 0.973,
    shares: 5.1387,
    takerFeeUsdc: 0,
    totalCostUsdc: 5,
    netGainIfWinUsdc: 0.1387,
    maxLossUsdc: 5,
  },
];

function pctText(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? `${(numeric * 100).toFixed(1)}%` : "-";
}

function pointText(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "-";
  const sign = numeric > 0 ? "+" : "";
  return `${sign}${(numeric * 100).toFixed(1)} pts`;
}

function compactSentence(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function buildMarketComparisonSummary({ probability, marketProbability, rationale }) {
  const ai = Number(probability);
  const market = Number(marketProbability);
  const reason = compactSentence(rationale);
  if (!Number.isFinite(ai) || !Number.isFinite(market)) {
    return reason || "No Polymarket entry price was available for a percentage-point comparison.";
  }
  const difference = ai - market;
  const direction = difference >= 0 ? "above" : "below";
  const reasonText = reason ? ` because ${reason.charAt(0).toLowerCase()}${reason.slice(1)}` : ".";
  return `AI probability ${pctText(ai)} is ${(Math.abs(difference) * 100).toFixed(1)} pts ${direction} the Polymarket entry ${pctText(market)}${reasonText}`;
}

function nowIso() {
  return new Date().toISOString();
}

function pragueDateKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function pragueHourKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}T${values.hour}`;
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

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { "User-Agent": "PolymarketPaperBot/1.0" },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.json();
}

async function readState() {
  if (String(process.env.PAPER_RESET_STATE || "").toLowerCase() === "true") {
    return normalizeState({});
  }

  let remoteError = null;
  if (REMOTE_STATE_URL) {
    try {
      const remote = await fetchJson(`${REMOTE_STATE_URL}${REMOTE_STATE_URL.includes("?") ? "&" : "?"}t=${Date.now()}`);
      if (remote && typeof remote === "object" && (Array.isArray(remote.trades) || remote.paperPortfolios)) {
        const remoteState = normalizeState(remote);
        try {
          const rawLocal = await readFile(OUTPUT_PATH, "utf8");
          return mergeStates(remoteState, normalizeState(JSON.parse(rawLocal)));
        } catch {
          return remoteState;
        }
      }
      remoteError = new Error("Remote state did not contain a trades array");
    } catch (error) {
      remoteError = error;
    }
  }

  try {
    const raw = await readFile(OUTPUT_PATH, "utf8");
    if (REMOTE_STATE_URL && remoteError) {
      throw new Error(`Refusing to use repository paper-state fallback because remote state is unavailable: ${remoteError.message}`);
    }
    return normalizeState(JSON.parse(raw));
  } catch {
    if (REMOTE_STATE_URL && remoteError) {
      throw remoteError;
    }
    return normalizeState({});
  }
}

function normalizeState(input) {
  const conservativeInput = input.paperPortfolios?.conservative || {
    portfolio: input.portfolio,
    trades: input.trades,
    lastTradeDate: input.lastTradeDate,
    lastTradeHour: input.lastTradeHour,
    lastDecision: input.lastDecision,
    runLog: input.runLog,
  };
  const highRewardInput = input.paperPortfolios?.highReward || {};
  const moreProbableInput = input.paperPortfolios?.moreProbable || {};
  const paperPortfolios = {
    conservative: normalizePaperPortfolio(PAPER_STRATEGIES.conservative, conservativeInput),
    highReward: normalizePaperPortfolio(PAPER_STRATEGIES.highReward, highRewardInput),
    moreProbable: normalizePaperPortfolio(PAPER_STRATEGIES.moreProbable, moreProbableInput),
  };
  return {
    schemaVersion: 2,
    generatedAt: input.generatedAt || null,
    paperPortfolios,
    portfolio: paperPortfolios.conservative.portfolio,
    trades: paperPortfolios.conservative.trades,
    evaluations: mergeEvaluationLists(Array.isArray(input.evaluations) ? input.evaluations : []),
    marketObservations: mergeMarketObservationLists(Array.isArray(input.marketObservations) ? input.marketObservations : []),
    marketScan: normalizeMarketScan(input.marketScan),
    evaluationRunLog: Array.isArray(input.evaluationRunLog) ? input.evaluationRunLog.slice(0, 80) : [],
    calculationReports: Array.isArray(input.calculationReports) ? input.calculationReports.slice(0, 30) : [],
    latestCalculationReport: input.latestCalculationReport || (Array.isArray(input.calculationReports) ? input.calculationReports[0] || null : null),
    learningProfile: normalizeLearningProfile(input.learningProfile),
    aiUsageLog: Array.isArray(input.aiUsageLog) ? input.aiUsageLog.slice(-Math.max(20, AI_USAGE_HISTORY_LIMIT)) : [],
    aiUsage: input.aiUsage && typeof input.aiUsage === "object" ? input.aiUsage : null,
    lastTradeDate: paperPortfolios.conservative.lastTradeDate,
    lastTradeHour: paperPortfolios.conservative.lastTradeHour,
    lastDecision: paperPortfolios.conservative.lastDecision,
    runLog: paperPortfolios.conservative.runLog,
  };
}

function normalizePaperPortfolio(strategy, input = {}) {
  return {
    id: strategy.id,
    label: strategy.label,
    selectionMetric: strategy.selectionMetric,
    selectionOrder: strategy.selectionOrder,
    minProbability: strategy.minProbability,
    maxFraction: strategy.maxFraction,
    maxResolutionDays: strategyMaxResolutionDays(strategy),
    minLiquidityUsdc: strategy.minLiquidityUsdc,
    minNetYield: Math.max(0, Number(strategy.minNetYield) || 0),
    tradeCadenceHours: normalizeTradeCadenceHours(strategy.tradeCadenceHours, 1),
    requireMostProbableOutcome: Boolean(strategy.requireMostProbableOutcome),
    probabilitySource: strategy.probabilitySource,
    description: strategy.description,
    portfolio: {
      initialUsdc: Number(input.portfolio?.initialUsdc || PORTFOLIO_USDC),
      maxFraction: Number(strategy.maxFraction ?? input.portfolio?.maxFraction ?? MAX_FRACTION),
      minProbability: Number(strategy.minProbability ?? input.portfolio?.minProbability ?? MIN_PROBABILITY),
      minAnnualReturn: Number(input.portfolio?.minAnnualReturn || MIN_ANNUAL_RETURN),
      opportunityMinProbability: Number(input.portfolio?.opportunityMinProbability || OPPORTUNITY_MIN_PROBABILITY),
      opportunityMinEdge: Number(input.portfolio?.opportunityMinEdge || OPPORTUNITY_MIN_EDGE),
      opportunityMinAnnualReturn: Number(input.portfolio?.opportunityMinAnnualReturn || OPPORTUNITY_MIN_ANNUAL_RETURN),
      maxResolutionDays: strategyMaxResolutionDays(strategy),
      minLiquidityUsdc: strategy.minLiquidityUsdc == null ? null : Number(strategy.minLiquidityUsdc),
      minNetYield: Math.max(0, Number(strategy.minNetYield) || 0),
      tradeCadenceHours: normalizeTradeCadenceHours(strategy.tradeCadenceHours, 1),
      requireMostProbableOutcome: Boolean(strategy.requireMostProbableOutcome),
      probabilitySource: strategy.probabilitySource,
    },
    trades: Array.isArray(input.trades)
      ? input.trades.map((trade) => normalizeTrade({ ...trade, strategyId: trade.strategyId || strategy.id, strategyLabel: trade.strategyLabel || strategy.label }))
      : [],
    lastTradeDate: input.lastTradeDate || null,
    lastTradeHour: input.lastTradeHour || null,
    lastDecision: input.lastDecision || null,
    runLog: Array.isArray(input.runLog) ? input.runLog : [],
  };
}

function stateTime(state) {
  const time = Date.parse(state?.generatedAt || "");
  return Number.isFinite(time) ? time : 0;
}

function tradeUpdateTime(trade) {
  return Math.max(
    Date.parse(trade?.resolvedAt || "") || 0,
    Date.parse(trade?.closedTime || "") || 0,
    Date.parse(trade?.lastCheckedAt || "") || 0,
    Date.parse(trade?.openedAt || trade?.date || "") || 0,
  );
}

function evaluationKey(item) {
  const tokenId = String(item?.tokenId || item?.clobTokenId || "").trim();
  if (tokenId) return `token:${tokenId}`;
  const slug = String(item?.slug || item?.eventSlug || "").trim().toLowerCase();
  const outcome = String(item?.outcome || "").trim().toLowerCase();
  if (slug && outcome) return `market:${slug}:${outcome}`;
  return String(item?.id || "").trim();
}

function evaluationUpdateTime(item) {
  return Math.max(
    Date.parse(item?.evaluatedAt || "") || 0,
    Date.parse(item?.lastSeenAt || "") || 0,
    Date.parse(item?.marketDataUpdatedAt || "") || 0,
    Date.parse(item?.updatedAt || "") || 0,
  );
}

function marketObservationKey(item) {
  return String(item?.marketKey || item?.id || item?.tokenId || "").trim();
}

function marketObservationUpdateTime(item) {
  return Date.parse(item?.marketDataUpdatedAt || item?.observedAt || item?.updatedAt || "") || 0;
}

function normalizeMarketObservationLifecycle(item, checkedAt = nowIso()) {
  if (!item || typeof item !== "object") return item;
  const status = String(item.status || item.selectionStatus || "").trim().toUpperCase();
  if (status === "ERROR" || status === "RESOLVED") return item;
  const end = Date.parse(item.endDate || "");
  if (!Number.isFinite(end) || end > Date.now()) return item;
  return {
    ...item,
    status: "RESOLVED",
    selectionStatus: "RESOLVED",
    resolutionStatus: item.resolutionStatus || "PENDING_RESULT",
    resolvedAt: item.resolvedAt || item.closedTime || item.endDate || checkedAt,
    resolvedDetectedAt: item.resolvedDetectedAt || checkedAt,
  };
}

function normalizeMarketScan(input = {}) {
  return {
    cursor: Math.max(0, Math.floor(Number(input?.cursor) || 0)),
    lastScanAt: input?.lastScanAt || null,
    lastBatchCount: Math.max(0, Math.floor(Number(input?.lastBatchCount) || 0)),
    lastPreferredCount: Math.max(0, Math.floor(Number(input?.lastPreferredCount) || 0)),
    lastShortHorizonCount: Math.max(0, Math.floor(Number(input?.lastShortHorizonCount) || 0)),
    preferredMaxResolutionDays: Math.max(1, Math.floor(Number(input?.preferredMaxResolutionDays) || MARKET_SCAN_PREFERRED_MAX_RESOLUTION_DAYS)),
    minResolutionHours: Math.max(0, Number(input?.minResolutionHours) || MARKET_SCAN_MIN_RESOLUTION_HOURS),
    lastScanError: input?.lastScanError || null,
  };
}

function mergeMarketObservationLists(primary = [], secondary = [], limit = MARKET_SCAN_MAX_OBSERVATIONS) {
  const byKey = new Map();
  for (const item of [...secondary, ...primary]) {
    const key = marketObservationKey(item);
    if (!key) continue;
    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, item);
      continue;
    }
    const incomingIsNewer = marketObservationUpdateTime(item) >= marketObservationUpdateTime(current);
    const newer = incomingIsNewer ? item : current;
    const older = incomingIsNewer ? current : item;
    const newerVerification = newer.executionRevalidation;
    const olderVerification = older.executionRevalidation;
    const newerCheckedAt = Date.parse(newerVerification?.checkedAt || "") || 0;
    const olderCheckedAt = Date.parse(olderVerification?.checkedAt || "") || 0;
    // A Gamma refresh updates market quotes but cannot prove CLOB executability.
    // Keep the latest live verdict until the next executor check replaces it.
    const executionRevalidation = newerCheckedAt >= olderCheckedAt ? newerVerification : olderVerification;
    byKey.set(key, {
      ...older,
      ...newer,
      ...(executionRevalidation ? { executionRevalidation } : {}),
    });
  }
  return [...byKey.values()]
    .map((item) => normalizeMarketObservationLifecycle(item))
    .sort((a, b) => marketObservationUpdateTime(b) - marketObservationUpdateTime(a))
    .slice(0, limit);
}

function mergeUniqueById(items, idFn, limit = Infinity) {
  const byId = new Map();
  for (const item of items) {
    const id = idFn(item);
    if (!id) continue;
    if (!byId.has(id)) byId.set(id, item);
  }
  return [...byId.values()].slice(0, limit);
}

const EVALUATION_CHANGE_FIELDS = [
  "status",
  "selectionStatus",
  "thesisType",
  "outcome",
  "tokenId",
  "marketPrice",
  "marketProbability",
  "marketDataUpdatedAt",
  "marketOutcomeFlipped",
  "bestAsk",
  "bestBid",
  "spread",
  "liquidity",
  "volume24hr",
  "aiProbability",
  "rawProbability",
  "edge",
  "expectedValueUsdc",
  "annualizedReturn",
  "aiExpectedValueUsdc",
  "aiAnnualizedReturn",
  "marketExpectedValueUsdc",
  "marketExpectedRoi",
  "marketAnnualizedReturn",
  "stakeUsdc",
  "executableShares",
  "totalCostUsdc",
  "takerFeeUsdc",
  "netGainIfWinUsdc",
  "riskReward",
  "expectedRoi",
  "endDate",
  "marketClosed",
  "acceptingOrders",
  "closedTime",
  "resolutionStatus",
  "finalOutcomePrice",
  "probabilityThesis",
];

function comparableEvaluationValue(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? Number(value.toFixed(6)) : null;
  if (Array.isArray(value)) return value.map(comparableEvaluationValue);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function changedEvaluationFields(previous, next) {
  const changes = [];
  for (const field of EVALUATION_CHANGE_FIELDS) {
    const from = comparableEvaluationValue(previous?.[field]);
    const to = comparableEvaluationValue(next?.[field]);
    if (JSON.stringify(from) === JSON.stringify(to)) continue;
    changes.push({ field, from, to });
  }
  return changes;
}

function normalizeEvaluationRisk(item) {
  if (!item || typeof item !== "object") return item;
  const risk = riskProfile({
    question: item.question,
    slug: item.slug,
    eventSlug: item.eventSlug,
    outcome: item.outcome,
    tags: item.tags,
  });
  const existingRiskKeys = Array.isArray(item.riskGroupKeys) ? item.riskGroupKeys : [];
  const existingRiskLabels = Array.isArray(item.riskGroupLabels) ? item.riskGroupLabels : [];
  return {
    ...item,
    riskGroupKeys: [...new Set([...existingRiskKeys, ...risk.keys])],
    riskGroupLabels: [...new Set([...existingRiskLabels, ...risk.labels])],
    riskCategory: item.riskCategory || risk.category,
    riskPrimaryEntity: item.riskPrimaryEntity || risk.primaryEntity,
  };
}

function mergeEvaluation(previous, next) {
  if (!previous) {
    const key = evaluationKey(next);
    return normalizeEvaluationRisk({
      ...next,
      id: key || next.id,
      firstEvaluatedAt: next.firstEvaluatedAt || next.evaluatedAt || nowIso(),
      lastSeenAt: next.lastSeenAt || next.evaluatedAt || nowIso(),
      evaluationCount: Number(next.evaluationCount || 1),
      updateHistory: Array.isArray(next.updateHistory) ? next.updateHistory.slice(0, 30) : [],
    });
  }
  if (!next) return previous;

  const incomingIsNewer = evaluationUpdateTime(next) >= evaluationUpdateTime(previous);
  const latest = incomingIsNewer ? next : previous;
  const older = incomingIsNewer ? previous : next;
  const changes = changedEvaluationFields(older, latest);
  const deferredWithoutNewMemo = latest.selectionStatus === "AI_PENDING"
    || latest.aiAnalysis?.aiModelStatus === "QUOTA_LIMITED";
  const preservePreviousMemo = deferredWithoutNewMemo && hasStoredGroundedPublicMemo(previous);
  if (preservePreviousMemo) {
    const retryAt = latest.evaluatedAt || latest.lastSeenAt || nowIso();
    const retryReason = compactSentence(
      latest.errorReason
      || latest.aiAnalysis?.aiModelError
      || latest.analysisSummary
      || "Gemini grounded analysis was deferred before a newer memo was completed.",
    );
    return normalizeEvaluationRisk({
      ...previous,
      lastAiRetryAt: retryAt,
      lastAiRetryStatus: "QUOTA_LIMITED",
      lastAiRetryReason: retryReason,
      aiRetryCount: Number(previous.aiRetryCount || 0) + 1,
      aiRetryHistory: [{ attemptedAt: retryAt, status: "QUOTA_LIMITED", reason: retryReason }, ...(Array.isArray(previous.aiRetryHistory) ? previous.aiRetryHistory : [])].slice(0, 20),
    });
  }
  const sameObservation = (previous.evaluatedAt || previous.lastSeenAt || "") === (next.evaluatedAt || next.lastSeenAt || "")
    && changes.length === 0;
  const previousHistory = Array.isArray(previous.updateHistory) ? previous.updateHistory : [];
  const incomingHistory = Array.isArray(next.updateHistory) ? next.updateHistory : [];
  const changeEntry = changes.length
    ? [{
        changedAt: latest.evaluatedAt || latest.lastSeenAt || nowIso(),
        previousEvaluatedAt: older.evaluatedAt || older.lastSeenAt || null,
        changes: changes.slice(0, 20),
      }]
    : [];

  const merged = {
    ...older,
    ...latest,
    id: evaluationKey(latest) || latest.id || previous.id,
    firstEvaluatedAt: previous.firstEvaluatedAt || next.firstEvaluatedAt || previous.evaluatedAt || next.evaluatedAt || nowIso(),
    previousEvaluatedAt: older.evaluatedAt || older.lastSeenAt || null,
    lastSeenAt: latest.evaluatedAt || latest.lastSeenAt || nowIso(),
    evaluationCount: sameObservation
      ? Math.max(Number(previous.evaluationCount || 1), Number(next.evaluationCount || 1))
      : Number(previous.evaluationCount || 1) + Number(next.evaluationCount || 1),
    updateHistory: [...changeEntry, ...incomingHistory, ...previousHistory].slice(0, 30),
    lastChanges: changes,
  };
  return normalizeEvaluationRisk(merged);
}

function mergeEvaluationLists(primary = [], secondary = [], limit = MAX_HISTORY) {
  const byKey = new Map();
  const ordered = [...secondary, ...primary].sort((a, b) => evaluationUpdateTime(a) - evaluationUpdateTime(b));
  for (const item of ordered) {
    const key = evaluationKey(item);
    if (!key) continue;
    byKey.set(key, mergeEvaluation(byKey.get(key), item));
  }
  const deduplicated = new Map();
  for (const item of byKey.values()) {
    const binaryKey = binaryEvaluationMarketKey(item);
    if (!binaryKey) {
      deduplicated.set(`evaluation:${evaluationKey(item)}`, item);
      continue;
    }
    const previous = deduplicated.get(binaryKey);
    const itemIsPendingRetry = item.selectionStatus === "AI_PENDING" || item.aiAnalysis?.aiModelStatus === "QUOTA_LIMITED";
    const previousIsPendingRetry = previous?.selectionStatus === "AI_PENDING" || previous?.aiAnalysis?.aiModelStatus === "QUOTA_LIMITED";
    const previousHasMemo = hasStoredGroundedPublicMemo(previous);
    const itemHasMemo = hasStoredGroundedPublicMemo(item);
    if (previousHasMemo && itemIsPendingRetry) continue;
    if (!previous
      || (itemHasMemo && previousIsPendingRetry)
      || evaluationUpdateTime(item) > evaluationUpdateTime(previous)
      || (evaluationUpdateTime(item) === evaluationUpdateTime(previous) && Number(item.aiProbability || 0) > Number(previous.aiProbability || 0))) {
      deduplicated.set(binaryKey, item);
    }
  }
  return [...deduplicated.values()]
    .sort((a, b) => evaluationUpdateTime(b) - evaluationUpdateTime(a))
    .slice(0, limit);
}

function cleanEvaluationErrorMessage(message) {
  return String(message || "")
    .replace(/^Orderbook fetch failed:\s*/i, "")
    .replace(/^Polymarket CLOB orderbook fetch failed:\s*/i, "")
    .trim();
}

function inferEvaluationErrorDetails(item = {}) {
  const reasons = Array.isArray(item.rejectReasons)
    ? item.rejectReasons.map(cleanEvaluationErrorMessage).filter(Boolean)
    : [];
  const rawMessage = cleanEvaluationErrorMessage(item.rawErrorMessage || item.errorReason || reasons[0] || item.analysisSummary || "");
  const joined = `${item.errorType || ""} ${rawMessage} ${item.analysisSummary || ""}`;
  const tokenNote = item.tokenId ? ` token_id ${item.tokenId}.` : "";

  if (/CLOB_ORDERBOOK_NOT_FOUND|HTTP 404|\/book\?token_id=|orderbook.*not found/i.test(joined)) {
    return {
      errorType: "CLOB_ORDERBOOK_NOT_FOUND",
      errorReason: `Polymarket CLOB returned HTTP 404 for${tokenNote || " the market token."} The token is likely closed, stale, migrated, or not currently exposed by the CLOB orderbook.`,
    };
  }

  if (/orderbook|clob|book\?/i.test(joined)) {
    return {
      errorType: item.errorType || "ORDERBOOK_FETCH_FAILED",
      errorReason: `Polymarket CLOB orderbook fetch failed for${tokenNote || " the market token."} ${rawMessage || "No detailed exchange error was returned."}`.trim(),
    };
  }

  return {
    errorType: item.errorType || "EVALUATION_ERROR",
    errorReason: rawMessage || "Unknown evaluation error.",
  };
}

function ensureEvaluationErrorMetadata(item = {}) {
  if (String(item.status || "").toUpperCase() !== "ERROR") return item;
  const details = inferEvaluationErrorDetails(item);
  const errorType = item.errorType || details.errorType;
  const errorReason = item.errorReason || details.errorReason;
  const rejectReasons = [...new Set([
    errorReason,
    ...(Array.isArray(item.rejectReasons) ? item.rejectReasons : []),
  ].filter(Boolean))];

  return {
    ...item,
    errorType,
    errorReason,
    rejectReasons,
    analysisSummary: item.analysisSummary || `Evaluation error: ${errorReason}`,
  };
}

function expirePastEvaluations(evaluations = []) {
  return evaluations.map((item) => {
    const status = String(item.status || "").toUpperCase();
    const end = Date.parse(item.endDate || "");
    if (status === "ERROR" || status === "RESOLVED" || !Number.isFinite(end) || end > Date.now()) return item;

    const rejectReasons = Array.isArray(item.rejectReasons) ? [...item.rejectReasons] : [];
    if (!rejectReasons.some((reason) => /end date|past|closed|accepting orders/i.test(String(reason || "")))) {
      rejectReasons.unshift("event end date is in the past; awaiting resolution sync");
    }
    const changedAt = nowIso();
    const changes = changedEvaluationFields(item, { ...item, status: "RESOLVED", rejectReasons });
    return {
      ...item,
      status: "RESOLVED",
      thesisType: "RESOLVED",
      resolutionStatus: item.resolutionStatus || "PENDING_RESULT",
      rejectReasons,
      lastSeenAt: item.lastSeenAt || changedAt,
      lastChanges: changes,
      updateHistory: [
        {
          changedAt,
          previousEvaluatedAt: item.evaluatedAt || item.lastSeenAt || null,
          changes: changes.length ? changes : [{ field: "status", from: status || "ELIGIBLE", to: "RESOLVED" }],
        },
        ...(Array.isArray(item.updateHistory) ? item.updateHistory : []),
      ].slice(0, 30),
    };
  });
}

function evaluationResolutionSlug(item) {
  return String(item?.slug || item?.eventSlug || "").trim();
}

function resolutionSyncPriority(item) {
  if (item?.finalOutcomePrice != null && item?.marketClosed !== true) return 0;
  const end = Date.parse(item?.endDate || "");
  const checked = Date.parse(item?.resolutionCheckedAt || "");
  const ageHours = Number.isFinite(checked) ? (Date.now() - checked) / 3600000 : Infinity;
  const days = Number.isFinite(end) ? (end - Date.now()) / 86400000 : Infinity;
  if (days <= 0) return 0;
  if (ageHours < 6) return 9;
  if (days <= 2) return 1;
  if (days <= 7) return 2;
  return 5;
}

function withEvaluationResolutionUpdate(item, patch, reason, checkedAt = nowIso()) {
  const rejectReasons = Array.isArray(item.rejectReasons) ? [...item.rejectReasons] : [];
  if (reason && !rejectReasons.some((entry) => String(entry || "") === reason)) {
    rejectReasons.unshift(reason);
  }
  const next = normalizeEvaluationRisk({
    ...item,
    ...patch,
    rejectReasons,
    lastSeenAt: checkedAt,
    resolutionCheckedAt: checkedAt,
  });
  const changes = changedEvaluationFields(item, next);
  return {
    ...next,
    lastChanges: changes,
    updateHistory: [
      {
        changedAt: checkedAt,
        previousEvaluatedAt: item.evaluatedAt || item.lastSeenAt || null,
        changes: changes.length ? changes : [{ field: "resolutionCheckedAt", from: item.resolutionCheckedAt || null, to: checkedAt }],
      },
      ...(Array.isArray(item.updateHistory) ? item.updateHistory : []),
    ].slice(0, 30),
  };
}

function resolvedEvaluationFromMarket(item, market, checkedAt = nowIso()) {
  const outcomeIndex = outcomeIndexForTrade(market, item);
  const prices = parseOutcomePrices(market);
  const resolvedPrice = outcomeIndex >= 0 ? prices[outcomeIndex] : null;
  const endDate = correctedEndDate(market.question || item.question, market.endDate || item.endDate || null, item.evaluatedAt || item.firstEvaluatedAt);
  const remainingDays = endDate ? daysToEnd(endDate) : null;
  const patch = {
    question: market.question || item.question,
    slug: market.slug || item.slug || "",
    eventSlug: marketEventSlug(market) || item.eventSlug || "",
    endDate,
    daysToResolution: remainingDays == null ? item.daysToResolution ?? null : Number(remainingDays.toFixed(2)),
    marketClosed: typeof market.closed === "boolean" ? market.closed : item.marketClosed ?? null,
    marketActive: typeof market.active === "boolean" ? market.active : item.marketActive ?? null,
    acceptingOrders: typeof market.acceptingOrders === "boolean" ? market.acceptingOrders : item.acceptingOrders ?? null,
    closedTime: market.closedTime || item.closedTime || null,
    umaResolutionStatus: market.umaResolutionStatus || item.umaResolutionStatus || null,
    finalOutcomePrice: market.closed && Number.isFinite(resolvedPrice) ? Number(resolvedPrice.toFixed(4)) : null,
  };

  if (market.closed) {
    return withEvaluationResolutionUpdate(item, {
      ...patch,
      status: "RESOLVED",
      thesisType: "RESOLVED",
      resolutionStatus: Number.isFinite(resolvedPrice) ? "FINAL_PRICE_AVAILABLE" : "PENDING_RESULT",
    }, "Polymarket market is closed; no longer selectable for new trades", checkedAt);
  }

  if (market.acceptingOrders === false) {
    return withEvaluationResolutionUpdate(item, {
      ...patch,
      status: "RESOLVED",
      thesisType: "RESOLVED",
      resolutionStatus: "NOT_ACCEPTING_ORDERS",
    }, "Polymarket market is no longer accepting orders; excluded from active evaluated opportunities", checkedAt);
  }

  if (remainingDays != null && remainingDays <= 0) {
    return withEvaluationResolutionUpdate(item, {
      ...patch,
      status: "RESOLVED",
      thesisType: "RESOLVED",
      resolutionStatus: "PENDING_RESULT",
    }, "event end date is in the past; awaiting resolution sync", checkedAt);
  }

  return withEvaluationResolutionUpdate(item, patch, "", checkedAt);
}

async function refreshStoredEvaluationResolutionStatuses(evaluations = []) {
  const refreshable = evaluations
    .map((item, index) => ({ item, index, status: String(item.status || "").toUpperCase(), slug: evaluationResolutionSlug(item) }))
    .filter(({ status, slug }) => slug && status !== "ERROR" && status !== "RESOLVED")
    .sort((a, b) => resolutionSyncPriority(a.item) - resolutionSyncPriority(b.item))
    .slice(0, Math.max(0, EVALUATION_RESOLUTION_SYNC_LIMIT));
  if (!refreshable.length) return evaluations;

  const next = [...evaluations];
  for (const entry of refreshable) {
    const checkedAt = nowIso();
    try {
      const market = await fetchMarketBySlug(entry.slug);
      if (!market) {
        next[entry.index] = withEvaluationResolutionUpdate(entry.item, {
          marketUrlStatus: "not_found",
        }, "Polymarket market slug was not found during resolution sync", checkedAt);
        continue;
      }
      next[entry.index] = resolvedEvaluationFromMarket(entry.item, market, checkedAt);
    } catch (error) {
      next[entry.index] = {
        ...entry.item,
        resolutionCheckedAt: checkedAt,
        resolutionCheckError: error?.message || String(error || "Unknown resolution sync error"),
      };
    }
  }
  return next;
}

function mergeTrade(existing, incoming) {
  if (!existing) return incoming;
  if (!incoming) return existing;
  const existingClosed = ["WON", "LOST"].includes(String(existing.status || "").toUpperCase());
  const incomingClosed = ["WON", "LOST"].includes(String(incoming.status || "").toUpperCase());
  if (incomingClosed && !existingClosed) return incoming;
  if (existingClosed && !incomingClosed) return existing;
  return tradeUpdateTime(incoming) >= tradeUpdateTime(existing) ? incoming : existing;
}

function mergeStates(primary, secondary) {
  const base = stateTime(primary) >= stateTime(secondary) ? primary : secondary;
  const other = base === primary ? secondary : primary;
  const merged = {
    ...base,
    evaluations: mergeEvaluationLists(base.evaluations || [], other.evaluations || []),
    marketObservations: mergeMarketObservationLists(base.marketObservations || [], other.marketObservations || []),
    marketScan: stateTime(base) >= stateTime(other) ? normalizeMarketScan(base.marketScan) : normalizeMarketScan(other.marketScan),
    evaluationRunLog: mergeUniqueById([...(base.evaluationRunLog || []), ...(other.evaluationRunLog || [])], (item) => item.runAt || item.id || "", 80),
    calculationReports: mergeUniqueById([...(base.calculationReports || []), ...(other.calculationReports || [])], (item) => item.id || item.generatedAt || "", 60)
      .sort((a, b) => (Date.parse(b.generatedAt || "") || 0) - (Date.parse(a.generatedAt || "") || 0))
      .slice(0, 30),
  };
  merged.latestCalculationReport = merged.calculationReports?.[0] || base.latestCalculationReport || other.latestCalculationReport || null;
  merged.paperPortfolios = {};
  for (const strategy of Object.values(PAPER_STRATEGIES)) {
    const basePortfolio = base.paperPortfolios?.[strategy.id] || normalizePaperPortfolio(strategy, {});
    const otherPortfolio = other.paperPortfolios?.[strategy.id] || normalizePaperPortfolio(strategy, {});
    const tradesById = new Map();
    for (const trade of [...(otherPortfolio.trades || []), ...(basePortfolio.trades || [])]) {
      tradesById.set(trade.id, mergeTrade(tradesById.get(trade.id), trade));
    }
    merged.paperPortfolios[strategy.id] = {
      ...basePortfolio,
      trades: [...tradesById.values()].sort((a, b) => tradeUpdateTime(b) - tradeUpdateTime(a)),
      runLog: mergeUniqueById([...(basePortfolio.runLog || []), ...(otherPortfolio.runLog || [])], (item) => `${item.runAt || ""}:${item.strategyId || strategy.id}`, 120),
    };
  }
  syncLegacyPaperAliases(merged);
  return merged;
}

function syncLegacyPaperAliases(state) {
  const conservative = state.paperPortfolios?.conservative || normalizePaperPortfolio(PAPER_STRATEGIES.conservative, {});
  state.paperPortfolios ||= {};
  state.paperPortfolios.conservative = conservative;
  state.paperPortfolios.highReward ||= normalizePaperPortfolio(PAPER_STRATEGIES.highReward, {});
  state.paperPortfolios.moreProbable ||= normalizePaperPortfolio(PAPER_STRATEGIES.moreProbable, {});
  state.portfolio = conservative.portfolio;
  state.trades = conservative.trades;
  state.lastTradeDate = conservative.lastTradeDate;
  state.lastTradeHour = conservative.lastTradeHour;
  state.lastDecision = conservative.lastDecision;
  state.runLog = conservative.runLog;
  return state;
}

function normalizeLearningProfile(profile = {}) {
  return {
    version: 1,
    updatedAt: profile.updatedAt || null,
    sampleSize: Number(profile.sampleSize || 0),
    brierScore: profile.brierScore != null && Number.isFinite(Number(profile.brierScore)) ? Number(profile.brierScore) : null,
    calibrationBias: profile.calibrationBias != null && Number.isFinite(Number(profile.calibrationBias)) ? Number(profile.calibrationBias) : 0,
    bucketCalibration: profile.bucketCalibration && typeof profile.bucketCalibration === "object" ? profile.bucketCalibration : {},
    factorAdjustments: profile.factorAdjustments && typeof profile.factorAdjustments === "object" ? profile.factorAdjustments : {},
    promptRules: Array.isArray(profile.promptRules) ? profile.promptRules : [],
    aiLastRun: profile.aiLastRun || null,
    aiModel: profile.aiModel || null,
    aiProvider: profile.aiProvider || null,
  };
}

function normalizeTrade(trade) {
  if (!trade || typeof trade !== "object") return trade;
  const risk = riskProfile({
    question: trade.question,
    slug: trade.slug,
    eventSlug: trade.eventSlug,
    outcome: trade.outcome,
    tags: trade.tags,
  });
  const existingRiskKeys = Array.isArray(trade.riskGroupKeys) ? trade.riskGroupKeys : [];
  const existingRiskLabels = Array.isArray(trade.riskGroupLabels) ? trade.riskGroupLabels : [];
  return {
    ...trade,
    status: trade.status || "OPEN",
    totalCostUsdc: Number(trade.totalCostUsdc || trade.maxLossUsdc || trade.stakeUsdc || 0),
    aiAnalysis: trade.aiAnalysis || {
      model: trade.analysisModel || "legacy-paper-trade",
      thesis: trade.probabilityThesis || trade.analysisSummary || "",
      probability: Number.isFinite(Number(trade.aiProbability)) ? Number(trade.aiProbability) : null,
      rawProbability: Number.isFinite(Number(trade.rawProbability)) ? Number(trade.rawProbability) : null,
      confidenceTier: trade.thesisType || null,
    },
    probabilityThesis: trade.probabilityThesis || trade.aiAnalysis?.thesis || "",
    analysisSummary: trade.analysisSummary || trade.aiAnalysis?.thesis || "",
    riskGroupKeys: [...new Set([...existingRiskKeys, ...risk.keys])],
    riskGroupLabels: [...new Set([...existingRiskLabels, ...risk.labels])],
  };
}

function daysToEnd(endDate) {
  const end = Date.parse(endDate || "");
  if (!Number.isFinite(end)) return null;
  return (end - Date.now()) / 86400000;
}

function endDateIsFuture(endDate) {
  const end = Date.parse(endDate || "");
  return Number.isFinite(end) && end > Date.now();
}

function inferredEndDateFromQuestion(question, fallbackDate = null) {
  const match = String(question || "").match(/\b(?:by|on|before|through)\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:,\s*(\d{4}))?/i);
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
  const fallback = new Date(fallbackDate || Date.now());
  const year = Number(match[3]) || (Number.isFinite(fallback.getTime()) ? fallback.getUTCFullYear() : new Date().getUTCFullYear());
  const month = months[match[1].toLowerCase()];
  const day = Number(match[2]);
  if (!Number.isInteger(month) || !Number.isFinite(day)) return null;
  const inferred = new Date(Date.UTC(year, month, day, 23, 59, 59));
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

function normalizeRiskText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function displayRiskName(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
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
  const key = normalizeRiskText(cleaned);
  if (!key || key.length < 2) return;
  if (/^(yes|no|over|under|draw|other|none)$/.test(key)) return;
  teams.set(key, displayRiskName(cleaned));
}

function extractTeams(question) {
  const text = String(question || "");
  const teams = new Map();
  const patterns = [
    /^Exact Score:\s*(.+?)\s+\d+\s*-\s*\d+\s*(.+?)\?/i,
    /^(.+?)\s+vs\.?\s+(.+?)(?::|\s+end\b|\s+go\b|\s+O\/U\b|\?|$)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      addTeam(teams, match[1]);
      addTeam(teams, match[2]);
    }
  }

  const spread = text.match(/^Spread:\s*(.+?)\s*\(/i);
  if (spread) addTeam(teams, spread[1]);

  const winner = text.match(/^Will\s+(.+?)\s+win(?:\s+on\b|\s+the\b|\?|$)/i);
  if (winner && !/\bvs\.?\b/i.test(winner[1])) addTeam(teams, winner[1]);

  return teams;
}

function eventSlugKey(slug) {
  const text = normalizeRiskText(slug).replace(/\s+/g, "-");
  const dated = text.match(/^(.+?-\d{4}-\d{2}-\d{2})(?:-|$)/);
  return dated ? dated[1] : "";
}

function topicRiskClusters({ question, slug, eventSlug }) {
  const text = normalizeRiskText(`${question || ""} ${slug || ""} ${eventSlug || ""}`);
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

  const normalizedSlug = normalizeRiskText(slug).replace(/\s+/g, "-");
  if (normalizedSlug) addKey(`market:${normalizedSlug}`, `Market: ${normalizedSlug}`);

  const normalizedEventSlug = normalizeRiskText(eventSlug).replace(/\s+/g, "-");
  if (normalizedEventSlug) addKey(`event:${normalizedEventSlug}`, `Event: ${normalizedEventSlug}`);
  const eventKey = eventSlugKey(eventSlug || slug);
  if (eventKey) addKey(`event:${eventKey}`, `Event: ${eventKey}`);
  for (const [key, label] of topicRiskClusters({ question, slug, eventSlug })) addKey(key, label);

  const teams = extractTeams(question);
  for (const [teamKey, label] of teams) {
    addKey(`team:${teamKey}`, `Team: ${label}`);
  }

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

function marketEventSlug(market) {
  const events = Array.isArray(market.events) ? market.events : [];
  const eventSlug = events.find((event) => event?.slug)?.slug;
  return eventSlug || market.eventSlug || market.slug || "";
}

function bestBook(book) {
  const bids = Array.isArray(book.bids) ? book.bids : [];
  const asks = Array.isArray(book.asks) ? book.asks : [];
  const bidPrices = bids.map((level) => Number(level.price)).filter(Number.isFinite);
  const askPrices = asks.map((level) => Number(level.price)).filter(Number.isFinite);
  const bestBid = bidPrices.length ? Math.max(...bidPrices) : null;
  const bestAsk = askPrices.length ? Math.min(...askPrices) : null;
  return {
    bestBid,
    bestAsk,
    spread: bestBid != null && bestAsk != null ? Math.max(0, bestAsk - bestBid) : null,
    askDepth: asks.slice(0, 5).reduce((sum, level) => sum + Number(level.size || 0), 0),
    asks,
  };
}

function simulateMarketBuy(asks, stakeUsdc) {
  const levels = asks
    .map((level) => ({
      price: Number(level.price),
      size: Number(level.size),
    }))
    .filter((level) => Number.isFinite(level.price) && Number.isFinite(level.size) && level.price > 0 && level.size > 0)
    .sort((a, b) => a.price - b.price);

  let remaining = stakeUsdc;
  let cost = 0;
  let shares = 0;
  const fills = [];

  for (const level of levels) {
    if (remaining <= 0) break;
    const levelCost = level.price * level.size;
    const costAtLevel = Math.min(remaining, levelCost);
    const sizeAtLevel = costAtLevel / level.price;
    cost += costAtLevel;
    shares += sizeAtLevel;
    remaining -= costAtLevel;
    fills.push({
      price: Number(level.price.toFixed(4)),
      size: Number(sizeAtLevel.toFixed(4)),
      costUsdc: Number(costAtLevel.toFixed(4)),
    });
  }

  const avgPrice = shares > 0 ? cost / shares : null;
  const bestAsk = levels[0]?.price ?? null;
  const depthUsdc = levels.reduce((sum, level) => sum + level.price * level.size, 0);

  return {
    requestedUsdc: Number(stakeUsdc.toFixed(2)),
    filledUsdc: Number(cost.toFixed(4)),
    fillable: cost >= stakeUsdc * 0.999,
    shares: Number(shares.toFixed(4)),
    avgPrice: avgPrice == null ? null : Number(avgPrice.toFixed(4)),
    bestAsk: bestAsk == null ? null : Number(bestAsk.toFixed(4)),
    slippage: avgPrice != null && bestAsk != null ? Number((avgPrice - bestAsk).toFixed(4)) : null,
    depthUsdc: Number(depthUsdc.toFixed(4)),
    fills: fills.slice(0, 8),
  };
}

function feeConfig(market) {
  const schedule = market.feeSchedule && typeof market.feeSchedule === "object" ? market.feeSchedule : {};
  const rate = Number(schedule.rate ?? 0);
  const enabled = Boolean(market.feesEnabled) && Number.isFinite(rate) && rate > 0;
  return {
    feesEnabled: enabled,
    feeRate: enabled ? rate : 0,
    feeType: market.feeType || (enabled ? "unknown" : "fee_free"),
    takerOnly: schedule.takerOnly !== false,
  };
}

function takerFeeForFills(fills, feeRate) {
  if (!Number.isFinite(feeRate) || feeRate <= 0) return 0;
  const fee = fills.reduce((sum, fill) => {
    const size = Number(fill.size);
    const price = Number(fill.price);
    if (!Number.isFinite(size) || !Number.isFinite(price)) return sum;
    return sum + size * feeRate * price * (1 - price);
  }, 0);
  return Number(fee.toFixed(5));
}

function totalCost(trade) {
  return Number(trade.totalCostUsdc || trade.maxLossUsdc || trade.stakeUsdc || 0);
}

function pnlPercent(pnl, basis) {
  const denominator = Number(basis);
  return denominator > 0 ? Number((Number(pnl || 0) / denominator).toFixed(4)) : null;
}

function average(values) {
  const rows = values.filter((value) => Number.isFinite(Number(value))).map(Number);
  return rows.length ? rows.reduce((sum, value) => sum + value, 0) / rows.length : null;
}

function parseOutcomePrices(market) {
  return parseJsonField(market.outcomePrices).map((price) => Number(price));
}

function outcomeIndexForTrade(market, trade) {
  const outcomes = parseJsonField(market.outcomes).map((outcome) => String(outcome));
  const byOutcome = outcomes.findIndex((outcome) => outcome.toLowerCase() === String(trade.outcome || "").toLowerCase());
  if (byOutcome >= 0) return byOutcome;
  const tokenIds = parseJsonField(market.clobTokenIds).map((tokenId) => String(tokenId));
  return tokenIds.findIndex((tokenId) => tokenId === String(trade.tokenId || ""));
}

async function fetchMarketBySlug(slug) {
  if (!slug) return null;
  for (const closed of ["true", "false"]) {
    const url = new URL("https://gamma-api.polymarket.com/markets");
    url.searchParams.set("slug", slug);
    url.searchParams.set("closed", closed);
    const markets = await fetchJson(url);
    if (Array.isArray(markets) && markets[0]) return markets[0];
  }
  return null;
}

async function markOpenTrade(trade) {
  if (!OPEN_STATUSES.has(trade.status)) return trade;

  const checkedAt = nowIso();
  const cost = totalCost(trade);
  let market = null;

  try {
    market = await fetchMarketBySlug(trade.slug);
  } catch (error) {
    return {
      ...trade,
      statusNote: `Market refresh failed: ${error.message}`,
      lastCheckedAt: checkedAt,
    };
  }

  if (!market) {
    return {
      ...trade,
      status: "MARKET_NOT_FOUND",
      statusNote: "Market slug not found in Gamma API.",
      lastCheckedAt: checkedAt,
      marketUrlStatus: "not_found",
    };
  }

  const outcomeIndex = outcomeIndexForTrade(market, trade);
  const prices = parseOutcomePrices(market);
  const resolvedPrice = outcomeIndex >= 0 ? prices[outcomeIndex] : null;
  const eventSlug = marketEventSlug(market);
  const endDate = correctedEndDate(market.question || trade.question, market.endDate || trade.endDate || null, trade.openedAt || trade.date);
  const remainingDays = endDate ? daysToEnd(endDate) : null;
  const base = {
    ...trade,
    question: market.question || trade.question,
    eventSlug,
    endDate,
    daysToResolution: remainingDays == null ? trade.daysToResolution ?? null : Number(remainingDays.toFixed(2)),
    marketClosed: Boolean(market.closed),
    marketActive: Boolean(market.active),
    acceptingOrders: Boolean(market.acceptingOrders),
    umaResolutionStatus: market.umaResolutionStatus || trade.umaResolutionStatus || null,
    closedTime: market.closedTime || trade.closedTime || null,
    lastCheckedAt: checkedAt,
    marketUrlStatus: eventSlug && eventSlug !== trade.slug ? "use_event_slug" : "ok",
  };

  if (market.closed && Number.isFinite(resolvedPrice)) {
    const won = resolvedPrice >= 0.999;
    const lost = resolvedPrice <= 0.001;
    if (won || lost) {
      const realizedPnl = won ? Number((Number(trade.shares || 0) - cost).toFixed(4)) : Number((-cost).toFixed(4));
      return {
        ...base,
        status: won ? "WON" : "LOST",
        resolvedAt: market.closedTime || checkedAt,
        finalOutcomePrice: Number(resolvedPrice.toFixed(4)),
        currentPrice: Number(resolvedPrice.toFixed(4)),
        currentValueUsdc: won ? Number(Number(trade.shares || 0).toFixed(4)) : 0,
        unrealizedPnlUsdc: 0,
        unrealizedPnlPct: 0,
        realizedPnlUsdc: realizedPnl,
        realizedPnlPct: pnlPercent(realizedPnl, cost),
        statusNote: `Resolved by Polymarket as ${trade.outcome}=${resolvedPrice}.`,
      };
    }
  }

  if (market.closed) {
    return {
      ...base,
      status: "PENDING_RESOLUTION",
      finalOutcomePrice: Number.isFinite(resolvedPrice) ? Number(resolvedPrice.toFixed(4)) : null,
      statusNote: "Market is closed but outcome price is not final yet.",
    };
  }

  if (remainingDays != null && remainingDays <= 0) {
    return {
      ...base,
      status: "PENDING_RESOLUTION",
      finalOutcomePrice: Number.isFinite(resolvedPrice) ? Number(resolvedPrice.toFixed(4)) : null,
      currentPrice: Number.isFinite(resolvedPrice) ? Number(resolvedPrice.toFixed(4)) : trade.currentPrice ?? null,
      currentValueUsdc: trade.currentValueUsdc ?? null,
      unrealizedPnlUsdc: trade.unrealizedPnlUsdc ?? 0,
      unrealizedPnlPct: trade.unrealizedPnlPct ?? 0,
      statusNote: "Event end date has passed; waiting for Polymarket resolution.",
    };
  }

  try {
    const book = await fetchJson(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(trade.tokenId)}`);
    const { bestBid } = bestBook(book);
    if (Number.isFinite(bestBid)) {
      const currentValue = Number((Number(trade.shares || 0) * bestBid).toFixed(4));
      const unrealizedPnl = Number((currentValue - cost).toFixed(4));
      return {
        ...base,
        status: "OPEN",
        currentPrice: Number(bestBid.toFixed(4)),
        currentValueUsdc: currentValue,
        unrealizedPnlUsdc: unrealizedPnl,
        unrealizedPnlPct: pnlPercent(unrealizedPnl, cost),
        statusNote: "Marked to current best bid.",
      };
    }
  } catch (error) {
    return {
      ...base,
      statusNote: `Orderbook refresh failed: ${error.message}`,
    };
  }

  return base;
}

async function refreshTrades(trades) {
  const refreshed = [];
  for (const trade of trades) {
    refreshed.push(await markOpenTrade(trade));
  }
  return refreshed;
}

function probabilityBucket(probability) {
  const value = Number(probability);
  if (!Number.isFinite(value)) return "unknown";
  if (value < 0.2) return "00-20";
  if (value < 0.4) return "20-40";
  if (value < 0.6) return "40-60";
  if (value < 0.8) return "60-80";
  if (value < 0.9) return "80-90";
  if (value < 0.97) return "90-97";
  return "97-100";
}

function outcomeKind(outcome) {
  const text = String(outcome || "").toLowerCase();
  if (text === "yes") return "YES";
  if (text === "no") return "NO";
  return "OUTCOME";
}

function binaryYesNoOutcomeIndexes(outcomes = []) {
  const normalized = outcomes.map((outcome) => String(outcome || "").trim().toLowerCase());
  if (normalized.length !== 2) return null;
  const yesIndex = normalized.indexOf("yes");
  const noIndex = normalized.indexOf("no");
  return yesIndex >= 0 && noIndex >= 0 ? { yesIndex, noIndex } : null;
}

function binaryEvaluationMarketKey(item) {
  const outcome = outcomeKind(item?.outcome);
  // Older stored evaluations do not always carry outcomeCount or the paired
  // token IDs. A Yes/No evaluation is still a binary market and must match the
  // fresh Gamma snapshot by slug so its current Polymarket probability is kept.
  const isBinary = item?.binaryYesTokenId || outcome === "YES" || outcome === "NO" || Number(item?.outcomeCount) === 2;
  if (!isBinary) return "";
  const slug = String(item?.slug || item?.eventSlug || "").trim().toLowerCase();
  const question = String(item?.question || "").trim().toLowerCase();
  return slug ? `binary:${slug}` : (question ? `binary-question:${question}` : "");
}

function binaryMarketKeyFromMarket(market) {
  const outcomes = parseJsonField(market?.outcomes);
  if (!binaryYesNoOutcomeIndexes(outcomes)) return "";
  const slug = String(market?.slug || marketEventSlug(market) || "").trim().toLowerCase();
  const question = String(market?.question || "").trim().toLowerCase();
  return slug ? `binary:${slug}` : (question ? `binary-question:${question}` : "");
}

function analysisFactorKeys({ probability, outcome, tags, spread, liquidity, volume24hr, days, market }) {
  const keys = new Set();
  const tagList = Array.isArray(tags) && tags.length ? tags : ["general"];
  for (const tag of tagList.slice(0, 4)) keys.add(`tag:${tag}`);
  keys.add(`bucket:${probabilityBucket(probability)}`);
  keys.add(`outcome:${outcomeKind(outcome).toLowerCase()}`);
  keys.add(spread != null && spread <= 0.015 ? "spread:tight" : "spread:wide");
  keys.add(liquidity >= 5000 || volume24hr >= 5000 ? "liquidity:deep" : "liquidity:thin");
  keys.add(days != null && days <= 21 ? "horizon:short" : "horizon:long");
  if (market?.negRisk) keys.add("market:negative-risk");
  return [...keys];
}

function learningAdjustment({ probability, outcome, tags, spread, liquidity, volume24hr, days, market, learningProfile }) {
  const profile = normalizeLearningProfile(learningProfile);
  const factors = analysisFactorKeys({ probability, outcome, tags, spread, liquidity, volume24hr, days, market });
  const applied = [];
  let adjustment = 0;

  for (const key of factors) {
    const value = Number(profile.factorAdjustments?.[key]?.adjustment);
    if (Number.isFinite(value) && value !== 0) {
      adjustment += value;
      applied.push({ key, adjustment: Number(value.toFixed(4)) });
    }
  }

  const bucket = profile.bucketCalibration?.[probabilityBucket(probability)];
  const bucketError = Number(bucket?.calibrationError);
  if (Number.isFinite(bucketError) && Number(bucket?.count || 0) >= 3) {
    const value = clamp(bucketError * 0.25, -0.04, 0.04);
    adjustment += value;
    applied.push({ key: `calibration:${probabilityBucket(probability)}`, adjustment: Number(value.toFixed(4)) });
  }

  const bias = Number(profile.calibrationBias);
  if (Number.isFinite(bias) && profile.sampleSize >= 5) {
    const value = clamp(bias * 0.15, -0.025, 0.025);
    adjustment += value;
    applied.push({ key: "global:bias", adjustment: Number(value.toFixed(4)) });
  }

  return {
    adjustment: clamp(adjustment, -0.08, 0.08),
    applied,
    factors,
  };
}

function confidenceTier(probability) {
  if (probability >= 0.95) return "near-certain";
  if (probability >= 0.8) return "high";
  if (probability >= 0.6) return "edge-watch";
  if (probability >= 0.4) return "uncertain";
  return "long-shot";
}

function buildHeuristicAnalysis({
  question,
  outcome,
  probability,
  rawProbability,
  executionPrice,
  edge,
  annualizedReturn,
  expectedValue,
  notes,
  tags,
  learning,
}) {
  const direction = outcomeKind(outcome);
  const likely = probability >= 0.5 ? "likely" : "unlikely";
  const value = expectedValue > 0 ? "positive" : "negative";
  const thesis = `${direction} thesis: ${String(outcome || "selected outcome")} is ${likely} at ${(probability * 100).toFixed(1)}% versus market-buy entry ${(executionPrice * 100).toFixed(1)}%; expected value is ${value}.`;
  const probabilityRationale = notes.length
    ? `The probability is calibrated from the strongest available signals: ${notes.slice(0, 3).join(" ")}`
    : "The probability remains close to the observable execution price because no stronger independent public signal was available in the heuristic pass.";
  const probabilityPointRationale = `The estimate lands at ${pctText(probability)} after a raw heuristic estimate of ${pctText(rawProbability)} and learning adjustment of ${pointText(probability - rawProbability)}.`;
  const marketComparisonSummary = buildMarketComparisonSummary({
    probability,
    marketProbability: executionPrice,
    rationale: probabilityRationale,
  });
  const uncertaintyFlags = [
    executionPrice > 0.97 ? "crowded near-certain market" : "",
    executionPrice < 0.15 ? "long-shot price bucket" : "",
    Math.abs(edge) < 0.015 ? "thin modeled edge" : "",
    tags.includes("clear-resolution") ? "" : "resolution wording needs review",
  ].filter(Boolean);

  return {
    model: "heuristic-calibration-v2",
    direction,
    thesis,
    probability: Number(probability.toFixed(4)),
    rawProbability: Number(rawProbability.toFixed(4)),
    confidenceTier: confidenceTier(probability),
    marketImpliedProbability: Number(executionPrice.toFixed(4)),
    edge: Number(edge.toFixed(4)),
    probabilityRationale,
    probabilityPointRationale,
    marketComparisonSummary,
    expectedValueUsdc: Number(expectedValue.toFixed(4)),
    annualizedReturn: Number(annualizedReturn.toFixed(4)),
    evidence: notes.slice(0, 6),
    counterEvidence: uncertaintyFlags,
    tags,
    learningAdjustment: Number((probability - rawProbability).toFixed(4)),
    learningFactors: learning.factors,
    appliedLearning: learning.applied,
  };
}

function scoreStatus({ probability, annualizedReturn, edge, spreadOk, volumeOk, depthOk, endOk }) {
  const highConfidenceOk = probability >= MIN_PROBABILITY;
  const opportunityOk = probability >= OPPORTUNITY_MIN_PROBABILITY
    && edge >= OPPORTUNITY_MIN_EDGE
    && annualizedReturn >= OPPORTUNITY_MIN_ANNUAL_RETURN;
  const returnOk = annualizedReturn >= MIN_ANNUAL_RETURN;
  const eligible = endOk && (highConfidenceOk || opportunityOk) && returnOk && spreadOk && volumeOk && depthOk;
  return {
    status: eligible ? "ELIGIBLE" : "REJECTED",
    thesisType: highConfidenceOk ? "HIGH_CONFIDENCE" : (opportunityOk ? "EDGE_OPPORTUNITY" : "REJECTED"),
    rejectReasons: [
      endOk ? null : "event end date is in the past",
      highConfidenceOk || opportunityOk ? null : `probability ${(probability * 100).toFixed(1)}% below high-confidence threshold and edge-opportunity threshold`,
      annualizedReturn <= 0
        ? `annualized EV ${(annualizedReturn * 100).toFixed(1)}% is non-profitable after fees`
        : (returnOk ? null : `annualized EV ${(annualizedReturn * 100).toFixed(1)}% below ${(MIN_ANNUAL_RETURN * 100).toFixed(1)}%`),
      spreadOk ? null : "spread too wide",
      volumeOk ? null : "liquidity/volume too low",
      depthOk ? null : "insufficient ask depth for market buy",
    ].filter(Boolean),
  };
}

function economicsForProbability({ probability, execution, stake, takerFee, totalCost, days, spreadOk, volumeOk, depthOk, endOk }) {
  const executionPrice = execution.avgPrice;
  const expectedValue = probability * execution.shares - stake - takerFee;
  const expectedRoi = totalCost > 0 ? expectedValue / totalCost : 0;
  const annualizedReturn = days ? expectedRoi * (365 / days) : expectedRoi;
  const edge = probability - executionPrice;
  const scored = scoreStatus({ probability, annualizedReturn, edge, spreadOk, volumeOk, depthOk, endOk });
  return {
    expectedValue,
    expectedRoi,
    annualizedReturn,
    edge,
    ...scored,
  };
}

function estimateProbability({ market, outcome, ask, bid, spread, liquidity, volume24hr, tags, days, learningProfile }) {
  const marketConsensus = Number.isFinite(bid) && Number.isFinite(ask) ? (bid + ask) / 2 : ask;
  let probability = marketConsensus;
  const notes = [];

  if (ask >= 0.94) {
    probability += 0.018;
    notes.push("Market consensus already prices this outcome as near-certain.");
  }
  if (spread != null && spread <= 0.015) {
    probability += 0.006;
    notes.push("Tight spread increases confidence in the quoted probability.");
  }
  if (liquidity >= 5000 || volume24hr >= 5000) {
    probability += 0.006;
    notes.push("Liquidity/volume is high enough to treat price as meaningful.");
  }
  if (days != null && days <= 21 && ask >= 0.9) {
    probability += 0.008;
    notes.push("Short time to resolution reduces forecast horizon.");
  }
  if (!tags.includes("clear-resolution")) {
    probability -= 0.01;
    notes.push("Resolution wording may need manual review.");
  }
  if (/other|none|unknown|another/i.test(outcome)) {
    probability -= 0.015;
    notes.push("Outcome label is less specific than a direct yes/no claim.");
  }
  if (market.negRisk) {
    notes.push("Negative-risk market: execution needs extra care in live mode.");
  }

  const rawProbability = clamp(probability, 0.01, 0.995);
  const learning = learningAdjustment({
    probability: rawProbability,
    outcome,
    tags,
    spread,
    liquidity,
    volume24hr,
    days,
    market,
    learningProfile,
  });
  probability = rawProbability + learning.adjustment;
  if (learning.applied.length) {
    notes.push(`Learning calibration adjusted probability by ${(learning.adjustment * 100).toFixed(1)} pts.`);
  }

  return {
    probability: clamp(probability, 0.01, 0.995),
    rawProbability,
    notes,
    learning,
  };
}

function evaluateCandidate({ market, outcomeIndex, tokenId, book, learningProfile }) {
  const question = String(market.question || "");
  const outcomes = parseJsonField(market.outcomes);
  const outcomePrices = parseJsonField(market.outcomePrices);
  const outcome = String(outcomes[outcomeIndex] || `Outcome ${outcomeIndex + 1}`);
  const { bestBid, bestAsk, spread, askDepth, asks } = bestBook(book);
  const volume24hr = Number(market.volume24hr || 0);
  const liquidity = Number(market.liquidity || 0);
  const tags = tagQuestion(question);
  const eventSlug = marketEventSlug(market);
  const risk = riskProfile({ question, slug: market.slug, eventSlug, outcome, tags });
  const endDate = correctedEndDate(question, market.endDate, market.createdAt || market.updatedAt);
  const days = daysToEnd(endDate);
  const endOk = endDateIsFuture(endDate);
  const stake = PORTFOLIO_USDC * MAX_FRACTION;
  const execution = simulateMarketBuy(asks, stake);
  const fees = feeConfig(market);

  if (!Number.isFinite(bestAsk) || bestAsk <= 0 || bestAsk >= 1) return null;
  if (!Number.isFinite(execution.avgPrice) || execution.avgPrice <= 0 || execution.avgPrice >= 1) return null;

  const { probability, rawProbability, notes, learning } = estimateProbability({
    market,
    outcome,
    ask: bestAsk,
    bid: bestBid,
    spread,
    liquidity,
    volume24hr,
    tags,
    days,
    learningProfile,
  });
  const executionPrice = execution.avgPrice;
  const takerFee = takerFeeForFills(execution.fills, fees.feeRate);
  const totalCost = stake + takerFee;
  const grossGainIfWin = execution.shares - stake;
  const netGainIfWin = execution.shares - stake - takerFee;
  const grossRoiIfWin = totalCost > 0 ? netGainIfWin / totalCost : 0;
  const grossAnnualizedIfWin = days ? grossRoiIfWin * (365 / days) : grossRoiIfWin;
  const spreadOk = spread != null && spread <= MAX_SPREAD;
  const volumeOk = volume24hr >= MIN_VOLUME_24H || liquidity >= MIN_VOLUME_24H;
  const depthOk = execution.fillable;
  const economics = economicsForProbability({ probability, execution, stake, takerFee, totalCost, days, spreadOk, volumeOk, depthOk, endOk });
  const marketProbability = validMarketProbability(outcomePrices[outcomeIndex]) ?? executionPrice;
  const marketEconomics = economicsForProbability({
    probability: marketProbability,
    execution,
    stake,
    takerFee,
    totalCost,
    days,
    spreadOk,
    volumeOk,
    depthOk,
    endOk,
  });
  const rejectReasons = economics.rejectReasons.map((reason) => {
    if (reason === "spread too wide") return `spread ${spread == null ? "n/a" : (spread * 100).toFixed(1) + " pts"} too wide`;
    if (reason === "insufficient ask depth for market buy") return `insufficient ask depth for ${stake.toFixed(2)} USDC market buy`;
    return reason;
  });
  const aiAnalysis = buildHeuristicAnalysis({
    question,
    outcome,
    probability,
    rawProbability,
    executionPrice,
    edge: economics.edge,
    annualizedReturn: economics.annualizedReturn,
    expectedValue: economics.expectedValue,
    notes,
    tags,
    learning,
  });

  return {
    id: `token:${tokenId}`,
    evaluatedAt: nowIso(),
    status: economics.status,
    thesisType: economics.thesisType,
    rejectReasons,
    question,
    slug: market.slug || "",
    eventSlug,
    outcome,
    outcomeCount: outcomes.length,
    marketType: outcomes.length > 2 ? "multi" : reportMarketType({ question, slug: market.slug, eventSlug, outcome }),
    tokenId,
    endDate,
    tags,
    riskCategory: risk.category,
    riskPrimaryEntity: risk.primaryEntity,
    riskGroupKeys: risk.keys,
    riskGroupLabels: risk.labels,
    executionMode: "MARKET_BUY",
    marketPrice: Number(executionPrice.toFixed(4)),
    marketProbability: Number(marketProbability.toFixed(4)),
    bestAsk: Number(bestAsk.toFixed(4)),
    bestBid: bestBid == null ? null : Number(bestBid.toFixed(4)),
    spread: spread == null ? null : Number(spread.toFixed(4)),
    slippage: execution.slippage,
    liquidity: Number(liquidity.toFixed(2)),
    volume24hr: Number(volume24hr.toFixed(2)),
    askDepth: Number(askDepth.toFixed(2)),
    executableDepthUsdc: execution.depthUsdc,
    filledStakeUsdc: execution.filledUsdc,
    executableShares: execution.shares,
    marketFills: execution.fills,
    feesEnabled: fees.feesEnabled,
    feeType: fees.feeType,
    feeRate: fees.feeRate,
    takerFeeUsdc: takerFee,
    totalCostUsdc: Number(totalCost.toFixed(5)),
    grossGainIfWinUsdc: Number(grossGainIfWin.toFixed(4)),
    netGainIfWinUsdc: Number(netGainIfWin.toFixed(4)),
    daysToResolution: days == null ? null : Number(days.toFixed(2)),
    aiProbability: Number(probability.toFixed(4)),
    rawProbability: Number(rawProbability.toFixed(4)),
    edge: Number(economics.edge.toFixed(4)),
    expectedRoi: Number(economics.expectedRoi.toFixed(4)),
    annualizedReturn: Number(economics.annualizedReturn.toFixed(4)),
    aiExpectedValueUsdc: Number(economics.expectedValue.toFixed(4)),
    aiAnnualizedReturn: Number(economics.annualizedReturn.toFixed(4)),
    grossAnnualizedIfWin: Number(grossAnnualizedIfWin.toFixed(4)),
    stakeUsdc: Number(stake.toFixed(2)),
    expectedValueUsdc: Number(economics.expectedValue.toFixed(4)),
    marketExpectedValueUsdc: Number(marketEconomics.expectedValue.toFixed(4)),
    marketExpectedRoi: Number(marketEconomics.expectedRoi.toFixed(4)),
    marketAnnualizedReturn: Number(marketEconomics.annualizedReturn.toFixed(4)),
    maxLossUsdc: Number(totalCost.toFixed(5)),
    aiAnalysis,
    probabilityThesis: aiAnalysis.thesis,
    analysisModel: aiAnalysis.model,
    analysisSummary: [
      `${aiAnalysis.thesis}`,
      `Raw probability ${(rawProbability * 100).toFixed(1)}%, calibrated probability ${(probability * 100).toFixed(1)}% vs simulated market-buy entry ${(executionPrice * 100).toFixed(1)}%.`,
      `Why this probability: ${aiAnalysis.probabilityRationale}`,
      `Why these percentage points: ${aiAnalysis.probabilityPointRationale}`,
      `AI vs Polymarket: ${aiAnalysis.marketComparisonSummary}`,
      `Best ask ${(bestAsk * 100).toFixed(1)}%, slippage ${execution.slippage == null ? "n/a" : (execution.slippage * 100).toFixed(1) + " pts"} for ${stake.toFixed(2)} USDC.`,
      `Polymarket taker fee ${takerFee.toFixed(5)} USDC (${fees.feesEnabled ? `${(fees.feeRate * 100).toFixed(1)}% ${fees.feeType}` : "fee-free market"}).`,
      `Net gain if win ${netGainIfWin.toFixed(4)} USDC; expected annualized return ${(economics.annualizedReturn * 100).toFixed(1)}% with max paper loss ${totalCost.toFixed(5)} USDC.`,
      `Selection thesis type: ${economics.thesisType}.`,
      notes.length ? notes.join(" ") : "No strong qualitative adjustment found.",
    ].join(" "),
    evidence: [
      `question=${question}`,
      `outcome=${outcome}`,
      `riskGroupKeys=${risk.keys.join(",")}`,
      `executionMode=MARKET_BUY`,
      `bestAsk=${bestAsk}`,
      `avgExecutionPrice=${executionPrice}`,
      `filledStakeUsdc=${execution.filledUsdc}`,
      `executableDepthUsdc=${execution.depthUsdc}`,
      `feesEnabled=${fees.feesEnabled}`,
      `feeRate=${fees.feeRate}`,
      `takerFeeUsdc=${takerFee}`,
      `netGainIfWinUsdc=${netGainIfWin}`,
      `rawProbability=${rawProbability}`,
      `calibratedProbability=${probability}`,
      `thesisType=${economics.thesisType}`,
      `learningFactors=${learning.factors.join(",")}`,
      `bestBid=${bestBid ?? "n/a"}`,
      `spread=${spread ?? "n/a"}`,
      `volume24hr=${volume24hr}`,
      `liquidity=${liquidity}`,
      `daysToResolution=${days ?? "n/a"}`,
    ],
  };
}

function withBinaryEvaluationMetadata(evaluation, { yesProbability, yesTokenId, noTokenId }) {
  const { _binaryCounterpart, ...clean } = evaluation;
  return {
    ...clean,
    binaryYesProbability: Number(yesProbability.toFixed(4)),
    binaryYesTokenId: String(yesTokenId || ""),
    binaryNoTokenId: String(noTokenId || ""),
  };
}

function invertedNoModelAnalysis(modelAnalysis, yesProbability) {
  const noProbability = 1 - yesProbability;
  const yesText = pctText(yesProbability);
  const noText = pctText(noProbability);
  const rationale = compactSentence(modelAnalysis?.probabilityRationale || modelAnalysis?.researchSummary || "The model assessed the YES statement from independent public evidence.");
  return {
    ...modelAnalysis,
    direction: "NO",
    thesis: `NO thesis: independent research estimates the YES statement at ${yesText}, so its inverse NO outcome is ${noText}.`,
    finalHumanConclusion: `Gemini estimates that the YES statement has only ${yesText} probability on public evidence; the displayed NO outcome is therefore the more probable inverse at ${noText}.`,
    probabilityRationale: `Gemini's public-evidence assessment assigns ${yesText} to YES. The inverse NO probability is therefore ${noText}. Evidence for the YES assessment: ${rationale}`,
    probabilityPointRationale: `The model first estimated YES at ${yesText}; NO is calculated as 100% minus YES, resulting in ${noText}.`,
    probabilityBridge: `YES ${yesText} -> inverse NO ${noText}.`,
    confidenceTier: modelAnalysis?.confidenceTier || confidenceTier(noProbability),
  };
}

function modelProbabilityForCandidate(result, candidate) {
  const expectedOutcome = String(candidate?.outcome || "").trim().toLowerCase();
  const declaredOutcome = String(result?.evaluatedOutcome || result?.probabilityFor || result?.direction || "").trim().toLowerCase();
  const probability = Number(result?.probability);
  if (!Number.isFinite(probability)) {
    return { valid: false, reason: "Gemini returned no valid probability" };
  }
  if (expectedOutcome && declaredOutcome && declaredOutcome !== expectedOutcome) {
    return {
      valid: false,
      reason: `Gemini labelled probability as ${declaredOutcome.toUpperCase()}, but this pass must return probability for ${expectedOutcome.toUpperCase()} only`,
    };
  }
  return {
    valid: true,
    probability: clamp(probability, 0.01, 0.995),
    declaredOutcome: declaredOutcome || expectedOutcome,
  };
}

async function materializePreferredBinaryOutcome(candidate, yesProbability, modelName, modelAnalysis) {
  const counterpart = candidate?._binaryCounterpart;
  if (!counterpart || yesProbability >= 0.5) {
    return withBinaryEvaluationMetadata(
      refreshEvaluationAfterProbability(candidate, yesProbability, modelName, modelAnalysis),
      {
        yesProbability,
        yesTokenId: counterpart?.yesTokenId || candidate.tokenId,
        noTokenId: counterpart?.tokenId || "",
      },
    );
  }

  const inverseAnalysis = invertedNoModelAnalysis(modelAnalysis, yesProbability);
  try {
    const book = await fetchJson(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(counterpart.tokenId)}`);
    const noEvaluation = evaluateCandidate({
      market: counterpart.market,
      outcomeIndex: counterpart.outcomeIndex,
      tokenId: counterpart.tokenId,
      book,
      learningProfile: counterpart.learningProfile,
    });
    if (!noEvaluation) throw new Error("No executable orderbook data for the inverse NO outcome");
    return withBinaryEvaluationMetadata(
      refreshEvaluationAfterProbability(noEvaluation, 1 - yesProbability, modelName, inverseAnalysis),
      {
        yesProbability,
        yesTokenId: counterpart.yesTokenId || candidate.tokenId,
        noTokenId: counterpart.tokenId,
      },
    );
  } catch (error) {
    const message = `Inverse NO orderbook refresh failed: ${error?.message || String(error)}`;
    return withBinaryEvaluationMetadata(ensureEvaluationErrorMetadata({
      ...candidate,
      id: `token:${counterpart.tokenId}`,
      tokenId: counterpart.tokenId,
      outcome: counterpart.outcome || "No",
      status: "ERROR",
      rawErrorMessage: message,
      rejectReasons: [message],
      aiProbability: Number((1 - yesProbability).toFixed(4)),
      rawProbability: Number((1 - yesProbability).toFixed(4)),
      aiAnalysis: inverseAnalysis,
      probabilityThesis: inverseAnalysis.thesis,
      analysisModel: modelName,
      analysisSummary: `${inverseAnalysis.finalHumanConclusion} ${message}`,
    }), {
      yesProbability,
      yesTokenId: counterpart.yesTokenId || candidate.tokenId,
      noTokenId: counterpart.tokenId,
    });
  }
}

function parseJsonObject(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

async function callOpenAiJson(messages) {
  if (!OPENAI_API_KEY) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages,
      }),
    });
    if (!response.ok) throw new Error(`OpenAI HTTP ${response.status}`);
    const payload = await response.json();
    return parseJsonObject(payload?.choices?.[0]?.message?.content);
  } catch (error) {
    return { error: error.message || String(error) };
  } finally {
    clearTimeout(timeout);
  }
}

function messagesToGeminiText(messages) {
  return messages
    .map((message) => {
      const role = message.role === "system" ? "System" : "User";
      return `${role}:\n${message.content}`;
    })
    .join("\n\n");
}

async function callGeminiJson(messages) {
  if (!GEMINI_API_KEY) return null;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const requestText = `${messagesToGeminiText(messages)}\n\nReturn only one valid JSON object.`;
  const requestBody = {
    generationConfig: {
      responseMimeType: "application/json",
    },
    tools: GEMINI_SEARCH_GROUNDING ? [{ google_search: {} }] : undefined,
    contents: [{
      role: "user",
      parts: [{
        text: requestText,
      }],
    }],
  };

  async function send() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);
    try {
      const response = await fetch(url, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        // Gemini returns the quota dimension and sometimes a retry delay in this body.
        // Preserve enough of it to distinguish RPM/TPM/RPD/project-limit responses.
        throw new Error(`Gemini HTTP ${response.status}${detail ? `: ${detail.slice(0, 1800)}` : ""}`);
      }
      return response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  try {
      const payload = await send();
    const text = payload?.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || "")
      .join("")
      .trim();
    const parsed = parseJsonObject(text);
    if (!parsed || typeof parsed !== "object") return parsed;
    const grounding = payload?.candidates?.[0]?.groundingMetadata || null;
    return {
      ...parsed,
      _grounding: grounding ? {
        webSearchQueries: Array.isArray(grounding.webSearchQueries) ? grounding.webSearchQueries.slice(0, 8) : [],
        sources: Array.isArray(grounding.groundingChunks)
          ? grounding.groundingChunks
              .map((chunk) => chunk.web)
              .filter(Boolean)
              .map((web) => ({ title: web.title || "", uri: web.uri || "" }))
              .filter((source) => source.uri)
              .slice(0, 8)
          : [],
      } : null,
      _usage: {
        promptTokens: Number(payload?.usageMetadata?.promptTokenCount || 0) || null,
        outputTokens: Number(payload?.usageMetadata?.candidatesTokenCount || 0) || null,
        totalTokens: Number(payload?.usageMetadata?.totalTokenCount || 0) || null,
      },
    };
  } catch (error) {
    return { error: error.message || String(error), provider: "gemini", model: GEMINI_MODEL };
  }
}

async function callAiJson(messages) {
  const providers = PRIMARY_AI_PROVIDER === "openai"
    ? ["openai", "gemini"]
    : ["gemini", "openai"];
  let lastError = null;

  for (const provider of providers) {
    const result = provider === "gemini"
      ? await callGeminiJson(messages)
      : await callOpenAiJson(messages);
    if (!result) continue;
    if (!result.error) {
      return {
        ...result,
        _model: provider === "gemini" ? GEMINI_MODEL : OPENAI_MODEL,
        _provider: provider,
      };
    }
    lastError = result;
  }

  return lastError || null;
}

function refreshEvaluationAfterProbability(evaluation, probability, modelName, modelAnalysis) {
  const stake = Number(evaluation.stakeUsdc || PORTFOLIO_USDC * MAX_FRACTION);
  const takerFee = Number(evaluation.takerFeeUsdc || 0);
  const totalCostValue = Number(evaluation.totalCostUsdc || stake + takerFee);
  const execution = {
    avgPrice: Number(evaluation.marketPrice),
    shares: Number(evaluation.executableShares),
  };
  const spread = Number(evaluation.spread);
  const spreadOk = Number.isFinite(spread) && spread <= MAX_SPREAD;
  const liquidity = Number(evaluation.liquidity || 0);
  const volume24hr = Number(evaluation.volume24hr || 0);
  const volumeOk = volume24hr >= MIN_VOLUME_24H || liquidity >= MIN_VOLUME_24H;
  const depthOk = Number(evaluation.filledStakeUsdc || 0) >= stake * 0.999;
  const days = Number(evaluation.daysToResolution);
  const endOk = endDateIsFuture(evaluation.endDate);
  const economics = economicsForProbability({
    probability,
    execution,
    stake,
    takerFee,
    totalCost: totalCostValue,
    days: Number.isFinite(days) ? days : null,
    spreadOk,
    volumeOk,
    depthOk,
    endOk,
  });
  const marketProbability = validMarketProbability(evaluation.marketProbability) ?? Number(evaluation.marketPrice);
  const marketEconomics = Number.isFinite(marketProbability)
    ? economicsForProbability({
        probability: marketProbability,
        execution,
        stake,
        takerFee,
        totalCost: totalCostValue,
        days: Number.isFinite(days) ? days : null,
        spreadOk,
        volumeOk,
        depthOk,
        endOk,
      })
    : null;

  const rejectReasons = economics.rejectReasons.map((reason) => {
    if (reason === "spread too wide") return `spread ${Number.isFinite(spread) ? (spread * 100).toFixed(1) + " pts" : "n/a"} too wide`;
    if (reason === "insufficient ask depth for market buy") return `insufficient ask depth for ${stake.toFixed(2)} USDC market buy`;
    return reason;
  });
  const probabilityRationale = compactSentence(
    modelAnalysis?.probabilityRationale
      || modelAnalysis?.researchSummary
      || modelAnalysis?.thesis
      || evaluation.probabilityThesis
      || "No source-grounded probability rationale was returned by the model."
  );
  const probabilityPointRationale = compactSentence(
    modelAnalysis?.probabilityPointRationale
      || `The model's independent probability is ${pctText(probability)}; the difference versus Polymarket is computed after the forecast from the entry price ${pctText(evaluation.marketPrice)}.`
  );
  const marketComparisonSummary = buildMarketComparisonSummary({
    probability,
    marketProbability: evaluation.marketProbability ?? evaluation.marketPrice,
    rationale: probabilityRationale,
  });
  const aiAnalysis = {
    ...(evaluation.aiAnalysis || {}),
    ...modelAnalysis,
    model: modelName,
    analysisSchemaVersion: modelAnalysis?.analysisSchemaVersion || GROUNDED_AI_ANALYSIS_VERSION,
    probability: Number(probability.toFixed(4)),
    probabilityMethod: "independent-public-research",
    marketImpliedProbability: Number(evaluation.marketProbability ?? evaluation.marketPrice),
    edge: Number(economics.edge.toFixed(4)),
    probabilityRationale,
    probabilityPointRationale,
    marketComparisonSummary,
    expectedValueUsdc: Number(economics.expectedValue.toFixed(4)),
    annualizedReturn: Number(economics.annualizedReturn.toFixed(4)),
    confidenceTier: modelAnalysis?.confidenceTier || confidenceTier(probability),
    provider: modelAnalysis?._provider || modelAnalysis?.provider || null,
  };
  const keyFacts = formatKeyFacts(aiAnalysis.keyFacts);
  const groundingSources = formatGroundingSources(aiAnalysis.groundingSources);
  const evidence = Array.isArray(aiAnalysis.evidence) && aiAnalysis.evidence.length
    ? aiAnalysis.evidence.map((item) => `- ${compactSentence(item)}`).join(" ")
    : "";
  const counterEvidence = Array.isArray(aiAnalysis.counterEvidence) && aiAnalysis.counterEvidence.length
    ? aiAnalysis.counterEvidence.map((item) => `- ${compactSentence(item)}`).join(" ")
    : "";
  const groundedSummary = [
    aiAnalysis.finalHumanConclusion ? `Zaver: ${compactSentence(aiAnalysis.finalHumanConclusion)}` : "",
    aiAnalysis.researchSummary ? `Verejna fakta: ${compactSentence(aiAnalysis.researchSummary)}` : "",
    keyFacts ? `Klicova fakta: ${keyFacts}` : "",
    `AI probability ${(probability * 100).toFixed(1)}%.`,
    aiAnalysis.probabilityRationale ? `Proc tato pravdepodobnost: ${aiAnalysis.probabilityRationale}` : "",
    aiAnalysis.probabilityPointRationale ? `Kalibrace procent: ${aiAnalysis.probabilityPointRationale}` : "",
    aiAnalysis.probabilityBridge ? `Mostek vypoctu: ${compactSentence(aiAnalysis.probabilityBridge)}` : "",
    evidence ? `Evidence: ${evidence}` : "",
    counterEvidence ? `Nejistoty/protiargumenty: ${counterEvidence}` : "",
    groundingSources ? `Zdroje: ${groundingSources}` : "",
  ].filter(Boolean).join(" ");

  return {
    ...evaluation,
    status: economics.status,
    thesisType: economics.thesisType,
    rejectReasons,
    aiProbability: Number(probability.toFixed(4)),
    edge: Number(economics.edge.toFixed(4)),
    expectedRoi: Number(economics.expectedRoi.toFixed(4)),
    annualizedReturn: Number(economics.annualizedReturn.toFixed(4)),
    expectedValueUsdc: Number(economics.expectedValue.toFixed(4)),
    aiExpectedValueUsdc: Number(economics.expectedValue.toFixed(4)),
    aiAnnualizedReturn: Number(economics.annualizedReturn.toFixed(4)),
    marketExpectedValueUsdc: marketEconomics ? Number(marketEconomics.expectedValue.toFixed(4)) : null,
    marketExpectedRoi: marketEconomics ? Number(marketEconomics.expectedRoi.toFixed(4)) : null,
    marketAnnualizedReturn: marketEconomics ? Number(marketEconomics.annualizedReturn.toFixed(4)) : null,
    aiAnalysis,
    probabilityThesis: aiAnalysis.thesis || evaluation.probabilityThesis,
    analysisModel: modelName,
    analysisSummary: groundedSummary || [
      aiAnalysis.thesis || evaluation.probabilityThesis || "AI analysis produced no thesis.",
      `Independent AI probability ${(probability * 100).toFixed(1)}%; Polymarket entry is used only after the AI estimate for EV calculation.`,
      aiAnalysis.probabilityRationale ? `Why this probability: ${aiAnalysis.probabilityRationale}` : "",
      aiAnalysis.probabilityPointRationale ? `Why these percentage points: ${aiAnalysis.probabilityPointRationale}` : "",
      aiAnalysis.marketComparisonSummary ? `AI vs Polymarket: ${aiAnalysis.marketComparisonSummary}` : "",
      `Edge ${(economics.edge * 100).toFixed(1)} pts; expected annualized return ${(economics.annualizedReturn * 100).toFixed(1)}%; thesis type ${economics.thesisType}.`,
    ].filter(Boolean).join(" "),
  };
}

function hasIndependentResearch(item) {
  return item?.aiAnalysis?.probabilityMethod === "independent-public-research";
}

function longEnough(value, minLength) {
  return String(value || "").trim().length >= minLength;
}

function hasStoredGroundedPublicMemo(item) {
  const analysis = item?.aiAnalysis || {};
  return analysis.analysisSchemaVersion === GROUNDED_AI_ANALYSIS_VERSION
    && longEnough(analysis.probabilityRationale, 80)
    && longEnough(analysis.probabilityPointRationale, 70)
    && longEnough(analysis.researchSummary, 140)
    && (Array.isArray(analysis.keyFacts) ? analysis.keyFacts.length >= 2 : Array.isArray(analysis.evidence) && analysis.evidence.length >= 2);
}

function hasGroundedPublicMemo(item) {
  if (item?.selectionStatus === "AI_PENDING" || item?.aiAnalysis?.aiModelStatus === "QUOTA_LIMITED") return false;
  return hasStoredGroundedPublicMemo(item);
}

function formatKeyFact(fact) {
  if (!fact || typeof fact !== "object") return compactSentence(fact);
  const source = compactSentence(fact.source || fact.authority || fact.publisher || "");
  const date = compactSentence(fact.date || fact.asOf || "");
  const impact = compactSentence(fact.impact || fact.effect || "");
  const effect = Number(fact.probabilityEffectPts);
  const effectText = Number.isFinite(effect) ? `${effect >= 0 ? "+" : ""}${effect.toFixed(1)} pp` : "";
  const text = compactSentence(fact.fact || fact.summary || fact.text || "");
  return [
    source || "public source",
    date ? `(${date})` : "",
    text ? `- ${text}` : "",
    impact ? `Impact: ${impact}.` : "",
    effectText ? `Calibration: ${effectText}.` : "",
  ].filter(Boolean).join(" ");
}

function formatKeyFacts(facts = []) {
  const rows = Array.isArray(facts) ? facts.map(formatKeyFact).filter(Boolean).slice(0, 5) : [];
  return rows.length ? rows.map((fact) => `- ${fact}`).join(" ") : "";
}

function formatGroundingSources(sources = []) {
  if (!Array.isArray(sources) || !sources.length) return "";
  return sources
    .map((source) => compactSentence(source.title || source.uri || ""))
    .filter(Boolean)
    .slice(0, 5)
    .join("; ");
}

function isQuotaError(result) {
  return /quota|rate limit|429/i.test(String(result?.error || ""));
}

function markAiAnalysisUnavailable(item, message) {
  const reason = compactSentence(message || "Gemini grounded AI analysis unavailable");
  return ensureEvaluationErrorMetadata({
    ...item,
    status: "ERROR",
    errorType: "AI_ANALYSIS_UNAVAILABLE",
    errorReason: `Gemini grounded AI analysis unavailable: ${reason}. Trade selection is blocked because Gemini analysis is required.`,
    rejectReasons: [
      `Gemini grounded AI analysis unavailable: ${reason}`,
      ...(Array.isArray(item.rejectReasons) ? item.rejectReasons : []),
    ],
    aiAnalysis: {
      ...(item.aiAnalysis || {}),
      aiModelError: reason,
      requiredModel: GEMINI_MODEL,
      provider: "gemini",
    },
    analysisSummary: `Gemini grounded AI analysis unavailable: ${reason}. This opportunity was not allowed to trade from heuristic-only analysis.`,
  });
}

function markAiAnalysisDeferred(item, message) {
  const reason = compactSentence(String(message || "Gemini grounded AI analysis was deferred")
    .replace(/(?:Gemini grounded AI analysis is pending:\s*)+/gi, "")
    .replace(/(?:\.?\s*The item will be retried by a later scheduled evaluation run\.?)+/gi, "")
    .trim());
  return ensureEvaluationErrorMetadata({
    ...item,
    status: "ERROR",
    errorType: "AI_ANALYSIS_PENDING",
    errorReason: `Gemini grounded AI analysis is pending: ${reason}. The item will be retried by a later scheduled evaluation run.`,
    selectionStatus: "AI_PENDING",
    aiAnalysis: {
      ...(item.aiAnalysis || {}),
      aiModelStatus: "QUOTA_LIMITED",
      aiModelError: reason,
      requiredModel: GEMINI_MODEL,
      provider: "gemini",
    },
    analysisSummary: `Gemini grounded AI analysis is pending because the API rate limit or quota was reached: ${reason}. This is not an evaluated opportunity and cannot be selected for trading until a grounded memo is completed.`,
  });
}

function normalizeAiPendingEvaluation(item) {
  const pending = item?.selectionStatus === "AI_PENDING" || item?.aiAnalysis?.aiModelStatus === "QUOTA_LIMITED";
  if (!pending) return item;
  if (!hasStoredGroundedPublicMemo(item)) {
    return markAiAnalysisDeferred(item, item.errorReason || item.aiAnalysis?.aiModelError || item.analysisSummary);
  }
  const { aiModelStatus, aiModelError, ...completedAnalysis } = item.aiAnalysis || {};
  return {
    ...item,
    selectionStatus: null,
    aiAnalysis: completedAnalysis,
    lastAiRetryAt: item.lastAiRetryAt || item.lastSeenAt || nowIso(),
    lastAiRetryStatus: item.lastAiRetryStatus || aiModelStatus || "QUOTA_LIMITED",
    lastAiRetryReason: item.lastAiRetryReason || aiModelError || null,
  };
}

function aiUsageEntries(state) {
  return Array.isArray(state?.aiUsageLog) ? state.aiUsageLog : [];
}

function pacificDateStamp(timestamp) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function nextPacificQuotaReset(now = Date.now()) {
  try {
    const currentDate = pacificDateStamp(now);
    let lower = now;
    let upper = now + 36 * 60 * 60 * 1000;
    while (pacificDateStamp(upper) === currentDate) upper += 24 * 60 * 60 * 1000;
    while (upper - lower > 1000) {
      const midpoint = Math.floor((lower + upper) / 2);
      if (pacificDateStamp(midpoint) === currentDate) lower = midpoint;
      else upper = midpoint;
    }
    // Leave a small safety margin after the provider-side daily reset.
    return new Date(upper + 5 * 60 * 1000).toISOString();
  } catch {
    return new Date(now + 24 * 60 * 60 * 1000).toISOString();
  }
}

function quotaBackoffUntil(error, now = Date.now()) {
  const text = String(error || "");
  const match = text.match(/retry(?:\s+in|[_\s-]*delay)?[^\d]*(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)/i);
  if (match) {
    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    const multiplier = unit.startsWith("h") ? 3600000 : unit.startsWith("m") ? 60000 : 1000;
    if (Number.isFinite(amount) && amount > 0) return new Date(now + amount * multiplier + 5000).toISOString();
  }
  return nextPacificQuotaReset(now);
}

function recordAiQuotaBackoff(state, error) {
  if (!state) return;
  const now = Date.now();
  state.aiUsage = {
    ...aiUsageSnapshot(state, now),
    quotaBlockedUntil: quotaBackoffUntil(error, now),
    quotaBlockedReason: compactSentence(error || "Gemini quota/rate limit response"),
  };
}

function aiUsageSnapshot(state, now = Date.now()) {
  const entries = aiUsageEntries(state).filter((entry) => {
    const time = Date.parse(entry.requestedAt || "");
    return Number.isFinite(time) && time >= now - 86400000;
  });
  const inWindow = (duration) => entries.filter((entry) => Date.parse(entry.requestedAt || "") >= now - duration);
  const minute = inWindow(60000);
  const hour = inWindow(3600000);
  const successful = (rows) => rows.filter((entry) => entry.status === "SUCCESS").length;
  const quotaErrors = (rows) => rows.filter((entry) => entry.status === "QUOTA_LIMITED").length;
  const inputTokens = (rows) => rows.reduce((total, entry) => total + Math.max(0, Number(entry.inputTokens ?? entry.estimatedInputTokens ?? 0)), 0);
  const last = [...entries].sort((a, b) => Date.parse(b.requestedAt || "") - Date.parse(a.requestedAt || ""))[0] || null;
  const nextFromInterval = last ? Date.parse(last.requestedAt || "") + AI_MIN_INTERVAL_SECONDS * 1000 : 0;
  const oldestHour = hour[0] ? Date.parse(hour[0].requestedAt || "") + 3600000 : 0;
  const oldestMinute = minute[0] ? Date.parse(minute[0].requestedAt || "") + 60000 : 0;
  const oldestDay = entries[0] ? Date.parse(entries[0].requestedAt || "") + 86400000 : 0;
  const storedQuotaBlockedUntil = Date.parse(state?.aiUsage?.quotaBlockedUntil || "") || 0;
  const quotaBlockedUntil = storedQuotaBlockedUntil > now ? new Date(storedQuotaBlockedUntil).toISOString() : null;
  const nextAvailable = Math.max(
    nextFromInterval,
    minute.length >= AI_MAX_REQUESTS_PER_MINUTE ? oldestMinute : 0,
    hour.length >= AI_MAX_REQUESTS_PER_HOUR ? oldestHour : 0,
    entries.length >= AI_MAX_REQUESTS_PER_DAY ? oldestDay : 0,
    storedQuotaBlockedUntil > now ? storedQuotaBlockedUntil : 0,
  );
  return {
    model: GEMINI_MODEL,
    requestsLastMinute: minute.length,
    inputTokensLastMinute: inputTokens(minute),
    requestsLastHour: hour.length,
    requestsLast24Hours: entries.length,
    successfulLastMinute: successful(minute),
    successfulLastHour: successful(hour),
    successfulLast24Hours: successful(entries),
    quotaErrorsLast24Hours: quotaErrors(entries),
    maxRequestsPerHour: AI_MAX_REQUESTS_PER_HOUR,
    maxRequestsPerMinute: AI_MAX_REQUESTS_PER_MINUTE,
    maxInputTokensPerMinute: AI_MAX_INPUT_TOKENS_PER_MINUTE,
    maxRequestsPer24Hours: AI_MAX_REQUESTS_PER_DAY,
    executionReserveRequests: AI_EXECUTION_RESERVE_REQUESTS,
    backgroundRequestBudget: Math.max(0, AI_MAX_REQUESTS_PER_DAY - AI_EXECUTION_RESERVE_REQUESTS),
    minIntervalSeconds: AI_MIN_INTERVAL_SECONDS,
    estimatedDailyCapacity: Math.min(AI_MAX_REQUESTS_PER_DAY, Math.floor(86400 / Math.max(1, AI_MIN_INTERVAL_SECONDS))),
    nextAvailableAt: nextAvailable > now ? new Date(nextAvailable).toISOString() : null,
    lastRequestAt: last?.requestedAt || null,
    lastRequestStatus: last?.status || null,
    lastError: last?.error || null,
    quotaBlockedUntil,
    quotaBlockedReason: quotaBlockedUntil ? state?.aiUsage?.quotaBlockedReason || null : null,
    deferredRuns: Number(state?.aiUsage?.deferredRuns || 0),
    lastDeferredAt: state?.aiUsage?.lastDeferredAt || null,
  };
}

function reserveAiRequest(state, estimatedInputTokens = 0, metadata = {}) {
  const entry = {
    id: `ai-${nowIso()}-${Math.random().toString(36).slice(2, 8)}`,
    requestedAt: nowIso(),
    status: "IN_FLIGHT",
    model: GEMINI_MODEL,
    estimatedInputTokens: Math.max(0, Number(estimatedInputTokens) || 0),
    evaluationKey: metadata.evaluationKey || null,
    phase: metadata.phase || "research",
  };
  state.aiUsageLog = [...aiUsageEntries(state), entry].slice(-Math.max(20, AI_USAGE_HISTORY_LIMIT));
  state.aiUsage = aiUsageSnapshot(state);
  return entry.id;
}

function finishAiRequest(state, id, status, error = "", usage = null) {
  state.aiUsageLog = aiUsageEntries(state).map((entry) => entry.id === id
    ? {
        ...entry,
        completedAt: nowIso(),
        status,
        error: error ? compactSentence(error) : null,
        inputTokens: Number(usage?.promptTokens) || entry.estimatedInputTokens || 0,
        outputTokens: Number(usage?.outputTokens) || null,
        totalTokens: Number(usage?.totalTokens) || null,
      }
    : entry);
  state.aiUsage = aiUsageSnapshot(state);
}

function deferAiRun(state, reason) {
  state.aiUsage = {
    ...aiUsageSnapshot(state),
    deferredRuns: Number(state?.aiUsage?.deferredRuns || 0) + 1,
    lastDeferredAt: nowIso(),
    lastDeferredReason: compactSentence(reason),
  };
}

function aiSlotAvailability(state, nextInputTokens = 0) {
  const snapshot = aiUsageSnapshot(state);
  const backgroundDailyBudget = Math.max(0, AI_MAX_REQUESTS_PER_DAY - AI_EXECUTION_RESERVE_REQUESTS);
  if (snapshot.quotaBlockedUntil) {
    return { allowed: false, reason: `Gemini quota backoff until ${snapshot.quotaBlockedUntil}`, snapshot };
  }
  if (snapshot.requestsLast24Hours >= backgroundDailyBudget) {
    return { allowed: false, reason: `AI background daily budget reached (${backgroundDailyBudget}/24h; ${AI_EXECUTION_RESERVE_REQUESTS} reserved for execution)`, snapshot };
  }
  if (snapshot.requestsLastMinute >= AI_MAX_REQUESTS_PER_MINUTE) {
    return { allowed: false, reason: `AI minute request budget reached (${AI_MAX_REQUESTS_PER_MINUTE}/min)`, snapshot };
  }
  if (snapshot.inputTokensLastMinute + Math.max(0, Number(nextInputTokens) || 0) > AI_MAX_INPUT_TOKENS_PER_MINUTE) {
    return { allowed: false, reason: `AI minute input-token budget reached (${AI_MAX_INPUT_TOKENS_PER_MINUTE}/min)`, snapshot };
  }
  if (snapshot.requestsLastHour >= AI_MAX_REQUESTS_PER_HOUR) {
    return { allowed: false, reason: `AI hourly request budget reached (${AI_MAX_REQUESTS_PER_HOUR}/h)`, snapshot };
  }
  if (snapshot.nextAvailableAt) {
    return { allowed: false, reason: `AI request slot is reserved until ${snapshot.nextAvailableAt}`, snapshot };
  }
  return { allowed: true, reason: "AI request slot available", snapshot };
}

async function enrichEvaluationsWithAi(evaluations, learningProfile, state = null) {
  if (!GEMINI_API_KEY || AI_ANALYSIS_LIMIT <= 0) return evaluations;
  const storedByKey = new Map((state?.evaluations || []).map((item) => [evaluationKey(item), item]).filter(([key]) => key));
  const carriedMemos = new Map();
  const candidates = [...evaluations]
    .filter((item) => item.status !== "ERROR")
    .filter((item) => {
      const stored = storedByKey.get(evaluationKey(item));
      if (!stored || !hasGroundedPublicMemo(stored)) return true;
      const lastGroundedAt = Date.parse(stored.evaluatedAt || stored.lastSeenAt || "");
      if (!Number.isFinite(lastGroundedAt) || Date.now() - lastGroundedAt >= 86400000) return true;
      carriedMemos.set(evaluationKey(item), stored);
      return false;
    })
    .sort((a, b) => {
      if (hasGroundedPublicMemo(a) !== hasGroundedPublicMemo(b)) return hasGroundedPublicMemo(a) ? 1 : -1;
      if (hasIndependentResearch(a) !== hasIndependentResearch(b)) return hasIndependentResearch(a) ? 1 : -1;
      if (a.status !== b.status) return a.status === "ELIGIBLE" ? -1 : 1;
      const horizon = compareShorterHorizon(a, b);
      if (horizon !== 0) return horizon;
      if (b.expectedValueUsdc !== a.expectedValueUsdc) return b.expectedValueUsdc - a.expectedValueUsdc;
      return b.annualizedReturn - a.annualizedReturn;
    })
    .slice(0, AI_ANALYSIS_LIMIT);
  const byId = new Map(evaluations.map((item) => [item.id, item]));
  let quotaResponseReceived = false;
  const attemptedIds = new Set();

  for (const [candidateIndex, candidate] of candidates.entries()) {
    if (candidateIndex > 0 && AI_REQUEST_DELAY_MS > 0) {
      await new Promise((resolve) => setTimeout(resolve, AI_REQUEST_DELAY_MS));
    }
    const prompt = {
      task: "Deep-research this prediction-market event and estimate the true probability of the selected outcome using public evidence only.",
      strictRules: [
        "Do not search for, infer from, mention, or use Polymarket prices, odds, order books, volume, liquidity, market-implied probability, or betting consensus.",
        "The probability must be independent of Polymarket. Treat market pricing as unavailable.",
        "Use verified public information with strong causal relevance to the event outcome: official sources, primary data, reputable news, match/event schedules, statements, results, or authoritative statistics.",
        "Search the web if needed. Prefer recent and primary sources. If evidence is weak or conflicting, lower confidence instead of copying market intuition.",
        "Evidence bullets must name the source or authority, include the date/as-of date when available, and state the concrete fact learned, for example an official schedule, regulator release, company statement, weather service, or reputable news outlet.",
        "Do not write generic filler such as 'market conditions suggest' or 'current sentiment indicates' unless it is tied to a named public source and a concrete fact.",
        "For macro/central-bank markets, use official central-bank communications, inflation/jobs/activity data, and reputable reporting about policymakers; do not use prediction-market odds or betting consensus.",
        "For YES/NO markets, estimate the probability that the selected outcome is true by resolution time. For multi-outcome markets, estimate the selected outcome only.",
        "For a binary market, this initial research pass always has candidate.outcome = YES. The probability field must therefore mean probability of YES only. Never select NO or return probability for NO; the application inverts a sub-50% YES result itself after the analysis is complete.",
        "Always include a fact-based human-language sentence explaining why the final probability is exactly in this range, grounded in the public evidence you found.",
        "Always explain the percentage-point calibration: which facts push probability upward, which facts cap or reduce it, and why the final percentage is not merely a vague likely/unlikely label.",
        "Write the rationale in Czech, concise but concrete. Keep each field short enough for a dashboard detail modal.",
        "Return calibrated probability, not trade recommendation. EV is calculated later outside the model.",
      ],
      candidate: {
        question: candidate.question,
        outcome: candidate.outcome,
        endDate: candidate.endDate,
        daysToResolution: candidate.daysToResolution,
        tags: candidate.tags,
        riskGroupLabels: candidate.riskGroupLabels,
      },
      learningProfile: {
        sampleSize: learningProfile.sampleSize,
        brierScore: learningProfile.brierScore,
        calibrationBias: learningProfile.calibrationBias,
        promptRules: learningProfile.promptRules,
      },
      requiredJson: {
        evaluatedOutcome: "must exactly repeat candidate.outcome; for a binary research pass this is always YES",
        probability: "number from 0.01 to 0.995",
        thesis: "one Czech sentence with the core forecast",
        finalHumanConclusion: "one Czech sentence: based on named public facts, why the final probability is exactly this high/low",
        probabilityRationale: "one clear Czech human sentence explaining why the final probability is what it is, based on verified public evidence",
        probabilityPointRationale: "one concise Czech sentence explaining the percentage-point calibration: facts pushing up, facts pushing down, and why the final number lands there",
        probabilityBridge: "one Czech sentence with a rough base-rate/adjustment bridge, e.g. start near X%, add Y pp for fact A, subtract Z pp for uncertainty B",
        confidenceTier: "near-certain | high | edge-watch | uncertain | long-shot",
        keyFacts: [
          {
            source: "source or authority name",
            date: "publication/as-of date if known",
            fact: "specific public fact used",
            impact: "pushes probability up | pushes probability down | caps probability",
            probabilityEffectPts: "approximate percentage-point effect as a signed number",
          },
        ],
        evidence: ["short Czech bullet with a named public source and concrete fact"],
        counterEvidence: ["short Czech bullet with uncertainty or contrary public fact"],
        researchSummary: "2-4 concise Czech sentences explaining the public evidence chain, with named facts rather than generic commentary",
        sourceQuality: "primary | reputable-news | mixed | weak",
      },
    };
    const messages = [
      { role: "system", content: "You are a cautious forecasting analyst doing source-grounded public research. You must ignore prediction-market pricing and betting consensus. You write concrete Czech rationales based on named public facts, not generic trading commentary. Return only valid JSON." },
      { role: "user", content: JSON.stringify(prompt) },
    ];
    const estimatedInputTokens = Math.ceil(messagesToGeminiText(messages).length / 4) + 128;
    if (state) {
      const slot = aiSlotAvailability(state, estimatedInputTokens);
      if (!slot.allowed) {
        deferAiRun(state, slot.reason);
        quotaResponseReceived = true;
        break;
      }
    }
    const requestId = state ? reserveAiRequest(state, estimatedInputTokens, { evaluationKey: evaluationKey(candidate), phase: "research" }) : null;
    attemptedIds.add(candidate.id);
    let result = await callGeminiJson(messages);
    if (!result || result.error) {
      const message = result?.error || "Gemini public-research analysis unavailable";
      const quotaLimited = isQuotaError(result);
      if (requestId) finishAiRequest(state, requestId, quotaLimited ? "QUOTA_LIMITED" : "ERROR", message);
      if (quotaLimited) recordAiQuotaBackoff(state, message);
      const deferredMessage = quotaLimited && state?.aiUsage?.quotaBlockedUntil
        ? `${message}. Retry deferred until ${state.aiUsage.quotaBlockedUntil}`
        : message;
      byId.set(candidate.id, REQUIRE_GEMINI && !quotaLimited
        ? markAiAnalysisUnavailable(candidate, message)
        : quotaLimited
          ? markAiAnalysisDeferred(candidate, deferredMessage)
          : {
            ...candidate,
            aiAnalysis: {
              ...(candidate.aiAnalysis || {}),
              aiModelError: message,
            },
          });
      if (AI_STOP_ON_QUOTA_ERROR && quotaLimited) {
        quotaResponseReceived = true;
        break;
      }
      continue;
    }
    if (requestId) finishAiRequest(state, requestId, "SUCCESS", "", result._usage);

    const researchResult = result;
    let criticResult = null;
    if (AI_CRITIC_ENABLED) {
      await new Promise((resolve) => setTimeout(resolve, AI_REQUEST_DELAY_MS));
      const criticPrompt = {
        task: "Independently audit this prediction-market research. Search public sources yourself, challenge omissions and calibration, then return the final probability. Do not use market prices or betting consensus.",
        candidate: prompt.candidate,
        preliminaryResearch: {
          probability: result.probability,
          thesis: result.thesis,
          keyFacts: result.keyFacts,
          evidence: result.evidence,
          counterEvidence: result.counterEvidence,
          probabilityRationale: result.probabilityRationale,
        },
        strictRules: prompt.strictRules,
        requiredJson: prompt.requiredJson,
      };
      const criticMessages = [
        { role: "system", content: "You are an independent forecasting critic. Verify public facts yourself, correct unsupported claims, and return only valid JSON in Czech." },
        { role: "user", content: JSON.stringify(criticPrompt) },
      ];
      const criticEstimate = Math.ceil(messagesToGeminiText(criticMessages).length / 4) + 128;
      if (state) {
        const slot = aiSlotAvailability(state, criticEstimate);
        if (!slot.allowed) {
          deferAiRun(state, slot.reason);
          byId.set(candidate.id, markAiAnalysisDeferred(candidate, `Gemini critic pass deferred: ${slot.reason}`));
          quotaResponseReceived = true;
          break;
        }
      }
      const criticRequestId = state ? reserveAiRequest(state, criticEstimate, { evaluationKey: evaluationKey(candidate), phase: "critic" }) : null;
      criticResult = await callGeminiJson(criticMessages);
      if (!criticResult || criticResult.error) {
        const message = criticResult?.error || "Gemini critic analysis unavailable";
        const quotaLimited = isQuotaError(criticResult);
        if (criticRequestId) finishAiRequest(state, criticRequestId, quotaLimited ? "QUOTA_LIMITED" : "ERROR", message);
        if (quotaLimited) recordAiQuotaBackoff(state, message);
        const deferredMessage = quotaLimited && state?.aiUsage?.quotaBlockedUntil
          ? `${message}. Retry deferred until ${state.aiUsage.quotaBlockedUntil}`
          : message;
        byId.set(candidate.id, quotaLimited ? markAiAnalysisDeferred(candidate, deferredMessage) : markAiAnalysisUnavailable(candidate, message));
        if (AI_STOP_ON_QUOTA_ERROR && quotaLimited) {
          quotaResponseReceived = true;
          break;
        }
        continue;
      }
      if (criticRequestId) finishAiRequest(state, criticRequestId, "SUCCESS", "", criticResult._usage);
      result = criticResult;
    }
    const probabilityResult = modelProbabilityForCandidate(result, candidate);
    if (!probabilityResult.valid) {
      if (requestId) finishAiRequest(state, requestId, "ERROR", probabilityResult.reason);
      byId.set(candidate.id, markAiAnalysisUnavailable(candidate, probabilityResult.reason));
      continue;
    }
    const probability = probabilityResult.probability;
    const modelAnalysis = {
      direction: outcomeKind(candidate.outcome),
      evaluatedOutcome: probabilityResult.declaredOutcome,
      thesis: result.thesis || candidate.probabilityThesis,
      finalHumanConclusion: result.finalHumanConclusion || "",
      probabilityRationale: result.probabilityRationale || "",
      probabilityPointRationale: result.probabilityPointRationale || "",
      probabilityBridge: result.probabilityBridge || "",
      confidenceTier: result.confidenceTier || confidenceTier(probability),
      keyFacts: Array.isArray(result.keyFacts) ? result.keyFacts.slice(0, 6) : [],
      evidence: Array.isArray(result.evidence) ? result.evidence.slice(0, 6) : [],
      counterEvidence: Array.isArray(result.counterEvidence) ? result.counterEvidence.slice(0, 6) : [],
      researchSummary: result.researchSummary || "",
      sourceQuality: result.sourceQuality || "",
      analysisSchemaVersion: GROUNDED_AI_ANALYSIS_VERSION,
      groundingQueries: result._grounding?.webSearchQueries || [],
      groundingSources: result._grounding?.sources || [],
      source: "gemini-grounded-public-research",
      researchPass: {
        probability: Number(researchResult.probability) || null,
        thesis: researchResult.thesis || "",
        keyFacts: Array.isArray(researchResult.keyFacts) ? researchResult.keyFacts.slice(0, 6) : [],
      },
      aiRequestUsage: {
        totalRequests: AI_CRITIC_ENABLED ? 2 : 1,
        research: researchResult._usage || null,
        critic: criticResult?._usage || null,
      },
      _provider: "gemini",
    };
    byId.set(candidate.id, await materializePreferredBinaryOutcome(
      candidate,
      probability,
      result._model || GEMINI_MODEL,
      modelAnalysis,
    ));
  }
  // A 429 is authoritative for this run. Persist only requests that Gemini
  // actually received (plus existing carried memos), leaving all other market
  // observations untouched for the next scheduled evaluation.
  const output = quotaResponseReceived
    ? evaluations.filter((item) => attemptedIds.has(item.id) || carriedMemos.has(evaluationKey(item)))
    : evaluations;

  return output.map((item) => {
    const carried = carriedMemos.get(evaluationKey(item));
    if (!carried) {
      const { _binaryCounterpart, ...clean } = byId.get(item.id) || item;
      return clean;
    }
    const refreshed = refreshEvaluationAfterProbability(
      item,
      Number(carried.aiProbability),
      carried.analysisModel || carried.aiAnalysis?.model || GEMINI_MODEL,
      carried.aiAnalysis || {},
    );
    const { _binaryCounterpart, ...clean } = refreshed;
    return clean;
  });
}

function openRisk(trades) {
  return trades
    .filter((trade) => OPEN_STATUSES.has(trade.status))
    .reduce((sum, trade) => sum + Number(trade.maxLossUsdc || trade.stakeUsdc || 0), 0);
}

function alreadyOpen(trades, tokenId) {
  return trades.some((trade) => OPEN_STATUSES.has(trade.status) && trade.tokenId === tokenId);
}

function riskBlock(candidate, trades) {
  const candidateKeys = new Set(Array.isArray(candidate.riskGroupKeys) ? candidate.riskGroupKeys : []);
  if (!candidateKeys.size) return null;

  for (const trade of trades.filter((item) => OPEN_STATUSES.has(item.status))) {
    const tradeKeys = Array.isArray(trade.riskGroupKeys) ? trade.riskGroupKeys : [];
    const overlap = tradeKeys.filter((key) => candidateKeys.has(key));
    if (overlap.length) {
      return {
        tradeId: trade.id,
        question: trade.question,
        outcome: trade.outcome,
        overlap,
      };
    }
  }

  return null;
}

function riskBlockReason(block) {
  const overlap = block?.overlap?.slice(0, 3).join(", ") || "risk group";
  return `open correlated paper trade ${block.tradeId} already covers ${overlap}`;
}

function candidateSelectionDecision({ candidate, portfolioState, selected, action, reason }) {
  if (!candidate) return "not selected: missing candidate";
  if (selected && String(candidate.tokenId || "") === String(selected.tokenId || "")) {
    return "selected for trade";
  }
  const activeTrades = Array.isArray(portfolioState?.trades) ? portfolioState.trades : [];
  const duplicate = activeTrades.find((trade) => OPEN_STATUSES.has(trade.status) && trade.tokenId === candidate.tokenId);
  if (duplicate) return `not selected: same token already open in trade ${duplicate.id}`;
  const block = riskBlock(candidate, activeTrades);
  if (block) return `not selected: ${riskBlockReason(block)}`;
  if (String(action || "").toUpperCase() === "SKIP" && reason) return `not selected: batch skipped - ${reason}`;
  if (selected) return "not selected: lower priority than selected candidate after portfolio ranking";
  return "not selected: no selectable candidate was recorded";
}

function rewardRiskRatio(item) {
  const reward = Number(item.netGainIfWinUsdc ?? item.grossGainIfWinUsdc);
  const risk = Number(item.totalCostUsdc || item.maxLossUsdc || item.stakeUsdc || 0);
  if (!Number.isFinite(reward) || !Number.isFinite(risk) || reward <= 0 || risk <= 0) return null;
  return reward / risk;
}

function remainingDaysValue(item) {
  const endTime = Date.parse(item.endDate || "");
  if (Number.isFinite(endTime)) return Math.max(1 / 24, (endTime - Date.now()) / 86400000);
  return Math.max(1 / 24, daysValue(item));
}

function tradeCurrentValue(trade) {
  const stored = Number(trade.currentValueUsdc);
  if (Number.isFinite(stored) && stored >= 0) return stored;
  const shares = Number(trade.shares);
  const price = Number(trade.currentPrice ?? trade.entryPrice);
  if (Number.isFinite(shares) && Number.isFinite(price) && shares >= 0 && price >= 0) {
    return shares * price;
  }
  return null;
}

function tradeContinuationEconomics(trade, strategy = PAPER_STRATEGIES.conservative) {
  const currentValue = tradeCurrentValue(trade);
  const shares = Number(trade.shares);
  const probability = Number(strategy.probabilitySource === "polymarket"
    ? (trade.marketProbability ?? trade.sourceEvaluation?.marketProbability ?? trade.entryPrice)
    : (trade.aiProbability ?? trade.sourceEvaluation?.aiProbability));
  const remainingDays = remainingDaysValue(trade);
  const reward = Number.isFinite(shares) && Number.isFinite(currentValue) ? Math.max(0, shares - currentValue) : null;
  const expectedValue = Number.isFinite(probability) && Number.isFinite(shares) && Number.isFinite(currentValue)
    ? (probability * shares) - currentValue
    : Number(strategy.probabilitySource === "polymarket"
      ? (trade.marketExpectedValueUsdc ?? trade.sourceEvaluation?.marketExpectedValueUsdc)
      : trade.expectedValueUsdc);
  const expectedRoi = Number.isFinite(expectedValue) && Number.isFinite(currentValue) && currentValue > 0
    ? expectedValue / currentValue
    : null;
  const annualizedReturn = Number.isFinite(expectedRoi)
    ? expectedRoi * (365 / remainingDays)
    : Number(strategy.probabilitySource === "polymarket"
      ? (trade.marketAnnualizedReturn ?? trade.sourceEvaluation?.marketAnnualizedReturn)
      : trade.annualizedReturn);
  const rewardRisk = Number.isFinite(reward) && Number.isFinite(currentValue) && currentValue > 0 ? reward / currentValue : null;
  const score = strategy.selectionOrder === "highest_reward_risk_first" ? rewardRisk : annualizedReturn;
  return {
    currentValue,
    reward,
    expectedValue,
    annualizedReturn,
    rewardRisk,
    score,
  };
}

function candidateRotationScore(candidate, strategy = PAPER_STRATEGIES.conservative) {
  return strategy.selectionOrder === "highest_reward_risk_first"
    ? rewardRiskRatio(candidate)
    : portfolioEconomics(candidate, strategy).annualizedReturn;
}

function openTrades(trades) {
  return trades.filter((trade) => OPEN_STATUSES.has(trade.status));
}

function openExposureProfile(portfolioStates = []) {
  const tagCounts = {};
  const categoryCounts = {};
  const riskCounts = {};
  const rows = [];
  for (const portfolioState of portfolioStates) {
    for (const trade of openTrades(portfolioState?.trades || [])) {
      const tags = Array.isArray(trade.tags) && trade.tags.length ? trade.tags : tagQuestion(trade.question || "");
      const category = trade.riskCategory || (tags.includes("sports") ? "sports" : tags[0] || "general");
      for (const tag of tags) {
        tagCounts[tag] = Number(tagCounts[tag] || 0) + 1;
      }
      categoryCounts[category] = Number(categoryCounts[category] || 0) + 1;
      const keys = Array.isArray(trade.riskGroupKeys) && trade.riskGroupKeys.length
        ? trade.riskGroupKeys
        : riskProfile({
            question: trade.question,
            slug: trade.slug,
            eventSlug: trade.eventSlug,
            outcome: trade.outcome,
            tags,
          }).keys;
      for (const key of keys) {
        riskCounts[key] = Number(riskCounts[key] || 0) + 1;
      }
      rows.push({
        strategyId: portfolioState?.id || trade.strategyId || "paper",
        tradeId: trade.id || null,
        question: trade.question || "",
        outcome: trade.outcome || "",
        tags,
        category,
        riskGroupKeys: keys,
      });
    }
  }
  return { tagCounts, categoryCounts, riskCounts, openTrades: rows };
}

function marketDiversificationScore(market, exposure) {
  const question = String(market?.question || "");
  const tags = tagQuestion(question);
  const eventSlug = marketEventSlug(market);
  const risk = riskProfile({ question, slug: market?.slug, eventSlug, outcome: "", tags });
  const category = risk.category || tags[0] || "general";
  let score = 0;
  const reasons = [];

  if (!Number(exposure.categoryCounts[category] || 0)) {
    score += 5;
    reasons.push(`new category ${category}`);
  }
  const newTags = tags.filter((tag) => !Number(exposure.tagCounts[tag] || 0));
  if (newTags.length) {
    score += Math.min(4, newTags.length * 2);
    reasons.push(`new tags ${newTags.slice(0, 3).join(", ")}`);
  }
  const topicKeys = risk.keys.filter((key) => key.startsWith("topic:"));
  const newTopics = topicKeys.filter((key) => !Number(exposure.riskCounts[key] || 0));
  if (newTopics.length) {
    score += Math.min(4, newTopics.length * 2);
    reasons.push(`new topics ${newTopics.slice(0, 3).join(", ")}`);
  }
  const overlapKeys = risk.keys.filter((key) => Number(exposure.riskCounts[key] || 0));
  if (overlapKeys.length) {
    score -= Math.min(6, overlapKeys.length * 2);
    reasons.push(`overlaps ${overlapKeys.slice(0, 3).join(", ")}`);
  }

  return {
    score,
    tags,
    category,
    riskGroupKeys: risk.keys,
    reasons,
  };
}

function heldHours(trade) {
  const opened = Date.parse(trade.openedAt || trade.date || "");
  if (!Number.isFinite(opened)) return Infinity;
  return Math.max(0, (Date.now() - opened) / 3600000);
}

function daysValue(item) {
  const days = Number(item.daysToResolution);
  return Number.isFinite(days) ? days : Infinity;
}

function compareShorterHorizon(a, b) {
  const delta = daysValue(a) - daysValue(b);
  return Number.isFinite(delta) ? delta : 0;
}

function isNoOutcome(item) {
  return /^no$/i.test(String(item?.outcome || "").trim());
}

function similarPolymarketProbability(a, b, tolerance = 0.03) {
  const aPrice = Number(a?.marketProbability ?? a?.marketPrice ?? a?.entryPrice ?? a?.currentPrice);
  const bPrice = Number(b?.marketProbability ?? b?.marketPrice ?? b?.entryPrice ?? b?.currentPrice);
  return Number.isFinite(aPrice) && Number.isFinite(bPrice) && Math.abs(aPrice - bPrice) <= tolerance;
}

function preferNoWhenComparable(a, b, scoreDelta = 0) {
  if (!similarPolymarketProbability(a, b)) return 0;
  if (Math.abs(scoreDelta) > 0.05) return 0;
  if (isNoOutcome(a) === isNoOutcome(b)) return 0;
  return isNoOutcome(a) ? -1 : 1;
}

function strategyMaxResolutionDays(strategy) {
  const days = Number(strategy.maxResolutionDays);
  return Number.isFinite(days) && days > 0 ? days : DEFAULT_MAX_RESOLUTION_DAYS;
}

function normalizeTradeCadenceHours(value, fallback = 1) {
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0) return fallback;
  return Math.min(168, Math.max(1, Math.round(hours)));
}

function hourKeyToDate(key) {
  const match = String(key || "").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})$/);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4])));
  return Number.isFinite(date.getTime()) ? date : null;
}

function cadenceBlocked(lastTradeHour, currentHour, cadenceHours) {
  const cadence = normalizeTradeCadenceHours(cadenceHours, 1);
  if (cadence <= 1) return lastTradeHour === currentHour;
  const previous = hourKeyToDate(lastTradeHour);
  const current = hourKeyToDate(currentHour);
  if (!previous || !current) return false;
  return (current.getTime() - previous.getTime()) / 3600000 < cadence;
}

function latestPortfolioRunAt(portfolioState = {}) {
  const isTradeEvaluationRun = (row = {}) => {
    if (row.refreshOnly || row.reportOnly) return false;
    return !["REFRESH", "REPORT", "CADENCE_WAIT"].includes(String(row.action || "").toUpperCase());
  };
  const candidates = [
    isTradeEvaluationRun(portfolioState.lastDecision) ? portfolioState.lastDecision?.runAt : null,
    ...(Array.isArray(portfolioState.runLog) ? portfolioState.runLog.filter(isTradeEvaluationRun).map((row) => row.runAt) : []),
  ];
  return candidates.find((value) => Number.isFinite(Date.parse(value || ""))) || null;
}

function portfolioRunDue(portfolioState, strategy, now = new Date()) {
  if (!SCHEDULED_CADENCE_POLL || MANUAL_RUN_ONCE) return true;
  const lastRunAt = latestPortfolioRunAt(portfolioState);
  if (!lastRunAt) return true;
  const last = Date.parse(lastRunAt);
  if (!Number.isFinite(last)) return true;
  const cadence = normalizeTradeCadenceHours(strategy.tradeCadenceHours, 1);
  return (now.getTime() - last) / 3600000 >= cadence;
}

function dueExecutionStrategies(state) {
  const now = new Date();
  return executionStrategies().filter((strategy) => {
    const portfolioState = state.paperPortfolios?.[strategy.id];
    return portfolioRunDue(portfolioState, strategy, now);
  });
}

function latestNewTrade(portfolioState = {}) {
  return (portfolioState.trades || [])
    .filter((trade) => !trade.openedAfterRotationOfTradeId)
    .sort((a, b) => tradeUpdateTime(b) - tradeUpdateTime(a))[0] || null;
}

function strategyEligibleCandidates(eligible, strategy) {
  const maxResolutionDays = strategyMaxResolutionDays(strategy);
  let rows = [...eligible].filter((item) => {
    const tokenId = String(item?.tokenId || item?.clobTokenId || item?.assetId || "");
    if (strategy.excludedCandidateTokenIds?.has(tokenId)) return false;
    const minProbability = Number(strategy.minProbability);
    const selectedProbability = Number(strategy.probabilitySource === "polymarket" ? (item.marketProbability ?? item.marketPrice) : item.aiProbability);
    if (Number.isFinite(minProbability) && (!Number.isFinite(selectedProbability) || selectedProbability < minProbability)) return false;
    if (daysValue(item) > maxResolutionDays) return false;
    const minLiquidityUsdc = Number(strategy.minLiquidityUsdc);
    if (Number.isFinite(minLiquidityUsdc) && Number(item.liquidity || 0) < minLiquidityUsdc) return false;
    const minimumNetYield = Math.max(0, Number(strategy.minNetYield) || 0);
    const candidateNetYield = netYieldAfterFees(item);
    if (!Number.isFinite(candidateNetYield) || candidateNetYield < minimumNetYield) return false;
    return true;
  });
  if (strategy.requireMostProbableOutcome) {
    rows = rows.filter((item) => item.marketType === "multi" || reportMarketType(item) === "multi");
  }
  return rows;
}

function netYieldAfterFees(item = {}) {
  const stored = Number(item.netYield);
  if (Number.isFinite(stored)) return stored;
  const gain = Number(item.netGainIfWinUsdc);
  const cost = Number(item.totalCostUsdc ?? item.stakeUsdc);
  if (!Number.isFinite(gain) || !Number.isFinite(cost) || cost <= 0) return null;
  return gain / cost;
}

function portfolioEconomics(item, strategy = PAPER_STRATEGIES.conservative) {
  const probabilitySource = strategy.probabilitySource === "polymarket" ? "polymarket" : "ai";
  const storedPotential = Number(item.potentialAnnualizedReturn);
  const netYield = Number(item.netYield);
  const potentialAnnualized = Number.isFinite(storedPotential)
    ? storedPotential
    : annualizedPotentialReturn(netYield, daysValue(item));
  const annualizedValue = Number(probabilitySource === "polymarket" ? potentialAnnualized : item.annualizedReturn);
  const expectedValue = Number(probabilitySource === "polymarket" ? item.netGainIfWinUsdc : item.expectedValueUsdc);
  return {
    probabilitySource,
    annualizedReturn: Number.isFinite(annualizedValue) ? annualizedValue : null,
    expectedValueUsdc: Number.isFinite(expectedValue) ? expectedValue : null,
  };
}

function portfolioFilterResult(item, strategy) {
  const reasons = [];
  const tokenId = String(item?.tokenId || item?.clobTokenId || item?.assetId || "");
  const status = String(item.status || "").toUpperCase();
  const minProbability = Number(strategy.minProbability);
  const maxResolutionDays = strategyMaxResolutionDays(strategy);
  const minLiquidityUsdc = Number(strategy.minLiquidityUsdc);
  const minNetYield = Math.max(0, Number(strategy.minNetYield) || 0);
  const probabilitySource = strategy.probabilitySource === "polymarket" ? "polymarket" : "ai";
  const selectedProbability = Number(probabilitySource === "polymarket" ? (item.marketProbability ?? item.marketPrice) : item.aiProbability);
  const days = daysValue(item);
  const liquidity = Number(item.liquidity || 0);
  const marketType = item.marketType || reportMarketType(item);
  const economics = portfolioEconomics(item, strategy);
  const annualizedReturn = economics.annualizedReturn;
  const returnMetric = probabilitySource === "polymarket" ? "Potential p.a." : "EV p.a.";

  if (strategy.excludedCandidateTokenIds?.has(tokenId)) reasons.push("manually excluded from this paper portfolio");
  if (probabilitySource === "ai" && status !== "ELIGIBLE") reasons.push(`base status ${status || "UNKNOWN"} is not ELIGIBLE`);
  if (probabilitySource === "polymarket" && ["ERROR", "RESOLVED", "CLOSED", "FINALIZED", "SETTLED"].includes(status)) {
    reasons.push(`base status ${status || "UNKNOWN"} is not executable`);
  }
  if (probabilitySource === "ai" && REQUIRE_GEMINI && !hasGroundedPublicMemo(item)) reasons.push("grounded Gemini analysis is pending");
  if (Number.isFinite(minProbability) && (!Number.isFinite(selectedProbability) || selectedProbability < minProbability)) {
    const label = probabilitySource === "polymarket" ? "Polymarket probability" : "AI probability";
    reasons.push(`${label} ${Number.isFinite(selectedProbability) ? (selectedProbability * 100).toFixed(1) : "-"}% below ${(minProbability * 100).toFixed(1)}%`);
  }
  if (!Number.isFinite(annualizedReturn)) {
    const label = probabilitySource === "polymarket" ? "Polymarket probability" : "AI probability";
    reasons.push(`missing ${label} ${returnMetric}`);
  } else if (annualizedReturn <= 0) {
    const label = probabilitySource === "polymarket" ? "Polymarket probability" : "AI probability";
    reasons.push(`${label} ${returnMetric} ${(annualizedReturn * 100).toFixed(1)}% is non-profitable after fees`);
  } else if (probabilitySource !== "polymarket" && annualizedReturn < MIN_ANNUAL_RETURN) {
    const label = probabilitySource === "polymarket" ? "Polymarket probability" : "AI probability";
    reasons.push(`${label} ${returnMetric} ${(annualizedReturn * 100).toFixed(1)}% below ${(MIN_ANNUAL_RETURN * 100).toFixed(1)}%`);
  }
  if (days > maxResolutionDays) {
    reasons.push(`resolution ${Number.isFinite(days) ? days.toFixed(2) : "-"} days exceeds max ${maxResolutionDays}`);
  }
  if (Number.isFinite(minLiquidityUsdc) && liquidity < minLiquidityUsdc) {
    reasons.push(`liquidity ${liquidity.toFixed(2)} below ${minLiquidityUsdc.toFixed(2)} USDC`);
  }
  const candidateNetYield = netYieldAfterFees(item);
  if (!Number.isFinite(candidateNetYield) || candidateNetYield < minNetYield) {
    reasons.push(`net profit ${Number.isFinite(candidateNetYield) ? `${(candidateNetYield * 100).toFixed(1)}%` : "-"} below ${(minNetYield * 100).toFixed(1)}% after fees`);
  }
  if (strategy.requireMostProbableOutcome && marketType !== "multi") {
    reasons.push(`market type ${marketType || "-"} is not multichoice`);
  }

  return {
    eligible: reasons.length === 0,
    reasons,
  };
}

function incrementCount(counts, key) {
  counts[key] = Number(counts[key] || 0) + 1;
}

function sortEligibleForStrategy(eligible, strategy = PAPER_STRATEGIES.conservative) {
  const strategyRows = strategyEligibleCandidates(eligible, strategy);
  const rows = strategyRows;
  if (strategy.selectionOrder === "highest_reward_risk_first") {
    return rows.sort((a, b) => {
      const aRatio = rewardRiskRatio(a) ?? -Infinity;
      const bRatio = rewardRiskRatio(b) ?? -Infinity;
      if (bRatio !== aRatio) {
        const noPreference = preferNoWhenComparable(a, b, bRatio - aRatio);
        if (noPreference) return noPreference;
        return bRatio - aRatio;
      }
      const horizon = compareShorterHorizon(a, b);
      if (horizon !== 0) return horizon;
      const aEconomics = portfolioEconomics(a, strategy);
      const bEconomics = portfolioEconomics(b, strategy);
      if (bEconomics.annualizedReturn !== aEconomics.annualizedReturn) return bEconomics.annualizedReturn - aEconomics.annualizedReturn;
      return bEconomics.expectedValueUsdc - aEconomics.expectedValueUsdc;
    });
  }
  return rows.sort((a, b) => {
    const aEconomics = portfolioEconomics(a, strategy);
    const bEconomics = portfolioEconomics(b, strategy);
    if (bEconomics.annualizedReturn !== aEconomics.annualizedReturn) {
      const noPreference = preferNoWhenComparable(a, b, bEconomics.annualizedReturn - aEconomics.annualizedReturn);
      if (noPreference) return noPreference;
      return bEconomics.annualizedReturn - aEconomics.annualizedReturn;
    }
    const horizon = compareShorterHorizon(a, b);
    if (horizon !== 0) return horizon;
    return bEconomics.expectedValueUsdc - aEconomics.expectedValueUsdc;
  });
}

function scaledPaperEconomics(best, stake) {
  const baseStake = Number(best.stakeUsdc || best.filledStakeUsdc || 0);
  const targetStake = Number(stake);
  const scale = baseStake > 0 && Number.isFinite(targetStake) ? targetStake / baseStake : 1;
  const shares = Number(best.executableShares);
  const takerFee = Number(best.takerFeeUsdc || 0);
  const totalCost = Number(best.totalCostUsdc || baseStake + takerFee);
  const grossGain = Number(best.grossGainIfWinUsdc);
  const netGain = Number(best.netGainIfWinUsdc);
  const maxLoss = Number(best.maxLossUsdc || totalCost);
  const expectedValue = Number(best.expectedValueUsdc);
  const fills = Array.isArray(best.marketFills) ? best.marketFills.map((fill) => ({
    ...fill,
    size: Number((Number(fill.size || 0) * scale).toFixed(4)),
    costUsdc: Number((Number(fill.costUsdc || 0) * scale).toFixed(4)),
  })) : [];

  return {
    scale,
    shares: Number.isFinite(shares) ? Number((shares * scale).toFixed(4)) : shares,
    takerFeeUsdc: Number.isFinite(takerFee) ? Number((takerFee * scale).toFixed(5)) : takerFee,
    totalCostUsdc: Number.isFinite(totalCost) ? Number((totalCost * scale).toFixed(5)) : totalCost,
    grossGainIfWinUsdc: Number.isFinite(grossGain) ? Number((grossGain * scale).toFixed(4)) : grossGain,
    netGainIfWinUsdc: Number.isFinite(netGain) ? Number((netGain * scale).toFixed(4)) : netGain,
    maxLossUsdc: Number.isFinite(maxLoss) ? Number((maxLoss * scale).toFixed(5)) : maxLoss,
    expectedValueUsdc: Number.isFinite(expectedValue) ? Number((expectedValue * scale).toFixed(4)) : expectedValue,
    marketFills: fills,
  };
}

function paperTradeFromCandidate(best, strategy, today, stake) {
  const economics = scaledPaperEconomics(best, stake);
  const selectionEconomics = portfolioEconomics(best, strategy);
  const selectedExpectedValue = Number.isFinite(selectionEconomics.expectedValueUsdc)
    ? Number((selectionEconomics.expectedValueUsdc * economics.scale).toFixed(4))
    : null;
  return {
    id: `paper-${strategy.id}-${today}-${best.tokenId}`,
    strategyId: strategy.id,
    strategyLabel: strategy.label,
    selectionMetric: strategy.selectionMetric,
    openedAt: nowIso(),
    date: today,
    status: "OPEN",
    sourceEvaluationId: best.id,
    sourceEvaluation: {
      id: best.id,
      evaluatedAt: best.evaluatedAt,
      status: best.status,
      thesisType: best.thesisType,
      aiProbability: best.aiProbability,
      rawProbability: best.rawProbability,
      marketPrice: best.marketPrice,
      marketProbability: best.marketProbability,
      edge: best.edge,
      expectedValueUsdc: selectedExpectedValue,
      annualizedReturn: selectionEconomics.annualizedReturn,
      aiExpectedValueUsdc: Number.isFinite(Number(best.aiExpectedValueUsdc ?? best.expectedValueUsdc)) ? Number((Number(best.aiExpectedValueUsdc ?? best.expectedValueUsdc) * economics.scale).toFixed(4)) : null,
      aiAnnualizedReturn: best.aiAnnualizedReturn ?? best.annualizedReturn,
      marketExpectedValueUsdc: Number.isFinite(Number(best.marketExpectedValueUsdc)) ? Number((Number(best.marketExpectedValueUsdc) * economics.scale).toFixed(4)) : null,
      marketAnnualizedReturn: best.marketAnnualizedReturn ?? null,
      probabilitySource: strategy.probabilitySource,
      probabilityThesis: best.probabilityThesis,
      analysisSummary: best.analysisSummary,
      analysisModel: best.analysisModel,
      aiAnalysis: best.aiAnalysis,
      evidence: best.evidence,
    },
    question: best.question,
    slug: best.slug,
    eventSlug: best.eventSlug,
    outcome: best.outcome,
    tokenId: best.tokenId,
    tags: best.tags,
    riskCategory: best.riskCategory,
    riskPrimaryEntity: best.riskPrimaryEntity,
    riskGroupKeys: best.riskGroupKeys,
    riskGroupLabels: best.riskGroupLabels,
    executionMode: best.executionMode,
    entryPrice: best.marketPrice,
    bestAsk: best.bestAsk,
    bestBid: best.bestBid,
    spread: best.spread,
    slippage: best.slippage,
    liquidity: best.liquidity,
    volume24hr: best.volume24hr,
    daysToResolution: best.daysToResolution,
    aiProbability: best.aiProbability,
    rawProbability: best.rawProbability,
    marketProbability: best.marketProbability,
    thesisType: best.thesisType,
    probabilitySource: strategy.probabilitySource,
    annualizedReturn: selectionEconomics.annualizedReturn,
    expectedValueUsdc: selectedExpectedValue,
    aiExpectedValueUsdc: Number.isFinite(Number(best.aiExpectedValueUsdc ?? best.expectedValueUsdc)) ? Number((Number(best.aiExpectedValueUsdc ?? best.expectedValueUsdc) * economics.scale).toFixed(4)) : null,
    aiAnnualizedReturn: best.aiAnnualizedReturn ?? best.annualizedReturn,
    marketExpectedValueUsdc: Number.isFinite(Number(best.marketExpectedValueUsdc)) ? Number((Number(best.marketExpectedValueUsdc) * economics.scale).toFixed(4)) : null,
    marketAnnualizedReturn: best.marketAnnualizedReturn ?? null,
    stakeUsdc: Number(stake.toFixed(2)),
    shares: economics.shares,
    feesEnabled: best.feesEnabled,
    feeType: best.feeType,
    feeRate: best.feeRate,
    takerFeeUsdc: economics.takerFeeUsdc,
    totalCostUsdc: economics.totalCostUsdc,
    grossGainIfWinUsdc: economics.grossGainIfWinUsdc,
    netGainIfWinUsdc: economics.netGainIfWinUsdc,
    maxLossUsdc: economics.maxLossUsdc,
    currentPrice: best.marketPrice,
    currentValueUsdc: Number(stake.toFixed(2)),
    unrealizedPnlUsdc: 0,
    unrealizedPnlPct: 0,
    marketFills: economics.marketFills,
    aiAnalysis: best.aiAnalysis,
    probabilityThesis: best.probabilityThesis,
    analysisModel: best.analysisModel,
    analysisSummary: best.analysisSummary,
  };
}

function tradeBatchCandidateSummary(item) {
  if (!item) return null;
  return {
    id: item.id || null,
    question: item.question || "",
    outcome: item.outcome || "",
    tokenId: item.tokenId || null,
    evaluatedAt: item.evaluatedAt || null,
    status: item.status || null,
    selectionStatus: item.selectionStatus || null,
    aiProbability: Number.isFinite(Number(item.aiProbability)) ? Number(Number(item.aiProbability).toFixed(4)) : null,
    marketPrice: Number.isFinite(Number(item.marketPrice)) ? Number(Number(item.marketPrice).toFixed(4)) : null,
    marketProbability: Number.isFinite(Number(item.marketProbability)) ? Number(Number(item.marketProbability).toFixed(4)) : null,
    annualizedReturn: Number.isFinite(Number(item.annualizedReturn)) ? Number(Number(item.annualizedReturn).toFixed(4)) : null,
    expectedValueUsdc: Number.isFinite(Number(item.expectedValueUsdc)) ? Number(Number(item.expectedValueUsdc).toFixed(4)) : null,
    aiAnnualizedReturn: Number.isFinite(Number(item.aiAnnualizedReturn)) ? Number(Number(item.aiAnnualizedReturn).toFixed(4)) : null,
    aiExpectedValueUsdc: Number.isFinite(Number(item.aiExpectedValueUsdc)) ? Number(Number(item.aiExpectedValueUsdc).toFixed(4)) : null,
    marketAnnualizedReturn: Number.isFinite(Number(item.marketAnnualizedReturn)) ? Number(Number(item.marketAnnualizedReturn).toFixed(4)) : null,
    marketExpectedValueUsdc: Number.isFinite(Number(item.marketExpectedValueUsdc)) ? Number(Number(item.marketExpectedValueUsdc).toFixed(4)) : null,
    netGainIfWinUsdc: Number.isFinite(Number(item.netGainIfWinUsdc)) ? Number(Number(item.netGainIfWinUsdc).toFixed(4)) : null,
    netYield: Number.isFinite(Number(item.netGainIfWinUsdc)) && Number(item.totalCostUsdc || item.stakeUsdc || 0) > 0
      ? Number((Number(item.netGainIfWinUsdc) / Number(item.totalCostUsdc || item.stakeUsdc || 0)).toFixed(4))
      : null,
    riskReward: Number.isFinite(Number(rewardRiskRatio(item))) ? Number(Number(rewardRiskRatio(item)).toFixed(4)) : null,
    daysToResolution: Number.isFinite(Number(item.daysToResolution)) ? Number(Number(item.daysToResolution).toFixed(2)) : null,
    liquidity: Number.isFinite(Number(item.liquidity)) ? Number(Number(item.liquidity).toFixed(2)) : null,
    riskGroupLabels: Array.isArray(item.riskGroupLabels) ? item.riskGroupLabels.slice(0, 5) : [],
    rejectReasons: Array.isArray(item.rejectReasons) ? item.rejectReasons.slice(0, 6) : [],
    riskBlockedByTradeId: item.riskBlockedByTradeId || null,
    riskBlockedReason: item.riskBlockedReason || null,
    url: `https://polymarket.com/event/${item.eventSlug || item.slug || ""}`,
  };
}

function portfolioFilterDiagnostics(evaluations, strategy) {
  const rows = Array.isArray(evaluations) ? evaluations : [];
  const reasonCounts = {};
  const excludedSample = [];
  let baseEligible = 0;
  let portfolioEligible = 0;

  for (const item of rows) {
    if (String(item.status || "").toUpperCase() === "ELIGIBLE") baseEligible += 1;
    const result = portfolioFilterResult(item, strategy);
    if (result.eligible) {
      portfolioEligible += 1;
      continue;
    }
    for (const reason of result.reasons) incrementCount(reasonCounts, reason);
    if (excludedSample.length < 20) {
      excludedSample.push({
        ...tradeBatchCandidateSummary(item),
        portfolioRejectReasons: result.reasons,
      });
    }
  }

  return {
    totalEvaluated: rows.length,
    baseEligible,
    portfolioEligible,
    excludedCount: Math.max(0, rows.length - portfolioEligible),
    reasonCounts,
    excludedSample,
  };
}

function latestUniqueExecutionEvaluations(evaluations = []) {
  const byKey = new Map();
  const ordered = [...evaluations].sort((a, b) => evaluationUpdateTime(b) - evaluationUpdateTime(a));
  for (const item of ordered) {
    const key = evaluationKey(item);
    if (!key || byKey.has(key)) continue;
    byKey.set(key, item);
  }
  return [...byKey.values()];
}

function executionRowsForStrategy(state, strategy, baseRows = []) {
  const rows = Array.isArray(baseRows) ? baseRows : [];
  if (strategy.probabilitySource !== "polymarket") return latestUniqueExecutionEvaluations(rows);
  const observations = Array.isArray(state.marketObservations) ? state.marketObservations : [];
  return latestUniqueExecutionEvaluations([...observations, ...rows]);
}

function storedExecutionShortlist(state, strategy) {
  const baseRows = expirePastEvaluations(state.evaluations || []).map(ensureEvaluationErrorMetadata);
  const unique = executionRowsForStrategy(state, strategy, baseRows);
  const rejected = [];
  const passed = [];
  const reasonCounts = {};

  for (const item of unique) {
    const result = portfolioFilterResult(item, strategy);
    if (result.eligible) {
      passed.push(item);
      continue;
    }
    for (const reason of result.reasons) incrementCount(reasonCounts, reason);
    if (rejected.length < 20) {
      rejected.push({
        ...tradeBatchCandidateSummary(item),
        portfolioRejectReasons: result.reasons,
      });
    }
  }

  const rows = sortEligibleForStrategy(passed, strategy);
  return {
    rows,
    diagnostics: {
      source: "stored_execution_candidates",
      storedEvaluations: Array.isArray(state.evaluations) ? state.evaluations.length : 0,
      storedMarketObservations: Array.isArray(state.marketObservations) ? state.marketObservations.length : 0,
      uniqueEvaluations: unique.length,
      prefilterPassed: rows.length,
      prefilterRejected: Math.max(0, unique.length - rows.length),
      scanLimit: MAX_EVALUATIONS_PER_RUN,
      reasonCounts,
      portfolioPrefilterPassed: rows.length,
      portfolioPrefilterRejected: Math.max(0, unique.length - rows.length),
      rejectedSample: rejected,
      executionShortlist: rows.slice(0, 30).map(tradeBatchCandidateSummary).filter(Boolean),
    },
  };
}

function marketFromStoredEvaluation(item) {
  const outcome = String(item.outcome || "Outcome 1");
  const tokenId = String(item.tokenId || item.clobTokenId || "");
  return {
    id: item.marketId || item.conditionId || item.slug || item.eventSlug || tokenId,
    question: item.question || "",
    slug: item.slug || item.eventSlug || "",
    eventSlug: item.eventSlug || item.slug || "",
    events: item.eventSlug ? [{ slug: item.eventSlug }] : [],
    endDate: item.endDate || null,
    createdAt: item.createdAt || item.firstEvaluatedAt || item.evaluatedAt || null,
    updatedAt: item.updatedAt || item.lastSeenAt || item.evaluatedAt || null,
    outcomes: JSON.stringify([outcome]),
    clobTokenIds: JSON.stringify([tokenId]),
    liquidity: Number(item.liquidity || 0),
    volume24hr: Number(item.volume24hr || 0),
    negRisk: item.negRisk,
    feeSchedule: item.feeSchedule,
    feesEnabled: item.feesEnabled,
    feeType: item.feeType,
    feeRate: item.feeRate,
  };
}

function revalidationFailureEvaluation(item, message, status = "REJECTED") {
  const reason = `execution shortlist revalidation failed: ${message}`;
  return normalizeEvaluationRisk({
    ...item,
    id: evaluationKey(item) || item.id,
    evaluatedAt: nowIso(),
    lastSeenAt: nowIso(),
    status,
    thesisType: status === "ERROR" ? "ERROR" : "REJECTED",
    selectionStatus: "REVALIDATION_FAILED",
    rejectReasons: [reason, ...(Array.isArray(item.rejectReasons) ? item.rejectReasons : [])],
    analysisSummary: `${reason}. Candidate was removed from the current execution shortlist until a later evaluation makes it executable again.`,
  });
}

async function revalidateStoredExecutionCandidate(item, learningProfile) {
  const tokenId = String(item.tokenId || item.clobTokenId || "");
  if (!tokenId) {
    return revalidationFailureEvaluation(item, "missing token id");
  }
  if (REQUIRE_GEMINI && !hasGroundedPublicMemo(item)) {
    return markAiAnalysisDeferred(item, "Execution revalidation uses the stored grounded AI memo and never consumes a new Gemini request.");
  }

  try {
    const book = await fetchJson(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(tokenId)}`);
    const evaluation = evaluateCandidate({
      market: marketFromStoredEvaluation(item),
      outcomeIndex: 0,
      tokenId,
      book,
      learningProfile,
    });
    if (!evaluation) {
      return revalidationFailureEvaluation(item, "no executable ask/orderbook depth at current market");
    }
    const refreshed = normalizeEvaluationRisk({
      ...evaluation,
      revalidationSource: "stored_execution_candidates",
      previousEvaluatedAt: item.evaluatedAt || item.lastSeenAt || null,
      firstEvaluatedAt: item.firstEvaluatedAt || item.evaluatedAt || null,
    });
    return normalizeEvaluationRisk(refreshEvaluationAfterProbability(
      refreshed,
      Number(item.aiProbability),
      item.analysisModel || item.aiAnalysis?.model || GEMINI_MODEL,
      item.aiAnalysis || {},
    ));
  } catch (error) {
    const message = cleanEvaluationErrorMessage(error?.message || String(error || "unknown error"));
    return ensureEvaluationErrorMetadata(revalidationFailureEvaluation(item, message, "ERROR"));
  }
}

async function revalidateStoredExecutionShortlist(shortlist, learningProfile, state = null) {
  const raw = [];
  for (const item of shortlist) {
    raw.push(await revalidateStoredExecutionCandidate(item, learningProfile));
  }
  // Execution verifies price, liquidity and diversification only. AI research
  // belongs to the background evaluation budget, never to execution cadence.
  return raw.map(normalizeEvaluationRisk);
}

function buildTradeBatchLog({ portfolioState, strategy, evaluations = [], eligible, rankedEligible, action, reason, available, stake, selected = null, skippedForRisk = 0, insufficientCapital = false, cadenceBlocked = false, rotationReview = null, diversificationDiagnostics = null, prevalidationFilter = null }) {
  const evaluated = Array.isArray(eligible) ? eligible : [];
  const ranked = Array.isArray(rankedEligible) ? rankedEligible : evaluated;
  const blocked = ranked.filter((item) => item.selectionStatus === "RISK_BLOCKED" || item.riskBlockedReason);
  const eligibleCandidates = ranked
    .map((item) => ({
      ...tradeBatchCandidateSummary(item),
      selectionDecision: candidateSelectionDecision({ candidate: item, portfolioState, selected, action, reason }),
    }))
    .filter(Boolean);
  return {
    id: `trade-batch-${strategy.id}-${nowIso()}`,
    runAt: nowIso(),
    strategyId: strategy.id,
    strategyLabel: strategy.label,
    selectionMetric: strategy.selectionMetric,
    action,
    reason,
    explanation: selected
      ? `Opened ${selected.outcome || "selected outcome"} because it was the first non-duplicate, non-correlated candidate after ${strategy.label} rules.`
      : `No ${strategy.label} trade was opened: ${reason}.`,
    settings: {
      minProbability: strategy.minProbability,
      maxFraction: strategy.maxFraction ?? null,
      maxResolutionDays: strategyMaxResolutionDays(strategy),
      minLiquidityUsdc: strategy.minLiquidityUsdc ?? null,
      minNetYield: Math.max(0, Number(strategy.minNetYield) || 0),
      selectionOrder: strategy.selectionOrder,
      requireMostProbableOutcome: Boolean(strategy.requireMostProbableOutcome),
      probabilitySource: strategy.probabilitySource,
      tradeCadenceHours: normalizeTradeCadenceHours(strategy.tradeCadenceHours, 1),
      manualRunOnce: MANUAL_RUN_ONCE,
      cadenceIgnored: MANUAL_RUN_ONCE,
      requestedStrategyId: PAPER_STRATEGY_ID || null,
      maxStakeUsdc: Number(stake.toFixed(2)),
    },
    capital: {
      availableUsdc: Number(available.toFixed(4)),
      requiredStakeUsdc: Number(stake.toFixed(4)),
      insufficientCapital: Boolean(insufficientCapital),
    },
    counts: {
      rankedEligible: ranked.length,
      skippedForRisk,
      riskBlocked: blocked.length,
      openTrades: openTrades(portfolioState.trades || []).length,
      cadenceBlocked: Boolean(cadenceBlocked),
    },
    portfolioFilter: portfolioFilterDiagnostics(evaluations, strategy),
    selected: tradeBatchCandidateSummary(selected),
    eligibleCandidates,
    topCandidates: ranked.slice(0, 8).map(tradeBatchCandidateSummary).filter(Boolean),
    revalidatedCandidates: prevalidationFilter?.revalidatedCandidates || null,
    topRejected: prevalidationFilter?.revalidatedRejectedSample || null,
    riskBlocked: blocked.slice(0, 8).map(tradeBatchCandidateSummary).filter(Boolean),
    rotationReview: rotationReview || null,
    diversificationDiagnostics: diversificationDiagnostics || null,
    prevalidationFilter: prevalidationFilter || null,
  };
}

function findFirstOpenCandidate(portfolioState, eligible, excludedTradeId = null) {
  let skippedForRisk = 0;
  const activeTrades = excludedTradeId
    ? portfolioState.trades.filter((trade) => trade.id !== excludedTradeId)
    : portfolioState.trades;

  const best = eligible.find((item) => {
    if (alreadyOpen(activeTrades, item.tokenId)) return false;
    const block = riskBlock(item, activeTrades);
    if (!block) return true;
    skippedForRisk += 1;
    item.selectionStatus = "RISK_BLOCKED";
    item.riskBlockedByTradeId = block.tradeId;
    item.riskBlockedReason = riskBlockReason(block);
    return false;
  });

  return { best: best || null, skippedForRisk };
}

function rotationReview(portfolioState, eligible, strategy, available, stake) {
  const openRows = openTrades(portfolioState.trades)
    .filter((trade) => trade.status === "OPEN")
    .filter((trade) => heldHours(trade) >= ROTATION_MIN_HOLD_HOURS);
  if (!openRows.length) return null;

  let bestReview = null;
  for (const trade of openRows) {
    const candidate = findFirstOpenCandidate(portfolioState, eligible, trade.id).best;
    if (!candidate) continue;
    if (String(candidate.tokenId || "") === String(trade.tokenId || "")) continue;
    const capitalAfterExit = available + Number(trade.maxLossUsdc || trade.stakeUsdc || 0);
    if (capitalAfterExit < stake) continue;

    const hold = tradeContinuationEconomics(trade, strategy);
    const candidateScore = candidateRotationScore(candidate, strategy);
    const candidateEv = Number(portfolioEconomics(candidate, strategy).expectedValueUsdc);
    const holdEv = Number(hold.expectedValue);
    if (!Number.isFinite(candidateScore) || !Number.isFinite(hold.score)) continue;
    if (!Number.isFinite(candidateEv) || !Number.isFinite(holdEv)) continue;

    const scoreDelta = candidateScore - hold.score;
    const evDelta = candidateEv - holdEv;
    if (scoreDelta < ROTATION_MIN_SCORE_IMPROVEMENT || evDelta < ROTATION_MIN_EV_USDC_IMPROVEMENT) continue;

    const review = {
      trade,
      candidate,
      hold,
      candidateScore,
      candidateEv,
      scoreDelta,
      evDelta,
      capitalAfterExit,
    };
    if (!bestReview || review.scoreDelta > bestReview.scoreDelta || (review.scoreDelta === bestReview.scoreDelta && review.evDelta > bestReview.evDelta)) {
      bestReview = review;
    }
  }
  return bestReview;
}

function closeTradeForRotation(trade, review, strategy) {
  const closedAt = nowIso();
  const currentValue = Number(review.hold.currentValue || 0);
  const cost = Number(trade.totalCostUsdc || trade.maxLossUsdc || trade.stakeUsdc || 0);
  const realizedPnl = Number((currentValue - cost).toFixed(4));
  const realizedPnlPct = pnlPercent(realizedPnl, cost);
  const metric = strategy.selectionMetric;
  const note = [
    `Predcasne uzavreno pred vyhodnocenim kvuli lepsi paper prilezitosti.`,
    `Nova prilezitost ma ${metric} ${strategy.selectionOrder === "highest_reward_risk_first" ? review.candidateScore.toFixed(2) : `${(review.candidateScore * 100).toFixed(1)}%`} oproti drzeni ${strategy.selectionOrder === "highest_reward_risk_first" ? review.hold.score.toFixed(2) : `${(review.hold.score * 100).toFixed(1)}%`}.`,
    `Realizovany P/L pri vystupu je ${realizedPnl >= 0 ? "+" : ""}${realizedPnl.toFixed(4)} USDC; ocekavane EV se zlepsuje o ${review.evDelta >= 0 ? "+" : ""}${review.evDelta.toFixed(4)} USDC.`,
  ].join(" ");

  return {
    ...trade,
    status: "SOLD",
    closedAt,
    resolvedAt: closedAt,
    exitReason: "ROTATED_TO_BETTER_CANDIDATE",
    exitPrice: Number(trade.currentPrice ?? trade.entryPrice ?? 0),
    currentValueUsdc: Number(currentValue.toFixed(4)),
    unrealizedPnlUsdc: 0,
    unrealizedPnlPct: 0,
    realizedPnlUsdc: realizedPnl,
    realizedPnlPct,
    statusNote: note,
    rotationReview: {
      strategyId: strategy.id,
      strategyMetric: strategy.selectionMetric,
      closedForQuestion: review.candidate.question,
      closedForOutcome: review.candidate.outcome,
      closedForTokenId: review.candidate.tokenId,
      previousScore: Number(review.hold.score.toFixed(6)),
      newScore: Number(review.candidateScore.toFixed(6)),
      scoreDelta: Number(review.scoreDelta.toFixed(6)),
      previousExpectedValueUsdc: Number(review.hold.expectedValue.toFixed(4)),
      newExpectedValueUsdc: Number(review.candidateEv.toFixed(4)),
      expectedValueDeltaUsdc: Number(review.evDelta.toFixed(4)),
      realizedPnlUsdc: realizedPnl,
      note,
    },
  };
}

function maybeOpenScheduledTrade(portfolioState, eligible, strategy = PAPER_STRATEGIES.conservative, evaluations = [], options = {}) {
  const today = pragueDateKey();
  const currentHour = pragueHourKey();
  const realizedPnl = portfolioState.trades.reduce((sum, trade) => sum + Number(trade.realizedPnlUsdc || 0), 0);
  const sizingCapital = Math.max(0, PORTFOLIO_USDC + realizedPnl);
  const available = Math.max(0, sizingCapital - openRisk(portfolioState.trades));
  const maxFraction = Number(strategy.maxFraction ?? portfolioState.portfolio?.maxFraction ?? MAX_FRACTION);
  const stake = sizingCapital * maxFraction;

  const tradeCadenceHours = normalizeTradeCadenceHours(strategy.tradeCadenceHours, 1);
  const ignoreCadence = Boolean(options.ignoreCadence);

  if (!ignoreCadence && cadenceBlocked(portfolioState.lastTradeHour, currentHour, tradeCadenceHours)) {
    const latest = latestNewTrade(portfolioState);
    const latestLabel = latest
      ? `${latest.strategyLabel || strategy.label}: ${latest.outcome || "-"} / ${latest.question || "-"}`
      : strategy.label;
    const reason = `${strategy.label} paper trade cadence blocked: this portfolio last opened a new trade at ${portfolioState.lastTradeHour || "-"}, cadence ${tradeCadenceHours}h. Other paper portfolios do not block this cadence. Last trade: ${latestLabel}`;
    return {
      action: "SKIP",
      reason,
      available,
      requiredStake: stake,
      strategyId: strategy.id,
      batchLog: buildTradeBatchLog({
        portfolioState,
        strategy,
        evaluations,
        eligible,
        rankedEligible: eligible,
        action: "SKIP",
        reason,
        available,
        stake,
        cadenceBlocked: true,
        diversificationDiagnostics: options.diversificationDiagnostics || null,
        prevalidationFilter: options.prevalidationFilter || null,
      }),
    };
  }

  const rotation = rotationReview(portfolioState, eligible, strategy, available, stake);
  if (rotation) {
    const closedTrade = closeTradeForRotation(rotation.trade, rotation, strategy);
    portfolioState.trades = portfolioState.trades.map((trade) => trade.id === closedTrade.id ? closedTrade : trade);
    const newTrade = paperTradeFromCandidate(rotation.candidate, strategy, today, stake);
    newTrade.openedAfterRotationOfTradeId = closedTrade.id;
    newTrade.rotationEntryReason = closedTrade.rotationReview?.note || "";
    portfolioState.trades.unshift(newTrade);
    portfolioState.lastTradeDate = today;
    portfolioState.lastTradeHour = currentHour;
    return {
      action: "ROTATED_OPENED",
      reason: `closed weaker open paper trade and opened better ${strategy.selectionMetric} candidate`,
      trade: newTrade,
      closedTrade,
      available: rotation.capitalAfterExit - stake,
      requiredStake: stake,
      skippedForRisk: 0,
      rotationReview: closedTrade.rotationReview,
      strategyId: strategy.id,
      batchLog: buildTradeBatchLog({
        portfolioState,
        strategy,
        evaluations,
        eligible,
        rankedEligible: eligible,
        action: "ROTATED_OPENED",
        reason: `closed weaker open paper trade and opened better ${strategy.selectionMetric} candidate`,
        available: rotation.capitalAfterExit,
        stake,
        selected: rotation.candidate,
        rotationReview: closedTrade.rotationReview,
        diversificationDiagnostics: options.diversificationDiagnostics || null,
        prevalidationFilter: options.prevalidationFilter || null,
      }),
    };
  }

  if (available < stake) {
    const reason = `not enough free paper capital for next ${strategy.label} trade: ${available.toFixed(2)} USDC available, ${stake.toFixed(2)} USDC required by diversification settings`;
    return {
      action: "SKIP",
      reason,
      available,
      requiredStake: stake,
      insufficientCapital: true,
      strategyId: strategy.id,
      batchLog: buildTradeBatchLog({
        portfolioState,
        strategy,
        evaluations,
        eligible,
        rankedEligible: eligible,
        action: "SKIP",
        reason,
        available,
        stake,
        insufficientCapital: true,
        diversificationDiagnostics: options.diversificationDiagnostics || null,
        prevalidationFilter: options.prevalidationFilter || null,
      }),
    };
  }

  if (!eligible.length) {
    const reason = `no candidates passed ${strategy.label} portfolio filters`;
    return {
      action: "SKIP",
      reason,
      available,
      requiredStake: stake,
      skippedForRisk: 0,
      strategyId: strategy.id,
      batchLog: buildTradeBatchLog({
        portfolioState,
        strategy,
        evaluations,
        eligible,
        rankedEligible: eligible,
        action: "SKIP",
        reason,
        available,
        stake,
        diversificationDiagnostics: options.diversificationDiagnostics || null,
        prevalidationFilter: options.prevalidationFilter || null,
      }),
    };
  }

  const { best, skippedForRisk } = findFirstOpenCandidate(portfolioState, eligible);
  if (!best) {
    const reason = skippedForRisk > 0
      ? "no eligible non-correlated candidate"
      : "no eligible non-duplicate candidate";
    return {
      action: "SKIP",
      reason,
      available,
      requiredStake: stake,
      skippedForRisk,
      strategyId: strategy.id,
      batchLog: buildTradeBatchLog({
        portfolioState,
        strategy,
        evaluations,
        eligible,
        rankedEligible: eligible,
        action: "SKIP",
        reason,
        available,
        stake,
        skippedForRisk,
        diversificationDiagnostics: options.diversificationDiagnostics || null,
        prevalidationFilter: options.prevalidationFilter || null,
      }),
    };
  }

  const trade = paperTradeFromCandidate(best, strategy, today, stake);

  portfolioState.trades.unshift(trade);
  portfolioState.lastTradeDate = today;
  portfolioState.lastTradeHour = currentHour;
  const reason = `best ${strategy.selectionMetric} non-correlated candidate within max ${strategyMaxResolutionDays(strategy)} day resolution`;
  return {
    action: "OPENED",
    reason,
    trade,
    available: available - stake,
    requiredStake: stake,
    skippedForRisk,
    strategyId: strategy.id,
    batchLog: buildTradeBatchLog({
      portfolioState,
      strategy,
      evaluations,
      eligible,
      rankedEligible: eligible,
      action: "OPENED",
      reason,
      available,
      stake,
      selected: best,
      skippedForRisk,
      diversificationDiagnostics: options.diversificationDiagnostics || null,
      prevalidationFilter: options.prevalidationFilter || null,
    }),
  };
}

function recoveryEvaluation(state, anchor) {
  const evaluations = Array.isArray(state.evaluations) ? state.evaluations : [];
  const candidates = evaluations.filter((item) => String(item.tokenId || "") === String(anchor.tokenId));
  if (!candidates.length) return null;
  const targetTime = Date.parse(anchor.openedAt || "");
  return candidates.sort((a, b) => {
    if (a.id === anchor.sourceEvaluationId) return -1;
    if (b.id === anchor.sourceEvaluationId) return 1;
    const aDistance = Math.abs((Date.parse(a.evaluatedAt || "") || targetTime || 0) - (targetTime || 0));
    const bDistance = Math.abs((Date.parse(b.evaluatedAt || "") || targetTime || 0) - (targetTime || 0));
    return aDistance - bDistance;
  })[0];
}

function recoveredTradeFromAnchor(state, anchor) {
  const evaluation = recoveryEvaluation(state, anchor) || {};
  const entryPrice = Number(anchor.entryPrice ?? evaluation.marketPrice);
  const stake = Number(evaluation.stakeUsdc || PORTFOLIO_USDC * MAX_FRACTION);
  const shares = Number(anchor.shares ?? evaluation.executableShares ?? (Number.isFinite(entryPrice) && entryPrice > 0 ? stake / entryPrice : 0));
  const takerFee = Number(anchor.takerFeeUsdc ?? evaluation.takerFeeUsdc ?? 0);
  const totalCostUsdc = Number(anchor.totalCostUsdc ?? evaluation.totalCostUsdc ?? (stake + takerFee));
  const netGainIfWin = Number(anchor.netGainIfWinUsdc ?? evaluation.netGainIfWinUsdc ?? (shares - totalCostUsdc));
  const sourceEvaluation = {
    id: anchor.sourceEvaluationId || evaluation.id || null,
    evaluatedAt: evaluation.evaluatedAt || null,
    status: evaluation.status || "ELIGIBLE",
    thesisType: evaluation.thesisType || null,
    aiProbability: evaluation.aiProbability ?? null,
    rawProbability: evaluation.rawProbability ?? null,
    marketPrice: Number.isFinite(entryPrice) ? entryPrice : evaluation.marketPrice,
    edge: evaluation.edge ?? null,
    expectedValueUsdc: evaluation.expectedValueUsdc ?? null,
    annualizedReturn: evaluation.annualizedReturn ?? null,
    probabilityThesis: evaluation.probabilityThesis || "",
    analysisSummary: evaluation.analysisSummary || "",
    aiAnalysis: evaluation.aiAnalysis || null,
    evidence: evaluation.evidence || [],
  };

  return normalizeTrade({
    id: anchor.id,
    openedAt: anchor.openedAt,
    date: anchor.date,
    status: "OPEN",
    recoveredAt: nowIso(),
    recoveryReason: anchor.reason,
    sourceEvaluationId: sourceEvaluation.id,
    sourceEvaluation,
    question: anchor.question || evaluation.question,
    slug: anchor.slug || evaluation.slug,
    eventSlug: anchor.eventSlug || evaluation.eventSlug,
    outcome: anchor.outcome || evaluation.outcome,
    tokenId: anchor.tokenId,
    tags: evaluation.tags || [],
    riskCategory: evaluation.riskCategory,
    riskPrimaryEntity: evaluation.riskPrimaryEntity,
    riskGroupKeys: evaluation.riskGroupKeys,
    riskGroupLabels: evaluation.riskGroupLabels,
    executionMode: evaluation.executionMode || "MARKET_BUY",
    entryPrice,
    bestAsk: Number(anchor.entryPrice ?? evaluation.bestAsk ?? evaluation.marketPrice),
    bestBid: evaluation.bestBid,
    spread: evaluation.spread,
    slippage: evaluation.slippage ?? 0,
    liquidity: evaluation.liquidity,
    volume24hr: evaluation.volume24hr,
    daysToResolution: evaluation.daysToResolution,
    aiProbability: evaluation.aiProbability,
    rawProbability: evaluation.rawProbability,
    thesisType: evaluation.thesisType,
    annualizedReturn: evaluation.annualizedReturn,
    expectedValueUsdc: evaluation.expectedValueUsdc,
    stakeUsdc: Number(stake.toFixed(2)),
    shares: Number(shares.toFixed(4)),
    feesEnabled: evaluation.feesEnabled ?? takerFee > 0,
    feeType: evaluation.feeType || (takerFee > 0 ? "sports_fees_v2" : "fee_free"),
    feeRate: evaluation.feeRate ?? 0,
    takerFeeUsdc: takerFee,
    totalCostUsdc,
    grossGainIfWinUsdc: Number((shares - stake).toFixed(4)),
    netGainIfWinUsdc: netGainIfWin,
    maxLossUsdc: Number(anchor.maxLossUsdc ?? evaluation.maxLossUsdc ?? totalCostUsdc),
    currentPrice: entryPrice,
    currentValueUsdc: Number(stake.toFixed(2)),
    unrealizedPnlUsdc: 0,
    unrealizedPnlPct: 0,
    marketFills: evaluation.marketFills || [{ price: entryPrice, size: Number(shares.toFixed(4)), costUsdc: Number(stake.toFixed(2)) }],
    aiAnalysis: evaluation.aiAnalysis,
    probabilityThesis: evaluation.probabilityThesis,
    analysisModel: evaluation.analysisModel,
    analysisSummary: evaluation.analysisSummary,
    statusNote: "Recovered into ledger before market refresh.",
  });
}

function recoverLedgerGaps(state) {
  let recovered = 0;
  for (const anchor of LEDGER_RECOVERY_ANCHORS) {
    const exists = state.trades.some((trade) => trade.id === anchor.id || String(trade.tokenId || "") === String(anchor.tokenId));
    if (exists) continue;
    state.trades.unshift(recoveredTradeFromAnchor(state, anchor));
    recovered += 1;
  }
  if (recovered > 0) {
    state.runLog = [
      {
        runAt: nowIso(),
        evaluatedCount: 0,
        eligibleCount: 0,
        action: "RECOVER_LEDGER",
        reason: `recovered ${recovered} paper trade(s) missing after state regression`,
        riskSkippedCount: 0,
        refreshOnly: true,
      },
      ...state.runLog,
    ].slice(0, 120);
  }
  return recovered;
}

function closedOutcome(trade) {
  const status = String(trade.status || "").toUpperCase();
  if (status === "WON") return 1;
  if (status === "LOST") return 0;
  return null;
}

function deterministicPostMortem(trade) {
  const actual = closedOutcome(trade);
  const predicted = Number(trade.aiProbability);
  const error = Number.isFinite(predicted) && actual != null ? actual - predicted : null;
  const absoluteError = error == null ? null : Math.abs(error);
  const overconfidentLoss = trade.status === "LOST" && predicted >= 0.8;
  const underpricedWin = trade.status === "WON" && Number(trade.entryPrice) <= 0.8;
  const conclusion = trade.status === "WON"
    ? "Puvodni teze byla podporena vysledkem."
    : "Puvodni teze selhala proti vysledku trhu.";
  const lessons = [
    overconfidentLoss ? "Snizit duveru u podobnych near-certain vstupu, dokud neni vice nez jen trzni konsensus." : "",
    underpricedWin ? "Podobne edge opportunity si zaslouzi vyssi prioritu, pokud zustane kladne EV po fees a slippage." : "",
    trade.thesisType === "EDGE_OPPORTUNITY" ? "Sledovat, zda nizsi pravdepodobnost kompenzuje vyssi vyplatu v realne kalibraci." : "",
    Array.isArray(trade.riskGroupLabels) && trade.riskGroupLabels.length ? `Rizikova skupina: ${trade.riskGroupLabels.slice(0, 3).join(", ")}.` : "",
  ].filter(Boolean);

  return {
    reviewedAt: nowIso(),
    model: (GEMINI_API_KEY || OPENAI_API_KEY) ? "heuristic-fallback-after-ai-error" : "heuristic-postmortem-v1",
    result: trade.status,
    actualOutcome: actual,
    predictedProbability: Number.isFinite(predicted) ? Number(predicted.toFixed(4)) : null,
    predictionError: error == null ? null : Number(error.toFixed(4)),
    absoluteError: absoluteError == null ? null : Number(absoluteError.toFixed(4)),
    conclusion,
    thesisReview: trade.probabilityThesis || trade.analysisSummary || "No stored thesis.",
    lessons,
    optimizationSignals: {
      overconfidentLoss,
      underpricedWin,
      thesisType: trade.thesisType || "UNKNOWN",
      probabilityBucket: probabilityBucket(predicted),
      factorKeys: analysisFactorKeys({
        probability: Number.isFinite(predicted) ? predicted : 0.5,
        outcome: trade.outcome,
        tags: trade.tags || [trade.riskCategory || "general"],
        spread: trade.spread,
        liquidity: trade.liquidity,
        volume24hr: trade.volume24hr,
        days: trade.daysToResolution,
        market: { negRisk: trade.feeType === "negative_risk" },
      }),
    },
  };
}

async function reviewClosedTradesWithAi(trades, state = null) {
  const reviewed = [];
  let remaining = AI_POSTMORTEM_LIMIT;

  for (const trade of trades) {
    if (!["WON", "LOST"].includes(String(trade.status || "").toUpperCase()) || trade.postMortem) {
      reviewed.push(trade);
      continue;
    }

    const fallback = deterministicPostMortem(trade);
    if ((!GEMINI_API_KEY && !OPENAI_API_KEY) || remaining <= 0) {
      reviewed.push({ ...trade, postMortem: fallback });
      continue;
    }

    remaining -= 1;
    const prompt = {
      task: "Review a resolved Polymarket paper trade. Compare the initial thesis and probability against the actual result. Produce a concise conclusion and optimization signals for future initial analysis. Use only supplied data.",
      trade: {
        question: trade.question,
        outcome: trade.outcome,
        result: trade.status,
        entryPrice: trade.entryPrice,
        aiProbability: trade.aiProbability,
        rawProbability: trade.rawProbability,
        thesisType: trade.thesisType,
        probabilityThesis: trade.probabilityThesis,
        analysisSummary: trade.analysisSummary,
        realizedPnlUsdc: trade.realizedPnlUsdc,
        realizedPnlPct: trade.realizedPnlPct,
        riskGroupLabels: trade.riskGroupLabels,
      },
      requiredJson: {
        conclusion: "short Czech sentence",
        thesisReview: "short Czech paragraph",
        lessons: ["short Czech bullet"],
        probabilityAdjustmentHint: "increase | decrease | neutral",
        factorKeysToReward: ["factor:key"],
        factorKeysToPenalize: ["factor:key"],
      },
    };
    const messages = [
      { role: "system", content: "You are a prediction-market calibration reviewer. Return only valid JSON." },
      { role: "user", content: JSON.stringify(prompt) },
    ];
    let result;
    if (GEMINI_API_KEY) {
      const estimatedInputTokens = Math.ceil(messagesToGeminiText(messages).length / 4) + 128;
      const slot = state ? aiSlotAvailability(state, estimatedInputTokens) : { allowed: true };
      if (!slot.allowed) {
        if (state) deferAiRun(state, `post-mortem deferred: ${slot.reason}`);
        reviewed.push({ ...trade, postMortem: { ...fallback, aiModelError: `Gemini post-mortem deferred: ${slot.reason}` } });
        continue;
      }
      const requestId = state ? reserveAiRequest(state, estimatedInputTokens, {
        evaluationKey: trade.sourceEvaluationId || trade.tokenId || trade.id,
        phase: "postmortem",
      }) : null;
      result = await callGeminiJson(messages);
      if (!result || result.error) {
        const message = result?.error || "Gemini post-mortem unavailable";
        const quotaLimited = isQuotaError(result);
        if (requestId) finishAiRequest(state, requestId, quotaLimited ? "QUOTA_LIMITED" : "ERROR", message);
        if (quotaLimited) recordAiQuotaBackoff(state, message);
        reviewed.push({ ...trade, postMortem: { ...fallback, aiModelError: message } });
        continue;
      }
      if (requestId) finishAiRequest(state, requestId, "SUCCESS", "", result._usage);
      result = { ...result, _model: GEMINI_MODEL, _provider: "gemini" };
    } else {
      result = await callAiJson(messages);
    }
    if (!result || result.error) {
      reviewed.push({ ...trade, postMortem: { ...fallback, aiModelError: result?.error || "OpenAI post-mortem unavailable" } });
      continue;
    }
    reviewed.push({
      ...trade,
      postMortem: {
        ...fallback,
        model: result._model || OPENAI_MODEL,
        provider: result._provider || null,
        conclusion: result.conclusion || fallback.conclusion,
        thesisReview: result.thesisReview || fallback.thesisReview,
        lessons: Array.isArray(result.lessons) && result.lessons.length ? result.lessons.slice(0, 6) : fallback.lessons,
        probabilityAdjustmentHint: result.probabilityAdjustmentHint || "neutral",
        factorKeysToReward: Array.isArray(result.factorKeysToReward) ? result.factorKeysToReward.slice(0, 8) : [],
        factorKeysToPenalize: Array.isArray(result.factorKeysToPenalize) ? result.factorKeysToPenalize.slice(0, 8) : [],
      },
    });
  }

  return reviewed;
}

function buildLearningProfile(trades, previousProfile = {}) {
  const closed = trades.filter((trade) => closedOutcome(trade) != null && Number.isFinite(Number(trade.aiProbability)));
  const profile = normalizeLearningProfile(previousProfile);
  if (!closed.length) {
    return {
      ...profile,
      updatedAt: nowIso(),
      promptRules: [
        "Prefer candidates with positive EV after fees, slippage, and market-buy execution.",
        "Do not treat market consensus alone as proof; require explicit liquidity, spread, and resolution clarity checks.",
        "Allow edge-opportunity candidates below 95% only when EV and edge are materially positive.",
      ],
    };
  }

  const buckets = {};
  const factors = new Map();
  let brier = 0;
  let bias = 0;

  for (const trade of closed) {
    const predicted = Number(trade.aiProbability);
    const actual = closedOutcome(trade);
    const error = actual - predicted;
    brier += (predicted - actual) ** 2;
    bias += error;

    const bucketKey = probabilityBucket(predicted);
    buckets[bucketKey] ||= { count: 0, predictedSum: 0, actualSum: 0 };
    buckets[bucketKey].count += 1;
    buckets[bucketKey].predictedSum += predicted;
    buckets[bucketKey].actualSum += actual;

    const postFactors = [
      ...(trade.postMortem?.optimizationSignals?.factorKeys || []),
      ...(trade.postMortem?.factorKeysToReward || []),
      ...(trade.postMortem?.factorKeysToPenalize || []),
    ];
    const keys = postFactors.length ? postFactors : analysisFactorKeys({
      probability: predicted,
      outcome: trade.outcome,
      tags: trade.tags || [trade.riskCategory || "general"],
      spread: trade.spread,
      liquidity: trade.liquidity,
      volume24hr: trade.volume24hr,
      days: trade.daysToResolution,
      market: { negRisk: false },
    });

    for (const key of new Set(keys)) {
      if (!factors.has(key)) factors.set(key, { count: 0, predictedSum: 0, actualSum: 0 });
      const record = factors.get(key);
      record.count += 1;
      record.predictedSum += predicted;
      record.actualSum += actual;
    }
  }

  const bucketCalibration = {};
  for (const [key, record] of Object.entries(buckets)) {
    const avgPredicted = record.predictedSum / record.count;
    const winRate = record.actualSum / record.count;
    bucketCalibration[key] = {
      count: record.count,
      avgPredicted: Number(avgPredicted.toFixed(4)),
      winRate: Number(winRate.toFixed(4)),
      calibrationError: Number((winRate - avgPredicted).toFixed(4)),
    };
  }

  const factorAdjustments = {};
  for (const [key, record] of factors) {
    if (record.count < 2) continue;
    const avgPredicted = record.predictedSum / record.count;
    const winRate = record.actualSum / record.count;
    const adjustment = clamp((winRate - avgPredicted) * 0.2, -0.05, 0.05);
    factorAdjustments[key] = {
      count: record.count,
      avgPredicted: Number(avgPredicted.toFixed(4)),
      winRate: Number(winRate.toFixed(4)),
      adjustment: Number(adjustment.toFixed(4)),
    };
  }

  const brierScore = brier / closed.length;
  const calibrationBias = bias / closed.length;
  const promptRules = [
    calibrationBias < -0.05 ? "Recent predictions were overconfident; penalize market-consensus-only theses." : "",
    calibrationBias > 0.05 ? "Recent predictions were too conservative; promote positive-edge opportunities with acceptable liquidity." : "",
    "Estimate AI probability from independent public evidence only; never use Polymarket price, odds, order book, volume, liquidity, or betting consensus as evidence.",
    "Use market-buy price only after the independent probability is set, solely for EV, edge, and sizing calculations.",
    "Prefer lower-probability opportunities only when edge, EV p.a., and post-fee payout all remain positive.",
    "After a loss, avoid multiplying exposure to the same event, team, or risk group until resolved.",
  ].filter(Boolean);

  return {
    version: 1,
    updatedAt: nowIso(),
    sampleSize: closed.length,
    brierScore: Number(brierScore.toFixed(4)),
    calibrationBias: Number(calibrationBias.toFixed(4)),
    bucketCalibration,
    factorAdjustments,
    promptRules,
    aiLastRun: (GEMINI_API_KEY || OPENAI_API_KEY) ? nowIso() : profile.aiLastRun,
    aiModel: (GEMINI_API_KEY || OPENAI_API_KEY) ? (GEMINI_API_KEY ? GEMINI_MODEL : OPENAI_MODEL) : profile.aiModel,
    aiProvider: (GEMINI_API_KEY || OPENAI_API_KEY) ? (GEMINI_API_KEY ? "gemini" : "openai") : profile.aiProvider,
  };
}

function marketIdentity(market = {}) {
  return String(market.conditionId || market.id || market.slug || market.question || "").trim().toLowerCase();
}

function mergeMarketLists(...lists) {
  const byId = new Map();
  for (const list of lists) {
    for (const market of Array.isArray(list) ? list : []) {
      const key = marketIdentity(market);
      if (!key) continue;
      if (!byId.has(key)) byId.set(key, market);
    }
  }
  return [...byId.values()];
}

function gammaMarketsUrl(params = {}) {
  const url = new URL("https://gamma-api.polymarket.com/markets");
  url.searchParams.set("active", "true");
  url.searchParams.set("closed", "false");
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return url;
}

async function fetchGammaMarkets(params = {}) {
  return fetchJson(gammaMarketsUrl(params));
}

function marketDaysLeft(market = {}) {
  return daysToEnd(correctedEndDate(market.question || "", market.endDate, market.createdAt || market.updatedAt));
}

function compareMarketsForShortHorizon(a, b) {
  const preferredDays = Math.max(1, Number(MARKET_SCAN_PREFERRED_MAX_RESOLUTION_DAYS) || DEFAULT_MAX_RESOLUTION_DAYS);
  const minimumDays = Math.max(0, Number(MARKET_SCAN_MIN_RESOLUTION_HOURS) || 0) / 24;
  const aDays = marketDaysLeft(a);
  const bDays = marketDaysLeft(b);
  const aBucket = Number.isFinite(aDays) && aDays >= minimumDays && aDays <= preferredDays ? 0 : Number.isFinite(aDays) && aDays > 0 ? 1 : 2;
  const bBucket = Number.isFinite(bDays) && bDays >= minimumDays && bDays <= preferredDays ? 0 : Number.isFinite(bDays) && bDays > 0 ? 1 : 2;
  if (aBucket !== bBucket) return aBucket - bBucket;
  if (Number.isFinite(aDays) && Number.isFinite(bDays) && aDays !== bDays) return aDays - bDays;
  return Number(b.volume24hr || 0) - Number(a.volume24hr || 0);
}

async function loadMarkets() {
  const preferredDays = Math.max(1, Number(MARKET_SCAN_PREFERRED_MAX_RESOLUTION_DAYS) || DEFAULT_MAX_RESOLUTION_DAYS);
  const minimumHours = Math.max(0, Number(MARKET_SCAN_MIN_RESOLUTION_HOURS) || 0);
  const start = new Date(Date.now() + minimumHours * 3600000).toISOString();
  const preferredEnd = new Date(Date.now() + preferredDays * 86400000).toISOString();
  const preferred = await fetchGammaMarkets({
    limit: "60",
    order: "endDate",
    ascending: "true",
    end_date_min: start,
    end_date_max: preferredEnd,
  });
  const broad = await fetchGammaMarkets({
    limit: "60",
    order: "volume24hr",
    ascending: "false",
  });
  return mergeMarketLists(preferred, broad).sort(compareMarketsForShortHorizon);
}

async function loadBroadMarketScanBatch(previousScan) {
  const limit = Math.max(1, Math.min(500, MARKET_SCAN_BATCH_SIZE));
  return fetchGammaMarkets({
    limit,
    offset: previousScan.cursor,
    order: "volume24hr",
    ascending: "false",
  });
}

async function loadPreferredMarketScanBatch() {
  const preferredDays = Math.max(1, Number(MARKET_SCAN_PREFERRED_MAX_RESOLUTION_DAYS) || DEFAULT_MAX_RESOLUTION_DAYS);
  const minimumHours = Math.max(0, Number(MARKET_SCAN_MIN_RESOLUTION_HOURS) || 0);
  return fetchGammaMarkets({
    limit: Math.max(1, Math.min(500, MARKET_SCAN_BATCH_SIZE)),
    order: "endDate",
    ascending: "true",
    end_date_min: new Date(Date.now() + minimumHours * 3600000).toISOString(),
    end_date_max: new Date(Date.now() + preferredDays * 86400000).toISOString(),
  });
}

function compareObservationsForMarketScan(a, b) {
  const preferredDays = Math.max(1, Number(MARKET_SCAN_PREFERRED_MAX_RESOLUTION_DAYS) || DEFAULT_MAX_RESOLUTION_DAYS);
  const minimumDays = Math.max(0, Number(MARKET_SCAN_MIN_RESOLUTION_HOURS) || 0) / 24;
  const aDays = daysToEnd(a?.endDate);
  const bDays = daysToEnd(b?.endDate);
  const aBucket = Number.isFinite(aDays) && aDays >= minimumDays && aDays <= preferredDays ? 0 : Number.isFinite(aDays) && aDays > 0 ? 1 : 2;
  const bBucket = Number.isFinite(bDays) && bDays >= minimumDays && bDays <= preferredDays ? 0 : Number.isFinite(bDays) && bDays > 0 ? 1 : 2;
  if (aBucket !== bBucket) return aBucket - bBucket;
  if (Number.isFinite(aDays) && Number.isFinite(bDays) && aDays !== bDays) return aDays - bDays;
  if (Number(b.marketProbability || 0) !== Number(a.marketProbability || 0)) return Number(b.marketProbability || 0) - Number(a.marketProbability || 0);
  return Number(b.volume24hr || 0) - Number(a.volume24hr || 0);
}

function validMarketProbability(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 && numeric < 1 ? numeric : null;
}

function annualizedPotentialReturn(netYield, days) {
  if (!Number.isFinite(netYield)) return null;
  return Number.isFinite(days) && days > 0 ? netYield * (365 / days) : netYield;
}

function normalizeMarketObservationEconomics(observation) {
  const price = validMarketProbability(observation?.marketPrice ?? observation?.marketProbability);
  const probability = validMarketProbability(observation?.marketProbability);
  const stake = Number(observation?.stakeUsdc);
  if (!Number.isFinite(price) || !Number.isFinite(probability) || !Number.isFinite(stake) || stake <= 0) return observation;

  const shares = stake / price;
  const feeRate = Math.max(0, Number(observation?.feeRate) || 0);
  const takerFee = takerFeeForFills([{ price, size: shares }], feeRate);
  const totalCost = stake + takerFee;
  const netGainIfWin = shares - totalCost;
  const netYield = totalCost > 0 ? netGainIfWin / totalCost : null;
  const expectedValue = probability * shares - totalCost;
  const expectedRoi = totalCost > 0 ? expectedValue / totalCost : null;
  const days = daysToEnd(observation.endDate);
  const marketAnnualizedReturn = Number.isFinite(expectedRoi)
    ? (Number.isFinite(days) && days > 0 ? expectedRoi * (365 / days) : expectedRoi)
    : null;
  const potentialAnnualizedReturn = annualizedPotentialReturn(netYield, days);

  return {
    ...observation,
    marketPrice: Number(price.toFixed(4)),
    marketProbability: Number(probability.toFixed(4)),
    daysToResolution: Number.isFinite(days) ? Number(days.toFixed(2)) : observation.daysToResolution ?? null,
    executableShares: Number(shares.toFixed(4)),
    takerFeeUsdc: Number(takerFee.toFixed(5)),
    totalCostUsdc: Number(totalCost.toFixed(5)),
    netGainIfWinUsdc: Number(netGainIfWin.toFixed(4)),
    netYield: Number.isFinite(netYield) ? Number(netYield.toFixed(4)) : null,
    riskReward: Number.isFinite(netYield) ? Number(netYield.toFixed(4)) : null,
    potentialAnnualizedReturn: Number.isFinite(potentialAnnualizedReturn) ? Number(potentialAnnualizedReturn.toFixed(4)) : null,
    marketExpectedValueUsdc: Number(expectedValue.toFixed(4)),
    marketExpectedRoi: Number.isFinite(expectedRoi) ? Number(expectedRoi.toFixed(4)) : null,
    marketAnnualizedReturn: Number.isFinite(marketAnnualizedReturn) ? Number(marketAnnualizedReturn.toFixed(4)) : null,
    expectedValueUsdc: Number(expectedValue.toFixed(4)),
    annualizedReturn: Number.isFinite(marketAnnualizedReturn) ? Number(marketAnnualizedReturn.toFixed(4)) : null,
  };
}

function preferredMarketObservation(market, observedAt = nowIso()) {
  const outcomes = parseJsonField(market?.outcomes).map((outcome) => String(outcome || ""));
  const prices = parseJsonField(market?.outcomePrices).map(validMarketProbability);
  const tokenIds = parseJsonField(market?.clobTokenIds).map((tokenId) => String(tokenId || ""));
  const binary = binaryYesNoOutcomeIndexes(outcomes);
  let outcomeIndex = -1;
  let binaryYesPrice = null;
  let binaryNoPrice = null;

  if (binary) {
    binaryYesPrice = prices[binary.yesIndex];
    binaryNoPrice = prices[binary.noIndex] ?? (binaryYesPrice == null ? null : 1 - binaryYesPrice);
    if (binaryYesPrice == null && binaryNoPrice == null) return null;
    outcomeIndex = binaryYesPrice != null && (binaryNoPrice == null || binaryYesPrice >= binaryNoPrice)
      ? binary.yesIndex
      : binary.noIndex;
  } else {
    let best = -1;
    for (let index = 0; index < Math.min(outcomes.length, prices.length, tokenIds.length); index += 1) {
      if (prices[index] != null && prices[index] > best) {
        best = prices[index];
        outcomeIndex = index;
      }
    }
  }

  const probability = binary && outcomeIndex === binary.noIndex ? binaryNoPrice : prices[outcomeIndex];
  const tokenId = tokenIds[outcomeIndex];
  if (outcomeIndex < 0 || probability == null || probability < 0.5 || !tokenId) return null;

  const marketKey = binary
    ? binaryMarketKeyFromMarket(market)
    : `token:${tokenId}`;
  if (!marketKey) return null;
  const endDate = correctedEndDate(market.question || "", market.endDate, market.createdAt || market.updatedAt);
  const days = daysToEnd(endDate);
  const stake = PORTFOLIO_USDC * MAX_FRACTION;
  const fees = feeConfig(market);
  const shares = stake / probability;
  const takerFee = takerFeeForFills([{ price: probability, size: shares }], fees.feeRate);
  const totalCost = stake + takerFee;
  const netGainIfWin = shares - stake - takerFee;
  const netYield = totalCost > 0 ? netGainIfWin / totalCost : null;
  const riskReward = totalCost > 0 ? netGainIfWin / totalCost : null;
  const marketExpectedValue = probability * shares - stake - takerFee;
  const marketExpectedRoi = totalCost > 0 ? marketExpectedValue / totalCost : null;
  const marketAnnualizedReturn = Number.isFinite(days) && days > 0 && Number.isFinite(marketExpectedRoi)
    ? marketExpectedRoi * (365 / days)
    : marketExpectedRoi;
  const potentialAnnualizedReturn = annualizedPotentialReturn(netYield, days);
  const tags = tagQuestion(market.question || "");
  const risk = riskProfile({
    question: market.question || "",
    slug: market.slug,
    eventSlug: marketEventSlug(market),
    outcome: outcomes[outcomeIndex],
    tags,
  });
  return {
    id: marketKey,
    marketKey,
    marketId: String(market.conditionId || market.id || ""),
    question: String(market.question || ""),
    slug: String(market.slug || ""),
    eventSlug: marketEventSlug(market),
    outcome: outcomes[outcomeIndex],
    tokenId,
    status: "SCRAPED",
    selectionStatus: "SCRAPED",
    marketType: outcomes.length > 2 ? "multi" : reportMarketType({ question: market.question || "", slug: market.slug, eventSlug: marketEventSlug(market), outcome: outcomes[outcomeIndex] }),
    tags,
    riskCategory: risk.category,
    riskPrimaryEntity: risk.primaryEntity,
    riskGroupKeys: risk.keys,
    riskGroupLabels: risk.labels,
    marketPrice: Number(probability.toFixed(4)),
    marketProbability: Number(probability.toFixed(4)),
    binaryYesMarketProbability: binary && binaryYesPrice != null ? Number(binaryYesPrice.toFixed(4)) : null,
    binaryNoMarketProbability: binary && binaryNoPrice != null ? Number(binaryNoPrice.toFixed(4)) : null,
    binaryYesTokenId: binary ? tokenIds[binary.yesIndex] || "" : "",
    binaryNoTokenId: binary ? tokenIds[binary.noIndex] || "" : "",
    outcomeCount: outcomes.length,
    endDate,
    daysToResolution: days == null ? null : Number(days.toFixed(2)),
    liquidity: Number(market.liquidity || 0),
    volume24hr: Number(market.volume24hr || 0),
    stakeUsdc: Number(stake.toFixed(2)),
    executableShares: Number(shares.toFixed(4)),
    takerFeeUsdc: Number(takerFee.toFixed(5)),
    totalCostUsdc: Number(totalCost.toFixed(5)),
    netGainIfWinUsdc: Number(netGainIfWin.toFixed(4)),
    netYield: Number.isFinite(netYield) ? Number(netYield.toFixed(4)) : null,
    riskReward: Number.isFinite(riskReward) ? Number(riskReward.toFixed(4)) : null,
    potentialAnnualizedReturn: Number.isFinite(potentialAnnualizedReturn) ? Number(potentialAnnualizedReturn.toFixed(4)) : null,
    marketExpectedValueUsdc: Number(marketExpectedValue.toFixed(4)),
    marketExpectedRoi: Number.isFinite(marketExpectedRoi) ? Number(marketExpectedRoi.toFixed(4)) : null,
    marketAnnualizedReturn: Number.isFinite(marketAnnualizedReturn) ? Number(marketAnnualizedReturn.toFixed(4)) : null,
    annualizedReturn: Number.isFinite(marketAnnualizedReturn) ? Number(marketAnnualizedReturn.toFixed(4)) : null,
    expectedValueUsdc: Number(marketExpectedValue.toFixed(4)),
    feesEnabled: fees.feesEnabled,
    feeType: fees.feeType,
    feeRate: fees.feeRate,
    marketDataUpdatedAt: observedAt,
    observedAt,
    source: "polymarket-gamma",
  };
}

async function refreshMarketObservations(state) {
  const previousScan = normalizeMarketScan(state.marketScan);
  const preferredMarkets = await loadPreferredMarketScanBatch();
  const broadBatches = [];
  let broadCursor = previousScan.cursor;
  const broadBatchCount = Math.max(1, Math.floor(Number(MARKET_SCAN_PREFETCH_BATCHES) || 1));
  for (let index = 0; index < broadBatchCount; index += 1) {
    const batch = await loadBroadMarketScanBatch({ cursor: broadCursor });
    broadBatches.push(...(Array.isArray(batch) ? batch : []));
    if (!Array.isArray(batch) || batch.length < MARKET_SCAN_BATCH_SIZE) {
      broadCursor = 0;
      break;
    }
    broadCursor += MARKET_SCAN_BATCH_SIZE;
    if (broadCursor >= MARKET_SCAN_MAX_OFFSET) {
      broadCursor = 0;
      break;
    }
  }
  const markets = mergeMarketLists(preferredMarkets, broadBatches).sort(compareMarketsForShortHorizon);
  const observedAt = nowIso();
  const observations = (Array.isArray(markets) ? markets : [])
    .map((market) => preferredMarketObservation(market, observedAt))
    .filter((item) => {
      if (!item) return false;
      const probability = Number(item.marketProbability);
      const days = daysToEnd(item.endDate);
      const minimumDays = Math.max(0, Number(MARKET_SCAN_MIN_RESOLUTION_HOURS) || 0) / 24;
      return Number.isFinite(probability)
        && probability >= MARKET_SCAN_MIN_PROBABILITY
        && Number.isFinite(days)
        && days >= minimumDays;
    })
    .sort(compareObservationsForMarketScan);
  const shortHorizonCount = observations.filter((item) => {
    const days = daysToEnd(item.endDate);
    return Number.isFinite(days) && days > 0 && days <= MARKET_SCAN_PREFERRED_MAX_RESOLUTION_DAYS;
  }).length;
  state.marketObservations = mergeMarketObservationLists(observations, state.marketObservations || [])
    .map(normalizeMarketObservationEconomics);
  state.marketScan = {
    cursor: broadCursor,
    lastScanAt: observedAt,
    lastBatchCount: Array.isArray(markets) ? markets.length : 0,
    lastPreferredCount: observations.length,
    lastShortHorizonCount: shortHorizonCount,
    preferredMaxResolutionDays: MARKET_SCAN_PREFERRED_MAX_RESOLUTION_DAYS,
    minResolutionHours: MARKET_SCAN_MIN_RESOLUTION_HOURS,
    lastScanError: null,
  };
  return observations;
}

function snapshotMatchesEvaluation(snapshot, evaluation) {
  if (!snapshot || !evaluation) return false;
  if (snapshot.marketKey.startsWith("binary:")) {
    if (binaryEvaluationMarketKey(evaluation) === snapshot.marketKey) return true;
    // Keep compatibility with evaluations written before binary metadata was
    // persisted. Slugs identify the same binary contract across both sources.
    return String(snapshot.slug || "").trim().toLowerCase() === String(evaluation.slug || "").trim().toLowerCase();
  }
  return String(snapshot.tokenId || "") === String(evaluation.tokenId || "");
}

function quoteEconomicsForStoredEvaluation(evaluation, marketPrice, probability) {
  const previousTotalCost = Number(evaluation.totalCostUsdc ?? evaluation.stakeUsdc);
  const previousFee = Number(evaluation.takerFeeUsdc ?? 0);
  const stake = Number(evaluation.stakeUsdc ?? evaluation.filledStakeUsdc ?? (previousTotalCost - previousFee));
  const days = Number(evaluation.daysToResolution);
  const feeRate = Number(evaluation.feeRate ?? 0);
  if (!Number.isFinite(stake) || stake <= 0 || !Number.isFinite(marketPrice) || marketPrice <= 0 || marketPrice >= 1 || !Number.isFinite(probability)) {
    return null;
  }

  // A binary YES/NO flip changes the actual token being bought. Rebuild every
  // quote-dependent value from that token's price; retaining previous shares
  // would combine the new side's probability with the old side's payoff.
  const shares = stake / marketPrice;
  const takerFee = takerFeeForFills([{ price: marketPrice, size: shares }], feeRate);
  const totalCost = stake + takerFee;
  const expectedValue = probability * shares - totalCost;
  const expectedRoi = totalCost > 0 ? expectedValue / totalCost : null;
  const annualizedReturn = Number.isFinite(expectedRoi) && Number.isFinite(days) && days > 0
    ? expectedRoi * (365 / days)
    : expectedRoi;
  const netGainIfWin = shares - totalCost;
  const netYield = totalCost > 0 ? netGainIfWin / totalCost : null;

  return {
    stakeUsdc: Number(stake.toFixed(2)),
    executableShares: Number(shares.toFixed(4)),
    filledStakeUsdc: Number(stake.toFixed(4)),
    totalCostUsdc: Number(totalCost.toFixed(5)),
    takerFeeUsdc: Number(takerFee.toFixed(5)),
    grossGainIfWinUsdc: Number((shares - stake).toFixed(4)),
    netGainIfWinUsdc: Number(netGainIfWin.toFixed(4)),
    netYield: Number.isFinite(netYield) ? Number(netYield.toFixed(4)) : null,
    riskReward: Number.isFinite(netYield) ? Number(netYield.toFixed(4)) : null,
    expectedValueUsdc: Number(expectedValue.toFixed(4)),
    expectedRoi: Number.isFinite(expectedRoi) ? Number(expectedRoi.toFixed(4)) : null,
    annualizedReturn: Number.isFinite(annualizedReturn) ? Number(annualizedReturn.toFixed(4)) : null,
    marketFills: [{
      price: Number(marketPrice.toFixed(4)),
      size: Number(shares.toFixed(4)),
      costUsdc: Number(stake.toFixed(4)),
    }],
  };
}

function binarySideQuoteIsStale(item) {
  const hasBinaryMetadata = Boolean(item?.binaryYesTokenId || item?.binaryNoTokenId)
    || (validMarketProbability(item?.binaryYesMarketProbability) != null && validMarketProbability(item?.binaryNoMarketProbability) != null);
  if (!hasBinaryMetadata) return false;
  const entry = validMarketProbability(item.marketPrice);
  const selectedMarketProbability = validMarketProbability(item.marketProbability);
  return entry != null && selectedMarketProbability != null && Math.abs(entry - selectedMarketProbability) >= 0.1;
}

function repriceEvaluationForSelectedMarketQuote(evaluation, marketPrice, aiProbability = evaluation.aiProbability) {
  const price = validMarketProbability(marketPrice);
  const probability = Number(aiProbability);
  const aiEconomics = quoteEconomicsForStoredEvaluation(evaluation, price, probability);
  const marketEconomics = quoteEconomicsForStoredEvaluation(evaluation, price, price);
  if (!aiEconomics || !marketEconomics) return evaluation;

  return {
    ...evaluation,
    marketPrice: Number(price.toFixed(4)),
    bestAsk: Number(price.toFixed(4)),
    executableDepthUsdc: null,
    ...aiEconomics,
    aiExpectedValueUsdc: aiEconomics.expectedValueUsdc,
    aiAnnualizedReturn: aiEconomics.annualizedReturn,
    marketExpectedValueUsdc: marketEconomics.expectedValueUsdc,
    marketExpectedRoi: marketEconomics.expectedRoi,
    marketAnnualizedReturn: marketEconomics.annualizedReturn,
    edge: Number((probability - price).toFixed(4)),
    marketQuoteSource: "polymarket-gamma-selected-token",
  };
}

function recordEvaluationUpdate(previous, next, source, changedAt) {
  const changes = changedEvaluationFields(previous, next);
  if (!changes.length) return previous;
  return {
    ...next,
    updateHistory: [{
      changedAt,
      previousEvaluatedAt: previous.evaluatedAt || previous.lastSeenAt || null,
      source,
      changes,
    }, ...(Array.isArray(previous.updateHistory) ? previous.updateHistory : [])].slice(0, 30),
    lastChanges: changes,
  };
}

function repairStaleBinarySideQuotes(evaluations = []) {
  return evaluations.map((evaluation) => {
    if (!binarySideQuoteIsStale(evaluation)) return evaluation;
    const repaired = repriceEvaluationForSelectedMarketQuote(evaluation, evaluation.marketProbability, evaluation.aiProbability);
    return recordEvaluationUpdate(
      evaluation,
      {
        ...repaired,
        marketSideQuoteRepairedAt: nowIso(),
        marketSideQuoteRepairNote: "Rebuilt quote economics after a YES/NO token flip so entry, shares, fee, EV and R/R all use the selected outcome.",
      },
      "binary-side-quote-repair",
      nowIso(),
    );
  });
}

function applyMarketObservationsToEvaluations(evaluations, observations) {
  if (!observations.length || !evaluations.length) return evaluations;
  return evaluations.map((evaluation) => {
    const snapshot = observations.find((item) => snapshotMatchesEvaluation(item, evaluation));
    if (!snapshot) return evaluation;
    const outcomeChanged = String(snapshot.tokenId) !== String(evaluation.tokenId || "");
    const storedProbability = Number(evaluation.aiProbability);
    const yesProbability = Number.isFinite(Number(evaluation.binaryYesProbability))
      ? Number(evaluation.binaryYesProbability)
      : (Number.isFinite(storedProbability)
        ? (String(evaluation.outcome || "").toLowerCase() === "yes" ? storedProbability : 1 - storedProbability)
        : null);
    const nextAiProbability = Number.isFinite(yesProbability)
      ? Number((String(snapshot.outcome).toLowerCase() === "yes" ? yesProbability : 1 - yesProbability).toFixed(4))
      : evaluation.aiProbability;
    const next = normalizeEvaluationRisk({
      ...evaluation,
      id: outcomeChanged ? `token:${snapshot.tokenId}` : evaluation.id,
      tokenId: snapshot.tokenId,
      outcome: snapshot.outcome,
      marketProbability: snapshot.marketProbability,
      marketDataUpdatedAt: snapshot.marketDataUpdatedAt,
      binaryYesMarketProbability: snapshot.binaryYesMarketProbability,
      binaryNoMarketProbability: snapshot.binaryNoMarketProbability,
      binaryYesTokenId: snapshot.binaryYesTokenId || evaluation.binaryYesTokenId,
      binaryNoTokenId: snapshot.binaryNoTokenId || evaluation.binaryNoTokenId,
      marketOutcomeFlipped: outcomeChanged,
      marketOutcomeFlipAt: outcomeChanged ? snapshot.marketDataUpdatedAt : evaluation.marketOutcomeFlipAt || null,
      marketOutcomeFlipNote: outcomeChanged
        ? `Polymarket probability crossed 50%; stored outcome switched to ${snapshot.outcome} at ${(snapshot.marketProbability * 100).toFixed(1)}%.`
        : evaluation.marketOutcomeFlipNote || null,
      aiProbability: nextAiProbability,
      binaryYesProbability: Number.isFinite(yesProbability) ? Number(yesProbability.toFixed(4)) : evaluation.binaryYesProbability,
      rawProbability: Number.isFinite(yesProbability)
        ? Number((String(snapshot.outcome).toLowerCase() === "yes" ? yesProbability : 1 - yesProbability).toFixed(4))
        : evaluation.rawProbability,
      lastSeenAt: snapshot.marketDataUpdatedAt,
    });
    // Gamma's outcome price is a current quote for the selected token. It is
    // especially important after a YES/NO preference flip, when the old price
    // and share count belong to the opposite token.
    const repriced = repriceEvaluationForSelectedMarketQuote(next, snapshot.marketProbability, nextAiProbability);
    return recordEvaluationUpdate(evaluation, repriced, "polymarket-market-scan", snapshot.marketDataUpdatedAt);
  });
}

async function loadFocusedEvaluationMarkets(state) {
  let market = EVALUATION_MARKET_SLUG ? await fetchMarketBySlug(EVALUATION_MARKET_SLUG) : null;
  if (!market && EVALUATION_TOKEN_ID) {
    const stored = (state.evaluations || []).find((item) => String(item.tokenId || "") === EVALUATION_TOKEN_ID);
    if (stored?.slug) market = await fetchMarketBySlug(stored.slug);
  }
  if (!market) {
    throw new Error("manual evaluation market was not found on Polymarket");
  }
  return [market];
}

function marketHasNewOutcome(market, knownEvaluationKeys, knownBinaryMarketKeys = new Set()) {
  const binaryKey = binaryMarketKeyFromMarket(market);
  if (binaryKey) return !knownBinaryMarketKeys.has(binaryKey);
  return parseJsonField(market.clobTokenIds).some((tokenId) => tokenId && !knownEvaluationKeys.has(`token:${tokenId}`));
}

function reportMarketType(item) {
  const question = String(item?.question || "");
  const slug = String(item?.eventSlug || item?.slug || "");
  if (/(^|[-\s])(exact-score|correct-score|winner|group-winner|nominee|award|primary|election)([-\s]|$)/i.test(`${slug} ${question}`)) {
    return "multi";
  }
  if (/^(which|who|what|how many)\b/i.test(question)) return "multi";
  const kind = outcomeKind(item?.outcome);
  if (kind !== "OUTCOME") return "binary";
  if (/^(will|is|are|can|does|do|did|has|have|was|were)\b/i.test(question)) return "binary";
  return "multi";
}

function reportPolymarketProbability(item) {
  const value = Number(item?.marketProbability ?? item?.entryPrice ?? item?.marketPrice ?? item?.currentPrice);
  return Number.isFinite(value) && value > 0 && value < 1 ? value : null;
}

function reportProbability(item, source) {
  const ai = Number(item?.aiProbability);
  const poly = reportPolymarketProbability(item);
  if (source === "ai") return Number.isFinite(ai) ? ai : null;
  if (source === "polymarket") return poly;
  if (Number.isFinite(ai) && Number.isFinite(poly)) return (ai + poly) / 2;
  return null;
}

function reportTradeKey(trade) {
  return [
    trade.strategyId || "paper",
    trade.tokenId || trade.id || "",
    trade.openedAt || trade.date || "",
  ].join(":");
}

function closedTradesForCalculation(state) {
  const rows = [];
  for (const portfolioState of Object.values(state.paperPortfolios || {})) {
    for (const trade of portfolioState.trades || []) {
      if (closedOutcome(trade) == null) continue;
      rows.push({
        ...trade,
        strategyId: trade.strategyId || portfolioState.id,
        strategyLabel: trade.strategyLabel || portfolioState.label,
      });
    }
  }
  return mergeUniqueById(rows, reportTradeKey, 5000);
}

function tradeSimulationPnl(trade) {
  const realized = Number(trade.realizedPnlUsdc);
  if (Number.isFinite(realized)) return realized;
  const cost = totalCost(trade);
  const actual = closedOutcome(trade);
  if (actual == null) return 0;
  return actual ? Number((Number(trade.shares || 0) - cost).toFixed(4)) : Number((-cost).toFixed(4));
}

function summarizeTradesForReport(trades) {
  const stake = trades.reduce((sum, trade) => sum + totalCost(trade), 0);
  const pnl = trades.reduce((sum, trade) => sum + tradeSimulationPnl(trade), 0);
  const wins = trades.filter((trade) => closedOutcome(trade) === 1).length;
  const avgAi = average(trades.map((trade) => Number(trade.aiProbability)).filter(Number.isFinite));
  const avgPoly = average(trades.map(reportPolymarketProbability).filter(Number.isFinite));
  return {
    trades: trades.length,
    wins,
    losses: trades.length - wins,
    stakeUsdc: Number(stake.toFixed(4)),
    pnlUsdc: Number(pnl.toFixed(4)),
    roi: stake > 0 ? Number((pnl / stake).toFixed(4)) : null,
    winRate: trades.length ? Number((wins / trades.length).toFixed(4)) : null,
    avgAiProbability: avgAi == null ? null : Number(avgAi.toFixed(4)),
    avgPolymarketProbability: avgPoly == null ? null : Number(avgPoly.toFixed(4)),
  };
}

function buildCalculationReport(state) {
  const trades = closedTradesForCalculation(state);
  const generatedAt = state.generatedAt || nowIso();
  const portfolioSummaries = Object.values(state.paperPortfolios || {}).map((portfolioState) => {
    const closed = (portfolioState.trades || []).filter((trade) => closedOutcome(trade) != null);
    return {
      strategyId: portfolioState.id,
      strategyLabel: portfolioState.label,
      selectionMetric: portfolioState.selectionMetric,
      minProbability: portfolioState.portfolio?.minProbability ?? portfolioState.minProbability ?? null,
      maxResolutionDays: strategyMaxResolutionDays(portfolioState),
      minLiquidityUsdc: portfolioState.portfolio?.minLiquidityUsdc ?? portfolioState.minLiquidityUsdc ?? null,
      selectionOrder: portfolioState.selectionOrder,
      ...summarizeTradesForReport(closed),
    };
  });

  const thresholdSummaries = [];
  for (const source of ["ai", "polymarket", "combined"]) {
    for (const marketType of ["binary", "multi"]) {
      const typedTrades = trades.filter((trade) => reportMarketType(trade) === marketType);
      for (const threshold of REPORT_THRESHOLDS) {
        const selected = typedTrades.filter((trade) => {
          const probability = reportProbability(trade, source);
          return Number.isFinite(probability) && probability >= threshold;
        });
        thresholdSummaries.push({
          source,
          marketType,
          threshold,
          ...summarizeTradesForReport(selected),
        });
      }
    }
  }

  return {
    id: `calculation-report-${generatedAt}`,
    generatedAt,
    sampleSize: trades.length,
    resolvedBinaryCount: trades.filter((trade) => reportMarketType(trade) === "binary").length,
    resolvedMultiCount: trades.filter((trade) => reportMarketType(trade) === "multi").length,
    sourceNotes: {
      ai: "Uses our stored AI probability at evaluation/open time.",
      polymarket: "Uses the executable Polymarket entry probability for the selected outcome.",
      combined: "Uses the average of AI and Polymarket probabilities as a neutral blended filter.",
    },
    portfolioSummaries,
    thresholdSummaries,
    examples: trades.slice(0, 80).map((trade) => ({
      id: trade.id,
      strategyId: trade.strategyId,
      strategyLabel: trade.strategyLabel,
      marketType: reportMarketType(trade),
      question: trade.question,
      outcome: trade.outcome,
      url: `https://polymarket.com/event/${trade.eventSlug || trade.slug || ""}`,
      resolvedAt: trade.resolvedAt || trade.closedTime || trade.lastCheckedAt || null,
      status: trade.status,
      aiProbability: Number.isFinite(Number(trade.aiProbability)) ? Number(Number(trade.aiProbability).toFixed(4)) : null,
      polymarketProbability: reportPolymarketProbability(trade),
      pnlUsdc: tradeSimulationPnl(trade),
      stakeUsdc: totalCost(trade),
    })),
  };
}

function updateCalculationReport(state) {
  const report = buildCalculationReport(state);
  state.calculationReports = mergeUniqueById([report, ...(state.calculationReports || [])], (item) => item.id || item.generatedAt || "", 30)
    .sort((a, b) => (Date.parse(b.generatedAt || "") || 0) - (Date.parse(a.generatedAt || "") || 0));
  state.latestCalculationReport = state.calculationReports[0] || report;
  return report;
}

function updatePaperPortfolio(portfolioState) {
  const realizedPnl = portfolioState.trades.reduce((sum, trade) => sum + Number(trade.realizedPnlUsdc || 0), 0);
  const openPnl = portfolioState.trades
    .filter((trade) => trade.status === "OPEN")
    .reduce((sum, trade) => sum + Number(trade.unrealizedPnlUsdc || 0), 0);
  const openRiskValue = openRisk(portfolioState.trades);
  const equity = PORTFOLIO_USDC + realizedPnl + openPnl;
  const freeCapital = Math.max(0, PORTFOLIO_USDC + realizedPnl - openRiskValue);
  portfolioState.portfolio = {
    ...(portfolioState.portfolio || {}),
    strategyId: portfolioState.id,
    strategyLabel: portfolioState.label,
    selectionMetric: portfolioState.selectionMetric,
    selectionOrder: portfolioState.selectionOrder,
    strategyDescription: portfolioState.description,
    initialUsdc: PORTFOLIO_USDC,
    maxFraction: MAX_FRACTION,
    maxStakeUsdc: Number((equity * MAX_FRACTION).toFixed(2)),
    minProbability: Number(portfolioState.minProbability ?? MIN_PROBABILITY),
    minAnnualReturn: MIN_ANNUAL_RETURN,
    opportunityMinProbability: OPPORTUNITY_MIN_PROBABILITY,
    opportunityMinEdge: OPPORTUNITY_MIN_EDGE,
    opportunityMinAnnualReturn: OPPORTUNITY_MIN_ANNUAL_RETURN,
    maxResolutionDays: strategyMaxResolutionDays(portfolioState),
    minLiquidityUsdc: portfolioState.minLiquidityUsdc == null ? null : Number(portfolioState.minLiquidityUsdc),
    requireMostProbableOutcome: Boolean(portfolioState.requireMostProbableOutcome),
    realizedPnlUsdc: Number(realizedPnl.toFixed(4)),
    realizedPnlPct: pnlPercent(realizedPnl, PORTFOLIO_USDC),
    openPnlUsdc: Number(openPnl.toFixed(4)),
    openPnlPct: pnlPercent(openPnl, PORTFOLIO_USDC),
    equityUsdc: Number(equity.toFixed(4)),
    totalPnlUsdc: Number((realizedPnl + openPnl).toFixed(4)),
    totalPnlPct: pnlPercent(realizedPnl + openPnl, PORTFOLIO_USDC),
    openRiskUsdc: Number(openRiskValue.toFixed(2)),
    freeCapitalUsdc: Number(freeCapital.toFixed(2)),
  };
}

function updatePortfolio(state) {
  state.paperPortfolios ||= {};
  for (const strategy of Object.values(PAPER_STRATEGIES)) {
    state.paperPortfolios[strategy.id] ||= normalizePaperPortfolio(strategy, {});
    updatePaperPortfolio(state.paperPortfolios[strategy.id]);
  }
  syncLegacyPaperAliases(state);
}

function recordPortfolioRun(state, portfolioState, { evaluations = [], eligible = [], decision }) {
  const runAt = state.generatedAt;
  const portfolioEligibleCount = Number(decision.batchLog?.counts?.rankedEligible);
  const eligibleCount = Number.isFinite(portfolioEligibleCount) ? portfolioEligibleCount : eligible.length;
  portfolioState.lastDecision = {
    runAt,
    strategyId: portfolioState.id,
    strategyLabel: portfolioState.label,
    selectionMetric: portfolioState.selectionMetric,
    evaluatedCount: evaluations.length,
    eligibleCount,
    action: decision.action,
    reason: decision.reason,
    tradeId: decision.trade?.id || null,
    closedTradeId: decision.closedTrade?.id || null,
    rotationReview: decision.rotationReview || null,
    batchLog: decision.batchLog || null,
    availableCapitalUsdc: decision.available == null ? null : Number(Number(decision.available).toFixed(4)),
    requiredStakeUsdc: decision.requiredStake == null ? null : Number(Number(decision.requiredStake).toFixed(4)),
    insufficientCapital: Boolean(decision.insufficientCapital),
    selectedHorizonDays: decision.trade?.daysToResolution ?? null,
    riskSkippedCount: decision.skippedForRisk || 0,
    refreshOnly: REFRESH_ONLY,
    reportOnly: REPORT_ONLY,
    learningSampleSize: state.learningProfile.sampleSize,
    brierScore: state.learningProfile.brierScore,
    calibrationBias: state.learningProfile.calibrationBias,
  };
  portfolioState.runLog = [
    {
      runAt,
      strategyId: portfolioState.id,
      strategyLabel: portfolioState.label,
      selectionMetric: portfolioState.selectionMetric,
      evaluatedCount: evaluations.length,
      eligibleCount,
      action: decision.action,
      reason: decision.reason,
      tradeId: decision.trade?.id || null,
      closedTradeId: decision.closedTrade?.id || null,
      rotationReview: decision.rotationReview || null,
      batchLog: decision.batchLog || null,
      availableCapitalUsdc: decision.available == null ? null : Number(Number(decision.available).toFixed(4)),
      requiredStakeUsdc: decision.requiredStake == null ? null : Number(Number(decision.requiredStake).toFixed(4)),
      insufficientCapital: Boolean(decision.insufficientCapital),
      riskSkippedCount: decision.skippedForRisk || 0,
      refreshOnly: REFRESH_ONLY,
      reportOnly: REPORT_ONLY,
      learningSampleSize: state.learningProfile.sampleSize,
      brierScore: state.learningProfile.brierScore,
    },
    ...portfolioState.runLog,
  ].slice(0, 120);
  syncLegacyPaperAliases(state);
}

function recordRun(state, { evaluations = [], eligible = [], decisions = [] }) {
  for (const decision of decisions) {
    const portfolioState = state.paperPortfolios?.[decision.strategyId] || state.paperPortfolios?.conservative;
    if (!portfolioState) continue;
    recordPortfolioRun(state, portfolioState, { evaluations, eligible, decision });
  }
  state.evaluationRunLog = [
    {
      id: `evaluation-run-${state.generatedAt}`,
      runAt: state.generatedAt,
      refreshOnly: REFRESH_ONLY,
      reportOnly: REPORT_ONLY,
      evaluatedCount: evaluations.length,
      eligibleCount: eligible.length,
      rejectedCount: evaluations.filter((item) => String(item.status || "").toUpperCase() === "REJECTED").length,
      errorCount: evaluations.filter((item) => String(item.status || "").toUpperCase() === "ERROR").length,
      statusCounts: evaluations.reduce((counts, item) => {
        const status = String(item.status || "UNKNOWN").toUpperCase();
        counts[status] = Number(counts[status] || 0) + 1;
        return counts;
      }, {}),
      decisions: decisions.map((decision) => ({
        strategyId: decision.strategyId,
        action: decision.action,
        reason: decision.reason,
        tradeId: decision.trade?.id || null,
        closedTradeId: decision.closedTrade?.id || null,
        rotationReview: decision.rotationReview || null,
        batchLog: decision.batchLog || null,
        availableCapitalUsdc: decision.available == null ? null : Number(Number(decision.available).toFixed(4)),
        requiredStakeUsdc: decision.requiredStake == null ? null : Number(Number(decision.requiredStake).toFixed(4)),
        insufficientCapital: Boolean(decision.insufficientCapital),
      })),
      events: evaluations.map((item) => ({
        id: item.id,
        evaluatedAt: item.evaluatedAt,
        evaluationResult: String(item.status || "").toUpperCase() === "ERROR" ? "ERROR" : "EVALUATED",
        portfolioFilterStatus: item.status,
        status: item.status,
        question: item.question,
        outcome: item.outcome,
        slug: item.slug,
        eventSlug: item.eventSlug,
        tokenId: item.tokenId,
        url: `https://polymarket.com/event/${item.eventSlug || item.slug || ""}`,
        aiProbability: item.aiProbability,
        rawProbability: item.rawProbability,
        marketPrice: item.marketPrice,
        annualizedReturn: item.annualizedReturn,
        expectedValueUsdc: item.expectedValueUsdc,
        netGainIfWinUsdc: item.netGainIfWinUsdc,
        riskReward: rewardRiskRatio(item),
        liquidity: item.liquidity,
        volume24hr: item.volume24hr,
        endDate: item.endDate,
        daysToResolution: item.daysToResolution,
        rejectReasons: item.rejectReasons,
        analysisSummary: item.analysisSummary,
        probabilityThesis: item.probabilityThesis,
        analysisModel: item.analysisModel,
        riskGroupLabels: item.riskGroupLabels,
      })),
    },
    ...(state.evaluationRunLog || []),
  ].slice(0, 80);
}

function updateEvaluationStats(state, { evaluations = [], retainedBefore = 0, retainedAfter = 0 } = {}) {
  const previousStats = state.evaluationStats || {};
  const previousTotal = Number(previousStats.totalRunEvaluatedCount);
  const loggedTotal = Array.isArray(state.evaluationRunLog)
    ? state.evaluationRunLog.reduce((total, run) => total + Number(run.evaluatedCount || 0), 0)
    : 0;
  const baselineTotal = Number.isFinite(previousTotal) ? previousTotal : loggedTotal;
  const retainedLimit = Number.isFinite(MAX_HISTORY) && MAX_HISTORY > 0 ? MAX_HISTORY : retainedAfter;

  state.evaluationStats = {
    ...previousStats,
    retainedLimit,
    retainedCount: retainedAfter,
    retainedBeforeMergeCount: retainedBefore,
    lastRunEvaluatedCount: evaluations.length,
    lastRunAt: state.generatedAt,
    totalRunEvaluatedCount: baselineTotal + evaluations.length,
    historyTrimmed: retainedLimit > 0 && retainedAfter >= retainedLimit,
    lastTrimmedCount: Math.max(0, retainedBefore - retainedAfter),
    aiUsage: state.aiUsage || null,
  };
}

async function executeManualPaperRunFromStoredCandidates(state, strategiesForRun) {
  const evaluations = [];
  const eligible = [];
  const decisions = [];

  for (const strategy of strategiesForRun) {
    const portfolioState = state.paperPortfolios?.[strategy.id];
    if (!portfolioState) continue;

    const shortlist = storedExecutionShortlist(state, strategy);
    const selectedForRevalidation = shortlist.rows.slice(0, MAX_EVALUATIONS_PER_RUN);
    const revalidated = await revalidateStoredExecutionShortlist(selectedForRevalidation, state.learningProfile, state);
    const rankedEligible = sortEligibleForStrategy(
      revalidated.filter((item) => portfolioFilterResult(item, strategy).eligible),
      strategy,
    );
    const revalidatedRejectedSample = revalidated
      .map((item) => {
        const result = portfolioFilterResult(item, strategy);
        if (result.eligible) return null;
        return {
          ...tradeBatchCandidateSummary(item),
          portfolioRejectReasons: result.reasons,
        };
      })
      .filter(Boolean)
      .slice(0, 30);

    const prevalidationFilter = {
      ...shortlist.diagnostics,
      source: "stored_execution_candidates",
      selectedForRevalidation: selectedForRevalidation.length,
      revalidatedCount: revalidated.length,
      revalidatedPortfolioEligible: rankedEligible.length,
      revalidatedRejected: Math.max(0, revalidated.length - rankedEligible.length),
      skippedByScanLimit: Math.max(0, shortlist.rows.length - selectedForRevalidation.length),
      skippedByRevalidationLimit: Math.max(0, shortlist.rows.length - selectedForRevalidation.length),
      revalidatedCandidates: revalidated.slice(0, 30).map(tradeBatchCandidateSummary).filter(Boolean),
      revalidatedRejectedSample,
    };

    const decision = maybeOpenScheduledTrade(portfolioState, rankedEligible, strategy, revalidated, {
      ignoreCadence: true,
      prevalidationFilter,
      diversificationDiagnostics: {
        source: "stored_execution_candidates",
        note: "Manual paper run revalidated the current portfolio execution shortlist only; no unrelated fresh market scan was used.",
      },
    });
    decisions.push(decision);
    evaluations.push(...revalidated);
    eligible.push(...revalidated.filter((item) => String(item.status || "").toUpperCase() === "ELIGIBLE"));
  }

  state.generatedAt = nowIso();
  updatePortfolio(state);
  const mergedEvaluations = await refreshStoredEvaluationResolutionStatuses(expirePastEvaluations(mergeEvaluationLists(evaluations, state.evaluations)));
  const retainedBefore = new Set([...(state.evaluations || []), ...evaluations].map(evaluationKey).filter(Boolean)).size;
  state.evaluations = mergedEvaluations.map(ensureEvaluationErrorMetadata);
  updateCalculationReport(state);
  updateEvaluationStats(state, { evaluations, retainedBefore, retainedAfter: state.evaluations.length });
  recordRun(state, { evaluations, eligible, decisions });
  await writeState(state);
  console.log(JSON.stringify({
    generatedAt: state.generatedAt,
    source: "stored_execution_candidates",
    decisions: Object.fromEntries(decisions.map((decision) => [decision.strategyId, {
      action: decision.action,
      reason: decision.reason,
      tradeId: decision.trade?.id || null,
      revalidatedCount: decision.batchLog?.prevalidationFilter?.revalidatedCount ?? null,
      revalidatedPortfolioEligible: decision.batchLog?.prevalidationFilter?.revalidatedPortfolioEligible ?? null,
    }])),
  }, null, 2));
}

async function writeState(state) {
  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function run() {
  if (REQUIRE_GEMINI && !GEMINI_API_KEY) {
    throw new Error("PAPER_REQUIRE_GEMINI is true, but GEMINI_API_KEY is not available. Check GitHub secret GEMINI_API_KEY_POLYMARKET and workflow secret access.");
  }
  console.log(JSON.stringify({
    aiProvider: GEMINI_API_KEY ? "gemini" : (OPENAI_API_KEY ? "openai" : "heuristic-only"),
    geminiConfigured: Boolean(GEMINI_API_KEY),
    geminiModel: GEMINI_API_KEY ? GEMINI_MODEL : null,
    requireGemini: REQUIRE_GEMINI,
    aiAnalysisLimit: AI_ANALYSIS_LIMIT,
  }));
  const state = await readState();
  syncLegacyPaperAliases(state);
  state.aiUsage = aiUsageSnapshot(state);
  state.evaluations = (await refreshStoredEvaluationResolutionStatuses(expirePastEvaluations(state.evaluations || [])))
    .map(normalizeAiPendingEvaluation)
    .map(ensureEvaluationErrorMetadata);
  state.marketObservations = (state.marketObservations || []).map(normalizeMarketObservationEconomics);
  // Repair records created before binary outcome flips rebuilt the full quote.
  // This runs even if the current market scan does not include that contract.
  state.evaluations = repairStaleBinarySideQuotes(state.evaluations);
  try {
    const observations = await refreshMarketObservations(state);
    state.evaluations = applyMarketObservationsToEvaluations(state.evaluations, observations);
  } catch (error) {
    state.marketScan = {
      ...normalizeMarketScan(state.marketScan),
      lastScanError: error?.message || String(error),
    };
  }
  recoverLedgerGaps(state);
  for (const portfolioState of Object.values(state.paperPortfolios)) {
    portfolioState.trades = await refreshTrades(portfolioState.trades);
    portfolioState.trades = await reviewClosedTradesWithAi(portfolioState.trades, state);
  }
  const allTrades = Object.values(state.paperPortfolios).flatMap((portfolioState) => portfolioState.trades || []);
  state.learningProfile = buildLearningProfile(allTrades, state.learningProfile);
  state.generatedAt = nowIso();
  updatePortfolio(state);
  updateCalculationReport(state);

  if (REPORT_ONLY) {
    const decisions = Object.values(state.paperPortfolios).map((portfolioState) => ({
      strategyId: portfolioState.id,
      action: "REPORT",
      reason: "nightly resolved-event portfolio replay calculations updated",
    }));
    recordRun(state, {
      decisions,
      eligible: [],
      evaluations: [],
    });
    await writeState(state);
    console.log(JSON.stringify({
      action: "REPORT",
      reason: "nightly resolved-event portfolio replay calculations updated",
      sampleSize: state.latestCalculationReport?.sampleSize || 0,
      strategies: decisions.map((decision) => decision.strategyId),
    }, null, 2));
    return;
  }

  if (REFRESH_ONLY) {
    const decisions = Object.values(state.paperPortfolios).map((portfolioState) => ({
      strategyId: portfolioState.id,
      action: "REFRESH",
      reason: "refreshed open positions and resolved markets only",
    }));
    recordRun(state, {
      decisions,
      eligible: [],
      evaluations: [],
    });
    await writeState(state);
    console.log(JSON.stringify({
        action: "REFRESH",
        reason: "refreshed open positions and resolved markets only",
        strategies: decisions.map((decision) => decision.strategyId),
      }, null, 2));
    return;
  }

  let strategiesForRun = EVALUATION_ONLY ? executionStrategies() : dueExecutionStrategies(state);
  if (!EVALUATION_ONLY && CONTINUOUS_EVALUATION && !strategiesForRun.length) {
    strategiesForRun = executionStrategies();
  }
  if (!strategiesForRun.length) {
    await writeState(state);
    console.log(JSON.stringify({
      action: "CADENCE_WAIT",
      reason: "no paper portfolio is due for a new trading evaluation run yet",
      scheduledCadencePoll: SCHEDULED_CADENCE_POLL,
      portfolios: Object.values(state.paperPortfolios || {}).map((portfolioState) => ({
        strategyId: portfolioState.id,
        lastRunAt: latestPortfolioRunAt(portfolioState),
        tradeCadenceHours: normalizeTradeCadenceHours(PAPER_STRATEGIES[portfolioState.id]?.tradeCadenceHours, 1),
      })),
    }, null, 2));
    return;
  }

  if (MANUAL_RUN_ONCE) {
    await executeManualPaperRunFromStoredCandidates(state, strategiesForRun);
    return;
  }

  const knownEvaluationKeys = new Set((state.evaluations || []).map(evaluationKey).filter(Boolean));
  const knownBinaryMarketKeys = new Set((state.evaluations || []).map(binaryEvaluationMarketKey).filter(Boolean));
  const exposureProfile = openExposureProfile(strategiesForRun.map((strategy) => state.paperPortfolios[strategy.id]).filter(Boolean));
  const diversificationByMarket = new Map();
  const diversificationForMarket = (market) => {
    const key = String(market?.id || market?.slug || market?.question || "");
    if (!diversificationByMarket.has(key)) {
      diversificationByMarket.set(key, marketDiversificationScore(market, exposureProfile));
    }
    return diversificationByMarket.get(key);
  };
  const markets = (EVALUATION_ONLY ? await loadFocusedEvaluationMarkets(state) : await loadMarkets()).sort((a, b) => {
    const aNew = marketHasNewOutcome(a, knownEvaluationKeys, knownBinaryMarketKeys) ? 1 : 0;
    const bNew = marketHasNewOutcome(b, knownEvaluationKeys, knownBinaryMarketKeys) ? 1 : 0;
    if (aNew !== bNew) return bNew - aNew;
    const aDiversification = diversificationForMarket(a).score;
    const bDiversification = diversificationForMarket(b).score;
    if (bDiversification !== aDiversification) return bDiversification - aDiversification;
    return Number(b.volume24hr || 0) - Number(a.volume24hr || 0);
  });
  const diversificationDiagnostics = {
    openTrades: exposureProfile.openTrades.length,
    occupiedTags: exposureProfile.tagCounts,
    occupiedCategories: exposureProfile.categoryCounts,
    topDiversifiedMarkets: markets.slice(0, 12).map((market) => {
      const diversification = diversificationForMarket(market);
      return {
        question: market.question || "",
        slug: market.slug || "",
        volume24hr: Number(market.volume24hr || 0),
        diversificationScore: Number(diversification.score.toFixed(2)),
        category: diversification.category,
        tags: diversification.tags,
        reasons: diversification.reasons,
      };
    }),
  };
  let evaluations = [];

  for (const market of markets) {
    const outcomes = parseJsonField(market.outcomes);
    const tokenIds = parseJsonField(market.clobTokenIds);
    const binaryIndexes = binaryYesNoOutcomeIndexes(outcomes);
    const requestedOutcomeIndex = EVALUATION_TOKEN_ID
      ? tokenIds.findIndex((tokenId) => String(tokenId) === EVALUATION_TOKEN_ID)
      : -1;
    const outcomeIndexes = binaryIndexes
      ? [binaryIndexes.yesIndex]
      : requestedOutcomeIndex >= 0
      ? [requestedOutcomeIndex]
      : Array.from({ length: Math.min(outcomes.length, tokenIds.length, 2) }, (_, index) => index);

    for (const outcomeIndex of outcomeIndexes) {
      if (evaluations.length >= MAX_EVALUATIONS_PER_RUN) break;
      const tokenId = tokenIds[outcomeIndex];
      if (!tokenId) continue;

      try {
        const book = await fetchJson(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(tokenId)}`);
        const evaluation = evaluateCandidate({ market, outcomeIndex, tokenId, book, learningProfile: state.learningProfile });
        if (evaluation) {
          if (binaryIndexes) {
            evaluation._binaryCounterpart = {
              market,
              outcomeIndex: binaryIndexes.noIndex,
              outcome: outcomes[binaryIndexes.noIndex] || "No",
              tokenId: tokenIds[binaryIndexes.noIndex],
              yesTokenId: tokenIds[binaryIndexes.yesIndex],
              learningProfile: state.learningProfile,
            };
          }
          evaluations.push(evaluation);
        }
      } catch (error) {
        const errorMessage = error?.message || String(error || "Unknown orderbook error");
        evaluations.push(ensureEvaluationErrorMetadata({
          id: tokenId ? `token:${tokenId}` : `market:${market.slug || market.id || "unknown"}:${outcomes[outcomeIndex] || outcomeIndex}`,
          evaluatedAt: nowIso(),
          status: "ERROR",
          question: market.question || "",
          outcome: outcomes[outcomeIndex] || `Outcome ${outcomeIndex + 1}`,
          tokenId,
          rawErrorMessage: errorMessage,
          rejectReasons: [errorMessage],
          analysisSummary: `Orderbook fetch failed: ${errorMessage}`,
        }));
      }
    }
  }

  evaluations = (await enrichEvaluationsWithAi(evaluations, state.learningProfile, state)).map(normalizeEvaluationRisk);
  const eligible = evaluations.filter((item) => item.status === "ELIGIBLE" && (!REQUIRE_GEMINI || hasGroundedPublicMemo(item)));
  const executionEvaluations = evaluations.filter((item) => item.status !== "ERROR" && (!REQUIRE_GEMINI || hasGroundedPublicMemo(item)));
  const decisions = EVALUATION_ONLY
    ? strategiesForRun.map((strategy) => ({
        action: "EVALUATION_ONLY",
        reason: `manual evaluation completed for ${evaluations.length} selected Polymarket outcome${evaluations.length === 1 ? "" : "s"}; no trade was considered`,
        strategyId: strategy.id,
        evaluatedCount: evaluations.length,
        eligibleCount: eligible.length,
        batchLog: {
          action: "EVALUATION_ONLY",
          reason: "manual single-opportunity evaluation",
          explanation: "A single Polymarket opportunity was evaluated on demand. Portfolio positions and trade cadence were not changed.",
          evaluatedCount: evaluations.length,
          eligibleCount: eligible.length,
          selected: evaluations[0] ? tradeBatchCandidateSummary(evaluations[0]) : null,
          evaluationOnly: true,
        },
      }))
    : strategiesForRun.map((strategy) => {
        const portfolioState = state.paperPortfolios[strategy.id];
        const strategyExecutionRows = executionRowsForStrategy(state, strategy, executionEvaluations);
        const rankedEligible = sortEligibleForStrategy(
          strategyExecutionRows.filter((item) => portfolioFilterResult(item, strategy).eligible),
          strategy,
        );
        return maybeOpenScheduledTrade(portfolioState, rankedEligible, strategy, strategyExecutionRows, { ignoreCadence: MANUAL_RUN_ONCE, diversificationDiagnostics });
      });

  state.generatedAt = nowIso();
  updatePortfolio(state);
  const mergedEvaluations = await refreshStoredEvaluationResolutionStatuses(expirePastEvaluations(mergeEvaluationLists(evaluations, state.evaluations)));
  const retainedBefore = new Set([...(state.evaluations || []), ...evaluations].map(evaluationKey).filter(Boolean)).size;
  state.evaluations = mergedEvaluations.map(ensureEvaluationErrorMetadata);
  updateCalculationReport(state);
  updateEvaluationStats(state, { evaluations, retainedBefore, retainedAfter: state.evaluations.length });
  recordRun(state, { evaluations, eligible, decisions });
  await writeState(state);
  console.log(JSON.stringify({
    generatedAt: state.generatedAt,
    decisions: Object.fromEntries(decisions.map((decision) => [decision.strategyId, {
      action: decision.action,
      reason: decision.reason,
      tradeId: decision.trade?.id || null,
    }])),
  }, null, 2));
}

run().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
