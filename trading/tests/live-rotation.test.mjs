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
    /\(upsideExhausted\s*\n\s*\|\| \(!candidateResolvesLater\s*\n\s*&& priorityDelta >= ROTATION_MIN_PRIORITY_IMPROVEMENT/,
    "exhausted upside still releases capital regardless of horizons",
  );
  // The horizon comparison must use the unfloored value.
  assert.match(source, /const positionRemainingDays = number\(economics\.rawRemainingDays\);/);
  assert.ok(source.includes("selling now would forfeit a nearer payout for a more distant one"));
});

test("rotation: ranking decides on its own, not gated by a separate absolute-USD requirement", async () => {
  // The user's point: a shorter-horizon candidate can legitimately rank higher on p.a.
  // while paying fewer raw dollars than the position/order it would replace. Requiring
  // the absolute USD result to ALSO improve meant the portfolio kept a worse-ranked
  // position purely because it happened to be a bigger single payout -- ranking alone
  // must decide, once the position clears the veto and the minimum-improvement floor.
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8");

  assert.match(
    source,
    /\(!candidateResolvesLater\s*\n\s*&& priorityDelta >= ROTATION_MIN_PRIORITY_IMPROVEMENT\)\)/,
    "position rotation must not also require evDelta > 0",
  );
  assert.ok(!/&& evDelta > 0\s*\n\s*&& priorityDelta/.test(source), "the old absolute-USD gate must be gone, not just reordered");

  // Open orders must use the same ranking-metric threshold as positions, not a
  // dollar EV margin -- the two paths were inconsistent before this fix.
  assert.match(
    source,
    /comparison\?\.replacementRanksAhead\s*\n\s*&& Number\(comparison\.metricDelta \|\| 0\) >= ROTATION_MIN_PRIORITY_IMPROVEMENT/,
    "open-order replacement must gate on the ranking metric, not an unrelated dollar EV margin",
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
  // A hardcoded baseline outranks the stored one on purpose: the stored value on the
  // hosting is the corrupted 33.36 from the old inference, and a fix that only applied
  // to fresh state would never have reached it.
  assert.match(sync, /const DEFAULT_ORIGINAL_VALUE_USDC = \d+(\.\d+)?;/);
  assert.match(sync, /originalValueSource: number\(process\.env\.LIVE_ORIGINAL_VALUE_USDC\) > 0/);

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
  assert.match(source, /const scheduledIsFuture = Number\.isFinite\(scheduledTime\) && scheduledTime > Date\.now\(\);/);
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

  // And the workflow must actually write that status back, or the loop never closes.
  const { readFile } = await import("node:fs/promises");
  const workflow = await readFile(new URL("../../.github/workflows/polymarket-live-limit-order-test.yml", import.meta.url), "utf8");
  assert.match(workflow, /if update\.get\("marketGone"\):/);
  assert.match(workflow, /item\["status"\] = "CLOSED"/);
  assert.match(workflow, /item\["acceptingOrders"\] = False/);
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
  assert.match(app, /function latestLiveExecutionVerdict\(item\)/);
  assert.match(app, /const executionCheck = latestLiveExecutionVerdict\(item\);/);

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
  const eligibleFields = {
    aiProbability: 0.97,
    annualizedReturn: 0.4,
    expectedValueUsdc: 0.3,
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

test("live candidates: liquidity and net-profit reject reasons collapse into one bucket each, not one per value", () => {
  // Both reason strings carry a per-candidate number (a USDC amount, a percentage).
  // Left ungrouped, every distinct value became its own bucket -- for liquidity
  // specifically this turned one homogeneous rejection reason into thousands of
  // one-off entries in production, which was most of a run's console/log output.
  const eligibleFields = {
    aiProbability: 0.97,
    annualizedReturn: 0.4,
    expectedValueUsdc: 0.3,
    netYield: 0.08,
    liquidity: 60000,
    daysToResolution: 0.3,
    status: "EVALUATED",
  };
  // Default thresholds with no env override (see MIN_VOLUME_24H/MIN_NET_YIELD in the
  // source): liquidity must be below 100, net yield below 0.
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
  const liquidityKeys = Object.keys(counts).filter((key) => /liquidity/i.test(key));
  const yieldKeys = Object.keys(counts).filter((key) => /net profit/i.test(key));
  assert.equal(liquidityKeys.length, 1, `expected one grouped liquidity bucket, got ${JSON.stringify(liquidityKeys)}`);
  assert.equal(counts[liquidityKeys[0]], 5);
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
