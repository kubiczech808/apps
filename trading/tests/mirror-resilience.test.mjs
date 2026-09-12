// Runs offline: no secrets, no network, no database.
//
// The mirror is the only thing that puts the catalogue into the database, and it is optional
// by design -- reads come from the JSON files until the storage is explicitly activated, so
// a mirror that stops has no symptom. Measured on production: every scan and bot pass
// reported the step as a success while the database went two hours without a write.
//
// The cause was one request carrying the state document, every portfolio, a thousand events
// and two thousand trades, sent BEFORE the 27 observation batches. When it failed it unwound
// the whole function, the catalogue was never sent, and the step exited 0.
//
// So this drives the script for real with urllib stubbed: one part is made to fail, and what
// is asserted is that everything else still went.

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = new URL("../tools/ingest-trading-state.py", import.meta.url).pathname;

// Runs main() with urllib.request.urlopen replaced, so every POST the script makes is
// recorded and can be made to fail on demand. Returns what it sent and what it printed.
function runMirror({ failOn = [], observations = 700, trades = 0 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "mirror-"));
  mkdirSync(join(directory, "data"), { recursive: true });
  const stateFile = join(directory, "data", "paper-state.json");
  const observationsFile = join(directory, "data", "observations.json");

  writeFileSync(observationsFile, JSON.stringify({
    marketObservations: Array.from({ length: observations }, (_, index) => ({
      id: `m${index}`,
      tokenId: `${index}`,
      status: "SCRAPED",
      marketProbability: 0.7,
    })),
  }));
  writeFileSync(stateFile, JSON.stringify({
    stateSegments: { observations: { file: "observations.json" } },
    marketScanHistory: [],
    paperPortfolios: {},
    trades: Array.from({ length: trades }, (_, index) => ({ id: `t${index}` })),
  }));

  const harness = join(directory, "harness.py");
  // Everything the script says goes to stdout, its own stderr included: one stream to read,
  // and execFileSync hands back stdout on a clean exit but stderr only on a throw.
  writeFileSync(harness, `
import json, sys, runpy, urllib.request
sys.stderr = sys.stdout
sent = []
FAIL_ON = json.loads(${JSON.stringify(JSON.stringify(failOn))})

class Response:
    def __init__(self, body): self._body = body
    def read(self): return self._body
    def __enter__(self): return self
    def __exit__(self, *a): return False

def fake_urlopen(request, timeout=None):
    payload = json.loads(request.data.decode("utf-8"))
    part = next((k for k in ("state", "paperPortfolios", "events", "trades", "observations") if k in payload), "?")
    count = len(payload[part]) if isinstance(payload.get(part), list) else 1
    sent.append({"part": part, "count": count})
    if part in FAIL_ON:
        raise OSError("stubbed failure for " + part)
    return Response(json.dumps({"ok": True, "ingest": {"observations": count}}).encode("utf-8"))

urllib.request.urlopen = fake_urlopen
sys.argv = ["ingest-trading-state.py"]
code = 0
try:
    runpy.run_path(${JSON.stringify(SCRIPT)}, run_name="__main__")
except SystemExit as exit:
    code = exit.code or 0
print("HARNESS " + json.dumps({"exit": code, "sent": sent}))
`);

  let stderr = "";
  let stdout = "";
  try {
    stdout = execFileSync("python3", [harness], {
      encoding: "utf8",
      env: {
        ...process.env,
        TRADING_STORAGE_MIRROR_ENABLED: "true",
        TRADING_STORAGE_INGEST_URL: "https://example.invalid/api.php?action=storage-ingest",
        TRADING_TRIGGER_KEY: "test-key",
        TRADING_STORAGE_INGEST_TARGET: "paper",
        TRADING_STORAGE_STATE_FILE: stateFile,
        TRADING_STORAGE_INGEST_REQUIRED: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    stdout = String(error.stdout || "");
    stderr = String(error.stderr || "");
  }
  const output = `${stdout}\n${stderr}`;
  const line = /HARNESS (\{.*\})/.exec(output);
  assert.ok(line, `the harness must report what it sent. output: ${output}`);
  return { ...JSON.parse(line[1]), output };
}

test("mirror: the catalogue is sent even when the state document fails", () => {
  // The exact production failure. 700 observations is three batches of 300; every one of
  // them used to be skipped because the request before them raised.
  const failed = runMirror({ failOn: ["state"] });
  const observationBatches = failed.sent.filter((entry) => entry.part === "observations");
  assert.equal(observationBatches.length, 3,
    `the catalogue must still be mirrored: ${JSON.stringify(failed.sent)}`);
  assert.equal(observationBatches.reduce((total, entry) => total + entry.count, 0), 700);

  // And it must say so rather than exiting quietly: a mirror that stops has no other symptom.
  assert.match(failed.output, /mirror INCOMPLETE/i,
    `an incomplete mirror must be reported. stderr: ${failed.output}`);
});

test("mirror: one failed catalogue batch does not cancel the batches after it", () => {
  const partial = runMirror({ failOn: [] });
  assert.equal(partial.sent.filter((entry) => entry.part === "observations").length, 3);
  assert.doesNotMatch(partial.output, /mirror INCOMPLETE/i,
    "a clean run must not claim to be incomplete");
  assert.equal(partial.exit, 0);
});

test("mirror: the state document no longer rides with the portfolios, events and trades", () => {
  // One request carrying all four is the shape that failed. They are separate parts now,
  // and separate parts are what makes a single failure survivable.
  const clean = runMirror({ failOn: [] });
  const parts = clean.sent.map((entry) => entry.part);
  const combined = clean.sent.filter((entry) => entry.part === "state").length;
  assert.equal(combined, 1, `the state document is sent once: ${JSON.stringify(parts)}`);
  assert.ok(parts.includes("paperPortfolios"), `portfolios are their own part: ${JSON.stringify(parts)}`);
  assert.ok(parts.includes("events"), `events are their own part: ${JSON.stringify(parts)}`);
});

test("mirror: a retried part is only reported as failed when the retry also fails", () => {
  // try_post retries once. A part that fails twice is a real failure and must be named.
  const failed = runMirror({ failOn: ["events"] });
  assert.match(failed.output, /mirror INCOMPLETE.*events/is,
    `the failing part must be named: ${failed.output}`);
  // Two attempts for the failing part, and everything else still went.
  assert.equal(failed.sent.filter((entry) => entry.part === "events").length, 2);
  assert.equal(failed.sent.filter((entry) => entry.part === "observations").length, 3);
});
