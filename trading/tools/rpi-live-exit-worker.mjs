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
// How long an order the exchange QUEUED is left alone before this worker sends another.
//
// Polymarket answers some orders with `delayed`: taken, given an order id, and held before
// matching. That is not a fill, and this worker was right never to treat it as one -- but it
// was recorded as a rejection, which made the retry timer start immediately. Measured on the
// account: three orders for the same position inside 90 seconds (04:59:26, 05:00:12,
// 05:00:53), then "the account no longer holds this position" at 05:01:13. The first one had
// filled all along; the other two were sent into a position that no longer existed.
//
// So a queued order gets a window to settle in. Longer than the retry interval on purpose:
// re-sending while an order may still match is the failure being fixed, and a stop that
// waits one minute for an order it has already sent is not an unprotected stop.
//
// 120s is a ceiling, not a wait: an order lookup that answers releases it in seconds, and
// only an order nobody can account for runs the clock down. It is set here rather than
// tuned by opinion, and the resolved events say which signal decided each one.
const PENDING_MATCH_WINDOW_MS = clampInteger(process.env.LIVE_EXIT_PENDING_MATCH_MS, 120000, 5000, 600000);
// How often the exchange is asked what became of a queued order. Not every pass: the pass is
// one second, and asking costs an authenticated round trip -- sixty of them per queued order
// would lengthen the very loop whose latency is the stop's reaction time.
const PENDING_MATCH_POLL_MS = clampInteger(process.env.LIVE_EXIT_PENDING_POLL_MS, 5000, 1000, 60000);
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

// Below this a holding is dust, not a position: the exit floors its size to two decimals, so
// a sold-out position leaves a remainder under 0.01 shares behind. The same number as
// DUST_SHARES in live-account-sync.mjs, which is where a position sold down to a remainder is
// counted as closed -- and a test holds the two together, because a remainder the sync calls
// closed and the worker calls open is exactly what happened here.
//
// Measured, and it is not a small effect: 333 of the worker's 500 retained events were the
// exchange refusing sells of 0.0031 and 0.0034 shares -- below its minimum order size, which
// it reports as "invalid maker amount". One attempt every twenty seconds, forever, for
// positions that no longer exist. Two rounds of fixes chased that error as a precision rule.
//
// The worse cost was the diagnosis: at 93% dust the 500-event history covered a few hours, so
// the record of a real stop loss decision had already scrolled out of the log it is kept in.
export const DUST_SHARES = 0.01;

