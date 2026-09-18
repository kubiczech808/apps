// Runs offline: the workflow's own python is LIFTED out of the YAML and executed, against a
// response shape produced by the REAL trading_storage_table_stats() running under php. No
// network, no database.
//
// Why this test exists at all. Three times now a check in this repo has been written against
// keys the endpoint does not send, and each time the failure was worse than a crash:
//
//   * the believability check read "rows", which does not exist, and printed
//     "0 combinations ... 0 perfect" -- a clean bill of health over an empty list;
//   * corrected to "combinations", which is an integer, and died on len();
//   * and this workflow read tradingTables as a list of rows when it is a MAP keyed by table
//     name, so footprint() raised AttributeError before a single row was archived.
//
// The last one cost nothing because it happened first. Written the other way round -- a
// default of {} and a quiet zero -- it would have reported "observations 0.0 MB -> 0.0 MB"
// after deleting ninety thousand rows, and the number that says whether this worked would
// have been fiction.
//
// So the readout is executed here against the shape php actually produces.

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WORKFLOW = readFileSync(
  new URL("../../.github/workflows/trading-archive-resolved-observations.yml", import.meta.url), "utf8");
const STORAGE = readFileSync(new URL("../storage.php", import.meta.url), "utf8");

// The archive step's script, dedented out of the YAML block exactly as bash receives it.
function liftScript() {
  const start = WORKFLOW.indexOf("<<'PY'", WORKFLOW.indexOf("Archive settled observations"));
  assert.ok(start > 0, "the archive step must still be a python heredoc");
  const body = WORKFLOW.slice(WORKFLOW.indexOf("\n", start) + 1);
  const end = body.indexOf("\n          PY\n");
  assert.ok(end > 0, "the heredoc must be terminated");
  return body.slice(0, end).split("\n")
    .map((line) => (line.startsWith("          ") ? line.slice(10) : line))
    .join("\n");
}

