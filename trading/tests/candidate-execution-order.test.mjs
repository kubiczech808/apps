// Runs offline: the dashboard's real sorter and the bot's real ranking metric are both
// EXECUTED and compared against each other. No browser, no network.
//
// Asked for: "serad prilezitosti v execution candidates shora podle toho, jak se budou
// exekuovat pri stavajicich parametrech a nastaveni priority v portfoliu".
//
// The table was ordered by yield on every portfolio. The executor picks by the portfolio's
// Priority -- reward/risk or yield -- so on a Reward/risk portfolio the reader was looking at
// a list whose top row was not the row that would trade next.
//
// This has been both ways round before, and the reason it was reverted is the thing to keep
// from breaking again: ordering by Priority while the R/R column was missing made the rows
// look shuffled, because they were sorted on a number that was not on screen. So the test
// checks the order AND checks that the column is there to explain it.
//
// The strongest check available offline is agreement: the dashboard's order must match what
// the bot's own observationPriorityScore() ranks by, because a table that sorts correctly by
// its own definition and differently from the executor is the same bug with extra steps.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const APP = readFileSync(new URL("../assets/app.js", import.meta.url), "utf8");
const BOT = readFileSync(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} must exist`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, `${name} must be a complete function`);
  return source.slice(start, end + 2);
}

// The real sorter, with the handful of readers it leans on supplied. Everything that decides
// the order is the deployed code.
const harness = new Function(`
  ${extractFunction(APP, "sortPortfolioCandidates")}
  ${extractFunction(APP, "candidateSortChoice")}
  ${extractFunction(BOT, "observationPriorityScore")}

  const state = { mode: "paper", candidateSort: null };
  let config = {};
  const normalizeMode = (mode) => String(mode || "paper");
  const portfolioConfigForMode = () => config;
  const normalizeSelectionOrder = (value) =>
    String(value) === "highest_reward_risk_first" ? "highest_reward_risk_first" : "highest_ev_pa_first";
  // The row carries both metrics already, which is why ranking costs no rebuild.
  const evaluationRiskReward = (item) => item.riskReward;
  const portfolioAnnualizedReturn = (item) => item.annualizedReturn;
  const portfolioExpectedValue = (item) => item.expectedValue;
  const evaluationDaysLeft = (item) => item.daysLeft;
  const rewardRiskRatio = (item) => item.riskReward;
  ${extractFunction(APP, "portfolioCandidateSortValue")}

  return {
    sort: (rows, selectionOrder, sortChoice = null) => {
      config = { selectionOrder };
      state.candidateSort = sortChoice;
      return sortPortfolioCandidates(rows, "paper");
    },
    botScore: (item, selectionOrder) => observationPriorityScore(item, { selectionOrder }),
  };
`)();

// Rows where the two metrics disagree on the order, which is the only shape that can tell
// the two orderings apart.
const ROWS = [
  { id: "a", annualizedReturn: 900, riskReward: 0.2, expectedValue: 3, daysLeft: 5 },
  { id: "b", annualizedReturn: 400, riskReward: 0.9, expectedValue: 1, daysLeft: 2 },
  { id: "c", annualizedReturn: 650, riskReward: 0.5, expectedValue: 2, daysLeft: 9 },
];
const ids = (rows) => rows.map((row) => row.id);

test("a yield portfolio reads down by yield", () => {
  assert.deepEqual(ids(harness.sort(ROWS, "highest_ev_pa_first")), ["a", "c", "b"]);
});

test("a reward/risk portfolio reads down by reward/risk", () => {
  // The case that was wrong: by yield this list is a, c, b, and the executor would take b.
  assert.deepEqual(ids(harness.sort(ROWS, "highest_reward_risk_first")), ["b", "c", "a"]);
});

test("the order matches what the bot ranks by, not merely what the table calls a good row", () => {
  // The check that survives either metric being redefined later. Whatever the dashboard
  // sorts by, it has to be the same ranking the executor applies -- so this compares the
  // dashboard's output against the bot's own score rather than against a hard-coded list.
  for (const selectionOrder of ["highest_ev_pa_first", "highest_reward_risk_first"]) {
    const sorted = harness.sort(ROWS, selectionOrder);
    const scores = sorted.map((row) => harness.botScore(
      { ...row, potentialAnnualizedReturn: row.annualizedReturn }, selectionOrder));
    for (let index = 1; index < scores.length; index += 1) {
      assert.ok(scores[index - 1] >= scores[index],
        `${selectionOrder}: ${ids(sorted).join(",")} is not descending by the bot's own score`
        + ` (${scores.join(", ")})`);
    }
  }
});

