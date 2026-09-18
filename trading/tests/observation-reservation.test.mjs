// Runs offline: the bot's own retention and reservation functions are lifted out of
// paper-trading-bot.mjs and EXECUTED. No network, no secrets, no state written.
//
// Reported: "nerozumim tomu, proc musime mit takoveto uzke hrdlo, ktere mi pak zabranuje
// pridat nove nalezene esports udalosti. vidim, ze z posledniho behu pribyla do katalogu
// snad jen 1 ... jestli by neslo aby proste melo kazde portfolio zvlast pro sebe tento
// predvyber - nemelo by se pak stat, ze jednomu portfoliu budou vyhladovet pocet
// prilezitosti a nebude vyuzite. i maly pocet udalosti na portfolio (rekneme 100 max) je ok,
// kdyz budou serazeny podle priorit."
//
// The cap starves by construction and a bigger cap does not fix it. Retention sorted every
// active row by soonest end date and kept the first N, so the catalogue filled with whatever
// ends next -- and sports has far more markets than esports. Once the esports scan was
// widened to seven days, a freshly found esports event three days out sorted below every
// sports market ending tomorrow and was cut before any portfolio saw it.
//
// So the thing to test is not "the reservation exists" but "a narrow portfolio still has
// markets when a broad one is flooding the catalogue" -- which is the failure as reported.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const BOT = readFileSync(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} must exist in paper-trading-bot.mjs`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, `${name} must be a complete function`);
  return source.slice(start, end + 2);
}

// The real functions, with the handful of helpers they lean on supplied so the lifted copies
// behave as they do in the bot. Everything that decides an outcome is the deployed code.
const harness = new Function(`
  ${extractFunction(BOT, "reserveObservationsPerPortfolio")}
  ${extractFunction(BOT, "observationPriorityScore")}
  ${extractFunction(BOT, "retainMarketObservations")}
  ${extractFunction(BOT, "marketObservationInScannedScope")}

  const MARKET_OBSERVATION_RETAIN_LIMIT = 10;
  const MARKET_SCAN_TAG_SCOPE = ["sports", "esports"];
  const UNKNOWN_TAG_SLUGS = new Set(["general"]);
  const rowTagSlugs = (item) => new Set((item.polymarketTags || []).map((tag) => String(tag).toLowerCase()));
  const marketObservationKey = (item) => String(item?.tokenId || "");
  const marketObservationUpdateTime = (item) => Date.parse(item?.observedAt || "") || 0;
  const daysToEnd = (endDate) => {
    const parsed = Date.parse(endDate || "");
    return Number.isFinite(parsed) ? (parsed - Date.parse("2026-09-18T00:00:00Z")) / 86400000 : NaN;
  };
  const hasOriginalMarketProbability = () => true;
  const rewardRiskRatio = (item) => Number(item?.rewardRisk);

  // The scope matcher, reduced to what these fixtures exercise: tag and probability band.
  // The deployed one also weighs horizon, volume and shape; none of those differ here, and
  // lifting it whole would drag in a dozen more helpers without changing an outcome.
  function observationMatchesActiveLiveConfig(item, config) {
    const status = String(item?.status || "").toUpperCase();
    if (status === "RESOLVED") return false;
    const probability = Number(item?.marketProbability);
    if (config.minProbability != null && probability < config.minProbability) return false;
    if (config.maxProbability != null && probability > config.maxProbability) return false;
    const tags = rowTagSlugs(item);
    const include = new Set(config.includeOnlyMarketTags || []);
    if (include.size && ![...include].some((tag) => tags.has(tag))) return false;
    return true;
  }

  return { reserveObservationsPerPortfolio, retainMarketObservations, observationPriorityScore };
`)();

const { reserveObservationsPerPortfolio, retainMarketObservations, observationPriorityScore } = harness;

let counter = 0;
const market = ({ tag = "sports", endsInDays = 1, probability = 0.75, annualized = 1, rewardRisk = 1 } = {}) => {
  counter += 1;
  return {
    tokenId: `t${counter}`,
    polymarketTags: [tag],
    status: "SCRAPED",
    marketProbability: probability,
    potentialAnnualizedReturn: annualized,
    rewardRisk,
    endDate: new Date(Date.parse("2026-09-18T00:00:00Z") + endsInDays * 86400000).toISOString(),
    observedAt: "2026-09-18T07:00:00.000Z",
  };
};

