#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const DATA_API = process.env.POLYMARKET_DATA_API || "https://data-api.polymarket.com";
const GAMMA_API = process.env.POLYMARKET_GAMMA_API || "https://gamma-api.polymarket.com";
const CLOB_HOST = process.env.POLYMARKET_HOST || "https://clob.polymarket.com";
const POLYGON_RPC = process.env.POLYGON_RPC_URL || "https://polygon-bor-rpc.publicnode.com";
const PUSD_TOKEN = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";
const USDCE_TOKEN = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const USDC_TOKEN = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359";
const CHAIN_ID = Number(process.env.POLYMARKET_CHAIN_ID || 137);
const DEFAULT_ADDRESS = "0x3252de913d9323667f21f4d88fa1f996fc282293";
const CONFIGURED_ACCOUNT_ADDRESS = (process.env.POLYMARKET_ADDRESS || DEFAULT_ADDRESS).toLowerCase();
const CONFIGURED_FUNDER_ADDRESS = (process.env.POLYMARKET_FUNDER_ADDRESS || process.env.POLYMARKET_ADDRESS || DEFAULT_ADDRESS).toLowerCase();
const STATE_PATH = process.env.LIVE_STATE_PATH || "data/live-state.json";
const LIVE_STATE_URL = process.env.LIVE_STATE_URL || "";
const ACTIVITY_LIMIT = Number(process.env.LIVE_ACTIVITY_LIMIT || 50);
const TRADE_LIMIT = Number(process.env.LIVE_TRADE_LIMIT || 500);
const SIGNATURE_TYPE = Number(process.env.POLYMARKET_SIGNATURE_TYPE || 1);
let ACCOUNT_ADDRESS = CONFIGURED_ACCOUNT_ADDRESS;
let ACTIVE_FUNDER_ADDRESS = CONFIGURED_FUNDER_ADDRESS;
let ACTIVE_SIGNATURE_TYPE = SIGNATURE_TYPE;
let ACTIVE_SIGNER_ADDRESS = null;
let ACCOUNT_DISCOVERY = null;

function number(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function ratio(value) {
  const numeric = number(value);
  if (numeric == null) return null;
  return Math.abs(numeric) > 2 ? numeric / 100 : numeric;
}

function rawUnitsToUsdc(value) {
  if (value == null || value === "") return null;
  const text = String(value);
  if (text.includes(".")) return number(text);
  try {
    const raw = BigInt(text);
    const whole = raw / 1000000n;
    const fraction = raw % 1000000n;
    return Number(whole) + Number(fraction) / 1000000;
  } catch {
    const numeric = number(value);
    if (numeric == null) return null;
    return numeric > 10000 ? numeric / 1000000 : numeric;
  }
}

function uniqueAddresses(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const address = String(value || "").trim().toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(address) || seen.has(address)) continue;
    seen.add(address);
    result.push(address);
  }
  return result;
}

function uniqueNumbers(values) {
  return [...new Set(values.map((value) => Number(value)).filter(Number.isFinite))];
}

function isoTime(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") {
    const ms = value < 1000000000000 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric) && /^\d+$/.test(String(value))) {
    const ms = numeric < 1000000000000 ? numeric * 1000 : numeric;
    return new Date(ms).toISOString();
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function apiUrl(path, params = {}) {
  const url = new URL(path, DATA_API);
  Object.entries(params).forEach(([key, value]) => {
    if (value != null && value !== "") url.searchParams.set(key, String(value));
  });
  return url;
}

function gammaUrl(path, params = {}) {
  const url = new URL(path, GAMMA_API);
  Object.entries(params).forEach(([key, value]) => {
    if (value != null && value !== "") url.searchParams.set(key, String(value));
  });
  return url;
}

async function fetchJson(path, params = {}) {
  const response = await fetch(apiUrl(path, params), {
    headers: { "User-Agent": "osobnizkusenosti-trading-live-sync" },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${path} HTTP ${response.status}${body ? `: ${body.slice(0, 160)}` : ""}`);
  }
  const payload = await response.json();
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.value)) return payload.value;
  return payload;
}

async function fetchGammaJson(path, params = {}) {
  const response = await fetch(gammaUrl(path, params), {
    headers: { "User-Agent": "osobnizkusenosti-trading-live-sync" },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${path} HTTP ${response.status}${body ? `: ${body.slice(0, 160)}` : ""}`);
  }
  return response.json();
}

async function optionalValue(label, promise, fallback = null, warnings = null) {
  try {
    return await promise;
  } catch (error) {
    if (warnings) warnings.push(`${label}: ${error?.message || String(error)}`);
    return fallback;
  }
}

async function loadPreviousLiveState(sync) {
  if (!LIVE_STATE_URL) return null;
  try {
    const url = new URL(LIVE_STATE_URL);
    url.searchParams.set("_sync", String(Date.now()));
    const response = await fetch(url, {
      headers: { "User-Agent": "osobnizkusenosti-trading-live-sync" },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}${body ? `: ${body.slice(0, 120)}` : ""}`);
    }
    const payload = await response.json();
    return payload && typeof payload === "object" ? payload : null;
  } catch (error) {
    sync.warnings.push(`previous-live-state: ${error?.message || String(error)}`);
    return null;
  }
}

async function erc20Balance(token, holder) {
  const data = `0x70a08231000000000000000000000000${String(holder).toLowerCase().replace(/^0x/, "")}`;
  const response = await fetch(POLYGON_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "osobnizkusenosti-trading-live-sync" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: token, data }, "latest"],
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Polygon RPC HTTP ${response.status}${body ? `: ${body.slice(0, 120)}` : ""}`);
  }
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message || JSON.stringify(payload.error));
  return rawUnitsToUsdc(payload.result);
}

async function loadTokenBalances(address) {
  const [pUsd, usdcE, usdc] = await Promise.all([
    optionalValue("pUSD balance", erc20Balance(PUSD_TOKEN, address), null),
    optionalValue("USDC.e balance", erc20Balance(USDCE_TOKEN, address), null),
    optionalValue("USDC balance", erc20Balance(USDC_TOKEN, address), null),
  ]);
  return {
    pUsd,
    usdcE,
    usdc,
    tokens: {
      pUsd: PUSD_TOKEN,
      usdcE: USDCE_TOKEN,
      usdc: USDC_TOKEN,
    },
  };
}

function normalizeProfile(profile) {
  if (!profile || typeof profile !== "object") {
    return {
      displayName: null,
      pseudonym: null,
      xUsername: null,
      displayUsernamePublic: null,
      verifiedBadge: false,
      profileUrl: `https://polymarket.com/profile/${ACCOUNT_ADDRESS}`,
      source: "gamma-public-profile",
      status: "not_available",
    };
  }
  const pseudonym = profile.pseudonym || null;
  const rawName = profile.displayUsernamePublic === false ? null : (profile.name || null);
  const name = /^0x[a-fA-F0-9]{40}-\d+$/.test(String(rawName || "")) ? null : rawName;
  const xUsername = profile.displayUsernamePublic === false ? null : (profile.xUsername || null);
  return {
    displayName: name || pseudonym || null,
    pseudonym,
    xUsername,
    displayUsernamePublic: profile.displayUsernamePublic ?? null,
    verifiedBadge: Boolean(profile.verifiedBadge),
    profileImage: profile.profileImage || null,
    createdAt: isoTime(profile.createdAt),
    userIds: Array.isArray(profile.users) ? profile.users.map((user) => String(user.id)).filter(Boolean) : [],
    profileUrl: `https://polymarket.com/profile/${profile.proxyWallet || ACCOUNT_ADDRESS}`,
    source: "gamma-public-profile",
    status: "ok",
  };
}

