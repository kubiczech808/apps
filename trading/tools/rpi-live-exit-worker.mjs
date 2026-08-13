#!/usr/bin/env node

// Persistent, deliberately conservative exit monitor for the self-hosted RPi.
// It is independent of the entry/rotation workflow: it only watches existing
// positions and never opens a new one. LIVE_EXIT_MODE defaults to `shadow`.

import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CLOB_HOST = process.env.POLYMARKET_HOST || "https://clob.polymarket.com";
const CHAIN_ID = Number(process.env.POLYMARKET_CHAIN_ID || 137);
const LIVE_STATE_URL = process.env.LIVE_EXIT_LIVE_STATE_URL
  || "https://osobnizkusenosti.cz/trading/api.php?action=state&target=live";
const MODE = String(process.env.LIVE_EXIT_MODE || "shadow").trim().toLowerCase();
const POLL_INTERVAL_MS = clampInteger(process.env.LIVE_EXIT_POLL_INTERVAL_MS, 5000, 1500, 60000);
const RETRY_INTERVAL_MS = clampInteger(process.env.LIVE_EXIT_RETRY_INTERVAL_MS, 20000, 5000, 300000);
const STATE_REFRESH_MS = clampInteger(process.env.LIVE_EXIT_STATE_REFRESH_MS, 30000, 5000, 300000);
const WATCHLIST_PATH = process.env.LIVE_EXIT_WATCHLIST_PATH || ".live-exit-watchlist.json";
const STATE_PATH = process.env.LIVE_EXIT_STATE_PATH || ".live-exit-worker-state.json";
const PROTECT_ALL = enabled(process.env.LIVE_EXIT_PROTECT_ALL);
const CONFIRM_LIVE = enabled(process.env.LIVE_EXIT_CONFIRM_LIVE);
const ALLOW_PARTIAL = enabled(process.env.LIVE_EXIT_ALLOW_PARTIAL);
const FUNDER_ADDRESS = process.env.POLYMARKET_FUNDER_ADDRESS || process.env.POLYMARKET_ADDRESS || "";
const SIGNATURE_TYPE = Number(process.env.POLYMARKET_SIGNATURE_TYPE || 3);
const SYNC_COMMAND = String(process.env.LIVE_EXIT_POST_FILL_SYNC_COMMAND || "").trim();

