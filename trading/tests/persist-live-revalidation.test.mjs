// Runs offline: the real script is executed against a stub host on localhost. No FTP, no
// credentials, no production endpoint is touched.
//
// The step this script runs in was the most expensive one in a live execution: 39 seconds
// of 101, measured on run 35262648170, against 5 seconds for the decision and the order
// together. It cost that because the catalogue travelled -- both segments pulled down over
// FTP, a handful of rows patched, the whole thing pushed back. The merge now lives in
// api.php and only the verdicts travel.
//
// What these tests hold onto is the part that must not change: a run's verdicts are either
// persisted or the step fails loudly. Every verdict that goes missing is a candidate the
// next pass pays a live market fetch to reject all over again, which is the exact fault the
// script was written to fix.
//
// execFile, not execFileSync: the stub host runs in this process, and a synchronous child
// blocks the event loop that has to answer it.

import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const TOOL = new URL("../tools/persist-live-revalidation.py", import.meta.url).pathname;
const SOURCE = readFileSync(TOOL, "utf8");
const KEY = "test-trigger-key";

const UPDATES = [
  {
    tokenId: "aaa",
    checkedAt: "2026-09-17T12:40:00.000Z",
    marketPrice: 0.71,
    annualizedReturn: 1.1,
    verdict: "PRICE_MOVED",
  },
  { tokenId: "bbb", checkedAt: "2026-09-17T12:40:01.000Z", marketGone: true },
];

