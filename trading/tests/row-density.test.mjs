// Runs offline: trading_storage_row_density is lifted out of storage.php and EXECUTED against
// a stub PDO whose information_schema answers are fixed, so the arithmetic is checked rather
// than described. No network, no database.
//
// Why this measurement exists. The footprint says trading_observations costs 2,720 bytes of
// data per row. The payload anatomy says the packed payload is 1,061 of them. Nothing named
// the other 1,659, and DATA_FREE -- the only fragmentation number information_schema has --
// reported 4%, which made "the table is fragmented" look already ruled out. It is not:
// DATA_FREE counts whole free extents and is blind to space wasted inside a page, which is
// where an InnoDB table that has been inserted into and updated for months puts it.
//
// The number this produces decides a production action (rebuild the table, or do not), so the
// two ways of getting it wrong both have to fail here:
//
//   overstating the content  -> the ratio drops to ~1 and a real 300 MB of empty space is
//                               written off as unavoidable
//   understating the content -> the ratio climbs and a rebuild is promised that returns little
//
// Both are baited below.

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
  // pdo_mysql is loaded here, so the real PDO class cannot be shadowed by a stub; the hint is
  // relaxed and the stub is passed in its place. Nothing else about the body is touched.
  return STORAGE.slice(start, end + 2).replace("(PDO $pdo", "($pdo");
}

const FUNCTION = extractPhpFunction("function trading_storage_row_density(PDO $pdo): array");

// One observations-shaped table, declared exactly as storage.php declares it, so the column
// types under test are the real ones.
const OBSERVATION_COLUMNS = [
  ["observation_key", "char", "NO", null, null, null, 256],
  ["lifecycle", "varchar", "NO", null, null, null, 96],
  ["source_id", "varchar", "YES", null, null, null, 764],
  ["token_id", "varchar", "YES", null, null, null, 764],
  ["event_slug", "varchar", "YES", null, null, null, 764],
  ["market_slug", "varchar", "YES", null, null, null, 764],
  ["outcome_label", "varchar", "YES", null, null, null, 764],
  ["market_type", "varchar", "YES", null, null, null, 64],
  ["end_at", "datetime", "YES", null, null, 0, null],
  ["observed_at", "datetime", "YES", null, null, 0, null],
  ["resolved_at", "datetime", "YES", null, null, 0, null],
  ["market_probability", "decimal", "YES", 12, 9, null, null],
  ["net_yield", "decimal", "YES", 18, 9, null, null],
  ["annualized_return", "decimal", "YES", 24, 9, null, null],
  ["volume_usdc", "decimal", "YES", 24, 6, null, null],
  ["tags_json", "longtext", "YES", null, null, null, 4294967295],
  ["payload", "mediumblob", "NO", null, null, null, 16777215],
  ["payload_checksum", "char", "NO", null, null, null, 256],
  ["created_at", "datetime", "NO", null, null, 6, null],
  ["updated_at", "datetime", "NO", null, null, 6, null],
];

function columnRows(table, columns) {
  return columns.map(([name, type, nullable, precision, scale, datetimePrecision, octets]) => ({
    TABLE_NAME: table,
    COLUMN_NAME: name,
    DATA_TYPE: type,
    IS_NULLABLE: nullable,
    NUMERIC_PRECISION: precision,
    NUMERIC_SCALE: scale,
    DATETIME_PRECISION: datetimePrecision,
    CHARACTER_OCTET_LENGTH: octets,
  }));
}

