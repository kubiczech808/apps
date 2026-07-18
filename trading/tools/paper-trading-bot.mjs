#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const OUTPUT_PATH = process.env.PAPER_STATE_PATH || "data/paper-state.json";
const REMOTE_STATE_URL = process.env.PAPER_STATE_URL || "";
const PORTFOLIO_USDC = Number(process.env.PAPER_PORTFOLIO_USDC || 100);
const MAX_FRACTION = Number(process.env.PAPER_MAX_FRACTION || 0.05);
const MIN_PROBABILITY = Number(process.env.PAPER_MIN_PROBABILITY || 0.95);
const MIN_ANNUAL_RETURN = Number(process.env.PAPER_MIN_ANNUAL_RETURN || 0.05);
const OPPORTUNITY_MIN_PROBABILITY = Number(process.env.PAPER_OPPORTUNITY_MIN_PROBABILITY || 0.6);
const OPPORTUNITY_MIN_EDGE = Number(process.env.PAPER_OPPORTUNITY_MIN_EDGE || 0.04);
const OPPORTUNITY_MIN_ANNUAL_RETURN = Number(process.env.PAPER_OPPORTUNITY_MIN_ANNUAL_RETURN || 0.3);
const MAX_EVALUATIONS_PER_RUN = Number(process.env.PAPER_MAX_EVALUATIONS_PER_RUN || 80);
const MAX_SPREAD = Number(process.env.PAPER_MAX_SPREAD || 0.08);
const MIN_VOLUME_24H = Number(process.env.PAPER_MIN_VOLUME_24H || 100);
const MAX_HISTORY = Number(process.env.PAPER_MAX_HISTORY || 1200);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const AI_ANALYSIS_LIMIT = Number(process.env.PAPER_AI_ANALYSIS_LIMIT || 10);
const AI_POSTMORTEM_LIMIT = Number(process.env.PAPER_AI_POSTMORTEM_LIMIT || 8);
const REFRESH_ONLY = String(process.env.PAPER_REFRESH_ONLY || "").toLowerCase() === "true";
const TZ = "Europe/Prague";
const OPEN_STATUSES = new Set(["OPEN", "PENDING_RESOLUTION", "MARKET_NOT_FOUND"]);

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
      const remote = await fetchJson(`${REMOTE_STATE_URL}?t=${Date.now()}`);
      if (remote && typeof remote === "object" && Array.isArray(remote.trades)) {
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
  return {
    schemaVersion: 2,
    generatedAt: input.generatedAt || null,
    portfolio: {
      initialUsdc: Number(input.portfolio?.initialUsdc || PORTFOLIO_USDC),
      maxFraction: Number(input.portfolio?.maxFraction || MAX_FRACTION),
      minProbability: Number(input.portfolio?.minProbability || MIN_PROBABILITY),
      minAnnualReturn: Number(input.portfolio?.minAnnualReturn || MIN_ANNUAL_RETURN),
      opportunityMinProbability: Number(input.portfolio?.opportunityMinProbability || OPPORTUNITY_MIN_PROBABILITY),
      opportunityMinEdge: Number(input.portfolio?.opportunityMinEdge || OPPORTUNITY_MIN_EDGE),
      opportunityMinAnnualReturn: Number(input.portfolio?.opportunityMinAnnualReturn || OPPORTUNITY_MIN_ANNUAL_RETURN),
    },
    trades: Array.isArray(input.trades) ? input.trades.map(normalizeTrade) : [],
    evaluations: Array.isArray(input.evaluations) ? input.evaluations : [],
    learningProfile: normalizeLearningProfile(input.learningProfile),
    lastTradeDate: input.lastTradeDate || null,
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

function mergeUniqueById(items, idFn, limit = Infinity) {
  const byId = new Map();
  for (const item of items) {
    const id = idFn(item);
    if (!id) continue;
    if (!byId.has(id)) byId.set(id, item);
  }
  return [...byId.values()].slice(0, limit);
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
  const tradesById = new Map();
  for (const trade of [...(other.trades || []), ...(base.trades || [])]) {
    tradesById.set(trade.id, mergeTrade(tradesById.get(trade.id), trade));
  }
  return {
    ...base,
    trades: [...tradesById.values()].sort((a, b) => tradeUpdateTime(b) - tradeUpdateTime(a)),
    evaluations: mergeUniqueById([...(base.evaluations || []), ...(other.evaluations || [])], (item) => item.id, MAX_HISTORY),
    runLog: mergeUniqueById([...(base.runLog || []), ...(other.runLog || [])], (item) => item.runAt, 120),
  };
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
  };
}

function normalizeTrade(trade) {
  if (!trade || typeof trade !== "object") return trade;
  const risk = riskProfile({
    question: trade.question,
    slug: trade.slug,
    outcome: trade.outcome,
    tags: trade.tags,
  });
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
    riskGroupKeys: Array.isArray(trade.riskGroupKeys) && trade.riskGroupKeys.length ? trade.riskGroupKeys : risk.keys,
    riskGroupLabels: Array.isArray(trade.riskGroupLabels) && trade.riskGroupLabels.length ? trade.riskGroupLabels : risk.labels,
  };
}

