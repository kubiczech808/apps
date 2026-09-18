// Runs offline: api.php's real reader is EXECUTED against a generated archive, under a PHP
// memory limit small enough that decoding it whole cannot succeed. No network, no database.
//
// Measured on production: action=state with segments=resolvedObservations, and with
// segments=resolvedRecent, both answer HTTP 500 from the published files while the same
// request answers 200 from the database. The cutover readiness run found it from one side
// and the Setup finder audit from the other -- nothing reports it on its own, the dashboard
// views that read these simply come back empty.
//
// The cause is where the bound sits. A downstream slice already trims the resolved list to
// 3000 rows, but that runs AFTER decode_state_file() has json_decoded the whole archive.
// The limit was applied to the response and never to the read.
//
// So the test has to be a memory test, not a row-count test: a cap that is applied after the
// file is already in memory passes every count assertion and still answers 500.

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API = readFileSync(new URL("../api.php", import.meta.url), "utf8");

function extractPhpFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start > 0, `${signature} must exist in api.php`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, "the function must be complete");
  return source.slice(start, end + 2);
}

const FUNCTIONS = [
  extractPhpFunction(API, "function stream_json_array_members(string $path, string $field, callable $onRow, ?callable $accepts = null): bool"),
  extractPhpFunction(API, "function load_resolved_segment_rows(string $path, int $limit = RESOLVED_SEGMENT_STREAM_LIMIT): array"),
].join("\n");

// An archive the size of the real one, written to disk rather than held in the test: the
// point is that the reader never has it all in memory, so neither may the fixture.
function writeArchive(path, rows, padding) {
  const chunks = ['{"generatedAt":"2026-09-18T08:00:00Z","resolvedMarketObservations":['];
  for (let index = 0; index < rows; index += 1) {
    chunks.push(`${index ? "," : ""}{"tokenId":"t${index}","firstMarketProbability":0.7,`
      + `"finalOutcomePrice":${index % 2},"note":"${"x".repeat(padding)}"}`);
    if (chunks.length > 500) {
      writeFileSync(path, chunks.join(""), { flag: index === chunks.length ? "w" : "a" });
      chunks.length = 0;
    }
  }
  chunks.push("]}");
  writeFileSync(path, chunks.join(""), { flag: "a" });
}

function run({ memoryLimit, limit, rows, padding, whole = false }) {
  const dir = mkdtempSync(join(tmpdir(), "resolved-stream-"));
  const archive = join(dir, "archive.json");
  writeFileSync(archive, "");
  writeArchive(archive, rows, padding);

  const script = join(dir, "run.php");
  writeFileSync(script, `<?php
const RESOLVED_SEGMENT_STREAM_LIMIT = ${limit};
${FUNCTIONS}
${whole ? `
// What the code did before: decode the file whole, then bound the result.
$decoded = json_decode(file_get_contents(${JSON.stringify(archive)}), true);
$rows = array_slice($decoded['resolvedMarketObservations'] ?? [], 0, RESOLVED_SEGMENT_STREAM_LIMIT);
` : `
$rows = load_resolved_segment_rows(${JSON.stringify(archive)});
`}
echo json_encode([
    'rows' => count($rows),
    'firstToken' => $rows[0]['tokenId'] ?? null,
    'lastToken' => $rows[count($rows) - 1]['tokenId'] ?? null,
    'peakMb' => round(memory_get_peak_usage(true) / 1048576, 1),
]);
`);
  try {
    return { ok: true, ...JSON.parse(execFileSync("php", ["-d", `memory_limit=${memoryLimit}`, script], { encoding: "utf8" })) };
  } catch (error) {
    return { ok: false, error: String(error.stderr || error.message).slice(0, 200) };
  }
}

// ~12 MB of archive. Small enough to generate quickly, large enough that an 8M limit cannot
// hold it -- which is the production shape in miniature.
const ARCHIVE = { rows: 12000, padding: 900 };

test("decoding the archive whole is what fails -- the production 500, reproduced", () => {
  const whole = run({ ...ARCHIVE, memoryLimit: "8M", limit: 3000, whole: true });
  assert.equal(whole.ok, false, "the old shape must run out of memory, or this proves nothing");
  assert.match(whole.error, /memory size|Allowed memory/i,
    `it must fail for memory, not for something else: ${whole.error}`);
});

test("streaming the same archive under the same limit succeeds", () => {
  const streamed = run({ ...ARCHIVE, memoryLimit: "8M", limit: 3000 });
  assert.equal(streamed.ok, true, `the streamed read must survive: ${streamed.error || ""}`);
  assert.equal(streamed.rows, 3000, "and stop at the cap");
  assert.ok(streamed.peakMb < 8, `and stay inside the limit: ${streamed.peakMb} MB`);
});

test("it stops reading at the cap rather than reading everything and slicing", () => {
  // The distinction the 500 turns on. A reader that takes the whole file and then keeps the
  // first N returns the same rows and still dies, so the row count alone cannot tell the two
  // apart -- the peak can. A 500-row cap must cost far less than a 3000-row one.
  const small = run({ ...ARCHIVE, memoryLimit: "64M", limit: 500 });
  const large = run({ ...ARCHIVE, memoryLimit: "64M", limit: 6000 });
  assert.equal(small.rows, 500);
  assert.equal(large.rows, 6000);
  assert.ok(small.peakMb < large.peakMb,
    `a smaller cap must cost less, or the whole file is being read either way: ${small.peakMb} vs ${large.peakMb}`);
});

test("the rows kept are the newest, which is what the segment is ordered by", () => {
  // Taking the FIRST rows is only correct because the segment is written newest-first. If
  // that ever changes, this keeps the oldest 3000 and the dashboard shows an archive frozen
  // months ago -- which would look like working software.
  const streamed = run({ ...ARCHIVE, memoryLimit: "64M", limit: 10 });
  assert.equal(streamed.firstToken, "t0");
  assert.equal(streamed.lastToken, "t9");

  const bot = readFileSync(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");
  assert.match(bot, /\.\.\.resolved\.sort\(\(a, b\) => marketObservationUpdateTime\(b\) - marketObservationUpdateTime\(a\)\),/,
    "the bot must keep writing the resolved segment newest-first");
});

test("an archive smaller than the cap comes back whole", () => {
  const streamed = run({ rows: 40, padding: 10, memoryLimit: "64M", limit: 3000 });
  assert.equal(streamed.rows, 40, "a short file is not padded, truncated or refused");
});

test("the segment loader uses it, and only for the resolved archive", () => {
  const start = API.indexOf("        $segmentPath = dirname($path) . '/' . $file;");
  assert.ok(start > 0, "the segment loader must be findable");
  const block = API.slice(start, start + 1400);
  assert.match(block, /load_resolved_segment_rows\(\$segmentPath\)/);
  // Every other segment is still a plain decode: they are bounded collections and reading
  // them whole is what the manifest exists for.
  assert.match(block, /\$segment = decode_state_file\(\$segmentPath, false\);/);
  // Appended, not assigned: the active catalogue may already be loaded and the views
  // downstream expect one combined list.
  assert.match(block, /array_merge\(\$active, load_resolved_segment_rows/);

  // And the cap sits above the 3000 the response already applies, so that slice still
  // decides what is served and this only stops the file being loaded whole.
  const cap = /const RESOLVED_SEGMENT_STREAM_LIMIT = (\d+);/.exec(API);
  assert.ok(cap, "the cap must be a named constant");
  assert.ok(Number(cap[1]) >= 3000,
    `the read cap must not be tighter than the serve limit: ${cap[1]}`);
});