// The stub answers three shapes of query: the COLUMNS catalogue, the TABLES sizes, and the
// per-table aggregate the function builds. The aggregate is the interesting one -- the SQL
// text it generates is captured so the test can read what was actually asked.
function run({ columns, sizes, aggregates }) {
  const dir = mkdtempSync(join(tmpdir(), "row-density-"));
  const script = join(dir, "run.php");
  writeFileSync(script, `<?php
function trading_storage_bootstrap($pdo) {}

class StubStatement {
    public function __construct(private array $rows) {}
    public function fetchAll(): array { return $this->rows; }
    public function fetch() { return $this->rows[0] ?? false; }
}

class StubPdo {
    public array $queries = [];
    public function __construct(private array $columns, private array $sizes, private array $aggregates) {}
    public function query(string $sql) {
        $this->queries[] = $sql;
        if (str_contains($sql, 'information_schema.COLUMNS')) {
            return new StubStatement($this->columns);
        }
        if (str_contains($sql, 'information_schema.TABLES')) {
            return new StubStatement($this->sizes);
        }
        foreach ($this->aggregates as $table => $row) {
            if (str_contains($sql, '\`' . $table . '\`')) {
                return new StubStatement([$row]);
            }
        }
        throw new RuntimeException('unexpected query: ' . $sql);
    }
}

${FUNCTION}

$pdo = new StubPdo(
    ${JSON.stringify(JSON.stringify(columns))} ? json_decode(${JSON.stringify(JSON.stringify(columns))}, true) : [],
    json_decode(${JSON.stringify(JSON.stringify(sizes))}, true),
    json_decode(${JSON.stringify(JSON.stringify(aggregates))}, true)
);
echo json_encode(['report' => trading_storage_row_density($pdo), 'queries' => $pdo->queries]);
`);
  try {
    return { ok: true, ...JSON.parse(execFileSync("php", [script], { encoding: "utf8" })) };
  } catch (error) {
    return { ok: false, error: String(error.stderr || error.message).slice(0, 400) };
  }
}

const ROWS = 192225;

// The production shape: 192,225 rows charged 522.7 MB of data, whose variable-length columns
// (payload, tags_json, the slugs, the two CHAR(64) hashes) add up to 1,400 bytes each.
function productionRun({ variablePerRow = 1400, dataBytes = 548_000_000, freeBytes = 5_242_880 } = {}) {
  return run({
    columns: columnRows("trading_observations", OBSERVATION_COLUMNS),
    sizes: [{
      TABLE_NAME: "trading_observations",
      TABLE_ROWS: ROWS,
      DATA_LENGTH: dataBytes,
      INDEX_LENGTH: 97_000_000,
      DATA_FREE: freeBytes,
    }],
    aggregates: { trading_observations: { c: ROWS, b: variablePerRow * ROWS } },
  });
}

test("a datetime counts as its stored bytes, not the 19 characters of its text form", () => {
  // The bait for overstating content. LENGTH('2026-09-18 10:17:56.000000') is 26; the column
  // occupies 8. Five datetimes measured the wrong way would add ~80 bytes of invented content
  // per row -- 15 MB across the table -- all of it subtracted from the reclaim figure.
  const result = productionRun();
  assert.equal(result.ok, true, result.error || "");
  const table = result.report.tables[0];

  // Three DATETIME (5 each) + two DATETIME(6) (5 + 3 each) = 31.
  // DECIMAL(12,9): 3 whole digits -> 2, 9 fraction -> 4. = 6
  // DECIMAL(18,9): 9 -> 4, 9 -> 4. = 8
  // DECIMAL(24,9): 15 -> 4+3 = 7, 9 -> 4. = 11
  // DECIMAL(24,6): 18 -> 4+4 = 8, 6 -> 3. = 11
  assert.equal(table.fixedBytesPerRow, 31 + 6 + 8 + 11 + 11,
    "the fixed-width columns must be sized from their declared types");

  const aggregate = result.queries.find((sql) => sql.includes("FROM `trading_observations`"));
  assert.ok(aggregate, "the variable-length columns must be measured with one aggregate");
  for (const fixed of ["end_at", "created_at", "market_probability", "volume_usdc"]) {
    assert.ok(!aggregate.includes(`\`${fixed}\``),
      `${fixed} is fixed-width and must not be scanned with LENGTH(): ${aggregate}`);
  }
  for (const variable of ["payload", "tags_json", "market_slug", "observation_key"]) {
    assert.ok(aggregate.includes(`LENGTH(\`${variable}\`)`),
      `${variable} varies per row and must be measured, not assumed: ${aggregate}`);
  }
});

