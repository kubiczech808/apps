// Runs offline: reads live-order-executor.mjs and checks which submitter the restore path
// reaches for. No network, no credentials, nothing executed against an exchange.
//
// Every BUY the executor places goes through the entry guard first -- a claim keyed on
// tokenId and side, refused when the account already holds that outcome or already rests a
// buy on it. That guard is the thing standing between a hesitation and a second position in
// one market.
//
// One BUY did not go through it. restoreCulledOrders -> restoreOpenOrder -> submitOrder
// went straight to the exchange: no claim taken, nothing written to live-entry-claims.json,
// and the guard's question never asked. It is not the mechanism behind the doubled position
// that was reported -- that was a false "this order left the book" record, fixed in
// live-account-sync.mjs -- but it is a hole of the same shape, and it was the only one left.
//
// culledOrdersToRestore already refuses a token the account rests or holds, so routing this
// through the guard changes nothing in the ordinary case. That is the point: a second lock
// on a door that has one. Where they disagree, the guard reads the account rather than the
// last published snapshot, and its refusal costs a bid that is not re-rested -- against a
// duplicate position in the other direction.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const SOURCE = readFileSync(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8");

// Brace-matched: slicing to "the next function" silently swallows the rest of the file the
// moment something is inserted between them, and an assertion that searches too much text
// passes for the wrong reason.
function functionBody(source, name) {
  const at = source.indexOf(`function ${name}(`);
  assert.ok(at > 0, `function ${name} was not found`);
  const start = source.slice(Math.max(0, at - 6), at) === "async " ? at - 6 : at;
  let depth = 0;
  for (let index = source.indexOf("{", source.indexOf(")", start)); index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`function ${name} is unbalanced`);
}

test("BAIT: a restored bid is submitted through the entry guard, not around it", () => {
  const body = functionBody(SOURCE, "restoreOpenOrder");
  assert.match(body, /submitLiveEntryWithMakerPrecisionRecovery\(order\)/,
    "the restore must take an entry claim like every other BUY");
  assert.ok(!/await submitOrder\(/.test(body),
    `the raw submitter bypasses the guard entirely: ${body.slice(0, 400)}`);
});

test("the guarded submitter is what actually holds the claim, so the routing means something", () => {
  // Pinned to the guard's own body: if the claim were ever dropped from it, routing the
  // restore through it would be routing through nothing, and the test above would still
  // pass while the hole reopened somewhere else.
  const guard = functionBody(SOURCE, "submitLiveEntryWithMakerPrecisionRecovery");
  assert.match(guard, /liveEntryClaimRequest\("claim"/, "it must claim before submitting");
  assert.match(guard, /claim\.claimed !== true/, "and refuse when the claim is not granted");
  assert.match(guard, /duplicate_guard/, "with a refusal a caller can recognise");
});

test("the restore still reports a plain response, so its callers read it unchanged", () => {
  // submitLiveEntryWithMakerPrecisionRecovery answers with { order, response, attempts },
  // and all three call sites treat restoreOpenOrder's return as the response itself --
  // successfulOrderResponse(response) would quietly be false for the wrapper, turning every
  // restore into a reported failure.
  const body = functionBody(SOURCE, "restoreOpenOrder");
  assert.match(body, /return submission\.response;/,
    "the wrapper must be unwrapped before it is returned");
  for (const caller of ["restoreCulledOrders"]) {
    const callerBody = functionBody(SOURCE, caller);
    assert.match(callerBody, /successfulOrderResponse\(response\)/,
      `${caller} reads the return as a response, which is what it must stay`);
  }
});
