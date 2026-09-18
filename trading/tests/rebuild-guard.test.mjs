// Runs offline: decide() is imported from the real tool file and EXECUTED. No network.
//
// The guard exists because the quota is shared. This schema is one database among several on
// the hosting account, reported at 1,844 MB of 2,000 MB used -- so a rebuild may take about
// 156 MB, not the 1,219 MB the schema's own size suggests. OPTIMIZE TABLE builds the table
// again beside the old one, and trading_observations' second copy is around 400 MB.
//
// InnoDB rolls back a rebuild that runs out of room and the table survives. What does not
// survive is everything else writing to the account while the quota is full -- and this is
// scheduled to run at one in the morning, unattended.
//
// So the guard has two ways to be wrong and both are baited: letting through a rebuild that
// does not fit, and refusing one that does.

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const GUARD = fileURLToPath(new URL("../tools/rebuild-guard.py", import.meta.url));

function decide({ table, density, usedMb, quotaMb, marginMb }) {
  const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("guard", ${JSON.stringify(GUARD)})
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)
args = json.loads(sys.stdin.read())
kwargs = {} if args["marginMb"] is None else {"margin_mb": args["marginMb"]}
print(json.dumps(guard.decide(args["table"], args["density"], args["usedMb"], args["quotaMb"], **kwargs)))
`;
  return JSON.parse(execFileSync("python3", ["-c", script], {
    input: JSON.stringify({ table, density, usedMb, quotaMb, marginMb: marginMb ?? null }),
    encoding: "utf8",
  }));
}

// The measurement as production reported it, in the units the endpoint returns. The split
// matters: estimatedRebuiltBytes covers the clustered index only, and indexBytes is the
// secondary indexes the rebuild also writes again.
const MB = 1048576;
const DENSITY = {
  tables: [
    { table: "trading_observations", estimatedRebuiltBytes: Math.round(315 * MB), indexBytes: Math.round(60 * MB), estimatedReclaimBytes: Math.round(169 * MB) },
    { table: "trading_event_log", estimatedRebuiltBytes: Math.round(49 * MB), indexBytes: Math.round(5 * MB), estimatedReclaimBytes: Math.round(24 * MB) },
    { table: "trading_trades", estimatedRebuiltBytes: Math.round(21 * MB), indexBytes: Math.round(7 * MB), estimatedReclaimBytes: Math.round(21 * MB) },
  ],
};

test("BAIT: the secondary indexes are part of the copy", () => {
  // Measured, not reasoned: trading_trades' clustered index was estimated at 28 MB and the
  // rebuilt table landed at 42 MB, because its 7 MB of secondary indexes were written again
  // too. A guard that sizes the copy from the data alone under-estimates, and under-estimating
  // is the direction that fills a shared quota at one in the morning.
  // 85 MB free, a 60 MB margin. Counting the data alone leaves 64 MB spare and passes;
  // counting the indexes too leaves 57 MB and must not.
  const withIndexes = decide({ table: "trading_trades", density: DENSITY, usedMb: 1915, quotaMb: 2000, marginMb: 60 });
  assert.equal(withIndexes.ok, false,
    `21 MB of data plus 7 MB of index against 85 MB free must be refused: ${withIndexes.reason}`);
  assert.match(withIndexes.reason, /28 MB/, "and the figure quoted must be data plus index");
});

test("the big table is refused at today's headroom, and the refusal says why", () => {
  // 2000 - 1844 = 156 MB free against a 375 MB copy. This is the case that would otherwise
  // fill a shared quota at 01:11 with nobody watching.
  const verdict = decide({ table: "trading_observations", density: DENSITY, usedMb: 1844, quotaMb: 2000 });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /375 MB/, "the reason must name what it needs -- 315 MB of data plus 60 MB of index");
  assert.match(verdict.reason, /156 MB/, "and what is free");
  assert.match(verdict.reason, /1,844 of 2,000 MB/, "and where that came from");
  assert.match(verdict.reason, /Rows have to come out/, "and what would make it possible");
});

test("a table that fits is allowed, and says what it will return", () => {
  const verdict = decide({ table: "trading_trades", density: DENSITY, usedMb: 1844, quotaMb: 2000 });
  assert.equal(verdict.ok, true, verdict.reason);
  assert.match(verdict.reason, /return about 21 MB/);
});

test("the margin is what decides the close calls, not the bare comparison", () => {
  // 54 MB needed against 100 MB free fits arithmetically and is still refused: InnoDB wants
  // scratch beyond the table for the log of writes that land during the rebuild, and the
  // quota is shared with databases this process cannot measure.
  const tight = decide({ table: "trading_event_log", density: DENSITY, usedMb: 1900, quotaMb: 2000 });
  assert.equal(tight.ok, false, "46 MB spare is under the default 60 MB margin");

  const roomy = decide({ table: "trading_event_log", density: DENSITY, usedMb: 1810, quotaMb: 2000 });
  assert.equal(roomy.ok, true, roomy.reason);
});

test("BAIT: it must not pass a rebuild that does not fit", () => {
  // Walking the headroom down one megabyte at a time. Every verdict at or below the needed
  // size plus the margin must be a refusal -- an off-by-one here is a full disk.
  for (let free = 0; free <= 600; free += 25) {
    const verdict = decide({
      table: "trading_observations",
      density: DENSITY,
      usedMb: 2000 - free,
      quotaMb: 2000,
      marginMb: 60,
    });
    const shouldPass = free - 375 >= 60;
    assert.equal(verdict.ok, shouldPass,
      `${free} MB free vs a 375 MB copy and a 60 MB margin: expected ok=${shouldPass}, got ${verdict.ok}`);
  }
});

test("BAIT: an unmeasured table is refused rather than assumed to fit", () => {
  // The dangerous default. If a missing measurement read as zero bytes needed, every table
  // the density report failed to cover would sail through with unlimited headroom.
  const verdict = decide({ table: "trading_storage_meta", density: DENSITY, usedMb: 0, quotaMb: 2000 });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /was not measured/);
  assert.match(verdict.reason, /trading_observations/, "and it must name what it did measure");

  const empty = decide({ table: "trading_trades", density: { tables: [] }, usedMb: 0, quotaMb: 2000 });
  assert.equal(empty.ok, false, "an empty report is not a green light");
});

test("BAIT: a measured size of zero is treated as broken, not as free", () => {
  const verdict = decide({
    table: "trading_trades",
    density: { tables: [{ table: "trading_trades", estimatedRebuiltBytes: 0, indexBytes: 0, estimatedReclaimBytes: 0 }] },
    usedMb: 0,
    quotaMb: 2000,
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /cannot be right/);
});

test("the workflow actually runs the guard before the rebuild", () => {
  // A guard the pipeline does not call is decoration. The order is what matters: refusing
  // after OPTIMIZE has started is the same as not refusing.
  const workflow = execFileSync("cat", [fileURLToPath(new URL("../../.github/workflows/trading-storage-rebuild.yml", import.meta.url))], { encoding: "utf8" });
  const guardAt = workflow.indexOf("rebuild-guard.py");
  const rebuildAt = workflow.indexOf('"rebuild-table"');
  assert.ok(guardAt > 0, "the workflow must run the guard");
  assert.ok(rebuildAt > 0, "and the rebuild");
  assert.ok(guardAt < rebuildAt, "the guard must come first");
  assert.match(workflow, /HOSTING_USED_MB/, "and be told what the hosting reports");
  assert.match(workflow, /HOSTING_QUOTA_MB/);
});

test("BAIT: measure-only must never let the repack run", () => {
  // The room check changes every time rows are archived, so reading it must not require
  // arming a destructive dispatch -- that is how a guard stops being consulted. But the mode
  // that makes it cheap to read is also the mode that must never rebuild anything.
  const workflow = readFileSync(
    new URL("../../.github/workflows/trading-storage-rebuild.yml", import.meta.url), "utf8");
  const job = workflow.slice(workflow.indexOf("  rebuild:"));
  assert.match(job, /if: inputs\.confirm_rebuild == true \|\| inputs\.measure_only == true/,
    "the job runs for a measurement as well as for a rebuild");

  const repack = job.slice(job.indexOf("- name: Repack the table"));
  const condition = repack.slice(0, repack.indexOf("run:"));
  assert.match(condition, /inputs\.confirm_rebuild == true/,
    "the repack still needs the explicit confirmation");
  assert.match(condition, /inputs\.measure_only != true/,
    "and measure-only must hold it back, or the safe mode rebuilds the table");

  // The guard itself must stay unconditional: a rebuild that skips the room check is the
  // thing this whole file exists to prevent.
  const guard = job.slice(job.indexOf("- name: Check there is room"), job.indexOf("- name: Repack the table"));
  assert.ok(!/\n        if:/.test(guard), `the room check must never be conditional: ${guard}`);
});
