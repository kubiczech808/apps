// Runs offline: the REAL archiver out of storage.php is executed by php, against a stub PDO
// and real gzip files in a temp directory. No network, no MySQL, no host.
//
// "pokracuj v redukci ... soustred se jen na redukci stavajicich resolved dat a tech, ktere
// budou teprve do datove struktury pribyvat". trading_observations holds 90,795 settled rows
// and is the only complete record of them -- the published resolved file is a capped
// by-product with 6,533. So they can be moved out of MySQL, but only if moving them out is
// provably not the same thing as losing them.
//
// Two properties make that true, and both are tested here by running the code:
//
//   * the file is written, CLOSED, reopened and COUNTED before a single row is deleted, and
//     a count that disagrees refuses the whole batch;
//   * what the archive holds is what the statistics fold reads back, in the shape the
//     restore already expects.
//
// The order is the point. Losing the archive after deleting is unrecoverable; refusing to
// delete after writing costs one wasted file.

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, truncateSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STORAGE = readFileSync(new URL("../storage.php", import.meta.url), "utf8");

function lift(name) {
  const start = STORAGE.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} must exist in storage.php`);
  const end = STORAGE.indexOf("\n}\n", start);
  assert.ok(end > start, `${name} must be complete`);
  // The PDO type hint is relaxed so the stub can stand in; nothing else about the function
  // is rewritten, because a restated copy is a copy nobody ships.
  return STORAGE.slice(start, end + 2).replace("(PDO $pdo", "($pdo");
}

// Everything the archiver calls that is not itself under test. trading_storage_unpack is the
// real one -- what the archive holds has to survive the same decode the database write used.
const HARNESS = `
function trading_storage_bootstrap($pdo): void {}
${lift("trading_storage_unpack")}
${lift("trading_storage_count_archived_rows")}
${lift("trading_storage_archive_resolved_observations")}
${lift("trading_storage_stream_archived_observations")}

class StubPdo
{
    public array $log = [];
    public array $rows = [];
    public int $remaining = 0;
    public $atDelete = null;

    public function prepare(string $sql)
    {
        return new StubStatement($this, $sql);
    }

    public function query(string $sql)
    {
        $this->log[] = ['query', $sql];
        return new StubStatement($this, $sql);
    }
}

class StubStatement
{
    public function __construct(private StubPdo $pdo, private string $sql) {}

    public function execute($params = null): bool
    {
        $isDelete = str_contains($this->sql, 'DELETE');
        if ($isDelete && $this->pdo->atDelete === null) {
            // What the archive file looks like at the instant the first row is deleted.
            // Recorded here rather than asserted here, so the test does the judging.
            $this->pdo->atDelete = $GLOBALS['archiveState']();
        }
        $this->pdo->log[] = [$isDelete ? 'delete' : 'select', $this->sql, $params];
        if ($isDelete) {
            $this->pdo->deleted = count((array) $params);
            $keys = array_flip((array) $params);
            $this->pdo->rows = array_values(array_filter(
                $this->pdo->rows,
                static fn (array $row): bool => !isset($keys[$row['observation_key']])
            ));
            $this->pdo->remaining = count($this->pdo->rows);
        }
        return true;
    }

    public function fetchAll(): array
    {
        $limit = 0;
        if (preg_match('/LIMIT (\\\\d+)/', $this->sql, $match)) {
            $limit = (int) $match[1];
        }
        return array_slice($this->pdo->rows, 0, $limit ?: count($this->pdo->rows));
    }

    public function fetchColumn()
    {
        return $this->pdo->remaining;
    }

