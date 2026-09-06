#!/usr/bin/env node

// Persistent, deliberately conservative exit monitor for the self-hosted RPi.
// It is independent of the entry/rotation workflow: it only watches existing
// positions and never opens a new one. LIVE_EXIT_MODE defaults to `shadow`.
//
// ---------------------------------------------------------------------------------------
// NOT BUILT, ON PURPOSE, AND WORTH BUILDING IF THIS EVER REACTS TOO SLOWLY:
// replace the /books poll with Polymarket's WebSocket market channel.
//
// This loop asks for every watched book once a second. That is a poll: the reaction time
// can never be better than the interval plus a round trip, however cheap each pass is made.
// The market channel pushes book changes instead, so a price crossing the floor arrives
// when it happens -- tens of milliseconds -- and the cost stops depending on how many
// positions are held at all.
//
// It was left unbuilt because the polling version was first made to cost ONE request per
// pass regardless of position count, which took the loop to one second and is expected to
// be enough. The decision to revisit is a measurement, not a hunch, and the worker records
// it: `passTiming` in the state file, printed by the worker-status workflow. If passes
// regularly fill the interval, or a stop is seen firing late against a price that moved
// inside one pass, the reaction time has become the loop rather than the setting -- and
// that is the moment this is worth the persistent connection, the reconnect handling and
// the polling fallback it needs.
//
// Note also that speed is not uniformly valuable here. It matters for the stop loss and
// for taking a chosen entry; the certainty close does not need it, because a settled
// market stays settled.
// ---------------------------------------------------------------------------------------

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
// How fast this goes round IS the stop's reaction time. Measured on a stopped position:
// under a minute from healthy to through the floor, so five seconds was already coarse
// against the thing being measured. One pass is now one request regardless of how many
// positions are held, which is what makes a one-second loop affordable rather than
// merely faster.
const POLL_INTERVAL_MS = clampInteger(process.env.LIVE_EXIT_POLL_INTERVAL_MS, 1000, 250, 60000);
const RETRY_INTERVAL_MS = clampInteger(process.env.LIVE_EXIT_RETRY_INTERVAL_MS, 20000, 5000, 300000);
// How often a position that is ONLY waiting to be closed at certainty has its book read.
// A stop needs the poll interval, because how fast the loop goes round is its reaction
// time; this does not -- a market that has settled stays settled. Capped at 15 minutes so
// the answer is never more than that stale, and defaulted well inside it.
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
const LIVE_EXIT_RECORD_URL = process.env.LIVE_EXIT_RECORD_URL
  || "https://osobnizkusenosti.cz/trading/api.php?action=live-exit-record";
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

// Every watched book in ONE request.
//
// How fast this loop goes round IS the stop's reaction time, and a position measured
// falling to its floor in under a minute says the loop has to be quick. Reading a book per
// token made a pass cost N requests, which put a floor under the interval and a ceiling on
// the account at the same time: twenty positions at one second is twenty requests a second,
// against a rate limit, for nothing gained.
//
// The CLOB answers /books with every book asked for, so a pass now costs one round trip
// whether the account holds one position or twenty. That is what makes a one-second loop
// possible -- and it is also why the settlement-only positions no longer need a slower
// cadence of their own: they ride along in a request that was going out anyway.
//
// Returns a map from token to book. A token the CLOB did not answer for is simply absent,
// which the caller reports against that position alone rather than losing the whole pass.
async function fetchBooks(tokenIds) {
  const wanted = [...new Set(tokenIds.map((tokenId) => String(tokenId)).filter(Boolean))];
  if (!wanted.length) return new Map();
  const response = await fetch(`${CLOB_HOST}/books`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept": "application/json",
      "user-agent": "trading-live-exit-worker/1.0",
    },
    body: JSON.stringify(wanted.map((tokenId) => ({ token_id: tokenId }))),
  });
  if (!response.ok) throw new Error(`CLOB books: HTTP ${response.status}`);
  const rows = await response.json();
  const books = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const tokenId = String(row?.asset_id || row?.assetId || row?.token_id || "");
    if (tokenId) books.set(tokenId, row);
  }
  return books;
}

