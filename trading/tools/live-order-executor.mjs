#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

function envNumber(name, fallback = null) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

const PAPER_STATE_URL = process.env.PAPER_STATE_URL || "https://osobnizkusenosti.cz/trading/api.php?action=state&target=paper";
const LIVE_STATE_URL = process.env.LIVE_STATE_URL || "https://osobnizkusenosti.cz/trading/api.php?action=state&target=live";
const LIVE_EXECUTION_STATE_URL = process.env.LIVE_EXECUTION_STATE_URL || "https://osobnizkusenosti.cz/trading/api.php?action=state&target=live-execution";
const GAMMA_API = process.env.POLYMARKET_GAMMA_API || "https://gamma-api.polymarket.com";
const CLOB_HOST = process.env.POLYMARKET_HOST || "https://clob.polymarket.com";
const CHAIN_ID = Number(process.env.POLYMARKET_CHAIN_ID || 137);
const MIN_PROBABILITY = envNumber("LIVE_MIN_PROBABILITY", envNumber("PAPER_MIN_PROBABILITY", 0.95));
const MIN_ANNUAL_RETURN = envNumber("LIVE_MIN_ANNUAL_RETURN", envNumber("PAPER_MIN_ANNUAL_RETURN", 0.05));
const OPPORTUNITY_MIN_PROBABILITY = envNumber("LIVE_OPPORTUNITY_MIN_PROBABILITY", envNumber("PAPER_OPPORTUNITY_MIN_PROBABILITY", 0.6));
const OPPORTUNITY_MIN_EDGE = envNumber("LIVE_OPPORTUNITY_MIN_EDGE", envNumber("PAPER_OPPORTUNITY_MIN_EDGE", 0.04));
const OPPORTUNITY_MIN_ANNUAL_RETURN = envNumber("LIVE_OPPORTUNITY_MIN_ANNUAL_RETURN", envNumber("PAPER_OPPORTUNITY_MIN_ANNUAL_RETURN", 0.3));
const MAX_SPREAD = envNumber("LIVE_MAX_SPREAD", envNumber("PAPER_MAX_SPREAD", 0.08));
const MIN_VOLUME_24H = envNumber("LIVE_CONFIG_MIN_LIQUIDITY_USDC", envNumber("LIVE_MIN_VOLUME_24H", envNumber("PAPER_MIN_VOLUME_24H", 100)));
const MAX_ORDER_FRACTION = envNumber("MAX_ORDER_FRACTION", envNumber("LIVE_MAX_ORDER_FRACTION", 0.05));
const MAX_ORDER_NOTIONAL_USDC = envNumber("MAX_ORDER_NOTIONAL_USDC", envNumber("LIVE_MAX_ORDER_NOTIONAL_USDC", Infinity));
const CANDIDATE_SCAN_LIMIT = envNumber("LIVE_CANDIDATE_SCAN_LIMIT", 120);
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
const OPEN_ORDER_REVIEW_AFTER_HOURS = envNumber("LIVE_OPEN_ORDER_REVIEW_AFTER_HOURS", 2);
const OPEN_ORDER_CANCEL_AFTER_HOURS = envNumber("LIVE_OPEN_ORDER_CANCEL_AFTER_HOURS", 8);
const OPEN_ORDER_REPRICE_THRESHOLD = envNumber("LIVE_OPEN_ORDER_REPRICE_THRESHOLD", 0.015);
const OPEN_ORDER_BETTER_CANDIDATE_EV_USDC = envNumber("LIVE_OPEN_ORDER_BETTER_CANDIDATE_EV_USDC", 0.02);
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

