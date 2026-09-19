// Runs offline: unfilledLimitOrderHistory is the REAL function out of
// live-account-sync.mjs, EXECUTED. No network, no host.
//
// "ok smaz je, ale presvedc se, ze jen neuhasis problem. hledej i pricinu a oprav ji"
//
// Two causes, not one. The first -- a single absent read taken as proof an order had left
// the book -- is fixed in vanishedOpenOrders and covered by live-rotation.test.mjs. This is
// the second, and it is the one that made the first permanent: the ledger those rows land
// in was APPEND-ONLY. Every row ever written was carried forward by every later sync, with
// nothing able to take one back, so no amount of correct syncing afterwards could retire a
// row that a bad read had invented.
//
// Measured on the account, 2026-09-18: twenty-three rows recorded as
// LIVE_LIMIT_ORDER_UNFILLED, NINE of them naming a token the account was still resting or
// already holding. Those nine are not ambiguous -- a row says one specific thing, that THIS
// order left the book WITHOUT becoming anything, and the account was contradicting it
// outright.
//
// So the deletion asked for and the cause are the same change: a row the account
// contradicts is retired by the next sync, which both clears the nine and stops any future
// bad row from outliving the mistake that made it.

import assert from "node:assert/strict";
import test from "node:test";

const sync = await import("../tools/live-account-sync.mjs");

const row = (id, tokenId, overrides = {}) => ({
  id,
  orderId: id,
  tokenId,
  assetId: tokenId,
  question: `Q-${id}`,
  outcome: "Yes",
  price: 0.73,
  limitPrice: 0.73,
  remainingSize: 6.84,
  releasedCapitalUsdc: 4.9932,
  stakeUsdc: 4.9932,
  mode: "LIVE_LIMIT_ORDER",
  status: "LIVE_LIMIT_ORDER_UNFILLED",
  detectedAt: "2026-09-18T18:27:32.618Z",
  closedAt: "2026-09-18T18:27:32.618Z",
  ...overrides,
});

const idsOf = (rows) => rows.map((item) => item.id).sort();

test("a row the exchange contradicts by naming the order is retired", () => {
  const previousState = { unfilledLimitOrders: [row("a", "111"), row("b", "222")] };
  const kept = sync.unfilledLimitOrderHistory(previousState, {}, {
    // "a" is on the book after all -- by its own id, so this is the same order, not a
    // later one on the same market.
    openOrdersAll: [{ id: "a", tokenId: "111", status: "LIVE", remainingSize: 6.84 }],
    positions: [],
  });
  assert.deepEqual(idsOf(kept), ["b"], "the order that never left must not stay recorded as gone");
});

test("a row the account contradicts by holding the outcome is retired", () => {
  const previousState = { unfilledLimitOrders: [row("a", "111"), row("b", "222")] };
  const kept = sync.unfilledLimitOrderHistory(previousState, {}, {
    openOrdersAll: [],
    positions: [{ tokenId: "111", shares: 13.68 }],
  });
  assert.deepEqual(idsOf(kept), ["b"],
    "capital cannot have come back untouched from an outcome the account is holding");
});

test("BAIT: a row nothing contradicts is kept, so real history is not swept up with the wrong ones", () => {
  // The whole risk of a retirement rule is that it deletes the truth along with the
  // mistake. An order that really did leave the book unfilled is named by nobody and held
  // by nobody, and must survive every sync.
  const previousState = { unfilledLimitOrders: [row("a", "111"), row("b", "222"), row("c", "333")] };
  const kept = sync.unfilledLimitOrderHistory(previousState, {}, {
    openOrdersAll: [{ id: "zzz", tokenId: "999", status: "LIVE", remainingSize: 1 }],
    positions: [{ tokenId: "888", shares: 5 }],
  });
  assert.deepEqual(idsOf(kept), ["a", "b", "c"], "an uncontradicted row is genuine history");
});

test("BAIT: a zero-share position is not a holding and must not retire anything", () => {
  // A redeemed or fully exited position can linger at zero size. Reading that as "the
  // account holds this outcome" would quietly delete rows on every market it ever traded.
  const previousState = { unfilledLimitOrders: [row("a", "111")] };
  const kept = sync.unfilledLimitOrderHistory(previousState, {}, {
    openOrdersAll: [],
    positions: [{ tokenId: "111", shares: 0 }],
  });
  assert.deepEqual(idsOf(kept), ["a"], "nothing is held, so nothing is contradicted");
});

test("BAIT: called without the account, the ledger is left exactly as it was", () => {
  // Any caller that cannot say what the account holds must not be able to empty the list
  // by saying nothing -- absent evidence is not contradiction.
  const previousState = { unfilledLimitOrders: [row("a", "111"), row("b", "222")] };
  assert.deepEqual(idsOf(sync.unfilledLimitOrderHistory(previousState, {})), ["a", "b"]);
  assert.deepEqual(idsOf(sync.unfilledLimitOrderHistory(previousState, {}, {})), ["a", "b"]);
});

test("a newly vanished order is still recorded, and matches the account it was read from", () => {
  // The retirement must not eat the row the same pass is writing: the merge happens after
  // it, and an order that genuinely left is neither named nor held.
  const kept = sync.unfilledLimitOrderHistory(
    { unfilledLimitOrders: [] },
    {
      vanished: [{
        id: "new", tokenId: "444", price: 0.7, remainingSize: 7.14,
        releasedCapitalUsdc: 4.998, partiallyFilled: false, filledSize: 0,
        detectedAt: "2026-09-19T05:00:00Z", createdAt: "2026-09-19T04:00:00Z",
      }],
    },
    { openOrdersAll: [], positions: [] },
  );
  assert.deepEqual(idsOf(kept), ["new"]);
  assert.equal(kept[0].status, "LIVE_LIMIT_ORDER_UNFILLED");
  assert.equal(kept[0].releasedCapitalUsdc, 4.998);
});

test("the nine contradicted rows measured on the account are exactly what this clears", () => {
  // The shape of the real data, so the rule is checked against the case it was written
  // for rather than only against invented ones: some rows still resting, some now held,
  // and the rest genuinely gone.
  const previousState = {
    unfilledLimitOrders: [
      row("resting-1", "t1"), row("resting-2", "t2"), row("resting-3", "t3"),
      row("held-1", "t4"), row("held-2", "t5"),
      row("gone-1", "t6"), row("gone-2", "t7"),
    ],
  };
  const kept = sync.unfilledLimitOrderHistory(previousState, {}, {
    openOrdersAll: [
      { id: "resting-1", tokenId: "t1", status: "LIVE", remainingSize: 6.49 },
      { id: "resting-2", tokenId: "t2", status: "LIVE", remainingSize: 7.14 },
      // Named by the exchange but no longer restable -- matched, settling into a position.
      // Still a contradiction: it did not leave the book unfilled.
      { id: "resting-3", tokenId: "t3", status: "MATCHED", remainingSize: 0 },
    ],
    positions: [{ tokenId: "t4", shares: 6.84 }, { tokenId: "t5", shares: 6.75 }],
  });
  assert.deepEqual(idsOf(kept), ["gone-1", "gone-2"],
    "five contradicted rows retired, two genuine departures kept");
});
