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

test("custom tag portfolio: execution uses the active Polymarket shortlist the dashboard shows", () => {
  const state = bot.normalizeState({
    marketObservations: [{
      id: "counter-strike-active-row",
      tokenId: "1234567890123456789012345678901234567890",
      outcome: "Vitality",
      question: "Counter-Strike: Vitality vs Inner Circle Esports (BO3)",
      status: "SCRAPED",
      selectionStatus: "SCRAPED",
      marketPrice: 0.865,
      marketProbability: 0.865,
      netYield: 0.1483,
      stakeUsdc: 5,
      totalCostUsdc: 5,
      netGainIfWinUsdc: 0.7415,
      spread: 0.02,
      liquidity: 50000,
      volume24hr: 50000,
      daysToResolution: 0.4,
      endDate: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
      polymarketTags: ["esports", "counter-strike-2"],
    }],
  });
  const strategy = {
    ...bot.PAPER_STRATEGIES.conservative,
    id: "counterstrike2",
    probabilitySource: "polymarket",
    minProbability: 0.8,
    maxProbability: null,
    minLiquidityUsdc: null,
    minNetYield: 0,
    includeOnlyMarketTags: new Set(["counter-strike-2"]),
    excludedMarketTags: new Set(),
    excludedCandidateTokenIds: new Set(),
  };

  const shortlist = bot.storedExecutionShortlist(state, strategy);
  assert.equal(shortlist.diagnostics.scannedMarketObservations, 1);
  assert.equal(shortlist.rows.length, 1);
  assert.equal(shortlist.rows[0].tokenId, "1234567890123456789012345678901234567890");
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

test("paper limit entry: the Polymarket threshold applies to the actual maker price", () => {
  const strategy = {
    ...bot.PAPER_STRATEGIES.conservative,
    id: "limit-threshold",
    label: "Limit threshold",
    probabilitySource: "polymarket",
    minProbability: 0.7,
    maxProbability: null,
    minLiquidityUsdc: 0,
    minNetYield: 0,
    marketType: "all",
    requireMostProbableOutcome: false,
    useLimitOrders: true,
    allowRotation: false,
    excludedCandidateTokenIds: new Set(),
  };
  const candidate = {
    id: "limit-entry-29",
    tokenId: "12345678901234567890",
    status: "SCRAPED",
    question: "Exact Score: Any Other Score?",
    outcome: "No",
    marketPrice: 0.7,
    marketProbability: 0.7,
    bestBid: 0.29,
    bestAsk: 0.31,
    spread: 0.02,
    volumeUsdc: 100000,
    daysToResolution: 1,
    stakeUsdc: 5,
    executableShares: 5 / 0.7,
    totalCostUsdc: 5,
    netGainIfWinUsdc: 2.14,
    netYield: 0.428,
  };

  assert.equal(bot.portfolioProbabilityForStrategy(candidate, strategy), 0.29);
  assert.equal(bot.strategyEligibleCandidates([candidate], strategy).length, 0,
    "a 29% maker bid must not pass a 70% Polymarket threshold");

  // The final opening function is deliberately defended as well. It may be passed a
  // shortlist that was computed before an updated quote arrived.
  const decision = bot.maybeOpenScheduledTrade({ trades: [], capitalAdjustmentUsdc: 0 }, [candidate], strategy);
  assert.equal(decision.action, "SKIP");
  assert.match(decision.reason, /no candidates passed Limit threshold portfolio filters/);
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
  // It takes the portfolio it is building for now that live portfolios are independent, so
  // the call is matched rather than the old no-argument form.
  const payloadAt = body.search(/return liveWorkflowPayload\(\w*\);/);
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
  assert.match(app, /const shortlistTokenIds = portfolioCandidateRows\(mode\)/);

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
  // Unattended, but not greedily: this repository asks for far more scheduled runs an hour
  // than GitHub delivers, and housekeeping is the first thing that should give up its slot
  // to the trading schedules. The frequency is free to change; that it is scheduled at all
  // is the point.
  assert.match(janitor, /schedule:\s*\n(?:\s*#[^\n]*\n)*\s*- cron: '[^']+'/, "it has to run unattended");

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

  // The two reads that made PHP decode everything must now decode nothing heavy. The
  // dashboard reads the archives segment, which is bounded by how many portfolios were
  // archived or reset; what it must never pull in is a catalogue that grows per market.
  const dashboardSegments = /case 'dashboard':\s*\n\s*return (\[[^\]]*\]);/.exec(api);
  assert.ok(dashboardSegments, "the dashboard summary must still declare its segments");
  assert.doesNotMatch(dashboardSegments[1], /'evaluations'|'observations'|'resolved/);
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
  // are not there yet. Segments may go up together; the core may not join them, which is
  // why it is a separate call rather than the tail of one list.
  const publisher = await readFile(new URL("../tools/publish-paper-state.py", import.meta.url), "utf8");
  assert.match(publisher, /segments = declared_segments\(state_file\)/);
  const coreUpload = publisher.indexOf("publish_serially([state_file]");
  assert.ok(coreUpload > 0, "the core must be published on its own");
  for (const call of ["publish_in_parallel(segments", "publish_serially(segments"]) {
    assert.ok(
      publisher.indexOf(call) > 0 && publisher.indexOf(call) < coreUpload,
      `${call} must run before the core is published`,
    );
  }
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
  // What matters is that nothing escapes the loop, not that the word never appears: an
  // in-band `statusError` raised inside the try is caught by that same catch, which is
  // how a status the API reports in the body joins the path a network failure already
  // takes. So the check is that no throw survives past the catch.
  const afterCatch = runWaiter.slice(runWaiter.indexOf("catch (error) {"));
  assert.ok(!/throw /.test(afterCatch), "waitForWorkflowRun must not throw out of its loop");
  assert.match(runWaiter, /catch \(error\) \{[\s\S]{0,200}?lastError = error;/,
    "a failed poll must be recorded and the loop continue");
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
  assert.equal(report.taxonomyVersion, 6);
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
    // Two points wide, so the entry above had something to trade against. Without a
    // recorded spread the row cannot show it had a counterparty and the statistics leave
    // it out, which is a different exclusion from the one this test is about.
    firstSpread: 0.02,
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
    // Tradable when it was scraped, so the statistics count it. A row with no recorded
    // spread is held back for a different reason than anything this test is checking.
    firstSpread: 0.02,
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
  assert.equal(report.parameterSummaries.length, 300,
    "3 market types x 10 thresholds x 5 horizons, each as a floor row and a bounded row");
  for (const threshold of [0.55, 0.65, 0.75, 0.85, 0.95]) {
    assert.ok(report.parameterSummaries.some((row) => row.threshold === threshold), `${threshold * 100}% must be included`);
  }
  assert.ok(report.parameterSummaries.every((row) => !Object.hasOwn(row, "minLiquidityUsdc")));
  // Every rule appears twice and the pair must differ in exactly one way: the floor row is
  // open above, the band row stops ten points up. Anything else would be a duplicate.
  for (const row of report.parameterSummaries) {
    assert.equal(row.probabilityRange, row.maxProbability == null ? "floor" : "band");
    if (row.maxProbability != null) {
      assert.ok(Math.abs(row.maxProbability - Math.min(1, row.threshold + 0.1)) < 1e-9,
        `a bounded ${row.threshold} row must end ten points up, not at ${row.maxProbability}`);
    }
  }
  const widest = report.parameterSummaries.find((row) => row.marketType === "all"
    && row.threshold === 0.5
    && row.maxResolutionDays === 30
    && row.maxProbability == null);
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
    firstSpread: 0.02,
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
  for (const key of ["label",
    // A floor row is dominated by entries far above it -- 60% floor, 79% average entry, a
    // 90.5% headline against a 64.9% band -- so a bounded row is emitted beside every
    // floor and this column is what tells the two apart. Sorting by it is how a
    // floor-and-reward/risk portfolio finds the range it will actually trade.
    "probabilityRange",
    "openCount", "trades", "accuracy", "pnl",
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
    firstSpread: 0.02,
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
  // Each rung of the ladder is reported twice: once open above its floor, once bounded ten
  // points up. The floor row answers "what did everything above 90% do", the bounded one
  // answers "what did 90-100% do" -- and for a portfolio that ranks by reward/risk above a
  // floor, only the second is the range it will really buy in.
  assert.deepEqual(
    football?.minimumProbabilitySummaries?.map((row) => [row.minimumProbability, row.probabilityRange]),
    [[0.5, "floor"], [0.5, "band"], [0.6, "floor"], [0.6, "band"], [0.7, "floor"], [0.7, "band"],
      [0.8, "floor"], [0.8, "band"], [0.9, "floor"], [0.9, "band"]],
    "every tag needs the normalized 50%-90% ladder, each rung as a floor and a bounded row",
  );
  const footballAtNinety = football?.minimumProbabilitySummaries
    ?.find((row) => row.minimumProbability === 0.9 && row.probabilityRange === "floor");
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
  // Live rows still go first so bounded downstream steps keep them. They now share that
  // head with the two other uncursored passes, and liveMarkets stays the first argument,
  // so a market that is live and also resolving next keeps the live position.
  assert.match(source, /const priorityMarkets = mergeMarketLists\(liveMarkets, frontierMarkets, highVolumeMarkets\);/,
    "live rows go first so bounded downstream steps keep them");
  assert.match(source, /const fetchedMarkets = mergeMarketLists\(priorityMarkets, rotatingMarkets\);/,
    "the priority passes precede the rotating scope");
  // The passes overlap by design, so this has to merge rather than concatenate: a market
  // found by more than one pass must be counted, audited and retained exactly once.
  assert.ok(
    !/const fetchedMarkets = \[\.\.\./.test(source),
    "concatenating the passes would count an overlapping market once per pass",
  );

  // normalizeMarketScan is a whitelist; unlisted fields never reach the published state.
  for (const field of [
    "liveScanEnabled", "liveScanWindowHours", "liveScanCount", "liveScanCounts", "liveScanError",
    "frontierScanEnabled", "frontierScanCount", "frontierScanError",
    "highVolumeScanEnabled", "highVolumeScanCount", "highVolumeScanError",
    "priorityScanBatchLimit", "endDateGraceHours",
  ]) {
    assert.ok(
      new RegExp(`${field}: `).test(source.slice(source.indexOf("function normalizeMarketScan"), source.indexOf("function normalizeMarketScanHistory"))),
      `${field} must be whitelisted in normalizeMarketScan or it is silently dropped`,
    );
  }
  const scan = bot.normalizeState({
    marketScan: {
      liveScanCount: 7,
      liveScanCounts: { sports: 5, esports: 2 },
      frontierScanCount: 11,
      highVolumeScanCount: 13,
    },
  }).marketScan;
  assert.equal(scan.liveScanCount, 7);
  assert.deepEqual(scan.liveScanCounts, { sports: 5, esports: 2 });
  assert.equal(scan.frontierScanCount, 11);
  assert.equal(scan.highVolumeScanCount, 13);
});

test("scan ordering: the two priority passes ask for the orderings the probe verified", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");

  // Measured by tools/gamma-ordering-probe.mjs against the live API, not assumed: `order`
  // and `ascending` are honoured on events/keyset, survive the scan's end-date bounds and
  // survive after_cursor pagination. The rotating scope pages away from the head, so these
  // uncursored passes are what keep "nearest resolution first" true on every run.
  assert.match(source, /order: "endDate",\n\s+ascending: "true",/);
  assert.match(source, /order: "volume24hr",\n\s+ascending: "false",/,
    "the volume pass must rank on money moving now, not on lifetime turnover");

  // Both passes go through scanEventRequestParams, so they inherit the end-date bounds
  // and the liquidity floor. Ordering by endDate with no lower bound is what put
  // months-old closed events at the head of every page.
  const frontier = bot.scanEventRequestParams({ order: "endDate", ascending: "true" });
  assert.ok(frontier.end_date_min, "the frontier pass needs the lower end-date bound");
  assert.equal(frontier.order, "endDate");
  assert.equal(frontier.ascending, "true");
  const volume = bot.scanEventRequestParams({ order: "volume24hr", ascending: "false" });
  assert.ok(volume.end_date_min, "the volume pass must stay inside the resolution window");
  assert.equal(volume.ascending, "false");

  // A failure in either pass is logged and dropped, exactly as for the live pass: the
  // catalogue scan is the job that must keep working.
  assert.match(source, /Nearest-resolution scan failed \(\$\{frontierScanError\}\); continuing without it\./);
  assert.match(source, /Highest-volume scan failed \(\$\{highVolumeScanError\}\); continuing without it\./);
});

test("scan ordering: the probe that justified this stays read-only", async () => {
  const { readFile } = await import("node:fs/promises");
  const workflow = await readFile(new URL("../../.github/workflows/trading-gamma-ordering-probe.yml", import.meta.url), "utf8");
  const body = workflow.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
  // It reaches a third-party API from a runner, so it must stay unable to touch anything.
  for (const forbidden of ["secrets.", "ftplib", "storbinary", "HOSTING_", "upload-artifact"]) {
    assert.ok(!body.includes(forbidden), `the probe must not use ${forbidden}`);
  }
  assert.match(body, /permissions:\n\s+contents: read/);
  assert.match(body, /on:\n\s+workflow_dispatch:/);
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
    // A quote something could be traded against. Without one the candidate is rejected
    // for the spread rather than for its market type, and this test would pass for the
    // wrong reason.
    spread: 0.02,
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
  // The two shipped live portfolios plus any created ones, archived entries dropped.
  assert.match(app, /const liveModes = \["live", "live-5050", \.\.\.customLiveModes\]\.filter\(\(mode\) => !portfolioIsArchived\(mode\)\);/,
    "it needs its own tab");
  assert.match(html, /data-mode-switch/, "and a container the script can rebuild");
  assert.match(app, /const LIVE_MODES = new Set\(\["live", "live-5050"\]\);/);
  // Delegated, so a created live portfolio counts as live everywhere at once rather than
  // at each of the places that used to test the two shipped ids by hand.
  assert.match(app, /function isLiveMode\(\) \{\n  return isLivePortfolioMode\(state\.mode\);\n\}/,
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
  // Which loader runs follows the classification, not the two shipped ids -- a created
  // live portfolio would otherwise be sent to the paper loader and show paper data.
  assert.match(app, /return isLivePortfolioMode\(requestedMode\)\n\s*\? loadLiveState\(/,
    "a live portfolio must load live data");
  assert.ok(!/return requestedMode === "live"\n\s*\? loadLiveState/.test(app));

  // Overview finances come from the shared Polymarket account, as they must --
  // there is one wallet -- but orders, positions and the run log are attributed.
  assert.match(app, /function submittedTokenIds\(executionState\)/);
  // The mode is a parameter now, so the optimisation report can ask about a live
  // portfolio other than the selected one, but the either/or is unchanged.
  assert.match(app, /const wantsFixedEntry = isFixedEntryMode\(mode\);/);
  assert.match(app, /return wantsFixedEntry \? owned : !owned;/,
    "each token shows under exactly one of the two live portfolios");
  assert.match(app, /\.filter\(belongsToActiveLivePortfolio\)/);
  assert.match(app, /!isFixedEntryMode\(\) && Array\.isArray\(state\.liveState\?\.runLog\)/,
    "and 5050's run log is its own");

  // A token nobody claims belongs to Live: attribution must never hide a row from
  // both tabs, and a failed fetch must not reassign 5050's positions wholesale.
  assert.match(app, /if \(!tokenId\) return !wantsFixedEntry;/);
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
    // A created live portfolio owns its own settings too, so reading a mode's config now
    // asks whether the mode names one before it falls through to the paper branch. That
    // fall-through is exactly the bug this test was written for.
    pick(/function customLivePortfolioIdFromMode\(mode = state\.mode\)[\s\S]*?\n\}/),
    pick(/function isLivePortfolioMode\(mode = state\.mode\)[\s\S]*?\n\}/),
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
  assert.match(app, /function liveClosedTrades\(liveState, mode = state\.mode\) \{[\s\S]*?belongsToLivePortfolio\(row, mode\)\);/);
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
  assert.match(app, /renderPortfolioRulesCard\(`\$\{portfolioNameForMode\(\)\} portfolio`/);

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
    // One narrow exception, and only this one: the live initial capital. Every other
    // question here is "is this a live portfolio?", which must be asked of the set. The
    // deposited baseline is a different question -- it belongs to the main Live portfolio
    // alone, because only that one is funded by the wallet's own deposits, which is why
    // liveInitialCapitalForMode() itself returns null for any other mode. Excluding 5050
    // there is the intent rather than the bug, and the allowance is tied to the helper's
    // name so it cannot quietly cover anything else.
    if (/liveInitialCapital/.test(line)) return;
    if (/normalizeMode\([^)]*\)\s*===\s*"live"/.test(line)
      || /\bnormalizedMode\s*===\s*"live"(?!-)/.test(line)) {
      offenders.push(`app.js:${i + 1} — ${line.trim()}`);
    }
  });
  assert.deepEqual(offenders, [],
    `these compare against "live" alone and so exclude 5050:\n${offenders.join("\n")}`);

  // The two that matter most, pinned by name.
  assert.match(app, /function renderKnownStateForMode\(mode = state\.mode\) \{\n\s*if \(isLivePortfolioMode\(mode\)\) \{/,
    "the pre-load render must not fall through to the paper renderer");
  assert.match(app, /function portfolioForMode\(mode = state\.mode\) \{\n\s*if \(isLivePortfolioMode\(mode\)\)/);

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
  assert.match(app, /function currentExecutionTarget\(\) \{\n\s*return state\.mode;\n\}/);
  assert.match(app, /if \(button\.dataset\.oneTimeExecution === "current"\) return currentExecutionTarget\(\);/);
  assert.match(api, /'live-5050' => \[\n\s*'workflow' => 'trading-live-5050\.yml',/);

  // The result watcher must read the portfolio's own execution state, or it would
  // report another portfolio's run as this one's outcome.
  assert.match(app, /return isFixedEntryMode\(mode\) \? "live-5050-execution" : "live-execution";/);

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
  assert.match(app, /const sendsShortlist = live && target !== "live-5050";/);
  // Wrapped, because it is an optimisation: the runner rebuilds its own shortlist from the
  // same published catalogue, so a refresh that fails must degrade the run rather than
  // cancel it. It used to throw straight out of the click, showing an error and
  // dispatching nothing.
  assert.match(app, /try \{\n\s+workflowPayload = await freshLiveWorkflowPayload\(target\);\n\s+\} catch \(error\) \{/);
  assert.match(app, /if \(sendsShortlist && workflowPayload\) \{\n\s*\/\/ Name the shortlist that was actually submitted/);

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
    pick(/function belongsToLivePortfolio\([\s\S]*?\n\}/),
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
  assert.match(app, /const ownOrderReservation = reservedByOpenOrders\(openOrderRows\);/);
  assert.match(app, /const freeCash = Number\.isFinite\(cash\) \? Math\.max\(0, cash - ownOrderReservation\) : null;/);
  // The wallet total is still computed, so the tile can say how much of the balance the
  // other portfolio has spoken for rather than quietly overstating what is spendable.
  // Hoisted to module scope so the overview table and this tile cannot answer the same
  // question two different ways.
  assert.match(app, /const walletOrderRisk = reservedByOpenOrders\(liveState\?\.openOrders\);/);
  assert.match(app, /const otherPortfolioReservation = Math\.max\(0, walletOrderRisk - ownOrderReservation\);/);
  assert.match(app, /locked by the other portfolio/);

  // Unchanged: risk is what THIS portfolio has committed, and the wallet-wide position
  // total must not stand in for it.
  assert.match(app, /const ownPositionRisk = positions\.reduce\(/);
  assert.match(app, /els\.portfolioRisk\.textContent = money\(ownPositionRisk \+ openOrderRisk\);/);
  assert.ok(!/portfolio\.openRiskUsdc \|\| 0\) \+ openOrderRisk/.test(app),
    "the wallet-wide position total must not stand in for a portfolio's own");
  // A resting sell releases collateral rather than reserving it.
  assert.match(app, /\.filter\(\(order\) => !String\(order\?\.side \|\| ""\)\.toUpperCase\(\)\.includes\("SELL"\)\)/);
  // A cancelled or filled order still in the snapshot reserves no collateral.
  assert.match(app, /TERMINAL_ORDER_STATUSES\.has\(String\(order\?\.rawStatus \|\| order\?\.status \|\| ""\)\.toUpperCase\(\)\)/);
  // Orders carry notionalUsdc from the sync; the others are fallbacks.
  assert.match(app, /Number\(order\?\.notionalUsdc \?\? order\?\.totalCostUsdc \?\? order\?\.stakeUsdc\)/);

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
  // portfolioNameForMode and normalizeMode are supplied the same way isFixedEntryMode
  // already is: this harness is about the shape of the rows, and the naming chain reaches
  // the whole saved config. The label still has to be the portfolio's own -- the assertion
  // below is that a 5050 run is not labelled "Live" -- so the stub answers per mode rather
  // than returning a constant.
  return new Function("state", "isFixedEntryMode", "liveBatchCandidateSummaryFromExecution",
    "portfolioReturnMetricLabel", "portfolioNameForMode", "normalizeMode",
    `${body}\nreturn liveRunLogRows;`)(
    {
      liveState: null,
      liveExecutionState: executionState,
      mode: fixedEntry ? "live-5050" : "live",
      dispatchFailuresByMode: {},
    },
    () => fixedEntry,
    (item) => item,
    () => "",
    (mode = fixedEntry ? "live-5050" : "live") => (String(mode) === "live-5050" ? "5050" : "Live"),
    (mode) => String(mode || ""),
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
    "belongsToLivePortfolio", "belongsToActiveLivePortfolio", "isClosedTrade", "liveClosedTrades", "liveOpenOrders"]
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
    // The state file is named on the command line in the live workflow now, because it
    // follows whichever live portfolio the run is executing.
    assert.match(workflow, /run: (?:\w+="[^"]*" )*python3 trading\/tools\/persist-live-revalidation\.py/,
      `${file} must persist its verdicts`);
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
    "isFilledPortfolioRow", "boughtAtFixedEntryPrice", "belongsToLivePortfolio", "belongsToActiveLivePortfolio",
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
    "isFilledPortfolioRow", "boughtAtFixedEntryPrice", "belongsToLivePortfolio", "belongsToActiveLivePortfolio",
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
  assert.ok(crons.length >= 2, `expected at least two schedule entries, got ${JSON.stringify(crons)}`);
  const minutesOf = (cron) => cron.split(" ")[0].split(",").map(Number);

  // Two entries firing in the same minute would collide on the shared lock and one of them
  // would be the run GitHub drops, so which scope gets scanned would be down to timing.
  const all = crons.flatMap(minutesOf).sort((a, b) => a - b);
  assert.equal(new Set(all).size, all.length,
    `the schedule entries must not collide: ${JSON.stringify(crons)}`);
  // And they must be spread, not bunched: the gap between consecutive firings is what
  // gives a whole scrape-and-execute cycle time to publish before the next one starts.
  const gaps = all.slice(1).map((minute, index) => minute - all[index]);
  assert.ok(Math.min(...gaps) >= 5, `five minutes apart is the floor GitHub allows: ${JSON.stringify(all)}`);

  // The tag is chosen from which entry fired, so every cron string the chooser names has
  // to be one the schedule really carries -- edit one without the other and a scheduled run
  // silently falls through to scanning the wrong scope, or none.
  const chooser = /PAPER_MARKET_SCAN_TAG: ([^\n]+)/.exec(scan);
  assert.ok(chooser, "the scheduled tag chooser must be present");
  const named = [...chooser[1].matchAll(/github\.event\.schedule == '([^']+)'/g)].map((match) => match[1]);
  assert.ok(named.length >= 1, `the chooser must name the entries it selects on: ${chooser[1]}`);
  for (const cron of named) {
    assert.ok(crons.includes(cron), `the chooser names ${cron}, which is not one of ${JSON.stringify(crons)}`);
  }
  // Sports and esports each get their own slot, and they are not the same slot.
  for (const tag of ["sports", "esports"]) {
    assert.match(chooser[1], new RegExp(`'${tag}'`), `${tag} must have a scheduled slot`);
  }
  assert.equal(new Set(named).size, named.length, "two tags may not be selected on the same entry");
  // At least one entry stays untagged, or the broad catalogue cursor never advances.
  assert.ok(named.length < crons.length,
    `one entry must stay untagged for the broad scan: ${JSON.stringify(crons)} vs ${JSON.stringify(named)}`);
});

test("scheduled scan: a scheduled pass stays small and does not fan out", async () => {
  const { readFile } = await import("node:fs/promises");
  const [scan, bot] = await Promise.all([
    readFile(new URL("../../.github/workflows/trading-market-scan.yml", import.meta.url), "utf8"),
    readFile(new URL("../../.github/workflows/trading-paper-bot.yml", import.meta.url), "utf8"),
  ]);

  // The filters the opportunities page was already scanning with. They belong to the
  // short-dated tag slots -- the ones that exist to keep liquid sports and esports fresh --
  // and must not be imposed on the broad slot, whose job is to advance the category cursor
  // across the whole catalogue. A dispatch always overrides both.
  for (const [name, tight] of [["PAPER_MARKET_SCAN_LIQUIDITY_MIN", "40000"], ["PAPER_MARKET_SCAN_MAX_DAYS", "2"]]) {
    const line = new RegExp(`${name}: ([^\\n]+)`).exec(scan);
    assert.ok(line, `${name} must be set`);
    assert.match(line[1], /^\$\{\{ inputs\.market_scan_\w+ \|\|/, `${name} must let a dispatch override it`);
    assert.match(line[1], new RegExp(`'${tight}'`), `${name} must apply ${tight} to the tag slots`);
    // It is selected on the same entries the tag chooser selects on, never on all of them:
    // `github.event.schedule && ...` would catch the broad slot too.
    assert.doesNotMatch(line[1], /github\.event\.schedule &&/,
      `${name} must name the tag slots rather than every scheduled run`);
  }
  // The slots those filters name are the slots the tag chooser names, or one of them scans
  // a tag with the wrong filters.
  const tagSlots = new Set([...(/PAPER_MARKET_SCAN_TAG: [^\n]+/.exec(scan) || [""])[0]
    .matchAll(/github\.event\.schedule == '([^']+)'/g)].map((match) => match[1]));
  for (const name of ["PAPER_MARKET_SCAN_LIQUIDITY_MIN", "PAPER_MARKET_SCAN_MAX_DAYS"]) {
    const line = new RegExp(`${name}: ([^\\n]+)`).exec(scan)[1];
    const slots = new Set([...line.matchAll(/github\.event\.schedule == '([^']+)'/g)].map((match) => match[1]));
    assert.deepEqual([...slots].sort(), [...tagSlots].sort(),
      `${name} must apply to exactly the slots that carry a tag`);
  }

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
    "isFilledPortfolioRow", "boughtAtFixedEntryPrice", "belongsToLivePortfolio", "belongsToActiveLivePortfolio",
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
  // Matched across the filter chain rather than as one expression: the same reader also
  // drops segments a pass carries over untouched, so the two filters sit on separate lines.
  assert.match(source, /Object\.keys\(manifest\)[\s\S]{0,200}?!DERIVED_STATE_SEGMENTS\.has\(name\)/,
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

// Reported: a manual execution of one portfolio took 8m41s, all of it inside the single
// "Run paper bot" step, with a stated ceiling of one minute for the whole thing. The cost
// was not computation. Every network loop in the pass was `for (...) await fetch(...)`:
// one Polymarket round trip is a third of a second of waiting and no work, and a pass
// makes hundreds of them -- up to 420 slug lookups for resolution status alone, each of
// which is up to two requests, plus one per open position and one per shortlisted
// candidate. Sequentially that is minutes of an idle process.
//
// Overlapping them is only safe if it cannot reorder anything, because several callers
// zip the results back against their input by index and one produces the list the
// ranking runs on.
test("performance: overlapping requests never reorders the results", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");
  // functionSource matches from `function <name>(`, so an async declaration arrives
  // without its keyword; put it back or the awaits inside are a syntax error.
  const mapWithConcurrency = new Function(
    `async ${functionSource(source, "mapWithConcurrency")}\nreturn mapWithConcurrency;`,
  )();

  // Deliberately inverted latency: the last item finishes first. Completion order and
  // input order are as different as they can be.
  const items = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const completion = [];
  let inFlight = 0;
  let peak = 0;
  const results = await mapWithConcurrency(items, async (value) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, (items.length - value) * 4));
    inFlight -= 1;
    completion.push(value);
    return value * 10;
  }, 4);

  assert.deepEqual(results, items.map((value) => value * 10), "results come back in input order");
  assert.notDeepEqual(completion, items, "and the test is only meaningful because completion order differed");
  assert.ok(peak > 1, "requests really do overlap");
  assert.ok(peak <= 4, `the cap is honored, saw ${peak} in flight`);

  // The index is passed through, so a caller can write results back positionally.
  const indexes = await mapWithConcurrency(["a", "b", "c"], async (value, index) => `${index}:${value}`, 2);
  assert.deepEqual(indexes, ["0:a", "1:b", "2:c"]);
});

test("performance: a slug is fetched once per pass, and a failure is not remembered", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");
  // The real cache and the real wrapper, with only the HTTP call replaced.
  const calls = [];
  let fail = false;
  const build = new Function(
    "fetchMarketBySlugUncached",
    `const marketBySlugCache = new Map();\nasync ${functionSource(source, "fetchMarketBySlug")}\n`
    + "return { fetchMarketBySlug, size: () => marketBySlugCache.size };",
  );
  const { fetchMarketBySlug, size } = build(async (slug) => {
    calls.push(slug);
    if (fail) throw new Error("gamma is down");
    return { slug, question: `Q for ${slug}` };
  });

  // Four callers, two markets: the pattern a real pass makes when the resolution sync, the
  // position marking and the candidate revalidation all touch the same markets.
  const [a, b, c, d] = await Promise.all([
    fetchMarketBySlug("alpha"),
    fetchMarketBySlug("beta"),
    fetchMarketBySlug("alpha"),
    fetchMarketBySlug("beta"),
  ]);
  assert.deepEqual(calls, ["alpha", "beta"], "each market is looked up once, even concurrently");
  assert.equal(a.question, c.question);
  assert.equal(b.question, d.question);
  assert.equal(size(), 2);

  // A blank slug is not a market and must not occupy a cache slot.
  assert.equal(await fetchMarketBySlug(""), null);
  assert.equal(size(), 2);

  // A transient failure must not become this pass's permanent answer for that market.
  fail = true;
  await assert.rejects(() => fetchMarketBySlug("gamma"), /gamma is down/);
  assert.equal(size(), 2, "a rejected lookup is evicted");
  fail = false;
  assert.equal((await fetchMarketBySlug("gamma")).slug, "gamma", "so it can be retried");
});

test("performance: deciding the sort key once orders exactly as comparing twice did", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");
  const build = (body) => new Function(
    "evaluationUpdateTime", "evaluationKey", `${body}\nreturn latestUniqueExecutionEvaluations;`,
  );
  const evaluationUpdateTime = new Function(`${functionSource(source, "evaluationUpdateTime")}\nreturn evaluationUpdateTime;`)();
  const evaluationKey = new Function(`${functionSource(source, "evaluationKey")}\nreturn evaluationKey;`)();
  const fast = build(functionSource(source, "latestUniqueExecutionEvaluations"))(evaluationUpdateTime, evaluationKey);
  // The shape this replaced: the timestamp recomputed on both sides of every comparison.
  const slow = build(`function latestUniqueExecutionEvaluations(evaluations = []) {
    const byKey = new Map();
    const ordered = [...evaluations].sort((a, b) => evaluationUpdateTime(b) - evaluationUpdateTime(a));
    for (const item of ordered) {
      const key = evaluationKey(item);
      if (!key || byKey.has(key)) continue;
      byKey.set(key, item);
    }
    return [...byKey.values()];
  }`)(evaluationUpdateTime, evaluationKey);

  // Includes the cases that decide ordering: ties, rows dated by different fields, rows
  // with no date at all, duplicate keys and unkeyable rows.
  const rows = [];
  for (let i = 0; i < 400; i += 1) {
    const at = new Date(Date.UTC(2026, 7, 1 + (i % 17), i % 24)).toISOString();
    const field = ["evaluatedAt", "lastSeenAt", "marketDataUpdatedAt", "updatedAt"][i % 4];
    rows.push({ tokenId: String(i % 130), [field]: at, id: `row-${i}` });
  }
  rows.push({ tokenId: "7" }, { slug: "s", outcome: "Yes" }, { id: "" }, {});

  const fromFast = fast(rows);
  const fromSlow = slow(rows);
  assert.deepEqual(
    fromFast.map((item) => item.id ?? null),
    fromSlow.map((item) => item.id ?? null),
    "same rows kept, in the same order",
  );
  assert.ok(fromFast.length > 100, "the fixture really does exercise the dedupe");
});

// Reported after an earlier attempt at this: "preoptimalizovano" -- no suitable candidate
// found although dozens were available. Resolved rows were the reason. They outnumber the
// live catalogue several times over, they share a dedupe key with it, and the dedupe keeps
// whichever row is newer -- so a market scanned again while its resolved twin sat in the
// archive collapsed to the resolved twin, and a tradable candidate vanished. They were
// never eligible in the first place: portfolioFilterResult rejects a resolved row twice.
test("execution candidates: a resolved twin can no longer shadow a live market", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");
  const observationIsResolved = new Function(`${functionSource(source, "observationIsResolved")}\nreturn observationIsResolved;`)();
  const executionCandidateObservations = new Function(
    "observationIsResolved",
    `${functionSource(source, "executionCandidateObservations")}\nreturn executionCandidateObservations;`,
  )(observationIsResolved);

  const state = {
    marketObservations: [
      { tokenId: "1", status: "SCRAPED", marketDataUpdatedAt: "2026-08-20T09:00:00Z", id: "live" },
      // Same token, settled, and checked more recently than the live row was scanned.
      { tokenId: "1", status: "RESOLVED", marketDataUpdatedAt: "2026-08-20T10:00:00Z", id: "twin" },
      { tokenId: "2", selectionStatus: "RESOLVED", id: "old" },
      { tokenId: "3", status: "SCRAPED", id: "other" },
    ],
  };
  const scanned = executionCandidateObservations(state);
  assert.deepEqual(scanned.map((item) => item.id), ["live", "other"], "only unsettled rows are scanned");

  // And the shadowing itself: with the twin present the newer resolved row won the key.
  const evaluationUpdateTime = new Function(`${functionSource(source, "evaluationUpdateTime")}\nreturn evaluationUpdateTime;`)();
  const evaluationKey = new Function(`${functionSource(source, "evaluationKey")}\nreturn evaluationKey;`)();
  const latestUnique = new Function(
    "evaluationUpdateTime", "evaluationKey",
    `${functionSource(source, "latestUniqueExecutionEvaluations")}\nreturn latestUniqueExecutionEvaluations;`,
  )(evaluationUpdateTime, evaluationKey);
  assert.equal(
    latestUnique(state.marketObservations).find((item) => item.tokenId === "1").id,
    "twin",
    "the unfiltered pool really did hand back the settled row",
  );
  assert.equal(
    latestUnique(scanned).find((item) => item.tokenId === "1").id,
    "live",
    "and filtering first is what puts the tradable one back in the shortlist",
  );
});

test("execution candidates: no resolved row has ever been eligible for any portfolio", async () => {
  // The premise the filtering above rests on. If a resolved row could pass, dropping it
  // would be a change of decision rather than of cost.
  const strategy = {
    id: "conservative",
    label: "Conservative",
    minProbability: 0.5,
    minLiquidityUsdc: 0,
    minNetYield: 0,
    maxResolutionDays: 365,
    probabilitySource: "polymarket",
    marketType: "all",
    excludedCandidateTokenIds: new Set(),
  };
  const settled = {
    tokenId: "1",
    status: "RESOLVED",
    slug: "already-over",
    outcome: "Yes",
    marketPrice: 0.9,
    liquidity: 100000,
    volumeUsdc: 100000,
    endDate: "2026-01-01T00:00:00Z",
    finalOutcomePrice: 1,
  };
  const result = bot.portfolioFilterResult
    ? bot.portfolioFilterResult(settled, strategy)
    : null;
  if (result) {
    assert.equal(result.eligible, false);
    assert.ok(
      result.reasons.some((reason) => /not executable|is in the past/.test(reason)),
      `expected a resolved row to be refused, got ${JSON.stringify(result.reasons)}`,
    );
  } else {
    // Not exported: assert the rules exist in the source instead of skipping silently.
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");
    assert.match(source, /base status \$\{status \|\| "UNKNOWN"\} is not executable/);
    assert.match(source, /"event end date is in the past"/);
  }
});

// The resolved archive is the largest thing this bot stores -- around 143 MB against
// roughly 100 MB for everything else together -- and an execution pass has no business
// with it: rows only enter it when the resolution sync settles a market, which an
// execution pass does not run, and no resolved row can be a candidate. Downloading it and
// uploading it back unchanged was most of a run's transfer budget spent reproducing a file
// byte for byte.
//
// Carrying it over is only correct if the manifest entry survives verbatim and nothing is
// written over the file. Getting either half wrong replaces tens of thousands of settled
// markets with an empty array, so all three cases are pinned here.
function splitUnderEnv(env, payload) {
  const modulePath = new URL("../tools/paper-trading-bot.mjs", import.meta.url).href;
  const script = `
    import { splitStateIntoSegments, rememberStateSegmentManifest } from ${JSON.stringify(modulePath)};
    const input = JSON.parse(process.argv[1]);
    rememberStateSegmentManifest(input.manifest);
    const { core, segments } = splitStateIntoSegments(input.state);
    process.stdout.write(JSON.stringify({
      manifest: core.stateSegments,
      segmentNames: Object.keys(segments),
    }));
  `;
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(payload)], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  }));
}

test("state segments: an execution pass hands the resolved archive back instead of rewriting it", () => {
  // What a real read finds on the hosting: an archive of 24,000 settled markets and the
  // capped page derived from it.
  const manifest = {
    observations: { file: "paper-state.observations.json", fields: ["marketObservations", "marketScan"] },
    resolvedObservations: {
      file: "paper-state.resolvedObservations.json",
      fields: ["resolvedMarketObservations"],
      counts: { resolvedMarketObservations: 24000 },
      mergesInto: "marketObservations",
    },
    resolvedRecent: {
      file: "paper-state.resolvedRecent.json",
      fields: ["resolvedMarketObservations"],
      counts: { resolvedMarketObservations: 3000 },
      mergesInto: "marketObservations",
      truncatedFrom: 24000,
    },
  };
  // And what the pass holds: the active catalogue only, because it never fetched the rest.
  const state = { marketObservations: [{ id: "a1", status: "SCRAPED" }, { id: "a2", status: "SCRAPED" }] };

  const carried = splitUnderEnv({ PAPER_EXECUTION_ONLY: "true" }, { manifest, state });
  assert.equal(
    carried.segmentNames.includes("resolvedObservations"), false,
    "the archive must not be written from a state that never read it",
  );
  assert.equal(carried.segmentNames.includes("resolvedRecent"), false, "nor the page derived from it");
  assert.equal(carried.manifest.resolvedObservations.carriedOver, true);
  assert.equal(carried.manifest.resolvedObservations.file, "paper-state.resolvedObservations.json");
  assert.equal(
    carried.manifest.resolvedObservations.counts.resolvedMarketObservations, 24000,
    "the count stays the hosted file's own, not this pass's empty view of it",
  );
  assert.equal(carried.manifest.resolvedRecent.carriedOver, true);
  assert.equal(carried.manifest.resolvedRecent.truncatedFrom, 24000);
  // The active catalogue is still this pass's job and is still written.
  assert.ok(carried.segmentNames.includes("observations"));

  // A pass that does maintain the archive writes it, and says nothing about carrying over.
  const full = splitUnderEnv({ PAPER_EXECUTION_ONLY: "false", PAPER_MANUAL_RUN_ONCE: "false" }, { manifest, state });
  assert.ok(full.segmentNames.includes("resolvedObservations"), "a full pass writes the archive");
  assert.ok(full.segmentNames.includes("resolvedRecent"));
  assert.equal(full.manifest.resolvedObservations.carriedOver, undefined);
  assert.equal(full.manifest.resolvedObservations.counts.resolvedMarketObservations, 0);
});

test("state segments: an execution pass that is holding resolved rows still publishes them", () => {
  // The safety catch. Whatever put them there -- a merged local snapshot, a mode
  // combination added later -- they are worth more than the saved transfer, and dropping
  // them silently is the failure this whole mechanism risks.
  const manifest = {
    resolvedObservations: {
      file: "paper-state.resolvedObservations.json",
      fields: ["resolvedMarketObservations"],
      counts: { resolvedMarketObservations: 24000 },
    },
    resolvedRecent: { file: "paper-state.resolvedRecent.json", fields: ["resolvedMarketObservations"] },
  };
  const state = {
    marketObservations: [
      { id: "a1", status: "SCRAPED" },
      { id: "r1", status: "RESOLVED", resolvedAt: "2026-08-01T00:00:00Z" },
    ],
  };
  const written = splitUnderEnv({ PAPER_EXECUTION_ONLY: "true" }, { manifest, state });
  assert.ok(written.segmentNames.includes("resolvedObservations"), "a held resolved row is written, not carried over");
  assert.equal(written.manifest.resolvedObservations.carriedOver, undefined);
  assert.equal(written.manifest.resolvedObservations.counts.resolvedMarketObservations, 1);
});

test("state segments: a carried-over entry needs a real file name to be honored", () => {
  // A manifest entry that does not name a publishable file cannot be handed back -- there
  // would be nothing on the hosting for readers to find.
  for (const broken of [{}, { file: "" }, { file: "../escape.json" }, { file: "not-json.txt" }]) {
    const result = splitUnderEnv({ PAPER_EXECUTION_ONLY: "true" }, {
      manifest: { resolvedObservations: broken, resolvedRecent: { file: "paper-state.resolvedRecent.json" } },
      state: { marketObservations: [{ id: "a1", status: "SCRAPED" }] },
    });
    assert.ok(
      result.segmentNames.includes("resolvedObservations"),
      `a manifest entry of ${JSON.stringify(broken)} must fall back to writing the segment`,
    );
  }
});

test("publisher: a carried-over segment is skipped, a missing one is still fatal", async () => {
  const { mkdtemp, writeFile: write } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "paper-publish-"));
  const publisher = new URL("../tools/publish-paper-state.py", import.meta.url).pathname;

  const core = (manifest) => JSON.stringify({ stateSegments: manifest });
  const probe = `
import json, sys
sys.path.insert(0, ${JSON.stringify(new URL("../tools", import.meta.url).pathname)})
import importlib.util
spec = importlib.util.spec_from_file_location("publisher", ${JSON.stringify(publisher)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
from pathlib import Path
try:
    print(json.dumps([p.name for p in module.declared_segments(Path(sys.argv[1]))]))
except SystemExit as error:
    print(json.dumps({"error": str(error)}))
`;
  const run = (file) => {
    const output = execFileSync("python3", ["-c", probe, file], { encoding: "utf8" });
    return JSON.parse(output.trim().split("\n").pop());
  };

  // Carried over: the file is deliberately absent, and that is not an error.
  const carriedPath = join(dir, "carried.json");
  await write(carriedPath, core({
    observations: { file: "seg.observations.json" },
    resolvedObservations: { file: "seg.resolvedObservations.json", carriedOver: true },
  }));
  await write(join(dir, "seg.observations.json"), "{}");
  assert.deepEqual(run(carriedPath), ["seg.observations.json"], "only what this run produced is uploaded");

  // Not carried over and missing: the writer was interrupted, and publishing the core
  // alone would orphan the catalogue.
  const brokenPath = join(dir, "broken.json");
  await write(brokenPath, core({ resolvedObservations: { file: "seg.resolvedObservations.json" } }));
  const failure = run(brokenPath);
  assert.match(String(failure.error), /was not generated/);
});

// What an execution pass is allowed to skip, and what it is not. The distinction is the
// whole basis of the one-minute budget, so it is pinned rather than left to a comment: a
// later edit that quietly moves the catalogue maintenance back into the order path would
// put the minutes back with no test to notice.
test("execution pass: skips catalogue maintenance and keeps every decision input", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");

  // Both routes into executeManualPaperRunFromStoredCandidates are the same kind of pass:
  // the scan's after-scrape dispatch, and the dashboard's per-portfolio button.
  assert.match(source, /const EXECUTION_PASS = EXECUTION_ONLY \|\| MANUAL_RUN_ONCE;/);

  // Skipped: maintenance of the record, none of which the decision reads.
  assert.match(source, /scanOnly \|\| EXECUTION_PASS\s*\?\s*expirePastEvaluations/,
    "the stored-evaluation resolution sync must not run on an execution pass");
  assert.match(source, /if \(!scanOnly && !EXECUTION_PASS\) \{\s*state\.marketObservations = await timed\("observationResolutionSync"/,
    "nor the stored-observation resolution sync");
  assert.match(source, /if \(!EXECUTION_PASS\) \{\s*try \{\s*const observations = await timed\("marketScan"/,
    "nor a fresh market scrape");
  assert.match(source, /if \(!EXECUTION_PASS\) \{\s*portfolioState\.trades = await reviewClosedTradesWithAi/,
    "nor the AI review of closed trades");
  // And it must not claim the scheduled full stage it deliberately did not do.
  assert.match(source, /if \(!REFRESH_ONLY && !EXECUTION_PASS && !EVALUATION_ONLY\) \{\s*markCadenceStage\(state, "full"\)/);

  // Kept: expiry still runs, because it is what stops a finished market being offered.
  const expiryLine = source.slice(source.indexOf("state.evaluations = (scanOnly"), source.indexOf("state.marketObservations = (state.marketObservations"));
  assert.match(expiryLine, /expirePastEvaluations\(state\.evaluations \|\| \[\]\)/);
  // Kept: positions are marked to market, which is what decides free capital, and every
  // shortlisted candidate is requoted immediately before the order.
  assert.match(source, /await timed\("refreshTrades", \(\) => mapWithConcurrency\(/);
  assert.match(source, /await timed\("candidateRevalidation", \(\) =>\s*revalidateStoredExecutionShortlist\(/);
  assert.ok(
    source.indexOf('timed("candidateRevalidation"') > 0
      && !/EXECUTION_PASS[^\n]*revalidateStoredExecutionShortlist/.test(source),
    "revalidation is never conditional on the pass mode",
  );

  // Caught on a real pass: the statistics report must not be rebuilt by a pass that did
  // not read the whole catalogue. Its performance half comes from the resolved archive,
  // which an execution pass carries over untouched, so recalculating it from the active
  // half alone drove sampleSize to 0 against 4,673 open observations -- the
  // empty-statistics symptom, reached from the other side. One full pass with this guard in
  // place put it back to 53,413. Carrying the previous report forward is exact: an
  // execution pass changes none of the observations it is built from.
  assert.match(source, /if \(!EXECUTION_PASS\) timedSync\("calculationReport", \(\) => updateCalculationReport\(state\)\);/,
    "only a pass that read the whole catalogue may recalculate the report");
  // And the report is what every statistics tab renders, so it has to stay in the core
  // where the dashboard summary -- which loads no segments at all -- can see it. Checked
  // by splitting a state rather than by reading the source: the comment explaining this
  // mentions the field by name, and a regex cannot tell that apart from a declaration.
  const split = bot.splitStateIntoSegments({
    latestCalculationReport: { id: "report-1", categorySummaries: [{ value: "sports" }] },
    calculationReports: [{ id: "report-1" }, { id: "report-0" }],
  });
  assert.equal(
    split.core.latestCalculationReport?.id, "report-1",
    "the report every statistics tab renders must stay in the core file",
  );
  assert.deepEqual(split.core.calculationReports, [], "the history beside it is what stays segmented");
  assert.equal(split.segments.reports?.calculationReports?.length, 2);
  assert.equal(split.segments.reports?.latestCalculationReport, undefined);

  // Every phase reports its own duration, so a run that misses the budget says which part
  // took it rather than leaving one number for the whole step.
  assert.match(source, /action: "PASS_TIMING"/);
  for (const phase of ["readState", "refreshTrades", "candidateShortlist", "candidateRevalidation", "writeState", "execution"]) {
    assert.ok(source.includes(`"${phase}"`), `the ${phase} phase must be timed`);
  }
});

// Once the bot itself stopped being the slow part, the upload was: a hundred megabytes of
// segments pushed one file after another over a single FTP session, each transfer leaving
// the connection idle for the round trips around it. The files are independent, so a few
// connections at once is the same set of uploads with the waiting overlapped.
//
// The one ordering that must survive is segments-before-core: the core carries the
// manifest that points at them, so publishing it first advertises data the hosting does
// not have yet.
test("publisher: segments upload together, the core strictly last", async () => {
  const { mkdtemp, writeFile: write } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "paper-publish-order-"));
  const publisher = new URL("../tools/publish-paper-state.py", import.meta.url).pathname;

  const manifest = {};
  for (const name of ["observations", "evaluations", "archives", "reports"]) {
    const file = `paper-state.${name}.json`;
    manifest[name] = { file };
    await write(join(dir, file), JSON.stringify({ [name]: [] }));
  }
  await write(join(dir, "paper-state.json"), JSON.stringify({ stateSegments: manifest }));

  // A fake FTP that records what was stored, when, and how many sessions were open at
  // once. Every transfer sleeps, so overlap is observable rather than inferred.
  const probe = `
import importlib.util, json, os, sys, threading, time

spec = importlib.util.spec_from_file_location("publisher", ${JSON.stringify(publisher)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

lock = threading.Lock()
order = []
live = {"now": 0, "peak": 0}

class FakeFTP:
    def __init__(self, host, timeout=None):
        with lock:
            live["now"] += 1
            live["peak"] = max(live["peak"], live["now"])
        self.closed = False
    def login(self, *a, **k): pass
    def cwd(self, *a, **k): pass
    def mkd(self, *a, **k): pass
    def storbinary(self, command, handle):
        name = command.split(" ", 1)[1]
        with lock:
            order.append(name)
        time.sleep(0.25)
    def size(self, name):
        return None
    def rename(self, *a, **k): pass
    def delete(self, *a, **k): pass
    def close(self):
        if self.closed:
            return
        self.closed = True
        with lock:
            live["now"] -= 1
    def __enter__(self): return self
    def __exit__(self, *a): self.close()

module.ftplib.FTP = FakeFTP
os.environ.update({
    "HOSTING_FTP_SERVER": "ftp.example",
    "HOSTING_FTP_USERNAME": "u",
    "HOSTING_FTP_PASSWORD": "p",
    "TRADING_FTP_DIR": "/www/trading/data",
    "PAPER_STATE_FILE": ${JSON.stringify(join(dir, "paper-state.json"))},
})
module.main()
print(json.dumps({"order": order, "peak": live["peak"]}))
`;
  const { execFileSync: run } = await import("node:child_process");
  const observed = JSON.parse(run("python3", ["-c", probe], { encoding: "utf8" }).trim().split("\n").pop());

  assert.equal(observed.order.length, 5, "four segments and the core");
  assert.ok(
    observed.order[observed.order.length - 1].startsWith("paper-state.json."),
    `the core must be stored last, got ${observed.order.join(", ")}`,
  );
  assert.ok(observed.peak > 1, "segments really do upload over more than one connection");
  assert.ok(observed.peak <= 4, `and no more than the cap, saw ${observed.peak}`);
});

test("publisher: a host that refuses extra sessions still publishes", async () => {
  const { mkdtemp, writeFile: write } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "paper-publish-refuse-"));
  const publisher = new URL("../tools/publish-paper-state.py", import.meta.url).pathname;

  const manifest = {};
  for (const name of ["observations", "evaluations"]) {
    const file = `paper-state.${name}.json`;
    manifest[name] = { file };
    await write(join(dir, file), "{}");
  }
  await write(join(dir, "paper-state.json"), JSON.stringify({ stateSegments: manifest }));

  // Shared hosting caps simultaneous FTP sessions. Being refused mid-publish must be
  // slower, not fatal -- one connection is what this always did.
  const probe = `
import importlib.util, ftplib, json, os, threading

spec = importlib.util.spec_from_file_location("publisher", ${JSON.stringify(publisher)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

lock = threading.Lock()
stored = []
state = {"open": 0, "refused": 0, "asked": 0}

class PickyFTP:
    def __init__(self, host, timeout=None):
        # Refuses the second session it is ever asked for, whichever thread asks. Counting
        # sessions currently open would be a race: one worker can finish and close before
        # another opens, and then nothing is refused and the test proves nothing.
        with lock:
            state["asked"] += 1
            if state["asked"] == 2:
                state["refused"] += 1
                raise ftplib.error_temp("421 too many connections")
            state["open"] += 1
    def login(self, *a, **k): pass
    def cwd(self, *a, **k): pass
    def mkd(self, *a, **k): pass
    def storbinary(self, command, handle):
        with lock:
            stored.append(command.split(" ", 1)[1].rsplit(".", 1)[0])
    def size(self, name): return None
    def rename(self, *a, **k): pass
    def delete(self, *a, **k): pass
    def close(self):
        with lock:
            state["open"] = max(0, state["open"] - 1)
    def __enter__(self): return self
    def __exit__(self, *a): self.close()

module.ftplib.FTP = PickyFTP
os.environ.update({
    "HOSTING_FTP_SERVER": "ftp.example",
    "HOSTING_FTP_USERNAME": "u",
    "HOSTING_FTP_PASSWORD": "p",
    "TRADING_FTP_DIR": "/www/trading/data",
    "PAPER_STATE_FILE": ${JSON.stringify(join(dir, "paper-state.json"))},
})
module.main()
print(json.dumps({"stored": stored, "refused": state["refused"]}))
`;
  const { execFileSync: run } = await import("node:child_process");
  const observed = JSON.parse(run("python3", ["-c", probe], { encoding: "utf8" }).trim().split("\n").pop());

  assert.ok(observed.refused > 0, "the fixture really did refuse a second session");
  for (const name of ["paper-state.observations.json", "paper-state.evaluations.json", "paper-state.json"]) {
    assert.ok(observed.stored.includes(name), `${name} must still be published`);
  }
});

// The run-log endpoint pages from 0, and asks the state for what the NDJSON archive does
// not have. Both were confirmed by a diagnostic reading page 1 for every portfolio and
// reporting "0 rows" for the three whose logs are shorter than one page -- which looked
// exactly like lost history and was only the second page of a short list. The response
// carried `total` all along.
//
// Driven through api.php itself against a fixture, because the paging arithmetic and the
// fallback are both in the handler rather than in a function a source assertion could
// reach.
test("run log endpoint: page 0 is the first page, and the state fills in for a missing archive", async () => {
  const { execFileSync: run } = await import("node:child_process");
  const { mkdtemp, mkdir, writeFile: write, copyFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const dir = await mkdtemp(join(tmpdir(), "paper-run-log-"));
  await copyFile(new URL("../api.php", import.meta.url).pathname, join(dir, "api.php"));
  await mkdir(join(dir, "data"), { recursive: true });

  // Thirty rows in the portfolio's own state segment and no archive directory at all --
  // the shape of a portfolio whose NDJSON history was lost or never written.
  const runLog = Array.from({ length: 30 }, (_, index) => ({
    runAt: new Date(Date.UTC(2026, 7, 1, index)).toISOString(),
    strategyId: "conservative",
    action: index % 2 ? "OPENED" : "SKIP",
    reason: `row ${index}`,
  }));
  await write(join(dir, "data", "paper-state.json"), JSON.stringify({
    schemaVersion: 2,
    generatedAt: "2026-08-21T10:00:00.000Z",
    // Compacted exactly as the writer leaves it: the real log is in the segment.
    paperPortfolios: { conservative: { id: "conservative", trades: [], runLog: [] } },
    stateSegments: {
      "portfolio:conservative": {
        file: "paper-state.portfolio-conservative.json",
        fields: ["paperPortfolio"],
        strategyId: "conservative",
        counts: { trades: 0 },
      },
    },
  }));
  await write(join(dir, "data", "paper-state.portfolio-conservative.json"), JSON.stringify({
    strategyId: "conservative",
    paperPortfolio: { id: "conservative", trades: [], runLog },
  }));

  const page = (index, size = 12) => JSON.parse(run("php", ["-r", `
    $_SERVER["REQUEST_METHOD"] = "GET";
    $_GET = ["action" => "portfolio-run-log", "strategy_id" => "conservative",
             "page" => "${index}", "page_size" => "${size}"];
    include ${JSON.stringify(join(dir, "api.php"))};
  `], { encoding: "utf8" }));

  const first = page(0);
  assert.equal(first.total, 30, "the state's own log is the fallback when no archive exists");
  assert.equal(first.records.length, 12, "page 0 is a full first page, not an offset one");
  assert.equal(first.page, 0);
  assert.equal(first.hasMore, true);
  // Newest first, so page 0 starts at the newest row.
  assert.equal(first.records[0].runAt, runLog[runLog.length - 1].runAt);

  const second = page(1);
  assert.equal(second.records.length, 12, "page 1 is the second page");
  assert.notEqual(second.records[0].runAt, first.records[0].runAt);

  const third = page(2);
  assert.equal(third.records.length, 6);
  assert.equal(third.hasMore, false);

  // A log shorter than one page has nothing on page 1. That is correct, and it is what
  // reads as lost history if `total` is ignored -- so the response states it.
  const short = page(0, 40);
  assert.equal(short.records.length, 30);
  assert.equal(short.hasMore, false);
  const beyond = page(1, 40);
  assert.equal(beyond.records.length, 0, "past the end is empty");
  assert.equal(beyond.total, 30, "and still reports how many rows exist");

  // The dashboard must ask for page 0 first, or every short log renders empty.
  const app = await (await import("node:fs/promises")).readFile(new URL("../assets/app.js", import.meta.url), "utf8");
  assert.match(app, /const page = reset \? 0 : entry\.page \+ 1;/,
    "the run-log loader starts at page 0 and only advances on load-more");
});

// Reported: resolved rows reading "Final 50.0%", with a 55% multi-outcome row claiming
// 26,209 of 28,269 correct. The 50% rows are voided markets -- a sports prop on a game that
// was never played, refunded at 0.5 a side -- and `value >= 0.5 ? 1 : 0` put the void
// exactly on the winning edge, so every one counted as a full win in both accuracy and P/L.
//
// The band this now uses is the one the dashboard already used for the same decision, so the
// two stop disagreeing about what a settlement is.
test("scraped statistics: a voided market is not a win, and not a loss either", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");
  const finalOutcomePriceValue = new Function(
    `${functionSource(source, "finalOutcomePriceValue")}\nreturn finalOutcomePriceValue;`,
  )();
  const outcome = new Function(
    "finalOutcomePriceValue",
    `${functionSource(source, "scrapedSimulationOutcome")}\nreturn scrapedSimulationOutcome;`,
  )(finalOutcomePriceValue);

  // A settlement, either way.
  assert.equal(outcome({ finalOutcomePrice: 1 }), 1);
  assert.equal(outcome({ finalOutcomePrice: 0.9999 }), 1);
  assert.equal(outcome({ finalOutcomePrice: 0 }), 0);
  assert.equal(outcome({ finalOutcomePrice: 0.0001 }), 0);

  // A void. This is the whole report: it used to answer 1.
  assert.equal(outcome({ finalOutcomePrice: 0.5 }), null, "a void is not a win");
  // And the rest of the ambiguous middle, which a settlement never lands in.
  for (const price of [0.4, 0.5, 0.6, 0.75, 0.9]) {
    assert.equal(outcome({ finalOutcomePrice: price }), null, `${price} is not a settlement`);
  }
  // Nothing to say yet.
  assert.equal(outcome({}), null);
  assert.equal(outcome({ finalOutcomePrice: null }), null);
  assert.equal(outcome({ finalOutcomePrice: "" }), null);

  // The same band the dashboard has always used for this -- closedTradePredictionResult
  // grades the accuracy tile, finalOutcomeCell labels the row -- so the statistics report
  // and the portfolio tiles cannot disagree about whether a row counts.
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");
  const graded = functionSource(app, "closedTradePredictionResult");
  assert.match(graded, /finalOutcomePrice >= 0\.995/);
  assert.match(graded, /finalOutcomePrice <= 0\.005/);
  assert.match(source, /if \(value >= 0\.995\) return 1;/);
  assert.match(source, /if \(value <= 0\.005\) return 0;/);
});

test("scraped statistics: a void drops out of the sample rather than scoring", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");

  // Driven through the real summariser: three settled rows and one void, and the void must
  // not appear in resolved, wins, losses or P/L.
  const summarize = new Function(
    "average", "annualizeReturn", "annualizationDays", "MIN_ANNUALIZATION_DAYS",
    `${functionSource(source, "summarizeScrapedSimulationRows")}\nreturn summarizeScrapedSimulationRows;`,
  )(
    (list) => (list.length ? list.reduce((sum, value) => sum + value, 0) / list.length : null),
    (value) => value,
    (days) => days,
    1,
  );

  const row = (outcome, pnl) => ({
    item: { firstObservedAt: "2026-08-01T00:00:00Z", resolvedAt: "2026-08-05T00:00:00Z" },
    entry: 0.55, stake: 5, shares: 9.09, fee: 0, total: 5,
    outcome, pnl, days: 3, volumeUsdc: 1000, firstObservedAt: "2026-08-01T00:00:00Z",
  });

  const settledOnly = summarize([row(1, 4.09), row(1, 4.09), row(0, -5)]);
  const withVoid = summarize([row(1, 4.09), row(1, 4.09), row(0, -5), row(null, null)]);

  assert.equal(settledOnly.resolved, 3);
  assert.equal(withVoid.resolved, 3, "the void is not a resolved trade");
  assert.equal(withVoid.wins, settledOnly.wins, "nor a win");
  assert.equal(withVoid.losses, settledOnly.losses, "nor a loss");
  assert.equal(withVoid.winRate, settledOnly.winRate, "so it cannot move the win rate");
  assert.equal(withVoid.pnlUsdc, settledOnly.pnlUsdc, "nor the P/L");
  // It is still a row that was observed, so the deployed-capital total does see it.
  assert.equal(withVoid.trades, 4);
  assert.equal(withVoid.pending, 1, "and it is reported as unresolved rather than hidden");
});

test("resolved view: a void is labelled a void, not a final price", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");
  const cell = new Function(
    "probability",
    `${functionSource(app, "finalOutcomeCell")}\nreturn finalOutcomeCell;`,
  )((value) => `${(value * 100).toFixed(1)}%`);

  assert.match(cell({ finalOutcomePrice: 1 }), /Won/);
  assert.match(cell({ finalOutcomePrice: 0 }), /Lost/);
  // The reported case: closed, no longer accepting orders, settled to neither side.
  const voided = cell({ finalOutcomePrice: 0.5, marketClosed: true, acceptingOrders: false });
  assert.match(voided, /Void/, "a refunded market says so");
  assert.match(voided, /refunded at 50\.0%/);
  assert.ok(!/^<span>Final/.test(voided), "and no longer reads as a result");
  // A market still trading at a middling price is not a void -- it simply has no result yet.
  assert.match(cell({ finalOutcomePrice: 0.5, marketClosed: false, acceptingOrders: true }), /Final 50\.0%/);
  assert.equal(cell({}), "-");
});

// Reported: the statistics tables went blank -- every parameter row reading TRADES 0 and
// ACCURACY "-" beside an OPEN NOW of 3,851. A pass rebuilt the report while holding only the
// active catalogue, which produces a structurally complete report whose resolved sample is
// empty, and published it over a good one.
//
// Guarding the pass mode covered one of the five rebuild sites. The mode was only ever a
// proxy for the real precondition, which is about the data: does this process actually have
// the resolved rows the report measures? Asked at the one choke point, it covers every
// caller, including any added later -- which is what this pins.
test("statistics report: a pass without the resolved archive keeps the stored report", () => {
  const modulePath = new URL("../tools/paper-trading-bot.mjs", import.meta.url).href;
  const script = `
    import { splitStateIntoSegments, rememberStateSegmentManifest, updateCalculationReport } from ${JSON.stringify(modulePath)};
    const input = JSON.parse(process.argv[1]);
    rememberStateSegmentManifest(input.manifest);
    const state = input.state;
    const returned = updateCalculationReport(state);
    process.stdout.write(JSON.stringify({
      returnedSampleSize: returned?.sampleSize ?? null,
      returnedGeneratedAt: returned?.generatedAt ?? null,
      storedSampleSize: state.latestCalculationReport?.sampleSize ?? null,
      storedGeneratedAt: state.latestCalculationReport?.generatedAt ?? null,
      historyLength: Array.isArray(state.calculationReports) ? state.calculationReports.length : null,
    }));
  `;
  const run = (payload) => JSON.parse(execFileSync(
    process.execPath,
    ["--input-type=module", "-e", script, JSON.stringify(payload)],
    { encoding: "utf8", env: process.env },
  ));

  // A manifest that declares 53,408 settled markets, and a state holding none of them.
  const manifest = {
    resolvedObservations: {
      file: "paper-state.resolvedObservations.json",
      fields: ["resolvedMarketObservations"],
      counts: { resolvedMarketObservations: 53408 },
    },
  };
  const good = { id: "calculation-report-old", generatedAt: "2026-08-21T09:00:00.000Z", sampleSize: 53408 };
  const activeOnly = [
    { id: "a1", status: "SCRAPED", marketKey: "a1" },
    { id: "a2", status: "SCRAPED", marketKey: "a2" },
  ];

  const carried = run({
    manifest,
    state: {
      generatedAt: "2026-08-21T11:01:44.117Z",
      marketObservations: activeOnly,
      latestCalculationReport: good,
      calculationReports: [good],
    },
  });
  assert.equal(carried.storedSampleSize, 53408, "the complete report must survive");
  assert.equal(carried.storedGeneratedAt, good.generatedAt, "and must not be restamped as if remeasured");
  assert.equal(carried.historyLength, 1, "nor may an empty report enter the history");
  assert.equal(carried.returnedSampleSize, 53408);

  // One settled record is still a partial archive when the manifest declares 53,408.
  // It must preserve the measurement instead of publishing statistics for one row.
  const partial = run({
    manifest,
    state: {
      generatedAt: "2026-08-21T11:01:44.117Z",
      marketObservations: [
        ...activeOnly,
        {
          id: "r1", status: "RESOLVED", marketKey: "r1", finalOutcomePrice: 1,
          firstMarketProbability: 0.6, observedAt: "2026-08-20T00:00:00Z",
          firstObservedAt: "2026-08-20T00:00:00Z", resolvedAt: "2026-08-21T00:00:00Z",
        },
      ],
      latestCalculationReport: good,
      calculationReports: [good],
    },
  });
  assert.equal(partial.storedGeneratedAt, good.generatedAt, "a partial archive must not remeasure");
  assert.equal(partial.historyLength, 1, "nor may a partial report enter the history");

  // The same record is complete when the manifest declares exactly one resolved row.
  const complete = run({
    manifest: {
      resolvedObservations: {
        file: "paper-state.resolvedObservations.json",
        fields: ["resolvedMarketObservations"],
        counts: { resolvedMarketObservations: 1 },
      },
    },
    state: {
      generatedAt: "2026-08-21T11:01:44.117Z",
      marketObservations: [
        ...activeOnly,
        {
          id: "r1", status: "RESOLVED", marketKey: "r1", finalOutcomePrice: 1,
          firstMarketProbability: 0.6, observedAt: "2026-08-20T00:00:00Z",
          firstObservedAt: "2026-08-20T00:00:00Z", resolvedAt: "2026-08-21T00:00:00Z",
        },
      ],
      latestCalculationReport: good,
      calculationReports: [good],
    },
  });
  assert.equal(complete.storedGeneratedAt, "2026-08-21T11:01:44.117Z", "a complete archive remeasures");
  assert.equal(complete.historyLength, 2, "and its report joins the history");

  // And a state that never declared an archive has nothing missing, so it may rebuild.
  const undeclared = run({
    manifest: {},
    state: {
      generatedAt: "2026-08-21T11:01:44.117Z",
      marketObservations: activeOnly,
      latestCalculationReport: good,
      calculationReports: [good],
    },
  });
  assert.equal(undeclared.storedGeneratedAt, "2026-08-21T11:01:44.117Z",
    "an unsegmented state is holding everything there is");
});

// Requested: a portfolio resting limit orders had its capital tied up by offers that were
// waiting and might never fill, so it stopped placing new ones. A resting buy is not a
// position -- the market has not come down to it, and once the event ends it is discarded
// with no stake spent -- so it must not block the order after it.
test("limit orders: capital held by unfilled orders does not block the next order", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");
  const openRisk = new Function(
    "OPEN_STATUSES",
    `${functionSource(source, "openRisk")}\nreturn openRisk;`,
  )(new Set(["OPEN", "PENDING_RESOLUTION", "MARKET_NOT_FOUND", "STOP_BREACH", "LIMIT_ORDER_WAITING"]));
  const waitingLimitOrderRisk = new Function(
    `${functionSource(source, "waitingLimitOrderRisk")}\nreturn waitingLimitOrderRisk;`,
  )();
  const deployableCapital = new Function(
    "openRisk", "waitingLimitOrderRisk",
    `${functionSource(source, "deployableCapital")}\nreturn deployableCapital;`,
  )(openRisk, waitingLimitOrderRisk);

  // 100 USDC, three filled positions and four offers still resting.
  const trades = [
    ...Array.from({ length: 3 }, (_, i) => ({ id: `open-${i}`, status: "OPEN", maxLossUsdc: 5 })),
    ...Array.from({ length: 4 }, (_, i) => ({ id: `rest-${i}`, status: "LIMIT_ORDER_WAITING", maxLossUsdc: 5 })),
  ];
  const portfolioState = { trades };

  assert.equal(openRisk(trades), 35, "allocated capital still counts every open row");
  assert.equal(waitingLimitOrderRisk(trades), 20, "of which this much is only offers");

  // A market-order portfolio is unchanged: every open row is real exposure.
  assert.equal(deployableCapital(portfolioState, { useLimitOrders: false }, 100), 65);
  // A limit-order portfolio may size against the resting capital too.
  assert.equal(deployableCapital(portfolioState, { useLimitOrders: true }, 100), 85);

  // The reported case: free capital below the stake, so it used to skip; the resting
  // orders are what put it there, and now they do not.
  const full = {
    trades: [
      ...Array.from({ length: 19 }, (_, i) => ({ id: `rest-${i}`, status: "LIMIT_ORDER_WAITING", maxLossUsdc: 5 })),
      { id: "open-0", status: "OPEN", maxLossUsdc: 5 },
    ],
  };
  assert.equal(deployableCapital(full, { useLimitOrders: false }, 100), 0, "market orders: nothing left");
  assert.equal(deployableCapital(full, { useLimitOrders: true }, 100), 95,
    "limit orders: only the one filled position is exposure");

  // Never negative, whatever the book looks like.
  assert.equal(deployableCapital({ trades: [{ status: "OPEN", maxLossUsdc: 500 }] }, { useLimitOrders: true }, 100), 0);
  // A closed or expired order holds nothing at all.
  for (const status of ["LIMIT_ORDER_EXPIRED", "WON", "LOST", "CANCELLED"]) {
    assert.equal(waitingLimitOrderRisk([{ status, maxLossUsdc: 5 }]), 0, `${status} holds no capital`);
  }
  // Falls back to the stake when a row carries no explicit max loss.
  assert.equal(waitingLimitOrderRisk([{ status: "LIMIT_ORDER_WAITING", stakeUsdc: 7 }]), 7);
});

test("limit orders: the dashboard is told both figures, so it cannot contradict the run log", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");

  // updatePaperPortfolio publishes the allocated figure and the deployable one.
  const portfolioState = {
    id: "ewportfolio",
    label: "75 + SL",
    useLimitOrders: true,
    stakeUsdc: 5,
    trades: [
      { id: "open-0", status: "OPEN", maxLossUsdc: 5, stakeUsdc: 5 },
      { id: "rest-0", status: "LIMIT_ORDER_WAITING", maxLossUsdc: 5, stakeUsdc: 5 },
      { id: "rest-1", status: "LIMIT_ORDER_WAITING", maxLossUsdc: 5, stakeUsdc: 5 },
    ],
  };
  bot.updatePaperPortfolio(portfolioState);
  const portfolio = portfolioState.portfolio;
  assert.equal(portfolio.openRiskUsdc, 15, "all three rows are allocated");
  assert.equal(portfolio.restingLimitOrderUsdc, 10, "two of them are only offers");
  assert.equal(portfolio.freeCapitalUsdc, 85, "free capital counts them, because they are allocated");
  assert.equal(portfolio.deployableCapitalUsdc, 95, "the next order is sized without them");

  // And a market-order portfolio reports the two as the same number, so nothing reads as a
  // special case where there is none.
  const marketOrders = { ...portfolioState, useLimitOrders: false, portfolio: undefined };
  bot.updatePaperPortfolio(marketOrders);
  assert.equal(marketOrders.portfolio.deployableCapitalUsdc, marketOrders.portfolio.freeCapitalUsdc);
  assert.equal(marketOrders.portfolio.restingLimitOrderUsdc, 10,
    "the amount is still reported -- it is just not deployable here");

  // The skip message has to name the resting total, or "2.00 USDC available" cannot be
  // reconciled with the free capital the dashboard shows.
  assert.match(source, /USDC of unfilled limit orders is not counted against this/);
  assert.match(source, /const available = deployableCapital\(portfolioState, strategy, sizingCapital\);/);
});

// -- Multi-outcome versus Yes/No -------------------------------------------------------
//
// Reported: the app had the two backwards. Yes/No is any two-sided either-or -- one team
// beats the other, the total lands over or under -- and a football result that can be home,
// draw or away is still one fixture between two sides, explicitly not a field.
// Multi-outcome is a field of mutually exclusive alternatives where exactly one wins, like
// an election, even though each candidate there is quoted as its own Yes/No book.
//
// Every question below is a real one, copied out of the resolved archive.
const MARKET_TYPE_CASES = [
  // Two-sided, and all of these were being called multi-outcome.
  ["binary", { question: "Total Kills Over/Under 45.5 in Game 2?", outcome: "Over", outcomeCount: 2 }],
  ["binary", { question: "FC Sochaux-Montbéliard vs. En Avant Guingamp: O/U 3.5", outcome: "Under", outcomeCount: 2 }],
  ["binary", { question: "Dota 2: Team Spirit vs Team Liquid - Game 2 Winner", outcome: "Team Spirit", outcomeCount: 2 }],
  ["binary", { question: "Overwatch: United States vs Sweden - Game 4 Winner", outcome: "United States", outcomeCount: 2 }],
  ["binary", { question: "Game Handicap: TS (-1.5) vs Team Liquid (+1.5)", outcome: "Team Spirit", outcomeCount: 2 }],
  ["binary", { question: "Spread: Portland Fire (-2.5)", outcome: "Toronto Tempo", outcomeCount: 2 }],
  ["binary", { question: "Map 3 Rounds Handicap: Evil Geniuses (-2.5) vs FURIA Esports (+2.5)", outcome: "FURIA Esports", outcomeCount: 2 }],
  // Two-sided propositions.
  ["binary", { question: "SC Preußen Münster leading at halftime?", outcome: "No", outcomeCount: 2 }],
  ["binary", { question: "Will Arsenal FC win on 2026-08-21?", outcome: "Yes", outcomeCount: 2 }],
  ["binary", { question: "Game 1: Any Player Penta Kill?", outcome: "No", outcomeCount: 2 }],
  ["binary", { question: "Bitcoin Up or Down on August 21?", outcome: "Up", outcomeCount: 2 }],
  // The instruction that has to hold whatever the outcome count says: a result that can be
  // home, draw or away is one fixture with two sides, not a field of three contenders.
  ["binary", { question: "Real Madrid vs. FC Barcelona: full time result", outcome: "Draw", outcomeCount: 3 }],
  ["binary", { question: "Slavia Praha - Sparta Praha: 1X2", outcome: "Home", outcomeCount: 3 }],
  // A field: one of many, each quoted separately.
  ["multi", { question: "Exact Score: Club The Strongest 3 - 3 FC Universitario?", outcome: "No", outcomeCount: 2 }],
  ["multi", { question: "Exact Score: Any Other Score?", outcome: "Yes", outcomeCount: 2 }],
  ["multi", { question: "Will Donald Trump win the 2028 presidential election?", outcome: "Yes", outcomeCount: 2 }],
  ["multi", { question: "Who will be the Democratic nominee?", outcome: "Gavin Newsom", outcomeCount: 2 }],
  ["multi", { question: "Which team wins the Champions League?", outcome: "Arsenal", outcomeCount: 2 }],
  ["multi", { question: "Premier League top scorer 2026/27", outcome: "Erling Haaland", outcomeCount: 2 }],
  ["multi", { question: "Best Picture winner of the 2027 Oscars", outcome: "Some Film", outcomeCount: 2 }],
  // More than two outcomes with no pair vocabulary anywhere is a field.
  ["multi", { question: "Fed decision in September", outcome: "50+ bps cut", outcomeCount: 5 }],
];

test("market type: a two-sided event is Yes/No, a field of alternatives is multi-outcome", () => {
  for (const [expected, item] of MARKET_TYPE_CASES) {
    assert.equal(bot.reportMarketType(item), expected,
      `${JSON.stringify(item.question)} (outcome ${JSON.stringify(item.outcome)}) should be ${expected}`);
  }
});

test("market type: the slug carries the same evidence as the question", () => {
  // Real slugs. The question can be terse where the slug is explicit, so both are read.
  assert.equal(bot.reportMarketType({ slug: "wnba-por-tor-2026-08-21-spread-away-2pt5", question: "", outcome: "Toronto Tempo" }), "binary");
  assert.equal(bot.reportMarketType({ slug: "nfl-2026-exact-score-week-3", question: "", outcome: "No" }), "multi");
  assert.equal(bot.reportMarketType({ eventSlug: "us-presidential-election-2028", question: "", outcome: "No" }), "multi");
});

test("market type: a stored label from the old rule no longer decides anything", () => {
  // The archive is full of rows stamped "multi" by the rule this replaced. The statistics
  // always recompute, so anything that preferred the stored label would disagree with them
  // about the very same market -- which is what the report was about.
  const overUnder = {
    question: "Total Kills Over/Under 45.5 in Game 2?",
    outcome: "Over",
    outcomeCount: 2,
    marketType: "multi",
  };
  assert.equal(bot.reportMarketType(overUnder), "binary", "the row is classified, not the label read");

  const source = readFileSync(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /storedMarketType === "all" \? reportMarketType/,
    "no filter may fall back to a stored market type");
});

test("market type: the browser classifies exactly as the bot does", () => {
  // The link out of a statistics row filters the browser's own list. If the two rules
  // differ, a "Multi-outcome" row opens a list of something else -- a failure this
  // codebase has already had once, on tag counts.
  const app = readFileSync(new URL("../assets/app.js", import.meta.url), "utf8");
  const scope = {};
  const build = new Function("scope", `${
    app.slice(app.indexOf("const MULTI_OUTCOME_FIELD"), app.indexOf("function scrapedMarketType"))
  }; scope.candidateMarketType = candidateMarketType;`);
  build(scope);
  for (const [expected, item] of MARKET_TYPE_CASES) {
    assert.equal(scope.candidateMarketType(item), expected,
      `browser disagrees on ${JSON.stringify(item.question)}`);
    assert.equal(scope.candidateMarketType(item), bot.reportMarketType(item),
      `browser and bot disagree on ${JSON.stringify(item.question)}`);
  }
});

// -- A stop that a closing market walked past ------------------------------------------
//
// Reported: the two most recent losers in a protected portfolio sit in LOST at the full
// stake with stopLossStatus still ARMED. Measured on production: both had a derived floor,
// both booked -5.00 on a 5.00 stake against risk targets of 2.24 and 2.12, and neither
// carried a trigger time. markOpenTrade returned the settlement before it ever consulted
// the floor, so any position whose market closed between two polls skipped the stop.

test("stop loss: a losing settlement fills the stop the crossing would have taken out", () => {
  const plan = { protectable: true, requiresStop: true, stopPrice: 0.425, riskTargetUsdc: 2.24, stopLossRiskMultiplier: 1 };
  const fill = bot.settlementStopFill({
    plan,
    lastLiveMark: 0.62,
    shares: 6.4935,
    feeRate: 0,
    feesEnabled: false,
    totalCostUsdc: 5,
  });
  assert.ok(fill, "a mark above the floor is a crossing on the way to zero");
  assert.equal(fill.fillPrice, 0.425, "filled at the floor, never at the settlement print");
  // 6.4935 shares sold at 0.425 returns 2.76, against a 5.00 cost.
  assert.ok(Math.abs(fill.realizedPnlUsdc + 2.24) < 0.01,
    `the loss must land on the planned target, got ${fill.realizedPnlUsdc}`);
  // The floor above is hand-rounded to four places; production bisects until the exit value
  // is at or above the boundary. A sub-cent overshoot here therefore belongs to the fixture,
  // and what has to hold is that a fill at the floor does not breach the cap.
  assert.ok(fill.capBreachUsdc < 0.01,
    `a fill at the floor must not breach the cap, got ${fill.capBreachUsdc}`);
});

test("stop loss: a settlement print cannot pass for the last quote", () => {
  const plan = { protectable: true, requiresStop: true, stopPrice: 0.425, riskTargetUsdc: 2.24 };
  const args = { plan, shares: 6.4935, feeRate: 0, feesEnabled: false, totalCostUsdc: 5 };
  // 0 is exactly what the closing write leaves on currentPrice, and it is not a quote.
  assert.equal(bot.settlementStopFill({ ...args, lastLiveMark: 0 }), null);
  assert.equal(bot.settlementStopFill({ ...args, lastLiveMark: 1 }), null);
  assert.equal(bot.settlementStopFill({ ...args, lastLiveMark: null }), null);
  // Already through the floor when last seen: a genuine gap, and the full loss stands.
  assert.equal(bot.settlementStopFill({ ...args, lastLiveMark: 0.30 }), null);
  // No protection, or a plan that never needed a stop.
  assert.equal(bot.settlementStopFill({ ...args, plan: null, lastLiveMark: 0.62 }), null);
  assert.equal(bot.settlementStopFill({
    ...args,
    plan: { protectable: true, requiresStop: false, stopPrice: null },
    lastLiveMark: 0.62,
  }), null);
});

test("stop loss: a market that closes between two polls no longer skips the floor", async () => {
  const { bot: scoped, restore } = await scopedBot("settlement-stop", {});
  const stub = stubFetch((url) => {
    if (url.includes("gamma-api.polymarket.com/markets")) {
      return [{
        slug: "settlement-stop-fixture",
        question: "SC Preußen Münster leading at halftime?",
        conditionId: "0xabc",
        closed: true,
        active: false,
        acceptingOrders: false,
        closedTime: "2026-08-21T20:05:43Z",
        endDate: "2026-08-21T20:00:00Z",
        outcomes: JSON.stringify(["Yes", "No"]),
        outcomePrices: JSON.stringify(["1", "0"]),
        clobTokenIds: JSON.stringify(["11", "22"]),
      }];
    }
    return null;
  });
  try {
    const protectedTrade = {
      id: "t1",
      status: "OPEN",
      slug: "settlement-stop-fixture",
      tokenId: "22",
      outcome: "No",
      entryPrice: 0.77,
      shares: 6.4935,
      stakeUsdc: 5,
      maxLossUsdc: 5,
      totalCostUsdc: 5,
      netGainIfWinUsdc: 1.4935,
      feeRate: 0,
      feesEnabled: false,
      equalRiskProtection: true,
      stopLossRiskMultiplier: 1,
      // The mark from the poll before the close: above the floor, so the resting sell was
      // there to be filled when the price crossed on its way to zero.
      lastLiveBid: 0.62,
      currentPrice: 0.62,
      openedAt: "2026-08-21T18:00:00.000Z",
    };
    const marked = await scoped.markOpenTrade(protectedTrade);

    assert.equal(marked.status, "STOP_LOSS",
      `a protected loser must exit at its floor, got ${marked.status}: ${marked.statusNote}`);
    assert.equal(marked.stopLossStatus, "FILLED_AT_FLOOR");
    assert.ok(marked.stopLossTriggeredAt, "the stop has to record when it ran");
    assert.ok(marked.realizedPnlUsdc > -5,
      `the whole stake must no longer be lost, got ${marked.realizedPnlUsdc}`);
    // The floor for a 0.77 entry with an equal-risk cap is well above zero, so the loss is
    // a fraction of the stake rather than all of it.
    assert.ok(marked.realizedPnlUsdc < 0, "it is still a loss");
    assert.equal(marked.observedBidAtStop, 0.62, "the mark the decision was made on is kept");

    // The same market, with no protection configured, still books the plain settlement.
    const unprotected = await scoped.markOpenTrade({
      ...protectedTrade,
      id: "t2",
      equalRiskProtection: false,
    });
    assert.equal(unprotected.status, "LOST", "an unprotected position has no floor to fill at");
    assert.equal(unprotected.realizedPnlUsdc, -5);
  } finally {
    stub.restore();
    restore();
  }
});

test("stop loss: the last live bid is kept apart from the settlement print", () => {
  const source = readFileSync(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");
  // currentPrice is overwritten with 0 or 1 by the closing write, so the stop decision has
  // to read a field only a real orderbook ever sets.
  assert.match(source, /lastLiveBid: trade\.lastLiveBid \?\? null/,
    "every marked row must carry the last live bid forward");
  assert.match(source, /lastLiveBid: Number\(bestBid\.toFixed\(4\)\)/,
    "a bid taken off a book must be recorded as one");
  assert.match(source, /lastLiveMark: trade\.lastLiveBid \?\? trade\.currentPrice/,
    "the settlement path reads the live mark first, falling back for rows written earlier");
});

// -- Risk split: what is invested versus what is only queued ----------------------------
//
// Requested: show separately how much sits in orders and how much in open positions. They
// are not the same commitment. Capital in a filled position is exposure -- it moves with
// the market and can be lost. Capital behind a resting order is a reservation against an
// offer nobody has taken, and if the event ends unfilled it comes back untouched. A single
// "risk" figure cannot say whether a portfolio is invested or merely queueing.

test("portfolio: risk is published split into positions and resting orders", () => {
  const portfolioState = {
    id: "ewportfolio",
    useLimitOrders: true,
    trades: [
      { status: "OPEN", stakeUsdc: 5, maxLossUsdc: 5, unrealizedPnlUsdc: 0.2 },
      { status: "PENDING_RESOLUTION", stakeUsdc: 5, maxLossUsdc: 5 },
      { status: "LIMIT_ORDER_WAITING", stakeUsdc: 5, maxLossUsdc: 5 },
      { status: "LIMIT_ORDER_WAITING", stakeUsdc: 5, maxLossUsdc: 5 },
      { status: "LIMIT_ORDER_WAITING", stakeUsdc: 5, maxLossUsdc: 5 },
      { status: "WON", stakeUsdc: 5, realizedPnlUsdc: 0.4 },
    ],
    portfolio: {},
  };
  bot.updatePaperPortfolio(portfolioState);
  const result = portfolioState.portfolio;

  assert.equal(result.openRiskUsdc, 25, "the total still counts every open row");
  assert.equal(result.positionRiskUsdc, 10, "two filled positions are the exposure");
  assert.equal(result.restingLimitOrderUsdc, 15, "three resting orders are not");
  assert.equal(
    Number((result.positionRiskUsdc + result.restingLimitOrderUsdc).toFixed(2)),
    result.openRiskUsdc,
    "the two halves must add up to the total the dashboard also shows",
  );
});

test("portfolio: with nothing resting, the position half is the whole risk", () => {
  const portfolioState = {
    id: "conservative",
    trades: [{ status: "OPEN", stakeUsdc: 5, maxLossUsdc: 5 }],
    portfolio: {},
  };
  bot.updatePaperPortfolio(portfolioState);
  assert.equal(portfolioState.portfolio.positionRiskUsdc, 5);
  assert.equal(portfolioState.portfolio.restingLimitOrderUsdc, 0);
  assert.equal(portfolioState.portfolio.openRiskUsdc, 5);
});

test("overview: a resting buy reserves capital, a sell or a dead order does not", () => {
  const app = readFileSync(new URL("../assets/app.js", import.meta.url), "utf8");
  const scope = {};
  const build = new Function("scope", `${
    app.slice(app.indexOf("const TERMINAL_ORDER_STATUSES"), app.indexOf("function renderPortfolioOverview"))
  }; scope.reservedByOpenOrders = reservedByOpenOrders;`);
  build(scope);
  const reserved = scope.reservedByOpenOrders([
    { side: "BUY", status: "LIVE", notionalUsdc: 10 },
    // A sell is an exit, not a reservation.
    { side: "SELL", status: "LIVE", notionalUsdc: 40 },
    // Still in the snapshot, but reserving nothing any more.
    { side: "BUY", status: "CANCELED", notionalUsdc: 70 },
    { side: "BUY", rawStatus: "FILLED", notionalUsdc: 80 },
    // Falls back through the other cost fields.
    { side: "BUY", status: "LIVE", totalCostUsdc: 5 },
    { side: "BUY", status: "LIVE", stakeUsdc: 2 },
  ]);
  assert.equal(reserved, 17, "only the live buys reserve, and each by its own cost");
  assert.equal(scope.reservedByOpenOrders(null), 0, "a missing order list reserves nothing");
});

test("overview: the table shows the two halves of risk as their own columns", () => {
  const app = readFileSync(new URL("../assets/app.js", import.meta.url), "utf8");
  const overview = functionSource(app, "renderPortfolioOverview");
  for (const label of ["In positions", "In orders"]) {
    assert.ok(overview.includes(`data-label="${label}"`), `the table needs an ${label} cell`);
    assert.ok(overview.includes(`>${label}<`), `the table needs an ${label} header`);
  }
  // A state written before positionRiskUsdc existed must still split correctly rather
  // than reporting the whole total as positions.
  assert.match(overview, /positionRiskUsdc\s*\n?\s*\?\?/,
    "the paper row falls back for a state that predates the field");
  assert.match(overview, /reservedByOpenOrders\(state\.liveState\?\.openOrders\)/,
    "the live row takes its order half from the wallet's resting buys");
});

// -- A resting order the account cannot honour ------------------------------------------
//
// Requested: keep adding orders while capital is available, and if an order should become a
// position with no capital to fund it, cancel every order. Placing stays permissive -- an
// offer nobody takes costs nothing -- so the brake goes where the promise comes due. On
// production the placing side never ran out: three portfolios queued roughly twice their
// balance in three hours, one opening on all 24 of its last runs.

const restingOrder = (id, cost = 5) => ({
  id, status: "LIMIT_ORDER_WAITING", stakeUsdc: cost, maxLossUsdc: cost, entryPrice: 0.5,
});
const filledFrom = (order) => ({ ...order, status: "OPEN" });

test("limit orders: a fill the balance can fund is left alone", () => {
  const before = [restingOrder("a"), restingOrder("b")];
  const after = [filledFrom(before[0]), before[1]];
  const result = bot.fundLimitOrderFills(before, after, { id: "ewportfolio" });

  assert.equal(result.funded, 1);
  assert.equal(result.cancelled, 0, "nothing is cancelled while the account has room");
  assert.equal(result.trades[0].status, "OPEN", "the fill stands");
  assert.equal(result.trades[1].status, "LIMIT_ORDER_WAITING", "and the other order keeps resting");
});

test("limit orders: an unfundable fill cancels the whole resting queue", () => {
  // 100 balance with 98 already in positions leaves 2. A 5 USDC position does not fit.
  const held = { id: "held", status: "OPEN", stakeUsdc: 98, maxLossUsdc: 98 };
  const before = [held, restingOrder("a"), restingOrder("b"), restingOrder("c")];
  const after = [held, filledFrom(before[1]), before[2], before[3]];
  const result = bot.fundLimitOrderFills(before, after, { id: "ewportfolio" });

  assert.equal(result.funded, 0, "the fill could not be funded");
  assert.equal(result.trades[1].status, "LIMIT_ORDER_EXPIRED", "so it does not become a position");
  assert.equal(result.trades[1].cancelledForCapital, true);
  assert.equal(result.trades[1].realizedPnlUsdc, 0, "an order that never filled costs nothing");
  // And every other resting order goes with it, which is the point of the rule.
  assert.equal(result.cancelled, 2);
  for (const index of [2, 3]) {
    assert.equal(result.trades[index].status, "LIMIT_ORDER_EXPIRED", `order ${index} must be cancelled`);
    assert.equal(result.trades[index].cancelledForCapital, true);
  }
  assert.equal(result.trades[0].status, "OPEN", "positions already held are untouched");
});

test("limit orders: fills are funded until the balance runs out, then everything goes", () => {
  // 100 balance, 85 held, so 15 free: three of the four fills fit and the fourth does not.
  const held = { id: "held", status: "OPEN", stakeUsdc: 85, maxLossUsdc: 85 };
  const orders = ["a", "b", "c", "d"].map((id) => restingOrder(id));
  const before = [held, ...orders];
  const after = [held, ...orders.map(filledFrom)];
  const result = bot.fundLimitOrderFills(before, after, { id: "ewportfolio" });

  assert.equal(result.funded, 3, "three 5 USDC positions fit inside 15 USDC");
  assert.equal(result.trades[1].status, "OPEN");
  assert.equal(result.trades[3].status, "OPEN");
  assert.equal(result.trades[4].status, "LIMIT_ORDER_EXPIRED", "the fourth had nothing left to fund it");
  assert.equal(result.trades[4].cancelledForCapital, true);
});

test("limit orders: realized profit and a capital adjustment both raise the balance", () => {
  const held = { id: "held", status: "OPEN", stakeUsdc: 98, maxLossUsdc: 98 };
  const won = { id: "won", status: "WON", stakeUsdc: 5, realizedPnlUsdc: 20 };
  const before = [held, won, restingOrder("a")];
  const after = [held, won, filledFrom(before[2])];
  // 100 + 20 realized - 98 held = 22 free, so the 5 USDC fill fits.
  assert.equal(bot.fundLimitOrderFills(before, after, { id: "x" }).funded, 1);
  // The same portfolio rebased down to 40 cannot afford it: 40 + 20 - 98 is nothing.
  const rebased = bot.fundLimitOrderFills(before, after, { id: "x", capitalAdjustmentUsdc: -60 });
  assert.equal(rebased.funded, 0);
  assert.equal(rebased.trades[2].cancelledForCapital, true);
});

test("limit orders: a pass with no fills is left exactly as it was", () => {
  const before = [restingOrder("a"), { id: "p", status: "OPEN", stakeUsdc: 5, maxLossUsdc: 5 }];
  const after = [before[0], before[1]];
  const result = bot.fundLimitOrderFills(before, after, { id: "ewportfolio" });
  assert.equal(result.trades, after, "the same array comes back when there is nothing to fund");
  assert.equal(result.cancelled, 0);
  // A portfolio that never rests orders can never reach the cancel path.
  const marketOnly = [{ id: "p", status: "OPEN", stakeUsdc: 5, maxLossUsdc: 5 }];
  assert.equal(bot.fundLimitOrderFills(marketOnly, marketOnly, { id: "conservative" }).cancelled, 0);
});

test("limit orders: resting capital is not counted against a fill, only positions are", () => {
  // The distinction the whole rule rests on. 100 balance, 10 in positions, 90 resting: the
  // fill is funded out of the 90 that is not held, not refused because orders "used" it.
  const held = { id: "held", status: "OPEN", stakeUsdc: 10, maxLossUsdc: 10 };
  const resting = Array.from({ length: 18 }, (unused, index) => restingOrder(`r${index}`));
  const before = [held, ...resting];
  const after = [held, filledFrom(resting[0]), ...resting.slice(1)];
  const result = bot.fundLimitOrderFills(before, after, { id: "ewportfolio" });
  assert.equal(result.funded, 1, "90 USDC of resting offers reserve nothing against a fill");
  assert.equal(result.cancelled, 0);
  assert.equal(bot.positionRisk(before), 10, "positionRisk counts held positions only");
  assert.equal(bot.openRisk(before), 100, "openRisk still counts everything open");
});

test("limit orders: the refresh hands the portfolio to the funding check", () => {
  const source = readFileSync(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");
  assert.match(source, /refreshTrades\(portfolioState\.trades, portfolioState\)/,
    "the funding check needs the portfolio the trades belong to");
  assert.match(source, /const funding = fundLimitOrderFills\(trades, refreshed, portfolioState\);/,
    "and it runs after the fan-out, where every fill on the pass is visible at once");
});

test("limit orders: a cancelled order reads differently from an expired one", () => {
  const app = readFileSync(new URL("../assets/app.js", import.meta.url), "utf8");
  assert.match(app, /trade\.cancelledForCapital/,
    "the browser must tell an account problem apart from an event that simply ended");
  assert.match(app, /Limit order cancelled &middot; no capital/);
  assert.match(app, /Limit order expired &middot; unfilled/);
});

// -- Not missing the moment a resting order would have filled ----------------------------
//
// A resting buy fills when the market comes down to its price. Asking only where the best
// ask is right now missed that for 28 of 40 resting orders in production, audited against
// the CLOB's traded prices. Two distinct ways:
//
//   - No ask at all read as "did not fill" when it means "cannot tell from the book". On a
//     decided market nobody offers the worthless side, so the ask side empties while the
//     price has already collapsed through the order. Those sat in WAITING for hours, which
//     also flattered the results: an order that really filled and lost was discarded free.
//   - A dip between two checks leaves nothing in the book at all.

test("limit orders: the best ask reaching the limit still fills, as before", () => {
  const filled = bot.limitOrderFillDecision({ limitPrice: 0.75, bestAsk: 0.74, eventEnded: false });
  assert.equal(filled.outcome, "FILLED");
  assert.equal(filled.fillPrice, 0.75, "a resting order fills at its own price, never better");
  assert.equal(filled.filledBy, "ask");
  // Exactly at the limit counts: the market reached the order.
  assert.equal(bot.limitOrderFillDecision({ limitPrice: 0.75, bestAsk: 0.75, eventEnded: false }).outcome, "FILLED");
});

test("limit orders: an empty ask side is not evidence that nothing filled", () => {
  // The production case: limit 0.84, no ask on the book, market trading at 0.45.
  const decision = bot.limitOrderFillDecision({
    limitPrice: 0.84,
    bestAsk: null,
    marketPrice: 0.45,
    eventEnded: false,
  });
  assert.equal(decision.outcome, "FILLED", "the market is far below the resting price");
  assert.equal(decision.filledBy, "market-price");
  assert.equal(decision.fillPrice, 0.84);

  // With no ask and a market still above the limit, it genuinely has not filled.
  assert.equal(bot.limitOrderFillDecision({
    limitPrice: 0.84, bestAsk: null, marketPrice: 0.91, eventEnded: false,
  }).outcome, "WAITING");
  // A settled price of 0 is not a quote and must not fill anything.
  assert.equal(bot.limitOrderFillDecision({
    limitPrice: 0.84, bestAsk: null, marketPrice: 0, eventEnded: false,
  }).outcome, "WAITING");
});

test("limit orders: a dip between two checks fills the order", () => {
  // Both samples sit above the limit; the market went through it in between.
  const decision = bot.limitOrderFillDecision({
    limitPrice: 0.79,
    bestAsk: 0.80,
    marketPrice: 0.80,
    lowestTradedPrice: 0.79,
    eventEnded: false,
  });
  assert.equal(decision.outcome, "FILLED");
  assert.equal(decision.filledBy, "traded-through");
  assert.equal(decision.fillPrice, 0.79);

  // A low that never reached the limit leaves it resting.
  assert.equal(bot.limitOrderFillDecision({
    limitPrice: 0.79, bestAsk: 0.85, marketPrice: 0.86, lowestTradedPrice: 0.82, eventEnded: false,
  }).outcome, "WAITING");
});

test("limit orders: a fill beats expiry, and missing data never invents one", () => {
  // The event ending does not undo a fill that already happened on the way down.
  assert.equal(bot.limitOrderFillDecision({
    limitPrice: 0.6, bestAsk: null, marketPrice: 0.2, eventEnded: true,
  }).outcome, "FILLED");
  // Nothing observed at all: expiry when the event is over, waiting while it is not.
  assert.equal(bot.limitOrderFillDecision({
    limitPrice: 0.6, bestAsk: null, marketPrice: null, lowestTradedPrice: null, eventEnded: true,
  }).outcome, "EXPIRED");
  assert.equal(bot.limitOrderFillDecision({
    limitPrice: 0.6, bestAsk: null, marketPrice: null, lowestTradedPrice: null, eventEnded: false,
  }).outcome, "WAITING");
  // An unusable limit price cannot fill anything.
  assert.equal(bot.limitOrderFillDecision({
    limitPrice: null, bestAsk: 0.1, eventEnded: false,
  }).outcome, "WAITING");
});

test("limit orders: history is only fetched when the free signals leave it open", () => {
  const source = readFileSync(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");
  // The market comes with the Gamma read the refresh already does, so the current price
  // costs nothing; the history is one request per still-waiting order per pass.
  assert.match(source, /const needsHistory = !\(Number\.isFinite\(bestAsk\) && bestAsk <= limitPrice\)/);
  assert.match(source, /const lowestTradedPrice = needsHistory/);
  // Measured from the last look once one has happened, so the window stays small; the
  // catch-up for an order that has never had its history read is covered separately.
  assert.match(source, /lowestTradedPriceSince\(trade\.tokenId, historyFrom\)/);
  // A failed history read must leave the decision to the other signals rather than
  // becoming a "no fill" answer of its own.
  assert.match(source, /\/\/ A missing history is not evidence of no fill/);
  assert.match(source, /PAPER_LIMIT_ORDER_TRADE_HISTORY/,
    "the extra request per resting order has to be switchable");
});

test("limit orders: every resting order is refreshed on every pass, execution passes too", () => {
  const source = readFileSync(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");
  // How often a fill can be noticed is decided here: refreshTrades runs for every
  // portfolio on every pass, so the check cadence is the pass cadence and not the
  // portfolio's own execution cadence. An execution pass skipping it would mean a
  // portfolio on the hourly cron only ever noticing fills once an hour.
  const run = functionSource(source, "run");
  assert.match(run, /portfolioState\.trades = await refreshTrades\(portfolioState\.trades, portfolioState\)/);
  assert.ok(!/if \(!EXECUTION_PASS\)[\s\S]{0,120}refreshTrades/.test(run),
    "marking trades must not be behind an execution-pass guard");
  assert.ok(bot.OPEN_STATUSES
    ? bot.OPEN_STATUSES.has("LIMIT_ORDER_WAITING")
    : /OPEN_STATUSES = new Set\(\["OPEN", "PENDING_RESOLUTION", "MARKET_NOT_FOUND", "STOP_BREACH", "LIMIT_ORDER_WAITING"\]\)/.test(source),
    "a resting order has to be in the set the refresh walks");
});

test("limit orders: a book that cannot be read does not veto the other signals", () => {
  const source = readFileSync(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");
  const marked = functionSource(source, "markWaitingLimitOrder");
  // Measured: these tokens 404 once the market is delisted, and returning on that error
  // meant the market price and the traded history -- neither of which needs a book -- were
  // never consulted. Orders whose market had collapsed straight through them sat for hours.
  assert.ok(!/catch \(error\) \{\s*return \{ \.\.\.base, statusNote: `Order book refresh failed/.test(marked),
    "a failed book read must not return before the fill decision");
  assert.match(marked, /bookNote = ` \(order book unavailable: \$\{error\.message\}\)`/);
  assert.match(marked, /const decision = limitOrderFillDecision\(\{/,
    "the decision has to be reached whether or not the book read worked");
});

test("limit orders: the first history read reaches back to when the order was placed", () => {
  const source = readFileSync(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");
  const marked = functionSource(source, "markWaitingLimitOrder");
  // A window starting at the last look assumes every earlier look already covered its own.
  // Orders placed before this check existed had never had their history read at all, so the
  // dip that filled them stayed permanently outside every window.
  assert.match(marked, /const historyFrom = trade\.historyCheckedAt \|\| trade\.openedAt \|\| trade\.date \|\| trade\.lastCheckedAt;/);
  assert.match(marked, /lowestTradedPriceSince\(trade\.tokenId, historyFrom\)/);
  // And the marker only advances when the read actually happened, so a failed read leaves
  // the catch-up window open instead of closing it silently.
  assert.match(marked, /historyCheckedAt: lowestTradedPrice != null \|\| !needsHistory \? checkedAt : trade\.historyCheckedAt/);
});

// -- Correlation blocking: a spread is not a concentration -------------------------------
//
// Reported: portfolios skipping with "no eligible non-correlated candidate" while free
// capital and candidates both existed. Measured over those skips: 25 of 32 blocks came from
// real positions, not resting orders, and the blocking keys were overwhelmingly one event's
// mutually exclusive alternatives -- nine on a single tweet-count bracket set, where one
// order on "400-419" blocked "280-299", "420-439" and "500+" at once. Two alternatives of
// the same field cannot both win, so holding two is a hedge; refusing the second refuses it.

const tweetBracket = (range) => ({
  question: `Will Elon Musk post ${range} tweets from August 18 to August 25?`,
  outcome: "Yes",
  outcomeCount: 2,
  tokenId: `token-${range}`,
  // A bracket set is a field: exactly one range can happen.
  riskGroupKeys: [`market:elon-tweets-${range}`, "event:elon-musk-of-tweets-august-18-august-25"],
});

const openTradeFrom = (candidate, id) => ({ ...candidate, id, status: "OPEN" });

test("risk: another alternative of the same multi-outcome event is not blocked", () => {
  const held = openTradeFrom(tweetBracket("400-419"), "t1");
  // Precondition: both sides really are classified as a field, or this test proves nothing.
  assert.equal(bot.reportMarketType(held), "multi");
  assert.equal(bot.reportMarketType(tweetBracket("280-299")), "multi");

  assert.equal(bot.riskBlock(tweetBracket("280-299"), [held]), null,
    "a different bracket of the same event cannot lose alongside the one held");
  assert.equal(bot.riskBlock(tweetBracket("500+"), [held]), null);
});

test("risk: the same event still stops being added to once it is at the cap", () => {
  // Every bracket costs money and exactly one pays out, so buying the whole field is a
  // guaranteed loss. Three is the default ceiling.
  const held = ["400-419", "420-439", "440-459"].map((range, index) => openTradeFrom(tweetBracket(range), `t${index}`));
  const block = bot.riskBlock(tweetBracket("280-299"), held);
  assert.ok(block, "a fourth alternative of one event is refused");
  assert.equal(block.sameEventCount, 3);
  assert.match(bot.riskBlockReason(block), /the most one multi-outcome event may carry/);
  // Two held is still under the ceiling.
  assert.equal(bot.riskBlock(tweetBracket("280-299"), held.slice(0, 2)), null);
});

test("risk: a two-sided event keeps its strict one-position rule", () => {
  // Buying both sides of an either-or pays two spreads to hold nothing, so the event key
  // must still block outright when the event is not a field.
  const fixture = (outcome, token) => ({
    question: "Dota 2: Team Spirit vs Team Liquid - Game 2 Winner",
    outcome,
    outcomeCount: 2,
    tokenId: token,
    riskGroupKeys: ["market:dota2-ts-liquid-game2", "event:dota2-ts-liquid-2026-08-21"],
  });
  const held = openTradeFrom(fixture("Team Spirit", "a"), "t1");
  assert.equal(bot.reportMarketType(held), "binary", "vs makes this two-sided");
  const block = bot.riskBlock(fixture("Team Liquid", "b"), [held]);
  assert.ok(block, "the other side of the same fixture is still correlated");
  assert.ok(!block.atCap, "and it is refused outright, not on a count");
});

test("risk: a shared team or topic blocks whatever kind of market it is", () => {
  // Anything beyond the event itself is real correlation: those do lose together.
  const held = {
    id: "t1",
    status: "OPEN",
    question: "Will Iran close the Strait of Hormuz?",
    outcome: "Yes",
    outcomeCount: 2,
    riskGroupKeys: ["market:hormuz-close", "event:iran-escalation-2026", "topic:iran-war"],
  };
  const candidate = {
    question: "Will Israel strike Tehran before September?",
    outcome: "Yes",
    outcomeCount: 2,
    tokenId: "b",
    riskGroupKeys: ["market:tehran-strike", "event:iran-escalation-2026", "topic:iran-war"],
  };
  const block = bot.riskBlock(candidate, [held]);
  assert.ok(block, "a shared topic is correlated exposure, not a spread");
  assert.ok(block.overlap.includes("topic:iran-war"));
  assert.ok(!block.atCap);
});

test("risk: a closed trade never blocks, an unfilled order still does", () => {
  const candidate = tweetBracket("280-299");
  const otherEvent = {
    id: "t9",
    question: "Who wins the Oklahoma Republican primary runoff?",
    outcome: "Yes",
    outcomeCount: 2,
    riskGroupKeys: ["market:ok-runoff", "event:oklahoma-republican-governor-primary-runoff"],
  };
  // A resolved row has released its risk and must not block anything.
  assert.equal(bot.riskBlock(candidate, [{ ...openTradeFrom(tweetBracket("400-419"), "t1"), status: "WON" }]), null);
  assert.equal(bot.riskBlock(candidate, [{ ...otherEvent, status: "LOST" }]), null);
  // A resting order on a genuinely correlated market still blocks: it may yet fill, and the
  // portfolio would then hold both. Only the same-field relaxation above applies.
  const restingSameFixture = {
    id: "t2",
    status: "LIMIT_ORDER_WAITING",
    question: "Dota 2: Team Spirit vs Team Liquid - Game 2 Winner",
    outcome: "Team Spirit",
    outcomeCount: 2,
    riskGroupKeys: ["market:dota2-ts-liquid-game2", "event:dota2-ts-liquid-2026-08-21"],
  };
  const block = bot.riskBlock({
    question: "Dota 2: Team Spirit vs Team Liquid - Game 2 Winner",
    outcome: "Team Liquid",
    outcomeCount: 2,
    tokenId: "z",
    riskGroupKeys: ["market:dota2-ts-liquid-game2", "event:dota2-ts-liquid-2026-08-21"],
  }, [restingSameFixture]);
  assert.ok(block, "an unfilled order on the other side of one fixture still blocks");
});

test("risk: the per-event ceiling is configurable", () => {
  const source = readFileSync(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");
  assert.match(source, /MAX_PER_MULTI_OUTCOME_EVENT = Math\.max\(1, envNumber\("PAPER_MAX_PER_MULTI_EVENT", 3\)\)/);
  // Only a shared event key triggers the relaxation; team/topic overlap alone still blocks.
  assert.match(source, /const EVENT_RISK_KEY_PREFIX = "event:";/);
});

test("market type: a bracket set is a field, a date in a question is not", () => {
  // Mutually exclusive ranges of one quantity: exactly one happens.
  for (const range of ["280-299", "400-419", "65-89"]) {
    assert.equal(bot.reportMarketType({
      question: `Will Elon Musk post ${range} tweets from August 18 to August 25?`,
      outcome: "Yes",
      outcomeCount: 2,
    }), "multi", `${range} is one bracket of a field`);
  }
  assert.equal(bot.reportMarketType({
    question: "Will Elon Musk post 500+ tweets from August 18 to August 25?",
    outcome: "Yes",
    outcomeCount: 2,
  }), "multi", "the open-ended top bracket too");

  // The trap: a date contains the same digit-dash-digit shape and is not a range. Both of
  // these are real production rows and both must stay two-sided.
  assert.equal(bot.reportMarketType({
    question: "Will Arsenal FC win on 2026-08-21?", outcome: "Yes", outcomeCount: 2,
  }), "binary", "a date in the question is not a bracket");
  assert.equal(bot.reportMarketType({
    slug: "wnba-por-tor-2026-08-21-spread-away-2pt5",
    question: "Spread: Portland Fire (-2.5)",
    outcome: "Toronto Tempo",
    outcomeCount: 2,
  }), "binary", "a dated slug is not a bracket, and the rule never reads the slug");
  // A handicap carries a signed decimal, not a range.
  assert.equal(bot.reportMarketType({
    question: "Game Handicap: TS (-1.5) vs Team Liquid (+1.5)", outcome: "Team Spirit", outcomeCount: 2,
  }), "binary");
  // And a scoreline keeps its spaces, so it is caught by the exact-score rule, not this one.
  assert.equal(bot.reportMarketType({
    question: "Exact Score: Club The Strongest 3 - 3 FC Universitario?", outcome: "No", outcomeCount: 2,
  }), "multi");
});

// -- The team key entailed by being the same fixture must not veto the relaxation --------
//
// Reported in production: Conservative kept skipping with candidates on the book. Two
// exact-score lines of one match were blocked as real correlation --
// "Exact Score: Go Ahead Eagles 1-0" refused because "Exact Score: Go Ahead Eagles 0-0" was
// already held, with overlap "event:..., event:..., team:go ahead eagles". The team key is
// entailed by being the same fixture: two exact-score lines of one match always name the
// same two teams. Requiring every overlapping key to be event-scoped rejected exactly this.

const exactScoreLine = (score) => ({
  question: `Exact Score: Go Ahead Eagles ${score} ADO Den Haag?`,
  outcome: score === "0 - 0" ? "Yes" : "No",
  outcomeCount: 2,
  tokenId: `token-${score.replace(/\s/g, "")}`,
  riskGroupKeys: [
    `market:ere-goa-ado-2026-08-23-exact-score-${score.replace(/\s/g, "")}`,
    "event:ere-goa-ado-2026-08-23-exact-score",
    "event:ere-goa-ado-2026-08-23",
    "team:go ahead eagles",
  ],
});

test("risk: a shared team name entailed by the same fixture does not veto the field relaxation", () => {
  const held = openTradeFrom(exactScoreLine("0 - 0"), "t1");
  assert.equal(bot.reportMarketType(held), "multi", "exact score is a field");
  assert.equal(bot.reportMarketType(exactScoreLine("1 - 0")), "multi");

  assert.equal(bot.riskBlock(exactScoreLine("1 - 0"), [held]), null,
    "another line of the same match's exact-score field is a spread, not a second risk");
  assert.equal(bot.riskBlock(exactScoreLine("0 - 1"), [held]), null);
});

test("risk: the cap still applies to exact-score lines of one match", () => {
  const held = ["1 - 0", "0 - 1", "2 - 0"].map((score, index) => openTradeFrom(exactScoreLine(score), `t${index}`));
  const block = bot.riskBlock(exactScoreLine("0 - 0"), held);
  assert.ok(block, "a fourth line of the same match is refused once three are held");
  assert.equal(block.sameEventCount, 3);
});

test("risk: a shared team with no shared event is a different match, and still blocks", () => {
  // The boundary the fix has to respect: the same team name appearing on two DIFFERENT
  // fixtures (no event key in common) is genuine cross-match correlation, not one field's
  // own alternatives, and must keep blocking outright regardless of market type.
  const heldElsewhere = {
    id: "t1",
    status: "OPEN",
    question: "Go Ahead Eagles to reach the KNVB Cup final?",
    outcome: "Yes",
    outcomeCount: 2,
    riskGroupKeys: ["market:knvb-cup-goa-final", "event:knvb-cup-2026-27", "team:go ahead eagles"],
  };
  const block = bot.riskBlock(exactScoreLine("1 - 0"), [heldElsewhere]);
  assert.ok(block, "no shared event key means this is a different match sharing only a team");
  assert.ok(!block.atCap);
});

// -- Team extraction: the esports/league label is not a team, and "Team X" org names ------
// -- must survive their own name -----------------------------------------------------------
//
// Reported: "75 muj test" kept skipping with candidates on the book, same as Conservative
// had. The cause was one level deeper than the event-key fix: extractTeams anchors its first
// capture at the start of the question, so "Dota 2: Team Yandex vs Team Spirit - Game 2
// Winner" captured "Dota 2: Team Yandex" whole, and cleanTeamName used to strip the literal
// word "team" as filler -- deleting "Team Yandex" outright and leaving the game's own title
// standing in as if it were a team. Every Dota 2 match then shared "team:dota 2", which
// correlated matches that have nothing to do with each other. This lives in riskProfile,
// which every portfolio's candidate evaluation shares, so the fix and its tests are portfolio-
// agnostic by construction -- there is nothing to configure per portfolio, present or future.

function teamKeys(question) {
  return bot.riskProfile({ question, slug: "", eventSlug: "", outcome: "Yes", tags: [] }).keys
    .filter((key) => key.startsWith("team:"));
}

test("risk: a league label before a fixture is not extracted as a team", () => {
  assert.deepEqual(
    teamKeys("Dota 2: Team Yandex vs Team Spirit - Game 2 Winner").sort(),
    ["team:team spirit", "team:team yandex"],
    "the real teams, not the game title",
  );
  assert.deepEqual(
    teamKeys("LoL: Bilibili Gaming vs Anyone's Legend (BO3) - LPL").sort(),
    ["team:anyone s legend bo3", "team:bilibili gaming"],
  );
  assert.deepEqual(
    teamKeys("Overwatch: United States vs Sweden - Game 4 Winner").sort(),
    ["team:sweden", "team:united states"],
  );
  // No label prefix at all still works exactly as before.
  assert.deepEqual(
    teamKeys("Real Madrid vs. FC Barcelona: full time result").sort(),
    ["team:fc barcelona", "team:real madrid"],
  );
});

test("risk: two unrelated matches of the same esport no longer share a false team key", () => {
  // The actual defect: under the old rule, any match whose first team's name literally
  // started with "Team " degenerated to the game's own title. Two different, unrelated
  // matches both had that shape, so both produced "team:dota 2" -- a false correlation
  // between fixtures that share nothing but the esport.
  const first = teamKeys("Dota 2: Team Falcons vs Team Nigma - Game 1 Winner");
  const second = teamKeys("Dota 2: Team Yandex vs Team Spirit - Game 2 Winner");
  assert.ok(!first.includes("team:dota 2") && !second.includes("team:dota 2"),
    "the game's own title must never stand in as a team");
  assert.equal(first.filter((key) => second.includes(key)).length, 0,
    "two different matches' real teams must not overlap with each other");
});

test("risk: an org literally named \"Team X\" keeps its own name", () => {
  // The org names this domain is full of: Team Liquid, Team Spirit, Team Secret, Team
  // Yandex. Stripping "team" as generic filler deleted every one of them outright whenever
  // they were captured without a label prefix ahead of them (the second side of a "vs").
  assert.deepEqual(teamKeys("Game Handicap: TS (-1.5) vs Team Liquid (+1.5)").sort(),
    ["team:team liquid 1 5", "team:ts 1 5"]);
  assert.ok(teamKeys("CS2: Nemiga vs FORZE Reload (BO3) - Moscow").includes("team:nemiga"));
});

test("risk: a trailing game/map descriptor after a dash is not part of the name", () => {
  const source = readFileSync(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");
  assert.match(source, /\.replace\(\/\\s\+-\\s\+\.\*\$\/, " "\)/,
    "a trailing \" - Game 2\", \" - LPL\" etc. must be stripped before the outcome-word rule runs");
  assert.ok(!/\\b\(to advance\|advance\|win\|wins\|winner\|draw\|end\|team\)\\b/.test(source),
    "\"team\" must not be in the destructive filler list any more");
});

// -- A floor is not a band, and a reward/risk rule only ever trades the band --------------
//
// Reported: league-of-legends read 90.5% accuracy and +13.9% ROI in the tag statistics while
// the portfolio was an extreme failure. Both numbers were true of their own population, and
// those populations are opposite ends of the same one.
//
// Measured on production. Differencing adjacent floors recovers each band:
//   floor 60% claims 94.1% over 38,699   ->  band 60-65% wins 64.9% over 1,835
//   floor 50% claims 76.3% over 59,089   ->  band 50-55% wins 40.6% over 18,490
// and the portfolio put 17 of its 19 closed trades within 5 points of its 60% floor,
// entering at 63.9% on average against the row's 79.1%. The reason is arithmetic, not luck:
// reward per dollar risked is (1-p)/p, strictly decreasing in p, so ranking by reward/risk
// descending is ranking by probability ascending. The rule buys at the floor by construction.
//
// The execution hypothesis was measured and killed: repricing the same trades at the mid
// recovered $0.00, because they already paid the mid.

test("statistics: a floor keeps every higher entry, a band stops at the next floor", () => {
  const source = readFileSync(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");
  const matches = new Function(
    `${functionSource(source, "scrapedSimulationMatchesRule")}; return scrapedSimulationMatchesRule;`,
  )();
  const row = (entry) => ({ entry, marketType: "binary", days: 1 });

  // The floor, unchanged: everything at or above it, which is why a 60% row is dominated by
  // entries near 100% and reads far better than a 60% entry ever does.
  const floor = { marketType: "all", threshold: 0.6, maxResolutionDays: 7 };
  assert.equal(matches(row(0.60), floor), true, "the floor itself is included");
  assert.equal(matches(row(0.95), floor), true, "and so is everything above it");
  assert.equal(matches(row(0.59), floor), false);

  // The band: the same floor, closed ten points up. Half-open so adjacent bands neither
  // overlap nor drop an entry, which is what lets them be compared against each other.
  // Entries cluster on the round numbers, so a closed upper end would file a 70% trade
  // under both 60-70% and 70-80% and quietly double-count the most common price of all.
  const band = { ...floor, upperThreshold: 0.7 };
  assert.equal(matches(row(0.60), band), true);
  assert.equal(matches(row(0.699), band), true);
  assert.equal(matches(row(0.70), band), false, "the next band's own entries belong to it");
  assert.equal(matches(row(0.95), band), false, "the band must exclude what inflates the floor");

  // The other criteria keep working inside a band.
  assert.equal(matches({ entry: 0.62, marketType: "multi", days: 1 },
    { marketType: "binary", threshold: 0.6, upperThreshold: 0.7 }), false);
  assert.equal(matches({ entry: 0.62, marketType: "binary", days: 30 },
    { marketType: "all", threshold: 0.6, upperThreshold: 0.7, maxResolutionDays: 7 }), false);
});

test("statistics: a band reports what the floor above it hides", () => {
  // The behaviour, not the shape: build a report whose 60% floor is dominated by a
  // near-certain winner, and whose own 60-70% band is a loser. The floor must read well and
  // the band must read badly, because that is exactly the disagreement that was reported.
  const at = (id, entry, won) => ({
    id,
    tokenId: `${id}`.padEnd(20, "0"),
    question: `Will ${id} be true?`,
    outcome: "Yes",
    status: "RESOLVED",
    marketClosed: true,
    firstMarketProbability: entry,
    lastLiveMarketProbability: entry,
    finalOutcomePrice: won ? 1 : 0,
    firstDaysToResolution: 3,
    firstSpread: 0.02,
    firstPolymarketCategories: ["esports"],
    firstPolymarketTags: ["league-of-legends"],
  });
  const report = bot.buildCalculationReport(bot.normalizeState({
    marketObservations: [
      // Four in the band, one win: 25%. Thirty far above it, all wins. The count matters:
      // a winner bought at 90% returns $0.56 on a $5 stake while a loser costs the whole
      // $5, so it takes nine of them to pay for one, and a smaller high group would leave
      // the floor negative too and prove nothing.
      at("band-1", 0.62, false), at("band-2", 0.63, false),
      at("band-3", 0.64, false), at("band-4", 0.66, true),
      ...Array.from({ length: 30 }, (unused, index) => at(`high-${index}`, 0.9, true)),
    ],
  }));
  const rule = (maxProbability) => report.parameterSummaries.find((row) => row.marketType === "all"
    && row.threshold === 0.6 && row.maxResolutionDays === 3
    && (maxProbability == null ? row.maxProbability == null : row.maxProbability === maxProbability));

  const floor = rule(null);
  const band = rule(0.7);
  assert.ok(floor && band, "a 60% rule must be reported both open above and bounded");
  assert.equal(floor.trades, 34, "the floor keeps every entry above it");
  assert.equal(floor.wins, 31);
  assert.equal(band.trades, 4, "the band keeps only its own ten points");
  assert.equal(band.wins, 1);
  assert.ok(floor.winRate - band.winRate > 0.5,
    `the floor must read far better than the band it opens on: ${floor.winRate} vs ${band.winRate}`);
  assert.ok(floor.avgProbability > band.avgProbability + 0.2,
    "and the floor's average entry must sit far above the band a reward/risk rule buys in");
  // The gap is the whole point: the floor is profitable and the band is not.
  assert.ok(floor.roi > 0 && band.roi < 0, `${floor.roi} vs ${band.roi}`);

  // The tag ladder carries the same pair, which is the table the report was about.
  const tag = report.tagSummaries.find((row) => row.label === "league-of-legends");
  const rung = (probabilityRange) => tag?.minimumProbabilitySummaries
    ?.find((row) => row.minimumProbability === 0.6 && row.probabilityRange === probabilityRange);
  assert.equal(rung("floor")?.trades, 34);
  assert.equal(rung("band")?.trades, 4);
});

test("statistics: the browser shows a row's probability range, floor or band", () => {
  const app = readFileSync(new URL("../assets/app.js", import.meta.url), "utf8");
  const cell = new Function(
    `${functionSource(app, "normalizeOptionalProbability")}
     ${functionSource(app, "probabilityRangeCell")}
     const probability = (value) => \`\${(value * 100).toFixed(1)}%\`;
     return probabilityRangeCell;`,
  )();
  // A floor states that it is open above, so it can never be mistaken for a measurement of
  // the range it names.
  assert.equal(cell(0.6, null), ">= 60.0%");
  assert.equal(cell(0.6, 0.7), "60.0%-70.0%");
  assert.equal(cell(null, null), "-");

  // Both statistics tables carry the column, and both can sort by it.
  assert.match(app, /calculationHeader\("probabilityRange", "Probability"\)/);
  assert.match(app, /taxonomyHeader\(kind, "probabilityRange", "Probability"/);
  assert.equal([...app.matchAll(/if \(key === "probabilityRange"\) return numeric\(row\./g)].length, 2,
    "each table sorts with its own value getter");

  // And a band row can be turned straight into a portfolio bounded to it, which is the
  // only way to act on the finding: a floor-and-reward/risk portfolio buys at the floor by
  // construction, so capping it is what makes it trade the range it was chosen for.
  assert.match(app, /maxProbability: row\.maxProbability \?\? "",/);
});

// -- A quote nobody was on the other side of ---------------------------------------------
//
// Reported: the scrape lands too early, while a fixture has no volume and the gap between
// bid and ask is enormous. The row then reads as lucrative at a price no order could have
// been filled at, because there was no counterparty. Asked for: count only trades whose
// spread is under 5 points, in the statistics and at entry alike.
//
// Measured on the 600 newest open Polymarket markets before any of this was written. Gamma
// populates spread on 600 of 600, and it equals bestAsk - bestBid on 516 of the 516 that
// carry both -- so it is in probability units and "5 points" is 0.05. The distribution is
// not a tail, it is the bulk: median 90 points, p75 97. A 5-point gate keeps 66 of 600, and
// the markets above 10 points number 521, every single one of them with zero 24h volume.
//
// A volume floor does not catch these. rowVolumeUsdc prefers lifetime volume over the last
// 24 hours, so a long-listed fixture that nobody is quoting today still clears it -- the
// median 24h volume across leagueoflegends' own closed trades was $45 against a configured
// $10,000 gate.

test("spread: a row is only tradable if something was quoting near it", () => {
  const tight = { firstSpread: 0.02 };
  const wide = { firstSpread: 0.9 };
  assert.equal(bot.observationSpread(tight), 0.02);
  assert.equal(bot.observationSpreadIsTradable(tight), true);
  assert.equal(bot.observationSpreadIsTradable(wide), false);
  // Exactly at the limit is still tradable; a hair over is not.
  assert.equal(bot.observationSpreadIsTradable({ firstSpread: 0.05 }), true);
  assert.equal(bot.observationSpreadIsTradable({ firstSpread: 0.0501 }), false);

  // Either representation answers the question, and they agree.
  assert.equal(bot.observationSpread({ firstBestAsk: 0.99, firstBestBid: 0.09 }), 0.9);
  assert.equal(bot.observationSpreadIsTradable({ firstBestAsk: 0.99, firstBestBid: 0.09 }), false);
  assert.equal(bot.observationSpreadIsTradable({ bestAsk: 0.71, bestBid: 0.69 }), true);

  // What to do with a row that recorded no spread at all is a policy, not a fact, and the
  // two sides answer it differently on purpose -- so each is asserted against the policy in
  // force rather than against one of its settings. Hardcoding either turns a deliberate
  // change of the owner's mind into a red test.
  assert.equal(bot.observationSpread({}), null);
  assert.equal(bot.observationSpreadIsTradable({}), bot.COUNT_UNKNOWN_SPREAD_AS_TRADABLE,
    "the statistics must follow PAPER_COUNT_UNKNOWN_SPREAD");
  assert.equal(bot.candidateSpreadIsTradable({}), bot.OPEN_ON_UNKNOWN_SPREAD,
    "an entry must follow PAPER_OPEN_ON_UNKNOWN_SPREAD");
  // They are allowed to differ, and the reason they may is worth stating: refusing every
  // row the scan has not revisited would idle a portfolio over missing data rather than
  // over a wide book, while the statistics can afford to wait for evidence.
  assert.equal(typeof bot.COUNT_UNKNOWN_SPREAD_AS_TRADABLE, "boolean");
  assert.equal(typeof bot.OPEN_ON_UNKNOWN_SPREAD, "boolean");
  // A recorded wide book is evidence, and it is refused on both sides.
  assert.equal(bot.candidateSpreadIsTradable({ spread: 0.9 }), false);
  assert.equal(bot.observationSpreadIsTradable({ firstSpread: 0.9 }), false);

  // The two readers disagree on purpose. The statistics judge the price the simulation
  // entered at, which is the discovery-time quote; an entry judges the book as it is now.
  // A market that has since tightened does not make the original entry real, and a market
  // that has since widened is not one to send an order into.
  const tightenedSinceDiscovery = { firstSpread: 0.9, spread: 0.01 };
  assert.equal(bot.observationSpread(tightenedSinceDiscovery), 0.9);
  assert.equal(bot.liveObservationSpread(tightenedSinceDiscovery), 0.01);
  assert.equal(bot.observationSpreadIsTradable(tightenedSinceDiscovery), false);
  assert.equal(bot.candidateSpreadIsTradable(tightenedSinceDiscovery), true);
  // And each falls back to the other when its own side is missing.
  assert.equal(bot.liveObservationSpread({ firstSpread: 0.02 }), 0.02);
  assert.equal(bot.observationSpread({ spread: 0.02 }), 0.02);
});

test("spread: an untradable quote is kept out of the statistics and counted where it went", () => {
  const row = (id, firstSpread) => ({
    id,
    tokenId: `${id}`.padEnd(20, "0"),
    question: `Will ${id} be true?`,
    outcome: "Yes",
    status: "RESOLVED",
    marketClosed: true,
    firstMarketProbability: 0.8,
    lastLiveMarketProbability: 0.8,
    finalOutcomePrice: 1,
    firstDaysToResolution: 2,
    firstPolymarketTags: ["esports"],
    ...(firstSpread == null ? {} : { firstSpread }),
  });
  const report = bot.buildCalculationReport(bot.normalizeState({
    marketObservations: [row("tradable", 0.02), row("unquoted", 0.9), row("unrecorded", null)],
  }));

  // The row with a recorded 90-point book is out whatever the policy says -- that is the
  // whole point of the gate, and it is the assertion that must never soften. Whether the
  // row that recorded no spread at all joins it follows PAPER_COUNT_UNKNOWN_SPREAD, so the
  // expected sample is derived from the policy rather than fixed at one of its settings.
  const measurable = bot.COUNT_UNKNOWN_SPREAD_AS_TRADABLE ? 2 : 1;
  assert.equal(report.sampleSize, measurable,
    "a recorded wide book is always out; an unrecorded one follows the policy");
  assert.equal(report.spreadScrapedCount, 3, "and the report says how many it started from");
  assert.equal(report.spreadExcludedCount, 3 - measurable);
  assert.equal(report.maxTradableSpread, 0.05, "the limit in force is published with the count");
  // Nothing was deleted to achieve this: the observations are all still in the state.
  const rule = report.parameterSummaries.find((r) => r.marketType === "all"
    && r.threshold === 0.5 && r.maxResolutionDays === 30 && r.maxProbability == null);
  assert.equal(rule.trades, measurable);
  assert.equal(report.tagSummaries.find((r) => r.label === "esports")?.trades, measurable);
  // Whatever the policy, the tradable row survives and the wide one does not, so the
  // sample can never be empty here and can never contain the 90-point book.
  assert.ok(report.sampleSize >= 1 && report.sampleSize <= 2);
});

test("spread: a portfolio will not open a position it could not have been filled on", () => {
  const strategy = {
    ...bot.PAPER_STRATEGIES.conservative,
    probabilitySource: "polymarket",
    minProbability: 0.8,
    maxProbability: null,
    minLiquidityUsdc: null,
    minNetYield: 0,
    marketType: "all",
    requireMostProbableOutcome: false,
    excludedCandidateTokenIds: new Set(),
  };
  const candidate = (spread) => ({
    tokenId: "12345678901234567890",
    status: "SCRAPED",
    question: "Will the event happen?",
    outcome: "Yes",
    marketProbability: 0.95,
    marketPrice: 0.95,
    volumeUsdc: 100000,
    daysToResolution: 1,
    netGainIfWinUsdc: 0.25,
    totalCostUsdc: 5,
    ...(spread == null ? {} : { spread }),
  });

  assert.equal(bot.strategyEligibleCandidates([candidate(0.02)], strategy).length, 1);
  assert.deepEqual(bot.strategyEligibleCandidates([candidate(0.9)], strategy), [],
    "a 90-point book has no counterparty at the midpoint the row is quoting");
  // A row nothing has looked at yet is still openable. The statistics exclude it, because
  // there it would have to prove its entry was reachable; an entry decision must not stall
  // a whole portfolio on the scan's coverage, which takes most of a day to come round.
  assert.equal(bot.strategyEligibleCandidates([candidate(null)], strategy).length, 1);

  // And the run log says exactly what was wrong, because "no eligible candidate" with a
  // full shortlist behind it is exactly the report that has come back three times now.
  const wide = bot.portfolioFilterResult(candidate(0.9), strategy);
  assert.equal(wide.eligible, false);
  assert.ok(wide.reasons.some((reason) => /spread 90\.0 points exceeds 5\.0/.test(reason)), wide.reasons.join(" | "));
});

test("spread: the browser, the bot and api.php apply one rule", async () => {
  const { readFile } = await import("node:fs/promises");
  const [api, app, botSource] = await Promise.all([
    readFile(new URL("../api.php", import.meta.url), "utf8"),
    readFile(new URL("../assets/app.js", import.meta.url), "utf8"),
    readFile(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8"),
  ]);

  // The execution shortlist is served by PHP and then re-filtered by the bot. If the two
  // limits drifted apart the screen would offer rows the run refuses, which is the shape of
  // every "candidates exist but the run skipped" report so far.
  const botLimit = /PAPER_MAX_TRADABLE_SPREAD", ([\d.]+)\)/.exec(botSource);
  const phpLimit = /const MAX_TRADABLE_SPREAD = ([\d.]+);/.exec(api);
  assert.ok(botLimit && phpLimit, "both sides must state their limit");
  assert.equal(Number(botLimit[1]), Number(phpLimit[1]));
  assert.equal(Number(botLimit[1]), 0.05, "five points, as asked");

  // PHP reads the same fields.
  const phpReader = /function observation_spread\(array \$item\): \?float[\s\S]*?\n\}/.exec(api);
  assert.ok(phpReader);
  for (const field of ["spread", "bestAsk", "bestBid", "firstSpread", "firstBestAsk", "firstBestBid"]) {
    assert.match(phpReader[0], new RegExp(`'${field}'`), `${field} must be read`);
  }
  assert.match(api, /return \$spread <= MAX_TRADABLE_SPREAD;/);

  // A row that recorded no spread is a policy question, not a fact, and the policy is set
  // in one place: PAPER_COUNT_UNKNOWN_SPREAD for the statistics. What must never drift is
  // that the drill-down list behind a statistics row applies whatever that policy says --
  // a list holding a different set from the number it was opened from is the complaint this
  // endpoint exists to answer. So the default is read rather than assumed, and PHP is
  // required to match it.
  const statisticsAdmitsUnknown = /PAPER_COUNT_UNKNOWN_SPREAD", (true|false)\)/.exec(botSource);
  assert.ok(statisticsAdmitsUnknown, "the statistics must state their unknown-spread policy");
  const drilldown = /\/\/ [^\n]*\n(?:\s+\/\/[^\n]*\n)*\s+if \(!observation_spread_is_tradable\(\$item(, true)?\)\) \{\n\s+return true;/.exec(api);
  assert.ok(drilldown, "the drill-down list must apply the gate");
  assert.equal(Boolean(drilldown[1]), statisticsAdmitsUnknown[1] === "true",
    `the drill-down admits unknown spreads ${Boolean(drilldown[1])} while the statistics say ${statisticsAdmitsUnknown[1]}`);

  // The execution shortlist is the one place that is permissive regardless: refusing every
  // row the scan has not revisited would idle a portfolio over missing data rather than
  // over a wide book, and the scan takes most of a day to come round.
  assert.match(api, /if \(!observation_spread_is_tradable\(\$item, true\)\) \{\n\s+return false;/,
    "the execution shortlist must not empty itself over rows nothing has looked at yet");

  // The fields have to survive transport, or the executor sees a row with no spread on it
  // and drops everything.
  const compaction = /function compact_market_observation\(array \$item\): array[\s\S]*?\n\}/.exec(api);
  assert.ok(compaction);
  for (const field of ["firstSpread", "firstBestAsk", "firstBestBid", "spread", "bestAsk", "bestBid"]) {
    assert.match(compaction[0], new RegExp(`'${field}',`), `${field} must be carried through the compaction`);
  }

  // The scan is what puts them there in the first place.
  const scan = functionSource(botSource, "preferredMarketObservation");
  assert.match(scan, /firstSpread: numericOrNull\(market\.spread\)/);
  assert.match(scan, /spread: numericOrNull\(market\.spread\)/);

  // A shrinking sample must read as deliberate rather than as data loss.
  assert.match(app, /report\.spreadExcludedCount/);
  assert.match(app, /held back: bid\/ask wider than/);
});

test("market type: api.php classifies exactly as the bot does", async () => {
  // Reported: the "Paper 75" portfolio shows no candidates and does not execute. It is set
  // to multi-outcome, and the execution endpoint served it 0 rows out of 1,060 -- because
  // api.php still classified with `outcomeCount > 2 ? multi : binary`, the very shortcut the
  // bot stopped using. Polymarket quotes a field as one Yes/No market per member, so every
  // election candidate and every correct-score line carries exactly two outcomes and read as
  // binary. A multi portfolio therefore matched nothing that exists.
  //
  // PHP builds the shortlist and the bot re-filters it, so the two rules must agree on every
  // case or the screen shows one set of candidates and the run trades another. This runs
  // both over the same list rather than comparing their source.
  const { execFileSync } = await import("node:child_process");
  const api = readFileSync(new URL("../api.php", import.meta.url), "utf8");
  // Including api.php would answer a request, so the classifier is lifted out and evaluated
  // on its own -- the same trick functionSource() plays on the JS side.
  const start = api.indexOf("function observation_market_type(array $item): string");
  assert.ok(start >= 0, "api.php must define observation_market_type");
  const end = api.indexOf("\n}", start);
  assert.ok(end > start);
  const classifier = api.slice(start, end + 2);

  const cases = MARKET_TYPE_CASES.map(([expected, item]) => ({ expected, item }));
  const encodedCases = Buffer.from(JSON.stringify(cases.map((row) => row.item))).toString("base64");
  const encodedFunction = Buffer.from(classifier).toString("base64");
  const output = execFileSync("php", ["-r",
    `eval(base64_decode('${encodedFunction}'));`
    + ` $rows = json_decode(base64_decode('${encodedCases}'), true);`
    + ` $out = []; foreach ($rows as $row) { $out[] = observation_market_type($row); }`
    + ` echo json_encode($out);`,
  ], { encoding: "utf8" });
  const verdicts = JSON.parse(output);
  assert.equal(verdicts.length, cases.length);
  for (let index = 0; index < cases.length; index += 1) {
    const { expected, item } = cases[index];
    assert.equal(verdicts[index], expected,
      `PHP: ${JSON.stringify(item.question || item.slug)} should be ${expected}`);
    assert.equal(verdicts[index], bot.reportMarketType(item),
      `PHP and the bot disagree about ${JSON.stringify(item.question || item.slug)}`);
  }
});

// Reported: the scraping log said several runs each added thousands of new events while
// the scraped list stayed at about 1200, so either the rows were not accumulating or the
// log was wrong. Measured on production: the catalogue does accumulate -- 68581 rows
// stored, and the active set grew 1200 -> 2859 over three hours -- but the log's "new"
// count really is misleading. A scan deliberately never loads the resolved archive, so it
// compares against the active working set alone, and a short-dated market that resolved
// since it was last seen counts as new again on every re-read. That is how twelve runs
// reported 17507 new rows while the active set grew by under 1700.
test("scan log: a run reports what the catalogue did, not only what was new to the working set", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  // The before count is the working set, and the after count is measured once the merge
  // and the retention pass have run -- taking it any earlier would report the intent
  // rather than the result.
  assert.match(source, /const activeObservationCountBefore = previousKeys\.size;/);
  assert.match(source, /const activeObservationCountAfter = \(state\.marketObservations \|\| \[\]\)/);
  const afterMerge = source.indexOf("const activeObservationCountAfter");
  const merge = source.indexOf("state.marketObservations = retainMarketObservations(");
  assert.ok(merge >= 0 && afterMerge > merge,
    "the after count must be taken once the catalogue has actually been updated");
  // Resolved rows are not part of the working set the list shows, so they cannot be
  // counted into it or the net figure would grow for ever and mean nothing.
  assert.match(source, /!== "RESOLVED"\)\.length;/);
  assert.match(source, /netObservationCount: activeObservationCountAfter - activeObservationCountBefore,/);

  // And the browser has to show it, or the number is published and never read.
  assert.match(app, /catalogue \$\{Number\(run\.netObservationCount\) >= 0 \? "\+" : ""\}/);
  assert.match(app, /const net = Number\(run\.netObservationCount\);/);

  // The arithmetic itself, on the shape a real run publishes.
  const netOf = new Function("run", `
    const formatInteger = (value) => String(value);
    ${/const net = Number\(run\.netObservationCount\);[\s\S]*?: "";/.exec(app)[0]}
    return netText;
  `);
  assert.equal(netOf({ netObservationCount: 0 }), ", catalogue +0",
    "a run that added nothing must say so rather than staying silent");
  assert.equal(netOf({ netObservationCount: 1659 }), ", catalogue +1659");
  // Markets resolve out of the working set faster than they arrive, so a shrinking
  // catalogue is ordinary and must read as a fall, not as an unsigned number.
  assert.equal(netOf({ netObservationCount: -240 }), ", catalogue -240");
  // A run recorded before the field existed must not print "catalogue NaN".
  assert.equal(netOf({}), "");
});
