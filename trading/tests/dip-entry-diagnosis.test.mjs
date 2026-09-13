// Runs offline: a local stub stands in for the hosting, and the diagnosis tool is executed
// as a real process against it. No secrets, no network beyond localhost.
//
// The reason this exists rather than "the tool looks right": the last read-only probe I
// wrote reported trades=0 against a 910 KB file because it assumed the wrong shape, and the
// only thing that caught it was running it against a fabricated payload first. A diagnostic
// that reads a field nobody publishes answers every question with "nothing here", which is
// indistinguishable from the fault it is looking for -- and that is the worst possible
// failure for a tool whose whole job is to tell those two apart.
//
// So each of the three states a dip portfolio can be in is fabricated here and driven
// through the tool, and the tool has to name the right one.

import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";

// Asynchronous on purpose. execFileSync blocks this process's event loop, and the stub
// below lives in this process -- so the child's first request would never be answered and
// the test would hang forever rather than fail. Measured: it did.
const run = promisify(execFile);

const TOOL = new URL("../tools/dip-entry-portfolio-diagnosis.mjs", import.meta.url).pathname;

// One portfolio per state, so a single run has to distinguish all three.
const CONFIG = {
  config: {
    paper: {
      // Watched, plans prepared, hits recorded: the rule working.
      dipworks: {
        displayName: "dip 70+ works", dipEntryEnabled: true,
        dipEntryOpenMin: 0.7, dipEntryOpenMax: 0.8,
        minProbability: 0.3, maxProbability: 0.45, automationEnabled: true,
      },
      // Watched and armed, but the worker has recorded nothing. Either it is not running or
      // no favourite has fallen yet -- and those are not a configuration fault.
      dipquiet: {
        displayName: "dip 70+ quiet", dipEntryEnabled: true,
        dipEntryOpenMin: 0.7, dipEntryOpenMax: 0.8,
        minProbability: 0.3, maxProbability: 0.5, automationEnabled: true,
      },
      // The configuration fault: the buy range reaches into the opening band, so the rule
      // would fire on a market that never fell and the payload refuses to watch it at all.
      dipoverlap: {
        displayName: "dip 70+ overlapping", dipEntryEnabled: true,
        dipEntryOpenMin: 0.7, dipEntryOpenMax: 0.8,
        minProbability: 0.5, maxProbability: 0.75, automationEnabled: true,
      },
    },
  },
};

const WATCH = {
  ok: true,
  generatedAt: "2026-09-13T05:00:00Z",
  portfolios: ["paper-dipworks", "paper-dipquiet"],
  plans: [
    { portfolioId: "paper-dipworks", tokenId: "1", question: "Team A vs Team B", blockedReason: "" },
    { portfolioId: "paper-dipquiet", tokenId: "2", question: "Team C vs Team D", blockedReason: "" },
    { portfolioId: "paper-dipquiet", tokenId: "3", question: "Team E vs Team F", blockedReason: "already holding this condition" },
  ],
};

const HITS = {
  ok: true,
  hits: [{ portfolioId: "paper-dipworks", tokenId: "1", price: 0.38, at: "2026-09-13T04:41:00Z" }],
};

const STATE = { paperPortfolios: {} };

async function stubHostOutput() {
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    const action = url.searchParams.get("action");
    const body = action === "portfolio-config" ? CONFIG
      : action === "dip-entry-watch" ? WATCH
        : action === "dip-entry-hits" ? HITS
          : action === "state" ? STATE
            : { ok: false, action };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { stdout } = await run("node", [TOOL], {
      env: { ...process.env, TRADING_HOST: `http://127.0.0.1:${server.address().port}` },
    });
    // A diagnostic that dies halfway prints its reason and exits 1, which would arrive here
    // as a throw. Reaching this line at all means it read every endpoint it asked for.
    assert.doesNotMatch(stdout, /diagnosis stopped early/);
    return stdout;
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("dip diagnosis: it separates a misconfigured portfolio from a quiet one", async () => {
  {
    const output = await stubHostOutput();
    const line = (needle) => output.split("\n").find((row) => row.includes(needle)) || "";

    // The whole point: three portfolios, three different answers. A tool that printed the
    // same thing for all three would be worse than nothing, because the run log already
    // does that -- "no candidate passed this portfolio's current rules", for every cause.
    assert.match(line("paper-dipworks"), /WATCHED/);
    assert.doesNotMatch(line("paper-dipworks"), /NOT WATCHED/);
    assert.match(line("paper-dipoverlap"), /NOT WATCHED/);

    // And the fault has to be NAMED, with the two numbers that produced it. "Not watched"
    // on its own sends someone to look at the worker, which is the wrong end entirely.
    assert.match(output, /its range reaches into the opening band \(max\s+75\.0% >= opening min\s+70\.0%\)/,
      `the overlap must be quantified: ${output}`);

    // The quiet one is armed and empty, and that must not read as a fault. Asserted against
    // the whole output rather than the first line naming the portfolio: that line is the
    // watch-list row, and matching it here passed for the wrong reason.
    assert.match(line("paper-dipquiet"), /WATCHED/);
    assert.match(output, /paper-dipquiet\s+0 hit\(s\)  <- nothing to open a position from/,
      `an armed portfolio with no hits must say so in section 4: ${output}`);
    assert.match(output, /LIVE_DIP_ENTRY_MODE=off/,
      "an armed portfolio with no hits has to point at the worker, not at the config");
    // And not ONLY at the worker. Measured on the account: the watcher was armed and
    // recording, and deploying the site was deleting the file it wrote to, so a conclusion
    // that named the switch alone was wrong in the one case this tool was written for.
    assert.match(output, /lost after being written/);
    assert.match(output, /DIP_ENTRY_PAPER_RECORDED before concluding the watcher is off/);

    // A prepared plan the payload itself blocked is shown with its reason -- otherwise a
    // portfolio with plans and no hits looks identical to one the worker never polled.
    assert.match(output, /blocked: already holding this condition/);

    // The counts have to come from the payload rather than from the portfolio list, or a
    // portfolio watching nothing reads the same as one watching ten markets.
    assert.match(output, /portfolios watching 2   plans prepared 3/);

    // The misreading that prompted all this, written where it will be read.
    assert.match(output, /the candidates list is NOT this pool/i);
  }
});

test("dip diagnosis: a hit that exists is attributed to the portfolio that will open it", async () => {
  {
    const output = await stubHostOutput();
    // Hits are matched by `paper-<id>` and nothing else -- the bot's own pool does the same
    // -- so an id that does not match produces a portfolio that watches, records, and still
    // never trades. Asserting the attribution is what makes the count trustworthy.
    assert.match(output, /paper-dipworks\s+1 hit\(s\)   newest 2026-09-13T04:41:00Z/);
    assert.match(output, /1 hit\(s\) on record/);
  }
});
