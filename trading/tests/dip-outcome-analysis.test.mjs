// Runs offline: the analysis tool's own arithmetic, executed. No network, no credentials.
// Importing the tool must not fire its reads, which the run guard at the bottom of it
// ensures and the last test here checks.
//
// This is a REPORTING tool, so the thing that can go wrong is not a crash -- it is a table
// that looks authoritative and says something false. Three ways that happens, one test each:
//
//   * a bucket boundary that silently drops rows, so a band reads better than it is;
//   * P/L per dollar computed off the stake instead of the cost, which flatters cheap
//     entries -- a 30% entry buys three times the shares a 90% entry does;
//   * the verified/mid-game split collapsing, which is the whole reason this tool exists.
//     Every trade opened before the opening-price fix was selected on a number that may
//     have been a mid-game price, and pooling those with the real ones would turn "where
//     should I set the opening band" into a question answered from noise.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { bucketOf, volumeBucket, summarise, openingIsVerified } from "../tools/dip-outcome-analysis.mjs";

const EDGES = [0.3, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];

test("every probability lands in exactly one bucket, and none falls through the floor", () => {
  assert.equal(bucketOf(0.35, EDGES), "30-50%");
  assert.equal(bucketOf(0.5, EDGES), "50-60%", "a value ON a boundary belongs to the bucket it opens");
  assert.equal(bucketOf(0.78, EDGES), "70-80%");
  assert.equal(bucketOf(0.995, EDGES), "90-100%");
  assert.equal(bucketOf(null, EDGES), "unknown", "a missing opening price must not be counted as a low one");

  // The bait: a row below the lowest edge must be visible, not vanish. A table that
  // silently omits its worst rows reads as a better strategy than it is.
  assert.equal(bucketOf(0.1, EDGES), "below");

  // And no probability in the range may be dropped. Walked rather than spot-checked,
  // because an off-by-one in the loop shows up only at one edge.
  for (let value = 0.30; value <= 0.999; value += 0.005) {
    const label = bucketOf(Number(value.toFixed(3)), EDGES);
    assert.notEqual(label, "unknown", `${value.toFixed(3)} fell out of every bucket`);
    assert.notEqual(label, "below", `${value.toFixed(3)} was pushed below the floor`);
  }
});

test("volume buckets cover the line without a gap or an overlap", () => {
  assert.equal(volumeBucket(0), "a <1k");
  assert.equal(volumeBucket(999.99), "a <1k");
  assert.equal(volumeBucket(1000), "b 1-5k");
  assert.equal(volumeBucket(24999), "c 5-25k");
  assert.equal(volumeBucket(25000), "d 25-100k");
  assert.equal(volumeBucket(1e6), "e 100k+");
  assert.equal(volumeBucket(null), "unknown");
});

test("P/L per dollar is measured against what the trade COST, not the nominal stake", () => {
  // The distinction that makes the table comparable across entry prices. Both trades below
  // staked $5 and made $1; the first paid $5.50 with fees for it and the second $5.00, so
  // they are not the same return and must not print as one.
  const rows = [
    { realizedPnlUsdc: 1, stakeUsdc: 5, totalCostUsdc: 5.5 },
    { realizedPnlUsdc: 1, stakeUsdc: 5, totalCostUsdc: 5.0 },
  ];
  const both = summarise(rows);
  assert.equal(both.n, 2);
  assert.equal(both.wins, 2);
  assert.equal(both.winRate, 1);
  assert.equal(both.pnl, 2);
  assert.equal(both.perTrade, 1);
  // 2 / 10.5, not 2 / 10.
  assert.ok(Math.abs(both.perDollar - 2 / 10.5) < 1e-9,
    `per-dollar must divide by the real cost: ${both.perDollar}`);

  // A trade with no recorded cost falls back to its stake rather than dividing by zero.
  const fallback = summarise([{ realizedPnlUsdc: 1, stakeUsdc: 5 }]);
  assert.ok(Math.abs(fallback.perDollar - 0.2) < 1e-9);

  // A loss is a loss: zero P/L is not a win, or every unresolved row inflates the win rate.
  const mixed = summarise([
    { realizedPnlUsdc: -2, totalCostUsdc: 5 },
    { realizedPnlUsdc: 0, totalCostUsdc: 5 },
    { realizedPnlUsdc: 3, totalCostUsdc: 5 },
  ]);
  assert.equal(mixed.wins, 1, "break-even is not a win");
  assert.equal(mixed.pnl, 1);
  assert.equal(summarise([]).n, 0, "an empty bucket must not divide by zero");
  assert.equal(summarise([]).winRate, null);
});

