// Runs offline: the real accumulator from api.php and the real store/load pair from
// storage.php are EXECUTED against a generated archive and an in-memory stand-in for the
// table. No network, no database.
//
// What this is for. trading_observations holds 226,262 rows, 90,795 of them settled, and the
// hosting reports 1,844 MB of 2,000 MB used across a shared quota -- so the table cannot even
// be repacked, let alone grow. The settled rows are only read to answer one page, and that
// page is a running total over a few tens of thousands of cells. Store the cells and the rows
// have no reader left.
//
// The order is the part that has been got wrong before. Archiving observations out of MySQL
// was added and reverted the same day (ca6b7de -> e812214) because the read path still needed
// the rows. So the thing that has to be proven first, and is proven here, is that the stored
// cells answer identically to the archive -- not approximately, identically.

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API = readFileSync(new URL("../api.php", import.meta.url), "utf8");
const STORAGE = readFileSync(new URL("../storage.php", import.meta.url), "utf8");

function lift(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start > 0, `${signature} must exist`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, `${signature} must be complete`);
  return source.slice(start, end + 2).replace("(PDO $pdo", "($pdo");
}

const PIECES = [
  lift(API, "function stream_json_array_members(string $path, string $field, callable $onRow, ?callable $accepts = null): bool"),
  lift(API, "function resolved_stats_accumulate(array $sources, float $stake = 5.0): array"),
  lift(STORAGE, "function trading_storage_resolved_stats_replace(PDO $pdo, array $cells, array $anyTag, array $meta = []): array"),
  lift(STORAGE, "function trading_storage_resolved_stats_load(PDO $pdo): ?array"),
].join("\n");

// The row shape the accumulator reads, written to disk the way the archive is: streamed, not
// held, because the reader must never have the whole file in memory.
function writeArchive(path, rows) {
  const parts = ['{"resolvedMarketObservations":['];
  rows.forEach((row, index) => {
    parts.push(`${index ? "," : ""}${JSON.stringify(row)}`);
  });
  parts.push("]}");
  writeFileSync(path, parts.join(""));
}

