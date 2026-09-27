// Runs offline: the analysis tool's own logic, executed. No network, no credentials.
//
// This tool simulates entries over RESOLVED markets, so the ways it can mislead are
// specific and each gets a test:
//
//   * reading the entry price off a settled book. A resolved row prints 0 or 1, so taking
//     marketProbability from it would "enter" every winner at 100% and every loser at 0%
//     and report a flawless strategy. That is the single most dangerous line in the file.
//   * calling a partial settlement a win or a loss.
//   * answering the timing question from rows that cannot answer it.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  shapeOf, matchesTag, settlement, entryPrice, entryTiming, simulate, summarise,
} from "../tools/resolved-market-analysis.mjs";

test("the entry price is never read off a settled book", () => {
  // The trap. A resolved winner carries marketProbability 1 and finalOutcomePrice 1; taking
  // the former as the entry buys at 100%, wins, and reports a 0% return on a certainty --
  // or worse, buys the loser at 0% for infinite shares. The live quote from BEFORE
  // settlement is the only usable one.
  const settled = {
    marketProbability: 1, finalOutcomePrice: 1,
    lastLiveMarketProbability: 0.58, firstMarketProbability: 0.55,
  };
  assert.deepEqual(entryPrice(settled), { price: 0.55, field: "firstMarketProbability" });

  // THE ORDER ITSELF, which the assertion above does not test: with marketProbability at a
  // flat 1 the 0<p<1 guard rejects it whatever the order is, so reordering the list broke
  // nothing and the bait passed. The dangerous row is the one that settled to a plausible
  // number -- 0.97, not 1 -- because that walks straight through the guard. Entering at 97%
  // on a market that had already been decided reports a near-certain winner as a real trade.
  const nearlySettled = {
    marketProbability: 0.97, lastLiveMarketProbability: 0.58,
    firstMarketProbability: 0.55, finalOutcomePrice: 1,
  };
  assert.equal(entryPrice(nearlySettled).field, "firstMarketProbability",
    "the first-seen quote must win over a post-settlement one that merely looks tradable");
  assert.equal(entryPrice({ marketProbability: 0.97, lastLiveMarketProbability: 0.58 }).field,
    "lastLiveMarketProbability", "and the last LIVE quote beats it too");

  // Preference order, and each fallback only when the one before it is unusable.
  assert.equal(entryPrice({ lastLiveMarketProbability: 0.58, marketProbability: 1 }).field,
    "lastLiveMarketProbability");
  assert.equal(entryPrice({ marketProbability: 0.62 }).field, "marketProbability");

  // A settled 0 or 1 in EVERY field is not an entry price at all. Returning it would be the
  // bug wearing a different field name.
  assert.equal(entryPrice({ firstMarketProbability: 1, marketProbability: 1 }).price, null);
  assert.equal(entryPrice({ firstMarketProbability: 0, marketProbability: 0 }).price, null);
  assert.equal(entryPrice({}).price, null);

  // And the tool must say which field it used, or the reader cannot tell a real entry from
  // a fallback that happens to be tradable-looking.
  const source = readFileSync(new URL("../tools/resolved-market-analysis.mjs", import.meta.url), "utf8");
  assert.match(source, /entry price taken from:/);
});

test("only a clean settlement counts, and a partial one is skipped rather than guessed", () => {
  assert.equal(settlement({ finalOutcomePrice: 1 }), 1);
  assert.equal(settlement({ finalOutcomePrice: 0.998 }), 1);
  assert.equal(settlement({ finalOutcomePrice: 0 }), 0);
  assert.equal(settlement({ finalOutcomePrice: 0.002 }), 0);
  // The bait: a mid-range final price is not a settlement of this outcome. Rounding it to
  // the nearer end would invent a result for every market that never resolved cleanly.
  assert.equal(settlement({ finalOutcomePrice: 0.5 }), null);
  assert.equal(settlement({ finalOutcomePrice: 0.9 }), null);
  assert.equal(settlement({ finalOutcomePrice: 0.1 }), null);
  assert.equal(settlement({}), null);
});

