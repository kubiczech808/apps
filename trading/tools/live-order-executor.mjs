#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const PAPER_STATE_URL = process.env.PAPER_STATE_URL || "https://osobnizkusenosti.cz/trading/api.php?action=state&target=paper";
const LIVE_STATE_URL = process.env.LIVE_STATE_URL || "https://osobnizkusenosti.cz/trading/api.php?action=state&target=live";
const GAMMA_API = process.env.POLYMARKET_GAMMA_API || "https://gamma-api.polymarket.com";
const CLOB_HOST = process.env.POLYMARKET_HOST || "https://clob.polymarket.com";
const CHAIN_ID = Number(process.env.POLYMARKET_CHAIN_ID || 137);
const MIN_PROBABILITY = Number(process.env.LIVE_MIN_PROBABILITY || process.env.PAPER_MIN_PROBABILITY || 0.95);
const MIN_ANNUAL_RETURN = Number(process.env.LIVE_MIN_ANNUAL_RETURN || process.env.PAPER_MIN_ANNUAL_RETURN || 0.05);
const OPPORTUNITY_MIN_PROBABILITY = Number(process.env.LIVE_OPPORTUNITY_MIN_PROBABILITY || process.env.PAPER_OPPORTUNITY_MIN_PROBABILITY || 0.6);
const OPPORTUNITY_MIN_EDGE = Number(process.env.LIVE_OPPORTUNITY_MIN_EDGE || process.env.PAPER_OPPORTUNITY_MIN_EDGE || 0.04);
const OPPORTUNITY_MIN_ANNUAL_RETURN = Number(process.env.LIVE_OPPORTUNITY_MIN_ANNUAL_RETURN || process.env.PAPER_OPPORTUNITY_MIN_ANNUAL_RETURN || 0.3);
const MAX_SPREAD = Number(process.env.LIVE_MAX_SPREAD || process.env.PAPER_MAX_SPREAD || 0.08);
const MIN_VOLUME_24H = Number(process.env.LIVE_MIN_VOLUME_24H || process.env.PAPER_MIN_VOLUME_24H || 100);
const MAX_ORDER_FRACTION = Number(process.env.MAX_ORDER_FRACTION || process.env.LIVE_MAX_ORDER_FRACTION || 0.05);
const MAX_ORDER_NOTIONAL_USDC = Number(process.env.MAX_ORDER_NOTIONAL_USDC || process.env.LIVE_MAX_ORDER_NOTIONAL_USDC || Infinity);
const CANDIDATE_SCAN_LIMIT = Number(process.env.LIVE_CANDIDATE_SCAN_LIMIT || 120);
const ORDER_SIZE_MODE = String(process.env.LIVE_ORDER_SIZE_MODE || "minimum").toLowerCase();
const USE_LIMIT_ORDERS = String(process.env.USE_LIMIT_ORDERS ?? "true").toLowerCase() !== "false";
const POST_ONLY = String(process.env.POLYMARKET_POST_ONLY ?? "true").toLowerCase() !== "false";
const DRY_RUN = String(process.env.POLYMARKET_DRY_RUN ?? "true").toLowerCase() !== "false";
const SIGNATURE_TYPE = Number(process.env.POLYMARKET_SIGNATURE_TYPE || 1);
const DEFAULT_FUNDER = "0x3252de913d9323667f21f4d88fa1f996fc282293";
const FUNDER_ADDRESS = process.env.POLYMARKET_FUNDER_ADDRESS || process.env.POLYMARKET_ADDRESS || DEFAULT_FUNDER;
const EXECUTION_STATE_PATH = process.env.LIVE_EXECUTION_STATE_PATH || "";
const OPEN_STATUSES = new Set(["OPEN", "PENDING_RESOLUTION", "MARKET_NOT_FOUND", "ORDER_STATUS_LIVE", "LIVE"]);

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

