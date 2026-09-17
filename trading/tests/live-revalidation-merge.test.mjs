// Runs offline: api.php is executed as a real POST against real segment files on disk, and
// the files are read back afterwards. No network, no secrets, no database.
//
// Measured on live execution run 35262648170 (101 seconds end to end), the single most
// expensive step was "Persist current live market verification into evaluation state" at
// 39 seconds -- more than a third of the run, and more than seven times the 5 seconds the
// actual decision and order submission took together. It cost that because it pulled the
// evaluations and observations segments down over FTP, patched a handful of rows in Python,
// and pushed the whole catalogue back. The observations segment is the 8,091-row catalogue
// and is measured in megabytes; the verdicts that change it are a few hundred bytes.
//
// This endpoint is the other way round: the verdicts travel, the catalogue stays put. That
// only helps if the merge does exactly what the Python did, so these tests are written
// against the rules that script encoded -- newer verdict wins, economics are copied only
// when carried, a gone market is closed out, an unsettled one says so -- rather than against
// the new code's own shape.

import assert from "node:assert/strict";
import test from "node:test";
import { merge, row } from "./live-revalidation-merge-harness.mjs";

const find = (rows, tokenId) => rows.find((item) => item.tokenId === tokenId);

// What the executor actually sends: it re-fetched the market, so it knows the current price
// and the economics that follow from it.
const REVALIDATED = {
  tokenId: "aaa",
  checkedAt: "2026-09-17T12:40:00.000Z",
  marketPrice: 0.71,
  marketProbability: 0.71,
  annualizedReturn: 1.1,
  expectedValueUsdc: 0.18,
  liquidity: 3100,
  orderPrice: 0.71,
  orderSize: 7,
  verdict: "PRICE_MOVED",
};

test("the verdict lands in every segment that holds the token", () => {
  const { payload, evaluations, observations } = merge({ updates: [REVALIDATED] });
  assert.equal(payload.ok, true, `the merge must run: ${JSON.stringify(payload).slice(0, 400)}`);
  // Token aaa is in both segments; a merge that wrote one and not the other would leave the
  // two disagreeing about the same market, which is worse than not writing at all.
  assert.equal(payload.merged, 2);
  assert.deepEqual(payload.segments, ["evaluations", "observations"]);

  for (const rows of [evaluations, observations]) {
    const merged = find(rows, "aaa");
    assert.equal(merged.executionRevalidation.verdict, "PRICE_MOVED");
    assert.equal(merged.executionRevalidation.checkedAt, REVALIDATED.checkedAt);
    // The re-measured economics replace the scan's, or the shortlist keeps ranking the
    // candidate on a price that has already moved.
    assert.equal(merged.marketPrice, 0.71);
    assert.equal(merged.annualizedReturn, 1.1);
    assert.equal(merged.liquidity, 3100);
    assert.equal(merged.updatedAt, REVALIDATED.checkedAt);
    // Still a live candidate: nothing said this market was gone.
    assert.equal(merged.status, "SCRAPED");
    assert.equal(merged.selectionStatus, "READY");
  }

  // And the rows nobody revalidated are exactly as they were.
  assert.deepEqual(find(evaluations, "bbb"), row("bbb"));
  assert.deepEqual(find(observations, "ccc"), row("ccc"));
});

test("a market that is gone is closed out for good", () => {
  // The reason the step exists at all: without this the prefilter keeps shortlisting a
  // delisted market and every run pays for a live fetch just to reject it again.
  const { payload, evaluations, observations } = merge({
    updates: [{ tokenId: "aaa", checkedAt: "2026-09-17T12:40:00.000Z", marketGone: true, verdict: "MARKET_GONE" }],
  });
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.closedOut, ["aaa"]);

  // As strings. PHP turns a numeric string into an integer array key, so a short numeric
  // token id came back as a number while a 77-digit one -- which is what Polymarket
  // actually issues -- stayed a string. Found by driving this endpoint with the live
  // executor's own verdict in tests/live-rotation.
  const numeric = merge({
    updates: [{ tokenId: "111", checkedAt: "2026-09-17T12:40:00.000Z", marketGone: true }],
    evaluations: [row("111")],
    observations: [row("111")],
  });
  assert.deepEqual(numeric.payload.closedOut, ["111"]);
  for (const rows of [evaluations, observations]) {
    const closed = find(rows, "aaa");
    assert.equal(closed.status, "CLOSED");
    assert.equal(closed.selectionStatus, "CLOSED");
    assert.equal(closed.marketClosed, true);
    assert.equal(closed.acceptingOrders, false);
    // Not awaiting anything: Gamma dropped it.
    assert.equal(closed.awaitingResolution, undefined);
    assert.equal(closed.closedReason, undefined);
  }
});

