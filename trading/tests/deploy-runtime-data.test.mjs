// Runs offline: the deploy workflow's own Python function is extracted and EXECUTED against
// the data paths api.php actually writes. Nothing is deployed and nothing is read from the
// network.
//
// This has now destroyed runtime state four times, and the comments in the workflow record
// three of them: the paper state segments, the 5050 portfolio's entire run-log history, and
// every portfolio's archived run log. Each time the fix was to add one more name to a
// hand-maintained list, and each time the list went stale the moment somebody added a file.
//
// The fourth was reported as "two of my dip portfolios cannot catch any trade". Measured:
// the RPi worker recorded real dips at 03:40-03:44 -- DIP_ENTRY_PAPER_RECORDED, three
// portfolios, prices inside their bands -- and the hits endpoint answered zero at 04:26.
// Nothing removes hits but a 48-hour TTL. What removed them was three deploys of the site
// between 03:50 and 03:58, because dip-entry-hits.json was not on the list. The paper bot
// reads on the hour and found an empty file every time.
//
// So the list is no longer maintained by hand. This test derives the truth from api.php --
// every path it writes under data/ is runtime state by definition, because the deploy
// uploads nothing there -- and fails if the workflow would delete any of them.

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WORKFLOW = new URL("../../.github/workflows/trading-deploy.yml", import.meta.url).pathname;
const API = readFileSync(new URL("../api.php", import.meta.url), "utf8");

// Every data path api.php names, reduced to the top-level entry a remote listing shows:
// "market-scan-history/x.ndjson" is deleted by removing "market-scan-history", so that is
// the name the cleanup decides on.
function runtimePathsApiWrites() {
  const names = new Set();
  for (const match of API.matchAll(/__DIR__ \. '\/data\/([^']+)'/g)) {
    const raw = match[1];
    const head = raw.split("/")[0];
    // A path built by concatenation -- 'live-' . $id . '-execution-state.json' -- appears
    // here as its literal prefix. Those are covered by the shape rule and are checked
    // through a concrete example below instead of as a fragment.
    if (!head || head.endsWith("-") || head === "") continue;
    names.add(head);
  }
  return [...names].sort();
}