function latestUniqueEvaluations(evaluations) {
  const byToken = new Map();
  const ordered = [...evaluations].sort((a, b) => (Date.parse(b.evaluatedAt || "") || 0) - (Date.parse(a.evaluatedAt || "") || 0));
  for (const item of ordered) {
    const tokenId = String(item.tokenId || "");
    if (!tokenId || byToken.has(tokenId)) continue;
    byToken.set(tokenId, item);
    if (byToken.size >= CANDIDATE_SCAN_LIMIT) break;
  }
  return [...byToken.values()];
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

function sortLiveEligibleCandidates(rows = []) {
  return [...rows].sort((a, b) => {
    if (SELECTION_ORDER === "highest_reward_risk_first") {
      const aRatio = Number(a.riskReward || 0);
      const bRatio = Number(b.riskReward || 0);
      if (bRatio !== aRatio) return bRatio - aRatio;
    }
    if (b.annualizedReturn !== a.annualizedReturn) return b.annualizedReturn - a.annualizedReturn;
    const horizon = compareShorterHorizon(a, b);
    if (horizon !== 0) return horizon;
    return b.expectedValueUsdc - a.expectedValueUsdc;
  });
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

function scoreEconomics({ probability, annualizedReturn, edge, spread, volume24hr, liquidity, endOk }) {
  const probabilityOk = probability >= MIN_PROBABILITY;
  const opportunityOk = probability >= OPPORTUNITY_MIN_PROBABILITY
    && edge >= OPPORTUNITY_MIN_EDGE
    && annualizedReturn >= OPPORTUNITY_MIN_ANNUAL_RETURN;
  const returnOk = annualizedReturn >= MIN_ANNUAL_RETURN;
  const spreadOk = spread != null && spread <= MAX_SPREAD;
  const volumeOk = volume24hr >= MIN_VOLUME_24H || liquidity >= MIN_VOLUME_24H;
  return {
    eligible: endOk && probabilityOk && returnOk && spreadOk && volumeOk,
    thesisType: probabilityOk ? "HIGH_CONFIDENCE" : (opportunityOk ? "EDGE_OPPORTUNITY_BELOW_LIVE_THRESHOLD" : "REJECTED"),
    rejectReasons: [
      endOk ? null : "event end date is in the past",
      probabilityOk ? null : `AI probability ${(probability * 100).toFixed(1)}% below live threshold ${(MIN_PROBABILITY * 100).toFixed(1)}%`,
      returnOk ? null : `annualized EV ${(annualizedReturn * 100).toFixed(1)}% below ${(MIN_ANNUAL_RETURN * 100).toFixed(1)}%`,
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

function sharesForOrder({ price, minOrderSize, maxNotional, cash }) {
  const targetStake = maxNotional;
  const minNotional = price * minOrderSize;
  if (targetStake > cash) {
    return {
      size: null,
      targetStake,
      minNotional,
      minSizeOverride: false,
      sizingNote: `target stake ${targetStake.toFixed(4)} USDC is based on total portfolio value, above available cash ${cash.toFixed(4)} USDC`,
    };
  }
  if (minNotional > cash) {
    return {
      size: null,
      targetStake,
      minNotional,
      minSizeOverride: false,
      sizingNote: `minimum order ${minOrderSize} shares costs ${minNotional.toFixed(4)} USDC, above cash ${cash.toFixed(4)} USDC`,
    };
  }
  if (minNotional > targetStake) {
    return {
      size: Number(minOrderSize.toFixed(4)),
      targetStake,
      minNotional,
      minSizeOverride: true,
      sizingNote: `raised to exchange minimum ${minOrderSize.toFixed(4)} shares because target stake ${targetStake.toFixed(4)} USDC is below exchange minimum ${minNotional.toFixed(4)} USDC`,
    };
  }
  if (ORDER_SIZE_MODE === "minimum") {
    return {
      size: Number(minOrderSize.toFixed(4)),
      targetStake,
      minNotional,
      minSizeOverride: false,
      sizingNote: "legacy minimum-share sizing; use LIVE_ORDER_SIZE_MODE=stake_fraction for equal stake sizing",
    };
  }
  const size = Math.floor((targetStake / price) * 10000) / 10000;
  return {
    size: size >= minOrderSize ? Number(size.toFixed(4)) : null,
    targetStake,
    minNotional,
    minSizeOverride: false,
    sizingNote: size >= minOrderSize ? "sized from target stake percentage" : `target stake ${targetStake.toFixed(4)} USDC is below exchange minimum ${minNotional.toFixed(4)} USDC`,
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

  const orderSizing = sharesForOrder({ price, minOrderSize, maxNotional, cash });
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

  const probability = number(evaluation.aiProbability);
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
  const fee = USE_LIMIT_ORDERS && POST_ONLY ? 0 : takerFee(size, price, feeRateForEvaluation(evaluation));
  const totalCost = notional + fee;
  const expectedValue = probability * size - notional - fee;
  const expectedRoi = totalCost > 0 ? expectedValue / totalCost : 0;
  const annualizedReturn = days ? expectedRoi * (365 / days) : expectedRoi;
  const edge = probability - price;
  const scored = scoreEconomics({
    probability,
    annualizedReturn,
    edge,
    spread: book.spread,
    volume24hr,
    liquidity,
    endOk,
  });

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
    minOrderSize,
    minOrderNotionalUsdc: Number(orderSizing.minNotional.toFixed(5)),
    maxNotionalBeforeMinimumOverrideUsdc: maxNotional,
    minSizeOverride: orderSizing.minSizeOverride,
    sizingNote: orderSizing.sizingNote,
    tickSize: tick,
    negRisk: Boolean(market.negRisk),
    aiProbability: Number(probability.toFixed(4)),
    edge: Number(edge.toFixed(4)),
    daysToResolution: days == null ? null : Number(days.toFixed(2)),
    expectedValueUsdc: Number(expectedValue.toFixed(4)),
    annualizedReturn: Number(annualizedReturn.toFixed(4)),
    netGainIfWinUsdc: Number((size - notional - fee).toFixed(4)),
    totalCostUsdc: Number(totalCost.toFixed(5)),
    tradingFeeUsdc: Number(fee.toFixed(5)),
    feeMode: USE_LIMIT_ORDERS && POST_ONLY ? "post-only maker fee assumed 0" : "taker fee estimate",
    orderType: USE_LIMIT_ORDERS ? "GTC" : "FAK",
    riskGroupKeys: risk.keys,
    riskGroupLabels: risk.labels,
    score: Number((annualizedReturn + edge).toFixed(6)),
  };
}

async function emitDecision(payload) {
  const previousRunLog = Array.isArray(previousExecutionState?.runLog) ? previousExecutionState.runLog : [];
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
  if (!USE_LIMIT_ORDERS) {
    const marketOrder = await client.createMarketOrder(
      {
        tokenID: order.tokenId,
        price: order.orderPrice,
        amount: order.orderNotionalUsdc,
        side: Side.BUY,
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
      side: Side.BUY,
    },
    options,
  );
  return client.postOrder(signedOrder, OrderType.GTC, POST_ONLY);
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
  return {
    question: item?.question || source.question || "",
    outcome: item?.outcome || source.outcome || "",
    tokenId: item?.tokenId || source.tokenId || null,
    evaluatedAt: item?.evaluatedAt || source.evaluatedAt || null,
    status: item?.status || source.status || null,
    aiProbability: number(item?.aiProbability ?? source.aiProbability),
    marketPrice: number(item?.marketPrice ?? source.marketPrice ?? item?.currentPrice),
    annualizedReturn: number(item?.annualizedReturn ?? source.annualizedReturn),
    expectedValueUsdc: number(item?.expectedValueUsdc ?? source.expectedValueUsdc),
    netGainIfWinUsdc: gain,
    netYield: gain != null && cost != null && cost > 0 ? number(gain / cost) : null,
    riskReward: gain != null && cost != null && cost > 0 ? number(gain / cost) : null,
    orderPrice: number(item?.orderPrice),
    orderSize: number(item?.orderSize),
    orderNotionalUsdc: number(item?.orderNotionalUsdc),
    rejectReasons: Array.isArray(item?.rejectReasons) ? item.rejectReasons.slice(0, 6) : [],
    sizingNote: item?.sizingNote || null,
    url: `https://polymarket.com/event/${item?.eventSlug || source.eventSlug || item?.slug || source.slug || ""}`,
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

async function reviewOpenOrders({ liveState, evaluationByToken, eligible, cash, maxNotional, tradingConfig }) {
  const openOrders = Array.isArray(liveState?.openOrders) ? liveState.openOrders : [];
  const reviews = [];
  let selectedAction = null;

  for (const order of openOrders) {
    const orderId = order.id || order.orderID || order.orderId;
    const tokenId = String(order.tokenId || order.assetId || "");
    const ageHours = openOrderAgeHours(order);
    const sourceEvaluation = evaluationByToken.get(tokenId);
    const lockedNotional = number(order.notionalUsdc, number(order.price, 0) * number(order.remainingSize, 0));
    const effectiveCash = number(cash, 0) + number(lockedNotional, 0);
    const review = openOrderSummary(order, {
      action: "KEEP_WAITING",
      reason: "open order is still inside the minimum review window",
      currentEvaluation: null,
      betterCandidate: null,
      cancelResponse: null,
      replaceResponse: null,
    });

    if (!sourceEvaluation) {
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
          Math.max(number(maxNotional, 0), number(lockedNotional, 0)),
          evaluationByToken,
        );
        review.currentEvaluation = liveBatchCandidateSummary(revalidated);
        const bestOther = eligible.find((candidate) => String(candidate.tokenId || "") !== tokenId) || null;
        const betterCandidate = bestOther && Number(bestOther.expectedValueUsdc || 0) > Number(revalidated.expectedValueUsdc || 0) + OPEN_ORDER_BETTER_CANDIDATE_EV_USDC
          ? bestOther
          : null;
        const orderPrice = number(order.price);
        const newPrice = number(revalidated.orderPrice);
        const priceDelta = Number.isFinite(orderPrice) && Number.isFinite(newPrice) ? newPrice - orderPrice : 0;
        review.betterCandidate = betterCandidate ? liveBatchCandidateSummary(betterCandidate) : null;
        review.priceDelta = Number(priceDelta.toFixed(4));

        if (revalidated.status !== "ELIGIBLE") {
          review.action = ageHours >= OPEN_ORDER_REVIEW_AFTER_HOURS ? "CANCEL" : "KEEP_WAITING";
          review.reason = `current revalidation no longer satisfies live rules: ${(revalidated.rejectReasons || []).join("; ") || "not eligible"}`;
        } else if (betterCandidate) {
          review.action = "CANCEL_FOR_BETTER_CANDIDATE";
          review.reason = `a better candidate exceeds this order by at least ${OPEN_ORDER_BETTER_CANDIDATE_EV_USDC.toFixed(2)} USDC expected value`;
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
  const [paperState, liveState, previousExecution] = await Promise.all([
    loadJsonResource(PAPER_STATE_URL, "paper state"),
    loadJsonResource(LIVE_STATE_URL, "live state"),
    loadOptionalJsonResource(LIVE_EXECUTION_STATE_URL, "previous live execution state"),
  ]);
  previousExecutionState = previousExecution;
  const cash = liveCashUsdc(liveState);
  const tradingConfig = liveTradingConfig(liveState);
  const portfolioValue = livePortfolioValue(liveState, cash);
  const fractionNotional = portfolioValue * MAX_ORDER_FRACTION;
  const monitoring = liveCashMonitoring(previousExecution, cash);
  const regularMaxNotional = Math.min(fractionNotional, MAX_ORDER_NOTIONAL_USDC);
  const idleUtilizationNotional = monitoring.idleCashOverdue ? Math.max(0, cash - IDLE_CASH_MAX_USDC) : 0;
  const maxNotional = Number(regularMaxNotional.toFixed(5));
  const rawEvaluations = Array.isArray(paperState.evaluations) ? paperState.evaluations : [];
  const latestEvaluations = latestUniqueEvaluations(rawEvaluations);
  const evaluationByToken = new Map(latestEvaluations.map((item) => [String(item.tokenId || ""), item]).filter(([tokenId]) => tokenId));
  const baseCandidates = latestEvaluations
    .filter((item) => Number.isFinite(Number(item.aiProbability)))
    .filter((item) => String(item.status || "").toUpperCase() !== "ERROR");

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
    .map((item) => ({
      ...item,
      funderAddress: tradingConfig.funderAddress,
      signatureType: tradingConfig.signatureType,
    }));
  const eligible = sortLiveEligibleCandidates(allEligible);
  const orderManagement = await reviewOpenOrders({
    liveState,
    evaluationByToken,
    eligible,
    cash,
    maxNotional,
    tradingConfig,
  });

  const best = eligible[0] || null;
  const cadenceBlocked = Boolean(monitoring.cadenceBlocked);
  const decision = {
    mode: DRY_RUN || !hasFlag("confirm-live") ? "validated-dry-run" : "live-submit",
    action: best && !cadenceBlocked ? (DRY_RUN || !hasFlag("confirm-live") ? "DRY_RUN_READY" : "SUBMIT") : "SKIP",
    reason: cadenceBlocked
      ? `live new-trade cadence blocked (${TRADE_CADENCE_HOURS}h)`
      : (best ? "best currently revalidated executable candidate" : "no currently executable candidate after live revalidation"),
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
      postOnly: POST_ONLY,
      orderSizeMode: ORDER_SIZE_MODE,
      minProbability: MIN_PROBABILITY,
      minAnnualReturn: MIN_ANNUAL_RETURN,
      maxSpread: MAX_SPREAD,
      minVolume24hr: MIN_VOLUME_24H,
      maxResolutionDays: MAX_RESOLUTION_DAYS,
      selectionOrder: SELECTION_ORDER,
      maxOrderNotionalCapUsdc: Number.isFinite(MAX_ORDER_NOTIONAL_USDC) ? MAX_ORDER_NOTIONAL_USDC : null,
      idleCashMaxUsdc: IDLE_CASH_MAX_USDC,
      idleCashGraceHours: IDLE_CASH_GRACE_HOURS,
      oneTradePerDay: ONE_TRADE_PER_DAY,
      tradeCadenceHours: TRADE_CADENCE_HOURS,
      ignoreTradeCadence: IGNORE_TRADE_CADENCE,
      capitalUtilizationOverride: monitoring.idleCashOverdue,
      scannedCandidates: baseCandidates.length,
      revalidatedCandidates: checked.length,
      eligibleCandidates: allEligible.length,
      openOrderReviewAfterHours: OPEN_ORDER_REVIEW_AFTER_HOURS,
      openOrderCancelAfterHours: OPEN_ORDER_CANCEL_AFTER_HOURS,
      openOrderRepriceThreshold: OPEN_ORDER_REPRICE_THRESHOLD,
    },
    orderManagement,
    selected: best,
    batchLog: {
      id: `live-trade-batch-${new Date().toISOString()}`,
      runAt: new Date().toISOString(),
      strategyId: "live",
      strategyLabel: "Live",
      selectionMetric: "EV p.a.",
      action: best && !cadenceBlocked ? (DRY_RUN || !hasFlag("confirm-live") ? "DRY_RUN_READY" : "SUBMIT") : "SKIP",
      reason: cadenceBlocked
        ? `live new-trade cadence blocked (${TRADE_CADENCE_HOURS}h)`
        : (best ? "best currently revalidated executable candidate" : "no currently executable candidate after live revalidation"),
      explanation: best && !cadenceBlocked
        ? "Live batch found an executable candidate after revalidation."
        : (cadenceBlocked ? "No live order was submitted because the configured new-trade cadence is not elapsed yet. Open-order management still ran." : "No live order was submitted because all revalidated candidates failed current execution criteria."),
      settings: {
        minProbability: MIN_PROBABILITY,
        minAnnualReturn: MIN_ANNUAL_RETURN,
        maxSpread: MAX_SPREAD,
        minVolume24hr: MIN_VOLUME_24H,
        maxResolutionDays: MAX_RESOLUTION_DAYS,
        tradeCadenceHours: TRADE_CADENCE_HOURS,
        ignoreTradeCadence: IGNORE_TRADE_CADENCE,
        selectionOrder: SELECTION_ORDER,
        useLimitOrders: USE_LIMIT_ORDERS,
        crossPortfolioRiskDiversification: CROSS_PORTFOLIO_RISK_DIVERSIFICATION,
        maxOrderFraction: MAX_ORDER_FRACTION,
      },
      capital: {
        availableUsdc: cash,
        portfolioValueUsdc: Number(portfolioValue.toFixed(5)),
        requiredStakeUsdc: maxNotional,
        insufficientCapital: !Number.isFinite(maxNotional) || maxNotional <= 0 || cash + 0.000001 < maxNotional,
      },
      counts: {
        scannedCandidates: baseCandidates.length,
        revalidatedCandidates: checked.length,
        eligibleCandidates: allEligible.length,
        rankedEligibleCandidates: eligible.length,
        openOrdersReviewed: orderManagement.reviews.length,
        rejectedCandidates: checked.filter((item) => item.status !== "ELIGIBLE").length,
        cadenceBlocked,
        rawCadenceBlocked: Boolean(monitoring.rawCadenceBlocked),
      },
      openOrderReviews: orderManagement.reviews,
      selected: best ? liveBatchCandidateSummary(best) : null,
      topCandidates: eligible.slice(0, 8).map(liveBatchCandidateSummary),
      topRejected: checked.filter((item) => item.status !== "ELIGIBLE").slice(0, 8).map(liveBatchCandidateSummary),
    },
    topRejected: checked
      .filter((item) => item.status !== "ELIGIBLE")
      .slice(0, 8)
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

  if (orderManagement.action !== "NONE") {
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
      await emitDecision({
        ...decision,
        action: "SUBMITTED",
        reason: "live order accepted by Polymarket",
        batchLog: {
          ...decision.batchLog,
          action: "SUBMITTED",
          reason: "live order accepted by Polymarket",
          explanation: "Live batch revalidated candidates and Polymarket accepted the selected order.",
          selected: liveBatchCandidateSummary(candidate),
        },
        monitoring: {
          ...monitoring,
          lastSubmittedAt: new Date().toISOString(),
          estimatedCashAfterOrderUsdc: Number(Math.max(0, cash - Number(candidate.totalCostUsdc || candidate.orderNotionalUsdc || 0)).toFixed(5)),
        },
        selected: candidate,
        response,
        attempts: [...attempts, orderAttemptSummary(candidate, response, { action: "SUBMITTED" })],
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
      await emitDecision({
        ...decision,
        action: "REJECTED",
        reason: stopReason,
        batchLog: {
          ...decision.batchLog,
          action: "REJECTED",
          reason: stopReason,
          explanation: `Live order was not opened because submission stopped: ${stopReason}.`,
          selected: liveBatchCandidateSummary(candidate),
        },
        selected: candidate,
        response,
        attempts,
      });
      process.exit(1);
    }
  }

  await emitDecision({
    ...decision,
    action: "REJECTED",
    reason: "all revalidated candidates were rejected by order submission",
    batchLog: {
      ...decision.batchLog,
      action: "REJECTED",
      reason: "all revalidated candidates were rejected by order submission",
      explanation: "Live order was not opened because every revalidated candidate failed during order submission.",
    },
    response: attempts.at(-1)?.response || null,
    attempts,
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
