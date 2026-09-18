// Runs offline: the mirror's real Python functions are EXECUTED, and the key they compute is
// compared against the one storage.php's real PHP computes for the same row. No network, no
// database, no credentials.
//
// Measured on a market scan of 18.9.: 204 seconds of job, of which the scan itself was 37 and
// the MySQL mirror was 90 -- 27 POSTs of 300 observations, roughly 16 MB uploaded, every ten
// minutes, for a catalogue that mostly stands still. It re-sent everything because the
// payload always differs: each row carries its own observedAt and that ticks on every scrape
// even when nothing about the market moved.
//
// So rows are now compared on the four fields that decide whether a row is worth storing
// again. Two ways this can go wrong, and both are worse than the cost it removes:
//
//   skip a row that DID change  -> the database quietly goes stale and nothing reports it
//   mis-compute the key         -> every row looks new, the saving silently evaporates
//
// The second is the one that hides, so the key is checked against PHP's own, not restated.

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const INGEST = new URL("../tools/ingest-trading-state.py", import.meta.url).pathname;
const STORAGE = readFileSync(new URL("../storage.php", import.meta.url), "utf8");
const API = readFileSync(new URL("../api.php", import.meta.url), "utf8");

// Calls the real module's real functions. Importing rather than re-implementing is the whole
// point: a copy of the rule would pass its own tests while the deployed one did anything.
function runPython(body) {
  const dir = mkdtempSync(join(tmpdir(), "mirror-skip-"));
  const script = join(dir, "run.py");
  writeFileSync(script, `import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("ingest", ${JSON.stringify(INGEST)})
ingest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ingest)
${body}
`);
  return execFileSync("python3", [script], { encoding: "utf8" });
}

const unchanged = (row, stored) => runPython(
  `print(json.dumps(ingest.observation_is_unchanged(${JSON.stringify(JSON.stringify(row))} and json.loads(${JSON.stringify(JSON.stringify(row))}), json.loads(${JSON.stringify(JSON.stringify(stored))}))))`,
).trim() === "true";

// probability, volume, end_at, lifecycle -- positionally, as the endpoint returns them.
const stored = (probability, volume, endAt, lifecycle = "SCRAPED") => [probability, volume, endAt, lifecycle];

const market = (overrides = {}) => ({
  tokenId: "tok-1",
  eventSlug: "cs-nrg-vs-aurora",
  outcome: "Yes",
  marketProbability: 0.74,
  volumeUsdc: 5000,
  endDate: "2026-09-19T18:00:00.000Z",
  status: "SCRAPED",
  observedAt: "2026-09-18T06:40:00.000Z",
  ...overrides,
});

test("a market that only ticked its observedAt is not sent again", () => {
  // The whole saving. Same price, same volume, same end date -- a new scrape timestamp and
  // nothing else, which is what 8000 rows look like ten minutes apart.
  assert.equal(unchanged(market({ observedAt: "2026-09-18T06:50:00.000Z" }),
    stored(0.74, 5000, "2026-09-19 18:00:00")), true);
});

test("a market nobody has stored is always sent", () => {
  assert.equal(unchanged(market(), null), false, "no fingerprint means a new market");
  assert.equal(unchanged(market(), []), false, "and so does a truncated one");
});

test("a price that actually moved is sent", () => {
  // 74.0% -> 76.0%: two points, which is a different trade.
  assert.equal(unchanged(market({ marketProbability: 0.76 }),
    stored(0.74, 5000, "2026-09-19 18:00:00")), false);
  // And just past the tolerance, so the threshold is the thing being tested rather than the
  // size of the fixture: 0.1 point is kept, 0.2 is not.
  assert.equal(unchanged(market({ marketProbability: 0.7409 }),
    stored(0.74, 5000, "2026-09-19 18:00:00")), true);
  assert.equal(unchanged(market({ marketProbability: 0.7421 }),
    stored(0.74, 5000, "2026-09-19 18:00:00")), false);
});

test("a market that resolved is always sent, whatever its numbers say", () => {
  // The lifecycle change is the single most important thing this mirror carries -- it is
  // what the resolved statistics are built from -- and a resolved market often resolves AT
  // the price it last traded, so the numeric comparison alone would skip exactly the row
  // that matters most.
  assert.equal(unchanged(market({ status: "RESOLVED" }),
    stored(0.74, 5000, "2026-09-19 18:00:00", "SCRAPED")), false);
});

test("a horizon that moved is sent", () => {
  // Every portfolio rule reads the end date, so a rescheduled fixture must never be skipped.
  assert.equal(unchanged(market({ endDate: "2026-09-20T18:00:00.000Z" }),
    stored(0.74, 5000, "2026-09-19 18:00:00")), false);
  // The stored side is a MySQL DATETIME and the feed side is ISO with a Z. Comparing them
  // naively marks every row as changed, which is the failure that silently removes the
  // saving while every other test here still passes.
  assert.equal(unchanged(market({ endDate: "2026-09-19T18:00:00Z" }),
    stored(0.74, 5000, "2026-09-19 18:00:00")), true);
});

