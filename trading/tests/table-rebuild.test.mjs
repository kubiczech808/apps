// Runs offline: trading_storage_rebuild_compacted_table is lifted out of storage.php and
// EXECUTED against a stub PDO. No network, no database.
//
// The table name reaches DDL by string interpolation, so the whitelist is the only thing
// standing between a request body and `OPTIMIZE TABLE <whatever the caller sent>`. It was
// widened here -- rebuilding is not payload compaction and every Trading table can be
// repacked, while only three of them have a payload column to rewrite -- and widening a
// whitelist is exactly the kind of change that quietly turns into no whitelist at all.

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STORAGE = readFileSync(new URL("../storage.php", import.meta.url), "utf8");
const start = STORAGE.indexOf("function trading_storage_rebuild_compacted_table(PDO $pdo, string $table): array");
assert.ok(start > 0, "the rebuild must exist in storage.php");
const FUNCTION = STORAGE.slice(start, STORAGE.indexOf("\n}\n", start) + 2).replace("(PDO $pdo", "($pdo");

function rebuild(table) {
  const dir = mkdtempSync(join(tmpdir(), "table-rebuild-"));
  const script = join(dir, "run.php");
  writeFileSync(script, `<?php
function trading_storage_bootstrap($pdo) {}
function trading_storage_table_stats($pdo) { return ['stats' => true]; }

class StubStatement { public function fetchAll(): array { return []; } }
class StubPdo {
    public array $executed = [];
    public function query(string $sql) { $this->executed[] = $sql; return new StubStatement(); }
}

${FUNCTION}

$pdo = new StubPdo();
$error = null;
try {
    trading_storage_rebuild_compacted_table($pdo, ${JSON.stringify(table)});
} catch (Throwable $throwable) {
    $error = $throwable->getMessage();
}
echo json_encode(['error' => $error, 'executed' => $pdo->executed]);
`);
  return JSON.parse(execFileSync("php", [script], { encoding: "utf8" }));
}

const ALLOWED = ["trading_observations", "trading_event_log", "trading_trades",
  "trading_documents", "trading_storage_meta"];

test("every Trading table can be repacked, and is repacked by name", () => {
  for (const table of ALLOWED) {
    const result = rebuild(table);
    assert.equal(result.error, null, `${table} must be accepted: ${result.error}`);
    assert.deepEqual(result.executed, [`OPTIMIZE TABLE \`${table}\``],
      `${table} must produce exactly one statement, against itself`);
  }
});

test("the list matches what the workflow offers", () => {
  // A choice the operator can pick and the endpoint then refuses is a dispatch spent on an
  // error message, and this has already happened once with the payload-compaction list.
  const workflow = readFileSync(new URL("../../.github/workflows/trading-storage-rebuild.yml", import.meta.url), "utf8");
  const options = [...workflow.matchAll(/^ {10}- (trading_\w+)$/gm)].map(([, name]) => name);
  assert.ok(options.length >= 4, `the workflow must offer tables: ${options.join(", ")}`);
  for (const option of options) {
    assert.ok(ALLOWED.includes(option), `${option} is offered but would be refused`);
  }
});

test("BAIT: anything not on the list is refused, and nothing is issued", () => {
  for (const table of [
    "users",
    "trading_observations_backup",
    "trading_trades`; DROP TABLE trading_trades; --",
    "trading_trades` , `trading_observations",
    "",
    "TRADING_TRADES",
  ]) {
    const result = rebuild(table);
    assert.match(String(result.error), /Unknown Trading storage table/,
      `${JSON.stringify(table)} must be refused`);
    assert.deepEqual(result.executed, [],
      `${JSON.stringify(table)} must reach no statement at all`);
  }
});

test("it repacks and does not delete", () => {
  const body = FUNCTION;
  for (const destructive of ["DELETE", "TRUNCATE", "DROP TABLE", "INSERT", "UPDATE"]) {
    assert.ok(!body.includes(destructive),
      `a rebuild must not ${destructive}: the rows are written again, not changed`);
  }
  assert.ok(body.includes("OPTIMIZE TABLE"), "and it must actually repack");
});