// The shape the endpoint really sends, produced by running the real stats builder. Written
// by php rather than by hand, because a hand-written fixture agrees with whatever the test
// author already believed -- which is the exact mistake being guarded against.
function realTableStatsShape() {
  const directory = mkdtempSync(join(tmpdir(), "archive-readout-"));
  try {
    const start = STORAGE.indexOf("function trading_storage_table_stats");
    assert.ok(start > 0, "trading_storage_table_stats must exist");
    const fn = STORAGE.slice(start, STORAGE.indexOf("\n}\n", start) + 2).replace("(PDO $pdo", "($pdo");
    writeFileSync(join(directory, "stats.php"), `<?php
${fn}
class StubStatement {
    public function execute($params = null): bool { return true; }
    public function fetchAll(): array {
        return [
            ['table_name' => 'trading_observations', 'table_rows' => 226262,
             'data_length' => 700000000, 'index_length' => 40000000, 'data_free' => 5242880],
            ['table_name' => 'trading_trades', 'table_rows' => 364,
             'data_length' => 44040192, 'index_length' => 1048576, 'data_free' => 0],
        ];
    }
}
class StubPdo { public function prepare(string $sql) { return new StubStatement(); } }
echo json_encode(trading_storage_table_stats(new StubPdo()));
`);
    return JSON.parse(execFileSync("php", [join(directory, "stats.php")], { encoding: "utf8" }));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// Runs the workflow's footprint() against a given storage payload and returns what it printed
// and what it read.
function readout(storage) {
  const directory = mkdtempSync(join(tmpdir(), "archive-readout-run-"));
  try {
    const script = liftScript();
    const head = script.slice(0, script.indexOf("\nbefore = footprint()"));
    assert.ok(head.includes("def footprint()"), "footprint() must still be there to execute");
    writeFileSync(join(directory, "readout.py"), `
import json, sys
${head.replace(/^key = os\.environ\["TRADING_TRIGGER_KEY"\]$/m, 'key = "stub"')}

# call() is replaced AFTER the script defines it, so footprint() is the real one.
def call(payload, timeout=900):
    return {"ok": True, "operation": "status", "counts": {"RESOLVED": 90795},
            "storage": json.loads(sys.argv[1])}

print("RESULT " + json.dumps(footprint()))
`);
    const output = execFileSync("python3", [join(directory, "readout.py"), JSON.stringify(storage)], {
      encoding: "utf8", env: { ...process.env, TRADING_TRIGGER_KEY: "stub", BATCHES: "1", LIMIT: "200", KEEP_DAYS: "0" },
    });
    const line = output.split("\n").find((row) => row.startsWith("RESULT "));
    assert.ok(line, `footprint() printed no result:\n${output}`);
    return { value: JSON.parse(line.slice(7)), output };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("the workflow reads real megabytes out of the shape php sends", () => {
  const tradingTables = realTableStatsShape();
  // The shape itself, stated once so the reason for the crash is on the record: a MAP.
  assert.ok(!Array.isArray(tradingTables), "tradingTables is keyed by table name, not a list");
  assert.ok(tradingTables.trading_observations, "and trading_observations is one of its keys");

  const { value } = readout({
    databaseSizeBytes: 797966336, tradingSizeBytes: 785088512, tradingTables,
  });
  assert.equal(value.databaseMB, 761.0);
  assert.equal(value.observationsMB, 705.7, "700 MB of data plus 40 MB of index, over 1024 not 1000");
  assert.deepEqual(value.counts, { RESOLVED: 90795 });
});

test("BAIT: reading it as a list of rows finds nothing, and says so out loud", () => {
  // The bug, in the shape it had. The point is not that it fails -- it is that a run which
  // reports 0.0 MB must never look like a successful measurement.
  const { value, output } = readout({
    databaseSizeBytes: 797966336,
    tradingTables: [{ name: "trading_observations", dataBytes: 700000000, indexBytes: 40000000 }],
  });
  assert.equal(value.observationsMB, 0, "a list genuinely yields nothing");
  assert.match(output, /unexpected tradingTables shape: list/,
    "and the run has to print the shape it got rather than report a comfortable zero");
});

test("BAIT: a missing observations entry is reported, not silently zero", () => {
  const { value, output } = readout({
    databaseSizeBytes: 1000, tradingTables: { trading_trades: { dataBytes: 1, indexBytes: 2 } },
  });
  assert.equal(value.observationsMB, 0);
  assert.match(output, /no trading_observations entry; keys were: \['trading_trades'\]/);
});

test("an endpoint that answers nothing at all does not crash the run", () => {
  const { value } = readout({});
  assert.equal(value.databaseMB, 0);
  assert.equal(value.observationsMB, 0);
});

test("the batch loop stops the job if a batch deletes more than it verified", () => {
  // The one failure worth abandoning the whole run for, since it can only mean the archiver
  // changed under the workflow. Read from the lifted script, so a rewrite that drops it fails.
  const script = liftScript();
  assert.match(script, /if int\(result\.get\("deleted"\) or 0\) > int\(result\.get\("verified"\) or 0\):/);
  assert.match(script, /STOP: this batch deleted more rows than it verified/);
  assert.ok(script.indexOf('"operation": "archive-resolved-observations"') < script.indexOf("STOP: this batch"),
    "the check must follow the batch it is checking");
});

test("the fold check refuses a run that lost settlements", () => {
  // The other half: the archive is only safe because the statistics can still read it.
  const start = WORKFLOW.indexOf("<<'PY'", WORKFLOW.indexOf("Check the statistics still see"));
  const check = WORKFLOW.slice(start, WORKFLOW.indexOf("\n          PY\n", start));
  assert.match(check, /"operation": "refresh-resolved-stats"/);
  assert.match(check, /if priced < 70000:/,
    "77,553 priced settlements was the count before archiving; it must not fall");
  assert.match(check, /raise SystemExit/);
  assert.match(check, /result\.get\("priced"\)/,
    "read from the response's own keys -- 'rows' and 'combinations' were both wrong before");
});

test("the nightly run exists, and its fold check cannot be skipped after a delete", () => {
  // "a tech, ktere budou teprve do datove strukture pribyvat" -- a one-off bulk run only
  // handles the rows that are already there. Around 4,500 fresh settlements were waiting on
  // the day this was written, and more arrive every day.
  const on = WORKFLOW.slice(0, WORKFLOW.indexOf("\njobs:"));
  assert.match(on, /cron: "41 0 \* \* \*"/, "the archive runs nightly");
  assert.ok(WORKFLOW.indexOf('cron: "41 0') > 0, "and before the 01:11 fold, so the archive is ready for it");

  // The gate exists so a night with nothing to archive does not re-fold tens of thousands of
  // cells for nothing. It must still fire when rows DID move, including when the run failed
  // partway -- that is precisely when the statistics need checking.
  const check = WORKFLOW.slice(WORKFLOW.indexOf("Check the statistics still see"));
  const condition = check.slice(0, check.indexOf("run:"));
  assert.match(condition, /always\(\)/, "a failed run may still have moved rows");
  assert.match(condition, /steps\.archive\.outputs\.archived != '0'/);
  assert.ok(!/archived == '0'/.test(condition), "the sense of the test must not be inverted");
  // And the count it reads has to actually be written.
  assert.match(WORKFLOW, /handle\.write\(f"archived=\{archived\}\\n"\)/,
    "the step must publish what it archived, or the gate reads an empty string forever");
});

test("BAIT: a gate that skips the check after archiving is a fault, not a saving", () => {
  // The dangerous inversion. If the condition were ever written so that a run which moved
  // 20,000 rows skipped the fold check, the one guarantee this whole design rests on --
  // that the statistics can still read what left MySQL -- would go unverified, quietly.
  const check = WORKFLOW.slice(WORKFLOW.indexOf("Check the statistics still see"));
  const condition = check.slice(0, check.indexOf("run:"));
  const skipsWhenArchived = /outputs\.archived == '0'/.test(condition)
    || /outputs\.archived != ''/.test(condition) === false && /archived == /.test(condition);
  assert.equal(skipsWhenArchived, false,
    `the check must run whenever rows moved: ${condition.trim()}`);
});
