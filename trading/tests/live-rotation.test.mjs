// Runs offline: no secrets, no network, no hosting access. Importing the executor
// does not start a run, so no order can be placed from a test.
import assert from "node:assert/strict";
import test from "node:test";

const executor = await import("../tools/live-order-executor.mjs");

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
    /\(upsideExhausted\s*\n\s*\|\| \(!candidateResolvesLater\s*\n\s*&& evDelta > 0/,
    "exhausted upside still releases capital regardless of horizons",
  );
  // The horizon comparison must use the unfloored value.
  assert.match(source, /const positionRemainingDays = number\(economics\.rawRemainingDays\);/);
  assert.ok(source.includes("selling now would forfeit a nearer payout for a more distant one"));
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
  const workflow = await readFile(
    new URL("../../.github/workflows/polymarket-live-limit-order-test.yml", import.meta.url), "utf8");
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
  assert.match(sync, /originalValueSource: configuredOriginalValueUsdc > 0/);

  // Both workflows that sync the account must pass the baseline through.
  for (const name of ["polymarket-live-limit-order-test", "trading-live-account"]) {
    const workflow = await readFile(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), "utf8");
    assert.match(workflow, /LIVE_ORIGINAL_VALUE_USDC: \$\{\{ vars\.LIVE_ORIGINAL_VALUE_USDC \}\}/,
      `${name} must pass the configured baseline`);
    assert.match(workflow, /LIVE_ADDITIONAL_DEPOSIT_ID: \$\{\{ vars\.LIVE_ADDITIONAL_DEPOSIT_ID \}\}/);
  }
});