function run(rows, { skipStore = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "resolved-stats-"));
  const archive = join(dir, "archive.json");
  writeArchive(archive, rows);

  const script = join(dir, "run.php");
  writeFileSync(script, `<?php
// The helpers the accumulator leans on, kept deliberately simple and explicit so the test is
// reading the accumulator's arithmetic rather than theirs.
function simulation_entry_probability(array $item) { return $item['firstMarketProbability'] ?? null; }
function observation_entry_spread_is_tradable(array $item): bool { return ($item['tradable'] ?? true) === true; }
function observation_market_shape(array $item): string { return (string) ($item['shape'] ?? 'binary'); }
function resolved_horizon_band(array $item): string { return (string) ($item['horizon'] ?? '0-2d'); }
function simulation_taxonomy_labels(array $item, string $first, string $second): array {
    return array_values($item[$first] ?? $item[$second] ?? []);
}
function trading_storage_bootstrap($pdo) {}
function trading_storage_now(): string { return '2026-09-18 11:00:00.000000'; }

// The table and the meta row, in memory. Every statement the store issues goes through here,
// so a store that forgot its transaction or its DELETE shows up as rows that should be gone.
class StubStatement {
    public function __construct(private StubPdo $pdo, private string $sql) {}
    public function execute(array $params = []): bool {
        // Logged here, not in prepare(): a prepared statement reused across batches is one
        // prepare and many executes, and it is the executes that cost the round trips. The
        // first version of this only logged query() and exec(), so the batching assertion
        // counted zero statements and passed however the insert was written.
        $this->pdo->log[] = $this->sql;
        $this->pdo->record($this->sql, $params);
        return true;
    }
    public function fetchAll(): array { return array_values($this->pdo->rows); }
    public function fetch() { return false; }
    public function fetchColumn() { return false; }
}

class StubPdo {
    public array $rows = [];
    public array $meta = [];
    public bool $inTransaction = false;
    public array $log = [];
    public function beginTransaction(): bool { $this->inTransaction = true; $this->log[] = 'BEGIN'; return true; }
    public function commit(): bool { $this->inTransaction = false; $this->log[] = 'COMMIT'; return true; }
    public function rollBack(): bool { $this->inTransaction = false; $this->log[] = 'ROLLBACK'; return true; }
    public function exec(string $sql) {
        $this->log[] = $sql;
        if (str_contains($sql, 'DELETE FROM trading_resolved_stats')) { $this->rows = []; }
        return 0;
    }
    public function query(string $sql) { $this->log[] = $sql; return new StubStatement($this, $sql); }
    public function prepare(string $sql) { return new StubStatement($this, $sql); }
    public function record(string $sql, array $params): void {
        if (!str_contains($sql, 'INSERT INTO trading_resolved_stats')) {
            return;
        }
        // Positional, in batches of eleven columns -- so this also fails loudly if the column
        // list and the placeholder list ever stop agreeing.
        $values = array_values($params);
        // The placeholder groups in the SQL must account for exactly the bindings handed over.
        // Without this the stub happily swallowed an insert whose column list and placeholder
        // list disagreed -- which real MySQL rejects and the test did not.
        $groups = substr_count($sql, '(?,');
        if ($groups < 1) {
            throw new RuntimeException('no placeholder groups in: ' . $sql);
        }
        $perRow = count($values) / $groups;
        if (abs($perRow - 11) > 0.0001) {
            throw new RuntimeException(
                'each row must bind 11 columns, got ' . $perRow . ' across ' . $groups . ' group(s)'
            );
        }
        $placeholders = substr_count(substr($sql, strpos($sql, 'VALUES')), '?');
        if ($placeholders !== count($values)) {
            throw new RuntimeException(
                'the SQL has ' . $placeholders . ' placeholders for ' . count($values) . ' bindings'
            );
        }
        foreach (array_chunk($values, 11) as $row) {
            $this->rows[$row[0]] = [
                'scope' => $row[1], 'probability' => $row[2],
                'tag' => $row[3], 'shape' => $row[4], 'horizon' => $row[5],
                'trades' => $row[6], 'wins' => $row[7],
                'staked_usdc' => $row[8], 'pnl_usdc' => $row[9],
            ];
        }
    }
}

function trading_storage_meta_put(string $key, string $value): void { $GLOBALS['meta'][$key] = $value; }
function trading_storage_meta_get(string $key): ?string { return $GLOBALS['meta'][$key] ?? null; }
$GLOBALS['meta'] = [];

${PIECES}

$sources = [[${JSON.stringify(archive)}, 'resolvedMarketObservations']];
$accumulated = resolved_stats_accumulate($sources);
$pdo = new StubPdo();
${skipStore ? "" : `$stored = trading_storage_resolved_stats_replace($pdo, $accumulated['cells'], $accumulated['anyTag'],
    ['scanned' => $accumulated['scanned'], 'priced' => $accumulated['priced']]);`}
$loaded = trading_storage_resolved_stats_load($pdo);

// The maps are keyed by \\x1f-joined strings, which JSON cannot round-trip readably. They are
// flattened to sorted lists so the comparison is on values, not on key encoding.
$flatten = static function (?array $map): array {
    if ($map === null) { return []; }
    $out = [];
    foreach ($map as $key => $value) { $out[] = str_replace("\\x1f", '|', (string) $key) . '=' . implode(',', $value); }
    sort($out);
    return $out;
};

echo json_encode([
    'accumulated' => ['cells' => $flatten($accumulated['cells']), 'anyTag' => $flatten($accumulated['anyTag']),
                      'scanned' => $accumulated['scanned'], 'priced' => $accumulated['priced']],
    'loaded' => $loaded === null ? null : ['cells' => $flatten($loaded['cells']), 'anyTag' => $flatten($loaded['anyTag']),
                      'scanned' => $loaded['scanned'], 'priced' => $loaded['priced'], 'foldedAt' => $loaded['foldedAt']],
    'rowCount' => count($pdo->rows),
    'log' => $pdo->log,
]);
`);
  try {
    return { ok: true, ...JSON.parse(execFileSync("php", [script], { encoding: "utf8" })) };
  } catch (error) {
    return { ok: false, error: String(error.stderr || error.message).slice(0, 600) };
  }
}

