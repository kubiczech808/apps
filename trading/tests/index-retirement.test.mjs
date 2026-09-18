// Runs offline: trading_storage_bootstrap is lifted out of storage.php and EXECUTED against a
// stub PDO that records every statement it is given. No network, no database.
//
// What is being retired, and why it is safe. The index inventory compared column lists on the
// live database and found one index whose columns are an exact leftmost prefix of another's:
//
//   trading_observations_lifecycle_updated (lifecycle, updated_at)
//   trading_observations_scope             (lifecycle, updated_at, market_probability, end_at)
//
// A B-tree on (a, b, c, d) can serve every lookup a B-tree on (a, b) can. That is a property
// of the structure, not a claim about this application's queries, so the narrow one can go
// without reading a single call site.
//
// What makes this worth a test rather than a one-line edit: the bootstrap ADDS indexes to an
// existing table on every deploy, because CREATE TABLE IF NOT EXISTS never touches one that
// already exists. Drop the index by hand on production and the next deploy puts it straight
// back -- silently, and the space with it. The retirement therefore has to happen in the same
// place the addition did, and this checks it happens there and nowhere else.
//
// The dangerous neighbour is trading_observations_scope. Serving portfolio reads without it is
// what collapsed the host once already, so a change that retires one index must be shown NOT
// to have retired the other.

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STORAGE = readFileSync(new URL("../storage.php", import.meta.url), "utf8");

function extractPhpFunction(signature) {
  const start = STORAGE.indexOf(signature);
  assert.ok(start > 0, `${signature} must exist in storage.php`);
  const end = STORAGE.indexOf("\n}\n", start);
  assert.ok(end > start, "the function must be complete");
  return STORAGE.slice(start, end + 2).replace("(PDO $pdo", "($pdo");
}

// The bootstrap creates the tables; the schema optimiser reconciles the indexes on tables that
// already exist. Both are lifted, because the retirement only works if the two agree -- the
// point of the test is that one does not undo the other.
const BOOTSTRAP = [
  extractPhpFunction("function trading_storage_bootstrap(PDO $pdo): void"),
  extractPhpFunction("function trading_storage_optimize_schema(PDO $pdo): void"),
].join("\n");

// `present` lists the indexes the stub database already has. Everything the bootstrap issues
// is recorded, so the test reads what it actually did instead of what the source looks like.
function bootstrap(present) {
  const dir = mkdtempSync(join(tmpdir(), "index-retirement-"));
  const script = join(dir, "run.php");
  writeFileSync(script, `<?php
class StubStatement {
    public array $bound = [];
    public function __construct(private string $sql, private StubPdo $pdo) {}
    public function execute(array $params = []): bool { $this->bound = $params; return true; }
    public function fetchColumn() {
        // Only ever asked one thing: does this index exist?
        $index = (string) ($this->bound['index'] ?? '');
        return $this->pdo->hasIndex($index) ? 1 : false;
    }
    public function fetchAll(): array { return []; }
    public function fetch() { return false; }
}

class StubPdo {
    public array $executed = [];
    public function __construct(private array $present) {}
    // A dropped index is gone. Without this the add loop, which runs after the drop loop, sees
    // the index it just removed still standing and skips the ADD -- so a bootstrap that drops
    // and recreates the same index every deploy would look correct here.
    public function hasIndex(string $index): bool { return in_array($index, $this->present, true); }
    public function exec(string $sql) {
        $this->executed[] = $sql;
        if (preg_match('/DROP INDEX .(\\w+)./', $sql, $match)) {
            $this->present = array_values(array_diff($this->present, [$match[1]]));
        }
        if (preg_match('/ADD INDEX .(\\w+)./', $sql, $match)) {
            $this->present[] = $match[1];
        }
        return 0;
    }
    public function query(string $sql) { $this->executed[] = $sql; return new StubStatement($sql, $this); }
    public function prepare(string $sql) { return new StubStatement($sql, $this); }
}

${BOOTSTRAP}

$pdo = new StubPdo(json_decode(${JSON.stringify(JSON.stringify(present))}, true));
trading_storage_bootstrap($pdo);
echo json_encode($pdo->executed);
`);
  try {
    return { ok: true, statements: JSON.parse(execFileSync("php", [script], { encoding: "utf8" })) };
  } catch (error) {
    return { ok: false, error: String(error.stderr || error.message).slice(0, 400) };
  }
}

