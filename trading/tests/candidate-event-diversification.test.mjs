// Runs offline. The dashboard's real shortlist rule is EXECUTED, on the real risk keys the
// production catalogue holds for the fixture that was reported.
//
// Reported with two screenshots: "Will Israel win on 2026-09-27?" and "Will Republic of
// Ireland win on 2026-09-27?" side by side in the candidates list, both READY, both on No,
// both ending 20:45. They are the two sides of one match, and a portfolio that takes both
// has one bet at twice the stake.
//
// Measured against the live catalogue before changing anything: both rows DO carry
// event:unl-isr-ire-2026-09-27, so the keys were never the fault. candidateRiskBlockReason
// compared each candidate only against OPEN positions, and before either side is held that
// comparison has nothing to say -- so the shortlist never applied the rule among its own
// rows and both read READY.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const APP = readFileSync(new URL("../assets/app.js", import.meta.url), "utf8");

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} must exist`);
  const prefix = source.slice(Math.max(0, start - 6), start);
  const from = prefix.endsWith("async ") ? start - 6 : start;
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, `${name} must be a complete function`);
  return source.slice(from, end + 2);
}

const rule = new Function(`
  ${extractFunction(APP, "candidatesAfterEventRule")}
  return candidatesAfterEventRule;
`)();

// Exactly what the production catalogue holds for these two rows, read off a walk of the
// active scope on 2026-09-27. Not invented: the point of the test is that the rule fires on
// the real keys.
const ISRAEL = {
  question: "Will Israel win on 2026-09-27?",
  slug: "unl-isr-ire-2026-09-27-isr",
  riskGroupKeys: ["market:unl-isr-ire-2026-09-27-isr", "event:unl-isr-ire-2026-09-27", "topic:iran-war", "team:israel"],
};
const IRELAND = {
  question: "Will Republic of Ireland win on 2026-09-27?",
  slug: "unl-isr-ire-2026-09-27-ire",
  riskGroupKeys: ["market:unl-isr-ire-2026-09-27-ire", "event:unl-isr-ire-2026-09-27", "team:republic of ireland"],
};
const keysOf = (item) => item.riskGroupKeys;

test("both sides of one fixture cannot both be READY", () => {
  const { ready, blocked } = rule([ISRAEL, IRELAND], keysOf);

  assert.equal(ready.length, 1, "one bet on one match");
  assert.equal(ready[0].question, ISRAEL.question, "the better-ranked row keeps READY");
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].question, IRELAND.question);
  // The reason has to name the OTHER bet. "Excluded by diversification rules" was the same
  // sentence on every blocked row and answered nothing.
  assert.match(blocked[0].portfolioRiskBlockReason, /event:unl-isr-ire-2026-09-27/);
  assert.match(blocked[0].portfolioRiskBlockReason, /Will Israel win on 2026-09-27\?/);
});

test("the row that would trade is the one that keeps READY", () => {
  // Order in, order out: the caller hands the list in execution order, so whichever side
  // ranks first is the one the portfolio would actually take.
  const { ready, blocked } = rule([IRELAND, ISRAEL], keysOf);
  assert.equal(ready[0].question, IRELAND.question);
  assert.equal(blocked[0].question, ISRAEL.question);
});

test("a shared team or topic is not a shared bet", () => {
  // topic:iran-war matches on the word "israel" alone, which ties an Israeli football match
  // to an oil market; team:israel ties two different fixtures the moment a side plays twice
  // in the window. Blocking on those would hide real opportunities, so only event: and
  // match: count -- the same two prefixes the fixed-entry batch claims on.
  const oil = { question: "Will Brent close above $95 in October?", riskGroupKeys: ["market:brent-oct", "topic:iran-war"] };
  const nextWeek = {
    question: "Will Israel win on 2026-10-11?",
    riskGroupKeys: ["market:unl-isr-ita-2026-10-11-isr", "event:unl-isr-ita-2026-10-11", "topic:iran-war", "team:israel"],
  };
  const { ready, blocked } = rule([ISRAEL, oil, nextWeek], keysOf);
  assert.equal(ready.length, 3, "three different bets");
  assert.equal(blocked.length, 0);
});

test("a match key links a fixture whose rows carry no common event slug", () => {
  // Exact-score and O/U lines of one fixture share match:<a>-vs-<b> even where the event
  // slugs differ ("-more-markets" is its own event), so the match key has to count too.
  const scoreLine = {
    question: "Exact Score: Israel 1 - 0 Republic of Ireland?",
    riskGroupKeys: ["market:isr-ire-1-0", "event:unl-isr-ire-2026-09-27", "match:israel-vs-republic of ireland"],
  };
  const overUnder = {
    question: "Israel vs. Republic of Ireland: O/U 2.5",
    riskGroupKeys: ["market:isr-ire-ou-2pt5", "event:unl-isr-ire-2026-09-27-more-markets", "match:israel-vs-republic of ireland"],
  };
  const { ready, blocked } = rule([scoreLine, overUnder], keysOf);
  assert.equal(ready.length, 1);
  assert.match(blocked[0].portfolioRiskBlockReason, /match:israel-vs-republic of ireland/);
});

test("a row with no event key of its own is its own bet", () => {
  const loose = { question: "Will it rain in Prague tomorrow?", riskGroupKeys: ["market:prague-rain", "topic:weather"] };
  const alsoLoose = { question: "Will it snow in Brno tomorrow?", riskGroupKeys: ["market:brno-snow", "topic:weather"] };
  const { ready, blocked } = rule([loose, alsoLoose], keysOf);
  assert.equal(ready.length, 2, "nothing to collide on");
  assert.equal(blocked.length, 0);
});

test("the blocked row's own reason reaches the precheck column", () => {
  // The column rendered "excluded by diversification rules" for every blocked row, which is
  // the one thing a reader already knows from the badge. The reason names which other bet.
  assert.match(APP, /item\.portfolioRiskBlockReason \|\| "excluded by diversification rules"/);
});

test("the demoted sibling still travels in the dispatched shortlist", () => {
  // Display and dispatch are not the same list. Trimming what is sent would take the
  // executor's fallback away: a fixture whose top row fails revalidation on price or
  // liquidity would end with nothing bought, where before the sibling was bought. The
  // executor blocks the sibling by itself, so it rides along ranked last.
  assert.match(APP, /executionShortlist: \[\.\.\.readyInExecutionOrder, \.\.\.sameEventAsBetterRanked\]/);
  assert.match(APP, /portfolioCandidateDiagnostics\(mode\)\.executionShortlist/);
  // And the dispatch must not go back to reading the displayed list.
  const dispatch = APP.slice(APP.indexOf("function liveWorkflowPayload("), APP.indexOf("async function fetchFreshState("));
  assert.ok(!/portfolioCandidateRows\(mode\)/.test(dispatch), "dispatch reads the shortlist, not the display");
});

test("the shortlist applies the rule to itself, not only to open positions", () => {
  // The whole fault in one line: candidateRiskBlockReason walks activeRows, and an empty
  // portfolio has none, so before this the shortlist could never block anything.
  assert.match(APP, /candidatesAfterEventRule\(\s*\n?\s*sortPortfolioCandidates/);
});
