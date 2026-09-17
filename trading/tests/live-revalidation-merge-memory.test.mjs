// Runs offline: api.php executed as a real POST against a catalogue larger than the memory
// PHP is given. No network, no secrets.
//
// This test exists because the endpoint shipped without it and production answered:
//
//   HTTP 500 {"ok":false,"error":"Trading API stopped on a fatal error.",
//             "reason":"Allowed memory size of 536870912 bytes exhausted
//                       (tried to allocate 20480 bytes)",
//             "where":"api.php:342","memoryPeakMb":512.6,"memoryLimit":"512M"}
//
// api.php:342 is the json_decode inside decode_state_file. The first version of the merge
// decoded the observations segment -- the whole scraped catalogue -- to change a handful of
// rows in it, which is exactly the thing stream_json_array_members exists in this file to
// avoid. Every other test passed throughout, because every other fixture is a few kilobytes.
//
// So this one is sized against the limit rather than against convenience: PHP is given 48 MB
// and the catalogue is made comfortably larger than that. An implementation that decodes the
// segment cannot pass, whatever the catalogue grows to; one that streams does not care.

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API_PATH = new URL("../api.php", import.meta.url).pathname;
const MEMORY_LIMIT = "32M";

// Rows the size the scan actually writes: the published catalogue measured 21.32 MB over
// 8001 rows, and the stored segment carries more per row than the response does.
function catalogue(count) {
  const filler = "y".repeat(2400);
  return Array.from({ length: count }, (_, index) => ({
    tokenId: `token-${index}`,
    question: `Market ${index} ${filler}`,
    status: "SCRAPED",
    selectionStatus: "READY",
    marketPrice: 0.62,
    marketProbability: 0.62,
    annualizedReturn: 1.9,
    expectedValueUsdc: 0.44,
    liquidity: 4200,
    slug: `market-${index}`,
    endDate: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-17T06:00:00.000Z",
  }));
}