function positionUrl(position) {
  const slug = String(position.eventSlug || position.slug || "").trim();
  return /^[a-z0-9-]+$/i.test(slug) ? `https://polymarket.com/event/${slug}` : "https://polymarket.com/";
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
  const raw = isoTime(rawEndDate);
  const inferred = inferredEndDateFromQuestion(question, raw || fallbackDate);
  if (!inferred) return { endDate: raw, source: raw ? "positions-api" : "unknown", rawEndDate: raw };
  const rawTime = Date.parse(raw || "");
  const inferredTime = Date.parse(inferred);
  if (!Number.isFinite(rawTime) || inferredTime > rawTime) {
    return { endDate: inferred, source: raw ? "question-corrected" : "question-inferred", rawEndDate: raw };
  }
  return { endDate: raw || inferred, source: raw ? "positions-api" : "question-inferred", rawEndDate: raw };
}

function normalizePosition(position, generatedAt) {
  const size = number(position.size ?? position.balance ?? position.quantity, 0);
  const question = position.title || position.question || position.market || "-";
  const avgPrice = number(position.avgPrice ?? position.averagePrice ?? position.entryPrice);
  const currentPrice = number(position.curPrice ?? position.currentPrice ?? position.price);
  const initialValue = number(position.initialValue ?? position.totalBought ?? (avgPrice != null ? avgPrice * size : null), 0);
  const currentValue = number(position.currentValue ?? position.value ?? (currentPrice != null ? currentPrice * size : null), 0);
  const cashPnl = number(position.cashPnl ?? position.pnl ?? position.unrealizedPnl ?? (currentValue - initialValue), 0);
  const pnlPct = ratio(position.percentPnl ?? position.pnlPercent ?? (initialValue > 0 ? cashPnl / initialValue : null));
  const realizedPnl = number(position.realizedPnl ?? position.cashPnlRealized, 0);
  const rawEndDate = isoTime(position.endDate ?? position.endDateIso ?? position.resolutionDate);
  const endDateCorrection = correctedEndDate(question, rawEndDate, position.createdAt ?? position.timestamp ?? generatedAt);
  const endDate = endDateCorrection.endDate;
  const redeemable = Boolean(position.redeemable ?? position.claimable ?? position.canRedeem ?? position.conditionRedeemable ?? false);
  const resolved = Boolean(position.resolved ?? position.isResolved ?? position.closed ?? false);
  const claimable = Boolean(position.claimable ?? position.canRedeem ?? false);
  const resolvedAt = isoTime(position.resolvedAt ?? position.closedAt ?? position.closedTime ?? position.redeemedAt);

  const openedAt = isoTime(position.createdAt ?? position.timestamp);
  const pendingResolution = !redeemable && !resolved && endDate && Date.parse(endDate) <= Date.now();

  return {
    id: String(position.asset ?? position.tokenId ?? position.conditionId ?? `${position.slug || position.title || "position"}-${position.outcome || ""}`),
    mode: "LIVE",
    status: pendingResolution ? "PENDING_RESOLUTION" : "OPEN",
    question,
    outcome: position.outcome || position.side || "-",
    slug: position.slug || position.eventSlug || "",
    eventSlug: position.eventSlug || position.slug || "",
    url: positionUrl(position),
    tokenId: position.asset || position.tokenId || null,
    conditionId: position.conditionId || null,
    date: openedAt,
    openedAt,
    openedAtSource: openedAt ? "positions-api" : "unknown",
    endDate,
    rawEndDate,
    endDateSource: endDateCorrection.source,
    resolvedAt,
    entryPrice: avgPrice,
    currentPrice,
    shares: size,
    stakeUsdc: initialValue,
    totalCostUsdc: initialValue,
    currentValueUsdc: currentValue,
    netGainIfWinUsdc: size > 0 ? size - initialValue : null,
    unrealizedPnlUsdc: cashPnl,
    unrealizedPnlPct: pnlPct,
    realizedPnlUsdc: realizedPnl,
    realizedPnlPct: ratio(position.percentRealizedPnl),
    redeemable,
    resolved,
    claimable,
    officialResolutionStatus: resolved || redeemable || claimable ? "polymarket-resolved-or-redeemable" : (pendingResolution ? "pending-polymarket-resolution" : "open"),
    size,
  };
}

function normalizeActivity(item) {
  const slug = item.eventSlug || item.slug || "";
  const url = /^[a-z0-9-]+$/i.test(String(slug)) ? `https://polymarket.com/event/${slug}` : "https://polymarket.com/";
  return {
    id: String(item.transactionHash || item.proxyWallet || item.timestamp || Math.random()),
    timestamp: isoTime(item.timestamp ?? item.createdAt ?? item.updatedAt),
    type: item.type || item.activityType || "-",
    side: item.side || item.action || "",
    question: item.title || item.question || item.market || "-",
    outcome: item.outcome || "",
    slug,
    url,
    tokenId: item.asset || item.tokenId || null,
    conditionId: item.conditionId || null,
    price: number(item.price),
    size: number(item.size ?? item.shares),
    usdcValue: number(item.usdcSize ?? item.value ?? item.amount),
    transactionHash: item.transactionHash || item.txHash || "",
  };
}

function normalizeTradeHistoryItem(item) {
  const slug = item.eventSlug || item.slug || "";
  const url = /^[a-z0-9-]+$/i.test(String(slug)) ? `https://polymarket.com/event/${slug}` : "https://polymarket.com/";
  const size = number(item.size ?? item.shares ?? item.amount, 0);
  const price = number(item.price ?? item.avgPrice);
  const timestamp = isoTime(item.timestamp ?? item.createdAt ?? item.updatedAt);
  const side = String(item.side || item.type || item.action || "").toUpperCase();
  const notional = number(item.usdcSize ?? item.value ?? item.amountUsdc ?? (price != null ? price * size : null), 0);

  return {
    id: String(item.transactionHash || item.tradeId || item.id || `${item.asset || item.tokenId || item.conditionId || slug}-${timestamp || ""}-${side}`),
    timestamp,
    side,
    question: item.title || item.question || item.market || "-",
    outcome: item.outcome || item.name || "",
    slug,
    eventSlug: item.eventSlug || item.slug || "",
    url,
    tokenId: item.asset || item.tokenId || null,
    conditionId: item.conditionId || null,
    price,
    size,
    usdcValue: notional,
    transactionHash: item.transactionHash || item.txHash || "",
  };
}

function normalizeOpenOrder(order) {
  const size = number(order.originalSize ?? order.original_size ?? order.size ?? order.orderSize ?? order.order_size, 0);
  const matched = number(order.sizeMatched ?? order.size_matched ?? order.matchedSize ?? order.matched_size, 0);
  const remaining = Math.max(0, size - matched);
  const price = number(order.price);
  const tokenId = order.assetId || order.asset_id || order.tokenID || order.tokenId || null;
  return {
    id: String(order.id || order.orderID || order.orderId || `${tokenId || "order"}-${price || ""}`),
    status: order.status || order.orderStatus || "ORDER_STATUS_LIVE",
    side: order.side || "",
    tokenId,
    assetId: tokenId,
    market: order.market || order.conditionId || null,
    outcome: order.outcome || "",
    price,
    originalSize: size,
    sizeMatched: matched,
    remainingSize: remaining,
    notionalUsdc: price != null ? price * remaining : null,
    createdAt: isoTime(order.createdAt ?? order.created_at ?? order.insertTime ?? order.createTime),
    rawStatus: order.status || null,
  };
}