test("the verified / mid-game split is the one thing this tool must never blur", () => {
  const hours = (n) => new Date(Date.now() + n * 3600000).toISOString();

  // First seen six hours before kickoff: a real opening price.
  assert.equal(openingIsVerified({ firstObservedAt: hours(-6), eventStartTime: hours(-1) }), true);
  // First seen half an hour AFTER kickoff: a mid-game price wearing the name of an opening
  // one. This is the reported case -- a market flat at 50/50 for a week, met by the scan at
  // 6-6 in extra innings and recorded as "opened at 75%".
  assert.equal(openingIsVerified({ firstObservedAt: hours(-0.5), eventStartTime: hours(-1) }), false);

  // Undecidable is its own answer, and must be neither. Folding it into "verified" would put
  // unknowable rows into the evidence; folding it into "mid-game" would throw away rows that
  // may be fine. The report counts all three separately.
  assert.equal(openingIsVerified({ firstObservedAt: hours(-6) }), null);
  assert.equal(openingIsVerified({ eventStartTime: hours(-1) }), null);
  assert.equal(openingIsVerified({}), null);
  assert.equal(openingIsVerified({ firstObservedAt: "not a date", eventStartTime: hours(-1) }), null);

  // And the report actually keeps them apart, rather than computing the split and pooling it
  // anyway. Checked on the source because it is the shape of the output, not a return value.
  const source = readFileSync(new URL("../tools/dip-outcome-analysis.mjs", import.meta.url), "utf8");
  assert.match(source, /openingVerified === true/);
  assert.match(source, /openingVerified === false/);
  assert.match(source, /openingVerified == null/);
  assert.match(source, /NOT evidence about the band/,
    "the mid-game table has to say what it is, or it will be read as a result");
});

test("importing the tool does not run it", () => {
  // It pages the whole observation catalogue over HTTPS. A module that did that on import
  // would fire it from every test run that touches this file.
  const source = readFileSync(new URL("../tools/dip-outcome-analysis.mjs", import.meta.url), "utf8");
  assert.match(source, /import\.meta\.url === `file:\/\/\$\{process\.argv\[1\]\}`/,
    "main() must be behind a run guard");
  assert.ok(!/^main\(\)/m.test(source), "and never called at the top level");
});

