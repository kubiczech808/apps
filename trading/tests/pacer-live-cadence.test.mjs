// Runs offline: the planner's real export, and the pacer's own shell arithmetic lifted out
// and executed by bash. No network, no dispatches, no secrets.
//
// Asked for: "chtel bych zaroven, aby u live portfolia dochazelo ke kontrole dostupnych
// kandidatu casteji nez s kazdym scrapingem. treba kazdou minutu."
//
// It could not be done by shortening the pacer's interval, and the pacer's own comment says
// why: every trading writer shares one concurrency slot, so scanning more often queues
// scans behind the lock rather than running them sooner -- the fault the ten-minute spacing
// was chosen to end. Measured before choosing a number: a live pass costs ~25 seconds on
// the Pi runner after the snapshot fix, two live portfolios run per tick, and the scan and
// the paper bot want the same slot. At a three-minute tick that is ~28% of the lock for the
// live checks; at one minute it would be ~83% and the scan would start being cancelled
// again, which is exactly the failure this desk spent this morning fixing.
//
// So the tick got shorter and the scan did not: the scan runs on every Nth tick, and the
// ticks in between wake only the live executors.

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { plannedDispatches } = await import("../tools/dispatch-after-scan.mjs");
const PACER = readFileSync(new URL("../../.github/workflows/trading-pacer.yml", import.meta.url), "utf8");
const DISPATCHER = readFileSync(new URL("../tools/dispatch-after-scan.mjs", import.meta.url), "utf8");

// The pacer decides which ticks scan with a handful of lines of shell. They are cut out of
// the workflow and RUN, for every tick of an hour, rather than read: an off-by-one here
// either scans three times as often as intended or never scans at all, and both look
// entirely plausible in a diff.
//
// Written out because the first version of this helper re-typed those lines instead of
// slicing them, and the bait proved it: changing the pacer's rotation to count ticks again
// broke nothing, because the test was executing its own transcription of the old rule. A
// lifted copy that drifts is worse than a grep -- it reports that it ran the real thing.
const SCAN_SCRIPT = (() => {
  const step = PACER.slice(PACER.indexOf("      - name: Wake the market scan"));
  const start = step.indexOf(`          tick=$(printf '%.0f' "\${TICK:-0}"`);
  const end = step.indexOf("          echo \"Tick ${tick}: scanning ");
  assert.ok(start > 0 && end > start, "the pacer's tick arithmetic must be findable");
  return step.slice(start, end)
    .split("\n").map((line) => (line.startsWith("          ") ? line.slice(10) : line)).join("\n");
})();

