// Runs offline: dip_watch_market_is_live() is the REAL function out of api.php, executed by
// php. No network, no database, no host.
//
// Reported twice, the second time as "stale nemaji kandidaty ... neverim, ze to neni nejakou
// chybou". Measured on the live host before anything was changed:
//
//     2127 plan(s) watched: paper-newportfolio5=709, paper-dip70=709, paper-dip70live=709
//     ... already past their resolution date: 2070 (97%)
//     ... carrying no resolution date at all: 0
//     143 dips recorded for this portfolio -- 141 refused as "market already ended"
//
// The watch admitted a market on observation_event_is_running() alone, which asks only
// whether the kickoff has passed. Polymarket can take days to mark a finished fixture
// RESOLVED, so a match that ended on Tuesday was still "running" on Friday, and its price
// decaying towards 0 or 1 as the result became known read as exactly the collapse this rule
// buys.
//
// Two ways that starves the portfolios. The recorded dips are settlements, refused one by one
// at fire time; and every one of those tokens rides the worker's one-second /books request
// (rpi-live-exit-worker.mjs: `[...candidates.map(...), ...dipTokens]`), which is the request
// the live stop loss reads its prices from.

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API = readFileSync(new URL("../api.php", import.meta.url), "utf8");

// api.php require_once's storage.php from its own directory. Nothing on this path touches
// the database, so an empty stub is the whole of it.
function runPhp(expression) {
  const directory = mkdtempSync(join(tmpdir(), "dip-watch-window-"));
  try {
    const cut = API.indexOf("\ntry {");
    assert.ok(cut > 0, "api.php still ends with its request dispatch");
    writeFileSync(join(directory, "storage.php"), "<?php\n");
    writeFileSync(join(directory, "definitions.php"), API.slice(0, cut) + "\n");
    return JSON.parse(execFileSync("php", ["-r",
      `require '${join(directory, "definitions.php")}';`
      + ` echo json_encode(${expression});`,
    ], { encoding: "utf8" }));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const NOW = Math.floor(Date.parse("2026-09-18T18:00:00Z") / 1000);
const at = (hours) => new Date((NOW + hours * 3600) * 1000).toISOString();

function admits(item) {
  return runPhp(`dip_watch_market_is_live(${phpArray(item)}, ${NOW})`);
}

function phpArray(item) {
  return `json_decode(base64_decode('${Buffer.from(JSON.stringify(item)).toString("base64")}'), true)`;
}

// A fixture that kicked off an hour ago and settles in three. The market the rule exists for.
const UNDER_WAY = { eventStartTime: at(-1), resolutionEndDate: at(3) };

test("a fixture under way is watched", () => {
  assert.equal(admits(UNDER_WAY), true);
});

test("a fixture that already settled is not watched", () => {
  // The reported case, and 97% of what the watch was holding: kicked off three days ago,
  // resolution date two days past, still unmarked by Polymarket.
  assert.equal(admits({ eventStartTime: at(-72), resolutionEndDate: at(-48) }), false);
});

test("BAIT: without the upper bound the settled fixture is watched", () => {
  // What the code did before, in its own words. If this ever passes, the bound is gone and
  // the test above is proving nothing.
  const before = runPhp(
    `observation_event_is_running(${phpArray({ eventStartTime: at(-72), resolutionEndDate: at(-48) })})`);
  assert.equal(before, true,
    "the old admission test really did admit a fixture two days past its resolution");
});

test("a fixture that has not kicked off is not watched", () => {
  assert.equal(admits({ eventStartTime: at(2), resolutionEndDate: at(6) }), false);
});

test("BAIT: the bound is read from resolutionEndDate, never from endDate", () => {
  // The trap this bound had to be written around. For a sports fixture the bot substitutes
  // the KICKOFF into endDate, so a bound on that field rejects every match in play -- which
  // is every market the rule wants. Here endDate says the market ended an hour ago because
  // that is when the match STARTED.
  //
  // The row that catches it carries NO resolutionEndDate. Written the other way -- both
  // fields present -- the bait proved nothing: `resolutionEndDate ?? endDate` never reaches
  // its fallback while the first field is set, and the wrong implementation passed. The
  // fallback is the whole risk, so the fixture has to be the shape that reaches it, and
  // `resolutionEndDate ?? endDate` is precisely what api.php:6212 writes three hundred lines
  // below, which is where the habit would come from.
  assert.equal(admits({ eventStartTime: at(-1), endDate: at(-1) }), true,
    "a match in play must stay watched when endDate holds its kickoff and nothing else is set");
  assert.equal(admits({ eventStartTime: at(-1), endDate: at(-6) }), true,
    "and however far back that kickoff reads");
  // And with both present the resolution date is the one that decides, either way round.
  assert.equal(admits({ eventStartTime: at(-1), endDate: at(-1), resolutionEndDate: at(3) }), true);
  assert.equal(admits({ eventStartTime: at(-3), endDate: at(9), resolutionEndDate: at(-1) }), false,
    "a settled market is not rescued by an endDate in the future");
});

test("BAIT: a stale daysToResolution must not retire a live fixture", () => {
  // observation_hours_to_resolution() falls back to daysToResolution, which is frozen at
  // scan time: a row scanned on the morning of the match reads 0 days for as long as it is
  // stored. Using that helper here would drop the match the moment it kicked off.
  assert.equal(admits({ eventStartTime: at(-1), daysToResolution: 0 }), true,
    "with no resolution date the frozen day count must not decide it");
  assert.equal(admits({ eventStartTime: at(-1), daysToResolution: -3 }), true);
});

test("a market with no resolution date at all is still watched", () => {
  // A missing date is not evidence that a fixture is over. The measurement found none of
  // these in the watch, so leniency costs nothing and guessing could cost the rule.
  assert.equal(admits({ eventStartTime: at(-1) }), true);
});

test("the boundary belongs to the finished side", () => {
  assert.equal(admits({ eventStartTime: at(-1), resolutionEndDate: at(0) }), false);
  assert.equal(admits({ eventStartTime: at(-1), resolutionEndDate: at(0.01) }), true);
});

test("an unparseable resolution date does not retire the market", () => {
  assert.equal(admits({ eventStartTime: at(-1), resolutionEndDate: "not a date" }), true);
  assert.equal(admits({ eventStartTime: at(-1), resolutionEndDate: "" }), true);
});

test("the watch loop applies it, and no longer admits on the kickoff alone", () => {
  // The fix is only a fix if the caller uses it. This is the line that built 2127 plans.
  const start = API.indexOf("function live_dip_entry_watch_payload()");
  assert.ok(start > 0, "the watch builder must exist");
  const body = API.slice(start, API.indexOf("\n}\n", start));
  assert.match(body, /if \(!dip_watch_market_is_live\(\$item\)\) \{/,
    "the loop must ask the bounded question");
  assert.ok(!/if \(!observation_event_is_running\(\$item\)\) \{/.test(body),
    "and must no longer admit on the kickoff alone");
});

test("the fall the rule buys is judged on price, not on the clock", () => {
  // Guard against over-correcting. The bound retires SETTLED markets; it must not start
  // second-guessing the band, which is the rule itself and belongs to the portfolio.
  const start = API.indexOf("function dip_watch_market_is_live(");
  const body = API.slice(start, API.indexOf("\n}\n", start));
  for (const foreign of ["dipEntryOpenMin", "dipEntryOpenMax", "minProbability", "maxProbability"]) {
    assert.ok(!body.includes(foreign), `${foreign} is the portfolio's business, not this bound's`);
  }
});
