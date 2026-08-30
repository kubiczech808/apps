// Runs offline: no secrets, no network, no hosting access. Importing the executor
// does not start a run, so no order can be placed from a test.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import test from "node:test";

const executor = await import("../tools/live-order-executor.mjs");
const sync = await import("../tools/live-account-sync.mjs");

const THRESHOLD = executor.ROTATION_PROTECT_REMAINING_GAIN_USDC;

const STAKE = 5;
const MAX_WIN = 0.5;
const SHARES = STAKE + MAX_WIN;

const HOUR_AGO = () => new Date(Date.now() - 3600000).toISOString();
const NEXT_WEEK = () => new Date(Date.now() + 7 * 86400000).toISOString();

// Builds a position whose *net exit* P/L sits `remaining` USDC short of its maximum
// win. The mark price is derived rather than asserted, because the economics are
// computed from shares * price - cost, not from a stored P/L field.
function position({ remaining, endDate = null, feeRate = 0 }) {
  const targetSellPnl = MAX_WIN - remaining;
  return {
    tokenId: "1000000000000000001",
    question: "Fixture market",
    outcome: "Yes",
    status: "OPEN",
    shares: SHARES,
    stakeUsdc: STAKE,
    totalCostUsdc: STAKE,
    maxLossUsdc: STAKE,
    netGainIfWinUsdc: MAX_WIN,
    currentPrice: (STAKE + targetSellPnl) / SHARES,
    feeRate,
    feesEnabled: feeRate > 0,
    endDate,
  };
}

const economicsFor = (options) => executor.positionRotationEconomics(position(options));
const remainingFor = (options) => economicsFor(options).remainingPotentialGainUsdc;
const lockedFor = (options) => economicsFor(options).settlementLocked;
const exhaustedFor = (options) => economicsFor(options).upsideExhausted;

test("rotation: the threshold is two cents", () => {
  assert.equal(THRESHOLD, 0.02);
});

test("live history: an unmatched redeem remains a closed, correct position", () => {
  const rows = sync.closedTradesFromHistory([], [{
    type: "REDEEM",
    timestamp: "2026-08-30T18:05:31Z",
    question: "A winning market whose buy aged out of the public trade feed",
    outcome: "Yes",
    conditionId: "condition-1",
    size: 6.41,
    usdcValue: 6.41,
    transactionHash: "redeem-1",
  }], "2026-08-30T18:10:00Z");

  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "REDEEMED");
  assert.equal(rows[0].finalOutcomePrice, 1, "a Polymarket redemption is a resolved winner");
  assert.equal(rows[0].reconciliationOnly, true);
  assert.equal(rows[0].stakeUsdc, null, "the missing buy is not guessed as a zero-dollar stake");
  assert.equal(rows[0].realizedPnlUsdc, null, "the missing buy is not guessed as zero P/L");
});

test("live history: only fully unfilled limit orders are retained as their own audit ledger", () => {
  const generatedAt = "2026-08-30T18:10:00Z";
  const history = sync.unfilledLimitOrderHistory({
    unfilledLimitOrders: [{
      id: "older-order",
      tokenId: "older-token",
      status: "LIVE_LIMIT_ORDER_UNFILLED",
      price: 0.74,
      openedAt: "2026-08-29T18:10:00Z",
      closedAt: "2026-08-29T19:10:00Z",
    }],
  }, {
    vanished: [{
      id: "unfilled-order",
      tokenId: "unfilled-token",
      question: "A market that never filled",
      outcome: "Yes",
      price: 0.8,
      remainingSize: 6.25,
      releasedCapitalUsdc: 5,
      filledSize: 0,
      partiallyFilled: false,
      createdAt: "2026-08-30T17:10:00Z",
      detectedAt: generatedAt,
    }, {
      id: "partial-order",
      tokenId: "partial-token",
      price: 0.8,
      releasedCapitalUsdc: 2,
      filledSize: 2.5,
      partiallyFilled: true,
      createdAt: "2026-08-30T17:10:00Z",
      detectedAt: generatedAt,
    }],
  });

  assert.equal(history.length, 2, "the partially filled order became a position and must not enter this ledger");
  const row = history.find((item) => item.id === "unfilled-order");
  assert.equal(row.status, "LIVE_LIMIT_ORDER_UNFILLED");
  assert.equal(row.entryPrice, undefined, "a resting price must not make the UI treat this as a filled position");
  assert.equal(row.price, 0.8);
  assert.equal(row.stakeUsdc, 5);

  const repeated = sync.unfilledLimitOrderHistory({ unfilledLimitOrders: history }, { vanished: [row] });
  assert.equal(repeated.length, 2, "a repeated sync must not duplicate the same vanished order");
});

test("portfolio UI: unfilled limit orders have a dedicated route and do not remain in closed trades", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const app = readFileSync(new URL("../assets/app.js", import.meta.url), "utf8");

  assert.match(html, /data-tab-target="unfilled-limit-orders"/);
  assert.match(html, /data-unfilled-limit-orders-summary/);
  assert.match(app, /"unfilled-limit-orders": "unfilled-limit-orders"/);
  assert.match(app, /function isUnfilledLimitOrder\(order = \{\}\)/);
  assert.match(app, /filter\(\(trade\) => isClosedTrade\(trade\) && !isUnfilledLimitOrder\(trade\)\)/);
});

test("closed trades: entry volume is recorded at live submission and rendered separately from the live mark", () => {
  const executorSource = readFileSync(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8");
  const app = readFileSync(new URL("../assets/app.js", import.meta.url), "utf8");

  assert.match(executorSource, /entryVolumeUsdc: candidate\.volumeUsdc == null \|\| candidate\.volumeUsdc === "" \? null : number\(candidate\.volumeUsdc\)/);
  assert.match(app, /function tradeEntryVolumeUsdc\(trade = \{\}\)/);
  assert.match(app, /tradeHeader\(tableKey, "entryVolume", "Entry volume"\)/);
  assert.match(app, /entry_volume_usdc: csvNumber\(tradeEntryVolumeUsdc\(trade\), 1, 2\)/);
});

test("rotation: the fixture drives the economics the executor actually reads", () => {
  // Guards the test itself: if the derived price stopped producing the intended
  // remaining gain, every assertion below would silently test nothing.
  assert.ok(Math.abs(remainingFor({ remaining: 0.01 }) - 0.01) < 1e-9);
  assert.ok(Math.abs(remainingFor({ remaining: 0.3 }) - 0.3) < 1e-9);
});

test("rotation: past resolution with real upside left is protected", () => {
  // The case worth waiting out: settlement is overdue and the position still has
  // meaningful money to collect, so no candidate may take its capital.
  for (const remaining of [0.021, 0.05, 0.3, 0.5]) {
    assert.equal(
      lockedFor({ remaining, endDate: HOUR_AGO() }),
      true,
      `remaining ${remaining} USDC past resolution must be held`,
    );
  }
});

test("rotation: past resolution with nothing left to collect is released", () => {
  // Waiting no longer earns anything, so the capital is freed instead of parked
  // until settlement.
  for (const remaining of [0, 0.005, 0.02]) {
    const economics = economicsFor({ remaining, endDate: HOUR_AGO() });
    assert.equal(economics.settlementLocked, false, `remaining ${remaining} USDC must not be held`);
    assert.equal(economics.upsideExhausted, true, `remaining ${remaining} USDC has nothing left to wait for`);
  }
});

test("rotation: a future resolution is never protected", () => {
  // The protection exists only for positions stuck awaiting settlement. One that has
  // not reached its end date follows the ordinary improvement rules.
  for (const remaining of [0.01, 0.3, 0.5]) {
    assert.equal(
      lockedFor({ remaining, endDate: NEXT_WEEK() }),
      false,
      `remaining ${remaining} USDC before resolution must stay rotatable`,
    );
  }
});

test("rotation: a missing end date does not count as elapsed", () => {
  // Sports rows carry unreliable dates. Treating unknown as past would strand
  // capital in a position nobody can prove is overdue.
  assert.equal(lockedFor({ remaining: 0.3, endDate: null }), false);
  assert.equal(economicsFor({ remaining: 0.3, endDate: null }).noDaysLeft, true, "still reported as no usable horizon");
});

test("rotation: the boundary is inclusive on the release side", () => {
  const past = HOUR_AGO();
  assert.equal(exhaustedFor({ remaining: THRESHOLD, endDate: past }), true);
  assert.equal(lockedFor({ remaining: THRESHOLD, endDate: past }), false);
  assert.equal(exhaustedFor({ remaining: THRESHOLD + 0.001, endDate: past }), false);
  assert.equal(lockedFor({ remaining: THRESHOLD + 0.001, endDate: past }), true);
});

test("rotation: upside exhaustion is independent of the horizon", () => {
  // Nothing left to collect means nothing to wait for, whenever it lands.
  assert.equal(exhaustedFor({ remaining: 0.01, endDate: HOUR_AGO() }), true);
  assert.equal(exhaustedFor({ remaining: 0.01, endDate: NEXT_WEEK() }), true);
  assert.equal(exhaustedFor({ remaining: 0.01, endDate: null }), true);
});

test("rotation: the exit fee counts against the remaining gain", () => {
  // A taker exit fee lowers the net sell P/L, so a position that looks two cents from
  // its win before fees can still have real upside after them. The threshold must be
  // measured after fees, like every other economic check.
  const withoutFee = remainingFor({ remaining: 0.01, endDate: HOUR_AGO() });
  const withFee = remainingFor({ remaining: 0.01, endDate: HOUR_AGO(), feeRate: 0.02 });
  assert.ok(withFee > withoutFee, `the fee must widen the gap, got ${withFee} vs ${withoutFee}`);
});

test("rotation: the veto precedes the ranking metric and exhaustion bypasses it", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8");

  // The veto is evaluated first, and an exhausted position may rotate without
  // clearing the improvement threshold, because the metric cannot judge either case.
  assert.match(source, /const rotationPreferred = !settlementLocked/);
  // The exact decision shape is asserted by the horizon test below; here it is enough
  // that exhaustion is an alternative to the improvement threshold, not a precondition.
  assert.match(source, /\(upsideExhausted\s*\n\s*\|\|/);
  assert.equal(/const settlementLocked = resolutionPast && !upsideExhausted;/.test(source), true);

  // Both outcomes must be explained in words in the run log.
  assert.ok(source.includes("resolution is already past and this position still has $"));
  assert.ok(source.includes("short of its maximum win, within the $"));
});

test("rotation: the real remaining horizon is reported unfloored", () => {
  // The annualization floor is one hour, so the floored `daysToResolution` cannot be
  // used to compare horizons: every sub-hour position would look like a full hour and
  // tie with the candidate. rawRemainingDays keeps the true value, including zero and
  // negative when settlement is overdue.
  const soon = executor.positionRotationEconomics(position({
    remaining: 0.3,
    endDate: new Date(Date.now() + 3600000).toISOString(),
  }));
  assert.ok(Math.abs(soon.rawRemainingDays - 1 / 24) < 0.01, `expected ~1h, got ${soon.rawRemainingDays}`);
  assert.ok(soon.daysToResolution >= 1 / 24, "the floored value is still available for annualization");

  const overdue = executor.positionRotationEconomics(position({
    remaining: 0.3,
    endDate: new Date(Date.now() - 7200000).toISOString(),
  }));
  assert.ok(overdue.rawRemainingDays < 0, "an overdue position reports a negative horizon");

  const unknown = executor.positionRotationEconomics(position({ remaining: 0.3, endDate: null }));
  assert.equal(unknown.rawRemainingDays, null, "an unknown horizon stays null rather than guessing");
});

test("rotation: a replacement that resolves later is refused", async () => {
  // Selling a nearer payout to buy a more distant one forfeits the running position's
  // remaining profit, and the candidate is very likely still available afterwards.
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8");

  assert.match(
    source,
    /const candidateResolvesLater = positionRemainingDays != null\s*\n\s*&& candidateDays != null\s*\n\s*&& candidateDays >= positionRemainingDays;/,
    "an equal or later candidate horizon must block the swap",
  );
  // It gates the metric path but must not gate the exhausted-upside path, which is the
  // case where holding earns nothing more.
  assert.match(
    source,
    /\(upsideExhausted\s*\n\s*\|\| \(!candidateResolvesLater\s*\n\s*&& priorityDelta >= ROTATION_MIN_PRIORITY_IMPROVEMENT/,
    "exhausted upside still releases capital regardless of horizons",
  );
  // The horizon comparison must use the unfloored value.
  assert.match(source, /const positionRemainingDays = number\(economics\.rawRemainingDays\);/);
  assert.ok(source.includes("selling now would forfeit a nearer payout for a more distant one"));
});

test("rotation: potential p.a. cannot bank a larger dollar loss", async () => {
  // Live regression: the old position would lose 0.155 USDC at the executable bid and
  // the replacement could win only 0.2524 USDC. Its spectacular short-horizon p.a. did
  // not make up for giving up the current 0.135 USDC maximum win.
  const blocked = executor.rotationNetProfitGuard({
    economics: {
      realizedPnlIfExit: -0.155,
      maximumWinPnl: 0.135,
      cost: 4.865,
    },
    candidate: {
      netGainIfWinUsdc: 0.2524,
      totalCostUsdc: 4.75,
    },
  });
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.maximumPnlDeltaUsdc < 0);
  assert.equal(blocked.requiredImprovementUsdc, executor.ROTATION_MIN_NET_PNL_IMPROVEMENT_USDC);

  const profitable = executor.rotationNetProfitGuard({
    economics: {
      realizedPnlIfExit: -0.05,
      maximumWinPnl: 0.25,
      cost: 5,
    },
    candidate: {
      netGainIfWinUsdc: 0.4,
      totalCostUsdc: 5,
    },
  });
  assert.equal(profitable.allowed, true);
  assert.ok(profitable.maximumPnlDeltaUsdc >= profitable.requiredImprovementUsdc);

  // The guard telescopes across repeated swaps. Previously banked exit losses are
  // common to holding or replacing the current position, while each new exit loss is
  // charged before the next maximum win is compared. Two accepted rotations therefore
  // cannot end with a lower maximum portfolio result than the starting position.
  const firstSwap = executor.rotationNetProfitGuard({
    economics: { realizedPnlIfExit: -0.05, maximumWinPnl: 0.3, cost: 5 },
    candidate: { netGainIfWinUsdc: 0.4, totalCostUsdc: 5 },
  });
  const secondSwap = executor.rotationNetProfitGuard({
    economics: { realizedPnlIfExit: -0.08, maximumWinPnl: 0.4, cost: 5 },
    candidate: { netGainIfWinUsdc: 0.55, totalCostUsdc: 5 },
  });
  assert.equal(firstSwap.allowed, true);
  assert.equal(secondSwap.allowed, true);
  assert.ok((-0.05 - 0.08 + 0.55) > 0.3);

  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8");

  assert.match(
    source,
    /const rotationPreferred = !settlementLocked\s*\n\s*&& netProfitGuard\.allowed/,
    "the absolute after-loss profit guard must precede the p.a. decision",
  );
  assert.match(
    source,
    /\{ forceTakerEntry: ROTATION_TAKER_ENTRY \}/,
    "rotation economics must use the replacement ask and taker fee, not maker economics",
  );

  // Open orders must use the same ranking-metric threshold as positions, not a
  // dollar EV margin: cancelling an unfilled buy does not realize a position loss.
  assert.match(
    source,
    /comparison\?\.replacementRanksAhead\s*\n\s*&& Number\(comparison\.metricDelta \|\| 0\) >= ROTATION_MIN_PRIORITY_IMPROVEMENT/,
    "open-order replacement must gate on the ranking metric, not an unrelated dollar EV margin",
  );
});

test("rotation: the completion pass can buy only the approved replacement", () => {
  const planned = { tokenId: "2222222222222222222", question: "Approved replacement" };
  const other = { tokenId: "3333333333333333333", question: "General shortlist leader" };
  const previousState = {
    rotationExit: {
      position: { tokenId: "1111111111111111111" },
      candidateTokenId: planned.tokenId,
      candidate: planned,
    },
  };
  assert.deepEqual(
    executor.restrictCandidatesToRotationPlan([other, planned], previousState, true),
    [planned],
    "the second pass must not buy a new shortlist leader or the token it just sold",
  );
  assert.deepEqual(
    executor.restrictCandidatesToRotationPlan([other], previousState, true),
    [planned],
    "the approved candidate stays available as a fallback when the refreshed catalogue page omits it",
  );
  assert.deepEqual(
    executor.restrictCandidatesToRotationPlan([other], null, true),
    [],
    "a completion run without a durable rotation plan must not place an arbitrary order",
  );
});

// --- Market-derived minimum order stake -------------------------------------------
// The exchange minimum is `mos` shares, not a fixed dollar amount, so its cost moves
// with the price. These pin that the stake is raised to exactly the market's own
// minimum when the portfolio percentage lands below it.

const sizing = (options) => executor.sharesForOrder({
  price: 0.9,
  minOrderSize: 5,
  maxNotional: 15,
  cash: 100,
  feeRate: 0,
  ...options,
});

test("order sizing: the exchange minimum is priced from the market, not fixed at $5", () => {
  assert.ok(Math.abs(sizing({ price: 0.99 }).minimumOrderCost - 4.95) < 1e-9);
  assert.ok(Math.abs(sizing({ price: 0.9 }).minimumOrderCost - 4.5) < 1e-9);
  assert.ok(Math.abs(sizing({ price: 0.5 }).minimumOrderCost - 2.5) < 1e-9);
  // A larger mos scales it too, which is why a ceiling exists.
  assert.ok(Math.abs(sizing({ price: 0.9, minOrderSize: 10 }).minimumOrderCost - 9) < 1e-9);
});

test("order sizing: a stake cap below the market minimum is raised to it", () => {
  // Previously this refused to trade with "max per trade is below Polymarket's
  // exchange minimum" while free cash was sufficient.
  const result = sizing({ price: 0.9, maxNotional: 1.5, cash: 100 });
  assert.equal(result.stakeFloorApplied, true);
  assert.ok(Math.abs(result.effectiveStake - 4.5) < 1e-9, `expected 4.5, got ${result.effectiveStake}`);
  assert.equal(result.stakeCapBelowExchangeMinimum, false, "the cap must no longer block the order");
  assert.equal(result.minimumFundingBlocked, false);
  assert.ok(result.size >= 5, `the order must reach the ${5}-share minimum, got ${result.size}`);
  assert.match(result.sizingNote, /raised from the configured 1\.5000 USDC stake to this market's 4\.5000 USDC minimum/);
});

test("order sizing: the floor never exceeds free cash", () => {
  // A real cash shortfall must still go to rotation review rather than being papered
  // over by the floor.
  const result = sizing({ price: 0.9, maxNotional: 1.5, cash: 2 });
  assert.equal(result.stakeFloorApplied, false);
  assert.equal(result.cashBelowExchangeMinimum, true);
  assert.equal(result.minimumFundingBlocked, true);
});

test("order sizing: the floor is capped so an unusual mos cannot run away", () => {
  // 200 shares at 0.9 would demand a 180 USDC stake. The ceiling refuses that and the
  // order is reported as blocked by the cap instead of silently oversizing.
  const result = sizing({ price: 0.9, minOrderSize: 200, maxNotional: 15, cash: 1000 });
  assert.ok(result.minimumOrderCost > executor.MIN_ORDER_STAKE_CEILING_USDC);
  assert.equal(result.stakeFloorApplied, false);
  assert.equal(result.stakeCapBelowExchangeMinimum, true);
});

test("order sizing: a sufficient stake cap is left exactly as configured", () => {
  const result = sizing({ price: 0.9, maxNotional: 15, cash: 100 });
  assert.equal(result.stakeFloorApplied, false);
  assert.equal(result.effectiveStake, 15, "the percentage cap stays authoritative when it can be met");
  assert.match(result.sizingNote, /sized from the configured portfolio stake/);
});

test("order sizing: a post-only limit order reserves no taker fee in the minimum", () => {
  // Default mode is post-only limit, which pays the maker side and therefore
  // deliberately reserves no taker fee. The market minimum is then exactly
  // price * mos, and passing a fee rate must not inflate it.
  const withFeeRate = executor.sharesForOrder({
    price: 0.9, minOrderSize: 5, maxNotional: 1, cash: 100, feeRate: 0.02,
  });
  assert.ok(Math.abs(withFeeRate.minimumOrderCost - 4.5) < 1e-9,
    `post-only must not reserve a taker fee, got ${withFeeRate.minimumOrderCost}`);

  // The floor still lifts the stake to that minimum.
  assert.equal(withFeeRate.stakeFloorApplied, true);
  assert.ok(withFeeRate.effectiveStake >= withFeeRate.minimumOrderCost - 1e-9);
  assert.ok(withFeeRate.size >= 5, `the order must reach the minimum size, got ${withFeeRate.size}`);
});

test("live run log: publishing can never shrink the hosted history", async () => {
  const merge = await import("../tools/merge-live-execution-history.mjs");

  const published = [
    { id: "row-3", runAt: "2026-08-05T07:00:00.000Z", action: "SKIP" },
    { id: "row-2", runAt: "2026-08-04T07:00:00.000Z", action: "SUBMIT" },
    { id: "row-1", runAt: "2026-08-03T07:00:00.000Z", action: "SUBMIT" },
  ];

  // The reported failure: a run started from an empty local log and published it over
  // three real rows, emptying the Live run log.
  const fromEmpty = merge.mergeRunLogs([], published);
  assert.equal(fromEmpty.length, 3, "an empty local log must not erase published history");
  assert.deepEqual(fromEmpty.map((row) => row.id), ["row-3", "row-2", "row-1"]);

  // A normal run adds exactly one row and keeps the rest.
  const withNew = merge.mergeRunLogs(
    [{ id: "row-4", runAt: "2026-08-05T07:45:00.000Z", action: "SUBMIT" }],
    published,
  );
  assert.equal(withNew.length, 4);
  assert.equal(withNew[0].id, "row-4", "newest row sorts first");

  // The same run seen twice must not duplicate, and the local copy wins because it
  // carries this run's fresh decision.
  const deduped = merge.mergeRunLogs(
    [{ id: "row-3", runAt: "2026-08-05T07:00:00.000Z", action: "ROTATION_EXIT_SUBMITTED" }],
    published,
  );
  assert.equal(deduped.length, 3, "a re-seen row must not duplicate");
  assert.equal(deduped.find((row) => row.id === "row-3").action, "ROTATION_EXIT_SUBMITTED");

  // Rows without an id are keyed by run id, time and action, matching the restore step.
  const keyed = merge.mergeRunLogs(
    [{ workflowRunId: "99", runAt: "2026-08-05T08:00:00.000Z", action: "SUBMIT" }],
    [{ workflowRunId: "99", runAt: "2026-08-05T08:00:00.000Z", action: "SUBMIT" }],
  );
  assert.equal(keyed.length, 1, "identical rows without an id must still dedupe");
});

test("live run log: a missing published state does not block order submission", async () => {
  const { readFile } = await import("node:fs/promises");
  const restore = await readFile(new URL("../tools/restore-live-execution-history.mjs", import.meta.url), "utf8");

  // The deadlock: the restore step exited 1 on a 404, so the order-submission step
  // after it was skipped, so no execution state was produced or uploaded, so the next
  // run got another 404. Trading stayed blocked run after run.
  assert.match(restore, /async function loadPublishedExecutionState/);
  assert.match(restore, /if \(error\?\.status === 404\) \{/);
  assert.match(restore, /starting with an empty run log/);
  // Any other status must still throw: there the data probably exists and continuing
  // with an empty log would let the upload replace it.
  assert.match(restore, /throw error;/);
  assert.match(restore, /error\.status = response\.status;/);

  const workflow = await readFile(
    new URL("../../.github/workflows/polymarket-live-limit-order-test.yml", import.meta.url), "utf8");
  // The merge guard must run before the upload, and on every run.
  const mergeAt = workflow.indexOf("merge-live-execution-history.mjs");
  const uploadAt = workflow.indexOf("- name: Upload live state");
  assert.ok(mergeAt > 0, "the merge guard must be wired into the workflow");
  assert.ok(mergeAt < uploadAt, "the merge must run before the upload, not after");
  assert.match(workflow, /- name: Merge published run-log history before upload\n\s+if: always\(\)/);
});

test("live run log: an upload never leaves the hosted path empty", async () => {
  const { readFile } = await import("node:fs/promises");
  // This read the live workflow, where the swap was an inline heredoc. It is a shared
  // tool now, because 5050 was created with a weaker copy of the same upload and lost its
  // whole run-log history to it. The rule below is unchanged; only its file moved.
  const workflow = await readFile(new URL("../tools/publish-execution-state.py", import.meta.url), "utf8");
  const publisher = await readFile(new URL("../tools/publish-paper-state.py", import.meta.url), "utf8");

  // delete-then-rename loses the file outright if the rename fails, and for
  // live-execution-state.json that file is the whole run-log history.
  assert.match(workflow, /def swap_into_place\(ftp, tmp_name, remote_name\):/);
  assert.match(workflow, /backup_name = f"\{remote_name\}\.previous"/);
  assert.match(workflow, /ftp\.rename\(backup_name, remote_name\)/, "a failed swap must restore the original");
  assert.ok(!/ftp\.delete\(remote_name\)\n\s+except ftplib\.all_errors:\n\s+pass\n\s+ftp\.rename\(tmp_name, remote_name\)/.test(workflow),
    "the delete-then-rename pattern must be gone");

  // The paper-state publisher had the same hazard.
  assert.match(publisher, /backup = f"\{source\.name\}\.previous"/);
  assert.match(publisher, /ftp\.rename\(backup, source\.name\)/);
});

test("live portfolio: the deposited baseline is configured, never inferred from P/L", async () => {
  const { readFile } = await import("node:fs/promises");
  const sync = await readFile(new URL("../tools/live-account-sync.mjs", import.meta.url), "utf8");

  // The reported bug: "Original value $33.36" was equity 26.93 minus a -6.43 P/L that
  // was not a real result, inferred on the first snapshot and then kept sticky forever.
  // Every percentage on the card derived from that wrong baseline, so it sustained itself.
  assert.ok(!/inferredOriginalValueUsdc/.test(sync), "the baseline must not be inferred at all");
  assert.ok(!/equityUsdc - number\(portfolioBase\.totalPnlUsdc/.test(sync),
    "deriving the deposit from P/L is what corrupted it");
  assert.match(sync, /process\.env\.LIVE_ORIGINAL_VALUE_USDC/);

  // A configured amount outranks a stored one, so a bad stored baseline can be corrected.
  assert.match(sync, /baselineUsdc = configuredOriginalValueUsdc > 0/);
  // A top-up is applied once and remembered, so runs cannot double-count it.
  assert.match(sync, /!appliedDeposits\.some\(\(entry\) => String\(entry\.id \|\| ""\) === additionalDepositId\)/);
  assert.match(sync, /appliedDeposits\.unshift\(\{/);
  // With no baseline, P/L must come from the ledger. `equity - null` coerces to equity
  // and would report the entire balance as profit.
  assert.match(sync, /const hasBaseline = number\(originalValueUsdc, 0\) > 0;/);
  assert.match(sync, /: number\(portfolioBase\.totalPnlUsdc\)/);
  // A hardcoded baseline outranks the stored one on purpose: the stored value on the
  // hosting is the corrupted 33.36 from the old inference, and a fix that only applied
  // to fresh state would never have reached it.
  assert.match(sync, /const DEFAULT_ORIGINAL_VALUE_USDC = \d+(\.\d+)?;/);
  // A saved portfolio setting now outranks the environment variable, which in turn
  // outranks a stored value. The label has to report which of them the baseline on the
  // card actually came from, or "configured" is unfalsifiable.
  assert.match(sync, /const originalValueSource = configOriginalValueUsdc > 0/);
  assert.match(sync, /\? "portfolio-config"/);
  assert.match(sync, /envOriginalValueUsdc > 0\s*\n?\s*\? "configured-env"/);
  assert.match(sync, /storedOriginalValueUsdc > 0 \? "persisted-original-value" : "configured-default"/);

  // Both workflows that sync the account must pass the baseline through.
  for (const name of ["polymarket-live-limit-order-test", "trading-live-account"]) {
    const workflow = await readFile(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), "utf8");
    assert.match(workflow, /LIVE_ORIGINAL_VALUE_USDC: \$\{\{ vars\.LIVE_ORIGINAL_VALUE_USDC \}\}/,
      `${name} must pass the configured baseline`);
    assert.match(workflow, /LIVE_ADDITIONAL_DEPOSIT_ID: \$\{\{ vars\.LIVE_ADDITIONAL_DEPOSIT_ID \}\}/);
  }
});

test("released capital: an order that leaves the book without filling triggers a run", async () => {
  const sync = await import("../tools/live-account-sync.mjs");
  const order = (id, tokenId, size) => ({
    id, tokenId, assetId: tokenId, question: `Q-${id}`, outcome: "No",
    price: 0.9, remainingSize: size, notionalUsdc: Number((size * 0.9).toFixed(4)),
  });
  const previousState = { openOrders: [order("a", "111", 5.68), order("b", "222", 5)] };

  // "b" is still on the book, "a" is gone and never became a position: its locked
  // capital is back as cash and would otherwise sit idle until the next cron run.
  const released = sync.vanishedOpenOrders(previousState, [order("b", "222", 5)], [], null, "2026-08-05T14:00:00Z");
  assert.equal(released.vanished.length, 1);
  assert.equal(released.vanished[0].id, "a");
  assert.equal(released.vanished[0].partiallyFilled, false);
  assert.equal(released.freedCapitalUsdc, 5.112, "the freed capital is reported for the dispatch log");
  assert.equal(released.ordersUnavailable, false);

  // An older stored row may carry only the notional, with no size/price to apportion.
  // Dropping its release would be worse than crediting all of it.
  const legacyOnly = sync.vanishedOpenOrders(
    { openOrders: [{ id: "c", tokenId: "333", assetId: "333", notionalUsdc: 4.87 }] },
    [], [], null, "2026-08-05T14:00:00Z",
  );
  assert.equal(legacyOnly.vanished.length, 1, "a legacy row must still be detected");
  assert.equal(legacyOnly.freedCapitalUsdc, 4.87);
});

test("released capital: how much came back decides, not whether a position exists", async () => {
  const sync = await import("../tools/live-account-sync.mjs");
  const order = {
    id: "a", tokenId: "111", assetId: "111", price: 0.9,
    remainingSize: 5.68, notionalUsdc: 5.112,
  };
  const at = "2026-08-05T14:00:00Z";
  const released = (previousState, positions) => sync.vanishedOpenOrders(previousState, [], positions, null, at);
  const noPosition = { openOrders: [order] };

  // Fully filled: the whole locked size became shares, so nothing returned to cash.
  assert.equal(released(noPosition, [{ tokenId: "111", shares: 5.68 }]).vanished.length, 0,
    "a fully filled order released no capital");

  // Partially filled with the remainder cancelled: shares went into a position AND the
  // unfilled rest came back as cash. Checking only for a position's existence missed
  // this entirely, even though there is real capital to redeploy.
  const partial = released(noPosition, [{ tokenId: "111", shares: 2 }]);
  assert.equal(partial.vanished.length, 1, "the unfilled remainder is released capital");
  assert.equal(partial.vanished[0].partiallyFilled, true);
  assert.equal(partial.freedCapitalUsdc, 3.312, "only the unfilled part counts: (5.68 - 2) * 0.9");

  // A zero-share row is not a real position, so that order did vanish outright.
  assert.equal(released(noPosition, [{ tokenId: "111", shares: 0 }]).vanished.length, 1);

  // Shares are compared before/after, so a position that already existed on this token
  // is not mistaken for this order's fill. Judging by existence alone got this wrong,
  // and it is the live portfolio's normal shape -- orders and positions on one event.
  const hadPosition = { openOrders: [order], positions: [{ tokenId: "111", shares: 3 }] };
  assert.equal(released(hadPosition, [{ tokenId: "111", shares: 3 }]).vanished.length, 1,
    "an unchanged pre-existing position means this order filled nothing");
  assert.equal(released(hadPosition, [{ tokenId: "111", shares: 8.68 }]).vanished.length, 0,
    "shares growing by the full locked size is a fill, not a release");

  // A fill on some other token must not be credited to this order either.
  assert.equal(released(noPosition, [{ tokenId: "999", shares: 5.68 }]).vanished.length, 1);
});

test("released capital: a failed open-orders fetch never looks like a mass cancellation", async () => {
  const sync = await import("../tools/live-account-sync.mjs");
  const previousState = {
    openOrders: [{ id: "a", tokenId: "111", assetId: "111", price: 0.9, remainingSize: 5.68, notionalUsdc: 5.112 }],
  };

  // getOpenOrders() throwing leaves the list empty while the sync still reports OK, so
  // without this guard one transient CLOB error would look like every order vanishing
  // and would dispatch a live execution run against an unchanged portfolio.
  const failed = sync.vanishedOpenOrders(
    previousState,
    [],
    [],
    { warnings: ["open-orders: request timed out"] },
    "2026-08-05T14:00:00Z",
  );
  assert.equal(failed.vanished.length, 0, "an unreadable book must not be treated as an empty one");
  assert.equal(failed.ordersUnavailable, true, "and the workflow must be able to see why");

  // An unrelated warning must not suppress a genuine detection.
  const unrelated = sync.vanishedOpenOrders(
    previousState,
    [],
    [],
    { warnings: ["balance-allowance update 0x1/sig1: boom"] },
    "2026-08-05T14:00:00Z",
  );
  assert.equal(unrelated.vanished.length, 1);

  // A first-ever run has no previous orders and must stay silent.
  assert.equal(sync.vanishedOpenOrders(null, [], [], null, "2026-08-05T14:00:00Z").vanished.length, 0);
});

test("released capital: the account sync dispatches the execution workflow", async () => {
  const { readFile } = await import("node:fs/promises");
  const workflow = await readFile(new URL("../../.github/workflows/trading-live-account.yml", import.meta.url), "utf8");

  // Dispatching needs actions: write, and workflow_dispatch is one of the two events
  // GITHUB_TOKEN may still start a run with, so no personal access token is needed.
  assert.match(workflow, /actions: write/);
  assert.match(workflow, /actions\/workflows\/\{workflow\}\/dispatches/);
  assert.match(workflow, /"live_execution_trigger": "open_order_released"/);
  // A scheduled run places real orders, and this stands in for one that would otherwise
  // happen hours later, so it must not be a dry run.
  assert.match(workflow, /"live_confirm": True/);
  // The transient-failure guard has to be honoured by the workflow, not just computed.
  assert.match(workflow, /if released\.get\("ordersUnavailable"\)/);

  // Order matters: dispatching after the upload means the published state no longer
  // lists the vanished order, so the next sync cannot fire a duplicate run.
  const uploadAt = workflow.indexOf("name: Upload live state");
  const dispatchAt = workflow.indexOf("name: Dispatch execution run when an open order released its capital");
  assert.ok(uploadAt > 0 && dispatchAt > uploadAt, "the dispatch must come after the state upload");

  // The sync must actually publish what the workflow reads.
  const syncSource = await readFile(new URL("../tools/live-account-sync.mjs", import.meta.url), "utf8");
  assert.match(syncSource, /releasedOrderCapital,/);
});

test("live positions: a date-only resolution date means the end of that day", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../tools/live-account-sync.mjs", import.meta.url), "utf8");

  // Reported: positions on fixtures still being played showed "05. 08. 2026 02:00" and
  // "awaiting settlement" while their own Polymarket page showed a live countdown. 02:00
  // Prague is midnight UTC -- Polymarket sent "2026-08-05" with no time, and JS reads a
  // bare date as the START of the day, so every position opened during it looked past
  // resolution. That zeroes potential p.a. and freezes the position out of rotation.
  assert.match(source, /const dateOnly = String\(value\)\.trim\(\)\.match\(\/\^\(\\d\{4\}\)-\(\\d\{2\}\)-\(\\d\{2\}\)\$\/\);/);
  assert.match(source, /23, 59, 59,\s*\n\s*\)\)\.toISOString\(\);/);

  // And the same future-kickoff correction as the paper side: an end date earlier than a
  // kickoff that has not happened yet is a stale estimate, not a resolution.
  // Only a real kickoff may override a real end date. A whole-day date is "in the future"
  // for the entire day it names, so allowing it there kept finished fixtures looking open.
  assert.match(source, /const scheduledIsFuture = scheduledIsPrecise\s*\n\s*&& Number\.isFinite\(scheduledTime\)\s*\n\s*&& scheduledTime > Date\.now\(\);/);
  assert.match(source, /scheduledIsPrecise = !dateOnly;/);
  assert.match(source, /\|\| scheduledTime < endTime \|\| scheduledIsFuture\)\)/);

  // Verify the arithmetic the fix relies on, so a future refactor cannot silently
  // reintroduce start-of-day semantics.
  const startOfDay = Date.parse("2026-08-05T00:00:00.000Z");
  const endOfDay = Date.UTC(2026, 7, 5, 23, 59, 59);
  const openedAt = Date.parse("2026-08-05T08:31:00.000Z");
  assert.ok(openedAt > startOfDay, "the reported position was opened after start-of-day, hence 'already resolved'");
  assert.ok(openedAt < endOfDay, "and before end-of-day, which is the correct reading");
});

test("live revalidation: the market is found by token id, not only by slug", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8");

  // Reported: execution rejected candidates with "market not found in Gamma" while the
  // shortlist showed them with six-figure liquidity and Polymarket showed them live. The
  // lookup keyed on the stored slug, but several scraped rows hold the parent EVENT slug
  // in `slug` (slug === eventSlug, seen on esports fixtures), and /markets?slug=<event>
  // matches nothing. The CLOB token id is what an order is placed against and Gamma
  // indexes markets by it, so it resolves the market unambiguously.
  const fetchMarket = source.slice(source.indexOf("async function fetchMarket(evaluation)"));
  const body = fetchMarket.slice(0, fetchMarket.indexOf("\nasync function fetchMarketByToken"));
  assert.match(body, /const byToken = await fetchMarketByToken\(tokenId\)/,
    "the token lookup must be tried first");
  const tokenAt = body.indexOf("fetchMarketByToken(tokenId)");
  const slugAt = body.indexOf('apiUrl(GAMMA_API, "/markets", { slug })');
  assert.ok(tokenAt > 0 && slugAt > tokenAt, "slug must remain only the fallback");
  // A slug can resolve to several of an event's sub-markets, so the one carrying this
  // token has to win over whichever Gamma happened to return first.
  assert.match(body, /markets\.find\(\(market\) => parseJsonField\(market\?\.clobTokenIds\)\.map\(String\)\.includes\(tokenId\)\)/);
  // A token-lookup failure must fall through to the slug rather than abort the candidate.
  assert.match(body, /fetchMarketByToken\(tokenId\)\.catch\(\(\) => null\)/);

  // fetchMarketByToken must keep using the parameter Gamma actually indexes.
  assert.match(source, /apiUrl\(GAMMA_API, "\/markets", \{ clob_token_ids: tokenId \}\)/);
});