function livePositions(state = {}) {
  const positions = Array.isArray(state.positions) ? state.positions : [];
  return positions.filter((position) => {
    const status = String(position.status || "").toUpperCase();
    return !FINISHED_POSITION_STATUSES.includes(status)
      && String(position.tokenId || position.assetId || "").trim()
      && number(position.shares ?? position.size, 0) >= DUST_SHARES;
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
  // Only while the capital is the constraint. This close pays about a cent a share to have
  // the stake hours early; when the account already holds enough cash to fund the next
  // stake there is nothing to buy back, so the position is held and settles at 1.00.
  if (canFundAnotherPosition(entry?.accountCashUsdc, entry?.stakeUsdc)) return null;
  return Math.max(0.5, Math.min(0.999, bid));
}

// Whether another position could be opened right now without selling anything.
//
// Asked of the ACCOUNT's cash rather than a per-portfolio figure, because live portfolios
// all spend one balance -- which is what the API sends.
//
// An unknown cash figure, or a stake of zero, answers FALSE: not fundable, so the close is
// never blocked by a number that simply did not arrive. This close has shipped broken three
// times already; it must not be possible to silence it with an absent field.
export function canFundAnotherPosition(cashUsdc, stakeUsdc) {
  const cash = number(cashUsdc);
  const stake = number(stakeUsdc);
  if (cash == null || stake == null || !(stake > 0)) return false;
  return cash + 0.000001 >= stake;
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
    // How many shares are held is a fact about the POSITION, not about whether a stop can be
    // derived from it -- and every early return in equalRiskExitPlan omits it.
    //
    // Reported: a market reached 100%, sat at a 0.999 bid for over five minutes with the
    // certainty close set to 99.9, and was never sold. Measured: the bid was at the setting
    // and the tick was 0.001, so the trigger was satisfied; what refused it was the exit
    // itself, with "the remaining UNKNOWN shares are dust" -- and terminally, so it was never
    // retried. Unknown, not small: the position holds 6.93 shares.
    //
    // The path is exact. "70-80 sports, esports" runs with the stop loss OFF, so
    // equalRiskExitPlan returns { protectable: false, reason: "position stop-loss multiplier
    // is disabled" } and nothing else. watchPlan still watches the position, correctly,
    // because the settlement close is its own independent reason -- but the plan it spread
    // that refusal into carried no share count, so the close could never size an order.
    //
    // So a portfolio with the stop loss off and the certainty close on could never close at
    // certainty, which is precisely the pair of settings this portfolio has. The nine
    // SETTLEMENT_CLOSE_REJECTED events already in the worker's history say "unknown shares"
    // too: this has been failing for every such position, not just this one.
    shares: number(derived.shares, number(position.shares ?? position.size)),
    totalCostUsdc: number(derived.totalCostUsdc, number(position.totalCostUsdc ?? position.stakeUsdc ?? position.initialValue)),
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
//
// The equal-risk floor can never sit at or above the entry -- equalRiskExitPlan refuses to
// return one, because a floor there does not cap a loss, it liquidates the position the
// instant the stop arms. The probability floor had no such guard: it is a flat number that
// does not move with the entry, and a position bought BELOW it (entry 0.45, floor 0.49 on
// "Will CA Nacional Potosi win?", No) armed a stop that was already past its own trigger at
// the moment of purchase. entryPrice is optional so a caller that does not have it yet still
// gets the pre-fix behavior rather than a silently unprotected position.
export function effectiveStopFloor({ stopPrice, probabilityFloor, entryPrice = null } = {}) {
  const risk = number(stopPrice);
  const flatRaw = number(probabilityFloor);
  const entry = number(entryPrice);
  const flat = flatRaw != null && entry != null && flatRaw >= entry ? null : flatRaw;
  const levels = [risk, flat].filter((level) => level != null && level > 0);
  return levels.length ? Math.max(...levels) : null;
}

// The coarsest tick Polymarket quotes on, and the reason the certainty close never fired.
//
// Reported: positions the market prices as decided are not sold and have to be closed by
// hand. Measured on the account: the setting is 0.999 on every live portfolio, it IS stored,
// the positions ARE in the policy the worker watches -- and six of ten open positions trade
// on a 0.01 grid, where THE HIGHEST BID THAT CAN EXIST IS 0.99. The rule was correct, the
// wiring was correct, and `bid >= 0.999` was unsatisfiable by construction.
//
// So the level is clamped to what a book can actually quote. 0.999 on a 0.01 market means
// 0.99, the top of its grid; on a finer grid it fires a tenth of a cent early, which is well
// inside what this setting exists to pay -- about a cent a share to have the capital back
// now instead of hours later. A reachable setting is untouched: 0.95 still means 0.95.
const COARSEST_MARKET_TICK = 0.01;

// Candidate grids, coarsest first. The first that explains every quoted price is the answer:
// a book is only ever quoted ON its market's grid, so the prices themselves are the evidence.
const MARKET_TICK_CANDIDATES = [0.01, 0.001, 0.0001];

// The grid this book demonstrates, read from the book rather than assumed.
//
// Reported: a position whose portfolio asked for 99.9 was sold at 99.1, forfeiting a win the
// market had already decided. Cause: the clamp below applied the COARSEST tick to EVERY
// market, so 0.999 became 0.99 everywhere -- including on markets quoting in tenths of a
// cent, where 0.999 is perfectly reachable. The 0.991 bid is itself the proof: no 0.01 grid
// can quote it. The old comment called this "a tenth of a cent early", which was simply
// wrong -- on a 0.001 market it sells up to 0.9c a share below a certainty already reached.
//
// It never claims finer than the book has shown. A book quoting only round cents reads as a
// 0.01 grid and the clamp still applies there, which is the case it was written for: 0.999
// on a cent grid is unsatisfiable by construction and would otherwise never fire at all.
export function observedBookTick(book = {}) {
  const rows = [
    ...(Array.isArray(book?.bids) ? book.bids : []),
    ...(Array.isArray(book?.asks) ? book.asks : []),
  ];
  const prices = rows.map((row) => number(row?.price ?? row?.p)).filter((price) => price != null && price > 0);
  if (!prices.length) return COARSEST_MARKET_TICK;
  for (const tick of MARKET_TICK_CANDIDATES) {
    // Compared with a tolerance, not by equality: 0.991 / 0.001 is 990.9999999999999, and an
    // exact test would read every grid as the finest candidate.
    if (prices.every((price) => Math.abs(price / tick - Math.round(price / tick)) < 1e-6)) return tick;
  }
  return MARKET_TICK_CANDIDATES[MARKET_TICK_CANDIDATES.length - 1];
}

// The market's declared tick, remembered per token.
//
// Reading the book alone was not enough, and a position paid for it within the hour:
// "Coritiba FBC vs. CA Paranaense: O/U 1.5" quoted bid 0.99 with no ask, every visible
// price a round cent, so the book read as a 0.01 grid and 0.999 was clamped to 0.99. The
// market's real tick is 0.001 -- the order this very sale placed went out priced on it.
// The evidence was in hand on the other side of the same event and the trigger never saw it.
//
// A tick is a property of the market, so it is fetched once per token and kept. The lookup
// is a network call and the watch loop runs every second; a cache is what makes asking at
// all affordable.
const marketTickCache = new Map();
const MARKET_TICK_CACHE_LIMIT = 4000;
// When a token whose lookup failed may be asked about again.
//
// Every watched token is looked up in the same pass the moment the worker starts, so a
// burst Gamma refuses fails all of them at once. Remembering that failure pinned the whole
// account to book-only inference until the next restart -- which is what the 0.01 ticks in
// its log turned out to be, on markets Gamma declares at 0.001. Retrying every pass instead
// would ask again every second of a one-second loop, so a failure is held briefly and no
// longer: short enough that the level recovers on its own within a minute.
const marketTickRetryAt = new Map();
const MARKET_TICK_RETRY_DELAY_MS = 20000;

// Lets a test reach the far side of the backoff without waiting twenty seconds. Exported in
// the same spirit as observedBookTick and exitReason beside it: this module's internals are
// testable on purpose, because the alternative here was asserting on the shape of the source
// -- and that is exactly what passed while three separate versions of this sold early.
export function __resetMarketTickBackoffForTests(tokenId) {
  marketTickRetryAt.delete(String(tokenId || ""));
}

// Both halves of the market list, closed included.
//
// marketForToken asks with closed=false, which is right for the reversal that uses it. Here
// the worry was that a decided market -- which is exactly when this fires -- would have
// dropped out of the open half. Measured on the two markets that actually sold early, that
// is NOT what happened: both were still returned by closed=false, both declaring 0.001. So
// this is robustness rather than the fix, and the fix is the backoff above; it is kept
// because a market that does close between passes would otherwise lose its tick outright,
// and one extra request only happens when the open half came back empty.
async function marketForTokenIncludingClosed(tokenId) {
  for (const closed of ["false", "true"]) {
    const url = new URL(`${GAMMA_API}/markets`);
    url.searchParams.append("clob_token_ids", String(tokenId));
    url.searchParams.set("closed", closed);
    const markets = await fetchJson(url, `Gamma market for token ${tokenId}`);
    if (Array.isArray(markets) && markets[0]) return markets[0];
  }
  return null;
}

async function declaredMarketTick(tokenId) {
  const key = String(tokenId || "");
  if (!key) return null;
  const cached = marketTickCache.get(key);
  if (cached != null) return cached;
  // Still inside the backoff from a failed lookup: answer unknown without asking again.
  const retryAt = marketTickRetryAt.get(key);
  if (retryAt != null && Date.now() < retryAt) return null;
  let tick = null;
  try {
    const market = await marketForTokenIncludingClosed(key);
    const declared = number(market?.orderPriceMinTickSize);
    if (declared != null && declared > 0) tick = declared;
  } catch {
    // A lookup that fails leaves the book as the only evidence, which is where this
    // started. It must not be remembered as a coarse tick -- that is the bug, cached.
    tick = null;
  }
  // Only a real answer is remembered for good; a failure is held for the backoff above and
  // then asked again. Remembering the failure permanently was its own bug, and retrying it
  // every pass would be a second one.
  if (tick != null) {
    if (marketTickCache.size >= MARKET_TICK_CACHE_LIMIT) marketTickCache.clear();
    marketTickCache.set(key, tick);
    marketTickRetryAt.delete(key);
  } else {
    if (marketTickRetryAt.size >= MARKET_TICK_CACHE_LIMIT) marketTickRetryAt.clear();
    marketTickRetryAt.set(key, Date.now() + MARKET_TICK_RETRY_DELAY_MS);
  }
  return tick;
}

// The FINER of what the exchange declares and what the book demonstrates.
//
// Both can be too coarse on their own and each failure costs money in the same direction.
// The book misses a fine grid whenever it happens to be quoting round numbers, which is
// what sold Coritiba at 0.99. And the declared tick has been seen too coarse as well --
// the worker's own log holds an exit priced "tick 0.01" against a book quoting 0.999.
// Taking the finer of the two believes whichever one proves the market can quote closer to
// certainty, and neither can drag the level down alone.
export async function effectiveMarketTick(tokenId, book) {
  const observed = observedBookTick(book);
  const declared = await declaredMarketTick(tokenId);
  // An UNKNOWN declared tick is not a 0.01 tick, and this used to treat it as one by
  // falling back to the book.
  //
  // That fallback is wrong exactly when it is used. The observed tick is read from the
  // prices the book happens to be quoting, and a market approaching certainty quotes round
  // cents -- 0.98, 0.99 -- so "observed" reports 0.01 precisely at the moment the position
  // is about to be sold. The 0.999 the portfolio asked for was then lowered to 0.99 and the
  // position went a full cent early. Coritiba, Fortaleza and Games Total O/U 3.5 are all
  // this same path, each time through whatever made the declared lookup miss: a 404, a
  // network blip, the retry backoff.
  //
  // Unknown now means unknown, and an unknown grid never lowers the level. If the market
  // really is a 0.01 market the close simply does not fire and the position settles at
  // 1.00, which is MORE than the 0.99 the fallback was taking. The only cost is time, and
  // since the close only runs when the capital is actually needed, even that is bounded.
  if (declared == null) return null;
  return Math.min(declared, observed);
}

// The level the close can actually be reached at, or the level as configured when the grid
// is not known.
//
// Lowering to the nearest reachable tick is what makes 0.999 fire at all on a market that
// cannot quote it. But lowering on a GUESS is what sold three positions a cent early, so a
// missing tick no longer reduces anything: selling early is a permanent loss, waiting is
// only slower.
export function reachableSettlementCloseBid(closeBid, tickSize = null) {
  const level = number(closeBid);
  if (level == null || !(level > 0)) return null;
  const tick = number(tickSize);
  if (tick == null || !(tick > 0)) return level;
  return Math.min(level, round(1 - tick, 6));
}

// tickSize defaults to null, not to the coarsest grid: a caller that does not know the tick
// must not be treated as having measured a 0.01 one. That default is what made "no tick
// here" and "this market trades in cents" the same thing at the only place it matters.
export function exitReason({ bestBidPrice, bestAskPrice = null, stopPrice, triggerPrice, probabilityFloor = null, entryPrice = null, settlementCloseBid: closeBid, tickSize = null } = {}) {
  const floor = effectiveStopFloor({ stopPrice, probabilityFloor, entryPrice });
  if (floor != null) {
    // The pre-trigger buffer belongs to the level actually in force. Carrying the stored
    // trigger over would test the equal-risk floor's buffer against the probability floor.
    const trigger = floor === number(stopPrice) && triggerPrice != null
      ? triggerPrice
      : round(Math.min(0.999999, floor + STOP_PRETRIGGER_BUFFER), 6);
    if (exitTrigger({ bestBidPrice, bestAskPrice, stopPrice: floor, triggerPrice: trigger })) return "stop";
  }
  const bid = number(bestBidPrice);
  const reachable = reachableSettlementCloseBid(closeBid, tickSize);
  if (reachable != null && bid != null && bid >= reachable) return "settlement";
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

// The exchange's size grid for a SELL. The CLOB client floors to two decimals before
// signing, so this is the size an order will actually carry -- and asking for anything
// finer only means the difference is left behind as dust.
export function sellableSize(shares) {
  const value = number(shares);
  if (value == null || !(value > 0)) return 0;
  return Math.floor(value * 100) / 100;
}

function exitFilled(response) {
  // A FOK exit is useful only after the CLOB confirms the whole order matched.
  // Treating a generic `live`/`delayed` acknowledgement as a fill would stop
  // monitoring a position that is still exposed.
  return Boolean(response?.success) && String(response?.status || "").toLowerCase() === "matched";
}

// Taken by the exchange, not yet decided. The third answer, between a fill and a refusal,
// and the one this worker had no name for: every `delayed` response was written down as
// EXIT_REJECTED, which is false in both directions -- the order exists, and nothing has
// been rejected.
//
// Two things followed from having no name for it. Another order went out on the retry timer
// while the first was still queued, and when the queued one filled, nothing annotated the
// closed trade with the stop that sold it, because only the `matched` branch does that.
export function exitPendingMatch(response) {
  if (!response || response.success === false) return false;
  const status = String(response?.status || "").toLowerCase();
  // Decided already, in either direction. `unmatched` is the exchange saying a kill order
  // executed nothing, which for FOK/FAK is the end of it -- there is nothing left to wait for.
  if (status === "matched" || status === "unmatched") return false;
  // The order id is the evidence. A refusal carries an error and no id; an accepted order
  // carries an id whatever the exchange calls its state.
  return Boolean(response?.orderID);
}

// Whether a queued order is still worth waiting for, rather than re-sending on top of.
export function pendingExitIsOpen(record, now = Date.now(), windowMs = PENDING_MATCH_WINDOW_MS) {
  const since = Date.parse(String(record?.pending?.since || ""));
  if (!Number.isFinite(since)) return false;
  return now - since < windowMs;
}

// What the exchange says became of an order it queued. `size_matched` is the deciding
// field: a FOK that matched reports its whole size, and a status string alone cannot
// distinguish "still queued" from "queued, matched, and no longer open".
export function pendingOrderOutcome(order, { requestedShares = null } = {}) {
  if (!order) return { kind: "unknown", filled: false };
  const status = String(order?.status || "").toLowerCase();
  const matched = number(order?.size_matched, 0);
  const original = number(order?.original_size) ?? number(requestedShares);
  if (status === "matched" || (matched > 0 && original != null && matched >= original - 1e-9)) {
    return { kind: "filled", filled: true, sizeMatched: matched };
  }
  // Gone without matching. There is nothing to wait for and the next pass may try again at
  // once -- this is the one outcome where the ordinary retry timer is too slow, not too fast.
  if (["cancelled", "canceled", "unmatched", "expired", "killed"].includes(status)) {
    return { kind: "cancelled", filled: false, sizeMatched: matched };
  }
  if (["live", "delayed", "pending", "matching", "open"].includes(status)) {
    return { kind: "open", filled: false, sizeMatched: matched };
  }
  return { kind: "unknown", filled: false, sizeMatched: matched };
}

// Best effort, and deliberately so. A lookup that fails must not decide anything: the
// pending window expires on its own, and the worst case of not knowing is that the retry
// happens a minute later than it might have.
async function lookupOrder(orderId) {
  if (!orderId) return null;
  try {
    const { client } = await authenticatedClient();
    return await client.getOrder(String(orderId));
  } catch {
    // A filled or cancelled order is not an OPEN order, so the endpoint answering with a
    // 404 is itself ambiguous -- it means "not resting", which covers both. Treated as
    // unknown rather than read as either.
    return null;
  }
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
//
// "invalid maker amount" is one of those, and it took three attempts to see why. It is not a
// precision rule -- measured, every single one of them was an order for 0.0031 or 0.0034
// shares, which is below the minimum order size the exchange accepts. The order is dust. It
// cannot be resized into validity, only stopped: 333 of 500 retained events were this one
// refusal repeating, and the two fixes before this one were rules invented to explain it.
//
// The position filter above now keeps dust out of the watch list, so this should stop being
// reachable. It stays terminal for the case that gets there anyway -- a position that falls
// to dust between the watch plan and the order -- because retrying it forever is the actual
// damage: it floods the event history that every other diagnosis reads.
export function exitFailureIsTerminal(response) {
  const text = String(response?.errorMsg || response?.error || "");
  return /not enough balance|balance is not enough|no position to sell|invalid maker amount/i.test(text);
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
// Read as a fraction OF THE STOP, not as percentage points: a 50% tolerance under a 0.30
// floor declines below 0.15, not below a 0.30 minus 50 points that does not exist. That is
// what "under what I have set" means when the stop is itself a price.
//
// It was 10%, and 10% was too tight to survive a market that moves. Measured, on the trade
// that prompted widening it: Counter-Strike Map 2 Winner, stop 0.524963, and the price went
// from above the 0.527 trigger to a 0.45 bid between two one-second passes. 0.45 is 14% under
// the stop, so the stop declined, the bid then fell to 0.03, and the position resolved at
// zero. Selling at 0.45 would have capped the loss near 2.20; waiting cost the whole 4.95
// stake. A one-second loop cannot be late enough for 10% to be a reachable band.
//
// 50% still refuses every case the band was built for, which is the test that matters: the
// positions bought near 76-80c and sold at 1.5c and 5.7c had floors around 25-37c, so their
// bids sat at a tenth of the stop and are declined by a wide margin. A bid at half the stop
// is a real price on a book that has moved; a bid at a twentieth of it is somebody's lowball
// resting order.
const STOP_GAP_TOLERANCE = Math.min(1, Math.max(0, number(process.env.LIVE_EXIT_STOP_GAP_TOLERANCE, 0.5)));

// The lowest price this stop will accept. Null when there is no floor to measure against,
// which is the settlement close: that one takes the bid on purpose.
//
// Snapped DOWN to the market's price grid, because the band is compared against a bid and a
// bid can only exist on that grid. A 0.49 stop puts the raw line at 0.441, and on a one-cent
// tick the best price at or below that line is 0.44 -- so an un-snapped line refuses the only
// price inside its own band, and the effective tolerance becomes 8% instead of the 10% that
// was asked for. Measured: four positions declined at bid 0.44 against a 0.441 floor, missing
// by a tenth of a cent, while the rule exists to avoid twenty-point liquidations.
//
// One cent, not the market's real tick. Reading the true tick means a Gamma lookup, and this
// runs once a second for as long as a stop stays declined -- 1599 passes on one position in
// the last sample. On a finer grid this is at most one cent more generous than an exact 10%,
// which is immaterial against what the band is for, and it errs toward selling: the owner's
// instruction is that the stop should apply.
const STOP_GAP_PRICE_GRID = 0.01;

// How wide a spread a stop will still act on, and how much of the position the buyers have to
// be able to absorb.
//
// Reported with the book in evidence: Games Total O/U 2.5 on a match that had not started,
// $291 of volume in the whole market, an order book showing asks at 97-99c and "No bids" on
// the other side. A position bought at 75% left at about 25% for a 3.33 loss. Nothing had
// happened to the fixture -- there was simply no counterparty, and the price that fired the
// stop was the absence of one.
//
// exitTrigger already refuses to read a lone bid as a price when both sides are quoted: it
// makes the midpoint agree. The hole is the case with NO ask, where the bid stood alone by
// design, and that is exactly this book. So the test moves to the book itself.
//
// Three cents, as asked. It is deliberately tight, and it will refuse a lot of stops on these
// markets -- a 0.10 bid against a 0.90 ask is not a 3c spread and never will be. That is the
// instruction and it is the right way round: a stop that cannot be filled near its level is
// not protection, it is a market order into a vacuum.
const STOP_MAX_SPREAD = Math.max(0, number(process.env.LIVE_EXIT_STOP_MAX_SPREAD, 0.03));

// The buyers have to be able to take the whole position at or above the price the sell is
// priced at. That is not a guess about liquidity: it is what a fill-and-kill order can
// actually match against, so anything less is a partial exit at a worse price.
const STOP_MIN_DEPTH_FRACTION = Math.min(1, Math.max(0, number(process.env.LIVE_EXIT_STOP_MIN_DEPTH_FRACTION, 1)));

// Shares bid at or above a price. The size a sell at that price could actually fill against,
// summed over every level that qualifies rather than read off the top of the book -- a 5-share
// top bid does not sell a 6.6-share position however good its price is.
export function bidDepthShares(book = {}, atOrAbove = 0) {
  const floor = number(atOrAbove, 0) ?? 0;
  const bids = Array.isArray(book?.bids) ? book.bids : [];
  let shares = 0;
  for (const level of bids) {
    const price = number(level?.price ?? level?.p);
    const size = number(level?.size ?? level?.s ?? level?.amount, 0) || 0;
    if (price == null || !(price > 0) || price + 1e-9 < floor) continue;
    shares += size;
  }
  return round(shares, 6);
}

// Whether this book can absorb a protective sell at all. Null means it can; otherwise the
// reason, which is recorded so a position left open says why rather than looking unwatched.
//
// Never applied to a settlement close: that one takes the bid on purpose on a book that is
// quoting near certainty, where a one-sided book is the normal and correct shape.
export function stopBookIsUntradable({
  book,
  bestBidPrice,
  bestAskPrice,
  exitPrice,
  shares,
  maxSpread = STOP_MAX_SPREAD,
  minDepthFraction = STOP_MIN_DEPTH_FRACTION,
} = {}) {
  const bid = number(bestBidPrice);
  const ask = number(bestAskPrice);
  if (bid == null || !(bid > 0)) return null; // exitTrigger already refuses a bidless book.

  // No ask is not a tight book, it is half a book. Nobody is offering this outcome, so the
  // lone bid is the only number in the market and there is nothing to corroborate it with.
  if (ask == null || !(ask > 0)) {
    return {
      kind: "one-sided",
      spread: null,
      reason: `the book has a ${bid} bid and no ask at all, so the bid is the only number in`
        + ` this market and nothing corroborates it. A stop priced off it would be selling into`
        + ` the absence of a counterparty rather than into a fall`,
    };
  }

  const spread = round(ask - bid, 6);
  if (spread > maxSpread + 1e-9) {
    return {
      kind: "wide-spread",
      spread,
      reason: `the spread is ${spread} (bid ${bid}, ask ${ask}), wider than the ${maxSpread}`
        + ` a stop will act on. A book this wide has no agreed price, so the bid is a lowball`
        + ` order rather than what this position is worth`,
    };
  }

  // And enough capital behind that bid to take the position. Measured at or above the price
  // the sell would be priced at, because that is what the order can match against.
  const needed = round(Math.max(0, number(shares, 0) || 0) * minDepthFraction, 6);
  const available = bidDepthShares(book, number(exitPrice) ?? bid);
  if (needed > 0 && available + 1e-9 < needed) {
    return {
      kind: "thin-depth",
      spread,
      depthShares: available,
      neededShares: needed,
      reason: `the buyers show ${available} shares at or above ${number(exitPrice) ?? bid} and this`
        + ` position is ${round(number(shares, 0) || 0, 6)}. Selling into that fills a fraction at`
        + ` the top and the rest at whatever is underneath, which is a liquidation rather than a`
        + ` capped loss`,
    };
  }
  return null;
}

// A stop must not sell before the fixture has started. Asked for as a strict rule, with the
// trade and the market side by side: Counter-Strike A Great Chaos vs DNK, bought at 77.9%,
// exited around 50% for a 1.79 loss -- and Polymarket showed M1, M2 and M3 all blank on a
// market with 4.06K of volume. Not one map had been played. Nothing had happened to be
// right or wrong about; the price had drifted on a thin book and the stop sold into the
// drift.
//
// That is the general case, not one bad trade. Before kickoff there is no information for a
// price to carry, so a stop can only be reacting to noise, and the loss it books is real
// while the fall it reacted to is not.
//
// The kickoff is read on the same corroborated rule the paper bot uses
// (sportsScheduledEventDateDetail): a bare gameStartTime is NOT proof of a fixture, because
// Gamma populates it on non-sports markets too -- a tweet-count market carried the tracking
// window's start there with every other sports field blank -- so one of gameId,
// sportsMarketType, eventStartTime, teamAID or teamBID has to corroborate it.
//
// Slug-derived dates are deliberately not candidates. A date recovered from a slug is the
// DAY a fixture belongs to, stretched to 23:59:59, and treating a whole-day bucket as a
// kickoff would hold stops off for a whole day after the match had finished.
export function preciseKickoffAt(market = {}) {
  const events = Array.isArray(market?.events) ? market.events : [];
  const corroborated = Boolean(
    market?.gameId || market?.sportsMarketType || market?.eventStartTime
    || market?.teamAID || market?.teamBID,
  );
  const candidates = [
    corroborated ? market?.gameStartTime : null,
    market?.eventStartTime,
    ...events.flatMap((event) => [event?.gameStartTime, event?.eventStartTime, event?.startDateIso]),
  ];
  for (const candidate of candidates) {
    const parsed = Date.parse(String(candidate || ""));
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return null;
}

// True only when the kickoff is KNOWN and still ahead. An unknown kickoff abstains on
// purpose: refusing on the absence of a date would switch every stop off on any market
// Gamma does not schedule -- politics, and any fixture whose time it has not published --
// which is the opposite of a strict rule.
export function stopIsBeforeKickoff({ kickoffAt, now = Date.now() } = {}) {
  const kickoff = Date.parse(String(kickoffAt || ""));
  if (!Number.isFinite(kickoff)) return false;
  const at = typeof now === "number" ? now : Date.parse(String(now));
  return Number.isFinite(at) ? kickoff > at : false;
}

// How long a "no kickoff published" answer is trusted before Gamma is asked again. A known
// kickoff never changes and is kept for the life of the process; an unknown one is re-read
// occasionally because Gamma does fill schedules in late.
const KICKOFF_UNKNOWN_RECHECK_MS = 15 * 60 * 1000;

// The kickoff for a token, cached. A triggered stop re-runs every twenty seconds for as
// long as the book stays down, and asking Gamma on every one of those passes would spend a
// request a second on a date that does not move.
async function kickoffForToken(state, tokenId, at) {
  state.kickoffs = state.kickoffs || {};
  const cached = state.kickoffs[tokenId];
  if (cached) {
    if (cached.at) return cached.at;
    const checked = Date.parse(cached.checkedAt || "");
    if (Number.isFinite(checked) && Date.parse(at) - checked < KICKOFF_UNKNOWN_RECHECK_MS) return null;
  }
  let kickoff = null;
  try {
    kickoff = preciseKickoffAt(await marketForToken(tokenId));
  } catch {
    // A lookup that failed says nothing about the fixture. Recorded as unknown so the rule
    // abstains and the stop is decided by the other rules, rather than a Gamma outage
    // becoming a reason to hold every position.
    kickoff = null;
  }
  state.kickoffs[tokenId] = { at: kickoff, checkedAt: at };
  return kickoff;
}

export function stopGapFloorPrice(stopPrice, tolerance = STOP_GAP_TOLERANCE, grid = STOP_GAP_PRICE_GRID) {
  const floor = number(stopPrice);
  if (floor == null || !(floor > 0)) return null;
  const raw = round(floor * (1 - tolerance), 6);
  const snapped = roundToTick(raw, grid, "down");
  return snapped != null && snapped > 0 ? snapped : raw;
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

  // The amounts the last order was SIGNED with -- what the exchange itself saw, not what we
  // asked for. Those are not the same number: the CLOB client rounds a SELL size down before
  // signing, so a plan asking for 6.8472 shares is posted as 6.84, and every attempt to
  // explain "invalid maker amount" so far reasoned about the number we passed in.
  //
  // Two rounds of fixes were aimed at that gap, and the first measurement refuted the rule
  // they were built on. This closes the guessing: makerAmount and takerAmount are the two
  // fields the error names, in the exact base units the exchange judged.
  let signedAmounts = null;
  const sell = async (size, orderType) => {
    const signed = await client.createOrder(
      { tokenID: plan.tokenId, price, size, side: Side.SELL },
      options,
    );
    const order = signed?.order || signed;
    signedAmounts = {
      requestedShares: size,
      makerAmount: order?.makerAmount != null ? String(order.makerAmount) : null,
      takerAmount: order?.takerAmount != null ? String(order.takerAmount) : null,
    };
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
  // Dust is not a position, and the exchange will not take an order for it: measured, every
  // "invalid maker amount" refusal on this worker was an order for 0.0011 to 0.0075 shares.
  // The watch list already excludes them, so this is the position that fell to dust between
  // the plan and the order -- terminal, because the alternative is one refusal every twenty
  // seconds for the rest of the day.
  if (planned == null || planned < DUST_SHARES) {
    // Terminal only when the holding is genuinely tiny. An UNKNOWN size is not a fact about
    // the position at all -- it is a plan that failed to carry its share count -- and
    // treating the two the same is what froze nine live positions out of every later pass,
    // including every pass after the plan was fixed. A position whose size we could not read
    // is one to try again, not one to give up on.
    return {
      success: false, terminal: planned != null, exitPrice: price, tickSize: constraints.tickSize,
      plannedShares: planned, heldShares: null,
      error: planned == null
        ? "the position's share count was missing from the exit plan, so no order could be sized"
        : `the remaining ${planned} shares are dust,`
          + ` below the ${DUST_SHARES} the exchange will accept an order for`,
    };
  }
  // Asked for on the grid the exchange will sign it on, because the client floors a SELL size
  // to two decimals and the difference is not cosmetic.
  //
  // Measured across every sized order in the retained history, eight for eight: an order for
  // 6.5733 shares is signed as 6.57 and 0.0033 is left behind, and twenty seconds later this
  // worker sent an order for exactly that 0.0033 and was told "invalid maker amount". The
  // residue is asked minus floor(asked, 2) every single time.
  //
  // Sending the floored size does not remove the residue -- the exchange's size grid does
  // that -- but it makes the record honest, and the size we asked for is now the size an
  // order lookup can be compared against.
  let size = sellableSize(planned);
  if (!(size >= DUST_SHARES)) {
    return {
      success: false, terminal: true, exitPrice: price, tickSize: constraints.tickSize,
      plannedShares: planned, heldShares: null,
      error: `${planned} shares floor to ${size} on the exchange's two-decimal size grid,`
        + ` which is below the ${DUST_SHARES} it will accept an order for`,
    };
  }
  let response = await sell(size, OrderType.FOK);
  // Only when the FOK is DECIDED and did not fill. A queued FOK has not failed yet -- sending
  // the FAK on top of it is a second live order for the same shares, which is the duplicate
  // this pass is trying not to create.
  if (!exitFilled(response) && !exitPendingMatch(response) && ALLOW_PARTIAL) {
    response = await sell(size, OrderType.FAK);
  }

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
    size = sellableSize(Math.min(planned, held));
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

  return {
    ...response,
    exitPrice: price,
    tickSize: constraints.tickSize,
    exitShares: size,
    // The other half of the number the exchange judged. A row carrying only the price cannot
    // distinguish a bad price from a bad size, and the size is what "invalid maker amount"
    // turned out to be about: 0.0031 shares, below the exchange minimum. Three attempts to
    // explain that error were made while only the price was ever written down.
    makerAmountUsdc: round(price * size, 6),
    // In base units, off the signed order. The row above is what we asked for; this is what
    // was sent, and the two differ because the client rounds a SELL size down before signing.
    signedAmounts,
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

// Everything owed once a protective SELL has actually matched. Extracted because there are
// now two ways to learn that it did -- the order came back `matched`, or an order the
// exchange had queued is later found filled -- and the second one used to do none of this.
// A position sold by a queued order lost its dashboard annotation and its reverse.
async function afterExitFilled(context, plan, { reason, response, event = {}, at, bestBidPrice = null, bestAskPrice = null }) {
  const now = at || new Date().toISOString();
  // It sold, so it is no longer declining to.
  clearDeclinedStop(context.state, plan.tokenId);
  // Why this position was sold, sent before anything else is attempted: the reverse
  // below can fail, and the fill it follows still happened.
  await recordLiveExit(plan, { reason, response, bestBidPrice, bestAskPrice });
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

// What became of the orders the exchange took but had not decided. Run before the plans,
// for the same reason the reverses are: a queued order that filled has already removed the
// position from the account, so nothing in the plan list represents it any more and the
// pass below would never look at it again.
async function resolvePendingExits(context, heldTokenIds = null) {
  const held = heldTokenIds instanceof Set ? heldTokenIds : null;
  const entries = Object.entries(context.state.exits || {})
    .filter(([, record]) => record?.pending?.orderId);
  for (const [tokenId, record] of entries) {
    const pending = record.pending;
    // Throttled per order, and never at the cost of the window: once the window has run out
    // the record is released below whether or not it was due for a look.
    const checked = Date.parse(String(pending.checkedAt || ""));
    const due = !Number.isFinite(checked) || Date.now() - checked >= PENDING_MATCH_POLL_MS;
    if (!due && pendingExitIsOpen(record, Date.now())) continue;
    pending.checkedAt = new Date().toISOString();
    const order = await lookupOrder(pending.orderId);
    let outcome = pendingOrderOutcome(order, { requestedShares: pending.exitShares });
    // The account is the second witness, and often the only one: a filled FOK is not an OPEN
    // order, so the lookup that answers "is it still resting" cannot distinguish a fill from
    // a cancel. The position no longer being held is not ambiguous -- an order to sell it
    // was on the exchange, and it is gone.
    if (outcome.kind === "unknown" && held && !held.has(String(tokenId))) {
      outcome = { kind: "filled", filled: true, sizeMatched: pending.exitShares ?? null, via: "position" };
    }
    const now = new Date().toISOString();
    if (outcome.kind === "filled") {
      record.pending = null;
      record.terminal = true;
      record.status = "matched";
      recordEvent(context.state, {
        at: now,
        type: pending.reason === "settlement" ? "SETTLEMENT_CLOSE_FILLED" : "EXIT_FILLED",
        tokenId,
        question: pending.plan?.question || null,
        outcome: pending.plan?.outcome || null,
        orderId: pending.orderId,
        exitPrice: pending.exitPrice ?? null,
        exitShares: outcome.sizeMatched ?? pending.exitShares ?? null,
        queuedSince: pending.since,
        resolvedVia: outcome.via || "order",
        reason: outcome.via === "position"
          ? `the order the exchange queued at ${pending.since} filled: the account no longer holds this position`
          : `the order the exchange queued at ${pending.since} has matched`,
      });
      await afterExitFilled(context, pending.plan || { tokenId }, {
        reason: pending.reason,
        response: { ...pending, orderID: pending.orderId, status: "matched" },
        at: now,
        bestBidPrice: pending.bestBidPrice ?? null,
        bestAskPrice: pending.bestAskPrice ?? null,
      });
      continue;
    }
    if (outcome.kind === "cancelled") {
      // Decided, and it did not sell. The position is still exposed, so the next pass must
      // be free to try again immediately rather than wait out the retry timer.
      record.pending = null;
      record.lastAttemptAt = null;
      record.status = order?.status || "cancelled";
      recordEvent(context.state, {
        at: now,
        type: "EXIT_QUEUE_CANCELLED",
        tokenId,
        question: pending.plan?.question || null,
        orderId: pending.orderId,
        queuedSince: pending.since,
        reason: `the queued order ended as ${order?.status || "cancelled"} without matching; the stop is re-armed for the next pass`,
      });
      continue;
    }
    // Still queued, or the exchange would not say. Left alone until the window runs out --
    // and then released to the ordinary retry timer rather than held forever, because an
    // order nobody can account for must not become a stop that never tries again.
    if (!pendingExitIsOpen(record, Date.now())) {
      record.pending = null;
      recordEvent(context.state, {
        at: now,
        type: "EXIT_QUEUE_TIMED_OUT",
        tokenId,
        question: pending.plan?.question || null,
        orderId: pending.orderId,
        queuedSince: pending.since,
        reason: `the order queued at ${pending.since} is still ${outcome.kind === "unknown" ? "unaccounted for" : "unmatched"}`
          + ` after ${Math.round(PENDING_MATCH_WINDOW_MS / 1000)}s; the stop returns to the ordinary retry interval`,
      });
    }
  }
}

// Exit records outlive the positions they describe, and they are terminal on purpose. Held
// past the position they belong to, a token re-entered later starts with its stop already
// filtered out of every pass. Returns the tokens dropped, so a caller can say so.
export function pruneSettledExits(state, heldTokenIds) {
  const held = heldTokenIds instanceof Set ? heldTokenIds : new Set(Array.from(heldTokenIds || []).map(String));
  const dropped = [];
  for (const [tokenId, record] of Object.entries(state?.exits || {})) {
    if (held.has(String(tokenId))) continue;
    // An order is still on the exchange for it. The position being gone is the expected
    // shape here, not a reason to forget the order.
    if (record?.pending?.orderId) continue;
    delete state.exits[tokenId];
    dropped.push(String(tokenId));
  }
  return dropped;
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
// How often the standing row is also published to the dashboard. The row itself is updated
// every pass; posting it every pass would be one HTTP request a second per declined position,
// and 1599 of them for a single position in the last sample. Fifteen minutes keeps the bid on
// the dashboard current enough to judge the band without turning the annotation into traffic.
const DECLINED_STOP_PUBLISH_MS = 15 * 60 * 1000;

function recordDeclinedStop(state, plan, { bestBid, gapFloor, at, reason, declineKind = "gapped", spread = null, kickoffAt = null }) {
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
    // WHICH rule declined: the price is too far below the level, or the book cannot absorb
    // the sell at all. They read the same on the row -- a position still open with its stop
    // reached -- and they want opposite responses, so the row has to say which.
    declineKind,
    spread,
    // When the refusal is the clock rather than the book, the scheduled kickoff IS the
    // explanation and the row is unreadable without it.
    kickoffAt,
    firstAt: previous ? previous.firstAt : at,
    lastAt: at,
    count: previous ? (Number(previous.count) || 1) + 1 : 1,
    publishedAt: previous ? previous.publishedAt : null,
    reason,
  };
  // Whether the dashboard is due a copy of this row. Returned rather than acted on here, so
  // the caller owns the await and this stays a pure state update.
  const row = state.declinedStops[plan.tokenId];
  const publishedAt = Date.parse(row.publishedAt || "");
  const due = !Number.isFinite(publishedAt) || Date.parse(at) - publishedAt >= DECLINED_STOP_PUBLISH_MS;
  if (due) row.publishedAt = at;
  if (previous) return due;
  recordEvent(state, {
    // Named by the rule that declined it. Collapsing both into STOP_DECLINED_GAPPED would
    // make the event tally say "the book gapped" about a market where nothing had happened
    // and there was simply nobody on the other side.
    at,
    type: declineKind === "gapped" ? "STOP_DECLINED_GAPPED" : "STOP_DECLINED_UNTRADABLE",
    declineKind,
    tokenId: plan.tokenId,
    question: plan.question, outcome: plan.outcome,
    stopPrice: plan.stopPrice, gapFloor, bestBid, spread, kickoffAt, reason,
  });
  return due;
}

// A stop that sold, or a position that left the account, has nothing left to decline.
function clearDeclinedStop(state, tokenId) {
  if (state.declinedStops && state.declinedStops[tokenId]) delete state.declinedStops[tokenId];
}

// The standing row, sent to the dashboard so an open position can explain itself. Same
// endpoint and the same best-effort contract as a completed exit: the stop's decision stands
// whether or not the annotation is delivered, and a failed post must never become a crashed
// pass. The record is keyed by token, so this refreshes rather than accumulates.
async function recordDeclinedStopOnDashboard(state, plan, bestBid) {
  if (!TRADING_TRIGGER_KEY) return;
  const row = state.declinedStops?.[plan.tokenId];
  if (!row) return;
  const shares = number(plan.shares);
  const entry = number(plan.entryPrice);
  const bid = number(bestBid);
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
        reason: "stop-declined",
        portfolioId: String(plan.source || "").replace(/^portfolio:/, ""),
        question: plan.question,
        outcome: plan.outcome,
        stopPrice: row.stopPrice ?? plan.stopPrice ?? null,
        gapFloor: row.gapFloor ?? null,
        bestBid: bid,
        worstBid: row.worstBid ?? null,
        shares: shares ?? null,
        declinedSince: row.firstAt || null,
        declinedPasses: row.count ?? null,
        // Which rule refused, and the spread it refused on. Without these the row says only
        // "the stop did not sell", and the two reasons want opposite responses: a gapped book
        // has moved against the position, while a one-sided one has not moved at all.
        declineKind: row.declineKind || "gapped",
        declineSpread: row.spread ?? null,
        declineKickoffAt: row.kickoffAt ?? null,
        declineReason: row.reason || null,
        riskTargetUsdc: row.riskTargetUsdc ?? plan.riskTargetUsdc ?? null,
        // What refusing to sell is currently costing, at the bid it refused. The band is a
        // judgement call between two bad outcomes, and this is the number it is judged on.
        unrealizedPnlUsdc: shares != null && entry != null && bid != null
          ? round((bid - entry) * shares, 6)
          : null,
      }),
      signal: controller.signal,
    });
  } catch {
    // Swallowed on purpose, exactly as recordLiveExit does: the stop's decision is already
    // made and holds regardless, and the next publish window tries again.
  } finally {
    clearTimeout(timeout);
  }
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

// How long the same failure must have been gone before its return is worth a new row.
const WORKER_ERROR_EPISODE_MS = 600000;

// The third instance of the trap recordBookError and the declined stops above already fixed,
// and the worst of the three, because this one is not scoped to a single market. Measured on
// the Pi: 482 of the 500 retained events were WORKER_ERROR "fetch failed", one per second
// through a nine-minute outage of the host the worker polls, leaving eighteen rows for
// everything else the worker had ever done. Nine minutes of one unreachable host is enough
// to erase the record of a settlement close, a protective sell, or the single recorded dip
// this whole rule is meant to be judged by.
//
// So an identical message repeating becomes a counter, exactly as a repeating book error
// does. The first one is still written immediately -- noise is collapsed, the signal is not
// delayed -- and a failure that has been gone for WORKER_ERROR_EPISODE_MS opens a new
// episode, because "it broke again an hour later" is a different fact from "it never
// stopped", and a bare counter cannot tell them apart.
function recordWorkerError(state, error, at) {
  const message = error?.message || String(error);
  state.workerErrors = state.workerErrors && typeof state.workerErrors === "object" ? state.workerErrors : {};
  const previous = state.workerErrors[message];
  const gap = previous ? Date.parse(at) - Date.parse(previous.lastAt) : null;
  const continuing = Boolean(previous) && Number.isFinite(gap) && gap >= 0 && gap < WORKER_ERROR_EPISODE_MS;
  state.workerErrors[message] = {
    error: message,
    firstAt: continuing ? previous.firstAt : at,
    lastAt: at,
    count: continuing ? (Number(previous.count) || 1) + 1 : 1,
    episodes: previous ? (Number(previous.episodes) || 1) + (continuing ? 0 : 1) : 1,
    totalCount: previous ? (Number(previous.totalCount) || 0) + 1 : 1,
  };
  if (continuing) return;
  recordEvent(state, { at, type: "WORKER_ERROR", error: message });
}

// ---------------------------------------------------------------------------------------
// DIP ENTRY. One block, on purpose: this whole section, the dip-entry-watch endpoint and
// tools/dip-entry-rule.mjs are the entire feature, and deleting the three removes it.
//
// Asked for: buy a favourite that has collapsed inside a fixture already under way -- it
// opened at 70-80%, it is trading at 30-40% now -- and do it without waiting one to two
// minutes for a runner, with every other parameter already decided.
//
// So it lives here rather than in the hourly executor, for the reason written at the top of
// this file: speed matters for taking a chosen entry. This loop is already round every
// second with the signing key and the entry claim, and the trough lasts minutes.
//
// Everything slow is decided by api.php's dip-entry-watch: which tokens to watch, the size,
// the tick, the price ceiling, whether the wallet already holds the market, and how much
// cash there is. Nothing here ranks, filters or sizes. The two questions left are the only
// two that cannot be answered early -- is the book inside the band right now, and is there
// cash -- and then it places the order.
//
// The watch set is held HERE rather than served each time, because a dipped favourite
// leaves the catalogue: at 70-80% it is a row, at 35% it is not. Entries are picked up on
// the way in and kept until they expire.
const DIP_ENTRY_WATCH_URL = process.env.LIVE_DIP_ENTRY_WATCH_URL
  || "https://osobnizkusenosti.cz/trading/api.php?action=dip-entry-watch";
// Off unless deliberately armed, exactly like LIVE_EXIT_MODE. An experiment must not start
// buying because a file was deployed.
const DIP_ENTRY_MODE = String(process.env.LIVE_DIP_ENTRY_MODE || "off").trim().toLowerCase();
// How long a watch entry survives after the catalogue stops listing it. A fixture runs for
// an hour or two, and the entry has to outlive the collapse that removes the row.
const DIP_ENTRY_TTL_MS = clampInteger(process.env.LIVE_DIP_ENTRY_TTL_MS, 4 * 3600 * 1000, 600000, 24 * 3600 * 1000);
const DIP_ENTRY_MAX_SLIPPAGE = Number(process.env.LIVE_DIP_ENTRY_MAX_SLIPPAGE || 0.02);
const DIP_ENTRY_RECORD_URL = process.env.LIVE_DIP_ENTRY_RECORD_URL
  || "https://osobnizkusenosti.cz/trading/api.php?action=dip-entry-record";

// A paper portfolio's dip, recorded rather than bought.
//
// This is the half that makes the rule testable at all. The trough lasts minutes and the
// paper bot runs hourly, so a paper portfolio can never witness one from its own cadence --
// but this loop is already round every second with the same tokens in its batch. So it
// records WHEN the price entered the band and AT WHAT PRICE, and the bot opens a simulated
// position from that record: an entry at the price the dip actually reached, rather than at
// whatever the market has drifted to an hour later.
//
// Nothing is signed and no money moves, so this path runs whatever the live switches say --
// a paper test that needed the live keys armed would not be a paper test.
async function recordDipEntryHit(plan, price) {
  if (!TRADING_TRIGGER_KEY) return { ok: false, error: "dip entry record key is not configured" };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(DIP_ENTRY_RECORD_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-trading-trigger-key": TRADING_TRIGGER_KEY,
        "user-agent": "trading-live-exit-worker/1.0",
      },
      body: JSON.stringify({
        portfolioId: plan.portfolioId,
        tokenId: String(plan.tokenId),
        conditionId: plan.conditionId || "",
        question: plan.question || "",
        outcome: plan.outcome || "",
        slug: plan.slug || "",
        price,
        openProbability: plan.openProbability ?? null,
        volumeUsdc: plan.volumeUsdc ?? null,
        endDate: plan.endDate || "",
      }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload?.ok) return { ok: false, error: `HTTP ${response.status}` };
    return { ok: true, recorded: payload.recorded !== false };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  } finally {
    clearTimeout(timeout);
  }
}

function dipEntryPlanKey(plan) {
  return `${String(plan.portfolioId || "")}:${String(plan.tokenId || "")}`;
}

// Accumulate rather than replace. A plan that has left the catalogue keeps the fields it
// was prepared with; a plan still listed refreshes them.
function mergeDipEntryWatch(watch, payload, at) {
  const merged = watch instanceof Map ? watch : new Map();
  for (const plan of (Array.isArray(payload?.plans) ? payload.plans : [])) {
    if (!plan?.tokenId || !(Number(plan.buyMax) > 0)) continue;
    merged.set(dipEntryPlanKey(plan), { ...plan, seenAt: at });
  }
  for (const [key, plan] of merged) {
    // seenAt is Date.now(), a NUMBER. Reading it through Date.parse coerced it to a string
    // first -- "1757534..." parses as a year, not a timestamp -- so the age came out
    // meaningless and the TTL either expired everything at once or nothing ever.
    const seenAt = Number(plan.seenAt);
    if (!Number.isFinite(seenAt) || at - seenAt > DIP_ENTRY_TTL_MS) merged.delete(key);
  }
  return merged;
}

// Is the book inside the buy band. The ASK is what an entry pays, so the ask decides -- the
// bid would report a collapse the buyer cannot actually get filled at.
function dipEntryTrigger(plan, book) {
  const ask = bestAsk(book);
  if (ask == null || !(ask > 0)) return { fire: false, reason: "no executable ask" };
  if (ask > Number(plan.buyMax)) return { fire: false, reason: `ask ${ask} is above the buy band` };
  if (ask < Number(plan.buyMin)) return { fire: false, reason: `ask ${ask} is below the buy band` };
  return { fire: true, ask };
}

async function submitDipEntry(plan, book, cashUsdc) {
  const stake = Number(plan.stakeUsdc);
  if (!(stake > 0)) return { success: false, error: "no stake is configured for this portfolio" };
  if (!(Number(cashUsdc) >= stake)) {
    return { success: false, error: `cash ${cashUsdc} does not cover the ${stake} stake` };
  }
  // Marketable through the levels this size consumes, then capped at the band's ceiling.
  // The cap is the point: a worker that was one second late must not buy the recovery.
  const marketable = marketableBuyPrice({ book, notionalUsdc: stake, maxSlippage: DIP_ENTRY_MAX_SLIPPAGE });
  if (!(marketable > 0) || marketable >= 1) return { success: false, error: "no executable ask for the whole stake" };
  const price = Math.min(marketable, Number(plan.buyMax));
  const shares = Math.floor((stake / price) * 10000) / 10000;
  if (!(shares > 0)) return { success: false, error: "order size is below the exchange minimum" };
  const claimId = randomUUID();
  const claim = await claimLiveEntry(plan.tokenId, claimId);
  if (!claim.claimed) {
    return { success: false, error: `duplicate entry guard: ${claim.reason || "an equivalent live buy is already claimed"}` };
  }
  try {
    const { client, Side, OrderType } = await authenticatedClient();
    const signed = await client.createOrder({ tokenID: String(plan.tokenId), price, size: shares, side: Side.BUY }, {});
    // FAK first, for the same reason the stop-loss reversal does it: the rule asks for a
    // position to be opened, and a smaller one is still that position. FOK turned every
    // shortfall in depth into no position at all.
    let response = await client.postOrder(signed, OrderType.FAK, false);
    if (!exitFilled(response)) response = await client.postOrder(signed, OrderType.FOK, false);
    if (exitFilled(response)) await settleLiveEntryClaim("confirm", plan.tokenId, claimId);
    else await settleLiveEntryClaim("release", plan.tokenId, claimId);
    return { ...response, price: round(price, 6), shares: round(shares, 4), stakeUsdc: stake };
  } catch (error) {
    await settleLiveEntryClaim("release", plan.tokenId, claimId);
    return { success: false, error: error?.message || String(error), price: round(price, 6), shares: round(shares, 4) };
  }
}

// One pass over the watch set, given the books already fetched for this pass.
async function fireDipEntries(context, books, now) {
  const watch = context.dipWatch instanceof Map ? context.dipWatch : new Map();
  const entered = context.state.dipEntries && typeof context.state.dipEntries === "object"
    ? context.state.dipEntries
    : (context.state.dipEntries = {});
  const cash = Number(context.dipWatchPayload?.cashUsdc);
  for (const [key, plan] of watch) {
    // Bought once, ever. A price wobbling across the band's edge must not buy repeatedly,
    // and the claim alone would not stop it once the first order has settled.
    if (entered[key]?.terminal) continue;
    const book = books.get(String(plan.tokenId));
    if (!book) continue;
    const trigger = dipEntryTrigger(plan, book);
    if (!trigger.fire) continue;
    // Decided when the plan was prepared, and printed rather than hidden so the log says
    // why a market that reached the band was not bought.
    const event = {
      at: now,
      type: "DIP_ENTRY_TRIGGERED",
      portfolioId: plan.portfolioId,
      tokenId: plan.tokenId,
      question: plan.question,
      outcome: plan.outcome,
      openProbability: plan.openProbability,
      ask: trigger.ask,
      buyMin: plan.buyMin,
      buyMax: plan.buyMax,
      stakeUsdc: plan.stakeUsdc,
      cashUsdc: Number.isFinite(cash) ? cash : null,
    };
    if (plan.blockedReason) {
      recordEvent(context.state, { ...event, type: "DIP_ENTRY_BLOCKED", error: plan.blockedReason });
      entered[key] = { terminal: true, at: now, reason: plan.blockedReason };
      continue;
    }
    // A paper portfolio's dip is recorded, never bought. It runs whatever the live switches
    // say, because nothing is signed and no money moves -- and a paper test that needed the
    // live keys armed would not be a paper test.
    if (plan.accountType === "paper") {
      const recorded = await recordDipEntryHit(plan, trigger.ask);
      recordEvent(context.state, {
        ...event,
        type: recorded.ok ? "DIP_ENTRY_PAPER_RECORDED" : "DIP_ENTRY_PAPER_RECORD_FAILED",
        price: trigger.ask,
        error: recorded.ok ? null : recorded.error,
      });
      // A failed record is NOT terminal: the price is still in the band on the next pass, so
      // the next one can record it. A dip missed because a POST timed out is a dip lost.
      if (recorded.ok) entered[key] = { terminal: true, at: now, reason: "recorded for paper" };
      continue;
    }
    if (DIP_ENTRY_MODE !== "live" || MODE !== "live" || !CONFIRM_LIVE) {
      // Shadow: the whole decision is recorded, at the price it would have paid, and
      // nothing is sent. This is how the rule gets measured before it is trusted.
      recordEvent(context.state, { ...event, type: "DIP_ENTRY_SHADOW" });
      entered[key] = { terminal: true, at: now, reason: "shadow mode" };
      continue;
    }
    const response = await submitDipEntry(plan, book, cash);
    const filled = exitFilled(response);
    recordEvent(context.state, {
      ...event,
      type: filled ? "DIP_ENTRY_SUBMITTED" : "DIP_ENTRY_REJECTED",
      price: response?.price ?? null,
      shares: response?.shares ?? null,
      error: filled ? null : (response?.errorMsg || response?.error || "order was not accepted"),
    });
    // A rejection is terminal for this token too. The band is a moment; retrying into a
    // book that has already refused the size is how one decision became three orders.
    entered[key] = { terminal: true, at: now, reason: filled ? "submitted" : "rejected" };
  }
}
// ---------------------------------------------------------------------------------------

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
  // The dip-entry watch, on the same cadence and with the same tolerance for failure: a
  // watch that cannot be refreshed keeps the entries it already has, because the market it
  // is following has by then left the catalogue and could not be re-fetched anyway.
  if (DIP_ENTRY_MODE !== "off"
    && (!context.dipWatchPayload || Date.now() - (context.dipWatchFetchedAt || 0) >= STATE_REFRESH_MS)) {
    try {
      context.dipWatchPayload = await fetchJson(
        `${DIP_ENTRY_WATCH_URL}${DIP_ENTRY_WATCH_URL.includes("?") ? "&" : "?"}exitWorkerAt=${Date.now()}`,
        "dip entry watch",
      );
      context.dipWatch = mergeDipEntryWatch(context.dipWatch, context.dipWatchPayload, Date.now());
      context.dipWatchError = null;
    } catch (error) {
      context.dipWatchError = error?.message || String(error);
    }
    context.dipWatchFetchedAt = Date.now();
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

  // What the account actually holds, which is not the same as what is watched: a position
  // may be held and deliberately excluded from the watch list. Both the questions below are
  // about the position existing at all, so they ask this rather than the plan list.
  const heldTokens = new Set(livePositions(context.liveState)
    .map((position) => String(position.tokenId || position.assetId || ""))
    .filter(Boolean));

  // Orders the exchange queued and has not decided. Resolved here, after the live state, so
  // the account itself can answer: a filled FOK is not an OPEN order, so the order lookup
  // cannot tell a fill from a cancel, and the position being gone can.
  if (MODE === "live" && CONFIRM_LIVE) await resolvePendingExits(context, heldTokens);

  // Exit records for positions the account no longer holds are dropped here.
  //
  // Nothing ever removed them, and they are terminal by design -- "the account no longer
  // holds this position", "invalid maker amount", a fill. That is correct for as long as the
  // position exists and permanently WRONG once it does not: the record is keyed by token, so
  // a market re-entered later inherits a terminal row from its previous life and its stop is
  // then filtered out of every pass without ever being tried. A position with no stop is the
  // failure this whole file exists to prevent, so the record ends when the position does.
  // Measured on the Pi: 133 records retained, three positions watched, the oldest three days
  // old.
  //
  // Never a queued one: a pending order is precisely the case where the position vanishes
  // from the account BEFORE the record has done its job, which is how a filled queue gets
  // annotated at all. resolvePendingExits above runs first for that reason.
  pruneSettledExits(context.state, heldTokens);

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
    // Terminality earned by a DEFECT has to be released when the defect is fixed, or the fix
    // reaches no position that already hit it. Nine live positions were marked terminal by
    // the missing-share-count refusal above and would have stayed frozen for as long as they
    // were held, with the certainty close set, the bid at the setting, and the worker
    // skipping them every pass. Matched on the recorded reason rather than cleared wholesale:
    // a refusal from the exchange is still terminal and still means what it said.
    if (pending?.terminal && /share count was missing|shares are dust/.test(String(pending.error || ""))
      && number(plan.shares) != null && number(plan.shares) >= DUST_SHARES) {
      recordEvent(context.state, {
        at: new Date().toISOString(),
        type: "EXIT_TERMINAL_CLEARED",
        tokenId: plan.tokenId,
        question: plan.question || null,
        outcome: plan.outcome || null,
        shares: number(plan.shares),
        note: "the plan now carries a share count, so the refusal that had no size to work with is released",
      });
      delete pending.terminal;
      delete pending.error;
    }
    if (pending?.terminal) return false;
    // An order for this position is already on the exchange, queued and undecided. Sending
    // another is how one stop became three orders in 90 seconds, of which one filled and two
    // were sent into a position that had already been sold.
    if (pendingExitIsOpen(pending, Date.now())) return false;
    if (pending?.lastAttemptAt && Date.now() - Date.parse(pending.lastAttemptAt) < RETRY_INTERVAL_MS) return false;
    // Every plan, every pass. Settlement-only plans used to be held back to their own
    // slower interval because each one added a request; batching removed that cost, so the
    // reason is gone -- and holding a position back from the pass that would have sold it
    // is exactly the delay this loop exists to avoid.
    return true;
  });
  // The dip tokens ride the same batched /books call as the watched positions. A separate
  // fetch would add a round trip to every pass, which is the cost this batching removed in
  // the first place -- and the dip path needs the same speed the stop does.
  const dipTokens = [...(context.dipWatch instanceof Map ? context.dipWatch.values() : [])]
    .filter((plan) => !context.state.dipEntries?.[dipEntryPlanKey(plan)]?.terminal)
    .map((plan) => String(plan.tokenId));
  let observed = [];
  let dipBooks = new Map();
  try {
    const books = await fetchBooks([...new Set([...candidates.map((plan) => plan.tokenId), ...dipTokens])]);
    dipBooks = books;
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
    // The grid this market actually quotes on, from the exchange and the book together --
    // reading only the book sold a position at 0.99 whose market could quote 0.999.
    const marketTick = await effectiveMarketTick(plan.tokenId, book);
    // Recorded separately, and null when the exchange did not answer. A logged tick of
    // 0.01 could mean "this market quotes in cents" or "the lookup failed and something
    // defaulted", and those call for opposite fixes -- a whole round trip was spent
    // telling them apart by hand on a sale that had already happened.
    const declaredTick = await declaredMarketTick(plan.tokenId);
    const reason = exitReason({
      bestBidPrice: currentBestBid,
      bestAskPrice: currentBestAsk,
      stopPrice: plan.stopPrice,
      triggerPrice: plan.triggerPrice,
      probabilityFloor: plan.probabilityFloor,
      entryPrice: plan.entryPrice,
      settlementCloseBid: plan.settlementCloseBid,
      tickSize: marketTick,
    });
    // The level actually in force, which is what the sell is priced at and what the gap
    // tolerance is measured against. Using plan.stopPrice for either would price against a
    // floor the trigger did not use.
    const activeFloor = effectiveStopFloor({ stopPrice: plan.stopPrice, probabilityFloor: plan.probabilityFloor, entryPrice: plan.entryPrice });
    if (!reason) continue;
    event.reasonKind = reason;
    if (reason === "settlement") {
      event.settlementCloseBid = plan.settlementCloseBid;
      // The level the trigger actually used, which is not the stored one on an ordinary
      // 0.01 market. Recorded separately so a log never reports a number no book could meet.
      event.settlementCloseBidInForce = reachableSettlementCloseBid(plan.settlementCloseBid, marketTick);
      // And the grid that decided it, so a sale below the stored setting can be explained
      // from the log instead of re-derived. This one sold at 0.991 against a 0.999 setting
      // and there was no record of why.
      event.marketTick = marketTick;
      // What each source said, so the next surprise names its own cause. A null declared
      // tick now means the grid is unknown and the level was NOT lowered -- the book alone
      // never sets it, because a market at certainty quotes round cents.
      event.declaredTick = declaredTick;
      event.observedTick = observedBookTick(book);
    }
    if (MODE !== "live" || !CONFIRM_LIVE) {
      recordEvent(context.state, {
        ...event,
        type: reason === "settlement" ? "SHADOW_SETTLEMENT_CLOSE" : "SHADOW_STOP_TRIGGERED",
        reason: reason === "settlement"
          ? `the bid is ${currentBestBid} at or above the ${reachableSettlementCloseBid(plan.settlementCloseBid, marketTick)} settlement close`
            + ` (set to ${plan.settlementCloseBid}, capped at what the market's grid can quote);`
            + ` no SELL is allowed in shadow mode`
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
      let exitAsk = currentBestAsk;
      let exitBook = book;
      try {
        const fresh = await fetchJson(`${CLOB_HOST}/book?token_id=${encodeURIComponent(plan.tokenId)}`, `CLOB book ${plan.tokenId}`);
        const freshBid = bestBid(fresh);
        if (freshBid != null && freshBid > 0) {
          exitBid = freshBid;
          // The whole fresh book, not just its best bid: the depth and the spread are decided
          // on the same read as the price, or the three describe different moments.
          exitAsk = bestAsk(fresh);
          exitBook = fresh;
        }
      } catch {
        // Keep the bid the trigger was decided on rather than abandoning the exit.
      }
      // A book that cannot absorb this sell at all. Asked for after a position bought at 75%
      // was left at about 25% on a market with $291 of volume, asks on one side and no bids
      // on the other: nothing had happened to the fixture, there was no counterparty, and the
      // price that fired the stop was the absence of one.
      //
      // Only for a stop. A settlement close takes the bid on purpose on a book quoting near
      // certainty, where one-sided is the normal shape and refusing it would strand the
      // capital this rule exists to free.
      // Before the fixture starts, a stop can only be selling into noise. Checked FIRST of
      // the stop's refusals, because it is the most fundamental of them: the others describe
      // a book that has moved against the position, and this one says nothing has happened
      // at all yet. Reporting a wide spread on a match that has not begun would send the
      // reader after the book when the answer is the clock.
      if (reason === "stop") {
        const kickoffAt = await kickoffForToken(context.state, plan.tokenId, now);
        if (stopIsBeforeKickoff({ kickoffAt, now })) {
          const due = recordDeclinedStop(context.state, plan, {
            bestBid: exitBid,
            gapFloor: null,
            at: now,
            declineKind: "before-kickoff",
            kickoffAt,
            reason: `the fixture has not started yet -- it is scheduled for ${kickoffAt} -- so no`
              + ` result has happened for this price to be about. A stop here would be selling`
              + ` into a drift on a thin book rather than into a fall`,
          });
          if (due) await recordDeclinedStopOnDashboard(context.state, plan, exitBid);
          continue;
        }
      }
      if (reason === "stop") {
        const untradable = stopBookIsUntradable({
          book: exitBook,
          bestBidPrice: exitBid,
          bestAskPrice: exitAsk,
          exitPrice: protectedExitPrice({ stopPrice: activeFloor, bestBidPrice: exitBid }),
          shares: plan.shares,
        });
        if (untradable) {
          const due = recordDeclinedStop(context.state, plan, {
            bestBid: exitBid,
            gapFloor: null,
            at: now,
            declineKind: untradable.kind,
            spread: untradable.spread,
            reason: `${untradable.reason}. The position is left to resolve and the stop is`
              + ` re-checked every pass in case a real counterparty appears.`,
          });
          if (due) await recordDeclinedStopOnDashboard(context.state, plan, exitBid);
          continue;
        }
      }
      // A settlement close is not a stop: there is no floor to respect, because the point is
      // to take the bid the market is already showing. Passing the stop price here would
      // price the sell below a book that is quoting near certainty.
      // Decided on the FRESH bid, which is the one the sell would actually meet. Deciding
      // on the older read would decline against a price that has since recovered, or sell
      // into one that has since collapsed.
      if (reason === "stop" && stopGapIsTooWide({ bestBidPrice: exitBid, stopPrice: activeFloor })) {
        const limit = stopGapFloorPrice(activeFloor);
        const due = recordDeclinedStop(context.state, plan, {
          bestBid: exitBid,
          gapFloor: limit,
          at: now,
          reason: `the stop is ${activeFloor} and the best bid is ${exitBid}, below the ${limit} floor`
            + ` this stop will sell at (${(STOP_GAP_TOLERANCE * 100).toFixed(0)}% under the stop). Selling here`
            + ` would take far less than the level that was set, so the position is left to resolve`
            + ` and the stop is re-checked every pass in case the book recovers.`,
        });
        // Published to the dashboard, so the position can say on its own row why it is still
        // open with its stop long since reached. Rate-limited inside recordDeclinedStop --
        // this branch runs once a second for as long as the book stays down.
        if (due) await recordDeclinedStopOnDashboard(context.state, plan, exitBid);
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
    const queued = !accepted && exitPendingMatch(response);
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
      // An order that exists on the exchange and has not been decided yet. Everything the
      // fill will need is snapshotted here, because by the time it fills the position is
      // gone from the account and this plan is no longer in the pass -- which is exactly
      // why a queued exit that filled was never annotated on the closed trade.
      pending: queued
        ? {
          orderId: response?.orderID || null,
          status: response?.status || null,
          since: now,
          reason,
          bestBidPrice: currentBestBid,
          bestAskPrice: currentBestAsk,
          exitPrice: response?.exitPrice ?? null,
          exitShares: response?.exitShares ?? null,
          tickSize: response?.tickSize ?? null,
          plan: {
            tokenId: plan.tokenId,
            question: plan.question,
            outcome: plan.outcome,
            source: plan.source,
            shares: response?.exitShares ?? plan.shares,
            stopPrice: plan.stopPrice,
            triggerPrice: plan.triggerPrice,
            riskTargetUsdc: plan.riskTargetUsdc,
            reverseOnStopLoss: Boolean(plan.reverseOnStopLoss),
          },
        }
        : null,
    };
    const type = accepted
      ? (reason === "settlement" ? "SETTLEMENT_CLOSE_SUBMITTED" : "EXIT_SUBMITTED")
      : queued
        ? (reason === "settlement" ? "SETTLEMENT_CLOSE_QUEUED" : "EXIT_QUEUED")
        : (reason === "settlement" ? "SETTLEMENT_CLOSE_REJECTED" : "EXIT_REJECTED");
    recordEvent(context.state, {
      ...event,
      type,
      exitPrice: response?.exitPrice ?? null,
      tickSize: response?.tickSize ?? null,
      exitShares: response?.exitShares ?? null,
      makerAmountUsdc: response?.makerAmountUsdc ?? null,
      signedAmounts: response?.signedAmounts ?? null,
      response: { success: Boolean(response?.success), status: response?.status || null, error: response?.errorMsg || response?.error || null, orderId: response?.orderID || null },
    });
    if (accepted) {
      await afterExitFilled(context, plan, {
        reason, response, event, at: now,
        bestBidPrice: currentBestBid,
        bestAskPrice: currentBestAsk,
      });
    } else if (queued) {
      // The account is asked to refresh NOW rather than when the fill is noticed, because
      // the position disappearing IS how the fill gets noticed when the order lookup cannot
      // say -- a filled kill order is not an open order. Same dispatch a fill would make,
      // and measured on this account every queued exit filled, so it is not a wasted one.
      context.liveStateFetchedAt = 0;
      const sync = await notifyAccountSync();
      if (sync.attempted && !sync.ok) recordEvent(context.state, { at: new Date().toISOString(), type: "POST_EXIT_SYNC_ERROR", tokenId: plan.tokenId, error: sync.error });
    }
  }
  // After the exits, deliberately. An exit is protecting capital already committed and a dip
  // entry is committing more of it; if one pass can only do one of the two, the protection
  // goes first. The books are the ones already read above, so this costs no round trip and
  // reacts on the same one-second beat the stop does.
  if (DIP_ENTRY_MODE !== "off") {
    context.state.dipEntryMode = DIP_ENTRY_MODE;
    context.state.dipEntryWatchUrl = DIP_ENTRY_WATCH_URL;
    context.state.dipEntryError = context.dipWatchError || null;
    // What is being followed and what each entry would pay, so a pass that bought nothing
    // is still legible: the alternative is a watch set that can only be inferred from the
    // absence of events.
    context.state.dipEntryWatch = [...(context.dipWatch instanceof Map ? context.dipWatch.values() : [])]
      .map((plan) => ({
        portfolioId: plan.portfolioId,
        tokenId: plan.tokenId,
        question: plan.question,
        outcome: plan.outcome,
        openProbability: plan.openProbability,
        buyMin: plan.buyMin,
        buyMax: plan.buyMax,
        stakeUsdc: plan.stakeUsdc,
        blockedReason: plan.blockedReason || null,
        settled: context.state.dipEntries?.[dipEntryPlanKey(plan)]?.reason || null,
      }));
    try {
      await fireDipEntries(context, dipBooks, now);
    } catch (error) {
      // The dip rule is an experiment bolted onto the loop that protects real positions.
      // It must never be able to stop a stop loss from running on the next pass.
      recordEvent(context.state, { at: now, type: "DIP_ENTRY_ERROR", error: error?.message || String(error) });
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
      recordWorkerError(context.state, error, new Date().toISOString());
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
