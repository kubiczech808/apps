import assert from "node:assert/strict";
import test from "node:test";

import { gammaRowsForEvent, selectCandidateSide, selectGammaMarketSamples, shapeSummary } from "../tools/dip-gamma-backtest.mjs";

const event = {
  slug: "wta-player-a-player-b-2026-09-25",
  title: "WTA: Player A vs Player B",
  startTime: "2026-09-25T12:00:00Z",
  closedTime: "2026-09-25T14:00:00Z",
  tags: [{ slug: "tennis" }],
  markets: [{
    conditionId: "condition-1",
    question: "WTA: Player A vs Player B",
    outcomes: '["Player A","Player B"]',
    outcomePrices: '["1","0"]',
    clobTokenIds: '["12345678901234567890","23456789012345678901"]',
    createdAt: "2026-09-25T10:00:00Z",
    gameStartTime: "2026-09-25 12:00:00+00",
    closedTime: "2026-09-25T14:00:00Z",
    feesEnabled: true,
    feeSchedule: { rate: 0.05 },
  }],
};

test("Gamma tennis source creates one settled side per CLOB token and uses kickoff, not market startDate", () => {
  const rows = gammaRowsForEvent(event, Date.parse("2026-10-01T00:00:00Z"));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].shape, "outright");
  assert.equal(rows[0].eventStartTime, "2026-09-25 12:00:00+00");
  assert.equal(rows[0].firstFeeRate, 0.05);
  assert.equal(rows[0].tags[0], "tennis");
  assert.deepEqual(rows.map((row) => row.finalOutcomePrice), [1, 0]);
});

test("Gamma sample picks at most the favourite side of one market", () => {
  const selected = selectCandidateSide([
    { status: "complete", verifiedOpening: true, openingInBand: true, openingPrice: 0.68, tokenId: "loser" },
    { status: "complete", verifiedOpening: true, openingInBand: true, openingPrice: 0.82, tokenId: "winner" },
  ]);
  assert.equal(selected.tokenId, "winner");
});

test("Gamma source limits every shape to one market per event, not correlated props", () => {
  const rows = gammaRowsForEvent(event, Date.parse("2026-10-01T00:00:00Z"));
  const secondMarket = rows.map((row) => ({ ...row, marketKey: "condition-2", tokenId: `9${row.tokenId.slice(1)}` }));
  const selected = selectGammaMarketSamples([...rows, ...secondMarket], 100);
  const outright = selected.get("outright");
  assert.equal(outright.size, 1);
  assert.equal([...outright.values()][0].length, 2, "only the complementary outcomes of one market remain");
});

test("a shape is not recommended until it reaches the requested number of executable entries", () => {
  const rows = gammaRowsForEvent(event, Date.parse("2026-10-01T00:00:00Z"));
  const completed = {
    [rows[0].tokenId]: {
      status: "complete", verifiedOpening: true, openingInBand: true, openingPrice: 0.7,
      entries: { "0.56": { enteredAt: "2026-09-25T12:30:00Z", entryPrice: 0.55, feeUsdc: 0.1125, pnlUsdc: 3.978409, outcome: "WIN" } },
    },
    [rows[1].tokenId]: { status: "complete", verifiedOpening: true, openingInBand: false, openingPrice: 0.3, entries: {} },
  };
  const summary = shapeSummary(rows, completed, { target: 100 }).find((row) => row.shape === "outright");
  assert.equal(summary.sourceMarkets, 1);
  assert.equal(summary.sourceEvents, 1);
  assert.equal(summary.historyWithVerifiedOpeningMarkets, 1);
  assert.equal(summary.openingBandMarkets, 1);
  assert.equal(summary.eligibleEntries, 1);
  assert.equal(summary.minimumEligibleEntriesMet, false);
  assert.match(summary.recommendation, /1\/100/);
});
