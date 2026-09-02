#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

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
const LIVE_PORTFOLIO_CONFIG_URL = process.env.LIVE_PORTFOLIO_CONFIG_URL || "";
const ACTIVITY_LIMIT = Number(process.env.LIVE_ACTIVITY_LIMIT || 50);
const TRADE_LIMIT = Number(process.env.LIVE_TRADE_LIMIT || 500);
const SIGNATURE_TYPE = Number(process.env.POLYMARKET_SIGNATURE_TYPE || 1);
const OPEN_ORDER_FALLBACK_HORIZON_MS = 24 * 60 * 60 * 1000;
const UNFILLED_LIMIT_OUTCOME_REFRESH_LIMIT = 16;
let ACCOUNT_ADDRESS = CONFIGURED_ACCOUNT_ADDRESS;
let ACTIVE_FUNDER_ADDRESS = CONFIGURED_FUNDER_ADDRESS;
let ACTIVE_SIGNATURE_TYPE = SIGNATURE_TYPE;
let ACTIVE_SIGNER_ADDRESS = null;
let ACCOUNT_DISCOVERY = null;

function number(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function optionalNumber(value) {
  return value == null || value === "" ? null : number(value);
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
  // "2026-08-05" carries no time, and JS reads it as midnight UTC -- the START of the
  // day. As a resolution date that is wrong in the worst direction: every position
  // opened during that day looks past resolution, which zeroes its potential p.a. and
  // (via the settlement-locked veto) freezes it out of rotation, while the fixture is
  // still being played. A day without a time ends when the day ends. The date-only
  // kickoff parsing below already used 23:59:59; this brings the rest in line.
  const dateOnly = String(value).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    return new Date(Date.UTC(
      Number(dateOnly[1]),
      Number(dateOnly[2]) - 1,
      Number(dateOnly[3]),
      23, 59, 59,
    )).toISOString();
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

async function loadLivePortfolioConfig(sync) {
  if (!LIVE_PORTFOLIO_CONFIG_URL) return null;
  try {
    const url = new URL(LIVE_PORTFOLIO_CONFIG_URL);
    url.searchParams.set("_sync", String(Date.now()));
    const response = await fetch(url, {
      headers: { "User-Agent": "osobnizkusenosti-trading-live-sync" },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}${body ? `: ${body.slice(0, 120)}` : ""}`);
    }
    const payload = await response.json();
    return payload?.config && typeof payload.config === "object" ? payload.config : null;
  } catch (error) {
    sync.warnings.push(`portfolio-config: ${error?.message || String(error)}`);
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

function correctedEndDate(question, rawEndDate, fallbackDate = null, position = {}) {
  const raw = isoTime(rawEndDate);
  const inferred = inferredEndDateFromQuestion(question, raw || fallbackDate);
  const text = [position.slug, position.eventSlug, position.category, position.categorySlug, position.marketType, question].filter(Boolean).join(" ");
  const isSports = Boolean(
    position.gameStartTime
    || position.eventStartTime
    || position.gameId
    || /\b(atp|wta|nba|nfl|mlb|nhl|ufc|fifa|soccer|football|tennis|baseball|basketball|hockey|esports|lol|match|game|tournament|spread|moneyline)\b/i.test(text),
  );
  const dateCandidates = [position.gameStartTime, position.eventStartTime, position.startDateIso];
  let scheduledEventDate = null;
  // Whether the scheduled date is an actual kickoff time or only the day the fixture
  // belongs to. A date with no time -- from the API or recovered from a slug -- is a
  // whole-day bucket stretched to 23:59:59, not a moment the match starts.
  let scheduledIsPrecise = false;
  for (const candidate of dateCandidates) {
    const value = String(candidate || "").trim();
    if (!value) continue;
    const dateOnly = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const parsed = dateOnly
      ? new Date(Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]), 23, 59, 59))
      : new Date(value);
    if (Number.isFinite(parsed.getTime())) {
      scheduledEventDate = parsed.toISOString();
      scheduledIsPrecise = !dateOnly;
      break;
    }
  }
  if (!scheduledEventDate && isSports) {
    const slugMatch = String(position.slug || position.eventSlug || "").match(/(?:^|[-_])((?:19|20)\d{2})-(\d{2})-(\d{2})(?:$|[-_])/);
    if (slugMatch) scheduledEventDate = new Date(Date.UTC(Number(slugMatch[1]), Number(slugMatch[2]) - 1, Number(slugMatch[3]), 23, 59, 59)).toISOString();
  }
  const rawTime = Date.parse(raw || "");
  const inferredTime = Date.parse(inferred || "");
  const base = !inferred
    ? { endDate: raw, source: raw ? "positions-api" : "unknown", rawEndDate: raw }
    : (!Number.isFinite(rawTime) || inferredTime > rawTime
      ? { endDate: inferred, source: raw ? "question-corrected" : "question-inferred", rawEndDate: raw }
      : { endDate: raw || inferred, source: raw ? "positions-api" : "question-inferred", rawEndDate: raw });
  const scheduledTime = Date.parse(scheduledEventDate || "");
  const endTime = Date.parse(base.endDate || "");
  // A kickoff still in the future wins even when it falls after the market's own end
  // date, because that end date is sometimes a stale pre-reschedule estimate and a
  // fixture cannot be past resolution before it has been played. Same correction as
  // marketDateContext() in paper-trading-bot.mjs -- including its limit: only a real
  // kickoff qualifies. A whole-day date is "in the future" for the entire day it names,
  // so letting it override a real end date keeps finished fixtures looking open.
  const scheduledIsFuture = scheduledIsPrecise
    && Number.isFinite(scheduledTime)
    && scheduledTime > Date.now();
  if (isSports
    && scheduledEventDate
    && Number.isFinite(scheduledTime)
    && (!Number.isFinite(endTime) || scheduledTime < endTime || scheduledIsFuture)) {
    return { ...base, endDate: scheduledEventDate, source: "sports-event-start", scheduledEventDate, resolutionEndDate: base.endDate || null };
  }
  return { ...base, scheduledEventDate: scheduledEventDate || null, resolutionEndDate: base.endDate || null };
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
  const endDateCorrection = correctedEndDate(question, rawEndDate, position.createdAt ?? position.timestamp ?? generatedAt, position);
  const endDate = endDateCorrection.endDate;
  const endTime = Date.parse(endDate || "");
  // Signed. This is reported as the row's days-left, so a market whose resolution date
  // has passed must read as overdue rather than as a day of runway. Nothing here
  // computes with it -- every annualization downstream applies its own
  // MIN_ANNUALIZATION_DAYS floor, so no other figure moves.
  const daysToResolution = Number.isFinite(endTime)
    ? (endTime - Date.now()) / OPEN_ORDER_FALLBACK_HORIZON_MS
    : null;
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
    scheduledEventDate: endDateCorrection.scheduledEventDate || null,
    resolutionEndDate: endDateCorrection.resolutionEndDate || null,
    daysToResolution,
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
  const tokenId = order.assetId || order.asset_id || order.asset || order.tokenID || order.tokenId || order.token_id || null;
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

// `/trades` and `/activity` overlap, but they are not a one-to-one ledger. In
// particular, Polymarket can settle two independent CLOB fills in one Polygon
// transaction. A transaction hash alone is therefore not an identity for a
// fill: collapsing it made a double buy look like one buy followed by a double
// redeem. Keep the highest observed multiplicity for each detailed fill across
// the two feeds, rather than adding both feeds or throwing away same-tx fills.
function publicHistoryFillIdentity(item) {
  return [
    item.transactionHash || item.txHash || item.id || "",
    item.tokenId || item.conditionId || item.slug || "",
    String(item.side || item.type || "").toUpperCase(),
    item.timestamp || "",
    number(item.price, ""),
    number(item.size, ""),
    number(item.usdcValue, ""),
    String(item.outcome || "").trim().toLowerCase(),
  ].join(":");
}

function mergedPublicHistoryRows(trades, activity, predicate) {
  const grouped = new Map();
  const append = (source, rows) => {
    for (const item of rows) {
      if (!predicate(item, source)) continue;
      const key = publicHistoryFillIdentity(item);
      if (!grouped.has(key)) grouped.set(key, { trades: [], activity: [] });
      grouped.get(key)[source].push(item);
    }
  };
  append("trades", Array.isArray(trades) ? trades : []);
  append("activity", Array.isArray(activity) ? activity : []);

  const rows = [];
  for (const group of grouped.values()) {
    // The dedicated trade endpoint wins a tie; it has the richer fill payload.
    const selected = group.trades.length >= group.activity.length ? group.trades : group.activity;
    rows.push(...selected);
  }
  return rows;
}

function closedTradesFromHistory(trades, activity, generatedAt) {
  const groups = new Map();
  const groupsByQuestion = new Map();
  const unmatchedRedeems = new Map();

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

  function unmatchedRedeemIdentity(item) {
    return [
      item.transactionHash || "",
      item.conditionId || "",
      questionKey(item),
      String(item.outcome || "").toLowerCase(),
      item.timestamp || "",
    ].join(":");
  }

  function retainUnmatchedRedeem(item) {
    const identity = unmatchedRedeemIdentity(item);
    if (unmatchedRedeems.has(identity)) return;
    const redeemedValue = number(item.usdcValue, 0);
    const redeemedShares = number(item.size, 0);
    unmatchedRedeems.set(identity, {
      id: `redeem-activity:${identity}`,
      mode: "LIVE",
      status: "REDEEMED",
      question: item.question || "-",
      outcome: item.outcome || "-",
      slug: item.slug || "",
      eventSlug: item.slug || "",
      url: item.url,
      tokenId: item.tokenId || null,
      conditionId: item.conditionId || null,
      date: item.timestamp || generatedAt,
      openedAt: item.timestamp || generatedAt,
      openedAtSource: "redeem-activity-unmatched",
      resolvedAt: item.timestamp || generatedAt,
      closedAt: item.timestamp || generatedAt,
      closedAtSource: "redeem-activity-unmatched",
      endDate: item.timestamp || generatedAt,
      entryPrice: null,
      exitPrice: redeemedShares > 0 ? redeemedValue / redeemedShares : 1,
      currentPrice: 1,
      finalOutcomePrice: 1,
      shares: redeemedShares || null,
      redeemedShares: redeemedShares || null,
      stakeUsdc: null,
      totalCostUsdc: null,
      exitValueUsdc: redeemedValue || null,
      netGainIfWinUsdc: null,
      realizedPnlUsdc: null,
      realizedPnlPct: null,
      realizedPct: null,
      unrealizedPnlUsdc: 0,
      unrealizedPnlPct: 0,
      reconciliationOnly: true,
      analysisSummary: "Redeem recorded by Polymarket activity, but the matching original buy is outside the retained trade history. Included as a resolved winning position; stake and realized P/L are intentionally unknown.",
    });
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

  for (const trade of mergedPublicHistoryRows(trades, activity, (item, source) => (
    source === "trades" || String(item.type || "").toUpperCase().includes("TRADE")
  ))) {
    ingestTrade(trade);
  }

  for (const item of mergedPublicHistoryRows([], activity, (entry) => (
    String(entry.type || "").toUpperCase().includes("REDEEM")
  ))) {
    const group = bestRedeemGroup(item);
    if (!group || !(group.buyCost > 0)) {
      // The public feeds have independent, capped windows. A redemption can therefore
      // still be present after its original buy has aged out of /trades. It remains a
      // real resolved win and must stay in Closed trades and accuracy, just without a
      // fabricated stake or P/L.
      retainUnmatchedRedeem(item);
      continue;
    }
    group.sellProceeds += number(item.usdcValue, 0);
    group.redeemedShares = number(group.redeemedShares, 0) + number(item.size, 0);
    if (!group.resolvedAt || Date.parse(item.timestamp || "") > Date.parse(group.resolvedAt || "")) group.resolvedAt = item.timestamp;
    group.status = "REDEEMED";
    group.closedAtSource = "redeem-activity";
  }

  const matchedRows = [...groups.values()]
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
  return [...matchedRows, ...unmatchedRedeems.values()]
    .sort((left, right) => (Date.parse(right.resolvedAt || "") || 0) - (Date.parse(left.resolvedAt || "") || 0));
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

// The public history endpoints are deliberately bounded. They are useful for enriching
// the live ledger, but they are not a durable ledger themselves: a later page can omit an
// old close or add a newer redeem activity. Match the same market outcome across snapshots
// so that subsequent syncs can refresh P/L/status without turning the close time into the
// time at which the account happened to be polled.
function closedTradeIdentityKeys(item = {}) {
  const tokenId = String(item.tokenId || item.assetId || item.asset || "").trim();
  const conditionId = String(item.conditionId || item.market || "").trim();
  const outcome = normalizedKeyText(item.outcome || item.side);
  const question = normalizedKeyText(item.question || item.title || item.market);
  const id = String(item.id || "").trim();
  const keys = [];
  if (tokenId) keys.push(`token:${tokenId}`);
  if (conditionId && outcome) keys.push(`condition:${conditionId}:${outcome}`);
  if (!tokenId && !conditionId && question && outcome) keys.push(`question:${question}:${outcome}`);
  if (!keys.length && id) keys.push(`id:${id}`);
  return keys;
}

function preservedClosedTimestamp(previous, generatedAt) {
  if (!previous) return null;
  return stableCloseTimestamp(
    previous.closedAt || previous.resolvedAt || previous.closedTime,
    generatedAt,
  );
}

function mergeClosedTradeHistory(currentRows = [], previousState = null, generatedAt = new Date().toISOString()) {
  const records = new Map();
  const keyToRecord = new Map();
  let anonymous = 0;

  function recordKey(row) {
    return closedTradeIdentityKeys(row)[0] || `anonymous:${anonymous += 1}`;
  }

  function findExisting(row) {
    for (const key of closedTradeIdentityKeys(row)) {
      const record = keyToRecord.get(key);
      if (record) return record;
    }
    return null;
  }

  function index(record) {
    records.set(record.key, record);
    for (const key of closedTradeIdentityKeys(record.row)) keyToRecord.set(key, record);
  }

  // Begin with our previous durable snapshot. This means an older close remains visible
  // when the public API's capped history no longer happens to return it.
  const previousRows = [
    ...(Array.isArray(previousState?.closedTrades) ? previousState.closedTrades : []),
    ...(Array.isArray(previousState?.resolvedApiPositions) ? previousState.resolvedApiPositions : []),
  ].filter((row) => row && typeof row === "object");
  for (const row of previousRows) {
    const existing = findExisting(row);
    if (existing) continue;
    index({ key: recordKey(row), row: { ...row } });
  }

  // Fresh rows carry better trade facts (for example a redeem replacing a previously
  // detected REDEEM_REQUIRED row), but never a newer close date for a known row.
  for (const row of (Array.isArray(currentRows) ? currentRows : []).filter((item) => item && typeof item === "object")) {
    const existing = findExisting(row);
    if (!existing) {
      index({ key: recordKey(row), row: { ...row } });
      continue;
    }
    const immutableClosedAt = preservedClosedTimestamp(existing.row, generatedAt);
    const merged = {
      ...existing.row,
      ...row,
    };
    if (immutableClosedAt) {
      merged.closedAt = immutableClosedAt;
      merged.resolvedAt = immutableClosedAt;
      merged.closedAtSource = existing.row.closedAtSource || "previous-live-state-close";
    }
    existing.row = merged;
    index(existing);
  }

  return [...records.values()]
    .map((record) => record.row)
    .sort((left, right) => (Date.parse(right.closedAt || right.resolvedAt || "") || 0)
      - (Date.parse(left.closedAt || left.resolvedAt || "") || 0));
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
    // A stored close date is carried forward WHATEVER it looks like, including one that
    // happens to equal the run that wrote it. Discarding those was the whole fault:
    // resolvedPositionCloseTime's last resort stamps `generatedAt` when nothing else can
    // date the close, so the row it writes always equals that run's own timestamp -- and
    // this skip then refused to carry it, so the next sync fell to the same last resort
    // and stamped ITS generatedAt. Every sync rewrote the date, roughly every ten minutes.
    //
    // An approximate date that never moves is worth far more than an approximate date that
    // moves: the first is "when we noticed", the second is not a date at all.
    if (!value) continue;
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
  // A close date is a fact about when something ended. It is written once, from the best
  // evidence available at that moment, and never rewritten -- so a date already recorded
  // for this row wins over every source below, including a fresher one.
  //
  // This is first, not last, because that is the difference between a date and a clock.
  // Reported: the Closed column kept moving. The chain below ends in a last resort that
  // stamps the current sync time when nothing can date the close, and the row it wrote was
  // then rejected on the next pass for looking like that run's own timestamp, so the last
  // resort ran again and stamped the new time. The date advanced with every sync.
  //
  // Deliberately ahead of the positions API too: if a later reading disagreed with what was
  // stored, honouring it would still be a Closed date that changed after the fact, which is
  // the thing being fixed. The sanity check remains -- a stored value in the future is
  // corrupt and falls through to be recomputed.
  const alreadyRecorded = bestIndexedTimestamp(previousCloseTimeIndex, position, "latest");
  if (stableCloseTimestamp(alreadyRecorded?.timestamp, generatedAt)) return alreadyRecorded;
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

// Is there actually anything to claim? Polymarket marks a losing position `resolved`
// exactly like a winning one, so "resolved" on its own says nothing about whether a
// redeem is owed. A settled position worth 0.00 has nothing to collect.
//
// The price fallback covers a winner whose value has not been marked yet: a settled
// outcome trades at ~1.00, so that is a win whose value is merely late.
function positionHasRedeemableValue(position = {}) {
  const currentValue = number(position.currentValueUsdc ?? position.currentValue, 0);
  const currentPrice = number(position.currentPrice);
  return currentValue > 0.000001 || (currentPrice != null && currentPrice >= 0.995);
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
      // Same predicate the redeem alert uses, so a row classified REDEEM_REQUIRED here
      // and the decision to email about it can never disagree.
      const winningResolved = positionHasRedeemableValue(position);
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

function openOrderIdentityKeys(order = {}) {
  return [order.id, order.orderId, order.orderID, order.tokenId, order.assetId, order.asset]
    .map((key) => String(key || "").trim())
    .filter(Boolean);
}

// Below this the difference is share/price rounding, not capital worth acting on.
const RELEASED_CAPITAL_EPSILON_USDC = 0.01;

function positionSharesByToken(positions = []) {
  const shares = new Map();
  for (const position of Array.isArray(positions) ? positions : []) {
    const size = number(position?.shares ?? position?.size, 0);
    if (!(size > 0)) continue;
    for (const key of [position?.tokenId, position?.assetId, position?.conditionId]) {
      const normalized = String(key || "").trim();
      // Several positions can share a conditionId, so accumulate rather than overwrite.
      if (normalized) shares.set(normalized, number(shares.get(normalized), 0) + size);
    }
  }
  return shares;
}

// An open order that leaves the book without filling hands its locked capital back as
// cash, where it sits idle until the next scheduled execution run picks it up hours
// later. Detecting it here lets the account sync dispatch a run for it immediately.
//
// The question is how much capital came back, not merely whether a position exists: an
// order can partially fill and have its remainder cancelled, which puts shares into a
// position AND frees the unfilled rest. Comparing the position's shares before and
// after tells the two apart, so a full fill (nothing freed) stays quiet while a partial
// one is reported for exactly the remainder.
function vanishedOpenOrders(previousState, openOrders = [], positions = [], sync = null, generatedAt = new Date().toISOString()) {
  // getOpenOrders() failing leaves the list empty while the sync still reports OK, so
  // without this guard a transient CLOB error would look like every order vanishing at
  // once and would dispatch a run against a portfolio that never actually changed.
  const ordersUnavailable = (Array.isArray(sync?.warnings) ? sync.warnings : [])
    .some((warning) => String(warning || "").startsWith("open-orders"));
  const previousOrders = Array.isArray(previousState?.openOrders) ? previousState.openOrders : [];
  if (ordersUnavailable || !previousOrders.length) {
    return { vanished: [], freedCapitalUsdc: 0, ordersUnavailable, checked: previousOrders.length };
  }

  const liveKeys = new Set(openOrders.flatMap(openOrderIdentityKeys));
  const sharesBefore = positionSharesByToken(previousState?.positions);
  const sharesNow = positionSharesByToken(positions);

  const vanished = [];
  for (const order of previousOrders) {
    const keys = openOrderIdentityKeys(order);
    if (!keys.length || keys.some((key) => liveKeys.has(key))) continue;

    const token = String(order.tokenId || order.assetId || "").trim();
    const lockedSize = number(order.remainingSize ?? order.originalSize, 0);
    const price = number(order.price, 0);
    // How much of this order actually became shares, measured on its own token so a
    // position opened elsewhere in the same run cannot be mistaken for this fill.
    const filledSize = token
      ? Math.max(0, number(sharesNow.get(token), 0) - number(sharesBefore.get(token), 0))
      : 0;
    const releasedSize = Math.max(0, lockedSize - filledSize);
    // A stored order without a usable size/price pair cannot be apportioned, so its
    // recorded notional stands. Losing an older row's release entirely would be worse
    // than treating it as fully released -- the execution run still decides what fits.
    const releasedCapitalUsdc = lockedSize > 0 && price > 0
      ? Number((releasedSize * price).toFixed(6))
      : number(order.notionalUsdc, 0);
    // Fully filled: the capital moved into the position, nothing came back to cash.
    if (releasedCapitalUsdc < RELEASED_CAPITAL_EPSILON_USDC) continue;

    const partiallyFilled = filledSize > 0;
    vanished.push({
      id: order.id || null,
      tokenId: order.tokenId || order.assetId || null,
      question: order.question || "",
      outcome: order.outcome || "",
      price,
      limitPrice: price,
      slug: order.slug || "",
      eventSlug: order.eventSlug || order.slug || "",
      url: order.url || "",
      conditionId: order.conditionId || order.market || null,
      endDate: order.endDate || order.resolutionEndDate || null,
      finalOutcomePrice: optionalNumber(order.finalOutcomePrice),
      remainingSize: lockedSize,
      filledSize: Number(filledSize.toFixed(6)),
      releasedSize: Number(releasedSize.toFixed(6)),
      releasedCapitalUsdc,
      partiallyFilled,
      createdAt: order.createdAt || null,
      detectedAt: generatedAt,
      reason: partiallyFilled
        ? "open order left the book after filling only part of its size; the unfilled remainder is free capital again"
        : "open order left the book without becoming a position; its locked capital is free again",
    });
  }

  const freedCapitalUsdc = vanished.reduce((sum, order) => sum + number(order.releasedCapitalUsdc, 0), 0);
  return {
    vanished,
    freedCapitalUsdc: Number(freedCapitalUsdc.toFixed(6)),
    ordersUnavailable,
    checked: previousOrders.length,
  };
}

// A CLOB order can disappear because it was cancelled, expired with the event, or was
// withdrawn by our executor. When it did not produce even a partial position it is useful
// audit history in its own right, but it must never be made into a closed trade or P/L.
// Persist it outside `releasedOrderCapital`: that field is a one-sync trigger, whereas
// this ledger is the durable list rendered in the portfolio tab.
function unfilledLimitOrderHistory(previousState, releasedOrderCapital = {}) {
  const previous = Array.isArray(previousState?.unfilledLimitOrders)
    ? previousState.unfilledLimitOrders.filter((item) => item && typeof item === "object")
    : [];
  const records = new Map();
  const keyFor = (order = {}) => String(order.id || order.orderId || order.orderID || "").trim()
    || `${String(order.tokenId || order.assetId || "").trim()}:${String(order.createdAt || order.openedAt || "").trim()}`;
  for (const order of previous) {
    const key = keyFor(order);
    if (key) records.set(key, order);
  }
  for (const vanished of (Array.isArray(releasedOrderCapital?.vanished) ? releasedOrderCapital.vanished : [])) {
    if (vanished.partiallyFilled || number(vanished.filledSize, 0) > 0.000001) continue;
    const key = keyFor(vanished);
    if (!key) continue;
    const prior = records.get(key) || {};
    records.set(key, {
      ...prior,
      ...vanished,
      id: vanished.id || prior.id || null,
      orderId: vanished.id || prior.orderId || null,
      mode: "LIVE_LIMIT_ORDER",
      status: "LIVE_LIMIT_ORDER_UNFILLED",
      // Keep it an order for portfolio attribution. `entryPrice` would cause the UI to
      // treat it as a filled position, while `price` is correctly a resting bid price.
      price: number(vanished.price, number(prior.price)),
      limitPrice: number(vanished.limitPrice ?? vanished.price, number(prior.limitPrice ?? prior.price)),
      shares: null,
      stakeUsdc: number(vanished.releasedCapitalUsdc, number(prior.stakeUsdc)),
      releasedCapitalUsdc: number(vanished.releasedCapitalUsdc, number(prior.releasedCapitalUsdc)),
      openedAt: vanished.createdAt || prior.openedAt || prior.createdAt || null,
      createdAt: vanished.createdAt || prior.createdAt || null,
      closedAt: vanished.detectedAt || prior.closedAt || null,
      detectedAt: vanished.detectedAt || prior.detectedAt || null,
      finalOutcomePrice: optionalNumber(vanished.finalOutcomePrice) ?? optionalNumber(prior.finalOutcomePrice),
    });
  }
  return [...records.values()].sort((a, b) => {
    const aTime = Date.parse(a.closedAt || a.detectedAt || a.openedAt || "") || 0;
    const bTime = Date.parse(b.closedAt || b.detectedAt || b.openedAt || "") || 0;
    return bTime - aTime;
  });
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
    const settled = positionOfficiallyResolved(position)
      || String(position.status || "").toUpperCase() === "REDEEM_REQUIRED";
    // A lost position is `resolved` too, so settled-ness alone used to raise an alert --
    // and it was emailed under the title "Winning Polymarket position may need redeem"
    // with a redeem value of 0.00. Nothing is owed on it, so there is nothing to tell.
    if (!settled || !positionHasRedeemableValue(position)) continue;
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

  for (const trade of mergedPublicHistoryRows(trades, activity, (item, source) => (
    source === "trades" || String(item.type || "").toUpperCase().includes("TRADE")
  ))) {
    ingestTrade(trade);
  }
  for (const item of mergedPublicHistoryRows([], activity, (entry) => (
    String(entry.type || "").toUpperCase().includes("REDEEM")
  ))) {
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

function parseArrayField(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function openOrderMetadataIndex(previousState = null) {
  const index = new Map();
  const rows = Array.isArray(previousState?.openOrders) ? previousState.openOrders : [];
  for (const row of rows) {
    if (!row || (!row.question && !row.slug && !row.eventSlug)) continue;
    for (const key of [row.tokenId, row.assetId, row.asset, row.id, row.orderId, row.orderID]) {
      const normalized = String(key || "").trim();
      if (normalized) index.set(normalized, row);
    }
  }
  return index;
}

async function gammaMarketForOpenOrder(tokenId) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const markets = await fetchGammaJson("/markets", { clob_token_ids: tokenId });
      const market = Array.isArray(markets) ? markets[0] : null;
      if (market) return market;
      lastError = new Error("Gamma returned no market for CLOB token");
    } catch (error) {
      lastError = error;
    }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 250));
  }
  throw lastError || new Error("Gamma market lookup failed");
}

function openOrderMarketDates(market = {}, order = {}, generatedAt = new Date().toISOString()) {
  const event = Array.isArray(market.events) ? market.events.find((item) => item?.slug) : null;
  // Gamma stores the fixture kickoff on either the market or its parent event.
  // Prefer it for sports: it is the useful capital-lock horizon even when final
  // settlement happens later. The actual resolution window stays in the record
  // separately for auditability.
  const scheduledEventDate = isoTime(
    market.gameStartTime
      ?? market.eventStartTime
      ?? event?.gameStartTime
      ?? event?.eventStartTime
      ?? event?.startTime
      ?? null,
  );
  const resolutionEndDate = isoTime(market.endDate ?? market.endDateIso ?? event?.endDate ?? null);
  const dateContext = correctedEndDate(
    market.question || order.question || "",
    resolutionEndDate,
    order.createdAt || generatedAt,
    {
      ...market,
      eventSlug: event?.slug || market.eventSlug || order.eventSlug || "",
      gameStartTime: scheduledEventDate || market.gameStartTime || event?.startTime || null,
      eventStartTime: scheduledEventDate || market.eventStartTime || event?.startTime || null,
      startDateIso: market.startDateIso || event?.startDateIso || event?.startDate || null,
    },
  );
  let endDate = dateContext.endDate;
  let endDateSource = dateContext.source === "positions-api" ? "gamma-market-end-date" : dateContext.source;
  if (!endDate) {
    const createdAt = Date.parse(order.createdAt || generatedAt || "");
    const fallbackTime = (Number.isFinite(createdAt) ? createdAt : Date.now()) + OPEN_ORDER_FALLBACK_HORIZON_MS;
    endDate = new Date(fallbackTime).toISOString();
    endDateSource = "open-order-24h-fallback";
  }
  const remainingDays = (Date.parse(endDate) - Date.now()) / OPEN_ORDER_FALLBACK_HORIZON_MS;
  return {
    endDate,
    endDateSource,
    scheduledEventDate: dateContext.scheduledEventDate || scheduledEventDate || null,
    resolutionEndDate: dateContext.resolutionEndDate || resolutionEndDate || null,
    // Signed, for the same reason as the position row above: this is the value the
    // order's days-left is rendered from. The one-day minimum the annualized returns
    // want is applied where those are calculated, not baked into the reported horizon --
    // clamping it here made every expired order read "1.0 d left".
    daysToResolution: Number.isFinite(remainingDays) ? remainingDays : null,
  };
}

// CLOB open-order records contain trading fields only. Preserve the Gamma
// event identity so another market from the same match is never treated as an
// unrelated opportunity. Gamma can occasionally return an empty response
// during settlement; retain the last confirmed metadata rather than rendering
// a nameless order in the meantime.
async function enrichOpenOrdersWithMarketMetadata(openOrders = [], sync, previousState = null) {
  const previousMetadata = openOrderMetadataIndex(previousState);
  return Promise.all(openOrders.map(async (order) => {
    const tokenId = String(order?.tokenId || order?.assetId || "").trim();
    if (!tokenId) return order;
    try {
      const market = await gammaMarketForOpenOrder(tokenId);
      const tokenIds = parseArrayField(market.clobTokenIds).map(String);
      const outcomes = parseArrayField(market.outcomes).map(String);
      const outcomePrices = parseArrayField(market.outcomePrices).map((value) => optionalNumber(value));
      const outcomeIndex = tokenIds.indexOf(tokenId);
      const event = Array.isArray(market.events) ? market.events.find((item) => item?.slug) : null;
      const slug = market.slug || order.slug || "";
      const eventSlug = event?.slug || market.eventSlug || order.eventSlug || slug;
      const dates = openOrderMarketDates(market, { ...order, eventSlug }, new Date().toISOString());
      return {
        ...order,
        question: order.question || market.question || "",
        outcome: order.outcome || outcomes[outcomeIndex] || "",
        slug,
        eventSlug,
        conditionId: order.conditionId || market.conditionId || order.market || null,
        market: order.market || market.conditionId || null,
        url: eventSlug ? `https://polymarket.com/event/${eventSlug}` : order.url,
        ...dates,
        // What Polymarket still says about the market this order rests on. A bid on a
        // market that has stopped trading cannot fill for a reason worth having, and it
        // holds its collateral until it is cancelled -- so both the dashboard and the
        // executor need to tell one apart from an order that is simply still waiting.
        marketListed: true,
        marketClosed: market.closed === true,
        marketArchived: market.archived === true,
        marketResolved: market.resolved === true || market.isResolved === true,
        marketAcceptingOrders: market.acceptingOrders !== false,
        // This value travels with a subsequently vanished order. It is intentionally
        // present only after Gamma marks the market closed: an in-play mark is not the
        // eventual answer to "would this unfilled bid have won?".
        finalOutcomePrice: market.closed === true ? (outcomePrices[outcomeIndex] ?? null) : null,
        marketMetadataSource: "gamma-clob-token",
      };
    } catch (error) {
      const previous = previousMetadata.get(tokenId)
        || previousMetadata.get(String(order?.id || "").trim())
        || previousMetadata.get(String(order?.orderId || order?.orderID || "").trim());
      if (previous) {
        sync.warnings.push(`open-order-market-${tokenId.slice(0, 12)}: Gamma lookup failed; retained last confirmed market metadata`);
        return {
          ...previous,
          ...order,
          question: order.question || previous.question || "",
          outcome: order.outcome || previous.outcome || "",
          slug: order.slug || previous.slug || "",
          eventSlug: order.eventSlug || previous.eventSlug || "",
          conditionId: order.conditionId || previous.conditionId || order.market || null,
          url: order.url || previous.url || "",
          marketMetadataSource: "previous-live-snapshot",
        };
      }
      sync.warnings.push(`open-order-market-${tokenId.slice(0, 12)}: ${error?.message || String(error)}`);
      return order;
    }
  }));
}