test("the observation read uses the query parameter names api.php actually reads", () => {
  // The bug this exists for, and the one the arithmetic tests above could never catch: the
  // first version sent scrapedScope / observationsLimit / observationsOffset -- the names of
  // api.php's INTERNAL variables, not of its query parameters. Every request came back as
  // page one of the active catalogue, the resolved archive was never read at all, and the
  // join recovered an opening price for 0 of 373 resolved trades while reporting success.
  //
  // A tool whose arithmetic is tested and whose contract with the server is not will fail
  // exactly like this: quietly, with a plausible-looking table.
  const tool = readFileSync(new URL("../tools/dip-outcome-analysis.mjs", import.meta.url), "utf8");
  const api = readFileSync(new URL("../api.php", import.meta.url), "utf8");

  // What the server reads, asserted against the server.
  assert.match(api, /\$scrapedScope = \(\(string\) \(\$_GET\['scope'\] \?\? ''\)\)/,
    "the scope parameter is named 'scope'");
  assert.match(api, /\$executionOffset = max\(0, \(int\) \(\$_GET\['offset'\] \?\? 0\)\);/,
    "the paging parameter is named 'offset'");

  // What the tool sends.
  const request = tool.match(/action=state&target=paper&summary=scraped[^`]*/)?.[0];
  assert.ok(request, "the observation read must be findable");
  assert.match(request, /scope=\$\{scope\}/, "it must page the resolved archive by 'scope'");
  assert.match(request, /offset=\$\{offset\}/, "and page by 'offset'");
  assert.ok(!/scrapedScope=|observationsLimit=|observationsOffset=/.test(tool),
    `no internal parameter name may be sent as a query parameter: ${request}`);

  // And it must ask for BOTH catalogues. A resolved trade's market is, by definition, in the
  // resolved one -- reading only the active catalogue is how the join returned nothing.
  assert.match(tool, /for \(const scope of \["active", "resolved"\]\)/,
    "both catalogues, or resolved trades have no observation to join to");
});

test("a trade records the premise it was admitted on, so its own history can report it", async () => {
  // The finding behind this: asked how the dip portfolios did BY OPENING PROBABILITY, the
  // analysis could recover that probability for 4 of 373 resolved trades. Not a bug in the
  // read -- the observation catalogue is a moving window and every older observation had
  // aged out. The one parameter the dip rule is entirely about was the one thing its own
  // history could not report, because paperTradeFromCandidate never copied it.
  const bot = await import("../tools/paper-trading-bot.mjs");
  const price = 0.53;
  const firstSeen = new Date(Date.now() - 6 * 3600000).toISOString();
  const kickoff = new Date(Date.now() - 3600000).toISOString();
  const candidate = {
    tokenId: "t1", question: "Counter-Strike: M80 vs GamerLegion", outcome: "GamerLegion",
    marketProbability: price, marketPrice: price, aiProbability: price,
    bestBid: price, bestAsk: price, spread: 0, volumeUsdc: 12000, liquidity: 12000,
    firstMarketProbability: 0.76, firstObservedAt: firstSeen, eventStartTime: kickoff,
    daysToResolution: 1 / 24, feeRate: 0, feesEnabled: false,
  };
  const trade = bot.paperTradeFromCandidate(candidate, { id: "dip70", stakeUsdc: 5 }, "2026-09-26", 5);

  assert.equal(trade.firstMarketProbability, 0.76, "the opening probability must travel with the trade");
  assert.equal(trade.firstObservedAt, firstSeen);
  assert.equal(trade.eventStartTime, kickoff,
    "and both times, or a mid-game price cannot be told from an opening one after the fact");

  // The pair is what makes the number readable. A trade carrying the probability but neither
  // time is exactly as unanalysable as one carrying nothing, which is the state this fixes.
  assert.ok(openingIsVerified(trade) === true,
    "a trade first seen before kickoff must read as verified straight off its own row");

  // A candidate that never had one stores null rather than a fabricated number: the rule
  // refuses such a row anyway, and inventing a probability here would put it in the evidence.
  const blind = bot.paperTradeFromCandidate(
    { ...candidate, firstMarketProbability: null, firstObservedAt: null, eventStartTime: null },
    { id: "dip70", stakeUsdc: 5 }, "2026-09-26", 5,
  );
  assert.equal(blind.firstMarketProbability, null);
  assert.equal(openingIsVerified(blind), null, "unknowable stays unknowable");
});

// ---------------------------------------------------------------------------------------
// The profitable-subset breakdown. Asked for: only the bands and shapes clearing 5%, split
// by tag, ordered by NOMINAL profit, plus a check of "volume over 5k" across every
// combination. Each of those is a way to mislead, so each gets a test.

test("the 5% bar is applied to buckets computed from the data, not to a typed-in list", async () => {
  const { qualifyingBuckets, PROFIT_BAR } = await import("../tools/dip-outcome-analysis.mjs");
  // Three bands: one clearly over the bar, one clearly under, one just under it. The last is
  // the one that matters -- a >= would let a 5.0% bucket through as "profit above 5%".
  const rows = [
    { band: "good", realizedPnlUsdc: 2, totalCostUsdc: 10 },      // +20%
    { band: "bad", realizedPnlUsdc: -1, totalCostUsdc: 10 },      // -10%
    { band: "edge", realizedPnlUsdc: 0.5, totalCostUsdc: 10 },    // exactly +5%
  ];
  const { keep, rejected } = qualifyingBuckets(rows, (row) => row.band);
  assert.equal(PROFIT_BAR, 0.05);
  assert.ok(keep.has("good"));
  assert.ok(!keep.has("bad"));
  assert.ok(!keep.has("edge"), "exactly 5% is not ABOVE 5%");
  assert.deepEqual(rejected.map(([label]) => label).sort(), ["bad", "edge"],
    "what was dropped has to be reportable, or the filter is invisible");
});

test("a trade's tags are read wherever they were stored, and an untagged trade is not dropped", async () => {
  const { tradeTags } = await import("../tools/dip-outcome-analysis.mjs");
  assert.deepEqual(tradeTags({ polymarketTags: ["Esports", "CS2"] }), ["esports", "cs2"]);
  assert.deepEqual(tradeTags({ tags: ["sports"] }), ["sports"]);
  assert.deepEqual(tradeTags({ tags: [{ slug: "nba" }, { label: "Basketball" }] }), ["nba", "basketball"]);
  assert.deepEqual(tradeTags({ polymarketTags: ["a", "a", "b"] }), ["a", "b"], "a tag counts once");
  // The bait: an untagged trade must be VISIBLE, not silently excluded. How much of the
  // profit carries no tag at all is part of the answer, and a filter that drops those rows
  // makes the tag table add up to less than the subset while looking complete.
  assert.deepEqual(tradeTags({}), ["(untagged)"]);
  assert.deepEqual(tradeTags({ tags: [] }), ["(untagged)"]);
});

test("the volume rule is judged by comparison, and abstains when it has only one side", async () => {
  const { volumeVerdict } = await import("../tools/dip-outcome-analysis.mjs");
  const at = (volume, pnl) => ({ entryVolume: volume, realizedPnlUsdc: pnl, totalCostUsdc: 5 });

  // Over 5k does better: the rule holds here.
  assert.equal(volumeVerdict([at(1000, -1), at(20000, 3)]).verdict, "confirms");
  // Over 5k does worse: it must say so rather than quietly passing.
  assert.equal(volumeVerdict([at(1000, 3), at(20000, -1)]).verdict, "contradicts");
  // 5000 itself belongs to the "over" side, or the boundary the user named is not the
  // boundary being tested.
  assert.equal(volumeVerdict([at(4999, -1), at(5000, 3)]).verdict, "confirms");

  // The bait: with rows on only one side there is no comparison, and calling that a
  // confirmation is how a rule gets "verified" by data that never tested it.
  assert.equal(volumeVerdict([at(20000, 3), at(30000, 2)]).verdict, "no comparison");
  assert.equal(volumeVerdict([at(100, 3)]).verdict, "no comparison");
  assert.equal(volumeVerdict([]).verdict, "no comparison");
  // A row with no volume at all cannot vote either way.
  assert.equal(volumeVerdict([at(null, 3), at(20000, 2)]).verdict, "no comparison");
});

test("the tag tables are ordered by nominal profit and say that they overlap", () => {
  // "ani tak moc me nezajima win rate jako nominalni hodnota zisku." Sorting by win rate or
  // by per-dollar return would answer a question that was not asked, and a tag carried by a
  // trade alongside two others is counted under each -- so the column does not sum to the
  // subset and the report has to say so rather than let it be read as a partition.
  const source = readFileSync(new URL("../tools/dip-outcome-analysis.mjs", import.meta.url), "utf8");
  assert.match(source, /const byProfit = \[\.\.\.tagged\.entries\(\)\]\.sort\(\(a, b\) => summarise\(b\[1\]\)\.pnl - summarise\(a\[1\]\)\.pnl\);/,
    "the tag table must be ordered by nominal P/L");
  assert.match(source, /do not sum to the subset total/,
    "the overlap has to be stated where the table is read");
  assert.match(source, /both halves lose money/,
    "a combination that loses on both sides is not evidence for the volume rule");
});

test("a trade keeps the market's tags, so the profit can be attributed to them", async () => {
  // The finding behind this: asked to break the profitable trades down BY TAG, all 100 of
  // them came back as "(untagged)". Not because the markets had no tags -- because the trade
  // stored `tags: best.tags` alone, while a scraped row carries its real Polymarket tags
  // under polymarketTags. Same shape as the opening probability before it: the attribute the
  // analysis needs is the one the trade did not record.
  const bot = await import("../tools/paper-trading-bot.mjs");
  const { tradeTags } = await import("../tools/dip-outcome-analysis.mjs");
  const price = 0.53;
  const candidate = {
    tokenId: "t1", question: "Counter-Strike: M80 vs GamerLegion", outcome: "GamerLegion",
    marketProbability: price, marketPrice: price, aiProbability: price,
    bestBid: price, bestAsk: price, spread: 0, volumeUsdc: 12000,
    polymarketTags: ["Esports", "CS2"], riskCategory: "esports",
    daysToResolution: 1 / 24, feeRate: 0, feesEnabled: false,
  };
  const trade = bot.paperTradeFromCandidate(candidate, { id: "dip70", stakeUsdc: 5 }, "2026-09-26", 5);

  assert.ok(Array.isArray(trade.tagSlugs) && trade.tagSlugs.length,
    "the trade must carry the market's tags, not just whichever field happened to be set");
  assert.ok(trade.tagSlugs.includes("esports"), `expected esports in ${JSON.stringify(trade.tagSlugs)}`);
  assert.ok(trade.tagSlugs.includes("cs2"));

  // And the analysis has to read them, or storing them changes nothing.
  assert.ok(tradeTags(trade).includes("cs2"),
    "the breakdown must read the field the trade actually writes");

  // A market genuinely without tags still reports as untagged rather than disappearing:
  // how much profit carries no tag is part of the answer.
  const bare = bot.paperTradeFromCandidate(
    { ...candidate, polymarketTags: undefined, tags: undefined, riskCategory: undefined },
    { id: "dip70", stakeUsdc: 5 }, "2026-09-26", 5,
  );
  assert.deepEqual(tradeTags(bare), ["(untagged)"]);
});
