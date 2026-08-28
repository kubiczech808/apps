// Runs offline: no secrets, no network, no hosting access.
process.env.PAPER_PORTFOLIO_USDC = "100";
process.env.PAPER_MAX_FRACTION = "0.05";
process.env.PAPER_MIN_ANNUALIZATION_DAYS = String(1 / 24);

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bot = await import("../tools/paper-trading-bot.mjs");

// Pulls a named top-level function out of a source file so it can be exercised rather
// than only pattern-matched. Brace counting starts after the parameter list so default
// values containing braces cannot end it early.
function extractFunction(source, name, where) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `function ${name} was not found in ${where}`);
  let depth = 0;
  for (let index = source.indexOf("{", source.indexOf(")", start)); index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`function ${name} is unbalanced in ${where}`);
}

const API_PATH = new URL("../api.php", import.meta.url).pathname;

const dayAgo = (days) => new Date(Date.now() - days * 86400000).toISOString();

// A stored observation in the shape the archive really holds one: the scrape-time
// taxonomy is its own field, the settled book is kept apart from the last live quote.
function observation(overrides = {}) {
  return {
    id: `market-${Math.random().toString(36).slice(2)}`,
    marketKey: `key-${Math.random().toString(36).slice(2)}`,
    question: "Who wins?",
    status: "RESOLVED",
    marketType: "binary",
    firstMarketProbability: 0.72,
    marketProbability: 1,
    firstPolymarketTags: ["esports", "league-of-legends"],
    polymarketTags: ["esports", "league-of-legends"],
    firstPolymarketCategories: ["games"],
    polymarketCategories: ["games"],
    tags: ["general"],
    firstObservedAt: dayAgo(9),
    observedAt: dayAgo(1),
    endDate: dayAgo(1),
    resolvedAt: dayAgo(1),
    finalOutcomePrice: 1,
    volumeUsdc: 120000,
    firstVolumeUsdc: 120000,
    firstDaysToResolution: 3,
    // The width of the book at discovery. Both sides drop a row whose quote was too wide
    // to trade against, so it has to be here or the two would agree only on emptiness --
    // which would make every count in this file pass without proving anything.
    firstSpread: 0.02,
    spread: 0.02,
    ...overrides,
  };
}

const OPEN_DEFAULTS = {
  status: "SCRAPED",
  finalOutcomePrice: null,
  resolvedAt: null,
  marketProbability: 0.72,
  endDate: new Date(Date.now() + 4 * 86400000).toISOString(),
  marketClosed: false,
  acceptingOrders: true,
};

// One catalogue exercising every rule the two sides can disagree on.
function buildObservations() {
  const rows = [];
  for (let index = 0; index < 26; index += 1) {
    rows.push(observation({
      firstMarketProbability: 0.5 + (index % 5) * 0.1,
      finalOutcomePrice: index % 3 === 0 ? 0 : 1,
      resolvedAt: dayAgo(index + 1),
      endDate: dayAgo(index + 1),
    }));
  }
  for (let index = 0; index < 7; index += 1) {
    rows.push(observation({ ...OPEN_DEFAULTS, firstMarketProbability: 0.55 + index * 0.05 }));
  }
  // Carries the tag only in its current Gamma relation, which is the fallback both
  // sides apply for rows stored before the immutable field existed.
  rows.push(observation({ firstPolymarketTags: [], polymarketTags: ["league-of-legends"] }));
  // Tagged as objects rather than strings, which Gamma also returns.
  rows.push(observation({ firstPolymarketTags: [{ slug: "league-of-legends", label: "LoL" }] }));
  // Re-tagged on Polymarket after it was scraped. The statistic evaluates the market as
  // it first appeared, so this belongs to league-of-legends and not to its current tag;
  // a list preferring today's relation would put it in the other group.
  rows.push(observation({ firstPolymarketTags: ["league-of-legends"], polymarketTags: ["dota"] }));
  // A settled book prints 1, so this row is priced by the last live quote it carried --
  // which puts it on a different rung of the probability ladder than its stored 1 would.
  rows.push(observation({ firstMarketProbability: 1, lastLiveMarketProbability: 0.83, marketProbability: 1 }));
  // Never carried a live quote, so the simulation cannot price it and counts none.
  rows.push(observation({ firstMarketProbability: 1, lastLiveMarketProbability: null, marketProbability: 1, marketPrice: 1 }));
  // Settled but with no final price: waiting for settlement is not a trade.
  rows.push(observation({ finalOutcomePrice: null, marketClosed: true, acceptingOrders: false }));
  // A different tag entirely, plus a per-fixture slug that neither side may group by.
  rows.push(observation({
    firstPolymarketTags: ["soccer", "team:arsenal", "arsenal-chelsea-2026-03-04"],
    polymarketTags: ["soccer"],
  }));
  // Structural noise inside string values, deliberately unbalanced: a walker that
  // counted braces without honouring strings would end this row at the first "}" and
  // lose it and everything after it. The escaped quotes put the escape handling on the
  // same hook, and the transport field's own name checks that finding the array is not
  // a plain text search.
  rows.push(observation({
    question: 'Closes with "}" and opens with "{" -- an unbalanced ] on purpose',
    slug: '"resolvedMarketObservations":[',
    firstPolymarketTags: ["esports", "league-of-legends"],
  }));
  return rows;
}