// Serves a queued list of answers and records every request it was sent. The last answer
// repeats, so a retry that is meant to succeed has something to succeed against.
async function withHost(answers, body) {
  const seen = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      seen.push({
        method: request.method,
        url: request.url,
        key: request.headers["x-trading-trigger-key"],
        contentType: request.headers["content-type"],
        bytes: raw.length,
        body: raw ? JSON.parse(raw) : null,
      });
      const answer = answers[Math.min(seen.length - 1, answers.length - 1)];
      response.writeHead(answer.status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(answer.payload ?? {}));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/api.php?action=live-revalidation-merge`;
  try {
    return { seen, ...(await body(url)) };
  } finally {
    server.close();
  }
}

// Runs the tool for real and hands back what it printed, what it exited with, and what the
// host was sent.
function persist({
  answers = [{ status: 200, payload: { ok: true, merged: 2, segments: ["evaluations", "observations"], closedOut: ["bbb"] } }],
  revalidationUpdates = UPDATES,
  key = KEY,
  writeState = true,
} = {}) {
  return withHost(answers, async (url) => {
    const directory = mkdtempSync(join(tmpdir(), "persist-revalidation-"));
    try {
      const statePath = join(directory, "live-execution-state.json");
      if (writeState) {
        writeFileSync(statePath, JSON.stringify({ at: "2026-09-17T12:40:02.000Z", revalidationUpdates }));
      }
      const environment = {
        ...process.env,
        LIVE_EXECUTION_STATE_FILE: statePath,
        LIVE_REVALIDATION_MERGE_URL: url,
        // A proxy in the environment would send localhost requests somewhere else entirely.
        no_proxy: "127.0.0.1,localhost",
        NO_PROXY: "127.0.0.1,localhost",
      };
      if (key === null) delete environment.TRADING_TRIGGER_KEY;
      else environment.TRADING_TRIGGER_KEY = key;

      try {
        const { stdout } = await run("python3", [TOOL], { env: environment });
        return { code: 0, output: stdout };
      } catch (error) {
        return { code: error.code ?? 1, output: `${error.stdout || ""}${error.stderr || ""}` };
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("the verdicts are sent, and only the verdicts", async () => {
  const { code, output, seen } = await persist();
  assert.equal(code, 0, `the step must succeed: ${output}`);
  assert.equal(seen.length, 1, "one request, not one per segment");

  const [request] = seen;
  assert.equal(request.method, "POST");
  assert.equal(request.key, KEY, "the merge writes the shortlist and is authenticated");
  assert.equal(request.contentType, "application/json");
  assert.deepEqual(request.body.updates, UPDATES, "the verdicts arrive exactly as recorded");
  assert.deepEqual(Object.keys(request.body), ["updates"],
    "the verdicts and nothing else: the execution state carries the whole run beside them");

  // The point of the change: what travels is a few hundred bytes, not the 8,091-row
  // catalogue. A kilobyte ceiling is far above a real run's verdicts and far below any
  // version of this that has started shipping rows again.
  assert.ok(request.bytes < 1024, `the catalogue must not travel: ${request.bytes} bytes sent`);

  assert.match(output, /Persisted 2 live revalidation updates into evaluations, observations/);
  assert.match(output, /Closed out 1 rows whose market no longer exists/,
    "a closed-out market is the reason this step exists; it has to be in the run log");
});

test("a run with nothing to persist does not call the endpoint at all", async () => {
  const { code, output, seen } = await persist({ revalidationUpdates: [] });
  assert.equal(code, 0);
  assert.equal(seen.length, 0, "an empty merge is a request the shared host does not need");
  assert.match(output, /No candidates were revalidated/);
});

test("a run that produced no execution state is not an error", async () => {
  // Every live workflow runs this step with `if: always()`, including passes that decided
  // nothing. That is not a failure and must not be reported as one.
  const { code, output, seen } = await persist({ writeState: false });
  assert.equal(code, 0);
  assert.equal(seen.length, 0);
  assert.match(output, /No live execution state was generated/);
});

test("a transient failure is retried rather than losing the run's verdicts", async () => {
  const { code, output, seen } = await persist({
    answers: [
      { status: 502, payload: { ok: false, error: "bad gateway" } },
      { status: 200, payload: { ok: true, merged: 2, segments: ["evaluations"], closedOut: [] } },
    ],
  });
  assert.equal(code, 0, `the retry must carry the step: ${output}`);
  assert.equal(seen.length, 2);
  // Re-sending is only safe because the merge is idempotent: a stored verdict newer than
  // the arriving one wins, so the same updates twice land the same way once.
  assert.deepEqual(seen[0].body.updates, seen[1].body.updates);
  assert.match(output, /attempt 1 failed/);
  assert.match(output, /Persisted 2 live revalidation updates/);
});

test("an endpoint that keeps refusing fails the step loudly", async () => {
  // The failure mode that matters. Verdicts that are silently dropped leave every candidate
  // this pass rejected sitting READY, to be fetched and rejected again by the next one --
  // which is the bug this script exists to prevent, back in a quieter form.
  const { code, output, seen } = await persist({
    answers: [{ status: 403, payload: { ok: false, error: "Invalid storage administration key." } }],
  });
  assert.notEqual(code, 0, "an unpersisted run must not report success");
  assert.equal(seen.length, 3, "and it must have tried more than once before giving up");
  assert.match(output, /Revalidation merge failed/);
  assert.match(output, /Invalid storage administration key/, "the server's reason has to reach the log");
});

test("a 200 that says ok:false is a failure, not a success", async () => {
  // A refusal does not have to arrive as an HTTP error, and reading the status alone would
  // report a run as persisted when nothing was written.
  const { code, output } = await persist({
    answers: [{ status: 200, payload: { ok: false, error: "The paper state could not be read." } }],
  });
  assert.notEqual(code, 0);
  assert.match(output, /The paper state could not be read/);
});

test("tokens the catalogue no longer holds are reported, not treated as a failure", async () => {
  // A market that has already been closed out, or aged out of the retention window, merges
  // into nothing. That is an ordinary outcome and the run should stay green.
  const { code, output } = await persist({
    answers: [{ status: 200, payload: { ok: true, merged: 0, segments: [], closedOut: [] } }],
  });
  assert.equal(code, 0);
  assert.match(output, /no longer present in remote evaluation or scraped market state/);
});

test("a missing key is refused before anything is sent", async () => {
  const { code, output, seen } = await persist({ key: null });
  assert.notEqual(code, 0);
  assert.equal(seen.length, 0, "an unauthenticated request would only be refused anyway");
  // "Not configured" and "rejected" need different fixes, and the log is where that is told.
  assert.match(output, /TRADING_TRIGGER_KEY is not configured/);
});

test("the catalogue is no longer fetched over FTP by anyone", async () => {
  // The saving is the transfer that no longer happens. A script that still opened the
  // connection would keep paying for it whatever the endpoint did.
  assert.doesNotMatch(SOURCE, /\bftplib\b/, "the FTP round trip is what this replaced");
  assert.doesNotMatch(SOURCE, /HOSTING_FTP_PASSWORD/, "and the step no longer needs the credentials");

  const { readFile } = await import("node:fs/promises");
  for (const [workflow, step] of [
    ["polymarket-live-limit-order-test.yml", "Persist current live market verification"],
    ["trading-live-5050.yml", "Persist current 5050 market verification"],
  ]) {
    const source = await readFile(new URL(`../../.github/workflows/${workflow}`, import.meta.url), "utf8");
    const start = source.indexOf(step);
    assert.ok(start > 0, `${workflow} must still run the persist step`);
    const body = source.slice(start, source.indexOf("\n      - name:", start + 1));
    assert.match(body, /persist-live-revalidation\.py/);
    assert.doesNotMatch(body, /HOSTING_FTP_/,
      `${workflow} still hands the persist step FTP credentials it cannot use`);
  }
});