function daysToEnd(endDate) {
  const end = Date.parse(endDate || "");
  if (!Number.isFinite(end)) return null;
  return Math.max(1, (end - Date.now()) / 86400000);
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

function riskProfile({ question, slug, outcome, tags }) {
  const keys = new Set();
  const labels = new Map();
  const addKey = (key, label) => {
    if (!key) return;
    keys.add(key);
    if (label) labels.set(key, label);
  };

  const normalizedSlug = normalizeRiskText(slug).replace(/\s+/g, "-");
  if (normalizedSlug) addKey(`market:${normalizedSlug}`, `Market: ${normalizedSlug}`);

  const eventKey = eventSlugKey(slug);
  if (eventKey) addKey(`event:${eventKey}`, `Event: ${eventKey}`);

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

function scoreStatus({ probability, annualizedReturn, edge, spreadOk, volumeOk, depthOk }) {
  const highConfidenceOk = probability >= MIN_PROBABILITY;
  const opportunityOk = probability >= OPPORTUNITY_MIN_PROBABILITY
    && edge >= OPPORTUNITY_MIN_EDGE
    && annualizedReturn >= OPPORTUNITY_MIN_ANNUAL_RETURN;
  const returnOk = annualizedReturn >= MIN_ANNUAL_RETURN;
  const eligible = (highConfidenceOk || opportunityOk) && returnOk && spreadOk && volumeOk && depthOk;
  return {
    status: eligible ? "ELIGIBLE" : "REJECTED",
    thesisType: highConfidenceOk ? "HIGH_CONFIDENCE" : (opportunityOk ? "EDGE_OPPORTUNITY" : "REJECTED"),
    rejectReasons: [
      highConfidenceOk || opportunityOk ? null : `probability ${(probability * 100).toFixed(1)}% below high-confidence threshold and edge-opportunity threshold`,
      returnOk ? null : `annualized EV ${(annualizedReturn * 100).toFixed(1)}% below ${(MIN_ANNUAL_RETURN * 100).toFixed(1)}%`,
      spreadOk ? null : "spread too wide",
      volumeOk ? null : "liquidity/volume too low",
      depthOk ? null : "insufficient ask depth for market buy",
    ].filter(Boolean),
  };
}

function economicsForProbability({ probability, execution, stake, takerFee, totalCost, days, spreadOk, volumeOk, depthOk }) {
  const executionPrice = execution.avgPrice;
  const expectedValue = probability * execution.shares - stake - takerFee;
  const expectedRoi = totalCost > 0 ? expectedValue / totalCost : 0;
  const annualizedReturn = days ? expectedRoi * (365 / days) : expectedRoi;
  const edge = probability - executionPrice;
  const scored = scoreStatus({ probability, annualizedReturn, edge, spreadOk, volumeOk, depthOk });
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
  const outcome = String(outcomes[outcomeIndex] || `Outcome ${outcomeIndex + 1}`);
  const { bestBid, bestAsk, spread, askDepth, asks } = bestBook(book);
  const volume24hr = Number(market.volume24hr || 0);
  const liquidity = Number(market.liquidity || 0);
  const tags = tagQuestion(question);
  const risk = riskProfile({ question, slug: market.slug, outcome, tags });
  const days = daysToEnd(correctedEndDate(question, market.endDate, market.createdAt || market.updatedAt));
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
  const economics = economicsForProbability({ probability, execution, stake, takerFee, totalCost, days, spreadOk, volumeOk, depthOk });
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
    id: `${market.id}-${outcomeIndex}-${Date.now()}`,
    evaluatedAt: nowIso(),
    status: economics.status,
    thesisType: economics.thesisType,
    rejectReasons,
    question,
    slug: market.slug || "",
    eventSlug: marketEventSlug(market),
    outcome,
    tokenId,
    endDate: market.endDate || null,
    tags,
    riskCategory: risk.category,
    riskPrimaryEntity: risk.primaryEntity,
    riskGroupKeys: risk.keys,
    riskGroupLabels: risk.labels,
    executionMode: "MARKET_BUY",
    marketPrice: Number(executionPrice.toFixed(4)),
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
    grossAnnualizedIfWin: Number(grossAnnualizedIfWin.toFixed(4)),
    stakeUsdc: Number(stake.toFixed(2)),
    expectedValueUsdc: Number(economics.expectedValue.toFixed(4)),
    maxLossUsdc: Number(totalCost.toFixed(5)),
    aiAnalysis,
    probabilityThesis: aiAnalysis.thesis,
    analysisModel: aiAnalysis.model,
    analysisSummary: [
      `${aiAnalysis.thesis}`,
      `Raw probability ${(rawProbability * 100).toFixed(1)}%, calibrated probability ${(probability * 100).toFixed(1)}% vs simulated market-buy entry ${(executionPrice * 100).toFixed(1)}%.`,
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
  });

  const rejectReasons = economics.rejectReasons.map((reason) => {
    if (reason === "spread too wide") return `spread ${Number.isFinite(spread) ? (spread * 100).toFixed(1) + " pts" : "n/a"} too wide`;
    if (reason === "insufficient ask depth for market buy") return `insufficient ask depth for ${stake.toFixed(2)} USDC market buy`;
    return reason;
  });
  const aiAnalysis = {
    ...(evaluation.aiAnalysis || {}),
    ...modelAnalysis,
    model: modelName,
    probability: Number(probability.toFixed(4)),
    marketImpliedProbability: Number(evaluation.marketPrice),
    edge: Number(economics.edge.toFixed(4)),
    expectedValueUsdc: Number(economics.expectedValue.toFixed(4)),
    annualizedReturn: Number(economics.annualizedReturn.toFixed(4)),
    confidenceTier: modelAnalysis?.confidenceTier || confidenceTier(probability),
  };

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
    aiAnalysis,
    probabilityThesis: aiAnalysis.thesis || evaluation.probabilityThesis,
    analysisModel: modelName,
    analysisSummary: [
      aiAnalysis.thesis || evaluation.probabilityThesis || "AI analysis produced no thesis.",
      `Model probability ${(probability * 100).toFixed(1)}% vs market-buy entry ${(Number(evaluation.marketPrice) * 100).toFixed(1)}%.`,
      `Edge ${(economics.edge * 100).toFixed(1)} pts; expected annualized return ${(economics.annualizedReturn * 100).toFixed(1)}%; thesis type ${economics.thesisType}.`,
      modelAnalysis?.evidence ? `Evidence: ${[].concat(modelAnalysis.evidence).join(" ")}` : "",
      modelAnalysis?.counterEvidence ? `Counter evidence: ${[].concat(modelAnalysis.counterEvidence).join(" ")}` : "",
      evaluation.analysisSummary || "",
    ].filter(Boolean).join(" "),
  };
}