test("BAIT: the two orderings must actually differ on this fixture", () => {
  // Without this the two tests above could both pass on a list that sorts the same way
  // either way, and the whole thing would prove nothing.
  assert.notDeepEqual(
    ids(harness.sort(ROWS, "highest_ev_pa_first")),
    ids(harness.sort(ROWS, "highest_reward_risk_first")),
  );
});

test("the metric the portfolio does not pick by is the first tie-break", () => {
  // So a reader can see why two rows with the same priority fell the way they did.
  const tied = [
    { id: "low", annualizedReturn: 100, riskReward: 0.5, expectedValue: 1, daysLeft: 3 },
    { id: "high", annualizedReturn: 800, riskReward: 0.5, expectedValue: 1, daysLeft: 3 },
  ];
  assert.deepEqual(ids(harness.sort(tied, "highest_reward_risk_first")), ["high", "low"]);
});

test("risk-blocked rows sink whatever the order", () => {
  const rows = [
    { id: "blocked", annualizedReturn: 5000, riskReward: 9, expectedValue: 9, daysLeft: 1,
      portfolioRiskBlockReason: "overlaps an open position" },
    ...ROWS,
  ];
  for (const order of ["highest_ev_pa_first", "highest_reward_risk_first"]) {
    assert.equal(ids(harness.sort(rows, order)).at(-1), "blocked",
      "an untradable row must never head the list, however good its numbers");
  }
  // And with a column sorted by hand, which is a separate code path.
  assert.equal(
    ids(harness.sort(rows, "highest_ev_pa_first", { key: "annualizedReturn", direction: "desc", mode: "paper" })).at(-1),
    "blocked");
});

test("clicking a column sorts by it, and clicking back restores the execution order", () => {
  const byDays = harness.sort(ROWS, "highest_ev_pa_first",
    { key: "days", direction: "asc", mode: "paper" });
  assert.deepEqual(ids(byDays), ["b", "a", "c"], "ascending days");

  const byDaysDown = harness.sort(ROWS, "highest_ev_pa_first",
    { key: "days", direction: "desc", mode: "paper" });
  assert.deepEqual(ids(byDaysDown), ["c", "a", "b"], "descending days");

  assert.deepEqual(ids(harness.sort(ROWS, "highest_ev_pa_first", null)), ["a", "c", "b"],
    "cleared, the list goes back to the order the executor picks in");
});

test("a sort chosen on another portfolio does not follow", () => {
  // The columns differ between portfolios -- R/R only exists on a Reward/risk one -- so a
  // carried-over choice would sort the list by a column that is not on screen, which is the
  // complaint that made this table stop sorting by Priority in the first place.
  const sorted = harness.sort(ROWS, "highest_ev_pa_first",
    { key: "days", direction: "asc", mode: "live-custom" });
  assert.deepEqual(ids(sorted), ["a", "c", "b"], "the execution order, not the other mode's sort");
});

test("the columns that can be sorted are the ones the sorter understands", () => {
  // A header that looks clickable and sorts by nothing is worse than a plain one. Every
  // data-candidate-sort key in the markup must be a key portfolioCandidateSortValue() reads.
  const known = ["riskReward", "annualizedReturn", "expectedValue", "aiProbability", "days"];
  const used = [...APP.matchAll(/candidateSortHeader\([^,]+,\s*"(\w+)"/g)].map(([, key]) => key);
  assert.ok(used.length >= 3, `the headers must be sortable: ${used.join(", ")}`);
  for (const key of used) {
    assert.ok(known.includes(key), `${key} is offered as a sort but the sorter returns 0 for it`);
  }
});

test("the reward/risk column is on screen whenever the list is ordered by it", () => {
  // The reason this ordering was reverted once: sorted by a number that was not in the
  // table, the rows read as shuffled. The column and the ordering share one condition.
  const block = APP.slice(APP.indexOf("const showRiskReward ="));
  assert.match(block.slice(0, 200), /normalizeSelectionOrder\(config\.selectionOrder\) === "highest_reward_risk_first"/);
  const sorter = APP.slice(APP.indexOf("function sortPortfolioCandidates"));
  assert.match(sorter.slice(0, 900), /prioritizesRiskReward \? "riskReward" : "annualizedReturn"/,
    "the sort must key off the same setting the column does");
});