test("live revalidation: a market Gamma no longer lists is closed out, not re-fetched forever", async () => {
  const executor = await import("../tools/live-order-executor.mjs");

  // Verified against a production dry run: four short-dated esports legs ("Game 2
  // Winner", "Map 2 Winner", 0.18 d left) were absent from Gamma by token id AND by
  // slug, because such markets are delisted once they settle. That is a market that no
  // longer exists, not one that failed a threshold, so it must leave the pool for good
  // rather than costing a live fetch on every run for as long as the row is retained.
  const gone = executor.liveRevalidationUpdate({
    candidate: { tokenId: "111", question: "Dota 2: PlayTime vs Yakult Brothers - Game 2 Winner" },
    eligible: false,
    marketGone: true,
    rejectReasons: ["market no longer listed in Gamma by token id or slug; treated as closed"],
  }, "2026-08-05T19:36:31Z");
  assert.equal(gone.tokenId, "111", "the token id must come through for the merge to find the row");
  assert.equal(gone.status, "CLOSED", "a vanished market is closed, not merely rejected");
  assert.equal(gone.marketGone, true, "the persist step keys the close-out off this flag");
  assert.equal(gone.retryable, false, "it can never come back, so it must not be retried");
  assert.equal(gone.retryClass, null);

  // A capital block is the opposite case and must stay retryable.
  const blocked = executor.liveRevalidationUpdate({
    tokenId: "222",
    status: "REJECTED",
    rejectReasons: ["minimum order of 5 shares costs 4.55 USDC, above cash 2.70 USDC"],
  }, "2026-08-05T19:36:31Z");
  assert.equal(blocked.status, "WAITING_CAPITAL");
  assert.equal(blocked.retryable, true);
  assert.equal(blocked.marketGone, false);

  // Once closed out, the cheap prefilter drops the row with no network call at all.
  const pool = executor.prepareLiveCandidatePool([{
    tokenId: "111", question: "Dota 2: PlayTime vs Yakult Brothers - Game 2 Winner",
    status: "CLOSED", marketClosed: true, acceptingOrders: false,
    aiProbability: 0.97, annualizedReturn: 2.1, expectedValueUsdc: 0.5,
    netYield: 0.1, liquidity: 84775, daysToResolution: 0.18,
  }], null);
  assert.equal(pool.candidates.length, 0, "a closed-out row must never reach revalidation again");

  // And something must actually write that status back, or the loop never closes. That
  // merge is a shared script now: it was a heredoc in the live workflow and absent from
  // 5050 entirely, so a market 5050 found gone stayed READY in its candidate list.
  const { readFile } = await import("node:fs/promises");
  const persist = await readFile(new URL("../tools/persist-live-revalidation.py", import.meta.url), "utf8");
  assert.match(persist, /if update\.get\("marketGone"\):/);
  assert.match(persist, /item\["status"\] = "CLOSED"/);
  assert.match(persist, /item\["acceptingOrders"\] = False/);
  // And both live portfolios must run it, or one of them keeps re-fetching dead markets.
  for (const file of ["polymarket-live-limit-order-test", "trading-live-5050"]) {
    const workflow = await readFile(new URL(`../../.github/workflows/${file}.yml`, import.meta.url), "utf8");
    // The state file it writes is per-portfolio now, so it is named on the command line
    // ahead of the interpreter rather than in a fixed env block.
    assert.match(workflow, /run: (?:\w+="[^"]*" )*python3 trading\/tools\/persist-live-revalidation\.py/,
      `${file} must persist its verdicts`);
  }
});

test("redeem alerts: a lost position with nothing to claim raises no alert", async () => {
  const sync = await import("../tools/live-account-sync.mjs");

  // Reported: redeem emails arriving for lost positions whose redeem value is 0.00.
  // Polymarket marks a loser `resolved` exactly like a winner, so settled-ness alone
  // qualified the position -- and it was mailed under the title "Winning Polymarket
  // position may need redeem" with 0.00 to collect. Nothing is owed, so nothing to send.
  const base = {
    tokenId: "111", question: "Exact Score: SSC Napoli 1 - 0 CA Osasuna?", outcome: "No",
    resolved: true, stakeUsdc: 4.5,
  };
  const lost = sync.redeemNotifications(
    [{ ...base, currentValueUsdc: 0, currentPrice: 0 }],
    null,
    "2026-08-06T18:00:00Z",
  );
  assert.equal(lost.redeemAlerts.length, 0, "a settled loser worth 0.00 must raise no alert");
  assert.equal(lost.unsentRedeemAlerts.length, 0, "and therefore nothing to email");

  // A genuine winner must still be alerted -- this must not silence the useful case.
  const won = sync.redeemNotifications(
    [{ ...base, currentValueUsdc: 5.62, currentPrice: 1 }],
    null,
    "2026-08-06T18:00:00Z",
  );
  assert.equal(won.redeemAlerts.length, 1, "a winning position still needs its redeem alert");
  assert.equal(won.unsentRedeemAlerts.length, 1);

  // A winner whose value has not been marked yet is still a winner: a settled outcome
  // trades at ~1.00, so the price carries the information the value is missing.
  const valueLate = sync.redeemNotifications(
    [{ ...base, currentValueUsdc: 0, currentPrice: 0.999 }],
    null,
    "2026-08-06T18:00:00Z",
  );
  assert.equal(valueLate.redeemAlerts.length, 1, "a late-marked winner must not be dropped");

  // A near-worthless residual is not a redeem worth emailing about, but a real one is.
  assert.equal(sync.positionHasRedeemableValue({ currentValueUsdc: 0, currentPrice: 0.02 }), false);
  assert.equal(sync.positionHasRedeemableValue({ currentValueUsdc: 0.5, currentPrice: 0.1 }), true);

  // An explicit REDEEM_REQUIRED row with no value must not slip through either.
  const mislabelled = sync.redeemNotifications(
    [{ ...base, resolved: false, status: "REDEEM_REQUIRED", currentValueUsdc: 0, currentPrice: 0 }],
    null,
    "2026-08-06T18:00:00Z",
  );
  assert.equal(mislabelled.redeemAlerts.length, 0);
});

test("rotation exit: the sell is posted as a taker order, which createAndPostOrder cannot do", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8");

  // The reported failure -- "rotation's sell of the existing position does not work".
  // buildRotationExitOrder asks for FAK/forceTaker, but the submit path called
  // createAndPostOrder(..., OrderType.FAK), and that method accepts only GTC or GTD. The
  // FAK never took effect, so the exit was posted as a RESTING limit sell: when the book
  // moved off its price it sat there unfilled, reserving the position's shares, and the
  // rotation could never complete. That is the 5.5 shares parked at 0.25 on a position
  // entered at 0.93.
  // Comment lines are stripped first: this file explains the bug in prose, and the
  // explanation must not itself trip the check.
  const code = source.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  assert.ok(!/createAndPostOrder\([^)]*OrderType\.FAK/s.test(code),
    "createAndPostOrder cannot post FAK; a taker sell must not go through it");
  const submit = source.slice(source.indexOf("async function submitOrder(order)"));
  const body = submit.slice(0, submit.indexOf("\nasync function submitOrderWithMakerPrecisionRecovery"));
  const takerBranch = body.slice(body.indexOf("if (side === Side.SELL && forceTaker)"));
  assert.match(takerBranch, /await client\.createOrder\(/,
    "the exit still needs the normal V2 limit-order signature for the POLY_1271 wrapper");
  assert.match(takerBranch, /client\.postOrder\(signedExit, OrderType\.FAK, false\)/,
    "postOrder is the call that actually accepts FAK");

  // Pin this against the client's own declared constraint, so the next refactor cannot
  // quietly reintroduce a resting sell. Skipped when dependencies are not installed.
  let types = null;
  try {
    types = await readFile(new URL("../node_modules/@polymarket/clob-client-v2/dist/client.d.ts", import.meta.url), "utf8");
  } catch {
    types = null;
  }
  if (types) {
    assert.match(types, /createAndPostOrder<T extends OrderType\.GTC \| OrderType\.GTD/,
      "if this widens to allow FAK, the comment in submitOrder should be revisited");
    assert.match(types, /postOrder<T extends OrderType\b/,
      "postOrder must remain the unconstrained one");
  }
});