function riskProfile({ question, slug, outcome, tags }) {
  const keys = new Set();
  const labels = new Map();
  const addKey = (key, label) => {
    if (!key) return;
    keys.add(key);
    if (label) labels.set(key, label);
  };
  const marketSlug = normalizedSlug(slug);
  if (marketSlug) addKey(`market:${marketSlug}`, `Market: ${marketSlug}`);
  const eventKey = eventSlugKey(slug);
  if (eventKey) addKey(`event:${eventKey}`, `Event: ${eventKey}`);
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

function openLiveRiskItems(liveState) {
  const positions = Array.isArray(liveState?.positions) ? liveState.positions : [];
  const openOrders = Array.isArray(liveState?.openOrders) ? liveState.openOrders : [];
  return [...positions, ...openOrders].filter((item) => {
    const status = String(item.status || item.rawStatus || "OPEN").toUpperCase();
    return OPEN_STATUSES.has(status) || !["WON", "LOST", "CLOSED", "REDEEMED", "CANCELED", "CANCELLED"].includes(status);
  });
}

function riskBlock(candidate, liveState) {
  const candidateKeys = new Set(candidate.riskGroupKeys || []);
  for (const item of openLiveRiskItems(liveState)) {
    if (String(item.tokenId || item.assetId || "") === String(candidate.tokenId || "")) {
      return { reason: "duplicate token already open", overlap: [String(candidate.tokenId)] };
    }
    const itemRisk = riskProfile({
      question: item.question || "",
      slug: item.slug || item.eventSlug || "",
      outcome: item.outcome || "",
      tags: item.tags || tagQuestion(item.question || ""),
    });
    const overlap = itemRisk.keys.filter((key) => candidateKeys.has(key));
    if (overlap.length) return { reason: "correlated live exposure", overlap: overlap.slice(0, 4) };
  }
  return null;
}

function scoreEconomics({ probability, annualizedReturn, edge, spread, volume24hr, liquidity }) {
  const highConfidenceOk = probability >= MIN_PROBABILITY;
  const opportunityOk = probability >= OPPORTUNITY_MIN_PROBABILITY
    && edge >= OPPORTUNITY_MIN_EDGE
    && annualizedReturn >= OPPORTUNITY_MIN_ANNUAL_RETURN;
  const returnOk = annualizedReturn >= MIN_ANNUAL_RETURN;
  const spreadOk = spread != null && spread <= MAX_SPREAD;
  const volumeOk = volume24hr >= MIN_VOLUME_24H || liquidity >= MIN_VOLUME_24H;
  return {
    eligible: (highConfidenceOk || opportunityOk) && returnOk && spreadOk && volumeOk,
    thesisType: highConfidenceOk ? "HIGH_CONFIDENCE" : (opportunityOk ? "EDGE_OPPORTUNITY" : "REJECTED"),
    rejectReasons: [
      highConfidenceOk || opportunityOk ? null : `probability ${(probability * 100).toFixed(1)}% below thresholds`,
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
  const budget = Math.min(maxNotional, cash);
  const minNotional = price * minOrderSize;
  if (minNotional > cash) {
    return {
      size: null,
      budget,
      minNotional,
      minSizeOverride: false,
      sizingNote: `minimum order ${minOrderSize} shares costs ${minNotional.toFixed(4)} USDC, above cash ${cash.toFixed(4)} USDC`,
    };
  }
  if (minNotional > budget) {
    return {
      size: Number(minOrderSize.toFixed(4)),
      budget,
      minNotional,
      minSizeOverride: true,
      sizingNote: `raised to exchange minimum ${minOrderSize} shares because Polymarket minimum exceeds max-per-trade ${budget.toFixed(4)} USDC`,
    };
  }
  if (ORDER_SIZE_MODE === "minimum") {
    return {
      size: Number(minOrderSize.toFixed(4)),
      budget,
      minNotional,
      minSizeOverride: false,
      sizingNote: "exchange minimum order size",
    };
  }
  const size = Math.floor((budget / price) * 10000) / 10000;
  return {
    size: size >= minOrderSize ? Number(size.toFixed(4)) : null,
    budget,
    minNotional,
    minSizeOverride: false,
    sizingNote: size >= minOrderSize ? "sized from max-per-trade budget" : `budget ${budget.toFixed(4)} USDC is below exchange minimum ${minNotional.toFixed(4)} USDC`,
  };
}

async function revalidateEvaluation(evaluation, liveState, cash, maxNotional) {
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
    outcome: outcomes[tokenIndex] || evaluation.outcome,
    tags,
  });
  const block = riskBlock({ ...evaluation, riskGroupKeys: risk.keys }, liveState);
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
  const days = daysToEnd(correctedEndDate(market.question || evaluation.question, market.endDate, market.createdAt || market.updatedAt));
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
    endDate: market.endDate || evaluation.endDate || null,
    currentBestBid: book.bestBid,
    currentBestAsk: book.bestAsk,
    currentSpread: book.spread,
    marketPrice: Number(price.toFixed(4)),
    orderPrice: Number(price.toFixed(4)),
    orderSize: Number(size.toFixed(4)),
    orderNotionalUsdc: notional,
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
  console.log(JSON.stringify(payload, null, 2));
  if (!EXECUTION_STATE_PATH) return;
  await mkdir(dirname(EXECUTION_STATE_PATH), { recursive: true });
  await writeFile(EXECUTION_STATE_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function submitOrder(order) {
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
  if (!privateKey || !FUNDER_ADDRESS) throw new Error("POLYMARKET_PRIVATE_KEY and POLYMARKET_FUNDER_ADDRESS are required");
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
    signatureType: signatureTypeMap[SIGNATURE_TYPE] ?? SignatureTypeV2.POLY_PROXY,
    funderAddress: FUNDER_ADDRESS,
  });
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

async function main() {
  const [paperState, liveState] = await Promise.all([
    loadJsonResource(PAPER_STATE_URL, "paper state"),
    loadJsonResource(LIVE_STATE_URL, "live state"),
  ]);
  const cash = liveCashUsdc(liveState);
  const fractionNotional = cash * MAX_ORDER_FRACTION;
  const maxNotional = Number(Math.min(fractionNotional, MAX_ORDER_NOTIONAL_USDC).toFixed(5));
  const rawEvaluations = Array.isArray(paperState.evaluations) ? paperState.evaluations : [];
  const baseCandidates = latestUniqueEvaluations(rawEvaluations)
    .filter((item) => Number.isFinite(Number(item.aiProbability)))
    .filter((item) => String(item.status || "").toUpperCase() !== "ERROR");

  const checked = [];
  for (const evaluation of baseCandidates) {
    try {
      checked.push(await revalidateEvaluation(evaluation, liveState, cash, maxNotional));
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

  const eligible = checked
    .filter((item) => item.status === "ELIGIBLE")
    .sort((a, b) => {
      if (a.thesisType !== b.thesisType) return a.thesisType === "EDGE_OPPORTUNITY" ? -1 : 1;
      if (b.annualizedReturn !== a.annualizedReturn) return b.annualizedReturn - a.annualizedReturn;
      return b.expectedValueUsdc - a.expectedValueUsdc;
    });

  const best = eligible[0] || null;
  const decision = {
    mode: DRY_RUN || !hasFlag("confirm-live") ? "validated-dry-run" : "live-submit",
    action: best ? (DRY_RUN || !hasFlag("confirm-live") ? "DRY_RUN_READY" : "SUBMIT") : "SKIP",
    reason: best ? "best currently revalidated executable candidate" : "no currently executable candidate after live revalidation",
    generatedAt: new Date().toISOString(),
    account: {
      address: liveState?.account?.address || FUNDER_ADDRESS,
      cashUsdc: cash,
      maxOrderFraction: MAX_ORDER_FRACTION,
      maxOrderNotionalCapUsdc: Number.isFinite(MAX_ORDER_NOTIONAL_USDC) ? MAX_ORDER_NOTIONAL_USDC : null,
      maxNotionalUsdc: maxNotional,
      openPositions: Array.isArray(liveState.positions) ? liveState.positions.length : 0,
      openOrders: Array.isArray(liveState.openOrders) ? liveState.openOrders.length : 0,
    },
    settings: {
      useLimitOrders: USE_LIMIT_ORDERS,
      postOnly: POST_ONLY,
      orderSizeMode: ORDER_SIZE_MODE,
      minProbability: MIN_PROBABILITY,
      minAnnualReturn: MIN_ANNUAL_RETURN,
      maxSpread: MAX_SPREAD,
      minVolume24hr: MIN_VOLUME_24H,
      maxOrderNotionalCapUsdc: Number.isFinite(MAX_ORDER_NOTIONAL_USDC) ? MAX_ORDER_NOTIONAL_USDC : null,
      scannedCandidates: baseCandidates.length,
      revalidatedCandidates: checked.length,
      eligibleCandidates: eligible.length,
    },
    selected: best,
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

  if (!best || DRY_RUN || !hasFlag("confirm-live")) {
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
