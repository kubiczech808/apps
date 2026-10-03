// Runs offline: api.php's real ownership-recording function is EXECUTED against a
// temporary, server-owned ownership ledger. No network, no database, no credentials.
//
// Reported: "Games Total: O/U 3.5" on a League of Legends match, bought by the dip 70+ ->
// 45-56 live portfolio (no stop loss configured) and sold 66 seconds later at 47% -- inside
// the base Live portfolio's 0.49 floor, a cap the position's actual portfolio never set.
//
// The cause: a live dip-entry fires from the RPi worker directly, never through
// live-order-executor.mjs, and so never reaches that script's own orderOwnership write.
// The ledger must be independent from execution-state uploads. Otherwise an ordinary
// executor run can erase a direct DIP fill's owner before the exit worker sees it.

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
  const open = source.indexOf("{", start);
  assert.ok(open > start, "the function must have a body");
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  assert.fail("the function must be complete");
}

// A plain literal, not brace-matched: extractPhpFunction looks for the next "\n}\n" after
// the start, which for a bare `const X = 4000;` line would run on into the next unrelated
// function and lift far more than intended.
const OWNERSHIP_LIMIT_LINE = API.match(/^const LIVE_DIP_ENTRY_OWNERSHIP_LIMIT = 4000;$/m)?.[0];
assert.ok(OWNERSHIP_LIMIT_LINE, "the cap constant must exist in api.php, unchanged");

const FUNCTIONS = [
  extractPhpFunction(API, "function live_dip_entry_ownership_path(): string"),
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

function record(dir, input, seedLedger = null, seedExecutionState = null) {
  const script = join(dir, "run.php");
  const ledgerPath = join(dir, "data", "live-dip-entry-ownership.json");
  const executionPath = join(dir, "data", "live-dip704060live-execution-state.json");
  if (seedLedger) writeFileSync(ledgerPath, JSON.stringify(seedLedger));
  if (seedExecutionState) writeFileSync(executionPath, JSON.stringify(seedExecutionState));
  writeFileSync(script, `<?php
define('__DIR__OVERRIDE__', ${JSON.stringify(dir)});
${FUNCTIONS.replace(/__DIR__/g, "__DIR__OVERRIDE__")}
$result = record_live_dip_entry_ownership(json_decode(${JSON.stringify(JSON.stringify(input))}, true));
$ledger = @file_get_contents(${JSON.stringify(ledgerPath)});
$execution = @file_get_contents(${JSON.stringify(executionPath)});
echo json_encode(['result' => $result, 'ledger' => $ledger !== false ? json_decode($ledger, true) : null, 'execution' => $execution !== false ? json_decode($execution, true) : null]);
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
  assert.equal(outcome.ledger.records.length, 1);
  assert.equal(outcome.ledger.records[0].portfolioId, "live-custom-dip704060live");
  assert.equal(outcome.ledger.records[0].tokenId, "12345678901234567890");
  assert.equal(outcome.ledger.records[0].price, 0.5624);
  assert.equal(outcome.ledger.records[0].at, "2026-09-27T21:17:23.000Z");
  assert.equal(outcome.ledger.records[0].mode, "live");
});

test("a direct dip fill is also exposed as a durable portfolio run-log row", () => {
  assert.match(API, /function live_dip_entry_run_log_records\(string \$portfolioId, int \$limit = 400\): array/);
  assert.match(API, /'action' => 'DIP_ENTRY_SUBMITTED'/);
  assert.match(API, /if \(\$action === 'live-dip-entry-log'\)/);
  assert.match(API, /'records' => live_dip_entry_run_log_records\(\$portfolioId\)/);
  const app = readFileSync(new URL("../assets/app.js", import.meta.url), "utf8");
  assert.match(app, /api\.php\?action=live-dip-entry-log&portfolio_id=/);
  assert.match(app, /rows\.push\(\.\.\.directDipEntries\)/);
});

test("portfolioId and tokenId are both required", () => {
  const outcome = withTempDataDir((dir) => record(dir, { portfolioId: "live-custom-dip704060live" }));
  assert.equal(outcome.result.ok, false);
  const outcome2 = withTempDataDir((dir) => record(dir, { tokenId: "123" }));
  assert.equal(outcome2.result.ok, false);
});

test("a direct DIP fill cannot be erased by an executor-state upload", () => {
  const outcome = withTempDataDir((dir) => record(dir, {
    portfolioId: "live-custom-dip704060live",
    tokenId: "999",
    price: 0.5,
    at: "2026-09-27T22:00:00.000Z",
  }, null, {
    runLog: [{ action: "SUBMITTED", generatedAt: "2026-09-20T00:00:00Z" }],
    orderOwnership: [{ tokenId: "111", price: 0.4, mode: "live", at: "2026-09-01T00:00:00Z" }],
  }));
  assert.equal(outcome.execution.runLog.length, 1, "the executor file is not touched");
  assert.equal(outcome.execution.orderOwnership.length, 1, "the executor keeps its own state");
  assert.equal(outcome.ledger.records.length, 1, "the DIP fill is stored separately");
  assert.equal(outcome.ledger.records[0].tokenId, "999");
});

test("a second fill of the same token at the same price replaces the first, not duplicates it", () => {
  const outcome = withTempDataDir((dir) => {
    record(dir, { portfolioId: "live-custom-dip704060live", tokenId: "555", price: 0.5, at: "2026-09-27T10:00:00.000Z" });
    return record(dir, { portfolioId: "live-custom-dip704060live", tokenId: "555", price: 0.5, at: "2026-09-27T11:00:00.000Z" });
  });
  assert.equal(outcome.ledger.records.length, 1);
  assert.equal(outcome.ledger.records[0].at, "2026-09-27T11:00:00.000Z", "the newer claim wins");
});

test("the same token bought again at a DIFFERENT price is a separate claim", () => {
  // Mirrors live-order-executor.mjs's own mergeOrderOwnership(): keyed on tokenId AND price,
  // because a token re-entered at a different price is a different order, not the same one.
  const outcome = withTempDataDir((dir) => {
    record(dir, { portfolioId: "live-custom-dip704060live", tokenId: "777", price: 0.5, at: "2026-09-27T10:00:00.000Z" });
    return record(dir, { portfolioId: "live-custom-dip704060live", tokenId: "777", price: 0.62, at: "2026-09-27T11:00:00.000Z" });
  });
  assert.equal(outcome.ledger.records.length, 2);
});

test("a missing or unparsable timestamp is not fatal -- the record still lands, timestamped now", () => {
  const outcome = withTempDataDir((dir) => record(dir, { portfolioId: "live-custom-dip704060live", tokenId: "1", price: 0.5 }));
  assert.equal(outcome.result.ok, true);
  assert.ok(outcome.ledger.records[0].at, "some timestamp was written");
});

test("the endpoint requires the trigger key, same as the paper dip-entry recorder beside it", () => {
  assert.match(API, /if \(\$action === 'live-dip-entry-ownership'\) \{\s*\n\s*require_trading_trigger_key\(\);/);
});

test("the write is capped the same way live-order-executor.mjs bounds its own copy", () => {
  const executor = readFileSync(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8");
  assert.match(executor, /const ORDER_OWNERSHIP_LIMIT = 4000;/);
  assert.match(API, /const LIVE_DIP_ENTRY_OWNERSHIP_LIMIT = 4000;/);
});
