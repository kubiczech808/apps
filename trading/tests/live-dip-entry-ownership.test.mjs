// Runs offline: api.php's real ownership-recording function is EXECUTED against a
// temporary execution-state file. No network, no database, no credentials.
//
// Reported: "Games Total: O/U 3.5" on a League of Legends match, bought by the dip 70+ ->
// 45-56 live portfolio (no stop loss configured) and sold 66 seconds later at 47% -- inside
// the base Live portfolio's 0.49 floor, a cap the position's actual portfolio never set.
//
// The cause: a live dip-entry fires from the RPi worker directly, never through
// live-order-executor.mjs, and so never reaches that script's own orderOwnership write.
// live_stop_loss_policy_payload() already reads orderOwnership from every portfolio's
// execution state to decide whose policy protects a position -- a token this function never
// touches simply is not there, and falls through to the base portfolio's stop instead.

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
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

// A plain literal, not brace-matched: extractPhpFunction looks for the next "\n}\n" after
// the start, which for a bare `const X = 4000;` line would run on into the next unrelated
// function and lift far more than intended.
const OWNERSHIP_LIMIT_LINE = API.match(/^const LIVE_DIP_ENTRY_OWNERSHIP_LIMIT = 4000;$/m)?.[0];
assert.ok(OWNERSHIP_LIMIT_LINE, "the cap constant must exist in api.php, unchanged");

const FUNCTIONS = [
  extractPhpFunction(API, "function live_execution_state_path_for_policy(string $portfolioId): string"),
  // A minimal stand-in for the real decode_state_file(), which the lifted function calls to
  // read whatever seed state the test wrote. The real one also handles the compact,
  // segmented and pending-upload cases this harness has no need to reproduce.
  "function decode_state_file(string $path, bool $waitForUpload = true): ?array {"
    + " if (!is_file($path)) return null;"
    + " $decoded = json_decode(file_get_contents($path), true);"
    + " return is_array($decoded) ? $decoded : null; }",
  OWNERSHIP_LIMIT_LINE,
  extractPhpFunction(API, "function record_live_dip_entry_ownership(array $input): array"),
].join("\n");

// __DIR__ inside the lifted function resolves to wherever the harness script lives, so the
// path helper is monkey-patched to a temp dir rather than fighting __DIR__ directly.
function withTempDataDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "live-dip-ownership-"));
  mkdirSync(join(dir, "data"), { recursive: true });
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function record(dir, input, seedState = null) {
  const script = join(dir, "run.php");
  const seedPath = join(dir, "data", "live-dip704060live-execution-state.json");
  if (seedState) writeFileSync(seedPath, JSON.stringify(seedState));
  writeFileSync(script, `<?php
define('__DIR__OVERRIDE__', ${JSON.stringify(dir)});
${FUNCTIONS.replace(/__DIR__/g, "__DIR__OVERRIDE__")}
$result = record_live_dip_entry_ownership(json_decode(${JSON.stringify(JSON.stringify(input))}, true));
$after = @file_get_contents(${JSON.stringify(seedPath)});
echo json_encode(['result' => $result, 'state' => $after !== false ? json_decode($after, true) : null]);
`);
  return JSON.parse(execFileSync("php", [script], { encoding: "utf8" }));
}

test("a live dip-entry fill is recorded as this portfolio's ownership", () => {
  const outcome = withTempDataDir((dir) => record(dir, {
    portfolioId: "live-custom-dip704060live",
    tokenId: "12345678901234567890",
    price: 0.5624,
    at: "2026-09-27T21:17:23.000Z",
  }));
  assert.equal(outcome.result.ok, true);
  assert.equal(outcome.state.orderOwnership.length, 1);
  assert.equal(outcome.state.orderOwnership[0].tokenId, "12345678901234567890");
  assert.equal(outcome.state.orderOwnership[0].price, 0.5624);
  assert.equal(outcome.state.orderOwnership[0].at, "2026-09-27T21:17:23.000Z");
  assert.equal(outcome.state.orderOwnership[0].mode, "live");
});

test("portfolioId and tokenId are both required", () => {
  const outcome = withTempDataDir((dir) => record(dir, { portfolioId: "live-custom-dip704060live" }));
  assert.equal(outcome.result.ok, false);
  const outcome2 = withTempDataDir((dir) => record(dir, { tokenId: "123" }));
  assert.equal(outcome2.result.ok, false);
});

test("an existing execution state keeps its other fields -- this only touches orderOwnership", () => {
  const outcome = withTempDataDir((dir) => record(dir, {
    portfolioId: "live-custom-dip704060live",
    tokenId: "999",
    price: 0.5,
    at: "2026-09-27T22:00:00.000Z",
  }, {
    runLog: [{ action: "SUBMITTED", generatedAt: "2026-09-20T00:00:00Z" }],
    orderOwnership: [{ tokenId: "111", price: 0.4, mode: "live", at: "2026-09-01T00:00:00Z" }],
  }));
  assert.equal(outcome.state.runLog.length, 1, "the run log this portfolio's own executor writes is untouched");
  assert.equal(outcome.state.orderOwnership.length, 2, "the new claim is added beside the existing one");
  assert.deepEqual(outcome.state.orderOwnership.map((row) => row.tokenId).sort(), ["111", "999"]);
});

test("a second fill of the same token at the same price replaces the first, not duplicates it", () => {
  const outcome = withTempDataDir((dir) => {
    record(dir, { portfolioId: "live-custom-dip704060live", tokenId: "555", price: 0.5, at: "2026-09-27T10:00:00.000Z" });
    return record(dir, { portfolioId: "live-custom-dip704060live", tokenId: "555", price: 0.5, at: "2026-09-27T11:00:00.000Z" });
  });
  assert.equal(outcome.state.orderOwnership.length, 1);
  assert.equal(outcome.state.orderOwnership[0].at, "2026-09-27T11:00:00.000Z", "the newer claim wins");
});

test("the same token bought again at a DIFFERENT price is a separate claim", () => {
  // Mirrors live-order-executor.mjs's own mergeOrderOwnership(): keyed on tokenId AND price,
  // because a token re-entered at a different price is a different order, not the same one.
  const outcome = withTempDataDir((dir) => {
    record(dir, { portfolioId: "live-custom-dip704060live", tokenId: "777", price: 0.5, at: "2026-09-27T10:00:00.000Z" });
    return record(dir, { portfolioId: "live-custom-dip704060live", tokenId: "777", price: 0.62, at: "2026-09-27T11:00:00.000Z" });
  });
  assert.equal(outcome.state.orderOwnership.length, 2);
});

test("a missing or unparsable timestamp is not fatal -- the record still lands, timestamped now", () => {
  const outcome = withTempDataDir((dir) => record(dir, { portfolioId: "live-custom-dip704060live", tokenId: "1", price: 0.5 }));
  assert.equal(outcome.result.ok, true);
  assert.ok(outcome.state.orderOwnership[0].at, "some timestamp was written");
});

test("the endpoint requires the trigger key, same as the paper dip-entry recorder beside it", () => {
  assert.match(API, /if \(\$action === 'live-dip-entry-ownership'\) \{\s*\n\s*require_trading_trigger_key\(\);/);
});

test("the write is capped the same way live-order-executor.mjs bounds its own copy", () => {
  const executor = readFileSync(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8");
  assert.match(executor, /const ORDER_OWNERSHIP_LIMIT = 4000;/);
  assert.match(API, /const LIVE_DIP_ENTRY_OWNERSHIP_LIMIT = 4000;/);
});
