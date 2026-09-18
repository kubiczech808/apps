// Runs offline: storage.php's real function is EXECUTED against a stub PDO that answers the
// information_schema query with a schema the size of the one on the hosting. No database, no
// network, no credentials.
//
// Asked, with the hosting panel showing 1785 MB of a 2000 MB quota: "nase mysql databaze nema
// tolik dat, ale jeji velikost je neumerne vysoka a hrozi problemy s uctovanim na hostingu
// ... nemame tam miliony zaznamu, takze myslim, ze je spis chyba v datech nez v mnozstvi."
//
// The function that existed before this one, trading_storage_table_stats, lists four tables by
// name. On a schema shared with another application that reads as "Trading is 300 MB" beside a
// quota that is full, with nothing named as the difference -- which is exactly the shape of a
// measurement that ends an investigation without answering it. So the two things this must get
// right are: every table in the schema appears, and free space is counted where the hosting
// counts it, inside the total.

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STORAGE = readFileSync(new URL("../storage.php", import.meta.url), "utf8");

// The function, lifted with nothing else: it takes a PDO and returns an array, so a stub that
// answers query() is the whole environment it needs.
function extractPhpFunction(source, name) {
  const start = source.indexOf(`function ${name}(PDO $pdo): array`);
  assert.ok(start > 0, `${name} must exist in storage.php`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, `${name} must be a complete function`);
  return source.slice(start, end + 2);
}

// The PDO type hint is relaxed and NOTHING else is touched: pdo_mysql is loaded here, so the
// real PDO cannot be replaced by a stub of the same name, and PDO::query's signature cannot be
// overridden compatibly by anything that returns a fake statement. Relaxing the hint on the
// signature line leaves the body byte-for-byte the code that runs on the hosting.
const FOOTPRINT = extractPhpFunction(STORAGE, "trading_storage_schema_footprint")
  .replace("function trading_storage_schema_footprint(PDO $pdo): array",
    "function trading_storage_schema_footprint($pdo): array");
assert.doesNotMatch(FOOTPRINT, /\bPDO\b/, "only the type hint may differ from the deployed body");

function runFootprint(rows) {
  const dir = mkdtempSync(join(tmpdir(), "schema-footprint-"));
  const script = join(dir, "run.php");
  writeFileSync(script, `<?php
${FOOTPRINT}

class StubStatement {
    public function __construct(private array $rows) {}
    public function fetchAll(): array { return $this->rows; }
}

class StubPdo {
    public array $queries = [];
    public function __construct(private array $rows) {}
    public function query(string $sql): StubStatement {
        $this->queries[] = $sql;
        return new StubStatement($this->rows);
    }
}

$pdo = new StubPdo(json_decode(${JSON.stringify(JSON.stringify(rows))}, true));
$result = trading_storage_schema_footprint($pdo);
$result['sql'] = $pdo->queries[0] ?? '';
echo json_encode($result);
`);
  const out = execFileSync("php", [script], { encoding: "utf8" });
  return JSON.parse(out);
}

const mb = (value) => Math.round(value * 1048576);

// Shaped like the hosting: the four Trading tables plus a neighbour that was never suspected,
// because nothing that ran before this could see it.
const SCHEMA = [
  { table_name: "wp_options", engine: "InnoDB", table_rows: 3100, data_length: mb(40), index_length: mb(4), data_free: mb(900) },
  { table_name: "trading_event_log", engine: "InnoDB", table_rows: 21315, data_length: mb(222), index_length: mb(18), data_free: mb(60) },
  { table_name: "trading_observations", engine: "InnoDB", table_rows: 40120, data_length: mb(180), index_length: mb(30), data_free: mb(12) },
  { table_name: "trading_documents", engine: "InnoDB", table_rows: 96, data_length: mb(60), index_length: mb(1), data_free: mb(8) },
  { table_name: "trading_storage_meta", engine: "InnoDB", table_rows: 9, data_length: mb(0.02), index_length: mb(0.02), data_free: mb(0) },
];