function writeSegmentedState(directory, rows) {
  const { core, segments } = bot.splitStateIntoSegments({
    generatedAt: new Date().toISOString(),
    schemaVersion: 1,
    marketObservations: rows,
  });
  mkdirSync(join(directory, "data"), { recursive: true });
  writeFileSync(join(directory, "data/paper-state.json"), JSON.stringify(core));
  for (const [name, payload] of Object.entries(segments)) {
    const file = core.stateSegments[name].file;
    // The recent page is deliberately emptied: the drill-down has to read the archive
    // itself, and a reader that settled for the capped page would find nothing here.
    const body = name === "resolvedRecent" ? { resolvedMarketObservations: [] } : payload;
    writeFileSync(join(directory, "data", file), JSON.stringify(body));
  }
  return core;
}

function callApi(directory, query) {
  const encoded = Buffer.from(JSON.stringify(query)).toString("base64");
  const output = execFileSync("php", ["-r",
    `$_GET = json_decode(base64_decode('${encoded}'), true); require '${join(directory, "api.php")}';`,
  ], { encoding: "utf8" });
  return JSON.parse(output);
}

function withApi(rows, run) {
  const directory = mkdtempSync(join(tmpdir(), "taxonomy-drilldown-"));
  try {
    copyFileSync(API_PATH, join(directory, "api.php"));
    writeSegmentedState(directory, rows);
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function tagRow(rows, label) {
  const report = bot.buildCalculationReport({ marketObservations: rows });
  const row = (report.tagSummaries || []).find((entry) => entry.label === label);
  assert.ok(row, `the report has a ${label} row`);
  return row;
}

// Reported: Tag performance says league-of-legends has 937 resolved trades, and the
// "trades" link on that very row lists 12. Measured against production: the statistic is
// computed over all 26,207 stored resolved rows while the browser is served the most
// recent 3,000 of them, of which 12 carry the tag. The count and the rows behind it have
// to be one set, so the drill-down reads the archive with the report's own predicates.
test("taxonomy drill-down: the resolved count matches the statistic it was clicked from", () => {
  const rows = buildObservations();
  const expected = tagRow(rows, "league-of-legends");

  const response = withApi(rows, (directory) => callApi(directory, {
    action: "taxonomy-observations",
    kind: "tag",
    value: "league-of-legends",
    statuses: "RESOLVED",
    probability: "50",
  }));

  assert.equal(response.ok, true);
  assert.equal(response.matched, expected.trades,
    "the drill-down lists exactly as many rows as the statistic counted");
  assert.equal(response.returned, expected.trades, "and returns all of them");
  assert.equal(response.truncated, false);
  // Not merely the same number: every row carries the tag and a settled result.
  for (const item of response.marketObservations) {
    const labels = [...(item.firstPolymarketTags || []), ...(item.polymarketTags || [])]
      .map((entry) => (entry && typeof entry === "object" ? entry.slug : entry));
    assert.ok(labels.includes("league-of-legends"), `${item.id} carries the tag`);
    assert.ok(item.finalOutcomePrice != null, `${item.id} is settled`);
  }
});

// The same row's probability ladder: each rung is its own statistic and its own link.
test("taxonomy drill-down: every probability rung matches its own row", () => {
  const rows = buildObservations();
  const expected = tagRow(rows, "league-of-legends");

  withApi(rows, (directory) => {
    for (const summary of expected.minimumProbabilitySummaries) {
      const percent = String(Math.round(summary.minimumProbability * 100));
      // Every rung is reported twice: open above its floor, and bounded ten points up.
      // A band row's link has to carry that bound, or clicking it opens the floor's whole
      // population -- the very inflation the band exists to separate out.
      const bound = summary.maxProbability == null
        ? {}
        : { maxProbability: String(Math.round(summary.maxProbability * 100)) };
      const range = summary.maxProbability == null ? `>= ${percent}%` : `${percent}-${bound.maxProbability}%`;
      const resolved = callApi(directory, {
        action: "taxonomy-observations",
        kind: "tag",
        value: "league-of-legends",
        statuses: "RESOLVED",
        probability: percent,
        ...bound,
      });
      assert.equal(resolved.matched, summary.trades, `resolved count at ${range}`);
      const open = callApi(directory, {
        action: "taxonomy-observations",
        kind: "tag",
        value: "league-of-legends",
        statuses: "SCRAPED",
        probability: percent,
        ...bound,
      });
      assert.equal(open.matched, summary.openCount, `open count at ${range}`);
    }
  });
});

// A tag the report resolves through the current Gamma relation, and one it drops as a
// per-fixture slug, are both counted the same way on each side.
test("taxonomy drill-down: fallback and per-fixture rules match the report", () => {
  const rows = buildObservations();
  const soccer = tagRow(rows, "soccer");

  withApi(rows, (directory) => {
    const response = callApi(directory, {
      action: "taxonomy-observations",
      kind: "tag",
      value: "soccer",
      statuses: "RESOLVED",
      probability: "50",
    });
    assert.equal(response.matched, soccer.trades);

    // A per-fixture slug groups exactly one opportunity, so neither side offers it.
    assert.ok(!(bot.buildCalculationReport({ marketObservations: rows }).tagSummaries || [])
      .some((entry) => entry.label === "team:arsenal" || entry.label.includes("2026-03-04")));
    for (const label of ["team:arsenal", "arsenal-chelsea-2026-03-04"]) {
      assert.equal(callApi(directory, {
        action: "taxonomy-observations",
        kind: "tag",
        value: label,
        statuses: "RESOLVED",
      }).matched, 0, `${label} groups nothing`);
    }
  });
});

// Categories are the same mechanism with a different pair of fields.
test("taxonomy drill-down: categories match their own statistic", () => {
  const rows = buildObservations();
  const report = bot.buildCalculationReport({ marketObservations: rows });
  const expected = (report.categorySummaries || []).find((entry) => entry.label === "games");
  assert.ok(expected, "the report has a games category row");

  const response = withApi(rows, (directory) => callApi(directory, {
    action: "taxonomy-observations",
    kind: "category",
    value: "games",
    statuses: "RESOLVED",
  }));
  assert.equal(response.matched, expected.trades);
});

// The archive is what makes this endpoint necessary, so it must be what it reads. The
// fixture empties the capped recent page; a reader that used it would answer zero.
test("taxonomy drill-down: the archive is read, not the capped recent page", () => {
  const rows = buildObservations();
  const response = withApi(rows, (directory) => callApi(directory, {
    action: "taxonomy-observations",
    kind: "tag",
    value: "league-of-legends",
    statuses: "RESOLVED",
  }));
  assert.ok(response.matched > 0,
    "the resolved archive is read even when the recent page the scraped view uses is empty");
});

// Structural characters inside string values are ordinary text. A walker that counted
// braces without honouring strings would split a row apart and lose everything after it.
test("taxonomy drill-down: braces and escapes inside a question do not derail the walk", () => {
  const rows = buildObservations();
  const noisy = rows.find((row) => row.question.includes("unbalanced"));
  assert.ok(noisy, "the fixture carries a row with unbalanced structural noise in its strings");

  const response = withApi(rows, (directory) => callApi(directory, {
    action: "taxonomy-observations",
    kind: "tag",
    value: "league-of-legends",
    statuses: "RESOLVED",
    limit: "8000",
  }));
  assert.ok(response.marketObservations.some((item) => item.id === noisy.id),
    "the row whose question contains braces, brackets and an escape is returned");
  assert.equal(response.matched, tagRow(rows, "league-of-legends").trades,
    "and nothing after it was lost");
});

test("taxonomy drill-down: a value that is not a slug is refused", () => {
  const rows = buildObservations();
  withApi(rows, (directory) => {
    assert.equal(callApi(directory, { action: "taxonomy-observations", kind: "tag", value: "" }).ok, false);
    assert.equal(callApi(directory, { action: "taxonomy-observations", kind: "weather", value: "rain" }).ok, false);
    assert.equal(callApi(directory, { action: "taxonomy-observations", kind: "tag", value: "../secrets" }).ok, false);
  });
});

// The browser groups rows too -- for the filter dropdown and for the rows it renders --
// and it used to do it by a different rule than the statistics. Both derivations are run
// here on the same records, so they cannot drift apart again without this failing.
test("taxonomy drill-down: the browser groups a row exactly as the statistics do", () => {
  const app = readFileSync(new URL("../assets/app.js", import.meta.url), "utf8");
  const botSource = readFileSync(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");

  const browser = new Function(`
    ${/const PER_FIXTURE_TAXONOMY_LABEL = [^\n]+/.exec(app)[0]}
    ${extractFunction(app, "normalizeScrapedTaxonomyLabel", "app.js")}
    ${extractFunction(app, "taxonomyValuesFromRecord", "app.js")}
    return taxonomyValuesFromRecord;
  `)();
  const statistics = new Function(`
    ${/const RISK_NAMESPACE_TAG = [^\n]+/.exec(botSource)[0]}
    ${/const DATED_FIXTURE_SLUG_TAG = [^\n]+/.exec(botSource)[0]}
    const SCRAPED_SIMULATION_TAGS_PER_TRADE = 8;
    ${extractFunction(botSource, "isPerFixtureLabel", "paper-trading-bot.mjs")}
    ${extractFunction(botSource, "scrapedSimulationTaxonomy", "paper-trading-bot.mjs")}
    return scrapedSimulationTaxonomy;
  `)();

  for (const row of buildObservations()) {
    for (const [kind, first, current] of [
      ["tag", "firstPolymarketTags", "polymarketTags"],
      ["category", "firstPolymarketCategories", "polymarketCategories"],
    ]) {
      assert.deepEqual(
        [...browser(row, kind)].sort(),
        [...statistics(row, first, current)].sort(),
        `${kind} labels for ${row.id}`,
      );
    }
  }
});

// The spread gate has to hold on both sides of the wire. PHP serves the execution
// shortlist and the drill-down lists; the bot re-filters what it is served and computes the
// statistics. If the two disagreed, the screen would offer rows the run then refuses --
// which is the shape of the "candidates exist but the run skipped" reports.
test("spread: PHP and the bot drop the same untradable rows", () => {
  const row = (id, spread, tag) => observation({
    id,
    marketKey: `key-${id}`,
    firstPolymarketTags: ["esports", tag],
    polymarketTags: ["esports", tag],
    firstSpread: spread,
    spread,
  });
  // Three tradable, three not: one far too wide, one a hair over the limit, one that
  // recorded nothing at all.
  const rows = [
    row("tight-1", 0.01, "league-of-legends"),
    row("tight-2", 0.05, "league-of-legends"),
    row("tight-3", 0.02, "league-of-legends"),
    row("wide", 0.9, "league-of-legends"),
    row("just-over", 0.0501, "league-of-legends"),
    { ...observation({ id: "silent", marketKey: "key-silent" }), firstSpread: undefined, spread: undefined },
  ];

  const expected = tagRow(rows, "league-of-legends");
  // The three tight rows always count and the two wide ones never do. Whether the row that
  // recorded no spread at all counts is a policy (PAPER_COUNT_UNKNOWN_SPREAD), and this
  // test deliberately does not pin which way it is set -- what it pins is that both sides
  // answer the same, because a list holding a different set from the number it was opened
  // from is the whole complaint this endpoint exists to answer.
  assert.ok([3, 4].includes(expected.trades),
    `the three tight rows count, the two wide ones never do: got ${expected.trades}`);
  const admitsUnknown = expected.trades === 4;

  withApi(rows, (directory) => {
    const response = callApi(directory, {
      action: "taxonomy-observations",
      kind: "tag",
      value: "league-of-legends",
      statuses: "RESOLVED",
      probability: "50",
    });
    assert.equal(response.matched, expected.trades,
      "the list behind the statistic must hold exactly what the statistic counted");
    const ids = (response.marketObservations || []).map((item) => item.id).sort();
    assert.deepEqual(ids, admitsUnknown
      ? ["silent", "tight-1", "tight-2", "tight-3"]
      : ["tight-1", "tight-2", "tight-3"]);
    // A recorded wide book is evidence, and it is excluded whatever the unknown policy is.
    assert.ok(!ids.includes("wide") && !ids.includes("just-over"),
      "a measured wide spread is never admitted");
    // The row that was exactly at the limit is in, the one a hair over is not.
    assert.ok(ids.includes("tight-2"));
  });
});
