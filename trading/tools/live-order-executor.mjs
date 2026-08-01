#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

function envNumber(name, fallback = null) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function envTokenIdSet(name) {
  return new Set(String(process.env[name] || "")
    .split(",")
    .map((tokenId) => tokenId.trim())
    .filter((tokenId) => /^\d{8,100}$/.test(tokenId)));
}

const PAPER_STATE_URL = process.env.PAPER_STATE_URL || "https://osobnizkusenosti.cz/trading/api.php?action=state&target=paper";
const PAPER_SCRAPED_STATE_URL = process.env.PAPER_SCRAPED_STATE_URL || "https://osobnizkusenosti.cz/trading/api.php?action=state&target=paper&summary=scraped";
const LIVE_STATE_URL = process.env.LIVE_STATE_URL || "https://osobnizkusenosti.cz/trading/api.php?action=state&target=live";
const LIVE_EXECUTION_STATE_URL = process.env.LIVE_EXECUTION_STATE_URL || "https://osobnizkusenosti.cz/trading/api.php?action=state&target=live-execution";
const GAMMA_API = process.env.POLYMARKET_GAMMA_API || "https://gamma-api.polymarket.com";
const CLOB_HOST = process.env.POLYMARKET_HOST || "https://clob.polymarket.com";
const CHAIN_ID = Number(process.env.POLYMARKET_CHAIN_ID || 137);
const MIN_PROBABILITY = envNumber("LIVE_MIN_PROBABILITY", envNumber("PAPER_MIN_PROBABILITY", 0.95));
const PROBABILITY_SOURCE = process.env.LIVE_PROBABILITY_SOURCE === "polymarket" ? "polymarket" : "ai";
const MIN_ANNUAL_RETURN = envNumber("LIVE_MIN_ANNUAL_RETURN", envNumber("PAPER_MIN_ANNUAL_RETURN", 0.05));
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
const MANUAL_SHORTLIST_PROBABILITY_SOURCE = String(process.env.LIVE_EXECUTION_SHORTLIST_PROBABILITY_SOURCE || "").trim().toLowerCase();
const HAS_MANUAL_SHORTLIST = MANUAL_SHORTLIST_TOKEN_IDS.length > 0;
const EXCLUDED_CANDIDATE_TOKEN_IDS = envTokenIdSet("LIVE_EXCLUDED_CANDIDATE_TOKEN_IDS");
const MAX_ORDER_FRACTION = envNumber("MAX_ORDER_FRACTION", envNumber("LIVE_MAX_ORDER_FRACTION", 0.05));
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
const HAS_EXPLICIT_TRADE_CADENCE = process.env.LIVE_TRADE_CADENCE_HOURS != null && process.env.LIVE_TRADE_CADENCE_HOURS !== "";
const ONE_TRADE_PER_DAY = HAS_EXPLICIT_TRADE_CADENCE
  ? false
  : String(process.env.LIVE_ONE_TRADE_PER_DAY ?? "true").toLowerCase() !== "false";
const TRADE_CADENCE_HOURS = Math.min(168, Math.max(1, Math.round(envNumber("LIVE_TRADE_CADENCE_HOURS", ONE_TRADE_PER_DAY ? 24 : 1))));
const IGNORE_TRADE_CADENCE = String(process.env.LIVE_IGNORE_TRADE_CADENCE || "").toLowerCase() === "true";
const SCHEDULED_CADENCE_POLL = String(process.env.LIVE_SCHEDULED_CADENCE_POLL || "").toLowerCase() === "true";
const OPEN_ORDER_REVIEW_AFTER_HOURS = envNumber("LIVE_OPEN_ORDER_REVIEW_AFTER_HOURS", 2);
const OPEN_ORDER_CANCEL_AFTER_HOURS = envNumber("LIVE_OPEN_ORDER_CANCEL_AFTER_HOURS", 8);
const OPEN_ORDER_REPRICE_THRESHOLD = envNumber("LIVE_OPEN_ORDER_REPRICE_THRESHOLD", 0.015);
const OPEN_ORDER_BETTER_CANDIDATE_EV_USDC = envNumber("LIVE_OPEN_ORDER_BETTER_CANDIDATE_EV_USDC", 0.02);
const ROTATION_CANDIDATE_SCAN_LIMIT = envNumber("LIVE_ROTATION_CANDIDATE_SCAN_LIMIT", 10);
const ROTATION_POSITION_SCAN_LIMIT = envNumber("LIVE_ROTATION_POSITION_SCAN_LIMIT", 6);
const ROTATION_MIN_EV_USDC_IMPROVEMENT = envNumber("LIVE_ROTATION_MIN_EV_USDC_IMPROVEMENT", 0.02);
const ROTATION_MIN_ANNUALIZED_IMPROVEMENT = envNumber("LIVE_ROTATION_MIN_ANNUALIZED_IMPROVEMENT", 0.25);
const LIVE_AUTO_ROTATE = String(process.env.LIVE_AUTO_ROTATE ?? "true").toLowerCase() !== "false";
const OPEN_STATUSES = new Set(["OPEN", "PENDING_RESOLUTION", "MARKET_NOT_FOUND", "ORDER_STATUS_LIVE", "LIVE"]);
const TZ = "Europe/Prague";
let previousExecutionState = null;

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function number(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
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

async function loadJsonResource(location, label = location) {
  const source = String(location || "");
  if (/^https?:\/\//i.test(source)) {
    return fetchJson(`${source}${source.includes("?") ? "&" : "?"}t=${Date.now()}`, label);
  }
  const path = source.startsWith("file://") ? new URL(source) : source;
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw);
}

async function loadOptionalJsonResource(location, label = location) {
  try {
    return await loadJsonResource(location, label);
  } catch {
    return null;
  }
}

function pragueDateKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function hoursSince(value, now = new Date()) {
  const time = Date.parse(value || "");
  if (!Number.isFinite(time)) return null;
  return Math.max(0, (now.getTime() - time) / 3600000);
}

function isCadenceWaitRun(row = {}) {
  const action = String(row.action || row.batchLog?.action || "").toUpperCase();
  const reason = String(row.reason || row.batchLog?.reason || "");
  return action === "CADENCE_WAIT" || /cadence poll is not due|poll is not due/i.test(reason);
}

function latestLiveExecutionRunAt(previousExecution = {}) {
  const fromLog = Array.isArray(previousExecution?.runLog)
    ? previousExecution.runLog.find((row) => !isCadenceWaitRun(row))?.runAt
    : null;
  const rootGeneratedAt = isCadenceWaitRun(previousExecution) ? null : previousExecution?.generatedAt;
  const rootBatchAt = isCadenceWaitRun(previousExecution?.batchLog || {}) ? null : previousExecution?.batchLog?.runAt;
  const candidates = [fromLog, rootGeneratedAt, rootBatchAt];
  return candidates.find((value) => Number.isFinite(Date.parse(value || ""))) || null;
}

