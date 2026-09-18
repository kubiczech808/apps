// Runs offline: decide() is imported from the real tool file and EXECUTED. No network.
//
// What this is for. The pipeline runs on a self-dispatching chain -- each pacer run waits,
// wakes the scan, and dispatches the next link. On 18.9. at 09:23 the hand-off answered
//
//     422 Cannot trigger a 'workflow_dispatch' on a disabled workflow
//
// five times over, and the chain stopped. Automatic execution and scraping were dead for four
// hours. The only thing that noticed was the owner, looking at a live portfolio that had not
// traded and a scan log whose newest entry was 11:16.
//
// The pacer already carries an hourly cron for exactly this case. It could not help: a
// disabled workflow does not run its own schedule either, so the loop could not resurrect
// itself from inside itself.
//
// The watchdog has two ways to be wrong and both are baited. Missing a dead chain leaves the
// pipeline stopped, which is what happened. Firing on a LIVE chain is worse than it sounds:
// the pacer collapses duplicates with cancel-in-progress, so a spurious dispatch kills the
// running link rather than adding to it.

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const WATCHDOG = fileURLToPath(new URL("../tools/pacer-watchdog.py", import.meta.url));
const NOW = "2026-09-18T13:22:00+00:00";

function decide(runs, { now = NOW, maxSilence = null, stuck = null } = {}) {
  const script = `
import importlib.util, json, sys
from datetime import datetime
spec = importlib.util.spec_from_file_location("watchdog", ${JSON.stringify(WATCHDOG)})
watchdog = importlib.util.module_from_spec(spec)
spec.loader.exec_module(watchdog)
args = json.loads(sys.stdin.read())
kwargs = {}
if args["maxSilence"] is not None: kwargs["max_silence_minutes"] = args["maxSilence"]
if args["stuck"] is not None: kwargs["stuck_minutes"] = args["stuck"]
print(json.dumps(watchdog.decide(args["runs"], datetime.fromisoformat(args["now"]), **kwargs)))
`;
  return JSON.parse(execFileSync("python3", ["-c", script], {
    input: JSON.stringify({ runs, now, maxSilence, stuck }),
    encoding: "utf8",
  }));
}

// Minutes before NOW, in the shape the runs API returns.
const run = (minutesAgo, { status = "completed", conclusion = "success" } = {}) => ({
  created_at: new Date(Date.parse(NOW) - minutesAgo * 60000).toISOString(),
  status,
  conclusion,
});

test("the outage that prompted this is detected", () => {
  // The real shape: the last pacer run started at 09:15 and its hand-off failed, so nothing
  // followed. By 13:22 that is 247 minutes of silence.
  const verdict = decide([run(247, { conclusion: "cancelled" })]);
  assert.equal(verdict.restart, true);
  assert.match(verdict.reason, /247/, "the reason must name how long it has been quiet");
  assert.match(verdict.reason, /chain is dead/);
  assert.equal(verdict.alive, false);
});

test("BAIT: a running chain is left alone", () => {
  // The dangerous direction. The pacer runs under cancel-in-progress, so dispatching over a
  // live link cancels it -- a watchdog that fires on a healthy chain interrupts the pipeline
  // instead of protecting it.
  // The run has to be OLD as well as running, or the silence window alone would save it and
  // this would pass with the in-progress branch deleted -- which it did, until a bait showed
  // it. 40 minutes is past the 25-minute window and inside the 65-minute job timeout, so
  // nothing but "it is still going" can keep the watchdog quiet.
  for (const status of ["in_progress", "queued", "requested", "waiting"]) {
    const verdict = decide([run(40, { status, conclusion: null }), run(46)]);
    assert.equal(verdict.restart, false, `${status} means the chain is working: ${verdict.reason}`);
    assert.equal(verdict.alive, true);
    assert.match(verdict.reason, /chain is alive/);
  }
});