test("volume moves within noise are ignored, real ones are not", () => {
  assert.equal(unchanged(market({ volumeUsdc: 5020 }), stored(0.74, 5000, "2026-09-19 18:00:00")), true);
  assert.equal(unchanged(market({ volumeUsdc: 9000 }), stored(0.74, 5000, "2026-09-19 18:00:00")), false);
  // A tiny market must not be given the flat $50 tolerance as a percentage of nothing: $50
  // of absolute tolerance is the floor, so 10 -> 55 is still inside it and 10 -> 500 is not.
  assert.equal(unchanged(market({ volumeUsdc: 55 }), stored(0.74, 10, "2026-09-19 18:00:00")), true);
  assert.equal(unchanged(market({ volumeUsdc: 500 }), stored(0.74, 10, "2026-09-19 18:00:00")), false);
});

test("a field that appeared or vanished is sent", () => {
  assert.equal(unchanged(market({ marketProbability: null }),
    stored(0.74, 5000, "2026-09-19 18:00:00")), false, "a price we no longer have");
  assert.equal(unchanged(market(), stored(null, 5000, "2026-09-19 18:00:00")), false,
    "a price the database never had");
});

test("the key the mirror computes is the key PHP files the row under", () => {
  // The quiet failure. A key that does not match means every fingerprint lookup misses,
  // every row is treated as new, and the mirror does exactly what it did before -- while
  // every test above still passes, because they are handed the fingerprint directly.
  const rows = [
    market(),
    market({ id: "0x1234" }),
    market({ tokenId: "", firstTokenId: "tok-2", firstOutcome: "No", outcome: undefined }),
    market({ eventSlug: undefined, slug: "map-2-winner" }),
  ];

  const php = (() => {
    const start = STORAGE.indexOf("function trading_storage_observation_key(array $item): string");
    assert.ok(start > 0);
    return STORAGE.slice(start, STORAGE.indexOf("\n}\n", start) + 2);
  })();
  const dir = mkdtempSync(join(tmpdir(), "mirror-key-"));
  const phpScript = join(dir, "key.php");
  writeFileSync(phpScript, `<?php
${php}
$rows = json_decode(${JSON.stringify(JSON.stringify(rows))}, true);
echo json_encode(array_map('trading_storage_observation_key', $rows));
`);
  const fromPhp = JSON.parse(execFileSync("php", [phpScript], { encoding: "utf8" }));

  const fromPython = JSON.parse(runPython(
    `rows = json.loads(${JSON.stringify(JSON.stringify(rows))})\n`
    + `print(json.dumps([ingest._observation_key(r) for r in rows]))`,
  ));

  assert.deepEqual(fromPython, fromPhp,
    "the mirror and the database must agree on what identifies a row");
  assert.equal(new Set(fromPhp).size, fromPhp.length, "and the fixtures must be distinguishable");
});

test("the filter is actually applied to what gets posted, and can be turned off", () => {
  const source = readFileSync(INGEST, "utf8");
  // Inside the batching loop, before the POST -- not computed and then ignored.
  const loop = source.slice(source.indexOf("    for source, field in sources:"));
  assert.match(loop, /observation_is_unchanged\(row, fingerprints\.get\(_observation_key\(row\)\)\)/);
  assert.ok(loop.indexOf("observation_is_unchanged") < loop.indexOf("for offset in range(0, len(rows), 300)"),
    "rows must be filtered before they are batched, or nothing is saved");
  assert.match(source, /TRADING_STORAGE_INGEST_FULL/, "there must be a way to force a full mirror");
  // A fingerprint fetch that fails must send everything rather than send nothing.
  assert.match(source, /mirroring everything/);
  assert.match(source, /return \{\}/);
  // And it says how many it skipped, or a mirror that silently stopped writing looks
  // identical to one that had nothing to write.
  assert.match(source, /Skipped \{skipped\} observation\(s\)/);
});

test("the endpoint is read-only and behind the key", () => {
  const start = API.indexOf("if ($operation === 'observation-fingerprints') {");
  assert.ok(start > 0, "the operation must be reachable");
  assert.match(API.slice(start, start + 400), /trading_storage_observation_fingerprints\(/);
  const admin = API.slice(API.indexOf("if ($action === 'storage-admin') {"), start);
  assert.match(admin, /require_trading_trigger_key\(\);/);
  assert.match(admin, /REQUEST_METHOD'\] !== 'POST'/);
  // The query reads five columns and writes nothing.
  const fn = STORAGE.slice(STORAGE.indexOf("function trading_storage_observation_fingerprints"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.match(body, /SELECT observation_key, lifecycle, market_probability, volume_usdc, end_at/);
  // Word-bounded: an unbounded /UPDATE/i also matches the updated_at column this
  // query legitimately reads, and a test that fails on its own WHERE clause gets deleted.
  assert.doesNotMatch(body, /\b(DELETE|UPDATE|INSERT|ALTER|DROP|TRUNCATE)\b/i);
  // Bounded: an unbounded SELECT over 224 000 rows is how this becomes the new 90 seconds.
  assert.match(body, /LIMIT/);
  assert.match(body, /updated_at >= \(UTC_TIMESTAMP\(\) - INTERVAL :days DAY\)/);
});