// The reported situation, in miniature: a flood of sports ending tomorrow, a handful of
// esports three days out, and a cap that cannot hold both.
const flood = () => {
  counter = 0;
  return [
    ...Array.from({ length: 20 }, () => market({ tag: "sports", endsInDays: 1 })),
    ...Array.from({ length: 4 }, (_, index) =>
      market({ tag: "esports", endsInDays: 3, annualized: 5 + index })),
  ];
};

const esportsPortfolio = { selectionOrder: "highest_ev_pa_first", includeOnlyMarketTags: ["esports"] };
const sportsPortfolio = { selectionOrder: "highest_ev_pa_first", includeOnlyMarketTags: ["sports"] };

const tagsOf = (rows) => rows.map((row) => row.polymarketTags[0]);

test("without a reservation the narrow portfolio is starved -- the reported failure", () => {
  // Not a claim about the old code: this RUNS the current retention with the reservation
  // switched off, which is exactly what it did before. If this ever stops starving, the
  // test below proves nothing.
  const kept = retainMarketObservations(flood());
  assert.equal(kept.length, 10, "the cap still binds");
  assert.equal(tagsOf(kept).filter((tag) => tag === "esports").length, 0,
    `every slot went to the sooner-ending tag: ${tagsOf(kept).join(",")}`);
});

test("with a reservation the narrow portfolio keeps its markets", () => {
  const rows = flood();
  const reservedKeys = reserveObservationsPerPortfolio(rows, [esportsPortfolio, sportsPortfolio], 3);
  const kept = retainMarketObservations(rows, { reservedKeys });
  const esports = tagsOf(kept).filter((tag) => tag === "esports").length;
  assert.equal(esports, 3, `the esports portfolio's three reserved rows survive: ${tagsOf(kept).join(",")}`);
  // And the broad portfolio is not punished for it: the cap is still full.
  assert.equal(kept.length, 10);
  assert.equal(tagsOf(kept).filter((tag) => tag === "sports").length, 7);
});

test("a reservation is filled by the portfolio's own Priority, not by end date", () => {
  // The whole point of reserving BY PRIORITY rather than just by tag. Retention orders by
  // soonest end date; a portfolio set to "reward/risk" must get its best reward/risk rows,
  // not the three of its markets that happen to end first.
  counter = 0;
  const rows = [
    market({ tag: "esports", endsInDays: 1, rewardRisk: 0.1, annualized: 0.1 }),
    market({ tag: "esports", endsInDays: 2, rewardRisk: 0.2, annualized: 0.2 }),
    market({ tag: "esports", endsInDays: 6, rewardRisk: 9.9, annualized: 0.3 }),
  ];
  const byRewardRisk = reserveObservationsPerPortfolio(
    rows, [{ selectionOrder: "highest_reward_risk_first", includeOnlyMarketTags: ["esports"] }], 1);
  assert.deepEqual([...byRewardRisk], ["t3"], "the best reward/risk, though it ends last");

  const byYield = reserveObservationsPerPortfolio(
    rows, [{ selectionOrder: "highest_ev_pa_first", includeOnlyMarketTags: ["esports"] }], 1);
  assert.deepEqual([...byYield], ["t3"], "and the best EV p.a. for a portfolio set that way");

  // A portfolio whose Priority points the other way picks a different row, or the setting is
  // being ignored and both branches are the same code.
  counter = 0;
  const divergent = [
    market({ tag: "esports", rewardRisk: 9, annualized: 1 }),
    market({ tag: "esports", rewardRisk: 1, annualized: 9 }),
  ];
  assert.deepEqual([...reserveObservationsPerPortfolio(
    divergent, [{ selectionOrder: "highest_reward_risk_first", includeOnlyMarketTags: ["esports"] }], 1)], ["t1"]);
  assert.deepEqual([...reserveObservationsPerPortfolio(
    divergent, [{ selectionOrder: "highest_ev_pa_first", includeOnlyMarketTags: ["esports"] }], 1)], ["t2"]);
});

