#!/usr/bin/env node

// Persistent, deliberately conservative exit monitor for the self-hosted RPi.
// It is independent of the entry/rotation workflow: it only watches existing
// positions and never opens a new one. LIVE_EXIT_MODE defaults to `shadow`.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CLOB_HOST = process.env.POLYMARKET_HOST || "https://clob.polymarket.com";
const GAMMA_API = process.env.POLYMARKET_GAMMA_API || "https://gamma-api.polymarket.com";
const CHAIN_ID = Number(process.env.POLYMARKET_CHAIN_ID || 137);
const LIVE_STATE_URL = process.env.LIVE_EXIT_LIVE_STATE_URL
  || "https://osobnizkusenosti.cz/trading/api.php?action=state&target=live";
const LIVE_EXIT_POLICY_URL = process.env.LIVE_EXIT_POLICY_URL
  || "https://osobnizkusenosti.cz/trading/api.php?action=live-exit-policy";
const LIVE_ENTRY_CLAIM_URL = process.env.LIVE_ENTRY_CLAIM_URL
  || "https://osobnizkusenosti.cz/trading/api.php?action=live-entry-claim";
const TRADING_TRIGGER_KEY = String(process.env.TRADING_TRIGGER_KEY || "").trim();
const MODE = String(process.env.LIVE_EXIT_MODE || "shadow").trim().toLowerCase();
const POLL_INTERVAL_MS = clampInteger(process.env.LIVE_EXIT_POLL_INTERVAL_MS, 5000, 1500, 60000);
const RETRY_INTERVAL_MS = clampInteger(process.env.LIVE_EXIT_RETRY_INTERVAL_MS, 20000, 5000, 300000);
// How often a position that is ONLY waiting to be closed at certainty has its book read.
// A stop needs the poll interval, because how fast the loop goes round is its reaction
// time; this does not -- a market that has settled stays settled. Capped at 15 minutes so
// the answer is never more than that stale, and defaulted well inside it.
const SETTLEMENT_SCAN_INTERVAL_MS = clampInteger(process.env.LIVE_EXIT_SETTLEMENT_SCAN_MS, 60000, 5000, 900000);
const STATE_REFRESH_MS = clampInteger(process.env.LIVE_EXIT_STATE_REFRESH_MS, 30000, 5000, 300000);
const WATCHLIST_PATH = process.env.LIVE_EXIT_WATCHLIST_PATH || ".live-exit-watchlist.json";
const STATE_PATH = process.env.LIVE_EXIT_STATE_PATH || ".live-exit-worker-state.json";
const PROTECT_ALL = enabled(process.env.LIVE_EXIT_PROTECT_ALL);
const CONFIRM_LIVE = enabled(process.env.LIVE_EXIT_CONFIRM_LIVE);
const ALLOW_PARTIAL = enabled(process.env.LIVE_EXIT_ALLOW_PARTIAL);
const FUNDER_ADDRESS = process.env.POLYMARKET_FUNDER_ADDRESS || process.env.POLYMARKET_ADDRESS || "";
const SIGNATURE_TYPE = Number(process.env.POLYMARKET_SIGNATURE_TYPE || 3);

// WHICH ACCOUNT THIS WORKER SIGNS AS.
//
// The environment above is a guess, and it was the wrong one. The workflow writes
// `secrets.POLYMARKET_FUNDER_ADDRESS || secrets.POLYMARKET_ADDRESS || <a hard-coded
// address>`, so with that secret unset the Pi signed every protective sell as
// 0x3252...2293 while the account actually being traded is 0xe219...39e2. Under signature
// type 3 the funder address is the address the order presents as its signer, and the L2
// API key belongs to the wallet -- so the CLOB refused every exit with
//
//   400 "the order signer address has to be the address of the API KEY"
//
// 106 times across 6 tokens, each left terminal:false and retried forever. Buys were
// unaffected because live-order-executor.mjs does NOT trust its environment here: its
// liveTradingConfig() reads the account configuration published in the live state. Two
// paths signing for one wallet, only one of which knew which wallet it was.
//
// So this worker reads the same published configuration, and the environment becomes what
// it should always have been -- the fallback for before the first live state arrives.
let accountTrading = {
  funderAddress: FUNDER_ADDRESS,
  signatureType: SIGNATURE_TYPE,
  source: "environment",
};

// Mirrors liveTradingConfig() in live-order-executor.mjs, deliberately: the two must
// resolve the same account from the same fields, or they can disagree again.
export function adoptAccountTradingConfig(liveState, state = null) {
  const funderAddress = String(
    liveState?.account?.trading?.funderAddress
    || liveState?.accountDiscovery?.selectedFunderAddress
    || "",
  ).trim();
  const signatureType = Number(
    liveState?.account?.trading?.signatureType
    ?? liveState?.accountDiscovery?.selectedSignatureType,
  );
  if (!funderAddress) return accountTrading;
  const next = {
    funderAddress,
    signatureType: Number.isFinite(signatureType) ? signatureType : SIGNATURE_TYPE,
    source: "live-state",
  };
  const changed = next.funderAddress.toLowerCase() !== String(accountTrading.funderAddress || "").toLowerCase()
    || next.signatureType !== accountTrading.signatureType;
  accountTrading = next;
  // Recorded once, when it moves. A worker signing as the wrong wallet produced twelve
  // hours of identical rejections and nothing anywhere said which address it was using.
  if (changed && state) {
    recordEvent(state, {
      type: "SIGNING_ACCOUNT_ADOPTED",
      funderAddress: next.funderAddress,
      signatureType: next.signatureType,
      previousFunderAddress: FUNDER_ADDRESS || null,
      previousSignatureType: SIGNATURE_TYPE,
      note: "the account published in the live state, which is what the executor signs as",
    });
  }
  if (state) state.signingAccount = { ...accountTrading };
  return accountTrading;
}

export function signingAccount() {
  return { ...accountTrading };
}

// The CLOB says this when the address an order presents as its signer is not the address
// that owns the API key. It is a configuration fault, never a market condition, so it must
// not read as one more transient rejection in a list of hundreds.
export function rejectionIsSignerMismatch(response) {
  const message = String(response?.errorMsg || response?.error || "").toLowerCase();
  return message.includes("signer address") && message.includes("api key");
}
const SYNC_COMMAND = String(process.env.LIVE_EXIT_POST_FILL_SYNC_COMMAND || "").trim();
const STOP_LOSS_REVERSAL_STAKE_USDC = 5;
// How many watched books are read at once. The books are independent reads, so this is
// bounded only to stay polite to the CLOB rather than for correctness.
const BOOK_FETCH_CONCURRENCY = clampInteger(process.env.LIVE_EXIT_BOOK_CONCURRENCY, 8, 1, 32);