test("a finished market that has not settled says so", () => {
  // Two different ends look identical once a row reads CLOSED. On the day of its own match
  // a row leaving the candidate list has to be distinguishable from a delisted one, or the
  // reason is lost with it.
  const { evaluations } = merge({
    updates: [{
      tokenId: "aaa", checkedAt: "2026-09-17T12:40:00.000Z", marketGone: true, awaitingResolution: true,
    }],
  });
  const closed = find(evaluations, "aaa");
  assert.equal(closed.status, "CLOSED");
  assert.equal(closed.awaitingResolution, true);
  assert.equal(closed.closedReason, "finished, awaiting Polymarket resolution");
});

test("an older verdict never overwrites a newer one", () => {
  // Live runs overlap -- two portfolios execute against the same catalogue, and the queue
  // can deliver them out of order. The newer answer has to win whichever order they arrive.
  const stored = {
    executionRevalidation: { checkedAt: "2026-09-17T12:50:00.000Z", verdict: "FRESH" },
    marketPrice: 0.9,
  };
  const { payload, evaluations, observations } = merge({
    updates: [REVALIDATED],
    evaluations: [row("aaa", stored)],
    observations: [row("aaa", stored)],
  });
  assert.equal(payload.merged, 0, "a stale verdict is not news");
  for (const rows of [evaluations, observations]) {
    assert.equal(find(rows, "aaa").executionRevalidation.verdict, "FRESH");
    assert.equal(find(rows, "aaa").marketPrice, 0.9, "and the newer economics stand too");
  }
  assert.deepEqual(payload.segments, [], "nothing changed, so nothing is rewritten");
});

test("a verdict about one field never blanks another", () => {
  // The executor sends what it measured. A merge that copied the whole list would write
  // nulls over the scan's economics for every field this particular check did not look at.
  const { evaluations } = merge({
    updates: [{ tokenId: "aaa", checkedAt: "2026-09-17T12:40:00.000Z", marketPrice: 0.71 }],
  });
  const merged = find(evaluations, "aaa");
  assert.equal(merged.marketPrice, 0.71, "what was sent is written");
  assert.equal(merged.annualizedReturn, 1.9, "what was not sent keeps the scan's value");
  assert.equal(merged.expectedValueUsdc, 0.44);
  assert.equal(merged.liquidity, 4200);
});

test("a state that was never segmented is merged in place", () => {
  // The bug this script had once already: the catalogue moved into sibling files and the
  // merge kept writing to the core, so no verdict was ever persisted and nothing said so.
  // The mirror image has to work too.
  const { payload, evaluations, observations } = merge({ updates: [REVALIDATED], segmented: false });
  assert.equal(payload.ok, true);
  assert.equal(payload.merged, 2);
  assert.equal(find(evaluations, "aaa").marketPrice, 0.71);
  assert.equal(find(observations, "aaa").marketPrice, 0.71);
});

test("a token the catalogue does not hold leaves the files untouched", () => {
  const before = merge({ updates: [] });
  const { payload, raw } = merge({ updates: [{ tokenId: "not-in-the-catalogue", checkedAt: "2026-09-17T12:40:00.000Z" }] });
  assert.equal(payload.ok, true);
  assert.equal(payload.merged, 0);
  // Not written at all -- rewriting a megabyte-scale segment to change nothing is the cost
  // this endpoint exists to avoid. Measured with a bait: the byte comparison below does NOT
  // catch this on its own, because re-encoding this fixture happens to reproduce it exactly.
  // It is the report of which segments were written that distinguishes the two.
  assert.deepEqual(payload.segments, []);
  assert.equal(raw.evaluations, before.raw.evaluations);
  assert.equal(raw.observations, before.raw.observations);
});

test("an empty update list is accepted without touching anything", () => {
  const { payload } = merge({ updates: [] });
  assert.equal(payload.ok, true);
  assert.equal(payload.merged, 0);
  assert.match(String(payload.note), /no revalidated candidates/);
});

test("the catalogue cannot be rewritten without the key", () => {
  // This writes the shortlist every portfolio reads. Closing rows out is exactly what an
  // unauthenticated caller would want to do.
  for (const key of [null, "wrong-key"]) {
    const { payload, evaluations } = merge({ updates: [REVALIDATED], key });
    assert.equal(payload.ok, false, `key ${key} must be refused`);
    assert.match(String(payload.error), /key/i);
    assert.equal(find(evaluations, "aaa").marketPrice, 0.62, "and nothing may be written");
  }
});

test("a GET is refused", () => {
  // Same-origin GETs are made by the browser on every page load; this one writes.
  const { payload, evaluations } = merge({ updates: [REVALIDATED], method: "GET" });
  assert.equal(payload.ok, false);
  assert.match(String(payload.error), /POST is required/);
  assert.equal(find(evaluations, "aaa").marketPrice, 0.62);
});
