#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

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
const SKIP_SCHEDULED_EXECUTION = String(process.env.LIVE_SKIP_SCHEDULED_EXECUTION || "").toLowerCase() === "true";
const OPEN_ORDER_REVIEW_AFTER_HOURS = envNumber("LIVE_OPEN_ORDER_REVIEW_AFTER_HOURS", 2);
const OPEN_ORDER_CANCEL_AFTER_HOURS = envNumber("LIVE_OPEN_ORDER_CANCEL_AFTER_HOURS", 8);
const OPEN_ORDER_REPRICE_THRESHOLD = envNumber("LIVE_OPEN_ORDER_REPRICE_THRESHOLD", 0.015);
const OPEN_ORDER_BETTER_CANDIDATE_EV_USDC = envNumber("LIVE_OPEN_ORDER_BETTER_CANDIDATE_EV_USDC", 0.02);
const ROTATION_CANDIDATE_SCAN_LIMIT = envNumber("LIVE_ROTATION_CANDIDATE_SCAN_LIMIT", 10);
const ROTATION_POSITION_SCAN_LIMIT = envNumber("LIVE_ROTATION_POSITION_SCAN_LIMIT", 6);
// A rotation must improve the configured portfolio metric by at least the
// portfolio's minimum net profit. This keeps the exit fee and required return
// threshold in one place instead of using an unrelated dollar EV margin.
const ROTATION_MIN_PRIORITY_IMPROVEMENT = Math.max(
  MIN_NET_YIELD,
  envNumber("LIVE_ROTATION_MIN_PRIORITY_IMPROVEMENT", MIN_NET_YIELD),
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

function prefilterLiveCandidate(item) {
  const reasons = [];
  const tokenId = String(item?.tokenId || "");
  const status = String(item?.status || "").toUpperCase();
  const aiPending = item?.selectionStatus === "AI_PENDING" || item?.aiAnalysis?.aiModelStatus === "QUOTA_LIMITED";
  const qualificationProbability = selectedProbability(item);
  const endTime = Date.parse(item?.endDate || "");
  const days = localDaysToResolution(item);
  const liquidity = number(item?.liquidity, 0);

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
  if (liquidity < MIN_VOLUME_24H) {
    reasons.push(`liquidity ${liquidity.toFixed(2)} USDC below live minimum ${MIN_VOLUME_24H.toFixed(2)} USDC`);
  }
  // Gamma's end date can be a scheduled start or an outdated estimate. The
  // live market check is authoritative: retain this row until Gamma/CLOB says
  // the market is closed or no longer accepting orders.
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
  // These three also carry a per-candidate number (a percentage or a USDC amount) baked
  // into the reason text. Left ungrouped, every distinct value became its own bucket --
  // for liquidity specifically this turned a single homogeneous rejection reason into
  // thousands of one-off entries and was the dominant contributor to run-log size.
  if (/annualized return .* is non-profitable after fees/i.test(text)) return "annualized return non-profitable after fees";
  if (/^net profit .* below .* after fees/i.test(text)) return "net profit below live minimum after fees";
  if (/^liquidity .* below live minimum .* USDC/i.test(text)) return "liquidity below live minimum";
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
      if (!market) return order;
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
        daysToResolution: daysToEnd(dates.endDate || order.endDate) ?? Math.max(1, number(order.daysToResolution, 1)),
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

function activeBuyOrderReservationUsdc(liveState) {
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

function availableLiveCashUsdc(liveState, grossCash = liveCashUsdc(liveState)) {
  // CLOB collateral is the account balance before the notional locked in
  // pending BUY orders. A new order may only consume the remainder.
  return Math.max(0, number(grossCash, 0) - activeBuyOrderReservationUsdc(liveState));
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

function candidatePoolForRotation(baseCandidates = []) {
  return [...baseCandidates]
    .filter((item) => Number.isFinite(selectedProbability(item)))
    .filter((item) => Number.isFinite(selectedAnnualizedReturn(item)) && selectedAnnualizedReturn(item) > 0)
    .filter((item) => Number.isFinite(selectedExpectedValue(item)) && selectedExpectedValue(item) > 0)
    // Rotation must use exactly the portfolio's configured ordering. In
    // particular, high-reward portfolios must not silently fall back to EV p.a.
    .sort(compareLiveCandidatePriority)
    .slice(0, ROTATION_CANDIDATE_SCAN_LIMIT);
}

function candidateRequiresSpecificPositionExit(candidate, position, liveState, evaluationByToken = new Map()) {
  const beforeExit = riskBlock(candidate, liveState, evaluationByToken);
  if (!beforeExit) return false;
  const afterExit = riskBlock(candidate, liveStateWithoutPosition(liveState, position), evaluationByToken);
  return !afterExit;
}

async function reviewPositionRotation({ liveState, evaluationByToken, baseCandidates, cash, maxNotional, restrictToRiskReplacement = false }) {
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

  for (const [positionRank, item] of positions.entries()) {
    const {
      position,
      exitValue,
      holdEv,
      holdAnnualizedReturn,
      priority,
      economics,
      pendingResolutionReferenceAnnualizedReturn,
      usesPendingResolutionReference,
    } = item;
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
        // Otherwise the replacement must improve the portfolio's ranking metric by at
        // least the configured minimum net profit. A separate requirement that the
        // absolute USD result also improve was removed: the ranking metric (p.a.) is
        // exactly what the portfolio is optimised for, and a shorter-horizon candidate
        // can legitimately rank higher while paying fewer raw dollars -- gating on
        // evDelta as well meant the portfolio kept a worse-ranked position/order simply
        // because it happened to be a bigger single payout.
        const rotationPreferred = !settlementLocked
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
            : (candidateResolvesLater && !settlementLocked
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

function scoreEconomics({ probability, qualificationProbability, annualizedReturn, netYield, edge, spread, volume24hr, liquidity, endOk }) {
  const probabilityOk = qualificationProbability >= MIN_PROBABILITY;
  const opportunityOk = probability >= OPPORTUNITY_MIN_PROBABILITY
    && edge >= OPPORTUNITY_MIN_EDGE
    && annualizedReturn >= OPPORTUNITY_MIN_ANNUAL_RETURN;
  const minimumAnnualizedReturn = PROBABILITY_SOURCE === "polymarket" ? 0 : MIN_ANNUAL_RETURN;
  const returnOk = annualizedReturn > minimumAnnualizedReturn;
  const netYieldOk = Number.isFinite(netYield) && netYield >= MIN_NET_YIELD;
  const spreadOk = spread != null && spread <= MAX_SPREAD;
  // `minLiquidityUsdc` is a portfolio liquidity floor.  24h volume is useful
  // context but must not substitute for executable order-book liquidity.
  const liquidityOk = liquidity >= MIN_VOLUME_24H;
  return {
    eligible: endOk && probabilityOk && returnOk && netYieldOk && spreadOk && liquidityOk,
    thesisType: probabilityOk ? "HIGH_CONFIDENCE" : (opportunityOk ? "EDGE_OPPORTUNITY_BELOW_LIVE_THRESHOLD" : "REJECTED"),
    rejectReasons: [
      endOk ? null : "event end date is in the past",
      probabilityOk ? null : `${probabilitySourceLabel()} ${(qualificationProbability * 100).toFixed(1)}% below live threshold ${(MIN_PROBABILITY * 100).toFixed(1)}%`,
      annualizedReturn <= 0
        ? `${probabilitySourceLabel()} ${returnMetricLabel()} ${(annualizedReturn * 100).toFixed(1)}% is non-profitable after fees`
        : (returnOk ? null : `${probabilitySourceLabel()} ${returnMetricLabel()} ${(annualizedReturn * 100).toFixed(1)}% below ${(minimumAnnualizedReturn * 100).toFixed(1)}%`),
      netYieldOk ? null : `net profit ${Number.isFinite(netYield) ? `${(netYield * 100).toFixed(1)}%` : "-"} below ${(MIN_NET_YIELD * 100).toFixed(1)}% after fees`,
      spreadOk ? null : `spread ${spread == null ? "n/a" : (spread * 100).toFixed(1) + " pts"} too wide`,
      liquidityOk ? null : `liquidity ${Number(liquidity || 0).toFixed(2)} USDC below live minimum ${MIN_VOLUME_24H.toFixed(2)} USDC`,
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
  const appliedFeeRate = USE_LIMIT_ORDERS && POST_ONLY ? 0 : Math.max(0, number(feeRate, 0));
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
  const makerPrecisionBlocked = USE_LIMIT_ORDERS && POST_ONLY && size > 0 && orderNotional < 0.01 - 0.000001;

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

async function revalidateEvaluation(evaluation, liveState, cash, maxNotional, evaluationByToken = new Map()) {
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
  // Gamma's scheduled date often marks a match start, not the point at which
  // Polymarket stops accepting trades. As long as the market is active and
  // accepting orders, verify its live CLOB quote instead of rejecting it just
  // because that scheduled date has elapsed.
  const awaitingResolutionWhileTradable = !endDateIsFuture(dateContext.endDate);

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
      ? "no available cash for a new order; rotation may release capital"
      : (orderSizing.stakeCapBelowExchangeMinimum
        ? "Polymarket minimum order " + minOrderSize.toFixed(4) + " shares costs " + minimumCost.toFixed(4) + " USDC, above this portfolio's max per trade " + targetStake.toFixed(4) + " USDC and above the " + Number(orderSizing.stakeFloorCeilingUsdc || 0).toFixed(2) + " USDC stake-floor ceiling, so the stake was not raised to meet it; " + availableCash.toFixed(4) + " USDC remains free, so rotation is not needed"
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
  const endDate = dateContext.endDate;
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
  // The exchange state above is authoritative. A past scheduled date is not
  // a disqualifier while Polymarket still accepts the trade.
  const endOk = true;
  const volume24hr = number(market.volume24hr, number(evaluation.volume24hr, 0));
  const liquidity = number(market.liquidity, number(evaluation.liquidity, 0));
  const notional = Number((price * size).toFixed(5));
  const fee = USE_LIMIT_ORDERS && POST_ONLY ? 0 : takerFee(size, price, estimatedFeeRate);
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
    scheduledEventDate: dateContext.scheduledEventDate,
    resolutionEndDate: dateContext.resolutionEndDate,
    endDateSource: dateContext.endDateSource,
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
    awaitingResolutionWhileTradable,
    expectedValueUsdc: Number(selectedExpectedValueUsdc.toFixed(4)),
    annualizedReturn: Number(selectedAnnualizedReturn.toFixed(4)),
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
    feeMode: USE_LIMIT_ORDERS && POST_ONLY ? "post-only maker fee assumed 0" : "taker fee estimate",
    orderType: USE_LIMIT_ORDERS ? "GTC" : "FAK",
    riskGroupKeys: risk.keys,
    riskGroupLabels: risk.labels,
    score: Number((selectedAnnualizedReturn + (PROBABILITY_SOURCE === "polymarket" ? qualificationProbability - price : edge)).toFixed(6)),
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
  const options = {
    tickSize: String(order.tickSize || "0.01"),
    negRisk: Boolean(order.negRisk),
  };
  const side = String(order.side || "BUY").toUpperCase() === "SELL" ? Side.SELL : Side.BUY;
  const forceTaker = Boolean(order.forceTaker) || String(order.orderType || "").toUpperCase() === "FAK";
  // A rotation exit must consume the best bid immediately, but it still needs
  // the normal V2 limit-order signature. `createMarketOrder` has a separate
  // payload builder; using the standard FAK path keeps the POLY_1271 wrapper
  // identical to the order shape verified by the CLOB.
  if (side === Side.SELL && forceTaker) {
    return client.createAndPostOrder(
      {
        tokenID: order.tokenId,
        price: order.orderPrice,
        size: order.orderSize,
        side,
      },
      options,
      OrderType.FAK,
      false,
    );
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
    minSizeOverride: candidate.minSizeOverride,
    sizingNote: candidate.sizingNote,
    response,
    responseStatus: response?.status ?? null,
    responseError: orderResponseError(response) || null,
    responseSummary: compactOrderResponse(response) || null,
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
  const fee = USE_LIMIT_ORDERS && POST_ONLY ? 0 : takerFee(size, price, feeRate);
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
    status: status === "ELIGIBLE"
      ? "READY"
      : (status === "ERROR"
        ? "ERROR"
        : (marketGone ? "CLOSED" : (retryClass ? `WAITING_${retryClass}` : "REJECTED"))),
    retryable: Boolean(retryClass) && !marketGone,
    retryClass: marketGone ? null : retryClass,
    marketGone,
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
      negRisk: Boolean(order.negRisk),
      question: order.question || order.market || "",
      outcome: order.outcome || "",
    },
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

    if (maxStakeBreached) {
      review.reason = `open order notional ${lockedNotional.toFixed(4)} USDC exceeds max stake ${maxNotional.toFixed(4)} USDC; kept because no replacement can be submitted atomically in this review`;
    } else if (!sourceEvaluation) {
      review.reason = ageHours >= OPEN_ORDER_CANCEL_AFTER_HOURS
        ? "no current evaluation links to this open order and the order is stale; kept because no replacement can be submitted atomically in this review"
        : "no current evaluation links to this open order yet; kept waiting for a replacement decision";
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
          review.reason = `current revalidation no longer satisfies live rules: ${(revalidated.rejectReasons || []).join("; ") || "not eligible"}; existing order kept because no replacement can be submitted atomically in this review`;
        } else if (betterCandidate && betterCandidateNeedsReleasedCapital) {
          review.action = "CANCEL_FOR_BETTER_CANDIDATE";
          // Keep the freshly validated order payload. After the cancellation
          // succeeds, main() submits this exact replacement immediately and
          // restores the original order if that submission fails.
          review.replacementCandidate = betterCandidate;
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
          review.reason = `order has waited ${ageHours.toFixed(1)}h without fill; kept because cancelling without an immediate replacement is not allowed`;
        } else {
          review.action = "KEEP_WAITING";
          review.reason = `still eligible and price gap ${Math.abs(priceDelta * 100).toFixed(1)} pts is below reprice threshold`;
        }
      } catch (error) {
        review.reason = `open order revalidation failed: ${error?.message || String(error)}; existing order kept because no replacement can be submitted atomically in this review`;
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
        : await submitOrderWithMakerPrecisionRecovery(replacementOrder);
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
  const liveState = await hydrateLiveOpenOrderMetadata(loadedLiveState);
  previousExecutionState = previousExecution;
  if (SKIP_SCHEDULED_EXECUTION) {
    console.log(JSON.stringify({
      action: "TRIGGER_WAIT",
      reason: "Live portfolio is configured to execute after each scraping batch; scheduled cron execution was skipped.",
      executionTrigger: "after_scrape",
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
  const reservedOpenOrderUsdc = activeBuyOrderReservationUsdc(liveState);
  const availableCash = availableLiveCashUsdc(liveState, cash);
  const tradingConfig = liveTradingConfig(liveState);
  const portfolioValue = livePortfolioValue(liveState, cash);
  const fractionNotional = portfolioValue * MAX_ORDER_FRACTION;
  const monitoring = liveCashMonitoring(previousExecution, availableCash);
  const regularMaxNotional = Math.min(fractionNotional, MAX_ORDER_NOTIONAL_USDC);
  const idleUtilizationNotional = monitoring.idleCashOverdue ? Math.max(0, availableCash - IDLE_CASH_MAX_USDC) : 0;
  const maxNotional = Number(regularMaxNotional.toFixed(5));
  const directMaxNotional = Number(Math.min(maxNotional, availableCash).toFixed(5));
  const rawEvaluations = Array.isArray(paperState.evaluations) ? paperState.evaluations : [];
  const rawMarketObservations = PROBABILITY_SOURCE === "polymarket" && Array.isArray(scrapedState?.marketObservations)
    ? scrapedState.marketObservations
    : [];
  const rawCandidateRows = PROBABILITY_SOURCE === "polymarket"
    ? rawMarketObservations
    : rawEvaluations;
  const candidatePool = prepareLiveCandidatePool(rawCandidateRows, liveState);
  const latestEvaluations = candidatePool.uniqueEvaluations;
  const evaluationByToken = new Map(latestEvaluations.map((item) => [String(item.tokenId || ""), item]).filter(([tokenId]) => tokenId));
  const manualShortlistFallback = candidatePool.diagnostics.manualShortlistFallback === true;
  const baseCandidates = candidatePool.candidates;

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
  const rotationReview = !eligible.length && (needsCapitalRotation || needsRiskReplacement)
    ? await reviewPositionRotation({
        liveState,
        evaluationByToken,
        baseCandidates,
        cash: availableCash,
        maxNotional,
        restrictToRiskReplacement: needsRiskReplacement,
      })
    : null;
  const rotationCandidatePool = candidatePoolForRotation(baseCandidates);
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
  // A directly fundable candidate must also protect unrelated open orders from
  // cancellation. A funded buy must never trigger a needless cancellation just
  // to make room for a trade that is already funded.
  const orderManagement = activeSellOrders.length || directCandidateCanUseFreeCapital
    ? { action: "NONE", reviews: [] }
    : await reviewOpenOrders({
      liveState,
      evaluationByToken,
      eligible,
      rotationCandidates: rotationCandidatePool,
      cash: availableCash,
        maxNotional,
        tradingConfig,
      });

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
  const appliedDirectStake = best?.totalCostUsdc != null
    ? number(best.totalCostUsdc, 0)
    : Math.min(maxNotional, Math.max(0, availableCashAfterOrderManagement));
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
                ? `live candidates blocked by available USDC: ${cashSizingBlocked.length} cannot meet the current Polymarket minimum order size`
                : (stakeCapBlockedCandidates.length
                  ? `free cash is sufficient, but ${stakeCapBlockedCandidates.length} live candidate${stakeCapBlockedCandidates.length === 1 ? " is" : "s are"} below Polymarket's minimum order size at the configured max per trade`
                  : "no currently executable candidate after live revalidation")))));
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
                ? "No live order was submitted because available USDC cannot cover the exchange minimum size for the revalidated candidate(s)."
                : (stakeCapBlockedCandidates.length
                  ? "No live order was submitted because the configured max per trade is below Polymarket's exchange minimum. Free cash was sufficient, so no order or position was rotated."
                  : "No live order was submitted because all revalidated candidates failed current execution criteria.")))));
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
      reservedOpenOrderUsdc: Number(reservedOpenOrderUsdc.toFixed(5)),
      availableCashUsdc: Number(availableCash.toFixed(5)),
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
      freeCapitalPriority: true,
      hasUsableFreeCash,
      directCandidateCanUseFreeCapital,
      directCandidateCostUsdc: directCandidateCost,
      manualShortlistFallback,
      capitalUtilizationOverride: monitoring.idleCashOverdue,
      storedEvaluations: rawEvaluations.length,
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
      rotationProtectRemainingGainUsdc: ROTATION_PROTECT_REMAINING_GAIN_USDC,
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
      runSource: String(process.env.LIVE_RUN_SOURCE || "AUTO").toUpperCase() === "MANUAL" ? "MANUAL" : "AUTO",
      manualRunOnce: String(process.env.LIVE_RUN_SOURCE || "").toUpperCase() === "MANUAL",
      selectionMetric: returnMetricLabel(),
      action: best ? (DRY_RUN || !hasFlag("confirm-live") ? "DRY_RUN_READY" : "SUBMIT") : "SKIP",
      reason: actionReason,
      explanation: actionExplanation,
      humanReason: rotationHumanReason || null,
      settings: {
        minProbability: MIN_PROBABILITY,
        probabilitySource: PROBABILITY_SOURCE,
        minAnnualReturn: MIN_ANNUAL_RETURN,
        maxSpread: MAX_SPREAD,
        minVolume24hr: MIN_VOLUME_24H,
        minNetYield: MIN_NET_YIELD,
        maxResolutionDays: MAX_RESOLUTION_DAYS,
        executionTrigger: String(process.env.LIVE_EXECUTION_TRIGGER || "cron").toLowerCase() === "after_scrape" ? "after_scrape" : "cron",
        freeCapitalPriority: true,
        hasUsableFreeCash,
        directCandidateCanUseFreeCapital,
        directCandidateCostUsdc: directCandidateCost,
        manualShortlistFallback,
        selectionOrder: SELECTION_ORDER,
        useLimitOrders: USE_LIMIT_ORDERS,
        crossPortfolioRiskDiversification: CROSS_PORTFOLIO_RISK_DIVERSIFICATION,
        liveAutoRotate: LIVE_AUTO_ROTATE,
        maxOrderFraction: MAX_ORDER_FRACTION,
        rotationMinimumPriorityImprovement: ROTATION_MIN_PRIORITY_IMPROVEMENT,
        rotationProtectRemainingGainUsdc: ROTATION_PROTECT_REMAINING_GAIN_USDC,
      },
      capital: {
        availableUsdc: availableCash,
        grossCashUsdc: cash,
        reservedOpenOrderUsdc: Number(reservedOpenOrderUsdc.toFixed(5)),
        portfolioValueUsdc: Number(portfolioValue.toFixed(5)),
        targetStakeUsdc: maxNotional,
        requiredStakeUsdc: Number(appliedDirectStake.toFixed(5)),
        insufficientCapital: !best && (!Number.isFinite(maxNotional) || maxNotional <= 0 || cashSizingBlocked.length > 0),
        capitalSizingBlockedCandidates: cashSizingBlocked.length,
        stakeCapBlockedCandidates: stakeCapBlockedCandidates.length,
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
        capitalSizingBlockedCandidates: cashSizingBlocked.length,
        stakeCapBlockedCandidates: stakeCapBlockedCandidates.length,
        makerPrecisionBlockedCandidates: makerPrecisionBlockedCandidates.length,
        rankedEligibleCandidates: eligible.length,
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
    let response = null;
    try {
      exitOrder = await buildRotationExitOrder(
        rotation.positionOrder || rotation.position,
        evaluationByToken,
        tradingConfig,
      );
      response = DRY_RUN || !hasFlag("confirm-live")
        ? { status: "dry_run_rotation_exit", success: true }
        : await submitOrder(exitOrder);
    } catch (error) {
      response = { status: "exception", error: error?.message || String(error) };
    }
    const accepted = successfulOrderResponse(response);
    const action = accepted
      ? (DRY_RUN || !hasFlag("confirm-live") ? "DRY_RUN_ROTATION_EXIT" : "ROTATION_EXIT_SUBMITTED")
      : "ROTATION_EXIT_REJECTED";
    const reason = accepted
      ? `${rotationHumanReason || "A weaker live position is being replaced by a better candidate."} Sell order submitted; the replacement buy will follow the next confirmed account sync.`
      : `Rotation sell order was not accepted: ${orderResponseError(response) || "unknown Polymarket response"}; the existing position was preserved`;
    const explanation = accepted
      ? "The selected position passed the portfolio-metric comparison after estimated sell fees and current P/L. The sell was submitted first; the next run will sync released cash and revalidate the selected replacement before buying it."
      : "The selected replacement was not executed because its sell order was not accepted. No position or unrelated order was cancelled.";
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
    const submission = await submitOrderWithMakerPrecisionRecovery(candidate);
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
  MIN_ORDER_STAKE_CEILING_USDC,
  consoleDecisionSummary,
  annualizeReturn,
  localDaysToResolution,
  selectedAnnualizedReturn,
  ROTATION_PROTECT_REMAINING_GAIN_USDC,
  positionRotationEconomics,
  sharesForOrder,
  prepareLiveCandidatePool,
  liveRevalidationUpdate,
  heldRiskItems,
  earlyRiskBlockReason,
  compactLiveRunRecord,
};
