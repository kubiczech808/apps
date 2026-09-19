// Runs offline: refreshClosedTradeOutcomes is the REAL function out of live-account-sync.mjs,
// executed with globalThis.fetch stubbed for the one HTTP call it makes (Gamma). No network,
// no secrets, no exchange.
//
// "dodelat ukol 18 chci, to se vsak ma dit pro vsechny eventy, bez ohledu na to zda byly
// zavreny stop lossem - pro statistiku."
//
// Task 18 as first reported was narrower: whether a stop-loss sale gave up a match that would
// have won. Measured on the account, 2026-09-18: "ShindeN vs Turma do Pagode" was sold by a
// stop loss its own portfolio never configured (a separate, already-fixed bug), for a loss --
// and nothing anywhere recorded whether the match itself was won or lost, because Polymarket's
// own trade history only tells us that for a REDEEMED position. Selling before resolution --
// by a stop, by the certainty close, by hand -- all look identical to that history: a sale,
// with no final price attached.
//
// refreshUnfilledLimitOrderOutcomes already asks Gamma this exact question for a bid that
// never filled. This is the same lookup, reused as-is (not reimplemented) and pointed at
// live.trades.closed, so every closed position is eventually graded regardless of why it
// closed.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const SYNC_PATH = new URL("../tools/live-account-sync.mjs", import.meta.url);
const SOURCE = readFileSync(SYNC_PATH, "utf8");
const sync = await import(SYNC_PATH);

// Swaps globalThis.fetch for the duration of one call and always restores it, even on
// failure. Matches the helper live-rotation.test.mjs already uses for the sibling function,
// so both grading paths are proven against the same fake Gamma.
async function withStubbedFetch(handler, run) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
    const body = handler(url);
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

const closedTrade = (id, tokenId, overrides = {}) => ({
  id,
  tokenId,
  status: "CLOSED",
  question: `Market ${id}`,
  outcome: "Yes",
  entryPrice: 0.7,
  shares: 7.14,
  realizedPnlUsdc: -1.52,
  exitReason: "stop",
  closedAt: "2026-09-18T23:48:43Z",
  finalOutcomePrice: null,
  ...overrides,
});

// Gamma's actual behaviour, as already measured for the sibling function: /markets answers
// clob_token_ids with an empty list until the market settles, and only closed=true reaches
// the settled row. Echoes back whichever token was actually asked for, so one handler can
// grade several different tokens in the same test the way a real batch would.
function settledMarketHandler(winningOutcome) {
  return (url) => {
    if (url.searchParams.get("closed") !== "true") return [];
    const tokenId = url.searchParams.get("clob_token_ids");
    return [{
      closed: true,
      clobTokenIds: JSON.stringify(["9000000000000000000", tokenId]),
      outcomePrices: JSON.stringify(winningOutcome === 0 ? ["1", "0"] : ["0", "1"]),
    }];
  };
}

test("a position sold before resolution -- for a match it went on to win -- is graded", () => {
  return withStubbedFetch(settledMarketHandler(1), async () => {
    const [refreshed] = await sync.refreshClosedTradeOutcomes(
      [closedTrade("shinden-vs-turma", "shinden-token")], "2026-09-19T04:00:00Z",
    );
    assert.equal(refreshed.finalOutcomePrice, 1,
      "sold by a stop, still graded as the match it actually was -- a would-be winner");
    assert.equal(refreshed.outcomeLastCheckedAt, "2026-09-19T04:00:00Z");
    // Nothing about why it closed is disturbed -- this is a purely additive field.
    assert.equal(refreshed.exitReason, "stop");
    assert.equal(refreshed.realizedPnlUsdc, -1.52);
  });
});

test("the same grading applies whatever closed the position -- settlement, stop-declined, unlabelled", () => {
  return withStubbedFetch(settledMarketHandler(0), async () => {
    const trades = [
      closedTrade("a", "tok-a", { exitReason: "settlement" }),
      closedTrade("b", "tok-b", { exitReason: "stop-declined" }),
      closedTrade("c", "tok-c", { exitReason: null }),
    ];
    const refreshed = await sync.refreshClosedTradeOutcomes(trades, "2026-09-19T04:00:00Z");
    assert.ok(refreshed.every((row) => row.finalOutcomePrice === 0),
      "the lookup is keyed on the token, not on the exit reason -- every collection member is eligible");
  });
});

