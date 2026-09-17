// Runs offline: the bot's real exports, driven with real positions. No network, no secrets.
//
// Reported: "stava se, ze probehne zpracovani certainty, resp. uzavreni pozic na urovni
// 99.9 kdyz je cash mensi nez stake. to je spravne, ale staci kdyz se v tu chvili za jeden
// beh zavre pouze 1 z pozic, pri spusteni teto logiky se nyni zavrou hned vsechny."
//
// And they must have. The gate each position reads is "can the portfolio fund another
// stake", which is one fact about the ACCOUNT decided once for the whole pass -- so the
// moment it says no, it says no to every decided position at once and all of them sell a
// tick below 1.00. One close is normally enough to buy the next stake back; the rest pay
// the forfeit for nothing.

import assert from "node:assert/strict";
import test from "node:test";

const bot = await import("../tools/paper-trading-bot.mjs");

const CHECKED_AT = "2026-09-17T20:30:00.000Z";

// A position as the pass leaves it after a certainty close: the shape markOpenTrade returns.
const closed = (id, { price = 0.998, shares = 10, cost = 8 } = {}) => ({
  id,
  status: "CLOSED",
  closeReason: "certainty",
  certaintyClosedAt: CHECKED_AT,
  closedAt: CHECKED_AT,
  resolvedAt: CHECKED_AT,
  shares,
  stakeUsdc: cost,
  totalCostUsdc: cost,
  currentPrice: price,
  lastLiveBid: price,
  currentValueUsdc: Number((price * shares).toFixed(4)),
  unrealizedPnlUsdc: 0,
  unrealizedPnlPct: 0,
  realizedPnlUsdc: Number((price * shares - cost).toFixed(4)),
  realizedPnlPct: 10,
  settlementCloseBid: 0.99,
  statusNote: "Sold at 0.9980, at or above this portfolio's 0.9900 certainty threshold.",
});

const open = (id) => ({ id, status: "OPEN", shares: 10, totalCostUsdc: 8 });

test("only one decided position is sold on a pass", () => {
  // Three positions, all over the threshold, all closed by the fan-out.
  const marked = [
    closed("small", { shares: 5, cost: 4 }),
    closed("big", { shares: 40, cost: 32 }),
    closed("middle", { shares: 12, cost: 10 }),
  ];
  const result = bot.holdExtraCertaintyCloses(marked, [open("small"), open("big"), open("middle")]);

  const stillClosed = result.trades.filter((trade) => trade.closeReason === "certainty");
  assert.equal(stillClosed.length, 1, "exactly one close, not three");
  // The one that hands back the most capital: one close, the most capital freed, which is
  // what the close is for.
  assert.equal(result.closed, "big");
  assert.deepEqual(result.held.sort(), ["middle", "small"]);
});

test("a held position goes back to being held, and says so", () => {
  const marked = [closed("keep", { shares: 40, cost: 32 }), closed("hold", { shares: 5, price: 0.995, cost: 4 })];
  const { trades } = bot.holdExtraCertaintyCloses(marked, [open("keep"), open("hold")]);
  const held = trades.find((trade) => trade.id === "hold");

  assert.equal(held.status, "OPEN", "it is an open position again");
  // Nothing may be left claiming the close happened: a row with a closedAt and an OPEN
  // status is counted by one screen and not the other.
  for (const field of ["closeReason", "certaintyClosedAt", "closedAt", "resolvedAt", "realizedPnlUsdc", "realizedPnlPct"]) {
    assert.equal(field in held, false, `${field} must be gone from a position that was not sold`);
  }
  // The refreshed marks are kept -- the price this pass actually saw -- so the dashboard
  // does not show a stale quote for a whole cycle as the price of holding it back.
  assert.equal(held.currentPrice, 0.995);
  assert.equal(held.currentValueUsdc, 4.975, "marked at the bid, gross, the way an open position is");
  assert.equal(held.unrealizedPnlUsdc, 0.975, "and its open P/L follows from that, not from zero");
  assert.match(String(held.statusNote), /another decided position/);
});

test("a position that was not open before this pass is not this pass's close", () => {
  // A certainty close booked yesterday still carries closeReason and certaintyClosedAt. If
  // those counted, a portfolio closing its first position today would look like it was
  // closing two and would hold the real one back.
  const yesterday = { ...closed("older"), certaintyClosedAt: "2026-09-16T10:00:00.000Z" };
  const result = bot.holdExtraCertaintyCloses(
    [yesterday, closed("today", { shares: 4, cost: 3 })],
    [{ id: "older", status: "CLOSED" }, open("today")],
  );
  assert.equal(result.closed, "today", "the only close this pass made must be allowed to stand");
  assert.deepEqual(result.held, []);
  assert.equal(result.trades.find((trade) => trade.id === "older").closeReason, "certainty",
    "and a close already booked is not reopened");
});

test("one close is left alone, and so is none", () => {
  const one = bot.holdExtraCertaintyCloses([closed("only")], [open("only")]);
  assert.deepEqual(one.held, []);
  assert.equal(one.closed, "only");
  assert.equal(one.trades[0].status, "CLOSED");

  const none = bot.holdExtraCertaintyCloses([{ id: "x", status: "OPEN" }], [open("x")]);
  assert.deepEqual(none.held, []);
  assert.equal(none.closed, null);
});

test("the choice is the same however the markets answered", () => {
  // The fan-out finishes in whatever order the book replies, so a rule that depended on
  // array order would sell a different position every pass and be untestable.
  const rows = [closed("a", { shares: 10, cost: 8 }), closed("b", { shares: 10, cost: 8 }), closed("c", { shares: 10, cost: 8 })];
  const originals = [open("a"), open("b"), open("c")];
  const forwards = bot.holdExtraCertaintyCloses(rows, originals).closed;
  const backwards = bot.holdExtraCertaintyCloses([...rows].reverse(), originals).closed;
  assert.equal(forwards, backwards, "identical positions must resolve to the same choice");

  // And with equal capital freed, the smaller forfeit wins: same money back, less given up.
  const mixed = bot.holdExtraCertaintyCloses(
    [closed("cheap", { shares: 10, price: 0.99, cost: 8 }), closed("dear", { shares: 10, price: 0.999, cost: 8 })],
    [open("cheap"), open("dear")],
  );
  assert.equal(mixed.closed, "dear");
});

test("the pass applies the rule before it decides funding", async () => {
  // A certainty close is where the capital a resting fill needs comes from, so funding has
  // to see the closes that actually happened rather than the three the fan-out proposed.
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");
  const order = [
    "const certainty = holdExtraCertaintyCloses(refreshed, trades);",
    "const funding = fundLimitOrderFills(trades, certainty.trades, portfolioState);",
  ].map((line) => source.indexOf(line));
  assert.ok(order.every((index) => index > 0), "both steps must be present");
  assert.ok(order[0] < order[1], "the hold-back runs first, and funding reads its result");
  // And the early return for a portfolio with no state must carry the held rows too, or
  // the rule would silently not apply to it.
  assert.match(source, /if \(!portfolioState\) return certainty\.trades;/);
});