    public function rowCount(): int
    {
        return $this->pdo->deleted ?? 0;
    }
}
`;

function run({ rows, limit = 2000, call = "archive", truncateTo = null }) {
  const directory = mkdtempSync(join(tmpdir(), "resolved-archive-"));
  try {
    const rowsFile = join(directory, "rows.json");
    writeFileSync(rowsFile, JSON.stringify(rows ?? []));
    // __DIR__ inside the lifted functions resolves to wherever this file sits, so the
    // archive lands in the temp directory and the test can read and damage it.
    writeFileSync(join(directory, "harness.php"), `<?php\n${HARNESS}\n`);
    const script = `
      require '${join(directory, "harness.php")}';
      $GLOBALS['archiveState'] = static function (): array {
          $files = glob(__DIR__ . '/data/observation-archive/*/*.ndjson.gz') ?: [];
          return [
              'files' => count($files),
              'restorableRows' => array_sum(array_map('trading_storage_count_archived_rows', $files)),
          ];
      };
      $pdo = new StubPdo();
      foreach (json_decode(file_get_contents('${rowsFile}'), true) as $row) {
          $pdo->rows[] = [
              'observation_key' => $row['key'],
              'lifecycle' => 'RESOLVED',
              // Stored exactly as the database stores it, so the real unpack has to work.
              'payload' => $row['payload'] === null ? null : gzcompress(json_encode($row['payload'])),
              'updated_at' => $row['updatedAt'],
          ];
      }
      $pdo->remaining = count($pdo->rows);
      $result = ['ok' => true];
      try {
          $result['archive'] = trading_storage_archive_resolved_observations($pdo, ${limit});
      } catch (Throwable $error) {
          $result['ok'] = false;
          $result['error'] = $error->getMessage();
      }
      ${truncateTo === null ? "" : `
      // Damage the archive after it was written, then ask what it is now worth.
      foreach (glob(__DIR__ . '/data/observation-archive/*/*.ndjson.gz') ?: [] as $file) {
          $bytes = file_get_contents($file);
          file_put_contents($file, substr($bytes, 0, (int) (strlen($bytes) * ${truncateTo})));
      }`}
      $streamed = [];
      try {
          $result['streamedRows'] = trading_storage_stream_archived_observations(
              static function (array $payload) use (&$streamed): void { $streamed[] = $payload; });
      } catch (Throwable $error) {
          $result['streamError'] = $error->getMessage();
      }
      $result['streamed'] = $streamed;
      $result['atDelete'] = $pdo->atDelete;
      $result['deletes'] = array_values(array_filter($pdo->log, static fn ($entry) => $entry[0] === 'delete'));
      $result['survivingKeys'] = array_column($pdo->rows, 'observation_key');
      $result['restorable'] = $GLOBALS['archiveState']();
      echo json_encode($result);
    `;
    return JSON.parse(execFileSync("php", ["-r", script], {
      encoding: "utf8", maxBuffer: 64 * 1024 * 1024, cwd: directory,
    }));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const settled = (n) => Array.from({ length: n }, (_, index) => ({
  key: `obs-${String(index).padStart(4, "0")}`,
  updatedAt: `2026-0${1 + (index % 8)}-1${index % 9} 04:05:06`,
  payload: {
    tokenId: `token-${index}`, question: `Did fixture ${index} settle?`,
    outcome: index % 2 ? "Yes" : "No", resolvedOutcomePrice: index % 2 ? 1 : 0,
    marketProbability: 0.7 + (index % 20) / 100,
    firstPolymarketTags: ["esports", "valorant"],
    // Real observation payloads run to kilobytes. A long line is what catches a read that
    // was given a length and split it.
    scanNotes: "x".repeat(3000),
  },
}));

test("rows are written, read back and only then deleted", () => {
  const result = run({ rows: settled(12) });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.archive.archived, 12);
  assert.equal(result.archive.verified, 12);
  assert.equal(result.archive.deleted, 12);
  assert.equal(result.archive.remaining, 0);
  assert.equal(result.survivingKeys.length, 0, "every archived row left the table");
});

test("BAIT: at the moment of the first delete the archive is already complete on disk", () => {
  // The ordering IS the safety. Recorded by the stub at the instant DELETE was executed --
  // not inferred from the code, and not from the state afterwards.
  const result = run({ rows: settled(12) });
  assert.deepEqual(result.atDelete, { files: 1, restorableRows: 12 },
    "all twelve rows must be readable off the closed file before the first one is deleted");
});

test("what the archive holds is what the fold reads back", () => {
  const result = run({ rows: settled(5) });
  assert.equal(result.streamedRows, 5);
  assert.equal(result.streamed.length, 5);
  // The fold reads payloads, and it identifies a settlement by tokenId. A shape that
  // survives the round trip but drops those fields would fold to nothing at all.
  assert.deepEqual(result.streamed.map((row) => row.tokenId).sort(),
    ["token-0", "token-1", "token-2", "token-3", "token-4"]);
  assert.equal(result.streamed[0].scanNotes.length, 3000,
    "a payload larger than any read buffer must come back whole");
  assert.ok(result.streamed.every((row) => Array.isArray(row.firstPolymarketTags)),
    "the tags the fold groups by must survive");
});

test("BAIT: a damaged archive counts fewer rows than it was given", () => {
  // The guard's premise, executed. A gzip stream truncated by a full disk closes without
  // error, and its tail stops parsing -- which is what makes counting the check.
  const result = run({ rows: settled(40), truncateTo: 0.5 });
  assert.equal(result.ok, true, "the archive itself was sound when it was written");
  assert.ok(result.restorable.restorableRows < 40,
    `a halved file must not still read as forty rows: ${result.restorable.restorableRows}`);
});

test("a row whose payload cannot be unpacked stays in the database", () => {
  // Never written as a line the restore cannot rebuild, and never deleted on the strength
  // of one. It is simply left where it is, for someone to look at.
  const rows = [...settled(4)];
  rows[2] = { ...rows[2], payload: null };
  const result = run({ rows });
  assert.equal(result.archive.archived, 3);
  assert.equal(result.archive.deleted, 3);
  assert.deepEqual(result.survivingKeys, ["obs-0002"],
    "the unreadable row is the one still there");
  assert.equal(result.streamedRows, 3);
});

test("the batch is bounded, and says whether there is more to do", () => {
  const partial = run({ rows: settled(30), limit: 50 });
  assert.equal(partial.archive.archived, 30);
  assert.equal(partial.archive.done, true, "fewer rows than the limit means the table is drained");
  assert.equal(partial.archive.remaining, 0);

  // A full batch means there is more; the caller runs it again rather than assuming.
  const full = run({ rows: settled(80), limit: 50 });
  assert.equal(full.archive.archived, 50);
  assert.equal(full.archive.done, false);
  assert.equal(full.archive.remaining, 30);
});

test("BAIT: the delete names its keys and its lifecycle, and is chunked", () => {
  // A DELETE that lost its key list would empty the table. One that lost the lifecycle would
  // take the SCRAPED rows the executor reads every five minutes.
  const result = run({ rows: settled(1100) });
  assert.equal(result.deletes.length, 3, "1100 keys must go out in chunks of 500");
  for (const [, sql, params] of result.deletes) {
    assert.match(sql, /DELETE FROM trading_observations/);
    assert.match(sql, /lifecycle = "RESOLVED"/, "only settled rows may ever be deleted here");
    assert.match(sql, /observation_key IN \(/, "and only the ones just archived");
    assert.ok(params.length > 0 && params.length <= 500, `chunk size ${params.length}`);
    assert.equal((sql.match(/\?/g) || []).length, params.length,
      "a placeholder count that disagrees with the bindings deletes the wrong rows");
  }
});

test("BAIT: the select is bounded to RESOLVED and ordered oldest first", () => {
  // Reading the wrong lifecycle here would archive and then delete the live catalogue.
  const body = STORAGE.slice(STORAGE.indexOf("function trading_storage_archive_resolved_observations"));
  const select = body.slice(0, body.indexOf("$statement = $pdo->prepare"));
  assert.match(select, /WHERE lifecycle = :lifecycle/);
  assert.match(select, /'lifecycle' => 'RESOLVED'/);
  assert.match(select, /ORDER BY updated_at ASC/,
    "oldest first, so a run cut short has moved the rows least likely to be wanted");
});

test("the refusal comes before the delete, in the code as well as in the run", () => {
  const start = STORAGE.indexOf("function trading_storage_archive_resolved_observations");
  const body = STORAGE.slice(start, STORAGE.indexOf("\n}\n", start));
  const verified = body.indexOf("trading_storage_count_archived_rows");
  const refusal = body.indexOf("nothing was deleted");
  const deleted = body.indexOf("DELETE FROM trading_observations");
  assert.ok(verified > 0 && refusal > verified && deleted > refusal,
    "count, then refuse, then delete -- in that order");
  assert.ok(body.indexOf("gzclose($handle)") < verified,
    "and the file must be closed before it is counted");
});

test("the archive's shape is the one the restore already reads", () => {
  // Written before the first row leaves, so the way back exists first.
  const restore = STORAGE.slice(STORAGE.indexOf("function trading_storage_restore_observation_archives"));
  const body = restore.slice(0, restore.indexOf("\n}\n"));
  for (const field of ["observationKey", "payload"]) {
    assert.ok(body.includes(field), `the restore reads ${field}, so the archive must write it`);
  }
  const writer = STORAGE.slice(STORAGE.indexOf("function trading_storage_archive_resolved_observations"));
  const written = writer.slice(0, writer.indexOf("\n}\n"));
  for (const field of ["'observationKey' =>", "'lifecycle' =>", "'updatedAt' =>", "'payload' =>"]) {
    assert.ok(written.includes(field), `the archive must write ${field}`);
  }
});

test("BAIT: an archive file that cannot be read is never counted as rows", () => {
  const directory = mkdtempSync(join(tmpdir(), "resolved-archive-count-"));
  try {
    writeFileSync(join(directory, "harness.php"), `<?php\n${HARNESS}\n`);
    const broken = join(directory, "not-gzip.ndjson.gz");
    writeFileSync(broken, "this is not a gzip stream at all\n");
    const count = JSON.parse(execFileSync("php", ["-r",
      `require '${join(directory, "harness.php")}';`
      + ` echo json_encode(trading_storage_count_archived_rows('${broken}'));`,
    ], { encoding: "utf8" }));
    assert.equal(count, 0, "unreadable means zero restorable rows, which refuses the batch");
    const missing = JSON.parse(execFileSync("php", ["-r",
      `require '${join(directory, "harness.php")}';`
      + ` echo json_encode(trading_storage_count_archived_rows('${join(directory, "absent.gz")}'));`,
    ], { encoding: "utf8" }));
    assert.equal(missing, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("BAIT: the fold must read the archive as well as the database", () => {
  // Without this the first successful archive run silently replaces 77,553 priced
  // settlements with whatever is left in MySQL -- and the page still looks like it works.
  const api = readFileSync(new URL("../api.php", import.meta.url), "utf8");
  // The CALL, not the declaration -- the declaration is the first match and proves nothing.
  const start = api.indexOf("$accumulated = resolved_stats_accumulate(");
  assert.ok(start > 0, "the fold must still call the accumulator");
  const block = api.slice(start, start + 1400);
  assert.match(block, /trading_storage_resolved_observations_stream\(\$pdo, \$onRow\)/);
  assert.match(block, /trading_storage_stream_archived_observations\(\$onRow\)/,
    "the archived settlements must be folded too");
  assert.match(block, /\$fromDatabase \+ \$fromArchive/, "and both must be counted");
});

test("BAIT: no deploy may restore the archive back into the database", () => {
  // The trap this nearly walked into. trading-deploy.yml ran a one-time recovery that read
  // data/observation-archive back into MySQL, and its "already done" flag is written only
  // when the walk finishes -- an EMPTY archive directory returns done and records nothing.
  // The host's directory is empty, so the flag was never set, and the first archive file
  // would have been restored on the next deploy. The reduction would have undone itself on
  // a schedule, both halves reporting success.
  const deploy = readFileSync(new URL("../../.github/workflows/trading-deploy.yml", import.meta.url), "utf8");
  // What a step RUNS, not what a comment mentions. The comment recording why this was
  // removed names the operation, and a plain substring check reads that as the fault.
  const executable = deploy.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
  assert.ok(!executable.includes("restore-observation-archives"),
    "a deploy must never read the archive back into the database");
  assert.ok(!executable.includes("restore-archived-observations"),
    "and the job that did it must be gone, not merely renamed");
  // And the directory itself must still survive a deploy, which is the other half.
  assert.match(deploy, /"observation-archive",/,
    "the archive directory must stay on the keep list; it is now the only copy of those rows");
});

test("the early return really is the hole that made that trap possible", () => {
  // Executed rather than argued: the guard the deploy relied on is written AFTER the
  // empty-directory return, so an empty directory leaves it unset.
  const start = STORAGE.indexOf("function trading_storage_restore_observation_archives");
  const body = STORAGE.slice(start, STORAGE.indexOf("\n}\n", start));
  const emptyReturn = body.indexOf("if ($files === []) {");
  const flagCheck = body.indexOf("trading_storage_meta_get('observation-archive-restored-at')");
  assert.ok(emptyReturn > 0 && flagCheck > emptyReturn,
    "an empty archive returns done before the done-flag is ever consulted or written");
});