const settled = (over) => ({
  firstMarketProbability: 0.7,
  finalOutcomePrice: 1,
  shape: "binary",
  horizon: "0-2d",
  firstPolymarketTags: ["esports"],
  ...over,
});

test("what the archive computes is exactly what comes back out of the table", () => {
  const rows = [
    settled({}),
    settled({ finalOutcomePrice: 0 }),
    settled({ firstMarketProbability: 0.55, firstPolymarketTags: ["esports", "valorant"] }),
    settled({ firstMarketProbability: 0.92, shape: "outright", horizon: "3-7d", firstPolymarketTags: ["sports"] }),
    settled({ firstPolymarketTags: [] }),
  ];
  const result = run(rows);
  assert.equal(result.ok, true, result.error || "");
  assert.deepEqual(result.loaded.cells, result.accumulated.cells,
    "every tag cell must survive the round trip unchanged");
  assert.deepEqual(result.loaded.anyTag, result.accumulated.anyTag,
    "and so must every any-tag cell");
  assert.equal(result.loaded.scanned, result.accumulated.scanned);
  assert.equal(result.loaded.priced, result.accumulated.priced);
});

test("a two-tag row is two tag cells and still only one any-tag trade", () => {
  // The distinction the two maps exist for. Summing the tag cells to get an any-tag total
  // would count this row twice and inflate every threshold the page shows.
  const result = run([settled({ firstPolymarketTags: ["esports", "valorant"] })]);
  assert.equal(result.loaded.cells.length, 2, `two tags, two cells: ${result.loaded.cells}`);
  assert.equal(result.loaded.anyTag.length, 1);
  assert.match(result.loaded.anyTag[0], /=1,1,5,/, "one trade, one win, one stake");
});

test("an untagged row is filed under (untagged), not dropped and not blank", () => {
  // '' is what an any-tag cell stores in the tag column, so an untagged market sharing that
  // spelling would merge two different things into one row.
  const result = run([settled({ firstPolymarketTags: [] })]);
  assert.equal(result.loaded.cells.length, 1);
  assert.match(result.loaded.cells[0], /\|\(untagged\)\|/);
});

test("a void settlement is counted as neither a win nor a loss", () => {
  // Polymarket pays 0.50 a share on a void. Reading that as a win is the bug this endpoint
  // already refuses, and the stored table must not reintroduce it.
  const result = run([settled({ finalOutcomePrice: 0.5 }), settled({})]);
  assert.equal(result.accumulated.priced, 1, "only the real settlement is priced");
  assert.equal(result.loaded.cells.length, 1);
});

test("the load returns null when the fold has never run, so the page falls back", () => {
  // Not an empty set. An empty set served to the Setup finder reads as "nothing ever
  // settled", which is a wrong answer that looks like a working page.
  const result = run([settled({})], { skipStore: true });
  assert.equal(result.loaded, null);
  assert.equal(result.rowCount, 0);
});

test("the replace is all-or-nothing and clears what was there", () => {
  const result = run([settled({})]);
  const log = result.log.join("\n");
  assert.ok(result.log[0] === "BEGIN", `the replace must open a transaction: ${result.log[0]}`);
  assert.ok(result.log.includes("COMMIT"), "and commit it");
  assert.match(log, /DELETE FROM trading_resolved_stats/,
    "yesterday's cells must go, or the table accumulates two archives at once");
  assert.ok(log.indexOf("BEGIN") < log.indexOf("DELETE FROM trading_resolved_stats"),
    "and the delete must be inside the transaction, not before it");
});

