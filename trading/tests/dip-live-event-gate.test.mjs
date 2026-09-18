// Runs offline: the bot's real running-fixture test is EXECUTED, and the probe is checked
// against it. No network.
//
// Reported twice: "dip 70+ to 30-56 execution candidates ... 0 ready", and a live trade the
// owner held that the paper dip portfolio never took.
//
// Measured on production today, for newportfolio5:
//
//   evaluatedCount 149, eligibleCount 0, "no candidates passed dip portfolio filters"
//   143 dips recorded, 141 of them on markets that had ALREADY ENDED
//   2 survived every gate the probe applied -- both ending 2026-09-24, six days out
//   liveEventMode: "only"
//
// So eligibleCount 0 is not a shortlist bug. The portfolio trades running fixtures only, and
// the two survivors had not kicked off. The probe was the thing that was wrong: it did not
// apply that gate and therefore called them "WOULD BE READY", which is what sent me looking
// for a fault in the bot.
//
// A probe that over-reports readiness costs an investigation every time it is read, so the
// gate it applies has to be the gate the bot applies.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const BOT = readFileSync(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");
const PROBE = readFileSync(new URL("../tools/dip-shortlist-probe.mjs", import.meta.url), "utf8");

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} must exist`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, `${name} must be complete`);
  return source.slice(start, end + 2);
}

// Lifted from the probe rather than restated. The first version of this test copied the
// function into the harness and said the two could not drift -- so changing the probe
// changed nothing here, and the bait for "cannot tell treated as running" passed against a
// copy that was never touched. A test that carries its own duplicate of the code is testing
// the duplicate.
function extractArrow(source, name) {
  const start = source.indexOf(`const ${name} = (`);
  assert.ok(start > 0, `${name} must exist in the probe`);
  const end = source.indexOf("\n  };", start);
  assert.ok(end > start, `${name} must be complete`);
  return source.slice(start, end + 5);
}

const NOW = Date.parse("2026-09-18T13:47:00Z");

// The bot's own answer, and the probe's, side by side on the same rows.
const harness = new Function(`
  ${extractFunction(BOT, "rowEventIsRunning")}
  ${extractFunction(BOT, "rowEventStartKnown")}
  const now = ${NOW};
  ${extractArrow(PROBE, "running")}
  return { botRunning: rowEventIsRunning, botKnows: rowEventStartKnown, probeRunning: running };
`)();

const ROWS = {
  kickedOff: { eventStartTime: "2026-09-18T13:00:00Z" },
  notYet: { eventStartTime: "2026-09-24T16:00:00Z" },
  flaggedRunning: { eventStarted: true },
  flaggedNotRunning: { eventStarted: false },
  silent: { question: "no timing at all" },
};

test("the probe answers the running question the same way the bot does", () => {
  // Where the bot can answer, the probe must agree. Disagreement here is a probe that
  // reports readiness the executor will refuse -- which is what happened.
  for (const [name, row] of Object.entries(ROWS)) {
    if (!harness.botKnows(row)) continue;
    assert.equal(harness.probeRunning(row), harness.botRunning(row),
      `${name}: the probe and the bot must agree on whether the fixture is running`);
  }
});

test("a fixture six days out is not running, which is the case that was misreported", () => {
  // Both survivors on production ended 2026-09-24. The probe called them ready.
  assert.equal(harness.probeRunning(ROWS.notYet), false);
  assert.equal(harness.botRunning(ROWS.notYet), false);
});

test("a row with no timing at all is 'cannot tell', not 'not running'", () => {
  // The bot treats the absence as not running and refuses the row; the probe reports it
  // separately, because "the portfolio will not trade this" and "this dip recorded nothing
  // to judge it by" call for different fixes.
  assert.equal(harness.probeRunning(ROWS.silent), null, "the probe must say it cannot tell");
  assert.equal(harness.botRunning(ROWS.silent), false, "while the bot refuses it");
});

test("BAIT: the probe must actually apply the gate before calling a dip ready", () => {
  // The whole finding. Without this the probe reports rows as WOULD BE READY that the bot
  // rejects outright, and every reading of it starts a hunt for a fault that is not there.
  const readyBlock = PROBE.slice(PROBE.indexOf("if ((rule.buyMin != null"),
    PROBE.indexOf("readyRows.push(hit)"));
  assert.match(readyBlock, /liveEventMode === "only"/,
    "the running-fixture gate must be applied before a row is counted ready");
  assert.match(readyBlock, /notRunning \+= 1/);
  assert.match(readyBlock, /startUnknown \+= 1/,
    "and 'cannot tell' must be counted apart from 'has not started'");
  assert.ok(readyBlock.indexOf("liveEventMode") < readyBlock.indexOf("ready += 1"),
    "the gate must come before the count, not after it");
});

test("the bot rejects a non-running row under 'only', which is what the gate mirrors", () => {
  // Pinned to the bot so the probe's copy is known to mirror a rule that still exists.
  assert.match(BOT, /if \(liveEventMode === "only" && !eventIsRunning\) \{/,
    "the executor's own refusal must still be there");
});