async function enrichEvaluationsWithAi(evaluations, learningProfile) {
  if (!OPENAI_API_KEY || AI_ANALYSIS_LIMIT <= 0) return evaluations;
  const candidates = [...evaluations]
    .filter((item) => item.status !== "ERROR")
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === "ELIGIBLE" ? -1 : 1;
      if (b.expectedValueUsdc !== a.expectedValueUsdc) return b.expectedValueUsdc - a.expectedValueUsdc;
      return b.annualizedReturn - a.annualizedReturn;
    })
    .slice(0, AI_ANALYSIS_LIMIT);
  const byId = new Map(evaluations.map((item) => [item.id, item]));

  for (const candidate of candidates) {
    const prompt = {
      task: "Analyze a Polymarket paper-trading candidate. Estimate whether the selected outcome thesis should be YES/NO/OUTCOME, assign calibrated probability, and explain edge. Use only supplied market/orderbook data; do not invent external facts.",
      candidate: {
        question: candidate.question,
        outcome: candidate.outcome,
        marketPrice: candidate.marketPrice,
        bestBid: candidate.bestBid,
        bestAsk: candidate.bestAsk,
        spread: candidate.spread,
        slippage: candidate.slippage,
        liquidity: candidate.liquidity,
        volume24hr: candidate.volume24hr,
        daysToResolution: candidate.daysToResolution,
        takerFeeUsdc: candidate.takerFeeUsdc,
        netGainIfWinUsdc: candidate.netGainIfWinUsdc,
        expectedValueUsdc: candidate.expectedValueUsdc,
        annualizedReturn: candidate.annualizedReturn,
        heuristicProbability: candidate.aiProbability,
        rawProbability: candidate.rawProbability,
        tags: candidate.tags,
        riskGroupLabels: candidate.riskGroupLabels,
        currentThesis: candidate.probabilityThesis,
      },
      learningProfile: {
        sampleSize: learningProfile.sampleSize,
        brierScore: learningProfile.brierScore,
        calibrationBias: learningProfile.calibrationBias,
        promptRules: learningProfile.promptRules,
      },
      requiredJson: {
        direction: "YES | NO | OUTCOME",
        probability: "number from 0.01 to 0.995",
        thesis: "one sentence",
        confidenceTier: "near-certain | high | edge-watch | uncertain | long-shot",
        evidence: ["short bullet"],
        counterEvidence: ["short bullet"],
      },
    };
    const result = await callOpenAiJson([
      { role: "system", content: "You are a cautious prediction-market analyst. Return only valid JSON." },
      { role: "user", content: JSON.stringify(prompt) },
    ]);
    if (!result || result.error) {
      byId.set(candidate.id, {
        ...candidate,
        aiAnalysis: {
          ...(candidate.aiAnalysis || {}),
          aiModelError: result?.error || "OpenAI analysis unavailable",
        },
      });
      continue;
    }
    const probability = clamp(Number(result.probability), 0.01, 0.995);
    if (!Number.isFinite(probability)) continue;
    byId.set(candidate.id, refreshEvaluationAfterProbability(candidate, probability, OPENAI_MODEL, {
      direction: result.direction || outcomeKind(candidate.outcome),
      thesis: result.thesis || candidate.probabilityThesis,
      confidenceTier: result.confidenceTier || confidenceTier(probability),
      evidence: Array.isArray(result.evidence) ? result.evidence.slice(0, 6) : [],
      counterEvidence: Array.isArray(result.counterEvidence) ? result.counterEvidence.slice(0, 6) : [],
      source: "openai-initial-analysis",
    }));
  }

  return evaluations.map((item) => byId.get(item.id) || item);
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