test("the length prefix of a variable-length column is counted", () => {
  const result = productionRun();
  const aggregate = result.queries.find((sql) => sql.includes("FROM `trading_observations`"));
  // MEDIUMBLOB carries a 3-byte length, LONGTEXT 4, a VARCHAR wider than 255 octets 2, and a
  // short one 1. 192,225 rows x a handful of bytes is single-digit MB -- small, but it is the
  // difference between an estimate and a guess.
  assert.match(aggregate, /LENGTH\(`payload`\), 0\) \+ 3/);
  assert.match(aggregate, /LENGTH\(`tags_json`\), 0\) \+ 4/);
  assert.match(aggregate, /LENGTH\(`market_slug`\), 0\) \+ 2/);
  assert.match(aggregate, /LENGTH\(`market_type`\), 0\) \+ 1/);
});

test("a half-empty table is reported as half empty, and the reclaim follows the gap", () => {
  const result = productionRun();
  const table = result.report.tables[0];

  // 1,400 variable + 67 fixed + 18 record overhead (5 + 6 + 7, NULL bitmap of 13 nullable
  // columns = 2) = 1,485 bytes of content per row.
  assert.equal(table.logicalBytesPerRow, 1400 + 67 + 5 + 6 + 7 + 2);
  assert.equal(table.physicalBytesPerRow, Math.round((548_000_000 / ROWS) * 10) / 10);
  assert.ok(table.overheadRatio > 1.8 && table.overheadRatio < 2.0,
    `the production numbers must land near 2x, not somewhere else: ${table.overheadRatio}`);

  // What a rebuild would leave, and what that returns. The free extents are added on top
  // because they sit outside DATA_LENGTH and come back from the same operation.
  //
  // The fill factor was 15/16 here until three rebuilds were actually run, and none of them
  // reached it: documents packed exactly (overflow pages), trades reached 77%, and the event
  // log 69% -- where it already was, so its rebuild moved 0.1 MB of data and returned only the
  // 5 MB of free extents against a predicted 24 MB. The worst of the three is what the estimate
  // now uses, because it decides whether a rebuild may start against a shared quota, and
  // under-promising costs a dispatch while over-promising costs the disk.
  assert.equal(result.report.rebuiltFill, 0.69,
    "the fill factor must be the worst measured one, not the documented 15/16");
  assert.equal(table.estimatedRebuiltBytes, Math.round(table.logicalBytes / result.report.rebuiltFill));
  assert.equal(table.estimatedReclaimBytes,
    548_000_000 - table.estimatedRebuiltBytes + 5_242_880);
  assert.ok(table.estimatedReclaimBytes > 90_000_000,
    `a 2x table must promise a real reclaim: ${table.estimatedReclaimBytes}`);
});

test("BAIT: a densely packed table must promise nothing", () => {
  // The bait for the arithmetic running backwards. If the ratio or the subtraction were
  // inverted, a table already packed tight would be reported as reclaimable and a rebuild
  // would be run on production for nothing.
  //
  // Note what "packed tight" is worth in this ratio. A well-packed table does not read as
  // 1.00x: at the measured 69% fill it reads as 1.45x. trading_event_log measured exactly
  // 1.45x and its rebuild moved 0.1 MB, which is the proof. So 1.55x on trading_observations
  // is not "half the table is empty" -- it is 1.07x off the best a rebuild can reach, and the
  // reclaim figure is the only honest reading of the ratio.
  const result = productionRun({ dataBytes: Math.round(1485 * ROWS / 0.69), freeBytes: 0 });
  const table = result.report.tables[0];
  assert.ok(table.overheadRatio > 1.40 && table.overheadRatio < 1.50,
    `a rebuilt table sits at 1/0.69, not at 1.0: ${table.overheadRatio}`);
  assert.equal(table.estimatedReclaimBytes, 0,
    "and a table already at that density must promise no reclaim");
});

