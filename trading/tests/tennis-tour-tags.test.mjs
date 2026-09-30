import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

function source(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");
}

function extractFunction(text, name) {
  const start = text.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  const opening = text.indexOf("{", text.indexOf(")", start));
  let depth = 0;
  for (let index = opening; index < text.length; index += 1) {
    if (text[index] === "{") depth += 1;
    if (text[index] === "}" && --depth === 0) return text.slice(start, index + 1);
  }
  throw new Error(`${name} is not balanced`);
}

const APP = source("../assets/app.js");
const BOT = source("../tools/paper-trading-bot.mjs");
const EXECUTOR = source("../tools/live-order-executor.mjs");
const API = source("../api.php");
const STORAGE = source("../storage.php");

function paperTags() {
  return new Function(`
    ${extractFunction(BOT, "derivedMarketTags")}
    ${/const TAG_FIELDS = \[[\s\S]*?\];/.exec(BOT)[0]}
    ${/const TAG_CATEGORY_FIELDS = \[[^\]]*\];/.exec(BOT)[0]}
    ${extractFunction(BOT, "rowTagSlugs")}
    return rowTagSlugs;
  `)();
}

function dashboardTags() {
  return new Function(`
    ${extractFunction(APP, "normalizedScrapedScanTag")}
    ${extractFunction(APP, "derivedTennisTourTags")}
    ${extractFunction(APP, "marketTagSlugsOf")}
    return marketTagSlugsOf;
  `)();
}

function liveTags() {
  return new Function(`
    ${extractFunction(EXECUTOR, "marketTagSlugs")}
    return marketTagSlugs;
  `)();
}

test("ATP and WTA stay visible and filterable beside official tennis tags", () => {
  const cases = [
    [{ eventSlug: "atp-lehecka-bergs-2026-09-29", polymarketTags: ["tennis", "sports", "games"] }, "atp"],
    [{ eventSlug: "wta-joint-kraus-2026-09-29", polymarketTags: ["tennis", "sports", "games"] }, "wta"],
  ];
  const readers = [paperTags(), dashboardTags(), liveTags()];
  for (const [row, tour] of cases) {
    for (const reader of readers) {
      const tags = reader(row);
      assert.ok(tags.has(tour), `${tour} must be retained by ${reader.name || "a tag reader"}`);
      assert.ok(tags.has("tennis"), "official Polymarket tag must remain alongside the tour");
    }
  }
});

test("only the real WTA acronym derives a women's tour tag", () => {
  const readers = [paperTags(), dashboardTags(), liveTags()];
  for (const reader of readers) {
    assert.ok(!reader({ eventSlug: "wtp-demo-market-2026-09-29", polymarketTags: ["tennis"] }).has("wta"));
    assert.ok(!reader({ question: "A player says atpology", polymarketTags: ["sports"] }).has("atp"));
  }
});

test("server taxonomy and persistence include derived tennis tours without treating them as categories", () => {
  assert.match(API, /function derived_market_tag_slugs\(array \$item\): array/);
  assert.match(API, /if \(\$firstField === 'firstPolymarketTags'\)/,
    "only tag statistics, not category statistics, gain derived tours");
  assert.match(API, /foreach \(derived_market_tag_slugs\(\$item\) as \$tag\)/,
    "the candidate scope must recognize the same tag as the user interface");
  assert.match(STORAGE, /\['polymarketTags', 'derivedTags', 'tags'/,
    "stored tag summaries must not drop a derived tour tag");
});

test("portfolio tag picker offers ATP and WTA even between tennis scan batches", () => {
  const vocabulary = new Function("state", `
    const PER_FIXTURE_TAXONOMY_LABEL = /^(team|event):/i;
    const MARKET_SCAN_CATEGORIES = ["sports", "esports"];
    ${extractFunction(APP, "normalizedScrapedScanTag")}
    ${extractFunction(APP, "derivedTennisTourTags")}
    ${extractFunction(APP, "marketTagSlugsOf")}
    const evaluationEnded = () => false;
    ${extractFunction(APP, "scrapedObservationStatus")}
    ${extractFunction(APP, "tagVocabulary")}
    return tagVocabulary();
  `)({ scrapedMarketObservations: [] });
  assert.ok(vocabulary.some((entry) => entry.slug === "atp"));
  assert.ok(vocabulary.some((entry) => entry.slug === "wta"));
});
