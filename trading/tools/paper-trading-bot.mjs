#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const OUTPUT_PATH = process.env.PAPER_STATE_PATH || "data/paper-state.json";
const REMOTE_STATE_URL = process.env.PAPER_STATE_URL || "";
const PORTFOLIO_USDC = Number(process.env.PAPER_PORTFOLIO_USDC || 100);
const MAX_FRACTION = Number(process.env.PAPER_MAX_FRACTION || 0.05);
const MIN_PROBABILITY = Number(process.env.PAPER_MIN_PROBABILITY || 0.95);
const MIN_ANNUAL_RETURN = Number(process.env.PAPER_MIN_ANNUAL_RETURN || 0.05);
const MAX_EVALUATIONS_PER_RUN = Number(process.env.PAPER_MAX_EVALUATIONS_PER_RUN || 80);
const MAX_SPREAD = Number(process.env.PAPER_MAX_SPREAD || 0.08);
const MIN_VOLUME_24H = Number(process.env.PAPER_MIN_VOLUME_24H || 100);
const MAX_HISTORY = Number(process.env.PAPER_MAX_HISTORY || 1200);
const TZ = "Europe/Prague";

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

  if (REMOTE_STATE_URL) {
    try {
      const remote = await fetchJson(`${REMOTE_STATE_URL}?t=${Date.now()}`);
      if (remote && typeof remote === "object" && Array.isArray(remote.trades)) {
        return normalizeState(remote);
      }
    } catch {
      // Fall back to repository state when the public data file does not exist yet.
    }
  }

  try {
    const raw = await readFile(OUTPUT_PATH, "utf8");
    return normalizeState(JSON.parse(raw));
  } catch {
    return normalizeState({});
  }
}

function normalizeState(input) {
  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt || null,
    portfolio: {
      initialUsdc: Number(input.portfolio?.initialUsdc || PORTFOLIO_USDC),
      maxFraction: Number(input.portfolio?.maxFraction || MAX_FRACTION),
      minProbability: Number(input.portfolio?.minProbability || MIN_PROBABILITY),
      minAnnualReturn: Number(input.portfolio?.minAnnualReturn || MIN_ANNUAL_RETURN),
    },
    trades: Array.isArray(input.trades) ? input.trades : [],
    evaluations: Array.isArray(input.evaluations) ? input.evaluations : [],
    lastTradeDate: input.lastTradeDate || null,
    lastDecision: input.lastDecision || null,
    runLog: Array.isArray(input.runLog) ? input.runLog : [],
  };
}

