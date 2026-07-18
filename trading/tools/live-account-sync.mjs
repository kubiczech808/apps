#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const DATA_API = process.env.POLYMARKET_DATA_API || "https://data-api.polymarket.com";
const GAMMA_API = process.env.POLYMARKET_GAMMA_API || "https://gamma-api.polymarket.com";
const DEFAULT_ADDRESS = "0x3252de913d9323667f21f4d88fa1f996fc282293";
const ACCOUNT_ADDRESS = (process.env.POLYMARKET_FUNDER_ADDRESS || process.env.POLYMARKET_ADDRESS || DEFAULT_ADDRESS).toLowerCase();
const STATE_PATH = process.env.LIVE_STATE_PATH || "data/live-state.json";
const ACTIVITY_LIMIT = Number(process.env.LIVE_ACTIVITY_LIMIT || 50);

function number(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function ratio(value) {
  const numeric = number(value);
  if (numeric == null) return null;
  return Math.abs(numeric) > 2 ? numeric / 100 : numeric;
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
    price: number(item.price),
    size: number(item.size ?? item.shares),
    usdcValue: number(item.usdcSize ?? item.value ?? item.amount),
    transactionHash: item.transactionHash || item.txHash || "",
  };
}

function portfolioSummary(positions, valueRows) {
  const valueRow = Array.isArray(valueRows) ? valueRows.find((row) => String(row.user || "").toLowerCase() === ACCOUNT_ADDRESS) : null;
  const marketValue = positions.reduce((sum, item) => sum + number(item.currentValueUsdc, 0), 0);
  const openRisk = positions.reduce((sum, item) => sum + number(item.totalCostUsdc, 0), 0);
  const openPnl = positions.reduce((sum, item) => sum + number(item.unrealizedPnlUsdc, 0), 0);
  const realizedPnl = positions.reduce((sum, item) => sum + number(item.realizedPnlUsdc, 0), 0);
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
    realizedPnlPct: openRisk > 0 ? realizedPnl / openRisk : null,
    totalPnlUsdc: totalPnl,
    totalPnlPct: openRisk > 0 ? totalPnl / openRisk : null,
  };
}

async function main() {
  const generatedAt = new Date().toISOString();
  const sync = {
    status: "OK",
    message: "Live Polymarket account snapshot loaded",
    sources: ["positions", "value", "activity", "public-profile"],
  };

  let rawPositions = [];
  let rawActivity = [];
  let valueRows = [];
  let publicProfile = null;

  try {
    [rawPositions, valueRows, rawActivity, publicProfile] = await Promise.all([
      fetchJson("/positions", { user: ACCOUNT_ADDRESS, limit: 500 }),
      fetchJson("/value", { user: ACCOUNT_ADDRESS }),
      fetchJson("/activity", { user: ACCOUNT_ADDRESS, limit: ACTIVITY_LIMIT }),
      fetchGammaJson("/public-profile", { address: ACCOUNT_ADDRESS }).catch((error) => ({ error: error.message })),
    ]);
  } catch (error) {
    sync.status = "ERROR";
    sync.message = error?.message || String(error);
  }

  const positions = Array.isArray(rawPositions)
    ? rawPositions.map((position) => normalizePosition(position, generatedAt))
    : [];
  const activity = Array.isArray(rawActivity)
    ? rawActivity.map(normalizeActivity).filter((item) => item.timestamp || item.question !== "-")
    : [];

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
    portfolio: portfolioSummary(positions, valueRows),
    positions,
    activity,
    sync,
  };

  await mkdir(dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(JSON.stringify({
    mode: payload.mode,
    account: payload.account.address,
    positions: positions.length,
    activity: activity.length,
    status: sync.status,
  }));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