// The workflow's own function, lifted out and run for real. Asserting on the source text
// instead would pass for a list that contains the right words in the wrong place.
function isRuntimeData(names) {
  const source = readFileSync(WORKFLOW, "utf8");
  const start = source.indexOf("          def is_runtime_data(name):");
  const end = source.indexOf("          def clean_data_dir(ftp):");
  assert.ok(start > 0 && end > start, "the deploy's runtime-data function must be findable");
  const body = source
    .slice(start, end)
    .split("\n")
    .map((line) => (line.startsWith("          ") ? line.slice(10) : line))
    .join("\n");

  const directory = mkdtempSync(join(tmpdir(), "deploy-keep-"));
  try {
    const script = join(directory, "check.py");
    writeFileSync(script, `${body}\nimport json, sys\n`
      + "print(json.dumps({name: bool(is_runtime_data(name)) for name in json.loads(sys.argv[1])}))\n");
    return JSON.parse(execFileSync("python3", [script, JSON.stringify(names)], { encoding: "utf8" }));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("deploy: every data file the application writes survives a deploy", () => {
  const names = runtimePathsApiWrites();
  // A guard on the guard: if the extraction stops finding paths, the test would pass by
  // checking nothing at all -- which is precisely how a list goes stale unnoticed.
  assert.ok(names.length >= 10, `expected the data paths to be found, got ${JSON.stringify(names)}`);
  assert.ok(names.includes("dip-entry-hits.json"), "the reported case must be among them");

  const verdicts = isRuntimeData(names);
  const deleted = names.filter((name) => !verdicts[name]);
  assert.deepEqual(deleted, [],
    `these are written by api.php and would be DELETED by the next deploy: ${deleted.join(", ")}`);
});

test("deploy: the shape rules still cover the files that are not named literally", () => {
  // A live portfolio's execution state is built by concatenation, so no literal name for it
  // exists in api.php. 5050's was lost exactly this way -- the list named one portfolio and
  // the second was added later -- so the shape rule is checked with a portfolio that has
  // never existed.
  const verdicts = isRuntimeData([
    "live-execution-state.json",
    "live-5050-execution-state.json",
    "live-someportfolionobodyhasmadeyet-execution-state.json",
    "paper-state.json",
    "paper-state.portfolio-underwaycopy.json",
    // And the other half: things that are NOT runtime state must still be cleaned, or this
    // test would pass by keeping everything and the deploy would stop tidying entirely.
    "old-build-artifact.js",
    "index.html.bak",
  ]);
  assert.equal(verdicts["live-someportfolionobodyhasmadeyet-execution-state.json"], true,
    "a portfolio added later must not have to be remembered");
  assert.equal(verdicts["paper-state.portfolio-underwaycopy.json"], true);
  assert.equal(verdicts["old-build-artifact.js"], false);
  assert.equal(verdicts["index.html.bak"], false);
});

// Every trading workflow that writes to the hosting has to share a lock with the workflows
// it can COLLIDE with -- and with those only.
//
// The lock exists because one constrained hosting account cannot take concurrent writes to
// the same file, so two writers in different groups is the fault it was built to prevent.
// It was one group for every writer, which was safe and was also starving the desk:
// measured over days, 90 of the last 100 paper bot runs were CANCELLED. A group allows one
// running plus one pending, the scan dispatches the paper bot AND both live executors
// within the same second, and the live dispatches -- arriving last -- took the pending slot
// every time. Spacing them inside the scan cannot help, because the scan holds the lock
// while it waits.
//
// So the boundary is now the files. The scan, the paper bot and the paper evaluation write
// paper-state*; the live executors and the account sync write live-*state*. This test is
// what stops that boundary being drawn anywhere else: it reads what each workflow writes
// and requires two writers to share a group exactly when they share a file.
test("hosting writes: two writers share a lock exactly when they share a file", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const directory = new URL("../../.github/workflows/", import.meta.url);
  const names = (await readdir(directory)).filter((name) => name.endsWith(".yml"));

  const writers = [];
  for (const name of names) {
    const source = await readFile(new URL(name, directory), "utf8");
    const match = /group:\s*(trading-hosting-write[^\n]*)/.exec(source);
    if (!match) continue;
    // Which state files this workflow WRITES -- read from the paths it publishes, not from
    // every mention of a file name. The first version of this matched any occurrence, and
    // the live workflow names paper-state in a READ url (PAPER_STATE_URL), which made it
    // look like a paper writer and required it to share the paper lock. Reads never
    // collide; only the uploads do.
    const files = new Set();
    for (const match of source.matchAll(/(?:_STATE_PATH|PUBLISH_FILES?|_PUBLISH_FILE):?\s*"?([^"\n,]+)/g)) {
      for (const part of match[1].split(",")) {
        const file = part.split(">")[0].trim().split("/").pop();
        if (/^(paper|live)[\w.-]*state[\w.-]*\.json$/.test(file)) files.add(file);
      }
    }
    // Both live executors publish live-state.json through PUBLISH_FILES built inline, and
    // the scan publishes paper state through its own uploader; those are named in the run
    // line rather than in an env block, so they are picked up here too.
    for (const match of source.matchAll(/(paper-state\.json|live-state\.json|live-[\w-]*execution-state\.json)/g)) {
      const at = match.index ?? 0;
      const line = source.slice(source.lastIndexOf("\n", at) + 1, source.indexOf("\n", at));
      if (/_URL|api\.php/.test(line)) continue;
      files.add(match[1]);
    }
    writers.push({ name, group: match[1].trim(), files });
  }
  assert.ok(writers.length >= 6, `expected every writer, got ${writers.map((w) => w.name).join(", ")}`);

  for (const writer of writers) {
    assert.match(writer.group, /\$\{\{ github\.ref \}\}/,
      `${writer.name}: the group must be keyed by ref, or two branches serialise against each other`);
    assert.ok(writer.files.size > 0, `${writer.name}: no state file could be read from it`);
  }

  // The rule itself, over every pair.
  for (const left of writers) {
    for (const right of writers) {
      if (left.name >= right.name) continue;
      const shared = [...left.files].filter((file) => right.files.has(file));
      const sameGroup = left.group === right.group;
      if (shared.length) {
        assert.ok(sameGroup,
          `${left.name} and ${right.name} both write ${shared.join(", ")} and must share a lock`);
      } else {
        assert.ok(!sameGroup,
          `${left.name} and ${right.name} write nothing in common, so sharing a lock only`
          + ` makes them cancel each other`);
      }
    }
  }

  // And the six known writers land on the two expected sides, so a rename cannot quietly
  // move one across.
  const groupOf = (name) => writers.find((writer) => writer.name === name)?.group;
  for (const name of ["trading-market-scan.yml", "trading-paper-bot.yml", "trading-paper-evaluation.yml"]) {
    assert.match(String(groupOf(name)), /trading-hosting-write-paper-/, `${name} writes paper state`);
  }
  for (const name of ["polymarket-live-limit-order-test.yml", "trading-live-5050.yml", "trading-live-account.yml"]) {
    assert.match(String(groupOf(name)), /trading-hosting-write-live-/, `${name} writes live state`);
  }
});