test("BAIT: a trade already carrying finalOutcomePrice is never looked up again", () => {
  // A redeemed (held-to-settlement) trade already has this for free, straight from the
  // redemption event. Re-querying it would waste a Gamma call on every sync, forever, for
  // the trades that never needed this fix in the first place.
  let calls = 0;
  return withStubbedFetch((url) => { calls += 1; return []; }, async () => {
    const refreshed = await sync.refreshClosedTradeOutcomes(
      [closedTrade("already-known", "redeemed-token", { finalOutcomePrice: 1 })],
      "2026-09-19T04:00:00Z",
    );
    assert.equal(calls, 0, "a trade with a known result must not be looked up at all");
    assert.equal(refreshed[0].finalOutcomePrice, 1, "and its known result must survive untouched");
    assert.equal(refreshed[0].outcomeLastCheckedAt, undefined,
      "never queried, so never stamped -- a stamp here would misreport when it was actually checked");
  });
});

test("BAIT: the pass is bounded, and the next one reaches what the first left behind", () => {
  // The same resilience the unfilled-order queue already has, proven on this collection:
  // one unreachable or not-yet-settled market must not block everything behind it, and the
  // whole backlog must not be swept in a single sync.
  const trades = Array.from({ length: 20 }, (_, index) => closedTrade(`t${index}`, `token-${index}`));
  return withStubbedFetch(() => [], async () => {
    const first = await sync.refreshClosedTradeOutcomes(trades, "2026-09-19T04:00:00Z");
    const checkedFirst = first.filter((row) => row.outcomeLastCheckedAt === "2026-09-19T04:00:00Z");
    assert.equal(checkedFirst.length, 16, "one batch, matching the sibling queue's own bound");
    assert.ok(first.every((row) => row.finalOutcomePrice == null),
      "a market not yet settled must not be invented as a loss");

    const second = await sync.refreshClosedTradeOutcomes(first, "2026-09-19T05:00:00Z");
    const reachedBehind = second
      .filter((row) => !checkedFirst.some((done) => done.id === row.id))
      .filter((row) => row.outcomeLastCheckedAt === "2026-09-19T05:00:00Z");
    assert.equal(reachedBehind.length, 4, "the four rows the first pass could not reach");
  });
});

test("BAIT: a row with no token id is stamped rather than blocking the queue forever", () => {
  return withStubbedFetch(() => { throw new Error("must not be called for a tokenless row"); }, async () => {
    const [refreshed] = await sync.refreshClosedTradeOutcomes(
      [closedTrade("no-token", "", { assetId: "" })], "2026-09-19T04:00:00Z",
    );
    assert.equal(refreshed.outcomeLastCheckedAt, "2026-09-19T04:00:00Z");
    assert.equal(refreshed.finalOutcomePrice, null);
  });
});

test("BAIT: a Gamma failure never invents a result, and still rotates the queue", () => {
  return withStubbedFetch(() => { throw new Error("Gamma is down"); }, async () => {
    const [refreshed] = await sync.refreshClosedTradeOutcomes(
      [closedTrade("unreachable", "tok-x")], "2026-09-19T04:00:00Z",
    );
    assert.equal(refreshed.finalOutcomePrice, null, "an unknown result is not a loss");
    assert.equal(refreshed.outcomeLastCheckedAt, "2026-09-19T04:00:00Z",
      "still stamped, or this row would occupy the batch on every future pass");
  });
});

test("the lookup is the same function the unfilled-order queue already trusts, not a rewrite", () => {
  // gammaMarketForOpenOrder already tries the {} query and then { closed: "true" } -- proven
  // in production to be the only one that reaches a settled market. Reimplementing that
  // inside a second function is how the two paths would quietly drift apart.
  const start = SOURCE.indexOf("async function refreshClosedTradeOutcomes");
  assert.ok(start > 0, "refreshClosedTradeOutcomes must exist");
  const body = SOURCE.slice(start, SOURCE.indexOf("\n}\n", start));
  assert.match(body, /gammaMarketForOpenOrder\(tokenId\)/,
    "must call the shared lookup, not a second implementation of it");
  assert.ok(!/GAMMA_MARKET_QUERIES/.test(body),
    "the query-variant list belongs to the shared lookup alone");
});

test("BAIT: the main sync actually wires this into closedTrades, not just defines it", () => {
  const start = SOURCE.indexOf("const closedTrades = await refreshClosedTradeOutcomes(");
  assert.ok(start > 0, "the sync must call refreshClosedTradeOutcomes when it builds closedTrades");
  const nearby = SOURCE.slice(start, start + 400);
  assert.match(nearby, /stampPortfolioOwnership\(/,
    "the enrichment must wrap the same construction every other consumer of closedTrades reads");
});