test("a chain ticking normally is left alone, and one that has gone quiet is not", () => {
  // Ticks are three minutes and a scan every ten, so runs appear every few minutes.
  assert.equal(decide([run(4), run(8), run(12)]).restart, false);
  assert.equal(decide([run(24)]).restart, false, "24 minutes is inside the window");
  assert.equal(decide([run(26)]).restart, true, "26 is outside it");
});

test("BAIT: the window is a boundary, not a suggestion", () => {
  // An off-by-one here is either a pipeline left dead or a chain cancelled every run.
  for (let age = 0; age <= 60; age += 1) {
    const verdict = decide([run(age)], { maxSilence: 25 });
    assert.equal(verdict.restart, age > 25,
      `${age} minutes of silence against a 25-minute window: restart should be ${age > 25}`);
  }
});

test("a run stuck past its own timeout is not proof of life", () => {
  // The pacer job times out at 60 minutes. A run still "in progress" beyond that is not
  // working -- and treating it as alive is how a hung link keeps the watchdog quiet forever.
  const stuck = decide([run(90, { status: "in_progress", conclusion: null })]);
  assert.equal(stuck.restart, true);
  assert.match(stuck.reason, /stuck, not working/);

  const working = decide([run(30, { status: "in_progress", conclusion: null })]);
  assert.equal(working.restart, false, "inside the timeout it is still running");
});

test("no runs at all means start the chain, not assume it is fine", () => {
  const verdict = decide([]);
  assert.equal(verdict.restart, true);
  assert.match(verdict.reason, /no pacer run on record/);
});

test("runs out of order are still read newest-first", () => {
  // The API returns newest first, but nothing downstream should depend on that -- a listing
  // that arrives sorted the other way must not read the oldest run as the newest and restart
  // a perfectly healthy chain.
  assert.equal(decide([run(300), run(200), run(4)]).restart, false);
  assert.equal(decide([run(4), run(200), run(300)]).restart, false);
});

test("a rubbish timestamp is ignored rather than read as now", () => {
  // Date.parse on nonsense yields nothing; treated as the current moment it would report a
  // dead chain as alive.
  const verdict = decide([{ created_at: "not a date", status: "completed", conclusion: "success" },
    run(247)]);
  assert.equal(verdict.restart, true, `the undated row must not vouch for the chain: ${verdict.reason}`);
});

test("it says the one thing a retry cannot fix", () => {
  // A disabled workflow accepts no dispatch and runs no schedule, so it stays dead until a
  // person enables it. That has to read as an instruction, not as another failed attempt.
  const source = readFileSync(WATCHDOG, "utf8");
  assert.match(source, /disabled workflow/, "it must recognise the 422 that stopped the chain");
  assert.match(source, /Enable Trading Pacer in the repository's/,
    "and say what clears it");
  // Code, not prose. The comment right beside this branch says "rather than another retry",
  // and a check that reads comments counts the explanation as the thing it warns against --
  // the same way an earlier test read a warning about a call as the call itself.
  const code = source.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
  const afterBranch = code.slice(code.indexOf("disabled workflow"));
  assert.ok(!/for .* in range|while True|time\.sleep/.test(afterBranch),
    "and must not loop or sleep over a condition no retry can clear");
});

test("the watchdog runs from somewhere the pacer's own failure cannot reach", () => {
  // The whole point. The pacer's resurrection cron lives in the pacer, and a disabled
  // workflow runs neither. This has to be a separate workflow.
  const workflow = readFileSync(
    new URL("../../.github/workflows/trading-pacer-watchdog.yml", import.meta.url), "utf8");
  assert.match(workflow, /pacer-watchdog\.py/, "the workflow must run the watchdog");
  assert.match(workflow, /schedule:/, "on its own schedule");
  assert.ok(!workflow.includes("trading-pacer.yml:"), "and must not be part of the pacer itself");
  assert.match(workflow, /actions: write/, "and needs permission to dispatch");
});
