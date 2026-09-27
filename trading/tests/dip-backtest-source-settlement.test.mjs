// Runs offline: api.php's real settlement functions are EXECUTED against rows shaped like the
// archived observations dip-backtest-source streams. No network, no database, no credentials.
//
// Reported by sampling a swept dip cell that looked far too profitable to believe: "Exact
// Score: Maranhao AC MA 0 - 1 Brusque FC SC?" and "Exact Score: Maranhao AC MA 3 - 1 Brusque
// FC SC?" -- two mutually exclusive props on the SAME fixture -- both came out of the feed
// as finalOutcomePrice 1, i.e. both WIN. Only one final score can happen.
//
// dip_backtest_source_row() read finalOutcomePrice raw: whichever side was priced when the
// row was captured, not proven to be the side that actually settled. That is the exact fault
// resolved_stats_settled_outcome() already exists to fix for the folded resolved statistics --
// it just was never applied to this feed.

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API = readFileSync(new URL("../api.php", import.meta.url), "utf8");

function extractPhpFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start > 0, `${signature} must exist in api.php`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, "the function must be complete");
  return source.slice(start, end + 2);
}

const FUNCTIONS = [
  extractPhpFunction(API, "function resolved_stats_settled_outcome(array $item): ?int"),
  extractPhpFunction(API, "function dip_backtest_source_token(array $item): string"),
  extractPhpFunction(API, "function dip_backtest_source_row(array $item): ?array"),
].join("\n");

function sourceRow(item) {
  const dir = mkdtempSync(join(tmpdir(), "dip-source-row-"));
  const script = join(dir, "run.php");
  writeFileSync(script, `<?php
${FUNCTIONS}
$item = json_decode(${JSON.stringify(JSON.stringify(item))}, true);
$row = dip_backtest_source_row($item);
echo json_encode($row);
`);
  return JSON.parse(execFileSync("php", [script], { encoding: "utf8" }));
}

const base = {
  tokenId: "12345678901234567890",
  question: "Exact Score: Maranhao AC MA 0 - 1 Brusque FC SC?",
  outcome: "Yes",
  slug: "bra3-mar-bru-2026-08-09-exact-score-0-1",
};

test("finalOutcomePrice alone was trusted -- the fault, reproduced", () => {
  // Priced on Yes (firstTokenId), but settled against a DIFFERENT token (settledTokenId):
  // proof the side flipped. A raw read of finalOutcomePrice cannot see that at all.
  const row = sourceRow({
    ...base,
    firstTokenId: "12345678901234567890",
    settledTokenId: "99999999999999999999",
    outcomeCount: 2,
    finalOutcomePrice: 1,
  });
  // Two outcomes, proven to have flipped: the priced side's true result is the complement.
  assert.equal(row.finalOutcomePrice, 0, "priced Yes, settled on the other side -- this did NOT happen");
});

test("a row with no proof of a flip is still counted, unchanged", () => {
  // settledTokenId equals firstTokenId: no flip happened, so the raw price already IS the
  // priced side's settlement. Fixing the fault must not turn this into a blanket rejection.
  const row = sourceRow({
    ...base,
    firstTokenId: "12345678901234567890",
    settledTokenId: "12345678901234567890",
    outcomeCount: 2,
    finalOutcomePrice: 1,
  });
  assert.equal(row.finalOutcomePrice, 1);
});

test("an archived row with no settlement fields at all is still admitted", () => {
  // Most of the archive predates settledTokenId/firstTokenId. Rejecting every row without
  // them would empty the feed rather than correct it -- resolved_stats_settled_outcome()
  // only excludes the PROVEN-ambiguous case, not the merely-unprovable one.
  const row = sourceRow({ ...base, finalOutcomePrice: 1 });
  assert.equal(row.finalOutcomePrice, 1);
});

test("a proven flip on a market that is NOT two-outcome is excluded, not guessed at", () => {
  // The complement only exists for a binary settlement. A flip proven on a field with more
  // than two outcomes has no safe inversion, so the row must be dropped, not inverted.
  const row = sourceRow({
    ...base,
    firstTokenId: "12345678901234567890",
    settledTokenId: "99999999999999999999",
    outcomeCount: 5,
    finalOutcomePrice: 1,
  });
  assert.equal(row, null);
});

test("an unresolved market is still excluded before settlement is even considered", () => {
  const row = sourceRow({ ...base, finalOutcomePrice: 0.42 });
  assert.equal(row, null);
});

test("dip_backtest_source_row no longer reads finalOutcomePrice unguarded", () => {
  const fn = extractPhpFunction(API, "function dip_backtest_source_row(array $item): ?array");
  assert.match(fn, /resolved_stats_settled_outcome\(\$item\)/,
    "the settlement must be proven the same way the folded statistics prove it");
  assert.ok(!/\$final = \$item\['finalOutcomePrice'\] \?\? null;/.test(fn),
    "the raw, unproven read must be gone, not merely supplemented");
});