function enabled(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function number(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampInteger(value, fallback, minimum, maximum) {
  const parsed = Math.trunc(number(value, fallback));
  return Math.min(maximum, Math.max(minimum, parsed));
}

function round(value, digits = 6) {
  const parsed = number(value);
  return parsed == null ? null : Number(parsed.toFixed(digits));
}

async function fetchJson(url, label) {
  const response = await fetch(url, {
    headers: { "accept": "application/json", "cache-control": "no-cache", "user-agent": "trading-live-exit-worker/1.0" },
  });
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status}`);
  return response.json();
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, path);
}

function feeUsdc(shares, price, feeRate, feesEnabled) {
  if (!feesEnabled || !(feeRate > 0)) return 0;
  return Math.max(0, shares * feeRate * price * (1 - price));
}

export function netExitValue({ shares, price, feeRate = 0, feesEnabled = true } = {}) {
  const size = number(shares, 0);
  const quote = number(price, 0);
  if (!(size > 0) || quote < 0 || quote > 1) return null;
  return size * quote - feeUsdc(size, quote, feeRate, feesEnabled);
}

// Solve for the lowest allowed sell price such that the loss is no greater than
// the potential net win. It is a price floor, not a promise that the book will fill.
export function equalRiskExitPlan(position = {}) {
  const shares = number(position.shares ?? position.size);
  const cost = number(position.totalCostUsdc ?? position.stakeUsdc ?? position.initialValue);
  const feeRate = number(position.feeRate, 0);
  const feesEnabled = position.feesEnabled !== false;
  const potentialWin = number(position.netGainIfWinUsdc, shares != null && cost != null ? shares - cost : null);
  if (!(shares > 0) || !(cost > 0) || potentialWin == null || potentialWin <= 0) {
    return { protectable: false, reason: "position has no positive bounded potential win" };
  }
  const minimumExitValueUsdc = Math.max(0, cost - potentialWin);
  if (minimumExitValueUsdc <= 0) {
    return { protectable: false, reason: "loss target is already fully covered", riskTargetUsdc: potentialWin };
  }
  if ((netExitValue({ shares, price: 1, feeRate, feesEnabled }) || 0) < minimumExitValueUsdc) {
    return { protectable: false, reason: "position cannot cover the risk target at any executable price", riskTargetUsdc: potentialWin };
  }
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 48; iteration += 1) {
    const midpoint = (low + high) / 2;
    if ((netExitValue({ shares, price: midpoint, feeRate, feesEnabled }) || 0) >= minimumExitValueUsdc) high = midpoint;
    else low = midpoint;
  }
  return {
    protectable: true,
    shares,
    costUsdc: cost,
    riskTargetUsdc: potentialWin,
    minimumExitValueUsdc,
    stopPrice: round(high, 6),
    feeRate,
    feesEnabled,
  };
}

export function bestBid(book = {}) {
  const bids = Array.isArray(book?.bids) ? book.bids : [];
  const prices = bids.map((row) => number(row?.price ?? row?.p)).filter((price) => price != null && price > 0);
  return prices.length ? Math.max(...prices) : null;
}

export function exitTrigger({ bestBidPrice, stopPrice } = {}) {
  const bid = number(bestBidPrice);
  const stop = number(stopPrice);
  return bid != null && stop != null && bid <= stop;
}

function livePositions(state = {}) {
  const positions = Array.isArray(state.positions) ? state.positions : [];
  return positions.filter((position) => {
    const status = String(position.status || "").toUpperCase();
    return !["CLOSED", "LOST", "WON", "REDEEM_REQUIRED", "PENDING_RESOLUTION", "SOLD"].includes(status)
      && String(position.tokenId || position.assetId || "").trim()
      && number(position.shares ?? position.size, 0) > 0;
  });
}

function watchlistEntryMap(watchlist = {}) {
  const entries = Array.isArray(watchlist.positions) ? watchlist.positions : [];
  return new Map(entries
    .filter((entry) => entry && String(entry.tokenId || "").trim())
    .map((entry) => [String(entry.tokenId), entry]));
}

function watchPlan(position, entry = null) {
  if (entry && entry.enabled === false) return null;
  const derived = equalRiskExitPlan(position);
  const configuredStop = number(entry?.stopPrice);
  const stopPrice = configuredStop != null ? configuredStop : derived.stopPrice;
  if (!derived.protectable || stopPrice == null || !(stopPrice > 0) || stopPrice >= 1) return null;
  return {
    ...derived,
    tokenId: String(position.tokenId || position.assetId),
    question: entry?.question || position.question || position.market || "Unknown market",
    outcome: entry?.outcome || position.outcome || "",
    stopPrice,
    source: configuredStop != null ? "watchlist" : "equal-risk-derived",
  };
}

async function authenticatedClient() {
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
  if (!privateKey || !FUNDER_ADDRESS) throw new Error("POLYMARKET_PRIVATE_KEY and POLYMARKET_FUNDER_ADDRESS are required for live exits");
  const [{ ClobClient, Side, OrderType, SignatureTypeV2 }, { createWalletClient, custom }, { privateKeyToAccount }] = await Promise.all([
    import("@polymarket/clob-client-v2"), import("viem"), import("viem/accounts"),
  ]);
  const account = privateKeyToAccount(privateKey);
  const signer = createWalletClient({ account, transport: custom({ request: async ({ method }) => { throw new Error(`Unexpected RPC request: ${method}`); } }) });
  const temporary = new ClobClient({ host: CLOB_HOST, chain: CHAIN_ID, signer });
  const creds = await temporary.createOrDeriveApiKey();
  const signatureTypes = { 0: SignatureTypeV2.EOA, 1: SignatureTypeV2.POLY_PROXY, 2: SignatureTypeV2.GNOSIS_SAFE, 3: SignatureTypeV2.POLY_1271 };
  const client = new ClobClient({
    host: CLOB_HOST, chain: CHAIN_ID, signer, creds,
    signatureType: signatureTypes[SIGNATURE_TYPE] ?? SignatureTypeV2.POLY_1271,
    funderAddress: FUNDER_ADDRESS,
  });
  return { client, Side, OrderType };
}

function exitFilled(response) {
  // A FOK exit is useful only after the CLOB confirms the whole order matched.
  // Treating a generic `live`/`delayed` acknowledgement as a fill would stop
  // monitoring a position that is still exposed.
  return Boolean(response?.success) && String(response?.status || "").toLowerCase() === "matched";
}

async function submitProtectedExit(plan) {
  const { client, Side, OrderType } = await authenticatedClient();
  // FOK keeps the price floor strict: the complete position is sold at this price
  // or better, or it remains intact. FAK is only an explicit opt-in because partial
  // exits complicate the remaining stop plan.
  const signed = await client.createOrder({ tokenID: plan.tokenId, price: plan.stopPrice, size: plan.shares, side: Side.SELL }, {});
  let response = await client.postOrder(signed, OrderType.FOK, false);
  if (!exitFilled(response) && ALLOW_PARTIAL) response = await client.postOrder(signed, OrderType.FAK, false);
  return response;
}

async function notifyAccountSync() {
  if (!SYNC_COMMAND) return { attempted: false };
  const [command, ...args] = SYNC_COMMAND.split(/\s+/).filter(Boolean);
  if (!command) return { attempted: false };
  try {
    await execFileAsync(command, args, { timeout: 30000 });
    return { attempted: true, ok: true };
  } catch (error) {
    return { attempted: true, ok: false, error: error?.message || String(error) };
  }
}

function recordEvent(state, event) {
  const history = Array.isArray(state.history) ? state.history : [];
  state.history = [event, ...history].slice(0, 500);
  state.lastEvent = event;
}

async function checkOnce(context) {
  const now = new Date().toISOString();
  if (!context.liveState || Date.now() - context.liveStateFetchedAt >= STATE_REFRESH_MS) {
    context.liveState = await fetchJson(`${LIVE_STATE_URL}${LIVE_STATE_URL.includes("?") ? "&" : "?"}exitWorkerAt=${Date.now()}`, "live state");
    context.liveStateFetchedAt = Date.now();
  }
  const watchlist = await readJson(WATCHLIST_PATH, { positions: [] });
  const explicitlyWatched = watchlistEntryMap(watchlist);
  const plans = livePositions(context.liveState)
    .filter((position) => PROTECT_ALL || explicitlyWatched.has(String(position.tokenId || position.assetId)))
    .map((position) => watchPlan(position, explicitlyWatched.get(String(position.tokenId || position.assetId))))
    .filter(Boolean);
  context.state.generatedAt = now;
  context.state.mode = MODE;
  context.state.protectAll = PROTECT_ALL;
  context.state.watchedPositions = plans.map((plan) => ({ tokenId: plan.tokenId, question: plan.question, outcome: plan.outcome, stopPrice: plan.stopPrice, riskTargetUsdc: plan.riskTargetUsdc, source: plan.source }));

  for (const plan of plans) {
    const pending = context.state.exits?.[plan.tokenId];
    if (pending?.terminal) continue;
    if (pending?.lastAttemptAt && Date.now() - Date.parse(pending.lastAttemptAt) < RETRY_INTERVAL_MS) continue;
    let book;
    try {
      book = await fetchJson(`${CLOB_HOST}/book?token_id=${encodeURIComponent(plan.tokenId)}`, `CLOB book ${plan.tokenId}`);
    } catch (error) {
      recordEvent(context.state, { at: now, type: "BOOK_ERROR", tokenId: plan.tokenId, question: plan.question, error: error?.message || String(error) });
      continue;
    }
    const currentBestBid = bestBid(book);
    const event = { at: now, tokenId: plan.tokenId, question: plan.question, outcome: plan.outcome, stopPrice: plan.stopPrice, bestBid: currentBestBid, riskTargetUsdc: plan.riskTargetUsdc };
    if (!exitTrigger({ bestBidPrice: currentBestBid, stopPrice: plan.stopPrice })) continue;
    if (MODE !== "live" || !CONFIRM_LIVE) {
      recordEvent(context.state, { ...event, type: "SHADOW_STOP_TRIGGERED", reason: "price reached the stop; no SELL is allowed in shadow mode" });
      continue;
    }
    let response;
    try {
      response = await submitProtectedExit(plan);
    } catch (error) {
      response = { success: false, error: error?.message || String(error) };
    }
    const accepted = exitFilled(response);
    context.state.exits = context.state.exits || {};
    context.state.exits[plan.tokenId] = { lastAttemptAt: now, terminal: accepted, orderId: response?.orderID || null, status: response?.status || null };
    const type = accepted ? "EXIT_SUBMITTED" : "EXIT_REJECTED";
    recordEvent(context.state, { ...event, type, response: { success: Boolean(response?.success), status: response?.status || null, error: response?.errorMsg || response?.error || null, orderId: response?.orderID || null } });
    if (accepted) {
      context.liveStateFetchedAt = 0;
      const sync = await notifyAccountSync();
      if (sync.attempted && !sync.ok) recordEvent(context.state, { at: new Date().toISOString(), type: "POST_EXIT_SYNC_ERROR", tokenId: plan.tokenId, error: sync.error });
    }
  }
  await writeJson(STATE_PATH, context.state);
}

async function main() {
  const context = { state: await readJson(STATE_PATH, { version: 1, history: [], exits: {} }), liveState: null, liveStateFetchedAt: 0 };
  console.log(`Live exit worker started: mode=${MODE}, protectAll=${PROTECT_ALL}, poll=${POLL_INTERVAL_MS}ms`);
  for (;;) {
    try {
      await checkOnce(context);
    } catch (error) {
      recordEvent(context.state, { at: new Date().toISOString(), type: "WORKER_ERROR", error: error?.message || String(error) });
      await writeJson(STATE_PATH, context.state).catch(() => {});
      console.error(error?.stack || error?.message || String(error));
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;
if (invokedDirectly) main().catch((error) => { console.error(error?.stack || error); process.exit(1); });
