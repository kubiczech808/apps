// Runs offline: functions lifted straight out of paper-trading-bot.mjs and executed. No
// network, no secrets, no database.
//
// Found sampling a dip-combination-sweep cell that stayed suspiciously profitable (win% 95+
// at a ~50% buy price) even after dip_backtest_source_row() was fixed to prove settlement
// via resolved_stats_settled_outcome(). The sample showed SEVEN mutually exclusive "Exact
// Score" markets for one fixture (Maranhao AC MA vs Brusque FC SC) all recorded WIN, all
// opening at an implausible 95-98% two days before the match, all dipping to ~50% and
// resolving within the same 30-second window -- the signature of seven rows secretly
// carrying ONE market's data (almost certainly the fixture's own moneyline favourite, which
// legitimately opens high and want on).
//
// The cause: evaluationResolutionSlug()/marketObservationResolutionSlug() fell back to
// item.eventSlug when a row's own slug was missing. eventSlug is shared by every sibling
// market of one fixture. outcomeIndexForTrade() identifies a market's outcome by matching
// generic "Yes"/"No" TEXT, which cannot tell one sibling market from another -- so once the
// wrong sibling was fetched by that shared eventSlug, its "Yes" price was accepted as if it
// were this row's own settlement, with nothing to catch the swap.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");

function functionSource(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`missing ${name}`);
  let parens = 0;
  let bodyStart = -1;
  for (let i = src.indexOf("(", start); i < src.length; i += 1) {
    if (src[i] === "(") parens += 1;
    else if (src[i] === ")") {
      parens -= 1;
      if (parens === 0) {
        bodyStart = src.indexOf("{", i);
        break;
      }
    }
  }
  if (bodyStart < 0) throw new Error(`no body found for ${name}`);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (!depth) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced ${name}`);
}

const evaluationResolutionSlug = new Function(
  `${functionSource(source, "evaluationResolutionSlug")}\nreturn evaluationResolutionSlug;`,
)();
const marketObservationResolutionSlug = new Function(
  `${functionSource(source, "marketObservationResolutionSlug")}\nreturn marketObservationResolutionSlug;`,
)();
const parseJsonField = new Function(`${functionSource(source, "parseJsonField")}\nreturn parseJsonField;`)();
const outcomeIndexForTrade = new Function(
  "parseJsonField",
  `${functionSource(source, "outcomeIndexForTrade")}\nreturn outcomeIndexForTrade;`,
)(parseJsonField);

for (const [label, slugFor] of [
  ["evaluationResolutionSlug", evaluationResolutionSlug],
  ["marketObservationResolutionSlug", marketObservationResolutionSlug],
]) {
  test(`${label}: a row's own slug is used when it has one`, () => {
    assert.equal(slugFor({ slug: "bra3-mar-bru-2026-08-09-exact-score-3-2", eventSlug: "bra3-mar-bru-2026-08-09" }),
      "bra3-mar-bru-2026-08-09-exact-score-3-2");
  });

  test(`${label}: a row with no slug of its own is not identified by its event's shared slug`, () => {
    // The regression this guards: falling back to eventSlug let a slug-less "Exact Score"
    // sub-market be looked up and graded as if it were whichever OTHER sibling market (the
    // fixture's moneyline favourite) Gamma returned for that shared slug.
    assert.equal(slugFor({ slug: "", eventSlug: "bra3-mar-bru-2026-08-09" }), "");
    assert.equal(slugFor({ eventSlug: "bra3-mar-bru-2026-08-09" }), "", "a missing slug field, not just an empty one");
  });
}

test("outcomeIndexForTrade: a generic Yes/No text match cannot tell one sibling market from another", () => {
  // This is WHY the eventSlug fallback above was dangerous rather than merely imprecise: had
  // it fetched the wrong sibling, this identity check would have waved it through anyway.
  // The favourite's own moneyline market -- NOT the Exact Score sub-market the row is about.
  const wrongSiblingMarket = {
    outcomes: JSON.stringify(["Yes", "No"]),
    outcomePrices: JSON.stringify([1, 0]),
    clobTokenIds: JSON.stringify(["moneyline-yes-token", "moneyline-no-token"]),
  };
  // The Exact Score row's own recorded side: "Yes" (a common label on every binary market)
  // and its OWN token id, which belongs to neither of the wrong market's two tokens.
  const exactScoreRowTrade = { outcome: "Yes", tokenId: "exact-score-3-2-yes-token" };
  assert.equal(
    outcomeIndexForTrade(wrongSiblingMarket, exactScoreRowTrade),
    0,
    "matched by outcome text alone, although the token id proves it is a different market's row",
  );
});

test("outcomeIndexForTrade: the token id alone still finds the right side when outcome text is absent", () => {
  const market = {
    outcomes: JSON.stringify(["Yes", "No"]),
    outcomePrices: JSON.stringify([0.3, 0.7]),
    clobTokenIds: JSON.stringify(["yes-token", "no-token"]),
  };
  assert.equal(outcomeIndexForTrade(market, { outcome: "", tokenId: "no-token" }), 1);
  assert.equal(outcomeIndexForTrade(market, { outcome: "", tokenId: "unknown-token" }), -1);
});
