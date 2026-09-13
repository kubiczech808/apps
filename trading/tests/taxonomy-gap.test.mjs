// Runs offline: api.php is executed as a real request against a fabricated catalogue. No
// secrets, no network, no database.
//
// Reported with two screenshots of the same filter, taken seconds apart:
//
//   Catalogue overview   ESPORTS   1 370
//   Scraped, TAG=Esports           250 OF 287 SHOWN
//
// Both numbers were right, about different populations. The overview counts rows in the
// catalogue the browser holds. The list behind it is served by taxonomy-observations, which
// additionally requires a row the simulation can price and a spread inside the tradable
// ceiling -- so a market with no recorded quote is counted by one and omitted by the other.
// Nothing said so, and the overview promised "every number is a link and opens the list it
// counted".
//
// The gap is not a rounding error to be reconciled away. "1,083 Esports markets no
// portfolio can enter" is the answer to the question that was actually asked -- are we
// missing tradable opportunities -- so the endpoint now counts every row carrying the label
// and itemises what happened to the rest.

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API_PATH = new URL("../api.php", import.meta.url).pathname;

// One row per reason a market can be missing from the list, plus two that belong in it.
// Every row carries the tag, so carryingTag must count all of them.
const OBSERVATIONS = [
  // Listed: priced, tight book, still open.
  {
    tokenId: "1", question: "NAVI vs FaZe", outcome: "NAVI", polymarketTags: ["esports", "counter-strike-2"],
    marketProbability: 0.62, bestBid: 0.61, bestAsk: 0.63, status: "SCRAPED",
  },
  {
    tokenId: "2", question: "T1 vs GEN", outcome: "T1", polymarketTags: ["esports"],
    marketProbability: 0.55, spread: 0.02, status: "SCRAPED",
  },
  // No live quote ever recorded. The single largest bucket on production, and the one that
  // is a gap in what the scan saves rather than a market nobody wants to trade.
  {
    tokenId: "3", question: "Vitality vs G2", outcome: "Vitality", polymarketTags: ["esports"],
    bestBid: 0.4, bestAsk: 0.42, status: "SCRAPED",
  },
  // Priced, but the book is wider than the ceiling: a real absence of a counterparty.
  {
    tokenId: "4", question: "MOUZ vs Spirit", outcome: "MOUZ", polymarketTags: ["esports"],
    marketProbability: 0.5, bestBid: 0.2, bestAsk: 0.8, status: "SCRAPED",
  },
  // Priced, but no spread was ever saved. Needs the opposite fix to the row above, so the
  // two are counted apart.
  {
    tokenId: "5", question: "Heroic vs Astralis", outcome: "Heroic", polymarketTags: ["esports"],
    marketProbability: 0.48, status: "SCRAPED",
  },
  // Already resolved, and the request asks for open markets only.
  {
    tokenId: "6", question: "Falcons vs Liquid", outcome: "Falcons", polymarketTags: ["esports"],
    marketProbability: 0.7, spread: 0.01, status: "RESOLVED", resolvedOutcome: 1,
  },
  // A different tag entirely: it must not be counted anywhere.
  {
    tokenId: "7", question: "Chiefs vs Bills", outcome: "Chiefs", polymarketTags: ["nfl"],
    marketProbability: 0.6, spread: 0.01, status: "SCRAPED",
  },
];