// The order can be removed shortly after an event finishes, before Gamma publishes its
// final 0/1 outcome. Revisit the oldest unchecked terminal orders in small batches so the
// audit tab eventually grades every missed bid without turning each account sync into a
// large historical Gamma sweep.
async function refreshUnfilledLimitOrderOutcomes(orders = [], generatedAt = new Date().toISOString()) {
  const result = [...orders];
  const now = Date.parse(generatedAt) || Date.now();
  const pending = result
    .map((order, index) => ({ order, index }))
    .filter(({ order }) => {
      if (optionalNumber(order?.finalOutcomePrice) != null) return false;
      const end = Date.parse(order?.endDate || order?.resolutionEndDate || "");
      return Number.isFinite(end) && end <= now;
    })
    .sort((a, b) => (Date.parse(a.order.outcomeLastCheckedAt || "") || 0) - (Date.parse(b.order.outcomeLastCheckedAt || "") || 0))
    .slice(0, UNFILLED_LIMIT_OUTCOME_REFRESH_LIMIT);

  await Promise.all(pending.map(async ({ order, index }) => {
    const tokenId = String(order?.tokenId || order?.assetId || "").trim();
    if (!tokenId) return;
    try {
      const market = await gammaMarketForOpenOrder(tokenId);
      const tokenIds = parseArrayField(market.clobTokenIds).map(String);
      const outcomeIndex = tokenIds.indexOf(tokenId);
      const outcomePrices = parseArrayField(market.outcomePrices).map((value) => optionalNumber(value));
      const finalOutcomePrice = market.closed === true ? (outcomePrices[outcomeIndex] ?? null) : null;
      result[index] = {
        ...order,
        finalOutcomePrice: optionalNumber(finalOutcomePrice) ?? optionalNumber(order.finalOutcomePrice),
        outcomeLastCheckedAt: generatedAt,
      };
    } catch {
      // The next bounded pass retries this one. A temporary Gamma gap must not erase the
      // order or turn an unknown result into a loss.
    }
  }));
  return result;
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

    const proxyWallet = String(profile?.proxyWallet || "").toLowerCase();
    const isDepositWallet = proxyWallet === address;
    // CLOB balance queries can return the same collateral balance for several
    // signature types. For a discovered deposit wallet the order signer must
    // nevertheless be POLY_1271; choosing the first equal-balance row here
    // caused intermittent invalid-signature SELL orders during rotations.
    const signaturePreference = (item) => {
      if (isDepositWallet && item.signatureType === 3) return 30;
      if (address === signerAddress && item.signatureType === 0) return 20;
      if (address === CONFIGURED_FUNDER_ADDRESS && item.signatureType === SIGNATURE_TYPE) return 10;
      return 0;
    };
    const bestClob = clobChecks
      .filter((item) => item.status === "OK")
      .sort((a, b) => (
        b.balanceUsdc - a.balanceUsdc
        || signaturePreference(b) - signaturePreference(a)
      ))[0] || null;
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
  const [previousLiveState, portfolioConfig] = await Promise.all([
    loadPreviousLiveState(sync),
    loadLivePortfolioConfig(sync),
  ]);

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
  // Polymarket's /positions is the record of what this wallet holds NOW. The closed-trade
  // history is a record of things that ended, and it must not outvote the present.
  //
  // Measured on 2026-08-30: an unresolved position of 6.0057 shares priced at 0.8050 --
  // $4.83 -- was excluded right here because a REDEEMED history row shared one of its
  // keys. That $4.83 was then counted nowhere. It was missing from equityUsdc, from the
  // positions table, and from the risk checks the executor runs before it orders, and the
  // dashboard's equity was short by exactly that much against Polymarket's own figure.
  //
  // Which key matched was never established -- by the time a probe for it shipped, the
  // position had settled and the case no longer reproduced -- so this deliberately does
  // not depend on knowing. An unresolved position the exchange still reports as held is
  // kept whatever the history says, which is sound under any of the possible causes.
  //
  // The suppression it used to apply silently is recorded as a warning instead. If such a
  // row ever IS a sold-out position lagging in /positions, that now surfaces as something
  // to look at rather than as capital quietly going missing -- which is the right way
  // round, because a stale row costs a line in the table and the old behaviour cost real
  // equity off the screen.
  const openApiPositions = positions.filter((position) => !positionLooksResolved(position));
  for (const position of openApiPositions) {
    if (!anySharedKey(position, knownClosedKeys)) continue;
    const shares = number(position.shares ?? position.size, 0);
    if (!(shares > 0.000001)) continue;
    sync.warnings.push(`position-history-overlap-${String(position.tokenId || position.conditionId || position.question || "").slice(0, 24)}:`
      + ` kept an unresolved position of ${shares.toFixed(4)} shares that the closed-trade history also claims`);
  }
  const closedTrades = mergeClosedTradeHistory(
    [...historyClosedTrades, ...resolvedPositionRows],
    previousLiveState,
    generatedAt,
  );
  const openOrders = await enrichOpenOrdersWithMarketMetadata(
    Array.isArray(balanceAllowance?.openOrders) ? balanceAllowance.openOrders : [],
    sync,
    previousLiveState,
  );
  const reconciliation = ledgerReconciliationFallbacks(
    tradeHistory,
    activity,
    openApiPositions,
    closedTrades,
    openOrders,
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
  const releasedOrderCapital = vanishedOpenOrders(
    previousLiveState,
    openOrders,
    reconciledPositions,
    sync,
    generatedAt,
  );
  const unfilledLimitOrders = await refreshUnfilledLimitOrderOutcomes(
    unfilledLimitOrderHistory(previousLiveState, releasedOrderCapital),
    generatedAt,
  );
  const cashUsdc = number(balanceAllowance?.collateral?.balanceUsdc);
  const pendingRedeemUsdc = number(portfolioBase.pendingRedeemUsdc, 0);
  const equityUsdc = cashUsdc == null
    ? portfolioBase.equityUsdc
    : cashUsdc + number(portfolioBase.marketValueUsdc, 0) + pendingRedeemUsdc;
  // The deposited amount is an external fact: what was actually paid into the account.
  // It used to be inferred as equity - totalPnlUsdc on the first snapshot and then kept
  // sticky forever, so one bad totalPnlUsdc reading was permanently baked in as the
  // deposit. That is how "Original value $33.36" appeared: equity 26.93 minus a -6.43
  // P/L that was not itself a real result. Every percentage on the card then derives
  // from that wrong baseline, so the error sustains itself.
  //
  // It is now configured, never derived. The UI's portfolio config is authoritative when
  // set; LIVE_ORIGINAL_VALUE_USDC is a legacy fallback for headless recovery. If neither
  // exists, the stored baseline is kept before the old default is used.
  const storedOriginalValueUsdc = number(
    previousLiveState?.portfolio?.originalValueUsdc ?? previousLiveState?.portfolio?.depositedUsdc,
  );
  // The amount actually paid into the Polymarket account, stated here rather than
  // derived. It outranks any stored baseline on purpose: the stored one on the hosting
  // is the corrupted 33.36 that came from the old inference, and a fix that only applied
  // to fresh state would never have reached it.
  //
  // Change it in the Live portfolio parameters when the deposit really changes. The
  // legacy LIVE_ADDITIONAL_DEPOSIT_USDC path is still accepted only while no UI baseline
  // is set, so old recovery runs keep working without double-counting a saved top-up.
  const DEFAULT_ORIGINAL_VALUE_USDC = 27;
  const configOriginalValueUsdc = number(portfolioConfig?.live?.initialUsdc);
  const envOriginalValueUsdc = number(process.env.LIVE_ORIGINAL_VALUE_USDC);
  const configuredOriginalValueUsdc = configOriginalValueUsdc > 0
    ? configOriginalValueUsdc
    : (envOriginalValueUsdc > 0 ? envOriginalValueUsdc : null);
  // A later top-up is added once and recorded, so repeated runs cannot count it twice.
  const appliedDeposits = (Array.isArray(previousLiveState?.portfolio?.appliedDeposits)
    ? previousLiveState.portfolio.appliedDeposits
    : []).filter((entry) => entry && typeof entry === "object").slice(0, 50);
  const additionalDepositUsdc = number(process.env.LIVE_ADDITIONAL_DEPOSIT_USDC);
  const additionalDepositId = String(process.env.LIVE_ADDITIONAL_DEPOSIT_ID || "").trim()
    || (additionalDepositUsdc > 0 ? `deposit-${additionalDepositUsdc}` : "");
  const useConfiguredUiBaseline = configOriginalValueUsdc > 0;
  const depositIsNew = !useConfiguredUiBaseline
    && additionalDepositUsdc > 0
    && additionalDepositId !== ""
    && !appliedDeposits.some((entry) => String(entry.id || "") === additionalDepositId);

  let baselineUsdc = configuredOriginalValueUsdc > 0
    ? configuredOriginalValueUsdc
    : (storedOriginalValueUsdc > 0 ? storedOriginalValueUsdc : DEFAULT_ORIGINAL_VALUE_USDC);
  if (depositIsNew) {
    baselineUsdc = number((number(baselineUsdc, 0) + additionalDepositUsdc).toFixed(6));
    appliedDeposits.unshift({
      id: additionalDepositId,
      amountUsdc: additionalDepositUsdc,
      appliedAt: generatedAt,
      baselineAfterUsdc: baselineUsdc,
    });
    console.warn(`Applied deposit ${additionalDepositUsdc} USDC (${additionalDepositId}); baseline is now ${baselineUsdc}.`);
  }
  const originalValueUsdc = baselineUsdc;
  const originalValueSource = configOriginalValueUsdc > 0
    ? "portfolio-config"
    : (envOriginalValueUsdc > 0
      ? "configured-env"
      : (storedOriginalValueUsdc > 0 ? "persisted-original-value" : "configured-default"));
  // Public activity/history endpoints can briefly omit older closes. Equity
  // comes from the live collateral plus marked positions, so it is the stable
  // source of truth for total account P/L against the fixed original value.
  // Only meaningful against a known baseline. Without one, `equityUsdc - null` would
  // coerce to equity itself and report the entire balance as profit, so the ledger
  // values are reported instead and the card says the baseline is unavailable.
  const hasBaseline = number(originalValueUsdc, 0) > 0;
  const equityDeltaPnlUsdc = hasBaseline
    ? number((equityUsdc - originalValueUsdc).toFixed(6))
    : number(portfolioBase.totalPnlUsdc);
  const reconciledRealizedPnlUsdc = hasBaseline
    ? number((equityDeltaPnlUsdc - number(portfolioBase.openPnlUsdc, 0)).toFixed(6))
    : number(portfolioBase.realizedPnlUsdc);
  const pnlPctOfOriginalValue = (pnl) => (hasBaseline
    ? number(number(pnl, 0) / originalValueUsdc)
    : null);

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
      // Keep the legacy field for the frontend while storing an explicit,
      // immutable name for new snapshots.
      depositedUsdc: originalValueUsdc,
      originalValueUsdc,
      // Where the baseline came from, so a wrong one is traceable instead of
      // anonymous, and the applied top-ups so none is ever counted twice.
      originalValueSource,
      appliedDeposits,
      pnlPercentageBasis: hasBaseline ? "original-value" : "ledger",
      openPnlPct: pnlPctOfOriginalValue(portfolioBase.openPnlUsdc),
      // Keep total P/L stable even when the public closed-trade history is
      // temporarily incomplete. Realized P/L is the remainder after the
      // current marked open P/L, therefore the dashboard always reconciles.
      realizedPnlUsdc: reconciledRealizedPnlUsdc,
      realizedPnlPct: pnlPctOfOriginalValue(reconciledRealizedPnlUsdc),
      totalPnlUsdc: equityDeltaPnlUsdc,
      totalPnlPct: pnlPctOfOriginalValue(equityDeltaPnlUsdc),
      ledgerDerivedRealizedPnlUsdc: portfolioBase.realizedPnlUsdc,
      ledgerDerivedTotalPnlUsdc: portfolioBase.totalPnlUsdc,
      pnlSource: "equity-minus-original-value",
      depositedSource: originalValueSource,
      depositedNote: "Original account value is the configured live capital/deposit baseline. Update it in portfolio parameters after a real top-up or withdrawal; it is never inferred from position, redeem, or P/L sync changes.",
      equitySource: cashUsdc == null ? "polymarket-value-api-or-open-market-value" : "cash + open market value + pending redeem value",
      pendingRedeemNote: "Winning resolved positions that Polymarket exposes as redeemable are counted in equity until cash balance shows the manual redeem.",
      cashSource: balanceAllowance?.status === "OK" ? "clob-balance-allowance" : null,
    },
    balanceAllowance,
    openOrders,
    releasedOrderCapital,
    unfilledLimitOrders,
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
    vanishedOpenOrders: releasedOrderCapital.vanished.length,
    unfilledLimitOrders: unfilledLimitOrders.length,
    freedOrderCapitalUsdc: releasedOrderCapital.freedCapitalUsdc,
    cashUsdc: payload.portfolio.cashUsdc,
    closedTrades: closedTrades.length,
    redeemAlerts: notifications.redeemAlerts.length,
    unsentRedeemAlerts: notifications.unsentRedeemAlerts.length,
    tradeHistory: tradeHistory.length,
    activity: activity.length,
    status: sync.status,
  }));
}

// Importing this module must never start an account sync, so the pure helpers below can
// be tested offline. Only a direct `node tools/live-account-sync.mjs` invocation runs.
const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (invokedDirectly) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
}

export {
  resolvedPositionCloseTime,
  buildPreviousCloseTimeIndex,
  closedTradesFromHistory,
  mergeClosedTradeHistory,
  openOrderIdentityKeys,
  vanishedOpenOrders,
  unfilledLimitOrderHistory,
  refreshUnfilledLimitOrderOutcomes,
  positionHasRedeemableValue,
  redeemNotifications,
};