function mergeAgainstALargeCatalogue(updates) {
  const directory = mkdtempSync(join(tmpdir(), "revalidation-memory-"));
  try {
    mkdirSync(join(directory, "data"), { recursive: true });
    copyFileSync(API_PATH, join(directory, "api.php"));
    writeFileSync(join(directory, "config.php"), `<?php return ['trigger_key' => 'k'];`);
    writeFileSync(join(directory, "storage.php"), `<?php
      function trading_storage_pdo() { return new PDO('sqlite::memory:'); }
      function trading_storage_bootstrap($pdo): void {}
      function trading_storage_is_active(): bool { return false; }
      function trading_storage_observation_counts(): array { return ['SCRAPED' => 0, 'RESOLVED' => 0]; }
      function trading_storage_event_stream_stats(): array { return []; }
      function trading_storage_observation_freshness(): array { return []; }
      function trading_storage_meta_get(string $key) { return null; }
      function trading_storage_document_get(string $key) { return null; }
      function trading_storage_document_put(string $k, string $t, array $p): void {}
      function trading_storage_event_append(string $s, ?string $p, array $q, ?string $o = null): void {}
    `);

    writeFileSync(join(directory, "data", "paper-state.json"), JSON.stringify({
      schemaVersion: 7,
      paperPortfolios: {},
      stateSegments: {
        evaluations: { file: "paper-state.evaluations.json" },
        observations: { file: "paper-state.observations.json" },
      },
      evaluations: [],
      marketObservations: [],
    }));
    writeFileSync(join(directory, "data", "paper-state.evaluations.json"),
      JSON.stringify({ evaluations: catalogue(8000) }));
    writeFileSync(join(directory, "data", "paper-state.observations.json"),
      JSON.stringify({ marketObservations: catalogue(14000) }));

    const megabytes = (name) => statSync(join(directory, "data", name)).size / (1024 * 1024);
    const sizes = {
      evaluations: megabytes("paper-state.evaluations.json"),
      observations: megabytes("paper-state.observations.json"),
    };

    writeFileSync(join(directory, "body.json"), JSON.stringify({ updates }));
    writeFileSync(join(directory, "prelude.php"), `<?php
      class TestInputStream {
        public $context;
        private $offset = 0;
        private $body = '';
        public function stream_open($path, $mode, $options, &$opened) {
          $this->body = (string) file_get_contents(__DIR__ . '/body.json');
          return true;
        }
        public function stream_read($count) {
          $chunk = substr($this->body, $this->offset, $count);
          $this->offset += strlen($chunk);
          return $chunk;
        }
        public function stream_eof() { return $this->offset >= strlen($this->body); }
        public function stream_stat() { return ['size' => strlen($this->body)]; }
        public function stream_seek($offset, $whence = SEEK_SET) { $this->offset = $offset; return true; }
        public function stream_tell() { return $this->offset; }
      }
      stream_wrapper_unregister('php');
      stream_wrapper_register('php', 'TestInputStream');
      $_GET['action'] = 'live-revalidation-merge';
      $_SERVER['REQUEST_METHOD'] = 'POST';
      $_SERVER['HTTP_X_TRADING_TRIGGER_KEY'] = 'k';
    `);

    let output = "";
    let failure = null;
    try {
      output = execFileSync("php", [
        "-d", `memory_limit=${MEMORY_LIMIT}`,
        "-d", `auto_prepend_file=${join(directory, "prelude.php")}`,
        join(directory, "api.php"),
      ], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    } catch (error) {
      failure = `${error.stdout || ""}${error.stderr || ""}`;
    }
    const read = (name) => JSON.parse(readFileSync(join(directory, "data", name), "utf8"));
    return {
      sizes,
      failure,
      payload: failure ? null : JSON.parse(output.slice(output.indexOf("{"))),
      evaluations: read("paper-state.evaluations.json").evaluations,
      observations: read("paper-state.observations.json").marketObservations,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("a catalogue larger than the memory limit is merged, not decoded", () => {
  const checkedAt = "2026-09-17T20:40:00.000Z";
  const result = mergeAgainstALargeCatalogue([
    { tokenId: "token-7999", checkedAt, marketPrice: 0.71, annualizedReturn: 1.1 },
    { tokenId: "token-13999", checkedAt, marketGone: true },
  ]);

  // The guard on the guard. If the fixture ever shrinks below the limit this test would
  // pass by proving nothing, which is precisely how the defect reached production.
  assert.ok(result.sizes.observations > 32,
    `the catalogue must exceed the ${MEMORY_LIMIT} limit, got ${result.sizes.observations.toFixed(1)} MB`);

  assert.equal(result.failure, null,
    `the merge must survive a catalogue it cannot hold: ${String(result.failure).slice(0, 400)}`);
  assert.equal(result.payload.ok, true);
  // Three rows, not two: token-7999 is in BOTH segments, and a token in both has to be
  // patched in both or the two fields disagree about the same market.
  assert.equal(result.payload.merged, 3);
  assert.deepEqual(result.payload.segments, ["evaluations", "observations"]);
  assert.equal(result.observations[7999].marketPrice, 0.71,
    "the same market carried in the observations segment must be patched there too");

  // The last row of each segment, so the walk is proved to reach the end rather than
  // stopping early and reporting what it managed.
  const evaluated = result.evaluations.at(-1);
  assert.equal(evaluated.tokenId, "token-7999");
  assert.equal(evaluated.marketPrice, 0.71);
  assert.equal(evaluated.annualizedReturn, 1.1);
  assert.equal(evaluated.executionRevalidation.checkedAt, checkedAt);

  const observed = result.observations.at(-1);
  assert.equal(observed.tokenId, "token-13999");
  assert.equal(observed.status, "CLOSED");
  assert.equal(observed.acceptingOrders, false);
  assert.deepEqual(result.payload.closedOut, ["token-13999"]);
});

test("a row that straddles a read-chunk boundary is still patched", () => {
  // Added because a bait did not fail: setting the rewrite's sliding window to keep nothing
  // -- which loses any needle spanning a chunk boundary -- broke neither test above. It did
  // not, by luck: the reader takes 512 KB at a time, a row is about 2.5 KB, so a given row
  // has roughly a one-in-two-hundred chance of straddling one. Testing that with an
  // arbitrary row is testing nothing.
  //
  // So the row is CHOSEN: the file is measured and the first row that actually spans a
  // 512 KB boundary is the one updated.
  const chunk = 1 << 19;
  const rows = catalogue(14000);
  const text = JSON.stringify({ marketObservations: rows });
  let straddling = null;
  for (const row of rows) {
    const member = JSON.stringify(row);
    const start = text.indexOf(member);
    const end = start + member.length;
    if (Math.floor(start / chunk) !== Math.floor(end / chunk)) {
      straddling = row.tokenId;
      break;
    }
  }
  assert.ok(straddling, "a fixture this size must contain a row crossing a chunk boundary");

  const result = mergeAgainstALargeCatalogue([
    { tokenId: straddling, checkedAt: "2026-09-17T20:40:00.000Z", marketPrice: 0.77 },
  ]);
  assert.equal(result.failure, null,
    `a row on a chunk boundary must still be found: ${String(result.failure).slice(0, 300)}`);
  const patched = result.observations.find((row) => row.tokenId === straddling);
  assert.equal(patched.marketPrice, 0.77, `${straddling} spans a chunk boundary and must be patched`);
});

test("a splice that cannot find what it was told to replace changes nothing", () => {
  // Added because a bait did not fail: dropping the "every needle was found" check was
  // invisible, since in every other test every needle is there. It is not always: the
  // catalogue is rewritten by the paper bot on its own schedule, so a merge can read a
  // member and find the file replaced underneath it before the rewrite runs. Half a merge
  // applied is worse than none, and silently reporting it as done is worse still.
  const directory = mkdtempSync(join(tmpdir(), "revalidation-splice-"));
  try {
    const api = readFileSync(API_PATH, "utf8");
    const definitions = join(directory, "definitions.php");
    writeFileSync(definitions, api.slice(0, api.indexOf("\ntry {")) + "\n");
    mkdirSync(join(directory, "data"), { recursive: true });
    const target = join(directory, "catalogue.json");
    const before = JSON.stringify({ marketObservations: catalogue(4) });
    writeFileSync(target, before);

    const run = (replacements) => execFileSync("php", ["-r",
      `chdir('${directory}'); require '${definitions}';`
      + ` $r = json_decode('${JSON.stringify(replacements)}', true);`
      + ` echo json_encode(['ok' => splice_file_substrings('${target}', $r)]);`,
    ], { encoding: "utf8", cwd: directory });

    const missing = JSON.parse(run({ '{"tokenId":"token-that-is-not-in-the-file"}': { to: "{}", times: 1 } }));
    assert.equal(missing.ok, false, "a needle that is not there must be reported as a failure");
    assert.equal(readFileSync(target, "utf8"), before,
      "and the catalogue must be exactly as it was, not half rewritten");

    // The other half: a needle that IS there is replaced, so the refusal above is about the
    // missing needle rather than the helper refusing everything.
    const present = JSON.parse(run({ '"token-2"': { to: '"token-replaced"', times: 1 } }));
    assert.equal(present.ok, true);
    assert.match(readFileSync(target, "utf8"), /token-replaced/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("every other row of a spliced catalogue survives byte for byte", () => {
  // The rewrite is a byte-level splice over a file too large to hold, so the failure to
  // fear is not a wrong value in one row -- it is a truncated or mangled catalogue.
  const result = mergeAgainstALargeCatalogue([
    { tokenId: "token-1", checkedAt: "2026-09-17T20:40:00.000Z", marketPrice: 0.71 },
  ]);
  assert.equal(result.failure, null);
  assert.equal(result.evaluations.length, 8000, "no row may be lost");
  assert.equal(result.observations.length, 14000);

  const untouched = catalogue(8000);
  for (const index of [0, 2, 3, 1000, 7999]) {
    assert.deepEqual(result.evaluations[index], untouched[index],
      `row ${index} must be exactly as it was`);
  }
  // And the row that WAS patched kept everything the update did not mention.
  const patched = result.evaluations[1];
  assert.equal(patched.marketPrice, 0.71);
  assert.equal(patched.question, untouched[1].question);
  assert.equal(patched.liquidity, 4200);
  assert.equal(patched.slug, "market-1");
});