test("rotation exit: a sell that never filled is re-closed, not waited on forever", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8");

  // Observed at 21:48: action ROTATION_EXIT_WAITING with a SELL of the full 5.5 shares
  // resting at 0.25 on a position entered at 0.93 -- nothing filled. A rotation exit is
  // built as FAK (forceTaker), so it fills against the bid at once or is killed; a fully
  // unfilled sell resting on the book means the exit never completed. Waiting cannot fix
  // it, because the resting order reserves the position's shares: the position can be
  // neither sold nor rotated and every later run takes the same early return. Deadlock.
  assert.match(source, /orderType: "FAK",\s*\n\s*forceTaker: true,/,
    "the exit must remain a taker order");
  assert.match(source, /const ROTATION_EXIT_STALE_MINUTES = envNumber\("LIVE_ROTATION_EXIT_STALE_MINUTES", 2\)/);

  const waiting = source.slice(source.indexOf("if (activeSellOrders.length && !best) {"));
  const block = waiting.slice(0, waiting.indexOf('action: "ROTATION_EXIT_WAITING"'));
  // The stale order is cancelled first: its reservation is what blocks the re-close.
  assert.match(block, /const staleSellOrders = activeSellOrders/);
  assert.match(block, /openOrderAgeHours\(order\) \* 60 >= ROTATION_EXIT_STALE_MINUTES/);
  assert.match(block, /await cancelOrder\(order, tradingConfig\)/);
  assert.match(block, /if \(!successfulCancelResponse\(cancelResponse/,
    "a failed cancel must not be followed by a second sell of the same shares");
  // Then re-priced against the book as it stands now, not the price that failed.
  assert.match(block, /exitOrder = await buildRotationExitOrder\(/);
  const cancelAt = block.indexOf("cancelOrder(order, tradingConfig)");
  const rebuildAt = block.indexOf("buildRotationExitOrder(");
  assert.ok(cancelAt > 0 && rebuildAt > cancelAt, "cancel must precede the re-close");
  // Reporting ROTATION_EXIT_SUBMITTED is what makes the workflow buy the replacement in
  // this same run instead of deferring it to a fill that is not coming.
  assert.match(block, /\? \(DRY_RUN \|\| !hasFlag\("confirm-live"\) \? "DRY_RUN_ROTATION_EXIT" : "ROTATION_EXIT_SUBMITTED"\)/);
  // A dry run must never cancel or sell for real.
  assert.match(block, /DRY_RUN \|\| !hasFlag\("confirm-live"\)\s*\n?\s*\? \{ status: "dry_run_cancel", success: true \}/);

  // The workflow's immediate-replacement step keys off exactly that action.
  const workflow = await readFile(new URL("../../.github/workflows/polymarket-live-limit-order-test.yml", import.meta.url), "utf8");
  assert.match(workflow, /state\.action === "ROTATION_EXIT_SUBMITTED"/);
  assert.match(workflow, /npm run live:execute -- --confirm-live/);

  // Still waiting is correct while the order is fresh: a FAK can be in flight.
  assert.match(source, /action: "ROTATION_EXIT_WAITING"/);
});

test("live candidates: an execution rejection survives the next scrape", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  // Reported: execution returned SKIP with every candidate rejected ("market not found
  // in Gamma", "no valid current entry price", live liquidity far below the listed
  // figure) and they all stayed READY in the shortlist. The verdict was only honoured
  // while checkedAt >= evaluatedAt, so the next scrape -- which cannot know any of those
  // things, it only re-reads Gamma's listing -- silently reinstated the row.
  assert.ok(!/executionCheckIsCurrent = executionCheck\s*\n\s*&& \(Date\.parse\(executionCheck\.checkedAt/.test(app),
    "a re-scrape must not invalidate what execution measured");
  assert.match(app, /const executionCheckIsCurrent = Boolean\(executionCheck\);/);

  // The verdict is read from live-execution-state.json, which the execution run writes
  // and uploads itself, rather than depending on the FTP merge into paper-state.json.
  assert.match(app, /function liveExecutionVerdictByToken\(\)/);
  assert.match(app, /state\.liveExecutionState\?\.revalidationUpdates/);
  // Both take the mode now: the verdicts are persisted onto shared evaluation rows, so
  // reading one means first establishing whose it is. The rule this test is about --
  // that a re-scrape does not reinstate the row -- is unchanged by that.
  assert.match(app, /function latestLiveExecutionVerdict\(item, mode = state\.mode\)/);
  assert.match(app, /const executionCheck = latestLiveExecutionVerdict\(item, mode\);/);

  // Retryable verdicts (capital, diversification) must still return to the shortlist:
  // those block one run, not the market itself.
  assert.match(app, /!executionCheck\.retryable/);

  // And the executor must still classify only those two as retryable.
  const executor = await readFile(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8");
  assert.match(executor, /\? "DIVERSIFICATION"/);
  assert.match(executor, /\? "CAPITAL"/);
});

test("live ranking: the horizon is recomputed, not read from the scrape", async () => {
  const executor = await import("../tools/live-order-executor.mjs");

  // The reported bug. A market resolving 06.08 00:00, executed 05.08 12:23, was
  // annualized over "resolution 1.00d" while the dashboard showed 0.5 d left. Its
  // potential p.a. came out +4,055.3% instead of +8,399.3% -- half its real value,
  // because the stored daysToResolution was captured when the row was scraped.
  const endDate = new Date(Date.now() + 11.6 * 3600000).toISOString();
  const stale = { endDate, daysToResolution: 1 };
  const fresh = executor.localDaysToResolution(stale);
  assert.ok(fresh > 0.4 && fresh < 0.55, `expected ~0.48 d from the end date, got ${fresh}`);
  assert.ok(fresh < stale.daysToResolution, "the stored scrape-time horizon must not win");

  // Ranking follows, so an older row is no longer penalised against a fresher one.
  const pa = executor.annualizeReturn(0.111, fresh);
  assert.ok(pa > 70, `potential p.a. should be ~83x, got ${pa}`);

  // A row with no usable end date still falls back rather than becoming Infinity.
  assert.equal(executor.localDaysToResolution({ daysToResolution: 3 }), 3);
  assert.equal(executor.localDaysToResolution({}), Infinity);
  // resolutionEndDate is accepted too, since scraped rows carry either name.
  const viaResolution = executor.localDaysToResolution({ resolutionEndDate: endDate, daysToResolution: 9 });
  assert.ok(viaResolution < 1, "resolutionEndDate must also outrank the stored value");
});

test("live shortlist: one stale token id must not discard the whole shortlist", async () => {
  const { readFile } = await import("node:fs/promises");
  const executor = await readFile(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8");

  // The reported bug: a match sitting in the dashboard as READY never appeared in the
  // run log at all, neither placed nor rejected. The shortlist selection was
  // all-or-nothing -- a single token id missing from the ranked pool discarded every
  // other one and the run silently evaluated the executor's own top-N instead. With
  // ~120 ids and a scraping batch landing mid-run, that is close to guaranteed.
  assert.match(executor, /const manualShortlistFallback = HAS_MANUAL_SHORTLIST && requestedShortlist\.length === 0;/);
  assert.ok(
    !/manualShortlistFallback = HAS_MANUAL_SHORTLIST && missingManualShortlistTokenIds\.length > 0/.test(executor),
    "a missing id must no longer discard the surviving ones",
  );
  // The survivors are used in the order the browser asked for.
  assert.match(executor, /const selected = usesRequestedShortlist\s*\n?\s*\? requestedShortlist/);
  // And the dropped ids are reported rather than vanishing without a trace.
  assert.match(executor, /not in the current scraped catalogue when the run started/);
  assert.match(executor, /of \$\{MANUAL_SHORTLIST_TOKEN_IDS\.length\} requested/);
});

test("live candidates: an obvious risk collision is filtered before revalidation, not after", () => {
  // The reported bug: a browser shortlist of ~56 candidates, most of them different
  // sub-markets ("Exact Score", "Under", "Spread"...) of one already-open match, was
  // sent whole into revalidation. Every one of them paid for a live CLOB book fetch
  // only to be rejected afterwards for a reason knowable from stored data alone: the
  // dashboard's own READY/RISK-BLOCKED split already knew this without a network call.
  const liveState = {
    positions: [{
      tokenId: "held-token",
      status: "OPEN",
      shares: 10,
      question: "Exact Score: Chelsea FC 2 - 2 Juventus Turin?",
      slug: "clf-cfc-juv-2026-08-05-exact-score",
      eventSlug: "clf-cfc-juv-2026-08-05",
      outcome: "Yes",
    }],
    openOrders: [],
  };

  // Otherwise-eligible on every threshold the prefilter checks (probability, net
  // yield, liquidity, horizon), so the only thing distinguishing them is the risk
  // collision -- proving the rejection comes from that check and nothing else.
  // Scored the way the executor now scores every candidate: on the Polymarket
  // probability, with the potential p.a. derived from net gain over cost.
  const eligibleFields = {
    marketProbability: 0.97,
    netGainIfWinUsdc: 0.3,
    totalCostUsdc: 3,
    netYield: 0.08,
    liquidity: 60000,
    daysToResolution: 0.3,
    status: "EVALUATED",
  };
  const sameMatchCandidate = {
    ...eligibleFields,
    tokenId: "candidate-same-match",
    question: "Exact Score: Chelsea FC 1 - 2 Juventus Turin?",
    slug: "clf-cfc-juv-2026-08-05-exact-score-alt",
    eventSlug: "clf-cfc-juv-2026-08-05",
    outcome: "No",
    riskGroupKeys: ["event:clf-cfc-juv-2026-08-05", "match:chelsea fc-vs-juventus turin"],
  };
  const unrelatedCandidate = {
    ...eligibleFields,
    tokenId: "candidate-unrelated",
    question: "Associação Chapecoense de Futebol leading at halftime?",
    slug: "brco-cru-cha-2026-08-05-halftime-result",
    eventSlug: "brco-cru-cha-2026-08-05",
    outcome: "No",
    riskGroupKeys: ["event:brco-cru-cha-2026-08-05", "match:associacao chapecoense-vs-cruzeiro"],
  };

  const held = executor.heldRiskItems(liveState);
  assert.equal(held.length, 1);
  assert.ok(held[0].keys.includes("match:chelsea fc-vs-juventus turin") || held[0].keys.some((k) => k.startsWith("match:")),
    "the held position must carry a match: risk key derived from its own question");

  const blockedReason = executor.earlyRiskBlockReason(sameMatchCandidate, held);
  assert.match(blockedReason, /^same live event or match already open/);

  const clearReason = executor.earlyRiskBlockReason(unrelatedCandidate, held);
  assert.equal(clearReason, null, "an unrelated match must not be blocked");

  // And the whole pool-building step must exclude it before anything expensive runs.
  const pool = executor.prepareLiveCandidatePool([sameMatchCandidate, unrelatedCandidate], liveState);
  const poolTokenIds = pool.candidates.map((item) => item.tokenId);
  assert.ok(!poolTokenIds.includes("candidate-same-match"), "the colliding candidate must never reach revalidation");
  assert.ok(poolTokenIds.includes("candidate-unrelated"), "the unrelated candidate must still be considered");
  assert.ok(
    Object.keys(pool.diagnostics.reasonCounts).some((key) => key.startsWith("same live event or match already open")),
    "the rejection must still be visible in the run's reason counts, not silently dropped",
  );
});

test("live candidates: with no riskGroupKeys stored, the cheap filter defers to the live check", () => {
  // A row without stored risk keys cannot be judged cheaply. It must fall through
  // rather than being wrongly waved through as clear -- the authoritative riskBlock()
  // during revalidation is what actually decides it.
  const held = [{ tokenId: "held", keys: ["event:x", "match:y"] }];
  const noKeys = { tokenId: "candidate", question: "..." };
  assert.equal(executor.earlyRiskBlockReason(noKeys, held), null);
  assert.equal(executor.earlyRiskBlockReason(noKeys, []), null, "no held positions means nothing to collide with either");
});

test("live candidates: volume and net-profit reject reasons collapse into one bucket each, not one per value", () => {
  // Both reason strings carry a per-candidate number (a USDC amount, a percentage).
  // Left ungrouped, every distinct value became its own bucket -- for the volume floor
  // specifically this turned one homogeneous rejection reason into thousands of
  // one-off entries in production, which was most of a run's console/log output.
  //
  // The floor is measured on traded volume now, so rows below it are reported as
  // "volume ... below live minimum"; the old liquidity wording groups to the same bucket
  // so a state stored before the switch still collapses instead of fragmenting.
  // Scored the way the executor now scores every candidate: on the Polymarket
  // probability, with the potential p.a. derived from net gain over cost.
  const eligibleFields = {
    marketProbability: 0.97,
    netGainIfWinUsdc: 0.3,
    totalCostUsdc: 3,
    netYield: 0.08,
    liquidity: 60000,
    daysToResolution: 0.3,
    status: "EVALUATED",
  };
  // Default thresholds with no env override (see MIN_VOLUME_24H/MIN_NET_YIELD in the
  // source): volume must be below 100, net yield below 0. These rows carry no volume
  // field, so the stored liquidity is the fallback the accessor uses.
  const rows = [
    ...Array.from({ length: 5 }, (_, i) => ({
      ...eligibleFields, tokenId: `low-liquidity-${i}`, question: `Q${i}`, liquidity: 1 + i,
    })),
    ...Array.from({ length: 4 }, (_, i) => ({
      ...eligibleFields, tokenId: `low-yield-${i}`, question: `Y${i}`, netYield: -0.01 * (i + 1),
    })),
  ];
  const pool = executor.prepareLiveCandidatePool(rows, null);
  const counts = pool.diagnostics.reasonCounts;
  const volumeKeys = Object.keys(counts).filter((key) => /volume/i.test(key));
  const yieldKeys = Object.keys(counts).filter((key) => /net profit/i.test(key));
  assert.equal(volumeKeys.length, 1, `expected one grouped volume bucket, got ${JSON.stringify(volumeKeys)}`);
  assert.equal(counts[volumeKeys[0]], 5);
  assert.ok(!Object.keys(counts).some((key) => /^liquidity/i.test(key)),
    "the old wording must group into the volume bucket, not sit beside it");
  assert.equal(yieldKeys.length, 1, `expected one grouped net-profit bucket, got ${JSON.stringify(yieldKeys)}`);
  assert.equal(counts[yieldKeys[0]], 4);
});

test("live run log: revalidatedCandidates does not get stored 160 times over", () => {
  // Why the run's own decision JSON could not be read back from GitHub Actions logs:
  // emitDecision() spread the ENTIRE batchLog into every historical run-log entry,
  // including revalidatedCandidates -- every candidate the run touched, unbounded
  // now that a stale token id no longer discards the whole manual shortlist. Stored
  // across up to 160 retained runs, that duplicated the same few dozen KB up to 160
  // times over, in both the published live-execution-state.json and the console
  // dump printed on every run -- well past what a log reader can fetch in one request.
  const candidate = (i) => ({
    tokenId: String(i), question: `Q${i}`, marketProbability: 0.93, netGainIfWinUsdc: 0.3,
  });
  const batchLog = {
    id: "b1", action: "SKIP", reason: "no eligible candidate",
    topCandidates: [candidate(1)],
    topRejected: [candidate(2)],
    revalidatedCandidates: Array.from({ length: 120 }, (_, i) => candidate(i)),
    rotationReview: { action: "NO_ROTATION_CANDIDATE" },
  };
  const compacted = executor.compactLiveRunRecord(batchLog);
  assert.ok(!("revalidatedCandidates" in compacted), "the unbounded field must be dropped from the stored record");
  // Everything tradeBatchDetail()'s fallback ([...topCandidates, ...topRejected]) and
  // the run-log list rendering need must survive untouched.
  for (const field of ["id", "action", "reason", "topCandidates", "topRejected", "rotationReview"]) {
    assert.deepEqual(compacted[field], batchLog[field], `${field} must be preserved as-is`);
  }
  // Applying it twice (as happens to the already-stored backlog on every run) must
  // not change anything further -- it only ever removes the one named field.
  assert.deepEqual(executor.compactLiveRunRecord(compacted), compacted);

  // Confirms the fix actually addresses the reported log size, not just in theory.
  const bulky = Buffer.byteLength(JSON.stringify(batchLog));
  const slim = Buffer.byteLength(JSON.stringify(compacted));
  assert.ok(slim < bulky / 3, `expected a large reduction, got ${bulky} -> ${slim}`);
});

test("live run log: the already-stored backlog is compacted on the next run too", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8");
  // Fixing only new entries would leave up to 160 already-bloated ones in place for
  // roughly a day (this run cadence) before they aged out on their own. Reading the
  // previously stored log through the same compaction fixes the backlog immediately.
  assert.match(source, /const previousRunLog = \(Array\.isArray\(previousExecutionState\?\.runLog\)\s*\n?\s*\? previousExecutionState\.runLog\s*\n?\s*: \[\]\)\.map\(compactLiveRunRecord\);/);
});

test("live run log: the capped execution-shortlist sample is also dropped from history", () => {
  // Capped at 20, but still 20 candidate summaries repeated across up to 160 stored
  // runs -- the same duplication as revalidatedCandidates, just with a smaller cap.
  const batchLog = {
    id: "b1", action: "SKIP",
    prevalidationFilter: { reasonCounts: { x: 1 }, executionShortlist: [{ tokenId: "1" }] },
  };
  const compacted = executor.compactLiveRunRecord(batchLog);
  assert.ok(!("executionShortlist" in compacted.prevalidationFilter), "executionShortlist must be dropped from history");
  assert.deepEqual(compacted.prevalidationFilter.reasonCounts, { x: 1 }, "the rest of prevalidationFilter must survive");

  // A batchLog with no prevalidationFilter at all must not throw.
  assert.doesNotThrow(() => executor.compactLiveRunRecord({ id: "b2", action: "SKIP" }));
});

test("live console output: a decision's console dump is a bounded summary, not the full state", () => {
  // Even with history already compacted, the CURRENT run's own uncompacted
  // revalidatedCandidates (over 100 candidates once the whole shortlist is
  // considered, per the earlier all-or-nothing fix) plus 160 stored runs pushed a
  // single console.log(JSON.stringify(output)) well past what the log-reading tool
  // can return in one request -- confirmed against a real production run where the
  // fetched window did not even reach the start of the dumped JSON.
  const candidate = (i) => ({ tokenId: String(i), question: `Q${i}`, marketProbability: 0.93 });
  const batchLog = {
    action: "SKIP", reason: "no eligible candidate", settings: {}, capital: {}, counts: {},
    selected: null,
    topCandidates: [candidate(1)],
    topRejected: [candidate(2)],
    revalidatedCandidates: Array.from({ length: 109 }, (_, i) => candidate(100 + i)),
    openOrderReviews: [],
    rotationReview: { action: "NO_ROTATION_CANDIDATE", reviews: [] },
    prevalidationFilter: { reasonCounts: {}, executionShortlist: Array.from({ length: 20 }, (_, i) => candidate(300 + i)) },
  };
  const output = {
    generatedAt: "2026-08-05T13:16:00.000Z", action: "SKIP", reason: "no eligible candidate",
    batchLog,
    runLog: Array.from({ length: 160 }, () => executor.compactLiveRunRecord(batchLog)),
  };
  const summary = executor.consoleDecisionSummary(output);

  assert.ok(!("revalidatedCandidates" in summary), "the unbounded candidate list must not reach the console");
  assert.ok(!("runLog" in summary), "160 runs of history must not be re-printed on every run");
  assert.ok(!("executionShortlist" in (summary.prevalidationFilter || {})), "the capped shortlist sample is redundant with topCandidates/topRejected");
  for (const field of ["action", "reason", "settings", "capital", "counts", "selected", "topCandidates", "topRejected", "openOrderReviews", "rotationReview", "prevalidationFilter"]) {
    assert.ok(field in summary, `${field} must survive -- it is what a decision is diagnosed from`);
  }
  assert.equal(summary.rotationReview.action, "NO_ROTATION_CANDIDATE");

  const full = Buffer.byteLength(JSON.stringify(output));
  const compact = Buffer.byteLength(JSON.stringify(summary));
  assert.ok(compact < full / 10, `expected an order-of-magnitude reduction, got ${full} -> ${compact}`);

  // And this must be what actually gets printed, not just an unused helper.
  return import("node:fs/promises").then(({ readFile }) => readFile(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8")).then((source) => {
    assert.match(source, /console\.log\(JSON\.stringify\(consoleDecisionSummary\(output\), null, 2\)\);/);
    assert.match(source, /await writeFile\(EXECUTION_STATE_PATH, `\$\{JSON\.stringify\(output, null, 2\)\}\\n`, "utf8"\);/);
  });
});

test("rotation exit: a refused sell falls back to a real market order", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8");

  // Both taker paths have failed in production, in sequence:
  //   createAndPostOrder(..., FAK) ignored the FAK (that method takes only GTC/GTD), so
  //     the exit rested on the book, reserved the shares and deadlocked rotation;
  //   createOrder + postOrder(FAK) fixed the semantics but the CLOB refused it with
  //     "invalid POLY_1271 signature: signature does not match order hash" (SELL 5 @
  //     0.962), so the sell never reached the book either and the position was stranded.
  // Exiting has to actually execute, so a refused attempt now falls through to the
  // client's own market-order builder instead of giving up.
  const submit = source.slice(source.indexOf("async function submitOrder(order)"));
  const body = submit.slice(0, submit.indexOf("\nasync function submitOrderWithMakerPrecisionRecovery"));
  const branch = body.slice(body.indexOf("if (side === Side.SELL && forceTaker)"));

  assert.match(branch, /await client\.createOrder\(/, "the limit-signed attempt is still first");
  assert.match(branch, /client\.postOrder\(signedExit, OrderType\.FAK, false\)/);
  assert.match(branch, /if \(successfulOrderResponse\(limitSigned\)\) return/,
    "an accepted first attempt must not be followed by a second sell of the same shares");
  assert.match(branch, /await client\.createMarketOrder\(/, "the fallback is a real market order");
  assert.match(branch, /client\.postOrder\(marketOrder, OrderType\.FAK\)/);

  // A SELL market order is sized in shares, not USDC -- passing a notional would sell the
  // wrong quantity.
  assert.match(branch, /amount: order\.orderSize,/);

  // Ordering: the fallback must come after the check that the first attempt failed.
  const guardAt = branch.indexOf("if (successfulOrderResponse(limitSigned)) return");
  const fallbackAt = branch.indexOf("await client.createMarketOrder(");
  assert.ok(guardAt > 0 && fallbackAt > guardAt, "the market order must only run after a refusal");

  // A throw from either path must not abort the exit; it is recorded and the next path
  // still gets its turn.
  assert.match(branch, /limitSigned = \{ error: error\?\.message \|\| String\(error\), status: "exception" \}/);
  assert.match(branch, /marketSigned = \{ error: error\?\.message \|\| String\(error\), status: "exception" \}/);

  // Both attempts are reported, so a run log shows which path the exit took.
  assert.match(branch, /exitAttempts: attempts/);
  assert.match(branch, /path: "limit-signed-fak"/);
  assert.match(branch, /path: "market-order-fak"/);
});

test("capital: the reported requirement is what an order actually costs", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8");

  // Reported: "$3.42 available / $3.40 required / capital insufficient", which reads as a
  // contradiction. With no sized candidate, requiredStakeUsdc was
  // min(maxNotional, availableCash) -- what the portfolio would like to spend, capped by
  // its own cash -- not what an order actually costs. The real figure is the exchange
  // minimum (shares x price + fees), which each cash-blocked candidate already records.
  assert.match(source, /const blockedMinimumOrderCosts = cashSizingBlocked\s*\n\s*\.map\(\(item\) => number\(item\.minOrderNotionalUsdc, 0\)\)/);
  assert.match(source, /const cheapestBlockedMinimumCost = blockedMinimumOrderCosts\.length\s*\n\s*\? Math\.min\(\.\.\.blockedMinimumOrderCosts\)\s*\n\s*: null;/);
  assert.match(source, /\? cheapestBlockedMinimumCost\s*\n\s*: Math\.min\(maxNotional, Math\.max\(0, availableCashAfterOrderManagement\)\)/,
    "the capped stake stays only as the fallback when nothing was cash-blocked");

  // The same number has to appear in the reason and the note, not just the capital block,
  // so every place the run explains itself agrees.
  assert.match(source, /cheapest needs \$\{cheapestBlockedMinimumCost\.toFixed\(4\)\} USDC including fees/);
  assert.match(source, /The cheapest of them needs \$\{cheapestBlockedMinimumCost\.toFixed\(4\)\} USDC including fees/);

  // And the per-candidate reason must state the shortfall rather than claim there is no
  // cash at all, which was false: there was 3.42 USDC, just below the exchange minimum.
  assert.ok(!source.includes('"no available cash for a new order; rotation may release capital"'),
    "the old wording denied cash that was actually present");
  assert.match(source, /"Polymarket minimum order " \+ minOrderSize\.toFixed\(4\) \+ " shares costs " \+ minimumCost\.toFixed\(4\)\s*\n\s*\+ " USDC including fees, above the " \+ availableCash\.toFixed\(4\)/);
});

test("run digest: a run can be explained from its timestamp alone", async () => {
  const { readFile } = await import("node:fs/promises");
  const live = await readFile(new URL("../../.github/workflows/polymarket-live-limit-order-test.yml", import.meta.url), "utf8");
  const paper = await readFile(new URL("../../.github/workflows/trading-paper-bot.yml", import.meta.url), "utf8");

  // The decision is printed at the START of the execution step, so on a long run it falls
  // outside the window a log reader can fetch and the run cannot be explained from
  // outside the UI -- which is how a rotation verdict ended up unanswerable. A compact
  // digest printed LAST is always inside any tail.
  for (const [label, workflow] of [["live", live], ["paper", paper]]) {
    assert.match(workflow, /- name: Run digest/, `${label} must emit a digest`);
    assert.match(workflow, /=== RUN DIGEST ===/);
    assert.match(workflow, /=== END RUN DIGEST ===/, "a delimiter makes it greppable");
    // It must not be able to fail the run or be skipped when the run failed.
    const step = workflow.slice(workflow.indexOf("- name: Run digest"));
    assert.match(step.slice(0, 300), /if: always\(\)/, `${label} digest must run even after a failure`);
    assert.match(step.slice(0, 300), /continue-on-error: true/, `${label} digest must never fail the run`);
  }

  // Live: the parts that were previously invisible must be in it -- the real capital
  // requirement and the per-position rotation reasons, not just the outer verdict.
  assert.match(live, /required \{money\(capital\.get\('requiredStakeUsdc'\)\)\}/);
  assert.match(live, /for entry in \(review\.get\("reviews"\) or \[\]\)\[:12\]:/);
  assert.match(live, /entry\.get\('action'\)\}: \{str\(entry\.get\('reason'\)\)\[:200\]/);
  assert.match(live, /attempt\.get\('responseError'\)/, "a refused order must show why");

  // It has to be positioned after the state is written, or it would digest nothing.
  const uploadAt = live.indexOf("- name: Upload live state");
  const digestAt = live.indexOf("- name: Run digest");
  assert.ok(uploadAt > 0 && digestAt > uploadAt, "the digest must follow the state it reads");
});

test("rotation exit: an unknown negRisk must not be signed as 'not neg risk'", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8");

  // The reported failure, seen again in production at 05:11 on a 'Will Mark Sanford be
  // the new republican nominee for Senate' exit:
  //   SELL 5 @ 0.962 -> ROTATION_EXIT_REJECTED
  //   invalid POLY_1271 signature: signature does not match order hash
  //
  // negRisk picks which exchange contract is the EIP-712 verifying contract, so signing
  // a neg-risk market against the plain exchange yields an order hash the CLOB does not
  // reproduce. The client resolves it per token when the option is omitted
  // (`options?.negRisk ?? await this.getNegRisk(tokenID)`), so the only way to get this
  // wrong is to hand it a confident answer we never actually had -- which
  // `Boolean(order.negRisk)` did, turning every unknown into false.
  assert.ok(!/negRisk: Boolean\(/.test(source),
    "coercing an unknown negRisk to false overrides the client's own correct lookup");
  assert.match(source, /if \(typeof order\.negRisk === "boolean"\) options\.negRisk = order\.negRisk;/,
    "the option may only be set when the value is genuinely known");

  // And the reason it was never known on the exit path: /clob-markets/{conditionId}
  // answers in compact keys -- `mts`, `mos`, `nr` -- so reading `.negRisk` off it was
  // always undefined. The tick size already used the compact key; neg risk did not.
  assert.match(source, /typeof clobMarket\?\.nr === "boolean" \? clobMarket\.nr : undefined/,
    "the exit must read the compact `nr` key the endpoint actually returns");
  assert.ok(!/clobMarket\?\.negRisk/.test(source),
    "no camelCase read of a compact-key response may survive");
  assert.match(source, /number\(clobMarket\?\.mts/, "the tick size stays on its compact key too");

  // Both exit paths take the same options object, which is why both attempts failed
  // identically and the position stayed stranded.
  const submit = source.slice(source.indexOf("async function submitOrder"));
  const exitBlock = submit.slice(0, submit.indexOf("if (!USE_LIMIT_ORDERS || forceTaker)"));
  for (const builder of ["createOrder", "createMarketOrder"]) {
    assert.ok(exitBlock.includes(builder), `the exit must still try ${builder}`);
  }
});

test("rotation exit: a refused sell reports which taker path the CLOB refused", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8");
  const workflow = await readFile(new URL("../../.github/workflows/polymarket-live-limit-order-test.yml", import.meta.url), "utf8");

  // The exit tries two taker paths but persisted a single attempt record, so the digest
  // could only ever show one error and "the sell was rejected" stayed undiagnosable.
  assert.match(source, /exitPaths: Array\.isArray\(response\?\.exitAttempts\)/);
  assert.match(source, /path: attempt\.path/);
  assert.match(workflow, /for path in \(attempt\.get\("exitPaths"\) or \[\]\)/,
    "the digest must print every path that was tried");
});

test("run digest: a run carries the same timestamp label the dashboard shows", async () => {
  const { readFile } = await import("node:fs/promises");
  const workflow = await readFile(new URL("../../.github/workflows/polymarket-live-limit-order-test.yml", import.meta.url), "utf8");

  // Reported: every prompt already named the run time, and the run still could not be
  // located -- because a reported time was matched against when the workflow STARTED.
  // The dashboard labels a run by its generatedAt in local time, which lands minutes
  // after the start, so that lookup finds the wrong run or none at all. The digest now
  // prints the dashboard's own label, making a reported time directly greppable.
  assert.match(workflow, /from zoneinfo import ZoneInfo/);
  assert.match(workflow, /ZoneInfo\("Europe\/Prague"\)/, "the label must be in the dashboard's timezone, not UTC");
  assert.match(workflow, /strftime\("%d\. %m\. %Y %H:%M"\)/, "and in the dashboard's own format");
  assert.match(workflow, /\(dashboard \{dashboard_time\(state\.get\('generatedAt'\)\)\}\)/);
  // A missing or malformed timestamp must not take the whole digest down with it.
  assert.match(workflow, /except ValueError:\n\s*return "-"/);
});

test("rotation log: the sell and its replacement are one run, not two rows", () => {
  // Reported: the rotation worked, "but the log disappeared from the list", and both
  // legs were expected in a single entry. A rotation is two executor passes in one
  // workflow run -- pass 1 sells, pass 2 buys the replacement -- and each pass wrote
  // its own row. The dashboard dedupes rows by batchLog id, so the sell row lost and
  // vanished, leaving only the buy.
  const sellAttempt = { side: "SELL", orderPrice: 0.962, orderSize: 5, action: "ROTATION_EXIT_SUBMITTED" };
  const buyAttempt = { side: "BUY", orderPrice: 0.85, orderSize: 5, action: "SUBMITTED" };
  const previousState = {
    action: "ROTATION_EXIT_SUBMITTED",
    reason: "rotation exit accepted at the current bid",
    rotationExit: { tokenId: "sold-token" },
  };
  const exitEntry = { id: "live-trade-batch-sell", attempts: [sellAttempt] };
  const runEntry = { id: "live-trade-batch-buy", attempts: [buyAttempt] };
  const payload = { action: "SUBMITTED", reason: "live order accepted by Polymarket" };

  const merged = executor.rotationLegMerge({
    completionRun: true, previousState, exitEntry, runEntry, payload,
  });
  assert.ok(merged, "the completion pass must fold the sell into its own run");
  assert.equal(merged.action, "ROTATED");
  assert.deepEqual(merged.attempts, [sellAttempt, buyAttempt], "sell first, then buy -- the order they happened in");
  assert.match(merged.reason, /rotation exit accepted at the current bid/, "the close must stay readable");
  assert.match(merged.reason, /live order accepted by Polymarket/, "and so must the open");
  assert.deepEqual(merged.rotationExit, { tokenId: "sold-token" });
  // The merged row keeps the buy's identity on purpose: the dashboard renders the
  // top-level state as a row too and dedupes against the log by that id, so adopting
  // the sell's id would recreate the very row that used to disappear.
  assert.ok(!("id" in merged), "the merge must not override the entry's identity");

  // Every other run is untouched -- this must not collapse unrelated consecutive runs.
  assert.equal(executor.rotationLegMerge({
    completionRun: false, previousState, exitEntry, runEntry, payload,
  }), null, "a normal run keeps writing a single ordinary row");
  assert.equal(executor.rotationLegMerge({
    completionRun: true, previousState: { action: "SKIP" }, exitEntry, runEntry, payload,
  }), null, "only an accepted rotation exit may be folded in");
  assert.equal(executor.rotationLegMerge({
    completionRun: true, previousState, exitEntry: undefined, runEntry, payload,
  }), null, "with no previous row there is nothing to merge");
});

test("rotation log: the workflow tells the second pass that it is a rotation", async () => {
  const { readFile } = await import("node:fs/promises");
  const workflow = await readFile(new URL("../../.github/workflows/polymarket-live-limit-order-test.yml", import.meta.url), "utf8");
  const step = workflow.slice(workflow.indexOf("- name: Complete filled rotation immediately"));
  assert.match(step.slice(0, 900), /LIVE_ROTATION_COMPLETION: "true"/,
    "without the flag the replacement pass would write its own row again");
});

test("rotation scope: a candidate may not settle later than everything it could replace", () => {
  // Reported from the 07:53 SKIP run: the rotation tried 'Exact Score: FC Zbrojovka
  // Brno 1 - 2 FC Slovan Liberec' and then held anyway, because "this position
  // resolves in 0.75 days and the replacement not until 1.00 days". A candidate that
  // settles after everything it could replace can never win that comparison, so
  // revalidating it live is work spent to reach a foregone conclusion.
  const day = 24 * 60 * 60 * 1000;
  const base = Date.parse("2026-08-07T06:00:00Z");
  const candidate = (name, endOffsetDays, pa) => ({
    tokenId: `token-${name}`,
    question: name,
    endDate: new Date(base + endOffsetDays * day).toISOString(),
    marketProbability: 0.9,
    netGainIfWinUsdc: pa,
    totalCostUsdc: 1,
    daysToResolution: endOffsetDays,
  });
  const soon = candidate("resolves-first", 0.2, 0.05);
  const late = candidate("resolves-after-everything", 3, 0.9);

  const liveState = {
    positions: [{ tokenId: "held", status: "OPEN", shares: 5, endDate: new Date(base + 0.75 * day).toISOString() }],
    openOrders: [{ tokenId: "resting", side: "BUY", endDate: new Date(base + 0.5 * day).toISOString() }],
  };
  const latest = executor.latestHoldingResolutionMs(liveState, new Map());
  assert.equal(latest, Date.parse(new Date(base + 0.75 * day).toISOString()),
    "the bar is the latest holding, positions and resting orders alike");

  const pool = executor.candidatePoolForRotation([late, soon], { latestResolutionMs: latest });
  const ids = pool.map((item) => item.tokenId);
  assert.ok(ids.includes("token-resolves-first"), "a candidate settling inside the window stays");
  assert.ok(!ids.includes("token-resolves-after-everything"),
    "a candidate settling after every holding cannot be a rotation and must not be revalidated");

  // Unfiltered without a bar, and an unknown end date is not treated as a late one.
  assert.equal(executor.candidatePoolForRotation([late, soon], {}).length, 2);
  const undated = { ...soon, tokenId: "token-undated", endDate: null };
  assert.ok(executor.candidatePoolForRotation([undated], { latestResolutionMs: latest })
    .some((item) => item.tokenId === "token-undated"), "unknown must stay reviewable, not be dropped");
});

test("rotation scope: how many holdings get reviewed is a rule, not a fixed slice", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8");
  const workflow = await readFile(new URL("../../.github/workflows/polymarket-live-limit-order-test.yml", import.meta.url), "utf8");

  // Only one position was reviewed while other holdings worth less than the candidate
  // were never considered, because a fixed top-N slice decided how much got looked at.
  assert.match(source, /const worthRotatingOutOf = \(entry\) => \{/);
  assert.match(source, /return held == null \|\| held < bestCandidateReturn;/,
    "unknown stays reviewable; only a holding measurably above the candidate is skipped");
  assert.match(source, /\.filter\(worthRotatingOutOf\)/);
  // The cap remains, as a runaway guard rather than the selection rule.
  assert.match(source, /LIVE_ROTATION_POSITION_SCAN_LIMIT", 25\)/);

  // Resting orders were reviewed all along but only ever reported as a count, which
  // is why a run looked like it had considered a single holding.
  assert.match(workflow, /order_reviews = state\.get\("openOrderReviews"\)/);
  assert.match(workflow, /reviewed for rotation/);
});

test("5050: every bid rests at the configured price, sized to a valid maker amount", () => {
  // The 5050 portfolio does not buy the best candidate at the market price. It rests
  // a bid at a fixed point on the 0..1 scale across everything that clears its
  // probability bar, accepting that most never fill. So the revalidation's own price
  // and size -- which were derived from the current ask and the free cash -- must be
  // replaced, while the market facts it discovered are kept.
  const row = {
    tokenId: "t1",
    question: "Some market?",
    tickSize: 0.01,
    minOrderSize: 5,
    orderPrice: 0.96,
    orderSize: 5,
    orderNotionalUsdc: 4.8,
    negRisk: true,
  };

  const order = executor.fixedEntryOrder(row, { price: 0.5, stakeUsdc: 0 });
  assert.equal(order.orderPrice, 0.5, "the bid rests where the strategy says, not at the market");
  assert.equal(order.orderSize, 5, "with no stake configured it uses the exchange minimum");
  assert.equal(order.orderNotionalUsdc, 2.5);
  assert.equal(order.orderType, "GTC", "it has to rest on the book, not take");
  assert.equal(order.negRisk, true, "market facts from the revalidation are kept");

  // A stake buys as many shares as it covers, never fewer than the exchange minimum.
  assert.equal(executor.fixedEntryOrder(row, { price: 0.5, stakeUsdc: 10 }).orderSize, 20);
  assert.equal(executor.fixedEntryOrder(row, { price: 0.5, stakeUsdc: 1 }).orderSize, 5);

  // Polymarket rejects a maker amount with more than two decimals, and price * size
  // is that amount -- the same class of rejection that has bitten real orders.
  for (const price of [0.5, 0.33, 0.07, 0.99]) {
    for (const stake of [0, 1, 3.33, 10]) {
      const built = executor.fixedEntryOrder({ ...row, tickSize: 0.01 }, { price, stakeUsdc: stake });
      const makerAmount = built.orderPrice * built.orderSize;
      assert.ok(Math.abs(makerAmount * 100 - Math.round(makerAmount * 100)) < 1e-6,
        `price ${price} stake ${stake} produced maker amount ${makerAmount}`);
      assert.ok(built.orderSize >= 5, "and never below the exchange minimum");
    }
  }

  // A price outside the tradable band is refused rather than sent to be rejected.
  assert.equal(executor.fixedEntryOrder(row, { price: 0 }), null);
  assert.equal(executor.fixedEntryOrder(row, { price: 1 }), null);
});

test("5050: the strategy is opt-in and does not disturb the main live portfolio", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8");
  const workflow = await readFile(new URL("../../.github/workflows/trading-live-5050.yml", import.meta.url), "utf8");
  const api = await readFile(new URL("../api.php", import.meta.url), "utf8");

  // Off unless explicitly asked for, so the existing live portfolio is untouched.
  assert.match(source, /const FIXED_ENTRY_STRATEGY = String\(process\.env\.LIVE_STRATEGY \|\| ""\)\.trim\(\)\.toLowerCase\(\) === "fixed_entry";/);
  assert.match(source, /if \(FIXED_ENTRY_STRATEGY\) \{[\s\S]*?await runFixedEntryBatch\(/);

  // It writes its own run log: same wallet, separate decisions.
  assert.match(workflow, /LIVE_EXECUTION_STATE_PATH: data\/live-5050-execution-state\.json/);
  assert.match(api, /'live-5050-execution' => __DIR__ \. '\/data\/live-5050-execution-state\.json'/);

  // Resting below the market only works as a maker order, and rotation would fight
  // the whole premise of accumulating cheap fills.
  assert.match(workflow, /POLYMARKET_POST_ONLY: "true"/);
  assert.match(workflow, /LIVE_AUTO_ROTATE: "false"/);
  // A scheduled run trades; a dispatch only when explicitly confirmed, so an
  // unconfirmed manual run stays a dry run. The confirmation test is spelled out rather
  // than relying on the input's truthiness -- that form accepted the string "false" and
  // placed a real order, which the workflow test below covers in full.
  assert.match(workflow, /github\.event_name == 'schedule' \|\| \(github\.event_name == 'workflow_dispatch' && \(inputs\.live_confirm == true \|\| inputs\.live_confirm == 'true'\)\)/);

  // Running past the capital on hand is intended, so a collateral refusal is counted
  // rather than treated as a fault.
  assert.match(source, /rejectedForFunds/);
  assert.match(source, /balance\|allowance\|insufficient\|not enough/);
});

test("5050: a candidate the market-price check gave up on is still biddable", () => {
  // The first live dry run scanned 300 candidates and bid on none: every row read
  // 'probability -%' with no question. A revalidation returns a rich row when it
  // priced the market and a thin {candidate, rejectReasons} one when it gave up --
  // and it gives up for reasons that only bind at the market price, such as
  // "current Potential p.a. is non-profitable after fees". That says nothing about a
  // bid resting at half of it, so the facts must be read through to the evaluation
  // instead of treating the early return as a candidate with no facts at all.
  const thin = {
    candidate: {
      tokenId: "42",
      question: "Will X happen?",
      outcome: "No",
      marketProbability: 0.94,
      marketPrice: 0.94,
      tickSize: 0.01,
      negRisk: true,
      daysToResolution: 0.4,
    },
    eligible: false,
    rejectReasons: ["current Potential p.a. is non-profitable after fees"],
    currentPrice: 0.94,
    minOrderSize: 5,
  };

  const facts = executor.fixedEntryRowFacts(thin);
  assert.equal(facts.tokenId, "42");
  assert.equal(facts.question, "Will X happen?", "the question must survive an early return");
  assert.equal(facts.marketProbability, 0.94, "and so must the probability the bar is checked against");
  assert.equal(facts.minOrderSize, 5, "the exchange minimum the revalidation did learn is kept");
  assert.equal(facts.negRisk, true, "unknown must stay unknown, but a known value must not be lost");
  assert.equal(facts.currentBestAsk, 0.94);

  const order = executor.fixedEntryOrder(facts, { price: 0.5, stakeUsdc: 0 });
  assert.equal(order.orderPrice, 0.5);
  assert.equal(order.tokenId, "42");
  assert.equal(order.negRisk, true);

  // A rich row still wins over the stored evaluation where both exist.
  const rich = { ...thin, tokenId: "42", question: "Live question?", marketProbability: 0.91, currentBestAsk: 0.9 };
  assert.equal(executor.fixedEntryRowFacts(rich).question, "Live question?");
  assert.equal(executor.fixedEntryRowFacts(rich).marketProbability, 0.91);
});

test("5050: at most one bid per event, enforced before the orders exist", () => {
  // 5050 bids the whole qualifying set, and a match's sub-markets -- Exact Score
  // 2-1, 3-0, the spread -- are separate candidates. Left alone it would rest five
  // bids on one fixture and could open five correlated positions.
  //
  // This is enforced at submission rather than by cancelling siblings after a fill,
  // because cancelling cannot guarantee it: resting bids match asynchronously on
  // Polymarket's book, several sub-markets of one match can fill in the same
  // instant, and this process only sees fills by polling minutes apart. By the time
  // a fill is visible the siblings may already have filled too. One order per event
  // is a guarantee, because an event carrying a single order cannot open two
  // positions. Cancellation is kept, but as cleanup for what is already on the book.
  const src = readFileSync(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8");
  // The cap now bounds resting bids rather than one run's placements, so this
  // exercises the diversification pass alone with the allowance passed in.
  const block = /const diversified = \[\];[\s\S]*?\n  \}\n/.exec(src)[0];
  const run = new Function("pool", `
    const claimedGroupKeys=new Set(); const skipped=[];
    ${block}
    return {targets: diversified, skipped};`);

  const pool = [
    { tokenId: "a1", riskGroupKeys: ["event:matchA", "match:a"] },
    { tokenId: "a2", riskGroupKeys: ["event:matchA", "match:a"] },
    { tokenId: "a3", riskGroupKeys: ["event:matchA"] },
    { tokenId: "b1", riskGroupKeys: ["event:matchB", "match:b"] },
    { tokenId: "c1", riskGroupKeys: [] },
  ];
  const { targets, skipped } = run(pool);

  assert.deepEqual(targets.map((row) => row.tokenId), ["a1", "b1", "c1"],
    "one bid per event, and the pool is already in priority order so the best one wins");
  assert.equal(skipped.length, 2);
  assert.match(skipped[0].reason, /already covers this event/);

  // A row with no event key collides with nothing and is its own event.
  assert.ok(targets.some((row) => row.tokenId === "c1"));

  // Nothing caps the count: the exchange's collateral is what bounds it, so every
  // distinct event that qualifies gets a bid.
  assert.match(src, /const targets = diversified;/);
  assert.ok(!/FIXED_ENTRY_MAX_ORDERS/.test(src), "the configured ceiling is gone");

  // Events already open block a bid outright, from either portfolio's holdings.
  assert.match(src, /const heldCollision = earlyRiskBlockReason\(\{ \.\.\.row\.candidate, \.\.\.row, tokenId: facts\.tokenId \}, held\);/);
  // And the cleanup layer withdraws siblings once an event has opened.
  assert.match(src, /const cancelledSiblings = \[\];/);
  assert.match(src, /withdrew \$\{cancelledSiblings\.length\} resting bid\(s\) on events that already opened/);
});

test("5050: the batch is called with everything its signature requires", () => {
  // The run died with "evaluationByToken is not defined": the batch used it for the
  // risk checks but the call site never passed it, and the parameter had no default.
  // node --check parses, it does not resolve identifiers, so it compiled clean and
  // failed on the runner mid-run -- after the scan, before any bid.
  //
  // Comparing the destructured signature against the call site catches exactly that:
  // a parameter that is read but never supplied.
  const src = readFileSync(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8");
  const signature = /async function runFixedEntryBatch\(\{([^}]*)\}\)/.exec(src);
  assert.ok(signature, "the batch signature must stay destructured for this check to hold");
  const call = /await runFixedEntryBatch\(\{([^}]*)\}\)/.exec(src);
  assert.ok(call, "the call site must be found");

  const names = (text) => text.split(",").map((part) => part.split("=")[0].trim()).filter(Boolean);
  const declared = names(signature[1]);
  const passed = new Set(names(call[1]));
  // A parameter with a default is optional; one without must be supplied.
  const required = signature[1].split(",").filter((part) => !part.includes("=")).map((part) => part.trim()).filter(Boolean);

  for (const name of required) {
    assert.ok(passed.has(name), `runFixedEntryBatch reads ${name} but the call site does not pass it`);
  }
  // And nothing is passed that the batch would silently ignore.
  for (const name of passed) {
    assert.ok(declared.includes(name), `the call site passes ${name}, which the signature does not accept`);
  }
  // The parameter this actually failed on.
  assert.ok(declared.includes("evaluationByToken"));
  assert.ok(passed.has("evaluationByToken"));
});


// Reported: the newest entry in the 5050 run log appeared twice. The dashboard renders
// the top-level execution state as a row and dedupes it against the run log by batchLog
// id -- but only one of the executor's nine emit sites set an id. Every other run, and
// every 5050 run because that is its only path, published a batchLog its own stored log
// entry could not be matched to, so the same decision rendered as two rows.
function functionSource(source, name) {
  let start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`missing ${name}`);
  // Keep the `async` keyword, or an awaiting body is extracted as a sync function.
  if (source.slice(start - 6, start) === "async ") start -= 6;
  // Count from the body brace after the parameter list, not a `row = {}` default
  // parameter. Line endings vary across local checkouts, so this cannot depend on LF.
  const bodyStart = source.indexOf("{", source.indexOf(")", start));
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (!depth) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced ${name}`);
}

function dashboardRunLog(executionState) {
  const app = readFileSync(new URL("../assets/app.js", import.meta.url), "utf8");
  const body = ["normalizeLiveExecutionRun", "isSameLiveRun", "runLogTimestamp", "sortRunLogRows", "mergeUniqueByRun",
    "isCadenceWaitRun", "isHistoryRecoveryRun", "liveRunLogRows"]
    .map((name) => functionSource(app, name)).join("\n\n");
  const build = new Function("state", "isFixedEntryMode", "liveBatchCandidateSummaryFromExecution", "portfolioReturnMetricLabel", `
    ${body}
    return liveRunLogRows;
  `);
  return build(
    { liveState: null, liveExecutionState: executionState },
    () => true,
    (item) => item,
    () => "",
  )();
}

test("5050 run log: one decision is one row, not two", () => {
  // A real 5050 emit: generatedAt and batchLog.runAt are separate new Date() calls, so
  // they do not even agree to the millisecond, and the batchLog carried no id at all.
  const generatedAt = "2026-08-08T14:20:00.100Z";
  const batchLog = {
    action: "SKIP",
    reason: "no candidate cleared the bar for a resting bid at 0.50",
    strategyId: "live-5050",
    strategyLabel: "5050",
    runAt: "2026-08-08T14:20:00.104Z",
    counts: {},
  };
  // The entry emitDecision stores for that same run.
  const storedEntry = {
    ...batchLog,
    id: `live-trade-batch-${generatedAt}`,
    generatedAt,
    explanation: batchLog.reason,
  };
  const older = {
    id: "live-trade-batch-2026-08-08T13:50:00.000Z",
    runAt: "2026-08-08T13:50:00.000Z",
    strategyId: "live-5050",
    action: "SUBMITTED",
    reason: "older run",
  };

  const rows = dashboardRunLog({
    generatedAt,
    action: batchLog.action,
    reason: batchLog.reason,
    batchLog,
    runLog: [storedEntry, older],
  });

  assert.equal(rows.length, 2, `the newest run must appear once: ${rows.map((row) => `${row.action}@${row.runAt}`).join(", ")}`);
  assert.equal(rows[0].runAt, batchLog.runAt, "and it must still be the newest row");
  assert.equal(rows[1].id, older.id, "the older run is untouched");
  // Matching on id is what collapses them; the run times deliberately differ.
  assert.equal(rows[0].id, storedEntry.id);
});

test("5050 run log: the executor publishes the batchLog its own log entry is keyed by", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8");
  const emit = functionSource(source, "emitDecision");

  let written = null;
  const build = new Function(
    "previousExecutionState", "compactLiveRunRecord", "rotationLegMerge", "ROTATION_COMPLETION_RUN",
    "mergeRunLog", "consoleDecisionSummary", "EXECUTION_STATE_PATH", "mkdir", "writeFile", "dirname", "console",
    `${emit}\nreturn emitDecision;`,
  );
  const emitDecision = build(
    { runLog: [] },
    (batchLog) => batchLog,
    () => null,
    false,
    (rows) => rows,
    (output) => output,
    "state.json",
    async () => {},
    async (_path, body) => { written = JSON.parse(body); },
    () => ".",
    { log() {} },
  );

  // The 5050 payload, exactly as it is built: a batchLog with no id of its own.
  await emitDecision({
    generatedAt: "2026-08-08T14:20:00.100Z",
    action: "SKIP",
    reason: "no candidate cleared the bar",
    batchLog: { action: "SKIP", reason: "no candidate cleared the bar", strategyId: "live-5050", runAt: "2026-08-08T14:20:00.104Z" },
  });

  assert.ok(written, "the state must be written");
  assert.ok(written.batchLog.id, "the published batchLog needs an identity of its own");
  assert.equal(written.batchLog.id, written.runLog[0].id,
    "the top-level row and its log entry must be the same run to the dashboard's dedupe");
  assert.equal(written.batchLog.runAt, written.runLog[0].runAt);
  // Everything the row renders from must survive the stamping.
  assert.equal(written.batchLog.strategyId, "live-5050");
  assert.equal(written.batchLog.action, "SKIP");
});

test("5050 run log: a state with no batchLog is left as one", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8");
  const emit = functionSource(source, "emitDecision");

  let written = null;
  const build = new Function(
    "previousExecutionState", "compactLiveRunRecord", "rotationLegMerge", "ROTATION_COMPLETION_RUN",
    "mergeRunLog", "consoleDecisionSummary", "EXECUTION_STATE_PATH", "mkdir", "writeFile", "dirname", "console",
    `${emit}\nreturn emitDecision;`,
  );
  const emitDecision = build(
    { runLog: [] }, (batchLog) => batchLog, () => null, false, (rows) => rows, (output) => output,
    "state.json", async () => {}, async (_path, body) => { written = JSON.parse(body); }, () => ".", { log() {} },
  );

  // Some emits carry no batchLog, and the dashboard builds a richer row from settings
  // and account for those. Inventing one here would send them down the wrong branch.
  await emitDecision({ generatedAt: "2026-08-08T14:20:00.100Z", action: "AUTOMATION_DISABLED", reason: "off" });
  assert.equal(written.batchLog, undefined, "no batchLog must be conjured for a state that has none");
});

// Reported: the 5050 workflow took far too long. Measured on the runner, the executor
// step ran 5s when there was little to do and 200s when it rested a full batch -- about
// four seconds per bid, sequential, so the cost is the number of events. The pass is now
// bounded: bids go best-first until the budget is spent, the rest wait for the next run.
async function runPlacementLoop({ budgetMs, targetCount, perOrderMs, progressEvery = 5 }) {
  const source = readFileSync(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8");
  const start = source.indexOf("  const placementStartedAt = Date.now();");
  const end = source.indexOf("  // Cleanup, layered on top of the guarantee above.");
  assert.ok(start > 0 && end > start, "the placement loop must still be identifiable");
  const loop = source.slice(start, end);

  const progress = [];
  const build = new Function(
    "targets", "DRY_RUN", "hasFlag", "orderAttemptSummary", "submitOrderWithMakerPrecisionRecovery",
    "successfulOrderResponse", "orderResponseError", "tradingConfig", "FIXED_ENTRY_BUDGET_MS",
    "FIXED_ENTRY_PROGRESS_EVERY", "console",
    `return (async () => {
      const attempts = [];
      let accepted = 0;
      let rejectedForFunds = 0;
      ${loop}
      return { placed, deferredForBudget, accepted, elapsed: Date.now() - placementStartedAt };
    })();`,
  );
  const result = await build(
    Array.from({ length: targetCount }, (_, index) => ({ tokenId: String(index) })),
    false,
    (flag) => flag === "confirm-live",
    () => ({}),
    async (order) => {
      await new Promise((resolve) => setTimeout(resolve, perOrderMs));
      return { order, response: { success: true } };
    },
    () => true,
    () => "",
    {},
    budgetMs,
    progressEvery,
    { log: (line) => progress.push(line) },
  );
  return { ...result, progress };
}

test("5050 placement: the batch stops at its time budget and defers the rest", async () => {
  // Ten bids' worth of budget against fifty candidates.
  const result = await runPlacementLoop({ budgetMs: 400, targetCount: 50, perOrderMs: 40 });
  assert.ok(result.placed > 1 && result.placed < 50, `expected a partial batch, placed ${result.placed}`);
  assert.equal(result.placed + result.deferredForBudget, 50, "every candidate is either placed or deferred");
  // One order's worth of tolerance, because this is a real wall clock. The loop can only
  // overshoot by the order it had already committed to when the budget ran out, so 400 + 40
  // is the true ceiling; asserting a bare 400 failed on 401ms roughly one run in four and
  // made a green suite a coin toss. The check still means what it says -- a loop that ran
  // the whole batch would land near 2000ms and fail by a mile.
  assert.ok(result.elapsed <= 440, `the budget is a ceiling, not a target: took ${result.elapsed}ms`);
});

test("5050 placement: a budget never produces a pass that places nothing", async () => {
  // The per-order cost is unknown until one has been placed, so the first always goes.
  // Otherwise an unlucky budget would leave the portfolio unable to trade at all.
  const result = await runPlacementLoop({ budgetMs: 1, targetCount: 8, perOrderMs: 30 });
  assert.equal(result.placed, 1);
  assert.equal(result.deferredForBudget, 7);
});

test("5050 placement: no budget means the whole batch, as before", async () => {
  const result = await runPlacementLoop({ budgetMs: 0, targetCount: 12, perOrderMs: 20 });
  assert.equal(result.placed, 12);
  assert.equal(result.deferredForBudget, 0);

  // And a budget the batch fits inside changes nothing either.
  const roomy = await runPlacementLoop({ budgetMs: 5000, targetCount: 6, perOrderMs: 20 });
  assert.equal(roomy.placed, 6);
  assert.equal(roomy.deferredForBudget, 0);
});

test("5050 placement: a deferral is reported, not silent", async () => {
  const { readFile } = await import("node:fs/promises");
  const [source, workflow] = await Promise.all([
    readFile(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8"),
    readFile(new URL("../../.github/workflows/trading-live-5050.yml", import.meta.url), "utf8"),
  ]);

  // A run that quietly placed a third of the batch would read as a batch of that size,
  // so the run log row leads with how far the pass got rather than what it rested.
  assert.match(source, /`processed \$\{processedEvents\} of \$\{targets\.length\} events in \$\{elapsedSeconds\}s;/);
  assert.match(source, /\$\{deferredForBudget\} event\(s\) wait for the next run after the/);
  // A dry run touches every target, so its fraction is the whole batch, not zero.
  assert.match(source, /const processedEvents = DRY_RUN \|\| !hasFlag\("confirm-live"\) \? targets\.length : placed;/);
  // The dashboard reads the run's counts, so the progress and its cost live there too.
  assert.match(source, /processedEvents,\n\s+acceptedOrders: accepted,/);
  assert.match(source, /deferredForBudget,\n\s+placementBudgetMs: FIXED_ENTRY_BUDGET_MS,\n\s+placementElapsedMs: Date\.now\(\) - placementStartedAt,\n\s+placementPerOrderMs: placed \? Math\.round\(placementMs \/ placed\) : 0,/);

  // Best-first ordering is what makes deferral acceptable: the tail is the weakest.
  assert.match(source, /if \(b\.marketProbability !== a\.marketProbability\) return b\.marketProbability - a\.marketProbability;/);
  assert.match(workflow, /LIVE_FIXED_ENTRY_BUDGET_MS: "40000"/);
});

test("5050 placement: the pass reports its position in the batch as it goes", async () => {
  // Asked for: rather than a run whose time simply grows, it should be visible that
  // e.g. 20 of 300 events are being worked through. The runner log carries it live.
  const result = await runPlacementLoop({ budgetMs: 0, targetCount: 12, perOrderMs: 5, progressEvery: 5 });
  assert.deepEqual(result.progress, [
    "5050 placement: 5/12 events, 5 rested, 0s elapsed",
    "5050 placement: 10/12 events, 10 rested, 0s elapsed",
    "5050 placement: 12/12 events, 12 rested, 0s elapsed",
  ], "every fifth bid and the last one, so a 300-bid pass is sixty lines and not three hundred");

  // A pass cut short by the budget still says where it stopped.
  const partial = await runPlacementLoop({ budgetMs: 120, targetCount: 40, perOrderMs: 20, progressEvery: 2 });
  assert.ok(partial.progress.length, "a partial pass must report too");
  const last = partial.progress[partial.progress.length - 1];
  assert.match(last, new RegExp(`^5050 placement: \\d+/40 events,`));
  assert.ok(partial.placed < 40, "and it really did stop short");
});

test("5050 run detail: a partial pass reads as a fraction, not as a small batch", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");
  const start = app.indexOf("  const batchProgressText = ");
  const end = app.indexOf("  const riskText = ");
  assert.ok(start > 0 && end > start, "the batch progress block must still be identifiable");
  const build = new Function("counts", "batch", "formatInteger",
    `${app.slice(start, end)}\nreturn batchProgressText;`);
  const render = (counts) => build(counts, {}, (value) => String(value));

  const partial = render({
    processedEvents: 20, targetedOrders: 300, deferredForBudget: 280,
    placementElapsedMs: 38400, placementBudgetMs: 40000, placementPerOrderMs: 1920,
  });
  assert.match(partial, /^20 of 300 events processed in 38\.4s$/m);
  assert.match(partial, /280 left for the next run: the 40s placement budget was spent at 1\.9s per bid/);

  const whole = render({
    processedEvents: 12, targetedOrders: 12, deferredForBudget: 0,
    placementElapsedMs: 4100, placementBudgetMs: 40000, placementPerOrderMs: 341,
  });
  assert.match(whole, /^12 of 12 events processed in 4\.1s$/m);
  assert.match(whole, /the whole batch was worked through/);

  // Runs that do not work a batch -- the single-order live portfolio, and anything
  // published before this existed -- must render nothing rather than "0 of 0".
  assert.equal(render({ scannedCandidates: 40, eligibleCandidates: 3 }), "");
  assert.equal(render({ processedEvents: 0, targetedOrders: 0 }), "");
});

// Reported: the Live portfolio saw zero available cash for new orders because 5050 was
// resting a far larger book, and the two share one Polymarket account. Live must reserve
// against its own submissions only, so with nothing of its own placed the whole account
// cash is available to it.
function liveCashApi() {
  const source = readFileSync(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8");
  const body = ["activeBuyOrderReservationUsdc", "ownSubmittedOrderIdentity", "orderWasSubmittedByThisPortfolio",
    "successfulOrderResponse", "availableLiveCashUsdc"].map((name) => functionSource(source, name)).join("\n\n");
  return new Function("number", "liveCashUsdc", `${body}
    return { availableLiveCashUsdc, activeBuyOrderReservationUsdc, ownSubmittedOrderIdentity };`)(
    (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback),
    (liveState) => Number(liveState?.account?.cashUsdc || 0),
  );
}

const restingBid = (id, tokenId, notional) => ({
  id, tokenId, side: "BUY", status: "LIVE", price: 0.5, remainingSize: notional / 0.5, notionalUsdc: notional,
});

// Capital available for a new order is the account total minus what is held in open
// POSITIONS. Resting bids are not deducted, because they are not spent.
//
// This used to subtract the portfolio's own resting BUY notional, on the belief -- stated
// in a comment and never measured -- that CLOB collateral is the balance before the
// notional locked by pending buys. Measured on the live account
// (tools/live-capital-diagnosis.mjs): collateral 32.3788, positions 60.4041, equity
// 92.7829, and equity minus (collateral + positions) is exactly 0.0000. The collateral
// figure is therefore already the whole uncommitted balance and resting bids are not
// escrowed against it -- Polymarket checks collateral when an order matches, not when it
// rests. Subtracting 39.9657 of resting notional from 32.3788 of real cash clamped the
// result to zero and skipped every candidate for want of money the wallet was holding.
test("live cash: a resting bid is a claim at match time, not cash already spent", () => {
  const api = liveCashApi();
  const liveState = {
    account: { cashUsdc: 42.5 },
    openOrders: Array.from({ length: 8 }, (_, index) => restingBid(`o-5050-${index}`, `10${index}`, 5)),
  };

  // The whole-wallet total is still computed and still reported in the run digest: what
  // the account has resting is worth seeing, it just no longer reduces what may be spent.
  assert.equal(api.activeBuyOrderReservationUsdc(liveState), 40);

  // The balance is available in full, whoever placed those bids.
  assert.equal(api.availableLiveCashUsdc(liveState, 42.5), 42.5);
  // Including when this portfolio placed them itself. 40 resting against 42.5 of cash is
  // the ordinary state of a deployed account, not a reason to stop trading.
  const own = {
    account: { cashUsdc: 42.5 },
    openOrders: [restingBid("o-live-1", "999", 12)],
  };
  assert.equal(api.availableLiveCashUsdc(own, 42.5), 42.5);

  // The reported figure is the cash, never negative, and never invented from nothing.
  assert.equal(api.availableLiveCashUsdc(liveState, -5), 0, "a negative balance reads as nothing to spend");
  assert.equal(api.availableLiveCashUsdc(liveState, 0), 0);
  assert.equal(api.availableLiveCashUsdc(liveState, "abc"), 0, "an unreadable balance is not spendable");

  // The exact case from the reported SKIP: 32.3788 of cash with 39.9657 resting. The old
  // rule made this 0.00 and refused a 3.50 exchange minimum; the account had the money.
  const reported = {
    account: { cashUsdc: 32.3788 },
    openOrders: [restingBid("o-1", "1", 39.9657)],
  };
  assert.equal(api.availableLiveCashUsdc(reported, 32.3788), 32.3788);
  assert.ok(api.availableLiveCashUsdc(reported, 32.3788) > 3.5,
    "the run that skipped for want of 3.50 USDC was holding 32.38");
});

test("live cash: order attribution still works, because the run still reports it", () => {
  const api = liveCashApi();
  const liveState = {
    account: { cashUsdc: 42.5 },
    openOrders: [
      ...Array.from({ length: 8 }, (_, index) => restingBid(`o-5050-${index}`, `10${index}`, 5)),
      restingBid("o-live-1", "999", 12),
    ],
  };
  const history = {
    runLog: [{
      attempts: [
        { tokenId: "999", response: { orderID: "o-live-1", status: "live" } },
        // Live wanted this token, the exchange refused it, and the other portfolio is
        // resting a bid on it now. A refused attempt must not claim that order.
        { tokenId: "100", response: { error: "not enough balance" } },
      ],
    }],
  };
  // Which orders are this portfolio's is still needed -- the digest separates the wallet's
  // resting total from this portfolio's own -- so the identity rules stay pinned even
  // though they no longer gate spending.
  const identity = api.ownSubmittedOrderIdentity(history);
  assert.deepEqual([...identity.orderIds], ["o-live-1"]);
  assert.deepEqual([...identity.tokenIds], [], "a refused attempt contributes no token to fall back on");
  assert.equal(api.activeBuyOrderReservationUsdc(liveState, identity), 12,
    "only this portfolio's own resting bid counts as its own");
  assert.equal(api.activeBuyOrderReservationUsdc(liveState), 52, "the wallet total counts them all");
});

test("live cash: an accepted order with no id is still attributed by its token", () => {
  const api = liveCashApi();
  const liveState = {
    account: { cashUsdc: 20 },
    openOrders: [restingBid("o-live-1", "999", 12), restingBid("o-5050-1", "111", 5)],
  };
  // Some accepted responses carry no order id. The token is the only key left, and here
  // it is safe: the attempt succeeded, so the resting order on it is this portfolio's.
  const history = { runLog: [{ attempts: [{ tokenId: "999", response: { success: true } }] }] };
  const identity = api.ownSubmittedOrderIdentity(history);
  assert.equal(api.activeBuyOrderReservationUsdc(liveState, identity), 12);
  // And the balance is untouched by it either way.
  assert.equal(api.availableLiveCashUsdc(liveState, 20), 20);
});

// Asked for: a resolution date in the past must report the real negative horizon, not the
// default 1.0 d -- and without moving any figure computed from it. The clamp lived in the
// account sync, which stamps the horizon onto every position and open order, so an
// expired order read "1.0 d left" however long ago it had ended.
test("days left: an expired horizon is reported signed, and moves nothing else", async () => {
  const { readFile } = await import("node:fs/promises");
  const [sync, app] = await Promise.all([
    readFile(new URL("../tools/live-account-sync.mjs", import.meta.url), "utf8"),
    readFile(new URL("../assets/app.js", import.meta.url), "utf8"),
  ]);

  // Both places the sync stamps a horizon: the position row and the open-order row.
  assert.ok(!/Math\.max\(1, \(endTime - Date\.now\(\)\) \/ OPEN_ORDER_FALLBACK_HORIZON_MS\)/.test(sync),
    "the position horizon must not be floored at a day");
  assert.ok(!/daysToResolution: Math\.max\(1, Number\.isFinite\(remainingDays\)/.test(sync),
    "nor the open-order horizon");
  assert.match(sync, /\? \(endTime - Date\.now\(\)\) \/ OPEN_ORDER_FALLBACK_HORIZON_MS/);
  assert.match(sync, /daysToResolution: Number\.isFinite\(remainingDays\) \? remainingDays : null,/);
  // Nothing in the sync computes with it, so there is nothing there to move.
  assert.ok(!/365 \//.test(sync), "the account sync must not annualize");

  const horizon = 24 * 60 * 60 * 1000;
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
  const view = new Function("MIN_ANNUALIZATION_DAYS", `
    ${pick(app, "compactDays")}
    ${pick(app, "annualizationDays")}
    ${pick(app, "annualizeReturn")}
    return { compactDays, annualizeReturn };
  `)(1 / 24);
  const stored = (hoursPast) => -hoursPast / 24;

  // What the row reports now, against what it used to.
  assert.equal(view.compactDays(stored(2)), "-2.0 h");
  assert.equal(view.compactDays(stored(26)), "-1.1 d");
  assert.equal(view.compactDays(stored(96)), "-4.0 d");
  // A future horizon is untouched.
  assert.equal(view.compactDays(stored(-24)), "1.0 d");
  assert.equal(view.compactDays(stored(-1)), "1.0 h");

  // And the returns computed from it do not move: every annualization floors a
  // non-positive horizon itself, so the signed value and the old clamped one agree.
  for (const hoursPast of [2, 26, 96]) {
    const signed = stored(hoursPast);
    assert.equal(view.annualizeReturn(0.1, signed), view.annualizeReturn(0.1, Math.max(0, signed)),
      `p.a. must not move at ${hoursPast}h past the end date`);
  }
  assert.match(app, /return Math\.max\(MIN_ANNUALIZATION_DAYS, days\);/, "the floor stays where the maths is");
});

test("days left: an unparseable end date is unknown, not the most urgent row", async () => {
  const executor = await import("../tools/live-order-executor.mjs");

  // The sync now stores null where it used to store a floored 1, and `Number(null)` is 0.
  // Read straight, that would make a row whose end date could not be parsed the most
  // urgent thing on the book. It reads as unknown instead.
  assert.equal(executor.daysValue({ daysToResolution: null }), Infinity);
  assert.equal(executor.daysValue({ daysToResolution: undefined }), Infinity);
  assert.equal(executor.daysValue({}), Infinity);
  // A real horizon, including an overdue one, is still itself.
  assert.equal(executor.daysValue({ daysToResolution: 0.5 }), 0.5);
  assert.equal(executor.daysValue({ daysToResolution: -1.1 }), -1.1);

  // The comparator treats an unknown horizon as a tie rather than ordering against it --
  // its guard against Infinity - Infinity returns 0 whenever either side is unknown. That
  // is pre-existing and deliberately left alone; what matters here is that an unknown row
  // no longer claims to be the most urgent, which a stored 0 did.
  const shorter = executor.compareShorterHorizon;
  assert.equal(shorter({ daysToResolution: 0.5 }, { daysToResolution: null }), 0);
  assert.ok(shorter({ daysToResolution: -1.1 }, { daysToResolution: 0.5 }) < 0,
    "an overdue market really is the most urgent, and still sorts that way");
  assert.ok(shorter({ daysToResolution: 0.5 }, { daysToResolution: 3 }) < 0);
});

// Reported: a 5050 run turned three candidates into one order and left the other two
// sitting in the READY list. The digest says why -- both were "market no longer listed in
// Gamma by token id or slug; treated as closed" -- so they should have been closed out of
// the catalogue. 5050 revalidated them exactly as the live portfolio does, but published
// nothing about it: its emit carried no revalidationUpdates, and its workflow had no step
// to write them back. The verdicts died with the run and the two markets came round again
// on the next pass, and the one after that.
test("5050: what a pass learns about a candidate is published, not discarded", async () => {
  const { readFile } = await import("node:fs/promises");
  const executor = await readFile(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8");

  // The fixed-entry emit must carry the verdicts, built the same way the live one builds
  // them so the shared persist script can read either.
  const batch = executor.slice(executor.indexOf("async function runFixedEntryBatch"));
  const emit = batch.slice(0, batch.indexOf("\n}\n"));
  assert.match(emit, /revalidationUpdates: checked\n\s+\.map\(\(item\) => liveRevalidationUpdate\(item, new Date\(\)\.toISOString\(\)\)\)\n\s+\.filter\(\(item\) => item\.tokenId\),/,
    "the 5050 pass must publish what it revalidated");
  // Both emits build them identically; a divergence would make one portfolio's verdicts
  // unreadable to the shared script.
  assert.equal((executor.match(/revalidationUpdates: checked/g) || []).length, 2,
    "both live portfolios publish their verdicts");

  // A market this pass found gone is what the persist script keys its close-out off.
  const persist = await readFile(new URL("../tools/persist-live-revalidation.py", import.meta.url), "utf8");
  assert.match(persist, /updates = \[item for item in execution\.get\("revalidationUpdates", \[\]\) if item\.get\("tokenId"\)\]/);
  assert.match(persist, /if update\.get\("marketGone"\):/);

  // Each portfolio persists its own state file, not the other's. The path is a variable
  // now, because a created live portfolio supplies its own; what must not drift is the
  // default each workflow falls back to, and that the persist step reads that variable
  // rather than a path of its own.
  const pairs = [
    ["polymarket-live-limit-order-test", "data/live-execution-state.json"],
    ["trading-live-5050", "data/live-5050-execution-state.json"],
  ];
  for (const [file, statePath] of pairs) {
    const workflow = await readFile(new URL(`../../.github/workflows/${file}.yml`, import.meta.url), "utf8");
    assert.match(workflow, new RegExp(`LIVE_EXECUTION_STATE_PATH: ${statePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
      `${file} must default to its own execution state`);
    const step = workflow.slice(workflow.indexOf("market verification into evaluation state"));
    const body = step.slice(0, step.indexOf("persist-live-revalidation.py") + 40);
    // Either form is fine, and which one a workflow uses follows from whether it serves one
    // portfolio or several: 5050 is always 5050 and names its file outright, while the live
    // workflow now runs whichever live portfolio was dispatched and has to follow the path
    // that run is using. What must not happen is either of them writing the other's file.
    assert.match(
      body,
      new RegExp(`LIVE_EXECUTION_STATE_FILE(?::\\s+|=)"?trading/(?:\\$\\{LIVE_EXECUTION_STATE_PATH\\}|${statePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`),
      `${file} must persist into the state path this run is using`,
    );
  }

  // And it has to run before the upload, or it reads a state the run has not written.
  const fixed = await readFile(new URL("../../.github/workflows/trading-live-5050.yml", import.meta.url), "utf8");
  const order = ["Rest the fixed-entry bids", "Persist current 5050 market verification into evaluation state", "Upload 5050 state"]
    .map((name) => fixed.indexOf(`- name: ${name}`));
  assert.ok(order.every((index) => index > 0), "every step must be present");
  assert.deepEqual([...order].sort((a, b) => a - b), order, `steps are out of order: ${order}`);
});

// Asked for: "verify why 5050 execution does not run more often -- by its settings it
// should run after every scraping, and that is not happening". Three separate links in
// the chain were missing, so the tests below check each one on its own.

test("after a scrape: the dispatcher wakes the portfolio whose trigger says so", async () => {
  const { plannedDispatches } = await import("../tools/dispatch-after-scan.mjs");

  // The bug. 5050's trigger was saved, shown in the dashboard, and read by nothing:
  // the dispatcher looked at `paper` and `live` only, so the portfolio's sole trigger
  // was its own half-hourly cron however the setting was left.
  // Only 5050 is configured here, so only 5050 is woken: an absent live portfolio is not a
  // portfolio, and defaulting one into existence would dispatch a live run for an account
  // this config says nothing about.
  const planned = plannedDispatches({ live5050: { executionTrigger: "after_scrape" } });
  assert.deepEqual(planned.map((entry) => entry.workflow), ["trading-live-5050.yml"]);

  // A dispatch without live_confirm is a dry run: it would wake, decide, and rest
  // nothing, which reads exactly like the failure being fixed.
  assert.equal(planned[0].inputs.live_confirm, "true");
  // AUTO, because MANUAL means both "a person asked for this" in the run log and
  // "ignore the automation switch" in the executor. Neither is true of a scan.
  assert.equal(planned[0].inputs.live_run_source, "AUTO");

  // An after-scrape portfolio still wakes the same shared paper worker.
  assert.deepEqual(
    plannedDispatches({
      paper: { balanced: { executionTrigger: "after_scrape" } },
      live: { executionTrigger: "after_scrape" },
      live5050: { executionTrigger: "after_scrape" },
    }).map((entry) => entry.workflow),
    ["trading-paper-bot.yml", "polymarket-live-limit-order-test.yml", "trading-live-5050.yml"],
  );
  // A cron portfolio is woken by a completed scrape too -- paper and live alike. The
  // worker applies its own saved interval before it can execute, which makes this a
  // reliable delivery wake-up rather than an extra trade trigger.
  //
  // The live ones used to be excluded here, and that was the whole reason automatic live
  // execution stopped happening: a live portfolio set to "cron" had nothing but its own
  // schedule, and GitHub delivers almost none of this repository's schedules. Measured:
  // the live executor is configured for six runs an hour and delivered three in a day,
  // while every dispatch in the same window succeeded. The executor logs CADENCE_WAIT when
  // a review is not due, exactly as the paper worker does, so waking it is not trading.
  assert.deepEqual(plannedDispatches({
    paper: { balanced: { executionTrigger: "cron", executionCronMinutes: 60 } },
    live: { executionTrigger: "cron" },
    live5050: { executionTrigger: "cron" },
  }).map((entry) => entry.workflow),
  ["trading-paper-bot.yml", "polymarket-live-limit-order-test.yml", "trading-live-5050.yml"]);

  // And the same switches apply to a live portfolio as to a paper one.
  assert.deepEqual(plannedDispatches({ live: { executionTrigger: "cron", automationEnabled: false } }), [],
    "a live portfolio with automation off is not woken");
  assert.deepEqual(plannedDispatches({ live5050: { executionTrigger: "cron", archived: true } }), [],
    "an archived live portfolio is not woken");

  // A created live portfolio is woken through the same workflow, naming itself so the run
  // writes its own state rather than the shared account's.
  const created = plannedDispatches({ livePortfolios: { live70: { executionTrigger: "cron" } } });
  assert.deepEqual(created.map((entry) => entry.workflow), ["polymarket-live-limit-order-test.yml"]);
  assert.equal(created[0].inputs.live_portfolio_id, "live70");
  assert.equal(created[0].inputs.live_run_source, "AUTO");
  assert.deepEqual(plannedDispatches({
    paper: { paused: { executionTrigger: "cron", automationEnabled: false } },
  }), [], "a disabled cron portfolio does not wake the paper worker");
  assert.deepEqual(plannedDispatches({}), [], "an unreadable or empty config dispatches nothing");
});

test("after a scrape: a scheduled scan dispatches too, not only one someone pressed", async () => {
  const { readFile } = await import("node:fs/promises");
  const scan = await readFile(new URL("../../.github/workflows/trading-market-scan.yml", import.meta.url), "utf8");
  const step = scan.slice(scan.indexOf("- name: Dispatch post-scrape execution"));
  const condition = step.slice(0, step.indexOf("\n        env:"));

  // The scan runs every five minutes on the schedule and only rarely by hand, so
  // gating this on workflow_dispatch made "after each scraping" mean "almost never".
  assert.doesNotMatch(condition, /event_name/,
    "the dispatch must not be restricted to manual scans; scheduled scraping is still scraping");
  assert.match(condition, /if: success\(\)/, "but a failed scan must not wake an executor");

  // What makes the five-minute rate safe on the single self-hosted runner: a third
  // dispatch replaces the queued one instead of stacking behind it.
  for (const file of ["polymarket-live-limit-order-test", "trading-live-5050"]) {
    const workflow = await readFile(new URL(`../../.github/workflows/${file}.yml`, import.meta.url), "utf8");
    assert.match(workflow, /concurrency:\n  group: [^\n]+\n  cancel-in-progress: false/,
      `${file} must serialize its own runs`);
  }
  assert.match(scan, /runs-on: ubuntu-latest/, "and the scan itself must not compete for that runner");
});

test("after a scrape: the 5050 run knows it was automatic, and its cron stands down", async () => {
  const { readFile } = await import("node:fs/promises");
  const workflow = await readFile(new URL("../../.github/workflows/trading-live-5050.yml", import.meta.url), "utf8");

  // Without the input the dispatcher's AUTO is dropped and every dispatch reads as
  // MANUAL -- flagged as a person's run in the log, and exempt from the automation
  // switch. The default stays MANUAL so the dashboard button keeps behaving as it did.
  assert.match(workflow, /live_run_source:\n\s+description: [^\n]+\n\s+required: false\n\s+default: "MANUAL"/);
  assert.match(
    workflow,
    /LIVE_RUN_SOURCE: \$\{\{ github\.event_name == 'workflow_dispatch' && \(inputs\.live_run_source \|\| 'MANUAL'\) \|\| 'AUTO' \}\}/,
  );

  // With the scan dispatching it, the workflow's own cron would run it a second time.
  const loader = workflow.slice(workflow.indexOf("- name: Load 5050 portfolio config"));
  assert.match(loader, /if cfg\.get\("executionTrigger"\) == "after_scrape" and os\.environ\.get\("GITHUB_EVENT_NAME"\) == "schedule":\n\s+overrides\["LIVE_SKIP_SCHEDULED_EXECUTION"\] = "true"/);
  assert.match(workflow, /LIVE_SKIP_SCHEDULED_EXECUTION: "false"/, "and it defaults to running");

  // The executor is what acts on both, so the names have to line up with what it reads.
  const executorSource = readFileSync(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8");
  assert.match(executorSource, /const SKIP_SCHEDULED_EXECUTION = String\(process\.env\.LIVE_SKIP_SCHEDULED_EXECUTION/);
  assert.match(executorSource, /const IS_MANUAL_RUN = String\(process\.env\.LIVE_RUN_SOURCE \|\| ""\)\.toUpperCase\(\) === "MANUAL"/);
});

test("after a scrape: an automatic 5050 run still obeys the automation switch", async () => {
  const { readFile } = await import("node:fs/promises");
  const workflow = await readFile(new URL("../../.github/workflows/trading-live-5050.yml", import.meta.url), "utf8");
  const loader = workflow.slice(workflow.indexOf("- name: Load 5050 portfolio config"));

  // This used to be written only when the event was a schedule. Once the scan started
  // dispatching, that would have let a portfolio with automation off trade every five
  // minutes -- the switch would have looked broken instead. The saved value is written
  // whatever the event, and the executor makes the manual exception itself.
  assert.match(loader, /"LIVE_AUTOMATION_ENABLED": str\(bool\(cfg\.get\("automationEnabled", True\)\)\)\.lower\(\)/);
  assert.doesNotMatch(loader, /automationEnabled"\) is False and os\.environ\.get\("GITHUB_EVENT_NAME"\) == "schedule"/);
  assert.match(loader, /"LIVE_EXECUTION_TRIGGER": cfg\.get\("executionTrigger"\)/,
    "and the run log has to record what started the run");

  const executorSource = readFileSync(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8");
  assert.match(executorSource, /if \(!IS_MANUAL_RUN && !AUTOMATION_ENABLED\)/);
  assert.match(executorSource, /const AUTOMATION_ENABLED = String\(process\.env\.LIVE_AUTOMATION_ENABLED \?\? "true"\)\.toLowerCase\(\) !== "false"/,
    "an unwritten switch must mean on, or a config read failure would stop the portfolio");
});

test("after a scrape: the cron interval does not also throttle an after-scrape run", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8");

  // The cadence setting is the gap between cron runs -- the dashboard shows it only in
  // cron mode. Left over from an earlier setting it would have gated the after-scrape
  // dispatches too, and the portfolio would again have looked like it ignored its
  // trigger: woken by every scrape, and declining to look at all but one of them.
  const start = source.indexOf('const EXECUTION_TRIGGER = ');
  const end = source.indexOf('const IS_MANUAL_RUN = ');
  assert.ok(start > 0 && end > start, "the trigger and cadence constants must stay identifiable");
  const build = (env) => {
    const read = new Function("process", "envNumber", `${source.slice(start, end)}
      return { EXECUTION_TRIGGER, EXECUTION_CRON_MINUTES };`);
    return read({ env }, (name, fallback) => Number(env[name] ?? fallback));
  };

  assert.deepEqual(build({ LIVE_EXECUTION_TRIGGER: "after_scrape", LIVE_EXECUTION_CRON_MINUTES: "30" }),
    { EXECUTION_TRIGGER: "after_scrape", EXECUTION_CRON_MINUTES: 0 });
  // A portfolio on cron keeps its interval exactly as before.
  assert.deepEqual(build({ LIVE_EXECUTION_TRIGGER: "cron", LIVE_EXECUTION_CRON_MINUTES: "30" }),
    { EXECUTION_TRIGGER: "cron", EXECUTION_CRON_MINUTES: 30 });
  // An unset interval used to mean "every run". It now means hourly: a cron portfolio has
  // a cadence of its own, independent of how often the workflow happens to be scheduled.
  assert.deepEqual(build({}), { EXECUTION_TRIGGER: "cron", EXECUTION_CRON_MINUTES: 60 },
    "an unset trigger is cron, and an unset interval is hourly");
  // The floor exists so a stale or hand-set value cannot ask for a cadence the dashboard
  // does not offer. It has to agree with the shortest option there, or the saved setting
  // and the honoured one diverge without saying so -- which is what "it does not run as
  // often as I set it" looks like from the outside.
  assert.deepEqual(build({ LIVE_EXECUTION_CRON_MINUTES: "5" }),
    { EXECUTION_TRIGGER: "cron", EXECUTION_CRON_MINUTES: 30 });
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const options = [...html.matchAll(/<option value="(\d+)">[^<]*<\/option>/g)]
    .map((match) => Number(match[1]));
  const shortestOffered = Math.min(...options.filter((value) => value >= 30 && value <= 1440));
  assert.equal(shortestOffered, 30, "the shortest cadence the dashboard offers is the floor the executor applies");

  // Zero is what switches the gate off, so the value above has to reach it that way.
  assert.match(source, /&& EXECUTION_CRON_MINUTES > 0\n/);
  // And the run log reports the same trigger the gate was decided on, not its own copy.
  assert.match(source, /executionTrigger: EXECUTION_TRIGGER,/);
});

// Asked for: a record of an execution that is running should appear in the run log while
// it runs, and update when the run completes -- during it if possible.

// Builds the in-flight row machinery against a stubbed dashboard state, so the real
// functions decide rather than a restatement of them.
function runningRowHarness({
  target = "live-5050",
  run = null,
  now = Date.parse("2026-08-09T12:00:30Z"),
  // The synthetic row exists only for a run this browser dispatched, so that is the default
  // here. Pass false for the other case, which must produce no row at all.
  dispatchedHere = true,
} = {}) {
  const app = readFileSync(new URL("../assets/app.js", import.meta.url), "utf8");
  const body = ["runningExecutionRun", "runningExecutionRow", "formatDuration", "newestRunAt",
    // A paper target never gets a synthetic row -- every paper portfolio shares one
    // workflow, so its status cannot say which portfolio a run belongs to.
    "isPaperExecutionTarget",
    "runningRowIsSuperseded", "withRunningExecutionRow"]
    .map((name) => functionSource(app, name)).join("\n\n");
  const state = { runningExecutions: { [target]: run }, runningExecutionWatermark: null };
  const build = new Function("state", "currentExecutionTarget", "Date", "executionRunWasDispatchedHere", `
    ${body}
    return { withRunningExecutionRow, runningExecutionRow };
  `);
  const clock = { ...Date, now: () => now, parse: Date.parse };
  const api = build(state, () => target, clock, () => dispatchedHere);
  return { ...api, state };
}

const IN_PROGRESS_RUN = {
  id: 42,
  status: "in_progress",
  event: "schedule",
  createdAt: "2026-08-09T12:00:00Z",
  htmlUrl: "https://github.com/owner/repo/actions/runs/42",
  progress: { job: "live-5050", step: "Rest the fixed-entry bids", stepNumber: 7, stepCount: 11 },
};

test("running execution: a run in flight is a row before it has published anything", () => {
  const { withRunningExecutionRow } = runningRowHarness({ run: IN_PROGRESS_RUN });
  const rows = withRunningExecutionRow([{ id: "older", action: "SKIP", runAt: "2026-08-09T11:30:00Z" }]);

  assert.equal(rows.length, 2);
  const [live] = rows;
  assert.equal(live.action, "RUNNING");
  assert.equal(live.runAt, "2026-08-09T12:00:00Z", "dated from when GitHub created the run");
  assert.equal(live.runningExecution, true, "flagged, so the renderer does not offer a decision detail");
  assert.equal(live.htmlUrl, IN_PROGRESS_RUN.htmlUrl);
  // "MANUAL" is the only source this row can carry, and that is now true by construction:
  // it is produced only for a run this browser dispatched, so a person did ask.
  assert.equal(live.runSource, "MANUAL");

  // The point of the row is that it says something a spinner would not: where the run has
  // got to, and for how long it has been there.
  assert.equal(live.humanReason,
    "Execution in progress: Rest the fixed-entry bids (step 7 of 11) · 30s elapsed.");

  // A queued run is honest about being queued -- on the shared self-hosted runner that is
  // itself the answer to why nothing has happened yet.
  const queued = runningRowHarness({
    run: { ...IN_PROGRESS_RUN, status: "queued", event: "workflow_dispatch", progress: null },
  });
  const [pending] = queued.withRunningExecutionRow([]);
  assert.equal(pending.action, "QUEUED");
  assert.equal(pending.runSource, "MANUAL");
  assert.match(pending.humanReason, /^Execution in progress: waiting for a runner/);

  const foreign = runningRowHarness({ run: IN_PROGRESS_RUN, dispatchedHere: false });
  assert.deepEqual(
    foreign.withRunningExecutionRow([{ id: "older" }]),
    [{ id: "older" }],
    "a run this browser did not dispatch is not a speculative row",
  );

  // Nothing running, nothing added.
  const idle = runningRowHarness({ run: null });
  assert.deepEqual(idle.withRunningExecutionRow([{ id: "older" }]), [{ id: "older" }]);

  // And a run this dashboard did not start adds nothing either. The label used to be
  // "UNKNOWN" for this case; not inventing the row at all is the stronger version of the
  // same rule, because such a run publishes its own entry with its real source and this one
  // could only ever guess -- including guessing the wrong portfolio, since a shared workflow
  // status cannot say which portfolio it belongs to.
  const elsewhere = runningRowHarness({ run: IN_PROGRESS_RUN, dispatchedHere: false });
  assert.deepEqual(elsewhere.withRunningExecutionRow([{ id: "older" }]), [{ id: "older" }],
    "a run started somewhere else is logged by its own worker, never guessed at here");
  assert.equal(elsewhere.runningExecutionRow(), null);

  // A paper target never gets one whatever else is true: all paper portfolios share one
  // workflow, so its status cannot say which of them is running.
  const paper = runningRowHarness({ target: "paper-conservative", run: IN_PROGRESS_RUN });
  assert.equal(paper.runningExecutionRow(), null);
});

test("running execution: the row gives way to the run's own entry, and not before", () => {
  const existing = [{ id: "previous", action: "SKIP", runAt: "2026-08-09T11:30:00Z" }];
  const harness = runningRowHarness({ run: IN_PROGRESS_RUN });

  // First render sets the watermark from what the log already carried.
  assert.equal(harness.withRunningExecutionRow(existing).length, 2, "the row appears");
  assert.equal(harness.withRunningExecutionRow(existing).length, 2, "and stays while nothing new lands");

  // The trap this is built to avoid: a *previous* run can stamp its decision after this
  // run was created -- it is queued the moment it is dispatched but waits for the shared
  // runner -- so comparing against the run's own start time would hide the live row
  // before it had done anything.
  const laggingPrevious = [{ id: "previous", action: "SKIP", runAt: "2026-08-09T12:00:20Z" }];
  const lagging = runningRowHarness({ run: IN_PROGRESS_RUN });
  assert.equal(lagging.withRunningExecutionRow(laggingPrevious).length, 2,
    "a row stamped after the run was created is not evidence the run published it");

  // What does supersede it: an entry newer than anything the log held when it appeared.
  const published = [{ id: "this-run", action: "SUBMITTED", runAt: "2026-08-09T12:01:00Z" }, ...existing];
  assert.deepEqual(harness.withRunningExecutionRow(published), published,
    "once the run has published, its own row is the record and the placeholder goes");
});

test("running execution: status is read from GitHub, and only for a run still going", async () => {
  const { readFile } = await import("node:fs/promises");
  const [app, api] = await Promise.all([
    readFile(new URL("../assets/app.js", import.meta.url), "utf8"),
    readFile(new URL("../api.php", import.meta.url), "utf8"),
  ]);

  // Read rather than published by the run at its start: a run that dies, is cancelled or
  // never gets a runner would leave a RUNNING row on the hosting with nothing to clear it.
  const poll = functionSource(app, "pollRunningExecution");
  const shouldPoll = functionSource(app, "shouldPollRunningExecution");
  assert.match(poll, /if \(!shouldPollRunningExecution\(target\)\) return;/,
    "an idle dashboard must not hit the GitHub workflow-status endpoint");
  assert.match(poll, /run\.status === "queued" \|\| run\.status === "in_progress"/);
  assert.ok(!/event=all/.test(poll),
    "the live watcher follows manual dispatches only; scheduled runs publish their own logs");
  assert.match(poll, /&& executionRunWasDispatchedHere\(target, run\)/,
    "a scheduled or tool-dispatched run must not be adopted by the browser's synthetic row");
  assert.match(shouldPoll, /if \(!target \|\| isPaperExecutionTarget\(target\)\) return false;/,
    "paper workflows share one GitHub file, so they are never watched speculatively");
  assert.match(shouldPoll, /Date\.now\(\) - dispatchedAt <= DISPATCHED_EXECUTION_TTL_MS/);
  // A failed status read must not flicker the row away.
  assert.match(poll, /\} catch \{\r?\n(?:\s*\/\/[^\n]*\r?\n)*\s+return;\r?\n\s+\}/);
  // And when the run ends, the state is re-read once so the real row can take over.
  assert.match(poll, /if \(finished\) await loadDashboardState\(\{ skipAutoLiveSync: true \}\);/);

  // 5050 had no entry in the workflow map, so every status read for it answered 400.
  assert.match(api, /'live-5050' => 'trading-live-5050\.yml',/);
  // The default stays dispatch-only: the watcher that waits on a button press must not
  // adopt a cron run that started meanwhile.
  assert.match(api, /\$eventFilter = strtolower\(trim\(\(string\) \(\$_GET\['event'\] \?\? 'workflow_dispatch'\)\)\);/);
  assert.match(api, /if \(\$eventFilter !== '' && \$eventFilter !== 'all'\) \{\r?\n\s+\$query\['event'\] = \$eventFilter;/);
  assert.match(api, /'statusError' => \$e->getMessage\(\),/,
    "a temporary GitHub failure must not surface as a browser resource 500");

  // The progress read is what lets the row say more than "in progress", and it is skipped
  // for a completed run -- so an idle dashboard pays for no extra GitHub request.
  assert.match(api, /if \(\$runId <= 0 \|\| \$status === 'completed'\) \{\r?\n\s+return null;/);
  assert.match(api, /\$runs\[0\]\['progress'\] = workflow_progress_detail\(\$raw, \$config\);/);
});

test("running execution: the live row is not a decision to open", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");
  const render = functionSource(app, "renderRunLog");

  // A run still going has no decision behind it, so it must not be a detail button that
  // opens an empty panel. It links to its GitHub run, where there is more to see.
  assert.match(render, /if \(run\.runningExecution\) \{/);
  assert.match(render, /class="trade-batch portfolio-run-row portfolio-run-live" href=/);
  // The remaining rows keep their index into the same array the click handler reads, so
  // adding a row at the top must not shift what a click opens.
  assert.match(render, /data-portfolio-run="\$\{index\}"/);
  assert.match(app, /state\.displayedRunLog = runs;/);

  // Both paper and live logs carry it: the request was about the run log, not one tab.
  const currentLog = functionSource(app, "currentPortfolioRunLog");
  assert.equal((currentLog.match(/withRunningExecutionRow\(/g) || []).length, 2);
});

// Reported: the live portfolio has no candidates at all, which looks like a bug. It was.
// Both live portfolios persist their revalidation verdicts onto the same evaluation rows,
// and the dashboard read whichever was there without asking whose it was -- so a market
// 5050 could not execute vanished from the main live portfolio's shortlist as well.
//
// 5050 never noticed, because its branch of the filter returns before the verdict rule is
// reached; and since it began running after every scrape it swept the whole pool every few
// minutes, so the contamination was one-way and total.

function verdictHarness() {
  const app = readFileSync(new URL("../assets/app.js", import.meta.url), "utf8");
  // A verdict is owned by the portfolio that made it, and a created live portfolio owns its
  // own -- so the ownership test has to be able to name one from a mode.
  const body = ["customLivePortfolioIdFromMode", "executionVerdictIsOwn", "latestLiveExecutionVerdict"]
    .map((name) => functionSource(app, name)).join("\n\n");
  return (mode, item, ownUpdates = []) => new Function("state", "isFixedEntryMode", "liveExecutionVerdictByToken", "CUSTOM_PAPER_STRATEGY_ID", `
    ${body}
    return latestLiveExecutionVerdict;
  `)(
    { mode },
    (value) => value === "live-5050",
    () => new Map(ownUpdates.map((update) => [String(update.tokenId), update])),
    /^[a-z][a-zA-Z0-9]{1,30}$/,
  )(item, mode);
}

test("live candidates: one portfolio's rejection is not the other's", () => {
  const verdictFor = verdictHarness();
  const token = "1000000000000000001";
  // A real 5050 verdict, as persisted onto the shared evaluation row.
  const fromFixedEntry = {
    tokenId: token,
    portfolio: "live-5050",
    status: "REJECTED",
    retryable: false,
    checkedAt: "2026-08-09T12:00:00Z",
    rejectReasons: ["post-only limit would cross current ask"],
  };
  const row = { tokenId: token, executionRevalidation: fromFixedEntry };

  // The bug: the main live portfolio adopted it and dropped the row for good.
  assert.equal(verdictFor("live", row), null,
    "the live portfolio must not inherit what 5050 could not execute");
  // 5050 still honours its own.
  assert.deepEqual(verdictFor("live-5050", row), fromFixedEntry);

  // And the mirror case, so the fix is not one-directional.
  const fromLive = { ...fromFixedEntry, portfolio: "live", rejectReasons: ["no valid current entry price"] };
  assert.deepEqual(verdictFor("live", { tokenId: token, executionRevalidation: fromLive }), fromLive);
  assert.equal(verdictFor("live-5050", { tokenId: token, executionRevalidation: fromLive }), null);

  // A verdict stored before the field existed is ignored rather than guessed at: keeping
  // it costs a possibly foreign rejection forever, dropping it costs one run.
  const unstamped = { ...fromFixedEntry };
  delete unstamped.portfolio;
  assert.equal(verdictFor("live", { tokenId: token, executionRevalidation: unstamped }), null);

  // The portfolio's own execution state is loaded per mode, so it needs no stamp to be
  // its own -- and it is what lets a portfolio recover its verdicts on its very next run.
  const own = { tokenId: token, status: "REJECTED", retryable: false, checkedAt: "2026-08-09T12:30:00Z" };
  assert.deepEqual(verdictFor("live", { tokenId: token }, [own]), own);
});

test("live candidates: the verdict says which portfolio made it", async () => {
  const { readFile } = await import("node:fs/promises");
  const [executor, persist] = await Promise.all([
    readFile(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8"),
    readFile(new URL("../tools/persist-live-revalidation.py", import.meta.url), "utf8"),
  ]);

  // Stamped where the verdict is built, so both live workflows carry it without either
  // needing to know it is sharing rows with the other.
  // The owner is the portfolio the run belongs to, and a created live portfolio is passed
  // its own id -- the two shipped ones remain the fallback. Stamping it from the strategy
  // flag alone would file every created portfolio's verdicts under "live".
  assert.match(executor, /const LIVE_PORTFOLIO_ID = process\.env\.LIVE_PORTFOLIO_ID \|\| \(FIXED_ENTRY_STRATEGY \? "live-5050" : "live"\);/);
  assert.match(executor, /portfolio: LIVE_PORTFOLIO_ID,/);
  // The persist step copies the verdict wholesale, so the stamp reaches the stored row.
  assert.match(persist, /item\["executionRevalidation"\] = update/);

  // Why only the live portfolio emptied out: 5050's branch returns before the rule that
  // acts on a verdict, so it never saw the contamination it was causing.
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");
  const reasons = functionSource(app, "portfolioCandidateFilterReasons");
  const fixedEntryReturn = reasons.indexOf("    return reasons;\n  }");
  const verdictRule = reasons.indexOf("if (executionCheckIsCurrent");
  assert.ok(fixedEntryReturn > 0 && verdictRule > fixedEntryReturn,
    "the 5050 branch still returns before the verdict rule; only live reaches it");
});

// Reported: 5050 had a couple of positions, they are not in its closed trades, and its
// dashboard shows no data. Measured against production: its execution state is not
// published (404), so attribution had only the currently configured entry price to go on
// -- and that price had been changed from 0.50 to 0.65. Every order and fill made at 0.50
// stopped being recognised as 5050's. Its tab then showed no positions, no closed trades
// and zero P/L, while a bid plainly resting at 0.50 sat on the live portfolio's tab.

test("5050 attribution: a changed entry price does not orphan what was traded at the old one", () => {
  const app = readFileSync(new URL("../assets/app.js", import.meta.url), "utf8");
  const build = (config, execution = {}) => new Function("state", "portfolioConfigForMode", `
    ${/const FIXED_ENTRY_PRICE_TOLERANCE = [\d.]+;/.exec(app)[0]}
    ${functionSource(app, "normalizeFixedEntryPrice")}
    ${functionSource(app, "fixedEntryPriceSignatures")}
    ${functionSource(app, "matchesFixedEntryPrice")}
    return { fixedEntryPriceSignatures, matchesFixedEntryPrice };
  `)({ live5050ExecutionState: execution }, () => config);

  // Production's exact state: price moved to 0.65, nothing in the run log to fall back on.
  const moved = build({ fixedEntryPrice: 0.65, fixedEntryPriceHistory: [0.65, 0.5] });
  assert.deepEqual([...moved.fixedEntryPriceSignatures()].sort(), [0.5, 0.65]);
  assert.equal(moved.matchesFixedEntryPrice(0.5), true, "a bid rested at the old price is still 5050's");
  assert.equal(moved.matchesFixedEntryPrice(0.65), true, "and so is one at the current price");
  // Live buys at the market against a high probability bar, so its fills stay its own.
  assert.equal(moved.matchesFixedEntryPrice(0.95), false);
  assert.equal(moved.matchesFixedEntryPrice(0.78), false);

  // Without the history -- what production had -- the 0.50 rows are orphaned. This is the
  // bug, kept as a fixture so the fix cannot quietly regress to it.
  const before = build({ fixedEntryPrice: 0.65 });
  assert.equal(before.matchesFixedEntryPrice(0.5), false);

  // The run log stays the finer record where it exists, and adds to the history.
  const withLog = build(
    { fixedEntryPrice: 0.65, fixedEntryPriceHistory: [0.65] },
    { runLog: [{ attempts: [{ action: "SUBMITTED", orderPrice: 0.42 }] }] },
  );
  assert.equal(withLog.matchesFixedEntryPrice(0.42), true);
});

test("5050 attribution: the price history is kept by the server, not the browser", async () => {
  const { readFile } = await import("node:fs/promises");
  const api = await readFile(new URL("../api.php", import.meta.url), "utf8");

  // Carried across on save from the stored config. A save replaces the whole config with
  // whatever the dashboard holds, so a tab opened before this field existed would POST
  // without it and drop the record of every price 5050 had traded at.
  assert.match(api, /\$stored = load_portfolio_config\(\);/);
  assert.match(api, /\$config\['live5050'\]\['fixedEntryPriceHistory'\] = array_merge\(/);
  assert.match(api, /\[\$stored\['live5050'\]\['fixedEntryPrice'\] \?\? null\],/,
    "the price being replaced is what most needs remembering");

  // Normalized like a price, not like free text: a limit order cannot rest at 0 or 1.
  assert.match(api, /function normalize_fixed_entry_price_history\(mixed \$value, float \$current\): array/);
  assert.match(api, /if \(\$price <= 0 \|\| \$price >= 1\) \{/);
  assert.match(api, /if \(count\(\$prices\) >= 12\) \{/, "bounded, or it grows with every tweak");

  // And it is a saved portfolio setting, so a fresh install recognises its own fills too.
  assert.match(api, /'fixedEntryPriceHistory' => \[0\.50\],/);
});

// Measured against production: its stored config already carried the history field,
// holding [0.65] alone -- the history began being recorded only after the price had been
// changed away from 0.50 -- so a default that applies merely when the field is absent
// would never have fired, and the 0.50 rows would have stayed on the live portfolio's
// tab exactly as reported. The shipped price has to be merged in, not defaulted to.
test("5050 attribution: a config saved before the history existed still recovers 0.50", () => {
  const api = readFileSync(new URL("../api.php", import.meta.url), "utf8");
  const normalizer = /function normalize_fixed_entry_price_history\(mixed \$value, float \$current\): array\n\{\n[\s\S]*?\n\}/.exec(api);
  assert.ok(normalizer, "normalize_fixed_entry_price_history is defined in api.php");
  const assignment = /\$config\['live5050'\]\['fixedEntryPriceHistory'\] = normalize_fixed_entry_price_history\([\s\S]*?\n    \);/.exec(api);
  assert.ok(assignment, "the assignment that fills the history is defined in api.php");

  // Both blocks below are the file's own source, so this fails if either changes shape.
  const run = (storedInput) => JSON.parse(execFileSync("php", ["-r", `
${normalizer[0]}
$defaults = ['live5050' => ['fixedEntryPriceHistory' => [0.50]]];
$fixedInput = ${storedInput};
$config = ['live5050' => ['fixedEntryPrice' => 0.65]];
${assignment[0]}
echo json_encode($config['live5050']['fixedEntryPriceHistory']);
`], { encoding: "utf8" }));

  // Production's stored config, exactly: the field is there and holds only 0.65. This is
  // the case a fallback-when-absent could not reach, and the reported bid resting at 0.50
  // is on this config.
  assert.deepEqual(run("['fixedEntryPriceHistory' => [0.65]]"), [0.65, 0.5],
    "the shipped 0.50 is merged in, which is what makes the bid resting at 0.50 5050's");
  // A config written before the field existed at all reaches it too.
  assert.deepEqual(run("[]"), [0.65, 0.5]);
  // And nothing already recorded is lost to the merge.
  assert.deepEqual(run("['fixedEntryPriceHistory' => [0.42]]"), [0.65, 0.5, 0.42]);
});

// Reported: the live portfolio's closed trades hold rows reading 50-51%, and one open
// order reads 50%. Measured against production: those are entry prices, not probabilities
// -- no row on the account carries an AI probability at all -- and all three are 5050's,
// resting or filled at the 0.50 it used before the setting moved to 0.65.
//
// Every price below is the real figure from the account, so this fixes the boundary the
// live portfolio's own fills actually sit at rather than an invented one.
const PRODUCTION_FIXED_ENTRY_ROWS = [0.5, 0.51];
const PRODUCTION_LIVE_ENTRY_PRICES = [0.75, 0.78, 0.78, 0.81, 0.82, 0.91, 0.945, 0.95, 0.95, 0.961, 0.975, 0.978];

test("5050 attribution: an averaged fill price a cent off the bid is still 5050's", () => {
  const app = readFileSync(new URL("../assets/app.js", import.meta.url), "utf8");
  const build = (config) => new Function("state", "portfolioConfigForMode", `
    ${/const FIXED_ENTRY_PRICE_TOLERANCE = [\d.]+;/.exec(app)[0]}
    ${functionSource(app, "normalizeFixedEntryPrice")}
    ${functionSource(app, "fixedEntryPriceSignatures")}
    ${functionSource(app, "matchesFixedEntryPrice")}
    return matchesFixedEntryPrice;
  `)({ live5050ExecutionState: {} }, () => config);

  const matches = build({ fixedEntryPrice: 0.65, fixedEntryPriceHistory: [0.65, 0.5] });

  // A resting maker bid fills at its own price, but the stored figure is the cost-weighted
  // average of every fill, so partials either side of a settings change average between
  // them. 0.5100 against a 0.50 bid is the real case a half-cent window missed.
  for (const price of PRODUCTION_FIXED_ENTRY_ROWS) {
    assert.equal(matches(price), true, `${price} was 5050's and must be recognised`);
  }

  // And the widened window must not start claiming the live portfolio's fills. It buys at
  // the market against a probability bar in the nineties; these are its real entry prices.
  for (const price of PRODUCTION_LIVE_ENTRY_PRICES) {
    assert.equal(matches(price), false, `${price} is a live market buy, not a 5050 bid`);
  }

  // The gap that makes this safe, stated as a rule rather than left to the fixtures: the
  // window has to stay well inside the distance between the two portfolios' price bands.
  const tolerance = build({ fixedEntryPrice: 0.65 });
  assert.equal(tolerance(0.66), true);
  assert.equal(tolerance(0.70), false, "still far short of the lowest live entry price");
  assert.ok(Math.min(...PRODUCTION_LIVE_ENTRY_PRICES) - 0.65 > 0.02 * 2,
    "the live band must stay more than two windows clear of 5050's highest price");
});

test("closed trades: the retired AI probability column is gone, not merely hidden", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  // The scoring pipeline is retired -- every portfolio scores on the Polymarket
  // probability whatever an older config stored -- so the column could only ever show a
  // figure from a system no longer running. It was suppressed on the open tables and left
  // on the closed ones, which is where it was still being read as current.
  assert.match(app, /function normalizeProbabilitySource\(\) \{\n\s+return "polymarket";/);
  assert.ok(!/AI prob\./.test(app), "no AI probability column anywhere in the tables");
  assert.ok(!/showAiProbability/.test(app), "and no switch left to bring it back");

  // Production carries no AI probability on any row -- positions, orders or closed trades
  // -- so nothing of substance is lost with the column.
  assert.ok(!/sortableHeader\("aiProbability"/.test(app));
});

test("portfolio parameters: both live portfolios state their order price", () => {
  // Reported: the order price parameter is not shown in the portfolio parameters
  // overview. On 5050 it always was -- verified by running the real row builder -- but
  // the live portfolio's card simply had no such row, because its price is not a setting.
  // An absent row is indistinguishable from one that failed to render, so it now says
  // where the price comes from instead of saying nothing.
  const app = readFileSync(new URL("../assets/app.js", import.meta.url), "utf8");
  const rowsFor = (fixedEntry, limitOrders) => new Function(
    "state", "isFixedEntryMode", "portfolioConfigForMode", "resolutionDaysForMode",
    "normalizeOptionalMoney", "normalizeMinimumNetYield", "normalizeMarketTagList",
    "portfolioReturnMetricLabel", "probabilitySourceLabel", "currentEligibilityThreshold",
    "stakeSizingRuleValue", "normalizeExecutionTrigger", "executionTriggerLabel",
    "executionCronMinutesLabel", "normalizeFixedEntryPrice", "percent", "money",
    "currentLimitOrders", "systemConfig",
    // The row builder gained a market-type row, so its two helpers come across as the
    // real thing rather than as stubs -- they are pure, and a stub here would only prove
    // the harness agrees with itself.
    `${functionSource(app, "normalizePortfolioMarketType")}\n${functionSource(app, "portfolioMarketTypeLabel")}\n`
    + `${functionSource(app, "automaticRotationIsEnabled")}\n`
    // The probability row states a range now that a portfolio can carry a maximum as well
    // as a minimum, so its three pure helpers come across for the same reason as above.
    // The rule rows now ask whether the open mode is a live portfolio, which a created one
    // also is, so the classification cluster comes across too.
    + `${/const LIVE_MODES = new Set\(\[[^\]]*\]\);/.exec(app)[0]}\n`
    + `${/const CUSTOM_PAPER_STRATEGY_ID = [^\n]+/.exec(app)[0]}\n`
    + `${functionSource(app, "normalizeMode")}\n`
    + `${functionSource(app, "customLivePortfolioIdFromMode")}\n`
    + `${functionSource(app, "isLivePortfolioMode")}\n`
    + `${functionSource(app, "isLiveMode")}\n`
    + `${functionSource(app, "normalizeEligibilityThreshold")}\n`
    + `${functionSource(app, "normalizeOptionalProbability")}\n`
    + `${functionSource(app, "probabilityRangeRuleValue")}\n`
    // The rows now state the portfolio's initial capital, so its two pure helpers come
    // across as the real thing for the same reason as the ones above.
    + `${functionSource(app, "normalizeInitialCapital")}\n`
    + `${functionSource(app, "liveInitialCapitalForMode")}\n`
    // And the stop-loss row, whose label reads the risk multiplier. Pure again, so the
    // real pair comes across rather than a stub agreeing with the harness.
    + `${functionSource(app, "normalizeStopLossRiskMultiplier")}\n`
    + `${functionSource(app, "stopLossRiskMultiplier")}\n`
    + `${functionSource(app, "stopLossRiskLabel")}\n`
    + `${functionSource(app, "livePortfolioRuleRows")}\nreturn livePortfolioRuleRows;`,
  )(
    { liveState: { portfolio: {} } },
    () => fixedEntry,
    // The order mode is read off the open tab's saved config rather than the checkbox, so
    // it belongs on the config the row builder is handed.
    () => ({
      fixedEntryPrice: 0.65,
      allowedMarketTags: ["sports"],
      excludedMarketTags: [],
      useLimitOrders: limitOrders,
    }),
    () => 30, (value) => value, (value) => value || 0, (value) => (Array.isArray(value) ? value : []),
    () => "Potential p.a.", () => "Polymarket probability", () => 0.93, () => "stake",
    (value) => value, () => "After each scraping batch", () => "x", (value) => Number(value),
    (value) => `${(value * 100).toFixed(1)}%`, (value) => `$${value}`, () => limitOrders, () => ({}),
  )();
  const orderPrice = (fixedEntry, limitOrders) => (rowsFor(fixedEntry, limitOrders)
    .find(([label]) => label === "Order price") || [])[1];

  assert.equal(orderPrice(true, true), "every qualifying candidate is bid at 65.0%");
  // The live portfolio prices off the book, and which side depends on the order mode.
  assert.match(orderPrice(false, true), /^taken from the book: rested at the best bid/);
  assert.match(orderPrice(false, false), /^taken from the book: bought at the market ask/);

  // The tag filter stays 5050's alone -- only the order price row became universal.
  assert.ok(rowsFor(true, true).some(([label]) => label === "Tag filter"));
  assert.ok(!rowsFor(false, true).some(([label]) => label === "Tag filter"));
});

test("portfolio switch: the open portfolio is unmistakable", async () => {
  // Reported after a run was judged against the wrong portfolio: one order from twenty
  // ready candidates looks like a bug on 5050, which bids on everything that qualifies,
  // and is correct on Live, which buys the single best candidate. The tab was Live; the
  // UI did not make that obvious enough to notice.
  const { readFile } = await import("node:fs/promises");
  const [app, css] = await Promise.all([
    readFile(new URL("../assets/app.js", import.meta.url), "utf8"),
    readFile(new URL("../assets/app.css", import.meta.url), "utf8"),
  ]);

  // Hover and active used to be one rule, so the open portfolio looked exactly like
  // whichever tab the pointer was over -- two reading as selected, neither emphatically.
  assert.doesNotMatch(css, /\.mode-button:hover,\n\.mode-button\.active \{/,
    "hover must not be styled as the selected tab");
  assert.match(css, /\.mode-button:hover:not\(\.active\) \{/);
  const active = css.slice(css.indexOf(".mode-button.active {"));
  assert.match(active.slice(0, active.indexOf("}")), /background: var\(--accent-dark\);[\s\S]*color: #ffffff;/,
    "the open tab must be a filled pill, not a shade of the others");

  // And stated, not only coloured.
  assert.match(app, /button\.setAttribute\("aria-current", "true"\)/);

  // 5050 is a live portfolio but not the Live one. Both tabs headed their tables
  // "Opened live trades", so the two read identically while showing different rows.
  const sync = functionSource(app, "syncModeUi");
  // A portfolio may now carry a name of its own, which takes precedence; the fallback
  // behind it is what still has to tell 5050, Live and the paper portfolios apart. The
  // property is asserted rather than the exact expression, which is what broke when the
  // custom name was put in front of it.
  assert.match(sync, /const portfolioLabel = portfolioUsesCustomName\(\)\n\s+\? portfolioNameForMode\(\)/);
  assert.match(sync, /: \(isFixedEntryMode\(\) \? "5050" : \(live \? "live" : paperModeLabel\(\)\)\);/);
  assert.match(sync, /`Opened \$\{portfolioLabel\} trades`/);
  assert.match(sync, /`Closed \$\{portfolioLabel\} trades`/);
  // Checked against the code rather than the whole file, or the comment above explaining
  // the fix would itself count as the thing it warns about.
  const syncCode = sync.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  assert.ok(!/textContent = "Opened live trades"/.test(syncCode),
    "no fixed live heading left to blur the two");
});

test("run log history: both live portfolios publish through the same hardened upload", async () => {
  // Reported: 5050's run log holds a single entry; the history is meant to accumulate
  // there. Its execution state answers 404 on the hosting, so every run restored an empty
  // history, wrote one row, and published that -- one entry, forever.
  //
  // The main live portfolio's upload had already been hardened after its own log emptied:
  // retries, a timeout, a swap that restores the original if it fails, and a loud error
  // when it cannot finish. 5050 was created later with a simpler copy -- one attempt, no
  // timeout, no retry, no restore -- so a publish that did not land said nothing at all.
  const { readFile } = await import("node:fs/promises");
  const [publisher, fixedWorkflow, liveWorkflow] = await Promise.all([
    readFile(new URL("../tools/publish-execution-state.py", import.meta.url), "utf8"),
    readFile(new URL("../../.github/workflows/trading-live-5050.yml", import.meta.url), "utf8"),
    readFile(new URL("../../.github/workflows/polymarket-live-limit-order-test.yml", import.meta.url), "utf8"),
  ]);

  // One implementation, used by both, so neither can drift into the weaker shape again.
  for (const [name, workflow] of [["5050", fixedWorkflow], ["live", liveWorkflow]]) {
    assert.match(workflow, /run: (?:\w+="[^"]*" )*python3 trading\/tools\/publish-execution-state\.py/,
      `${name} must publish through the shared tool`);
    // And no inline copy left behind to be edited instead.
    assert.ok(!/ftp\.storbinary/.test(workflow), `${name} must have no inline FTP upload`);
  }
  assert.match(fixedWorkflow, /PUBLISH_FILES: trading\/data\/live-5050-execution-state\.json>live-5050-execution-state\.json/);
  // The live workflow composes its list from the per-portfolio execution file, so the
  // ordering is checked on the composition and on the default that fills it.
  assert.match(liveWorkflow, /PUBLISH_FILES="\$\{LIVE_EXECUTION_PUBLISH_FILE\},trading\/data\/live-state\.json>live-state\.json"/,
    "the execution state goes first, so the run log survives a failed account upload");
  assert.match(liveWorkflow, /LIVE_EXECUTION_PUBLISH_FILE: trading\/data\/live-execution-state\.json>live-execution-state\.json/,
    "and its default is this portfolio's own execution state");
  assert.match(liveWorkflow, /PUBLISH_REQUIRED: live-state\.json/);

  // What makes it hardened, asserted rather than assumed.
  assert.match(publisher, /for attempt in range\(1, ATTEMPTS \+ 1\):/);
  assert.match(publisher, /ftplib\.FTP\(config\["server"\], timeout=TIMEOUT_SECONDS\)/);
  assert.match(publisher, /raise RuntimeError\(f"Could not upload \{remote_name\} after/,
    "a publish that cannot finish must fail the run, not pass quietly");
  assert.match(publisher, /ftp\.rename\(backup_name, remote_name\)/,
    "a failed swap must put the original back rather than leave the path empty");

  // The merge is what makes the upload safe to do at all: it replaces the hosted file
  // outright, so the local copy has to be a superset of it first.
  for (const [name, workflow] of [["5050", fixedWorkflow], ["live", liveWorkflow]]) {
    // The URL it reads is named on the command line in the live workflow, because it now
    // follows whichever portfolio is running.
    assert.match(workflow, /run: (?:\w+="[^"]*" )*node tools\/merge-live-execution-history\.mjs/,
      `${name} must merge the published history before replacing it`);
  }
});

test("run log history: a publish is read back, so a silent non-landing fails the run", async () => {
  // 5050's run log still held one entry after the shared publisher went in. Measured:
  // live-execution-state.json answers 200 with 73 run-log entries, the 5050 file answers
  // 404 -- while every 5050 run reports success, the local file exists (the digest step
  // reads it), and the upload step raises nothing.
  //
  // An FTP STOR and rename can both succeed while the file lands where the web server
  // does not serve it. Nothing in the chain checked the one thing that matters: whether
  // the file can be read back afterwards. So now it is, and a publish that did not land
  // fails the run instead of passing quietly for days.
  const { readFile } = await import("node:fs/promises");
  const [publisher, fixedWorkflow, liveWorkflow] = await Promise.all([
    readFile(new URL("../tools/publish-execution-state.py", import.meta.url), "utf8"),
    readFile(new URL("../../.github/workflows/trading-live-5050.yml", import.meta.url), "utf8"),
    readFile(new URL("../../.github/workflows/polymarket-live-limit-order-test.yml", import.meta.url), "utf8"),
  ]);

  assert.match(publisher, /def verify_published\(base_url, remote_name\):/);
  assert.match(publisher, /raise RuntimeError\(f"\{remote_name\} uploaded, but \{url\} answers HTTP \{error\.code\}"\)/,
    "a hosted 404 after upload must fail the run");
  // A network blip reaching the hosting is not evidence the upload failed, and failing
  // on it would turn an unreachable host into a red trading job. But it must say plainly
  // that no verification happened: a runner that can never reach the hosting over HTTP
  // turns this check into a no-op reporting nothing, which is indistinguishable in a log
  // from a verification that passed -- and the 5050 run log is still missing.
  assert.match(publisher, /except urllib\.error\.URLError as error:/);
  assert.match(publisher, /print\(f"VERIFICATION SKIPPED: could not reach \{url\}: \{error\.reason\}"\)\n\s+return/);
  // Only after a successful upload, and only when a base URL is configured.
  assert.match(publisher, /upload_atomic\(config, local_path, remote_name\)\n\s+if verify_base:\n\s+verify_published\(verify_base, remote_name\)/);

  for (const [name, workflow] of [["5050", fixedWorkflow], ["live", liveWorkflow]]) {
    assert.match(workflow, /PUBLISH_VERIFY_BASE_URL: https:\/\/osobnizkusenosti\.cz\/trading\/data/,
      `${name} must verify what it publishes`);
  }
});

// Reported: a bid showed as LIMIT ORDER WAITING on a LoL match that had already been
// played -- blocking cash in the live portfolio, and at an entry level that made it look
// like one of 5050's. Nothing in either portfolio withdraws such an order: 5050 cancels
// only siblings of events it has already opened, and the live portfolio reviews open
// orders only when it wants their capital for something else. So it rests until the
// exchange settles the market, which for esports can take days -- and a bid left in the
// book after the result is known is the one bid a counterparty is certain to hit.

const RESTING_BID = {
  side: "BUY",
  price: 0.5,
  remainingSize: 10,
  marketListed: true,
  marketClosed: false,
  marketArchived: false,
  marketAcceptingOrders: true,
};
const HOURS = (count) => new Date(Date.now() - count * 3600000).toISOString();

test("expired orders: a bid on a market that is over is withdrawn, not left resting", () => {
  const { expiredOrderWithdrawalReason: reasonFor, EXPIRED_ORDER_GRACE_HOURS: grace } = executor;

  // Polymarket's own flags. Each means the book is shut, and none is ever set back.
  assert.match(reasonFor({ ...RESTING_BID, marketClosed: true }), /closed on Polymarket/);
  assert.match(reasonFor({ ...RESTING_BID, marketArchived: true }), /archived on Polymarket/);
  assert.match(reasonFor({ ...RESTING_BID, marketAcceptingOrders: false }), /stopped accepting orders/);

  // The reported case with no flag set yet: the match is long over, the market has not
  // been settled, and the bid is still in the book.
  assert.match(
    reasonFor({ ...RESTING_BID, resolutionEndDate: HOURS(grace + 12) }),
    /resolution window closed/,
  );
});

test("expired orders: nothing is withdrawn without positive evidence the market is over", () => {
  const { expiredOrderWithdrawalReason: reasonFor, EXPIRED_ORDER_GRACE_HOURS: grace } = executor;

  // A sell order is reducing a position, not holding collateral for a fill that will
  // never come, and cancelling one would strand the position it is exiting.
  assert.equal(reasonFor({ ...RESTING_BID, side: "SELL", marketClosed: true }), "");

  // Production's six resting bids, measured: every market answered closed=false,
  // active=true, acceptingOrders=true with a resolution window still hours away. Not one
  // of them may be touched, or this sweep would cancel the portfolio's live work.
  for (const hoursAhead of [0.6, 7.3, 10.3, 10.5, 11.8, 13.3]) {
    const order = { ...RESTING_BID, resolutionEndDate: new Date(Date.now() + hoursAhead * 3600000).toISOString() };
    assert.equal(reasonFor(order), "", `a bid ${hoursAhead}h before its market resolves must stay`);
  }

  // An unknown is not evidence. A Gamma lookup that failed leaves the flags absent and
  // the date whatever the snapshot last knew; neither may withdraw anything.
  assert.equal(reasonFor({ side: "BUY", price: 0.65 }), "");
  assert.equal(reasonFor({ ...RESTING_BID, resolutionEndDate: "not a date" }), "");

  // Inside the settlement grace the market is over but the exchange may still be
  // settling normally, and a bid that is about to be cancelled for us can be left alone.
  assert.equal(reasonFor({ ...RESTING_BID, resolutionEndDate: HOURS(Math.max(0, grace - 0.5)) }), "");

  // Gamma listing nothing is one unretried request, so on its own it could be a blip.
  // It counts only alongside a window that has already closed -- which a market still
  // trading cannot have, so a blip on a live market withdraws nothing.
  const unlisted = { ...RESTING_BID, marketListed: false };
  assert.equal(reasonFor({ ...unlisted, resolutionEndDate: new Date(Date.now() + 3600000).toISOString() }), "");
  assert.match(reasonFor({ ...unlisted, resolutionEndDate: HOURS(1) }), /no longer lists this market/);
});

test("expired orders: the sweep runs before the run measures its own capital", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8");
  const body = functionSource(source, "main");

  // Both portfolios reach this: it is in main(), above the branch that hands 5050 off to
  // its own batch. Putting it after would have left 5050 -- the portfolio that rests the
  // most bids, and the one the reported order belonged to -- sweeping nothing.
  const sweep = body.indexOf("withdrawExpiredOpenOrders({ liveState, tradingConfig })");
  const fixedEntryBranch = body.indexOf("if (FIXED_ENTRY_STRATEGY) {");
  assert.ok(sweep > 0 && fixedEntryBranch > sweep, "the sweep must run before either strategy branches off");

  // And before the cash is read, so the capital it recovers is spendable in the same run
  // rather than sitting idle until the next one.
  assert.ok(body.indexOf("const cash = liveCashUsdc(liveState);") > sweep);
  assert.ok(body.indexOf("const availableCash = availableLiveCashUsdc(") > sweep);

  // But after every guard that ends the run early. Cancelling is a trading action, so a
  // portfolio whose automation has been switched off must not do it unasked.
  for (const guard of ["if (SKIP_SCHEDULED_EXECUTION) {", "if (!IS_MANUAL_RUN && !AUTOMATION_ENABLED) {", '"CADENCE_WAIT"']) {
    assert.ok(body.indexOf(guard) > 0 && body.indexOf(guard) < sweep,
      `the sweep must not run before the ${guard} guard has had its say`);
  }

  // A dry run must not pretend the collateral came back: cancelOrder reports a dry run as
  // a success, and acting on that would let a preview run spend money the exchange holds.
  const withdraw = functionSource(source, "withdrawExpiredOpenOrders");
  assert.match(withdraw, /const previewOnly = DRY_RUN \|\| !hasFlag\("confirm-live"\);/);
  assert.match(withdraw, /if \(previewOnly\) remaining\.push\(order\);/);
  // A cancel the exchange refused leaves the order exactly where it was, collateral
  // included -- otherwise the run would go on to spend capital that is still committed.
  assert.match(withdraw, /failed\.push\(summary\);\n\s+remaining\.push\(order\);/);
});

// Asked for explicitly: an archived 5050 stops resting new bids, but nothing it already
// holds goes dark -- the sweep above still runs, and the account snapshot around this
// whole script is unconditional either way.
test("archiving: 5050 stops resting new bids, but the sweep above it still runs", async () => {
  const { readFile } = await import("node:fs/promises");
  const [executorSource, loaderWorkflow] = await Promise.all([
    readFile(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8"),
    readFile(new URL("../../.github/workflows/trading-live-5050.yml", import.meta.url), "utf8"),
  ]);
  const body = functionSource(executorSource, "main");

  const sweep = body.indexOf("withdrawExpiredOpenOrders({ liveState, tradingConfig })");
  const fixedEntryBranch = body.indexOf("if (FIXED_ENTRY_STRATEGY) {");
  const archivedGuard = body.indexOf("if (!IS_MANUAL_RUN && ARCHIVED) {");
  const runBatch = body.indexOf("await runFixedEntryBatch(");
  assert.ok(sweep > 0 && fixedEntryBranch > sweep,
    "archiving must not move new-bid placement's own guard ahead of the unconditional sweep");
  assert.ok(archivedGuard > fixedEntryBranch && archivedGuard < runBatch,
    "the archived check belongs inside the fixed-entry branch, before the batch it gates");

  assert.match(executorSource, /const ARCHIVED = String\(process\.env\.LIVE_ARCHIVED \?\? "false"\)\.toLowerCase\(\) === "true"/,
    "an unwritten switch must mean not archived, matching every portfolio that predates this feature");

  // The same manual-overrides-a-portfolio-switch rule automation already follows --
  // a person can still run it by hand on an archived portfolio.
  assert.match(body.slice(fixedEntryBranch, runBatch), /if \(!IS_MANUAL_RUN && ARCHIVED\) \{/);

  assert.match(loaderWorkflow, /"LIVE_ARCHIVED": str\(bool\(cfg\.get\("archived", False\)\)\)\.lower\(\)/,
    "the saved config's archived flag must reach the executor");
});

test("expired orders: the market's trading state is recorded where both readers can see it", async () => {
  const { readFile } = await import("node:fs/promises");
  const [sync, executorSource] = await Promise.all([
    readFile(new URL("../tools/live-account-sync.mjs", import.meta.url), "utf8"),
    readFile(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8"),
  ]);

  // The sweep can only act on flags something put on the order. The sync writes them for
  // the dashboard, the executor re-reads them fresh for its own decision.
  for (const [name, source] of [["account sync", sync], ["executor", executorSource]]) {
    assert.match(source, /marketClosed: market\.closed === true,/, `${name} records the closed flag`);
    assert.match(source, /marketArchived: market\.archived === true,/, `${name} records the archived flag`);
    assert.match(source, /marketAcceptingOrders: market\.acceptingOrders !== false,/,
      `${name} records whether the book still takes orders`);
  }

  // Gamma answering with no market is a delisted market; a lookup that threw is an
  // unknown. Collapsing the two would let a network failure cancel live orders.
  assert.match(executorSource, /if \(!market\) return \{ \.\.\.order, marketListed: false \};/);
});

test("expired orders: what the sweep recovered is on both portfolios' run logs", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8");

  // A portfolio whose cash keeps vanishing into stranded bids is a thing to notice, and
  // the run log is where it would be noticed.
  //
  // Counted, not matched: 5050 reports twice -- in the decision payload and in the
  // batchLog counts the run-log row is rendered from -- and one `assert.match` is
  // satisfied by either, so deleting the payload's copy passed this test unchanged.
  const occurrences = (haystack, needle) => haystack.match(new RegExp(needle, "g"))?.length || 0;
  const fixedEntry = functionSource(source, "runFixedEntryBatch");
  assert.equal(occurrences(fixedEntry, "expiredOrdersWithdrawn: expiredOrderSweep\\.withdrawn\\.length,"), 2,
    "5050 reports the sweep in its decision payload and in the counts its run-log row reads");
  assert.equal(occurrences(fixedEntry, "expiredOrderCashReleasedUsdc: expiredOrderSweep\\.releasedUsdc,"), 2);
  // Said on the branch that rests nothing too -- that is the branch where the missing
  // capital would otherwise have gone unexplained.
  assert.match(fixedEntry, /from \$\{checked\.length\} scanned\$\{expiredNote\}`;/);

  const main = functionSource(source, "main");
  assert.match(main, /expiredOrdersWithdrawn: expiredOrderSweep\.withdrawn\.length,/);
  assert.match(main, /expiredOrderCashReleasedUsdc: expiredOrderSweep\.releasedUsdc,/);
});

test("expired orders: the dashboard marks the row by the same rule that withdraws it", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");
  const hasEnded = new Function(`
    ${/const EXPIRED_ORDER_GRACE_HOURS = \d+;/.exec(app)[0]}
    ${functionSource(app, "orderMarketHasEnded")}
    return orderMarketHasEnded;
  `)();

  // The dashboard cannot import the executor -- it is a static page -- so the rule is
  // written twice. Agreeing on every case is the whole point of testing them together:
  // a row marked as ended that the sweep will not withdraw, or the reverse, is worse
  // than no marker at all.
  const cases = [
    { ...RESTING_BID, marketClosed: true },
    { ...RESTING_BID, marketArchived: true },
    { ...RESTING_BID, marketAcceptingOrders: false },
    { ...RESTING_BID, resolutionEndDate: HOURS(14) },
    { ...RESTING_BID, resolutionEndDate: HOURS(1) },
    { ...RESTING_BID, resolutionEndDate: new Date(Date.now() + 13.3 * 3600000).toISOString() },
    { ...RESTING_BID, resolutionEndDate: "not a date" },
    { ...RESTING_BID, marketListed: false, resolutionEndDate: HOURS(1) },
    { ...RESTING_BID, marketListed: false, resolutionEndDate: new Date(Date.now() + 3600000).toISOString() },
    { side: "BUY", price: 0.65 },
  ];
  for (const order of cases) {
    assert.equal(
      hasEnded(order),
      Boolean(executor.expiredOrderWithdrawalReason(order)),
      `the dashboard and the sweep disagree about ${JSON.stringify(order)}`,
    );
  }

  // Same grace, stated as a number in both places rather than inferred from behaviour.
  assert.equal(
    Number(/const EXPIRED_ORDER_GRACE_HOURS = (\d+);/.exec(app)[1]),
    executor.EXPIRED_ORDER_GRACE_HOURS,
  );

  // And the row says so instead of reading as an order that is still in play.
  assert.match(functionSource(app, "tradeTypeBadge"), /trade\.marketEnded/);
  assert.match(app, /marketEnded: orderMarketHasEnded\(order\),/);
});

test("run log history: a 5050 run that produced no state fails instead of publishing nothing", async () => {
  const { readFile } = await import("node:fs/promises");
  const [publisher, workflow] = await Promise.all([
    readFile(new URL("../tools/publish-execution-state.py", import.meta.url), "utf8"),
    readFile(new URL("../../.github/workflows/trading-live-5050.yml", import.meta.url), "utf8"),
  ]);

  // Measured: the hosted path answers 404 and no .uploading-N or .previous sits beside
  // it, so nothing was ever transferred -- while the step reported success. A local file
  // the publisher cannot find is skipped, and with nothing declared required the step
  // then exits clean, which is the only remaining way for that combination to happen.
  assert.match(workflow, /PUBLISH_REQUIRED: live-5050-execution-state\.json/,
    "producing this state is what a 5050 run is for; its absence must fail the run");
  assert.match(publisher, /unmet = required\.intersection\(missing\)/);
  assert.match(publisher, /raise SystemExit\(f"required file\(s\) not generated: /);
});

// Reported with screenshots of the live portfolio: three orders resting at +3,389.6%,
// +5,835.6% and +7,440.2% win p.a., a shortlist whose best candidates read +4,982.0% and
// +4,976.9% potential p.a., $0.41 free against $4.60 required -- and no rotation. The run
// log said why: every open order read "open order notional 3.2500 USDC exceeds max stake
// 2.1881 USDC; kept because no replacement can be submitted atomically in this review".
//
// Those are the real figures. The portfolio's value had fallen since the orders were
// placed, so its max stake had shrunk below the size of orders already on the book, and
// the breach ended the review before any comparison ran. That is a trap with no way out:
// the capital can only be released by a review, and the review refused to look.
test("open order review: an order above the current max stake is still evaluated", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8");
  const review = functionSource(source, "reviewOpenOrders");
  const code = review.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");

  // The branch that ended the review is gone: the breach no longer decides anything.
  assert.doesNotMatch(code, /if \(maxStakeBreached\) \{/,
    "a breach must not short-circuit the review before any candidate is compared");

  // The evaluation now runs for these orders like any other, so a better-ranked
  // candidate can take the capital.
  assert.match(code, /if \(!sourceEvaluation\) \{/);
  assert.match(code, /const revalidated = await revalidateEvaluation\(/);
  assert.match(code, /review\.action = "CANCEL_FOR_BETTER_CANDIDATE";/);

  // Cancelling releases the whole oversized notional, and the replacement is revalidated
  // against the current max stake -- so it comes back correctly sized by construction.
  assert.match(code, /const effectiveCash = number\(cash, 0\) \+ number\(lockedNotional, 0\);/);

  // And the breach still reaches the run log, on the review and in every reason that
  // ends with the order kept -- it is why the order is oversized, just not a verdict.
  assert.match(code, /review\.maxStakeBreached = maxStakeBreached;/);
  assert.match(code, /const breachNote = maxStakeBreached/);
  // Checked one assignment at a time, so a new keep-branch that forgets the note fails
  // here instead of quietly dropping it. Counting occurrences could not do this: one
  // assignment is a ternary carrying the note twice, which made the totals disagree.
  // The only two reasons allowed to omit it are the ones that do not keep the order.
  const statements = code.split("review.reason = ").slice(1)
    .map((chunk) => chunk.slice(0, chunk.indexOf(";\n")));
  const withoutNote = statements.filter((statement) => !statement.includes("breachNote"));
  assert.equal(withoutNote.length, 2,
    `only the two reasons that replace the order may omit the breach, found ${withoutNote.length}`);
  for (const statement of withoutNote) {
    assert.match(statement, /priority supports replacement \(|repriceReason\(/,
      "a reason that keeps the order must say the order is oversized");
  }
});

// "The application still does not keep the 5050 portfolio's run logs." Measured, finally,
// by listing the hosting's data directory over FTP: the path is right and the login is not
// chrooted, live-execution-state.json and every paper-state segment are present -- and
// live-5050-execution-state.json is not there, with no .uploading or .previous beside it.
//
// It was never a publishing failure. Every 5050 run uploaded it successfully; the next
// deploy of the site deleted it, because deploy cleans the data directory against a
// hard-coded keep list written when only one live portfolio existed. The run after that
// restored an empty history over the resulting 404 and published a single row, which is
// exactly the one-row log that kept coming back.
test("run log history: deploying the site does not delete a portfolio's run log", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/trading-deploy.yml", import.meta.url), "utf8");
  // Cut at the next definition, not at the next blank line: the docstring explaining why
  // this list exists contains blank lines, so stopping at one truncated the function
  // mid-string and every case failed on a syntax error rather than on its merits.
  const source = /def is_runtime_data\(name\):\n[\s\S]*?(?=\n {10}def )/.exec(workflow);
  assert.ok(source, "is_runtime_data must be findable in the deploy workflow");

  // The workflow's own function, run as it is written, against the directory listing the
  // hosting actually returned.
  const script = source[0].split("\n").map((line) => line.replace(/^ {10}/, "")).join("\n");
  const keeps = (name) => execFileSync("python3", ["-c", `${script}\nprint("1" if is_runtime_data(${JSON.stringify(name)}) else "0")`], { encoding: "utf8" }).trim() === "1";

  // The file whose loss was reported, and the one that survived because it was listed.
  assert.equal(keeps("live-5050-execution-state.json"), true,
    "a portfolio's entire run-log history must survive a deploy of the site");
  assert.equal(keeps("live-execution-state.json"), true);

  // Matched by shape, so the next live portfolio cannot be forgotten the way 5050 was.
  assert.equal(keeps("live-conservative-execution-state.json"), true);

  // The rest of the directory as the hosting listed it, unchanged.
  for (const name of [
    "live-state.json",
    "market-scan-history",
    "paper-state.json",
    "paper-state.evaluations.json",
    "paper-state.observations.json",
    "paper-state.resolvedObservations.json",
    "paper-state.scanHistory.json",
    "portfolio-config.json",
    "redeem-alert-ledger.json",
    "scrape-scan-preferences.json",
  ]) {
    assert.equal(keeps(name), true, `${name} is runtime state and must survive a deploy`);
  }

  // And the cleaning still cleans: a stale artefact is not runtime state.
  assert.equal(keeps("index.html"), false);
  assert.equal(keeps("live-5050-execution-state.json.uploading-1"), false);
});

// Three reports about the opportunities page, one cause between two of them: the chosen
// tab was not obvious, and the scraped view's filters were showing on the scraping log
// even though the script hides them there.
test("opportunities page: the active choice is obvious and the filters belong to the list", async () => {
  const { readFile } = await import("node:fs/promises");
  const [css, html, app] = await Promise.all([
    readFile(new URL("../assets/app.css", import.meta.url), "utf8"),
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../assets/app.js", import.meta.url), "utf8"),
  ]);

  // Hover and active shared one rule, so the chosen tab was a white pill among grey ones
  // -- and a touch screen has no hover to compare it against at all.
  assert.match(css, /\.segment-button:hover:not\(\.active\) \{/);
  assert.match(css, /\.segment-button\.active \{\n  background: var\(--accent-dark\);\n  color: #ffffff;/);

  // The script hid the filters on the scraping log all along. It could not take effect:
  // the browser hides [hidden] with a user-agent rule and any author display beats it,
  // and both .threshold-control and .segmented set their own inline-flex.
  assert.match(css, /\[hidden\] \{\n  display: none !important;\n\}/);
  for (const selector of [".threshold-control", ".segmented"]) {
    const rule = new RegExp(`\\${selector} \\{\\n  display: inline-flex;`);
    assert.match(css, rule, `${selector} sets its own display, which is why the global rule is needed`);
  }
  assert.match(app, /els\.opportunityFilterControls\.forEach\(\(element\) => \{\n\s+element\.hidden = scanLog;/);

  // The evaluated view is retired -- nothing produces AI verdicts any more -- so the tab
  // is gone and any stored route or old link resolves to the scraped list, not a blank.
  assert.doesNotMatch(html, /data-opportunity-view="evaluated"/);
  assert.match(app, /function normalizeOpportunityView\(view\) \{\n  return view === "scan-log" \? view : "scraped";/);
  assert.doesNotMatch(app, /opportunityRoutePath\("evaluated"\)/);
  assert.doesNotMatch(app, /routePath\("opportunities", "evaluated"\)/);

  // The view switch belongs to the page heading, while the tag picker and scan action
  // remain scraped-only. This keeps the switch available on the scan-log route without
  // making the filter row compete with it for space.
  assert.match(html, /class="panel-head-actions opportunity-header-actions"[\s\S]*?data-opportunity-view-toggle[\s\S]*?class="scraped-scan-controls" data-scraped-only/);
  assert.doesNotMatch(html, /<span>Polymarket tag<\/span>/);
  assert.doesNotMatch(app, /Choose a category to scan\./);
  assert.match(app, /els\.scrapedScanButton\.hidden = state\.scrapedScanBusy;/);
  assert.match(app, /els\.scrapedScanStatus\.hidden = !state\.scrapedScanBusy && !state\.scrapedScanStatus;/);

  // And the page must not still explain a filter in terms of the view that is gone.
  assert.doesNotMatch(html, /It uses AI probability in Evaluated/);
});

// Reported from the 5050 run log, twice within the hour: ERROR "scraped Polymarket state
// HTTP 500". Reproduced against the real api.php with a state built to production's own
// row counts -- 3,157 active observations and 23,561 resolved -- where summary=scraped
// dies with "Allowed memory size of 134217728 bytes exhausted" before it filters anything.
// Decoding the resolved archive alone costs 138 MB, so no downstream cap can rescue it.
//
// The executor never reads a resolved market: it takes marketObservations and nothing
// else. api.php already carries a summary for exactly this, whose own comment says the
// resolved archive is never decoded for it "no matter how large it grows" -- the trading
// runs were simply pointed at the wrong one.
test("live executor: the trading runs read the summary that skips the resolved archive", async () => {
  const { readFile } = await import("node:fs/promises");
  const [executorSource, fixedWorkflow, liveWorkflow, api] = await Promise.all([
    readFile(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8"),
    readFile(new URL("../../.github/workflows/trading-live-5050.yml", import.meta.url), "utf8"),
    readFile(new URL("../../.github/workflows/polymarket-live-limit-order-test.yml", import.meta.url), "utf8"),
    readFile(new URL("../api.php", import.meta.url), "utf8"),
  ]);

  for (const [name, source] of [["executor", executorSource], ["5050", fixedWorkflow], ["live", liveWorkflow]]) {
    assert.match(source, /PAPER_SCRAPED_STATE_URL[^\n]*summary=execution/,
      `${name} must not ask for the resolved archive it never reads`);
    assert.doesNotMatch(source, /PAPER_SCRAPED_STATE_URL[^\n]*summary=scraped/);
  }

  // Safe only because that is genuinely the one field taken from this response.
  const uses = executorSource.match(/scrapedState[?.]*\.\w+/g) || [];
  assert.deepEqual([...new Set(uses)], ["scrapedState?.marketObservations", "scrapedState.marketObservations"],
    "switching summaries is only safe while marketObservations is all the executor reads");

  // And the summary it now asks for really does serve that field, from active markets.
  const execution = /if \(\$summary === 'execution'\) \{[\s\S]*?\n    \}/.exec(api);
  assert.ok(execution);
  assert.match(execution[0], /'marketObservations' => array_map\(/);
  // The activeness filter moved into scoped_execution_observations when the summary
  // gained a per-portfolio scope, so the guarantee is checked where it now lives. Both
  // of that helper's branches have to uphold it: the unscoped one directly, and the
  // scoped one through execution_scope_matches_observation.
  assert.match(execution[0], /scoped_execution_observations\(\$observations, \$selectedStrategyId\)/);
  const scoped = /function scoped_execution_observations\([\s\S]*?\n\}/.exec(api);
  assert.ok(scoped);
  assert.match(scoped[0], /is_active_scraped_market_observation\(\$item\)/);
  assert.match(scoped[0], /execution_scope_matches_observation\(\$item, \$config\)/);
  const scopeMatches = /function execution_scope_matches_observation\([\s\S]*?\n\}/.exec(api);
  assert.ok(scopeMatches);
  assert.match(scopeMatches[0], /^[\s\S]{0,200}if \(!is_active_scraped_market_observation\(\$item\)\) \{\n\s+return false;/,
    "a scoped execution read must reject a resolved row before any other test");
  // The segment list is what actually keeps the archive off the heap.
  assert.match(api, /case 'execution':\n[\s\S]*?return \['observations'\];/);
  // And the heavy summary is no longer heavy either: the opportunities page reads the
  // writer's capped page of the archive rather than all of it.
  assert.match(api, /case 'scraped':\n[\s\S]*?return \['observations', 'resolvedRecent', 'scanHistory'\];/);
  assert.doesNotMatch(api, /return \['observations', 'resolvedObservations', 'scanHistory'\];/);
});

// Reported while reading a live run log: "Position rotation / NO_ROTATION_CANDIDATE / no
// open live position can be evaluated for rotation", next to a SKIP saying the cheapest
// candidate needs 4.6900 USDC against 0.4671 available. From that pairing it is not
// possible to tell whether the portfolio's own rule declined to rotate or whether the
// rotation logic is broken -- which is exactly what was asked of the log.
//
// One sentence was carrying three different situations: no positions at all, positions
// that all out-earn the best candidate, and positions that could not be priced. The
// account behind that log holds no position and eleven resting orders, so it was the
// first -- and the sentence gave no way to know that.
test("rotation log: no rotation says which of the three reasons applied", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8");
  const review = functionSource(source, "reviewPositionRotation");

  // Nothing held is a different statement from nothing worth rotating.
  assert.match(review, /const reason = !heldPositions\.length/);
  assert.match(review, /holds no open position, so there is nothing to rotate out of/);
  assert.match(review, /already earn at least as much as the best candidate/,
    "the rule declining to sell a better holding must read as a decision, not an absence");

  // With the figure the decision was made on, so it can be checked rather than trusted.
  assert.match(review, /bestCandidateReturn \* 100/);
  assert.match(review, /positionsAboveBestCandidate: rejectedByReturnBar\.length,/);
  assert.match(review, /positionsBelowBestCandidate: heldPositions\.length - rejectedByReturnBar\.length,/);

  // And when there is nothing held, where the capital actually is -- otherwise the reader
  // is told the portfolio has nothing to rotate while plainly having money committed.
  assert.match(review, /its committed capital is in \$\{restingBuyOrders\} resting order\(s\)/);
  assert.match(review, /the open-order review decides on separately/);

  // The same gap on the other side: the SKIP note said only that cash was short.
  const main = functionSource(source, "main");
  assert.match(main, /const capitalLocationNote = restingBuyOrderCount \|\| heldPositionCount/);
  assert.match(main, /the open-order review looked at \$\{orderManagement\.reviews\.length\} of them/);
  assert.match(main, /USDC available\.` : ""\}\$\{capitalLocationNote\}`/);
});

test("rotation log: the wording is driven by the real function, not by the log's shape", () => {
  const app = readFileSync(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8");
  const review = functionSource(app, "reviewPositionRotation");
  // The early return, lifted out and driven directly. Everything it needs is either a
  // parameter or computed just above it, so the branch runs exactly as it does in a run.
  const branch = /if \(!positions\.length\) \{[\s\S]*?\n  \}/.exec(review);
  assert.ok(branch, "the early return must stay findable");
  const run = new Function("heldPositions", "rejectedByReturnBar", "bestCandidateReturn", "liveState", "reviews", `
    const positions = [];
    ${branch[0].replace(/^\s*return \{/m, "return {")}
    return null;
  `);

  // Production's case: nothing held, eleven bids resting.
  const empty = run([], [], 0.9, { openOrders: Array.from({ length: 11 }, () => ({ side: "BUY" })) }, []);
  assert.match(empty.reason, /holds no open position/);
  assert.match(empty.reason, /11 resting order\(s\)/);
  assert.equal(empty.positionsHeld, 0);
  assert.equal(empty.restingBuyOrders, 11);

  // The rule declining: two holdings, both already earning more than anything on offer.
  const held = [{ holdAnnualizedReturn: 5 }, { holdAnnualizedReturn: 4 }];
  const declined = run(held, held, 3.2, { openOrders: [] }, []);
  assert.match(declined.reason, /all 2 open position\(s\) already earn at least as much/);
  assert.match(declined.reason, /320\.0% p\.a\./, "the bar it was measured against is stated");
  assert.equal(declined.positionsAboveBestCandidate, 2);
  assert.equal(declined.positionsBelowBestCandidate, 0);
  // Both are NO_ROTATION_CANDIDATE, and that is the point: the action never distinguished
  // them, so the reason has to.
  assert.equal(empty.action, declined.action);
  assert.notEqual(empty.reason, declined.reason);
});

// Reported from the live run log: every automatic run since the previous change threw
// "Cannot access 'capitalLocationNote' before initialization". Mine. The note is read by
// the actionExplanation expression and I declared it below that expression, which is a
// temporal dead zone error -- and unlike a plain typo it only fires when the line runs.
//
// The previous test asserted the text of both parts and passed, because text says nothing
// about order. This one runs the statements in the order the file declares them, which is
// the only thing that catches it.
test("run log note: the capital note is declared before the explanation that reads it", () => {
  const source = readFileSync(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8");
  const main = functionSource(source, "main");

  const noteAt = main.indexOf("const capitalLocationNote =");
  const usedAt = main.indexOf("${capitalLocationNote}");
  assert.ok(noteAt > 0 && usedAt > 0, "both the declaration and its use must be findable");
  assert.ok(noteAt < usedAt,
    "a const read above its own declaration throws at runtime, not at parse time");

  // Driven rather than matched: the three statements are lifted in file order and run, so
  // a future reordering fails here the way production failed.
  const block = main.slice(noteAt - 400 < 0 ? 0 : main.lastIndexOf("const restingBuyOrderCount", noteAt), main.indexOf("\n", usedAt));
  const build = new Function("liveState", "orderManagement", "openPositionsForRotation", `
    ${block.slice(0, block.indexOf("const actionExplanation"))}
    return capitalLocationNote;
  `);

  // Production's shape: nothing held, eleven bids resting, every one kept.
  const note = build(
    { openOrders: Array.from({ length: 11 }, () => ({ side: "BUY" })) },
    { action: "NONE", reviews: Array.from({ length: 11 }, () => ({})) },
    () => [],
  );
  assert.match(note, /0 position\(s\) and 11 resting order\(s\)/);
  assert.match(note, /looked at 11 of them and chose to keep every one/);

  // And nothing committed anywhere adds nothing to the note.
  assert.equal(build({ openOrders: [] }, { action: "NONE", reviews: [] }, () => []), "");
});

// Reported with the run log and the closed trade beside it: a position with 0.2174 USDC of
// remaining upside was sold to buy a market resolving in 0.01d, and the closed row shows
// +0.01 USDC banked against a +0.25 USDC potential win. The replacement never appeared.
//
// Both legs are visible in the code and they were not symmetrical. The exit is built with
// forceTaker/FAK and fills unconditionally. The entry went through the normal buy path,
// which prices a limit at the *bid* and posts it post-only -- so it fills only if someone
// crosses to us, and on a fourteen-minute market nobody was going to. The swap was certain
// on the selling side and optional on the buying side, which is strictly worse than not
// rotating: it banks the exit and keeps neither opportunity.
test("rotation entry: completing a rotation crosses the spread instead of resting at the bid", () => {
  const source = readFileSync(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8");

  const book = { bestBid: 0.92, bestAsk: 0.94 };
  // An ordinary maker buy still rests at the bid.
  assert.equal(executor.orderPriceForBook(book, 0.01), 0.92);
  // A rotation review and completion both force the executable ask, so the approved
  // economics and the eventual buy use the same price.
  assert.equal(executor.orderPriceForBook(book, 0.01, { forceTakerEntry: true }), 0.94);

  // The exit was always a taker. The entry is one too now, so neither leg is optional.
  const exit = functionSource(source, "buildRotationExitOrder");
  assert.match(exit, /orderType: "FAK",/);
  assert.match(exit, /forceTaker: true,/);
  assert.match(source, /orderType: USE_LIMIT_ORDERS && !takerEntry \? "GTC" : "FAK",/,
    "the entry must be marked FAK so submitOrder routes it as a taker");
  assert.match(functionSource(source, "submitOrder"), /const forceTaker = Boolean\(order\.forceTaker\) \|\| String\(order\.orderType \|\| ""\)\.toUpperCase\(\) === "FAK";/);

  // Crossing is the intent here, so the post-only guard must not veto it.
  assert.match(source, /if \(USE_LIMIT_ORDERS && POST_ONLY && !takerEntry && book\.bestAsk != null && price >= book\.bestAsk\) \{/);

  // Only on a completion run: an ordinary buy still rests below the market, which is what
  // the maker strategy is for.
  assert.match(source, /const ROTATION_ENTRY_CROSSES_SPREAD = ROTATION_COMPLETION_RUN && ROTATION_TAKER_ENTRY;/);
});

test("rotation entry: crossing the spread is charged, not assumed away", () => {
  const source = readFileSync(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8");

  // A post-only maker pays no fee, and every economics site said so unconditionally. A
  // taker entry does pay one, so a rotation approved on free-maker numbers and executed
  // at taker prices would report a gain it never made.
  const zeroFeeSites = source.match(/USE_LIMIT_ORDERS && POST_ONLY[^?\n]*\?/g) || [];
  for (const site of zeroFeeSites) {
    assert.match(site, /!ROTATION_ENTRY_CROSSES_SPREAD|!takerEntry/,
      `every maker-fee assumption must exclude the crossing entry, found: ${site}`);
  }
  // Including the resize path, whose row would otherwise disagree with its own order.
  assert.match(functionSource(source, "resizeCandidateForMakerPrecision"),
    /const fee = USE_LIMIT_ORDERS && POST_ONLY && !ROTATION_ENTRY_CROSSES_SPREAD \? 0 : takerFee\(/);
  // And the run log says which of the two it was.
  assert.match(source, /feeMode: USE_LIMIT_ORDERS && POST_ONLY && !takerEntry \? "post-only maker fee assumed 0" : "taker fee estimate",/);

  // The workflow step that completes a rotation is the one that turns this on.
  const workflow = readFileSync(new URL("../../.github/workflows/polymarket-live-limit-order-test.yml", import.meta.url), "utf8");
  assert.match(workflow, /LIVE_ROTATION_COMPLETION: "true"/);
});

// "The counts of our own events in brackets I do not need. Rather the counts of what is
// not scraped on Polymarket, if the load is under 2 seconds in the UI. Otherwise nothing."
//
// Measured against Gamma before building anything: /events/pagination reports
// pagination.totalResults without returning the rows, and all fourteen categories in
// parallel cost 561ms raw and 303ms under the scan's own filters -- inside the budget.
// The filters matter: sports has 12,312 open events and 191 that clear the scan's
// liquidity floor inside its window, so a raw total would advertise twelve thousand
// markets the scan will never fetch.
test("tag picker: the bracket is a live Polymarket count, on a budget, or nothing", () => {
  const app = readFileSync(new URL("../assets/app.js", import.meta.url), "utf8");

  // The stored count is gone -- label and the function that computed it.
  assert.doesNotMatch(app, /nothing stored yet/);
  assert.doesNotMatch(app, /stored`/);
  assert.doesNotMatch(app, /function scrapedScanStoredTagCounts/,
    "the stored counter has no other caller; leaving it would rot");

  // Counted the way the scan counts, not the way the category advertises itself.
  assert.match(app, /const SCAN_CATEGORY_LIQUIDITY_MIN = 40000;/);
  assert.match(app, /liquidity_min=\$\{SCAN_CATEGORY_LIQUIDITY_MIN\}/);
  assert.match(app, /end_date_min=\$\{encodeURIComponent\(endDateMin\)\}/);
  assert.match(app, /end_date_max=\$\{encodeURIComponent\(endDateMax\)\}/);
  assert.match(app, /pagination\?\.totalResults/);

  // The budget is enforced, not assumed, and it covers the row arriving together.
  assert.match(app, /const SCAN_CATEGORY_COUNT_BUDGET_MS = 2000;/);
  assert.match(app, /const controller = new AbortController\(\);/);
  assert.match(app, /setTimeout\(\(\) => controller\.abort\(\), SCAN_CATEGORY_COUNT_BUDGET_MS\)/);
  assert.match(app, /signal: controller\.signal/);

  // "Otherwise nothing": no number means no bracket, never a stale or invented one.
  const options = functionSource(app, "renderScrapedScanControls");
  assert.match(options, /const suffix = count == null \? "" :/);
  assert.match(functionSource(app, "scrapedScanTagOptions"),
    /counts\?\.has\(tag\) \? Number\(counts\.get\(tag\)\) : null/);
  // A failed refresh keeps the last good row rather than blanking every bracket.
  assert.match(functionSource(app, "loadScanCategoryCounts"), /if \(counts\.size\) \{/);

  // Every category the picker offers must have a tag id, or its bracket can never fill.
  const listed = /const MARKET_SCAN_CATEGORIES = \[([\s\S]*?)\];/.exec(app)[1]
    .match(/"([^"]+)"/g).map((entry) => entry.replace(/"/g, ""));
  const ids = /const MARKET_SCAN_CATEGORY_TAG_IDS = \{([\s\S]*?)\n\};/.exec(app)[1];
  for (const category of listed) {
    assert.match(ids, new RegExp(`(^|\\s|")${category.replace(/[-]/g, "[-]")}"?:`),
      `${category} is offered in the picker but has no Gamma tag id`);
  }
});

// Reported from the live run log: ERROR "paper state HTTP 500". The same shape as the
// scraped-state failure, on the other endpoint the run reads.
//
// Measured against the real api.php: the unnamed summary decodes and re-encodes every
// stored evaluation. 20,000 of them peak at 94 MB, 40,000 exhaust the host's 128 MB, and
// the manifest-only summary costs 2 MB at 60,000 while still carrying the true count.
//
// The run never used that catalogue. PROBABILITY_SOURCE is a constant, so candidates
// always come from the scraped Polymarket state; the evaluations were fetched in full to
// print one number in the log. It was downloading a catalogue it does not read, until the
// catalogue grew past the host.
test("live executor: the paper state is read for a count, not for a catalogue", async () => {
  const { readFile } = await import("node:fs/promises");
  const [executorSource, fixedWorkflow, liveWorkflow, api] = await Promise.all([
    readFile(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8"),
    readFile(new URL("../../.github/workflows/trading-live-5050.yml", import.meta.url), "utf8"),
    readFile(new URL("../../.github/workflows/polymarket-live-limit-order-test.yml", import.meta.url), "utf8"),
    readFile(new URL("../api.php", import.meta.url), "utf8"),
  ]);

  for (const [name, source] of [["executor", executorSource], ["5050", fixedWorkflow], ["live", liveWorkflow]]) {
    assert.match(source, /PAPER_STATE_URL[^\n]*target=paper&summary=dashboard/,
      `${name} must not download the evaluation catalogue it never reads`);
    assert.doesNotMatch(source, /PAPER_STATE_URL[^\n]*target=paper(?!&summary)/);
  }

  // That summary decodes no catalogue, which is what makes it cheap. It reads the
  // archives segment now that a reset portfolio's only historical copy lives there, and
  // that one is bounded by the number of archived portfolios rather than by the mined
  // catalogue -- the two segments this test exists to keep out are the ones that grow
  // without limit.
  const dashboardSegments = /case 'dashboard':\n\s+return (\[[^\]]*\]);/.exec(api);
  assert.ok(dashboardSegments, "the dashboard summary must still declare its segments");
  assert.doesNotMatch(dashboardSegments[1], /'evaluations'|'observations'|'resolved/);
  // And the core still carries the manifest the count comes from.
  assert.match(executorSource, /paperState\?\.stateSegments\?\.evaluations\?\.counts\?\.evaluations/);

  // The count still reaches the log, from the manifest rather than by counting rows.
  const main = functionSource(executorSource, "main");
  assert.match(main, /const storedEvaluations = storedEvaluationCount\(paperState\);/);
  assert.doesNotMatch(main, /rawEvaluations/,
    "nothing may read the catalogue now that the response does not carry it");

  // The dead branch that would have silently produced an empty shortlist is gone, not
  // left to be switched on by someone changing the constant.
  assert.match(main, /const rawCandidateRows = rawMarketObservations;/);
});

test("live executor: the stored-evaluation count survives both state shapes", () => {
  const source = readFileSync(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8");
  const count = new Function(`
    ${functionSource(source, "storedEvaluationCount")}
    return storedEvaluationCount;
  `)();

  // A segmented state: the rows are not in the response, the manifest says how many.
  assert.equal(count({ evaluations: [], stateSegments: { evaluations: { counts: { evaluations: 60000 } } } }), 60000);
  // A state written before segmentation carries the rows inline, and counting is then the
  // only way to answer.
  assert.equal(count({ evaluations: [{}, {}, {}] }), 3);
  // Neither: a number is still reported rather than the log breaking on it.
  assert.equal(count({}), 0);
  assert.equal(count(null), 0);
  // Zero declared is a real answer, not a missing one.
  assert.equal(count({ evaluations: [{}], stateSegments: { evaluations: { counts: { evaluations: 0 } } } }), 0);
});

// The pipeline stopped depending on GitHub's scheduler because the scheduler does not
// deliver. Measured over 24 hours on this repository: 1128 scheduled runs configured
// across every workflow, 25 delivered -- 2.2% -- arriving in bursts hours apart, with each
// workflow starved to two to six runs a day whether it asked for 24 or 312. Over the same
// window workflow_dispatch started 167 runs, none queued longer than two minutes.
//
// A self-dispatching loop is a sharp tool, so the properties that keep it safe are pinned
// here rather than left to review.
test("pacer: the clock cannot multiply, cannot stall the pipeline, and can be stopped", () => {
  const pacer = readFileSync(new URL("../../.github/workflows/trading-pacer.yml", import.meta.url), "utf8");

  // The one failure mode a self-dispatching loop must not have. Cancelling in progress
  // means a duplicate -- the resurrection cron firing while the chain is healthy, or a
  // person starting it by hand -- collapses back to one chain. Queuing would let
  // duplicates stack up and double the rate every time it happened.
  assert.match(pacer, /concurrency:\n\s+group: trading-pacer\n\s+cancel-in-progress: true/,
    "a second pacer must replace the first, never run beside it");

  // The chain is handed on even when a step above failed, or one bad minute stops the
  // pipeline until the hourly resurrection cron happens to be delivered.
  const handOn = /- name: Hand the chain on\n([\s\S]*?)(?=\n      - name: |\n*$)/.exec(pacer);
  assert.ok(handOn, "the pacer must hand the chain on");
  assert.match(handOn[1], /if: always\(\)/, "a failed tick must not end the chain");
  assert.match(handOn[1], /trading-pacer\.yml\/dispatches/);
  // And it is last, so the work is dispatched before the successor is.
  assert.ok(pacer.indexOf("- name: Hand the chain on") > pacer.indexOf("- name: Wake the market scan"));

  // An off switch that needs no code change, and that a running pacer honours.
  assert.match(handOn[1], /vars\.TRADING_PACER_ENABLED.*=.*"false"/,
    "there must be a way to stop the chain without editing the workflow");
  // Absent variable means empty string, which must not read as "stop".
  assert.ok(!/vars\.TRADING_PACER_ENABLED.*!=/.test(handOn[1]),
    "an unset variable must leave the chain running");

  // The sleep is bounded on both sides: a bad input can neither spin the loop hot nor
  // park a job past its own timeout.
  assert.match(pacer, /if \[ "\$minutes" -lt 1 \]/);
  assert.match(pacer, /if \[ "\$minutes" -gt 50 \]/);
  const timeout = /timeout-minutes: (\d+)/.exec(pacer);
  assert.ok(timeout && Number(timeout[1]) > 50,
    "the job timeout must exceed the longest permitted sleep");

  // A schedule is still declared, but only as the way a dead chain comes back. One entry
  // is the point: more would not be delivered any more often, and this one only has to
  // land eventually.
  const crons = pacer.match(/- cron: '[^']+'/g) || [];
  assert.equal(crons.length, 1, "the resurrection path is one entry, not a schedule");

  // The scan dispatch must not be able to end the chain, because it is the step most
  // likely to fail transiently.
  const scanStep = /- name: Wake the market scan\n([\s\S]*?)(?=\n      - name: )/.exec(pacer);
  assert.ok(scanStep);
  assert.match(scanStep[1], /::warning::/,
    "a failed scan dispatch is a warning, not a job failure");
});

test("pacer: the workflows it drives keep a heartbeat but no longer pretend to be scheduled", () => {
  const read = (name) => readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), "utf8");
  // Each of these is dispatched by the chain now, so its own schedule is a fallback for
  // the chain having stopped. Asking more often bought no extra runs -- measured -- so
  // one entry each is all that is left.
  for (const name of [
    "trading-market-scan.yml",
    "trading-paper-bot.yml",
    "trading-live-5050.yml",
    "polymarket-live-limit-order-test.yml",
  ]) {
    const body = read(name);
    const crons = body.match(/- cron: '[^']+'/g) || [];
    assert.equal(crons.length, 1, `${name} should keep exactly one heartbeat entry`);
    // A heartbeat, not a clock: no minute list and no step interval.
    assert.ok(!/- cron: '[^']*[,/]/.test(body),
      `${name} still asks for several runs an hour, which are not delivered`);
  }
});

// Reported: the scraping log showed runs clustered around midnight and then gaps of hours
// overnight -- 00:41 to 03:54 UTC with nothing scraped. That is GitHub's scheduler, which
// this repository gets at about 2%, and the pacer chain replaces it. But a chain of runs
// each dispatching the next is one failed request away from stopping, and a stopped clock
// is silent: recovery would fall back to the same 2% schedule and could wait until
// morning, reproducing the very gap it was built to end.
//
// So the chain is made hard to kill and easy to revive, and both halves are pinned here.
test("pacer: a stopped clock is restarted by the next scan, not left for the schedule", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../tools/dispatch-after-scan.mjs", import.meta.url), "utf8");
  const { pacerIsAlive } = await import("../tools/dispatch-after-scan.mjs");

  // A pacer spends nearly its whole life asleep inside a run, so a run in flight -- in any
  // of the states GitHub calls "not finished" -- means the clock is still ticking.
  assert.equal(pacerIsAlive([{ status: "in_progress" }]), true);
  assert.equal(pacerIsAlive([{ status: "queued" }]), true);
  assert.equal(pacerIsAlive([{ status: "waiting" }]), true);
  // Only finished runs means the chain has stopped, and a chain that stopped is the case
  // this exists for. Completed runs are the ordinary history of a healthy chain's past.
  assert.equal(pacerIsAlive([{ status: "completed" }, { status: "completed" }]), false);
  assert.equal(pacerIsAlive([]), false, "no runs at all is a stopped clock, not a healthy one");
  assert.equal(pacerIsAlive(null), false, "a malformed response must not read as alive");
  // A mixed page is alive: one link in flight is all it takes.
  assert.equal(pacerIsAlive([{ status: "completed" }, { status: "in_progress" }]), true);

  // The check runs after the executors are dispatched, so a watchdog failure can never
  // cost the run its actual work.
  assert.ok(source.indexOf("ensurePacerIsRunning") > source.indexOf("const failures = []"));
  // And it can never fail the scan: the data is already published by then.
  assert.match(source, /catch \(error\) \{\n\s*\/\/[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*console\.warn\(`Could not check or restart the pacer/);

  // The scan needs the permission to do it, or the watchdog is silently a no-op.
  const scan = await readFile(new URL("../../.github/workflows/trading-market-scan.yml", import.meta.url), "utf8");
  assert.match(scan, /permissions:\n(?:\s+\w+: \w+\n)*\s+actions: write/);
});

test("pacer: the hand-on is retried, because one refused request would stop the clock", async () => {
  const { readFile } = await import("node:fs/promises");
  const pacer = await readFile(new URL("../../.github/workflows/trading-pacer.yml", import.meta.url), "utf8");
  const handOn = pacer.slice(pacer.indexOf("- name: Hand the chain on"));

  assert.match(handOn, /for attempt in 1 2 3 4 5; do/, "the one request that carries the chain must be retried");
  assert.match(handOn, /sleep \$\(\( attempt \* 5 \)\)/, "retries must back off rather than hammer");
  assert.match(handOn, /--max-time 30/, "a hung request must not hold the job until its timeout");
  // Exhausting the retries must fail the run loudly. A silent give-up is what turns a
  // stopped clock into an unexplained overnight gap.
  assert.match(handOn, /::error::could not hand the chain on/);
  assert.match(handOn, /exit 1/);
  // And the success path must stop, or the loop would dispatch a successor five times.
  assert.match(handOn, /Handed on to tick \$\{next\}\."\n\s*exit 0/);
});

// Reported: a live order opened at 67 in a portfolio whose rule says min probability 70.
//
// Reproduced from the live configuration in that run's log -- LIVE_MIN_PROBABILITY 0.7,
// LIVE_MAX_PROBABILITY 0.85, LIVE_MAX_SPREAD 0.08, post-only limit orders. Qualification
// tests the market probability, which is Gamma's outcome price or the midpoint of the book;
// a post-only limit rests at the best bid. Those separate by the spread, so with an
// eight-point spread allowed, a market qualifying at exactly 70 rests its bid at 67 and
// opens three points under the floor the portfolio advertises. It is arithmetic, not luck.
test("live entry: the price actually submitted has to sit inside the portfolio band", () => {
  const { orderPriceBandRejection } = executor;
  const band = { min: 0.7, max: 0.85 };

  // The reported case, with the numbers from that run.
  const reported = orderPriceBandRejection(0.67, { ...band, spread: 0.08 });
  assert.ok(reported, "a bid three points under the floor must be refused");
  assert.match(reported, /67\.0%/);
  assert.match(reported, /8\.0-point spread/, "the reason must name the spread that caused it");
  assert.match(reported, /70\.0-85\.0%/, "and the band it broke");

  // The ceiling has the same fault mirrored: a taker entry pays the ask, which a wide book
  // can put above the top of the band.
  assert.ok(orderPriceBandRejection(0.88, band), "an ask above the ceiling must be refused too");
  // Inside the band, including exactly on either edge -- the bounds are inclusive, matching
  // the qualification test they now mirror.
  assert.equal(orderPriceBandRejection(0.7, band), null);
  assert.equal(orderPriceBandRejection(0.85, band), null);
  assert.equal(orderPriceBandRejection(0.78, band), null);

  // A portfolio with no ceiling is only bounded below, and says so.
  assert.equal(orderPriceBandRejection(0.99, { min: 0.7 }), null);
  assert.match(orderPriceBandRejection(0.5, { min: 0.7 }), /at least 70\.0%/);

  // An unusable price is refused rather than waved through as "not a number, not outside".
  for (const bad of [null, undefined, NaN, 0, 1, -0.5, "abc"]) {
    assert.ok(orderPriceBandRejection(bad, band), `${String(bad)} must not pass the band check`);
  }
  // With no floor configured there is no rule to break, and the check must not invent one.
  assert.equal(orderPriceBandRejection(0.67, { min: null }), null);
  assert.equal(orderPriceBandRejection(0.67, {}), null);
});

test("live entry: the band is checked against the submitted price, not the midpoint", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8");
  const bot = await readFile(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");

  // The check has to sit on `price` -- what orderPriceForBook returned, which is what the
  // order will carry -- and it has to run before the order is sized and submitted.
  const guard = source.indexOf("const outOfBand = spreadWithinLimit");
  assert.ok(guard > 0, "the submitted price must be band-checked");
  // A book too wide to trade is rejected for its spread, by the rule that owns that
  // limit. Measured on a live run: the two candidates that reached this point had spreads
  // of 25 and 14 points against an 8-point limit and were both reported as "outside the
  // portfolio band" -- true, but the band is a symptom of the spread, and naming it sent
  // the reader after the wrong setting. The band rejection is for a book the portfolio
  // would otherwise trade, where the price really is the disqualifier.
  assert.match(source, /const spreadWithinLimit = Number\.isFinite\(Number\(book\.spread\)\) && Number\(book\.spread\) <= MAX_SPREAD;/);
  assert.match(source, /const outOfBand = spreadWithinLimit\n\s+\? orderPriceBandRejection\(price, \{/,
    "a book wider than the limit must fall through to the spread rule, not answer as a band breach");
  assert.ok(guard > source.indexOf("const price = orderPriceForBook(book, tick"),
    "the check must come after the price is known");
  assert.ok(guard < source.indexOf("const orderSizing = sharesForOrder({"),
    "and before the order is sized, so a refused price never reaches the exchange");

  // Parity with the paper bot, which has always checked its band against the real entry:
  // a limit-order portfolio qualifies on the best bid it will rest at, not on the midpoint.
  // The two behaving differently on identical settings is the bug this closes.
  assert.match(bot, /if \(strategy\.useLimitOrders\) \{\n\s+const limitEntry = numericOrNaN\(item\.bestBid\);/,
    "the paper bot must still qualify a limit-order portfolio on its resting price");
});

// Reported: the run log showed the executor replacing a position while the portfolio had
// automatic rotation switched off.
//
// Confirmed from that run's own digest: LIVE_AUTO_ROTATE was false, and it still recorded
// `positionsReviewedForRotation=12, rotationAvailable=True` and an open-order decision of
// CANCELED_FOR_BETTER_CANDIDATE. The switch gated the position-rotation *action* and the
// wording around it, but not the review that produces those lines -- and it never gated
// the open-order path at all, which is the one that actually cancelled something.
test("auto-rotate off: nothing is swapped for something better on the machine's own initiative", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8");

  // Cancelling a resting order to fund a different one is a replacement whichever way it
  // is labelled: the portfolio ends up holding something it did not hold before, chosen
  // without being asked. With rotation off it must be declined, and say so.
  assert.match(source, /\} else if \(betterCandidate && betterCandidateNeedsReleasedCapital && !LIVE_AUTO_ROTATE\) \{/,
    "the open-order replacement path must respect the rotation switch");
  const declined = source.slice(source.indexOf("betterCandidateNeedsReleasedCapital && !LIVE_AUTO_ROTATE"));
  assert.match(declined.slice(0, 1200), /automatic rotation is off for this portfolio, so it is kept/,
    "and the run log must say why the order was kept");
  // The declining branch must come first, or the original one still fires.
  assert.ok(
    source.indexOf("betterCandidateNeedsReleasedCapital && !LIVE_AUTO_ROTATE")
      < source.indexOf('review.action = "CANCEL_FOR_BETTER_CANDIDATE";'),
    "the guard has to be evaluated before the cancellation it guards",
  );

  // The position review is skipped entirely rather than run and reported: with rotation
  // off it can act on nothing, so running it only spends exchange calls to fill the log
  // with replacements that will never happen.
  assert.match(source, /&& \(LIVE_AUTO_ROTATE \|\| needsRiskReplacement\)\n\s+&& \(needsCapitalRotation \|\| needsRiskReplacement\)/,
    "position rotation review must not run when rotation is off");

  // A risk replacement is the deliberate exception. It corrects a diversification breach
  // rather than chasing a better number, so it must survive the switch -- a portfolio
  // holding a conflicting position needs to be told regardless.
  assert.match(source, /needsRiskReplacement/);
  const gate = /const rotationReview = !ROTATION_COMPLETION_RUN[\s\S]*?: null;/.exec(source);
  assert.ok(gate, "the rotation review gate must be findable");
  assert.ok(gate[0].includes("LIVE_AUTO_ROTATE || needsRiskReplacement"),
    "a risk replacement must still be reviewed with rotation off");

  // Everything else the order review does is untouched: an expired or no-longer-qualifying
  // order still has to be dealt with, or turning rotation off would strand stale orders.
  assert.match(source, /expiredOrderWithdrawalReason/);
  assert.match(source, /KEEP_WAITING/);
});

// Asked, of a run that skipped while a candidate sat visibly on the dashboard: was it even
// evaluated? The digest could not say. It reported prefilterRejectedCandidates=1198 and
// nothing about which rule dropped them, so a candidate present on screen and absent from
// the run was unexplainable from the log -- which is the one question a SKIP actually
// raises. The grouping already existed and was computed on every run; it simply never
// left the diagnostics.
test("run digest: a candidate dropped before revalidation can be explained from the log", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8");
  const workflow = await readFile(
    new URL("../../.github/workflows/polymarket-live-limit-order-test.yml", import.meta.url), "utf8");

  // The grouped counts have to reach the payload the digest reads.
  // It has to sit inside the `counts` object, because that is the one the digest prints.
  // Publishing it into a neighbouring diagnostics object compiles, ships, and produces
  // exactly nothing in the log -- which is what happened on the first attempt, and a
  // pattern match on the field name alone was happy to confirm it.
  const countsBlock = /\n      counts: \{\n        storedEvaluations,[\s\S]*?\n      \},/.exec(source);
  assert.ok(countsBlock, "the run digest's counts object must be findable");
  assert.match(countsBlock[0], /prefilterRejectionReasons: candidatePool\.diagnostics\.reasonCounts,/,
    "the grouped prefilter reasons must be in the counts the digest reads");
  // And they are grouped, or a per-candidate number in the text makes one bucket each --
  // which is what once made this the dominant contributor to run-log size.
  assert.match(source, /function prefilterReasonCountKey\(reason\)/);

  // The digest must print them, on their own line: they are a dict, and folding a dict
  // into the comma-joined counts line makes it unreadable exactly when it matters.
  assert.match(workflow, /prefilter_reasons = counts\.pop\("prefilterRejectionReasons", None\)/,
    "the dict must be taken out of the inline counts line");
  assert.match(workflow, /print\("prefilter   : "/);
  // Sorted by size, so the rule that dropped the most candidates is read first.
  assert.match(workflow, /sorted\(prefilter_reasons\.items\(\), key=lambda kv: -int\(kv\[1\] or 0\)\)/);

  // The line only appears when there is something to say, so a clean run stays quiet.
  const block = workflow.slice(workflow.indexOf("prefilter_reasons ="));
  assert.match(block.slice(0, 700), /if prefilter_reasons:/);
});

// Reported, of a candidate that stayed on the dashboard across several runs while every
// one of those runs skipped with "all revalidated candidates failed current execution
// criteria": the match had already been played. The owner's reading was right -- the event
// had finished, Polymarket had simply not settled it yet -- and the two things missing were
// that the run log never said so, and that the row was never taken out of the candidate
// list, so the next run paid for the same live fetch to reach the same dead end.
test("finished events: a past-dated market with nothing left to quote is named and retired", () => {
  const { finishedAwaitingResolutionRejection, endDateHasPassed } = executor;
  const PAST = new Date(Date.now() - 3600000).toISOString();
  const FUTURE = new Date(Date.now() + 3600000).toISOString();

  // The two shapes a finished match takes on the exchange. An emptied book:
  const emptied = finishedAwaitingResolutionRejection({ endDate: PAST, price: null });
  assert.ok(emptied, "a past-dated market with no executable price is a finished event");
  assert.match(emptied, /already finished/, "the reason must say the event is over");
  assert.match(emptied, /waiting for Polymarket to publish its resolution/,
    "and that it is the resolution, not the market, that is outstanding");

  // ...and a book that converged instead of emptying: the winning side prices at ~1.00.
  const settled = finishedAwaitingResolutionRejection({
    endDate: PAST,
    price: 0.999,
    marketProbability: 0.9999,
  });
  assert.ok(settled, "a past-dated market priced at certainty is a finished event too");
  assert.match(settled, /already finished/);
  assert.match(settled, /100\.0%/, "the reason must name the price it settled at");

  // Neither half is terminal on its own, and that is the point of the pair.
  //
  // A past date alone must not retire anything: Gamma's end date is routinely a match
  // start or a stale estimate, and a market still quoting a tradable price is still
  // tradable. Retiring those is exactly the behaviour that keeping past-date candidates
  // was asked for.
  assert.equal(finishedAwaitingResolutionRejection({ endDate: PAST, price: 0.775, marketProbability: 0.775 }), null,
    "a past-dated market that still quotes a tradable price stays a candidate");

  // And a dead book on a market that has not reached its end date is transient -- books
  // refill, and a probability that spikes to 100% can come back down.
  assert.equal(finishedAwaitingResolutionRejection({ endDate: FUTURE, price: null }), null);
  assert.equal(finishedAwaitingResolutionRejection({ endDate: FUTURE, price: 0.999, marketProbability: 0.9999 }), null);

  // An unknown end date is evidence of nothing. `!endDateIsFuture()` answers true for it,
  // which would retire rows at random, so this deliberately does not reuse that helper.
  for (const unknown of [null, undefined, "", "not a date"]) {
    assert.equal(endDateHasPassed(unknown), false, `${String(unknown)} is not a passed end date`);
    assert.equal(finishedAwaitingResolutionRejection({ endDate: unknown, price: null }), null,
      `${String(unknown)} must not retire a candidate`);
  }
  assert.equal(endDateHasPassed(PAST), true);
  assert.equal(endDateHasPassed(FUTURE), false);
});

test("finished events: the verdict is terminal, logged, and closes the stored row out", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8");
  const persist = await readFile(new URL("../tools/persist-live-revalidation.py", import.meta.url), "utf8");

  // Both leaking branches must consult the rule. Before this, "no valid current entry
  // price" returned without marketGone, so the row was re-fetched and re-rejected on every
  // run for as long as it was retained -- forever, since nothing else would ever close it.
  const noPrice = source.slice(source.indexOf('rejectReasons: ["no valid current entry price"]') - 900,
    source.indexOf('rejectReasons: ["no valid current entry price"]'));
  assert.match(noPrice, /finishedAwaitingResolutionRejection\(\{ endDate: dateContext\.endDate, price \}\)/,
    "the empty-book branch must ask whether the event has finished");
  assert.match(noPrice, /marketGone: true/, "and mark that verdict terminal");

  const certainAt = source.indexOf(
    "if (marketProbability != null && marketProbability >= EFFECTIVELY_CERTAIN_MARKET_PROBABILITY) {");
  assert.ok(certainAt > 0, "the settled-price rejection must be findable");
  const certain = source.slice(certainAt, source.indexOf("const probability = PROBABILITY_SOURCE", certainAt));
  assert.match(certain, /finishedAwaitingResolutionRejection\(/,
    "the settled-price branch must ask the same question");
  assert.match(certain, /marketGone: Boolean\(finished\)/,
    "and stay non-terminal when the market has not reached its end date");

  // marketGone is what the persist step acts on, and it must survive into the update.
  const update = source.slice(source.indexOf("function liveRevalidationUpdate"),
    source.indexOf("function successfulCancelResponse"));
  assert.match(update, /awaitingResolution: Boolean\(item\?\.awaitingResolution\)/,
    "the stored row must record that it is awaiting a resolution, not delisted");
  assert.match(update, /marketGone \? "CLOSED"/, "a terminal verdict is stored as CLOSED");

  // The run has to say it tried. A capped rejection list is not enough on its own: the
  // count and the note are what a reader of a SKIP sees without opening the detail.
  assert.match(source, /finishedAwaitingResolutionCandidates: finishedAwaitingResolution\.length,/,
    "the run digest must count the finished events it evaluated");
  assert.match(source, /const finishedAwaitingResolution = checked\.filter\(\(item\) => item\?\.awaitingResolution\);/);
  assert.match(source, /No order could be placed on them and they are now marked closed/,
    "the note must say both that no order was possible and that the rows are now retired");
  // And the note must be attached to the skip explanation, not computed and dropped.
  assert.match(source, /all revalidated candidates failed current execution criteria\.\$\{finishedAwaitingResolutionNote\}/);

  // Finally the persist step, which is what actually removes it from the candidate list.
  assert.match(persist, /if update\.get\("awaitingResolution"\):/);
  assert.match(persist, /item\["closedReason"\] = "finished, awaiting Polymarket resolution"/);
});

// Reported of a run whose whole log read:
//   Action: REPLACED
//   Reason: market moved away; raise limit price closer to current post-only level by 2.0 pts
//   Note:   Live batch reviewed existing open limit orders before opening a new position.
// Which event? Which order for which? What was the probability before, and what now? None
// of it was there -- and "REPLACED" reads as a swap of one event for another, which a
// reprice is not: it cancels and reposts our own bid on the same market at a new price.
test("reprice log: the REPLACED reason names the market, the price move, and the probability", () => {
  const { repriceReason } = executor;
  const order = {
    price: 0.74,
    question: "Valorant: MIBR vs Evil Geniuses (BO3)",
    outcome: "Evil Geniuses",
    tokenId: "1234",
  };
  const revalidated = {
    orderPrice: 0.76,
    question: "Valorant: MIBR vs Evil Geniuses (BO3)",
    outcome: "Evil Geniuses",
    marketProbability: 0.775,
    currentBestBid: 0.76,
    currentBestAsk: 0.78,
  };

  const withHistory = repriceReason({
    order,
    revalidated,
    priceDelta: 0.02,
    ageHours: 3.2,
    previous: { currentEvaluation: { marketProbability: 0.74 } },
  });
  // The subject, which was missing entirely.
  assert.match(withHistory, /Evil Geniuses - Valorant: MIBR vs Evil Geniuses \(BO3\)/);
  // That it is a reprice and not a swap -- the reading the old wording invited.
  assert.match(withHistory, /same market and outcome/);
  assert.match(withHistory, /no event was swapped/i);
  // The price actually moved, both ends of it.
  assert.match(withHistory, /limit 0\.7400 -> 0\.7600 USDC/);
  assert.match(withHistory, /2\.0 pts/);
  // Probability before and now, which is what was asked for.
  assert.match(withHistory, /market probability 74\.0% -> 77\.5%/);
  assert.match(withHistory, /bid 0\.7600 \/ ask 0\.7800/);
  assert.match(withHistory, /unfilled for 3\.2h/);

  // With no earlier review of this order there is no honest "before", so only the current
  // reading is claimed rather than a comparison being invented from the stored evaluation
  // (which the persist step rewrites every run, and which therefore always reads as "now").
  const firstReview = repriceReason({ order, revalidated, priceDelta: 0.02, ageHours: 3.2, previous: null });
  assert.match(firstReview, /market probability now 77\.5%/);
  assert.doesNotMatch(firstReview, /->\s*77\.5%/);

  // The mirrored direction reads as a reprice down, not as "the market moved away".
  const down = repriceReason({
    order: { ...order, price: 0.78 },
    revalidated: { ...revalidated, orderPrice: 0.76 },
    priceDelta: -0.02,
    previous: null,
  });
  assert.match(down, /post-only level is 2\.0 pts lower/);
  assert.match(down, /limit 0\.7800 -> 0\.7600 USDC/);
});

test("reprice log: the run note says whether the portfolio's event actually changed", () => {
  const { openOrderActionExplanation } = executor;
  const selected = { question: "MIBR vs Evil Geniuses", outcome: "Evil Geniuses", tokenId: "1234" };

  const replaced = openOrderActionExplanation({ action: "REPLACED", selected, reviews: [selected] });
  assert.match(replaced, /Evil Geniuses - MIBR vs Evil Geniuses/);
  assert.match(replaced, /same market and the same outcome/);
  assert.match(replaced, /did not move to a different event/);
  assert.match(replaced, /1 open limit order was reviewed/);

  // The one action that DOES change which event is bid on has to read differently, or the
  // note is no better than the text it replaced.
  const swapped = openOrderActionExplanation({
    action: "CANCELED_FOR_BETTER_CANDIDATE",
    selected: { ...selected, replacementCandidate: { question: "T1 vs GenG", outcome: "T1" } },
    reviews: [selected, selected],
  });
  assert.match(swapped, /T1 - T1 vs GenG/);
  assert.match(swapped, /does change which event/);
  assert.match(swapped, /2 open limit orders were reviewed/);

  // A rejected replacement must not read as a completed one.
  assert.match(openOrderActionExplanation({ action: "REPLACE_REJECTED_ORDER_RESTORED", selected, reviews: [] }),
    /refused by the exchange.*original order was restored/s);
  assert.match(openOrderActionExplanation({ action: "REPLACE_REJECTED_ORDER_RESTORE_FAILED", selected, reviews: [] }),
    /currently unbid/);
});

// Reported alongside it: the same run showed a "Position rotation" section full of
// KEEP_WAITING lines on a portfolio whose rotation switch is OFF. Position rotation never
// ran -- the executor gates it on that switch. rotationComparison carries the OPEN-ORDER
// reviews too, under kind "order", and the detail view fell back to the whole list
// whenever there was no rotation review. So order rows were printed under a heading that
// claimed the portfolio had been weighing position swaps.
test("run detail: open-order reviews are not reported as position rotation", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");
  const { rotationComparisonRows } = executor;

  // The two kinds really do share one array, which is what made the confusion possible.
  const rows = rotationComparisonRows(null, [{
    action: "KEEP_WAITING",
    reason: "still eligible and price gap 0.5 pts is below reprice threshold",
    currentEvaluation: { question: "MIBR vs Evil Geniuses", outcome: "Evil Geniuses", netGainIfWinUsdc: 1 },
    betterCandidate: null,
  }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "order", "an open-order review is carried in the rotation comparison array");

  // The position section must select on kind, and it must be the assignment that does it --
  // a filter defined elsewhere in the file would satisfy a bare name match while the
  // section still printed order rows.
  const assignment = /const rotationSummary = rotationReview[\s\S]*?;\n/.exec(app);
  assert.ok(assignment, "the rotation summary assignment must be findable");
  assert.match(assignment[0], /rotationPositionComparison/,
    "the position section must read position rows only");
  assert.match(app, /const rotationPositionComparison = rotationComparison\.filter\(\(item\) => item\.kind !== "order"\);/);
  assert.match(app, /const rotationOrderComparison = rotationComparison\.filter\(\(item\) => item\.kind === "order"\);/);

  // Rotation off with nothing reviewed must say so, rather than borrowing another section's
  // rows to look busy.
  assert.match(assignment[0], /settings\.liveAutoRotate === false/);
  assert.match(assignment[0], /automatic rotation is off for this portfolio/);

  // And the order rows keep their comparison, under a heading that owns them.
  assert.match(app, /lines\.push\("", "Open-order comparison", orderComparisonSummary\);/);
  const pushes = app.slice(app.indexOf('lines.push("", "Open orders"'), app.indexOf('lines.push("", "Risk diversification"'));
  assert.ok(pushes.indexOf("Open-order comparison") < pushes.indexOf("Position rotation"),
    "the order comparison belongs with the open orders, before the position section");
});

// A dispatch asking for a dry run placed a real order. Measured from the run's own env
// dump: live_confirm was sent as the string "false" and the step still resolved
// POLYMARKET_DRY_RUN to false, so the executor ran with --confirm-live and Polymarket
// accepted a $5 bid. The REST API sends every workflow input as a string, and a non-empty
// string is truthy in a GitHub expression -- so the safety switch failed open for every
// dispatch made through the API rather than the UI checkbox.
//
// It sat latent because every earlier API dispatch skipped for want of an eligible
// candidate. The first run that found one traded.
test("live workflows: the dry-run switch cannot be defeated by a string input", async () => {
  const { readFile } = await import("node:fs/promises");
  const files = [
    "../../.github/workflows/polymarket-live-limit-order-test.yml",
    "../../.github/workflows/trading-live-5050.yml",
  ];

  for (const file of files) {
    const workflow = await readFile(new URL(file, import.meta.url), "utf8");
    const guards = [...workflow.matchAll(/POLYMARKET_DRY_RUN: \$\{\{([^\n]*)\}\}/g)].map((m) => m[1]);
    assert.ok(guards.length > 0, `${file}: the dry-run switch must be findable`);

    for (const guard of guards) {
      // The bare truthiness test is the fault. It must not appear in any form that could
      // let a string through.
      assert.doesNotMatch(guard, /&&\s*inputs\.live_confirm\s*\)/,
        `${file}: a bare inputs.live_confirm is truthy for the string "false"`);
      // Both halves are required: `== true` alone misses the string "true" that the API
      // sends, and the bare value alone accepts "false".
      assert.match(guard, /inputs\.live_confirm == true/, `${file}: must accept the UI's boolean`);
      assert.match(guard, /inputs\.live_confirm == 'true'/, `${file}: must accept the API's string`);
    }
  }

  // The truth table the expression has to satisfy, evaluated the way GitHub evaluates it:
  // `==` casts a string to a number when the other side is a boolean, so 'true' and 'false'
  // are both NaN against a boolean and only the string comparison can match them.
  const asksForLive = (value) => (value === true) || (value === "true");
  assert.equal(asksForLive(true), true, "UI checkbox ticked");
  assert.equal(asksForLive("true"), true, "API dispatch asking for a live order");
  assert.equal(asksForLive(false), false, "UI checkbox unticked");
  assert.equal(asksForLive("false"), false, "the dispatch that placed a real order");
  assert.equal(asksForLive(""), false, "an absent input must never mean live");
  assert.equal(asksForLive(undefined), false);
});
