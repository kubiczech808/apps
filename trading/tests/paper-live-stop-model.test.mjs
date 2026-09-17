// Runs offline: a local stub stands in for the hosting and the probe is executed as a real
// process against it. No secrets, no network beyond localhost.
//
// Tested before being trusted, for the reason recorded twice already in this repo: a probe
// that misreads the payload answers every question with "nothing here", which is
// indistinguishable from the finding it is looking for. This one decides whether three paper
// portfolios' results are real, so answering "no difference" by accident would end the
// investigation in exactly the wrong place.

import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";

// Asynchronous: execFileSync blocks the loop the stub answers on, and the test would hang.
const run = promisify(execFile);
const TOOL = new URL("../tools/paper-live-stop-model-probe.mjs", import.meta.url).pathname;

// Two portfolios. One books losing positions at its stop floor -- the assumption under
// test -- and one never has, so the probe must not report a difference where there is none.
const STATE = {
  paperPortfolios: {
    underway: {
      displayName: "0809 55+ underway + SL",
      trades: [
        // Booked at the floor: settled at zero, cost $5, and the floor capped it at -$2.20.
        { status: "STOP_LOSS", closedAt: "2026-09-16T10:00:00Z", stopLossStatus: "FILLED_AT_FLOOR", realizedPnlUsdc: -2.2, totalCostUsdc: 5 },
        { status: "STOP_LOSS", closedAt: "2026-09-16T11:00:00Z", stopLossStatus: "FILLED_AT_FLOOR", realizedPnlUsdc: -2.4, totalCostUsdc: 5 },
        // A real sale into a real book, and a win. Neither is affected by the assumption.
        { status: "STOP_LOSS", closedAt: "2026-09-16T12:00:00Z", stopLossStatus: "FILLED", realizedPnlUsdc: -1.8, totalCostUsdc: 5 },
        { status: "WON", closedAt: "2026-09-16T13:00:00Z", realizedPnlUsdc: 4.1, totalCostUsdc: 5 },
        // Still open: not a closed trade and must not be counted as one.
        { status: "OPEN", realizedPnlUsdc: 0, totalCostUsdc: 5 },
      ],
    },
    plain: {
      displayName: "plain portfolio",
      trades: [{ status: "LOST", closedAt: "2026-09-16T10:00:00Z", realizedPnlUsdc: -5, totalCostUsdc: 5 }],
    },
  },
};

async function probeOutput(env = {}) {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(STATE));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { stdout } = await run("node", [TOOL], {
      env: { ...process.env, TRADING_HOST: `http://127.0.0.1:${server.address().port}`, ...env },
    });
    assert.doesNotMatch(stdout, /probe stopped early/);
    return stdout;
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("stop model probe: it prices the resting-stop assumption per portfolio", async () => {
  const output = await probeOutput();

  // Two of four closed trades were booked at the floor. The open one is not closed, and the
  // FILLED one was a real sale -- counting either would overstate the finding.
  assert.match(output, /0809 55\+ underway \+ SL\s+4\s+2/,
    `four closed, two at the floor: ${output}`);

  // Booked -$4.60 against -$10.00 at settlement: the assumption is worth +$5.40 to this
  // portfolio, and that is the part with no live counterpart.
  assert.match(output, /-\$4\.60/);
  assert.match(output, /-\$10\.00/);
  assert.match(output, /\+\$5\.40/);
  assert.match(output, /2 of 4 closed trades \(50\.0%\), worth \+\$5\.40/);

  // And the portfolio that never used it shows zero rather than being left out, because an
  // absent row and a zero row mean opposite things.
  assert.match(output, /plain portfolio\s+1\s+0/);

  // The sentence that says what the number means, so the reader does not have to infer it.
  assert.match(output, /no live counterpart/);

  // The closing section is the one a reader acts on, so it lists only portfolios the
  // assumption actually moves. A zero in the table is information; a zero in the list of
  // movers is a portfolio sent for investigation that has nothing to investigate.
  const movers = output.slice(output.indexOf("the portfolios this actually moves"));
  assert.match(movers, /0809 55\+ underway \+ SL/);
  assert.doesNotMatch(movers, /plain portfolio/,
    "a portfolio with no floor fills is not moved by the assumption and must not be listed");
});

test("stop model probe: a focus filter narrows it without changing the arithmetic", async () => {
  const output = await probeOutput({ PROBE_PORTFOLIOS: "underway" });
  assert.match(output, /0809 55\+ underway \+ SL/);
  assert.doesNotMatch(output, /plain portfolio/);
  assert.match(output, /\+\$5\.40/, "the focused figure must be the same figure");
});
