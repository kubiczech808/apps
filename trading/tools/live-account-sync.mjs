#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const DATA_API = process.env.POLYMARKET_DATA_API || "https://data-api.polymarket.com";
const GAMMA_API = process.env.POLYMARKET_GAMMA_API || "https://gamma-api.polymarket.com";
const CLOB_HOST = process.env.POLYMARKET_HOST || "https://clob.polymarket.com";
const CHAIN_ID = Number(process.env.POLYMARKET_CHAIN_ID || 137);
const DEFAULT_ADDRESS = "0x3252de913d9323667f21f4d88fa1f996fc282293";
const ACCOUNT_ADDRESS = (process.env.POLYMARKET_FUNDER_ADDRESS || process.env.POLYMARKET_ADDRESS || DEFAULT_ADDRESS).toLowerCase();
const STATE_PATH = process.env.LIVE_STATE_PATH || "data/live-state.json";
const ACTIVITY_LIMIT = Number(process.env.LIVE_ACTIVITY_LIMIT || 50);
const TRADE_LIMIT = Number(process.env.LIVE_TRADE_LIMIT || 500);
const SIGNATURE_TYPE = Number(process.env.POLYMARKET_SIGNATURE_TYPE || 1);

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

function normalizePosition(position, generatedAt) {
  const size = number(position.size ?? position.balance ?? position.quantity, 0);
  const avgPrice = number(position.avgPrice ?? position.averagePrice ?? position.entryPrice);
  const currentPrice = number(position.curPrice ?? position.currentPrice ?? position.price);
  const initialValue = number(position.initialValue ?? position.totalBought ?? (avgPrice != null ? avgPrice * size : null), 0);
  const currentValue = number(position.currentValue ?? position.value ?? (currentPrice != null ? currentPrice * size : null), 0);
  const cashPnl = number(position.cashPnl ?? position.pnl ?? position.unrealizedPnl ?? (currentValue - initialValue), 0);
  const pnlPct = ratio(position.percentPnl ?? position.pnlPercent ?? (initialValue > 0 ? cashPnl / initialValue : null));
  const realizedPnl = number(position.realizedPnl ?? position.cashPnlRealized, 0);
  const endDate = isoTime(position.endDate ?? position.endDateIso ?? position.resolutionDate);

  return {
    id: String(position.asset ?? position.tokenId ?? position.conditionId ?? `${position.slug || position.title || "position"}-${position.outcome || ""}`),
    mode: "LIVE",
    status: "OPEN",
    question: position.title || position.question || position.market || "-",
    outcome: position.outcome || position.side || "-",
    slug: position.slug || position.eventSlug || "",
    eventSlug: position.eventSlug || position.slug || "",
    url: positionUrl(position),
    tokenId: position.asset || position.tokenId || null,
    conditionId: position.conditionId || null,
    date: isoTime(position.createdAt ?? position.timestamp) || generatedAt,
    openedAt: isoTime(position.createdAt ?? position.timestamp) || generatedAt,
    endDate,
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

function closedTradesFromHistory(trades, activity, generatedAt) {
  const groups = new Map();

  function groupKey(item) {
    return String(item.tokenId || `${item.conditionId || item.slug || item.question}:${item.outcome || ""}`);
  }

  for (const trade of trades) {
    const key = groupKey(trade);
    if (!key || key === "null") continue;
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
    }
  }

  for (const item of activity) {
    const type = String(item.type || "").toUpperCase();
    if (!type.includes("REDEEM")) continue;
    const key = groupKey(item);
    const group = groups.get(key);
    if (!group) continue;
    group.sellProceeds += number(item.usdcValue, 0);
    if (!group.resolvedAt || Date.parse(item.timestamp || "") > Date.parse(group.resolvedAt || "")) group.resolvedAt = item.timestamp;
    group.status = "REDEEMED";
  }

  return [...groups.values()]
    .filter((group) => group.buyCost > 0 && (Math.abs(group.sharesBought - group.sharesSold) < 0.000001 || group.status === "REDEEMED"))
    .map((group) => {
      const realizedPnl = group.sellProceeds - group.buyCost;
      const entryPrice = group.sharesBought > 0 ? group.buyCost / group.sharesBought : null;
      const exitPrice = group.sharesSold > 0
        ? group.sellProceeds / group.sharesSold
        : (group.sharesBought > 0 && group.status === "REDEEMED" ? group.sellProceeds / group.sharesBought : group.latestPrice);
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
        resolvedAt: group.resolvedAt || generatedAt,
        endDate: group.resolvedAt || generatedAt,
        entryPrice,
        currentPrice: exitPrice,
        finalOutcomePrice: exitPrice,
        shares: group.sharesBought,
        stakeUsdc: group.buyCost,
        totalCostUsdc: group.buyCost,
        netGainIfWinUsdc: group.sharesBought - group.buyCost,
        realizedPnlUsdc: realizedPnl,
        realizedPnlPct: group.buyCost > 0 ? realizedPnl / group.buyCost : null,
        unrealizedPnlUsdc: 0,
        unrealizedPnlPct: 0,
        analysisSummary: "Derived from public Polymarket trade history; realized P/L is estimated from buys, sells and redemption-like activity where available.",
      };
    });
}