test("every table in the schema is listed, not only the Trading ones", () => {
  const result = runFootprint(SCHEMA);
  const names = result.tables.map((row) => row.table);
  assert.equal(result.tableCount, 5);
  assert.ok(names.includes("wp_options"),
    "a neighbour holding a gigabyte must appear, or the quota has no explanation");

  // And the query is not filtered to a name list -- the point of this function over the one
  // beside it. IN (?, ?, ?, ?) here would pass every assertion above on a fixture and find
  // nothing on the hosting.
  assert.match(result.sql, /table_schema = DATABASE\(\)/);
  assert.doesNotMatch(result.sql, /table_name IN/);
  // Read-only, and provably so: this is the whole statement the function runs.
  assert.match(result.sql, /^\s*SELECT/);
  assert.doesNotMatch(result.sql, /DELETE|UPDATE|ALTER|OPTIMIZE|DROP|INSERT/i);
});

test("free space is charged to the total, because the hosting charges for it", () => {
  const result = runFootprint(SCHEMA);
  const neighbour = result.tables.find((row) => row.table === "wp_options");
  assert.equal(neighbour.totalBytes, mb(40) + mb(4) + mb(900),
    "944 MB of quota, of which 900 MB holds no row at all");
  assert.equal(result.totals.freeBytes, mb(900) + mb(60) + mb(12) + mb(8));
  assert.equal(result.totals.totalBytes,
    result.totals.dataBytes + result.totals.indexBytes + result.totals.freeBytes);

  // Bait: the same totals computed the way the existing tradingSizeBytes does, without free
  // space. If the function ever drops data_free from the total this equality holds and the
  // test above still passes on the per-table number alone.
  assert.notEqual(result.totals.totalBytes, result.totals.dataBytes + result.totals.indexBytes,
    "a total that ignores free space understates this schema by nearly a gigabyte");
});

test("largest first, so the first row is the one worth acting on", () => {
  const result = runFootprint(SCHEMA);
  // The ordering is the database's, so what is asserted is that it is ASKED for -- a fixture
  // returned in order would otherwise pass with no ORDER BY in the SQL at all.
  assert.match(result.sql, /ORDER BY \(data_length \+ index_length \+ data_free\) DESC/);
  assert.equal(result.tables[0].table, "wp_options");
});

test("Trading's own share is separated from the schema's", () => {
  const result = runFootprint(SCHEMA);
  assert.equal(result.tradingTotals.totalBytes,
    mb(222) + mb(18) + mb(60) + mb(180) + mb(30) + mb(12) + mb(60) + mb(1) + mb(8) + mb(0.02) + mb(0.02),
    "the four trading_ tables and nothing else");
  assert.ok(result.tradingTotals.totalBytes < result.totals.totalBytes,
    "and it is a share, not the whole");
  assert.equal(result.tables.filter((row) => row.trading).length, 4);
  assert.equal(result.tables.find((row) => row.table === "wp_options").trading, false,
    "a neighbour is never marked as ours: this flag is what decides what may be rebuilt");
});

test("a table name that merely contains 'trading_' is not ours", () => {
  // Bait for the obvious wrong implementation, str_contains. A neighbour's table called
  // something_trading_log would be counted into our share and, worse, offered up as ours to
  // rebuild.
  const result = runFootprint([
    { table_name: "wp_trading_archive", engine: "InnoDB", table_rows: 5, data_length: mb(500), index_length: 0, data_free: 0 },
    { table_name: "trading_documents", engine: "InnoDB", table_rows: 5, data_length: mb(1), index_length: 0, data_free: 0 },
  ]);
  assert.equal(result.tables.find((row) => row.table === "wp_trading_archive").trading, false);
  assert.equal(result.tradingTotals.totalBytes, mb(1));
});

test("the endpoint exists, is read-only and needs the key", () => {
  const api = readFileSync(new URL("../api.php", import.meta.url), "utf8");
  const start = api.indexOf("if ($operation === 'schema-footprint') {");
  assert.ok(start > 0, "the operation must be reachable");
  assert.match(api.slice(start, start + 320), /trading_storage_schema_footprint\(\$pdo\)/);

  // It sits inside storage-admin, which is POST-only and demands the trigger key before any
  // operation is read. Asserted rather than assumed: this reports table names from a schema
  // shared with other applications.
  const admin = api.slice(api.indexOf("if ($action === 'storage-admin') {"), start);
  assert.match(admin, /require_trading_trigger_key\(\);/);
  assert.match(admin, /REQUEST_METHOD'\] !== 'POST'/);
  assert.ok(admin.indexOf("require_trading_trigger_key();") < admin.indexOf("$operation = strtolower"),
    "the key is checked before the operation is even parsed");
});