// The reason a position was sold, sent to the dashboard at the moment this worker knows it.
//
// Reported: the closed-positions list shows no record that a stop loss ever fired. It could
// not -- every fill was recorded in this worker's own state file on the Pi, which nothing
// publishes, and the account sync that produces those rows learns only from Polymarket,
// where a protective sell and any other sell are the same event. The reason existed on one
// machine and the screen showed a position that had simply vanished.
//
// Best effort by design: a position that has already been sold must not be un-sold because
// the annotation could not be delivered.
async function recordLiveExit(plan, { reason, response, bestBidPrice, bestAskPrice }) {
  if (!TRADING_TRIGGER_KEY) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    await fetch(LIVE_EXIT_RECORD_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-trading-trigger-key": TRADING_TRIGGER_KEY,
        "user-agent": "trading-live-exit-worker/1.0",
      },
      body: JSON.stringify({
        tokenId: String(plan.tokenId),
        reason,
        portfolioId: String(plan.source || "").replace(/^portfolio:/, ""),
        question: plan.question,
        outcome: plan.outcome,
        exitPrice: response?.exitPrice ?? null,
        stopPrice: plan.stopPrice ?? null,
        bestBid: bestBidPrice ?? null,
        bestAsk: bestAskPrice ?? null,
        shares: plan.shares ?? null,
        orderId: response?.orderID || null,
      }),
      signal: controller.signal,
    });
  } catch {
    // Swallowed on purpose. The position is already sold; failing here would only turn a
    // missing annotation into a crashed pass, and the next exit still records normally.
  } finally {
    clearTimeout(timeout);
  }
}

// The reversal's outcome, posted against the exit record already written for the position
// it came out of. Same endpoint and same key, because it annotates the same record -- the
// exit is stored first, and this fills in what the stop did next.
async function recordLiveExitReversal(plan, reversal) {
  if (!TRADING_TRIGGER_KEY) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    await fetch(LIVE_EXIT_RECORD_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-trading-trigger-key": TRADING_TRIGGER_KEY,
        "user-agent": "trading-live-exit-worker/1.0",
      },
      body: JSON.stringify({ tokenId: String(plan.tokenId), reason: "stop", reversal }),
      signal: controller.signal,
    });
  } catch {
    // Swallowed for the same reason the exit record is: the reverse has already been
    // decided on the exchange, and a failed annotation must not crash the pass.
  } finally {
    clearTimeout(timeout);
  }
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

// Positions still worth watching. A finished one is excluded because there is nothing left
// to protect: the shares are gone, or the settlement price is already published.
//
// PENDING_RESOLUTION is not one of those, and excluding it was the fault. It means the
// market has stopped trading and its settlement price has not been published yet -- the
// shares are still held, and the dashboard has always counted such a row as an open
// position. Worse, it is the exact state the certainty close exists for: the outcome is
// decided, the bid sits at 0.999, and the point is to sell now rather than wait hours for
// Polymarket to settle. So the moment a position became the kind this rule is meant to act
// on, it dropped out of the watch list and the rule could never fire.
//
// Reported on "Set 2 Winner: Zverev vs Tabilo": another position of the same portfolio sold
// at 99.9 and this one never did. That one was still trading when its bid reached the
// close; this one crossed into PENDING_RESOLUTION first.
export const FINISHED_POSITION_STATUSES = ["CLOSED", "LOST", "WON", "REDEEM_REQUIRED", "SOLD"];