function isActiveOpenOrder(order) {
  const status = String(order.status || order.rawStatus || "").toUpperCase();
  const closedStatuses = new Set([
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
  if (closedStatuses.has(status)) return false;
  const remaining = number(order.remainingSize, 0);
  return remaining > 0.000001;
}

function closedTradesFromHistory(trades, activity, generatedAt) {
  const groups = new Map();
  const groupsByQuestion = new Map();
  const seenTradeKeys = new Set();

  function questionKey(item) {
    return String(item.question || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function groupKey(item) {
    return String(item.tokenId || `${item.conditionId || item.slug || item.question}:${item.outcome || ""}`);
  }

  function tradeIdentity(item) {
    return [
      item.transactionHash || "",
      item.tokenId || item.conditionId || "",
      String(item.side || "").toUpperCase(),
      item.timestamp || "",
    ].join(":");
  }

  function indexGroup(group) {
    const key = questionKey(group);
    if (!key) return;
    if (!groupsByQuestion.has(key)) groupsByQuestion.set(key, []);
    const list = groupsByQuestion.get(key);
    if (!list.includes(group)) list.push(group);
  }

  function bestRedeemGroup(item) {
    const direct = groups.get(groupKey(item));
    if (direct) return direct;
    const candidates = groupsByQuestion.get(questionKey(item)) || [];
    if (!candidates.length) return null;
    const redeemSize = number(item.size, 0);
    return [...candidates]
      .filter((group) => group.buyCost > 0 && group.status !== "REDEEMED")
      .sort((a, b) => {
        const aSizeDelta = Math.abs(number(a.sharesBought, 0) - redeemSize);
        const bSizeDelta = Math.abs(number(b.sharesBought, 0) - redeemSize);
        if (aSizeDelta !== bSizeDelta) return aSizeDelta - bSizeDelta;
        return (Date.parse(b.openedAt || "") || 0) - (Date.parse(a.openedAt || "") || 0);
      })[0] || candidates[0];
  }

  function ingestTrade(trade) {
    const identity = tradeIdentity(trade);
    if (seenTradeKeys.has(identity)) return;
    seenTradeKeys.add(identity);
    const key = groupKey(trade);
    if (!key || key === "null") return;
    if (!groups.has(key)) {
      groups.set(key, {
        id: key,
        mode: "LIVE",
        status: "CLOSED",
        question: trade.question,
        outcome: trade.outcome || trade.side || "-",
        slug: trade.slug,
        eventSlug: trade.eventSlug,
        url: trade.url,
        tokenId: trade.tokenId,
        conditionId: trade.conditionId,
        openedAt: trade.timestamp,
        resolvedAt: trade.timestamp,
        entryPrice: null,
        currentPrice: null,
        sharesBought: 0,
        sharesSold: 0,
        buyCost: 0,
        sellProceeds: 0,
        latestPrice: null,
      });
      indexGroup(groups.get(key));
    }
    const group = groups.get(key);
    const size = number(trade.size, 0);
    const value = number(trade.usdcValue, 0);
    const side = String(trade.side || "").toUpperCase();
    if (!group.openedAt || Date.parse(trade.timestamp || "") < Date.parse(group.openedAt || "")) group.openedAt = trade.timestamp;
    if (!group.resolvedAt || Date.parse(trade.timestamp || "") > Date.parse(group.resolvedAt || "")) group.resolvedAt = trade.timestamp;
    if (number(trade.price) != null) group.latestPrice = number(trade.price);
    if (side.includes("BUY")) {
      group.sharesBought += size;
      group.buyCost += value;
    } else if (side.includes("SELL")) {
      group.sharesSold += size;
      group.sellProceeds += value;
      group.closedAtSource = "sell-trade-history";
    }
  }

  for (const trade of trades) {
    ingestTrade(trade);
  }

  for (const item of activity) {
    const type = String(item.type || "").toUpperCase();
    if (!type.includes("TRADE")) continue;
    ingestTrade(item);
  }

  for (const item of activity) {
    const type = String(item.type || "").toUpperCase();
    if (!type.includes("REDEEM")) continue;
    const group = bestRedeemGroup(item);
    if (!group) continue;
    group.sellProceeds += number(item.usdcValue, 0);
    group.redeemedShares = number(group.redeemedShares, 0) + number(item.size, 0);
    if (!group.resolvedAt || Date.parse(item.timestamp || "") > Date.parse(group.resolvedAt || "")) group.resolvedAt = item.timestamp;
    group.status = "REDEEMED";
    group.closedAtSource = "redeem-activity";
  }

  return [...groups.values()]
    .filter((group) => group.buyCost > 0 && (Math.abs(group.sharesBought - group.sharesSold) < 0.000001 || group.status === "REDEEMED"))
    .map((group) => {
      const realizedPnl = group.sellProceeds - group.buyCost;
      const realizedPct = group.buyCost > 0 ? realizedPnl / group.buyCost : null;
      const entryPrice = group.sharesBought > 0 ? group.buyCost / group.sharesBought : null;
      const exitPrice = group.sharesSold > 0
        ? group.sellProceeds / group.sharesSold
        : (group.sharesBought > 0 && group.status === "REDEEMED" ? group.sellProceeds / group.sharesBought : group.latestPrice);
      const closedAt = group.resolvedAt || generatedAt;
      return {
        id: group.id,
        mode: "LIVE",
        status: group.status,
        question: group.question || "-",
        outcome: group.outcome || "-",
        slug: group.slug || group.eventSlug || "",
        eventSlug: group.eventSlug || group.slug || "",
        url: group.url,
        tokenId: group.tokenId,
        conditionId: group.conditionId,
        date: group.openedAt || generatedAt,
        openedAt: group.openedAt || generatedAt,
        resolvedAt: closedAt,
        closedAt,
        closedAtSource: group.closedAtSource || "trade-history-close",
        endDate: closedAt,
        entryPrice,
        exitPrice,
        currentPrice: exitPrice,
        finalOutcomePrice: exitPrice,
        shares: group.sharesBought,
        redeemedShares: number(group.redeemedShares),
        stakeUsdc: group.buyCost,
        totalCostUsdc: group.buyCost,
        exitValueUsdc: group.sellProceeds,
        netGainIfWinUsdc: group.sharesBought - group.buyCost,
        realizedPnlUsdc: realizedPnl,
        realizedPnlPct: realizedPct,
        realizedPct,
        unrealizedPnlUsdc: 0,
        unrealizedPnlPct: 0,
        analysisSummary: "Derived from public Polymarket trade history; realized P/L is estimated from buys, sells and redemption-like activity where available.",
      };
    });
}

function compactText(value, fallback = "-") {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text || fallback;
}

function normalizedKeyText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function liveItemKeys(item) {
  const tokenId = String(item.tokenId || item.assetId || item.asset || "").trim();
  const conditionId = String(item.conditionId || item.market || "").trim();
  const outcome = normalizedKeyText(item.outcome || item.side);
  const question = normalizedKeyText(item.question || item.title || item.market);
  const keys = new Set();
  if (tokenId) keys.add(`token:${tokenId}`);
  if (conditionId && outcome) keys.add(`condition:${conditionId}:${outcome}`);
  if (question && outcome) keys.add(`question:${question}:${outcome}`);
  return keys;
}

function anySharedKey(item, knownKeys) {
  return [...liveItemKeys(item)].some((key) => knownKeys.has(key));
}

function timestampMs(value) {
  const timestamp = Date.parse(isoTime(value) || "");
  return Number.isFinite(timestamp) ? timestamp : null;
}

function isSameTimestamp(a, b, toleranceMs = 2000) {
  const left = timestampMs(a);
  const right = timestampMs(b);
  return left != null && right != null && Math.abs(left - right) <= toleranceMs;
}

function addTimestampToKeyIndex(index, item, value, mode = "earliest", source = "unknown") {
  const timestamp = isoTime(value);
  if (!timestamp) return;
  for (const key of liveItemKeys(item)) {
    const existing = index.get(key);
    const shouldReplace = !existing
      || (mode === "latest"
        ? Date.parse(timestamp) > Date.parse(existing.timestamp)
        : Date.parse(timestamp) < Date.parse(existing.timestamp));
    if (shouldReplace) index.set(key, { timestamp, source });
  }
}

function bestIndexedTimestamp(index, item, mode = "earliest") {
  const candidates = [...liveItemKeys(item)]
    .map((key) => index.get(key))
    .filter(Boolean)
    .sort((a, b) => {
      const diff = Date.parse(a.timestamp) - Date.parse(b.timestamp);
      return mode === "latest" ? -diff : diff;
    });
  return candidates[0] || null;
}

function enrichOpenTimesFromHistory(positions, historyItems, previousState = null) {
  const historyByKey = new Map();
  const previousByKey = new Map();

  for (const item of historyItems) {
    const side = String(item.side || item.type || "").toUpperCase();
    if (side && !side.includes("BUY") && !side.includes("TRADE")) continue;
    addTimestampToKeyIndex(historyByKey, item, item.timestamp || item.createdAt || item.openedAt || item.date, "earliest", "trade-history");
  }

  const previousRows = [
    ...(Array.isArray(previousState?.positions) ? previousState.positions : []),
    ...(Array.isArray(previousState?.openOrders) ? previousState.openOrders : []),
  ];
  for (const item of previousRows) {
    const source = String(item.openedAtSource || "").toLowerCase();
    if (source === "sync-generated-fallback") continue;
    addTimestampToKeyIndex(previousByKey, item, item.openedAt || item.date || item.createdAt, "earliest", "previous-live-state");
  }

  return positions.map((position) => {
    const currentTime = isoTime(position.openedAt || position.date);
    const candidates = [
      bestIndexedTimestamp(historyByKey, position, "earliest"),
      bestIndexedTimestamp(previousByKey, position, "earliest"),
      currentTime ? { timestamp: currentTime, source: position.openedAtSource || "positions-api" } : null,
    ].filter(Boolean).sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    const best = candidates[0] || null;
    if (!best) return position;
    return {
      ...position,
      date: best.timestamp,
      openedAt: best.timestamp,
      openedAtSource: best.source,
    };
  });
}

function buildCloseTimeIndex(historyItems) {
  const index = new Map();
  for (const item of historyItems) {
    const side = String(item.side || "").toUpperCase();
    const type = String(item.type || "").toUpperCase();
    const isClose = side.includes("SELL")
      || type.includes("SELL")
      || type.includes("REDEEM")
      || type.includes("CLAIM")
      || type.includes("RESOLVE");
    if (!isClose) continue;
    addTimestampToKeyIndex(index, item, item.timestamp || item.closedAt || item.resolvedAt || item.date, "latest", "trade-history-close");
  }
  return index;
}

function buildPreviousCloseTimeIndex(previousState) {
  const index = new Map();
  const previousGeneratedAt = previousState?.generatedAt || null;
  const previousRows = [
    ...(Array.isArray(previousState?.closedTrades) ? previousState.closedTrades : []),
    ...(Array.isArray(previousState?.resolvedApiPositions) ? previousState.resolvedApiPositions : []),
  ];
  for (const item of previousRows) {
    const value = item.closedAt || item.resolvedAt || item.closedTime || item.endDate;
    if (!value || isSameTimestamp(value, previousGeneratedAt)) continue;
    addTimestampToKeyIndex(index, item, value, "latest", "previous-live-state-close");
  }
  return index;
}

function adjustedResolutionEndDate(position) {
  const endDate = isoTime(position.endDate);
  if (!endDate) return null;
  let endMs = Date.parse(endDate);
  const openedMs = timestampMs(position.openedAt || position.date);
  const looksDateOnly = /T00:00:00\.000Z$/.test(endDate);
  if (looksDateOnly && openedMs != null && endMs < openedMs) {
    endMs += (24 * 60 * 60 * 1000) - 1;
  }
  if (openedMs != null && endMs < openedMs) return null;
  return new Date(endMs).toISOString();
}

function stableCloseTimestamp(value, generatedAt) {
  const timestamp = isoTime(value);
  if (!timestamp) return null;
  const syncMs = timestampMs(generatedAt);
  const timestampValue = Date.parse(timestamp);
  if (syncMs != null && Number.isFinite(timestampValue) && timestampValue > syncMs + 60000) return null;
  return timestamp;
}

function resolvedPositionCloseTime(position, closeTimeIndex, previousCloseTimeIndex, generatedAt) {
  const explicit = isoTime(position.resolvedAt || position.closedAt || position.closedTime || position.redeemedAt);
  const stableExplicit = stableCloseTimestamp(explicit, generatedAt);
  if (stableExplicit) return { timestamp: stableExplicit, source: "positions-api-resolved" };
  const closeFromHistory = bestIndexedTimestamp(closeTimeIndex, position, "latest");
  if (stableCloseTimestamp(closeFromHistory?.timestamp, generatedAt)) return closeFromHistory;
  const closeFromPrevious = bestIndexedTimestamp(previousCloseTimeIndex, position, "latest");
  if (stableCloseTimestamp(closeFromPrevious?.timestamp, generatedAt)) return closeFromPrevious;
  const endDate = adjustedResolutionEndDate(position);
  const stableEndDate = stableCloseTimestamp(endDate, generatedAt);
  if (stableEndDate) return { timestamp: stableEndDate, source: "event-end-date" };
  if (positionOfficiallyResolved(position)) return { timestamp: generatedAt, source: "redeem-required-detected" };
  return null;
}

function redeemAlertId(prefix, item) {
  const marketKey = compactText(item.tokenId || item.conditionId || item.slug || item.question, "market").toLowerCase();
  const outcome = compactText(item.outcome, "outcome").toLowerCase();
  return `${prefix}:${marketKey}:${outcome}`;
}

function positionOfficiallyResolved(position) {
  return Boolean(position.redeemable || position.claimable || position.resolved);
}

function positionLooksResolved(position) {
  return positionOfficiallyResolved(position);
}

function closedRowsFromResolvedPositions(positions, knownClosedKeys, generatedAt, historyItems = [], previousState = null) {
  const closeTimeIndex = buildCloseTimeIndex(historyItems);
  const previousCloseTimeIndex = buildPreviousCloseTimeIndex(previousState);
  return positions
    .filter((position) => positionLooksResolved(position) && !anySharedKey(position, knownClosedKeys))
    .map((position) => {
      const currentValue = number(position.currentValueUsdc, 0);
      const stake = number(position.totalCostUsdc || position.stakeUsdc, 0);
      const currentPrice = number(position.currentPrice);
      const winningResolved = currentValue > 0.000001 || (currentPrice != null && currentPrice >= 0.995);
      const realizedPnl = currentValue - stake;
      const status = winningResolved ? "REDEEM_REQUIRED" : "LOST";
      const closeTime = resolvedPositionCloseTime(position, closeTimeIndex, previousCloseTimeIndex, generatedAt);
      const officialClosedAt = closeTime?.timestamp || null;
      return {
        ...position,
        id: `resolved-position-${position.id}`,
        status,
        resolvedAt: officialClosedAt,
        closedAt: officialClosedAt,
        closedAtSource: closeTime?.source || "unknown",
        exitPrice: currentPrice,
        finalOutcomePrice: currentPrice,
        exitValueUsdc: currentValue,
        realizedPnlUsdc: realizedPnl,
        realizedPnlPct: stake > 0 ? realizedPnl / stake : null,
        unrealizedPnlUsdc: 0,
        unrealizedPnlPct: 0,
        analysisSummary: [
          position.analysisSummary || "",
          status === "LOST"
            ? "Polymarket exposes this resolved position with zero value, so it is classified as a settled losing position rather than a redeem-needed winner."
            : "Polymarket exposes this position as redeemable/claimable/resolved, so it is classified outside opened trades until redeem is completed.",
          !officialClosedAt ? "No stable Polymarket resolution timestamp was available; closed time is intentionally left blank instead of using the sync time." : "",
        ].filter(Boolean).join(" "),
      };
    });
}

function livePortfolioPositionUrl(position) {
  const reference = compactText(position.tokenId || position.conditionId || position.slug || position.id, "position");
  const query = reference ? `?position=${encodeURIComponent(reference)}` : "";
  return `https://www.osobnizkusenosti.cz/trading/portfolios/closed/${query}`;
}

function redeemNotifications(positions, previousState, generatedAt) {
  const previousNotifications = previousState?.notifications && typeof previousState.notifications === "object"
    ? previousState.notifications
    : {};
  const sentKeys = new Set(Array.isArray(previousNotifications.sentRedeemAlertKeys)
    ? previousNotifications.sentRedeemAlertKeys.map(String)
    : []);
  const previousAlertsByKey = new Map((Array.isArray(previousNotifications.redeemAlerts)
    ? previousNotifications.redeemAlerts
    : [])
    .filter((alert) => alert && alert.key)
    .map((alert) => [String(alert.key), alert]));
  const alerts = [];

  function addAlert(alert) {
    if (!alert.key || alerts.some((item) => item.key === alert.key)) return;
    const previous = previousAlertsByKey.get(String(alert.key)) || {};
    const sentAt = previous.sentAt || null;
    const sent = Boolean(sentAt && (previous.sent || sentKeys.has(alert.key)));
    alerts.push({
      ...previous,
      ...alert,
      firstDetectedAt: previous.firstDetectedAt || previous.detectedAt || alert.detectedAt,
      sent,
      sentAt,
      emailAttempts: Array.isArray(previous.emailAttempts) ? previous.emailAttempts : [],
    });
  }

  for (const position of positions) {
    const currentPrice = number(position.currentPrice);
    const currentValue = number(position.currentValueUsdc, 0);
    const redeemable = positionOfficiallyResolved(position)
      || String(position.status || "").toUpperCase() === "REDEEM_REQUIRED";
    if (!redeemable) continue;
    addAlert({
      key: redeemAlertId("redeem-required", position),
      type: "REDEEM_REQUIRED",
      title: "Winning Polymarket position may need redeem",
      message: "Pozice vypada jako vyherne vyhodnocena. Pokud Polymarket neumozni automaticky redeem, otevri ji a proved redeem manualne.",
      question: position.question,
      outcome: position.outcome,
      url: position.url,
      portfolioUrl: livePortfolioPositionUrl(position),
      tokenId: position.tokenId,
      conditionId: position.conditionId,
      openedAt: position.openedAt,
      detectedAt: generatedAt,
      currentPrice,
      currentValueUsdc: currentValue,
      stakeUsdc: number(position.stakeUsdc),
      unrealizedPnlUsdc: number(position.unrealizedPnlUsdc),
      reason: "Polymarket position is marked redeemable/claimable/resolved",
    });
  }

  return {
    emailRecipient: "jakub.elias88@gmail.com",
    generatedAt,
    sentRedeemAlertKeys: alerts.filter((alert) => alert.sent && alert.sentAt).map((alert) => alert.key),
    redeemAlerts: alerts,
    unsentRedeemAlerts: alerts.filter((alert) => !alert.sent),
  };
}

function ledgerReconciliationFallbacks(trades, activity, positions, closedTrades, openOrders, generatedAt) {
  const groups = new Map();
  const groupsByQuestion = new Map();
  const seenTradeKeys = new Set();

  function questionKey(item) {
    return String(item.question || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function groupKey(item) {
    return String(item.tokenId || `${item.conditionId || item.slug || item.question}:${item.outcome || ""}`);
  }

  function tradeIdentity(item) {
    return [
      item.transactionHash || item.id || "",
      item.tokenId || item.conditionId || item.slug || "",
      String(item.side || "").toUpperCase(),
      item.timestamp || "",
    ].join(":");
  }

  function addKnownKeys(set, item) {
    const tokenId = String(item.tokenId || item.assetId || item.asset || "").trim();
    const conditionId = String(item.conditionId || item.market || "").trim();
    const outcome = String(item.outcome || item.side || "").trim().toLowerCase();
    const question = questionKey(item);
    if (tokenId) set.add(`token:${tokenId}`);
    if (conditionId && outcome) set.add(`condition:${conditionId}:${outcome}`);
    if (conditionId && !outcome) set.add(`condition:${conditionId}`);
    if (question && outcome) set.add(`question:${question}:${outcome}`);
  }

  function itemKeys(item) {
    const keys = new Set();
    addKnownKeys(keys, item);
    return keys;
  }

  function isKnown(group, knownKeys) {
    const keys = itemKeys(group);
    return [...keys].some((key) => knownKeys.has(key));
  }

  function indexGroup(group) {
    const key = questionKey(group);
    if (!key) return;
    if (!groupsByQuestion.has(key)) groupsByQuestion.set(key, []);
    const list = groupsByQuestion.get(key);
    if (!list.includes(group)) list.push(group);
  }

  function ensureGroup(item) {
    const key = groupKey(item);
    if (!key || key === "null") return null;
    if (!groups.has(key)) {
      groups.set(key, {
        id: key,
        question: item.question,
        outcome: item.outcome || item.side || "-",
        slug: item.slug,
        eventSlug: item.eventSlug || item.slug || "",
        url: item.url,
        tokenId: item.tokenId,
        conditionId: item.conditionId,
        openedAt: item.timestamp,
        lastActivityAt: item.timestamp,
        sharesBought: 0,
        sharesSold: 0,
        redeemedShares: 0,
        buyCost: 0,
        sellProceeds: 0,
        latestPrice: null,
      });
      indexGroup(groups.get(key));
    }
    return groups.get(key);
  }

  function ingestTrade(item) {
    const identity = tradeIdentity(item);
    if (seenTradeKeys.has(identity)) return;
    seenTradeKeys.add(identity);
    const group = ensureGroup(item);
    if (!group) return;
    const timestamp = Date.parse(item.timestamp || "") || 0;
    if (!group.openedAt || timestamp < (Date.parse(group.openedAt || "") || Infinity)) group.openedAt = item.timestamp;
    if (!group.lastActivityAt || timestamp > (Date.parse(group.lastActivityAt || "") || 0)) group.lastActivityAt = item.timestamp;
    if (number(item.price) != null) group.latestPrice = number(item.price);

    const size = number(item.size, 0);
    const value = number(item.usdcValue, 0);
    const side = String(item.side || "").toUpperCase();
    if (side.includes("BUY")) {
      group.sharesBought += size;
      group.buyCost += value;
    } else if (side.includes("SELL")) {
      group.sharesSold += size;
      group.sellProceeds += value;
    }
  }

  function bestRedeemGroup(item) {
    const direct = groups.get(groupKey(item));
    if (direct) return direct;
    const candidates = groupsByQuestion.get(questionKey(item)) || [];
    if (!candidates.length) return null;
    const redeemSize = number(item.size, 0);
    return [...candidates]
      .sort((a, b) => {
        const aSizeDelta = Math.abs(number(a.sharesBought, 0) - redeemSize);
        const bSizeDelta = Math.abs(number(b.sharesBought, 0) - redeemSize);
        if (aSizeDelta !== bSizeDelta) return aSizeDelta - bSizeDelta;
        return (Date.parse(b.openedAt || "") || 0) - (Date.parse(a.openedAt || "") || 0);
      })[0] || null;
  }

  for (const trade of trades) ingestTrade(trade);
  for (const item of activity) {
    if (String(item.type || "").toUpperCase().includes("TRADE")) ingestTrade(item);
  }
  for (const item of activity) {
    if (!String(item.type || "").toUpperCase().includes("REDEEM")) continue;
    const group = bestRedeemGroup(item);
    if (!group) continue;
    group.redeemedShares += number(item.size, 0);
    group.sellProceeds += number(item.usdcValue, 0);
    group.lastActivityAt = item.timestamp || group.lastActivityAt;
  }

  const knownKeys = new Set();
  for (const item of [...positions, ...closedTrades, ...openOrders]) addKnownKeys(knownKeys, item);

  const orphanedTrades = [...groups.values()]
    .filter((group) => {
      const netShares = number(group.sharesBought, 0) - number(group.sharesSold, 0) - number(group.redeemedShares, 0);
      const netCost = number(group.buyCost, 0) - number(group.sellProceeds, 0);
      return netShares > 0.000001 && netCost > 0.000001 && !isKnown(group, knownKeys);
    })
    .map((group) => {
      const netShares = number(group.sharesBought, 0) - number(group.sharesSold, 0) - number(group.redeemedShares, 0);
      const netCost = Math.max(0, number(group.buyCost, 0) - number(group.sellProceeds, 0));
      const entryPrice = netShares > 0 ? netCost / netShares : null;
      return {
        id: `ledger-gap-${group.id}`,
        mode: "LIVE_RECONCILIATION",
        status: "SYNC GAP",
        question: group.question || "-",
        outcome: group.outcome || "-",
        slug: group.slug || group.eventSlug || "",
        eventSlug: group.eventSlug || group.slug || "",
        url: group.url,
        tokenId: group.tokenId,
        conditionId: group.conditionId,
        date: group.openedAt || generatedAt,
        openedAt: group.openedAt || generatedAt,
        lastActivityAt: group.lastActivityAt || generatedAt,
        endDate: null,
        entryPrice,
        currentPrice: group.latestPrice,
        shares: netShares,
        stakeUsdc: netCost,
        totalCostUsdc: netCost,
        currentValueUsdc: group.latestPrice == null ? null : group.latestPrice * netShares,
        netGainIfWinUsdc: netShares - netCost,
        unrealizedPnlUsdc: 0,
        unrealizedPnlPct: 0,
        realizedPnlUsdc: 0,
        realizedPnlPct: 0,
        size: netShares,
        analysisSummary: "Ledger consistency fallback: public trade/activity history shows an open net buy that was not present in current Polymarket positions, open orders, or closed trades. Keep it visible until the next sync classifies it.",
      };
    });

  return {
    status: orphanedTrades.length ? "WARNING" : "OK",
    // Trade/activity history is an audit trail, not proof of a currently
    // held position. Only the current positions endpoint and active CLOB
    // orders may affect open risk, equity, or execution sizing.
    orphanedTrades: [],
    auditOnlyTrades: orphanedTrades,
    orphanedCount: orphanedTrades.length,
    checkedGroups: groups.size,
    invariant: "Only current Polymarket positions and active CLOB orders count as open exposure; unmatched history is audit-only.",
  };
}

function portfolioSummary(positions, valueRows, closedTrades = []) {
  const valueRow = Array.isArray(valueRows) ? valueRows.find((row) => String(row.user || "").toLowerCase() === ACCOUNT_ADDRESS) : null;
  const marketValue = positions.reduce((sum, item) => sum + number(item.currentValueUsdc, 0), 0);
  const pendingRedeemValue = closedTrades
    .filter((item) => String(item.status || "").toUpperCase() === "REDEEM_REQUIRED")
    .reduce((sum, item) => sum + number(item.exitValueUsdc ?? item.currentValueUsdc, 0), 0);
  const openRisk = positions.reduce((sum, item) => sum + number(item.totalCostUsdc, 0), 0);
  const openPnl = positions.reduce((sum, item) => sum + number(item.unrealizedPnlUsdc, 0), 0);
  const realizedPnl = positions.reduce((sum, item) => sum + number(item.realizedPnlUsdc, 0), 0)
    + closedTrades.reduce((sum, item) => sum + number(item.realizedPnlUsdc, 0), 0);
  const closedRisk = closedTrades.reduce((sum, item) => sum + number(item.totalCostUsdc || item.stakeUsdc, 0), 0);
  const totalRisk = openRisk + closedRisk;
  const equity = number(valueRow?.value, marketValue);
  const totalPnl = openPnl + realizedPnl;

  return {
    positionCount: positions.length,
    equityUsdc: equity,
    marketValueUsdc: marketValue,
    pendingRedeemUsdc: pendingRedeemValue,
    cashUsdc: null,
    openRiskUsdc: openRisk,
    openPnlUsdc: openPnl,
    openPnlPct: openRisk > 0 ? openPnl / openRisk : null,
    realizedPnlUsdc: realizedPnl,
    realizedPnlPct: closedRisk > 0 ? realizedPnl / closedRisk : null,
    totalPnlUsdc: totalPnl,
    totalPnlPct: totalRisk > 0 ? totalPnl / totalRisk : null,
  };
}

async function createClobContext() {
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
  if (!privateKey) return null;

  const [{ ClobClient, AssetType, SignatureTypeV2 }, { createWalletClient, custom }, { privateKeyToAccount }] =
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
        throw new Error(`Unexpected JSON-RPC request while syncing Polymarket balance: ${method}`);
      },
    }),
  });
  const tempClient = new ClobClient({ host: CLOB_HOST, chain: CHAIN_ID, signer });
  const creds = await tempClient.createOrDeriveApiKey();
  return { ClobClient, AssetType, SignatureTypeV2, signatureTypeMap, account, signer, creds };
}

async function loadClobBalanceAllowance(sync, options = {}) {
  const context = options.context || await createClobContext();
  if (!context) {
    return {
      status: "SKIPPED",
      message: "POLYMARKET_PRIVATE_KEY is not available to this workflow",
      collateral: null,
    };
  }
  const funderAddress = String(options.funderAddress || ACCOUNT_ADDRESS).toLowerCase();
  const signatureType = Number(options.signatureType ?? SIGNATURE_TYPE);
  const { ClobClient, AssetType, SignatureTypeV2, signatureTypeMap, signer, creds } = context;
  const client = new ClobClient({
    host: CLOB_HOST,
    chain: CHAIN_ID,
    signer,
    creds,
    signatureType: signatureTypeMap[signatureType] ?? SignatureTypeV2.POLY_PROXY,
    funderAddress,
  });

  const params = { asset_type: AssetType?.COLLATERAL || "COLLATERAL" };
  await client.updateBalanceAllowance(params).catch((error) => {
    sync.warnings.push(`balance-allowance update ${funderAddress}/sig${signatureType}: ${error?.message || String(error)}`);
  });
  const collateral = await client.getBalanceAllowance(params);
  let openOrders = [];
  if (typeof client.getOpenOrders === "function") {
    try {
      const orders = await client.getOpenOrders();
      openOrders = Array.isArray(orders) ? orders.map(normalizeOpenOrder).filter(isActiveOpenOrder) : [];
    } catch (error) {
      sync.warnings.push(`open-orders: ${error?.message || String(error)}`);
    }
  } else {
    sync.warnings.push("open-orders: clob client does not expose getOpenOrders");
  }
  const allowanceRaw = collateral.allowance
    || Object.values(collateral.allowances || {})[0]
    || null;
  const normalizedAllowance = allowanceRaw && String(allowanceRaw).length > 24 ? null : rawUnitsToUsdc(allowanceRaw);

  return {
    status: "OK",
    message: "CLOB collateral balance and allowance loaded",
    signerAddress: context.account.address.toLowerCase(),
    signatureType,
    funderAddress,
    collateral: {
      assetType: "COLLATERAL",
      balanceRaw: collateral.balance ?? null,
      balanceUsdc: rawUnitsToUsdc(collateral.balance),
      allowanceRaw,
      allowanceUsdc: normalizedAllowance,
      allowances: collateral.allowances || null,
      updatedAt: new Date().toISOString(),
    },
    openOrders,
  };
}

async function discoverTradingAccount(sync) {
  const discoveryWarnings = [];
  const context = await optionalValue("clob context", createClobContext(), null, discoveryWarnings);
  const signerAddress = context?.account?.address?.toLowerCase() || null;
  const envCandidates = uniqueAddresses([
    CONFIGURED_ACCOUNT_ADDRESS,
    CONFIGURED_FUNDER_ADDRESS,
    process.env.POLYMARKET_PROXY_WALLET_ADDRESS,
    process.env.POLYMARKET_DEPOSIT_WALLET_ADDRESS,
    signerAddress,
  ]);

  const profileCache = new Map();
  async function profileFor(address) {
    if (profileCache.has(address)) return profileCache.get(address);
    const profile = await optionalValue(
      `public-profile ${address}`,
      fetchGammaJson("/public-profile", { address }),
      null,
      discoveryWarnings,
    );
    profileCache.set(address, profile && !profile.error ? profile : null);
    return profileCache.get(address);
  }

  const expanded = [...envCandidates];
  for (const address of envCandidates) {
    const profile = await profileFor(address);
    if (profile?.proxyWallet) expanded.push(profile.proxyWallet);
  }

  const addresses = uniqueAddresses(expanded);
  const signatureTypes = uniqueNumbers([SIGNATURE_TYPE, 3, 1, 2, 0]);
  const candidates = [];

  for (const address of addresses) {
    const profile = await profileFor(address);
    const [valueRows, tokenBalances] = await Promise.all([
      optionalValue(`value ${address}`, fetchJson("/value", { user: address }), [], discoveryWarnings),
      optionalValue(`token balances ${address}`, loadTokenBalances(address), null, discoveryWarnings),
    ]);
    const dataValue = Array.isArray(valueRows)
      ? number(valueRows.find((row) => String(row.user || "").toLowerCase() === address)?.value, 0)
      : 0;
    const clobChecks = [];
    if (context) {
      for (const signatureType of signatureTypes) {
        const check = await optionalValue(
          `clob balance ${address}/sig${signatureType}`,
          loadClobBalanceAllowance(sync, { context, funderAddress: address, signatureType }),
          null,
          discoveryWarnings,
        );
        clobChecks.push({
          signatureType,
          status: check?.status || "ERROR",
          balanceUsdc: number(check?.collateral?.balanceUsdc, 0),
          allowanceUsdc: check?.collateral?.allowanceUsdc ?? null,
          openOrders: Array.isArray(check?.openOrders) ? check.openOrders.length : 0,
          message: check?.message || null,
        });
      }
    }

    const bestClob = clobChecks
      .filter((item) => item.status === "OK")
      .sort((a, b) => b.balanceUsdc - a.balanceUsdc)[0] || null;
    candidates.push({
      address,
      roles: [
        address === CONFIGURED_ACCOUNT_ADDRESS ? "configured-account" : null,
        address === CONFIGURED_FUNDER_ADDRESS ? "configured-funder" : null,
        address === signerAddress ? "private-key-signer" : null,
        profile?.proxyWallet && String(profile.proxyWallet).toLowerCase() === address ? "profile-proxy-wallet" : null,
      ].filter(Boolean),
      profile: normalizeProfile(profile),
      dataValueUsdc: dataValue,
      tokenBalances,
      clobChecks,
      bestClob,
      score: number(bestClob?.balanceUsdc, 0) * 1000
        + number(tokenBalances?.pUsd, 0) * 100
        + dataValue
        + (address === CONFIGURED_FUNDER_ADDRESS ? 0.01 : 0),
    });
  }

  const selected = [...candidates].sort((a, b) => b.score - a.score)[0] || {
    address: CONFIGURED_FUNDER_ADDRESS,
    bestClob: null,
    score: 0,
  };
  ACCOUNT_ADDRESS = selected.address;
  ACTIVE_FUNDER_ADDRESS = selected.address;
  ACTIVE_SIGNATURE_TYPE = selected.bestClob?.signatureType ?? SIGNATURE_TYPE;
  ACTIVE_SIGNER_ADDRESS = signerAddress;
  ACCOUNT_DISCOVERY = {
    signerAddress,
    configuredAccountAddress: CONFIGURED_ACCOUNT_ADDRESS,
    configuredFunderAddress: CONFIGURED_FUNDER_ADDRESS,
    selectedAddress: ACCOUNT_ADDRESS,
    selectedFunderAddress: ACTIVE_FUNDER_ADDRESS,
    selectedSignatureType: ACTIVE_SIGNATURE_TYPE,
    selectedReason: selected.score > 0 ? "highest discovered tradeable/data balance" : "configured fallback; no positive balance candidate discovered",
    candidates,
    warnings: discoveryWarnings,
  };
  if (discoveryWarnings.length) {
    sync.warnings.push(...discoveryWarnings.map((warning) => `account-discovery: ${warning}`));
  }
  return ACCOUNT_DISCOVERY;
}

async function main() {
  const generatedAt = new Date().toISOString();
  const sync = {
    status: "OK",
    message: "Live Polymarket account snapshot loaded",
    sources: ["positions", "value", "activity", "trades", "public-profile", "clob-balance-allowance"],
    warnings: [],
  };
  await discoverTradingAccount(sync);
  const previousLiveState = await loadPreviousLiveState(sync);

  let rawPositions = [];
  let rawActivity = [];
  let rawTrades = [];
  let valueRows = [];
  let publicProfile = null;
  let balanceAllowance = null;

  async function optional(label, promise, fallback) {
    try {
      return await promise;
    } catch (error) {
      sync.warnings.push(`${label}: ${error?.message || String(error)}`);
      return fallback;
    }
  }

  [rawPositions, valueRows, rawActivity, rawTrades, publicProfile, balanceAllowance] = await Promise.all([
    optional("positions", fetchJson("/positions", { user: ACCOUNT_ADDRESS, limit: 500 }), []),
    optional("value", fetchJson("/value", { user: ACCOUNT_ADDRESS }), []),
    optional("activity", fetchJson("/activity", { user: ACCOUNT_ADDRESS, limit: ACTIVITY_LIMIT }), []),
    optional("trades", fetchJson("/trades", { user: ACCOUNT_ADDRESS, limit: TRADE_LIMIT }), []),
    optional("public-profile", fetchGammaJson("/public-profile", { address: ACCOUNT_ADDRESS }), { error: "not_available" }),
    optional("balance-allowance", loadClobBalanceAllowance(sync, {
      funderAddress: ACTIVE_FUNDER_ADDRESS,
      signatureType: ACTIVE_SIGNATURE_TYPE,
    }), {
      status: "ERROR",
      message: "CLOB balance allowance sync failed",
      collateral: null,
    }),
  ]);

  if (sync.warnings.length && !Array.isArray(rawPositions)) {
    sync.status = "ERROR";
    sync.message = sync.warnings.join(" | ");
  } else if (sync.warnings.length) {
    sync.status = "PARTIAL";
    sync.message = `Live snapshot loaded with warnings: ${sync.warnings.join(" | ")}`;
  }

  const rawPositionRows = Array.isArray(rawPositions)
    ? rawPositions.map((position) => normalizePosition(position, generatedAt))
    : [];
  const activity = Array.isArray(rawActivity)
    ? rawActivity.map(normalizeActivity).filter((item) => item.timestamp || item.question !== "-")
    : [];
  const tradeHistory = Array.isArray(rawTrades)
    ? rawTrades.map(normalizeTradeHistoryItem).filter((item) => item.timestamp || item.question !== "-")
    : [];
  const positions = enrichOpenTimesFromHistory(rawPositionRows, [...tradeHistory, ...activity], previousLiveState);
  const historyClosedTrades = closedTradesFromHistory(tradeHistory, activity, generatedAt);
  const knownClosedKeys = new Set();
  for (const item of historyClosedTrades) {
    for (const key of liveItemKeys(item)) knownClosedKeys.add(key);
  }
  const resolvedPositionRows = closedRowsFromResolvedPositions(
    positions,
    knownClosedKeys,
    generatedAt,
    [...tradeHistory, ...activity],
    previousLiveState,
  );
  const openApiPositions = positions.filter((position) => !positionLooksResolved(position) && !anySharedKey(position, knownClosedKeys));
  const closedTrades = [...historyClosedTrades, ...resolvedPositionRows];
  const reconciliation = ledgerReconciliationFallbacks(
    tradeHistory,
    activity,
    openApiPositions,
    closedTrades,
    Array.isArray(balanceAllowance?.openOrders) ? balanceAllowance.openOrders : [],
    generatedAt,
  );
  const reconciledPositions = [...openApiPositions];
  if (reconciliation.orphanedCount > 0) {
    sync.status = sync.status === "ERROR" ? "ERROR" : "PARTIAL";
    sync.warnings.push(`${reconciliation.orphanedCount} live ledger trade(s) are visible only via activity/trade history and were kept as audit-only reconciliation rows`);
    sync.message = `Live snapshot loaded with ledger reconciliation warnings: ${sync.warnings.join(" | ")}`;
  }
  const portfolioBase = portfolioSummary(reconciledPositions, valueRows, closedTrades);
  const pendingRedeemPositions = [
    ...resolvedPositionRows,
    ...closedTrades.filter((item) => String(item?.status || "").toUpperCase() === "REDEEM_REQUIRED"),
  ];
  const notifications = redeemNotifications(pendingRedeemPositions, previousLiveState, generatedAt);
  const cashUsdc = number(balanceAllowance?.collateral?.balanceUsdc);
  const pendingRedeemUsdc = number(portfolioBase.pendingRedeemUsdc, 0);
  const equityUsdc = cashUsdc == null
    ? portfolioBase.equityUsdc
    : cashUsdc + number(portfolioBase.marketValueUsdc, 0) + pendingRedeemUsdc;
  const depositedUsdc = number((equityUsdc - number(portfolioBase.totalPnlUsdc, 0)).toFixed(6));
  // Dashboard portfolio returns use one consistent denominator: the estimated
  // original account value, rather than turnover through individual trades.
  const pnlPctOfOriginalValue = (pnl) => depositedUsdc > 0
    ? number(number(pnl, 0) / depositedUsdc)
    : null;

  const payload = {
    schemaVersion: 1,
    mode: "LIVE",
    generatedAt,
    account: {
      address: ACCOUNT_ADDRESS,
      proxyWallet: publicProfile?.proxyWallet || ACCOUNT_ADDRESS,
      label: "Polymarket account",
      connectionMode: "Read-only public API sync by proxy wallet address",
      loginMethod: "Polymarket proxy wallet; Gmail/MetaMask login is handled by Polymarket, not this frontend",
      trading: {
        signerAddress: ACTIVE_SIGNER_ADDRESS,
        configuredAccountAddress: CONFIGURED_ACCOUNT_ADDRESS,
        configuredFunderAddress: CONFIGURED_FUNDER_ADDRESS,
        funderAddress: ACTIVE_FUNDER_ADDRESS,
        signatureType: ACTIVE_SIGNATURE_TYPE,
        discoveryReason: ACCOUNT_DISCOVERY?.selectedReason || null,
      },
      profile: normalizeProfile(publicProfile?.error ? null : publicProfile),
    },
    accountDiscovery: ACCOUNT_DISCOVERY,
    portfolio: {
      ...portfolioBase,
      equityUsdc,
      cashUsdc,
      depositedUsdc,
      pnlPercentageBasis: "original-value",
      openPnlPct: pnlPctOfOriginalValue(portfolioBase.openPnlUsdc),
      realizedPnlPct: pnlPctOfOriginalValue(portfolioBase.realizedPnlUsdc),
      totalPnlPct: pnlPctOfOriginalValue(portfolioBase.totalPnlUsdc),
      depositedSource: "equity minus tracked Polymarket P/L",
      depositedNote: "Estimated original account capital currently visible to this app; deposits/withdrawals are not itemized by the public activity API.",
      equitySource: cashUsdc == null ? "polymarket-value-api-or-open-market-value" : "cash + open market value + pending redeem value",
      pendingRedeemNote: "Winning resolved positions that Polymarket exposes as redeemable are counted in equity until cash balance shows the manual redeem.",
      cashSource: balanceAllowance?.status === "OK" ? "clob-balance-allowance" : null,
    },
    balanceAllowance,
    openOrders: Array.isArray(balanceAllowance?.openOrders) ? balanceAllowance.openOrders : [],
    positions: reconciledPositions,
    apiPositions: openApiPositions,
    resolvedApiPositions: resolvedPositionRows,
    reconciliation,
    closedTrades,
    notifications,
    tradeHistory,
    activity,
    sync,
  };

  await mkdir(dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(JSON.stringify({
    mode: payload.mode,
    account: payload.account.address,
    positions: payload.positions.length,
    apiPositions: positions.length,
    reconciliationGaps: reconciliation.orphanedCount,
    openOrders: payload.openOrders.length,
    cashUsdc: payload.portfolio.cashUsdc,
    closedTrades: closedTrades.length,
    redeemAlerts: notifications.redeemAlerts.length,
    unsentRedeemAlerts: notifications.unsentRedeemAlerts.length,
    tradeHistory: tradeHistory.length,
    activity: activity.length,
    status: sync.status,
  }));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
