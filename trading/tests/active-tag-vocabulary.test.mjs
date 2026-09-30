import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const APP = readFileSync(new URL("../assets/app.js", import.meta.url), "utf8");

function extractFunction(name) {
  const start = APP.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  let params = APP.indexOf("(", start);
  let parameterDepth = 0;
  let open = -1;
  for (; params < APP.length; params += 1) {
    if (APP[params] === "(") parameterDepth += 1;
    if (APP[params] === ")" && --parameterDepth === 0) {
      open = APP.indexOf("{", params);
      break;
    }
  }
  assert.ok(open >= 0, `${name} body must exist`);
  let depth = 0;
  for (let at = open; at < APP.length; at += 1) {
    if (APP[at] === "{") depth += 1;
    if (APP[at] === "}" && --depth === 0) return APP.slice(start, at + 1);
  }
  throw new Error(`${name} is not balanced`);
}

test("portfolio tag suggestions use the active catalogue, not resolved history", () => {
  const vocabulary = new Function("state", `
    const PER_FIXTURE_TAXONOMY_LABEL = /^(team|event):/i;
    const MARKET_SCAN_CATEGORIES = ["sports", "esports"];
    ${extractFunction("normalizedScrapedScanTag")}
    ${extractFunction("derivedTennisTourTags")}
    ${extractFunction("marketTagSlugsOf")}
    const evaluationEnded = () => false;
    ${extractFunction("scrapedObservationStatus")}
    ${extractFunction("tagVocabulary")}
    return tagVocabulary();
  `)({
    scrapedMarketObservations: [
      { status: "SCRAPED", polymarketTags: ["esports", "counter-strike-2"] },
      { status: "RESOLVED", polymarketTags: ["1h"] },
    ],
  });

  assert.ok(vocabulary.some((entry) => entry.slug === "esports"));
  assert.ok(!vocabulary.some((entry) => entry.slug === "1h"));
});