function daysToEnd(endDate) {
  const end = Date.parse(endDate || "");
  if (!Number.isFinite(end)) return null;
  return Math.max(1, (end - Date.now()) / 86400000);
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

function estimateProbability({ market, outcome, ask, bid, spread, liquidity, volume24hr, tags, days }) {
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

  return {
    probability: clamp(probability, 0.01, 0.995),
    notes,
  };
}

function evaluateCandidate({ market, outcomeIndex, tokenId, book }) {
  const question = String(market.question || "");
  const outcomes = parseJsonField(market.outcomes);
  const outcome = String(outcomes[outcomeIndex] || `Outcome ${outcomeIndex + 1}`);
  const { bestBid, bestAsk, spread, askDepth, asks } = bestBook(book);
  const volume24hr = Number(market.volume24hr || 0);
  const liquidity = Number(market.liquidity || 0);
  const tags = tagQuestion(question);
  const days = daysToEnd(market.endDate);
  const stake = PORTFOLIO_USDC * MAX_FRACTION;
  const execution = simulateMarketBuy(asks, stake);

  if (!Number.isFinite(bestAsk) || bestAsk <= 0 || bestAsk >= 1) return null;
  if (!Number.isFinite(execution.avgPrice) || execution.avgPrice <= 0 || execution.avgPrice >= 1) return null;

  const { probability, notes } = estimateProbability({
    market,
    outcome,
    ask: bestAsk,
    bid: bestBid,
    spread,
    liquidity,
    volume24hr,
    tags,
    days,
  });
  const executionPrice = execution.avgPrice;
  const expectedRoi = probability / executionPrice - 1;
  const annualizedReturn = days ? expectedRoi * (365 / days) : expectedRoi;
  const grossRoiIfWin = 1 / executionPrice - 1;
  const grossAnnualizedIfWin = days ? grossRoiIfWin * (365 / days) : grossRoiIfWin;
  const edge = probability - executionPrice;
  const expectedValue = stake * expectedRoi;
  const spreadOk = spread != null && spread <= MAX_SPREAD;
  const volumeOk = volume24hr >= MIN_VOLUME_24H || liquidity >= MIN_VOLUME_24H;
  const probabilityOk = probability >= MIN_PROBABILITY;
  const returnOk = annualizedReturn >= MIN_ANNUAL_RETURN;
  const depthOk = execution.fillable;
  const status = probabilityOk && returnOk && spreadOk && volumeOk && depthOk ? "ELIGIBLE" : "REJECTED";
  const rejectReasons = [
    probabilityOk ? null : `probability ${(probability * 100).toFixed(1)}% below ${(MIN_PROBABILITY * 100).toFixed(0)}%`,
    returnOk ? null : `annualized EV ${(annualizedReturn * 100).toFixed(1)}% below ${(MIN_ANNUAL_RETURN * 100).toFixed(1)}%`,
    spreadOk ? null : `spread ${spread == null ? "n/a" : (spread * 100).toFixed(1) + " pts"} too wide`,
    volumeOk ? null : "liquidity/volume too low",
    depthOk ? null : `insufficient ask depth for ${stake.toFixed(2)} USDC market buy`,
  ].filter(Boolean);

  return {
    id: `${market.id}-${outcomeIndex}-${Date.now()}`,
    evaluatedAt: nowIso(),
    status,
    rejectReasons,
    question,
    slug: market.slug || "",
    outcome,
    tokenId,
    endDate: market.endDate || null,
    tags,
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
    daysToResolution: days == null ? null : Number(days.toFixed(2)),
    aiProbability: Number(probability.toFixed(4)),
    edge: Number(edge.toFixed(4)),
    expectedRoi: Number(expectedRoi.toFixed(4)),
    annualizedReturn: Number(annualizedReturn.toFixed(4)),
    grossAnnualizedIfWin: Number(grossAnnualizedIfWin.toFixed(4)),
    stakeUsdc: Number(stake.toFixed(2)),
    expectedValueUsdc: Number(expectedValue.toFixed(4)),
    maxLossUsdc: Number(stake.toFixed(2)),
    analysisSummary: [
      `Estimated probability ${(probability * 100).toFixed(1)}% vs simulated market-buy entry ${(executionPrice * 100).toFixed(1)}%.`,
      `Best ask ${(bestAsk * 100).toFixed(1)}%, slippage ${execution.slippage == null ? "n/a" : (execution.slippage * 100).toFixed(1) + " pts"} for ${stake.toFixed(2)} USDC.`,
      `Expected annualized return ${(annualizedReturn * 100).toFixed(1)}% with max paper loss ${stake.toFixed(2)} USDC.`,
      notes.length ? notes.join(" ") : "No strong qualitative adjustment found.",
    ].join(" "),
    evidence: [
      `question=${question}`,
      `outcome=${outcome}`,
      `executionMode=MARKET_BUY`,
      `bestAsk=${bestAsk}`,
      `avgExecutionPrice=${executionPrice}`,
      `filledStakeUsdc=${execution.filledUsdc}`,
      `executableDepthUsdc=${execution.depthUsdc}`,
      `bestBid=${bestBid ?? "n/a"}`,
      `spread=${spread ?? "n/a"}`,
      `volume24hr=${volume24hr}`,
      `liquidity=${liquidity}`,
      `daysToResolution=${days ?? "n/a"}`,
    ],
  };
}

function openRisk(trades) {
  return trades
    .filter((trade) => trade.status === "OPEN")
    .reduce((sum, trade) => sum + Number(trade.maxLossUsdc || trade.stakeUsdc || 0), 0);
}

function alreadyOpen(trades, tokenId) {
  return trades.some((trade) => trade.status === "OPEN" && trade.tokenId === tokenId);
}

function maybeOpenDailyTrade(state, eligible) {
  const today = pragueDateKey();
  const available = Math.max(0, PORTFOLIO_USDC - openRisk(state.trades));
  const stake = PORTFOLIO_USDC * MAX_FRACTION;

  if (state.lastTradeDate === today) {
    return { action: "SKIP", reason: "daily paper trade already opened", available };
  }
  if (available < stake) {
    return { action: "SKIP", reason: "not enough free paper capital", available };
  }

  const best = eligible.find((item) => !alreadyOpen(state.trades, item.tokenId));
  if (!best) {
    return { action: "SKIP", reason: "no eligible non-duplicate candidate", available };
  }

  const trade = {
    id: `paper-${today}-${best.tokenId}`,
    openedAt: nowIso(),
    date: today,
    status: "OPEN",
    sourceEvaluationId: best.id,
    question: best.question,
    slug: best.slug,
    outcome: best.outcome,
    tokenId: best.tokenId,
    executionMode: best.executionMode,
    entryPrice: best.marketPrice,
    bestAsk: best.bestAsk,
    slippage: best.slippage,
    aiProbability: best.aiProbability,
    annualizedReturn: best.annualizedReturn,
    expectedValueUsdc: best.expectedValueUsdc,
    stakeUsdc: Number(stake.toFixed(2)),
    shares: best.executableShares,
    maxLossUsdc: Number(stake.toFixed(2)),
    marketFills: best.marketFills,
    analysisSummary: best.analysisSummary,
  };

  state.trades.unshift(trade);
  state.lastTradeDate = today;
  return { action: "OPENED", reason: "best eligible candidate", trade, available: available - stake };
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

async function run() {
  const state = await readState();
  const markets = await loadMarkets();
  const evaluations = [];

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
        const evaluation = evaluateCandidate({ market, outcomeIndex, tokenId, book });
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

  const eligible = evaluations
    .filter((item) => item.status === "ELIGIBLE")
    .sort((a, b) => {
      if (b.annualizedReturn !== a.annualizedReturn) return b.annualizedReturn - a.annualizedReturn;
      return b.expectedValueUsdc - a.expectedValueUsdc;
    });
  const decision = maybeOpenDailyTrade(state, eligible);

  state.generatedAt = nowIso();
  state.portfolio = {
    initialUsdc: PORTFOLIO_USDC,
    maxFraction: MAX_FRACTION,
    maxStakeUsdc: Number((PORTFOLIO_USDC * MAX_FRACTION).toFixed(2)),
    minProbability: MIN_PROBABILITY,
    minAnnualReturn: MIN_ANNUAL_RETURN,
    openRiskUsdc: Number(openRisk(state.trades).toFixed(2)),
    freeCapitalUsdc: Number(Math.max(0, PORTFOLIO_USDC - openRisk(state.trades)).toFixed(2)),
  };
  state.lastDecision = {
    runAt: state.generatedAt,
    evaluatedCount: evaluations.length,
    eligibleCount: eligible.length,
    action: decision.action,
    reason: decision.reason,
    tradeId: decision.trade?.id || null,
  };
  state.evaluations = [...evaluations, ...state.evaluations].slice(0, MAX_HISTORY);
  state.runLog = [
    {
      runAt: state.generatedAt,
      evaluatedCount: evaluations.length,
      eligibleCount: eligible.length,
      action: decision.action,
      reason: decision.reason,
    },
    ...state.runLog,
  ].slice(0, 120);

  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(state.lastDecision, null, 2));
}

run().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