test("a market with no computable metric sorts last, never first", () => {
  // Recorded because a bait did NOT fail: flipping the unscorable branch from
  // NEGATIVE_INFINITY to POSITIVE_INFINITY left all eight tests passing, because every
  // fixture above carries both metrics and the branch was never reached.
  //
  // It matters more than the tidiness suggests. A scraped row often arrives before its
  // economics are computed -- no annualized return, no reward/risk -- and if those sorted
  // FIRST they would fill every portfolio's quota with markets that have no price, pushing
  // out the ones it could actually trade. That is the starvation this whole change exists
  // to end, arriving through the reservation itself.
  counter = 0;
  const rows = [
    market({ tag: "esports", annualized: 0.01, rewardRisk: 0.01 }),
    { ...market({ tag: "esports" }), potentialAnnualizedReturn: undefined, marketAnnualizedReturn: undefined,
      annualizedReturn: undefined, rewardRisk: undefined },
  ];
  assert.equal(observationPriorityScore(rows[1], { selectionOrder: "highest_ev_pa_first" }),
    Number.NEGATIVE_INFINITY, "an unpriced row scores last");
  assert.equal(observationPriorityScore(rows[1], { selectionOrder: "highest_reward_risk_first" }),
    Number.NEGATIVE_INFINITY);

  // And the ordering that follows from it: the poor-but-priced market is reserved ahead of
  // the unpriced one, on both Priority settings.
  for (const selectionOrder of ["highest_ev_pa_first", "highest_reward_risk_first"]) {
    assert.deepEqual(
      [...reserveObservationsPerPortfolio(rows, [{ selectionOrder, includeOnlyMarketTags: ["esports"] }], 1)],
      ["t1"], `${selectionOrder} must prefer a priced market`);
  }
});

test("a portfolio reserves only what it could actually trade", () => {
  // A reservation that ignored the portfolio's own rules would hold space for markets it
  // will never buy, which is the starvation again with extra steps.
  counter = 0;
  const rows = [
    market({ tag: "esports", probability: 0.75 }),
    market({ tag: "esports", probability: 0.40 }),
    market({ tag: "sports", probability: 0.75 }),
  ];
  const reserved = reserveObservationsPerPortfolio(rows, [{
    selectionOrder: "highest_ev_pa_first",
    includeOnlyMarketTags: ["esports"],
    minProbability: 0.70,
    maxProbability: 0.80,
  }], 10);
  assert.deepEqual([...reserved], ["t1"], "out of band and out of tag are both excluded");
});

test("a portfolio that wants more than exists takes what there is, and no more", () => {
  counter = 0;
  const rows = Array.from({ length: 3 }, () => market({ tag: "esports" }));
  assert.equal(reserveObservationsPerPortfolio(rows, [esportsPortfolio], 150).size, 3);
});

test("switched off, nothing is reserved and retention is exactly what it was", () => {
  // The off switch has to be real: this runs on every scan, and a portfolio list that
  // somehow reserved everything would turn the cap off by accident.
  const rows = flood();
  assert.equal(reserveObservationsPerPortfolio(rows, [esportsPortfolio], 0).size, 0);
  assert.equal(reserveObservationsPerPortfolio(rows, [], 150).size, 0);
  assert.deepEqual(retainMarketObservations(rows, { reservedKeys: new Set() }).map((row) => row.tokenId),
    retainMarketObservations(rows).map((row) => row.tokenId));
});

test("resolved rows are never reserved and never dropped", () => {
  // Resolved markets are the settled history every statistic is measured against, and
  // retention deliberately does not cap them. A reservation must not start competing with
  // that or spending a portfolio's quota on markets that already ended.
  counter = 0;
  const rows = [
    ...Array.from({ length: 12 }, () => market({ tag: "sports" })),
    { ...market({ tag: "esports" }), status: "RESOLVED" },
  ];
  const reserved = reserveObservationsPerPortfolio(rows, [esportsPortfolio], 5);
  assert.equal(reserved.size, 0, "a resolved market is not a trading opportunity");
  const kept = retainMarketObservations(rows, { reservedKeys: reserved });
  assert.equal(kept.filter((row) => row.status === "RESOLVED").length, 1, "and it is still kept");
});

test("the scan passes every running portfolio, live and paper, and skips archived ones", () => {
  const start = BOT.indexOf("const reservingConfigs = [");
  assert.ok(start > 0, "the scan must assemble the reserving portfolios");
  const block = BOT.slice(start, start + 700);
  assert.match(block, /liveCatalogueProtection\?\.configs/, "live portfolios reserve");
  assert.match(block, /Object\.values\(PAPER_STRATEGIES\)\.filter\(\(strategy\) => !paperStrategyIsArchived\(strategy\)\)/,
    "paper portfolios reserve, and archived ones do not");
  assert.match(block, /retainMarketObservations\(protectedObservations, \{ reservedKeys \}\)/,
    "and the reservation must actually reach retention");
  // Reported as the symptom, so the run says what it did rather than leaving it to be
  // inferred from a catalogue count that moved by one.
  assert.match(BOT, /Catalogue retention: \$\{reservedKeys\.size\} row\(s\) reserved across/);
});
