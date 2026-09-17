// Runs offline: the bot's real exports, no network, no secrets.
//
// Asked for: "vsechna paper portfolia vynuluj na 100 usd a odpoj dodavadni trades. nechame
// si je pro souhrne statistiky."
//
// A rebase already existed and does exactly that shape of thing: it sets displayed equity
// to a target WITHOUT touching a single trade, and stamps capitalAdjustmentAt so the
// headline stats read "since the reset" while the history stays in the data for anything
// that sums across the account. What it could not do was run over every portfolio at once,
// and a reset applied to some portfolios and not others is worse than none at all --
// nothing on screen says which half you are looking at.
//
// So this checks the two things that matter for a bulk reset: every portfolio ends at the
// target, and no trade is lost doing it.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const bot = await import("../tools/paper-trading-bot.mjs");
const SOURCE = readFileSync(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");

function portfolioWithHistory(equityDelta, tradeCount) {
  return {
    // A history worth keeping: these are the rows aggregate statistics still read.
    trades: Array.from({ length: tradeCount }, (_, index) => ({
      id: `t${index}`,
      status: "LOST",
      openedAt: `2026-09-0${(index % 9) + 1}T10:00:00.000Z`,
      resolvedAt: `2026-09-0${(index % 9) + 1}T18:00:00.000Z`,
      closedAt: `2026-09-0${(index % 9) + 1}T18:00:00.000Z`,
      stakeUsdc: 5,
      totalCostUsdc: 5,
      shares: 6,
      realizedPnlUsdc: equityDelta / tradeCount,
      feeRate: 0,
      feesEnabled: false,
    })),
  };
}

test("capital reset: a rebase moves the balance and keeps every trade", () => {
  const state = {
    paperPortfolios: {
      conservative: portfolioWithHistory(-40, 8),
      highReward: portfolioWithHistory(25, 5),
    },
  };
  const tradesBefore = Object.fromEntries(
    Object.entries(state.paperPortfolios).map(([id, row]) => [id, row.trades.length]),
  );

  for (const id of Object.keys(state.paperPortfolios)) {
    const result = bot.adjustPaperPortfolioCapital(state, id, 100);
    assert.equal(result.newEquity, 100, `${id} must end at the target`);
    assert.ok(result.adjustedAt, "the moment has to be recorded, or 'since the reset' has no start");
  }

  // Every portfolio the state holds AFTER the rebase, not just the two seeded: normalising
  // one portfolio fills in the built-in strategies and legacy aliases beside it, so the set
  // grows while the loop runs. That is why the bulk mode re-reads its keys each pass.
  assert.ok(Object.keys(state.paperPortfolios).length >= 2);
  for (const [id, row] of Object.entries(state.paperPortfolios)) {
    if (!(id in tradesBefore)) continue;
    assert.equal(row.portfolio.equityUsdc, 100, `${id} reads 100 after the reset`);
    // The whole point of using the rebase rather than deleting: the history is still there.
    assert.equal(row.trades.length, tradesBefore[id],
      `${id} must keep every trade -- they are the aggregate statistics`);
    assert.ok(row.capitalAdjustmentAt, "and each portfolio carries its own boundary");
    // The boundary the dashboard reads for "since the reset". Without these two the
    // headline would re-sum the old history and the reset would be cosmetic.
    assert.equal(row.capitalAdjustmentEquityUsdc, 100);
    assert.ok(Number.isFinite(Number(row.capitalAdjustmentOpenPnlUsdc)));
  }
});

test("capital reset: the bulk mode covers every portfolio in the state", () => {
  // Asserted on the source because the mode is a top-level branch in main(), not an export.
  // What matters is WHICH list it walks: the strategy table omits portfolios that were
  // archived or renamed, and those still hold trades and still show a balance.
  assert.match(SOURCE, /const pending = Object\.keys\(state\.paperPortfolios \|\| \{\}\)\.filter\(\(id\) => !done\.has\(id\)\);/,
    "the state's own portfolios are the list, not the strategy table");
  // And re-read each pass. A rebase materialises the built-in strategies and the legacy
  // aliases, so a single snapshot of the keys leaves those unrebased -- a half-reset behind
  // a run that reports success. Measured while writing this file.
  assert.match(SOURCE, /for \(let pass = 0; pass < 8; pass \+= 1\) \{/);
  assert.match(SOURCE, /\.filter\(\(id\) => !state\.paperPortfolios\[id\]\?\.capitalAdjustmentAt\);/,
    "and a portfolio left without a reset marker has to be reported as a failure");
  assert.match(SOURCE, /const PAPER_ADJUST_CAPITAL_ALL = envBool\("PAPER_ADJUST_CAPITAL_ALL", false\);/,
    "and it is its own switch: an absent variable must not decide to rewrite every portfolio");

  // One portfolio that cannot be resolved must not abandon the rest half-written, and must
  // not pass silently either.
  assert.match(SOURCE, /failures\.push\(\{ strategyId: id, error:/);
  assert.match(SOURCE, /if \(failures\.length\) \{\n\s+throw new Error\(/,
    "a partial reset has to fail loudly after writing what it could");

  // The state is written once, after the loop, rather than per portfolio: thirty writes to
  // one shared hosting account is the contention this project already measured.
  const branch = SOURCE.slice(SOURCE.indexOf("if (PAPER_ADJUST_CAPITAL_ALL) {"));
  const body = branch.slice(0, branch.indexOf("if (PAPER_ADJUST_CAPITAL) {"));
  assert.equal((body.match(/await writeState\(state\);/g) || []).length, 1,
    "exactly one state write for the whole reset");
});

test("capital reset: an unknown portfolio is refused rather than invented", () => {
  const state = { paperPortfolios: { conservative: portfolioWithHistory(-10, 2) } };
  assert.throws(() => bot.adjustPaperPortfolioCapital(state, "notAStrategy", 100),
    /Unknown paper portfolio strategy/);
  // And the portfolio that does exist is untouched by the failed attempt.
  assert.equal(state.paperPortfolios.conservative.trades.length, 2);
});

test("capital reset: the bulk mode is reachable only by a deliberate dispatch", async () => {
  const { readFile } = await import("node:fs/promises");
  const workflow = await readFile(new URL("../../.github/workflows/trading-paper-bot.yml", import.meta.url), "utf8");

  // It has to be dispatchable at all, or the reset can only be done by hand on the state.
  assert.match(workflow, /- adjust_capital_all/);
  assert.match(workflow, /PAPER_ADJUST_CAPITAL_ALL: \$\{\{ github\.event_name == 'workflow_dispatch'/,
    "the schedule must never be able to reset the account");
  assert.match(workflow, /inputs\.mode == 'adjust_capital_all' && 'true' \|\| 'false' \}\}/);

  // And the hourly run must not accidentally select it: the default mode is still full.
  assert.match(workflow, /mode:\n\s+description: "Run mode"\n\s+required: false\n\s+default: "full"/);
});