test("BAIT: a tag cell and an any-tag cell must not collide", () => {
  // The first version of this used an untagged row and proved nothing: an empty tag LIST
  // becomes the label "(untagged)", which cannot collide with the empty string an any-tag
  // cell stores. Dropping scope from the key left it passing, which is the finding.
  //
  // The collision is real for a tag that IS the empty string -- taxonomy labels pass those
  // through, only an empty list is relabelled -- and then the two cells differ in nothing but
  // scope. One settled row must still store one tag cell and one any cell.
  const result = run([settled({ firstPolymarketTags: [""] })]);
  assert.equal(result.rowCount, 2,
    `an empty-string tag must not overwrite the any-tag cell: ${JSON.stringify(result.loaded)}`);
  assert.equal(result.loaded.cells.length, 1);
  assert.equal(result.loaded.anyTag.length, 1);

  // And the untagged case, which is the one that is actually common.
  const untagged = run([settled({ firstPolymarketTags: [] })]);
  assert.equal(untagged.rowCount, 2);
});

test("BAIT: the stored numbers are the numbers, not rounded on the way through", () => {
  // staked and pnl are DECIMAL(24,6); a win at 0.55 pays 5 * (1/0.55 - 1) = 4.090909..., and
  // a column too narrow -- or a cast to int -- would quietly change every return the page
  // reports.
  const result = run([settled({ firstMarketProbability: 0.55 })]);
  const cell = result.loaded.cells[0];
  assert.match(cell, /,4\.09090909/, `the payout must survive to six places at least: ${cell}`);
  assert.deepEqual(result.loaded.cells, result.accumulated.cells);
});

test("the cells go in batches, not one round trip each", () => {
  // Tens of thousands of cells at a statement apiece is minutes of a request that a shared
  // host cuts short -- which rolls the transaction back and leaves the fold never finishing.
  // 450 cells must not be 450 statements.
  const rows = [];
  for (let index = 0; index < 900; index += 1) {
    rows.push(settled({ firstMarketProbability: 0.5 + (index % 45) / 100, horizon: `h${index % 10}`,
      shape: `s${index % 3}`, firstPolymarketTags: [`tag${index % 7}`] }));
  }
  const result = run(rows);
  assert.equal(result.ok, true, result.error || "");
  const inserts = result.log.filter((sql) => sql.includes("INSERT INTO trading_resolved_stats"));
  assert.ok(result.rowCount > 300, `the fixture must produce many cells: ${result.rowCount}`);
  assert.ok(inserts.length <= Math.ceil(result.rowCount / 200) + 1,
    `${result.rowCount} cells must not cost ${inserts.length} statements`);
  // And batching must not lose or duplicate a cell.
  assert.deepEqual(result.loaded.cells, result.accumulated.cells);
  assert.deepEqual(result.loaded.anyTag, result.accumulated.anyTag);
});

test("the endpoint prefers the stored fold and falls back rather than failing", () => {
  const endpoint = API.slice(API.indexOf("if ($action === 'resolved-combinations')"));
  const block = endpoint.slice(0, endpoint.indexOf("// Every combination, by suffix sum"));
  assert.match(block, /trading_storage_resolved_stats_load/, "it must try the table");
  assert.match(block, /\$accumulated === null[\s\S]*resolved_stats_accumulate/,
    "and stream the archive only when there is nothing stored");
  assert.match(block, /catch \(Throwable/, "a storage fault must not take the page down");
  assert.match(block, /'stored'/, "and the response must say which path answered");
});

test("the fold refuses to store an empty result over a good one", () => {
  // The failure that would be invisible: a read that returns no rows replaces the table with
  // nothing, and the Setup finder goes blank while reporting success.
  const operation = API.slice(API.indexOf("$operation === 'refresh-resolved-stats'"));
  const block = operation.slice(0, operation.indexOf("respond([\n                'ok' => true"));
  assert.match(block, /\['priced'\] \?\? 0\) <= 0/, "it must check that something was priced");
  assert.ok(block.indexOf("priced") < block.indexOf("trading_storage_resolved_stats_replace"),
    "and check before it writes, not after");
});
