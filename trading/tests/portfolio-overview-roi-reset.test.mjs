// Runs offline: api.php's own function is executed against fabricated portfolios. No
// network, no database, no secrets.
//
// Reported right after every paper portfolio was reset to 100 USDC: "asi se u portfolii
// nevynulovalo roi?" -- and it had not.
//
// The reset works by rebasing: equity is set to the target and capitalAdjustmentAt is
// stamped, so the browser switches every headline P/L to its *SinceAdjustment* figure. But
// the OVERVIEW's ROI and accuracy are not computed in the browser. They come from
// paper_portfolio_history_summary in PHP, which walked every trade the portfolio had ever
// held and had never heard of the boundary. So the overview showed a lifetime return beside
// a balance that had just been reset, and disagreed with the portfolio's own detail view --
// which is worse than either answer on its own.

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API = readFileSync(new URL("../api.php", import.meta.url), "utf8");

function summarise(portfolio, since = null) {
  const directory = mkdtempSync(join(tmpdir(), "roi-reset-"));
  try {
    const cut = API.indexOf("\ntry {");
    const definitions = join(directory, "definitions.php");
    mkdirSync(join(directory, "data"), { recursive: true });
    writeFileSync(definitions, API.slice(0, cut) + "\n");
    const sinceArg = since === null ? "null" : `'${since}'`;
    const output = execFileSync("php", ["-r",
      `chdir('${directory}'); require '${definitions}';`
      + ` echo json_encode(paper_portfolio_history_summary(`
      + `json_decode('${JSON.stringify(portfolio)}', true), ${sinceArg}));`,
    ], { encoding: "utf8", cwd: directory });
    return JSON.parse(output);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const RESET_AT = "2026-09-17T17:33:00.000Z";

// A portfolio with a long, profitable-looking history and two trades since the reset.
const PORTFOLIO = {
  capitalAdjustmentAt: RESET_AT,
  trades: [
    // Before the reset: five closed trades, +$40 on $250 invested. A 16% lifetime return
    // that has nothing to do with the restarted portfolio.
    ...Array.from({ length: 5 }, (_, index) => ({
      status: "WON",
      openedAt: `2026-09-0${index + 1}T10:00:00.000Z`,
      resolvedAt: `2026-09-0${index + 1}T18:00:00.000Z`,
      realizedPnlUsdc: 8,
      totalCostUsdc: 50,
      finalOutcomePrice: 1,
    })),
    // Since the reset: one win, one loss, -$2 on $10.
    {
      status: "WON",
      openedAt: "2026-09-17T18:00:00.000Z",
      resolvedAt: "2026-09-17T19:00:00.000Z",
      realizedPnlUsdc: 3,
      totalCostUsdc: 5,
      finalOutcomePrice: 1,
    },
    {
      status: "LOST",
      openedAt: "2026-09-17T18:30:00.000Z",
      resolvedAt: "2026-09-17T20:00:00.000Z",
      realizedPnlUsdc: -5,
      totalCostUsdc: 5,
      finalOutcomePrice: 0,
    },
  ],
};

test("overview ROI: a reset portfolio is scored on what it has done since", () => {
  const summary = summarise(PORTFOLIO, RESET_AT);

  // The two halves the ROI column is built from: -$2 on $10, not +$40 on $260.
  assert.equal(summary.closedRealizedPnlUsdc, -2,
    "the ROI must be the restarted portfolio's, not the account's whole life");
  assert.equal(summary.closedInvestedUsdc, 10);
  assert.equal(summary.closedTradeCount, 2);
  assert.equal(summary.closedFilledCount, 2);

  // Accuracy too, or the overview disagrees with the detail view, which already filters it.
  assert.equal(summary.resolvedCount, 2);
  assert.equal(summary.correctCount, 1);
  assert.equal(summary.accuracy, 0.5);

  // The annualised return divides by the time since the first trade. Left unbounded it
  // would divide two hours of results by two and a half weeks.
  assert.equal(summary.firstOpenedAt, "2026-09-17T18:00:00.000Z");

  // And the boundary is published, so a portfolio that has barely traded can be told from
  // one that was restarted an hour ago.
  assert.equal(summary.sinceAdjustmentAt, RESET_AT);
});

test("overview ROI: the lifetime figures survive the reset", () => {
  // The reset was asked for on one condition: "nechame si je pro souhrne statistiky." So
  // the whole-life numbers travel beside the bounded ones rather than being dropped.
  const summary = summarise(PORTFOLIO, RESET_AT);
  assert.equal(summary.lifetimeClosedTradeCount, 7);
  assert.equal(summary.lifetimeClosedRealizedPnlUsdc, 38, "+$40 before, -$2 since");
  assert.equal(summary.lifetimeClosedInvestedUsdc, 260);
  // And every trade is still stored: the reset moved a boundary, it deleted nothing.
  assert.equal(summary.tradeCount, 7);
});

test("overview ROI: without a reset nothing changes", () => {
  // The portfolios that were never rebased have to read exactly as before, or this fix
  // would silently rewrite every unreset portfolio's return.
  const summary = summarise(PORTFOLIO, null);
  assert.equal(summary.closedRealizedPnlUsdc, 38);
  assert.equal(summary.closedInvestedUsdc, 260);
  assert.equal(summary.closedTradeCount, 7);
  assert.equal(summary.resolvedCount, 7);
  assert.equal(summary.correctCount, 6);
  assert.equal(summary.firstOpenedAt, "2026-09-01T10:00:00.000Z");
  assert.equal(summary.sinceAdjustmentAt, null);
  // An empty string is how an absent field arrives from the call sites, and it must mean
  // "no reset" rather than "a boundary at the epoch", which would zero every portfolio.
  assert.deepEqual(summarise(PORTFOLIO, ""), summary);
});

test("overview ROI: the overview reads the boundary, the archive cards do not", () => {
  // Both overview call sites pass it. An archived snapshot describes a whole life, so
  // bounding those would rewrite history rather than restart it.
  assert.match(API, /paper_portfolio_history_summary\(\$portfolio, \(string\) \(\$portfolio\['capitalAdjustmentAt'\] \?\? ''\)\)/);
  assert.match(API, /\$source\['capitalAdjustmentAt'\] \?\? \$portfolio\['capitalAdjustmentAt'\] \?\? ''/);
  assert.match(API, /\$history = paper_portfolio_history_summary\(\$snapshot\);/,
    "an archive card keeps its whole life");
});