function liveExecutionRunDue(previousExecution, liveState, now = new Date()) {
  if (!SCHEDULED_CADENCE_POLL || IGNORE_TRADE_CADENCE) return true;
  if (rotationReplacementDue(previousExecution, liveState)) return true;
  if (Array.isArray(liveState?.openOrders) && liveState.openOrders.length > 0) return true;
  const lastRunAt = latestLiveExecutionRunAt(previousExecution);
  if (!lastRunAt) return true;
  return Number(hoursSince(lastRunAt, now) ?? Infinity) >= TRADE_CADENCE_HOURS;
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
  return Number.isFinite(days) && days > 0 ? netYield * (365 / days) : netYield;
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

function rotationReplacementDue(previousExecution, liveState) {
  const tokenId = previousExecution?.rotationExit?.position?.tokenId;
  if (!tokenId) return false;
  const stillHeld = (Array.isArray(liveState?.positions) ? liveState.positions : [])
    .some((position) => String(position.tokenId || position.assetId || "") === String(tokenId) && number(position.shares, 0) > 0);
  return !stillHeld && !hasOpenSellOrderForToken(liveState, tokenId);
}

function liveCashMonitoring(previousExecution, cash, now = new Date()) {
  const previousMonitoring = previousExecution?.monitoring || {};
  const previousCash = number(previousExecution?.account?.cashUsdc);
  const cashAboveLimit = Number.isFinite(cash) && cash > IDLE_CASH_MAX_USDC;
  const idleCashSince = cashAboveLimit
    ? (previousCash != null && previousCash > IDLE_CASH_MAX_USDC ? previousMonitoring.idleCashSince : null) || now.toISOString()
    : null;
  const idleHours = idleCashSince ? hoursSince(idleCashSince, now) : 0;
  const lastSubmittedAt = previousExecution?.action === "SUBMITTED"
    ? previousExecution.generatedAt
    : previousMonitoring.lastSubmittedAt || null;
  const submittedHoursAgo = lastSubmittedAt ? hoursSince(lastSubmittedAt, now) : null;
  const submittedToday = ONE_TRADE_PER_DAY
    && lastSubmittedAt
    && pragueDateKey(new Date(lastSubmittedAt)) === pragueDateKey(now);
  const rawCadenceBlocked = lastSubmittedAt
    ? Number(submittedHoursAgo ?? Infinity) < TRADE_CADENCE_HOURS
    : false;
  const cadenceBlocked = IGNORE_TRADE_CADENCE ? false : rawCadenceBlocked;

  return {
    idleCashLimitUsdc: IDLE_CASH_MAX_USDC,
    idleCashGraceHours: IDLE_CASH_GRACE_HOURS,
    cashAboveIdleLimit: cashAboveLimit,
    idleCashSince,
    idleCashHours: idleHours == null ? null : Number(idleHours.toFixed(2)),
    idleCashOverdue: cashAboveLimit && Number(idleHours || 0) >= IDLE_CASH_GRACE_HOURS,
    lastSubmittedAt,
    submittedHoursAgo: submittedHoursAgo == null ? null : Number(submittedHoursAgo.toFixed(2)),
    submittedToday,
    cadenceBlocked,
    rawCadenceBlocked,
    ignoreTradeCadence: IGNORE_TRADE_CADENCE,
    tradeCadenceHours: TRADE_CADENCE_HOURS,
    oneTradePerDay: ONE_TRADE_PER_DAY,
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

function daysToEnd(endDate) {
  const end = Date.parse(endDate || "");
  if (!Number.isFinite(end)) return null;
  return Math.max(1, (end - Date.now()) / 86400000);
}

function endDateIsFuture(endDate) {
  const end = Date.parse(endDate || "");
  return Number.isFinite(end) && end > Date.now();
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

function localDaysToResolution(item) {
  const stored = number(item?.daysToResolution);
  if (stored != null) return stored;
  const end = Date.parse(item?.endDate || "");
  if (!Number.isFinite(end)) return Infinity;
  return (end - Date.now()) / 86400000;
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

function prefilterLiveCandidate(item) {
  const reasons = [];
  const tokenId = String(item?.tokenId || "");
  const status = String(item?.status || "").toUpperCase();
  const aiPending = item?.selectionStatus === "AI_PENDING" || item?.aiAnalysis?.aiModelStatus === "QUOTA_LIMITED";
  const qualificationProbability = selectedProbability(item);
  const endTime = Date.parse(item?.endDate || "");
  const days = localDaysToResolution(item);

  if (!tokenId) reasons.push("missing token id");
  if (EXCLUDED_CANDIDATE_TOKEN_IDS.has(tokenId)) reasons.push("manually excluded from this live portfolio");
  if (status === "ERROR") {
    reasons.push("stored status ERROR");
  } else if (["RESOLVED", "CLOSED", "FINALIZED", "SETTLED"].includes(status)) {
    reasons.push(`stored status ${status}`);
  } else if (PROBABILITY_SOURCE === "ai" && status && !["ELIGIBLE", "EVALUATED"].includes(status)) {
    reasons.push(`stored status ${status}`);
  }
  if (PROBABILITY_SOURCE === "ai" && aiPending) reasons.push("grounded Gemini analysis is pending");
  if (item?.marketClosed === true || item?.closed === true || item?.resolved === true || item?.isResolved === true) {
    reasons.push("stored market is already closed/resolved");
  }
  if (item?.acceptingOrders === false) reasons.push("stored market is not accepting orders");
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
  }
  const annualizedReturn = selectedAnnualizedReturn(item);
  if (!Number.isFinite(annualizedReturn)) {
    reasons.push(`missing ${probabilitySourceLabel()} ${returnMetricLabel()}`);
  } else if (annualizedReturn <= 0) {
    reasons.push(`${probabilitySourceLabel()} ${returnMetricLabel()} ${(annualizedReturn * 100).toFixed(1)}% is non-profitable after fees`);
  }
  const candidateNetYield = netYieldAfterFees(item);
  if (candidateNetYield == null || candidateNetYield < MIN_NET_YIELD) {
    reasons.push(`net profit ${candidateNetYield == null ? "-" : `${(candidateNetYield * 100).toFixed(1)}%`} below ${(MIN_NET_YIELD * 100).toFixed(1)}% after fees`);
  }
  if (Number.isFinite(endTime) && endTime <= Date.now()) {
    reasons.push("stored end date is in the past");
  }
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
    const aAnnualized = selectedAnnualizedReturn(a) ?? -Infinity;
    const bAnnualized = selectedAnnualizedReturn(b) ?? -Infinity;
    if (bAnnualized !== aAnnualized) return bAnnualized - aAnnualized;
    const horizon = compareShorterHorizon(a, b);
    if (horizon !== 0) return horizon;
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
  if (/stored resolution .* exceeds live max/i.test(text)) return "stored resolution exceeds live max days";
  if (/outside live revalidation scan limit/i.test(text)) return "outside live revalidation scan limit after short-expiry ranking";
  return text || "unknown prevalidation reason";
}

function incrementReason(counts, reason) {
  const key = prefilterReasonCountKey(reason);
  counts[key] = number(counts[key], 0) + 1;
}

function prepareLiveCandidatePool(evaluations = []) {
  const uniqueEvaluations = latestUniqueEvaluations(evaluations);
  const reasonCounts = {};
  let prefilterRejectedCount = 0;
  const prefilterPassed = [];

  for (const item of uniqueEvaluations) {
    const result = prefilterLiveCandidate(item);
    if (result.passed) {
      prefilterPassed.push({
        ...item,
        daysToResolution: Number.isFinite(result.days) ? Number(result.days.toFixed(2)) : item.daysToResolution,
      });
      continue;
    }
    for (const reason of result.reasons) incrementReason(reasonCounts, reason);
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
  const selected = HAS_MANUAL_SHORTLIST
    ? requestedShortlist
    : ranked.slice(0, Math.max(0, CANDIDATE_SCAN_LIMIT));
  const skippedByLimit = HAS_MANUAL_SHORTLIST
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
      reasonCounts,
      rejectedSample: [],
      skippedByLimitSample: [],
      executionShortlist: selected.slice(0, Math.min(20, HAS_MANUAL_SHORTLIST ? MANUAL_SHORTLIST_TOKEN_IDS.length : CANDIDATE_SCAN_LIMIT)).map(liveBatchCandidateSummary),
    },
  };
}

async function fetchMarket(evaluation) {
  const slug = evaluation.slug || evaluation.marketSlug;
  if (!slug) return null;
  const markets = await fetchJson(apiUrl(GAMMA_API, "/markets", { slug }), `Gamma market ${slug}`);
  return Array.isArray(markets) ? markets[0] : null;
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

function daysValue(item) {
  const days = Number(item.daysToResolution);
  return Number.isFinite(days) ? days : Infinity;
}

function compareShorterHorizon(a, b) {
  const delta = daysValue(a) - daysValue(b);
  return Number.isFinite(delta) ? delta : 0;
}

// The portfolio's selection rule is the source of truth for every replacement
// decision as well as for the initial shortlist.  Do not compare an open order
// by absolute dollar EV when the portfolio is ranked by annualized return (or
// R/R): that can replace a better-ranked order with a lower-ranked one.
function compareLiveCandidatePriority(a, b) {
  if (SELECTION_ORDER === "highest_reward_risk_first") {
    const aRatio = Number(a?.riskReward || 0);
    const bRatio = Number(b?.riskReward || 0);
    if (bRatio !== aRatio) return bRatio - aRatio;
  }
  const aAnnualized = selectedAnnualizedReturn(a) ?? -Infinity;
  const bAnnualized = selectedAnnualizedReturn(b) ?? -Infinity;
  if (bAnnualized !== aAnnualized) return bAnnualized - aAnnualized;
  const horizon = compareShorterHorizon(a, b);
  if (horizon !== 0) return horizon;
  return (selectedExpectedValue(b) ?? -Infinity) - (selectedExpectedValue(a) ?? -Infinity);
}

function sortLiveEligibleCandidates(rows = []) {
  return [...rows]
    .filter((item) => Number.isFinite(selectedAnnualizedReturn(item)) && selectedAnnualizedReturn(item) > 0)
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
    if (!CROSS_PORTFOLIO_RISK_DIVERSIFICATION) continue;
    const itemRisk = riskProfile({
      question: item.question || "",
      slug: item.slug || "",
      eventSlug: item.eventSlug || "",
      outcome: item.outcome || "",
      tags: item.tags || tagQuestion(item.question || ""),
    });
    const overlap = itemRisk.keys.filter((key) => candidateKeys.has(key));
    if (overlap.length) return { reason: "correlated live exposure", overlap: overlap.slice(0, 4) };
  }
  return null;
}

function openPositionsForRotation(liveState) {
  return (Array.isArray(liveState?.positions) ? liveState.positions : [])
    .filter((position) => {
      const status = String(position.status || "OPEN").toUpperCase();
      if (!OPEN_STATUSES.has(status) && ["WON", "LOST", "CLOSED", "REDEEMED", "SOLD"].includes(status)) return false;
      const tokenId = String(position.tokenId || position.assetId || "");
      return number(position.shares, 0) > 0 && tokenId && !hasOpenSellOrderForToken(liveState, tokenId);
    });
}

function positionExitValue(position) {
  const explicit = number(position.currentValueUsdc ?? position.valueUsdc ?? position.marketValueUsdc);
  if (explicit != null) return explicit;
  const price = number(position.currentPrice ?? position.markPrice ?? position.price);
  const shares = number(position.shares ?? position.size);
  return price != null && shares != null ? price * shares : null;
}

function positionCost(position) {
  return number(position.totalCostUsdc ?? position.stakeUsdc ?? position.maxLossUsdc, 0);
}

function positionSourceEvaluation(position, evaluationByToken = new Map()) {
  return evaluationByToken.get(String(position.tokenId || position.assetId || "")) || null;
}

function positionExitFee(position, evaluationByToken = new Map()) {
  if (USE_LIMIT_ORDERS && POST_ONLY) return 0;
  const source = positionSourceEvaluation(position, evaluationByToken);
  const shares = number(position.shares ?? position.size);
  const price = number(position.currentPrice ?? position.markPrice ?? position.price);
  if (shares == null || price == null) return 0;
  return takerFee(shares, price, feeRateForEvaluation(source || {}));
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
  const holdExpectedPnl = expectedPayout == null ? null : expectedPayout - cost;
  const continuationExpectedValue = expectedPayout != null && netExitValue != null
    ? expectedPayout - netExitValue
    : null;
  const days = number(source?.daysToResolution);
  const continuationAnnualizedReturn = continuationExpectedValue != null && netExitValue != null && netExitValue > 0 && days != null && days > 0
    ? (continuationExpectedValue / netExitValue) * (365 / days)
    : null;
  return {
    source,
    grossExitValue,
    exitFee,
    netExitValue,
    cost,
    expectedPayout,
    realizedPnlIfExit,
    holdExpectedPnl,
    continuationExpectedValue,
    continuationAnnualizedReturn,
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
  if (economics.continuationAnnualizedReturn != null) return economics.continuationAnnualizedReturn;
  return selectedAnnualizedReturn(economics.source) ?? 0;
}

function positionHoldRiskReward(position, evaluationByToken = new Map()) {
  const source = positionSourceEvaluation(position, evaluationByToken);
  const sourceRatio = number(source?.riskReward);
  if (sourceRatio != null) return sourceRatio;
  const gain = number(source?.netGainIfWinUsdc);
  const cost = number(source?.totalCostUsdc ?? source?.stakeUsdc ?? position.totalCostUsdc ?? position.stakeUsdc);
  return gain != null && cost != null && cost > 0 ? gain / cost : 0;
}

function rotationPriority(position, evaluationByToken = new Map()) {
  if (SELECTION_ORDER === "highest_reward_risk_first") {
    return { metric: "R/R", value: positionHoldRiskReward(position, evaluationByToken) };
  }
  return { metric: "EV p.a.", value: positionHoldAnnualizedReturn(position, evaluationByToken) };
}

function rotationPositionSummary(position, evaluationByToken = new Map(), extra = {}) {
  const economics = positionRotationEconomics(position, evaluationByToken);
  const exitValue = economics.netExitValue;
  const cost = economics.cost;
  const holdEv = positionHoldExpectedValue(position, evaluationByToken);
  const holdAnnualizedReturn = positionHoldAnnualizedReturn(position, evaluationByToken);
  const priority = rotationPriority(position, evaluationByToken);
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
    realizedPnlIfExitUsdc: economics.realizedPnlIfExit == null ? null : Number(economics.realizedPnlIfExit.toFixed(5)),
    holdExpectedValueUsdc: Number(holdEv.toFixed(5)),
    holdExpectedPnlUsdc: economics.holdExpectedPnl == null ? null : Number(economics.holdExpectedPnl.toFixed(5)),
    holdAnnualizedReturn: Number(holdAnnualizedReturn.toFixed(5)),
    rotationPriorityMetric: priority.metric,
    rotationPriorityValue: Number(priority.value.toFixed(5)),
    url: position.url || `https://polymarket.com/event/${position.eventSlug || position.slug || ""}`,
    ...extra,
  };
}

function candidatePoolForRotation(baseCandidates = []) {
  return [...baseCandidates]
    .filter((item) => Number.isFinite(selectedProbability(item)))
    .filter((item) => Number.isFinite(selectedAnnualizedReturn(item)) && selectedAnnualizedReturn(item) > 0)
    .filter((item) => Number.isFinite(selectedExpectedValue(item)) && selectedExpectedValue(item) > 0)
    .sort((a, b) => {
      const annualized = (selectedAnnualizedReturn(b) ?? 0) - (selectedAnnualizedReturn(a) ?? 0);
      if (annualized) return annualized;
      return (selectedExpectedValue(b) ?? 0) - (selectedExpectedValue(a) ?? 0);
    })
    .slice(0, ROTATION_CANDIDATE_SCAN_LIMIT);
}

function candidateRequiresSpecificPositionExit(candidate, position, liveState, evaluationByToken = new Map()) {
  const beforeExit = riskBlock(candidate, liveState, evaluationByToken);
  if (!beforeExit) return false;
  const afterExit = riskBlock(candidate, liveStateWithoutPosition(liveState, position), evaluationByToken);
  return !afterExit;
}

async function reviewPositionRotation({ liveState, evaluationByToken, baseCandidates, cash, maxNotional, restrictToRiskReplacement = false }) {
  const positions = openPositionsForRotation(liveState)
    .map((position) => {
      const economics = positionRotationEconomics(position, evaluationByToken);
      return {
        position,
        exitValue: economics.netExitValue,
        holdEv: positionHoldExpectedValue(position, evaluationByToken),
        holdAnnualizedReturn: positionHoldAnnualizedReturn(position, evaluationByToken),
        priority: rotationPriority(position, evaluationByToken),
        economics,
      };
    })
    // Review the weakest held position first according to this portfolio's own selection rule.
    .sort((a, b) => {
      if (a.priority.value !== b.priority.value) return a.priority.value - b.priority.value;
      if (a.holdAnnualizedReturn !== b.holdAnnualizedReturn) return a.holdAnnualizedReturn - b.holdAnnualizedReturn;
      return a.holdEv - b.holdEv;
    })
    .slice(0, ROTATION_POSITION_SCAN_LIMIT);
  const candidates = candidatePoolForRotation(baseCandidates);
  const reviews = [];
  let best = null;

  if (!positions.length) {
    return {
      action: "NO_ROTATION_CANDIDATE",
      reason: "no open live position can be evaluated for rotation",
      reviews,
      best: null,
    };
  }

  for (const item of positions) {
    const { position, exitValue, holdEv, holdAnnualizedReturn, economics } = item;
    const baseReview = rotationPositionSummary(position, evaluationByToken);
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
        );
        if (revalidated.status !== "ELIGIBLE") {
          rejectedCandidates.push(liveBatchCandidateSummary(revalidated));
          continue;
        }
        const candidateEv = number(revalidated.expectedValueUsdc, 0);
        const candidateAnnualizedReturn = number(revalidated.annualizedReturn, 0);
        // Both paths now start from the same current portfolio state. The exit
        // P/L and estimated exit fee are included in the rotate path.
        const realizedPnlIfExit = economics.realizedPnlIfExit != null ? economics.realizedPnlIfExit : 0;
        const holdExpectedPnl = economics.holdExpectedPnl != null ? economics.holdExpectedPnl : holdEv;
        const rotatedExpectedPnl = realizedPnlIfExit + candidateEv;
        const evDelta = rotatedExpectedPnl - holdExpectedPnl;
        const annualizedDelta = candidateAnnualizedReturn - holdAnnualizedReturn;
        const rotationPreferred = evDelta >= ROTATION_MIN_EV_USDC_IMPROVEMENT
          || (evDelta > 0 && annualizedDelta >= ROTATION_MIN_ANNUALIZED_IMPROVEMENT);
        const review = {
          position: baseReview,
          candidate: liveBatchCandidateSummary(revalidated),
          action: rotationPreferred ? "ROTATION_AVAILABLE" : "HOLD_CURRENT_POSITION",
          reason: rotationPreferred
            ? `after estimated exit fees and realized P/L, candidate improves expected result by ${evDelta.toFixed(4)} USDC and EV p.a. by ${(annualizedDelta * 100).toFixed(1)} pts`
            : `after estimated exit fees and realized P/L, candidate change is ${evDelta.toFixed(4)} USDC / ${(annualizedDelta * 100).toFixed(1)} EV p.a. pts and does not justify rotation`,
          cashAfterExitUsdc: Number(cashAfterExit.toFixed(5)),
          evDeltaUsdc: Number(evDelta.toFixed(5)),
          annualizedDelta: Number(annualizedDelta.toFixed(5)),
          rotatedExpectedPnlUsdc: Number(rotatedExpectedPnl.toFixed(5)),
          holdExpectedPnlUsdc: Number(holdExpectedPnl.toFixed(5)),
          rejectedCandidates,
        };
        if (!bestForPosition
          || annualizedDelta > bestForPosition.annualizedDelta
          || (annualizedDelta === bestForPosition.annualizedDelta && evDelta > bestForPosition.evDeltaUsdc)) {
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
        || bestForPosition.annualizedDelta > best.annualizedDelta
        || (bestForPosition.annualizedDelta === best.annualizedDelta && bestForPosition.evDeltaUsdc > best.evDeltaUsdc))) {
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
        : "a better candidate could be opened after selling an existing position; live sell/rebuy execution is not automated in this step")
      : "selling reviewed open positions did not produce a better executable candidate",
    reviews,
    best,
  };
}

function scoreEconomics({ probability, qualificationProbability, annualizedReturn, netYield, edge, spread, volume24hr, liquidity, endOk }) {
  const probabilityOk = qualificationProbability >= MIN_PROBABILITY;
  const opportunityOk = probability >= OPPORTUNITY_MIN_PROBABILITY
    && edge >= OPPORTUNITY_MIN_EDGE
    && annualizedReturn >= OPPORTUNITY_MIN_ANNUAL_RETURN;
  const minimumAnnualizedReturn = PROBABILITY_SOURCE === "polymarket" ? 0 : MIN_ANNUAL_RETURN;
  const returnOk = annualizedReturn > minimumAnnualizedReturn;
  const netYieldOk = Number.isFinite(netYield) && netYield >= MIN_NET_YIELD;
  const spreadOk = spread != null && spread <= MAX_SPREAD;
  const volumeOk = volume24hr >= MIN_VOLUME_24H || liquidity >= MIN_VOLUME_24H;
  return {
    eligible: endOk && probabilityOk && returnOk && netYieldOk && spreadOk && volumeOk,
    thesisType: probabilityOk ? "HIGH_CONFIDENCE" : (opportunityOk ? "EDGE_OPPORTUNITY_BELOW_LIVE_THRESHOLD" : "REJECTED"),
    rejectReasons: [
      endOk ? null : "event end date is in the past",
      probabilityOk ? null : `${probabilitySourceLabel()} ${(qualificationProbability * 100).toFixed(1)}% below live threshold ${(MIN_PROBABILITY * 100).toFixed(1)}%`,
      annualizedReturn <= 0
        ? `${probabilitySourceLabel()} ${returnMetricLabel()} ${(annualizedReturn * 100).toFixed(1)}% is non-profitable after fees`
        : (returnOk ? null : `${probabilitySourceLabel()} ${returnMetricLabel()} ${(annualizedReturn * 100).toFixed(1)}% below ${(minimumAnnualizedReturn * 100).toFixed(1)}%`),
      netYieldOk ? null : `net profit ${Number.isFinite(netYield) ? `${(netYield * 100).toFixed(1)}%` : "-"} below ${(MIN_NET_YIELD * 100).toFixed(1)}% after fees`,
      spreadOk ? null : `spread ${spread == null ? "n/a" : (spread * 100).toFixed(1) + " pts"} too wide`,
      volumeOk ? null : "liquidity/volume too low",
    ].filter(Boolean),
  };
}

function orderPriceForBook(book, tick) {
  if (!USE_LIMIT_ORDERS) return book.bestAsk;
  if (book.bestBid != null && book.bestAsk != null && book.bestBid < book.bestAsk) return roundToTick(book.bestBid, tick, "down");
  if (book.bestAsk != null) return roundToTick(book.bestAsk - tick, tick, "down");
  return null;
}

function sharesForOrder({ price, minOrderSize, maxNotional, cash, feeRate = 0 }) {
  const targetStake = Math.max(0, number(maxNotional, 0));
  const availableCash = Math.max(0, number(cash, 0));
  // The portfolio percentage caps the cash committed, not the potential payout.
  // For taker orders, reserve the estimated fee inside that cap as well.
  const usableStake = Math.min(targetStake, availableCash);
  const appliedFeeRate = USE_LIMIT_ORDERS && POST_ONLY ? 0 : Math.max(0, number(feeRate, 0));
  const costPerShare = price * (1 + appliedFeeRate * (1 - price));
  const minNotional = price * minOrderSize;
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

  return {
    size: size > 0 ? Number(size.toFixed(4)) : null,
    targetStake,
    usableStake,
    minNotional,
    minSizeOverride: belowExchangeMinimum,
    sizingNote: size <= 0
      ? "no available cash for a positive stake"
      : (belowExchangeMinimum
        ? `sized to the available ${usableStake.toFixed(4)} USDC stake (below the displayed ${minOrderSize.toFixed(4)}-share exchange minimum; submission will verify acceptance)`
        : (usableStake < targetStake
          ? "sized from available cash below the configured portfolio stake"
          : "sized from the configured portfolio stake")),
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

async function revalidateEvaluation(evaluation, liveState, cash, maxNotional, evaluationByToken = new Map()) {
  const market = await fetchMarket(evaluation);
  if (!market) return { candidate: evaluation, eligible: false, rejectReasons: ["market not found in Gamma"] };
  const outcomes = parseJsonField(market.outcomes).map(String);
  const tokenIds = parseJsonField(market.clobTokenIds).map(String);
  const tokenIndex = tokenIds.findIndex((tokenId) => tokenId === String(evaluation.tokenId || ""));
  if (tokenIndex < 0) return { candidate: evaluation, eligible: false, rejectReasons: ["token no longer belongs to Gamma market"] };
  if (market.closed || market.active === false || market.acceptingOrders === false) {
    return { candidate: evaluation, eligible: false, rejectReasons: ["market is not accepting orders"] };
  }

  const clobMarket = await fetchClobMarket(market.conditionId).catch(() => null);
  const book = bestBook(await fetchJson(new URL(`/book?token_id=${evaluation.tokenId}`, CLOB_HOST), `CLOB book ${evaluation.tokenId}`));
  const tick = number(clobMarket?.mts ?? market.orderPriceMinTickSize ?? evaluation.tickSize, 0.01);
  const minOrderSize = number(clobMarket?.mos, 5);
  const price = orderPriceForBook(book, tick);
  if (!Number.isFinite(price) || price <= 0 || price >= 1) {
    return { candidate: evaluation, eligible: false, rejectReasons: ["no valid current entry price"] };
  }
  if (USE_LIMIT_ORDERS && POST_ONLY && book.bestAsk != null && price >= book.bestAsk) {
    return { candidate: evaluation, eligible: false, rejectReasons: ["post-only limit would cross current ask"] };
  }

  const estimatedFeeRate = feeRateForEvaluation(evaluation);
  const orderSizing = sharesForOrder({ price, minOrderSize, maxNotional, cash, feeRate: estimatedFeeRate });
  const size = orderSizing.size;
  if (!Number.isFinite(size)) {
    return {
      candidate: evaluation,
      eligible: false,
      rejectReasons: [orderSizing.sizingNote],
      currentPrice: price,
      minOrderSize,
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
  const endDate = correctedEndDate(market.question || evaluation.question, market.endDate, market.createdAt || market.updatedAt);
  const days = daysToEnd(endDate);
  const resolvedDays = daysValue({ daysToResolution: days });
  if (Number.isFinite(MAX_RESOLUTION_DAYS) && resolvedDays > MAX_RESOLUTION_DAYS) {
    return {
      candidate: evaluation,
      eligible: false,
      rejectReasons: [`resolution ${Number.isFinite(resolvedDays) ? resolvedDays.toFixed(2) : "-"} days exceeds live max ${MAX_RESOLUTION_DAYS} days`],
      currentPrice: price,
      minOrderSize,
    };
  }
  const endOk = endDateIsFuture(endDate);
  const volume24hr = number(market.volume24hr, number(evaluation.volume24hr, 0));
  const liquidity = number(market.liquidity, number(evaluation.liquidity, 0));
  const notional = Number((price * size).toFixed(5));
  const fee = USE_LIMIT_ORDERS && POST_ONLY ? 0 : takerFee(size, price, estimatedFeeRate);
  const totalCost = notional + fee;
  const expectedValue = Number.isFinite(aiProbability) ? aiProbability * size - notional - fee : null;
  const expectedRoi = Number.isFinite(expectedValue) && totalCost > 0 ? expectedValue / totalCost : null;
  const annualizedReturn = Number.isFinite(expectedRoi) ? (days ? expectedRoi * (365 / days) : expectedRoi) : null;
  const marketExpectedValue = marketProbability * size - notional - fee;
  const marketExpectedRoi = totalCost > 0 ? marketExpectedValue / totalCost : 0;
  const marketAnnualizedReturn = days ? marketExpectedRoi * (365 / days) : marketExpectedRoi;
  const netGainIfWin = size - notional - fee;
  const potentialRoi = totalCost > 0 ? netGainIfWin / totalCost : null;
  const potentialAnnualizedReturn = Number.isFinite(potentialRoi)
    ? (days ? potentialRoi * (365 / days) : potentialRoi)
    : null;
  const selectedExpectedValueUsdc = PROBABILITY_SOURCE === "polymarket" ? netGainIfWin : expectedValue;
  const selectedAnnualizedReturn = PROBABILITY_SOURCE === "polymarket" ? potentialAnnualizedReturn : annualizedReturn;
  const edge = Number.isFinite(aiProbability) ? aiProbability - price : marketProbability - price;
  const scored = scoreEconomics({
    probability: qualificationProbability,
    qualificationProbability,
    annualizedReturn: selectedAnnualizedReturn,
    netYield: potentialRoi,
    edge: qualificationProbability - price,
    spread: book.spread,
    volume24hr,
    liquidity,
    endOk,
  });
  if (!Number.isFinite(selectedExpectedValueUsdc) || selectedExpectedValueUsdc <= 0 || !Number.isFinite(selectedAnnualizedReturn) || selectedAnnualizedReturn <= 0) {
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
    endDate,
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
    negRisk: Boolean(market.negRisk),
    aiProbability: Number.isFinite(aiProbability) ? Number(aiProbability.toFixed(4)) : null,
    marketProbability: Number(marketProbability.toFixed(4)),
    edge: Number(edge.toFixed(4)),
    daysToResolution: days == null ? null : Number(days.toFixed(2)),
    expectedValueUsdc: Number(selectedExpectedValueUsdc.toFixed(4)),
    annualizedReturn: Number(selectedAnnualizedReturn.toFixed(4)),
    aiExpectedValueUsdc: Number.isFinite(expectedValue) ? Number(expectedValue.toFixed(4)) : null,
    aiAnnualizedReturn: Number.isFinite(annualizedReturn) ? Number(annualizedReturn.toFixed(4)) : null,
    marketExpectedValueUsdc: Number(marketExpectedValue.toFixed(4)),
    marketAnnualizedReturn: Number(marketAnnualizedReturn.toFixed(4)),
    potentialAnnualizedReturn: Number.isFinite(potentialAnnualizedReturn) ? Number(potentialAnnualizedReturn.toFixed(4)) : null,
    netGainIfWinUsdc: Number(netGainIfWin.toFixed(4)),
    netYield: Number.isFinite(potentialRoi) ? Number(potentialRoi.toFixed(6)) : null,
    totalCostUsdc: Number(totalCost.toFixed(5)),
    tradingFeeUsdc: Number(fee.toFixed(5)),
    feeMode: USE_LIMIT_ORDERS && POST_ONLY ? "post-only maker fee assumed 0" : "taker fee estimate",
    orderType: USE_LIMIT_ORDERS ? "GTC" : "FAK",
    riskGroupKeys: risk.keys,
    riskGroupLabels: risk.labels,
    score: Number((selectedAnnualizedReturn + (PROBABILITY_SOURCE === "polymarket" ? qualificationProbability - price : edge)).toFixed(6)),
  };
}

async function emitDecision(payload) {
  const previousRunLog = Array.isArray(previousExecutionState?.runLog)
    ? previousExecutionState.runLog.filter((row) => !isCadenceWaitRun(row))
    : [];
  const runEntry = {
    ...(payload.batchLog || {}),
    id: payload.batchLog?.id || `live-trade-batch-${payload.generatedAt || new Date().toISOString()}`,
    runAt: payload.batchLog?.runAt || payload.generatedAt || new Date().toISOString(),
    generatedAt: payload.generatedAt || payload.batchLog?.runAt || new Date().toISOString(),
    strategyId: payload.batchLog?.strategyId || "live",
    strategyLabel: payload.batchLog?.strategyLabel || "Live",
    action: payload.action || payload.batchLog?.action || "-",
    reason: payload.reason || payload.batchLog?.reason || "-",
    explanation: payload.batchLog?.explanation || payload.reason || "-",
    response: payload.response || null,
    attempts: Array.isArray(payload.attempts) ? payload.attempts : [],
  };
  const nextRunLog = mergeRunLog([runEntry, ...previousRunLog], 160);
  const output = {
    ...payload,
    runLog: nextRunLog,
  };

  console.log(JSON.stringify(output, null, 2));
  if (!EXECUTION_STATE_PATH) return;
  await mkdir(dirname(EXECUTION_STATE_PATH), { recursive: true });
  await writeFile(EXECUTION_STATE_PATH, `${JSON.stringify(output, null, 2)}\n`, "utf8");
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
  const options = {
    tickSize: String(order.tickSize || "0.01"),
    negRisk: Boolean(order.negRisk),
  };
  const side = String(order.side || "BUY").toUpperCase() === "SELL" ? Side.SELL : Side.BUY;
  if (!USE_LIMIT_ORDERS) {
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
  // A rotation exit at the current bid is intentionally marketable. Post-only
  // would reject it and leave the old correlated exposure in place.
  return client.postOrder(signedOrder, OrderType.GTC, side === Side.SELL ? false : POST_ONLY);
}

async function buildRotationExitOrder(position, evaluationByToken, tradingConfig) {
  const tokenId = String(position.tokenId || position.assetId || "");
  const orderSize = number(position.shares ?? position.size);
  if (!tokenId || orderSize == null || orderSize <= 0) throw new Error("rotation exit has no sellable token balance");
  const source = positionSourceEvaluation(position, evaluationByToken) || {};
  const book = bestBook(await fetchJson(new URL(`/book?token_id=${tokenId}`, CLOB_HOST), `CLOB rotation exit book ${tokenId}`));
  if (book.bestBid == null || book.bestBid <= 0) throw new Error("rotation exit has no executable bid in the order book");
  const clobMarket = await fetchClobMarket(position.market || position.conditionId || source.conditionId).catch(() => null);
  const tickSize = number(clobMarket?.mts ?? source.tickSize, 0.01);
  const orderPrice = roundToTick(book.bestBid, tickSize, "down");
  return {
    question: position.question || source.question || "",
    outcome: position.outcome || source.outcome || "",
    tokenId,
    side: "SELL",
    orderType: USE_LIMIT_ORDERS ? "GTC" : "FAK",
    orderPrice,
    orderSize: Number(orderSize.toFixed(4)),
    orderNotionalUsdc: Number((orderPrice * orderSize).toFixed(5)),
    tickSize,
    negRisk: Boolean(clobMarket?.negRisk ?? source.negRisk),
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
  return String(response.error || response.errorMsg || response.message || "");
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
    minSizeOverride: candidate.minSizeOverride,
    sizingNote: candidate.sizingNote,
    response,
    ...extra,
  };
}

function liveBatchCandidateSummary(item) {
  const source = item?.candidate || item || {};
  const gain = number(item?.netGainIfWinUsdc ?? source.netGainIfWinUsdc);
  const cost = number(item?.totalCostUsdc ?? item?.orderNotionalUsdc ?? source.totalCostUsdc ?? source.stakeUsdc);
  const daysToResolution = number(item?.daysToResolution ?? source.daysToResolution);
  const netYield = gain != null && cost != null && cost > 0 ? gain / cost : null;
  const potentialAnnualizedReturn = netYield != null
    ? (daysToResolution != null && daysToResolution > 0 ? netYield * (365 / daysToResolution) : netYield)
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
    daysToResolution,
    liquidity: number(item?.liquidity ?? source.liquidity),
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
    : (rejectReasons.some((reason) => /no available cash|above cash|insufficient.*(?:cash|USDC|capital)|minimum order .*costs|below the displayed .*share.*minimum/i.test(String(reason || "")))
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
  return {
    tokenId: String(item?.tokenId || source.tokenId || ""),
    checkedAt,
    status: status === "ELIGIBLE" ? "READY" : (status === "ERROR" ? "ERROR" : (retryClass ? `WAITING_${retryClass}` : "REJECTED")),
    retryable: Boolean(retryClass),
    retryClass,
    rejectReasons,
    question: item?.question || source.question || "",
    outcome: item?.outcome || source.outcome || "",
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
    ...extra,
  };
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
  };
}

function selectionMetricDisplay(comparison, value) {
  if (!Number.isFinite(value)) return "-";
  return comparison?.metricLabel === "R/R"
    ? `${Number(value).toFixed(2)}:1`
    : `${(Number(value) * 100).toFixed(1)}%`;
}

async function reviewOpenOrders({ liveState, evaluationByToken, eligible, cash, maxNotional, tradingConfig }) {
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

    if (maxStakeBreached) {
      review.action = "CANCEL";
      review.reason = `open order notional ${lockedNotional.toFixed(4)} USDC exceeds max stake ${maxNotional.toFixed(4)} USDC`;
    } else if (!sourceEvaluation) {
      review.reason = ageHours >= OPEN_ORDER_CANCEL_AFTER_HOURS
        ? "no current AI evaluation links to this open order and the order is stale"
        : "no current AI evaluation links to this open order yet";
      if (ageHours >= OPEN_ORDER_CANCEL_AFTER_HOURS) {
        review.action = "CANCEL";
      }
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
        const bestOther = eligible.find((candidate) => String(candidate.tokenId || "") !== tokenId) || null;
        const comparison = bestOther ? selectionComparison(revalidated, bestOther) : null;
        // A replacement must rank ahead under the configured portfolio rule.
        // Absolute EV is only a safety margin after that check; it must never
        // override EV p.a./Potential p.a. (or R/R) ordering.
        const betterCandidate = bestOther
          && comparison?.replacementRanksAhead
          && Number(comparison.expectedValueDelta || 0) >= OPEN_ORDER_BETTER_CANDIDATE_EV_USDC
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
          review.action = ageHours >= OPEN_ORDER_REVIEW_AFTER_HOURS ? "CANCEL" : "KEEP_WAITING";
          review.reason = `current revalidation no longer satisfies live rules: ${(revalidated.rejectReasons || []).join("; ") || "not eligible"}`;
        } else if (betterCandidate && betterCandidateNeedsReleasedCapital) {
          review.action = "CANCEL_FOR_BETTER_CANDIDATE";
          review.reason = `${comparison.metricLabel} priority supports replacement (${comparison.metricLabel} ${selectionMetricDisplay(comparison, comparison.currentMetric)} -> ${selectionMetricDisplay(comparison, comparison.replacementMetric)}, ${comparison.metricDelta >= 0 ? "+" : ""}${selectionMetricDisplay(comparison, comparison.metricDelta)}); expected value ${Number(comparison.currentExpectedValue).toFixed(4)} -> ${Number(comparison.replacementExpectedValue).toFixed(4)} USDC, so the replacement needs this order's locked capital`;
        } else if (betterCandidate) {
          review.reason = betterCandidateCost != null
            ? `${comparison.metricLabel} priority supports replacement, but ${number(cash, 0).toFixed(4)} USDC free cash already covers its ${betterCandidateCost.toFixed(4)} USDC cost; keep this independent order open (${comparison.metricLabel} ${selectionMetricDisplay(comparison, comparison.currentMetric)} -> ${selectionMetricDisplay(comparison, comparison.replacementMetric)})`
            : `${comparison.metricLabel} priority supports replacement, but the candidate has no current executable order cost; keep this independent order open`;
        } else if (comparison && !comparison.replacementRanksAhead && comparison.expectedValueDelta > OPEN_ORDER_BETTER_CANDIDATE_EV_USDC) {
          review.reason = `a candidate has higher absolute expected value (${Number(comparison.currentExpectedValue).toFixed(4)} -> ${Number(comparison.replacementExpectedValue).toFixed(4)} USDC) but ranks lower by ${comparison.metricLabel} (${selectionMetricDisplay(comparison, comparison.currentMetric)} vs ${selectionMetricDisplay(comparison, comparison.replacementMetric)}); keep the current order`;
        } else if (ageHours >= OPEN_ORDER_REVIEW_AFTER_HOURS && Math.abs(priceDelta) >= OPEN_ORDER_REPRICE_THRESHOLD) {
          review.action = "REPLACE";
          review.reason = priceDelta > 0
            ? `market moved away; raise limit price closer to current post-only level by ${(priceDelta * 100).toFixed(1)} pts`
            : `current post-only level is lower by ${(Math.abs(priceDelta) * 100).toFixed(1)} pts; repost at updated economics`;
          review.replacementCandidate = revalidated;
        } else if (ageHours >= OPEN_ORDER_CANCEL_AFTER_HOURS) {
          review.action = "CANCEL";
          review.reason = `order has waited ${ageHours.toFixed(1)}h without fill; release capital for the next batch`;
        } else {
          review.action = "KEEP_WAITING";
          review.reason = `still eligible and price gap ${Math.abs(priceDelta * 100).toFixed(1)} pts is below reprice threshold`;
        }
      } catch (error) {
        review.action = ageHours >= OPEN_ORDER_REVIEW_AFTER_HOURS ? "CANCEL" : "KEEP_WAITING";
        review.reason = `open order revalidation failed: ${error?.message || String(error)}`;
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
      selectedAction.replaceResponse = DRY_RUN || !hasFlag("confirm-live")
        ? { status: "dry_run_replace", success: true }
        : await submitOrder({
            ...selectedAction.replacementCandidate,
            funderAddress: tradingConfig.funderAddress,
            signatureType: tradingConfig.signatureType,
          });
      selectedAction.action = successfulOrderResponse(selectedAction.replaceResponse) ? "REPLACED" : "REPLACE_REJECTED";
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
  const [liveState, previousExecution] = await Promise.all([
    loadJsonResource(LIVE_STATE_URL, "live state"),
    loadOptionalJsonResource(LIVE_EXECUTION_STATE_URL, "previous live execution state"),
  ]);
  previousExecutionState = previousExecution;
  if (!liveExecutionRunDue(previousExecution, liveState)) {
    console.log(JSON.stringify({
      action: "CADENCE_WAIT",
      reason: "Scheduled polling skipped: no live execution review is due yet.",
      lastFullRunAt: latestLiveExecutionRunAt(previousExecution),
    }, null, 2));
    return;
  }
  const [paperState, scrapedState] = await Promise.all([
    loadJsonResource(PAPER_STATE_URL, "paper state"),
    PROBABILITY_SOURCE === "polymarket"
      ? loadJsonResource(PAPER_SCRAPED_STATE_URL, "scraped Polymarket state")
      : Promise.resolve(null),
  ]);
  if (HAS_MANUAL_SHORTLIST && MANUAL_SHORTLIST_PROBABILITY_SOURCE && MANUAL_SHORTLIST_PROBABILITY_SOURCE !== PROBABILITY_SOURCE) {
    throw new Error(`manual execution shortlist uses ${MANUAL_SHORTLIST_PROBABILITY_SOURCE} probability, but the live portfolio is configured for ${PROBABILITY_SOURCE} probability`);
  }
  const cash = liveCashUsdc(liveState);
  const tradingConfig = liveTradingConfig(liveState);
  const portfolioValue = livePortfolioValue(liveState, cash);
  const fractionNotional = portfolioValue * MAX_ORDER_FRACTION;
  const monitoring = liveCashMonitoring(previousExecution, cash);
  const regularMaxNotional = Math.min(fractionNotional, MAX_ORDER_NOTIONAL_USDC);
  const idleUtilizationNotional = monitoring.idleCashOverdue ? Math.max(0, cash - IDLE_CASH_MAX_USDC) : 0;
  const maxNotional = Number(regularMaxNotional.toFixed(5));
  const rawEvaluations = Array.isArray(paperState.evaluations) ? paperState.evaluations : [];
  const rawMarketObservations = PROBABILITY_SOURCE === "polymarket" && Array.isArray(scrapedState?.marketObservations)
    ? scrapedState.marketObservations
    : [];
  const rawCandidateRows = PROBABILITY_SOURCE === "polymarket"
    ? rawMarketObservations
    : rawEvaluations;
  const candidatePool = prepareLiveCandidatePool(rawCandidateRows);
  const latestEvaluations = candidatePool.uniqueEvaluations;
  const evaluationByToken = new Map(latestEvaluations.map((item) => [String(item.tokenId || ""), item]).filter(([tokenId]) => tokenId));
  const manualShortlistStale = HAS_MANUAL_SHORTLIST && candidatePool.diagnostics.manualShortlistMissingTokenIds.length > 0;
  const baseCandidates = manualShortlistStale ? [] : candidatePool.candidates;

  const checked = [];
  for (const evaluation of baseCandidates) {
    try {
      checked.push(await revalidateEvaluation(evaluation, liveState, cash, maxNotional, evaluationByToken));
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

  const allEligible = checked
    .filter((item) => item.status === "ELIGIBLE")
    .filter((item) => Number.isFinite(Number(item.annualizedReturn)) && Number(item.annualizedReturn) > 0)
    .filter((item) => Number.isFinite(Number(item.expectedValueUsdc)) && Number(item.expectedValueUsdc) > 0)
    .map((item) => ({
      ...item,
      funderAddress: tradingConfig.funderAddress,
      signatureType: tradingConfig.signatureType,
    }));
  const eligible = HAS_MANUAL_SHORTLIST
    ? allEligible
    : sortLiveEligibleCandidates(allEligible);
  const capitalSizingBlocked = checked.filter((item) => (item.rejectReasons || []).some((reason) => /above cash|insufficient.*(?:cash|USDC)|minimum order .* costs/i.test(String(reason || ""))));
  const riskBlockedCandidates = checked.filter((item) => (item.rejectReasons || [])
    .some((reason) => /^(correlated live exposure|duplicate token already open)/i.test(String(reason || ""))));
  const needsCapitalRotation = !manualShortlistStale && !eligible.length && (cash <= 0 || capitalSizingBlocked.length > 0);
  const needsRiskReplacement = !manualShortlistStale && !eligible.length && !needsCapitalRotation && riskBlockedCandidates.length > 0;
  const rotationReview = !manualShortlistStale && !eligible.length && (needsCapitalRotation || needsRiskReplacement)
    ? await reviewPositionRotation({
        liveState,
        evaluationByToken,
        baseCandidates,
        cash,
        maxNotional,
        restrictToRiskReplacement: needsRiskReplacement,
      })
    : null;
  const activeSellOrders = (Array.isArray(liveState.openOrders) ? liveState.openOrders : [])
    .filter((order) => String(order.side || "").toUpperCase().includes("SELL"));
  const best = eligible[0] || null;
  const replacementDue = rotationReplacementDue(previousExecution, liveState);
  // Use free cash for a direct candidate before touching existing orders or
  // positions. An unrelated buy is allowed while a sell order is pending.
  const directCapitalPriority = Boolean(best && (!monitoring.cadenceBlocked || replacementDue));
  const orderManagement = manualShortlistStale || activeSellOrders.length || directCapitalPriority
    ? { action: "NONE", reviews: [] }
    : await reviewOpenOrders({
        liveState,
        evaluationByToken,
        eligible,
        cash,
        maxNotional,
        tradingConfig,
      });

  // A cancelled buy order releases capital immediately. Continue with the same
  // revalidated shortlist instead of leaving the portfolio idle until the next run.
  const canceledForBetterCandidate = orderManagement.action === "CANCELED_FOR_BETTER_CANDIDATE";
  const appliedDirectStake = best?.totalCostUsdc != null
    ? number(best.totalCostUsdc, 0)
    : Math.min(maxNotional, Math.max(0, cash));
  // Replacing an order that this run just cancelled is order management, not an
  // additional portfolio allocation. Do not strand its released capital behind
  // the new-trade cadence.
  const cadenceBlocked = Boolean(monitoring.cadenceBlocked) && !replacementDue && !canceledForBetterCandidate;
  const rotationAvailable = rotationReview?.action === "ROTATION_AVAILABLE";
  const actionReason = directCapitalPriority
    ? "free capital prioritized: best direct candidate is submitted before order or position rotation"
    : activeSellOrders.length
    ? "waiting for an existing live sell order to reduce position exposure before any replacement buy"
    : (rotationAvailable && LIVE_AUTO_ROTATE
      ? (needsRiskReplacement
        ? "a risk-overlap replacement will sell the conflicting position before placing the replacement buy"
        : "cash is insufficient for a direct order, so a sell-and-replace rotation will submit the exit order first")
      : (cadenceBlocked
        ? `live new-trade cadence blocked (${TRADE_CADENCE_HOURS}h)`
        : (best
        ? "best currently revalidated executable candidate"
        : (rotationAvailable
            ? "cash is insufficient for a new direct order; a sell-and-replace rotation candidate was identified"
            : (capitalSizingBlocked.length
                ? `live candidates blocked by available USDC: ${capitalSizingBlocked.length} cannot meet the current Polymarket minimum order size`
                : "no currently executable candidate after live revalidation")))));
  const actionExplanation = directCapitalPriority
    ? "A currently executable candidate has available free capital. The batch submits it first; existing orders and positions are considered for rotation only when no direct allocation is possible."
    : activeSellOrders.length
    ? "A live sell order is open. The system waits for account sync to confirm the exit before it can revalidate and place a replacement buy."
    : (rotationAvailable && LIVE_AUTO_ROTATE
      ? (needsRiskReplacement
        ? "The replacement conflicts with the selected live position under diversification rules, so the system sells that position first and waits for account sync before buying the replacement."
        : "Available cash cannot support a direct order, so the system sells the selected weaker position first and waits for account sync before considering the replacement.")
      : (best && !cadenceBlocked
      ? "Live batch found an executable candidate after revalidation."
      : (cadenceBlocked
        ? "No live order was submitted because the configured new-trade cadence is not elapsed yet. Open-order management still ran."
        : (rotationAvailable
            ? "No live order was submitted because opening the better candidate would first require selling an existing live position; this run records the rotation review but does not perform the sell/rebuy sequence automatically."
            : (capitalSizingBlocked.length
                ? "No live order was submitted because available USDC cannot cover the exchange minimum size for the revalidated candidate(s)."
                : "No live order was submitted because all revalidated candidates failed current execution criteria.")))));
  const decision = {
    mode: DRY_RUN || !hasFlag("confirm-live") ? "validated-dry-run" : "live-submit",
    action: best && !cadenceBlocked ? (DRY_RUN || !hasFlag("confirm-live") ? "DRY_RUN_READY" : "SUBMIT") : "SKIP",
    reason: actionReason,
    generatedAt: new Date().toISOString(),
    account: {
      address: liveState?.account?.address || FUNDER_ADDRESS,
      funderAddress: tradingConfig.funderAddress,
      signatureType: tradingConfig.signatureType,
      cashUsdc: cash,
      portfolioValueUsdc: Number(portfolioValue.toFixed(5)),
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
      probabilitySource: PROBABILITY_SOURCE,
      minAnnualReturn: MIN_ANNUAL_RETURN,
      maxSpread: MAX_SPREAD,
      minVolume24hr: MIN_VOLUME_24H,
      minNetYield: MIN_NET_YIELD,
      maxResolutionDays: MAX_RESOLUTION_DAYS,
      selectionOrder: SELECTION_ORDER,
      maxOrderNotionalCapUsdc: Number.isFinite(MAX_ORDER_NOTIONAL_USDC) ? MAX_ORDER_NOTIONAL_USDC : null,
      idleCashMaxUsdc: IDLE_CASH_MAX_USDC,
      idleCashGraceHours: IDLE_CASH_GRACE_HOURS,
      oneTradePerDay: ONE_TRADE_PER_DAY,
      tradeCadenceHours: TRADE_CADENCE_HOURS,
      ignoreTradeCadence: IGNORE_TRADE_CADENCE,
      freeCapitalPriority: true,
      capitalUtilizationOverride: monitoring.idleCashOverdue,
      storedEvaluations: rawEvaluations.length,
      uniqueEvaluations: latestEvaluations.length,
      prefilterPassedCandidates: candidatePool.diagnostics.prefilterPassed,
      prefilterRejectedCandidates: candidatePool.diagnostics.prefilterRejected,
      skippedByScanLimit: candidatePool.diagnostics.skippedByScanLimit,
      scannedCandidates: baseCandidates.length,
      revalidatedCandidates: checked.length,
      eligibleCandidates: allEligible.length,
      capitalSizingBlockedCandidates: capitalSizingBlocked.length,
      openOrderReviewAfterHours: OPEN_ORDER_REVIEW_AFTER_HOURS,
      openOrderCancelAfterHours: OPEN_ORDER_CANCEL_AFTER_HOURS,
      openOrderRepriceThreshold: OPEN_ORDER_REPRICE_THRESHOLD,
      rotationTrigger: needsRiskReplacement ? "risk-overlap" : (needsCapitalRotation ? "capital" : null),
    },
    orderManagement,
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
      selectionMetric: returnMetricLabel(),
      action: best && !cadenceBlocked ? (DRY_RUN || !hasFlag("confirm-live") ? "DRY_RUN_READY" : "SUBMIT") : "SKIP",
      reason: actionReason,
      explanation: actionExplanation,
      settings: {
        minProbability: MIN_PROBABILITY,
        probabilitySource: PROBABILITY_SOURCE,
        minAnnualReturn: MIN_ANNUAL_RETURN,
        maxSpread: MAX_SPREAD,
        minVolume24hr: MIN_VOLUME_24H,
        minNetYield: MIN_NET_YIELD,
        maxResolutionDays: MAX_RESOLUTION_DAYS,
        tradeCadenceHours: TRADE_CADENCE_HOURS,
        ignoreTradeCadence: IGNORE_TRADE_CADENCE,
        freeCapitalPriority: true,
        selectionOrder: SELECTION_ORDER,
        useLimitOrders: USE_LIMIT_ORDERS,
        crossPortfolioRiskDiversification: CROSS_PORTFOLIO_RISK_DIVERSIFICATION,
        liveAutoRotate: LIVE_AUTO_ROTATE,
        maxOrderFraction: MAX_ORDER_FRACTION,
      },
      capital: {
        availableUsdc: cash,
        portfolioValueUsdc: Number(portfolioValue.toFixed(5)),
        targetStakeUsdc: maxNotional,
        requiredStakeUsdc: Number(appliedDirectStake.toFixed(5)),
        insufficientCapital: !Number.isFinite(maxNotional) || maxNotional <= 0 || cash <= 0 || (!allEligible.length && capitalSizingBlocked.length > 0),
        capitalSizingBlockedCandidates: capitalSizingBlocked.length,
      },
      counts: {
        storedEvaluations: rawEvaluations.length,
        uniqueEvaluations: latestEvaluations.length,
        prefilterPassedCandidates: candidatePool.diagnostics.prefilterPassed,
        prefilterRejectedCandidates: candidatePool.diagnostics.prefilterRejected,
        skippedByScanLimit: candidatePool.diagnostics.skippedByScanLimit,
        scannedCandidates: baseCandidates.length,
        revalidatedCandidates: checked.length,
        eligibleCandidates: allEligible.length,
        capitalSizingBlockedCandidates: capitalSizingBlocked.length,
        rankedEligibleCandidates: eligible.length,
        openOrdersReviewed: orderManagement.reviews.length,
        positionsReviewedForRotation: rotationReview?.reviews?.length || 0,
        rotationAvailable,
        riskBlockedCandidates: riskBlockedCandidates.length,
        rejectedCandidates: checked.filter((item) => item.status !== "ELIGIBLE").length,
        cadenceBlocked,
        rawCadenceBlocked: Boolean(monitoring.rawCadenceBlocked),
      },
      openOrderReviews: orderManagement.reviews,
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

  if (manualShortlistStale) {
    const missingCount = candidatePool.diagnostics.manualShortlistMissingTokenIds.length;
    const reason = `manual execution stopped: ${missingCount} submitted execution candidate${missingCount === 1 ? " is" : "s are"} no longer in the current scraped Polymarket shortlist`;
    await emitDecision({
      ...decision,
      action: "SHORTLIST_STALE",
      reason,
      batchLog: {
        ...decision.batchLog,
        action: "SHORTLIST_STALE",
        reason,
        explanation: "No live order, open-order change, or position rotation was attempted. Refresh the execution shortlist and start a new run so the submitted token list exactly matches current scraped Polymarket data.",
      },
      attempts: [],
    });
    return;
  }

  if (orderManagement.action !== "NONE" && !canceledForBetterCandidate) {
    await emitDecision({
      ...decision,
      action: orderManagement.action,
      reason: orderManagement.selected?.reason || "open order management action completed",
      batchLog: {
        ...decision.batchLog,
        action: orderManagement.action,
        reason: orderManagement.selected?.reason || "open order management action completed",
        explanation: "Live batch reviewed existing open limit orders before opening a new position.",
      },
      attempts: [orderManagement.selected],
    });
    return;
  }

  if (activeSellOrders.length && !best) {
    const pendingRotationExit = previousExecution?.rotationExit || null;
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
    let exitResponse = null;
    try {
      exitOrder = await buildRotationExitOrder(rotation.position, evaluationByToken, tradingConfig);
      exitResponse = DRY_RUN || !hasFlag("confirm-live")
        ? { status: "dry_run_rotation_exit", success: true }
        : await submitOrder(exitOrder);
    } catch (error) {
      exitResponse = { error: error?.message || String(error), status: "exception" };
    }
    const rotationExit = {
      position: rotation.position,
      replacementCandidate: rotation.candidate,
      order: exitOrder,
      response: exitResponse,
      submittedAt: new Date().toISOString(),
    };
    if (successfulOrderResponse(exitResponse)) {
      const action = DRY_RUN || !hasFlag("confirm-live") ? "ROTATION_EXIT_READY" : "ROTATION_EXIT_SUBMITTED";
      await emitDecision({
        ...decision,
        action,
        reason: "rotation exit accepted; wait for account sync before replacement buy",
        rotationExit,
        batchLog: {
          ...decision.batchLog,
          action,
          reason: "rotation exit accepted; wait for account sync before replacement buy",
          explanation: "The weaker position received a sell order at the current bid. A replacement is intentionally deferred until account sync confirms the sell has filled.",
          selected: rotation.candidate,
          rotationExit,
        },
        attempts: [orderAttemptSummary(exitOrder || rotation.position, exitResponse, { action, replacementCandidate: rotation.candidate })],
      });
      return;
    }
    await emitDecision({
      ...decision,
      action: "ROTATION_EXIT_REJECTED",
      reason: `rotation exit was not accepted: ${orderResponseError(exitResponse) || "unknown order response"}`,
      rotationExit,
      batchLog: {
        ...decision.batchLog,
        action: "ROTATION_EXIT_REJECTED",
        reason: `rotation exit was not accepted: ${orderResponseError(exitResponse) || "unknown order response"}`,
        explanation: "The old position remains open and no replacement buy was attempted.",
        selected: rotation.candidate,
        rotationExit,
      },
      attempts: [orderAttemptSummary(exitOrder || rotation.position, exitResponse, { action: "ROTATION_EXIT_REJECTED", replacementCandidate: rotation.candidate })],
    });
    return;
  }

  if (!best || cadenceBlocked || DRY_RUN || !hasFlag("confirm-live")) {
    await emitDecision({ ...decision, attempts: best ? [orderAttemptSummary(best, null, { action: decision.action })] : [] });
    return;
  }

  const attempts = [];
  for (const candidate of eligible) {
    let response = null;
    try {
      response = await submitOrder(candidate);
    } catch (error) {
      response = {
        error: error?.message || String(error),
        status: "exception",
      };
    }
    if (successfulOrderResponse(response)) {
      const action = canceledForBetterCandidate ? "CANCELED_AND_SUBMITTED" : "SUBMITTED";
      const reason = canceledForBetterCandidate
        ? "waiting limit order cancelled and the better replacement order was accepted by Polymarket"
        : "live order accepted by Polymarket";
      const explanation = canceledForBetterCandidate
        ? "The existing limit order was cancelled after the revalidated shortlist found a better candidate. The released capital was immediately used for the selected replacement order."
        : "Live batch revalidated candidates and Polymarket accepted the selected order.";
      await emitDecision({
        ...decision,
        action,
        reason,
        batchLog: {
          ...decision.batchLog,
          action,
          reason,
          explanation,
          selected: liveBatchCandidateSummary(candidate),
        },
        monitoring: {
          ...monitoring,
          lastSubmittedAt: new Date().toISOString(),
          estimatedCashAfterOrderUsdc: Number(Math.max(0, cash - Number(candidate.totalCostUsdc || candidate.orderNotionalUsdc || 0)).toFixed(5)),
        },
        selected: candidate,
        response,
        attempts: [
          ...(canceledForBetterCandidate && orderManagement.selected ? [orderManagement.selected] : []),
          ...attempts,
          orderAttemptSummary(candidate, response, { action }),
        ],
      });
      return;
    }

    const stopReason = nonRetryableOrderFailure(response);
    const attempt = orderAttemptSummary(candidate, response, {
      action: stopReason ? "STOP" : "RETRY_NEXT",
      rejectReason: orderResponseError(response) || "order was rejected",
      stopReason,
    });
    attempts.push(attempt);
    if (stopReason) {
      const action = canceledForBetterCandidate ? "CANCELED_REPLACEMENT_REJECTED" : "REJECTED";
      const reason = canceledForBetterCandidate
        ? `waiting limit order was cancelled, but the replacement order was rejected: ${stopReason}`
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
            ? `The replacement order was not opened after cancellation because submission stopped: ${stopReason}.`
            : `Live order was not opened because submission stopped: ${stopReason}.`,
          selected: liveBatchCandidateSummary(candidate),
        },
        selected: candidate,
        response,
        attempts: [
          ...(canceledForBetterCandidate && orderManagement.selected ? [orderManagement.selected] : []),
          ...attempts,
        ],
      });
      process.exit(1);
    }
  }

  const action = canceledForBetterCandidate ? "CANCELED_REPLACEMENT_REJECTED" : "REJECTED";
  const reason = canceledForBetterCandidate
    ? "waiting limit order was cancelled, but every replacement candidate was rejected by order submission"
    : "all revalidated candidates were rejected by order submission";
  await emitDecision({
    ...decision,
    action,
    reason,
    batchLog: {
      ...decision.batchLog,
      action,
      reason,
      explanation: canceledForBetterCandidate
        ? "The cancelled order was not replaced because every current replacement candidate failed during submission."
        : "Live order was not opened because every revalidated candidate failed during order submission.",
    },
    response: attempts.at(-1)?.response || null,
    attempts: [
      ...(canceledForBetterCandidate && orderManagement.selected ? [orderManagement.selected] : []),
      ...attempts,
    ],
  });
  process.exit(1);
}

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