test("a simulated entry pays out in shares, so a cheap winner is worth more than a dear one", () => {
  // 55% entry on a $5 stake buys 9.09 shares; winning returns 9.09, a profit of 4.09.
  const win = simulate({ firstMarketProbability: 0.55, finalOutcomePrice: 1 }, 5);
  assert.ok(Math.abs(win.pnl - (5 / 0.55 - 5)) < 1e-9, `got ${win.pnl}`);
  // The same win at 90% is worth far less. If these came out equal the tool would be
  // counting outcomes, not returns, and every "win%" column would be the whole story.
  const dear = simulate({ firstMarketProbability: 0.9, finalOutcomePrice: 1 }, 5);
  assert.ok(dear.pnl < win.pnl / 3, `a 90% winner must pay far less than a 55% one: ${dear.pnl}`);
  // A loss is the whole stake, whatever it was bought at.
  assert.equal(simulate({ firstMarketProbability: 0.55, finalOutcomePrice: 0 }, 5).pnl, -5);
  assert.equal(simulate({ firstMarketProbability: 0.9, finalOutcomePrice: 0 }, 5).pnl, -5);
  // Unusable rows produce nothing rather than a zero that would dilute every average.
  assert.equal(simulate({ finalOutcomePrice: 1 }, 5), null);
  assert.equal(simulate({ firstMarketProbability: 0.55, finalOutcomePrice: 0.5 }, 5), null);
});

test("timing is answered only where both times are on the row", () => {
  const at = (hours) => new Date(Date.now() + hours * 3600000).toISOString();
  assert.equal(entryTiming({ firstObservedAt: at(-6), eventStartTime: at(-1) }), "before kickoff");
  assert.equal(entryTiming({ firstObservedAt: at(-0.5), eventStartTime: at(-1) }), "under way");
  // The bait: a missing time must not default to either answer. "Underway vs before" is the
  // question being asked, and filling in a guess would answer it from rows that cannot.
  assert.equal(entryTiming({ firstObservedAt: at(-6) }), "unknown");
  assert.equal(entryTiming({ eventStartTime: at(-1) }), "unknown");
  assert.equal(entryTiming({}), "unknown");

  const source = readFileSync(new URL("../tools/resolved-market-analysis.mjs", import.meta.url), "utf8");
  assert.match(source, /timing !== "unknown"/,
    "the timing tables must exclude the rows that cannot answer");
  assert.match(source, /cannot\n\s+\/\/\s+be answered from this archive|cannot be answered from this archive/,
    "and say so when none of them can");
});

test("a tag matches on its tags first and the question text only as a fallback", () => {
  assert.equal(matchesTag({ polymarketTags: ["Dota 2", "Esports"] }, "dota"), "tag");
  assert.equal(matchesTag({ tags: [{ slug: "dota-2" }] }, "dota"), "tag");
  // The fallback that makes the question answerable at all: the archive may not have kept
  // the tags, and a market titled "Dota 2: ..." is a dota market regardless.
  assert.equal(matchesTag({ question: "Dota 2: Spirit vs Falcons - Game 1 Winner" }, "dota"), "question");
  assert.equal(matchesTag({ question: "Counter-Strike: MOUZ vs FURIA" }, "dota"), null);
  assert.equal(matchesTag({}, "dota"), null);
  // Which route matched is reported, because "matched by title" and "matched by tag" are
  // different levels of confidence about what the market is.
  const source = readFileSync(new URL("../tools/resolved-market-analysis.mjs", import.meta.url), "utf8");
  assert.match(source, /by question text only/);
});