test("BAIT: content the columns do carry must not be sold as empty space", () => {
  // The other direction. A table whose rows really are 2,700 bytes of content is NOT
  // reclaimable, however large it is, and the only honest answer is that rows have to go.
  const result = productionRun({ variablePerRow: 2650 });
  const table = result.report.tables[0];
  assert.ok(table.overheadRatio < 1.07,
    `content-heavy rows must not read as slack: ${table.overheadRatio}`);
  // Only the free extents, which a rebuild does return -- and nothing from the pages, because
  // there is nothing in them to return.
  assert.equal(table.estimatedReclaimBytes, 5_242_880,
    `no page slack may be promised: ${table.estimatedReclaimBytes}`);
});

test("an empty table divides by nothing and reports nothing", () => {
  const result = run({
    columns: columnRows("trading_storage_meta", [
      ["meta_key", "varchar", "NO", null, null, null, 764],
      ["meta_value", "longtext", "YES", null, null, null, 4294967295],
    ]),
    sizes: [{ TABLE_NAME: "trading_storage_meta", TABLE_ROWS: 0, DATA_LENGTH: 16384, DATA_FREE: 0 }],
    aggregates: { trading_storage_meta: { c: 0, b: 0 } },
  });
  assert.equal(result.ok, true, result.error || "");
  const table = result.report.tables[0];
  assert.equal(table.rows, 0);
  assert.equal(table.physicalBytesPerRow, 0);
  assert.equal(table.overheadRatio, null, "no rows means no ratio, not a ratio of zero");
  assert.equal(table.estimatedReclaimBytes, 0);
});

test("the secondary indexes are carried through", () => {
  // A rebuild writes them again too, and whatever sizes the rebuild has to add them to the
  // clustered index. Leaving this out under-estimated trading_trades' copy by a third.
  const result = productionRun();
  assert.equal(result.report.tables[0].indexBytes, 97_000_000,
    "the index size must reach the caller, not be dropped on the floor");
});

test("every Trading table is measured, largest first", () => {
  const result = run({
    columns: [
      ...columnRows("trading_observations", OBSERVATION_COLUMNS),
      ...columnRows("trading_trades", [
        ["trade_key", "char", "NO", null, null, null, 256],
        ["payload", "mediumblob", "NO", null, null, null, 16777215],
      ]),
    ],
    sizes: [
      { TABLE_NAME: "trading_observations", TABLE_ROWS: ROWS, DATA_LENGTH: 548_000_000, DATA_FREE: 0 },
      { TABLE_NAME: "trading_trades", TABLE_ROWS: 8395, DATA_LENGTH: 45_900_000, DATA_FREE: 4_194_304 },
    ],
    aggregates: {
      trading_observations: { c: ROWS, b: 1400 * ROWS },
      trading_trades: { c: 8395, b: 2600 * 8395 },
    },
  });
  assert.deepEqual(result.report.tables.map((entry) => entry.table),
    ["trading_observations", "trading_trades"]);
  assert.equal(result.report.totalReclaimBytes,
    result.report.tables.reduce((sum, entry) => sum + entry.estimatedReclaimBytes, 0));
});

test("it stays read-only", () => {
  const source = STORAGE.slice(STORAGE.indexOf("function trading_storage_row_density"));
  const body = source.slice(0, source.indexOf("\n}\n"));
  for (const write of ["INSERT", "UPDATE", "DELETE", "ALTER", "DROP", "OPTIMIZE", "->exec("]) {
    assert.ok(!body.includes(write),
      `a measurement must not ${write} -- the rebuild is a decision for the operator`);
  }
});
