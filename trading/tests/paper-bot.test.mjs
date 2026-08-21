// Runs offline: no secrets, no network, no hosting access.
// Deterministic portfolio constants must be set before the module is imported,
// because the bot reads them from the environment at import time.
process.env.PAPER_PORTFOLIO_USDC = "100";
process.env.PAPER_MAX_FRACTION = "0.05";
process.env.PAPER_MIN_ANNUALIZATION_DAYS = String(1 / 24);
process.env.PAPER_FULL_CADENCE_MINUTES = "55";
process.env.PAPER_REPORT_CADENCE_MINUTES = "55";

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const bot = await import("../tools/paper-trading-bot.mjs");

const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();

test("economics: taker fee follows shares * rate * price * (1 - price)", () => {
  const fee = bot.takerFeeForFills([{ size: 10, price: 0.9 }], 0.02);
  // 10 * 0.02 * 0.9 * 0.1 = 0.018
  assert.equal(fee, 0.018);
  assert.equal(bot.takerFeeForFills([{ size: 10, price: 0.9 }], 0), 0, "no fee when the market has no fee rate");
  assert.equal(bot.takerFeeForFills([{ size: 10, price: 0.9 }], -1), 0, "a negative rate must never credit the trade");
});

test("economics: a persisted fee market keeps its taker rate during revalidation", () => {
  const fees = bot.feeConfig({ feesEnabled: true, feeRate: 0.02 });
  assert.deepEqual(fees, {
    feesEnabled: true,
    feeRate: 0.02,
    feeType: "unknown",
    takerOnly: true,
  });
});

test("equal paper portfolio: its independent $100 account is registered with a synthetic risk cap", () => {
  assert.equal(bot.PAPER_STRATEGIES.equal.label, "Equal");
  assert.equal(bot.PAPER_STRATEGIES.equal.equalRiskProtection, true);
  assert.equal(bot.PAPER_STRATEGIES.equal.equalRiskMultiplier, 1.5);
  assert.equal(bot.PAPER_STRATEGIES.equal.allowRotation, false);
  assert.equal(bot.PAPER_STRATEGIES.equal.maxFraction, 0.05);
  assert.equal(bot.PAPER_STRATEGIES.equal.executionTrigger, "after_scrape", "Equal defaults to inspecting its synthetic stop after every completed scan");
  assert.equal(bot.PAPER_STRATEGIES.equal.executionCronMinutes, 60, "the saved cron interval only applies after the user selects the cron trigger");

  const state = bot.normalizeState({ paperPortfolios: {} });
  const equal = state.paperPortfolios.equal;
  assert.ok(equal, "the new portfolio must be created for existing saved states");
  assert.equal(equal.portfolio.initialUsdc, 100);
  assert.equal(equal.portfolio.freeCapitalUsdc, 100);
});

test("automatic rotation: each portfolio receives its saved On/Off setting", () => {
  assert.equal(bot.PAPER_STRATEGIES.conservative.allowRotation, true);
  assert.equal(bot.PAPER_STRATEGIES.equal.allowRotation, false, "Equal remains disabled until explicitly enabled");

  const app = readFileSync(new URL("../assets/app.js", import.meta.url), "utf8");
  const paperWorkflow = readFileSync(new URL("../../.github/workflows/trading-paper-bot.yml", import.meta.url), "utf8");
  const liveWorkflow = readFileSync(new URL("../../.github/workflows/polymarket-live-limit-order-test.yml", import.meta.url), "utf8");
  const fixedWorkflow = readFileSync(new URL("../../.github/workflows/trading-live-5050.yml", import.meta.url), "utf8");

  assert.match(app, /data-auto-rotate-positions/);
  assert.match(app, /autoRotatePositions: value/);
  assert.match(paperWorkflow, /_AUTO_ROTATE/);
  assert.match(liveWorkflow, /"LIVE_AUTO_ROTATE": str\(bool\(live\.get\("autoRotatePositions", True\)\)\)\.lower\(\)/);
  assert.match(fixedWorkflow, /"LIVE_AUTO_ROTATE": str\(bool\(cfg\.get\("autoRotatePositions", False\)\)\)\.lower\(\)/);
});

test("paper reset: archives only More probable and prevents stale trades from returning", () => {
  const state = bot.normalizeState({
    generatedAt: "2026-08-13T09:00:00.000Z",
    paperPortfolios: {
      moreProbable: {
        trades: [{
          id: "more-probable-old-trade",
          status: "OPEN",
          totalCostUsdc: 5,
          stakeUsdc: 5,
          openedAt: "2026-08-12T09:00:00.000Z",
        }],
        runLog: [{ id: "old-run", runAt: "2026-08-12T09:00:00.000Z", strategyId: "moreProbable" }],
      },
      conservative: {
        trades: [{ id: "conservative-kept", status: "OPEN", totalCostUsdc: 5, stakeUsdc: 5 }],
      },
    },
  });
  const archive = bot.archiveAndResetPaperPortfolio(state, "moreProbable");
  const reset = state.paperPortfolios.moreProbable;

  assert.equal(archive.strategyId, "moreProbable");
  assert.equal(archive.snapshot.trades.length, 1);
  assert.equal(reset.trades.length, 0);
  assert.equal(reset.runLog.length, 0);
  assert.equal(reset.portfolio.initialUsdc, 100);
  assert.ok(reset.resetAt);
  assert.equal(state.paperPortfolios.conservative.trades.length, 1, "other paper portfolios are untouched");

  const stale = bot.normalizeState({
    generatedAt: "2026-08-12T10:00:00.000Z",
    paperPortfolios: { moreProbable: archive.snapshot },
  });
  const merged = bot.mergeStates(state, stale);
  assert.equal(merged.paperPortfolios.moreProbable.trades.length, 0, "pre-reset trades must not return from stale state");
  assert.equal(merged.paperPortfolioArchives.length, 1);
});

// Reported: a reset dispatched by mistake removed the open positions, closed-trade
// history and run log of a portfolio that was still running -- the request was only to
// rebase its displayed equity, never to touch any of that. Measured against the
// production incident: a plain undo cannot just restore the archived trades wholesale,
// because a paper trade's id is strategyId+day+tokenId, which collides on purpose
// within one portfolio on one day -- and the bot, run again after the reset with an
// empty account, reopened a position on the very market an archived trade already held,
// producing two real, distinct fills sharing one id.
test("paper restore: undoes a mistaken reset without losing a fill that collided on id", () => {
  const state = bot.normalizeState({
    generatedAt: "2026-08-17T05:20:00.000Z",
    paperPortfolios: {
      highReward: {
        // What the reset produced: an empty account plus one trade opened after it, on
        // the same market (day) an archived trade already held -- the exact production
        // shape, entry price and stake deliberately different from the archived one.
        trades: [{
          id: "paper-highReward-2026-08-17-76203494307980720620810691744802511525054908181575758165291891445551300956006",
          status: "OPEN",
          tokenId: "76203494307980720620810691744802511525054908181575758165291891445551300956006",
          question: "Pisa SC leading at halftime?",
          openedAt: "2026-08-17T05:17:26.959Z",
          entryPrice: 0.63,
          stakeUsdc: 5,
          totalCostUsdc: 5,
        }],
        runLog: [{ id: "post-reset-run", runAt: "2026-08-17T05:18:00.000Z", strategyId: "highReward" }],
        resetAt: "2026-08-17T05:10:22.606Z",
        resetArchiveId: "paper-archive-highReward-20260817051022606",
      },
    },
    paperPortfolioArchives: [{
      id: "paper-archive-highReward-20260817051022606",
      strategyId: "highReward",
      label: "High reward",
      archivedAt: "2026-08-17T05:10:22.606Z",
      reason: "manual paper portfolio reset",
      snapshot: {
        portfolio: { initialUsdc: 100 },
        lastTradeDate: "2026-08-17",
        lastTradeHour: 9,
        lastDecision: { runAt: "2026-08-17T05:09:00.000Z" },
        runLog: [
          { id: "old-run-1", runAt: "2026-08-16T09:00:00.000Z", strategyId: "highReward" },
          { id: "old-run-2", runAt: "2026-08-17T05:09:00.000Z", strategyId: "highReward" },
        ],
        trades: [
          // The colliding id: same market, same day, opened well before the reset, still
          // open -- and materially different terms from the post-reset trade sharing it.
          {
            id: "paper-highReward-2026-08-17-76203494307980720620810691744802511525054908181575758165291891445551300956006",
            status: "OPEN",
            tokenId: "76203494307980720620810691744802511525054908181575758165291891445551300956006",
            question: "Pisa SC leading at halftime?",
            openedAt: "2026-08-17T01:56:07.167Z",
            entryPrice: 0.64,
            stakeUsdc: 3.85,
            totalCostUsdc: 3.85,
          },
          { id: "old-closed-trade", status: "WON", stakeUsdc: 5, totalCostUsdc: 5, realizedPnlUsdc: 4.2 },
        ],
      },
    }],
  });

  const result = bot.restoreArchivedPaperPortfolio(state, "highReward");
  const restored = state.paperPortfolios.highReward;

  assert.equal(result.collisions.length, 1, "the id collision must be reported, not silently resolved");
  assert.equal(result.collisions[0].id,
    "paper-highReward-2026-08-17-76203494307980720620810691744802511525054908181575758165291891445551300956006");
  assert.equal(result.collisions[0].resolution, "kept-both");

  // Nothing lost: the archived open position, the archived closed trade, and the
  // genuinely new post-reset fill are all present, as three separate rows.
  assert.equal(restored.trades.length, 3);
  const archivedOpen = restored.trades.find((trade) => trade.entryPrice === 0.64 && trade.stakeUsdc === 3.85);
  assert.ok(archivedOpen, "the pre-reset open position must survive under its original id");
  assert.equal(archivedOpen.openedAt, "2026-08-17T01:56:07.167Z");
  const postReset = restored.trades.find((trade) => trade.entryPrice === 0.63 && trade.stakeUsdc === 5);
  assert.ok(postReset, "the post-reset fill on the same market must not be discarded");
  assert.notEqual(postReset.id, archivedOpen.id, "the two fills must not share an id after the restore");
  assert.ok(restored.trades.some((trade) => trade.id === "old-closed-trade"), "unrelated archived trades are untouched");

  // The reset's own markers are gone -- this portfolio's history no longer began there.
  assert.equal(restored.resetAt, null);
  assert.equal(restored.resetArchiveId, null);
  assert.equal(restored.runLog.length, 2, "the archived run log is restored");
  assert.equal(restored.lastTradeDate, "2026-08-17");

  // portfolio.* is recomputed from the restored trades, not left at whatever
  // normalizePaperPortfolio defaults to before a real pass ever runs: realizedPnl 4.2
  // from the one closed trade, on top of the 100 baseline, with both OPEN positions
  // contributing nothing until they resolve.
  assert.equal(restored.portfolio.initialUsdc, 100);
  assert.equal(restored.portfolio.equityUsdc, 104.2);
});

// The equal (Stop loss) portfolio's own incident: two trades opened after its reset,
// neither sharing an id with anything archived. No collision to resolve here -- both
// are simply additional rows alongside the full archived history.
test("paper restore: two clean post-reset trades are appended, not merged into anything", () => {
  const state = bot.normalizeState({
    generatedAt: "2026-08-17T05:20:00.000Z",
    paperPortfolios: {
      equal: {
        trades: [
          { id: "post-reset-a", status: "PENDING_RESOLUTION", stakeUsdc: 5, totalCostUsdc: 5 },
          { id: "post-reset-b", status: "OPEN", stakeUsdc: 5, totalCostUsdc: 5 },
        ],
        runLog: [{ id: "post-reset-run", runAt: "2026-08-17T05:00:00.000Z", strategyId: "equal" }],
        resetAt: "2026-08-17T04:56:21.125Z",
        resetArchiveId: "paper-archive-equal-20260817045621125",
      },
    },
    paperPortfolioArchives: [{
      id: "paper-archive-equal-20260817045621125",
      strategyId: "equal",
      label: "Stop loss",
      archivedAt: "2026-08-17T04:56:21.125Z",
      reason: "manual paper portfolio reset",
      snapshot: {
        portfolio: { initialUsdc: 100 },
        lastTradeDate: "2026-08-17",
        runLog: [{ id: "old-run", runAt: "2026-08-17T04:00:00.000Z", strategyId: "equal" }],
        trades: [{ id: "old-trade", status: "OPEN", stakeUsdc: 5, totalCostUsdc: 5 }],
      },
    }],
  });

  const result = bot.restoreArchivedPaperPortfolio(state, "equal");
  const restored = state.paperPortfolios.equal;

  assert.equal(result.collisions.length, 0);
  assert.equal(restored.trades.length, 3);
  assert.ok(restored.trades.some((trade) => trade.id === "old-trade"));
  assert.ok(restored.trades.some((trade) => trade.id === "post-reset-a"));
  assert.ok(restored.trades.some((trade) => trade.id === "post-reset-b"));
  assert.equal(restored.resetAt, null);
});

// A collision where the post-reset re-buy on the same market actually settled must not
// be shadowed by the archived, still-open row for the same id: the settlement is real
// progress and the archived row is now simply stale.
test("paper restore: a post-reset fill that already closed replaces the archived open row", () => {
  const state = bot.normalizeState({
    generatedAt: "2026-08-17T06:00:00.000Z",
    paperPortfolios: {
      highReward: {
        trades: [{
          id: "collide-and-close",
          status: "WON",
          stakeUsdc: 5,
          totalCostUsdc: 5,
          realizedPnlUsdc: 3,
        }],
        resetArchiveId: "archive-a",
      },
    },
    paperPortfolioArchives: [{
      id: "archive-a",
      strategyId: "highReward",
      label: "High reward",
      archivedAt: "2026-08-17T05:00:00.000Z",
      snapshot: {
        portfolio: { initialUsdc: 100 },
        trades: [{ id: "collide-and-close", status: "OPEN", stakeUsdc: 5, totalCostUsdc: 5 }],
      },
    }],
  });

  const result = bot.restoreArchivedPaperPortfolio(state, "highReward");
  const restored = state.paperPortfolios.highReward;

  assert.equal(result.collisions.length, 1);
  assert.equal(result.collisions[0].resolution, "kept-post-reset-close");
  assert.equal(restored.trades.length, 1, "the settled fill replaces the archived open row rather than sitting beside it");
  assert.equal(restored.trades[0].status, "WON");
  assert.equal(restored.trades[0].realizedPnlUsdc, 3);
});

// Multiple archives can exist for one strategy (every reset adds one). Restoring must
// undo the SPECIFIC reset this portfolio's own resetArchiveId points at, not merely
// whichever archive for that strategy happens to be newest.
test("paper restore: picks the archive this portfolio's own reset points at, not just the newest", () => {
  const state = bot.normalizeState({
    generatedAt: "2026-08-17T06:00:00.000Z",
    paperPortfolios: {
      highReward: {
        trades: [],
        resetArchiveId: "archive-older-correct",
      },
    },
    paperPortfolioArchives: [
      {
        id: "archive-newer-wrong",
        strategyId: "highReward",
        label: "High reward",
        archivedAt: "2026-08-17T06:00:00.000Z",
        snapshot: { portfolio: { initialUsdc: 100 }, trades: [{ id: "wrong-trade", status: "OPEN", stakeUsdc: 5, totalCostUsdc: 5 }] },
      },
      {
        id: "archive-older-correct",
        strategyId: "highReward",
        label: "High reward",
        archivedAt: "2026-08-17T05:00:00.000Z",
        snapshot: { portfolio: { initialUsdc: 100 }, trades: [{ id: "correct-trade", status: "OPEN", stakeUsdc: 5, totalCostUsdc: 5 }] },
      },
    ],
  });

  const result = bot.restoreArchivedPaperPortfolio(state, "highReward");
  assert.equal(result.archiveId, "archive-older-correct");
  assert.deepEqual(state.paperPortfolios.highReward.trades.map((trade) => trade.id), ["correct-trade"]);
});

test("paper restore: the workflow and bot expose it as a dispatchable mode", async () => {
  const { readFile } = await import("node:fs/promises");
  const workflow = await readFile(new URL("../../.github/workflows/trading-paper-bot.yml", import.meta.url), "utf8");
  assert.match(workflow, /- restore\n/);
  assert.match(workflow,
    /PAPER_RESTORE_PORTFOLIO: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.mode == 'restore' && 'true' \|\| 'false' \}\}/);
  const source = readFileSync(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");
  assert.match(source, /if \(PAPER_RESTORE_PORTFOLIO\) \{/);
  assert.match(source, /restoreArchivedPaperPortfolio\(state, PAPER_STRATEGY_ID\)/);
});

// Reported: after undoing the mistaken reset, a portfolio's equity truthfully reflects
// its full historical PnL -- which is exactly what must not be erased -- but the request
// was only ever to rebase the displayed number, never to lose the history behind it.
// initialUsdc turned out not to be a real per-portfolio store: updatePaperPortfolio()
// overwrites it with the fixed PORTFOLIO_USDC constant on every single pass, so a
// genuine adjustment has to live in its own field and be folded into that formula.
test("paper capital adjustment: rebases equity to the target without changing a single trade", () => {
  const state = bot.normalizeState({
    generatedAt: "2026-08-17T10:00:00.000Z",
    paperPortfolios: {
      highReward: {
        trades: [
          { id: "t1", status: "WON", stakeUsdc: 5, totalCostUsdc: 5, realizedPnlUsdc: 4 },
          { id: "t2", status: "LOST", stakeUsdc: 5, totalCostUsdc: 5, realizedPnlUsdc: -36.2451 },
          { id: "t3", status: "OPEN", stakeUsdc: 5, totalCostUsdc: 5, unrealizedPnlUsdc: 1.5 },
        ],
      },
    },
  });
  // Baseline 100 + realized (4 - 36.2451) + open 1.5 = 69.2549, matching the shape of
  // the real production account this was measured against.
  assert.equal(state.paperPortfolios.highReward.portfolio.equityUsdc, 69.2549,
    "sanity: the fixture reproduces a realistic drawdown");

  const result = bot.adjustPaperPortfolioCapital(state, "highReward", 100);
  const adjusted = state.paperPortfolios.highReward;

  assert.equal(result.priorEquity, 69.2549);
  assert.equal(result.newEquity, 100);
  assert.equal(adjusted.portfolio.equityUsdc, 100);
  // Not one trade's own recorded PnL moved -- the account's true performance is
  // unchanged and fully readable from its history. retainPaperTrades() may reorder
  // (open positions are kept ahead of closed ones), so this checks each trade by id
  // rather than assuming the array order survived.
  const byId = Object.fromEntries(adjusted.trades.map((trade) => [trade.id, trade]));
  assert.equal(byId.t1.realizedPnlUsdc, 4);
  assert.equal(byId.t2.realizedPnlUsdc, -36.2451);
  assert.equal(byId.t3.unrealizedPnlUsdc, 1.5);
  assert.equal(adjusted.trades.length, 3);
  // The adjustment is stated, not hidden: it is exactly what closes the gap between the
  // fixed global baseline and the requested equity.
  assert.equal(adjusted.capitalAdjustmentUsdc, Number((100 - 69.2549).toFixed(4)));
  assert.equal(adjusted.portfolio.initialUsdc, 100 + adjusted.capitalAdjustmentUsdc);
});

test("paper capital adjustment: a second rebase adds to the existing adjustment, not past it", () => {
  const state = bot.normalizeState({
    generatedAt: "2026-08-17T10:00:00.000Z",
    paperPortfolios: {
      equal: {
        trades: [{ id: "t1", status: "LOST", stakeUsdc: 5, totalCostUsdc: 5, realizedPnlUsdc: -5 }],
        capitalAdjustmentUsdc: 10,
      },
    },
  });
  // Equity is already 100 + 10 - 5 = 105 under the existing adjustment.
  const result = bot.adjustPaperPortfolioCapital(state, "equal", 100);
  assert.equal(result.priorEquity, 105);
  assert.equal(result.priorAdjustment, 10);
  // Moves the adjustment down by 5, not by 100 -- a rebase is relative to where the
  // account already stands, or a second correction would overwrite the first.
  assert.equal(result.newAdjustment, 5);
  assert.equal(state.paperPortfolios.equal.portfolio.equityUsdc, 100);
});

test("paper capital adjustment: an untouched portfolio's formula is exactly the old one", () => {
  // capitalAdjustmentUsdc defaults to 0 for every portfolio that never had this run
  // against it, so PORTFOLIO_USDC + 0 must reproduce the pre-existing baseline exactly.
  const state = bot.normalizeState({
    generatedAt: "2026-08-17T10:00:00.000Z",
    paperPortfolios: {
      conservative: {
        trades: [{ id: "t1", status: "WON", stakeUsdc: 5, totalCostUsdc: 5, realizedPnlUsdc: 3.75 }],
      },
    },
  });
  const portfolio = state.paperPortfolios.conservative.portfolio;
  assert.equal(portfolio.initialUsdc, 100);
  assert.equal(portfolio.equityUsdc, 103.75);
  assert.equal(state.paperPortfolios.conservative.capitalAdjustmentUsdc, 0);
});

// Reported: after a rebase, Total P/L, Realized P/L and Resolved accuracy kept weighing
// performance by trades closed before it -- the user wanted performance measured "since"
// the rebase, without erasing the older trades from Closed positions history.
test("paper capital adjustment: 'since the rebase' stats exclude older trades, equity does not", () => {
  const state = bot.normalizeState({
    generatedAt: "2026-08-17T10:00:00.000Z",
    paperPortfolios: {
      moreProbable: {
        trades: [
          { id: "old-loss", status: "LOST", stakeUsdc: 5, totalCostUsdc: 5, realizedPnlUsdc: -10, resolvedAt: "2026-01-01T00:00:00.000Z" },
          { id: "old-win", status: "WON", stakeUsdc: 5, totalCostUsdc: 5, realizedPnlUsdc: 20, resolvedAt: "2026-06-01T00:00:00.000Z" },
        ],
      },
    },
  });

  const result = bot.adjustPaperPortfolioCapital(state, "moreProbable", 100);
  assert.ok(result.adjustedAt, "the rebase moment must be recorded, or nothing can be filtered by it");
  assert.equal(state.paperPortfolios.moreProbable.capitalAdjustmentAt, result.adjustedAt);

  // A trade that closes after the rebase.
  const after = new Date(Date.parse(result.adjustedAt) + 60000).toISOString();
  state.paperPortfolios.moreProbable.trades.push(
    { id: "new-win", status: "WON", stakeUsdc: 5, totalCostUsdc: 5, realizedPnlUsdc: 7, resolvedAt: after },
  );
  bot.updatePaperPortfolio(state.paperPortfolios.moreProbable);
  const portfolio = state.paperPortfolios.moreProbable.portfolio;

  // Equity is real money: it must still reflect every trade, or free capital and sizing
  // would drift from the account's actual balance. The rebase moved the baseline itself
  // (100 - 10, since it had to close a +10 pre-existing gap to land exactly on 100), so
  // equity is that baseline plus every trade's realized P/L, not 100 plus it.
  assert.equal(portfolio.realizedPnlUsdc, -10 + 20 + 7);
  assert.equal(portfolio.totalPnlUsdc, -10 + 20 + 7);
  assert.equal(state.paperPortfolios.moreProbable.capitalAdjustmentUsdc, -10);
  assert.equal(portfolio.equityUsdc, (100 - 10) + (-10 + 20 + 7));

  // "Since the rebase" counts only the one trade that closed after it.
  assert.equal(portfolio.realizedPnlSinceAdjustmentUsdc, 7);
  assert.equal(portfolio.totalPnlSinceAdjustmentUsdc, 7);
});

test("paper capital adjustment: a portfolio never rebased has nothing to exclude", () => {
  const state = bot.normalizeState({
    generatedAt: "2026-08-17T10:00:00.000Z",
    paperPortfolios: {
      conservative: {
        trades: [{ id: "t1", status: "WON", stakeUsdc: 5, totalCostUsdc: 5, realizedPnlUsdc: 3.75, resolvedAt: "2020-01-01T00:00:00.000Z" }],
      },
    },
  });
  const portfolio = state.paperPortfolios.conservative.portfolio;
  assert.equal(state.paperPortfolios.conservative.capitalAdjustmentAt, null);
  // With no rebase recorded, "since" must equal the true all-time figure exactly -- an
  // untouched portfolio's dashboard tiles must not change at all.
  assert.equal(portfolio.realizedPnlSinceAdjustmentUsdc, portfolio.realizedPnlUsdc);
  assert.equal(portfolio.totalPnlSinceAdjustmentUsdc, portfolio.totalPnlUsdc);
});

test("paper capital adjustment: the workflow and bot expose it as a dispatchable mode", async () => {
  const { readFile } = await import("node:fs/promises");
  const workflow = await readFile(new URL("../../.github/workflows/trading-paper-bot.yml", import.meta.url), "utf8");
  assert.match(workflow, /- adjust_capital\n/);
  assert.match(workflow,
    /PAPER_ADJUST_CAPITAL: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.mode == 'adjust_capital' && 'true' \|\| 'false' \}\}/);
  assert.match(workflow, /paper_target_equity_usdc:/);
  const source = readFileSync(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");
  assert.match(source, /if \(PAPER_ADJUST_CAPITAL\) \{/);
  assert.match(source, /adjustPaperPortfolioCapital\(state, PAPER_STRATEGY_ID, PAPER_TARGET_EQUITY_USDC\)/);
});

// Two already-rebased portfolios (Stop loss, High reward) predate capitalAdjustmentAt, so
// their "since the rebase" stats have nothing to filter by until this backfill runs once.
test("paper capital adjustment: the backfill-only timestamp is exposed as its own dispatchable mode", async () => {
  const { readFile } = await import("node:fs/promises");
  const workflow = await readFile(new URL("../../.github/workflows/trading-paper-bot.yml", import.meta.url), "utf8");
  assert.match(workflow, /- set_capital_adjustment_at\n/);
  assert.match(workflow,
    /PAPER_SET_CAPITAL_ADJUSTMENT_AT: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.mode == 'set_capital_adjustment_at' && 'true' \|\| 'false' \}\}/);
  assert.match(workflow, /paper_capital_adjustment_at_iso:/);
  const source = readFileSync(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");
  assert.match(source, /if \(PAPER_SET_CAPITAL_ADJUSTMENT_AT\) \{/);
  assert.match(source, /backfillCapitalAdjustmentAt\(state, PAPER_STRATEGY_ID, PAPER_CAPITAL_ADJUSTMENT_AT_ISO\)/);

  // And the function itself changes nothing but the timestamp.
  const state = bot.normalizeState({
    generatedAt: "2026-08-17T10:00:00.000Z",
    paperPortfolios: {
      equal: {
        trades: [{ id: "t1", status: "LOST", stakeUsdc: 5, totalCostUsdc: 5, realizedPnlUsdc: -5 }],
        capitalAdjustmentUsdc: 66.2259,
      },
    },
  });
  const result = bot.backfillCapitalAdjustmentAt(state, "equal", "2026-08-17T04:00:00.000Z");
  assert.equal(result.capitalAdjustmentAt, "2026-08-17T04:00:00.000Z");
  assert.equal(result.capitalAdjustmentUsdc, 66.2259, "the already-correct adjustment amount must not move");
  assert.equal(state.paperPortfolios.equal.trades[0].realizedPnlUsdc, -5, "not one trade is touched");
  assert.throws(() => bot.backfillCapitalAdjustmentAt(state, "equal", "not a date"), /Invalid capitalAdjustmentAt timestamp/);
});

test("paper stake sizing: a rebased portfolio keeps the fixed configured trade amount", () => {
  const strategy = { id: "test", label: "Test", selectionMetric: "EV p.a.", stakeUsdc: 5, maxFraction: 0.05, allowRotation: false };

  // No adjustment: the fixed stake is the configured nominal value.
  const untouched = bot.maybeOpenScheduledTrade({ trades: [], capitalAdjustmentUsdc: 0 }, [], strategy);
  assert.equal(untouched.available, 100);
  assert.equal(untouched.requiredStake, 5);

  // Rebased by +50: available moves, but the trade size deliberately does not.
  const rebased = bot.maybeOpenScheduledTrade({ trades: [], capitalAdjustmentUsdc: 50 }, [], strategy);
  assert.equal(rebased.available, 150);
  assert.equal(rebased.requiredStake, 5);
});

test("run log: a paper OPENED row keeps the selected order summary in the compact list", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  // Equal reports successful simulated entries as OPENED, unlike Live's SUBMITTED.
  // The compact list must not fall back to the generic ranking reason and hide the
  // market, outcome and economics that are available in Order placed.
  assert.match(app, /\["SUBMITTED", "CANCELED_AND_SUBMITTED", "OPENED", "ROTATED_OPENED"\]\.includes\(action\)/);
});

test("equal risk: the planned exit leaves no more loss than the net winning gain", () => {
  const plan = bot.equalRiskStopPlan({
    totalCostUsdc: 5,
    netGainIfWinUsdc: 0.5,
    shares: 5.5,
    entryPrice: 0.9,
    feeRate: 0,
    feesEnabled: false,
  });
  assert.equal(plan.protectable, true);
  assert.equal(plan.requiresStop, true);
  assert.equal(plan.riskTargetUsdc, 0.5);
  assert.ok(plan.stopPrice > 0 && plan.stopPrice < 0.9);
  const exitValue = bot.netExitValueAtPrice({ shares: 5.5, price: plan.stopPrice, feesEnabled: false });
  assert.ok(Math.abs(exitValue - 4.5) < 0.0001, `expected $4.50 exit value, got ${exitValue}`);

  const natural = bot.equalRiskStopPlan({
    totalCostUsdc: 5,
    netGainIfWinUsdc: 6,
    shares: 11,
    entryPrice: 0.45,
  });
  assert.equal(natural.protectable, true);
  assert.equal(natural.requiresStop, false, "a whole-stake loss is already below the possible reward");
});

test("equal risk: stop multiplier widens the allowed paper loss band", () => {
  const plan = bot.equalRiskStopPlan({
    totalCostUsdc: 5,
    netGainIfWinUsdc: 0.5,
    shares: 5.5,
    entryPrice: 0.9,
    feeRate: 0,
    feesEnabled: false,
    riskMultiplier: 1.5,
  });
  assert.equal(plan.protectable, true);
  assert.equal(plan.requiresStop, true);
  assert.equal(plan.riskTargetUsdc, 0.75);
  assert.equal(plan.stopLossRiskMultiplier, 1.5);
  const exitValue = bot.netExitValueAtPrice({ shares: 5.5, price: plan.stopPrice, feesEnabled: false });
  assert.ok(Math.abs(exitValue - 4.25) < 0.0001, `expected $4.25 exit value, got ${exitValue}`);
});

test("equal risk: a bid below the sell floor exits immediately and records the gap", () => {
  const plan = bot.equalRiskStopPlan({
    totalCostUsdc: 5,
    netGainIfWinUsdc: 0.5,
    shares: 5.5,
    entryPrice: 0.9,
    feesEnabled: false,
  });
  const filled = bot.equalRiskStopExitDecision({ plan, bestBid: plan.stopPrice, shares: 5.5, feesEnabled: false });
  assert.equal(filled.executableAtFloor, true);
  assert.ok(Math.abs(filled.realizedLossUsdc - 0.5) < 0.0001);

  const gap = bot.equalRiskStopExitDecision({ plan, bestBid: plan.stopPrice - 0.1, shares: 5.5, feesEnabled: false });
  assert.equal(gap.executableAtFloor, false);
  assert.ok(gap.realizedLossUsdc > plan.riskTargetUsdc);
  assert.ok(gap.exitValueUsdc < plan.minimumExitValueUsdc);
});

test("equal risk: entry is rejected when the current bid is already below the stop floor", () => {
  const plan = bot.equalRiskStopPlan({
    totalCostUsdc: 5,
    netGainIfWinUsdc: 0.5,
    shares: 5.5,
    entryPrice: 0.9,
    feesEnabled: false,
  });
  assert.equal(bot.equalRiskEntryProtection({ plan, bestBid: plan.stopPrice, shares: 5.5, feesEnabled: false }).eligible, true);
  const wideSpread = bot.equalRiskEntryProtection({ plan, bestBid: plan.stopPrice - 0.1, shares: 5.5, feesEnabled: false });
  assert.equal(wideSpread.eligible, false);
  assert.match(wideSpread.reason, /below Equal stop floor/);
});

test("equal risk: the default portfolio requires meaningful traded volume", () => {
  assert.equal(bot.PAPER_STRATEGIES.equal.minLiquidityUsdc, 20000);
});

test("equal risk: portfolio shortlist rejects a wide spread before opening", () => {
  const strategy = { ...bot.PAPER_STRATEGIES.equal, minLiquidityUsdc: 0 };
  const candidate = {
    status: "ELIGIBLE",
    marketProbability: 0.94,
    marketPrice: 0.94,
    bestBid: 0.56,
    executableShares: 6.2921,
    totalCostUsdc: 5.91461,
    netGainIfWinUsdc: 0.3775,
    daysToResolution: 1,
    volume24hr: 25000,
    feesEnabled: false,
  };
  const result = bot.portfolioFilterResult(candidate, strategy);
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.some((reason) => /below Equal stop floor/.test(reason)));
  assert.deepEqual(bot.strategyEligibleCandidates([candidate], strategy), []);
});

test("equal risk: a past estimated end date does not bypass a still-live synthetic stop check", () => {
  // Sports start times and Gamma resolution estimates can be stale while CLOB still
  // has executable bids. Equal must inspect that book before it becomes pending.
  assert.equal(bot.shouldCheckEqualStopBeforePending({ equalRiskProtection: true, awaitingResolution: true, marketClosed: false }), true);
  assert.equal(bot.shouldCheckEqualStopBeforePending({ equalRiskProtection: false, awaitingResolution: true, marketClosed: false }), false);
  assert.equal(bot.shouldCheckEqualStopBeforePending({ equalRiskProtection: true, awaitingResolution: true, marketClosed: true }), false);
});

test("economics: net yield is measured against the real stake, not the target win", () => {
  // $0.30 net gain on a $5 stake is a 6% yield, not a 300% one.
  assert.equal(bot.netYieldAfterFees({ netGainIfWinUsdc: 0.3, stakeUsdc: 5 }), 0.06);
  assert.equal(
    bot.netYieldAfterFees({ netGainIfWinUsdc: 0.3, totalCostUsdc: 5, stakeUsdc: 1 }),
    0.06,
    "total cost wins over a bare stake because it already includes fees",
  );
  assert.equal(bot.netYieldAfterFees({ netGainIfWinUsdc: 0.3, stakeUsdc: 0 }), null, "a zero stake has no yield");
  assert.equal(bot.netYieldAfterFees({}), null);
  assert.equal(bot.netYieldAfterFees({ netYield: 0.04, netGainIfWinUsdc: 99, stakeUsdc: 1 }), 0.04, "stored yield is authoritative");
});

test("economics: stake sizing uses the deposit, never the potential win", () => {
  assert.equal(bot.totalCost({ totalCostUsdc: 5.02, maxLossUsdc: 5, stakeUsdc: 5 }), 5.02);
  assert.equal(bot.totalCost({ maxLossUsdc: 5, stakeUsdc: 4 }), 5);
  assert.equal(bot.totalCost({ stakeUsdc: 5 }), 5);
  assert.equal(bot.totalCost({}), 0);
  // A "Win @ $5" figure must never be mistaken for the order size.
  assert.equal(bot.totalCost({ potentialWinUsdc: 5 }), 0);
});

test("economics: a 0.0 day horizon is floored at one hour, not left unbounded", () => {
  const hour = 1 / 24;
  assert.equal(bot.annualizationDays(0), hour, "the horizon is floored at one hour");
  assert.equal(bot.annualizationDays(0.0001), hour);
  assert.equal(bot.annualizationDays(7), 7);
  assert.equal(bot.annualizationDays("nonsense"), null);

  const potential = bot.annualizedPotentialReturn(0.01, 0);
  assert.equal(potential, 0.01 * (365 / hour));
  assert.ok(Number.isFinite(potential), "a zero horizon must never divide by zero");
});

test("economics: same-day horizons rank apart instead of collapsing", () => {
  // The reason the floor moved from a day to an hour: the strategy targets markets
  // resolving today or already running, and a one-day floor gave every one of them
  // the same potential p.a., so a live event could not outrank one hours away.
  const netYield = 0.111121;
  const pa = (days) => bot.annualizedPotentialReturn(netYield, days);

  assert.ok(pa(0.1) > pa(0.3), "a market two hours out must outrank one seven hours out");
  assert.ok(pa(0.3) > pa(0.5), "and that ordering must hold across the whole day");
  assert.ok(pa(0.02) === pa(0.04), "below one hour they still share the floor");
  assert.equal(pa(1 / 24), netYield * 365 * 24, "one hour is the first horizon reported directly");
});

test("economics: potential P.A. scales with the remaining horizon", () => {
  assert.equal(bot.annualizeReturn(0.01, 7), 0.01 * (365 / 7));
  assert.equal(bot.annualizeReturn(0.01, 365), 0.01);
  assert.equal(bot.annualizeReturn(null, 7), null);
  assert.ok(
    bot.annualizedPotentialReturn(0.01, 3) > bot.annualizedPotentialReturn(0.01, 30),
    "a nearer resolution must rank higher for the same yield",
  );
});

test("economics: percentages never divide by a zero or negative basis", () => {
  assert.equal(bot.pnlPercent(5, 100), 0.05);
  assert.equal(bot.pnlPercent(5, 0), null);
  assert.equal(bot.pnlPercent(5, -100), null);
  assert.equal(bot.pnlPercent(0, 100), 0);
});

test("economics: a market buy prices through the book, not at the best ask", () => {
  const fill = bot.simulateMarketBuy(
    [{ price: 0.9, size: 2 }, { price: 0.95, size: 100 }],
    5,
  );
  // The first level only holds 0.9 * 2 = $1.80, so the rest fills at 0.95.
  assert.ok(fill.avgPrice > fill.bestAsk, "average execution price must include slippage");
  assert.equal(fill.bestAsk, 0.9);
  assert.ok(fill.slippage > 0);
  assert.equal(fill.filledUsdc, 5);
  assert.equal(fill.fillable, true);

  const thin = bot.simulateMarketBuy([{ price: 0.9, size: 1 }], 5);
  assert.equal(thin.fillable, false, "a book that cannot absorb the stake is not fillable");
});

test("portfolio: equity is initial capital plus realized and open P/L", () => {
  const portfolioState = {
    id: "conservative",
    label: "Paper - Conservative",
    trades: [
      { status: "WON", realizedPnlUsdc: 0.25, stakeUsdc: 5 },
      { status: "LOST", realizedPnlUsdc: -5, stakeUsdc: 5 },
      { status: "OPEN", unrealizedPnlUsdc: 0.1, stakeUsdc: 5, maxLossUsdc: 5 },
    ],
    portfolio: {},
  };
  bot.updatePaperPortfolio(portfolioState);
  const result = portfolioState.portfolio;

  assert.equal(result.realizedPnlUsdc, -4.75, "realized P/L sums every booked trade");
  assert.equal(result.openPnlUsdc, 0.1, "open P/L only marks positions that are still open");
  assert.equal(result.equityUsdc, 100 - 4.75 + 0.1);
  assert.equal(result.totalPnlUsdc, -4.65);
  assert.equal(result.totalPnlPct, bot.pnlPercent(-4.65, 100), "total P/L % is measured against original value");
});

test("portfolio: cash reserved by an open position is not free capital", () => {
  const withOpen = {
    id: "conservative",
    trades: [{ status: "OPEN", stakeUsdc: 5, maxLossUsdc: 5 }],
    portfolio: {},
  };
  bot.updatePaperPortfolio(withOpen);
  assert.equal(withOpen.portfolio.openRiskUsdc, 5);
  assert.equal(withOpen.portfolio.freeCapitalUsdc, 95, "the $5 at risk is not available for a new trade");

  // A position awaiting resolution still ties up capital.
  assert.equal(bot.openRisk([{ status: "PENDING_RESOLUTION", stakeUsdc: 5 }]), 5);
  assert.equal(bot.openRisk([{ status: "MARKET_NOT_FOUND", stakeUsdc: 5 }]), 5);
  // Closed trades release it.
  assert.equal(bot.openRisk([{ status: "WON", stakeUsdc: 5 }]), 0);
  assert.equal(bot.openRisk([{ status: "LOST", stakeUsdc: 5 }]), 0);
});

test("portfolio: an empty portfolio reports original value and full free capital", () => {
  const empty = { id: "conservative", trades: [], portfolio: {} };
  bot.updatePaperPortfolio(empty);
  assert.equal(empty.portfolio.equityUsdc, 100);
  assert.equal(empty.portfolio.realizedPnlUsdc, 0);
  assert.equal(empty.portfolio.freeCapitalUsdc, 100);
  assert.equal(empty.portfolio.openRiskUsdc, 0);
});

test("portfolio: persisting a state must not strip the computed aggregates", () => {
  // The reported dashboard bug. writeState() normalizes right before writing, and
  // normalizePaperPortfolio rebuilt `portfolio` from a configuration-only
  // whitelist, so equity and P/L never reached the published file. The frontend
  // then fell back to initialUsdc / 0 and showed "$100.00, +$0.00, $0.00 risk"
  // forever. Shape and numbers below mirror the live conservative portfolio
  // measured in production: 9 trades, 4 WON, realized 0.734, unrealized 0.079.
  const live = {
    paperPortfolios: {
      conservative: {
        trades: [
          { id: "w1", status: "WON", realizedPnlUsdc: 0.184, stakeUsdc: 5, maxLossUsdc: 5 },
          { id: "w2", status: "WON", realizedPnlUsdc: 0.18, stakeUsdc: 5, maxLossUsdc: 5 },
          { id: "w3", status: "WON", realizedPnlUsdc: 0.19, stakeUsdc: 5, maxLossUsdc: 5 },
          { id: "w4", status: "WON", realizedPnlUsdc: 0.18, stakeUsdc: 5, maxLossUsdc: 5 },
          { id: "o1", status: "OPEN", unrealizedPnlUsdc: 0.04, stakeUsdc: 5, maxLossUsdc: 5 },
          { id: "o2", status: "OPEN", unrealizedPnlUsdc: 0.039, stakeUsdc: 5, maxLossUsdc: 5 },
          { id: "p1", status: "PENDING_RESOLUTION", unrealizedPnlUsdc: 0, stakeUsdc: 5, maxLossUsdc: 5 },
          { id: "p2", status: "PENDING_RESOLUTION", unrealizedPnlUsdc: 0, stakeUsdc: 5, maxLossUsdc: 5 },
          { id: "p3", status: "PENDING_RESOLUTION", unrealizedPnlUsdc: 0, stakeUsdc: 5.16, maxLossUsdc: 5.16 },
        ],
        portfolio: {},
      },
    },
  };

  const persisted = bot.normalizeState(live);
  const conservative = persisted.paperPortfolios.conservative.portfolio;

  for (const field of [
    "equityUsdc", "realizedPnlUsdc", "realizedPnlPct", "openPnlUsdc",
    "openPnlPct", "totalPnlUsdc", "totalPnlPct", "openRiskUsdc", "freeCapitalUsdc",
  ]) {
    assert.ok(
      conservative[field] !== undefined,
      `${field} must survive normalization, otherwise the dashboard tile renders a default`,
    );
  }

  assert.equal(conservative.realizedPnlUsdc, 0.734, "the four settled wins must be booked");
  assert.ok(conservative.equityUsdc > 100, `equity must exceed the opening balance, got ${conservative.equityUsdc}`);
  assert.ok(conservative.openRiskUsdc > 0, "five open or pending positions still tie up capital");
  assert.ok(conservative.freeCapitalUsdc < 100, "free capital cannot still be the full opening balance");
  // The exact symptom, asserted so it can never silently return.
  assert.notEqual(conservative.equityUsdc, 100);
  assert.notEqual(conservative.totalPnlUsdc, 0);
});

test("portfolio: aggregates survive a repeated normalize round-trip", () => {
  const state = {
    paperPortfolios: {
      conservative: {
        trades: [{ id: "w1", status: "WON", realizedPnlUsdc: 0.25, stakeUsdc: 5, maxLossUsdc: 5 }],
        portfolio: {},
      },
    },
  };
  const once = bot.normalizeState(state);
  const twice = bot.normalizeState(once);
  assert.equal(
    twice.paperPortfolios.conservative.portfolio.equityUsdc,
    once.paperPortfolios.conservative.portfolio.equityUsdc,
  );
  assert.equal(twice.paperPortfolios.conservative.portfolio.realizedPnlUsdc, 0.25);
});

test("portfolio: a created portfolio's trades and run log survive a reload, not only the four shipped ones", () => {
  // Reported live: a portfolio created (and started) in the browser never opened a
  // single trade. normalizeState's paperPortfolios object literal only ever named the
  // four shipped portfolios, so every reload silently dropped every other key in
  // input.paperPortfolios -- a created portfolio's trades, run log and capital
  // adjustment included, however many cycles they had accumulated over. Its own
  // strategy is only known to PAPER_STRATEGIES once PAPER_CUSTOM_PORTFOLIOS is read at
  // import time, so this runs the real module fresh in a subprocess rather than
  // reaching for the copy this file already imported without one.
  const customPortfolios = JSON.stringify({
    createdtest: {
      displayName: "Created test portfolio",
      minProbability: 0.55,
      executionTrigger: "cron",
      automationEnabled: true,
    },
  });
  const rawInput = JSON.stringify({
    paperPortfolios: {
      createdtest: {
        trades: [{ id: "paper-createdtest-2026-08-01-1", status: "WON", realizedPnlUsdc: 3.5 }],
        runLog: [{ runAt: "2026-08-01T00:00:00Z", action: "OPENED" }],
        capitalAdjustmentUsdc: 12.5,
      },
    },
  });
  const modulePath = new URL("../tools/paper-trading-bot.mjs", import.meta.url).href;
  const script = `
    import { normalizeState } from ${JSON.stringify(modulePath)};
    const state = normalizeState(JSON.parse(process.argv[1]));
    process.stdout.write(JSON.stringify(state.paperPortfolios.createdtest ?? null));
  `;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script, rawInput], {
    encoding: "utf8",
    env: { ...process.env, PAPER_CUSTOM_PORTFOLIOS: customPortfolios },
  });
  const survived = JSON.parse(output);
  assert.ok(survived, "a created portfolio must exist in the normalized state at all");
  assert.equal(survived.trades?.length, 1, "its trade history must survive a reload");
  assert.equal(survived.trades[0].id, "paper-createdtest-2026-08-01-1");
  assert.equal(survived.runLog?.length, 1, "its run log must survive a reload");
  assert.equal(survived.capitalAdjustmentUsdc, 12.5, "its capital adjustment must survive a reload");
});

test("portfolio: a run that was never told about a created portfolio still must not delete it", () => {
  // Reported live: "75 + SL" showed OPENED rows in its run log and nothing in either
  // its open or its closed positions. Cause: not every workflow that writes paper
  // state loads the saved portfolio config first. The market scan runs this same module
  // with PAPER_CUSTOM_PORTFOLIOS unset, so PAPER_STRATEGIES there is only the four
  // shipped portfolios -- and normalizeState rebuilt paperPortfolios from that list
  // alone, dropping every created portfolio's trades before publishing the truncated
  // state over FTP. The run log survived only because it is appended to its own NDJSON
  // archive. So this runs the module with NO custom portfolios declared, exactly as a
  // scan does, and requires the persisted ones to come back untouched.
  const rawInput = JSON.stringify({
    paperPortfolios: {
      conservative: { trades: [], runLog: [] },
      ewportfolio: {
        id: "ewportfolio",
        label: "75 + SL",
        trades: [
          { id: "paper-ewportfolio-2026-08-19-1", status: "OPEN", stakeUsdc: 5 },
          { id: "paper-ewportfolio-2026-08-18-1", status: "WON", realizedPnlUsdc: 1.25 },
        ],
        runLog: [{ runAt: "2026-08-19T00:00:00Z", action: "OPENED" }],
        portfolio: { equityUsdc: 101.25 },
      },
    },
  });
  const modulePath = new URL("../tools/paper-trading-bot.mjs", import.meta.url).href;
  const script = `
    import { normalizeState } from ${JSON.stringify(modulePath)};
    const state = normalizeState(JSON.parse(process.argv[1]));
    process.stdout.write(JSON.stringify(state.paperPortfolios.ewportfolio ?? null));
  `;
  const env = { ...process.env };
  delete env.PAPER_CUSTOM_PORTFOLIOS;
  const kept = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script, rawInput], {
    encoding: "utf8",
    env,
  }));
  assert.ok(kept, "a portfolio this process has no strategy for must not be deleted from the state");
  assert.equal(kept.trades?.length, 2, "both its open and its closed trade must survive");
  assert.equal(kept.trades.filter((trade) => trade.status === "OPEN").length, 1);
  assert.equal(kept.runLog?.length, 1);
  // Kept verbatim: with no strategy to normalize against, re-deriving its numbers
  // would mean guessing them from another portfolio's rules.
  assert.equal(kept.portfolio?.equityUsdc, 101.25);
});

test("portfolio: state merge keeps a created portfolio when a scan lacks its configuration", () => {
  // Scheduled scans merge the hosted state with the checkout's seed state. The scan
  // does not know browser-created strategies, so this is the exact path that must not
  // silently rebuild their state from only the shipped portfolio ids.
  const hosted = bot.normalizeState({
    generatedAt: "2026-08-21T08:00:00.000Z",
    paperPortfolios: {
      custompreserved: {
        id: "custompreserved",
        label: "Custom preserved",
        trades: [
          { id: "custom-open", status: "OPEN", stakeUsdc: 5 },
          { id: "custom-won", status: "WON", realizedPnlUsdc: 0.5, stakeUsdc: 5 },
        ],
        runLog: [{ runAt: "2026-08-21T07:55:00.000Z", strategyId: "custompreserved", action: "OPENED" }],
        portfolio: { equityUsdc: 100.5 },
      },
    },
  });
  const seed = bot.normalizeState({
    generatedAt: "2026-08-01T00:00:00.000Z",
    paperPortfolios: { conservative: { trades: [], runLog: [] } },
  });

  const merged = bot.mergeStates(hosted, seed);
  const preserved = merged.paperPortfolios.custompreserved;
  assert.ok(preserved, "the created portfolio must survive the merge");
  assert.equal(preserved.trades.length, 2, "open and settled rows must both survive");
  assert.equal(preserved.runLog.length, 1, "its execution history must survive");
});

test("portfolio: normalization keeps the per-portfolio fixed stake", () => {
  // portfolio-config is the source of truth; equity and the global fraction must not resize it.
  const portfolioState = {
    id: "highReward",
    stakeUsdc: 4.25,
    maxFraction: 0.12,
    trades: [],
    portfolio: {},
  };
  bot.updatePaperPortfolio(portfolioState);
  assert.equal(portfolioState.portfolio.stakeUsdc, 4.25);
  assert.equal(portfolioState.portfolio.maxFraction, 0.12);
  assert.equal(portfolioState.portfolio.maxStakeUsdc, 4.25);
});

test("portfolio: closed trades with no booked P/L cannot invent equity", () => {
  // The counterpart guard: aggregates are derived, never fabricated.
  const unbooked = {
    id: "conservative",
    trades: [
      { status: "RESOLVED", finalOutcomePrice: 1, stakeUsdc: 5 },
      { status: "RESOLVED", finalOutcomePrice: 1, stakeUsdc: 5 },
    ],
    portfolio: {},
  };
  bot.updatePaperPortfolio(unbooked);
  assert.equal(unbooked.portfolio.equityUsdc, 100);
  assert.equal(unbooked.portfolio.realizedPnlUsdc, 0);
  assert.equal(unbooked.portfolio.openRiskUsdc, 0, "RESOLVED releases the reserved cash");
});

test("bootstrap: only the multi-portfolio schema may ever restore production", () => {
  assert.equal(bot.stateHasCurrentSchema({ paperPortfolios: { conservative: {} } }), true);
  // The legacy single-portfolio shape, which is what the old repository seed uses.
  assert.equal(bot.stateHasCurrentSchema({ portfolio: {}, trades: [], runLog: [] }), false);
  assert.equal(bot.stateHasCurrentSchema({ paperPortfolios: [] }), false, "an array is not the keyed schema");
  assert.equal(bot.stateHasCurrentSchema({}), false);
  assert.equal(bot.stateHasCurrentSchema(null), false);
  assert.equal(bot.stateHasCurrentSchema(undefined), false);
});

test("bootstrap: normalizing a legacy snapshot yields every current paper portfolio", () => {
  const migrated = bot.normalizeState({
    portfolio: { initialUsdc: 100 },
    trades: [{ id: "t1", status: "WON", realizedPnlUsdc: 0.2, stakeUsdc: 5 }],
    runLog: [],
  });
  assert.deepEqual(
    Object.keys(migrated.paperPortfolios).sort(),
    ["conservative", "equal", "highReward", "moreProbable"],
  );
  assert.equal(migrated.paperPortfolios.conservative.trades.length, 1);
  // Migration is for reading, and does not license republishing the seed.
  assert.equal(bot.stateHasCurrentSchema({ portfolio: {}, trades: [] }), false);
});

test("cadence: a cold state runs the full portfolio pass", () => {
  assert.equal(bot.resolveScheduledCadence({}).stage, "full");
  assert.equal(bot.resolveScheduledCadence({ cadence: {} }).stage, "full");
});

test("cadence: frequent scans must not starve an overdue portfolio pass", () => {
  // The reported regression: scans kept running while portfolios stood still.
  const starved = { cadence: { lastScanAt: minutesAgo(2), lastReportAt: minutesAgo(2), lastFullAt: minutesAgo(180) } };
  assert.equal(bot.resolveScheduledCadence(starved).stage, "full");
});

test("cadence: a completed pass is not immediately repeated", () => {
  const state = { generatedAt: new Date().toISOString(), cadence: {} };
  bot.markCadenceStage(state, "full");
  assert.equal(bot.resolveScheduledCadence(state).stage, "scan", "a full pass also satisfies the report cadence");

  const boundary = { cadence: { lastFullAt: minutesAgo(54), lastReportAt: minutesAgo(1) } };
  assert.equal(bot.resolveScheduledCadence(boundary).stage, "scan");
  const due = { cadence: { lastFullAt: minutesAgo(55), lastReportAt: minutesAgo(1) } };
  assert.equal(bot.resolveScheduledCadence(due).stage, "full");
});

test("cadence: a scan never satisfies the portfolio pass", () => {
  const state = { generatedAt: new Date().toISOString(), cadence: { lastFullAt: minutesAgo(200) } };
  bot.markCadenceStage(state, "scan");
  assert.equal(bot.resolveScheduledCadence(state).stage, "full");
});

test("cadence: an overdue report runs once the full pass is current", () => {
  const state = { cadence: { lastFullAt: minutesAgo(10), lastReportAt: minutesAgo(90) } };
  assert.equal(bot.resolveScheduledCadence(state).stage, "report");
});

test("cadence: a stale snapshot can never rewind the clocks", () => {
  const merged = bot.mergeCadence(
    { lastFullAt: minutesAgo(10), lastReportAt: minutesAgo(10), lastRunAt: minutesAgo(10), lastStage: "full" },
    { lastFullAt: minutesAgo(30000), lastReportAt: minutesAgo(30000), lastRunAt: minutesAgo(30000), lastStage: "full" },
  );
  assert.equal(bot.resolveScheduledCadence({ cadence: merged }).stage, "scan");
  assert.equal(merged.lastFullAt, minutesAgo(10).slice(0, 16) + merged.lastFullAt.slice(16));
  assert.ok(Date.parse(merged.lastFullAt) > Date.parse(minutesAgo(20)), "the later timestamp wins");
});

test("cadence: unparseable timestamps are treated as never, not as recent", () => {
  assert.equal(bot.resolveScheduledCadence({ cadence: { lastFullAt: "not-a-date" } }).stage, "full");
  assert.equal(bot.normalizeCadence({ lastFullAt: "nope" }).lastFullAt, null);
  assert.equal(bot.minutesSinceIso(""), Infinity);
  assert.equal(bot.minutesSinceIso(undefined), Infinity);
});

test("cadence is persisted through normalizeState", () => {
  const state = { generatedAt: new Date().toISOString(), cadence: {} };
  bot.markCadenceStage(state, "full");
  const persisted = bot.normalizeState(state);
  assert.equal(persisted.cadence.lastFullAt, state.cadence.lastFullAt);
  assert.equal(persisted.cadence.lastStage, "full");
});

test("risk: two markets on the same event share a risk key", () => {
  // Diversification is enforced by key overlap, so two different questions about
  // one Fed meeting must collide rather than both becoming candidates.
  const cut = bot.riskProfile({
    question: "Will the Fed cut rates at the September meeting?",
    slug: "fed-cut-september",
    eventSlug: "fed-september-decision",
    outcome: "Yes",
    tags: ["fed"],
  });
  const hold = bot.riskProfile({
    question: "Will the Fed hold rates at the September meeting?",
    slug: "fed-hold-september",
    eventSlug: "fed-september-decision",
    outcome: "Yes",
    tags: ["fed"],
  });
  assert.ok(cut.keys.length > 0, "a market must expose risk keys");
  const shared = cut.keys.filter((key) => hold.keys.includes(key));
  assert.ok(shared.length > 0, `same-event markets must overlap, got ${JSON.stringify(cut.keys)} vs ${JSON.stringify(hold.keys)}`);

  // A genuinely unrelated market must not collide with it.
  const unrelated = bot.riskProfile({
    question: "Will Real Madrid beat Barcelona?",
    slug: "real-madrid-barcelona",
    eventSlug: "laliga-clasico",
    outcome: "Yes",
    tags: ["sports"],
  });
  assert.equal(
    cut.keys.filter((key) => unrelated.keys.includes(key)).length,
    0,
    "unrelated markets must not block each other",
  );
});

test("risk: both sides of one football match collide", () => {
  const home = bot.riskProfile({
    question: "Will Arsenal beat Chelsea?",
    slug: "arsenal-chelsea",
    eventSlug: "arsenal-vs-chelsea",
    outcome: "Yes",
    tags: ["sports"],
  });
  const away = bot.riskProfile({
    question: "Will Chelsea beat Arsenal?",
    slug: "chelsea-arsenal",
    eventSlug: "arsenal-vs-chelsea",
    outcome: "Yes",
    tags: ["sports"],
  });
  assert.ok(
    home.keys.filter((key) => away.keys.includes(key)).length > 0,
    "the same fixture must be one risk group regardless of which side is quoted",
  );
});

test("fixture: the committed paper fixture matches the current schema", async () => {
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(new URL("../data/paper-state.fixture.json", import.meta.url), "utf8");
  const fixture = JSON.parse(raw);

  assert.equal(bot.stateHasCurrentSchema(fixture), true, "the fixture must never regress to the legacy schema");
  assert.deepEqual(
    Object.keys(fixture.paperPortfolios).sort(),
    ["conservative", "highReward", "moreProbable"],
    "all three paper portfolios must be present",
  );

  for (const [name, portfolio] of Object.entries(fixture.paperPortfolios)) {
    assert.ok(portfolio.trades.length > 0, `${name} must carry trades`);
    for (const field of ["equityUsdc", "realizedPnlUsdc", "openPnlUsdc", "openRiskUsdc", "freeCapitalUsdc", "totalPnlUsdc"]) {
      assert.equal(typeof portfolio.portfolio[field], "number", `${name}.${field} must be a number`);
    }
    assert.notEqual(portfolio.portfolio.equityUsdc, 100, `${name} equity must be realistic, not the bare opening balance`);
    assert.ok(portfolio.portfolio.openRiskUsdc > 0, `${name} must hold capital at risk`);
    assert.ok(portfolio.portfolio.freeCapitalUsdc < 100, `${name} free capital must reflect the reserved cash`);
    assert.ok(portfolio.runLog.length > 0, `${name} must carry a run log`);
  }

  // A losing portfolio and a winning one, so P/L formatting is exercised both ways.
  assert.ok(fixture.paperPortfolios.highReward.portfolio.realizedPnlUsdc < 0);
  assert.ok(fixture.paperPortfolios.conservative.portfolio.realizedPnlUsdc > 0);

  const statuses = new Set(
    Object.values(fixture.paperPortfolios).flatMap((p) => p.trades.map((t) => t.status)),
  );
  for (const expected of ["OPEN", "WON", "LOST", "PENDING_RESOLUTION"]) {
    assert.ok(statuses.has(expected), `the fixture must include a ${expected} trade`);
  }

  assert.ok(fixture.marketObservations.length > 0, "scraped opportunities must be present");
  assert.ok(fixture.evaluations.length > 0, "evaluated opportunities must be present");
  assert.ok(fixture.marketScanHistory.length > 0, "a scan log must be present");

  // Only the four global statuses are allowed on opportunities.
  const allowed = new Set(["SCRAPED", "EVALUATED", "RESOLVED", "ERROR"]);
  for (const row of [...fixture.marketObservations, ...fixture.evaluations]) {
    assert.ok(allowed.has(String(row.status)), `unexpected opportunity status ${row.status}`);
  }

  // Anonymized: no real wallet, order or account identifiers.
  assert.ok(!/0x[a-fA-F0-9]{40}/.test(raw), "the fixture must not contain any wallet address");
});

test("fixture: normalizing the fixture is a no-op for its aggregates", async () => {
  const { readFile } = await import("node:fs/promises");
  const fixture = JSON.parse(await readFile(new URL("../data/paper-state.fixture.json", import.meta.url), "utf8"));
  const renormalized = bot.normalizeState(fixture);
  for (const name of ["conservative", "highReward", "moreProbable"]) {
    assert.equal(
      renormalized.paperPortfolios[name].portfolio.equityUsdc,
      fixture.paperPortfolios[name].portfolio.equityUsdc,
      `${name} equity must be stable across a normalize round-trip`,
    );
  }
});

test("paper cadence: deployable capital brings the execution pass forward", () => {
  // Only a full pass executes a portfolio, so capital that became free right after one
  // sat idle for the rest of the 55-minute cadence even though it had somewhere to go.
  const at = (minutesAgoValue) => new Date(Date.now() - minutesAgoValue * 60000).toISOString();
  const withCapital = (free, stake) => ({
    paperPortfolios: { conservative: { portfolio: { freeCapitalUsdc: free, maxStakeUsdc: stake } } },
  });
  const stage = (free, stake, lastFullMinutes) => bot.resolveScheduledCadence({
    ...withCapital(free, stake),
    cadence: { lastFullAt: at(lastFullMinutes), lastReportAt: at(1) },
  });

  // Fundable capital forces the pass on the next scheduled tick.
  const forced = stage(5, 5, 12);
  assert.equal(forced.stage, "full");
  assert.equal(forced.broughtForwardByCapital, true);
  assert.deepEqual(forced.capitalReadyPortfolios, ["conservative"]);

  // But not immediately after a pass: otherwise a portfolio that stays funded because
  // nothing is eligible turns every tick into the expensive stage.
  const tooSoon = stage(5, 5, 4);
  assert.equal(tooSoon.stage, "scan");
  assert.ok(!tooSoon.broughtForwardByCapital);

  // Capital short of a whole stake must not force anything: executePortfolio would report
  // insufficient capital and the pass would buy nothing.
  assert.equal(stage(2, 5, 12).stage, "scan");
  assert.equal(stage(4.99, 5, 12).stage, "scan");

  // The normal cadence still fires on its own, and is not mislabelled as capital-driven.
  const normal = stage(0, 5, 60);
  assert.equal(normal.stage, "full");
  assert.ok(!normal.broughtForwardByCapital);

  // The predicate itself, including the degenerate stake.
  assert.deepEqual(bot.portfoliosWithDeployableCapital(withCapital(5, 5)), ["conservative"]);
  assert.deepEqual(bot.portfoliosWithDeployableCapital(withCapital(4.99, 5)), []);
  assert.deepEqual(bot.portfoliosWithDeployableCapital(withCapital(50, 0)), [],
    "a zero stake is not something to deploy into");
  assert.deepEqual(bot.portfoliosWithDeployableCapital({}), []);
});

test("live execution: the run evaluates the shortlist that is on screen", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  // Reported: the run log listed completely different markets from the live portfolio's
  // Execution candidates. The shortlist was honoured end to end -- the run showed
  // manualShortlistMatched 16 of 16 with no fallback -- so the divergence was on the
  // browser side: freshLiveWorkflowPayload refetches the scraped state and rebuilds the
  // shortlist from it, but never re-rendered, so the table kept showing the previous
  // catalogue while the newly fetched one was submitted. Short-dated sports and esports
  // markets turn over within minutes, so the two drift apart easily.
  const fn = app.slice(app.indexOf("async function freshLiveWorkflowPayload"));
  const body = fn.slice(0, fn.indexOf("\nasync function triggerOneTimeExecution"));

  const storeAt = body.indexOf("storeScrapedMarketState(scrapedState);");
  const renderAt = body.search(/if \(state\.page === "opportunities"\) renderBotEvaluations\(\);/);
  const payloadAt = body.indexOf("liveWorkflowPayload();");
  assert.ok(storeAt >= 0 && renderAt >= 0 && payloadAt >= 0, "all three steps must be present");
  assert.ok(renderAt > storeAt, "the re-render must follow the refetch that replaced the rows");
  assert.ok(renderAt < payloadAt, "and precede building the shortlist, so screen and payload agree");
  assert.match(body, /else rerenderCurrentDashboard\(\);/);

  // Refreshing the shortlist is part of running, not a precondition the user has to
  // satisfy first -- the refetch above already did it. An empty result is not a reason
  // to refuse either: with no shortlist supplied the executor scans for candidates
  // itself, exactly as a scheduled run does.
  assert.ok(!/Refresh the shortlist before starting a live order run/.test(app),
    "a manual run must not be blocked on a shortlist it refreshes itself");

  // The shortlist is still taken from the same rows the table renders.
  assert.match(app, /const shortlistTokenIds = portfolioCandidateRows\("live"\)/);

  // And the count actually submitted is reported, so the run log can be checked against
  // it rather than taken on trust.
  assert.match(app, /"Shortlist submitted"/);
  assert.match(app, /live_execution_candidate_token_ids \|\| ""\)\s*\n\s*\.split\(","\)\.filter\(Boolean\)\.length/);
});

test("queue janitor: a stuck run cannot head-block a concurrency group forever", async () => {
  const { readFile } = await import("node:fs/promises");
  const janitor = await readFile(new URL("../../.github/workflows/trading-queue-janitor.yml", import.meta.url), "utf8");

  // Why this exists: a run that cannot get a runner holds its concurrency group, and every
  // later dispatch then sits pending with no job created -- nothing executes and nothing
  // reaches the run log. Clearing it meant cancelling runs by hand in the GitHub UI.
  assert.match(janitor, /actions: write/, "cancelling runs needs this permission");
  assert.match(janitor, /schedule:\s*\n\s*- cron: '\*\/15 \* \* \* \*'/, "it has to run unattended");

  // Both states block a group, and a pending run is the one with no job at all, so
  // checking only "queued" would miss exactly the case this was built for.
  assert.match(janitor, /for status in \("queued", "pending"\):/);

  // A run that is genuinely executing must never be touched -- only waiting ones, and
  // only past the grace period.
  assert.match(janitor, /if age >= stale_minutes:/);
  assert.match(janitor, /stale_minutes = max\(5, int\(os\.environ\.get\("STALE_MINUTES"\) or 20\)\)/,
    "the grace period must have a floor so it cannot be set to something destructive");

  // It is itself queued while it runs, so without this it would cancel itself.
  assert.match(janitor, /if str\(run\.get\("id"\)\) == self_run_id:\s*\n\s*continue/);

  // A run that started in the meantime returns 409; that is success, not an error.
  assert.match(janitor, /level = "notice" if exc\.code == 409 else "warning"/);
});

test("live sync: an open dashboard cannot dispatch a workflow every 30 seconds", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");
  const api = await readFile(new URL("../api.php", import.meta.url), "utf8");

  // What this prevents: LIVE_SYNC_REQUEST_MS was 30000 and the dispatch poll ran on the
  // 15s state-refresh interval, so one open tab dispatched a full Actions run every 30
  // seconds -- 88 of the repo's last 100 runs were this one workflow. That saturated the
  // account's runner capacity, and deploy / market scan / paper bot / live execution then
  // sat with runner='' until GitHub cancelled each at 15 minutes. The visible symptoms
  // were "Scan is still queued in the background", a frontend fix that never reached the
  // hosting, and manual execution stuck pending.
  const requestMs = Number(/const LIVE_SYNC_REQUEST_MS = (\d+);/.exec(app)?.[1]);
  assert.ok(Number.isFinite(requestMs), "the background sync cadence must be declared");
  assert.ok(requestMs >= 300000, `background dispatch must be minutes apart, got ${requestMs}ms`);

  // The poll must be paced by its own cadence, not by the fast state-refresh interval, so
  // the client asks no more often than the server would allow anyway.
  assert.match(app, /requestLiveAccountSync\(\{ quiet: true, minSeconds: LIVE_SYNC_REQUEST_MS \/ 1000 \}\);\s*\n\}, LIVE_SYNC_REQUEST_MS\);/);

  // Re-reading the published state stays fast: that is a static JSON fetch, not a run.
  const refreshMs = Number(/const LIVE_STATE_REFRESH_MS = (\d+);/.exec(app)?.[1]);
  assert.ok(refreshMs <= 60000, "reading the state should stay responsive");

  // The server floor is the only guard that survives a cached frontend, so it must be
  // enforced there too and not left at 30s.
  const floor = Number(/\$minSeconds = max\((\d+), min\(900,/.exec(api)?.[1]);
  assert.ok(Number.isFinite(floor), "the server-side throttle floor must exist");
  assert.ok(floor >= 120, `server floor must bound a stale client, got ${floor}s`);
  const fallback = Number(/min\(900, \(int\) \(\$_GET\['minSeconds'\] \?\? (\d+)\)\)/.exec(api)?.[1]);
  assert.ok(fallback >= 300, `the default must not be aggressive either, got ${fallback}s`);

  // A deliberate click may still dispatch sooner than the background cadence.
  const manual = Number(/const LIVE_SYNC_MANUAL_SECONDS = (\d+);/.exec(app)?.[1]);
  assert.ok(Number.isFinite(manual), "the manual refresh throttle must be declared");
  assert.ok(manual >= floor && manual < requestMs / 1000,
    `a manual refresh must beat the background poll but respect the server floor, got ${manual}s`);
});

test("stake sizing: the summary row, the control and the executor use a fixed USDC stake", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");
  const executor = await readFile(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8");

  // The setting used to be a percentage of a moving equity base. It is now a fixed
  // nominal cap, so the displayed rule must not read equity or open P/L at all.
  const rule = app.slice(app.indexOf("function stakeSizingRuleValue"));
  const body = rule.slice(0, rule.indexOf("\nfunction "));
  assert.match(body, /const stake = normalizeRiskAllocation\(config\.stakeUsdc\) \?\? DEFAULT_RISK_ALLOCATION;/);
  assert.match(body, /return `\$\{money\(stake\)\} fixed per trade`;/);
  assert.ok(!/equity|openPnl|sizingBase|nominalStake/.test(body),
    "the rule row must not compute the stake from portfolio equity anymore");

  assert.match(app, /stake_usdc: config\.stakeUsdc/,
    "manual live dispatch must send the fixed stake to the workflow");
  // A paper portfolio's stake is saved, never dispatched. The workflow's "Load portfolio
  // config" step reads portfolio-config.json and appends it to GITHUB_ENV, which
  // overrides the job env for every later step -- so a per-strategy dispatch input could
  // not take effect even when it was declared, and sending one now that it is not
  // declared makes GitHub answer 422 "Unexpected inputs provided" for every manual run.
  assert.ok(!/paper_(?:conservative|high_reward|more_probable)_/.test(app),
    "the paper dispatch payload must carry no per-strategy inputs");
  const workflow = await readFile(new URL("../../.github/workflows/trading-paper-bot.yml", import.meta.url), "utf8");
  assert.match(workflow, /emit\(f"\{prefix\}_STAKE_USDC", row\.get\("stakeUsdc"\)\)/,
    "the workflow must read each portfolio's stake from the saved config instead");

  assert.match(executor, /const LIVE_STAKE_USDC = envNumber\("LIVE_STAKE_USDC", envNumber\("LIVE_FIXED_STAKE_USDC", NaN\)\);/,
    "the live executor must read the fixed stake from workflow input/env");
  assert.match(executor, /const configuredStakeUsdc = Number\.isFinite\(LIVE_STAKE_USDC\) && LIVE_STAKE_USDC > 0\s*\n\s*\? LIVE_STAKE_USDC\s*\n\s*: legacyFractionNotional;/,
    "legacy percentage sizing may only be a fallback for old runs");

  // Paper also keeps the configured fixed stake instead of rebasing it when the
  // account equity changes.
  const bot = await readFile(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");
  assert.match(bot, /const configuredStakeUsdc = Number\(portfolioState\.stakeUsdc \?\? portfolioState\.portfolio\?\.stakeUsdc\);/);
  assert.match(bot, /maxStakeUsdc: Number\(portfolioStakeUsdc\.toFixed\(2\)\)/);
  assert.ok(!/maxStakeUsdc: Number\(\(equity \* portfolioMaxFraction\)\.toFixed\(2\)\)/.test(bot),
    "paper portfolios must not turn the old percentage into a moving stake");
});

test("market scan: sports and esports get a guaranteed slot every hour", async () => {
  const scopes = await bot.marketScanScopes();
  const indexOf = (slug) => scopes.findIndex((scope) => scope.tag?.slug === slug);
  assert.deepEqual(bot.MARKET_SCAN_HOURLY_TAG_SLUGS, ["sports", "esports"]);
  // The rotation is long enough that these tags' full pass came round only every few
  // hours, which is what the guaranteed slot exists to fix.
  assert.ok(scopes.length > 20, `expected the full rotation, got ${scopes.length}`);

  const now = Date.parse("2026-08-06T18:00:00Z");
  const iso = (minutesAgoValue) => new Date(now - minutesAgoValue * 60000).toISOString();

  // Never scanned counts as overdue, so a fresh state picks these up immediately.
  assert.equal(bot.overdueHourlyScanScope(scopes, {}, now), indexOf("sports"));

  // Both overdue: the older one wins, so they cannot starve each other.
  const bothOverdue = { tagScannedAt: { "tag:sports": iso(70), "tag:esports": iso(200) } };
  assert.equal(bot.overdueHourlyScanScope(scopes, bothOverdue, now), indexOf("esports"));

  // Only one overdue.
  const onlySports = { tagScannedAt: { "tag:sports": iso(90), "tag:esports": iso(5) } };
  assert.equal(bot.overdueHourlyScanScope(scopes, onlySports, now), indexOf("sports"));

  // Both fresh: the normal rotation must be left alone, or every other tag starves.
  const bothFresh = { tagScannedAt: { "tag:sports": iso(10), "tag:esports": iso(20) } };
  assert.equal(bot.overdueHourlyScanScope(scopes, bothFresh, now), null);

  // Exactly at the boundary counts as due, so drift cannot push a pass past the hour.
  const atBoundary = { tagScannedAt: { "tag:sports": iso(60), "tag:esports": iso(1) } };
  assert.equal(bot.overdueHourlyScanScope(scopes, atBoundary, now), indexOf("sports"));
});

test("market scan: the borrowed slot delays the rotation without skipping a scope", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");

  // Borrowing a run for sports/esports must not advance the rotation cursor, otherwise
  // every borrowed slot would silently skip whichever scope was next in line.
  assert.match(source, /scanScopeCursor: usedHourlySlot \? rotationIndex : \(scopeIndex \+ 1\) % scopes\.length/);
  // And the per-scope timestamp has to be persisted, or the slot reads an empty map every
  // run, believes both tags are permanently overdue, and the rotation never moves at all.
  assert.match(source, /tagScannedAt: \{ \.\.\.\(previousScan\.tagScannedAt \|\| \{\}\), \[scope\.key\]: scanRunAt \}/);
  const normalize = source.slice(source.indexOf("function normalizeMarketScan"));
  assert.match(normalize.slice(0, normalize.indexOf("\nfunction ")), /tagScannedAt: Object\.fromEntries\(/,
    "normalizeMarketScan must carry tagScannedAt through");
});

test("trade table: every header lines up with the cell beneath it", async () => {
  // Headers and cells are two separate lists in one template, so reordering columns can
  // silently shift values under the wrong heading -- a P/L read as a stake is worse than
  // a missing column. This pins them together whatever order they are in.
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  const fn = app.slice(app.indexOf("function renderTradeRows"));
  const body = fn.slice(0, fn.indexOf("\nfunction ", 1));
  const thead = body.slice(body.indexOf("<thead>"), body.indexOf("</thead>"));
  const tbody = body.slice(body.indexOf("<tbody>"), body.indexOf("</tbody>"));

  const conditional = (text) => {
    const match = /\?\s*"([^"]+)"\s*:\s*"([^"]+)"/.exec(text);
    return match ? `${match[1]}|${match[2]}` : text.replaceAll('"', "").trim();
  };
  const headers = [...thead.matchAll(/tradeHeader\(tableKey,\s*(?:showStatus \? "\w+" : "\w+"|"\w+"),\s*(showStatus \? "[^"]+" : "[^"]+"|"[^"]+")\)/g)]
    .map((match) => conditional(match[1]));
  // Any attribute may precede data-label -- the Market cell carries a class first -- and
  // requiring it to come first made the extractor skip that column and report a
  // misalignment that was not there. The order of the cells is what this test is about,
  // not the order of attributes within one.
  const cells = [...tbody.matchAll(/<td\b[^>]*?\bdata-label="(\$\{showStatus \? "[^"]+" : "[^"]+"\}|[^"]+)"/g)]
    .map((match) => conditional(match[1]));

  assert.ok(headers.length >= 10, `expected the full column set, found ${headers.length}`);
  assert.deepEqual(cells, headers, "each column's cell must sit under its own header");

  // The Result column only exists in one of the two views and must stay conditional, or
  // the open table gains an empty column and the closed one loses a value.
  assert.ok(thead.includes('showStatus ? tradeHeader(tableKey, "status", "Result")'));
  assert.ok(tbody.includes('showStatus ? `<td data-label="Result"'));

  // The AI probability column used to be the other conditional one, suppressed on the
  // open tables and left on the closed ones. The scoring pipeline it came from is
  // retired -- every portfolio scores on the Polymarket probability -- so the column
  // could only ever show a figure from a system no longer running, on rows old enough
  // to have one. A stale number reads as a current one, so it is gone rather than
  // hidden in one more place.
  assert.ok(!/AI prob\./.test(body), "no AI probability column in the trade tables");
  assert.ok(!/showAiProbability/.test(app), "and no leftover switch for it");
});

test("closed trades: the header exposes a Google Sheets CSV export", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  assert.match(html, /data-closed-trades-export/, "closed tab must expose the export button");
  assert.match(app, /function exportClosedTradesCsv\(\)/, "the export action must be implemented");
  assert.match(app, /closedTradesForCurrentPortfolio\(\)/, "export must use the active portfolio data, not DOM text");
  for (const column of ["portfolio", "status", "prediction_result", "outcome", "market", "polymarket_url"]) {
    assert.match(app, new RegExp(`${column}:`), `CSV includes ${column}`);
  }
  assert.match(app, /win_if_correct_usdc/, "CSV includes the Win column as a numeric value");
  assert.match(app, /realized_pl_usdc/, "CSV includes the P\\/L column as a numeric value");
  assert.match(app, /els\.closedTradesExport\?\.addEventListener\("click", exportClosedTradesCsv\)/);
});

test("candidates: the precheck column has no WAITING state", async () => {
  // The precheck column is informational. Execution revalidates every shortlisted
  // candidate from scratch and the shortlist is dispatched without consulting the
  // column, so a retryable verdict from a previous run is not a gate. Guarding the
  // vocabulary here keeps WAITING from silently returning as a pseudo-state.
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  const precheckLine = app.split("\n").find((line) => line.includes("const precheck ="));
  assert.ok(precheckLine, "the precheck label assignment must exist");
  assert.match(precheckLine, /"EXCLUDED"/);
  assert.match(precheckLine, /"RISK-BLOCKED"/);
  assert.match(precheckLine, /"READY"/);
  assert.doesNotMatch(precheckLine, /WAITING/, "a retryable verdict must not render as its own precheck state");

  // The retention rule must survive: a temporary block keeps the row in the
  // shortlist so the next run can retry it, while a permanent failure drops it.
  assert.ok(
    app.includes("!executionCheck.retryable"),
    "retryable revalidation verdicts must still keep the candidate in the shortlist",
  );

  // The dispatched shortlist must not be filtered by the precheck column.
  const payload = app.slice(app.indexOf("function liveWorkflowPayload"), app.indexOf("async function fetchFreshState"));
  assert.doesNotMatch(payload, /precheck|retryable|RISK-BLOCKED/, "the shortlist dispatch must not depend on precheck state");
});

test("annualization: the reported shortlist figures came from the old one-day floor", () => {
  // Kept as the record of the diagnosis: 0.111121 * 365 / 1 day = 4,055.9%, which is
  // why six candidates between 0.1 and 0.5 days all reported the same number. With
  // the one-hour floor those same rows now differ.
  const netYield = 0.111121;
  const oldFloorPa = (days) => Number((netYield * 365 / Math.max(1, days) * 100).toFixed(1));
  assert.equal(oldFloorPa(0.1), 4055.9);
  assert.equal(oldFloorPa(0.5), 4055.9);

  const now = (days) => Number((bot.annualizedPotentialReturn(netYield, days) * 100).toFixed(1));
  assert.notEqual(now(0.1), now(0.5), "the same two rows must no longer tie");
  assert.ok(now(0.1) > now(0.5));
});

test("annualization: the floor is what keeps a 0.0 day horizon finite", () => {
  assert.equal(bot.annualizationDays(0), 1 / 24);
  const withFloor = bot.annualizedPotentialReturn(0.111121, 0);
  assert.ok(Number.isFinite(withFloor), "a zero horizon must stay finite");
  assert.equal(withFloor, 0.111121 * 365 * 24, "a zero horizon reports the one-hour figure");
});

test("annualization: the floor is identical in the bot, the executor and the UI", async () => {
  // Three independent copies of this constant exist. If they drift, the shortlist
  // the browser ranks stops matching the shortlist the executor trades.
  const { readFile } = await import("node:fs/promises");
  const [app, executor] = await Promise.all([
    readFile(new URL("../assets/app.js", import.meta.url), "utf8"),
    readFile(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8"),
  ]);

  assert.equal(bot.annualizationDays(0.3), 0.3, "a horizon above the floor is used as-is");
  assert.equal(bot.annualizationDays(0), 1 / 24, "bot floor is one hour");
  assert.match(app, /const MIN_ANNUALIZATION_DAYS = 1 \/ 24;/, "UI floor must stay one hour");
  assert.match(
    executor,
    /MIN_ANNUALIZATION_DAYS = Math\.max\(ONE_HOUR_IN_DAYS, envNumber\("LIVE_MIN_ANNUALIZATION_DAYS", ONE_HOUR_IN_DAYS\)\)/,
    "executor floor must stay one hour and must never fall below it",
  );

  // The UI must annualize with the same formula, otherwise the displayed ranking
  // metric is not the one execution uses.
  assert.match(app, /value \* \(365 \/ horizon\)/);
});

test("resolved observations: the last live quote survives settlement", () => {
  // A settled book prints 0 or 1. Without a preserved value every resolved row in
  // the scraped list would read 0% or 100% instead of the probability the market
  // carried while it was tradable.
  const live = bot.withLastLiveMarketProbability({ status: "SCRAPED", marketProbability: 0.93 });
  assert.equal(live.lastLiveMarketProbability, 0.93);

  // While tradable it tracks the current quote, it does not freeze on the first one.
  const moved = bot.withLastLiveMarketProbability({ ...live, marketProbability: 0.97 });
  assert.equal(moved.lastLiveMarketProbability, 0.97);

  // Once resolved it freezes, whatever the book now says.
  const settled = bot.withLastLiveMarketProbability({ ...moved, status: "RESOLVED", marketProbability: 1 });
  assert.equal(settled.lastLiveMarketProbability, 0.97, "settlement must not overwrite the last live quote");
  const again = bot.withLastLiveMarketProbability({ ...settled, marketProbability: 0 });
  assert.equal(again.lastLiveMarketProbability, 0.97, "a later resolution update must not move it either");

  // Resolving while the book still quotes normally captures that quote.
  const captured = bot.withLastLiveMarketProbability({ status: "RESOLVED", marketProbability: 0.88 });
  assert.equal(captured.lastLiveMarketProbability, 0.88);

  // A row that is already settled and never had a live quote stays untouched.
  const noQuote = bot.withLastLiveMarketProbability({ status: "RESOLVED", marketProbability: 1 });
  assert.equal(noQuote.lastLiveMarketProbability, undefined);

  // marketClosed / acceptingOrders count as resolved even without the status.
  const closed = bot.withLastLiveMarketProbability({ marketProbability: 0.91, marketClosed: true });
  assert.equal(closed.lastLiveMarketProbability, 0.91);
  const frozenByClose = bot.withLastLiveMarketProbability({ ...closed, marketProbability: 1, marketClosed: true });
  assert.equal(frozenByClose.lastLiveMarketProbability, 0.91);
});

test("resolved observations: the scraped view surfaces them without a days filter", async () => {
  const { readFile } = await import("node:fs/promises");
  const [app, api] = await Promise.all([
    readFile(new URL("../assets/app.js", import.meta.url), "utf8"),
    readFile(new URL("../api.php", import.meta.url), "utf8"),
  ]);

  // The backend must send resolved rows, otherwise the tab can never list or count them.
  assert.match(api, /function is_resolved_scraped_market_observation/);
  assert.match(api, /\$active = array_merge\(\$active, \$resolved\);/);
  // And the fields the tab needs must survive compaction.
  for (const field of [
    "'lastLiveMarketProbability'",
    "'firstVolumeUsdc'",
    "'resolvedVolumeUsdc'",
    "'resolvedVolume24hr'",
    "'finalOutcomePrice'",
    "'marketClosed'",
    "'acceptingOrders'",
    "'polymarketCategories'",
    "'firstPolymarketTags'",
    "'firstPolymarketCategories'",
  ]) {
    assert.ok(api.includes(field), `compact_market_observation must keep ${field}`);
  }

  // No tradability filter may apply to a resolved row, and all of them are hidden there.
  assert.match(app, /if \(scrapedObservationStatus\(item\) === "RESOLVED"\) return true;/);
  assert.match(app, /function tradabilityFiltersAreIrrelevant/);
  assert.match(app, /element\.hidden = scanLog \|\| tradabilityFiltersAreIrrelevant\(\);/);
  // The markup must mark every one of them, or a leftover value silently empties the tab.
  const marked = (await readFile(new URL("../index.html", import.meta.url), "utf8"))
    .split("\n").filter((line) => line.includes("data-tradability-filter"));
  assert.equal(marked.length, 3, "days left, net yield and liquidity must all be marked");
  for (const needle of ["evaluation-days-control", "evaluation-net-yield-control", "evaluation-liquidity-control"]) {
    assert.ok(marked.some((line) => line.includes(needle)), `${needle} must be a tradability filter`);
  }

  // The asset cache-busting version must be stamped at deploy time. A hand-written
  // tag that nobody bumps ships new JS that every browser ignores.
  const deploy = await readFile(new URL("../../.github/workflows/trading-deploy.yml", import.meta.url), "utf8");
  assert.match(deploy, /Stamp asset cache-busting versions/);
  assert.match(deploy, /ASSET_VERSION: \$\{\{ github\.sha \}\}/);
  // The displayed probability goes through the preserving helper.
  assert.match(app, /function scrapedDisplayProbability/);
  assert.match(app, /probability\(Number\(scrapedDisplayProbability\(item\)\)\)/);
});

test("fixture: resolved observations carry a preserved live probability", async () => {
  const { readFile } = await import("node:fs/promises");
  const fixture = JSON.parse(await readFile(new URL("../data/paper-state.fixture.json", import.meta.url), "utf8"));
  const resolved = fixture.marketObservations.filter((row) => String(row.status).toUpperCase() === "RESOLVED");
  assert.ok(resolved.length >= 2, "the fixture must exercise the Resolved tab");

  for (const row of resolved) {
    const preserved = Number(row.lastLiveMarketProbability);
    assert.ok(preserved > 0 && preserved < 1, `${row.id} must keep a live probability, got ${preserved}`);
    assert.equal(row.finalOutcomePrice, 1, `${row.id} must report its settlement outcome separately`);
  }

  // The already-settled row proves the settled book did not overwrite the quote.
  const settled = resolved.find((row) => Number(row.marketProbability) >= 1);
  assert.ok(settled, "one resolved row must already show a settled book");
  assert.equal(settled.lastLiveMarketProbability, 0.96);
});

test("manual scan: publication is confirmed against the runner, not the browser clock", async () => {
  // The reported failure: the scan workflow succeeded and its run really was in the
  // published state (id scan-2026-08-04T20:27:55.054Z, uploaded at 20:28:00), yet the
  // UI reported the data as unpublished. The old check compared the runner's
  // timestamps against `new Date()` in the browser, so a clock a few minutes off
  // rejected a publication that had plainly landed.
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  const fn = app.slice(
    app.indexOf("function scrapedScanWasPublishedAfter"),
    app.indexOf("function loadScrapeRunHistory"),
  );
  assert.ok(fn.length > 0, "the publication check must exist");
  assert.doesNotMatch(fn, /startedAt/, "the check must not depend on a browser timestamp");
  assert.doesNotMatch(fn, /Date\.now\(\)/, "nor on the browser clock at all");
  assert.match(fn, /baseline\.newestScanTime/, "it compares against the pre-dispatch snapshot");

  // A successful workflow must never be reported as an error just because the
  // publication was not observed within the wait.
  assert.match(app, /return \{ state: lastState, confirmed: false \};/);
  assert.doesNotMatch(app, /its new scraped data has not been published yet/);
  assert.match(app, /Scan completed\. Its results are still being published/);
});

test("closed trades: the Resolution column shows Polymarket's date, not our close time", async () => {
  // Reported bug: every closed live row repeated its own Closed timestamp in the
  // Resolution column, because the date accessor fell back to closedTime and then
  // resolvedAt whenever Polymarket's endDate was absent.
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  const accessor = app.slice(
    app.indexOf("function tradeResolutionDate"),
    app.indexOf("function resolutionCell"),
  );
  assert.ok(accessor.length > 0, "a dedicated Polymarket-date accessor must exist");
  assert.doesNotMatch(accessor, /closedTime/, "the resolution date must never come from our close time");
  assert.doesNotMatch(accessor, /resolvedAt/, "nor from when we booked the result");
  assert.match(accessor, /trade\?\.endDate/, "it reads Polymarket's end date");

  // The cell must render that accessor, not the fallback-bearing one.
  const cell = app.slice(app.indexOf("function resolutionCell"), app.indexOf("function holdingCell"));
  assert.match(cell, /escapeHtml\(resolutionDate \? formatDate\(resolutionDate\) : "-"\)/);
  // The horizon maths keeps its own fallback, so days-left behaviour is untouched.
  assert.match(cell, /const endDate = tradeEndDate\(trade\);/);
});

test("scraping: a market that already reads 100% is not stored", () => {
  // Reported gap: resolved rows often showed 100% market probability. A quote of
  // 0.9996 displays as 100.0% but passed the bare `>= 1` test, so it was scraped with
  // no upside left. Anything that rounds to 100.0% now counts as settled.
  const market = (yesPrice) => ({
    conditionId: "0xfixture",
    question: "Fixture market",
    slug: "fixture-market",
    active: true,
    closed: false,
    acceptingOrders: true,
    outcomes: JSON.stringify(["Yes", "No"]),
    outcomePrices: JSON.stringify([String(yesPrice), String(1 - yesPrice)]),
    clobTokenIds: JSON.stringify(["1000000000000000001", "1000000000000000002"]),
    endDate: new Date(Date.now() + 2 * 86400000).toISOString(),
  });

  assert.equal(bot.marketScanRetentionReason(market(0.9996)), "settled_outcome_probability",
    "a quote that displays as 100.0% must not be stored");
  assert.equal(bot.marketScanRetentionReason(market(1)), "settled_outcome_probability");
  assert.equal(bot.marketScanRetentionReason(market(0.0004)), "settled_outcome_probability",
    "the settled side is symmetric");

  // A genuinely tradable quote is still retained.
  assert.equal(bot.marketScanRetentionReason(market(0.95)), null);
  assert.equal(bot.marketScanRetentionReason(market(0.99)), null);

  // The threshold is exactly the rounding boundary, shared with the executor.
  assert.equal(bot.EFFECTIVELY_CERTAIN_MARKET_PROBABILITY, 0.9995);
});

test("state segments: the core file never carries the heavy collections", async () => {
  const { readFile } = await import("node:fs/promises");
  const state = bot.normalizeState(
    JSON.parse(await readFile(new URL("../data/paper-state.fixture.json", import.meta.url), "utf8")),
  );
  // The fixture has to actually exercise every segment, or this proves nothing.
  assert.ok(state.marketObservations.length > 0, "fixture must have market observations");
  assert.ok(state.evaluations.length > 0, "fixture must have evaluations");
  assert.ok(state.marketScanHistory.length > 0, "fixture must have scan history");
  const isResolved = (item) => String(item?.status || item?.selectionStatus || "").toUpperCase() === "RESOLVED";
  const resolvedRows = state.marketObservations.filter(isResolved);
  const activeRows = state.marketObservations.filter((item) => !isResolved(item));
  assert.ok(resolvedRows.length > 0, "fixture must have resolved observations");
  assert.ok(activeRows.length > 0, "fixture must have active observations");

  const { core, segments } = bot.splitStateIntoSegments(state);
  // resolvedRecent joined these: the archive is kept whole and the newest page of it is
  // published beside it, so the opportunities page never decodes all of history to show
  // its most recent rows. Each portfolio then got a segment of its own, so the core no
  // longer grows with every trade every portfolio has ever made and the dashboard reads
  // the history of just the one it is showing.
  const fixedSegments = ["archives", "evaluations", "observations", "reports", "resolvedObservations", "resolvedRecent", "scanHistory"];
  const portfolioSegments = Object.keys(state.paperPortfolios).map((id) => `portfolio:${id}`);
  assert.ok(portfolioSegments.length > 0, "fixture must have portfolios to segment");
  assert.deepEqual(Object.keys(segments).sort(), [...fixedSegments, ...portfolioSegments].sort());

  // The whole point is that a reader of the core file decodes none of the catalogue.
  assert.deepEqual(core.marketObservations, []);
  assert.deepEqual(core.evaluations, []);
  assert.deepEqual(core.marketScanHistory, []);
  assert.deepEqual(core.marketScan, {});
  // Portfolio headline numbers stay in the core: the overview renders them for every
  // portfolio at once, and they stay small however long a trade history grows.
  assert.equal(core.paperPortfolios.conservative.portfolio.equityUsdc, state.paperPortfolios.conservative.portfolio.equityUsdc);
  // The rows themselves are what the per-portfolio segments carry, so the core must be
  // emptied of them -- but every one still has to be somewhere, checked next.
  assert.deepEqual(core.paperPortfolios.conservative.trades, []);
  assert.deepEqual(core.trades, [], "the legacy top-level alias is emptied with the rest");
  for (const [id, portfolio] of Object.entries(state.paperPortfolios)) {
    assert.deepEqual(segments[`portfolio:${id}`].paperPortfolio.trades, portfolio.trades,
      `${id} must keep every trade in its own segment`);
    assert.equal(core.stateSegments[`portfolio:${id}`].counts.trades, portfolio.trades.length,
      `${id}'s manifest must state its real trade count`);
  }

  // Resolved history is archived apart from the active catalogue. That separation is
  // what lets it accumulate instead of competing for one retention budget, and it
  // keeps the execution view from ever decoding it.
  assert.deepEqual(segments.observations.marketObservations, activeRows,
    "the observations segment carries only tradable rows");
  assert.deepEqual(segments.resolvedObservations.resolvedMarketObservations, resolvedRows,
    "resolved rows are archived in their own segment");

  // The manifest is the signal that empty collections mean "segmented", not "no data".
  assert.equal(core.stateSegments.observations.file, "paper-state.observations.json");
  assert.equal(core.stateSegments.evaluations.file, "paper-state.evaluations.json");
  assert.equal(core.stateSegments.scanHistory.file, "paper-state.scanHistory.json");
  assert.equal(core.stateSegments.resolvedObservations.file, "paper-state.resolvedObservations.json");
  assert.equal(core.stateSegments.observations.counts.marketObservations, activeRows.length);
  assert.equal(core.stateSegments.resolvedObservations.counts.resolvedMarketObservations, resolvedRows.length);
  assert.equal(core.stateSegments.evaluations.counts.evaluations, state.evaluations.length);
  assert.equal(core.stateSegments.scanHistory.counts.marketScanHistory, state.marketScanHistory.length);

  // Splitting must be lossless, or publishing it destroys retained history.
  let rebuilt = { ...core };
  for (const payload of Object.values(segments)) rebuilt = bot.mergeStateSegment(rebuilt, payload);
  delete rebuilt.stateSegments;
  // The combined list is active-then-resolved; order within each group is preserved.
  assert.deepEqual(rebuilt.marketObservations, [...activeRows, ...resolvedRows]);
  // The top-level portfolio/trades/runLog keys are aliases of paperPortfolios.conservative
  // kept for older readers. They are derived, not stored: every path that assembles a
  // state ends in syncLegacyPaperAliases, which rewrites them from the conservative
  // portfolio. So the round-trip is checked on the authoritative data and the aliases are
  // asserted to be rebuilt from it, rather than expected to survive the split themselves.
  const aliases = ["portfolio", "trades", "runLog", "lastTradeDate", "lastTradeHour", "lastDecision"];
  const withoutAliases = (value) => Object.fromEntries(Object.entries(value).filter(([key]) => !aliases.includes(key)));
  assert.deepEqual(
    withoutAliases({ ...rebuilt, marketObservations: state.marketObservations }),
    withoutAliases(state),
    "everything other than observation ordering must round-trip exactly",
  );
  assert.equal(rebuilt.marketObservations.length, state.marketObservations.length, "no row may be lost");
  // Rebuilding the aliases is what makes dropping them from the core safe.
  const synced = bot.syncLegacyPaperAliases({ ...rebuilt });
  for (const alias of aliases) {
    assert.deepEqual(synced[alias], state.paperPortfolios.conservative[alias],
      `${alias} must be rebuilt from the conservative portfolio`);
  }
});

test("state segments: resolved history retains every measurable trade and purges settlement-only rows", () => {
  // Reported: the counts in the scraped and resolved tabs did not match what had
  // actually been mined, and stopped growing. Resolved rows were trimmed to a limit
  // on every write, so once the archive filled it churned -- older settled markets
  // were deleted to make room for newer ones, and no count could exceed the cap.
  //
  // A resolved market is the record of what was scraped and how it ended, which is
  // what every report and parameter comparison is measured against. It stays forever
  // if it has an original live quote; settlement-only 0/1 rows have no usable entry
  // and must not pollute the evidence set.
  const source = readFileSync(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");
  assert.ok(!/MARKET_OBSERVATION_RESOLVED_RETAIN_LIMIT/.test(source),
    "no cap may stand between a resolved market and the archive");
  assert.match(source, /\.\.\.resolved\.sort\(\(a, b\) => marketObservationUpdateTime\(b\) - marketObservationUpdateTime\(a\)\),/,
    "resolved rows are sorted and kept, not sliced");

  // Active rows stay bounded: they are a working set, and one that falls out is
  // simply re-scraped.
  assert.match(source, /\.\.\.active\.sort\(compareActive\)\.slice\(0, MARKET_OBSERVATION_RETAIN_LIMIT\),/);

  const rows = Array.from({ length: 12 }, (_, index) => ({
    id: `resolved-${index}`,
    tokenId: String(900000000000 + index),
    status: "RESOLVED",
    firstMarketProbability: 0.9,
    updatedAt: new Date(Date.UTC(2026, 0, 1 + index)).toISOString(),
  }));
  rows.push({
    id: "settlement-only",
    tokenId: "900000000099",
    status: "RESOLVED",
    firstMarketProbability: 1,
    marketProbability: 1,
    finalOutcomePrice: 1,
    updatedAt: "2026-02-01T00:00:00.000Z",
  });
  const state = bot.normalizeState({ marketObservations: rows });
  assert.equal(state.marketObservations.length, 12,
    "only settlement-only resolved rows may be removed from the archive");
  assert.ok(!state.marketObservations.some((row) => row.id === "settlement-only"),
    "a final 0/1 print is not an original market probability");
});

test("state segments: writeState publishes siblings that readState reassembles", async () => {
  const { mkdtemp, readFile, readdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "paper-state-segments-"));

  // A fresh module instance is needed because OUTPUT_PATH is read at import time.
  const previous = process.env.PAPER_STATE_PATH;
  process.env.PAPER_STATE_PATH = join(dir, "paper-state.json");
  process.env.PAPER_STATE_URL = "";
  try {
    const scoped = await import(`../tools/paper-trading-bot.mjs?segments=${Date.now()}`);
    const source = scoped.normalizeState(
      JSON.parse(await readFile(new URL("../data/paper-state.fixture.json", import.meta.url), "utf8")),
    );
    await scoped.writeState(source);

    const published = (await readdir(dir)).sort();
    assert.deepEqual(published, [
      // Portfolio archives and the calculation reports: history that only their own
      // views open, so the core no longer carries either.
      "paper-state.archives.json",
      "paper-state.evaluations.json",
      "paper-state.json",
      "paper-state.observations.json",
      // One file per portfolio. Its trades and run log live here, so the core stops
      // growing with every trade every portfolio has ever made and the dashboard reads
      // back only the portfolio it is showing.
      ...Object.keys(source.paperPortfolios).map((id) => `paper-state.portfolio-${id}.json`).sort(),
      "paper-state.reports.json",
      "paper-state.resolvedObservations.json",
      // The newest page of the archive, so the opportunities page can show recent
      // resolved markets without decoding all of history to find them.
      "paper-state.resolvedRecent.json",
      "paper-state.scanHistory.json",
    ].sort());

    // The published core must be small: that is the property that stops PHP 500s.
    const coreRaw = await readFile(join(dir, "paper-state.json"), "utf8");
    const catalogueRaw = await readFile(join(dir, "paper-state.observations.json"), "utf8");
    assert.ok(!coreRaw.includes(source.marketObservations[0].tokenId),
      "no observation may leak into the core file");
    assert.ok(catalogueRaw.includes(source.marketObservations[0].tokenId),
      "the observation segment must carry them instead");

    // And reading it back has to restore everything the bot needs to keep merging.
    const restored = await scoped.readState();
    assert.equal(restored.marketObservations.length, source.marketObservations.length);
    assert.equal(restored.evaluations.length, source.evaluations.length);
    assert.equal(restored.marketScanHistory.length, source.marketScanHistory.length);
    assert.deepEqual(restored.marketScan, source.marketScan);
  } finally {
    if (previous === undefined) delete process.env.PAPER_STATE_PATH;
    else process.env.PAPER_STATE_PATH = previous;
  }
});

test("state segments: api.php loads only the segments a summary reads", async () => {
  const { readFile } = await import("node:fs/promises");
  const api = await readFile(new URL("../api.php", import.meta.url), "utf8");

  // The segment field map has to match the bot's, or a published field is never served.
  assert.match(api, /'observations' => \['marketObservations', 'marketScan'\]/);
  assert.match(api, /'evaluations' => \['evaluations'\]/);
  assert.match(api, /'scanHistory' => \['marketScanHistory'\]/);

  // Every state read must declare its segments; an undeclared one decodes the lot.
  // Comments and the compact_state_payload() helper are not call sites.
  const reads = (api.match(/(?<![\w])state_payload\([^;\n]*/g) || [])
    .filter((call) => !/^state_payload\((?:\)|string)/.test(call));
  assert.ok(reads.length >= 3, `expected at least three state reads, found ${reads.length}: ${reads.join(" | ")}`);
  for (const call of reads) {
    assert.match(call, /,\s*(\[|state_segments_for_summary)/, `${call} must declare which segments it needs`);
  }

  // The two reads that made PHP decode everything must now decode nothing heavy.
  assert.match(api, /case 'dashboard':\s*\n\s*return \[\];/);
  assert.match(api, /case 'refresh':(?:\s*\n\s*\/\/[^\n]*)+\s*\n\s*return \[\];/);
  // The audit endpoints only ever needed the scan history.
  assert.equal((api.match(/state_payload\('paper', \['scanHistory'\]\)/g) || []).length, 2);

  // The browser must declare a summary too. The unnamed one decodes the evaluation
  // archive and the scan history on the way out, and that is the read that answered
  // "paper state HTTP 500" after every dispatched paper run.
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");
  for (const call of app.match(/api\.php\?action=state&target=[^`"']*/g) || []) {
    assert.ok(!/target=paper(?![\w-])(?!.*summary=)/.test(call),
      `${call} must name the summary it needs from the paper state`);
  }

  // A state published before segmentation has no manifest and must still serve whole.
  assert.match(api, /if \(\$manifest === \[\]\) \{\s*\n\s*\/\/[^\n]*\n\s*return \$data;/);
  // A segment file name arrives as file content, so it stays a plain sibling name.
  assert.match(api, /preg_match\('\/\^\[A-Za-z0-9\._-\]\+\\\.json\$\/', \$file\)/);
});

test("state segments: every state-writing workflow publishes them", async () => {
  const { readFile } = await import("node:fs/promises");
  // Three workflows write paper state. One that uploads only the core would leave
  // the hosting advertising the previous run's catalogue, so they all publish
  // through the shared script.
  const writers = ["trading-paper-bot", "trading-market-scan", "trading-paper-evaluation"];
  const suffixes = new Set();
  for (const name of writers) {
    const workflow = await readFile(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), "utf8");
    assert.match(workflow, /run: python3 trading\/tools\/publish-paper-state\.py/,
      `${name} must publish through the shared script`);
    assert.ok(!/STOR paper-state\.json/.test(workflow),
      `${name} must not upload the core state inline`);
    const suffix = workflow.match(/PAPER_UPLOAD_SUFFIX: (\S+)/)?.[1];
    assert.ok(suffix, `${name} must set its own upload suffix`);
    // A shared temp name would let two concurrent runs overwrite each other's upload.
    assert.ok(!suffixes.has(suffix), `${name} reuses upload suffix ${suffix}`);
    suffixes.add(suffix);
  }

  // The publisher must send the core last, or the manifest points at files that
  // are not there yet.
  const publisher = await readFile(new URL("../tools/publish-paper-state.py", import.meta.url), "utf8");
  assert.match(publisher, /uploads = declared_segments\(state_file\) \+ \[state_file\]/);
  // And a manifest naming a file that was never written has to fail the run.
  assert.match(publisher, /was not generated/);
});

test("workflows: no workflow_dispatch may exceed GitHub's 25-input limit", async () => {
  const { readFile, readdir } = await import("node:fs/promises");
  // GitHub refuses to parse a workflow that defines more than 25 workflow_dispatch
  // inputs. It is not a warning and not per-run: the whole file becomes invalid, so
  // every dispatch answers 422 and every scheduled tick stops firing too. That is
  // exactly what a 26th input did here -- the paper bot went completely dark, the
  // post-scrape chain failed with "you may only define up to 25 inputs", and the
  // symptom on the dashboard was portfolios frozen mid-history. A count is far
  // cheaper to check here than to rediscover from a silent cron.
  const dir = new URL("../../.github/workflows/", import.meta.url);
  const files = (await readdir(dir)).filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"));
  assert.ok(files.length > 0, "no workflow files were found to check");
  for (const file of files) {
    const workflow = await readFile(new URL(file, dir), "utf8");
    // Counted off the indented block under workflow_dispatch's own `inputs:` rather
    // than by parsing YAML, so this test needs no dependency the repo does not have.
    const block = /^ {2}workflow_dispatch:\n((?:^ {4}.*\n|^\s*\n)*)/m.exec(workflow)?.[1];
    if (!block) continue;
    const inputs = /^ {4}inputs:\n((?:^ {6}.*\n|^\s*\n)*)/m.exec(block)?.[1];
    if (!inputs) continue;
    const names = inputs.match(/^ {6}([A-Za-z0-9_-]+):$/gm) || [];
    assert.ok(names.length <= 25,
      `${file} defines ${names.length} workflow_dispatch inputs; GitHub rejects the whole file above 25`);
  }
});

test("workflows: api.php only dispatches inputs the target workflow declares", async () => {
  const { readFile, readdir } = await import("node:fs/promises");
  // GitHub rejects a dispatch carrying an input the workflow does not declare
  // ("Unexpected inputs provided"), so the two sides have to agree. They did not: the
  // dashboard kept sending per-strategy inputs after the workflow stopped declaring
  // them, and every manual run of every portfolio failed with a 422.
  const api = await readFile(new URL("../api.php", import.meta.url), "utf8");
  const dir = new URL("../../.github/workflows/", import.meta.url);
  const declaredInputs = async (file) => {
    const workflow = await readFile(new URL(file, dir), "utf8");
    const block = /^ {2}workflow_dispatch:\n((?:^ {4}.*\n|^\s*\n)*)/m.exec(workflow)?.[1] || "";
    const inputs = /^ {4}inputs:\n((?:^ {6}.*\n|^\s*\n)*)/m.exec(block)?.[1] || "";
    return new Set((inputs.match(/^ {6}([A-Za-z0-9_-]+):$/gm) || []).map((line) => line.trim().replace(/:$/, "")));
  };
  const files = (await readdir(dir)).filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"));

  // Every `'workflow' => 'x.yml'` entry with its own `'inputs' => [...]` literal.
  const entries = [...api.matchAll(/'workflow' => '([^']+\.ya?ml)',\s*\n\s*'inputs' => ([\s\S]*?)\n\s*'message' =>/g)];
  assert.ok(entries.length >= 2, `expected api.php to dispatch several workflows, found ${entries.length}`);
  for (const [, workflowFile, inputsBlock] of entries) {
    assert.ok(files.includes(workflowFile), `api.php dispatches ${workflowFile}, which does not exist`);
    const declared = await declaredInputs(workflowFile);
    assert.ok(declared.size > 0, `${workflowFile} declares no workflow_dispatch inputs`);
    // Keys of the PHP array literal: 'name' => value.
    const sent = [...inputsBlock.matchAll(/'([a-z0-9_]+)' =>/g)].map((match) => match[1]);
    assert.ok(sent.length > 0, `no inputs parsed out of the ${workflowFile} dispatch payload`);
    for (const name of sent) {
      assert.ok(declared.has(name),
        `api.php sends "${name}" to ${workflowFile}, which does not declare it -- GitHub answers 422`);
    }
  }
});

test("state segments: the publisher refuses to write outside the trading tree", async () => {
  const { readFile } = await import("node:fs/promises");
  const publisher = await readFile(new URL("../tools/publish-paper-state.py", import.meta.url), "utf8");
  // The remote directory arrives from the environment and this script writes over
  // FTP, so it must not be able to reach anything but /www/trading/.
  assert.match(publisher, /if not remote_dir\.startswith\("www\/trading\/"\) or "\.\." in remote_dir:/);
  assert.match(publisher, /Refusing to publish outside \/www\/trading\//);
  // Nothing read from the environment may be echoed into the log.
  for (const secret of ["HOSTING_FTP_PASSWORD", "HOSTING_FTP_USERNAME"]) {
    assert.ok(!new RegExp(`print\\([^)]*${secret}`).test(publisher), `${secret} must never be printed`);
  }
});

// Pulls a named top-level function out of the browser bundle so its behaviour can
// be exercised directly instead of only pattern-matched. Brace counting starts
// after the parameter list so default values containing braces cannot end it early.
function extractAppFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `function ${name} was not found in app.js`);
  let index = source.indexOf("{", source.indexOf(")", start));
  let depth = 0;
  for (let i = index; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`function ${name} is unbalanced in app.js`);
}

async function loadExecutionSummary() {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");
  const names = [
    "money", "probability", "percent", "signedPercent", "compactDays",
    "executionCandidateEconomics", "executionPositionEconomics", "liveExecutionSummary",
  ];
  const source = names.map((name) => extractAppFunction(app, name)).join("\n");
  return new Function(`${source}\nreturn { liveExecutionSummary, executionCandidateEconomics, executionPositionEconomics };`)();
}

test("execution popup: the result names the candidate and the numbers behind it", async () => {
  const { liveExecutionSummary } = await loadExecutionSummary();
  const summary = liveExecutionSummary({
    action: "SUBMIT",
    reason: "candidate passed revalidation",
    selected: {
      question: "Will Team A win?",
      outcome: "Yes",
      potentialAnnualizedReturn: 4.0559,
      netYield: 0.0333,
      daysToResolution: 0.3,
      netGainIfWinUsdc: 0.1665,
      orderNotionalUsdc: 5,
      marketProbability: 0.967,
      orderType: "GTC",
      orderSize: 5.17,
      orderPrice: 0.967,
    },
    response: { orderID: "0xabc", status: "matched" },
  });

  // The point of the change: the popup must state which candidate and on what basis.
  assert.match(summary, /Selected: Will Team A win\? \/ Yes/);
  assert.match(summary, /potential p\.a\. 405\.6%/);
  assert.match(summary, /net yield 3\.3%/);
  // 0.3 days is 7.2 hours, and hours are the unit a short-dated market is read in.
  assert.match(summary, /7\.2 h left/);
  assert.match(summary, /win \$0\.17/);
  assert.match(summary, /stake \$5\.00/);
  assert.match(summary, /mkt 96\.7%/);
  assert.match(summary, /Order ID: 0xabc/);
});

test("execution popup: a rotation names the position it gives up and its P/L", async () => {
  const { liveExecutionSummary } = await loadExecutionSummary();
  const summary = liveExecutionSummary({
    action: "ROTATION_EXIT_SUBMITTED",
    reason: "a weaker live position is being replaced",
    selected: { question: "Will Team B win?", outcome: "No", potentialAnnualizedReturn: 9.5, daysToResolution: 0.2 },
    batchLog: {
      humanReason: "Replace X (120.0% p.a., 3.0 d) with Y (950.0% p.a., 0.2 d); expected P/L changes by 0.4000 USDC.",
      rotationExit: {
        position: {
          question: "Will Team X win?",
          outcome: "Yes",
          holdAnnualizedReturn: 1.2,
          currentSellPnlUsdc: 0.21,
          unrealizedPnlUsdc: 0.25,
          remainingPotentialGainUsdc: 0.09,
          potentialWinIfHeldUsdc: 0.3,
        },
      },
    },
  });

  // Which position is being given up, and what it costs to give it up.
  assert.match(summary, /Replacing: Will Team X win\? \/ Yes/);
  assert.match(summary, /potential p\.a\. 120\.0%/);
  assert.match(summary, /P\/L on close \$0\.21/);
  assert.match(summary, /open P\/L \$0\.25/);
  assert.match(summary, /\$0\.09 still to collect/);
  // The runner's own sentence is surfaced rather than re-derived in the browser.
  assert.match(summary, /Decision: Replace X .* expected P\/L changes by 0\.4000 USDC\./);
});

test("execution popup: with no candidate it explains what was considered", async () => {
  const { liveExecutionSummary } = await loadExecutionSummary();
  const summary = liveExecutionSummary({
    action: "SKIP",
    reason: "no candidate passed revalidation",
    batchLog: {
      counts: {
        scannedCandidates: 42,
        revalidatedCandidates: 40,
        eligibleCandidates: 0,
        positionsReviewedForRotation: 3,
      },
    },
  });
  assert.match(summary, /Considered: 42 scanned \/ 40 revalidated \/ 0 eligible \/ 3 positions reviewed for rotation/);
  assert.ok(!summary.includes("Selected:"), "there is no selected candidate to name");
});

test("execution run-once: a missing result state is waited out, not reported as failure", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");
  const waiter = extractAppFunction(app, "waitForExecutionResult");

  // The reported bug: the first poll can land before the runner has published its
  // state, and an unguarded read turned that into "Execution failed / State file is
  // not available yet". Each attempt must absorb its own error and keep polling.
  assert.match(waiter, /try \{[\s\S]{0,400}?payload = await fetchApiJson/);
  assert.match(waiter, /catch \(error\) \{\s*\n\s*lastError = error;\s*\n\s*await sleep\(3000\);\s*\n\s*continue;/);
  // And the loop must never rethrow, or the outer catch reports a failed execution.
  assert.ok(!/throw /.test(waiter), "waitForExecutionResult must not throw");
  // The final message must not claim the execution failed.
  assert.match(waiter, /The workflow conclusion above is authoritative/);

  // The status poll has the same hazard and the same fix.
  const runWaiter = extractAppFunction(app, "waitForWorkflowRun");
  assert.match(runWaiter, /catch \(error\) \{/);
  assert.ok(!/throw /.test(runWaiter), "waitForWorkflowRun must not throw");
  // Polling every 4s must update one line instead of appending an identical entry.
  assert.match(runWaiter, /upsertExecutionStep\(steps, "Workflow status"/);
  assert.ok(!/addExecutionStep\(steps, attempt === 0/.test(runWaiter), "the per-poll append is what spammed the popup");
});

test("state segments: a missing segment does not read as a missing state", async () => {
  // The production failure. A scan published core + segments; the site deploy then
  // deleted every data file it did not recognise, including the segments; the next
  // run fetched a manifest pointing at 404s, classified that as "published state is
  // missing (HTTP 404)", fell through to the repository snapshot and aborted with
  // "obsolete schema". Portfolios and trades live in the core file and were never
  // lost, so the run must continue with them.
  const http = await import("node:http");
  const { mkdtemp, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const source = bot.normalizeState(
    JSON.parse(await readFile(new URL("../data/paper-state.fixture.json", import.meta.url), "utf8")),
  );
  const { core } = bot.splitStateIntoSegments(source);

  let segmentStatus = 404;
  // Which segment files the hosting still has. Everything absent by default, so the
  // first read below is the full "the deploy deleted them all" case.
  let segmentServed = () => false;
  const { segments } = bot.splitStateIntoSegments(source);
  const fileFor = (name) => bot.stateSegmentFileName(name);
  const server = http.createServer((req, res) => {
    const path = req.url.split("?")[0];
    if (path === "/paper-state.json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(core));
      return;
    }
    const file = path.replace(/^\//, "");
    const name = Object.keys(segments).find((key) => fileFor(key) === file);
    if (name && segmentServed(file)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(segments[name]));
      return;
    }
    res.writeHead(segmentStatus, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "unavailable" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const previous = {
    path: process.env.PAPER_STATE_PATH,
    url: process.env.PAPER_STATE_URL,
    staticUrl: process.env.PAPER_STATIC_STATE_URL,
  };
  try {
    process.env.PAPER_STATE_PATH = join(await mkdtemp(join(tmpdir(), "paper-missing-segment-")), "paper-state.json");
    process.env.PAPER_STATE_URL = `${base}/paper-state.json`;
    process.env.PAPER_STATIC_STATE_URL = `${base}/paper-state.json`;
    const scoped = await import(`../tools/paper-trading-bot.mjs?missingSegment=${Date.now()}`);

    // Only the rebuildable catalogue may 404 its way to empty. A portfolio's trades and
    // run log now live in a segment of their own, and nothing regenerates them, so a 404
    // there has to stop the run rather than publish the portfolio with an empty history.
    await assert.rejects(
      () => scoped.readState(),
      /missing .* and nothing regenerates it/,
      "a missing portfolio segment must fail closed, not publish an emptied history",
    );

    // With the irreplaceable segments served and only the catalogue missing, the run
    // continues: that is the case this test was written for.
    segmentServed = (file) => /portfolio-|archives|reports/.test(file);
    const catalogueOnly = await import(`../tools/paper-trading-bot.mjs?catalogueGone=${Date.now()}`);
    const restored = await catalogueOnly.readState();
    assert.equal(restored.trades.length, source.trades.length, "trades must survive a missing catalogue");
    assert.equal(
      restored.paperPortfolios.conservative.portfolio.equityUsdc,
      source.paperPortfolios.conservative.portfolio.equityUsdc,
      "portfolio aggregates must survive a deleted segment",
    );
    // The catalogue is rebuilt by scanning, so an empty one is the correct outcome.
    assert.deepEqual(restored.marketObservations, []);
    assert.deepEqual(restored.evaluations, []);

    // A transient failure is the opposite case: the data is probably still there, so
    // continuing would overwrite it with empty collections.
    segmentStatus = 500;
    const failing = await import(`../tools/paper-trading-bot.mjs?failingSegment=${Date.now()}`);
    await assert.rejects(
      () => failing.readState(),
      /segment could not be read|paper state is unavailable/,
      "a 500 on a segment must fail closed instead of publishing an empty catalogue",
    );
  } finally {
    server.close();
    for (const [key, value] of [["PAPER_STATE_PATH", previous.path], ["PAPER_STATE_URL", previous.url], ["PAPER_STATIC_STATE_URL", previous.staticUrl]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("state segments: the site deploy never deletes published segments", async () => {
  const { readFile } = await import("node:fs/promises");
  const deploy = await readFile(new URL("../../.github/workflows/trading-deploy.yml", import.meta.url), "utf8");

  // The deploy wipes data/ of anything it does not recognise. Listing only the core
  // state file there is what deleted every segment and broke the next scan.
  assert.match(deploy, /def is_runtime_data\(name\):/);
  assert.match(deploy, /name\.startswith\("paper-state\."\) and name\.endswith\("\.json"\)/,
    "the rule must cover any segment the bot adds later, not a fixed list");
  assert.match(deploy, /if is_runtime_data\(child\):/);
  // The old literal set must be gone, or a stale copy could still win.
  assert.ok(!/keep = \{"paper-state\.json"/.test(deploy), "the old literal keep-set must not remain");
});

test("state segments: segments can be merged in any order", async () => {
  // Active rows and the resolved archive land in the same array from two different
  // files. An assign-based merge let whichever arrived second erase the other, which
  // silently halved the catalogue depending on read order.
  const { readFile } = await import("node:fs/promises");
  const state = bot.normalizeState(
    JSON.parse(await readFile(new URL("../data/paper-state.fixture.json", import.meta.url), "utf8")),
  );
  const { core, segments } = bot.splitStateIntoSegments(state);
  // Only the segments a reader reassembles. The recent page is published beside the
  // archive and carries the same transport field, and this merge replaces the resolved
  // half rather than appending -- so reading both would leave whichever landed last, and
  // the state would be rebuilt from a 3,000-row page instead of the whole archive.
  const names = bot.STATE_SEGMENT_NAMES.filter((name) => name in segments);
  assert.ok(!names.includes("resolvedRecent"), "the capped page is published, never read back");
  assert.ok(bot.PUBLISHED_STATE_SEGMENT_NAMES.includes("resolvedRecent"));
  const expected = state.marketObservations.length;

  // Every ordering of the segment files must reconstruct the same row count.
  const permute = (list) => (list.length <= 1 ? [list] : list.flatMap((item, index) =>
    permute([...list.slice(0, index), ...list.slice(index + 1)]).map((rest) => [item, ...rest])));
  let checked = 0;
  for (const order of permute(names)) {
    let merged = { ...core };
    for (const name of order) merged = bot.mergeStateSegment(merged, segments[name]);
    assert.equal(merged.marketObservations.length, expected, `order ${order.join(",")} lost rows`);
    checked += 1;
  }
  // Derived from the segment list rather than hardcoded: segments have been added since
  // (portfolio archives, calculation reports), and a fixed count silently stopped
  // asserting anything the moment the list grew.
  const factorial = (value) => (value <= 1 ? 1 : value * factorial(value - 1));
  assert.equal(checked, factorial(names.length), `all ${names.length} segment orderings must be covered`);
});

test("state segments: retention is not silently throttled by workflow env", async () => {
  // The resolved cap that made the counts churn was pinned in the workflow env, so
  // raising the default in the bot changed nothing in production. Any workflow that
  // overrides these must agree with what the response sizing allows.
  const { readFile } = await import("node:fs/promises");
  for (const name of ["trading-paper-bot", "trading-market-scan"]) {
    const workflow = await readFile(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), "utf8");
    const active = Number(workflow.match(/PAPER_MARKET_OBSERVATION_RETAIN_LIMIT: "(\d+)"/)?.[1]);
    // Pinning a resolved cap in the workflow is what made raising the default in the
    // bot change nothing in production. There must not be one at all now.
    assert.ok(!/PAPER_MARKET_OBSERVATION_RESOLVED_RETAIN_LIMIT/.test(workflow),
      `${name} must not cap resolved history`);
    const resolved = Number.NaN;
    if (Number.isFinite(active)) {
      assert.ok(active >= 5000, `${name} throttles the active catalogue to ${active}`);
    }
    if (Number.isFinite(resolved)) {
      assert.ok(resolved >= 3000, `${name} throttles resolved history to ${resolved}, so it cannot accumulate`);
      assert.ok(resolved <= 5000, `${name} would serve ${resolved} resolved rows at once and risk a 500`);
    }
  }
});

test("taxonomy performance: real Polymarket categories and tags stay separate", async () => {
  const { readFile } = await import("node:fs/promises");
  const state = bot.normalizeState(
    JSON.parse(await readFile(new URL("../data/paper-state.fixture.json", import.meta.url), "utf8")),
  );
  // Gamma categories and tags are separate relations and can contain both strings and
  // objects. The old report inferred category from the first tag, producing identical
  // `category general` and `tag general` rows.
  state.marketObservations = state.marketObservations.map((row, index) => ({
    ...row,
    firstDaysToResolution: 4,
    daysToResolution: 4,
    firstLiquidity: 52000,
    polymarketCategories: index % 2 ? [{ slug: "sports" }] : [{ label: "Politics" }],
    polymarketTags: index % 2 ? [{ slug: "nba" }, { label: "Sports" }] : ["crypto"],
    firstPolymarketCategories: index % 2 ? [{ slug: "sports" }] : [{ label: "Politics" }],
    firstPolymarketTags: index % 2 ? [{ slug: "nba" }, { label: "Sports" }] : ["crypto"],
    riskGroupLabels: ["entity:acme"],
  }));

  const report = bot.buildCalculationReport(state);
  assert.equal(report.taxonomyVersion, 5);
  const categoryLabels = report.categorySummaries.map((row) => row.label);
  const tagLabels = report.tagSummaries.map((row) => row.label);
  assert.deepEqual(new Set(categoryLabels), new Set(["sports", "politics"]));
  for (const expected of ["nba", "sports", "crypto"]) {
    assert.ok(tagLabels.includes(expected), `${expected} must appear as a tag row`);
  }
  assert.ok(report.categorySummaries.every((row) => row.kind === "category"));
  assert.ok(report.tagSummaries.every((row) => row.kind === "tag"));
  // Risk labels are per-fixture dedup identifiers, not taxonomy: each groups exactly
  // one opportunity, so it can never carry a comparable sample and only crowds out the
  // real categories. They used to be fed straight into this table.
  assert.ok(!tagLabels.includes("entity:acme"), "a risk label must not become a tag row");
  assert.ok(!categoryLabels.includes("general"), "missing categories must not be invented as general");

  const resolvedGroup = [...report.categorySummaries, ...report.tagSummaries]
    .find((row) => row.resolved > 0);
  assert.ok(resolvedGroup, "the fixture must resolve at least one trade");
  for (const field of ["pnlPerTradeUsdc", "annualizedPnlPerTradeUsdc", "annualizedRoi", "avgNetYield", "avgDaysToResolution", "lastResolvedAt"]) {
    assert.ok(resolvedGroup[field] != null, `${field} must be reported`);
  }
  // ROI p.a. must use the calendar span of the actual historical sample. Using the
  // average holding period instead treated every historical row as immediately
  // reinvested and inflated a broad tag's p.a. result into the thousands of percent.
  assert.ok(Number.isFinite(resolvedGroup.performanceWindowDays) && resolvedGroup.performanceWindowDays > 0,
    "a resolved taxonomy group must report an annualization window");
  assert.ok(
    Math.abs(resolvedGroup.annualizedRoi - resolvedGroup.roi * (365 / resolvedGroup.performanceWindowDays)) < 0.01,
    "ROI p.a. must annualize over the historical sample span",
  );
  assert.ok(
    Math.abs(resolvedGroup.annualizedPnlPerTradeUsdc
      - resolvedGroup.pnlPerTradeUsdc * (365 / resolvedGroup.performanceWindowDays)) < 0.01,
    "P/L p.a. must annualize per-trade P/L over the historical sample span",
  );
});

test("taxonomy performance: per-fixture slugs never become their own rows", async () => {
  const { readFile } = await import("node:fs/promises");
  const state = bot.normalizeState(
    JSON.parse(await readFile(new URL("../data/paper-state.fixture.json", import.meta.url), "utf8")),
  );
  // The exact shapes seen in production: risk labels reached the table as rows like
  // "market: uwcl-faw-haj-2026-08-05-corners-team-home-4pt5". Only the real taxonomy
  // (sports, esports, politics, geopolitics, ...) belongs here.
  state.marketObservations = state.marketObservations.map((row) => ({
    ...row,
    firstDaysToResolution: 4,
    daysToResolution: 4,
    firstLiquidity: 52000,
    firstCategory: "Market: uwcl-faw-haj-2026-08-05-corners-team-home-4pt5",
    tags: ["Match: FC Bayern vs Hajduk", "esports"],
    polymarketCategories: [{ slug: "sports" }],
    firstPolymarketCategories: [{ slug: "sports" }],
    polymarketTags: [{ slug: "sports" }, { slug: "ucl-fen-stu1-2026-08-05-exact-score" }],
    firstPolymarketTags: [{ slug: "esports" }, { slug: "ucl-fen-stu1-2026-08-05-exact-score" }],
    riskGroupLabels: [
      "Market: uwcl-faw-haj-2026-08-05-corners-team-home-4pt5",
      "Event: uwcl-faw-haj-2026-08-05",
      "Team: sk brann",
      "Topic: bitcoin",
    ],
  }));

  const report = bot.buildCalculationReport(state);
  const rows = [...report.categorySummaries, ...report.tagSummaries];
  const labels = rows.map((row) => row.label);
  for (const noise of [
    "market: uwcl-faw-haj-2026-08-05-corners-team-home-4pt5",
    "event: uwcl-faw-haj-2026-08-05",
    "team: sk brann",
    "topic: bitcoin",
    "match: fc bayern vs hajduk",
    "ucl-fen-stu1-2026-08-05-exact-score",
  ]) {
    assert.ok(!labels.includes(noise), `${noise} must not appear as a row`);
  }
  // The genuine taxonomy on the same rows must survive the filter.
  for (const kept of ["esports", "sports"]) {
    assert.ok(labels.includes(kept), `${kept} must still be reported`);
  }
  // A category that was nothing but a fixture slug falls back rather than leaking.
  assert.ok(
    !labels.some((label) => /-(?:19|20)\d{2}-\d{2}-\d{2}/.test(label)),
    `no row may carry a dated fixture slug, got ${JSON.stringify(labels)}`,
  );
});

test("parameter combinations: a resolved row keeps its scrape-time entry price", () => {
  // Why "Resolved" in Best parameter combinations fell far short of the resolved list's
  // own count: a settled book prints 0 or 1, firstMarketProbability was seeded from it
  // before lastLiveMarketProbability existed, and an entry price of exactly 0 or 1 is
  // discarded -- so those resolved rows left the simulation altogether instead of
  // being counted in it.
  const resolvedRow = {
    tokenId: "12345678901234567890",
    question: "Exact Score: SSC Napoli 1 - 0 CA Osasuna?",
    status: "RESOLVED",
    marketClosed: true,
    // The settlement print, which must not be taken as the entry price.
    marketProbability: 1,
    firstMarketProbability: 1,
    // The quote the market actually carried while it was tradable.
    lastLiveMarketProbability: 0.9,
    finalOutcomePrice: 1,
    firstLiquidity: 60000,
    firstDaysToResolution: 1,
  };
  const state = bot.normalizeState({ marketObservations: [resolvedRow] });
  const report = bot.buildCalculationReport(state);
  assert.equal(report.sampleSize, 1, "the resolved row must reach the simulation at all");
  assert.equal(report.resolvedSampleSize, 1, "and must be counted as resolved, not dropped");
  assert.equal(report.examples[0].firstProbability, 0.9, "the scrape-time quote is the entry price");

  // A row that genuinely never had a live quote stays excluded: a 0%/100% entry is not
  // a tradable simulation, which is the caveat the report is expected to keep.
  const neverLive = bot.normalizeState({
    marketObservations: [{ ...resolvedRow, lastLiveMarketProbability: null }],
  });
  assert.equal(bot.buildCalculationReport(neverLive).sampleSize, 0);
});

test("calculation report: a resolved loss is never counted as a win", () => {
  const base = {
    status: "RESOLVED",
    selectionStatus: "RESOLVED",
    marketClosed: true,
    question: "Will the selected outcome resolve?",
    firstOutcome: "Yes",
    firstMarketProbability: 0.8,
    lastLiveMarketProbability: 0.8,
    marketProbability: 0.8,
    firstFeeRate: 0,
    firstDaysToResolution: 1,
    daysToResolution: 1,
    firstObservedAt: "2026-08-01T00:00:00.000Z",
    observedAt: "2026-08-01T00:00:00.000Z",
    resolvedAt: "2026-08-02T00:00:00.000Z",
    endDate: "2026-08-02T00:00:00.000Z",
  };
  const state = bot.normalizeState({
    marketObservations: [
      { ...base, id: "won-selected-outcome", tokenId: "11111111111111111111", finalOutcomePrice: 1 },
      { ...base, id: "lost-selected-outcome", tokenId: "22222222222222222222", finalOutcomePrice: 0 },
    ],
  });
  const report = bot.buildCalculationReport(state);
  const broadestRule = report.parameterSummaries.find((row) => (
    row.marketType === "all" && row.threshold === 0.5 && row.maxResolutionDays === 30
  ));

  assert.equal(report.sampleSize, 2);
  assert.deepEqual(report.examples.map((row) => row.resolvedOutcome).sort(), [0, 1]);
  assert.equal(broadestRule.wins, 1);
  assert.equal(broadestRule.losses, 1);
  assert.ok(broadestRule.pnlUsdc < 0,
    "the full lost stake must make a one-win/one-loss sample negative at an 80% entry price");
});

test("parameter combinations: every distinct rule uses the full resolved sample and reports average resolution volume", async () => {
  // A liquidity-floor loop made four copies of each probability/horizon rule. It did
  // not make the report more informative, and its ROI-first UI slice hid most of the
  // high-evidence rows. Volume is now a descriptive aggregate, not a synthetic fourth
  // dimension of every parameter combination.
  const { readFile } = await import("node:fs/promises");
  const state = bot.normalizeState(
    JSON.parse(await readFile(new URL("../data/paper-state.fixture.json", import.meta.url), "utf8")),
  );
  state.marketObservations = state.marketObservations.map((row, index) => ({
    ...row,
    firstVolumeUsdc: 1000 + index * 100,
    resolvedVolumeUsdc: 9000 + index * 100,
    firstDaysToResolution: 4,
    daysToResolution: 4,
  }));
  const pendingSource = state.marketObservations.find((row) => {
    const price = Number(row.firstMarketProbability ?? row.lastLiveMarketProbability ?? row.marketProbability);
    return price > 0 && price < 1;
  });
  assert.ok(pendingSource, "the fixture must contain a tradable price for the pending regression case");
  state.marketObservations.push({
    ...pendingSource,
    id: "pending-statistics-regression",
    status: "SCRAPED",
    marketClosed: false,
    finalOutcomePrice: null,
  });
  const report = bot.buildCalculationReport(state);
  const withoutPending = bot.buildCalculationReport({
    ...state,
    marketObservations: state.marketObservations.filter((row) => row.id !== "pending-statistics-regression"),
  });
  assert.equal(report.parameterSummaries.length, 150, "3 market types x 10 thresholds x 5 horizons");
  for (const threshold of [0.55, 0.65, 0.75, 0.85, 0.95]) {
    assert.ok(report.parameterSummaries.some((row) => row.threshold === threshold), `${threshold * 100}% must be included`);
  }
  assert.ok(report.parameterSummaries.every((row) => !Object.hasOwn(row, "minLiquidityUsdc")));
  const widest = report.parameterSummaries.find((row) => row.marketType === "all"
    && row.threshold === 0.5
    && row.maxResolutionDays === 30);
  assert.equal(report.sampleSize, report.resolvedSampleSize,
    "performance statistics must exclude unresolved opportunities from the sample");
  assert.equal(report.observedSampleSize, withoutPending.observedSampleSize + 1,
    "the report retains the inventory count for the pending observation");
  assert.equal(report.sampleSize, withoutPending.sampleSize,
    "but the pending observation must stay outside performance statistics");
  assert.equal(widest.trades, report.sampleSize, "the broadest rule must retain every resolved trade");
  assert.equal(widest.pending, 0, "a parameter combination must never include pending opportunities");
  assert.ok(widest.openCount >= 1,
    "the broadest rule must separately expose the current open inventory without diluting historical results");
  assert.ok(Number.isFinite(widest.avgVolumeUsdc) && widest.avgVolumeUsdc > 0,
    "the rule must expose the average volume captured at resolution");
  assert.ok(widest.avgVolumeUsdc >= 9000,
    "resolved rows must prefer their resolution-time volume over the first scraped quote");
  const annualizedRule = report.parameterSummaries.find((row) => Number.isFinite(row.annualizedPnlPerTradeUsdc));
  assert.ok(annualizedRule,
    "a rule with a measured resolution horizon must expose comparable annualized P/L per fixed simulation trade");

  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");
  assert.match(app, /key: "roi",\s*direction: "desc"/);
  assert.match(app, /calculationHeader\("roi", "ROI"\)/);
  assert.match(app, /signedPercent\(Number\(row\.roi\)\)/);
  assert.match(app, /calculationHeader\("avgVolumeUsdc", "Avg volume"\)/);
  assert.doesNotMatch(app, /calculationHeader\("resolved", "Resolved"\)/);
  assert.doesNotMatch(app, /calculationHeader\("minLiquidityUsdc", "Min liquidity"\)/);
  assert.doesNotMatch(app, /rows\.slice\(0, 80\)/);
});

test("taxonomy performance: an unknown horizon reports no p.a. at all", async () => {
  const { readFile } = await import("node:fs/promises");
  const state = bot.normalizeState(
    JSON.parse(await readFile(new URL("../data/paper-state.fixture.json", import.meta.url), "utf8")),
  );
  // annualizationDays(null) coerces to 0 and is floored to one hour, which turned a
  // group with no measured horizon into a confident four-figure p.a.
  state.marketObservations = state.marketObservations.map((row) => {
    const stripped = { ...row };
    delete stripped.daysToResolution;
    delete stripped.firstDaysToResolution;
    delete stripped.endDate;
    delete stripped.resolutionEndDate;
    delete stripped.scheduledEventDate;
    return stripped;
  });

  state.marketObservations = state.marketObservations.map((row) => ({
    ...row,
    polymarketCategories: ["sports"],
    firstPolymarketCategories: ["sports"],
    polymarketTags: ["football"],
    firstPolymarketTags: ["football"],
  }));
  const report = bot.buildCalculationReport(state);
  const rows = [...report.categorySummaries, ...report.tagSummaries];
  for (const row of rows) {
    if (row.avgDaysToResolution == null) {
      assert.equal(row.annualizedRoi, null,
        `${row.label} has no horizon, so it must not report ${row.annualizedRoi} p.a.`);
    }
  }
});

test("taxonomy performance: every resolved trade is represented by a real label or an explicit fallback", () => {
  const resolvedRow = {
    tokenId: "taxonomy-unclassified-token",
    question: "Will the category fallback be visible?",
    status: "RESOLVED",
    marketClosed: true,
    marketProbability: 1,
    firstMarketProbability: 0.8,
    lastLiveMarketProbability: 0.8,
    finalOutcomePrice: 1,
    firstLiquidity: 60000,
    firstDaysToResolution: 2,
  };
  const report = bot.buildCalculationReport(bot.normalizeState({ marketObservations: [resolvedRow] }));
  assert.deepEqual(report.taxonomyCoverage.category, {
    totalTrades: 1,
    classifiedTrades: 0,
    unclassifiedTrades: 1,
  });
  assert.deepEqual(report.taxonomyCoverage.tag, {
    totalTrades: 1,
    classifiedTrades: 0,
    unclassifiedTrades: 1,
  });
  assert.equal(report.categorySummaries.find((row) => row.label === "uncategorized")?.trades, 1);
  assert.equal(report.tagSummaries.find((row) => row.label === "untagged")?.trades, 1);
});

test("taxonomy performance: categories and tags render as separately sorted tables", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  assert.match(app, /taxonomySort: \{/);
  assert.match(app, /category: \{ key: "roi", direction: "desc" \}/);
  assert.match(app, /tag: \{ key: "roi", direction: "desc" \}/);
  assert.match(app, /data-taxonomy-sort="\$\{kind\}" data-taxonomy-sort-key="\$\{key\}"/);
  assert.match(app, /const taxonomyButton = event\.target\.closest\("\[data-taxonomy-sort\]"\);/);
  assert.match(app, /const button = event\.target\.closest\("\[data-calculation-sort\]"\);/);
  assert.match(app, /"Category performance"/);
  assert.match(app, /"Tag performance"/);
  assert.doesNotMatch(app, /Category and tag performance/);
  assert.match(app, /kind === "category" && !hasSplitTaxonomy/,
    "legacy inferred categories must stay hidden until a split report is generated");
  // Every column in both tables is sortable.
  const sorted = [...app.matchAll(/taxonomyHeader\(kind, "([a-zA-Z]+)"/g)].map((match) => match[1]);
  for (const key of ["label", "minimumProbability", "openCount", "trades", "accuracy", "pnl",
    "roi", "avgProbability", "avgVolumeUsdc", "lastResolvedAt"]) {
    assert.ok(sorted.includes(key), `${key} column must be sortable`);
  }
  assert.doesNotMatch(app, /taxonomyHeader\(kind, "annualizedPnlPerTradeUsdc", "P\/L p\.a\."/);
  // The header count must match the colspan on the empty row, or the layout breaks.
  assert.match(app, /colspan="\$\{hasProbabilityBreakdown \? 12 : 11\}"/);
  assert.equal(sorted.length, 11);
  assert.doesNotMatch(app, /data-category-kind/);

  // The report is stored in the core state file, so its row count must be bounded.
  const botSource = await readFile(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");
  assert.match(botSource, /SCRAPED_SIMULATION_CATEGORY_ROW_LIMIT/);
  assert.match(botSource, /return rows\.slice\(0, SCRAPED_SIMULATION_CATEGORY_ROW_LIMIT\);/);
  assert.match(botSource, /if \(labels\.length >= SCRAPED_SIMULATION_TAGS_PER_TRADE\) return labels;/);
});

test("taxonomy performance: rows open the current scraped markets for that category or tag", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  assert.match(html, /data-scraped-taxonomy-filter/);
  assert.match(html, /data-scraped-status/,
    "scraped and resolved observations must be selectable together");
  assert.match(html, /<span>Tag<\/span>/,
    "the taxonomy filter should use the compact Tag label");
  assert.match(html, /<option value="">All<\/option>/,
    "the taxonomy filter should use the compact All option");
  assert.doesNotMatch(html, /data-evaluation-status/,
    "the retired evaluation status tabs must not remain in the opportunity filters");
  assert.doesNotMatch(html, /value="ERROR" data-scraped-status/,
    "scraped opportunity status must not expose an error option");
  assert.match(app, /function scrapedTaxonomyOpportunityPath/);
  assert.match(app, /new Set\(\["SCRAPED", "RESOLVED"\]\)/,
    "the scraped catalogue must allow only scraped and resolved statuses");
  assert.doesNotMatch(app, /scrapedCounts\.error/,
    "scraped opportunity counts must not expose an error bucket");
  assert.match(app, /taxonomy=|SCRAPED_TAXONOMY_KIND_QUERY_PARAM/);
  assert.match(app, /SCRAPED_STATUS_QUERY_PARAM/,
    "taxonomy links must carry their explicit scraped/resolved status scope");
  assert.match(app, /function applyScrapedTaxonomyRouteFilter/);
  assert.match(app, /scrapedRouteFilter/,
    "deep-linked scraped filters must survive the asynchronous catalogue load");
  assert.match(app, /const routeFilter = state\.scrapedRouteFilter/,
    "the rendered rows must use the route filter, not only the visible inputs");
  assert.match(app, /routeFilter\?\.marketTypeExplicit/,
    "an implicit route status/taxonomy filter must not override the selected market-type filter");
  assert.match(app, /marketTypeExplicit = params\.has\(SCRAPED_MARKET_TYPE_QUERY_PARAM\)/,
    "only an explicit marketType URL parameter may control the market-type filter");
  assert.match(app, /query\.set\(SCRAPED_MARKET_TYPE_QUERY_PARAM, state\.scrapedMarketTypeFilter\)/,
    "changing the market-type filter must survive a reload through the URL");
  assert.match(app, /routeFilter\?\.marketTypeExplicit[\s\S]*?routeFilter\.marketType/,
    "an explicit marketType URL filter must be applied to the rows");
  assert.match(app, /resetScrapedOpportunityFilters\(\)/,
    "a settings deep-link must clear the previous exploration filters");
  assert.match(app, /setScrapedStatuses\(\["SCRAPED", "RESOLVED"\]/,
    "a taxonomy deep-link must include both current and resolved markets");
  assert.match(app, /scrapedTaxonomyFilterMatches\(item, taxonomyFilter\)/,
    "the selected taxonomy must be applied to the scraped list itself");
  assert.match(app, /normalizedScrapedTaxonomyFilter\(state\.scrapedTaxonomyFilter\)/,
    "the renderer must pass the saved taxonomy selection into the row filter");
  assert.match(app, /const SCRAPED_PAGE_SIZE = 250;/,
    "the scraped catalogue must page rather than silently truncate its result set");
  assert.match(app, /function showMoreScrapedOpportunities\(\)/,
    "the scraped catalogue must expose a progressive load-more action");
  assert.match(app, /data-scraped-load-more/,
    "the rendered scraped table must offer remaining rows to the user");
  // Reversed deliberately. Tag performance evaluates each market as it first appeared,
  // so a market re-tagged on Polymarket after it was scraped is counted under its
  // scrape-time tag. A deep-link preferring today's relation listed it under a different
  // one, which is one of the ways a group's headline count and its own rows diverged.
  assert.match(app, /\["firstPolymarketTags", "polymarketTags"\]/,
    "tag deep-links must group by the scrape-time tag the statistics count with");
  assert.match(app, /\["firstPolymarketCategories", "polymarketCategories"\]/,
    "and category deep-links likewise");
  assert.match(app, /if \(label && !PER_FIXTURE_TAXONOMY_LABEL\.test\(label\)\) values\.add\(label\);/,
    "a per-fixture slug groups one opportunity, so no statistic offers it and neither may the picker");
  assert.match(app, /action=taxonomy-observations/,
    "a taxonomy view must query the stored archive, not filter the capped catalogue page");
  assert.match(app, /if \(drilldownKey && !drilldown\) \{/,
    "and must never fall back to rendering that page's subset under a taxonomy heading");
  assert.match(app, /selectedStatuses\.includes\(scrapedObservationFilterStatus\(item\)\)/,
    "the scraped list must respect multiple selected statuses");
  assert.match(app, /scrapedTaxonomyOpportunityPath\(\{ kind, label: row\.label \}, \{ statuses: \["SCRAPED", "RESOLVED"\], rule: scrapedTaxonomyProbabilityRule\(row\) \}\)/,
    "both category and tag performance rows must link to their respective scraped markets");
  assert.match(html, /data-scraped-market-type-filter/,
    "parameter-combination links must expose their market type in the scraped catalogue");
  assert.match(html, /data-calculation-open-filter/,
    "the calculation report must offer a shared filter for rows with current opportunities");
  assert.match(app, /function scrapedRuleOpportunityPath/,
    "the current-open parameter count must carry its filters to the scraped catalogue");
  assert.match(app, /function scrapedResolvedRuleOpportunityPath/,
    "the resolved trade count must carry the same parameter filters to the scraped catalogue");
  assert.match(app, /scrapedTaxonomyOpenOpportunityPath\(kind, row\.label, row\)/,
    "taxonomy open counts must link to current rows for the exact taxonomy label");
  assert.match(app, /scrapedTaxonomyResolvedOpportunityPath\(kind, row\.label, row\)/,
    "taxonomy trade counts must link to resolved rows for the exact taxonomy label");
  assert.match(app, /function scrapedTaxonomyProbabilityRule/,
    "tag probability bands must keep their minimum probability when opening the catalogue");
});

test("calculation report: open counts mirror parameter rules and taxonomy", () => {
  const resolved = {
    tokenId: "12345678901234567890",
    question: "Will the resolved market be true?",
    outcome: "Yes",
    status: "RESOLVED",
    marketClosed: true,
    firstMarketProbability: 0.8,
    lastLiveMarketProbability: 0.8,
    finalOutcomePrice: 1,
    firstDaysToResolution: 3,
    firstPolymarketCategories: ["sports"],
    firstPolymarketTags: ["football"],
  };
  const open = {
    ...resolved,
    id: "open-sports-market",
    tokenId: "09876543210987654321",
    question: "Will the open market be true?",
    status: "SCRAPED",
    marketClosed: false,
    acceptingOrders: true,
    finalOutcomePrice: null,
    firstMarketProbability: 0.9,
    lastLiveMarketProbability: 0.9,
    firstDaysToResolution: 2,
  };
  const report = bot.buildCalculationReport(bot.normalizeState({ marketObservations: [resolved, open] }));
  const matching = report.parameterSummaries.find((row) => row.marketType === "binary"
    && row.threshold === 0.85 && row.maxResolutionDays === 3);
  assert.equal(matching?.openCount, 1, "the matching open market must be counted exactly once");
  const blockedByThreshold = report.parameterSummaries.find((row) => row.marketType === "binary"
    && row.threshold === 0.95 && row.maxResolutionDays === 3);
  assert.equal(blockedByThreshold?.openCount, 0, "a lower-probability open market must not leak into stricter rules");
  assert.equal(report.categorySummaries.find((row) => row.label === "sports")?.openCount, 1);
  assert.equal(report.tagSummaries.find((row) => row.label === "football")?.openCount, 1);
  const football = report.tagSummaries.find((row) => row.label === "football");
  assert.deepEqual(
    football?.minimumProbabilitySummaries?.map((row) => row.minimumProbability),
    [0.5, 0.6, 0.7, 0.8, 0.9],
    "every tag needs the normalized 50%-90% minimum probability ladder",
  );
  const footballAtNinety = football?.minimumProbabilitySummaries?.find((row) => row.minimumProbability === 0.9);
  assert.equal(footballAtNinety?.openCount, 1, "the matching open market belongs to its 90% tag band");
  assert.equal(footballAtNinety?.trades, 0, "the lower-probability resolved market must not leak into the 90% tag band");
});

test("live events: the scan asks Gamma only for what was measured to work", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");

  // Every parameter here was verified against the live API by tools/gamma-live-probe.mjs
  // rather than assumed. live=true is a real server-side filter (the same sports query
  // returned 100 events with 1 live, and 2 events both live with the filter), and
  // end_date_min is honoured. start_date_max is silently ignored and must not be used.
  assert.match(source, /live: "true"/, "the live scope must use the server-side filter");
  // Check code, not the comment that explains why the parameter is avoided.
  const code = source.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  assert.ok(!/start_date_max/.test(code), "start_date_max is ignored by Gamma and must not be sent");

  // The lower bound is the fix for pages that started on months-old closed events.
  const params = bot.scanEventRequestParams({ tag_id: "1", order: "endDate", ascending: "true" });
  assert.ok(params.end_date_min, "every scan request needs a lower end-date bound");
  const graceHours = (Date.now() - Date.parse(params.end_date_min)) / 3600000;
  assert.ok(graceHours > 0, "the bound must sit in the past so just-ended tradable markets survive");
  assert.ok(graceHours <= 24, `the grace window is too wide at ${graceHours}h`);
  // A caller with its own window must keep it.
  const windowed = bot.scanEventRequestParams({ tag_id: "1", end_date_max: "2026-08-05T20:00:00.000Z" });
  assert.equal(windowed.end_date_max, "2026-08-05T20:00:00.000Z");

  // Exactly the two tags behind polymarket.com/sports/live and /esports/live.
  assert.deepEqual(bot.marketScanLiveTags().map((tag) => tag.slug), ["sports", "esports"]);
  assert.deepEqual(bot.marketScanLiveTags().map((tag) => tag.id), ["1", "64"]);

  // A live-scan failure must never take the catalogue scan down with it: the rotating
  // scope is the job that has to keep working.
  assert.match(source, /Live event scan failed \(\$\{liveScanError\}\); continuing with the rotating scope only\./);
  assert.match(source, /const fetchedMarkets = \[\.\.\.liveMarkets, \.\.\.diversifyMarketScanOrder\(batch\)\];/,
    "live rows go first so bounded downstream steps keep them");

  // normalizeMarketScan is a whitelist; unlisted fields never reach the published state.
  for (const field of ["liveScanEnabled", "liveScanWindowHours", "liveScanCount", "liveScanCounts", "liveScanError", "endDateGraceHours"]) {
    assert.ok(
      new RegExp(`${field}: `).test(source.slice(source.indexOf("function normalizeMarketScan"), source.indexOf("function normalizeMarketScanHistory"))),
      `${field} must be whitelisted in normalizeMarketScan or it is silently dropped`,
    );
  }
  const scan = bot.normalizeState({ marketScan: { liveScanCount: 7, liveScanCounts: { sports: 5, esports: 2 } } }).marketScan;
  assert.equal(scan.liveScanCount, 7);
  assert.deepEqual(scan.liveScanCounts, { sports: 5, esports: 2 });
});

test("live events: the probe that justified this stays read-only", async () => {
  const { readFile } = await import("node:fs/promises");
  const workflow = await readFile(new URL("../../.github/workflows/trading-gamma-live-probe.yml", import.meta.url), "utf8");
  const body = workflow.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
  // It reaches a third-party API from a runner, so it must stay unable to touch anything.
  for (const forbidden of ["secrets.", "ftplib", "storbinary", "HOSTING_", "upload-artifact"]) {
    assert.ok(!body.includes(forbidden), `the probe must not use ${forbidden}`);
  }
  assert.match(body, /permissions:\n\s+contents: read/);
  assert.match(body, /on:\n\s+workflow_dispatch:/);
});

test("execution revalidation: a missing probability estimate must not crash the shortlist", () => {
  // The reported bug. Conservative revalidated 80 stored candidates and marked every
  // one ERROR with "execution shortlist revalidation failed: Cannot read properties of
  // null (reading 'toFixed'); base status ERROR is not executable". annualizeReturn()
  // returns null for a non-finite input, which is normal for a scraped candidate that
  // was never AI-analysed, and the storage rounding called .toFixed() on it. The whole
  // object literal threw, so nothing was returned and a shortlist of tradable markets
  // (93% market probability, $80k liquidity) was discarded by a crash, not by a rule.
  assert.equal(bot.rounded(null, 4), null);
  assert.equal(bot.rounded(undefined, 4), null);
  assert.equal(bot.rounded(NaN, 4), null);
  assert.equal(bot.rounded(Infinity, 4), null);
  assert.equal(bot.rounded(0.12345, 4), 0.1235);
  assert.equal(bot.rounded(0, 2), 0, "a real zero must survive, not become null");
  assert.equal(bot.rounded("0.5", 2), 0.5);

  // annualizeReturn genuinely produces null for the input that triggered this.
  assert.equal(bot.annualizeReturn(NaN, 3), null);
  assert.equal(bot.rounded(bot.annualizeReturn(NaN, 3), 4), null, "the pair must compose safely");

  // No unguarded rounding may remain on a value annualizeReturn can null out.
  const source = readFileSync(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");
  for (const field of ["annualizedReturn", "expectedRoi", "expectedValue", "edge"]) {
    assert.ok(
      !new RegExp(`economics\\.${field}\\.toFixed`).test(source),
      `economics.${field}.toFixed() can throw and must go through rounded()`,
    );
  }
});

test("execution revalidation: a polymarket-source portfolio is judged on market numbers", () => {
  // The user's point: paper must decide like live. For probabilitySource "polymarket"
  // the ranking metric has to come from the market quote, never from an AI estimate
  // that a scraped candidate does not have.
  const strategy = { ...bot.PAPER_STRATEGIES.conservative, probabilitySource: "polymarket" };
  const item = {
    tokenId: "12345678901234567890",
    status: "SCRAPED",
    marketProbability: 0.93,
    liquidity: 80842.54,
    daysToResolution: 0.5,
    netGainIfWinUsdc: 0.32,
    totalCostUsdc: 5.02,
    netYield: 0.0637,
    // Deliberately absent: this candidate was never AI-analysed.
    aiProbability: null,
    annualizedReturn: null,
    expectedValueUsdc: null,
  };
  const economics = bot.portfolioEconomics(item, strategy);
  assert.equal(economics.probabilitySource, "polymarket");
  assert.ok(Number.isFinite(economics.annualizedReturn), "market p.a. must be computed without an AI probability");
  assert.equal(economics.expectedValueUsdc, 0.32, "the market path uses the net gain, not the AI expected value");
  assert.ok(economics.annualizedReturn > 0);
});

test("Polymarket probability threshold uses the executable CLOB entry, not a stale Gamma quote", () => {
  // A real Equal-paper defect: Gamma reported 81%, while the orderbook entry
  // used to open the trade was 59%. A 75% portfolio threshold must reject it.
  const strategy = {
    ...bot.PAPER_STRATEGIES.equal,
    probabilitySource: "polymarket",
    minProbability: 0.75,
  };
  const item = {
    tokenId: "12345678901234567890",
    status: "SCRAPED",
    marketProbability: 0.81,
    marketPrice: 0.59,
    volumeUsdc: 100000,
    daysToResolution: 0.5,
    netGainIfWinUsdc: 0.32,
    totalCostUsdc: 5.02,
    netYield: 0.0637,
    executableShares: 8.5,
    feeRate: 0,
  };
  const result = bot.portfolioFilterResult(item, strategy);

  assert.equal(bot.portfolioProbabilityForStrategy(item, strategy), 0.59);
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.some((reason) => reason.includes("Polymarket probability 59.0% below 75.0%")));
});

test("portfolio market type: Yes/No and multichoice use the same three-value filter as statistics", async () => {
  const binaryStrategy = {
    ...bot.PAPER_STRATEGIES.conservative,
    probabilitySource: "polymarket",
    minProbability: 0.9,
    minLiquidityUsdc: 0,
    marketType: "binary",
    requireMostProbableOutcome: false,
  };
  const candidate = {
    tokenId: "12345678901234567890",
    status: "SCRAPED",
    question: "Will the event happen?",
    outcome: "Yes",
    marketType: "binary",
    marketProbability: 0.95,
    marketPrice: 0.95,
    volumeUsdc: 100000,
    daysToResolution: 1,
    netGainIfWinUsdc: 0.25,
    totalCostUsdc: 5,
  };

  assert.equal(bot.portfolioFilterResult(candidate, binaryStrategy).eligible, true);
  assert.equal(bot.strategyEligibleCandidates([candidate], binaryStrategy).length, 1);

  const multichoiceStrategy = { ...binaryStrategy, marketType: "multi", requireMostProbableOutcome: true };
  const mismatch = bot.portfolioFilterResult(candidate, multichoiceStrategy);
  assert.equal(mismatch.eligible, false);
  assert.ok(mismatch.reasons.some((reason) => reason.includes("does not match portfolio market type multi")));
  assert.deepEqual(bot.strategyEligibleCandidates([candidate], multichoiceStrategy), []);

  const [html, app, paperWorkflow, liveWorkflow, fixedWorkflow, executor] = await Promise.all([
    import("node:fs/promises").then(({ readFile }) => readFile(new URL("../index.html", import.meta.url), "utf8")),
    import("node:fs/promises").then(({ readFile }) => readFile(new URL("../assets/app.js", import.meta.url), "utf8")),
    import("node:fs/promises").then(({ readFile }) => readFile(new URL("../../.github/workflows/trading-paper-bot.yml", import.meta.url), "utf8")),
    import("node:fs/promises").then(({ readFile }) => readFile(new URL("../../.github/workflows/polymarket-live-limit-order-test.yml", import.meta.url), "utf8")),
    import("node:fs/promises").then(({ readFile }) => readFile(new URL("../../.github/workflows/trading-live-5050.yml", import.meta.url), "utf8")),
    import("node:fs/promises").then(({ readFile }) => readFile(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8")),
  ]);
  assert.match(html, /data-portfolio-market-type/);
  assert.match(html, /<option value="binary">Yes\/No<\/option>/);
  assert.ok(!html.includes("Only multichoice events"));
  assert.match(app, /market type .* does not match/i);
  assert.match(paperWorkflow, /_MARKET_TYPE/);
  assert.match(liveWorkflow, /"LIVE_MARKET_TYPE": live\.get\("marketType"\)/);
  assert.match(fixedWorkflow, /"LIVE_MARKET_TYPE": cfg\.get\("marketType"\)/);
  assert.match(functionSource(executor, "prefilterLiveCandidate"), /PORTFOLIO_MARKET_TYPE !== "all"/);
});

test("execution revalidation: an unavailable CLOB quote cannot remain an Equal candidate", () => {
  const strategy = {
    ...bot.PAPER_STRATEGIES.equal,
    probabilitySource: "polymarket",
    minProbability: 0.75,
  };
  const item = {
    tokenId: "12345678901234567890",
    status: "REJECTED",
    selectionStatus: "REVALIDATION_FAILED",
    executionQuoteVerified: false,
    marketPrice: 0.9,
    marketProbability: 0.9,
    volumeUsdc: 100000,
    daysToResolution: 0.5,
    netGainIfWinUsdc: 0.5,
    totalCostUsdc: 5,
    executableShares: 5.55,
  };
  const result = bot.portfolioFilterResult(item, strategy);

  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes("current CLOB quote is unavailable after revalidation"));
});

test("execution revalidation: the log renders an unavailable quote as unavailable, never 0%", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  assert.match(functionSource(app, "executionCandidatePotentialPa"), /executionQuoteVerified === false/);
  assert.match(functionSource(app, "renderExecutionCandidatesNotUsedTable"), /item\.netYield == null \|\| item\.netYield === "" \? NaN/);
});

test("market dates: a date recovered from a slug is a whole day, not a kickoff", () => {
  // Reported: finished fixtures stayed in Execution candidates showing an end date of
  // 07. 08. 2026 01:59 -- midnight UTC in Prague, i.e. the slug's day stretched to
  // 23:59:59. val-fpx-jdg-2026-08-06 had already been played.
  //
  // sportsScheduledEventDate returns either a real kickoff or a date recovered from the
  // slug, and the future-kickoff rule could not tell them apart. A whole-day date is "in
  // the future" for the entire day it names, so it overrode the market's real end date
  // and kept the fixture listed until the next morning.
  const played = bot.marketDateContext({
    question: "Valorant: FunPlus Phoenix vs JD Gaming - Map 2 Winner",
    slug: "val-fpx-jdg-2026-08-06",
    eventSlug: "val-fpx-jdg-2026-08-06",
    endDate: "2026-08-06T18:00:00Z",
  });
  assert.equal(Date.parse(played.endDate), Date.parse("2026-08-06T18:00:00Z"),
    "the market's own end date must win over a whole-day slug bucket");
  assert.equal(played.endDateSource, "polymarket-resolution-window");
  // The slug date is still reported, just not used as the end date.
  assert.ok(played.scheduledEventDate.startsWith("2026-08-06T23:59:59"));

  // A real kickoff still ahead must still override a stale end date -- the case the
  // future-kickoff rule was added for in the first place.
  const kickoff = new Date(Date.now() + 2 * 3600000).toISOString();
  const upcoming = bot.marketDateContext({
    question: "Exact Score: SSC Napoli 1 - 0 CA Osasuna?",
    sportsMarketType: "soccer_exact_score",
    gameStartTime: kickoff,
    resolutionEndDate: new Date(Date.now() - 3 * 3600000).toISOString(),
  });
  assert.equal(upcoming.endDate, kickoff);
  assert.equal(upcoming.endDateSource, "sports-event-start");

  // With no end date at all the slug remains a usable fallback rather than nothing.
  const slugOnly = bot.marketDateContext({
    question: "Valorant: FunPlus Phoenix vs JD Gaming - Map 2 Winner",
    slug: "val-fpx-jdg-2026-08-06",
  });
  assert.ok(slugOnly.endDate.startsWith("2026-08-06T23:59:59"));
  assert.equal(slugOnly.endDateSource, "sports-event-start");
});

test("market dates: an election's own event metadata does not masquerade as a kickoff", () => {
  // Reported: open "... nominee" and "By-Election Winner" positions showed a negative
  // days-left, some by months. isSportsMarket was (correctly, if accidentally) true only
  // because "winner" is in SPORTS_MARKET_HINT -- a normal word for any single-winner
  // contest, not a sports-only one. With no real gameStartTime anywhere, event.startDate --
  // an unrelated internal timestamp Gamma sets on the event record -- was the only
  // candidate found, so it was taken as a "precise" kickoff and silently overrode the
  // market's correct, much later resolutionEndDate.
  const freshEndDate = "2026-08-18T00:00:00Z";
  const context = bot.marketDateContext({
    question: "Will Thomas Chalifoux be the Republican nominee for FL-09?",
    slug: "will-thomas-chalifoux-be-the-republican-nominee-for-fl-09",
    resolutionEndDate: freshEndDate,
    events: [{ title: "FL-09 Republican Primary Winner", startDate: "2025-12-23T22:44:51.742349Z" }],
  }, null);
  assert.equal(context.endDate, freshEndDate, "the market's real, fresh end date must win over event.startDate");
  assert.equal(context.endDateSource, "polymarket-resolution-window");
  assert.equal(context.scheduledEventDate, null, "event.startDate must not be surfaced as a scheduled kickoff at all");
});

test("market dates: a tracked-metric window's start does not masquerade as a kickoff", () => {
  // Live case: "Elon Musk # tweets August 11 - August 18, 2026?" is not a sports market,
  // but Gamma still sets gameStartTime to the tracking window's *start* (the 11th) with
  // gameId/sportsMarketType/eventStartTime/teamAID/teamBID all blank. isSportsMarket came
  // back true only because gameStartTime itself is truthy, and with nothing else to check
  // it against, the window's start -- days in the past by the time the position was
  // rechecked -- was taken as a "precise" kickoff and silently overrode the market's
  // correct, still-days-away real end date (the 18th), showing the open position as
  // already several days overdue.
  const windowStart = new Date(Date.now() - 6 * 24 * 3600000).toISOString();
  const realEndDate = new Date(Date.now() + 24 * 3600000).toISOString();
  const context = bot.marketDateContext({
    question: "Will Elon Musk post 180-199 tweets from August 11 to August 18, 2026?",
    slug: "elon-musk-of-tweets-august-11-august-18-180-199",
    gameStartTime: windowStart,
    resolutionEndDate: realEndDate,
  });
  assert.equal(context.endDate, realEndDate, "the market's real end date must win over the tracking window's start");
  assert.equal(context.endDateSource, "polymarket-resolution-window");
  assert.equal(context.scheduledEventDate, null, "an uncorroborated gameStartTime must not be surfaced as a scheduled kickoff at all");
});

test("market dates: a kickoff that hasn't happened yet outranks a stale resolution window", () => {
  // Live bug: an exact-score sub-market's own resolutionEndDate said 02:00 (already
  // past), while Polymarket's own event page still showed a ~2h countdown to an 18:30
  // kickoff -- gameStartTime is the fresher, sports-API-sourced signal and must win
  // whenever it is still in the future, even though it falls after resolutionEndDate.
  const kickoff = new Date(Date.now() + 2 * 3600000).toISOString();
  const staleResolutionWindow = new Date(Date.now() - 3 * 3600000).toISOString();
  const context = bot.marketDateContext({
    question: "Exact Score: SSC Napoli 1 - 0 CA Osasuna?",
    sportsMarketType: "soccer_exact_score",
    gameStartTime: kickoff,
    resolutionEndDate: staleResolutionWindow,
  });
  assert.equal(context.endDate, kickoff, "the future kickoff must win over the stale, already-past resolution window");
  assert.equal(context.endDateSource, "sports-event-start");
  assert.equal(context.sportsEventStarted, false, "the game has not kicked off yet");
});

test("market dates: with no scheduled kickoff at all, the resolution window is still used", () => {
  const resolutionWindow = new Date(Date.now() + 3600000).toISOString();
  const context = bot.marketDateContext({ question: "Will it rain tomorrow?", resolutionEndDate: resolutionWindow });
  assert.equal(context.endDate, resolutionWindow);
  assert.equal(context.endDateSource, "polymarket-resolution-window");
});

test("market dates: an already-past kickoff still yields to an even-earlier-closing resolution window", () => {
  // Not the common shape, but confirms the fix's new future-kickoff branch does not
  // swallow the original comparison when both dates are already in the past.
  const kickoff = new Date(Date.now() - 3600000).toISOString();
  const resolutionWindow = new Date(Date.now() - 2 * 3600000).toISOString();
  const context = bot.marketDateContext({
    question: "Exact Score: SSC Napoli 1 - 0 CA Osasuna?",
    sportsMarketType: "soccer_exact_score",
    gameStartTime: kickoff,
    resolutionEndDate: resolutionWindow,
  });
  assert.equal(context.endDate, resolutionWindow);
  assert.equal(context.endDateSource, "polymarket-resolution-window");
});

test("market metric: the app filters and shows traded volume, not order-book liquidity", async () => {
  const { readFile } = await import("node:fs/promises");
  const bot2 = await readFile(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");
  const executor = await readFile(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  // Reported: the dashboard's number never matched Polymarket's. It was showing Gamma's
  // `liquidity` (order-book depth) while the site shows traded volume ("$37.9K Vol.") --
  // two different measurements, so they could never agree. Volume is the metric now.
  for (const [label, source] of [["bot", bot2], ["executor", executor]]) {
    assert.match(source, /volumeNum/, `${label} must read Polymarket's own volume field`);
  }
  assert.match(bot2, /function marketVolumeUsdc\(market = \{\}\) \{/);
  assert.match(bot2, /volumeUsdc: Number\(marketVolumeUsdc\(market\)\.toFixed\(2\)\)/,
    "the scrape has to store volume, or nothing downstream can use it");

  // Every layer resolves the same way, and falls back to the stored liquidity so rows
  // captured before the switch keep working until they are refreshed.
  for (const [label, source] of [["bot", bot2], ["executor", executor], ["app", app]]) {
    assert.match(source, /\[item\??\.volumeUsdc, item\??\.volume24hr, item\??\.firstVolume24hr, item\??\.liquidity\]/,
      `${label} must resolve volume with the same fallback chain`);
  }

  // The thresholds are volume thresholds now, in both the paper and the live path.
  assert.match(bot2, /rowVolumeUsdc\(item\) < minLiquidityUsdc/);
  assert.match(bot2, /reasons\.push\(`volume \$\{candidateVolume\.toFixed\(2\)\} below/);
  assert.match(executor, /const candidateVolume = candidateVolumeUsdc\(item\);/);
  assert.match(executor, /`volume \$\{candidateVolume\.toFixed\(2\)\} USDC below live minimum/);
  // Live revalidation refreshes it, so an executed check updates the stored figure.
  assert.match(executor, /const volumeUsdc = number\(market\.volumeNum, number\(market\.volume, volume24hr\)\)/);
  assert.match(executor, /"volumeUsdc",/, "the persisted field list must carry it back to the row");

  // The tables and the filter control say volume, and read it.
  assert.ok(!/<th>Liquidity<\/th>/.test(app), "no table may still head a column Liquidity");
  assert.ok(!/data-label="Liquidity"/.test(app), "no cell may still be labelled Liquidity");
  assert.match(app, /data-label="Volume">\$\{scrapedVolumeCell\(item\)\}/);
  assert.match(app, /scrapedSortableHeader\("liquidity", "Volume"\)/);
  assert.doesNotMatch(app, /scrapedSortableHeader\("riskReward", "R\/R"\)/);
  assert.doesNotMatch(app, /scrapedSortableHeader\("volume24hr", "24h volume"\)/);
  assert.doesNotMatch(app, /scrapedSortableHeader\("outcomeCount", "Outcomes"\)/);
  assert.match(app, /\["Volume filter",/);
  assert.match(html, /<span>Probability &gt;=<\/span>/);
  assert.match(html, /<span>Days left max &lt;=<\/span>/);
  assert.match(html, /<span>Net yield min &gt;=<\/span>/);
  assert.match(html, /<span>Volume min &gt;=<\/span>/);
  assert.match(html, /<span>Type<\/span>/);
  assert.doesNotMatch(html, /data-evaluation-(?:days|net-yield|liquidity)-filter-label/,
    "filter values belong in their input, not in a duplicated suffix");
  assert.match(html, /<span>Min traded volume<\/span>/);
});

test("candidates: a finished event stops being listed, an in-play one does not", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");
  const bot2 = await readFile(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");

  // Reported: a Conservative run could only SKIP while several candidates were listed,
  // and their evaluation already said "event end date is in the past". Evaluation knew;
  // the list filter did not, so finished events kept occupying the shortlist.
  for (const [label, source] of [["app", app], ["bot", bot2]]) {
    assert.match(source, /reasons\.push\("event end date is in the past"\);/,
      `${label} must drop a candidate whose resolution window has passed`);
    // Not for a sports row dated by kickoff: past kickoff means in play, not finished,
    // and those are still tradable. Hiding them would be worse than listing a stale one.
    assert.match(source, /String\(item\.endDateSource \|\| ""\) !== "sports-event-start"/,
      `${label} must not hide an in-play fixture`);
  }

  // The evaluator already retires such rows in the stored state, which is what makes the
  // list agree with it rather than merely hiding the row on screen.
  assert.match(bot2, /rejectReasons\.unshift\("event end date is in the past; awaiting resolution sync"\)/);
  assert.match(bot2, /status: "RESOLVED",\s*\n\s*thesisType: "RESOLVED",/);

  // Ordering: the past-date check must precede the max-horizon check, or a finished event
  // would be reported as merely exceeding the horizon.
  const filter = bot2.slice(bot2.indexOf('reasons.push("event end date is in the past");'));
  assert.match(filter.slice(0, 400), /else if \(days > maxResolutionDays\)/);
});

test("no model: the bot consults no AI provider and never waits on a memo", async () => {
  const { readFile } = await import("node:fs/promises");
  const bot2 = await readFile(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");

  // Reported: candidates were unexecutable with "Gemini grounded AI analysis is pending"
  // and "base status ERROR is not executable". The portfolios must not use a model at all.
  //
  // One switch, off by default, and everything that could reach a provider or block on a
  // memo hangs off it -- so a stale env var or the stored portfolio config on the hosting
  // cannot turn it back on by itself.
  assert.match(bot2, /const AI_ANALYSIS_ENABLED = envBool\("PAPER_AI_ANALYSIS_ENABLED", false\);/);
  assert.match(bot2, /const GEMINI_API_KEY = AI_ANALYSIS_ENABLED \? \(process\.env\.GEMINI_API_KEY \|\| ""\) : "";/,
    "no key means callGeminiJson returns before making a request");
  assert.match(bot2, /const OPENAI_API_KEY = AI_ANALYSIS_ENABLED \? \(process\.env\.OPENAI_API_KEY \|\| ""\) : "";/,
    "'not Gemini' must not quietly mean 'some other provider'");
  assert.match(bot2, /const REQUIRE_GEMINI = AI_ANALYSIS_ENABLED && envBool/,
    "a memo that is never produced must not be required");
  assert.match(bot2, /const AI_ANALYSIS_LIMIT = AI_ANALYSIS_ENABLED \? envNumber\("PAPER_AI_ANALYSIS_LIMIT", 2\) : 0;/);
  // The request site is still guarded by the key it can no longer receive.
  assert.match(bot2, /async function callGeminiJson\(messages\) \{\s*\n\s*if \(!GEMINI_API_KEY\) return null;/);

  // With no model there is no AI probability, so ranking must fall to the market quote --
  // otherwise every candidate carries a NaN probability and nothing is executable.
  assert.match(bot2, /if \(!AI_ANALYSIS_ENABLED\) return "polymarket";/);
  assert.equal(bot.PAPER_STRATEGIES.conservative.probabilitySource, "polymarket");
  assert.equal(bot.PAPER_STRATEGIES.highReward.probabilitySource, "polymarket");
  assert.equal(bot.PAPER_STRATEGIES.moreProbable.probabilitySource, "polymarket");

  // And the workflows must neither ask for the AI source nor ship credentials.
  for (const name of ["trading-paper-bot", "trading-paper-evaluation"]) {
    const workflow = await readFile(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), "utf8");
    assert.ok(!/GEMINI_API_KEY|GEMINI_MODEL|OPENAI_API_KEY/.test(workflow),
      `${name} must not pass model credentials`);
    assert.ok(!/PROBABILITY_SOURCE: "ai"/.test(workflow), `${name} must not request the AI source`);
    assert.match(workflow, /PAPER_REQUIRE_GEMINI: "false"/);
  }
});

test("no model: the 'use Polymarket probability' switch is gone and cannot be flipped back", async () => {
  const { readFile } = await import("node:fs/promises");
  const [app, html, executorSource, liveWorkflow] = await Promise.all([
    readFile(new URL("../assets/app.js", import.meta.url), "utf8"),
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8"),
    readFile(new URL("../../.github/workflows/polymarket-live-limit-order-test.yml", import.meta.url), "utf8"),
  ]);

  // With no AI probability left to choose between, the toggle only offered a way to
  // break scoring. Deleting the control is not enough on its own: the value is stored
  // per portfolio on the hosting, so a config saved months ago still says "ai" and
  // would keep every candidate at a NaN probability with no way to fix it from the UI.
  // Each layer therefore decides the source itself instead of reading it back.
  assert.ok(!/data-polymarket-probability/.test(html), "the settings control must be gone");
  assert.ok(!/polymarketProbability/.test(app), "no element binding may survive the control");
  assert.match(app, /function normalizeProbabilitySource\(\) \{\n  return "polymarket";\n\}/,
    "a stored 'ai' config must still resolve to the market probability");

  // Run the shipped function over the values a stored config can actually hold.
  const normalize = new Function(`${/function normalizeProbabilitySource\(\)[\s\S]*?\n\}/.exec(app)[0]}
    return normalizeProbabilitySource;`)();
  for (const stored of ["ai", "AI", "gemini", "", null, undefined]) {
    assert.equal(normalize(stored), "polymarket", `stored ${JSON.stringify(stored)} must score on the market`);
  }

  // Same on the execution side, where the value used to arrive through the environment.
  assert.match(executorSource, /^const PROBABILITY_SOURCE = "polymarket";$/m);
  assert.ok(!/process\.env\.LIVE_PROBABILITY_SOURCE/.test(executorSource),
    "the executor must not read a source it no longer supports");
  assert.ok(!/LIVE_PROBABILITY_SOURCE: "ai"/.test(liveWorkflow), "the live workflow must not request the AI source");
  assert.ok(!/"LIVE_PROBABILITY_SOURCE": live\.get\("probabilitySource"\)/.test(liveWorkflow),
    "the stored portfolio config must not be able to inject the AI source either");

  // And the reject reason the user kept seeing must now be unreachable.
  assert.ok(!/grounded Gemini analysis is pending/.test(executorSource));
});

test("paper economics: a candidate with no stored netYield is not scored as break-even", () => {
  // Reported: no paper trade could pass, every candidate showing net yield 0.0% and
  // potential p.a. 0.0% while the market probability read 93-95%.
  //
  // Two defects compounded. A scraped evaluation never persisted netYield, so the
  // annualization had nothing to work from and returned null -- and Number(null) is
  // 0, not NaN, so "no p.a. could be computed" became an exact break-even that the
  // filter then rejected as "non-profitable after fees". Missing data read as a hard
  // and wrong verdict.
  const strategy = { ...bot.PAPER_STRATEGIES.conservative, probabilitySource: "polymarket" };
  const scraped = { marketProbability: 0.93, marketPrice: 0.93, netGainIfWinUsdc: 0.0723, totalCostUsdc: 1, daysToResolution: 0.5 };

  const economics = bot.portfolioEconomics(scraped, strategy);
  assert.equal(economics.expectedValueUsdc, 0.0723);
  // 7.23% over half a day is a large annualized number; the point is that it is the
  // real one and strictly positive, not zero.
  assert.ok(economics.annualizedReturn > 1, `expected a real p.a., got ${economics.annualizedReturn}`);
  assert.equal(Number(economics.annualizedReturn.toFixed(3)), 52.779);

  // A stored value still wins, so the one-day annualization floor keeps applying.
  assert.ok(bot.netYieldAfterFees({ netYield: 0.04, netGainIfWinUsdc: 99, totalCostUsdc: 1 }) === 0.04);

  // And genuinely absent economics must stay absent -- "unknown", never "worthless".
  const unknown = bot.portfolioEconomics({ marketProbability: 0.93, daysToResolution: 0.5 }, strategy);
  assert.equal(unknown.annualizedReturn, null, "an unknown p.a. must not become 0");
  assert.equal(unknown.expectedValueUsdc, null);
});

test("paper economics: the scraped evaluation persists what the portfolios rank on", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");
  // Deriving these on read is what left a missing field scoring the row at a flat
  // zero, so the record itself must carry them.
  assert.match(source, /netYield: rounded\(totalCost > 0 \? netGainIfWin \/ totalCost : null, 4\)/);
  assert.match(source, /potentialAnnualizedReturn: rounded\(/);
  // The shared guard against the Number(null) trap.
  assert.match(source, /function numericOrNaN\(value\) \{\n  return value == null \|\| value === "" \? NaN : Number\(value\);\n\}/);
});

test("automation: a portfolio can be switched off and paced, and a manual run overrides both", () => {
  const base = bot.PAPER_STRATEGIES.conservative;
  const now = Date.parse("2026-08-07T12:00:00Z");
  const minutesAgoIso = (minutes) => new Date(now - minutes * 60000).toISOString();

  // Off means off for automatic runs.
  assert.equal(bot.strategyMatchesExecutionTrigger({ ...base, automationEnabled: false }, { manual: false }), false);
  // Absent means on: a portfolio saved before the switch existed must keep trading
  // rather than silently stop because a field it never had reads as false.
  assert.equal(bot.strategyMatchesExecutionTrigger({ ...base, automationEnabled: undefined }, { manual: false }), true);
  assert.equal(bot.strategyMatchesExecutionTrigger({ ...base, automationEnabled: true }, { manual: false }), true);
  // ...but a manual run still trades a switched-off portfolio.
  assert.equal(bot.strategyMatchesExecutionTrigger({ ...base, automationEnabled: false }, { manual: true }), true);

  // The interval is the portfolio's own cadence, independent of how often the
  // workflow happens to be scheduled.
  const hourly = { ...base, executionCronMinutes: 60 };
  assert.equal(bot.strategyCadenceIsDue(hourly, minutesAgoIso(59), now, { manual: false }), false, "not due yet");
  assert.equal(bot.strategyCadenceIsDue(hourly, minutesAgoIso(59), now, { manual: true }), true, "a manual run ignores the cadence");
  assert.equal(bot.strategyCadenceIsDue(hourly, minutesAgoIso(61), now, { manual: false }), true, "due");
  assert.equal(bot.strategyCadenceIsDue(hourly, null, now, { manual: false }), true, "no previous run is not a reason to wait");
  assert.equal(bot.lastRunAtForStrategy({
    runLog: [{ strategyId: "conservative", runAt: minutesAgoIso(5) }],
    paperPortfolios: {
      customOne: { runLog: [{ strategyId: "customOne", runAt: minutesAgoIso(65) }] },
    },
  }, { id: "customOne" }), minutesAgoIso(65), "a created portfolio uses its own run log for cadence");
  // Legacy 0 becomes the concrete one-hour default, while after-scrape still
  // runs every batch.
  assert.equal(bot.strategyCadenceIsDue({ ...base, executionCronMinutes: 0 }, minutesAgoIso(1), now, { manual: false }), false);
  assert.equal(bot.strategyCadenceIsDue({ ...base, executionTrigger: "after_scrape", executionCronMinutes: 0 }, minutesAgoIso(1), now, { manual: false }), true);
});

test("manual live execution: the server no longer demands a parameter that was removed", async () => {
  const { readFile } = await import("node:fs/promises");
  const api = await readFile(new URL("../api.php", import.meta.url), "utf8");

  // Reported: "Manual live execution requires a current execution shortlist and its
  // probability source. Refresh the shortlist before running." That guard outlived the
  // parameter -- the probability source was removed with the AI pipeline, so the check
  // could never be satisfied again and every manual live run was rejected with 400.
  assert.ok(!/live_execution_probability_source/.test(api),
    "the server must not read a request field that no longer exists");
  assert.ok(!/requires a current execution shortlist/.test(api),
    "and must not refuse a run over a shortlist the dashboard refreshes as part of running");
});

test("market scan: a run evicted from the queue is retaken, not reported as an error", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");
  const scan = await readFile(new URL("../../.github/workflows/trading-market-scan.yml", import.meta.url), "utf8");
  const bot2 = await readFile(new URL("../../.github/workflows/trading-paper-bot.yml", import.meta.url), "utf8");

  // Reported: a manual "esports" scan showed 'Error: Scan workflow finished with
  // cancelled.' The run was cancelled 22 seconds after dispatch, having never run.
  //
  // The scan shares a concurrency group with the paper bot -- correctly, since both
  // publish paper-state.json and must never overlap -- and in a non-cancelling group
  // GitHub keeps one run in progress and one pending, evicting the pending one the
  // moment a third is queued. So the scan lost its place in the queue; nothing failed
  // and nothing was scanned.
  for (const [label, workflow] of [["scan", scan], ["paper bot", bot2]]) {
    assert.match(workflow, /group: trading-paper-bot/, `${label} must stay serialized against the other`);
    assert.match(workflow, /cancel-in-progress: false/, `${label} must not cancel a run that is mid-write`);
  }

  const fn = app.slice(app.indexOf("const dispatchScan = async () =>"));
  const body = fn.slice(0, fn.indexOf("state.scrapedScanStatus = \"Publishing scan results...\""));
  assert.match(body, /workflow\?\.status === "completed" && workflow\.conclusion === "cancelled"/,
    "an eviction must be recognised rather than surfaced as a failure");
  assert.match(body, /re-queuing/, "and the user must see it was retaken, not that it broke");
  // Exactly one retry: a genuine cancellation must still surface instead of looping.
  assert.equal((body.match(/await dispatchScan\(\);/g) || []).length, 2);
  // A failed scan now publishes its reason before the workflow goes red, so that reason is
  // preferred -- but an eviction has no reason to report, and must still surface as before.
  assert.match(body, /throw new Error\(reason \|\| `Scan workflow finished with \$\{workflow\.conclusion/,
    "a second cancellation is still reported");
});

test("5050 tab: the portfolio is a live mode with its own config and run log", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  // 5050 trades the same wallet as the main live portfolio, so it shares every live
  // view -- positions, orders, account. What must not be shared is the config it is
  // steered by and the run log it writes, because the two decide separately.
  // The tab row is rebuilt from the saved portfolios, so 5050's tab is asserted where
  // it is now produced rather than in the shipped markup.
  assert.match(app, /const liveModes = \["live", "live-5050"\]\.filter\(\(mode\) => !portfolioIsArchived\(mode\)\);/,
    "it needs its own tab");
  assert.match(html, /data-mode-switch/, "and a container the script can rebuild");
  assert.match(app, /const LIVE_MODES = new Set\(\["live", "live-5050"\]\);/);
  assert.match(app, /function isLiveMode\(\) \{\n  return LIVE_MODES\.has\(state\.mode\);\n\}/,
    "every live view must recognise it, or the tab renders as a paper portfolio");
  assert.match(app, /isFixedEntryMode\(mode\) \? "live5050" : "live"/, "separate config");
  assert.match(app, /isFixedEntryMode\(mode\) \? "data\/live-5050-execution-state\.json"/, "separate run log");
  assert.match(app, /fetchJson\(liveExecutionStateFile\(/, "and the load must actually use it");

  // Its defaults are the strategy: a fixed entry price, many bids, and automation
  // off until it is deliberately switched on -- this one commits past its capital.
  assert.match(app, /live5050: \{/);
  assert.match(app, /fixedEntryPrice: 0\.5,/);
  assert.match(app, /automationEnabled: false,/);
});

test("days left: under a day reads in hours, not tenths of a day", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");
  const compactDays = new Function(`${/function compactDays\(value\)[\s\S]*?\n\}/.exec(app)[0]}
    return compactDays;`)();

  // "0.2 d" has to be converted before it means anything, and the old "< 0.1 d"
  // bucket covered everything from two hours down to two minutes -- which is the
  // range that matters most for the short-dated sports markets this trades.
  assert.equal(compactDays(0.2), "4.8 h");
  assert.equal(compactDays(0.75), "18.0 h");
  assert.equal(compactDays(0.05), "1.2 h");
  assert.ok(!/</.test(compactDays(0.02)), "the catch-all bucket must be gone");
  assert.equal(compactDays(0.02), "29 min", "below an hour, minutes");

  // A day and over is unchanged.
  assert.equal(compactDays(1), "1.0 d");
  assert.equal(compactDays(3.4), "3.4 d");
  // The boundary belongs to hours, so nothing renders as "1.0 d" twice.
  assert.equal(compactDays(0.99), "23.8 h");

  // Superseded: "due now" used to cover everything at or past the end date, which hid
  // how long a market had been overdue. A passed date now reads as a negative horizon.
  assert.equal(compactDays(0), "< 1 min");
  assert.equal(compactDays(-1), "-1.0 d");
  assert.equal(compactDays(Number.NaN), "-");
  assert.equal(compactDays(0.0005), "1 min");
});

test("5050: it is its own live portfolio, not a copy of a paper one", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  // Reported: the 5050 tab showed the conservative paper portfolio. The mode was
  // recognised as live everywhere except the one place that decides which loader
  // runs, so it fell through to the paper bot's state.
  assert.match(app, /return LIVE_MODES\.has\(requestedMode\)\n\s*\? loadLiveState\(/,
    "a live portfolio must load live data");
  assert.ok(!/return requestedMode === "live"\n\s*\? loadLiveState/.test(app));

  // Overview finances come from the shared Polymarket account, as they must --
  // there is one wallet -- but orders, positions and the run log are attributed.
  assert.match(app, /function submittedTokenIds\(executionState\)/);
  assert.match(app, /return isFixedEntryMode\(\) \? owned : !owned;/,
    "each token shows under exactly one of the two live portfolios");
  assert.match(app, /\.filter\(belongsToActiveLivePortfolio\)/);
  assert.match(app, /!isFixedEntryMode\(\) && Array\.isArray\(state\.liveState\?\.runLog\)/,
    "and 5050's run log is its own");

  // A token nobody claims belongs to Live: attribution must never hide a row from
  // both tabs, and a failed fetch must not reassign 5050's positions wholesale.
  assert.match(app, /if \(!tokenId\) return !isFixedEntryMode\(\);/);
  assert.match(app, /if \(fixedEntryResult\.status === "fulfilled"\) state\.live5050ExecutionState/);

  // Its own identity, and automation off by default: this is the portfolio that
  // deliberately commits past its capital.
  assert.match(app, /"5050 - fixed-entry bids"/);
  assert.match(app, /live5050: \{[\s\S]*?automationEnabled: false,/);
});

test("portfolio config: a setting the server drops can never persist", async () => {
  const { readFile } = await import("node:fs/promises");
  const api = await readFile(new URL("../api.php", import.meta.url), "utf8");

  // normalize_strategy_config rebuilds the config from a fixed key list, so any key
  // it does not return is discarded on every save no matter what the dashboard
  // sends. The automation switch and the cron interval were both missing, which
  // would have made them look like they saved and silently reset.
  const strategy = api.slice(api.indexOf("function normalize_strategy_config"));
  const body = strategy.slice(0, strategy.indexOf("\n}"));
  assert.match(body, /'executionCronMinutes' =>/);
  assert.match(body, /'automationEnabled' =>/);
  assert.match(body, /\$defaults\['automationEnabled'\] \?\? true/, "absent must mean on");

  // 5050 is a whole portfolio the normalizer never copied, so its settings -- the
  // order price above all -- would have vanished on the first save.
  assert.match(api, /\$config\['live5050'\] = normalize_strategy_config\(\$fixedInput, \$defaults\['live5050'\]\);/);
  assert.match(api, /'fixedEntryPrice' => 0\.50,/);
  assert.match(api, /'automationEnabled' => false,/, "5050 ships with automation off");
  // A limit order cannot rest at 0 or 1, so a bad price must not reach the executor
  // and be rejected by the exchange one bid at a time.
  assert.match(api, /\(\$entryPrice > 0 && \$entryPrice < 1\)/);
});

test("portfolio name: only the saved name 75 is migrated to Paper 75", async () => {
  const { readFile } = await import("node:fs/promises");
  const api = await readFile(new URL("../api.php", import.meta.url), "utf8");

  const normalizer = api.slice(api.indexOf("function normalize_portfolio_display_name"));
  const body = normalizer.slice(0, normalizer.indexOf("\n}"));
  assert.match(body, /if \(\$name === '75'\) \{\s*return 'Paper 75';\s*\}/);
  assert.match(api, /'equal' => \[\s*'displayName' => 'Equal',/,
    "the Equal strategy must keep its own default name");
  assert.doesNotMatch(api, /\$id === 'equal'.*displayName/s,
    "the rename must follow the saved name, not an unrelated strategy id");
});

test("5050: the order price is a portfolio setting, not only a dispatch input", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const workflow = await readFile(new URL("../../.github/workflows/trading-live-5050.yml", import.meta.url), "utf8");

  // It has to be visible and editable where the portfolio is configured.
  assert.match(html, /data-fixed-entry-price/);
  assert.match(app, /function normalizeFixedEntryPrice\(value\)/);
  assert.match(app, /els\.fixedEntryPrice\?\.addEventListener\("change"/);
  // The order count is not capped: the exchange reserves collateral per resting bid,
  // so the balance bounds it and a configured ceiling only stopped the strategy
  // short of what it could fund.
  assert.ok(!/maxOpenOrders/.test(app), "no order ceiling remains in the dashboard");
  assert.ok(!/data-fixed-entry-max-orders/.test(html));
  // And meaningless for every other portfolio, so its control only shows for 5050. Keyed
  // on the mode the sync call is for, not on state.mode as it was: the two differ whenever
  // the panel is synced for a portfolio other than the open tab, and the row then followed
  // the tab rather than the portfolio being edited.
  assert.match(app, /els\.fixedEntryRows\?\.forEach\(\(row\) => row\.toggleAttribute\("hidden", !isFixedEntryMode\(mode\)\)\)/);
  assert.match(app, /every qualifying candidate is bid at/, "the rules card must state it");

  // The saved value has to actually govern the run, or the dashboard and the bids
  // would disagree. A dispatch input overrides it for one run and is blank by
  // default, so it cannot silently shadow the portfolio setting.
  assert.match(workflow, /- name: Load 5050 portfolio config/);
  assert.match(workflow, /"LIVE_FIXED_ENTRY_PRICE": cfg\.get\("fixedEntryPrice"\)/);
  const inputs = workflow.slice(workflow.indexOf("entry_price:"), workflow.indexOf("concurrency:"));
  assert.ok(!/default: "0\.50"/.test(inputs), "a defaulted input would always win over the saved setting");
});

test("portfolio settings: each portfolio owns its own, and cannot change another's", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  // Reported: the ON/OFF switch behaved as if it applied to everything at once.
  // updatePortfolioConfigForMode special-cased only "live", so "live-5050" fell
  // through to the paper branch -- where paperStrategyIdFromMode answers
  // "conservative" for any mode it does not recognise. Every 5050 setting, the
  // automation switch and the order price alike, was written into the conservative
  // paper portfolio.
  const pick = (re) => re.exec(src)[0];
  const run = new Function("state", `${[
    pick(/const BUILT_IN_PAPER_STRATEGY_IDS = \[[^\]]*\];/),
    pick(/const CUSTOM_PAPER_STRATEGY_ID = [^\n]+/),
    pick(/function normalizeMode\(mode\)[\s\S]*?\n\}/),
    pick(/const LIVE_MODES = new Set\(\[[^\]]*\]\);/),
    pick(/function isFixedEntryMode\(mode = state\.mode\)[\s\S]*?\n\}/),
    pick(/function liveConfigKeyForMode\(mode = state\.mode\)[\s\S]*?\n\}/),
    pick(/function paperStrategyIdFromMode\(mode = state\.mode\)[\s\S]*?\n\}/),
    // defaultPortfolioConfig gained a market-type default, so its normalizer comes too.
    pick(/function normalizePortfolioMarketType\(value, legacyMultichoice = false\)[\s\S]*?\n\}/),
    pick(/function defaultPortfolioConfig\(\)[\s\S]*?\n\}/),
    pick(/function portfolioConfigForMode\(mode = state\.mode\)[\s\S]*?\n\}/),
    pick(/function customPaperPortfolioDefaults\(strategyId\)[\s\S]*?\n\}/),
    pick(/function updatePortfolioConfigForMode\(mode, updates\)[\s\S]*?\n\}/),
  ].join("\n")}
    const DEFAULT_MAX_RESOLUTION_DAYS = 7;
    return { portfolioConfigForMode, updatePortfolioConfigForMode };`);

  const MODES = ["live", "live-5050", "paper-conservative", "paper-highReward", "paper-moreProbable"];
  for (const changed of MODES) {
    const api = run({ mode: changed, portfolioConfig: null });
    api.updatePortfolioConfigForMode(changed, { automationEnabled: false });
    assert.equal(api.portfolioConfigForMode(changed).automationEnabled, false, `${changed} must keep its own change`);
    for (const other of MODES.filter((m) => m !== changed)) {
      const stillOn = api.portfolioConfigForMode(other).automationEnabled;
      // 5050 is the one that ships off; everything else defaults on.
      const expected = other === "live-5050" ? false : true;
      assert.equal(stillOn, expected, `changing ${changed} must not touch ${other}`);
    }
  }

  // The 5050-only settings land in the 5050 slot, not in a paper strategy.
  const api = run({ mode: "live-5050", portfolioConfig: null });
  api.updatePortfolioConfigForMode("live-5050", { fixedEntryPrice: 0.35 });
  assert.equal(api.portfolioConfigForMode("live-5050").fixedEntryPrice, 0.35);
  assert.equal(api.portfolioConfigForMode("paper-conservative").fixedEntryPrice, undefined,
    "a paper portfolio must never acquire a setting it does not have");
});

test("5050: only equity is shared with Live, never its history", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  // One wallet means one equity, and that figure is genuinely shared. Everything
  // else on the overview is account-level -- the main portfolio's entire history --
  // so showing it under 5050 would credit it with trades it never made.
  assert.match(app, /els\.portfolioEquity\.textContent = money\(equity\);/,
    "equity stays the shared account figure");

  const live = app.slice(app.indexOf("const fixedEntry = isFixedEntryMode();"));
  const block = live.slice(0, live.indexOf("data-account-summary") + 1 || 4000);
  assert.match(block, /const realizedPnl = fixedEntry \? ownRealized : rawRealized;/);
  assert.match(block, /const totalPnlValue = fixedEntry \? ownRealized \+ ownOpen : totalPnl;/);
  assert.match(block, /els\.portfolioTotalPl\.textContent = signedMoney\(totalPnlValue\);/);
  assert.match(block, /els\.portfolioOpenPl\.textContent = signedMoney\(openPnlValue\);/);
  // Percentages measure what this portfolio put at risk, not a deposit it does not
  // have of its own.
  assert.match(block, /ownStake > 0 \? value \/ ownStake : null/);

  // Closed trades and the activity feed are attributed too, so the accuracy card
  // and the closed-trades tab cannot show Live's history either.
  assert.match(app, /function liveClosedTrades\(liveState\) \{[\s\S]*?\.filter\(belongsToActiveLivePortfolio\);/);
  assert.match(app, /function liveActivity\(liveState\) \{[\s\S]*?\.filter\(belongsToActiveLivePortfolio\)/);
});

test("dashboard: the browser file cannot borrow a Node-only helper", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  // Reported: "Can't find variable: number" blanked the entire portfolio dashboard
  // -- parameters, tiles and trades -- on every portfolio. The 5050 P/L split called
  // number(), which exists in the executor but not here. node --check parses, it
  // does not resolve identifiers, so the file compiled cleanly and failed only in
  // the browser at render time.
  //
  // These names all exist in tools/*.mjs and none of them exist in app.js, so a call
  // to one is always this mistake: an executor idiom carried into the browser file.
  const nodeOnly = ["number", "envNumber", "envBool", "hasFlag", "roundToTick", "successfulOrderResponse", "orderResponseError", "selectedProbability", "selectedExpectedValue", "selectedAnnualizedReturn"];
  const source = app
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/(^|[^:'"`])\/\/.*$/, "$1"))
    .join("\n");
  for (const name of nodeOnly) {
    const called = new RegExp(`(?<![\\w$.])${name}\\s*\\(`).test(source);
    const defined = new RegExp(`(?:function\\s+${name}\\s*\\(|(?:const|let|var)\\s+${name}\\s*=)`).test(source);
    assert.ok(!called || defined, `app.js calls ${name}() but never defines it`);
  }

  // The call site that broke: it must convert with something the browser has.
  assert.match(app, /const usdc = \(value\) => \{\n\s*const numeric = Number\(value\);/);
  assert.match(app, /closedTrades\.reduce\(\(sum, trade\) => sum \+ usdc\(/);
});

test("dashboard: a renderer cannot read another renderer's local variables", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  // Reported: "all statistics are shared". renderBotState was rewritten to read
  // totalPnlValue, which is a local of renderLiveState -- a first-occurrence replace
  // that landed in the wrong function. Every paper portfolio then threw at that line,
  // so its tiles kept whatever the previous render had left on screen, which reads
  // exactly as one portfolio's numbers showing under all of them.
  //
  // These are locals of the live renderer's per-portfolio P/L split. Each must appear
  // only inside the function that declares it.
  const lines = app.split("\n");
  const bounds = (name) => {
    const start = lines.findIndex((line) => line.startsWith(`function ${name}(`));
    assert.ok(start >= 0, `${name} not found`);
    const end = lines.findIndex((line, i) => i > start && line === "}");
    return [start, end];
  };
  const [liveStart, liveEnd] = bounds("renderLiveState");

  for (const local of ["totalPnlValue", "openPnlValue", "ownBasePct", "ownRealized", "ownOpen", "ownStake", "fixedEntry", "usdc"]) {
    lines.forEach((line, i) => {
      // A property of the same name is not a read of the variable. `row.fixedEntry` is a
      // field the executor publishes and says nothing about renderLiveState's local, so
      // matching it would make this guard fire on data rather than on scope.
      if (!new RegExp(`(?<![\\w$.?])${local}(?![\\w$])`).test(line.replace(/\?\.\s*/g, "."))) return;
      assert.ok(i >= liveStart && i <= liveEnd,
        `${local} is a local of renderLiveState but is read at app.js:${i + 1} — ${line.trim()}`);
    });
  }

  // And the paper renderer keeps its own figure. Renamed to totalPnlDisplay when the
  // capital-rebase display filter was added -- still a local of this function alone,
  // never renderLiveState's.
  const [paperStart, paperEnd] = bounds("renderBotState");
  const paper = lines.slice(paperStart, paperEnd).join("\n");
  assert.match(paper, /els\.portfolioTotalPl\.textContent = signedMoney\(totalPnlDisplay\);/,
    "the paper portfolio must report its own total P/L");
});

test("automation: every portfolio carries its own ON/OFF badge in its settings", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  // It belongs with the portfolio's own settings, next to the card that names it
  // -- "Live portfolio", "5050 portfolio", the paper label -- so which portfolio it
  // applies to is never in question.
  assert.match(app, /function automationBadgeMarkup\(\)/);
  const card = app.slice(app.indexOf("function renderPortfolioRulesCard"), app.indexOf("portfolio-rule-list"));
  assert.match(card, /<strong>\$\{escapeHtml\(title\)\}<\/strong>\s*\n\s*\$\{automationBadgeMarkup\(\)\}/,
    "the badge must render beside the card's own title");

  // One card is rendered per portfolio, so both paths get it.
  assert.match(app, /renderPortfolioRulesCard\(portfolioState\.label \|\| "Paper portfolio"/);
  assert.match(app, /renderPortfolioRulesCard\(isFixedEntryMode\(\) \? "5050 portfolio" : "Live portfolio"/);

  // The state shown is the open portfolio's own.
  assert.match(app, /const on = automationIsEnabled\(portfolioConfigForMode\(state\.mode\)\);/);
  assert.match(app, /updatePortfolioConfigForMode\(state\.mode, \{ automationEnabled: value \}\)/);

  // The card is rebuilt on every render, so a bound listener would be lost with the
  // element it was attached to. Delegation is what makes the click keep working.
  assert.match(app, /document\.addEventListener\("click", \(event\) => \{\n\s*const toggle = event\.target\?\.closest\?\.\("\[data-automation-toggle\]"\);/);
  assert.ok(!/els\.automationToggle/.test(app), "no stale handle to an element that no longer exists at load");
  assert.ok(!/data-automation-toggle/.test(html), "and no static copy in the markup to go out of sync");

  // This pinned the exact cache-buster the badge shipped with, which froze the
  // stylesheet's version: every later CSS change failed this test for a reason that had
  // nothing to do with the badge. What has to hold is that the badge is styled and that
  // the stylesheet is versioned at all, so a browser holding an old copy re-fetches it.
  const css = await readFile(new URL("../assets/app.css", import.meta.url), "utf8");
  assert.match(css, /^\.automation-toggle \{/m, "the badge must be styled");
  assert.match(css, /^\.automation-toggle\.is-off \{/m, "and off must look different from on");
  assert.match(html, /app\.css\?v=[\w.-]+/, "and the stylesheet must be cache-busted");
});

test("live modes: nothing may treat 5050 as a paper portfolio", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  // Reported: switching to 5050 flashed several closed trades before they vanished.
  // renderKnownStateForMode tested normalizeMode(mode) === "live", so 5050 fell to
  // renderBotState and painted the paper portfolio's closed trades until the live
  // load replaced them. That single comparison had already caused the tab showing
  // conservative data, the settings writing into the conservative portfolio, and the
  // stats appearing shared -- it is one bug shape, not four.
  //
  // Every place that asks "is this a live portfolio?" must ask it of the set, so
  // adding a live portfolio can never again mean auditing the file by hand.
  const lines = app.split("\n");
  const offenders = [];
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*)/.test(line)) return;
    if (/normalizeMode\([^)]*\)\s*===\s*"live"/.test(line)
      || /\bnormalizedMode\s*===\s*"live"(?!-)/.test(line)) {
      offenders.push(`app.js:${i + 1} — ${line.trim()}`);
    }
  });
  assert.deepEqual(offenders, [],
    `these compare against "live" alone and so exclude 5050:\n${offenders.join("\n")}`);

  // The two that matter most, pinned by name.
  assert.match(app, /function renderKnownStateForMode\(mode = state\.mode\) \{\n\s*if \(LIVE_MODES\.has\(normalizeMode\(mode\)\)\) \{/,
    "the pre-load render must not fall through to the paper renderer");
  assert.match(app, /function portfolioForMode\(mode = state\.mode\) \{\n\s*if \(LIVE_MODES\.has\(normalizeMode\(mode\)\)\)/);

  // Reloading on the 5050 tab must not drop back to a paper portfolio.
  assert.match(app, /if \(normalizeMode\(value\) === value\) return value;/);
});

test("5050: the run log is its own, even before it has one", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  // Reported: 5050 displayed another portfolio's execution history. Its state file
  // does not exist until its first run publishes one, so that fetch legitimately
  // 404s -- and the load kept the previous value on failure, which was Live's log if
  // Live had been opened first. "No log of its own yet" was being rendered as
  // "show the other portfolio's".
  assert.match(app, /state\.liveExecutionByMode\[executionMode\] = executionResult\.value;/);
  assert.match(app, /\} else if \(!\(executionMode in state\.liveExecutionByMode\)\) \{\n\s*\/\/[^\n]*\n\s*state\.liveExecutionByMode\[executionMode\] = null;/,
    "a missing log must resolve to nothing, never to another portfolio's");
  assert.match(app, /state\.liveExecutionState = state\.liveExecutionByMode\[executionMode\] \|\| null;/);
  assert.ok(!/executionResult\.status === "fulfilled" \? executionResult\.value : state\.liveExecutionState/.test(app),
    "the failure branch must not fall back to whatever was loaded last");

  // And the pre-load render must switch the log with the tab, or the other
  // portfolio's history shows for as long as the fetch takes.
  assert.match(app, /state\.liveExecutionState = state\.liveExecutionByMode\[normalizeMode\(mode\)\] \|\| null;\n\s*if \(state\.liveState\) renderLiveState/);

  // Each portfolio reads its own file.
  assert.match(app, /isFixedEntryMode\(mode\) \? "data\/live-5050-execution-state\.json" : "data\/live-execution-state\.json"/);
  assert.match(app, /fetchJson\(liveExecutionStateFile\(options\.requestedMode \|\| state\.mode\)\)/);
});

test("5050: its own button and its own schedule run its own algorithm", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");
  const api = await readFile(new URL("../api.php", import.meta.url), "utf8");
  const workflow = await readFile(new URL("../../.github/workflows/trading-live-5050.yml", import.meta.url), "utf8");

  // Reported: pressing Run once on the 5050 dashboard started the main live
  // portfolio. 5050 is a live mode, so the target resolved to "live" -- a different
  // algorithm, against real money.
  assert.match(app, /function currentExecutionTarget\(\) \{\n\s*if \(isFixedEntryMode\(\)\) return "live-5050";/);
  assert.match(app, /if \(button\.dataset\.oneTimeExecution === "current"\) return currentExecutionTarget\(\);/);
  assert.match(api, /'live-5050' => \[\n\s*'workflow' => 'trading-live-5050\.yml',/);

  // The result watcher must read the portfolio's own execution state, or it would
  // report another portfolio's run as this one's outcome.
  assert.match(app, /target === "live-5050" \? "live-5050-execution"/);

  // The auto trigger: a schedule exists, and the run is gated by the portfolio's own
  // switch and cadence rather than firing regardless.
  assert.match(workflow, /schedule:\s*\n(?:\s*#[^\n]*\n)*\s*- cron: '7,37 \* \* \* \*'/);
  // This asserted a hard-coded MANUAL for every dispatch, which was right while the cron
  // was the only automatic trigger. The scan now dispatches this workflow as well, for a
  // portfolio set to execute after each scrape, and that run is not a person's -- so the
  // source is an input the dispatcher sets, still defaulting to MANUAL so that pressing
  // the dashboard button means what it always did.
  assert.match(
    workflow,
    /LIVE_RUN_SOURCE: \$\{\{ github\.event_name == 'workflow_dispatch' && \(inputs\.live_run_source \|\| 'MANUAL'\) \|\| 'AUTO' \}\}/,
    "a hard-coded MANUAL would bypass both the switch and the cadence",
  );
  assert.match(workflow, /"LIVE_EXECUTION_CRON_MINUTES": cfg\.get\("executionCronMinutes"\)/);
  // The switch moved for the same reason: applied only to scheduled events, it would now
  // leave a dispatched after-scrape run trading while automation is off. It is written as
  // saved whatever the event, and the executor is what exempts a manual run from it.
  assert.match(workflow, /"LIVE_AUTOMATION_ENABLED": str\(bool\(cfg\.get\("automationEnabled", True\)\)\)\.lower\(\)/);

  // A scheduled run must place orders; only an unconfirmed dispatch is a dry run.
  assert.match(workflow, /POLYMARKET_DRY_RUN: \$\{\{ \(github\.event_name == 'schedule' \|\| \(github\.event_name == 'workflow_dispatch' && inputs\.live_confirm\)\) && 'false' \|\| 'true' \}\}/);

  // The algorithm runs over the whole candidate set, not a browser shortlist.
  assert.match(workflow, /LIVE_CANDIDATE_SCAN_LIMIT: "300"/);
  assert.ok(!/live_execution_candidate_token_ids/.test(workflow));
});

test("5050: the candidate list is judged by its own rule, not market-price economics", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  // 5050 does not buy at the market, it rests a bid at a fixed price. Judging its
  // shortlist on market-price yield asks the wrong question: a candidate trading at
  // 95c has a poor return if bought there and an excellent one if filled at 50c, so
  // the generic economics filter was hiding exactly the candidates it bids on -- and
  // the visible list disagreed with what the run would do.
  const branch = /if \(isFixedEntryMode\(mode\)\) \{[\s\S]*?return reasons;\n  \}/.exec(app)[0];
  const run = new Function("item", "config", "mode", "deps", `
    const {isFixedEntryMode,normalizeFixedEntryPrice,probability,money,compactDays,
      normalizeMarketTagList,marketMatchesAllowedTags}=deps;
    const reasons=[];
    const liquidity=Number(item.volumeUsdc||0), minLiquidity=Number(config.minLiquidityUsdc);
    const days=Number(item.daysToResolution), maxDays=Number(config.maxResolutionDays);
    ${branch}
    return reasons;`);
  const deps = {
    isFixedEntryMode: () => true,
    normalizeFixedEntryPrice: (v) => v ?? 0.5,
    probability: (v) => `${(v * 100).toFixed(1)}%`,
    money: (v) => `$${Number(v).toFixed(0)}`,
    compactDays: (d) => `${d} d`,
    // The tag restriction is covered by its own test; here it must not interfere.
    normalizeMarketTagList: (value) => (Array.isArray(value) ? value : []),
    marketMatchesAllowedTags: () => true,
  };
  const config = { fixedEntryPrice: 0.5, minLiquidityUsdc: 100, maxResolutionDays: 30 };
  const reasons = (item) => run(item, config, "live-5050", deps);

  // The case the old filter wrongly hid: expensive now, which is the whole point.
  assert.deepEqual(reasons({ bestAsk: 0.95, volumeUsdc: 60000, daysToResolution: 0.4 }), []);

  // Resting below the market is the strategy, so at or under the entry price there is
  // nothing to buy -- the same reason the executor gives.
  assert.match(reasons({ bestAsk: 0.5, volumeUsdc: 60000, daysToResolution: 0.4 })[0], /at or below the 50\.0% entry price/);
  assert.match(reasons({ bestAsk: 0.3, volumeUsdc: 60000, daysToResolution: 0.4 })[0], /at or below/);

  // The portfolio's own volume floor and horizon still apply.
  assert.match(reasons({ bestAsk: 0.95, volumeUsdc: 50, daysToResolution: 0.4 })[0], /volume/);
  assert.match(reasons({ bestAsk: 0.95, volumeUsdc: 60000, daysToResolution: -1 })[0], /end date is in the past/);
  assert.match(reasons({ bestAsk: 0.95, volumeUsdc: 60000, daysToResolution: 45 })[0], /beyond 30 days/);

  // It must return before the market-price economics, or those would re-reject it.
  const after = app.slice(app.indexOf(branch) + branch.length);
  assert.match(after.slice(0, 200), /if \(!Number\.isFinite\(annualizedReturn\)\)/,
    "the fixed-entry branch has to short-circuit the generic yield checks");
});

test("5050: the progress log describes the run that actually happens", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  // Reported: pressing Run 5050 once looked like it started the live portfolio. The
  // right workflow was dispatched, but every line of the progress log said "Live
  // execution" and one of them claimed "34 candidates from the refreshed list on
  // screen were sent for live verification" -- which never happened: the 5050
  // workflow has no shortlist input and the API forwards none, so the run scans for
  // candidates itself. The log described a different run from the one taking place.
  assert.match(app, /target === "live-5050" \? "5050 execution requested"/);
  assert.match(app, /target === "live-5050" \? "5050 execution confirmed"/);
  assert.match(app, /target === "live-5050" \? "starting 5050 workflow"/);

  // The shortlist is built and announced only for the portfolio that sends one.
  assert.match(app, /const sendsShortlist = target === "live";/);
  assert.match(app, /const workflowPayload = sendsShortlist \? await freshLiveWorkflowPayload\(\) : null;/);
  assert.match(app, /if \(sendsShortlist\) \{\n\s*\/\/ Name the shortlist that was actually submitted/);

  // And 5050 says what it will really do, naming its own entry price.
  assert.match(app, /"Running the 5050 algorithm"/);
  assert.match(app, /scans for them itself rather than taking the list on screen/);
});

test("5050: candidates on an event already working are risk-blocked", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  // Reported twice: every candidate stayed READY however many bids were resting.
  //
  // The rule was never wrong -- it was fed an empty set. The exposure passed to it
  // came from activeExposureRowsForMode, which filters the wallet down to what this
  // portfolio placed, and that attribution is derived from 5050's run log. The log
  // does not exist until its first run publishes one, so 5050 saw no exposure at all
  // and blocked nothing. Checking the token alone was also too narrow: one bid per
  // event means the other sub-markets of that event are different tokens and collide
  // only on the event key.
  assert.match(app, /const activeRows = isFixedEntryMode\(mode\)\n\s*\? \[\n\s*\.\.\.\(Array\.isArray\(state\.liveState\?\.positions\)/,
    "5050 must see the whole wallet, not its attributed subset");
  assert.ok(!/walletTokenIds/.test(app), "the narrower token-only check is superseded");

  const pick = (re) => re.exec(app)[0];
  const body = [
    "const inferredRiskKeysForRow = () => [];",
    pick(/function riskKeysForRow\([\s\S]*?\n\}/),
    pick(/function candidateRiskBlockReason\([\s\S]*?\n\}/),
  ].join("\n");
  const reason = new Function("item", "activeRows", `${body}
    return candidateRiskBlockReason(item, activeRows, new Map());`);
  const wallet = [{ tokenId: "A1", riskGroupKeys: ["event:matchA", "match:a"] }];

  assert.match(reason({ tokenId: "A1", riskGroupKeys: ["event:matchA"] }, wallet), /duplicate token already open/);
  assert.match(reason({ tokenId: "A2", riskGroupKeys: ["event:matchA", "match:a"] }, wallet),
    /same event or match already open/, "a sibling sub-market must block on the event key");
  assert.equal(reason({ tokenId: "B1", riskGroupKeys: ["event:matchB"] }, wallet), "",
    "an unrelated event stays biddable");

  // The failure being fixed: an empty exposure set makes everything look ready.
  assert.equal(reason({ tokenId: "A2", riskGroupKeys: ["event:matchA"] }, []), "");
});

test("5050: its own resting orders appear on its tab straight away", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  // Reported: orders placed by 5050 did not show in its Opened trades. Attribution
  // read only 5050's run log, and that log is written at the END of a run -- after
  // the orders are already resting on the book. So its own orders were invisible on
  // its own tab, and counted as Live's, for the whole window in between.
  //
  // The price is a second, independent signal: 5050 rests every bid at exactly its
  // configured entry price, far from the market by construction.
  const pick = (re) => re.exec(app)[0];
  const body = [
    pick(/function fixedEntryPriceSignatures\([\s\S]*?\n\}/),
    pick(/function matchesFixedEntryPrice\([\s\S]*?\n\}/),
    pick(/function restsAtFixedEntryPrice\([\s\S]*?\n\}/),
    // Attribution now separates a filled row from a resting one. These orders are
    // unfilled, so they still go through the price and run-log signals this pins.
    pick(/function isFilledPortfolioRow\([\s\S]*?\n\}/),
    pick(/function boughtAtFixedEntryPrice\([\s\S]*?\n\}/),
    pick(/function isClosedTrade\([\s\S]*?\n\}/),
    pick(/function belongsToActiveLivePortfolio\([\s\S]*?\n\}/),
  ].join("\n");
  const belongs = (fixed, owned) => new Function("row", `
    const isFixedEntryMode=()=>${fixed};
    const normalizeFixedEntryPrice=(v)=>v??0.5;
    const portfolioConfigForMode=()=>({fixedEntryPrice:0.51});
    // No published run log in this case -- the point is that a bid is recognised before
    // one exists, from the configured price alone.
    const state={live5050ExecutionState:null};
    const fixedEntryTokenIds=()=>new Set(${JSON.stringify(owned)});
    ${/const FIXED_ENTRY_PRICE_TOLERANCE = [\d.]+;/.exec(app)[0]}
    ${body}
    return belongsToActiveLivePortfolio(row);`);

  const notYetLogged = { tokenId: "T1", price: 0.51 };
  const logged = { tokenId: "T2", price: 0.51 };
  const liveOrder = { tokenId: "T3", price: 0.96 };

  // The case that was broken: on the book, not yet in the log.
  assert.equal(belongs(true, ["T2"])(notYetLogged), true);
  assert.equal(belongs(false, ["T2"])(notYetLogged), false, "and it must not count as Live's");
  assert.equal(belongs(true, ["T2"])(logged), true);
  // Live's orders rest near the market and stay Live's.
  assert.equal(belongs(true, ["T2"])(liveOrder), false);
  assert.equal(belongs(false, ["T2"])(liveOrder), true);

  // Every row lands on exactly one tab -- attribution must not hide or duplicate.
  for (const row of [notYetLogged, logged, liveOrder]) {
    assert.equal(belongs(true, ["T2"])(row) === belongs(false, ["T2"])(row), false,
      `${row.tokenId} must belong to exactly one live portfolio`);
  }

  // Tick rounding must not lose a bid by a hundredth.
  assert.equal(belongs(true, [])({ tokenId: "T4", price: 0.5099 }), true);
});

// Reported: a position closed by the stop loss should count as a loss in the accuracy
// tile, whatever the underlying market eventually resolves to. Before this, STOP_LOSS
// and STOP_GAP fell through to the same "wait for final resolution" rule as an ordinary
// sale or rotation -- so a stopped-out position with no recorded final price sat
// excluded from the tile indefinitely, understating how often the strategy was wrong.
test("dashboard accuracy: a stop loss counts as a loss; an unresolved sale stays excluded", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");
  const pick = (re) => re.exec(app)[0];
  const calculate = new Function("trades", `
    ${pick(/function isClosedTrade\([\s\S]*?\n\}/)}
    ${pick(/function closedTradePredictionResult\([\s\S]*?\n\}/)}
    ${pick(/function closedAccuracyStats\([\s\S]*?\n\}/)}
    return closedAccuracyStats(trades);
  `);

  const stats = calculate([
    { status: "WON" },
    { status: "LOST" },
    // Neither carries a final settlement price, so a rotation/sale is still excluded --
    // only a stop loss is unconditional.
    { status: "SOLD", realizedPnlUsdc: -0.15 },
    { status: "STOP_LOSS", realizedPnlUsdc: -1.2 },
    { status: "STOP_GAP", realizedPnlUsdc: -4.6 },
    { status: "SOLD", realizedPnlUsdc: -0.1, finalOutcomePrice: 1 },
    { status: "CLOSED", realizedPnlUsdc: 0.1, finalOutcomePrice: 0 },
    { status: "OPEN" },
  ]);

  assert.deepEqual(stats, {
    correct: 2,
    total: 6,
    excluded: 1,
    rate: 2 / 6,
  });
});

test("market scan: a manual scan finishes on the server, whatever the tab does", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  // Reported: a manual scan sometimes ends in an error, or seems to break when the
  // page is left. The scan itself runs on the runner and finishes regardless -- only
  // the waiting happens in the browser, and the waiting had three faults.
  const wait = app.slice(app.indexOf("async function waitForScrapedScanWorkflow"));
  const body = wait.slice(0, wait.indexOf("\n}"));

  // 1. It gave up after 64 polls 3s apart -- about three minutes, shorter than a
  //    large scan -- and the caller turned that into an error.
  assert.match(body, /budgetMs = 25 \* 60 \* 1000/);
  assert.match(body, /while \(Date\.now\(\) < deadline\)/,
    "the budget must be wall-clock, not a poll count, or a throttled tab spends it on no real time");
  assert.ok(!/attempt < 64/.test(body));

  // 2. One failed status check threw out of the loop and reported an error for a
  //    scan that was running fine.
  assert.match(body, /\} catch \{/);
  assert.match(body, /consecutiveFailures \+= 1;/);
  assert.match(body, /still waiting/);

  // 3. A hidden tab throttles timers to about one per minute, so a poll scheduled
  //    before the switch idles long past the work finishing.
  assert.match(body, /await sleepUntilVisible\(/);
  assert.match(app, /function sleepUntilVisible\(ms\)/);
  assert.match(app, /document\.addEventListener\("visibilitychange", onVisible\);/);
  assert.match(app, /if \(document\.visibilityState === "visible"\) finish\(\);/);
  // The listener must be removed, or every wait leaks one.
  assert.match(app, /document\.removeEventListener\("visibilitychange", onVisible\);/);

  // Running is not failing: the caller waits for publication instead of erroring.
  assert.match(app, /Scan is still running on the server; its results will appear when it publishes\./);
  assert.ok(!/throw new Error\("Scan is still queued in the background/.test(app));
});

test("live portfolios: each sizes from its own commitments, not the shared wallet's", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  // Superseded by a later report and an explicit decision. Free cash was the shared
  // balance minus EVERY resting buy, because one wallet backs both portfolios and the
  // exchange really does reserve for all of them. In practice 5050 rests many bids at
  // once, which left the Live portfolio reading zero free cash and skipping every
  // candidate while the account was otherwise idle. Each portfolio is now shown, and
  // sizes from, what its own commitments leave -- and the exchange, not the dashboard,
  // decides whether a submission fits. That refusal is already handled and counted.
  assert.match(app, /const ownOrderReservation = reservedByOrders\(openOrderRows\);/);
  assert.match(app, /const freeCash = Number\.isFinite\(cash\) \? Math\.max\(0, cash - ownOrderReservation\) : null;/);
  // The wallet total is still computed, so the tile can say how much of the balance the
  // other portfolio has spoken for rather than quietly overstating what is spendable.
  assert.match(app, /const walletOrderRisk = reservedByOrders\(Array\.isArray\(liveState\?\.openOrders\)/);
  assert.match(app, /const otherPortfolioReservation = Math\.max\(0, walletOrderRisk - ownOrderReservation\);/);
  assert.match(app, /locked by the other portfolio/);

  // Unchanged: risk is what THIS portfolio has committed, and the wallet-wide position
  // total must not stand in for it.
  assert.match(app, /const ownPositionRisk = positions\.reduce\(/);
  assert.match(app, /els\.portfolioRisk\.textContent = money\(ownPositionRisk \+ openOrderRisk\);/);
  assert.ok(!/portfolio\.openRiskUsdc \|\| 0\) \+ openOrderRisk/.test(app),
    "the wallet-wide position total must not stand in for a portfolio's own");
  // A resting sell releases collateral rather than reserving it.
  assert.match(app, /\.filter\(\(order\) => !String\(order\.side \|\| ""\)\.toUpperCase\(\)\.includes\("SELL"\)\)/);
  // A cancelled or filled order still in the snapshot reserves no collateral.
  assert.match(app, /TERMINAL_ORDER_STATUSES\.has\(String\(order\.rawStatus \|\| order\.status \|\| ""\)\.toUpperCase\(\)\)/);
  // Orders carry notionalUsdc from the sync; the others are fallbacks.
  assert.match(app, /Number\(order\.notionalUsdc \?\? order\.totalCostUsdc \?\? order\.stakeUsdc\)/);

  // The arithmetic, on one wallet holding both portfolios' orders.
  const cash = 20;
  const live = [{ side: "BUY", notionalUsdc: 3 }];
  const other = [{ side: "BUY", notionalUsdc: 2.55 }, { side: "BUY", notionalUsdc: 2.55 }];
  const sell = [{ side: "SELL", notionalUsdc: 9 }];
  const reserved = (rows) => rows
    .filter((order) => !order.side.includes("SELL"))
    .reduce((sum, order) => sum + order.notionalUsdc, 0);
  const own = reserved(live);
  const wallet = reserved([...live, ...other, ...sell]);
  assert.equal(own, 3);
  assert.equal(wallet, 8.1);
  // What the Live tab shows now, and what it has to disclose alongside it.
  assert.equal(Math.max(0, cash - own).toFixed(2), "17.00");
  assert.equal(Math.max(0, wallet - own).toFixed(2), "5.10");
});

test("run log: history survives a reload and a failed fetch", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  // Reported: the run log empties itself -- "No Live trading decision runs recorded
  // yet" on a list that had entries. The per-portfolio execution state was cached in
  // memory only, so every reload began with nothing and the log read empty until the
  // fetch landed; if that fetch failed, it stayed empty for the whole session.
  // History that disappears on a refresh is worse than history a minute stale.
  const pick = (re) => re.exec(app)[0];
  const body = [
    pick(/function cachedLiveExecutionByMode\(\)[\s\S]*?\n\}/),
    pick(/function rememberLiveExecutionState\(mode, value\)[\s\S]*?\n\}/),
  ].join("\n");
  const store = new Map();
  const localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const api = new Function("localStorage", `const LIVE_EXECUTION_CACHE_KEY="k";
    ${body}
    return {cachedLiveExecutionByMode, rememberLiveExecutionState};`)(localStorage);

  assert.deepEqual(api.cachedLiveExecutionByMode(), {}, "a first visit has no history to show");
  api.rememberLiveExecutionState("live", { generatedAt: "t1", action: "SUBMITTED", runLog: [{ id: "r1" }, { id: "r2" }] });
  api.rememberLiveExecutionState("live-5050", { generatedAt: "t2", action: "SKIP", runLog: [{ id: "f1" }] });

  // Each portfolio keeps its own, so a reload cannot show one portfolio's log
  // under the other.
  const reloaded = api.cachedLiveExecutionByMode();
  assert.equal(reloaded.live.runLog.length, 2);
  assert.equal(reloaded["live-5050"].runLog.length, 1);
  assert.equal(reloaded.live.action, "SUBMITTED");

  // The failure that was blanking it.
  api.rememberLiveExecutionState("live", null);
  assert.equal(api.cachedLiveExecutionByMode().live.runLog.length, 2, "a failed fetch must not wipe the log");

  // A full or unavailable store must never break a render.
  assert.doesNotThrow(() => api.rememberLiveExecutionState("live", { runLog: [], get generatedAt() { throw new Error("boom"); } }));

  // The cache is seeded before the first render, not only after a load.
  assert.match(app, /state\.liveExecutionByMode = state\.liveExecutionByMode \|\| cachedLiveExecutionByMode\(\);\n\s*state\.liveExecutionState = state\.liveExecutionByMode\[normalizeMode\(mode\)\] \|\| null;/);
  assert.match(app, /rememberLiveExecutionState\(executionMode, executionResult\.value\);/);
  // Bounded, so a large batch cannot overflow the quota and lose everything.
  assert.match(app, /runLog: Array\.isArray\(value\.runLog\) \? value\.runLog\.slice\(0, 60\) : \[\]/);
});

test("rules card: automation is the badge, not a row", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  // The ON/OFF badge sits in the card header and is clickable, so repeating the same
  // state as a read-only row below it said the same thing twice -- and the row could
  // not be acted on.
  assert.ok(!/\["Automatic execution", automationIsEnabled/.test(app));
  assert.match(app, /function automationBadgeMarkup\(\)/, "the badge stays the single place it is shown");
  assert.match(app, /\$\{automationBadgeMarkup\(\)\}/);
});

test("scraped counts: the UI reports the archive, not the page it was served", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");
  const api = await readFile(new URL("../api.php", import.meta.url), "utf8");

  // Nothing is discarded on disk now, but one response still cannot carry the whole
  // archive: measured on a 5000-row active catalogue, this summary peaks near 111 MB
  // at 8000 resolved rows and a 128 MB host answers 500 first. So the list is a page
  // and the count is the total -- otherwise the labels shrink as the archive grows,
  // which reads as records disappearing.
  assert.match(api, /\$resolvedServeLimit = 3000;/);
  assert.match(api, /'observationTotals' => state_observation_totals\(\$data\)/,
    "the true totals must be served alongside the page");
  assert.match(api, /'resolvedTruncated' => \$resolvedTruncated/);

  // And the browser must prefer the reported total over what it received.
  assert.match(app, /const totals = state\.scrapedObservationTotals;/);
  assert.match(app, /if \(totals && Number\.isFinite\(Number\(totals\.resolved\)\) && Number\(totals\.resolved\) > counts\.resolved\)/);
  assert.match(app, /counts\.resolved = Number\(totals\.resolved\);/);
});

// A manual scan of the `clf` tag on 2026-08-08 exited 0, published nothing and left no log.
// The tag picker is built from tags observed on stored markets, which is a far wider set
// than MARKET_SCAN_CATEGORY_TAGS, so the scan threw "unknown Polymarket scan tag" before
// the try that records a run -- and the caller swallowed it. These tests pin both halves:
// an unknown slug is now looked up rather than rejected, and a scan that fails anyway
// still leaves a row behind.
// The tag is read at import time and the trigger at call time, so the environment has to
// stay applied for the whole test, not just for the import. The query suffix gives each
// case its own module instance.
async function scopedBot(suffix, env = {}) {
  const previous = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    if (value == null) delete process.env[key];
    else process.env[key] = String(value);
  }
  const restore = () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  };
  try {
    return { bot: await import(`../tools/paper-trading-bot.mjs?${suffix}`), restore };
  } catch (error) {
    restore();
    throw error;
  }
}

function stubFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    const result = handler(url);
    if (!result) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => result };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test("market scan: a tag outside the catalogue is resolved instead of aborting the scan", async () => {
  const { bot: scoped, restore } = await scopedBot("scan-tag-resolve", {
    PAPER_MARKET_SCAN_TAG: "clf",
    PAPER_MARKET_SCAN_TRIGGER: "MANUAL",
    PAPER_MARKET_SCAN_LIVE: "false",
  });
  const stub = stubFetch((url) => {
    if (url.includes("/tags/slug/clf")) return { id: 102345, slug: "clf", label: "CLF" };
    if (url.includes("events/keyset")) return { events: [], next_cursor: "" };
    return null;
  });
  try {
    const state = { marketObservations: [], marketScanHistory: [], evaluations: [] };
    await scoped.refreshMarketObservations(state);

    const run = state.marketScanHistory[0];
    assert.equal(run.status, "SUCCESS", `expected a completed scan, got ${run.status}: ${run.error}`);
    assert.equal(run.trigger, "MANUAL", "the manual flag the user was looking for");
    assert.equal(run.scanTag, "clf");

    // The scan needs Gamma's numeric id; the slug alone cannot be queried.
    const eventsCall = stub.calls.find((url) => url.includes("events/keyset"));
    assert.ok(eventsCall, "the resolved tag must actually be scanned");
    assert.match(eventsCall, /tag_id=102345/);

    // And the id is kept, so the next scan of this tag costs no extra request.
    assert.equal(state.marketScan.resolvedTagIds.clf, "102345");
    assert.equal(scoped.normalizeMarketScan(state.marketScan).resolvedTagIds.clf, "102345",
      "the whitelist must carry it into the published state");
  } finally {
    stub.restore();
    restore();
  }
});

test("market scan: a cached tag id is reused without a second lookup", async () => {
  const { bot: scoped, restore } = await scopedBot("scan-tag-cache", {
    PAPER_MARKET_SCAN_TAG: "clf",
    PAPER_MARKET_SCAN_LIVE: "false",
  });
  const stub = stubFetch((url) => (url.includes("events/keyset") ? { events: [], next_cursor: "" } : null));
  try {
    const state = {
      marketObservations: [],
      marketScanHistory: [],
      evaluations: [],
      marketScan: { resolvedTagIds: { clf: "102345" } },
    };
    await scoped.refreshMarketObservations(state);
    assert.equal(state.marketScanHistory[0].status, "SUCCESS");
    assert.ok(!stub.calls.some((url) => url.includes("/tags")), "a cached id must not be looked up again");
    assert.match(stub.calls.find((url) => url.includes("events/keyset")), /tag_id=102345/);
  } finally {
    stub.restore();
    restore();
  }
});

test("market scan: a scan that cannot run still records a run with its trigger and reason", async () => {
  const { bot: scoped, restore } = await scopedBot("scan-tag-missing", {
    PAPER_MARKET_SCAN_TAG: "clf",
    PAPER_MARKET_SCAN_TRIGGER: "MANUAL",
    PAPER_MARKET_SCAN_LIVE: "false",
  });
  // Gamma knows no such tag: every lookup route 404s.
  const stub = stubFetch(() => null);
  try {
    const state = { marketObservations: [], marketScanHistory: [], evaluations: [] };
    const observations = await scoped.refreshMarketObservations(state);
    assert.deepEqual(observations, [], "a failed scan returns nothing rather than throwing past the caller");

    const run = state.marketScanHistory[0];
    assert.ok(run, "the run the user went looking for and could not find");
    assert.equal(run.status, "ERROR");
    assert.equal(run.trigger, "MANUAL");
    assert.equal(run.scanTag, "clf");
    assert.equal(run.scanScope, "Category: clf", "the attempt is named even though no scope was chosen");
    assert.ok(String(run.error || "").length > 0, "the row has to carry the reason");
    assert.equal(state.marketScan.lastScanError, run.error);
  } finally {
    stub.restore();
    restore();
  }
});

test("market scan: a failed scan is published, then fails the workflow", async () => {
  const { readFile } = await import("node:fs/promises");
  const [source, workflow, app] = await Promise.all([
    readFile(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8"),
    readFile(new URL("../../.github/workflows/trading-market-scan.yml", import.meta.url), "utf8"),
    readFile(new URL("../assets/app.js", import.meta.url), "utf8"),
  ]);

  // The history row is written whatever happened, so a failed scan is still listed.
  assert.match(source, /scanFailure = String\(normalizeMarketScan\(state\.marketScan\)\.lastScanError \|\| ""\);/);
  assert.match(source, /if \(scanFailure\) await writeScanErrorMarker\(scanFailure\);/);
  // And the summary must not claim success over a scan that fetched nothing.
  assert.match(source, /action: scanFailure \? "MARKET_SCAN_FAILED" : "MARKET_SCAN"/);

  // Publish first, fail second, dispatch downstream work only if the scan actually ran.
  const order = ["Upload paper state", "Append compact scraping history entry",
    "Fail when the scan did not complete", "Dispatch post-scrape execution"]
    .map((name) => workflow.indexOf(`- name: ${name}`));
  assert.ok(order.every((index) => index > 0), "every step must be present");
  assert.deepEqual([...order].sort((a, b) => a - b), order, `steps are out of order: ${order}`);
  assert.match(workflow, /PAPER_SCAN_ERROR_PATH: data\/market-scan-error\.txt/);
  assert.match(workflow, /if \[ -s trading\/data\/market-scan-error\.txt \]; then/);

  // The dashboard names the cause instead of only reporting that the workflow failed.
  assert.match(app, /const reason = await publishedScanFailureReason\(baseline\);/);
  assert.match(app, /return `\$\{label\}: scan failed - \$\{runError \|\| "no markets were scanned"\}`;/);
});

// Reported: the execution candidates list did not show every candidate. It rendered a
// fixed first 80 rows and said nothing about the rest, so a portfolio with more than
// that simply hid them. The list now pages through the whole set.
function candidateRenderer(state) {
  const app = readFileSync(new URL("../assets/app.js", import.meta.url), "utf8");
  const pick = (name) => {
    let start = app.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`missing ${name}`);
    const bodyStart = app.indexOf(") {\n", start);
    let depth = 0;
    for (let i = bodyStart + 2; i < app.length; i += 1) {
      if (app[i] === "{") depth += 1;
      else if (app[i] === "}") {
        depth -= 1;
        if (!depth) return app.slice(start, i + 1);
      }
    }
    throw new Error(`unbalanced ${name}`);
  };
  const body = [pick("candidateVisibleCount"), pick("renderPortfolioCandidateRows")].join("\n\n");
  const pageSize = Number(/const CANDIDATE_PAGE_SIZE = (\d+);/.exec(app)[1]);
  const stub = () => "";
  const deps = {
    state,
    CANDIDATE_PAGE_SIZE: pageSize,
    normalizeMode: (mode) => mode,
    portfolioConfigForMode: () => ({ probabilitySource: "polymarket" }),
    normalizeProbabilitySource: (value) => value,
    LIVE_MODES: new Set(["live", "live-5050"]),
    portfolioReturnMetricLabel: () => "p.a.",
    escapeHtml: (value) => String(value ?? ""),
    formatInteger: (value) => String(value),
  };
  // Cell formatting is not what is under test, so whatever the renderer reaches for
  // next gets a neutral stub.
  const compile = () => {
    const names = Object.keys(deps);
    return new Function(...names, `${body}\nreturn { renderPortfolioCandidateRows, candidateVisibleCount };`)(
      ...names.map((name) => deps[name]),
    );
  };
  let api = compile();
  return {
    pageSize,
    candidateVisibleCount: (mode) => api.candidateVisibleCount(mode),
    render(rows, mode, diagnostics) {
      for (let guard = 0; guard < 80; guard += 1) {
        try {
          return api.renderPortfolioCandidateRows(rows, mode, diagnostics);
        } catch (error) {
          const missing = /(\w+) is not defined/.exec(error.message);
          if (!missing) throw error;
          deps[missing[1]] = stub;
          api = compile();
        }
      }
      throw new Error("renderer could not be satisfied");
    },
  };
}

test("execution candidates: every candidate is reachable, a page at a time", () => {
  const state = { mode: "live-5050", candidateVisibleCount: 0, candidateVisibleMode: "", candidateTotalCount: 0 };
  const renderer = candidateRenderer(state);
  const size = renderer.pageSize;
  const total = size * 3 + 10;
  const rows = Array.from({ length: total }, (_, index) => ({ tokenId: String(index), question: `Market ${index}` }));
  const diagnostics = { ready: rows, riskBlocked: [], manuallyExcluded: [], filteredReasonCounts: new Map() };
  const countRows = (html) => (html.match(/<tr\b/g) || []).length - 1;

  const first = renderer.render(rows, "live-5050", diagnostics);
  assert.equal(countRows(first), size, "the first page is one screenful");
  assert.match(first, /data-candidates-load-more/, "and it must say the rest exists");
  assert.match(first, new RegExp(`${total - size} of ${total} still hidden`),
    "the control has to name how many are not on screen");

  // Scrolling (or the button) raises the count; the renderer must follow it all the way.
  state.candidateVisibleCount = size * 2;
  assert.equal(countRows(renderer.render(rows, "live-5050", diagnostics)), size * 2);

  state.candidateVisibleCount = total;
  const last = renderer.render(rows, "live-5050", diagnostics);
  assert.equal(countRows(last), total, "with the count at the total, every candidate renders");
  assert.ok(!/data-candidates-load-more/.test(last), "and nothing claims there is more");

  // Past the end is not an error, and still shows exactly the whole set.
  state.candidateVisibleCount = total + size;
  assert.equal(countRows(renderer.render(rows, "live-5050", diagnostics)), total);

  // A different portfolio starts again at one page rather than inheriting the scroll.
  assert.equal(renderer.candidateVisibleCount("live"), size);
  assert.equal(state.candidateVisibleMode, "live");
});

test("execution candidates: the list extends itself on scroll and by button", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  // Endless scrolling, as asked for -- plus the button, because a scroll listener is
  // no use to anyone driving the table from the keyboard.
  assert.match(app, /els\.portfolioCandidates\?\.addEventListener\("click", \(event\) => \{\n  if \(!event\.target\.closest\("\[data-candidates-load-more\]"\)\) return;/);
  // `scroll` does not bubble, so a panel-level listener has to capture.
  assert.match(app, /els\.portfolioCandidates\?\.addEventListener\("scroll", \(event\) => \{[\s\S]*?\}, true\);/);
  assert.match(app, /showMoreCandidates\(\);/);
  // Re-rendering replaces the table, so the position has to survive the extension or
  // the list snaps back to the top and the end can never be reached.
  assert.match(app, /const offset = scroller \? scroller\.scrollTop : 0;/);
  assert.match(app, /if \(nextScroller\) nextScroller\.scrollTop = offset;/);
  // The summary must not imply the totals are all on screen.
  assert.match(app, /const paged = shown < total \? ` - showing \$\{formatInteger\(shown\)\} of \$\{formatInteger\(total\)\}` : "";/);
});

// Reported with a screenshot: the newest 5050 run was still listed twice, the first of
// the pair labelled "Live", and the newest runs were missing. The earlier fix matched the
// two rows by batchLog id -- but the device cache keeps a reduced copy of the state, and
// the first paint after a reload renders from it. That copy carried no batchLog, so the
// top-level row was rebuilt as a run of its own with a synthesized id and a hard-coded
// Live label, and the pair no longer matched.
function runLogRenderer(app, executionState, { fixedEntry = true } = {}) {
  const pick = (name) => {
    const start = app.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`missing ${name}`);
    const bodyStart = app.indexOf(") {\n", start);
    let depth = 0;
    for (let i = bodyStart + 2; i < app.length; i += 1) {
      if (app[i] === "{") depth += 1;
      else if (app[i] === "}") {
        depth -= 1;
        if (!depth) return app.slice(start, i + 1);
      }
    }
    throw new Error(`unbalanced ${name}`);
  };
  const body = ["normalizeLiveExecutionRun", "isSameLiveRun", "runLogTimestamp", "sortRunLogRows", "mergeUniqueByRun",
    "isCadenceWaitRun", "isHistoryRecoveryRun", "liveRunLogRows"].map(pick).join("\n\n");
  return new Function("state", "isFixedEntryMode", "liveBatchCandidateSummaryFromExecution", "portfolioReturnMetricLabel",
    `${body}\nreturn liveRunLogRows;`)(
    { liveState: null, liveExecutionState: executionState },
    () => fixedEntry,
    (item) => item,
    () => "",
  )();
}

test("5050 run log: one row per run whatever shape the state was stored in", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  const generatedAt = "2026-08-08T13:09:11.000Z";
  const batchLog = {
    action: "SKIP",
    reason: "fixed-entry batch rested 0 of 1 bids at 0.51",
    strategyId: "live-5050",
    strategyLabel: "5050",
    runAt: generatedAt,
    counts: {},
  };
  const newest = { ...batchLog, id: `live-trade-batch-${generatedAt}`, generatedAt };
  const older = {
    id: "live-trade-batch-2026-08-08T11:55:40.000Z",
    runAt: "2026-08-08T11:55:40.000Z",
    strategyId: "live-5050",
    action: "SUBMITTED",
    reason: "older run",
  };
  const runLog = [newest, older];

  const shapes = {
    // Straight from the published state.
    fresh: { generatedAt, action: batchLog.action, reason: batchLog.reason, batchLog, runLog },
    // What the device cache used to hold: no batchLog at all. This is the screenshot.
    legacyCache: { generatedAt, action: batchLog.action, reason: batchLog.reason, runLog },
    // And with a batchLog whose clock read drifted from generatedAt by a few ms, which
    // is how the executor used to stamp them.
    driftedClock: {
      generatedAt,
      action: batchLog.action,
      reason: batchLog.reason,
      batchLog: { ...batchLog, id: null, runAt: "2026-08-08T13:09:11.004Z" },
      runLog,
    },
  };

  for (const [label, executionState] of Object.entries(shapes)) {
    const rows = runLogRenderer(app, executionState);
    assert.equal(rows.length, 2, `${label}: expected one row per run, got ${rows.map((row) => row.action).join(", ")}`);
    assert.equal(rows[1].id, older.id, `${label}: the older run must be untouched`);
    assert.ok(!/^Live$/.test(String(rows[0].strategyLabel || "")),
      `${label}: a 5050 run must not be labelled as the Live portfolio`);
  }
});

test("5050 run log: the cache keeps enough to identify the run it stored", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  // A cache that drops the identity is what forced the row to be rebuilt as a new run.
  assert.match(app, /batchLog: value\.batchLog\n\s+\? \{\n\s+id: value\.batchLog\.id \|\| null,/);
  assert.match(app, /strategyId: value\.batchLog\.strategyId \|\| null,/);
  // Unequal ids must not be read as proof of different runs, because one of them may be
  // synthesized here rather than by the executor.
  assert.match(app, /if \(leftId && rightId && leftId === rightId\) return true;/);
  // And the title must name the portfolio whose log it is.
  // Same shape as the panel titles: a custom portfolio name wins, and the fallback behind
  // it still names which portfolio the run belongs to.
  assert.match(app, /const label = portfolioUsesCustomName\(\) \? portfolioNameForMode\(\) : \(isFixedEntryMode\(\) \? "5050" : \(isLiveMode\(\) \? "Live" : paperModeLabel\(\)\)\);/);

  // The browser caches the script URL, so a dashboard fix that does not bump this is
  // published and never served -- which is why the earlier fix appeared not to work.
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const version = /assets\/app\.js\?v=([^"]+)/.exec(html);
  assert.ok(version, "app.js must stay cache-busted");
  assert.notEqual(version[1], "20260804-resolved-scraped", "the version has to move when app.js does");
});

test("days left: a market past its end date reads as overdue, and p.a. is untouched", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");
  const executor = await readFile(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8");
  const pick = (src, name) => {
    const start = src.indexOf(`function ${name}(`);
    const bodyStart = src.indexOf(") {\n", start);
    let depth = 0;
    for (let i = bodyStart + 2; i < src.length; i += 1) {
      if (src[i] === "{") depth += 1;
      else if (src[i] === "}") {
        depth -= 1;
        if (!depth) return src.slice(start, i + 1);
      }
    }
    throw new Error(`unbalanced ${name}`);
  };
  const minDays = 1 / 24;
  const api = new Function("MIN_ANNUALIZATION_DAYS", `
    ${pick(app, "compactDays")}
    ${pick(app, "daysUntil")}
    ${pick(app, "annualizationDays")}
    ${pick(app, "annualizeReturn")}
    return { compactDays, daysUntil, annualizeReturn };
  `)(minDays);
  const at = (days) => new Date(Date.now() + days * 86400000).toISOString();

  // Reported: "1.0 day left" on a market whose date had passed. Negative is wanted.
  assert.match(api.compactDays(api.daysUntil(at(-2.3))), /^-2\.3 d$/);
  assert.match(api.compactDays(api.daysUntil(at(-0.5))), /^-12\.0 h$/);
  assert.match(api.compactDays(api.daysUntil(at(-0.02))), /^-\d+ min$/);
  // Future horizons are unchanged.
  assert.match(api.compactDays(api.daysUntil(at(5))), /^5\.0 d$/);
  assert.match(api.compactDays(api.daysUntil(at(0.5))), /^12\.0 h$/);
  assert.equal(api.compactDays(api.daysUntil("not a date")), "-");

  // The executor stored a one-day floor as the row's days-left, which is what produced
  // "1.0 day". It is gone; the annualization floor that guards the maths is not.
  assert.ok(!/return Math\.max\(1, \(end - Date\.now\(\)\) \/ 86400000\);/.test(executor),
    "the display floor must be gone");
  assert.match(executor, /return Math\.max\(MIN_ANNUALIZATION_DAYS, days\);/,
    "the annualization floor must stay");

  // Asked for explicitly: leave the potential p.a. as it is. A signed horizon must not
  // move it, because every annualization already floors a non-positive one.
  for (const days of [-40, -2.3, -0.5, 0]) {
    const signed = api.daysUntil(at(days));
    assert.equal(api.annualizeReturn(0.1, signed), api.annualizeReturn(0.1, Math.max(0, signed)),
      `p.a. must be unchanged at ${days} days`);
  }
});

// Asked to check that the Live portfolio's closed trades show up. They do render -- the
// account snapshot carries 28 of them and nothing trims the list -- but attribution had a
// hole that could take them away. A row that FILLED was claimed the same way a resting
// order is: by token. Both live portfolios draw from one candidate pool and 5050 rests a
// bid on nearly everything that clears its bar, so any market Live actually bought and
// closed was handed to 5050 as soon as 5050 had an unfilled bid on the same token.
function liveTradeAttribution(app, { mode, fixedEntryPrice = 0.51, execution5050 = null }) {
  const pick = (name) => {
    const start = app.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`missing ${name}`);
    const bodyStart = app.indexOf(") {\n", start);
    let depth = 0;
    for (let i = bodyStart + 2; i < app.length; i += 1) {
      if (app[i] === "{") depth += 1;
      else if (app[i] === "}") {
        depth -= 1;
        if (!depth) return app.slice(start, i + 1);
      }
    }
    throw new Error(`unbalanced ${name}`);
  };
  const body = ["submittedTokenIds", "fixedEntryTokenIds", "fixedEntryPriceSignatures", "matchesFixedEntryPrice",
    "restsAtFixedEntryPrice", "isFilledPortfolioRow", "fixedEntryOrderPricesByToken", "boughtAtFixedEntryPrice",
    "belongsToActiveLivePortfolio", "isClosedTrade", "liveClosedTrades", "liveOpenOrders"]
    .map(pick).join("\n\n");
  const tolerance = /const FIXED_ENTRY_PRICE_TOLERANCE = [\d.]+;/.exec(app)[0];
  return new Function("state", "isFixedEntryMode", "normalizeFixedEntryPrice", "portfolioConfigForMode",
    `${tolerance}\n${body}\nreturn { liveClosedTrades, liveOpenOrders };`)(
    { mode, live5050ExecutionState: execution5050 },
    () => mode === "live-5050",
    (value) => Number(value),
    () => ({ fixedEntryPrice }),
  );
}

test("live closed trades: a resting 5050 bid does not take a trade Live actually closed", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  // The shape live-account-sync builds: an average fill price, and no `price` field.
  const closed = (tokenId, entryPrice, status = "WON") => ({
    id: `t-${tokenId}`, status, tokenId, question: `Market ${tokenId}`,
    entryPrice, currentPrice: null, latestPrice: entryPrice, realizedPnlUsdc: 1.2,
  });
  const liveState = {
    closedTrades: [
      closed("100", 0.95),
      closed("101", 0.88, "LOST"),
      closed("102", 0.51),                       // 5050's own fill, at its one price
      closed("103", 0.97, "REDEEMED"),
      { ...closed("104", 0.9), tokenId: "" },     // no token at all
    ],
  };
  // 5050 has a bid resting on 100 -- the market Live bought and closed -- and a genuine
  // logged order of its own on 102, the fill it actually owns.
  const execution5050 = { runLog: [
    { attempts: [{ tokenId: "100", action: "SUBMITTED" }] },
    { attempts: [{ tokenId: "102", orderPrice: 0.51, action: "SUBMITTED" }] },
  ] };

  const onLive = liveTradeAttribution(app, { mode: "live", execution5050 }).liveClosedTrades(liveState);
  const on5050 = liveTradeAttribution(app, { mode: "live-5050", execution5050 }).liveClosedTrades(liveState);

  assert.deepEqual(onLive.map((row) => row.tokenId), ["100", "101", "103", ""],
    "every trade Live bought stays on the Live tab, including the one 5050 has a bid on");
  assert.deepEqual(on5050.map((row) => row.tokenId), ["102"],
    "and 5050 keeps only what it actually bought, at its own price");

  // A row with no recorded buy price cannot be claimed, so it stays with Live.
  const unknown = { closedTrades: [{ id: "x", status: "WON", tokenId: "100", entryPrice: null }] };
  assert.equal(liveTradeAttribution(app, { mode: "live", execution5050 }).liveClosedTrades(unknown).length, 1);
  assert.equal(liveTradeAttribution(app, { mode: "live-5050", execution5050 }).liveClosedTrades(unknown).length, 0);

  // With no 5050 state at all -- its file 404s until its first run publishes -- nothing
  // may be taken from Live: all 5 rows, including 102, which only ever matched on the
  // default configured price coincidentally, not on anything recorded about that token.
  assert.equal(liveTradeAttribution(app, { mode: "live", execution5050: null }).liveClosedTrades(liveState).length, 5);
});

test("live closed trades: resting orders are still attributed by price and run log", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  // Unfilled orders have no buy price, so the original signals still decide them --
  // 5050 rests every bid at its entry price, which is far from the market by design.
  const liveState = {
    openOrders: [
      { id: "a", tokenId: "300", price: 0.51, remainingSize: 5 },   // 5050 by price
      { id: "b", tokenId: "301", price: 0.94, remainingSize: 3 },   // Live
      { id: "c", tokenId: "302", price: 0.88, remainingSize: 2 },   // 5050 by its run log
    ],
  };
  const execution5050 = { runLog: [{ attempts: [{ tokenId: "302", action: "SUBMITTED" }] }] };
  assert.deepEqual(
    liveTradeAttribution(app, { mode: "live", execution5050 }).liveOpenOrders(liveState).map((row) => row.id),
    ["b"],
  );
  assert.deepEqual(
    liveTradeAttribution(app, { mode: "live-5050", execution5050 }).liveOpenOrders(liveState).map((row) => row.id),
    ["a", "c"],
  );
});

// Reported: a Live run ended SKIP with "no currently executable candidate after live
// revalidation", and the rejected candidates stayed in the list instead of updating and
// disappearing. Two of the three were markets Gamma no longer lists at all.
//
// The workflow step that writes those verdicts back downloads paper-state.json and merges
// into state["evaluations"] and state["marketObservations"]. Since the catalogue was split
// into sibling segment files, the core keeps exactly those fields as empty arrays -- so
// every run merged into nothing, wrote nothing, and the dead markets were shortlisted,
// re-fetched and re-rejected again on the next pass.
test("live revalidation: the verdicts are written where the rows actually live", async () => {
  const { readFile } = await import("node:fs/promises");
  // The merge is a shared script now: it was a heredoc in the live workflow and absent
  // from 5050, so a market that portfolio found gone stayed READY in its candidate list
  // and was re-fetched and re-rejected by every pass after it.
  const persist = await readFile(new URL("../tools/persist-live-revalidation.py", import.meta.url), "utf8");

  // The fact that makes merging into the core wrong, checked against the real splitter
  // rather than assumed: the fields the step needs are emptied out of paper-state.json.
  const future = new Date(Date.now() + 86400000).toISOString();
  const { core, segments } = bot.splitStateIntoSegments(bot.normalizeState({
    evaluations: [{ tokenId: "555", question: "Dead", status: "EVALUATED", marketProbability: 0.9, endDate: future }],
    marketObservations: [{ tokenId: "555", question: "Dead", status: "SCRAPED", marketProbability: 0.9, endDate: future }],
  }));
  assert.deepEqual(core.evaluations, [], "the core carries no evaluations to merge into");
  assert.deepEqual(core.marketObservations, [], "nor any observations");
  assert.equal(segments.evaluations.evaluations.length, 1, "the rows are in the segment file");
  assert.equal(segments.observations.marketObservations.length, 1);
  assert.equal(core.stateSegments.evaluations.file, "paper-state.evaluations.json");
  assert.equal(core.stateSegments.observations.file, "paper-state.observations.json");

  // So the step has to follow the manifest to those files, and write them back.
  assert.match(persist, /core = read_json\("paper-state\.json"\)/);
  assert.match(persist, /manifest = core\.get\("stateSegments"\)/);
  assert.match(persist, /for segment, field in \(\("evaluations", "evaluations"\), \("observations", "marketObservations"\)\):/);
  assert.match(persist, /documents\[name\] = read_json\(name\)/);
  assert.match(persist, /count = merge_revalidation\(documents\[name\]\.get\(field\), /);
  assert.match(persist, /for name in sorted\(changed\):\n\s+write_json\(name, documents\[name\]\)/);
  // A state written before segmentation still has its rows inline; that path must remain.
  assert.match(persist, /if not re\.fullmatch\(r"\[A-Za-z0-9\._-\]\+\\\.json", name\):\n\s+name = "paper-state\.json"/);
  // And the old whole-core rewrite must be gone, or it would clobber the manifest shell.
  assert.ok(!/merged_evaluations = merge_revalidation\(state\.get\("evaluations"\)/.test(persist));
  assert.ok(!/json\.dumps\(state, ensure_ascii=False, indent=2\)/.test(persist),
    "the observations segment is megabytes; it must not be written indented");

  // A market Gamma dropped is closed out, which is what removes it from the candidates:
  // api.php's active-observation test rejects exactly this status.
  assert.match(persist, /if update\.get\("marketGone"\):/);
  assert.match(persist, /item\["status"\] = "CLOSED"/);
  // Both live portfolios must run it; one of them not doing so is the reported bug.
  for (const file of ["polymarket-live-limit-order-test", "trading-live-5050"]) {
    const workflow = await readFile(new URL(`../../.github/workflows/${file}.yml`, import.meta.url), "utf8");
    assert.match(workflow, /run: python3 trading\/tools\/persist-live-revalidation\.py/, `${file} must persist its verdicts`);
  }

  const api = await readFile(new URL("../api.php", import.meta.url), "utf8");
  assert.match(api, /in_array\(\$status, \['RESOLVED', 'CLOSED', 'EXPIRED', 'FINALIZED', 'SETTLED'\], true\)/);
});

// Asked for: restrict which tags the 5050 logic may be applied to, defaulting to sports
// and esports. The shortlist and the run have to agree on it, or the tab would list
// candidates the executor then refuses -- which is the failure mode this desk keeps
// running into whenever the two sides filter differently.
test("5050 tags: the setting defaults to sports and esports and reaches the executor", async () => {
  const { readFile } = await import("node:fs/promises");
  const [api, workflow, executor, html] = await Promise.all([
    readFile(new URL("../api.php", import.meta.url), "utf8"),
    readFile(new URL("../../.github/workflows/trading-live-5050.yml", import.meta.url), "utf8"),
    readFile(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8"),
    readFile(new URL("../index.html", import.meta.url), "utf8"),
  ]);

  assert.match(api, /'allowedMarketTags' => \['sports', 'esports'\],/, "the requested default");
  // Absent keeps the default; an explicitly empty list must clear the restriction, or it
  // could only ever be narrowed once set.
  assert.match(api, /array_key_exists\('allowedMarketTags', \$fixedInput\)/);
  assert.match(api, /\? normalize_market_tag_list\(\$fixedInput\['allowedMarketTags'\]\)/);

  // The saved value has to survive the trip: an empty list is a real setting and must be
  // written to the environment rather than skipped as "unset".
  assert.match(workflow, /"LIVE_FIXED_ENTRY_ALLOWED_TAGS": ",".join\(/);
  assert.match(workflow, /always_write = \{"LIVE_FIXED_ENTRY_ALLOWED_TAGS"\}/);
  assert.match(workflow, /if value is None or \(value == "" and key not in always_write\):/);
  assert.match(workflow, /LIVE_FIXED_ENTRY_ALLOWED_TAGS: "sports,esports"/, "and a fallback if the config cannot be read");

  // The executor rejects an off-tag market before anything that costs a request. The set
  // is built by the shared envTagSet now that the per-portfolio exclusion list needs the
  // same slugging; this used to be an inline `new Set(...)`.
  assert.match(executor, /const FIXED_ENTRY_ALLOWED_TAGS = envTagSet\("LIVE_FIXED_ENTRY_ALLOWED_TAGS"\);/);
  assert.match(executor, /if \(!marketTagIsAllowed\(row\)\) \{\n\s+note\(`outside this portfolio's tags/);
  // And it is editable, with the tag row shown only on the 5050 tab.
  assert.match(html, /<input type="text" placeholder="sports, esports" data-fixed-entry-tags>/);
  assert.match(html, /data-fixed-entry-row title="Comma separated Polymarket tags/);
});

test("5050 tags: the shortlist and the run agree on which markets qualify", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");
  const executor = await readFile(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8");
  const pick = (src, name) => {
    const start = src.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`missing ${name}`);
    const bodyStart = src.indexOf(") {\n", start);
    let depth = 0;
    for (let i = bodyStart + 2; i < src.length; i += 1) {
      if (src[i] === "{") depth += 1;
      else if (src[i] === "}") {
        depth -= 1;
        if (!depth) return src.slice(start, i + 1);
      }
    }
    throw new Error(`unbalanced ${name}`);
  };

  const dashboard = new Function(`
    ${pick(app, "normalizedScrapedScanTag")}
    ${pick(app, "normalizeMarketTagList")}
    ${pick(app, "marketTagSlugsOf")}
    ${pick(app, "marketCarriesAnyTag")}
    ${pick(app, "marketMatchesAllowedTags")}
    return { normalizeMarketTagList, marketMatchesAllowedTags };
  `)();
  const executorFor = (envValue) => new Function("process", `
      ${pick(executor, "envTagSet")}
      const FIXED_ENTRY_ALLOWED_TAGS = envTagSet("LIVE_FIXED_ENTRY_ALLOWED_TAGS");
      ${pick(executor, "marketTagSlugs")}
      ${pick(executor, "marketTagIsAllowed")}
      return { marketTagIsAllowed, tags: [...FIXED_ENTRY_ALLOWED_TAGS] };
    `)({ env: { LIVE_FIXED_ENTRY_ALLOWED_TAGS: envValue } });

  const allowed = dashboard.normalizeMarketTagList(["Sports", "esports", "esports", " "]);
  assert.deepEqual(allowed, ["sports", "esports"], "typed input is slugged and de-duplicated");
  const run = executorFor(allowed.join(","));
  assert.deepEqual(run.tags, ["sports", "esports"], "and the executor reads the same set");

  // Gamma hands tags back as plain strings and as {label,slug} objects, and a market
  // carries them under different fields depending on which pass recorded it.
  const cases = [
    [{ polymarketTags: ["esports", "counter-strike"] }, true],
    [{ tags: [{ slug: "sports" }, { label: "EPL" }] }, true],
    [{ firstTags: ["sports"] }, true],
    [{ riskCategory: "Sports" }, true],
    [{ polymarketTags: ["politics", "elections"] }, false],
    [{}, false],
  ];
  for (const [row, expected] of cases) {
    assert.equal(dashboard.marketMatchesAllowedTags(row, allowed), expected, `shortlist: ${JSON.stringify(row)}`);
    assert.equal(run.marketTagIsAllowed(row), expected, `run: ${JSON.stringify(row)}`);
  }

  // Cleared means every tag, on both sides -- including a market carrying no tags.
  const unrestricted = executorFor("");
  for (const [row] of cases) {
    assert.equal(dashboard.marketMatchesAllowedTags(row, []), true);
    assert.equal(unrestricted.marketTagIsAllowed(row), true);
  }
});

// Reported: a position bought at 50.0% with a 1.00:1 reward/risk -- 5050's signature --
// was showing under Live, which never buys at 50c because its probability bar is 80%.
// The earlier fix attributed a fill by comparing its buy price with 5050's CONFIGURED
// entry price, and that setting had since moved from 0.50 to 0.51. So every position
// 5050 had filled at the old price stopped matching and was handed to Live.
test("5050 fills: a changed entry price does not hand old fills to Live", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");
  const pick = (name) => {
    const start = app.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`missing ${name}`);
    const bodyStart = app.indexOf(") {\n", start);
    let depth = 0;
    for (let i = bodyStart + 2; i < app.length; i += 1) {
      if (app[i] === "{") depth += 1;
      else if (app[i] === "}") {
        depth -= 1;
        if (!depth) return app.slice(start, i + 1);
      }
    }
    throw new Error(`unbalanced ${name}`);
  };
  const body = ["submittedTokenIds", "fixedEntryTokenIds", "fixedEntryPriceSignatures",
    "matchesFixedEntryPrice", "restsAtFixedEntryPrice", "fixedEntryOrderPricesByToken",
    "isFilledPortfolioRow", "boughtAtFixedEntryPrice", "belongsToActiveLivePortfolio",
    "isClosedTrade"].map(pick).join("\n\n");
  const tolerance = /const FIXED_ENTRY_PRICE_TOLERANCE = [\d.]+;/.exec(app)[0];
  const belongs = (mode, execution5050, configuredPrice) => new Function(
    "state", "isFixedEntryMode", "normalizeFixedEntryPrice", "portfolioConfigForMode",
    `${tolerance}\n${body}\nreturn belongsToActiveLivePortfolio;`,
  )(
    { mode, live5050ExecutionState: execution5050 },
    () => mode === "live-5050",
    (value) => Number(value),
    () => ({ fixedEntryPrice: configuredPrice }),
  );

  const token = "88888888888888888888888888888888";
  // The reported row: rested and filled at 0.50, back when that was the setting.
  const position = {
    tokenId: token,
    question: "LoL: Movistar KOI vs GIANTX - Game 2 Winner",
    outcome: "Movistar KOI",
    status: "OPEN",
    shares: 7.18,
    entryPrice: 0.5,
    totalCostUsdc: 3.59,
  };
  const log = {
    runLog: [
      { attempts: [{ tokenId: token, orderPrice: 0.5, orderSize: 7.18, action: "SUBMITTED" }] },
      { attempts: [{ tokenId: "77777", orderPrice: 0.51, action: "SUBMITTED" }] },
    ],
  };

  // The setting has moved on; the run log has not. Attribution follows the log.
  for (const configured of [0.51, 0.5, 0.62]) {
    assert.equal(belongs("live", log, configured)(position), false,
      `configured ${configured}: a 5050 fill must not appear under Live`);
    assert.equal(belongs("live-5050", log, configured)(position), true,
      `configured ${configured}: it belongs to 5050`);
  }

  // What the earlier fix was for must still hold: a Live fill at the market price on a
  // token 5050 merely has an unfilled bid resting on stays with Live.
  const liveFill = { tokenId: "77777", status: "OPEN", shares: 4, entryPrice: 0.94, totalCostUsdc: 3.76 };
  assert.equal(belongs("live", log, 0.51)(liveFill), true);
  assert.equal(belongs("live-5050", log, 0.51)(liveFill), false);

  // Reversed by a later, better-evidenced report (see the test below): a fill with no
  // per-token order on record at all -- aged out of the log, or simply never 5050's --
  // now stays with Live, the documented safe default, rather than matching on price alone.
  const aged = { tokenId: "999", status: "OPEN", shares: 5, entryPrice: 0.51 };
  assert.equal(belongs("live-5050", { runLog: [] }, 0.51)(aged), false);
  assert.equal(belongs("live", { runLog: [] }, 0.51)(aged), true);

  // A rejected attempt claims no token. A market 5050 asked for and was refused, which
  // Live then bought at the market, stays with Live -- that is the guard that stops a
  // merely-attempted bid taking Live's history.
  const refused = { runLog: [{ attempts: [{ tokenId: "555", orderPrice: 0.5, action: "REJECTED" }] }] };
  const liveFillOnRefusedToken = { tokenId: "555", status: "OPEN", shares: 4, entryPrice: 0.94 };
  assert.equal(belongs("live-5050", refused, 0.62)(liveFillOnRefusedToken), false);
  assert.equal(belongs("live", refused, 0.62)(liveFillOnRefusedToken), true);

  // Also reversed: a DIFFERENT token (666) filled at a price 5050 once had refused
  // elsewhere (555, at 0.50) is not 5050's just because the number matches. Nothing here
  // says 666 has anything to do with 5050 at all.
  const fillAtARefusedPrice = { tokenId: "666", status: "OPEN", shares: 5, entryPrice: 0.5 };
  assert.equal(belongs("live-5050", refused, 0.62)(fillAtARefusedPrice), false);
  assert.equal(belongs("live", refused, 0.62)(fillAtARefusedPrice), true);
});

// Reported live: a position opened and shown under Live closed under 90 -> 50% instead.
// The production account had two such trades, both bought at ordinary market prices
// (0.64, 0.65) that happen to sit within FIXED_ENTRY_PRICE_TOLERANCE of 5050's configured
// price, with no order for either token anywhere in 5050's run log -- proof that "Live's
// probability bar means it never prices near 5050's setting" was not actually true.
test("live fills: a price that merely matches 5050's setting does not hand the trade to 5050", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");
  const pick = (name) => {
    const start = app.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`missing ${name}`);
    const bodyStart = app.indexOf(") {\n", start);
    let depth = 0;
    for (let i = bodyStart + 2; i < app.length; i += 1) {
      if (app[i] === "{") depth += 1;
      else if (app[i] === "}") {
        depth -= 1;
        if (!depth) return app.slice(start, i + 1);
      }
    }
    throw new Error(`unbalanced ${name}`);
  };
  const body = ["submittedTokenIds", "fixedEntryTokenIds", "fixedEntryPriceSignatures",
    "matchesFixedEntryPrice", "restsAtFixedEntryPrice", "fixedEntryOrderPricesByToken",
    "isFilledPortfolioRow", "boughtAtFixedEntryPrice", "belongsToActiveLivePortfolio",
    "isClosedTrade"].map(pick).join("\n\n");
  const tolerance = /const FIXED_ENTRY_PRICE_TOLERANCE = [\d.]+;/.exec(app)[0];
  const belongs = (mode, execution5050, configuredPrice) => new Function(
    "state", "isFixedEntryMode", "normalizeFixedEntryPrice", "portfolioConfigForMode",
    `${tolerance}\n${body}\nreturn belongsToActiveLivePortfolio;`,
  )(
    { mode, live5050ExecutionState: execution5050 },
    () => mode === "live-5050",
    (value) => Number(value),
    () => ({ fixedEntryPrice: configuredPrice }),
  );

  // The exact shape of the two production rows: closed, no logged 5050 order for either
  // token, priced within tolerance of 5050's configured 0.65 (once also 0.50).
  const execution = { runLog: [], fixedEntryPriceHistory: [0.65, 0.5] };
  const jdGaming = {
    tokenId: "6246925247605876855027437546764427752148257339899783681629942804531689023181",
    status: "LOST", entryPrice: 0.64, question: "Game Handicap: JDG (-1.5) vs LGD Gaming (+1.5)",
  };
  const teamYandex = {
    tokenId: "68743192567142339680992828280592921309106672174739147121902853530055585225049",
    status: "LOST", entryPrice: 0.65, question: "Dota 2: LGD Gaming vs Team Yandex - Game 1 Winner",
  };
  for (const row of [jdGaming, teamYandex]) {
    assert.equal(belongs("live", execution, 0.65)(row), true, `${row.question}: must stay with Live`);
    assert.equal(belongs("live-5050", execution, 0.65)(row), false, `${row.question}: must not go to 5050`);
  }
});

// Reported: the 5050 run log held a single entry, which is not what happened -- the
// portfolio had run dozens of times. The Live portfolio's log emptied the same way once
// and gained two guards for it; 5050 was created with neither.
test("5050 run log: history cannot be replaced by a single row", async () => {
  const { readFile } = await import("node:fs/promises");
  const [fixed, live] = await Promise.all([
    readFile(new URL("../../.github/workflows/trading-live-5050.yml", import.meta.url), "utf8"),
    readFile(new URL("../../.github/workflows/polymarket-live-limit-order-test.yml", import.meta.url), "utf8"),
  ]);

  // Guard one: the restore must not be allowed to fail quietly. The tool already treats
  // a genuine first-run 404 as an empty log and exits 0, so `|| echo` only ever masked
  // the failures it raises on purpose -- and the run then carried on with nothing.
  assert.match(fixed, /run: node tools\/restore-live-execution-history\.mjs\n/);
  assert.ok(!/restore-live-execution-history\.mjs \|\| echo/.test(fixed),
    "a failed restore must fail the run, not start a fresh log over real history");

  // Guard two: merge the published log into the local one immediately before the upload,
  // because the upload replaces the hosted file outright.
  assert.match(fixed, /- name: Merge published run-log history before upload/);
  assert.match(fixed, /LIVE_EXECUTION_PUBLISHED_STATE_URL: https:\/\/osobnizkusenosti\.cz\/trading\/api\.php\?action=state&target=live-5050-execution/);
  assert.match(fixed, /LIVE_EXECUTION_STATE_PATH: data\/live-5050-execution-state\.json/);
  assert.match(fixed, /run: node tools\/merge-live-execution-history\.mjs/);

  // It has to sit between the executor and the upload, or it guards nothing.
  const order = ["Rest the fixed-entry bids", "Merge published run-log history before upload", "Upload 5050 state"]
    .map((name) => fixed.indexOf(`- name: ${name}`));
  assert.ok(order.every((index) => index > 0), "every step must be present");
  assert.deepEqual([...order].sort((a, b) => a - b), order, `steps are out of order: ${order}`);

  // Both live portfolios now carry the same protection; neither should lose it.
  for (const [label, workflow] of [["live", live], ["5050", fixed]]) {
    assert.match(workflow, /node tools\/merge-live-execution-history\.mjs/, `${label} needs the merge guard`);
    assert.match(workflow, /node tools\/restore-live-execution-history\.mjs/, `${label} needs the restore`);
  }
});

test("5050 run log: the merge publishes a superset, never less", async () => {
  // The tool guards its own entry point, so importing it runs nothing.
  const { mergeRunLogs } = await import("../tools/merge-live-execution-history.mjs");

  // What a run that started from an empty restore writes locally: this decision alone.
  const local = [{ id: "live-trade-batch-2026-08-08T19:39:57.055Z", runAt: "2026-08-08T19:39:57.055Z", strategyId: "live-5050", action: "SUBMITTED", reason: "this run" }];
  const published = Array.from({ length: 13 }, (_, index) => {
    const hour = String(index + 6).padStart(2, "0");
    return { id: `live-trade-batch-2026-08-08T${hour}:00:00.000Z`, runAt: `2026-08-08T${hour}:00:00.000Z`, strategyId: "live-5050", action: "SUBMITTED", reason: `run ${hour}` };
  });

  const merged = mergeRunLogs(local, published);
  assert.equal(merged.length, 14, "one local row plus the thirteen already published");
  assert.equal(merged[0].reason, "this run", "newest first");
  assert.equal(merged[merged.length - 1].reason, "run 06", "and the whole history behind it");
  // The published log can only grow: the merge drops no row that was already there.
  for (const row of published) {
    assert.ok(merged.some((item) => item.id === row.id), `${row.id} must survive the merge`);
  }
  // A local row wins its key, so this run's fresh decision is not shadowed by a stale copy.
  const collided = mergeRunLogs(local, [{ ...local[0], reason: "stale published copy" }, ...published]);
  assert.equal(collided.length, 14);
  assert.equal(collided[0].reason, "this run");

  // And if the published state cannot be read at all the tool refuses outright, rather
  // than letting the upload replace rows it could not see.
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../tools/merge-live-execution-history.mjs", import.meta.url), "utf8");
  assert.match(source, /Live execution history merge failed/);
  assert.match(source, /process\.exit\(1\);/);
});

// Asked for: scrape sports and esports automatically, as often as the schedule allows.
// Five minutes is the floor -- GitHub does not run a scheduled workflow more often --
// and measured over seven hours of this repo's own scheduled runs it does not reliably
// manage even the ten minutes it was asked for: median gap 10 min, mean 14, worst 47.
// So two entries offset by five, each naming one tag, and no assumption that every tick
// arrives.
test("scheduled scan: sports and esports alternate on the tightest cadence available", async () => {
  const { readFile } = await import("node:fs/promises");
  const scan = await readFile(new URL("../../.github/workflows/trading-market-scan.yml", import.meta.url), "utf8");

  const crons = [...scan.matchAll(/^ {4}- cron: '([^']+)'$/gm)].map((match) => match[1]);
  assert.equal(crons.length, 2, `expected two schedule entries, got ${JSON.stringify(crons)}`);
  const minutesOf = (cron) => cron.split(" ")[0].split(",").map(Number);
  const [first, second] = crons.map(minutesOf);
  assert.equal(first.length, 6, "one entry every ten minutes");
  assert.equal(second.length, 6);
  // Together they fire every five minutes, and never at the same minute.
  const all = [...first, ...second].sort((a, b) => a - b);
  assert.deepEqual(all, [2, 7, 12, 17, 22, 27, 32, 37, 42, 47, 52, 57]);
  assert.equal(new Set(all).size, all.length, "the two entries must not collide");
  for (let i = 1; i < all.length; i += 1) {
    assert.equal(all[i] - all[i - 1], 5, "five minutes apart is the floor GitHub allows");
  }

  // The tag is chosen from which entry fired, so the expression has to name the very
  // string one of the cron entries carries -- edit one without the other and every
  // scheduled run would silently scan the same tag.
  const chooser = /PAPER_MARKET_SCAN_TAG: \$\{\{ inputs\.market_scan_tag \|\| \(github\.event\.schedule == '([^']+)' && 'esports' \|\| \(github\.event\.schedule && 'sports' \|\| ''\)\) \}\}/.exec(scan);
  assert.ok(chooser, "the scheduled tag chooser must be present");
  assert.ok(crons.includes(chooser[1]), `the chooser names ${chooser[1]}, which is not one of ${JSON.stringify(crons)}`);
});

test("scheduled scan: a scheduled pass stays small and does not fan out", async () => {
  const { readFile } = await import("node:fs/promises");
  const [scan, bot] = await Promise.all([
    readFile(new URL("../../.github/workflows/trading-market-scan.yml", import.meta.url), "utf8"),
    readFile(new URL("../../.github/workflows/trading-paper-bot.yml", import.meta.url), "utf8"),
  ]);

  // The filters the opportunities page was already scanning with, applied only to
  // scheduled runs so a dispatch still scans exactly what the page asked for.
  assert.match(scan, /PAPER_MARKET_SCAN_LIQUIDITY_MIN: \$\{\{ inputs\.market_scan_liquidity_min \|\| \(github\.event\.schedule && '40000' \|\| '0'\) \}\}/);
  assert.match(scan, /PAPER_MARKET_SCAN_MAX_DAYS: \$\{\{ inputs\.market_scan_max_days \|\| \(github\.event\.schedule && '2' \|\| '-1'\) \}\}/);

  // Only a dispatch is manual; the scraping log flags them and a scheduled pass must not
  // claim to be one.
  assert.match(scan, /PAPER_MARKET_SCAN_TRIGGER: \$\{\{ github\.event_name == 'workflow_dispatch' && 'MANUAL' \|\| 'AUTO' \}\}/);

  // This restricted the post-scrape dispatch to manual scans, on the worry that firing
  // it every five minutes would back up the one self-hosted runner the live executors
  // share. The effect was that "execute after each scraping" almost never happened, and
  // the worry was wrong: each live workflow serializes on its own concurrency group, so
  // a dispatch arriving while one runs and one waits replaces the waiting one. The rate
  // is bounded by run length, about a minute, not by how often the scan asks.
  assert.match(scan, /- name: Dispatch post-scrape execution\n\s+if: success\(\)\n/);
  assert.doesNotMatch(scan, /- name: Dispatch post-scrape execution\n\s+if: [^\n]*event_name/);

  // And the paper bot must stop taking its rotation slot for these two tags, or they are
  // scanned twice and the other 22 scopes only advance on the ticks left over.
  assert.match(bot, /PAPER_MARKET_SCAN_HOURLY_INTERVAL_MINUTES: "0"/);
  assert.equal(bot.match(/PAPER_MARKET_SCAN_HOURLY_INTERVAL_MINUTES/g).length, 1);

  // Zero is what disables it; the executor must still read it that way.
  const source = await readFile(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");
  assert.match(source, /if \(MARKET_SCAN_HOURLY_INTERVAL_MINUTES <= 0\) return null;/);

  // Both scanners still write one paper-state.json, so they must stay serialized.
  assert.match(scan, /group: trading-paper-bot/);
  assert.match(bot, /group: trading-paper-bot/);
});

// Reported: a resting limit order at 52% -- the price 5050 was set to -- was listed under
// Live. Attribution compared the order against a single value, the entry price the
// portfolio is configured at right now, and that setting moves: 0.50, then 0.51, then
// 0.52. Every bid rested at the previous one stopped matching the moment it changed. The
// token could not stand in for it either, because the run log had just been truncated to
// a single row, so there was nothing left to match a token against.
test("5050 orders: a bid is recognised at every price the portfolio bids at", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");
  const pick = (name) => {
    const start = app.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`missing ${name}`);
    const bodyStart = app.indexOf(") {\n", start);
    let depth = 0;
    for (let i = bodyStart + 2; i < app.length; i += 1) {
      if (app[i] === "{") depth += 1;
      else if (app[i] === "}") {
        depth -= 1;
        if (!depth) return app.slice(start, i + 1);
      }
    }
    throw new Error(`unbalanced ${name}`);
  };
  const body = ["submittedTokenIds", "fixedEntryTokenIds", "fixedEntryPriceSignatures",
    "matchesFixedEntryPrice", "restsAtFixedEntryPrice", "fixedEntryOrderPricesByToken",
    "isFilledPortfolioRow", "boughtAtFixedEntryPrice", "belongsToActiveLivePortfolio",
    "isClosedTrade", "liveOpenOrders"].map(pick).join("\n\n");
  const tolerance = /const FIXED_ENTRY_PRICE_TOLERANCE = [\d.]+;/.exec(app)[0];
  const openOrdersFor = (mode, execution5050, configuredPrice) => new Function(
    "state", "isFixedEntryMode", "normalizeFixedEntryPrice", "portfolioConfigForMode",
    `${tolerance}\n${body}\nreturn liveOpenOrders;`,
  )(
    { mode, live5050ExecutionState: execution5050 },
    () => mode === "live-5050",
    (value) => Number(value),
    () => ({ fixedEntryPrice: configuredPrice }),
  );

  // The reported row, plus one the Live portfolio really did place at the market.
  const fixedBid = {
    id: "o-1", tokenId: "444", side: "BUY", status: "ORDER_STATUS_LIVE", price: 0.52,
    originalSize: 6.88, remainingSize: 6.88, notionalUsdc: 3.58,
    question: "Valorant: Eternal Fire vs Joblife - Map 2 Winner", outcome: "Eternal Fire",
  };
  const liveBid = { id: "o-2", tokenId: "555", side: "BUY", status: "ORDER_STATUS_LIVE", price: 0.93, originalSize: 4, remainingSize: 4 };
  const liveState = { openOrders: [fixedBid, liveBid] };
  const ids = (mode, execution, configured) => openOrdersFor(mode, execution, configured)(liveState).map((row) => row.id);

  // A run log holding some other token, but recording the price this portfolio bids at.
  const log = { runLog: [{ attempts: [{ tokenId: "999", orderPrice: 0.52, action: "SUBMITTED" }] }] };
  // A log truncated to nothing, where the published state still says what the last run did.
  const wipedButRecent = { fixedEntry: { entryPrice: 0.52 }, attempts: [{ tokenId: "999", orderPrice: 0.52, action: "SUBMITTED" }], runLog: [] };

  for (const [label, execution, configured] of [
    ["configured price current", log, 0.52],
    ["configured price stale", log, 0.5],
    ["log wiped, last run known", wipedButRecent, 0.5],
    ["log wiped, configured current", { runLog: [] }, 0.52],
  ]) {
    assert.deepEqual(ids("live", execution, configured), ["o-2"], `${label}: Live keeps only its own bid`);
    assert.deepEqual(ids("live-5050", execution, configured), ["o-1"], `${label}: the fixed-entry bid is 5050's`);
  }

  // A rejected attempt still says what price this portfolio bids at, even though it
  // claims no token -- that distinction is what lets a refused bid help here without
  // letting it steal a market Live actually traded.
  const refusedOnly = { runLog: [{ attempts: [{ tokenId: "999", orderPrice: 0.52, action: "REJECTED" }] }] };
  assert.deepEqual(ids("live-5050", refusedOnly, 0.5), ["o-1"]);
  assert.deepEqual(ids("live", refusedOnly, 0.5), ["o-2"]);

  // A dry run placed nothing, so its price is not evidence of anything.
  const dryOnly = { runLog: [{ attempts: [{ tokenId: "999", orderPrice: 0.52, action: "DRY_RUN_READY" }] }] };
  assert.deepEqual(ids("live", dryOnly, 0.5).sort(), ["o-1", "o-2"]);
});

// Asked for: the ability to exclude whole event tags from a portfolio's candidates, as a
// portfolio parameter in the same shape as 5050's tag filter -- but on every portfolio,
// and the opposite way round: a block-list rather than an allow-list.

// Extracts a named function's source so the real implementation can be driven directly.
function functionSource(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`missing ${name}`);
  // Counted from the end of the parameter list, or a `= {}` default parameter would
  // close the brace count before the body has opened. The parameter list is found by
  // matching its own parentheses rather than by searching for a literal ") {": a PHP
  // signature may carry a return type with the brace on the next line (`): array\n{`),
  // and not finding the body there silently started the brace count near the top of the
  // file, returning a truncated function that then matched no assertion at all.
  let parens = 0;
  let bodyStart = -1;
  for (let i = src.indexOf("(", start); i < src.length; i += 1) {
    if (src[i] === "(") parens += 1;
    else if (src[i] === ")") {
      parens -= 1;
      if (parens === 0) {
        bodyStart = src.indexOf("{", i);
        break;
      }
    }
  }
  if (bodyStart < 0) throw new Error(`no body found for ${name}`);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (!depth) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced ${name}`);
}

test("excluded tags: every portfolio carries the setting, and it starts empty", async () => {
  const { readFile } = await import("node:fs/promises");
  const [api, html] = await Promise.all([
    readFile(new URL("../api.php", import.meta.url), "utf8"),
    readFile(new URL("../index.html", import.meta.url), "utf8"),
  ]);

  // In the shared strategy normalizer, so all five portfolios have it rather than 5050
  // alone. A key this function does not return is dropped on every save, so being here
  // is what makes it persist at all.
  const normalizer = functionSource(api.replace(/mixed \$/g, "$"), "normalize_strategy_config");
  assert.match(normalizer, /'excludedMarketTags' => normalize_market_tag_list\(\$input\['excludedMarketTags'\] \?\? \$defaults\['excludedMarketTags'\] \?\? \[\]\)/);

  // Every portfolio default carries it, excluding nothing -- so adding the setting
  // changed no portfolio's behaviour until someone fills it in. Counted against the
  // defaults themselves rather than against a number: this said 5 and a fourth paper
  // portfolio was added, which is a portfolio silently missing the setting if the count
  // is wrong, and a test to edit if it is merely stale.
  const portfolioDefaults = (api.match(/^\s+'minProbability' => /gm) || []).length;
  const excluded = (api.match(/^\s+'excludedMarketTags' => \[\],$/gm) || []).length;
  assert.ok(portfolioDefaults >= 6, `expected every portfolio default to be found, saw ${portfolioDefaults}`);
  assert.equal(excluded, 6, `every portfolio default must exclude nothing to start with, saw ${excluded}`);

  // Unlike the allow-list, empty and absent mean the same thing here, so the setting
  // needs no array_key_exists special case to be clearable.
  assert.doesNotMatch(api, /array_key_exists\('excludedMarketTags'/);

  // Editable on every tab: the row carries no data-fixed-entry-row, which is what hides
  // the 5050-only controls everywhere else.
  const row = html.slice(html.indexOf('data-excluded-tags-label') - 400, html.indexOf('data-excluded-tags-label') + 60);
  assert.match(row, /<input type="text" placeholder="politics, elections" data-excluded-tags>/);
  assert.doesNotMatch(row, /data-fixed-entry-row/);
});

test("excluded tags: dashboard, live executor and paper bot agree on what a tag is", async () => {
  const { readFile } = await import("node:fs/promises");
  const [app, executor, bot] = await Promise.all([
    readFile(new URL("../assets/app.js", import.meta.url), "utf8"),
    readFile(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8"),
    readFile(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8"),
  ]);

  // Three separate slug implementations decide this, so they are driven against the same
  // markets: a shortlist that disagrees with the run is the whole class of bug here.
  const dashboard = new Function(`
    ${functionSource(app, "normalizedScrapedScanTag")}
    ${functionSource(app, "normalizeMarketTagList")}
    ${functionSource(app, "marketTagSlugsOf")}
    ${functionSource(app, "marketExcludedByTags")}
    return (item, tags) => marketExcludedByTags(item, normalizeMarketTagList(tags));
  `)();
  const live = (tags) => new Function("process", `
    ${functionSource(executor, "envTagSet")}
    const EXCLUDED_MARKET_TAGS = envTagSet("LIVE_EXCLUDED_MARKET_TAGS");
    ${functionSource(executor, "marketTagSlugs")}
    ${functionSource(executor, "excludedMarketTagsOn")}
    return excludedMarketTagsOn;
  `)({ env: { LIVE_EXCLUDED_MARKET_TAGS: tags } });
  const paper = (tags) => {
    const strategy = new Function("process", `
      ${functionSource(bot, "envTagSet")}
      return { excludedMarketTags: envTagSet("PAPER_X_EXCLUDED_MARKET_TAGS") };
    `)({ env: { PAPER_X_EXCLUDED_MARKET_TAGS: tags } });
    const check = new Function(`
      ${functionSource(bot, "rowTagSlugs")}
      ${functionSource(bot, "excludedTagsOnRow")}
      return excludedTagsOnRow;
    `)();
    return (item) => check(item, strategy);
  };

  // Typed the way a person types it, matched against the slugs a market actually carries.
  const typed = "Politics, elections";
  const cases = [
    [{ polymarketTags: ["politics", "us-news"] }, ["politics"]],
    [{ tags: [{ slug: "elections", label: "Elections" }] }, ["elections"]],
    [{ firstTags: ["Politics"] }, ["politics"]],
    [{ riskCategory: "politics" }, ["politics"]],
    [{ polymarketTags: ["politics"], tags: ["elections"] }, ["politics", "elections"]],
    [{ polymarketTags: ["esports", "counter-strike"] }, []],
    [{}, []],
  ];
  for (const [row, expected] of cases) {
    const label = JSON.stringify(row);
    assert.deepEqual(dashboard(row, typed).sort(), [...expected].sort(), `dashboard: ${label}`);
    assert.deepEqual(live(typed)(row).sort(), [...expected].sort(), `live executor: ${label}`);
    assert.deepEqual(paper(typed)(row).sort(), [...expected].sort(), `paper bot: ${label}`);
  }

  // Nothing excluded is the default, and it must never reject anything.
  for (const empty of ["", "   ", ",,"]) {
    assert.deepEqual(dashboard({ polymarketTags: ["politics"] }, empty), [], "dashboard excludes nothing");
    assert.deepEqual(live(empty)({ polymarketTags: ["politics"] }), [], "live excludes nothing");
    assert.deepEqual(paper(empty)({ polymarketTags: ["politics"] }), [], "paper excludes nothing");
  }
});

test("excluded tags: the rule sits above every mode-specific test", async () => {
  const { readFile } = await import("node:fs/promises");
  const [app, executor, bot] = await Promise.all([
    readFile(new URL("../assets/app.js", import.meta.url), "utf8"),
    readFile(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8"),
    readFile(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8"),
  ]);

  // The 5050 branch returns early, so a rule placed after it would silently not apply to
  // the portfolio most likely to want one. The exclusion goes above the whole ladder.
  const reasons = functionSource(app, "portfolioCandidateFilterReasons");
  const exclusion = reasons.indexOf("const hitExclusions = marketExcludedByTags(item, excludedTags);");
  const fixedEntryBranch = reasons.indexOf("if (isFixedEntryMode(mode)) {");
  assert.ok(exclusion > 0 && fixedEntryBranch > exclusion,
    "the exclusion must be checked before the 5050 branch returns");

  // In the live executor it goes in the shared prefilter, which feeds both live
  // strategies -- not into either strategy, where the other would not inherit it.
  const prefilter = functionSource(executor, "prefilterLiveCandidate");
  assert.match(prefilter, /const excludedTags = excludedMarketTagsOn\(item\);/);
  assert.match(prefilter, /reasons\.push\(`excluded tag\$\{excludedTags\.length > 1 \? "s" : ""\} \$\{excludedTags\.join\(", "\)\}`\)/);
  assert.match(executor, /const candidatePool = prepareLiveCandidatePool\(rawCandidateRows, liveState\);/,
    "and that prefilter is what builds the pool both strategies read");

  // The paper bot filters and explains in two separate places; a row dropped by one and
  // not the other is a candidate list that disagrees with its own rejection reasons.
  // The test on the filtering side moved behind strategyAllowsTags when an include-only
  // whitelist was added, so the rule is asserted where it now lives.
  assert.match(functionSource(bot, "strategyEligibleCandidates"),
    /if \(!strategyAllowsTags\(item, strategy\)\) return false;/);
  assert.match(functionSource(bot, "portfolioFilterResult"),
    /const excludedTags = excludedTagsOnRow\(item, strategy\);/);

  // And the precedence that rule introduced: a populated whitelist is the whole policy,
  // but an empty one must fall through to the exclusions rather than admitting
  // everything -- an empty list is how the whitelist is cleared, and clearing it must
  // not quietly switch the exclusions off too.
  const allows = functionSource(bot, "strategyAllowsTags");
  assert.match(allows, /if \(strategy\?\.includeOnlyMarketTags\?\.size\) return includedTagsOnRow\(item, strategy\)\.length > 0;/);
  assert.match(allows, /return excludedTagsOnRow\(item, strategy\)\.length === 0;/);
});

test("excluded tags: the saved value reaches all three runtimes", async () => {
  const { readFile } = await import("node:fs/promises");
  const [paperWorkflow, liveWorkflow, fixedWorkflow, bot] = await Promise.all([
    readFile(new URL("../../.github/workflows/trading-paper-bot.yml", import.meta.url), "utf8"),
    readFile(new URL("../../.github/workflows/polymarket-live-limit-order-test.yml", import.meta.url), "utf8"),
    readFile(new URL("../../.github/workflows/trading-live-5050.yml", import.meta.url), "utf8"),
    readFile(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(paperWorkflow, /emit\(f"\{prefix\}_EXCLUDED_MARKET_TAGS", ",".join\(excluded_tags\)\)/);
  assert.match(paperWorkflow, /emit\(f"\{prefix\}_INCLUDE_ONLY_MARKET_TAGS", ",".join\(include_only_tags\)\)/);
  assert.match(liveWorkflow, /"LIVE_EXCLUDED_MARKET_TAGS": ",".join\(/);
  assert.match(liveWorkflow, /"LIVE_INCLUDE_ONLY_MARKET_TAGS": ",".join\(/);
  assert.match(fixedWorkflow, /"LIVE_EXCLUDED_MARKET_TAGS": ",".join\(/);
  assert.match(fixedWorkflow, /"LIVE_INCLUDE_ONLY_MARKET_TAGS": ",".join\(/);

  // The paper workflow writes one variable per strategy, so each strategy has to read
  // its own -- a shared name would give all three portfolios one setting.
  for (const prefix of ["CONSERVATIVE", "HIGH_REWARD", "MORE_PROBABLE"]) {
    assert.match(bot, new RegExp(`excludedMarketTags: envTagSet\\("PAPER_${prefix}_EXCLUDED_MARKET_TAGS"\\)`));
    assert.match(bot, new RegExp(`includeOnlyMarketTags: envTagSet\\("PAPER_${prefix}_INCLUDE_ONLY_MARKET_TAGS"\\)`));
  }
});

test("include-only tags: whitelist reaches every shortlist and execution path", async () => {
  const { readFile } = await import("node:fs/promises");
  const [app, bot, executor] = await Promise.all([
    readFile(new URL("../assets/app.js", import.meta.url), "utf8"),
    readFile(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8"),
    readFile(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(app, /outside included tags \(\$\{includeOnlyTags\.join\(", "\)\}\)/);
  assert.match(bot, /function strategyAllowsTags\(item, strategy\)/);
  assert.match(bot, /includeOnlyMarketTags: envTagSet\("PAPER_EQUAL_INCLUDE_ONLY_MARKET_TAGS"\)/);
  assert.match(executor, /const INCLUDE_ONLY_MARKET_TAGS = envTagSet\("LIVE_INCLUDE_ONLY_MARKET_TAGS"\)/);
  assert.match(executor, /function marketMatchesIncludeOnlyTags\(row = \{\}\)/);
});

// Asked for: the Polymarket tag box holds minor tags; it should offer only a few main
// ones, category-style, and politics and geopolitics are missing from it.

test("scan categories: the picker offers categories, not whatever was scraped", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  // The counting moved out of here: the bracket used to report how many of our own rows
  // carried the tag, and now reports how many events Polymarket lists that match what the
  // scan takes. What this test still owns is *which* categories are offered and in what
  // order, so it drives the option builder against a supplied count map instead.
  const build = (counts) => new Function("state", `
    ${/const MARKET_SCAN_CATEGORIES = \[[\s\S]*?\n\];/.exec(app)[0]}
    ${functionSource(app, "scrapedScanTagOptions")}
    return scrapedScanTagOptions;
  `)({ scanCategoryCounts: counts })();

  // Measured off Gamma, these are the per-league slugs the sports and esports scopes
  // produce. They are what used to fill the box, and exactly what must not.
  const options = build(new Map([["sports", 191], ["esports", 32]]));
  const offered = options.map(([tag]) => tag);

  for (const minor of ["uslc", "usl1", "bra3", "brazil-serie-a", "setkamemd", "setka", "chl2", "ecu1", "games"]) {
    assert.ok(!offered.includes(minor), `${minor} is a league, not a category, and must not be offered`);
  }
  // The two the box was missing. It could not have shown them while the list came from
  // scraped rows: only sports and esports are scraped, so a category could never appear
  // until it had already been scanned -- which needed it in the box first.
  assert.ok(offered.includes("politics"), "politics must be offerable");
  assert.ok(offered.includes("geopolitics"), "geopolitics must be offerable");
  assert.ok(offered.length <= 16, `a category picker, not a tag dump: ${offered.length} entries`);

  // Fixed order, so the box does not rearrange itself as counts arrive.
  assert.deepEqual(offered, build(null).map(([tag]) => tag), "the list is the same whatever is counted");
  assert.equal(offered[0], "politics");

  // The count is whatever Polymarket reported for that category, and a category with no
  // answer carries null rather than a zero -- "no number yet" and "none there" are
  // different facts, and only the second is worth putting in a bracket.
  assert.equal(options.find(([tag]) => tag === "sports")[1], 191);
  assert.equal(options.find(([tag]) => tag === "esports")[1], 32);
  assert.equal(options.find(([tag]) => tag === "politics")[1], null, "no answer is not a zero");
  assert.equal(build(new Map([["politics", 0]])).find(([tag]) => tag === "politics")[1], 0);
});

test("scan categories: every offered category is one the scanner can resolve", async () => {
  const { readFile } = await import("node:fs/promises");
  const [app, bot] = await Promise.all([
    readFile(new URL("../assets/app.js", import.meta.url), "utf8"),
    readFile(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8"),
  ]);

  const categories = new Function(`
    ${/const MARKET_SCAN_CATEGORIES = \[[\s\S]*?\n\];/.exec(app)[0]}
    return MARKET_SCAN_CATEGORIES;
  `)();
  const known = new Set(
    [...(/const MARKET_SCAN_CATEGORY_TAGS = \[[\s\S]*?\n\];/.exec(bot)[0]).matchAll(/slug: "([^"]+)"/g)]
      .map((match) => match[1]),
  );

  // Offering a category the scanner has no tag id for would make the box able to ask for
  // a scan that cannot run. Every entry has to be one it already knows.
  for (const tag of categories) {
    assert.ok(known.has(tag), `${tag} is offered but the scanner has no tag id for it`);
  }

  // A stored preference for a tag no longer offered has to fall back rather than sit
  // selected and invisible -- the per-league slugs people picked before are all gone now.
  const render = functionSource(app, "renderScrapedScanControls");
  assert.match(render, /if \(state\.scrapedScanTag && !availableTags\.has\(state\.scrapedScanTag\)\) state\.scrapedScanTag = "";/);
  // And a category whose count did not arrive inside the budget gets no bracket at all,
  // rather than a zero that would read as "nothing there".
  assert.match(render, /const suffix = count == null \? "" :/);
});

test("paper rotation: free capital is spent before a position is given up", async () => {
  // Reported on the Conservative portfolio, and it applied to all three: the log showed
  // free cash available to open a trade, yet the run rotated -- it sold a holding to fund
  // a candidate it could have bought outright, giving up the position for nothing.
  //
  // Two things made it certain rather than occasional. Rotation was evaluated before the
  // capital check that follows it, and its only capital test was whether the stake would
  // fit *after* an exit -- trivially true when it already fits without one.
  const { readFile } = await import("node:fs/promises");
  const bot = await readFile(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");

  const held = { id: "T1", status: "OPEN", tokenId: "1", maxLossUsdc: 5, stakeUsdc: 5 };
  const candidate = { tokenId: "2" };
  const review = (available, stake) => new Function(
    "openTrades", "heldHours", "ROTATION_MIN_HOLD_HOURS", "findFirstOpenCandidate",
    "tradeContinuationEconomics", "candidateRotationScore", "portfolioEconomics",
    "ROTATION_MIN_SCORE_IMPROVEMENT", "ROTATION_MIN_EV_USDC_IMPROVEMENT",
    // The review now summarises each position it weighed, so its two summary helpers
    // come with it.
    `${functionSource(bot, "rotationPositionSummary")}\n${functionSource(bot, "rotationCandidateSummary")}\n`
    + `${functionSource(bot, "rotationReview")}\nreturn rotationReview;`,
  )(
    (trades) => trades, () => 48, 6, () => ({ best: candidate }),
    // A candidate far better than the holding, so nothing but the capital rule can
    // decide this: score 2 vs 1 and EV 0.50 vs 0.10 clear both improvement bars.
    () => ({ score: 1, expectedValue: 0.10 }), () => 2, () => ({ expectedValueUsdc: 0.50 }),
    0.15, 0.02,
  )({ trades: [held] }, [candidate], {}, available, stake);

  // The rule is unchanged; only how a refusal is reported. It used to be a bare null,
  // which threw away the reason and left the run log unable to show that rotation had
  // run at all -- so a refusal now carries its verdict and `best` stays empty.
  assert.equal(review(9, 5).best, null, "with free cash to spare the portfolio buys, it does not rotate");
  assert.equal(review(5, 5).best, null, "and exactly enough is enough -- the same bar the capital check uses");
  assert.match(review(9, 5).reason, /already covers the 5\.00 USDC stake/,
    "and it says so, with the figures it decided on");

  // Rotation still does its job when the candidate genuinely cannot be funded otherwise.
  const short = review(1, 5);
  assert.ok(short.best, "short of the stake, rotation is the only way to take the better candidate");
  assert.equal(short.best.trade.id, "T1");
  assert.equal(short.best.candidate.tokenId, "2");

  // The rule the live executor has always had, now stated on the paper side too, and
  // recorded so a ROTATED_OPENED row can be read without guessing at the cash position.
  assert.match(bot, /if \(available >= stake\) \{\n\s+return declined\(/);
  assert.match(bot, /freeCapitalCoversStake: Number\(available\) >= Number\(stake\),/);
});

test("paper rotation log: it names the position sold and what lost to it", async () => {
  // Reported from a ROTATED_OPENED row: nothing said which open position was being
  // rotated out, nor why that one rather than the others. The run-log detail has a rich
  // rotation renderer, but it was written for the live executor's shape -- action,
  // reason, best.position, best.candidate, reviews -- and the paper side emitted none of
  // those, so the section rendered "Action: -", "Reason: -" and stopped.
  const { readFile } = await import("node:fs/promises");
  const bot = await readFile(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");

  const holding = (id, hours, tokenId) => ({
    id, status: "OPEN", tokenId, maxLossUsdc: 5, stakeUsdc: 5, totalCostUsdc: 5,
    currentValueUsdc: 4.6, unrealizedPnlUsdc: -0.4, question: `Held ${id}`, outcome: "Yes",
    openedAt: new Date(Date.now() - hours * 3600000).toISOString(),
  });
  const candidate = {
    tokenId: "2", question: "Better market", outcome: "No",
    marketProbability: 0.94, netYield: 0.06, daysToResolution: 1,
  };
  const review = new Function(
    "openTrades", "heldHours", "ROTATION_MIN_HOLD_HOURS", "findFirstOpenCandidate",
    "tradeContinuationEconomics", "candidateRotationScore", "portfolioEconomics",
    "ROTATION_MIN_SCORE_IMPROVEMENT", "ROTATION_MIN_EV_USDC_IMPROVEMENT",
    `${functionSource(bot, "rotationPositionSummary")}\n${functionSource(bot, "rotationCandidateSummary")}\n`
    + `${functionSource(bot, "rotationReview")}\nreturn rotationReview;`,
  )(
    (trades) => trades, (trade) => (Date.now() - Date.parse(trade.openedAt)) / 3600000, 6,
    () => ({ best: candidate }), () => ({ score: 1, expectedValue: 0.10 }), () => 2,
    () => ({ expectedValueUsdc: 0.50 }), 0.15, 0.02,
  )(
    { trades: [holding("A", 48, "1"), holding("B", 2, "3")] },
    [candidate], { selectionMetric: "EV p.a." }, 1, 5,
  );

  assert.equal(review.trade.id, "A", "the eligible holding is the one rotated");
  // Every holding that was weighed is on the record, including the ones that were not
  // chosen -- that is the half the log was missing.
  const byQuestion = new Map(review.reviews.map((row) => [row.position.question, row]));
  assert.deepEqual([...byQuestion.keys()].sort(), ["Held A", "Held B"]);
  assert.equal(byQuestion.get("Held A").action, "ROTATE_CANDIDATE");
  assert.match(byQuestion.get("Held A").reason, /clears both bars/);
  // And a holding excluded before the comparison says why it never got there.
  assert.equal(byQuestion.get("Held B").action, "HOLD");
  assert.match(byQuestion.get("Held B").reason, /below the 6h minimum/);

  // The position summary carries what the detail renders about the row being sold.
  const sold = byQuestion.get("Held A").position;
  assert.equal(sold.outcome, "Yes");
  assert.equal(sold.estimatedExitValueUsdc, 4.6);
  assert.equal(sold.realizedPnlIfExitUsdc, -0.4, "what exiting now actually realises");

  // The emitted review uses the field names the run-log detail already reads.
  const emitted = bot.slice(bot.indexOf("    rotationReview: {"));
  for (const field of ["action:", "reason:", "best: {", "position: rotationPositionSummary(trade)",
    "candidate: rotationCandidateSummary(review.candidate", "evDeltaUsdc:", "reviews:"]) {
    assert.ok(emitted.includes(field), `the rotation review must emit ${field}`);
  }
});

test("paper candidates: a retired scorer's zeros are not the reason a candidate was skipped", async () => {
  // Reported from the same log: every row under "Candidates not used" showed +0.0% net
  // yield, +0.0% potential p.a. and "probability 0.0% below high-confidence threshold and
  // edge-opportunity threshold; annualized EV 0.0% is non-profitable after fees" -- for
  // markets priced nowhere near zero.
  //
  // The row's verdict came from the AI-scored economics. With no model consulted there is
  // no AI probability, so that verdict is a row of zeros. Every portfolio scores on the
  // Polymarket probability, so that is the verdict the row now carries.
  const { readFile } = await import("node:fs/promises");
  const bot = await readFile(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");

  assert.match(bot, /const scoringEconomics = AI_ANALYSIS_ENABLED \? economics : marketEconomics;/);
  assert.match(bot, /const rejectReasons = scoringEconomics\.rejectReasons\.map/);
  // Both stored rows take their status from it, or one shape keeps the zeros.
  assert.equal((bot.match(/status: scoringEconomics\.status,/g) || []).length, 2);
  assert.ok(!/status: economics\.status,/.test(bot), "no row may still carry the AI verdict");

  // The switch is the existing single one, so nothing new can turn the model back on.
  assert.match(bot, /const AI_ANALYSIS_ENABLED = envBool\("PAPER_AI_ANALYSIS_ENABLED", false\);/);
});

test("scraping log: the asked-for columns lead, and every header keeps its own cell", async () => {
  // Asked for: new/updated third, categories fourth. The table scrolls horizontally, so
  // the first columns are what is read without dragging -- and those two are what a
  // scraping run is judged on.
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  const fn = app.slice(app.indexOf("function renderScrapeRunLog"));
  const body = fn.slice(0, fn.indexOf("\nfunction ", 1));
  const headers = [...body.matchAll(/<th>([^<]+)<\/th>/g)].map((match) => match[1]);
  const cells = [...body.matchAll(/<td data-label="([^"]+)"/g)].map((match) => match[1]);

  assert.deepEqual(headers.slice(0, 4), ["Run time", "Trigger", "New / updated", "Categories"]);

  // Headers and cells are two separate lists in one template, so moving a column means
  // moving both -- otherwise every value below it shifts under the wrong heading, which
  // reads as wrong data rather than a layout slip. The trade table has had this pinned
  // since a reorder did exactly that; this table had nothing.
  assert.deepEqual(cells, headers, "each column's cell must sit under its own header");
  assert.ok(headers.length >= 13, `expected the full column set, found ${headers.length}`);
});

test("execution candidates: Win and Days left lead, precheck follows the market", async () => {
  // Asked for: drop the row-number column, put Win first and Days left second, and move
  // precheck behind Market. The table scrolls sideways, so the leading columns are what
  // is read without dragging -- and a row's number in the list is not one of them.
  const renderer = candidateRenderer({ candidateVisibleCount: 80, candidateVisibleMode: "live" });
  const rows = [{ tokenId: "1", question: "A market", outcome: "Yes" }];

  for (const mode of ["live", "paper-conservative"]) {
    const html = renderer.render(rows, mode, null);
    const headers = [...html.matchAll(/<th>([^<]*)<\/th>/g)].map((match) => match[1].trim());
    const cells = [...html.matchAll(/<td data-label="([^"]*)"/g)].map((match) => match[1].trim());

    assert.deepEqual(headers.slice(0, 4), ["Win", "Days left", "Market", "Precheck"], `${mode} order`);
    // Headers and cells are two lists in one template, so a moved column has to move in
    // both or every value below it lands under the wrong heading.
    assert.deepEqual(cells, headers, `${mode}: each cell must sit under its own header`);
    assert.ok(!headers.includes("#"), `${mode}: the row-number column is gone`);
    assert.ok(!/data-label="#"/.test(html), `${mode}: and its cell with it`);
  }

  // READY on a live portfolio said "will verify live quote, fees and ranking" -- what
  // every live execution does to every candidate, so it said nothing about the row while
  // taking the space of something that would.
  const app = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../assets/app.js", import.meta.url), "utf8"));
  // Checked against the code, or the comment recording why it went would count as the
  // string it warns about.
  const appCode = app.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  assert.ok(!/will verify live quote/.test(appCode), "the blanket precheck note is gone");
  // A paper portfolio keeps its own note, and an excluded or blocked row keeps its reason.
  assert.match(app, /\(!live \? "ready for next paper execution" : ""\)/);
  assert.match(app, /"excluded manually for this portfolio"/);
  assert.match(app, /"excluded by diversification rules"/);
  // With no note there must be no empty element left behind under the badge.
  assert.match(app, /\$\{status \? `<span>\$\{escapeHtml\(status\)\}<\/span>` : ""\}/);
});

test("execution candidates: the last column names when the record was added or updated", () => {
  const renderer = candidateRenderer({ candidateVisibleCount: 80, candidateVisibleMode: "live" });
  const rows = [{ tokenId: "1", question: "A market", outcome: "Yes" }];
  const html = renderer.render(rows, "live", null);
  const headers = [...html.matchAll(/<th>([^<]*)<\/th>/g)].map((match) => match[1].trim());
  const cells = [...html.matchAll(/<td data-label="([^"]*)"/g)].map((match) => match[1].trim());

  assert.equal(headers[headers.length - 1], "Added / updated", "it must be the last column, not inserted before Analysis");
  assert.deepEqual(cells, headers, "the cell must sit under its own header");
});

// firstAnalysisDate/reassessmentDate already carry this exact "added vs updated"
// distinction for the Analysis modal's original/current comparison, so the candidates
// table's new column is only a thin cell around them -- this pins their actual behavior
// rather than the stubbed-out call the table-layout test above leaves them as.
test("execution candidates: added/updated picks the reassessment over the original add date", () => {
  const app = readFileSync(new URL("../assets/app.js", import.meta.url), "utf8");
  const extract = (name) => {
    const start = app.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`missing ${name}`);
    const bodyStart = app.indexOf(") {\n", start);
    let depth = 0;
    for (let i = bodyStart + 2; i < app.length; i += 1) {
      if (app[i] === "{") depth += 1;
      else if (app[i] === "}") {
        depth -= 1;
        if (!depth) return app.slice(start, i + 1);
      }
    }
    throw new Error(`unbalanced ${name}`);
  };
  const src = [extract("firstAnalysisDate"), extract("reassessmentDate"), extract("formatDate"), extract("candidateAddedOrUpdatedCell")].join("\n\n");
  const candidateAddedOrUpdatedCell = new Function(
    "escapeHtml",
    `${src}\nreturn candidateAddedOrUpdatedCell;`,
  )((value) => String(value ?? ""));

  // Never evaluated: nothing to report.
  assert.equal(candidateAddedOrUpdatedCell({}), "<span>-</span>");

  // Added once, never reassessed since: names when it was first added.
  const added = candidateAddedOrUpdatedCell({ firstEvaluatedAt: "2026-08-01T10:00:00.000Z" });
  assert.match(added, /^<span>Added /);
  assert.ok(!/Updated/.test(added), "must not claim an update that never happened");

  // Reassessed since: the later date wins, or the column would always say "Added" and
  // never reflect a candidate the bot has actually looked at again.
  const updated = candidateAddedOrUpdatedCell({
    firstEvaluatedAt: "2026-08-01T10:00:00.000Z",
    lastSeenAt: "2026-08-10T10:00:00.000Z",
  });
  assert.match(updated, /^<span>Updated /);
});

// Reported from the conservative portfolio's run log: every candidate came back as
// "execution shortlist revalidation failed: scoringEconomics is not defined; base status
// ERROR is not executable", and the portfolio stopped opening orders altogether.
//
// The cause was mine. Routing the verdict through market economics instead of the retired
// AI probability introduced `scoringEconomics` in the main evaluation path, and the same
// rename landed on two lines inside refreshEvaluationAfterProbability, which has no such
// local. node --check parses, it does not resolve identifiers, so it compiled clean and
// threw on the first call -- and that call is what revalidates a stored candidate, so one
// ReferenceError took out the whole shortlist.
//
// Calling the real function is the only thing that catches this class of bug.
test("revalidation: refreshing a stored candidate does not throw on an undefined name", () => {
  const evaluation = {
    id: "market-1",
    tokenId: "77",
    question: "Will this resolve yes?",
    outcome: "No",
    marketPrice: 0.96,
    marketProbability: 0.96,
    stakeUsdc: 5,
    takerFeeUsdc: 0,
    totalCostUsdc: 5,
    executableShares: 5.2,
    filledStakeUsdc: 5,
    spread: 0.01,
    liquidity: 90000,
    volume24hr: 90000,
    daysToResolution: 0.5,
    endDate: new Date(Date.now() + 12 * 3600000).toISOString(),
  };

  const refreshed = bot.refreshEvaluationAfterProbability(evaluation, 0.96, "market", null);
  assert.ok(refreshed, "the refreshed evaluation must come back");
  assert.equal(typeof refreshed.status, "string");
  assert.notEqual(refreshed.status, "", "a candidate with no verdict is not executable");
  // The verdict comes from the market's economics now, so a market this strong is not
  // rejected for want of an AI probability that nothing produces any more.
  assert.ok(Array.isArray(refreshed.rejectReasons));
  assert.ok(!refreshed.rejectReasons.some((reason) => /is not defined/.test(String(reason))));

  // And a market whose own probability cannot be read still gets judged rather than
  // crashing the shortlist -- that is the null-marketEconomics path.
  const unreadable = bot.refreshEvaluationAfterProbability(
    { ...evaluation, marketProbability: null, marketPrice: Number.NaN },
    0.96,
    "market",
    null,
  );
  assert.ok(unreadable);
  assert.equal(typeof unreadable.status, "string");
});

// The same 500 that killed the trading runs also kills the opportunities page, and the
// page cannot simply skip the resolved archive -- the Resolved tab is what it is for.
// Measured on a state at production's counts, decoding 23,561 resolved rows peaks at
// 138 MB, and the host answers 500 above 128 MB. Nothing downstream can rescue that: the
// cost is paid at json_decode, before a single row has been filtered or capped.
//
// So the archive is still kept whole -- it is the record of everything ever mined -- and
// the newest page of it is published beside it as its own capped file. Reading that
// instead changes the cost from "however much history exists" to a constant.
test("state segments: the newest resolved page is published beside the full archive", () => {
  const resolvedAt = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString();
  const observations = [];
  for (let i = 0; i < 40; i += 1) {
    observations.push({ id: `active-${i}`, tokenId: `${i}`, status: "SCRAPED", marketProbability: 0.9 });
  }
  // Deliberately oldest-first, so an implementation that just takes the head of the list
  // instead of sorting serves the wrong page and fails here.
  for (let i = 0; i < 200; i += 1) {
    observations.push({ id: `resolved-${i}`, tokenId: `r${i}`, status: "RESOLVED", resolvedAt: resolvedAt(200 - i) });
  }

  const { core, segments } = bot.splitStateIntoSegments({ marketObservations: observations });
  const archive = segments.resolvedObservations.resolvedMarketObservations;
  const recent = segments.resolvedRecent.resolvedMarketObservations;

  // The archive keeps everything, and the active catalogue never carries resolved rows.
  assert.equal(archive.length, 200);
  assert.equal(segments.observations.marketObservations.length, 40);

  // The page is bounded and newest first. With the default cap above the row count it is
  // the whole archive re-ordered, which is what makes the ordering testable at this size.
  assert.equal(recent.length, 200);
  assert.equal(recent[0].id, "resolved-199", "the newest resolved market leads the page");
  assert.equal(recent[recent.length - 1].id, "resolved-0");

  // The tab labels read the manifest, not the served rows, so capping the page must not
  // change what the counts say was mined.
  assert.equal(core.stateSegments.resolvedObservations.counts.resolvedMarketObservations, 200);
  assert.equal(core.stateSegments.resolvedRecent.truncatedFrom, 200);
  assert.equal(core.stateSegments.resolvedRecent.file, "paper-state.resolvedRecent.json");
  assert.equal(core.stateSegments.resolvedRecent.mergesInto, "marketObservations");
});

test("state segments: the opportunities page reads the capped page, not the archive", async () => {
  const { readFile } = await import("node:fs/promises");
  const api = await readFile(new URL("../api.php", import.meta.url), "utf8");

  // The one line that decides whether this page costs a constant or grows with history.
  assert.match(api, /case 'scraped':\n[\s\S]*?return \['observations', 'resolvedRecent', 'scanHistory'\];/);
  // It merges through the same transport field, so nothing downstream changes shape.
  assert.match(api, /'resolvedRecent' => \['resolvedMarketObservations'\],/);
  // And the totals still come from the archive's own manifest entry, untouched.
  assert.match(api, /\$manifest\['resolvedObservations'\]\['counts'\]\['resolvedMarketObservations'\]/);

  // The page is published but never reassembled into state: it carries the archive's own
  // transport field, and the merge replaces the resolved half rather than appending, so a
  // reader that loaded both would rebuild the state from whichever landed last.
  const source = await readFile(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");
  const readBack = /const STATE_SEGMENT_NAMES = \[[^\]]*\];/.exec(source);
  const published = /const PUBLISHED_STATE_SEGMENT_NAMES = \[[^\]]*\];/.exec(source);
  assert.doesNotMatch(readBack[0], /RESOLVED_RECENT_SEGMENT/,
    "reassembling the state from the capped page would truncate the archive on the next write");
  assert.match(published[0], /RESOLVED_RECENT_SEGMENT/);
});

// The capped page was kept out of the local reader by name, and the hosted reader walks
// the manifest instead -- so it fetched the page too, merged it last, and the archive in
// memory became its own first 3,000 rows. The next write would have published that back
// as the whole archive, losing every older resolved market permanently.
test("state segments: reading the hosted state never rebuilds it from the capped page", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");

  // Both readers exclude the same set, named once so they cannot drift apart.
  assert.match(source, /const DERIVED_STATE_SEGMENTS = new Set\(\[RESOLVED_RECENT_SEGMENT\]\);/);
  assert.match(source, /\.filter\(\(\[name\]\) => !DERIVED_STATE_SEGMENTS\.has\(name\)\)/,
    "the manifest-driven reader must skip derived segments");
  assert.match(source, /Object\.keys\(manifest\)\.filter\(\(name\) => !DERIVED_STATE_SEGMENTS\.has\(name\)\)/,
    "and must not then count them as segments it failed to address");

  // What the merge would have done, driven by the real function in manifest order.
  const resolvedAt = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString();
  const observations = [];
  for (let i = 0; i < 5; i += 1) observations.push({ id: `a${i}`, status: "SCRAPED" });
  for (let i = 0; i < 50; i += 1) observations.push({ id: `r${i}`, status: "RESOLVED", resolvedAt: resolvedAt(50 - i) });
  const { core, segments } = bot.splitStateIntoSegments({ marketObservations: observations });

  // Manifest order, which is the order the hosted reader fetches in.
  let asHosted = { ...core };
  for (const name of Object.keys(core.stateSegments)) {
    if (name === "resolvedRecent") continue;
    asHosted = bot.mergeStateSegment(asHosted, segments[name]);
  }
  assert.equal(asHosted.marketObservations.length, 55, "the archive is rebuilt whole");

  // And the failure it replaces: merging the page last leaves only the page.
  const truncated = bot.mergeStateSegment(asHosted, segments.resolvedRecent);
  assert.equal(
    truncated.marketObservations.filter((item) => item.status === "RESOLVED").length,
    segments.resolvedRecent.resolvedMarketObservations.length,
    "merging the page replaces the archive rather than adding to it -- which is why it is skipped",
  );
});

// Reported on Paper 75: rotation is switched on in its parameters, and the run log showed
// only "SKIP: not enough free paper capital for next Paper 75 trade: 6.10 USDC available,
// 6.34 USDC required" -- nothing about rotation at all. From that it is impossible to tell
// a rule declining from the logic never running.
//
// It had run. Every path out of the review returned a bare null, which threw away the
// reasons it had collected, and the skip path built its batch log without them.
test("paper rotation: every outcome says what rotation decided", async () => {
  const { readFile } = await import("node:fs/promises");
  const bot = await readFile(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");

  const held = (id, hours) => ({ id, status: "OPEN", tokenId: id, maxLossUsdc: 5, stakeUsdc: 5, hours });
  const build = (trades, { candidate = { tokenId: "9" }, score = 2, ev = 0.5 } = {}) => new Function(
    "openTrades", "heldHours", "ROTATION_MIN_HOLD_HOURS", "findFirstOpenCandidate",
    "tradeContinuationEconomics", "candidateRotationScore", "portfolioEconomics",
    "ROTATION_MIN_SCORE_IMPROVEMENT", "ROTATION_MIN_EV_USDC_IMPROVEMENT",
    `${functionSource(bot, "rotationPositionSummary")}\n${functionSource(bot, "rotationCandidateSummary")}\n`
    + `${functionSource(bot, "rotationReview")}\nreturn rotationReview;`,
  )(
    (list) => list, (trade) => trade.hours, 6, () => ({ best: candidate }),
    () => ({ score: 1, expectedValue: 0.10 }), () => score, () => ({ expectedValueUsdc: ev }),
    0.15, 0.02,
  )({ trades }, [candidate], {}, 1, 5);

  // Production's numbers: short of the stake, so rotation is the portfolio's only route.
  // Each refusal below is a different rule, and each has to be distinguishable.
  const noHoldings = build([]);
  assert.equal(noHoldings.best, null);
  assert.match(noHoldings.reason, /holds no open paper trade to rotate out of/);

  const tooYoung = build([held("A", 1), held("B", 2)]);
  assert.equal(tooYoung.best, null);
  assert.match(tooYoung.reason, /all 2 open trade\(s\) are still inside the 6h minimum hold/);

  // Reviewable, but the candidate is not enough better. The per-holding reasons are the
  // answer here, so they must survive the refusal rather than being dropped.
  const tooSmall = build([held("A", 48)], { score: 1.05, ev: 0.11 });
  assert.equal(tooSmall.best, null);
  assert.match(tooSmall.reason, /none of the 1 reviewable holding\(s\) cleared the rotation bars/);
  assert.ok(tooSmall.reviews.length, "the per-holding reasons must travel with the refusal");
  assert.match(tooSmall.reviews[0].reason, /improvement too small/);

  // And a rotation that does qualify still reports itself the same way.
  const rotates = build([held("A", 48)]);
  assert.ok(rotates.best);
  assert.equal(rotates.action, "ROTATION_AVAILABLE");

  // Every refusal uses the shape the run-log rotation block already renders for live.
  for (const outcome of [noHoldings, tooYoung, tooSmall]) {
    assert.equal(outcome.action, "NO_ROTATION_CANDIDATE");
    assert.ok(Array.isArray(outcome.reviews));
  }
});

test("paper rotation: the switch reaches the bot, and being off is logged too", async () => {
  const { readFile } = await import("node:fs/promises");
  const [bot, workflow, api] = await Promise.all([
    readFile(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8"),
    readFile(new URL("../../.github/workflows/trading-paper-bot.yml", import.meta.url), "utf8"),
    readFile(new URL("../api.php", import.meta.url), "utf8"),
  ]);

  // The chain the setting travels: saved config -> workflow env -> strategy flag. A break
  // anywhere in it would look exactly like the reported symptom, so all three are pinned.
  assert.match(api, /'autoRotatePositions' => \(bool\) \(\$input\['autoRotatePositions'\]/);
  assert.match(workflow, /emit\(f"\{prefix\}_AUTO_ROTATE", str\(bool\(row\.get\("autoRotatePositions"/);
  const strategies = [...bot.matchAll(/allowRotation: envBool\("PAPER_(\w+)_AUTO_ROTATE", (\w+)\)/g)];
  assert.equal(strategies.length, 4, "every paper strategy reads its own rotation switch");
  // Equal is the one that ships off; the rest keep the behaviour they had before the
  // switch existed, so an existing portfolio does not silently stop rotating.
  const defaults = Object.fromEntries(strategies.map((match) => [match[1], match[2]]));
  assert.equal(defaults.EQUAL, "false");
  for (const name of ["CONSERVATIVE", "HIGH_REWARD", "MORE_PROBABLE"]) {
    assert.equal(defaults[name], "true", `${name} must keep rotating unless it is switched off`);
  }
  assert.match(bot, /allowRotation: strategy\.allowRotation !== false,/);

  // Off is a reason, not an absence: "rotation is off" and "rotation ran and declined"
  // are indistinguishable in a log that records neither.
  assert.match(bot, /action: "ROTATION_DISABLED", reason: "position rotation is switched off for this portfolio"/);
  // And whatever it concluded reaches the batch log on the paths that do not rotate --
  // the skip the report was filed against is one of them.
  assert.equal((bot.match(/rotationReview: rotationOutcome,/g) || []).length, 3);
});

// Reported: the Equal portfolio ends every trade on an enormous STOP_GAP, practically the
// size of the whole position.
//
// Measured on its own numbers. A 5.00 USDC entry at 0.95 buys 5.2632 shares and wins
// 0.2632, so capping the loss at the win puts the stop floor at 0.9000 -- a five-point
// band. A near-certain outcome that turns against you does not sit inside that band
// waiting to be polled; it collapses. Every check therefore saw a bid of 0.05 or 0.01,
// booked the exit there, and recorded a 4.74 USDC loss against a 0.26 cap.
//
// The live side never did that: the RPi worker polls every five seconds and submits its
// sell at stopPrice, not at the collapsed bid. Paper is meant to estimate the live
// strategy and was measuring something no live run would produce.
test("equal stop: a watched position exits at its floor, not at the collapsed bid", async () => {
  const { readFile } = await import("node:fs/promises");
  const bot = await readFile(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");
  const api = new Function(`
    ${functionSource(bot, "netExitValueAtPrice")}
    ${functionSource(bot, "normalizeStopLossRiskMultiplier")}
    ${functionSource(bot, "equalRiskStopPlan")}
    ${functionSource(bot, "equalRiskStopExitDecision")}
    return { equalRiskStopPlan, equalRiskStopExitDecision };
  `)();

  // The reported trade, to its own arithmetic.
  const shares = 5.2632;
  const plan = api.equalRiskStopPlan({
    totalCostUsdc: 5, netGainIfWinUsdc: 0.2632, shares, entryPrice: 0.95, feeRate: 0, feesEnabled: false,
  });
  assert.equal(plan.requiresStop, true);
  // The floor comes from a bounded search, so it lands a hair under the round number
  // rather than on it. The band is what matters: five points below a 0.95 entry.
  assert.ok(Math.abs(plan.stopPrice - 0.9) < 0.0001, `stop floor ${plan.stopPrice} is ~0.90`);
  assert.equal(plan.riskTargetUsdc, 0.2632);

  const decide = (bestBid, previousBid) => api.equalRiskStopExitDecision({
    plan, bestBid, shares, feeRate: 0, feesEnabled: false, previousBid,
  });

  // Watched above the floor, then found below it: the market traded through a resting
  // exit, so it filled at the floor and the loss is the cap. This is the whole fix -- the
  // same input used to book 4.7368.
  for (const collapsed of [0.5, 0.05, 0.01, 0]) {
    const exit = decide(collapsed, 0.95);
    assert.equal(exit.triggered, true);
    assert.equal(exit.fillPrice, plan.stopPrice, `crossing from 0.95 to ${collapsed} fills at the floor`);
    assert.equal(exit.filledByCrossing, true);
    assert.equal(exit.stopLossStatus, undefined);
    assert.ok(Math.abs(exit.realizedLossUsdc - plan.riskTargetUsdc) < 0.0001,
      `loss ${exit.realizedLossUsdc} must land on the ${plan.riskTargetUsdc} cap`);
  }

  // Caught at or above the floor, the bid is what fills -- it is better than the floor.
  // 0.88 is *below* a 0.89998 floor, so it is a crossing, not an in-band catch: the case
  // has to sit above the floor to test what it means to.
  const inside = decide(plan.stopPrice, 0.95);
  assert.equal(inside.fillPrice, plan.stopPrice);
  assert.equal(inside.filledByCrossing, false);
  assert.equal(inside.executableAtFloor, true);

  // Never observed above the floor: no resting exit could have filled, so this is the
  // genuine gap the status was invented for -- and it still reports the real loss.
  const gapped = decide(0.05, null);
  assert.equal(gapped.fillPrice, 0.05);
  assert.equal(gapped.filledByCrossing, false);
  assert.ok(gapped.realizedLossUsdc > 4.7, "a true gap still books what it really cost");
  // Already below the floor at the previous look is the same case.
  assert.equal(decide(0.05, 0.5).fillPrice, 0.05);

  // Above the floor is not a stop at all.
  assert.equal(decide(0.95, 0.95), null);
});

test("equal stop: the paper fill is modelled on what the live worker actually submits", async () => {
  const { readFile } = await import("node:fs/promises");
  const [bot, worker] = await Promise.all([
    readFile(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8"),
    readFile(new URL("../tools/rpi-live-exit-worker.mjs", import.meta.url), "utf8"),
  ]);

  // The live worker sells at the floor and triggers a touch above it so the order has
  // room to fill. That is the mechanism paper is estimating.
  assert.match(worker, /triggerPrice: round\(Math\.min\(0\.999999, stopPrice \+ STOP_PRETRIGGER_BUFFER\), 6\)/);
  assert.match(worker, /const POLL_INTERVAL_MS = clampInteger\(process\.env\.LIVE_EXIT_POLL_INTERVAL_MS, 5000,/);

  // Paper needs the previous mark to know a crossing happened; it is written by the
  // check before, so nothing new has to be stored for this.
  assert.match(bot, /previousBid: trade\.currentPrice,/);
  assert.match(bot, /const crossedSinceLastLook = Number\.isFinite\(priorBid\) && priorBid > floor;/);
  assert.match(bot, /const fillPrice = observedAtOrAboveFloor \? bid : \(crossedSinceLastLook \? floor : bid\);/);

  // The row records the price it filled at, and keeps the observed bid beside it so the
  // assumption is auditable rather than hidden.
  assert.match(bot, /currentPrice: Number\(equalStopDecision\.fillPrice\.toFixed\(4\)\),/);
  assert.match(bot, /observedBidAtStop: equalStopDecision\.observedBid,/);
  assert.match(bot, /stopLossStatus: equalStopDecision\.filledByCrossing\r?\n\s+\? "FILLED_AT_FLOOR"/);
});

// Reported: paper portfolios had no "use limit orders" row in their parameter overview,
// and the user wanted to be sure that was only a UI gap -- that a checked portfolio
// really does simulate whether a resting order would have filled, or been discarded
// unfilled, rather than always buying at the market ask regardless of the setting. It
// was not only a UI gap: the field was saved but never read anywhere in the bot.
function candidateFixture(overrides = {}) {
  return {
    id: "token:1",
    tokenId: "1",
    question: "Will it happen?",
    slug: "will-it-happen",
    outcome: "Yes",
    tags: [],
    marketPrice: 0.7,
    bestAsk: 0.7,
    bestBid: 0.65,
    executableShares: 7.1429,
    feesEnabled: false,
    feeRate: 0,
    daysToResolution: 2,
    ...overrides,
  };
}

test("limit orders: a portfolio without the setting still fills at the market ask", () => {
  const strategy = { ...bot.PAPER_STRATEGIES.conservative, useLimitOrders: false };
  const best = candidateFixture();
  const marketTrade = bot.paperTradeFromCandidate(best, strategy, "2026-08-18", 5);
  const trade = bot.openPaperTradeForStrategy(best, strategy, "2026-08-18", 5);
  // openedAt is a fresh timestamp on each call, so it is excluded rather than compared.
  assert.deepEqual({ ...trade, openedAt: null }, { ...marketTrade, openedAt: null },
    "unset, this must be exactly the existing market-buy path");
  assert.equal(trade.status, "OPEN");
  assert.equal(trade.entryPrice, 0.7);
});

test("limit orders: a portfolio with the setting rests at the best bid instead of paying the ask", () => {
  const strategy = { ...bot.PAPER_STRATEGIES.conservative, useLimitOrders: true };
  const best = candidateFixture();
  const trade = bot.openPaperTradeForStrategy(best, strategy, "2026-08-18", 5);
  assert.equal(trade.status, "LIMIT_ORDER_WAITING", "must not be booked as an already-filled position");
  assert.equal(trade.entryPrice, 0.65, "rests at the bid, not the ask it would have paid crossing the spread");
  assert.equal(trade.executionMode, "LIMIT_BUY");
  assert.equal(trade.shares, Number((5 / 0.65).toFixed(4)));
  assert.equal(trade.maxLossUsdc, trade.totalCostUsdc, "the whole reserved stake is still what is at risk");
  assert.equal(trade.currentValueUsdc, 5, "capital is reserved for a resting order the same as a filled one");
});

test("limit orders: a resting maker buy reserves no taker fee", () => {
  const strategy = { ...bot.PAPER_STRATEGIES.conservative, useLimitOrders: true };
  const trade = bot.openPaperTradeForStrategy(candidateFixture({
    feesEnabled: true,
    feeRate: 0.02,
  }), strategy, "2026-08-18", 5);

  assert.equal(trade.takerFeeUsdc, 0, "Polymarket fees apply to takers, not a resting bid");
  assert.equal(trade.totalCostUsdc, 5, "only the configured stake is reserved");
  assert.equal(trade.netGainIfWinUsdc, Number(((5 / 0.65) - 5).toFixed(4)));

  const economics = bot.portfolioEconomics(candidateFixture({
    stakeUsdc: 5,
    netGainIfWinUsdc: 2,
    totalCostUsdc: 5.04,
    daysToResolution: 2,
  }), strategy);
  assert.ok(economics.annualizedReturn > 0, "the shortlist uses the maker entry economics for a limit portfolio");
});

test("limit orders: with no usable bid, the order still falls back to a market fill", () => {
  // A thin book with no visible bid cannot be rested on; opening nothing at all would
  // silently drop the candidate the portfolio ranking already chose.
  const strategy = { ...bot.PAPER_STRATEGIES.conservative, useLimitOrders: true };
  for (const bestBid of [null, undefined, 0, 1, NaN]) {
    const trade = bot.openPaperTradeForStrategy(candidateFixture({ bestBid }), strategy, "2026-08-18", 5);
    assert.equal(trade.status, "OPEN", `bestBid=${bestBid} must fall back to a market fill`);
  }
});

test("limit orders: filled when the ask reaches the resting price, discarded unfilled once the event ends", () => {
  const waiting = bot.limitOrderFillDecision({ limitPrice: 0.65, bestAsk: 0.7, eventEnded: false });
  assert.equal(waiting.outcome, "WAITING", "the ask has not come down to the resting bid yet");

  const filled = bot.limitOrderFillDecision({ limitPrice: 0.65, bestAsk: 0.65, eventEnded: false });
  assert.equal(filled.outcome, "FILLED");
  assert.equal(filled.fillPrice, 0.65, "fills at the resting price, not the crossing ask");

  const filledByCrossing = bot.limitOrderFillDecision({ limitPrice: 0.65, bestAsk: 0.5, eventEnded: false });
  assert.equal(filledByCrossing.outcome, "FILLED");
  assert.equal(filledByCrossing.fillPrice, 0.65, "a deeper crossing still only costs the resting price, not the lower ask");

  const expired = bot.limitOrderFillDecision({ limitPrice: 0.65, bestAsk: 0.7, eventEnded: true });
  assert.equal(expired.outcome, "EXPIRED", "the event ended before the market ever came down to the resting bid");

  // A fill discovered in the very same look that also finds the event over must still
  // count as a fill: the order could have traded through at any point up to that check.
  const filledAtTheWire = bot.limitOrderFillDecision({ limitPrice: 0.65, bestAsk: 0.65, eventEnded: true });
  assert.equal(filledAtTheWire.outcome, "FILLED");
});

test("limit orders: an active Polymarket market keeps a resting bid alive after its scheduled end date", () => {
  const stillTradable = {
    active: true,
    closed: false,
    acceptingOrders: true,
  };
  assert.equal(
    bot.limitOrderEventEnded(stillTradable, -0.2),
    false,
    "a delayed settlement must not expire a bid while Polymarket still accepts orders",
  );
  const decision = bot.limitOrderFillDecision({
    limitPrice: 0.76,
    bestAsk: 0.78,
    eventEnded: bot.limitOrderEventEnded(stillTradable, -0.2),
  });
  assert.equal(decision.outcome, "WAITING");
  assert.equal(bot.limitOrderEventEnded({ active: false, closed: true }, -0.2), true);
  assert.equal(bot.limitOrderEventEnded({}, -0.2), true, "the end date remains the fallback when no live status exists");
});

// Reported: the trade count in Tag performance does not match the number of rows its own
// link shows, so the statistics look as though they are computed on something other than
// the data behind them.
//
// They were. Three different orders of preference for the same idea -- "the price this row
// is counted at" -- existed at once: the simulation used
// firstMarketProbability ?? marketProbability ?? marketPrice, the list used the current
// quote falling back to lastLiveMarketProbability, and firstObservationMetadata used a
// fourth. A market first seen at 0.85 and last quoted at 0.55 therefore sat in the >=60
// bucket and was filtered out of the list at that same threshold.
test("tag performance: the list behind a statistic is the set the statistic counted", async () => {
  const { readFile } = await import("node:fs/promises");
  const [app, bot] = await Promise.all([
    readFile(new URL("../assets/app.js", import.meta.url), "utf8"),
    readFile(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8"),
  ]);

  const statsEntry = new Function(`
    ${functionSource(bot, "firstLiveProbability")}
    ${functionSource(bot, "scrapedSimulationProbability")}
    return scrapedSimulationProbability;
  `)();
  const listEntry = new Function(`
    ${functionSource(app, "scrapedEntryProbability")}
    return scrapedEntryProbability;
  `)();

  // Every shape a stored observation actually takes, including the ones that made the two
  // disagree. The point is not what the answer is -- it is that there is only one.
  const rows = [
    { firstMarketProbability: 0.85, lastLiveMarketProbability: 0.55, marketProbability: 1 },
    { firstMarketProbability: 0.62, lastLiveMarketProbability: 0.95, marketProbability: 1 },
    // An old row whose first price was seeded from a settlement print: the live quote
    // beside it is the only usable number, and both sides must reach for it.
    { firstMarketProbability: 1, lastLiveMarketProbability: 0.73, marketProbability: 1 },
    { firstMarketProbability: 0, lastLiveMarketProbability: 0.41, marketPrice: 0 },
    { marketProbability: 0.9 },
    { marketPrice: 0.77 },
    // Nothing tradable was ever recorded: the simulation counts no such row, so the list
    // must not show one under a statistic either.
    { firstMarketProbability: 1, marketProbability: 1 },
    { firstMarketProbability: 0, marketProbability: 0 },
    {},
  ];
  for (const row of rows) {
    assert.equal(listEntry(row), statsEntry(row),
      `the list and the statistics must price ${JSON.stringify(row)} identically`);
  }

  // The two cases that were reported, spelled out: they now land in the same bucket.
  assert.equal(statsEntry(rows[0]), 0.85, "first seen at 0.85 is counted at 0.85, not at its last quote");
  assert.equal(statsEntry(rows[2]), 0.73, "a settlement print is not a quote; the live number wins");
  assert.equal(statsEntry(rows[6]), null, "a row with no live quote is counted by neither side");

  // And the list applies both of those rules where it filters, not only where it displays.
  const render = functionSource(app, "renderScrapedOpportunities");
  assert.match(render, /const filterProbability = Number\(isResolved \? scrapedEntryProbability\(item\) : scrapedDisplayProbability\(item\)\);/);
  assert.match(render, /if \(isResolved && scrapedEntryProbability\(item\) == null\) return false;/);
  // A settled row shows the number it was filtered on, so the column cannot contradict
  // the filter that admitted it.
  assert.match(functionSource(app, "scrapedDisplayProbability"), /const entry = scrapedEntryProbability\(item\);/);
});

test("automation: an after-scrape pass runs a cron portfolio once its own interval is due", async () => {
  // Reported: portfolios created in the browser never ran at all -- no run log, no
  // positions, equity still at the opening balance -- while the four shipped ones traded
  // on. Both were saved with the "cron" trigger, and an after-scrape pass used to admit
  // only portfolios whose trigger was literally "after_scrape". That is nearly every
  // execution pass there is: a scheduled tick resolves to a catalogue scan and chains an
  // after_scan run to do the trading, so EXECUTION_TRIGGER was almost never "cron".
  //
  // The pacing has to stay with the cadence, so this checks both halves: the trigger gate
  // lets a cron portfolio through, and the cadence gate is what still holds it to its own
  // interval.
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");
  const gate = source.slice(source.indexOf("function strategyMatchesExecutionTrigger"));
  const body = gate.slice(0, gate.indexOf("\nfunction "));
  assert.match(body, /if \(EXECUTION_TRIGGER === "after_scrape"\) return true;/,
    "an after-scrape pass must not exclude a portfolio by trigger alone");
  // The reverse stays exclusive: after_scrape means "only on freshly scanned data".
  assert.match(body, /if \(EXECUTION_TRIGGER === "cron"\) return strategy\.executionTrigger !== "after_scrape";/);

  // And both gates are applied together, so admitting cron portfolios above cannot make
  // them trade more often than their interval allows.
  const due = source.slice(source.indexOf("function dueExecutionStrategies"));
  const dueBody = due.slice(0, due.indexOf("\nfunction "));
  assert.match(dueBody, /strategyMatchesExecutionTrigger\(strategy\)/);
  assert.match(dueBody, /strategyCadenceIsDue\(strategy, lastRunAtForStrategy\(state, strategy\)\)/);

  const now = Date.parse("2026-08-21T12:00:00Z");
  const minutesAgoIso = (minutes) => new Date(now - minutes * 60000).toISOString();
  const created = { id: "ewportfolio", executionTrigger: "cron", executionCronMinutes: 60, automationEnabled: true };
  assert.equal(bot.strategyMatchesExecutionTrigger(created, { manual: false }), true,
    "a created cron portfolio is eligible for the pass that is running");
  assert.equal(bot.strategyCadenceIsDue(created, minutesAgoIso(59), now, { manual: false }), false,
    "but its own hourly interval still paces it");
  assert.equal(bot.strategyCadenceIsDue(created, minutesAgoIso(61), now, { manual: false }), true);
  // Never ran yet is not a reason to keep waiting -- that was the state it was stuck in.
  assert.equal(bot.strategyCadenceIsDue(created, null, now, { manual: false }), true);
  // Switching automation off is still respected.
  assert.equal(bot.strategyMatchesExecutionTrigger({ ...created, automationEnabled: false }, { manual: false }), false);
});

test("paper capital adjustment: since-the-reset stats reconcile with equity and never double count", () => {
  // Reported: High reward showed EQUITY $109.46 next to TOTAL P/L -$37.92. Those cannot
  // both describe the same account. A reset sets equity to a target outright, so it
  // resets a stock; "since the reset" was measured as a flow instead -- the realized P/L
  // of every trade that resolved after the moment, plus the current open P/L, divided by
  // the pre-reset baseline. A position already under water at the reset had that loss
  // absorbed into the equity the reset handed it, then had its full realized loss charged
  // again on resolution.
  //
  // Built to reproduce exactly that shape: the reset happens while a losing position is
  // open, and the position resolves afterwards.
  const adjustedAt = "2026-08-17T04:00:00.000Z";
  const state = bot.normalizeState({
    generatedAt: "2026-08-20T00:00:00.000Z",
    paperPortfolios: {
      conservative: {
        // The reset put equity at 100 while the open book was 40 down.
        capitalAdjustmentUsdc: 24.4466,
        capitalAdjustmentAt: adjustedAt,
        capitalAdjustmentEquityUsdc: 100,
        capitalAdjustmentOpenPnlUsdc: -40,
        trades: [
          // Booked before the reset: part of equity's history, not of "since".
          { id: "before", status: "WON", stakeUsdc: 5, totalCostUsdc: 5, realizedPnlUsdc: 22.93, resolvedAt: "2026-08-10T00:00:00.000Z" },
          // Was open and 40 down at the reset, resolved after it at exactly that loss.
          // Charging its whole -40 to "since the reset" is the double count.
          { id: "across", status: "LOST", stakeUsdc: 40, totalCostUsdc: 40, realizedPnlUsdc: -40, resolvedAt: "2026-08-18T00:00:00.000Z" },
        ],
      },
    },
  });
  const portfolio = state.paperPortfolios.conservative.portfolio;

  // Equity is the unfiltered truth and must not move: 100 + 24.4466 + 22.93 - 40.
  assert.equal(portfolio.equityUsdc, 107.3766);
  // A position that only moved from unrealized to realized changed nothing, so the
  // account has done nothing since the reset beyond shedding that open position.
  assert.equal(portfolio.totalPnlSinceAdjustmentUsdc, 7.3766, "equity moved 100 -> 107.3766");
  // The three tiles must add up, or the card cannot be reconciled by a reader.
  assert.equal(
    Number((portfolio.realizedPnlSinceAdjustmentUsdc + portfolio.openPnlSinceAdjustmentUsdc).toFixed(4)),
    portfolio.totalPnlSinceAdjustmentUsdc,
    "realized + open since the reset must equal total since the reset",
  );
  // The percentage is measured against the equity the reset handed the account, not the
  // baseline that still carries pre-reset history.
  assert.equal(portfolio.rebaseEquityUsdc, 100);
  assert.equal(portfolio.totalPnlSinceAdjustmentPct, Number((7.3766 / 100).toFixed(4)));

  // And the old flow-based figure is what this replaces: summing the realized P/L of
  // trades resolved after the reset would have reported -40 here.
  assert.notEqual(portfolio.realizedPnlSinceAdjustmentUsdc, -40);
});

test("paper capital adjustment: a reset records the equity and open book it hands over", () => {
  // Without these two the stats have to reconstruct the moment by re-summing trades,
  // which is what double counted a position that spanned it.
  const state = bot.normalizeState({
    paperPortfolios: {
      conservative: {
        trades: [
          { id: "open", status: "OPEN", stakeUsdc: 10, totalCostUsdc: 10, unrealizedPnlUsdc: -6 },
          { id: "done", status: "LOST", stakeUsdc: 5, totalCostUsdc: 5, realizedPnlUsdc: -5, resolvedAt: "2026-08-01T00:00:00.000Z" },
        ],
      },
    },
  });
  const before = state.paperPortfolios.conservative.portfolio;
  assert.equal(before.equityUsdc, 89, "100 - 5 realized - 6 unrealized");

  const result = bot.adjustPaperPortfolioCapital(state, "conservative", 100);
  const after = state.paperPortfolios.conservative;
  assert.equal(result.newEquity, 100, "the reset puts equity on the target");
  assert.equal(after.capitalAdjustmentEquityUsdc, 100);
  assert.equal(after.capitalAdjustmentOpenPnlUsdc, -6, "the open book it inherits is recorded too");
  // Immediately after a reset nothing has happened since it, on any of the three tiles.
  assert.equal(after.portfolio.totalPnlSinceAdjustmentUsdc, 0);
  assert.equal(after.portfolio.openPnlSinceAdjustmentUsdc, 0);
  assert.equal(after.portfolio.realizedPnlSinceAdjustmentUsdc, 0);
});

test("paper capital adjustment: a reset baseline of null survives a second normalize pass", () => {
  // Reported: High reward showed Total P/L +$110.05 against equity $110.05, at +0.0% --
  // the whole account value read as profit since the reset, measured against zero.
  //
  // normalizePaperPortfolio both reads and writes these fields, and it guarded them with
  // Number.isFinite(Number(x)). A portfolio rebased before they existed stored null on the
  // first pass; the next pass read Number(null) === 0, which is finite, and stored 0. From
  // then on the recorded "equity the reset handed over" was zero, so every dollar the
  // account held counted as gain since the reset. Two passes are what it takes to see it.
  const input = {
    capitalAdjustmentUsdc: 24.4466,
    capitalAdjustmentAt: "2026-08-17T04:00:00.000Z",
    trades: [{ id: "t", status: "WON", stakeUsdc: 5, totalCostUsdc: 5, realizedPnlUsdc: 3, resolvedAt: "2026-08-18T00:00:00.000Z" }],
  };
  const once = bot.normalizeState({ paperPortfolios: { highReward: input } }).paperPortfolios.highReward;
  assert.equal(once.capitalAdjustmentEquityUsdc, null, "nothing recorded yet stays unrecorded");

  const twice = bot.normalizeState({ paperPortfolios: { highReward: once } }).paperPortfolios.highReward;
  assert.equal(twice.capitalAdjustmentEquityUsdc, null, "and must not become 0 on the way back in");
  // So the fallback still applies and the reset baseline is the documented target, not zero.
  assert.equal(twice.portfolio.rebaseEquityUsdc, 100);
  // equity = 100 + 24.4466 + 3 = 127.4466, so since the reset it is up 27.4466 -- not the
  // entire account value.
  assert.equal(twice.portfolio.equityUsdc, 127.4466);
  assert.equal(twice.portfolio.totalPnlSinceAdjustmentUsdc, 27.4466);
  assert.notEqual(twice.portfolio.totalPnlSinceAdjustmentUsdc, twice.portfolio.equityUsdc);
  // And the percentage is measured, not zeroed by a divide-by-zero guard.
  assert.ok(twice.portfolio.totalPnlSinceAdjustmentPct > 0.27);
});