function livePositions(state = {}) {
  const positions = Array.isArray(state.positions) ? state.positions : [];
  return positions.filter((position) => {
    const status = String(position.status || "").toUpperCase();
    return !FINISHED_POSITION_STATUSES.includes(status)
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
  const flatFloor = number(entry?.stopLossProbabilityFloor) || null;
  // Three independent reasons to watch, and any one is enough. A portfolio that sets only
  // the probability floor still has a stop, and requiring one of the other two here would
  // leave it unwatched -- the fault the settlement close had before it joined this line.
  if (stopPrice == null && closeBid == null && flatFloor == null) return null;
  return {
    ...derived,
    tokenId: String(position.tokenId || position.assetId),
    question: entry?.question || position.question || position.market || "Unknown market",
    outcome: entry?.outcome || position.outcome || "",
    stopPrice,
    triggerPrice: stopPrice == null ? null : round(Math.min(0.999999, stopPrice + STOP_PRETRIGGER_BUFFER), 6),
    settlementCloseBid: closeBid,
    // Kept beside the derived stop rather than folded into it, so the row says which of the
    // two levels is in force and a reader can tell why a stop fired where it did.
    probabilityFloor: flatFloor,
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
// The level a falling price meets first, which is simply the higher of the two floors.
//
// The equal-risk floor moves with the entry -- a 95c entry gets 8.7 points of room, a 72c
// entry 46.3, from one setting -- which is why two stops on the same portfolio could fire
// one too early and one too late with nothing misconfigured. The probability floor does not
// move at all: below it the market has the other side winning, and that is the same
// statement whatever the position cost.
//
// Combining them by "whichever comes first" is combining them by max, since both are floors
// and the price arrives from above. Either may be absent, and the answer is then the other.
export function effectiveStopFloor({ stopPrice, probabilityFloor } = {}) {
  const risk = number(stopPrice);
  const flat = number(probabilityFloor);
  const levels = [risk, flat].filter((level) => level != null && level > 0);
  return levels.length ? Math.max(...levels) : null;
}

export function exitReason({ bestBidPrice, bestAskPrice = null, stopPrice, triggerPrice, probabilityFloor = null, settlementCloseBid: closeBid } = {}) {
  const floor = effectiveStopFloor({ stopPrice, probabilityFloor });
  if (floor != null) {
    // The pre-trigger buffer belongs to the level actually in force. Carrying the stored
    // trigger over would test the equal-risk floor's buffer against the probability floor.
    const trigger = floor === number(stopPrice) && triggerPrice != null
      ? triggerPrice
      : round(Math.min(0.999999, floor + STOP_PRETRIGGER_BUFFER), 6);
    if (exitTrigger({ bestBidPrice, bestAskPrice, stopPrice: floor, triggerPrice: trigger })) return "stop";
  }
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

// Conditional tokens are quoted in base units with six decimals, which is the unit the
// exchange's own refusal speaks in:
//
//   "not enough balance / allowance: the balance is not enough
//    -> balance: 7221, order amount: 6840000"
//
// 0.007221 shares held against the 6.84 the plan asked to sell. The plan's size came from
// the account snapshot when the plan was built and the exchange had moved on since.
const CONDITIONAL_TOKEN_UNIT = 1e6;

// The balance out of the exchange's own refusal, in shares.
//
// Asking what the account holds BEFORE selling is a race with itself: the answer is stale
// by the time the order lands, and on a resolving market it can be stale within the five
// seconds between passes. It also spends a round trip on every exit to serve the rare one.
//
// So nothing is asked. The whole position is offered, and the refusal -- which quotes the
// balance at the instant it rejected the order, which is as fresh as this can ever be --
// supplies the number for the one retry that follows. Null means this rejection was about
// something else and the size is not in question.
export function balanceFromRejection(response) {
  const text = String(response?.errorMsg || response?.error || "");
  if (!/not enough balance|balance is not enough/i.test(text)) return null;
  const quoted = text.match(/balance:\s*(\d+(?:\.\d+)?)/i);
  if (!quoted) return null;
  const raw = Number(quoted[1]);
  return Number.isFinite(raw) && raw >= 0 ? raw / CONDITIONAL_TOKEN_UNIT : null;
}

// A refusal no retry can talk the exchange out of. The account does not hold the shares,
// and that is the exchange's own view of the account rather than ours -- so trying again in
// twenty seconds asks a question already answered. Retrying it is what turned single dead
// positions into 84 identical rejections in the retained history.
// The exchange refusing the size's precision rather than the price or the balance. Worth
// its own name because the answer is different: this one is retried at a coarser size,
// where a balance refusal is retried at a smaller one and a signer fault at neither.
export function makerAmountPrecisionRefusal(response) {
  const text = `${response?.errorMsg || ""} ${response?.error || ""}`;
  return /invalid maker amount|maker amount.*(?:accuracy|decimal|precision)/i.test(text);
}

// The largest size at or below `size` whose USDC leg lands on a whole cent, at the SAME
// price. Returns null when no such size exists above the floor, which is the honest answer
// -- a caller that got null should keep its original refusal rather than sell a token amount.
//
// This is the executor's rule (largestTwoDecimalMakerSafeSize), not a new one. It is the
// only rule in this codebase observed to recover a live order from "invalid maker amount",
// so the two paths now share it instead of each guessing separately.
//
// The previous attempt here floored the size to two decimals. That could never fire: the
// CLOB client already floors a SELL size to two decimals before signing, so the "coarser"
// size was always the size it had just refused, and the retry was a no-op dressed as a fix.
// Measured on the worker after shipping it: 155 of 500 retained events still refused.
const MAKER_AMOUNT_RESIZE_STEPS = 2000;

export function makerAmountSafeSize({ price, size, minimumSize = 0 } = {}) {
  const limit = number(price);
  const from = number(size);
  if (limit == null || from == null || !(limit > 0) || !(from > 0)) return null;
  const floorCents = Math.ceil(Math.max(0, number(minimumSize, 0)) * 100 - 1e-7);
  let cents = Math.floor(from * 100 + 1e-7);
  const stopAt = Math.max(floorCents, cents - MAKER_AMOUNT_RESIZE_STEPS);
  for (; cents >= stopAt && cents > 0; cents -= 1) {
    const usdc = (limit * cents) / 100;
    if (Math.abs(usdc * 100 - Math.round(usdc * 100)) <= 1e-7) return round(cents / 100, 2);
  }
  return null;
}

export function exitFailureIsTerminal(response) {
  const text = String(response?.errorMsg || response?.error || "");
  return /not enough balance|balance is not enough|no position to sell/i.test(text);
}

// How far below its floor a stop is still willing to sell.
//
// The rule this replaces was "sell at any cost": below the floor the book has gapped, so
// take whatever the buyers are showing. Measured on the account, that meant positions
// bought near 76-80c being sold at 1.5c and 5.7c against floors around 25-37c -- twenty
// points and more below the level that was configured, which is not a capped loss but a
// liquidation at whatever happened to be resting.
//
// So the floor now has a floor. Outside it the stop declines to sell and the position is
// left to resolve, which is the owner's instruction: if it cannot be caught near the level
// that was set, waiting is the better of two bad outcomes. A market that has gapped that
// far usually has no real buyer anyway -- the 1.5c "bid" is somebody's lowball resting
// order, not a price.
//
// Read as a fraction OF THE STOP, not as percentage points: a 10% tolerance under a 0.30
// floor declines below 0.27, not below 0.20. That is what "10% under what I have set"
// means when the stop is itself a price.
const STOP_GAP_TOLERANCE = Math.min(1, Math.max(0, number(process.env.LIVE_EXIT_STOP_GAP_TOLERANCE, 0.1)));

// The lowest price this stop will accept. Null when there is no floor to measure against,
// which is the settlement close: that one takes the bid on purpose.
export function stopGapFloorPrice(stopPrice, tolerance = STOP_GAP_TOLERANCE) {
  const floor = number(stopPrice);
  if (floor == null || !(floor > 0)) return null;
  return round(floor * (1 - tolerance), 6);
}

// Whether the book has fallen so far below the stop that selling into it is worse than
// waiting. Never true for a settlement close, which has no floor and is not capping a loss.
export function stopGapIsTooWide({ bestBidPrice, stopPrice, tolerance = STOP_GAP_TOLERANCE } = {}) {
  const limit = stopGapFloorPrice(stopPrice, tolerance);
  if (limit == null) return false;
  const bid = number(bestBidPrice);
  // No bid at all is not a wide gap, it is no market. exitTrigger already refuses that
  // case, and answering it here would make two rules disagree about one book.
  if (bid == null || !(bid > 0)) return false;
  return bid < limit;
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

  const sell = async (size, orderType) => {
    const signed = await client.createOrder(
      { tokenID: plan.tokenId, price, size, side: Side.SELL },
      options,
    );
    return client.postOrder(signed, orderType, false);
  };

  // Offer the WHOLE position first, and ask the exchange nothing beforehand. A balance
  // query is a race with itself -- the answer is stale by the time the order lands, and on
  // a resolving market it can be stale inside the five seconds between passes -- and it
  // would spend a round trip on every exit to serve the rare one.
  //
  // FOK keeps the price floor strict: the complete position sells at this price or better,
  // or it remains intact. FAK is an explicit opt-in because partial exits complicate the
  // remaining stop plan.
  const planned = number(plan.shares);
  let size = planned;
  let response = await sell(size, OrderType.FOK);
  if (!exitFilled(response) && ALLOW_PARTIAL) response = await sell(size, OrderType.FAK);

  // Refused for size, and the refusal names the balance it refused against -- as fresh as
  // this can ever be, because it is what the exchange saw at the instant it said no. That
  // is the number to retry with, and it is the whole of what a pre-flight query would have
  // told us, without the query.
  const held = balanceFromRejection(response);
  if (held != null) {
    // Nothing there. Not worth another pass: there is no position here to protect, and
    // saying so ends the attempt instead of repeating it every twenty seconds.
    if (!(held > 0)) {
      return {
        success: false, terminal: true, exitPrice: price, tickSize: constraints.tickSize,
        plannedShares: planned, heldShares: 0,
        error: "the account no longer holds this position",
      };
    }
    // Floored, never rounded up: asking for a hair more than the balance is the refusal
    // being answered. Capped at the plan as well, because the account may hold the same
    // token for another portfolio and only this one's position is being closed.
    size = Math.floor(Math.min(planned, held) * 10000) / 10000;
    if (!(size > 0)) {
      return {
        success: false, terminal: true, exitPrice: price, tickSize: constraints.tickSize,
        plannedShares: planned, heldShares: held,
        error: "the remaining position is too small to sell",
      };
    }
    // Already a rescue of less than the position, so it takes whatever it can get. Holding
    // out for all-or-nothing here would throw the rescue away on a technicality.
    response = await sell(size, OrderType.FAK);
  }

  // "invalid maker amount" is the exchange refusing the ORDER'S AMOUNTS, not the price and
  // not the balance. What separates a refusal from a fill is the product rather than either
  // factor: the same position on Games Total: O/U 3.5 was accepted at 0.45 and refused at
  // 0.46 minutes later, same size, same book side.
  //
  // So the price is kept -- it is the whole point of a stop -- and the size walks down to
  // the nearest one whose USDC leg is a whole number of cents.
  //
  // Said plainly, because the rule is inferred from the exchange's behaviour rather than
  // from its documentation: whole-cent is what the executor recovers with in production, and
  // it is the best-evidenced rule available. Every refusal now records the price AND the
  // size, so the next status read shows the product on both the refused and the accepted
  // orders and can confirm or replace this rule with arithmetic instead of inference.
  let resizedForMakerAmount = null;
  if (!exitFilled(response) && makerAmountPrecisionRefusal(response)) {
    const safe = makerAmountSafeSize({ price, size });
    if (safe != null && safe > 0 && safe < size) {
      resizedForMakerAmount = safe;
      const retried = await sell(safe, OrderType.FAK);
      // Kept even when it fails for a NEW reason: that is progress worth recording, where
      // the same refusal again means the rule is wrong and the original row is the honest
      // one to keep.
      if (exitFilled(retried) || !makerAmountPrecisionRefusal(retried)) {
        response = retried;
        size = safe;
      }
    }
  }
  return {
    ...response,
    exitPrice: price,
    tickSize: constraints.tickSize,
    exitShares: size,
    // The other half of the number the exchange refused. A row carrying only the price
    // cannot distinguish a bad price from a bad product, which is exactly the distinction
    // that took two rounds to make here.
    makerAmountUsdc: round(price * size, 6),
    resizedForMakerAmount,
    // So the record says the rescue was partial rather than leaving the reader to infer it
    // from a size that does not match the position.
    plannedShares: planned,
    heldShares: held,
  };
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
  // Told to the closed trade this reversal came out of, so its row can explain itself.
  // Only once the answer is settled: a retry that will be tried again is not yet news, and
  // writing PENDING on every attempt would make the note flicker between states for a
  // position the reader is looking at exactly once.
  if (terminal) {
    await recordLiveExitReversal(pending.plan, {
      status: accepted ? "OPENED" : "SKIPPED",
      outcome: reversal?.reversal?.outcome || null,
      shares: reversal?.reversal?.shares ?? null,
      price: reversal?.reversal?.price ?? null,
      orderId: reversal?.orderID || null,
      reason: accepted ? null : (reason || "the opposite position could not be opened"),
    });
  }
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

// A stop that is declining to sell does so on every pass for as long as the book stays
// down there, which at one pass a second would bury the whole history within minutes -- the
// same trap the book errors above already fell into. So it is kept as a standing row per
// position, with the worst bid seen and how long it has been declining, and only the first
// one is written to the event log.
//
// The row is what the dashboard needs anyway: "this position's stop fired and deliberately
// did not sell, here is the level, the bid, and how long".
function recordDeclinedStop(state, plan, { bestBid, gapFloor, at, reason }) {
  state.declinedStops = state.declinedStops || {};
  const previous = state.declinedStops[plan.tokenId];
  const worst = previous && Number.isFinite(Number(previous.worstBid))
    ? Math.min(Number(previous.worstBid), Number(bestBid))
    : bestBid;
  state.declinedStops[plan.tokenId] = {
    question: plan.question,
    outcome: plan.outcome,
    stopPrice: plan.stopPrice,
    gapFloor,
    bestBid,
    worstBid: worst,
    riskTargetUsdc: plan.riskTargetUsdc,
    firstAt: previous ? previous.firstAt : at,
    lastAt: at,
    count: previous ? (Number(previous.count) || 1) + 1 : 1,
    reason,
  };
  if (previous) return;
  recordEvent(state, {
    at, type: "STOP_DECLINED_GAPPED", tokenId: plan.tokenId,
    question: plan.question, outcome: plan.outcome,
    stopPrice: plan.stopPrice, gapFloor, bestBid, reason,
  });
}

// A stop that sold, or a position that left the account, has nothing left to decline.
function clearDeclinedStop(state, tokenId) {
  if (state.declinedStops && state.declinedStops[tokenId]) delete state.declinedStops[tokenId];
}

// A rolling picture of what a pass costs, as counters rather than a log: the loop runs
// once a second, so one row per pass would bury everything else in the state file within
// minutes. The percentile that matters is the slow end -- a mean under the interval says
// nothing if one pass in twenty takes three times as long, because the stop is late in
// exactly those passes.
function recordPassDuration(state, ms) {
  const stats = state.passTiming && typeof state.passTiming === "object"
    ? state.passTiming
    : { passes: 0, totalMs: 0, maxMs: 0, overrunning: 0, buckets: {} };
  stats.passes += 1;
  stats.totalMs += ms;
  stats.maxMs = Math.max(stats.maxMs || 0, ms);
  stats.meanMs = Math.round(stats.totalMs / stats.passes);
  // How often the work alone already fills the interval. This is the number that says
  // whether the setting is still the thing deciding the reaction time.
  if (ms >= POLL_INTERVAL_MS) stats.overrunning += 1;
  const bucket = ms < 100 ? "<100ms"
    : ms < 250 ? "100-250ms"
      : ms < 500 ? "250-500ms"
        : ms < 1000 ? "500-1000ms"
          : ms < 2000 ? "1-2s" : ">2s";
  stats.buckets[bucket] = (stats.buckets[bucket] || 0) + 1;
  stats.intervalMs = POLL_INTERVAL_MS;
  stats.since = stats.since || new Date().toISOString();
  state.passTiming = stats;
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
  // Re-read on the same cadence as the remote policy rather than every pass. It is a
  // hand-maintained emergency file that changes when a person edits it, and a disk read
  // per second buys nothing.
  if (!context.watchlist || Date.now() - (context.watchlistReadAt || 0) >= STATE_REFRESH_MS) {
    context.watchlist = await readJson(WATCHLIST_PATH, { positions: [] });
    context.watchlistReadAt = Date.now();
  }
  const explicitlyWatched = watchlistEntryMap(context.watchlist);
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
  const candidates = plans.filter((plan) => {
    const pending = context.state.exits?.[plan.tokenId];
    if (pending?.terminal) return false;
    if (pending?.lastAttemptAt && Date.now() - Date.parse(pending.lastAttemptAt) < RETRY_INTERVAL_MS) return false;
    // Every plan, every pass. Settlement-only plans used to be held back to their own
    // slower interval because each one added a request; batching removed that cost, so the
    // reason is gone -- and holding a position back from the pass that would have sold it
    // is exactly the delay this loop exists to avoid.
    return true;
  });
  let observed = [];
  try {
    const books = await fetchBooks(candidates.map((plan) => plan.tokenId));
    observed = candidates.map((plan) => {
      const book = books.get(String(plan.tokenId));
      return book
        ? { plan, book }
        : { plan, error: new Error("the CLOB returned no book for this token") };
    });
  } catch (error) {
    // One failed batch must not blind the worker to every position at once, so it falls
    // back to reading them individually. Slower, and only for the pass that failed.
    observed = await mapWithConcurrency(candidates, async (plan) => {
      try {
        return { plan, book: await fetchJson(`${CLOB_HOST}/book?token_id=${encodeURIComponent(plan.tokenId)}`, `CLOB book ${plan.tokenId}`) };
      } catch (bookError) {
        return { plan, error: bookError };
      }
    }, BOOK_FETCH_CONCURRENCY);
  }

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
      probabilityFloor: plan.probabilityFloor,
      settlementCloseBid: plan.settlementCloseBid,
    });
    // The level actually in force, which is what the sell is priced at and what the gap
    // tolerance is measured against. Using plan.stopPrice for either would price against a
    // floor the trigger did not use.
    const activeFloor = effectiveStopFloor({ stopPrice: plan.stopPrice, probabilityFloor: plan.probabilityFloor });
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
      // Decided on the FRESH bid, which is the one the sell would actually meet. Deciding
      // on the older read would decline against a price that has since recovered, or sell
      // into one that has since collapsed.
      if (reason === "stop" && stopGapIsTooWide({ bestBidPrice: exitBid, stopPrice: activeFloor })) {
        const limit = stopGapFloorPrice(activeFloor);
        recordDeclinedStop(context.state, plan, {
          bestBid: exitBid,
          gapFloor: limit,
          at: now,
          reason: `the stop is ${activeFloor} and the best bid is ${exitBid}, below the ${limit} floor`
            + ` this stop will sell at (${(STOP_GAP_TOLERANCE * 100).toFixed(0)}% under the stop). Selling here`
            + ` would take far less than the level that was set, so the position is left to resolve`
            + ` and the stop is re-checked every pass in case the book recovers.`,
        });
        // Deliberately not terminal and not recorded as an exit attempt: nothing was sent,
        // and the next pass must ask again. A book that gapped on one tick often comes back.
        continue;
      }
      response = reason === "settlement"
        ? await submitProtectedExit({ ...plan, stopPrice: null }, { bestBidPrice: exitBid })
        : await submitProtectedExit({ ...plan, stopPrice: activeFloor }, { bestBidPrice: exitBid });
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
      // Sold, or refused in a way no retry can change. The exchange saying the account does
      // not hold the shares is its own view of the account, not ours, so asking again in
      // twenty seconds re-asks a question already answered -- which is how single dead
      // positions became 84 identical rejections in the retained history.
      //
      // Only THOSE refusals end it. A market that could not be read, a price off the grid,
      // a book with no bid: all still worth another pass, because a stop that has given up
      // on a live position is the worse failure.
      terminal: accepted || response?.terminal === true || exitFailureIsTerminal(response),
      orderId: response?.orderID || null,
      status: response?.status || null,
      // WHY it was refused, beside the fact that it was. This row is the first thing any
      // diagnosis reads and it recorded a bare `status: 400` -- true, and useless: a run
      // of rejected stop exits looks identical whether the price was off the tick grid,
      // the size below the exchange minimum, or the signature wrong. The event log carried
      // the text all along, which is precisely why it was easy not to notice its absence
      // here, and a stop that is refused every time is the one case where the reason has
      // to be on the surface.
      error: response?.errorMsg || response?.error || null,
      // The price and grid it was sent on. Six-decimal floors were being refused as
      // invalid prices with nothing on the row to show it, so this is recorded.
      exitPrice: response?.exitPrice ?? null,
      tickSize: response?.tickSize ?? null,
      // And the size, which is the other factor in the amount the exchange judges. Without
      // it a run of "invalid maker amount" refusals shows the price it was refused at and
      // nothing about the number that was actually invalid -- so the fix for them was
      // guessed twice rather than derived once.
      exitShares: response?.exitShares ?? null,
      plannedShares: response?.plannedShares ?? null,
      makerAmountUsdc: response?.makerAmountUsdc ?? null,
      resizedForMakerAmount: response?.resizedForMakerAmount ?? null,
    };
    const type = accepted
      ? (reason === "settlement" ? "SETTLEMENT_CLOSE_SUBMITTED" : "EXIT_SUBMITTED")
      : (reason === "settlement" ? "SETTLEMENT_CLOSE_REJECTED" : "EXIT_REJECTED");
    recordEvent(context.state, {
      ...event,
      type,
      exitPrice: response?.exitPrice ?? null,
      tickSize: response?.tickSize ?? null,
      exitShares: response?.exitShares ?? null,
      makerAmountUsdc: response?.makerAmountUsdc ?? null,
      resizedForMakerAmount: response?.resizedForMakerAmount ?? null,
      response: { success: Boolean(response?.success), status: response?.status || null, error: response?.errorMsg || response?.error || null, orderId: response?.orderID || null },
    });
    if (accepted) {
      // It sold, so it is no longer declining to.
      clearDeclinedStop(context.state, plan.tokenId);
      // Why this position was sold, sent before anything else is attempted: the reverse
      // below can fail, and the fill it follows still happened.
      await recordLiveExit(plan, {
        reason,
        response,
        bestBidPrice: currentBestBid,
        bestAskPrice: currentBestAsk,
      });
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
  await persistState(context);
}

// The state file is a quarter of a megabyte -- five hundred retained events, most of them
// large -- and it was rewritten on every pass. At five seconds that was merely wasteful; at
// one second it is 280 KB/s of synchronous writes onto the Pi's SD card, slow enough to
// lengthen the very loop it is timing and hard on the card besides.
//
// So it is written when it has something new to say -- an event recorded, an exit
// attempted, the watched set changed -- and otherwise on a slow heartbeat so `generatedAt`
// still shows the worker alive. Nothing that decides an exit is read back from this file
// mid-run: it is a report, not state the loop depends on.
const STATE_HEARTBEAT_MS = clampInteger(process.env.LIVE_EXIT_STATE_WRITE_MS, 30000, 5000, 300000);

async function persistState(context, { force = false } = {}) {
  const stamp = JSON.stringify([
    context.state.lastEvent?.at || null,
    Object.keys(context.state.exits || {}).length,
    context.state.watchedPositions?.length || 0,
    context.state.excludedPositions?.length || 0,
    context.state.policyError || null,
    context.state.signingError?.at || null,
  ]);
  const due = Date.now() - (context.statePersistedAt || 0) >= STATE_HEARTBEAT_MS;
  if (!force && !due && stamp === context.statePersistedStamp) return;
  context.statePersistedStamp = stamp;
  context.statePersistedAt = Date.now();
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
    const startedAt = Date.now();
    try {
      await checkOnce(context);
    } catch (error) {
      recordEvent(context.state, { at: new Date().toISOString(), type: "WORKER_ERROR", error: error?.message || String(error) });
      await writeJson(STATE_PATH, context.state).catch(() => {});
      console.error(error?.stack || error?.message || String(error));
    }
    // What a pass actually costs, kept so "is one second enough" is answered with numbers
    // rather than opinion. A pass that regularly approaches the interval means the loop is
    // running flat out and the reaction time is the pass, not the setting -- which is the
    // condition that would make the WebSocket feed worth building.
    recordPassDuration(context.state, Date.now() - startedAt);
    // Sleep for what is LEFT of the interval, not the whole of it. The pass itself costs a
    // round trip, so sleeping the full interval afterwards made the real period
    // interval + work -- and at one second the work is a large share of it. A pass that
    // overruns simply starts the next one immediately rather than accumulating drift.
    const remaining = POLL_INTERVAL_MS - (Date.now() - startedAt);
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
  }
}

const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;
if (invokedDirectly) main().catch((error) => { console.error(error?.stack || error); process.exit(1); });
