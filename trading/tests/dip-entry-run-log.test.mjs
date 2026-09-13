// Runs offline: the bot's own exports are executed, no network, no secrets.
//
// Reported: three dip portfolios in paper, two of which never open anything, the entry
// parameters lowered a long way, and markets plainly visible in the candidates list. The run
// log said, every hour, for every cause:
//
//   Action  SKIP
//   Reason  No order placed: no candidate passed this portfolio's current rules.
//
// Measured on the account afterwards: three portfolios WATCHED with 26 prepared plans each,
// and zero dip hits recorded for any portfolio at all. So the configuration was right and
// the pipeline was empty -- a state that sentence cannot express, and which looks exactly
// like a portfolio whose filters are too tight.
//
// The candidates list is the other half of the misreading, and the system earned it. A dip
// portfolio's pool is NOT the catalogue: a collapsed favourite is not a row at all, because
// the scan keeps only the leading outcome above 0.50. The pool is what the RPi worker
// recorded. Seeing markets in candidates says nothing about it.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import * as bot from "../tools/paper-trading-bot.mjs";

const APP = readFileSync(new URL("../assets/app.js", import.meta.url), "utf8");

// A correctly configured dip portfolio: its own range is the buy band, and it sits strictly
// below the opening band, which is what the watch list requires.
const DIP = {
  id: "dip70",
  label: "dip 70+",
  selectionMetric: "expectedValueUsdc",
  dipEntryEnabled: true,
  dipEntryOpenMin: 0.7,
  dipEntryOpenMax: 0.8,
  minProbability: 0.3,
  maxProbability: 0.45,
};

const hit = (portfolioId) => ({
  portfolioId, tokenId: `${portfolioId}-1`, price: 0.38, openProbability: 0.74,
  question: "Team A vs Team B", outcome: "Team A", endDate: "2026-09-14T00:00:00Z",
});

test("dip run log: the three causes of an empty pool are three different sentences", () => {
  // 1. NOTHING RECORDED ANYWHERE. The state the account was actually in, and the one that
  //    reads as bad luck when it is a switch. It has to point at the worker.
  const quiet = bot.dipEntryRunDiagnostics(DIP, 0, []);
  assert.equal(quiet.recordedHits, 0);
  assert.equal(quiet.hitsAcrossPortfolios, 0);
  assert.match(quiet.reason, /LIVE_DIP_ENTRY_MODE/);
  assert.match(quiet.reason, /never the catalogue/,
    "the candidates-list misreading is the reported one and has to be answered in the log");

  // 2. RECORDED FOR OTHERS, NOT FOR THIS ONE. Same empty pool, opposite conclusion: the
  //    watcher is demonstrably running, so this is a wait rather than a fault.
  const waiting = bot.dipEntryRunDiagnostics(DIP, 0, [hit("paper-other"), hit("paper-other2")]);
  assert.equal(waiting.recordedHits, 0);
  assert.equal(waiting.hitsAcrossPortfolios, 2);
  assert.match(waiting.reason, /has fallen into its buy band yet/);
  assert.match(waiting.reason, /the watcher is running/);
  assert.doesNotMatch(waiting.reason, /LIVE_DIP_ENTRY_MODE/,
    "pointing at the switch when the switch is demonstrably on sends the reader to the Pi for nothing");

  // 3. RECORDED FOR THIS ONE AND FILTERED OUT. The pool was fed and the portfolio's other
  //    rules refused it, which is the only one of the three that is about the filters.
  const filtered = bot.dipEntryRunDiagnostics(DIP, 0, [hit("paper-dip70"), hit("paper-dip70"), hit("paper-other")]);
  assert.equal(filtered.recordedHits, 2, "hits are matched by `paper-<id>` and nothing else");
  assert.equal(filtered.hitsAcrossPortfolios, 3);
  assert.match(filtered.reason, /2 recorded dip\(s\) for this portfolio, 0 of which passed its other filters/);

  // 4. A CONFIGURATION FAULT. The portfolio is not even in the watch list, so no hit can
  //    ever arrive -- and no amount of waiting changes it. This is the one the run log must
  //    never leave looking like the others.
  const broken = bot.dipEntryRunDiagnostics({ ...DIP, maxProbability: 0.75 }, 0, [hit("paper-dip70")]);
  assert.match(broken.fault, /reaches into the opening band/);
  assert.match(broken.reason, /buys nothing at all/);
  assert.match(broken.reason, /probability maximum is below its opening band/,
    "a fault has to name the change that fixes it");

  // 5. AN ORDINARY PORTFOLIO GETS NONE OF THIS. A dip sentence on a portfolio with no dip
  //    rule would be worse than the generic one it replaced.
  assert.equal(bot.dipEntryRunDiagnostics({ id: "plain", label: "Plain" }, 0, [hit("paper-plain")]), null);
});

test("dip run log: the batch log carries it and the dashboard prints it", () => {
  const batch = (action, hits) => bot.buildTradeBatchLog({
    portfolioState: {}, strategy: DIP, evaluations: [], eligible: [], rankedEligible: [],
    action, reason: "no candidates passed dip 70+ portfolio filters", available: 100, stake: 5,
    dipEntryHits: hits,
  });

  // The block travels with the run, so the reason survives into the stored log rather than
  // being recomputed by whoever opens it later.
  const skip = batch("SKIP");
  assert.ok(skip.dipEntry, "every dip portfolio's batch log carries the block");
  assert.equal(skip.dipEntry.passedFilters, 0);

  // humanReason is printed verbatim by the dashboard ahead of its own wording, which is the
  // whole point: the bot knows why the pool was empty and the dashboard does not.
  assert.match(String(skip.humanReason), /^No order placed: /);
  assert.match(String(skip.humanReason), /LIVE_DIP_ENTRY_MODE/);
  assert.match(APP, /if \(batch\.humanReason\) return String\(batch\.humanReason\);/,
    "the dashboard has to prefer it, or the sentence is written and never read");

  // Only on a SKIP. A run that placed an order is not explaining an absence, and overriding
  // its reason with one would be actively wrong.
  assert.equal(batch("EXECUTE").humanReason, undefined);

  // And the detail line, so the numbers are visible even on a run that did trade.
  assert.match(APP, /const dipEntry = batch\.dipEntry \|\| null;/);
  assert.match(APP, /Dip entry: \$\{dipEntry\.recordedHits\} recorded for this portfolio/);
});