const NARROW = "trading_observations_lifecycle_updated";
const WIDE = "trading_observations_scope";

const dropsOf = (statements) => statements
  .filter((sql) => sql.includes("DROP INDEX"))
  .map((sql) => /DROP INDEX `([^`]+)`/.exec(sql)?.[1])
  .filter(Boolean);
const addsOf = (statements) => statements
  .filter((sql) => sql.includes("ADD INDEX"))
  .map((sql) => /ADD INDEX `([^`]+)`/.exec(sql)?.[1])
  .filter(Boolean);

test("a database that still carries the narrow index has it dropped", () => {
  const result = bootstrap([NARROW, WIDE]);
  assert.equal(result.ok, true, result.error || "");
  assert.ok(dropsOf(result.statements).includes(NARROW),
    `production carries it today, so the deploy must drop it: ${dropsOf(result.statements).join(", ")}`);
});

test("and does not put it straight back", () => {
  // The failure this whole test exists for. The bootstrap's add loop runs after its drop loop,
  // so an index named in both lists is dropped and recreated on every single deploy -- a
  // rebuild of a 226,000-row index, twice a day, returning nothing.
  const result = bootstrap([NARROW, WIDE]);
  assert.ok(!addsOf(result.statements).includes(NARROW),
    `it must not be re-added in the same run: ${addsOf(result.statements).join(", ")}`);
});

test("the wide index it defers to is kept, and created where it is missing", () => {
  // Serving portfolio reads without trading_observations_scope is what made the host collapse.
  // Retiring the prefix is only safe because this one stays.
  const carried = bootstrap([NARROW, WIDE]);
  assert.ok(!dropsOf(carried.statements).includes(WIDE),
    "the wide index must never be dropped");

  const missing = bootstrap([NARROW]);
  assert.ok(addsOf(missing.statements).includes(WIDE),
    "and must still be created on a database that lacks it");
});

test("a database that never had it is left alone", () => {
  const result = bootstrap([WIDE]);
  assert.ok(!dropsOf(result.statements).includes(NARROW),
    "nothing to drop means no statement is issued");
  assert.ok(!addsOf(result.statements).includes(NARROW),
    "and it is not introduced by the deploy either");
});

test("a fresh database is not created with it", () => {
  // CREATE TABLE and the retirement list are two different places, and leaving the index in
  // the first means every new database builds it and then immediately throws it away.
  const create = STORAGE.slice(STORAGE.indexOf("CREATE TABLE IF NOT EXISTS trading_observations"));
  const body = create.slice(0, create.indexOf("ENGINE=InnoDB"));
  assert.ok(!body.includes(NARROW), `the schema must not declare it: ${body.match(/KEY [a-z_]+/g)}`);
  assert.ok(body.includes(WIDE), "while the wide index stays declared");
  assert.ok(body.includes("trading_observations_lifecycle_end"),
    "and so does (lifecycle, end_at), which is a prefix of nothing");
});

test("BAIT: no other index is a leftmost prefix of another on the same table", () => {
  // The rule that justified this retirement, applied to the whole schema rather than to the
  // one index that prompted it. If a future change adds another prefix pair, this says so
  // here instead of leaving it to be found by another 815 MB.
  const pattern = /KEY (\w+) \(([^)]*)\)/g;
  const perTable = new Map();
  for (const table of STORAGE.split("CREATE TABLE IF NOT EXISTS ").slice(1)) {
    const name = /^(\w+)/.exec(table)?.[1];
    const schema = table.slice(0, table.indexOf("ENGINE=InnoDB"));
    if (!name || schema.length === 0) continue;
    const keys = [...schema.matchAll(pattern)]
      .map(([, index, columns]) => ({ index, columns: columns.split(",").map((part) => part.trim()) }));
    if (keys.length) perTable.set(name, keys);
  }
  assert.ok(perTable.size >= 3, "the schema must have been parsed, not silently missed");

  for (const [table, keys] of perTable) {
    for (const narrow of keys) {
      for (const wide of keys) {
        if (narrow.index === wide.index || wide.columns.length <= narrow.columns.length) continue;
        const prefix = wide.columns.slice(0, narrow.columns.length).join(",") === narrow.columns.join(",");
        assert.ok(!prefix,
          `${table}.${narrow.index} is a leftmost prefix of ${wide.index} and buys nothing`);
      }
    }
  }
});
