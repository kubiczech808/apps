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

test("the burst that was reported, driven through the rule", () => {
  // Not a constructed fixture. These are the nine positions underwaycopy closed at
  // 2026-09-15T19:11:40 -- read back off production by the certainty burst probe, with their
  // real marks -- and they are the largest burst on record. Every one went at 0.9990, so the
  // portfolio paid a tick on nine positions to buy back capital that one would have covered.
  //
  // They carry no certaintyClosedAt on production because they predate the stamp; here they
  // are given one, because the rule reads the row the pass just built in memory and that row
  // always has it. What is real is the prices, the values and the count.
  const burst = [
    ["cs-forze-upgrade", 6.17],
    ["lol-mcon-senshi", 8.32],
    ["rayo-espanyol", 8.92],
    ["tiberias-jerusalem", 9.08],
    ["masry-ittihad", 8.61],
    ["grasshopper-sion", 9.08],
    ["brage-sandvikens", 8.32],
    ["al-ain", 8.47],
    ["riga-spread", 8.61],
  ].map(([id, value]) => ({
    ...closed(id, { price: 0.999, shares: Number((value / 0.999).toFixed(4)), cost: value - 0.5 }),
    currentValueUsdc: value,
  }));
  const originals = burst.map((trade) => ({ id: trade.id, status: "OPEN" }));

  const result = bot.holdExtraCertaintyCloses(burst, originals);

  const stillClosed = result.trades.filter((trade) => trade.closeReason === "certainty");
  assert.equal(stillClosed.length, 1,
    `nine decided positions must leave one close, not ${stillClosed.length}`);
  assert.equal(result.held.length, 8, "and eight held for a later pass");

  // The one kept is the one that hands back the most capital, which is what the close is for.
  // 9.08 twice, so the tie goes to the smaller forfeit and then to the id -- the same answer
  // every time it is computed, rather than whichever market answered first.
  assert.equal(result.closed, "grasshopper-sion");
  assert.equal(stillClosed[0].currentValueUsdc, 9.08);

  // What the portfolio would have paid without the rule, stated so the number is on record:
  // nine positions forfeiting a tick each instead of one.
  const forfeited = burst.reduce((sum, trade) => sum + (1 - trade.currentPrice) * trade.shares, 0);
  const kept = (1 - 0.999) * stillClosed[0].shares;
  assert.ok(forfeited > kept * 8,
    `the rule must be worth something: ${forfeited.toFixed(4)} paid vs ${kept.toFixed(4)}`);

  // And the eight held rows are held, not half-closed: nothing may still claim a close.
  for (const trade of result.trades.filter((row) => result.held.includes(row.id))) {
    assert.equal(trade.status, "OPEN");
    assert.equal(trade.closeReason, undefined);
    assert.equal(trade.certaintyClosedAt, undefined);
    assert.equal(trade.realizedPnlUsdc, undefined);
    assert.equal(trade.currentPrice, 0.999, "the refreshed mark is kept, so no stale price shows");
  }
});