// Bounded parallel map, preserving input order.
async function mapWithConcurrency(items, worker, limit = 8) {
  const list = Array.isArray(items) ? items : [];
  const width = Math.max(1, Math.min(limit, list.length));
  const results = new Array(list.length);
  let next = 0;
  await Promise.all(Array.from({ length: width }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= list.length) return;
      results[index] = await worker(list[index], index);
    }
  }));
  return results;
}
// How far through the ask side the reverse entry may pay to get filled. It is a market
// order, so it crosses the spread by design; this is what keeps "market order" from
// meaning "at any price" on a thin book.
const REVERSAL_MAX_SLIPPAGE = Number(process.env.LIVE_EXIT_REVERSAL_MAX_SLIPPAGE || 0.05);
// A reverse that did not fill is retried on later passes rather than abandoned: the stop
// has already sold, so the opposite position is still owed, and the reasons it fails are
// usually momentary.
const REVERSAL_RETRY_LIMIT = Number(process.env.LIVE_EXIT_REVERSAL_RETRY_LIMIT || 12);

function enabled(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

// `Number(null)` is 0, and 0 is finite, so an absent value used to read as a real zero.
// That is not a harmless default in a worker whose job is selling: bestBid() returns null
// for a book with no bids at all, and a stop asks "is the bid at or below the floor" -- so
// a market nobody was bidding on read as a market that had crashed through its floor. The
// Pi recorded a triggered stop for exactly that on every poll, and the only reason nothing
// was sold into an empty book is that it is in shadow mode. An absent price is unknown.
function number(value, fallback = null) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampInteger(value, fallback, minimum, maximum) {
  const parsed = Math.trunc(number(value, fallback));
  return Math.min(maximum, Math.max(minimum, parsed));
}

// Submit the strict FOK sell shortly before the floor is crossed. Waiting for a
// poll that is already below the floor guarantees a rejection in a fast book.
// The sell order itself still uses stopPrice, so this never authorizes a loss
// larger than the Equal target.
const STOP_PRETRIGGER_BUFFER = Math.min(0.02, Math.max(0, number(process.env.LIVE_EXIT_PRETRIGGER_BUFFER, 0.002)));

// How far under its floor a bid has to be before the crossing counts as gapped rather than
// happening now. A stop caps a loss by selling AT the floor; a book already trading at a
// fraction of it has jumped the floor, and the sell recovers a residue rather than
// capping anything. Both still sell -- a residue beats nothing, and refusing to sell is
// how a position goes to zero -- but they are recorded apart, because "the stop is firing"
// and "the stop was jumped hours ago" call for different reactions from the operator, and
// a shadow log that renders them identically is what made the difference invisible.
const STOP_GAP_FRACTION = Math.min(1, Math.max(0, number(process.env.LIVE_EXIT_GAP_FRACTION, 0.75)));

export function stopCrossing({ bestBidPrice, stopPrice } = {}) {
  const bid = number(bestBidPrice);
  const floor = number(stopPrice);
  if (bid == null || !(bid > 0) || floor == null || !(floor > 0)) return null;
  const recoveredFraction = bid / floor;
  return {
    bestBid: bid,
    stopPrice: floor,
    recoveredFraction: round(recoveredFraction, 6),
    gapped: recoveredFraction < STOP_GAP_FRACTION,
  };
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

async function claimLiveEntry(tokenId, claimId) {
  if (!TRADING_TRIGGER_KEY) throw new Error("live entry claim key is not configured");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(LIVE_ENTRY_CLAIM_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-trading-trigger-key": TRADING_TRIGGER_KEY,
        "user-agent": "trading-live-exit-worker/1.0",
      },
      body: JSON.stringify({
        operation: "claim",
        tokenId: String(tokenId),
        side: "BUY",
        portfolioId: "live-stop-loss",
        claimId,
      }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload?.ok) throw new Error(`live entry claim: HTTP ${response.status}`);
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

async function settleLiveEntryClaim(operation, tokenId, claimId) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(LIVE_ENTRY_CLAIM_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-trading-trigger-key": TRADING_TRIGGER_KEY,
          "user-agent": "trading-live-exit-worker/1.0",
        },
        body: JSON.stringify({ operation, tokenId: String(tokenId), side: "BUY", portfolioId: "live-stop-loss", claimId }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    // A missed confirmation leaves a conservative claim behind; it must never turn
    // a successful CLOB order into a second order merely because bookkeeping timed out.
    console.warn(`Live entry claim ${operation} failed for ${tokenId}: ${error?.message || String(error)}`);
  }
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

function normalizeStopLossRiskMultiplier(value, fallback = 1) {
  const numeric = number(value);
  if (numeric == null) return fallback;
  return Math.max(0, Math.min(3, round(numeric, 2)));
}

export function netExitValue({ shares, price, feeRate = 0, feesEnabled = true } = {}) {
  const size = number(shares, 0);
  const quote = number(price, 0);
  if (!(size > 0) || quote < 0 || quote > 1) return null;
  return size * quote - feeUsdc(size, quote, feeRate, feesEnabled);
}

// Solve for the lowest allowed sell price such that the loss is no greater than the
// configured multiple of the potential net win. It is a price floor, not a promise
// that the book will fill.
export function equalRiskExitPlan(position = {}) {
  const shares = number(position.shares ?? position.size);
  const cost = number(position.totalCostUsdc ?? position.stakeUsdc ?? position.initialValue);
  const feeRate = number(position.feeRate, 0);
  const feesEnabled = position.feesEnabled !== false;
  const potentialWin = number(position.netGainIfWinUsdc, shares != null && cost != null ? shares - cost : null);
  if (!(shares > 0) || !(cost > 0) || potentialWin == null || potentialWin <= 0) {
    return { protectable: false, reason: "position has no positive bounded potential win" };
  }
  const riskMultiplier = normalizeStopLossRiskMultiplier(position.stopLossRiskMultiplier, 1);
  const riskTargetUsdc = number(position.riskTargetUsdc, Math.min(cost, potentialWin * riskMultiplier));
  if (!(riskTargetUsdc > 0)) {
    return { protectable: false, reason: "position stop-loss multiplier is disabled" };
  }
  const minimumExitValueUsdc = Math.max(0, cost - riskTargetUsdc);
  if (minimumExitValueUsdc <= 0) {
    return { protectable: false, reason: "loss target is already fully covered", riskTargetUsdc };
  }
  if ((netExitValue({ shares, price: 1, feeRate, feesEnabled }) || 0) < minimumExitValueUsdc) {
    return { protectable: false, reason: "position cannot cover the risk target at any executable price", riskTargetUsdc };
  }
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 48; iteration += 1) {
    const midpoint = (low + high) / 2;
    if ((netExitValue({ shares, price: midpoint, feeRate, feesEnabled }) || 0) >= minimumExitValueUsdc) high = midpoint;
    else low = midpoint;
  }
  const stopPrice = round(high, 6);
  // A floor at or above what the position cost is not a stop loss. It cannot cap a loss --
  // it liquidates at the entry price the moment it is armed, which is the opposite of
  // protection.
  //
  // Measured live: four positions in four different markets were sold within the same
  // second, every one of them at 0.67-0.70 against an entry of 0.7028, every one carrying
  // stopPrice 0.704193 and riskTargetUsdc 0.040192. A four-cent risk target on a 4.92 stake
  // puts the floor a tenth of a percent ABOVE the entry, so the first book read sold them
  // all. However the multiplier came to be that small -- a mis-entered setting reaches this
  // code the same way a bug does -- the plan it produces is not one this worker should ever
  // act on, and refusing it here is what makes that true for every source of the number.
  const entryPrice = shares > 0 ? cost / shares : null;
  if (entryPrice != null && stopPrice >= entryPrice) {
    return {
      protectable: false,
      reason: `stop floor ${stopPrice.toFixed(4)} is not below the ${entryPrice.toFixed(4)} entry price,`
        + ` so it would liquidate at entry rather than cap a loss`
        + ` (risk target ${riskTargetUsdc.toFixed(4)} USDC on a ${cost.toFixed(2)} USDC position)`,
      riskTargetUsdc,
      stopPrice,
      entryPrice: round(entryPrice, 6),
    };
  }
  return {
    protectable: true,
    shares,
    costUsdc: cost,
    riskTargetUsdc,
    stopLossRiskMultiplier: riskMultiplier,
    minimumExitValueUsdc,
    stopPrice,
    entryPrice: entryPrice == null ? null : round(entryPrice, 6),
    feeRate,
    feesEnabled,
  };
}

export function bestBid(book = {}) {
  const bids = Array.isArray(book?.bids) ? book.bids : [];
  const prices = bids.map((row) => number(row?.price ?? row?.p)).filter((price) => price != null && price > 0);
  return prices.length ? Math.max(...prices) : null;
}

// A stop fires on a bid that has fallen to the floor. Two things are deliberately not that,
// even though both compare as "at or below" any floor:
//
//   * no bid at all -- nobody is buying, so there is nothing to sell into. Selling here
//     cannot cap a loss; it can only put a market order into a vacuum.
//   * a bid of zero -- the same thing quoted rather than absent.
//
// Both are stated as their own condition rather than left to the null check, because the
// null check alone has already failed once: number() coerced a missing bid to 0 and every
// bidless market read as a triggered stop.
export function exitTrigger({ bestBidPrice, stopPrice, triggerPrice = stopPrice, bestAskPrice = null } = {}) {
  const bid = number(bestBidPrice);
  const floor = number(stopPrice);
  const trigger = number(triggerPrice);
  if (bid == null || !(bid > 0)) return false;
  if (floor == null || trigger == null || bid > trigger) return false;
  // The bid alone is not the price. On these markets it is routinely not even close to it:
  // an illiquid first-half total at kickoff has no real bid side, just whatever lowball
  // order somebody left resting.
  //
  // Measured live on "Avispa Fukuoka vs. FC Mito Holly Hock: 1st Half O/U 1.5". Four
  // minutes after kickoff, 0-0, holding Under 1.5 bought at 0.70, the best bid read 0.10.
  // The stop fired, sold 7 shares at 0.096, and the market resolved Under at 1.00. In the
  // same window a neighbouring market's bid bounced 0.13, 0.07, 0.06, 0.12, 0.06, 0.01
  // within four minutes -- that is not a price series, it is an empty book.
  //
  // So the other side has to agree. Where both sides are quoted the midpoint decides: on a
  // healthy book bid, ask and mid are within a tick of each other and nothing changes,
  // while a 0.10 bid against a 0.90 ask puts the mid at 0.50 and says the market has not
  // moved against us at all. A genuinely collapsing outcome fails no test here, because
  // its ask collapses too -- bid 0.01 against ask 0.05 is a mid of 0.03, still through the
  // floor, and that exit still fires.
  const ask = number(bestAskPrice);
  // No ask at all means nobody is offering, which the midpoint cannot describe. The bid
  // stands alone there, as it always has.
  if (ask == null || !(ask > 0)) return true;
  return (bid + ask) / 2 <= trigger;
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

export function bestAsk(book = {}) {
  const asks = Array.isArray(book?.asks) ? book.asks : [];
  const prices = asks.map((row) => number(row?.price ?? row?.p)).filter((price) => price != null && price > 0);
  return prices.length ? Math.min(...prices) : null;
}

// The price a BUY must be willing to pay to actually take the size it wants, as opposed to
// the price at the very top of the book.
//
// The reverse-after-stop entry is specified as a market order: once the stop has fired, the
// opposite position opens. It was being priced at exactly bestAsk and posted FOK, which
// fills only if the entire order sits at that one price level at the instant it lands -- so
// a top level thinner than the order, or one tick of movement, killed it and no position
// opened at all.
//
// Walking the asks answers the question a market order actually asks: consume levels in
// price order until the notional is covered, and be willing to pay the level that finishes
// the fill. maxSlippage bounds it, because "market order" is not "at any price": beyond
// that the entry is refused rather than paying an arbitrary premium for a small position.
export function marketableBuyPrice({ book = {}, notionalUsdc, maxSlippage = 0.05 } = {}) {
  const need = number(notionalUsdc);
  if (need == null || !(need > 0)) return null;
  const levels = (Array.isArray(book?.asks) ? book.asks : [])
    .map((row) => ({ price: number(row?.price ?? row?.p), size: number(row?.size ?? row?.s) }))
    .filter((level) => level.price != null && level.price > 0 && level.price < 1
      && level.size != null && level.size > 0)
    .sort((left, right) => left.price - right.price);
  if (!levels.length) return null;
  const slip = number(maxSlippage);
  // Kept below 1: at 1.00 the outcome cannot profit at all.
  const ceiling = Math.min(0.99, levels[0].price + Math.max(0, slip == null ? 0 : slip));
  let filled = 0;
  for (const level of levels) {
    if (level.price > ceiling) break;
    filled += level.price * level.size;
    if (filled + 0.000001 >= need) return level.price;
  }
  // Not enough depth inside the cap to cover the whole stake. That is not a reason to place
  // nothing -- a smaller position is still the position this rule asks for -- so the
  // deepest price still within the cap is returned and the size is fitted to it.
  const affordable = levels.filter((level) => level.price <= ceiling);
  return affordable.length ? affordable[affordable.length - 1].price : null;
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function oppositeBinaryToken(market = {}, tokenId = "") {
  const tokens = parseJsonArray(market.clobTokenIds).map((value) => String(value));
  const outcomes = parseJsonArray(market.outcomes).map((value) => String(value));
  const index = tokens.indexOf(String(tokenId));
  if (tokens.length !== 2 || outcomes.length !== 2 || index < 0) {
    return { eligible: false, reason: "position is not in a two-outcome market" };
  }
  const oppositeIndex = index === 0 ? 1 : 0;
  if (!tokens[oppositeIndex] || tokens[oppositeIndex] === String(tokenId)) {
    return { eligible: false, reason: "market has no distinct opposite token" };
  }
  return { eligible: true, tokenId: tokens[oppositeIndex], outcome: outcomes[oppositeIndex] || "Opposite outcome" };
}

function remotePolicyMap(payload = {}) {
  const rows = Array.isArray(payload?.policies) ? payload.policies : [];
  return new Map(rows
    .filter((entry) => entry && entry.enabled !== false && String(entry.tokenId || "").trim())
    .map((entry) => [String(entry.tokenId), {
      ...entry,
      source: `portfolio:${String(entry.portfolioId || "live")}`,
    }]));
}

function defaultRemotePolicy(payload = {}) {
  const policy = payload?.defaultPolicy;
  if (!policy || policy.enabled === false || !(number(policy.stopLossRiskMultiplier, 0) > 0)) return null;
  return { ...policy, source: `portfolio:${String(policy.portfolioId || "live")}:default` };
}

// Positions the server says to leave alone, because the portfolio that opened them is
// switched off, archived, or has no stop loss configured. This has to be an explicit list:
// defaultPolicy covers every position NOT named in `policies`, so omitting a token is not a
// way to leave it unprotected -- it is a way to give it the main portfolio's stop instead.
// Turning a portfolio off has to stop its exits too, or the switch does not mean what it says.
export function excludedRemoteTokens(payload = {}) {
  const rows = Array.isArray(payload?.excluded) ? payload.excluded : [];
  return new Map(rows
    .filter((entry) => entry && String(entry.tokenId || "").trim())
    .map((entry) => [String(entry.tokenId), {
      portfolioId: String(entry.portfolioId || ""),
      reason: String(entry.reason || "its portfolio has no active stop loss"),
    }]));
}

// The bid at which a position is sold rather than held to settlement, or null for off.
//
// A market that has already decided still takes hours to resolve on Polymarket, and the
// stake is locked for all of it. Selling one tick below certainty pays about a cent a share
// to get that capital back now, which is the whole point of the setting.
//
// Bounded the same way the API bounds it, because a local watchlist can also carry one and
// nothing else would check it.
function settlementCloseBid(entry = null) {
  const bid = number(entry?.settlementCloseBid);
  if (bid == null || !(bid > 0)) return null;
  return Math.max(0.5, Math.min(0.999, bid));
}

export function watchPlan(position, entry = null) {
  if (entry && entry.enabled === false) return null;
  const derived = equalRiskExitPlan(position);
  const configuredStop = number(entry?.stopPrice);
  // A policy that exists only for the settlement close carries a 0 multiplier, and reading
  // the derived stop from it would invent one. stopLossEnabled says which it is.
  const stopIsConfigured = entry?.stopLossEnabled !== false;
  const candidateStop = configuredStop != null ? configuredStop : (stopIsConfigured ? derived.stopPrice : null);
  const stopPrice = derived.protectable && candidateStop != null && candidateStop > 0 && candidateStop < 1
    ? candidateStop
    : null;
  const closeBid = settlementCloseBid(entry);
  // Either reason is enough to watch the position. Requiring a stop here is what would keep
  // a portfolio that only wants its settled positions closed early from being watched at
  // all -- the books below are read for exactly what this returns.
  if (stopPrice == null && closeBid == null) return null;
  return {
    ...derived,
    tokenId: String(position.tokenId || position.assetId),
    question: entry?.question || position.question || position.market || "Unknown market",
    outcome: entry?.outcome || position.outcome || "",
    stopPrice,
    triggerPrice: stopPrice == null ? null : round(Math.min(0.999999, stopPrice + STOP_PRETRIGGER_BUFFER), 6),
    settlementCloseBid: closeBid,
    reverseOnStopLoss: entry?.reverseOnStopLoss === true,
    reverseStakeUsdc: STOP_LOSS_REVERSAL_STAKE_USDC,
    source: entry?.source || (configuredStop != null ? "watchlist" : "equal-risk-derived"),
  };
}

// Which rule, if either, wants this position sold at the current bid.
//
// The stop is checked first: both can be true only in a market that has moved from a loss
// to certainty within one pass, and a stop that has been reached is the more urgent of the
// two. Returns null when neither applies.
export function exitReason({ bestBidPrice, bestAskPrice = null, stopPrice, triggerPrice, settlementCloseBid: closeBid } = {}) {
  if (stopPrice != null && exitTrigger({ bestBidPrice, bestAskPrice, stopPrice, triggerPrice })) return "stop";
  const bid = number(bestBidPrice);
  if (closeBid != null && bid != null && bid >= closeBid) return "settlement";
  return null;
}

async function authenticatedClient() {
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
  const funderAddress = accountTrading.funderAddress;
  const signatureType = accountTrading.signatureType;
  if (!privateKey || !funderAddress) throw new Error("POLYMARKET_PRIVATE_KEY and POLYMARKET_FUNDER_ADDRESS are required for live exits");
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
    signatureType: signatureTypes[signatureType] ?? SignatureTypeV2.POLY_1271,
    funderAddress,
  });
  return { client, Side, OrderType };
}

function exitFilled(response) {
  // A FOK exit is useful only after the CLOB confirms the whole order matched.
  // Treating a generic `live`/`delayed` acknowledgement as a fill would stop
  // monitoring a position that is still exposed.
  return Boolean(response?.success) && String(response?.status || "").toLowerCase() === "matched";
}

// What the CLOB enforces on every order and this worker was never asking about: prices must
// sit on the market's tick grid, and a neg-risk market must be declared as one. The executor
// has always read both (see roundToTick and the tickSize/negRisk options it passes); this
// worker sent a raw price and an empty options object.
async function exchangeConstraintsForToken(tokenId) {
  try {
    const market = await marketForToken(tokenId);
    const tick = number(market?.orderPriceMinTickSize);
    return {
      tickSize: tick != null && tick > 0 ? tick : 0.01,
      negRisk: typeof market?.negRisk === "boolean" ? market.negRisk : undefined,
    };
  } catch {
    // A market lookup that fails must not stop the exit. 0.01 is the CLOB's ordinary tick
    // and is a valid multiple of every finer one, so an order priced on it stays valid.
    return { tickSize: 0.01, negRisk: undefined };
  }
}

export function roundToTick(value, tick, direction = "nearest") {
  const price = number(value);
  const step = number(tick);
  if (price == null || step == null || !(step > 0)) return price;
  const scale = Math.round(1 / step);
  if (!Number.isFinite(scale) || scale <= 0) return price;
  const raw = price * scale;
  const rounded = direction === "down" ? Math.floor(raw) : direction === "up" ? Math.ceil(raw) : Math.round(raw);
  return Number((rounded / scale).toFixed(String(step).split(".")[1]?.length || 4));
}

// The price a protective SELL has to carry to actually leave the position.
//
// Two things were wrong and both had to be, because every rejected exit showed both.
//
// The price was the raw binary-search floor, rounded to six decimals: 0.129981. The CLOB
// prices on a tick grid, so that is not a price at all and the order came back 400 --
// eleven times in eleven minutes on one position, and every one of the six tokens the
// worker had ever tried to exit sat at status 400 with no order id. That is the whole of
// "the stop loss does not work": it fired every time and was refused every time.
//
// And the floor is not where the position can be sold once the book has moved through it.
// In every one of those events the best bid (0.07 to 0.10) was already BELOW the 0.13
// floor, so even a validly priced sell at the floor could never have matched. A stop that
// insists on its floor after the market has gapped past it does not cap the loss, it just
// stops selling -- and the position keeps falling. Selling into the gap is what the paper
// model already books as FILLED_AFTER_GAP, so this is also what makes the two agree.
export function protectedExitPrice({ stopPrice, bestBidPrice, tickSize = 0.01 } = {}) {
  const floor = roundToTick(stopPrice, tickSize, "down");
  const bid = number(bestBidPrice);
  // No floor at all is the settlement close: nothing is being protected, the point is to
  // take the bid the market is already showing. Any floor here would price the sell under a
  // book quoting near certainty.
  if (floor == null) {
    if (bid == null || !(bid > 0)) return null;
    const atBid = roundToTick(bid, tickSize, "down");
    return atBid != null && atBid > 0 ? atBid : null;
  }
  // Below the floor the book has gapped; sell where the buyers actually are.
  if (bid != null && bid > 0 && bid < floor) {
    const gapped = roundToTick(bid, tickSize, "down");
    return gapped != null && gapped > 0 ? gapped : null;
  }
  return floor > 0 ? floor : null;
}

async function submitProtectedExit(plan, { bestBidPrice = null } = {}) {
  const { client, Side, OrderType } = await authenticatedClient();
  const constraints = await exchangeConstraintsForToken(plan.tokenId);
  const price = protectedExitPrice({
    stopPrice: plan.stopPrice,
    bestBidPrice,
    tickSize: constraints.tickSize,
  });
  if (price == null || !(price > 0)) {
    return { success: false, error: "no valid exit price on this market's tick grid" };
  }
  const options = { tickSize: String(constraints.tickSize) };
  // Only when it is actually known. Turning "unknown" into a confident false is what
  // deadlocked neg-risk exits in the executor, and the same trap is here.
  if (typeof constraints.negRisk === "boolean") options.negRisk = constraints.negRisk;
  // FOK keeps the price floor strict: the complete position is sold at this price
  // or better, or it remains intact. FAK is only an explicit opt-in because partial
  // exits complicate the remaining stop plan.
  const signed = await client.createOrder({ tokenID: plan.tokenId, price, size: plan.shares, side: Side.SELL }, options);
  let response = await client.postOrder(signed, OrderType.FOK, false);
  if (!exitFilled(response) && ALLOW_PARTIAL) response = await client.postOrder(signed, OrderType.FAK, false);
  return { ...response, exitPrice: price, tickSize: constraints.tickSize };
}

async function marketForToken(tokenId) {
  const url = new URL(`${GAMMA_API}/markets`);
  url.searchParams.append("clob_token_ids", String(tokenId));
  url.searchParams.set("closed", "false");
  const markets = await fetchJson(url, `Gamma market for token ${tokenId}`);
  return Array.isArray(markets) ? markets[0] || null : null;
}

async function submitStopLossReversal(plan) {
  const market = await marketForToken(plan.tokenId);
  if (!market || market.closed || market.acceptingOrders === false) {
    return { success: false, reversal: null, error: "opposite market is no longer accepting orders" };
  }
  const opposite = oppositeBinaryToken(market, plan.tokenId);
  if (!opposite.eligible) return { success: false, reversal: null, error: opposite.reason };
  const book = await fetchJson(`${CLOB_HOST}/book?token_id=${encodeURIComponent(opposite.tokenId)}`, `CLOB opposite book ${opposite.tokenId}`);
  // Marketable, not top-of-book: this entry is specified as a market order, so it has to be
  // willing to pay through the levels its own size consumes. See marketableBuyPrice.
  const price = marketableBuyPrice({
    book,
    notionalUsdc: STOP_LOSS_REVERSAL_STAKE_USDC,
    maxSlippage: REVERSAL_MAX_SLIPPAGE,
  });
  if (!(price > 0) || price >= 1) {
    return { success: false, reversal: { ...opposite }, error: "opposite outcome has no executable ask" };
  }
  // The quoted stake is principal. Fees remain exchange fees on top, exactly like the
  // normal taker entry path; rounding down avoids sending a quote value above the stake.
  const shares = Math.floor((STOP_LOSS_REVERSAL_STAKE_USDC / price) * 10000) / 10000;
  if (!(shares > 0)) return { success: false, reversal: { ...opposite, price }, error: "opposite order size is below the exchange minimum" };
  const claimId = randomUUID();
  const claim = await claimLiveEntry(opposite.tokenId, claimId);
  if (!claim.claimed) {
    return {
      success: false,
      reversal: { ...opposite, price: round(price, 6), shares: round(shares, 4), stakeUsdc: STOP_LOSS_REVERSAL_STAKE_USDC },
      error: `duplicate entry guard: ${claim.reason || "an equivalent live buy is already claimed"}`,
    };
  }
  const { client, Side, OrderType } = await authenticatedClient();
  const signed = await client.createOrder({ tokenID: opposite.tokenId, price, size: shares, side: Side.BUY }, {});
  // FAK, not FOK. The protective SELL uses FOK deliberately, because a partial exit leaves
  // a position with a stop plan that no longer matches it. This is the opposite case: the
  // rule asks for a position to be opened, and a smaller one is still that position. FOK
  // turned every shortfall in depth into no position at all.
  let response = await client.postOrder(signed, OrderType.FAK, false);
  // A venue that will not take FAK is not a reason to place nothing.
  if (!exitFilled(response)) response = await client.postOrder(signed, OrderType.FOK, false);
  if (exitFilled(response)) await settleLiveEntryClaim("confirm", opposite.tokenId, claimId);
  else await settleLiveEntryClaim("release", opposite.tokenId, claimId);
  return {
    ...response,
    reversal: { ...opposite, price: round(price, 6), shares: round(shares, 4), stakeUsdc: STOP_LOSS_REVERSAL_STAKE_USDC },
  };
}

// The same failures the paper bot treats as final: the opposite side cannot be bought at
// all, so no number of retries changes it. Everything else is a condition of one moment.
const TERMINAL_REVERSAL_PATTERNS = [
  /no longer accepting orders/i,
  /not in a two-outcome market/i,
  /no distinct opposite token/i,
];

export function reversalFailureIsTerminal(reason) {
  const text = String(reason || "");
  return TERMINAL_REVERSAL_PATTERNS.some((pattern) => pattern.test(text));
}

// One attempt at an owed reverse, from wherever it is called: right after the stop filled,
// or on a later pass from the pending list. Clears the entry once the position exists, or
// once the market says it never will.
async function attemptPendingReversal(context, tokenId, event = {}) {
  const pending = context.state.pendingReversals?.[tokenId];
  if (!pending) return;
  const now = new Date().toISOString();
  let reversal;
  try {
    reversal = await submitStopLossReversal(pending.plan);
  } catch (error) {
    reversal = { success: false, error: error?.message || String(error) };
  }
  const accepted = exitFilled(reversal);
  const reason = reversal?.errorMsg || reversal?.error || null;
  pending.attempts = Number(pending.attempts || 0) + 1;
  pending.lastAttemptAt = now;
  pending.lastError = accepted ? null : reason;
  const exhausted = pending.attempts >= REVERSAL_RETRY_LIMIT;
  const terminal = accepted || reversalFailureIsTerminal(reason) || exhausted;
  recordEvent(context.state, {
    ...event,
    at: now,
    tokenId,
    question: pending.plan.question,
    outcome: pending.plan.outcome,
    type: accepted ? "STOP_REVERSAL_SUBMITTED" : (terminal ? "STOP_REVERSAL_REJECTED" : "STOP_REVERSAL_RETRY"),
    reverseStakeUsdc: STOP_LOSS_REVERSAL_STAKE_USDC,
    reverseAttempt: pending.attempts,
    reversal: reversal?.reversal || null,
    response: {
      success: Boolean(reversal?.success),
      status: reversal?.status || null,
      error: reason,
      orderId: reversal?.orderID || null,
    },
  });
  if (terminal) delete context.state.pendingReversals[tokenId];
}

// Reverses still owed from an earlier pass. Run before the plans below, because the
// position that triggered them is already sold and nothing in the plan list represents it.
async function retryPendingReversals(context) {
  const pendingIds = Object.keys(context.state.pendingReversals || {});
  for (const tokenId of pendingIds) {
    if (MODE !== "live" || !CONFIRM_LIVE) continue;
    await attemptPendingReversal(context, tokenId);
  }
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

// The same book failing on every 5s pass wrote one event per pass. Measured on the Pi:
// 389 of the 500 retained events were BOOK_ERROR, nearly all of them one market repeating
// the same message, and they had pushed every exit rejection and the worker's own startup
// out of the window. A history that can only show the last forty minutes of one broken
// market cannot answer what the stop loss did.
//
// So a repeat of the same message for the same token updates a counter instead of adding a
// row. The first occurrence is still recorded immediately -- this collapses noise, it does
// not delay the signal.
function recordBookError(state, plan, error, at) {
  const message = error?.message || String(error);
  state.bookErrors = state.bookErrors || {};
  const previous = state.bookErrors[plan.tokenId];
  const repeated = previous && previous.error === message;
  state.bookErrors[plan.tokenId] = {
    question: plan.question,
    error: message,
    firstAt: repeated ? previous.firstAt : at,
    lastAt: at,
    count: repeated ? (Number(previous.count) || 1) + 1 : 1,
  };
  if (repeated) return;
  recordEvent(state, { at, type: "BOOK_ERROR", tokenId: plan.tokenId, question: plan.question, error: message });
}

function recordEvent(state, event) {
  const history = Array.isArray(state.history) ? state.history : [];
  state.history = [event, ...history].slice(0, 500);
  state.lastEvent = event;
}

async function checkOnce(context) {
  const now = new Date().toISOString();
  // Before anything else, because these are owed positions whose own plan is gone: the
  // protective SELL already matched, so the position no longer appears in the live state
  // the plans below are built from.
  await retryPendingReversals(context);
  if (!context.liveState || Date.now() - context.liveStateFetchedAt >= STATE_REFRESH_MS) {
    context.liveState = await fetchJson(`${LIVE_STATE_URL}${LIVE_STATE_URL.includes("?") ? "&" : "?"}exitWorkerAt=${Date.now()}`, "live state");
    context.liveStateFetchedAt = Date.now();
    // The same state that lists the positions also says which account holds them. Adopting
    // it here means the worker signs as that account rather than as whatever address its
    // environment happened to carry.
    adoptAccountTradingConfig(context.liveState, context.state);
  }
  if (!context.policyState || Date.now() - context.policyStateFetchedAt >= STATE_REFRESH_MS) {
    try {
      context.policyState = await fetchJson(`${LIVE_EXIT_POLICY_URL}${LIVE_EXIT_POLICY_URL.includes("?") ? "&" : "?"}exitWorkerAt=${Date.now()}`, "live exit policy");
      context.policyStateFetchedAt = Date.now();
      context.policyError = null;
    } catch (error) {
      // A policy read must never stop the worker from honoring a local emergency
      // watchlist. Keep the last valid policy briefly and expose the error in its
      // local state for diagnosis.
      context.policyError = error?.message || String(error);
      context.policyStateFetchedAt = Date.now();
    }
  }
  const watchlist = await readJson(WATCHLIST_PATH, { positions: [] });
  const explicitlyWatched = watchlistEntryMap(watchlist);
  const remotePolicies = remotePolicyMap(context.policyState);
  const fallbackPolicy = defaultRemotePolicy(context.policyState);
  const excludedTokens = excludedRemoteTokens(context.policyState);
  const plans = livePositions(context.liveState)
    .map((position) => {
      const tokenId = String(position.tokenId || position.assetId || "");
      // An exclusion outranks PROTECT_ALL and the local watchlist alike. Those say "watch
      // everything I can see"; this says the owner of this particular position has its
      // automation off, and a switched-off portfolio must not have an exit fired for it.
      if (excludedTokens.has(tokenId)) return null;
      const remotePolicy = remotePolicies.get(tokenId) || fallbackPolicy;
      const localWatch = explicitlyWatched.get(tokenId);
      if (!PROTECT_ALL && !localWatch && !remotePolicy) return null;
      // A local watchlist may set a one-off price floor, but the portfolio's risk
      // multiplier remains the source of truth unless a person explicitly adds one.
      const entry = localWatch ? { ...remotePolicy, ...localWatch } : remotePolicy;
      const policyPosition = remotePolicy
        ? { ...position, stopLossRiskMultiplier: remotePolicy.stopLossRiskMultiplier }
        : position;
      return watchPlan(policyPosition, entry);
    })
    .filter(Boolean);
  context.state.generatedAt = now;
  context.state.mode = MODE;
  context.state.protectAll = PROTECT_ALL;
  context.state.policyUrl = LIVE_EXIT_POLICY_URL;
  context.state.policyError = context.policyError || null;
  context.state.watchedPositions = plans.map((plan) => ({ tokenId: plan.tokenId, question: plan.question, outcome: plan.outcome, stopPrice: plan.stopPrice, triggerPrice: plan.triggerPrice, settlementCloseBid: plan.settlementCloseBid, riskTargetUsdc: plan.riskTargetUsdc, reverseOnStopLoss: plan.reverseOnStopLoss, source: plan.source }));
  // What is deliberately NOT watched, and why. A position missing from the watch list is
  // otherwise indistinguishable from one the worker failed to notice, which is the whole
  // difficulty this file has been debugged for twice.
  context.state.excludedPositions = livePositions(context.liveState)
    .map((position) => {
      const tokenId = String(position.tokenId || position.assetId || "");
      const exclusion = excludedTokens.get(tokenId);
      return exclusion ? { tokenId, question: position.question || position.market || "", outcome: position.outcome || "", ...exclusion } : null;
    })
    .filter(Boolean);

  // Every watched book is read AT ONCE, and only then are the triggers acted on.
  //
  // Polymarket has no stop order: a resting SELL priced below the current bid is
  // immediately marketable and fills straight away, so a stop cannot be left sitting on the
  // exchange. Detection therefore happens here, and how fast this loop goes round IS the
  // stop's reaction time.
  //
  // It used to read the books one after another, each awaited before the next began, and
  // submit an exit in the middle of that queue. With seventeen open positions the last one
  // was looked at seventeen round trips after the first, and a single exit -- an order
  // submission plus a possible reverse -- blocked every position behind it. Prices on a
  // resolving event move in seconds, so that queue was the stop's real latency, not the
  // poll interval.
  //
  // Reading them together makes one pass cost about one round trip instead of N.
  context.settlementScannedAt = context.settlementScannedAt || new Map();
  const candidates = plans.filter((plan) => {
    const pending = context.state.exits?.[plan.tokenId];
    if (pending?.terminal) return false;
    if (pending?.lastAttemptAt && Date.now() - Date.parse(pending.lastAttemptAt) < RETRY_INTERVAL_MS) return false;
    // A plan with a stop keeps the five-second cadence: how fast this loop goes round is
    // the stop's reaction time. A plan that is only waiting for the market to price its
    // outcome as certain does not need that -- a settled market stays settled -- so it is
    // read on its own slower interval rather than adding a book fetch every pass.
    if (plan.stopPrice == null) {
      const last = context.settlementScannedAt.get(plan.tokenId) || 0;
      if (Date.now() - last < SETTLEMENT_SCAN_INTERVAL_MS) return false;
      context.settlementScannedAt.set(plan.tokenId, Date.now());
    }
    return true;
  });
  const observed = await mapWithConcurrency(candidates, async (plan) => {
    try {
      return { plan, book: await fetchJson(`${CLOB_HOST}/book?token_id=${encodeURIComponent(plan.tokenId)}`, `CLOB book ${plan.tokenId}`) };
    } catch (error) {
      return { plan, error };
    }
  }, BOOK_FETCH_CONCURRENCY);

  for (const { plan, book, error: bookError } of observed) {
    if (bookError) {
      recordBookError(context.state, plan, bookError, now);
      continue;
    }
    const currentBestBid = bestBid(book);
    const currentBestAsk = bestAsk(book);
    const crossing = stopCrossing({ bestBidPrice: currentBestBid, stopPrice: plan.stopPrice });
    const event = {
      at: now,
      tokenId: plan.tokenId,
      question: plan.question,
      outcome: plan.outcome,
      stopPrice: plan.stopPrice,
      triggerPrice: plan.triggerPrice,
      bestBid: currentBestBid,
      // Recorded because the bid alone could not tell a collapsing market from an empty
      // book, and without them there was no way to tell afterwards which one had sold.
      bestAsk: currentBestAsk,
      midPrice: currentBestBid != null && currentBestAsk != null
        ? round((currentBestBid + currentBestAsk) / 2, 6)
        : null,
      riskTargetUsdc: plan.riskTargetUsdc,
      // Whether the stop is firing now or the book jumped it long ago. Recorded on every
      // event, so a shadow log answers "what would arming this actually sell, and at what
      // price" without anyone having to re-derive it from the bid.
      crossing: crossing ? { recoveredFraction: crossing.recoveredFraction, gapped: crossing.gapped } : null,
    };
    const reason = exitReason({
      bestBidPrice: currentBestBid,
      bestAskPrice: currentBestAsk,
      stopPrice: plan.stopPrice,
      triggerPrice: plan.triggerPrice,
      settlementCloseBid: plan.settlementCloseBid,
    });
    if (!reason) continue;
    event.reasonKind = reason;
    if (reason === "settlement") event.settlementCloseBid = plan.settlementCloseBid;
    if (MODE !== "live" || !CONFIRM_LIVE) {
      recordEvent(context.state, {
        ...event,
        type: reason === "settlement" ? "SHADOW_SETTLEMENT_CLOSE" : "SHADOW_STOP_TRIGGERED",
        reason: reason === "settlement"
          ? `the bid is ${currentBestBid} at or above the ${plan.settlementCloseBid} settlement close; no SELL is allowed in shadow mode`
          : crossing?.gapped
            ? `the book is already at ${(crossing.recoveredFraction * 100).toFixed(0)}% of the stop, so this sells a residue rather than capping the loss; no SELL is allowed in shadow mode`
            : "price reached the stop; no SELL is allowed in shadow mode",
      });
      continue;
    }
    let response;
    try {
      // The books above were read together, so by the time this position's turn comes the
      // bid can be a second or two old -- and on a resolving event that is enough to price
      // an exit where nobody is buying any more. One fresh read, only on the rare path
      // where a stop has actually fired.
      //
      // It re-prices, it does not re-decide. A stop that has triggered sells; letting a
      // momentary tick back above the trigger cancel it is how a stop ends up never
      // selling at all in a falling book.
      let exitBid = currentBestBid;
      try {
        const fresh = await fetchJson(`${CLOB_HOST}/book?token_id=${encodeURIComponent(plan.tokenId)}`, `CLOB book ${plan.tokenId}`);
        const freshBid = bestBid(fresh);
        if (freshBid != null && freshBid > 0) exitBid = freshBid;
      } catch {
        // Keep the bid the trigger was decided on rather than abandoning the exit.
      }
      // A settlement close is not a stop: there is no floor to respect, because the point is
      // to take the bid the market is already showing. Passing the stop price here would
      // price the sell below a book that is quoting near certainty.
      response = reason === "settlement"
        ? await submitProtectedExit({ ...plan, stopPrice: null }, { bestBidPrice: exitBid })
        : await submitProtectedExit(plan, { bestBidPrice: exitBid });
    } catch (error) {
      response = { success: false, error: error?.message || String(error) };
    }
    const accepted = exitFilled(response);
    // A signer mismatch is a configuration fault, not a market condition: it will refuse
    // every order for every position until the address is corrected, so it is surfaced on
    // the state itself rather than left to be inferred from hundreds of identical
    // rejections. It stays non-terminal on purpose -- the next live state can correct the
    // address, and a stop that has given up is worse than one that keeps trying.
    if (!accepted && rejectionIsSignerMismatch(response)) {
      context.state.signingError = {
        at: now,
        error: response?.errorMsg || response?.error || null,
        funderAddress: accountTrading.funderAddress || null,
        signatureType: accountTrading.signatureType,
        source: accountTrading.source,
        note: "every order will be refused until the signing address matches the API key's wallet",
      };
    } else if (accepted && context.state.signingError) {
      delete context.state.signingError;
    }
    context.state.exits = context.state.exits || {};
    context.state.exits[plan.tokenId] = {
      lastAttemptAt: now,
      terminal: accepted,
      orderId: response?.orderID || null,
      status: response?.status || null,
      // The price and grid it was sent on. Six-decimal floors were being refused as
      // invalid prices with nothing on the row to show it, so this is recorded.
      exitPrice: response?.exitPrice ?? null,
      tickSize: response?.tickSize ?? null,
    };
    const type = accepted
      ? (reason === "settlement" ? "SETTLEMENT_CLOSE_SUBMITTED" : "EXIT_SUBMITTED")
      : (reason === "settlement" ? "SETTLEMENT_CLOSE_REJECTED" : "EXIT_REJECTED");
    recordEvent(context.state, {
      ...event,
      type,
      exitPrice: response?.exitPrice ?? null,
      tickSize: response?.tickSize ?? null,
      response: { success: Boolean(response?.success), status: response?.status || null, error: response?.errorMsg || response?.error || null, orderId: response?.orderID || null },
    });
    if (accepted) {
      // A reverse is a second, independent FOK order. It is intentionally attempted
      // only after the CLOB said the complete protective SELL matched; a rejected
      // reverse never changes the fact that the original position was already exited.
      if (plan.reverseOnStopLoss && reason !== "settlement") {
        // Owed from here on. Once the protective SELL has matched the position is gone, so
        // this plan will not be in the next pass's plan list -- if the reverse is only
        // tried here and fails, nothing ever tries again. Recording it first means a
        // failure is a retry rather than the end of it.
        context.state.pendingReversals = context.state.pendingReversals || {};
        context.state.pendingReversals[plan.tokenId] = {
          plan: {
            tokenId: plan.tokenId,
            question: plan.question,
            outcome: plan.outcome,
            stopPrice: plan.stopPrice,
            triggerPrice: plan.triggerPrice,
            riskTargetUsdc: plan.riskTargetUsdc,
            reverseOnStopLoss: true,
          },
          owedSince: now,
          attempts: 0,
        };
        await attemptPendingReversal(context, plan.tokenId, event);
      }
      context.liveStateFetchedAt = 0;
      const sync = await notifyAccountSync();
      if (sync.attempted && !sync.ok) recordEvent(context.state, { at: new Date().toISOString(), type: "POST_EXIT_SYNC_ERROR", tokenId: plan.tokenId, error: sync.error });
    }
  }
  await writeJson(STATE_PATH, context.state);
}

async function main() {
  const context = {
    state: await readJson(STATE_PATH, { version: 1, history: [], exits: {} }),
    liveState: null,
    liveStateFetchedAt: 0,
    policyState: null,
    policyStateFetchedAt: 0,
    policyError: null,
  };
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
