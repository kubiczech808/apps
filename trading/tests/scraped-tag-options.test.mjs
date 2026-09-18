// Runs offline: the dashboard's real option builder is EXECUTED. No browser, no network.
//
// Reported: "japan-j-league nemuzu najit ve filrech tagu ve scraped udalosti".
//
// The options were built from two bounded sources -- the calculation report's own taxonomy
// table, and whatever catalogue the browser happened to be holding, which is capped -- while
// the query BEHIND the filter reads the full archive through taxonomy-observations. So a tag
// could be perfectly answerable and still not offerable, and picking it was impossible.
//
// The settled history now supplies a third source: trading_resolved_stats has one row per
// (tag, shape, horizon, probability) cell over all 77,553 priced settlements, so every tag
// that ever settled is one grouped scan away.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const APP = readFileSync(new URL("../assets/app.js", import.meta.url), "utf8");

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} must exist in app.js`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, `${name} must be complete`);
  return source.slice(start, end + 2);
}

const PER_FIXTURE = /const PER_FIXTURE_TAXONOMY_LABEL = .*;/.exec(APP);
assert.ok(PER_FIXTURE, "the per-fixture pattern must be findable");

function build({ catalogue = [], reportRows = [], resolvedTags = null, selected = null }) {
  return new Function(`
    ${PER_FIXTURE[0]}
    ${extractFunction(APP, "taxonomyValuesFromRecord")}
    ${extractFunction(APP, "scrapedTaxonomyFilterOptions")}
    const state = {
      botState: { latestCalculationReport: ${JSON.stringify({ rows: reportRows })} },
      resolvedTagOptions: ${JSON.stringify(resolvedTags)},
    };
    const normalizeScrapedTaxonomyLabel = (value) => String(value ?? "").trim().toLowerCase();
    const taxonomyRows = (report, kind) => (report?.rows || []).filter((row) => row.kind === kind);
    const scrapedMarketObservations = () => ${JSON.stringify(catalogue)};
    const normalizedScrapedTaxonomyFilter = () => ${JSON.stringify(selected)};
    return scrapedTaxonomyFilterOptions();
  `)();
}

test("a tag only the settled history knows is offered", () => {
  // The reported case. japan-j-league is in the archive; it is in neither the report's table
  // nor the catalogue the browser holds.
  const options = build({
    catalogue: [{ firstPolymarketTags: ["esports"] }],
    reportRows: [{ kind: "tag", label: "sports" }],
    resolvedTags: [{ tag: "japan-j-league", trades: 412 }, { tag: "valorant", trades: 86 }],
  });
  assert.ok(options.tag.includes("japan-j-league"),
    `the settled tag must be offerable: ${options.tag.join(", ")}`);
  assert.ok(options.tag.includes("valorant"));
  // And the sources that already worked still do.
  assert.ok(options.tag.includes("esports"), "the loaded catalogue still contributes");
  assert.ok(options.tag.includes("sports"), "and so does the report");
});

test("BAIT: without the settled source the reported tag is still missing", () => {
  // The state before the fix, so the test above is known to be testing something.
  const options = build({
    catalogue: [{ firstPolymarketTags: ["esports"] }],
    reportRows: [{ kind: "tag", label: "sports" }],
    resolvedTags: null,
  });
  assert.ok(!options.tag.includes("japan-j-league"),
    "with nothing loaded the tag cannot appear, which is what was reported");
});

test("per-fixture labels are still refused, whichever source they come from", () => {
  // A slug naming one match groups exactly one opportunity, and the performance tables drop
  // those -- offering one would produce a view no statistic ever counted. The settled table
  // holds them too, so the filter has to refuse them on the way in.
  const options = build({
    catalogue: [],
    resolvedTags: [
      { tag: "val-flfe-flc-2026-09-18", trades: 1 },
      { tag: "market:some-fixture", trades: 1 },
      { tag: "valorant", trades: 90 },
    ],
  });
  assert.deepEqual(options.tag, ["valorant"],
    `only the groupable tag may be offered: ${options.tag.join(", ")}`);
});

test("the list is sorted and free of duplicates", () => {
  const options = build({
    catalogue: [{ firstPolymarketTags: ["valorant", "esports"] }],
    resolvedTags: [{ tag: "valorant", trades: 90 }, { tag: "csgo", trades: 40 }],
  });
  assert.deepEqual(options.tag, ["csgo", "esports", "valorant"]);
});

test("an empty or failed load leaves the other sources intact", () => {
  // The endpoint reports source="unavailable" when storage cannot be read. That must narrow
  // the options back to what they were, not empty them.
  for (const resolvedTags of [[], null]) {
    const options = build({
      catalogue: [{ firstPolymarketTags: ["esports"] }],
      reportRows: [{ kind: "tag", label: "sports" }],
      resolvedTags,
    });
    assert.deepEqual(options.tag, ["esports", "sports"]);
  }
});

test("BAIT: the filter must not re-render itself forever", () => {
  // The loader returns immediately once it has an answer, so a .then that re-renders on every
  // call recurses without end. It may only fire on the transition from "not loaded".
  const sync = APP.slice(APP.indexOf("function syncScrapedTaxonomyFilterControl()"));
  const body = sync.slice(0, sync.indexOf("\n}\n"));
  assert.match(body, /state\.resolvedTagOptions === null && !state\.resolvedTagOptionsPending/,
    "the re-render must be gated on the not-loaded state");
  assert.ok(body.indexOf("loadResolvedTagOptions") > body.indexOf("=== null"),
    "and the gate must come before the call");
});

test("the endpoint reads the folded statistics, not the payloads", () => {
  const storage = readFileSync(new URL("../storage.php", import.meta.url), "utf8");
  const fn = storage.slice(storage.indexOf("function trading_storage_resolved_stats_tags"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.match(body, /FROM trading_resolved_stats/,
    "90,795 settled payloads must not be walked to list tags");
  assert.match(body, /scope = "tag"/,
    "the any-tag rows carry an empty tag and would list as a blank option");
  assert.match(body, /GROUP BY tag/);
  assert.match(body, /LIMIT/, "and it must be bounded");
});
