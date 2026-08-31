import assert from "node:assert/strict";
import test from "node:test";

const bot = await import("../tools/paper-trading-bot.mjs");

test("paper reversal chooses only the opposite binary token", () => {
  const market = {
    outcomes: JSON.stringify(["Yes", "No"]),
    clobTokenIds: JSON.stringify(["yes-token", "no-token"]),
  };
  assert.deepEqual(bot.oppositeBinaryOutcome(market, { outcome: "Yes", tokenId: "yes-token" }), {
    eligible: true,
    outcome: "No",
    tokenId: "no-token",
    outcomeIndex: 1,
  });
  assert.equal(bot.oppositeBinaryOutcome({ outcomes: "[\"A\",\"B\",\"C\"]", clobTokenIds: "[\"a\",\"b\",\"c\"]" }, { tokenId: "a" }).eligible, false);
});