function maybeOpenDailyTrade(state, eligible) {
  const today = pragueDateKey();
  const available = Math.max(0, PORTFOLIO_USDC - openRisk(state.trades));
  const stake = PORTFOLIO_USDC * MAX_FRACTION;
  let skippedForRisk = 0;

  if (state.lastTradeDate === today) {
    return { action: "SKIP", reason: "daily paper trade already opened", available };
  }
  if (available < stake) {
    return { action: "SKIP", reason: "not enough free paper capital", available };
  }

  const best = eligible.find((item) => {
    if (alreadyOpen(state.trades, item.tokenId)) return false;
    const block = riskBlock(item, state.trades);
    if (!block) return true;
    skippedForRisk += 1;
    item.selectionStatus = "RISK_BLOCKED";
    item.riskBlockedByTradeId = block.tradeId;
    item.riskBlockedReason = riskBlockReason(block);
    return false;
  });
  if (!best) {
    const reason = skippedForRisk > 0
      ? "no eligible non-correlated candidate"
      : "no eligible non-duplicate candidate";
    return { action: "SKIP", reason, available, skippedForRisk };
  }

  const trade = {
    id: `paper-${today}-${best.tokenId}`,
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
      edge: best.edge,
      expectedValueUsdc: best.expectedValueUsdc,
      annualizedReturn: best.annualizedReturn,
      probabilityThesis: best.probabilityThesis,
      analysisSummary: best.analysisSummary,
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
    thesisType: best.thesisType,
    annualizedReturn: best.annualizedReturn,
    expectedValueUsdc: best.expectedValueUsdc,
    stakeUsdc: Number(stake.toFixed(2)),
    shares: best.executableShares,
    feesEnabled: best.feesEnabled,
    feeType: best.feeType,
    feeRate: best.feeRate,
    takerFeeUsdc: best.takerFeeUsdc,
    totalCostUsdc: best.totalCostUsdc,
    grossGainIfWinUsdc: best.grossGainIfWinUsdc,
    netGainIfWinUsdc: best.netGainIfWinUsdc,
    maxLossUsdc: best.maxLossUsdc,
    currentPrice: best.marketPrice,
    currentValueUsdc: Number(stake.toFixed(2)),
    unrealizedPnlUsdc: 0,
    unrealizedPnlPct: 0,
    marketFills: best.marketFills,
    aiAnalysis: best.aiAnalysis,
    probabilityThesis: best.probabilityThesis,
    analysisModel: best.analysisModel,
    analysisSummary: best.analysisSummary,
  };

  state.trades.unshift(trade);
  state.lastTradeDate = today;
  return { action: "OPENED", reason: "best eligible non-correlated candidate", trade, available: available - stake, skippedForRisk };
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
    model: OPENAI_API_KEY ? "heuristic-fallback-after-ai-error" : "heuristic-postmortem-v1",
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

async function reviewClosedTradesWithAi(trades) {
  const reviewed = [];
  let remaining = AI_POSTMORTEM_LIMIT;

  for (const trade of trades) {
    if (!["WON", "LOST"].includes(String(trade.status || "").toUpperCase()) || trade.postMortem) {
      reviewed.push(trade);
      continue;
    }

    const fallback = deterministicPostMortem(trade);
    if (!OPENAI_API_KEY || remaining <= 0) {
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
    const result = await callOpenAiJson([
      { role: "system", content: "You are a prediction-market calibration reviewer. Return only valid JSON." },
      { role: "user", content: JSON.stringify(prompt) },
    ]);
    if (!result || result.error) {
      reviewed.push({ ...trade, postMortem: { ...fallback, aiModelError: result?.error || "OpenAI post-mortem unavailable" } });
      continue;
    }
    reviewed.push({
      ...trade,
      postMortem: {
        ...fallback,
        model: OPENAI_MODEL,
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
    "Always compute probability against executable market-buy price, not midpoint.",
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
    aiLastRun: OPENAI_API_KEY ? nowIso() : profile.aiLastRun,
    aiModel: OPENAI_API_KEY ? OPENAI_MODEL : profile.aiModel,
  };
}

async function loadMarkets() {
  const url = new URL("https://gamma-api.polymarket.com/markets");
  url.searchParams.set("limit", "60");
  url.searchParams.set("active", "true");
  url.searchParams.set("closed", "false");
  url.searchParams.set("order", "volume24hr");
  url.searchParams.set("ascending", "false");
  return fetchJson(url);
}

function updatePortfolio(state) {
  const realizedPnl = state.trades.reduce((sum, trade) => sum + Number(trade.realizedPnlUsdc || 0), 0);
  const openPnl = state.trades
    .filter((trade) => trade.status === "OPEN")
    .reduce((sum, trade) => sum + Number(trade.unrealizedPnlUsdc || 0), 0);
  const equity = PORTFOLIO_USDC + realizedPnl + openPnl;
  state.portfolio = {
    initialUsdc: PORTFOLIO_USDC,
    maxFraction: MAX_FRACTION,
    maxStakeUsdc: Number((PORTFOLIO_USDC * MAX_FRACTION).toFixed(2)),
    minProbability: MIN_PROBABILITY,
    minAnnualReturn: MIN_ANNUAL_RETURN,
    opportunityMinProbability: OPPORTUNITY_MIN_PROBABILITY,
    opportunityMinEdge: OPPORTUNITY_MIN_EDGE,
    opportunityMinAnnualReturn: OPPORTUNITY_MIN_ANNUAL_RETURN,
    realizedPnlUsdc: Number(realizedPnl.toFixed(4)),
    realizedPnlPct: pnlPercent(realizedPnl, PORTFOLIO_USDC),
    openPnlUsdc: Number(openPnl.toFixed(4)),
    openPnlPct: pnlPercent(openPnl, PORTFOLIO_USDC),
    equityUsdc: Number(equity.toFixed(4)),
    totalPnlUsdc: Number((realizedPnl + openPnl).toFixed(4)),
    totalPnlPct: pnlPercent(realizedPnl + openPnl, PORTFOLIO_USDC),
    openRiskUsdc: Number(openRisk(state.trades).toFixed(2)),
    freeCapitalUsdc: Number(Math.max(0, PORTFOLIO_USDC - openRisk(state.trades)).toFixed(2)),
  };
}

function recordRun(state, { evaluations = [], eligible = [], decision }) {
  const runAt = state.generatedAt;
  state.lastDecision = {
    runAt,
    evaluatedCount: evaluations.length,
    eligibleCount: eligible.length,
    action: decision.action,
    reason: decision.reason,
    tradeId: decision.trade?.id || null,
    riskSkippedCount: decision.skippedForRisk || 0,
    refreshOnly: REFRESH_ONLY,
    learningSampleSize: state.learningProfile.sampleSize,
    brierScore: state.learningProfile.brierScore,
    calibrationBias: state.learningProfile.calibrationBias,
  };
  state.runLog = [
    {
      runAt,
      evaluatedCount: evaluations.length,
      eligibleCount: eligible.length,
      action: decision.action,
      reason: decision.reason,
      riskSkippedCount: decision.skippedForRisk || 0,
      refreshOnly: REFRESH_ONLY,
      learningSampleSize: state.learningProfile.sampleSize,
      brierScore: state.learningProfile.brierScore,
    },
    ...state.runLog,
  ].slice(0, 120);
}

async function writeState(state) {
  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function run() {
  const state = await readState();
  recoverLedgerGaps(state);
  state.trades = await refreshTrades(state.trades);
  state.trades = await reviewClosedTradesWithAi(state.trades);
  state.learningProfile = buildLearningProfile(state.trades, state.learningProfile);
  state.generatedAt = nowIso();
  updatePortfolio(state);

  if (REFRESH_ONLY) {
    recordRun(state, {
      decision: {
        action: "REFRESH",
        reason: "refreshed open positions and resolved markets only",
      },
    });
    await writeState(state);
    console.log(JSON.stringify(state.lastDecision, null, 2));
    return;
  }

  const markets = await loadMarkets();
  let evaluations = [];

  for (const market of markets) {
    const outcomes = parseJsonField(market.outcomes);
    const tokenIds = parseJsonField(market.clobTokenIds);
    const maxOutcomes = Math.min(outcomes.length, tokenIds.length, 2);

    for (let outcomeIndex = 0; outcomeIndex < maxOutcomes; outcomeIndex += 1) {
      if (evaluations.length >= MAX_EVALUATIONS_PER_RUN) break;
      const tokenId = tokenIds[outcomeIndex];
      if (!tokenId) continue;

      try {
        const book = await fetchJson(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(tokenId)}`);
        const evaluation = evaluateCandidate({ market, outcomeIndex, tokenId, book, learningProfile: state.learningProfile });
        if (evaluation) evaluations.push(evaluation);
      } catch (error) {
        evaluations.push({
          id: `${market.id}-${outcomeIndex}-${Date.now()}`,
          evaluatedAt: nowIso(),
          status: "ERROR",
          question: market.question || "",
          outcome: outcomes[outcomeIndex] || `Outcome ${outcomeIndex + 1}`,
          tokenId,
          rejectReasons: [error.message],
          analysisSummary: `Orderbook fetch failed: ${error.message}`,
        });
      }
    }
  }

  evaluations = await enrichEvaluationsWithAi(evaluations, state.learningProfile);
  const eligible = evaluations
    .filter((item) => item.status === "ELIGIBLE")
    .sort((a, b) => {
      if (a.thesisType !== b.thesisType) return a.thesisType === "EDGE_OPPORTUNITY" ? -1 : 1;
      if (b.annualizedReturn !== a.annualizedReturn) return b.annualizedReturn - a.annualizedReturn;
      return b.expectedValueUsdc - a.expectedValueUsdc;
    });
  const decision = maybeOpenDailyTrade(state, eligible);

  state.generatedAt = nowIso();
  updatePortfolio(state);
  state.evaluations = [...evaluations, ...state.evaluations].slice(0, MAX_HISTORY);
  recordRun(state, { evaluations, eligible, decision });
  await writeState(state);
  console.log(JSON.stringify(state.lastDecision, null, 2));
}

run().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