function portfolioSummary(positions, valueRows, closedTrades = []) {
  const valueRow = Array.isArray(valueRows) ? valueRows.find((row) => String(row.user || "").toLowerCase() === ACCOUNT_ADDRESS) : null;
  const marketValue = positions.reduce((sum, item) => sum + number(item.currentValueUsdc, 0), 0);
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

async function loadClobBalanceAllowance(sync) {
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
  if (!privateKey) {
    return {
      status: "SKIPPED",
      message: "POLYMARKET_PRIVATE_KEY is not available to this workflow",
      collateral: null,
    };
  }

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
  const client = new ClobClient({
    host: CLOB_HOST,
    chain: CHAIN_ID,
    signer,
    creds,
    signatureType: signatureTypeMap[SIGNATURE_TYPE] ?? SignatureTypeV2.POLY_PROXY,
    funderAddress: ACCOUNT_ADDRESS,
  });

  const params = { asset_type: AssetType?.COLLATERAL || "COLLATERAL" };
  await client.updateBalanceAllowance(params).catch((error) => {
    sync.warnings.push(`balance-allowance update: ${error?.message || String(error)}`);
  });
  const collateral = await client.getBalanceAllowance(params);
  let openOrders = [];
  if (typeof client.getOpenOrders === "function") {
    try {
      const orders = await client.getOpenOrders();
      openOrders = Array.isArray(orders) ? orders.map(normalizeOpenOrder) : [];
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
    signatureType: SIGNATURE_TYPE,
    funderAddress: ACCOUNT_ADDRESS,
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

async function main() {
  const generatedAt = new Date().toISOString();
  const sync = {
    status: "OK",
    message: "Live Polymarket account snapshot loaded",
    sources: ["positions", "value", "activity", "trades", "public-profile", "clob-balance-allowance"],
    warnings: [],
  };

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
    optional("balance-allowance", loadClobBalanceAllowance(sync), {
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

  const positions = Array.isArray(rawPositions)
    ? rawPositions.map((position) => normalizePosition(position, generatedAt))
    : [];
  const activity = Array.isArray(rawActivity)
    ? rawActivity.map(normalizeActivity).filter((item) => item.timestamp || item.question !== "-")
    : [];
  const tradeHistory = Array.isArray(rawTrades)
    ? rawTrades.map(normalizeTradeHistoryItem).filter((item) => item.timestamp || item.question !== "-")
    : [];
  const closedTrades = closedTradesFromHistory(tradeHistory, activity, generatedAt);
  const portfolioBase = portfolioSummary(positions, valueRows, closedTrades);
  const cashUsdc = number(balanceAllowance?.collateral?.balanceUsdc);
  const equityUsdc = cashUsdc == null
    ? portfolioBase.equityUsdc
    : cashUsdc + number(portfolioBase.marketValueUsdc, 0);

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
      profile: normalizeProfile(publicProfile?.error ? null : publicProfile),
    },
    portfolio: {
      ...portfolioBase,
      equityUsdc,
      cashUsdc,
      cashSource: balanceAllowance?.status === "OK" ? "clob-balance-allowance" : null,
    },
    balanceAllowance,
    openOrders: Array.isArray(balanceAllowance?.openOrders) ? balanceAllowance.openOrders : [],
    positions,
    closedTrades,
    tradeHistory,
    activity,
    sync,
  };

  await mkdir(dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(JSON.stringify({
    mode: payload.mode,
    account: payload.account.address,
    positions: positions.length,
    openOrders: payload.openOrders.length,
    cashUsdc: payload.portfolio.cashUsdc,
    closedTrades: closedTrades.length,
    tradeHistory: tradeHistory.length,
    activity: activity.length,
    status: sync.status,
  }));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