test("shapes are classified, and an ordinary match falls through to outright", () => {
  assert.equal(shapeOf("Dota 2: Spirit vs Falcons - Game 1 Winner"), "in-event-leg");
  assert.equal(shapeOf("Games Total: O/U 2.5"), "over-under");
  assert.equal(shapeOf("Spread: Team Liquid (-1.5)"), "spread");
  assert.equal(shapeOf("Dota 2: Spirit vs Falcons (BO3)"), "outright");
  assert.equal(shapeOf(""), "outright");
});

test("summarise divides by what was staked and never by zero", () => {
  const row = (price, outcome) => ({ sim: simulate({ firstMarketProbability: price, finalOutcomePrice: outcome }, 5) });
  const s = summarise([row(0.5, 1), row(0.5, 0)]);
  assert.equal(s.n, 2);
  assert.equal(s.wins, 1);
  assert.equal(s.winRate, 0.5);
  assert.ok(Math.abs(s.pnl - 0) < 1e-9, "a 50% winner and a 50% loser at even money is flat");
  assert.ok(Math.abs(s.perDollar - 0) < 1e-9);
  const empty = summarise([]);
  assert.equal(empty.n, 0);
  assert.equal(empty.winRate, null);
  assert.equal(empty.perDollar, null);
});

test("the report says what it is not, where the numbers are read", () => {
  // A table of returns invites being read as a backtest. It is a simulation over recorded
  // quotes: no spread crossed, no fee charged, and one entry per market regardless of
  // whether capital was free. Every figure is therefore better than the real thing.
  const source = readFileSync(new URL("../tools/resolved-market-analysis.mjs", import.meta.url), "utf8");
  assert.match(source, /BETTER than the same strategy would really have done/);
  assert.match(source, /no spread is crossed and no fee is charged/i);
  assert.ok(!/^main\(\)/m.test(source), "and it must not run on import");
});

test("the resolved page is read under the key api.php actually publishes it as", () => {
  // The regression this exists for: the tool asked for scope=resolved and read only
  // state.resolvedMarketObservations, got 0 rows from an archive holding thousands, and
  // reported "nothing to analyse" as if that were the finding.
  //
  // compact_state_payload filters the archive into $rows and then assigns `$active = $rows`
  // for BOTH scopes, so a resolved page is published under the same key an active one is.
  // The scope decides the CONTENT, not the field name.
  const tool = readFileSync(new URL("../tools/resolved-market-analysis.mjs", import.meta.url), "utf8");
  const api = readFileSync(new URL("../api.php", import.meta.url), "utf8");

  assert.match(api, /\$active = \$rows;/,
    "both scopes funnel into one variable, which is why one key carries both");
  assert.match(tool, /state\.marketObservations/,
    "the tool must read the key the resolved page actually arrives under");
  assert.match(tool, /state\.resolvedMarketObservations/,
    "and the other, so a pre-segmentation state still works");
  assert.match(tool, /scope=resolved/, "while still asking for the resolved catalogue");
});