function scanTicks({ minutes, ticks }) {
  const directory = mkdtempSync(join(tmpdir(), "pacer-tick-"));
  try {
    const out = [];
    for (let tick = 0; tick < ticks; tick += 1) {
      // One tick per shell, because the real step's "not a scan tick" branch exits the job.
      const printed = execFileSync("bash", ["-c",
        `set -e; minutes=${minutes}; TICK=${tick}; GITHUB_ENV=${join(directory, `env-${tick}`)};`
        + ` : > "$GITHUB_ENV"\n${SCAN_SCRIPT}\necho "SCAN:$tag"`,
      ], { encoding: "utf8" });
      const match = /SCAN:(\S*)/.exec(printed);
      out.push(match ? `scan:${match[1] || "broad"}` : "live");
    }
    return out;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("the tick is three minutes and the scan still runs every ten", () => {
  // The default has to BE three, not merely be allowed to be: the chain carries its own
  // interval forward, so whatever this says is what runs forever after the next restart.
  assert.match(PACER, /interval_minutes:\n\s+description:[^\n]*\n\s+required: false\n\s+default: "3"/);
  assert.match(PACER, /INTERVAL: \$\{\{ inputs\.interval_minutes \|\| '3' \}\}/);
  assert.equal((PACER.match(/inputs\.interval_minutes \|\| '10'/g) || []).length, 0,
    "a leftover ten would hand the chain on at the old cadence and undo this silently");

  const hour = scanTicks({ minutes: 3, ticks: 20 });
  const scans = hour.filter((entry) => entry.startsWith("scan"));
  assert.equal(hour.length, 20, "twenty ticks an hour at three minutes");
  assert.equal(scans.length, 7, "and the scan keeps roughly its six-to-seven an hour");
  assert.equal(hour.filter((entry) => entry === "live").length, 13,
    "the rest are live checks, which is the whole point");

  // Every third tick, evenly: a scan cadence that drifted would show up here as a gap.
  assert.deepEqual(hour.slice(0, 7), ["scan:broad", "live", "live", "scan:esports", "live", "live", "scan:esports"]);
});

test("the scope rotation counts scans, not ticks", () => {
  // Counting ticks, only every third slot of six would ever be reached: broad and sports
  // would come round and two scopes would never be scanned at all. The rotation is what
  // decides which markets are fresh, so this failure is invisible until quotes go stale.
  const scopes = scanTicks({ minutes: 3, ticks: 60 })
    .filter((entry) => entry.startsWith("scan:")).map((entry) => entry.slice(5));
  assert.deepEqual(scopes.slice(0, 6), ["broad", "esports", "esports", "sports", "esports", "esports"],
    "all six slots must still come round in order");
  // Esports keeps the four-in-six share it was given deliberately: it is the only tag the
  // live portfolio trades. Measured over whole cycles -- a window cut mid-cycle reports a
  // share that is an artefact of where it was cut, not of the rotation.
  const cycles = scopes.slice(0, scopes.length - (scopes.length % 6));
  assert.equal(cycles.length % 6, 0);
  assert.equal(cycles.filter((scope) => scope === "esports").length / cycles.length, 4 / 6);
});

test("a ten-minute tick behaves exactly as before", () => {
  // The interval is an input, and somebody restarting the chain by hand with the old value
  // must get the old behaviour rather than a pacer that scans on every tick AND dispatches
  // the live executors on every tick as well.
  const ticks = scanTicks({ minutes: 10, ticks: 6 });
  assert.deepEqual(ticks, ["scan:broad", "scan:esports", "scan:esports", "scan:sports", "scan:esports", "scan:esports"],
    "at ten minutes every tick scans, as it always did");
});

test("the live-only tick wakes the live portfolios and nothing else", () => {
  const config = {
    paper: { conservative: { executionTrigger: "cron" } },
    live: { executionTrigger: "cron" },
    live5050: { executionTrigger: "after_scrape" },
    livePortfolios: { live70: { executionTrigger: "cron" } },
  };
  // What a scan tick does, unchanged.
  const full = plannedDispatches(config).map((entry) => entry.workflow);
  assert.ok(full.includes("trading-paper-bot.yml"), "a scan still wakes the paper bot");

  const live = plannedDispatches(config, { liveOnly: true });
  assert.deepEqual(live.map((entry) => entry.workflow), [
    "polymarket-live-limit-order-test.yml",
    "trading-live-5050.yml",
    "polymarket-live-limit-order-test.yml",
  ], "every live portfolio, and no paper work between scans");

  // The inputs have to be the same ones a scan sends, or a between-scans pass would be a
  // dry run, or would be logged as a person asking and ignore the automation switch.
  for (const entry of live) {
    assert.equal(entry.inputs.live_confirm, "true", "a dispatch without it rests nothing");
    assert.equal(entry.inputs.live_run_source, "AUTO", "this is the schedule, not a person");
  }
  assert.equal(live[2].inputs.live_portfolio_id, "live70",
    "a created portfolio must still write its own state rather than the shared account's");
});

test("the portfolios a scan leaves alone are left alone between scans too", () => {
  // The rules are the planner's, not a second copy: a portfolio that is archived, switched
  // off, or simply not in the config must not be traded three times as often as before.
  for (const config of [
    { live: { executionTrigger: "cron", automationEnabled: false } },
    { live5050: { executionTrigger: "cron", archived: true } },
    { live: {} },
    {},
  ]) {
    assert.deepEqual(plannedDispatches(config, { liveOnly: true }), [],
      `nothing may be dispatched for ${JSON.stringify(config)}`);
  }
});

test("the between-scans step runs only on the ticks that did not scan", () => {
  const start = PACER.indexOf("- name: Check the live portfolios between scans");
  assert.ok(start > 0, "the live tick must exist");
  const step = PACER.slice(start, PACER.indexOf("\n      - name:", start + 1));
  // Both dispatching on the same tick would run two live passes against one wallet.
  assert.match(step, /if: env\.scanned == 'false'/);
  assert.match(step, /--live-only/);
  // A tick that cannot dispatch must still hand the chain on: a stopped clock is silent.
  assert.match(step, /continue-on-error: true/);
  // And the scan step has to publish that flag on BOTH paths, or the live tick either never
  // fires or fires every time.
  const scan = PACER.slice(PACER.indexOf("- name: Wake the market scan"));
  assert.match(scan, /echo "scanned=false" >> "\$GITHUB_ENV"/);
  assert.match(scan, /echo "scanned=true" >> "\$GITHUB_ENV"/);
  // The pacer needs the repository on disk to run the planner at all.
  assert.match(PACER, /- uses: actions\/checkout@v4/);
});

test("the watchdog restarts the chain at the new tick, not the old one", () => {
  // The scan restarts a dead pacer. Restarting it with ten would put the live checks back
  // to once per scrape, silently, and only until the next outage would anyone see it.
  assert.match(DISPATCHER, /interval_minutes: "3", tick: "0"/);
  assert.doesNotMatch(DISPATCHER, /interval_minutes: "10"/);
});

test("a live-only tick does not restart the pacer it is running inside", () => {
  // The watchdog asks "is a pacer alive" and restarts one if not. Called from inside the
  // pacer the answer is yes, and a restart would be satisfied by the pacer's own
  // cancel-in-progress group cancelling the run that asked.
  assert.match(DISPATCHER, /if \(!liveOnly\) await ensurePacerIsRunning\(/);
});