function taxonomyRequest(query) {
  const directory = mkdtempSync(join(tmpdir(), "taxonomy-gap-"));
  try {
    mkdirSync(join(directory, "data"), { recursive: true });
    copyFileSync(API_PATH, join(directory, "api.php"));
    writeFileSync(join(directory, "config.php"), "<?php return ['trigger_key' => 'k'];");
    writeFileSync(join(directory, "storage.php"), `<?php
      function trading_storage_is_active(): bool { return false; }
      function trading_storage_document_get(string $key) { return null; }
      function trading_storage_document_put(string $k, string $t, array $p): void {}
      function trading_storage_event_append(string $s, ?string $p, array $q, ?string $o = null): void {}
      function trading_storage_observations_fetch(string $l, int $a = 0, int $b = 0, bool $c = false): array { return []; }
    `);
    writeFileSync(join(directory, "data", "paper-state.json"), JSON.stringify({
      schemaVersion: 7,
      generatedAt: "2026-09-13T05:53:00.000Z",
      paperPortfolios: {},
      marketObservations: OBSERVATIONS,
    }));
    const assigns = Object.entries({ action: "taxonomy-observations", target: "paper", ...query })
      .map(([key, value]) => `$_GET[${JSON.stringify(key)}] = ${JSON.stringify(String(value))};`)
      .join("\n");
    writeFileSync(join(directory, "prelude.php"), `<?php\n${assigns}\n$_SERVER['REQUEST_METHOD'] = 'GET';\n`);
    const output = execFileSync("php", [
      "-d", `auto_prepend_file=${join(directory, "prelude.php")}`,
      join(directory, "api.php"),
    ], { encoding: "utf8" });
    return JSON.parse(output.slice(output.indexOf("{")));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("taxonomy gap: every row carrying the tag is counted, and the difference is itemised", () => {
  const payload = taxonomyRequest({ kind: "tag", value: "esports", statuses: "SCRAPED", probability: "0" });

  // The number the catalogue overview shows: six rows carry the label, the NFL one does not.
  assert.equal(payload.carryingTag, 6, "the overview's number has to be available here");
  // The number the list holds.
  assert.equal(payload.matched, 2);
  assert.equal(payload.returned, 2);

  // And the four that are missing, each under the reason that removed it. This is the whole
  // point: "1,083 missing" is a mystery, and "812 never carried a quote" is a task.
  assert.deepEqual(payload.skipped, {
    noLiveQuote: 1,
    outsideProbabilityBand: 0,
    noRecordedSpread: 1,
    spreadWiderThanCeiling: 1,
    otherStatus: 1,
  });

  // The arithmetic must close, or the breakdown is decoration. A row that falls out for a
  // reason nobody counted would leave the two numbers unexplained all over again.
  const skipped = Object.values(payload.skipped).reduce((sum, count) => sum + count, 0);
  assert.equal(payload.matched + skipped, payload.carryingTag,
    `matched ${payload.matched} + skipped ${skipped} must equal carryingTag ${payload.carryingTag}`);

  // The ceiling is published with the counts, because "wider than the ceiling" is not a
  // number anyone can act on without knowing what the ceiling is.
  assert.equal(payload.maxTradableSpread, 0.05);
});

test("taxonomy gap: a probability band is counted apart from a missing quote", () => {
  // These two look identical in a list -- the row is simply not there -- and they mean
  // opposite things: one is a filter the reader chose, the other is data we never captured.
  const payload = taxonomyRequest({ kind: "tag", value: "esports", statuses: "SCRAPED", probability: "60" });
  assert.equal(payload.carryingTag, 6);
  assert.equal(payload.matched, 1, "only the 0.62 row is at or above 60%");
  assert.equal(payload.skipped.outsideProbabilityBand, 3,
    "0.55, 0.5 and 0.48 are below the band the reader asked for");
  assert.equal(payload.skipped.noLiveQuote, 1, "and a row with no quote is still not a band problem");
  const skipped = Object.values(payload.skipped).reduce((sum, count) => sum + count, 0);
  assert.equal(payload.matched + skipped, payload.carryingTag);
});

test("taxonomy gap: the rows the list does return are unchanged by the counting", () => {
  // The gates were reordered to make the counting possible -- the tag is asked first now --
  // and reordering refusals is exactly the kind of change that quietly admits a row it used
  // to refuse. The membership is asserted, not just the totals.
  const payload = taxonomyRequest({ kind: "tag", value: "esports", statuses: "SCRAPED", probability: "0" });
  const tokens = payload.marketObservations.map((row) => String(row.tokenId)).sort();
  assert.deepEqual(tokens, ["1", "2"],
    "only the priced, tight, open rows may be listed -- the same three gates as before");
});