test("a tag carried by one lucky market is not reported as an edge", async () => {
  const { topTradeShare, tagsOf, simulate } = await import("../tools/resolved-market-analysis.mjs");

  // Buying a 2% outcome that lands pays 49x the stake, so ONE such market can carry a whole
  // tag's P/L and print as a strategy. top% is what makes that visible: the share of the
  // tag's winnings that came from its single best market.
  const row = (price, outcome) => ({
    sim: simulate({ firstMarketProbability: price, finalOutcomePrice: outcome }, 5),
  });
  const lottery = [row(0.02, 1), row(0.5, 0), row(0.5, 0), row(0.5, 0)];
  const share = topTradeShare(lottery);
  assert.ok(share > 0.99, `one 2% winner must account for nearly all the winnings: ${share}`);

  // A tag that grinds out its profit across many markets reads completely differently, which
  // is the whole point of printing the column.
  const spread = [row(0.5, 1), row(0.5, 1), row(0.5, 1), row(0.5, 1)];
  assert.ok(topTradeShare(spread) < 0.3, `evenly won profit must not look concentrated: ${topTradeShare(spread)}`);

  // No winnings at all is not a concentration of anything, and must not divide by zero.
  assert.equal(topTradeShare([row(0.5, 0), row(0.5, 0)]), null);
  assert.equal(topTradeShare([]), null);

  // Tags are the UNION of the fields that carry them, so a coarse one cannot hide a real
  // one -- the same masking that made a dota portfolio read as untagged earlier today.
  assert.deepEqual(tagsOf({ tags: ["sports"], polymarketTags: ["Dota 2"] }).sort(), ["dota 2", "sports"]);
  assert.deepEqual(tagsOf({}), ["(untagged)"]);

  // And the ranking must hide tags too thin to mean anything, or the noisiest rows sort to
  // the top: a single 2% winner is the best "per dollar" row that can exist.
  const source = readFileSync(new URL("../tools/resolved-market-analysis.mjs", import.meta.url), "utf8");
  assert.match(source, /const MIN_ROWS = 15;/);
  assert.match(source, /rows\.length >= MIN_ROWS/);
  assert.match(source, /one market, not an edge/);
});

test("an empty tag ranks every tag rather than falling back to one", () => {
  // The tool defaulted to "dota", so passing an empty tag from the workflow re-ran the
  // single-tag analysis: the run succeeded and answered the previous question. A default
  // that silently substitutes a different question is worse than no default.
  const tool = readFileSync(new URL("../tools/resolved-market-analysis.mjs", import.meta.url), "utf8");
  assert.match(tool, /const TAG = String\(process\.env\.MARKET_TAG \|\| ""\)/,
    "an unset tag must mean 'every tag', not a hard-coded one");
  assert.ok(!/MARKET_TAG \|\| "dota"/.test(tool), "no tag may be substituted for an empty one");
  assert.match(tool, /if \(!TAG \|\| TAG === "\*"\) \{\n\s+rankTags\(all\);/,
    "and an empty tag must reach the ranking");
});

test("price bands are fine enough to choose a setting from, and a blank band filters nothing", async () => {
  const { priceBand } = await import("../tools/resolved-market-analysis.mjs");
  // A band is what gets typed into the portfolio, so it has to be readable at that
  // resolution. 50-70% in one bucket cannot tell 52% from 68%.
  assert.equal(priceBand(0.52), "50-55%");
  assert.equal(priceBand(0.57), "55-60%");
  assert.equal(priceBand(0.62), "60-65%");
  assert.equal(priceBand(0.68), "65-70%");
  assert.equal(priceBand(0.45), "40-50%");
  assert.equal(priceBand(0.95), "90-100%");
  assert.equal(priceBand(0.05), "<10%");
  assert.equal(priceBand(null), "unknown");
  for (let p = 0.11; p < 0.999; p += 0.007) {
    assert.notEqual(priceBand(Number(p.toFixed(3))), "unknown", `${p.toFixed(3)} fell outside`);
  }

  // A blank band must mean no filter. Substituting 0.51-0.60 for an empty input is the same
  // fault the tag fallback had: the run succeeds and answers a question nobody asked.
  const tool = readFileSync(new URL("../tools/resolved-market-analysis.mjs", import.meta.url), "utf8");
  assert.ok(!/Number\(process\.env\.MIN_PROBABILITY \|\| 0\.51\)/.test(tool),
    "an empty bound must not become a default band");
  assert.match(tool, /optionalBound\(process\.env\.MIN_PROBABILITY, 0\.01\)/);
  assert.match(tool, /optionalBound\(process\.env\.MAX_PROBABILITY, 0\.99\)/);

  // And the whole-range tables must exist, or a band cannot be chosen from the data at all.
  assert.match(tool, /by ENTRY PRICE BAND, whole range/);
  assert.match(tool, /by SHAPE x entry price band/);
});
