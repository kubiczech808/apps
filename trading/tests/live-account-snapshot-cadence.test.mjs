// Runs offline: the executor's real export, and the workflow's own step conditions. No
// network, no credentials, no orders.
//
// Measured on live execution run 35264749578 (self-hosted Pi runner, 46 seconds of job
// time): three account snapshots took 32 of them -- 11s before the pass, 12s after it, 9s
// after the rotation check -- while the decision and the order submission together took 1
// second. That pass submitted nothing and cancelled nothing, so the second and third
// snapshots refetched the balance and the open orders to find them exactly as the first had
// recorded them half a minute earlier.
//
// Asked for: "chtel bych zaroven, aby u live portfolia dochazelo ke kontrole dostupnych
// kandidatu casteji nez s kazdym scrapingem. treba kazdou minutu." A pass cannot run every
// minute while two thirds of it is spent asking an unchanged account what it holds.
//
// The risk in skipping them is real and worth stating: a resting order filled DURING the
// run is noticed by the next snapshot, so the published account can be one pass stale. At a
// one-minute cadence that is one minute. What must never happen is skipping a refresh after
// this run itself changed something -- that publishes an account missing an order it just
// placed -- so the tests below are mostly about the cases that must still refresh.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const { executionTouchedAccount } = await import("../tools/live-order-executor.mjs");
const EXECUTOR = readFileSync(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8");
const WORKFLOW = readFileSync(
  new URL("../../.github/workflows/polymarket-live-limit-order-test.yml", import.meta.url), "utf8");

test("a pass that placed an order refetches the account", () => {
  assert.equal(executionTouchedAccount({ action: "SUBMIT", accountMutated: true }), true);
});

test("a pass that only looked does not", () => {
  // The common case by far, and the whole saving: ~21 seconds of a 46-second job.
  assert.equal(executionTouchedAccount({ action: "SKIP", accountMutated: false }), false);
});

test("silence means refresh", () => {
  // A state written by an older build carries no flag, and one the executor never got to
  // write carries the PREVIOUS run's answer or nothing at all. None of those three says
  // this run changed nothing, and reading silence as "nothing changed" is how an account
  // that just placed an order gets published without it.
  assert.equal(executionTouchedAccount(null), true, "no state at all");
  assert.equal(executionTouchedAccount({}), true, "a state from before the flag existed");
  assert.equal(executionTouchedAccount({ action: "SKIP" }), true, "a SKIP is not evidence either");
  assert.equal(executionTouchedAccount({ accountMutated: "false" }), true,
    "a string is not the flag: JSON from anywhere else must not decide this");
  assert.equal(executionTouchedAccount("nonsense"), true);
});

test("the flag is set where the account is actually changed", () => {
  // Not at the decision sites -- there are dozens of those and a new one would be added
  // without the flag. It is set in the two functions every account-changing request goes
  // through, which is what makes it complete rather than merely correct today.
  const submit = EXECUTOR.slice(EXECUTOR.indexOf("async function submitOrder(order) {"));
  assert.match(submit.slice(0, submit.indexOf("\n}\n")), /accountMutated = true;/,
    "every submission goes through submitOrder");

  const cancel = EXECUTOR.slice(EXECUTOR.indexOf("async function cancelOrder(order, tradingConfig = {}) {"));
  const cancelBody = cancel.slice(0, cancel.indexOf("\n}\n"));
  assert.match(cancelBody, /accountMutated = true;/, "and every cancel through cancelOrder");
  // After the dry-run return, not before it: a dry run sends nothing and must not cause a
  // refetch, which would put the cost straight back for every non-live pass.
  assert.ok(cancelBody.indexOf("dry_run_cancel") < cancelBody.indexOf("accountMutated = true;"),
    "a dry run changes nothing and must not claim to");

  // And it has to reach the state file, or the workflow has nothing to read.
  assert.match(EXECUTOR, /\n    accountMutated,\n/, "the emitted state carries the flag");
});

test("the workflow skips only the two snapshots that follow a run that did nothing", () => {
  // The first snapshot is unconditional and must stay so: the pass decides against it.
  const first = WORKFLOW.indexOf("- name: Generate fresh live account snapshot");
  assert.ok(first > 0);
  assert.doesNotMatch(WORKFLOW.slice(first, WORKFLOW.indexOf("- name:", first + 10)), /if:/,
    "the pass must always start from a fresh account");

  const step = (name) => {
    const start = WORKFLOW.indexOf(`- name: ${name}`);
    assert.ok(start > 0, `${name} must exist`);
    return WORKFLOW.slice(start, WORKFLOW.indexOf("\n      - name:", start + 1));
  };

  // Conditional on the executor's own report AND on the execution having finished cleanly.
  const afterExecution = step("Refresh live account snapshot after execution");
  assert.match(afterExecution, /if: always\(\) && \(steps\.touched\.outputs\.touched != 'false' \|\| steps\.execute\.outcome != 'success'\)/);

  // != 'false', not == 'true': a step that failed to produce an output at all leaves it
  // empty, and an empty output must mean refresh.
  assert.doesNotMatch(afterExecution, /touched == 'true'/,
    "an absent output must fall on the refreshing side");

  const afterRotation = step("Refresh live account snapshot after rotation check");
  // Two gates, and the rotation switch is the outer one -- see "a pass does only what this
  // portfolio has switched on" below for why it is there at all.
  assert.match(afterRotation, /steps\.rotation\.outputs\.replaced == 'true'/);
  // Here the opposite default is right: this one exists solely to record a replacement
  // order, and the rotation step announces that it placed one.
  const rotation = step("Complete filled rotation immediately");
  assert.match(rotation, /id: rotation/);
  assert.match(rotation, /echo "replaced=true" >> "\$GITHUB_OUTPUT"/);
  // Written before the replacement runs, not after: a replacement that dies mid-submission
  // is exactly when the account must be refetched.
  assert.ok(rotation.indexOf("replaced=true") < rotation.indexOf("npm run live:execute"),
    "a replacement that fails halfway must still refresh");

  // And the deciding step reads the executor's function rather than restating the rule.
  const touched = step("Check whether this pass touched the exchange");
  assert.match(touched, /id: touched/);
  assert.match(touched, /executionTouchedAccount/);
  assert.match(touched, /tools\/live-order-executor\.mjs/);
});

test("5050 pays the same cost and gets the same treatment", () => {
  // It rests bids on the same wallet from the same runner, and its single refresh after the
  // pass is the same ten seconds spent on an account nothing touched. A fix applied to one
  // live portfolio and not the other is how 5050 ended up without a persist step at all.
  const fixed = readFileSync(
    new URL("../../.github/workflows/trading-live-5050.yml", import.meta.url), "utf8");
  const start = fixed.indexOf("- name: Refresh live account snapshot");
  assert.ok(start > 0);
  const refresh = fixed.slice(start, fixed.indexOf("\n      - name:", start + 1));
  assert.match(refresh, /if: always\(\) && \(steps\.touched\.outputs\.touched != 'false' \|\| steps\.execute\.outcome != 'success'\)/);
  assert.match(fixed, /- name: Check whether this pass touched the exchange/);
  assert.match(fixed, /executionTouchedAccount/);
  // The deciding step reads the state file this portfolio writes, not the other one's.
  assert.match(fixed, /LIVE_EXECUTION_STATE_PATH: data\/live-5050-execution-state\.json/);
  // And its own execution step has to be identifiable, or the outcome check names nothing.
  const executeStep = fixed.slice(fixed.indexOf("- name: Rest the fixed-entry bids"));
  assert.match(executeStep.slice(0, executeStep.indexOf("\n      - name:")), /id: execute/);
});

test("a pass does only what this portfolio has switched on", () => {
  // Asked for, after reading the step timings: "rotaci nemam zapnutou snad pro zadne
  // portfolio, tu z toho muzes vyloucit jednuchou podminkou (mozna se k ni nekdy vratim,
  // ale zatim se neosvedcila, takze logiku nechavam, jen to nepouzivam)."
  //
  // So the rotation steps are gated on the portfolio's OWN switch rather than deleted. The
  // logic stays; turning autoRotatePositions back on in the parameter form brings it back
  // with no workflow edit, which is what "mozna se k ni nekdy vratim" needs.
  const step = (name) => {
    const start = WORKFLOW.indexOf(`- name: ${name}`);
    assert.ok(start > 0, `${name} must exist`);
    return WORKFLOW.slice(start, WORKFLOW.indexOf("\n      - name:", start + 1));
  };
  assert.match(step("Complete filled rotation immediately"),
    /if: always\(\) && env\.LIVE_AUTO_ROTATE != 'false'/);
  assert.match(step("Refresh live account snapshot after rotation check"),
    /env\.LIVE_AUTO_ROTATE != 'false'/);
  // The switch has to reach the environment from the portfolio, or the gate above is a
  // constant: "Load portfolio config" writes it from autoRotatePositions.
  assert.match(WORKFLOW, /"LIVE_AUTO_ROTATE": str\(bool\(live\.get\("autoRotatePositions", True\)\)\)\.lower\(\)/);

  // The MySQL mirror is skipped on a pass that changed nothing. A run that decided nothing
  // has the same rows to mirror as the run before it, and at a three-minute cadence that is
  // two seconds spent every pass to write what is already there.
  assert.match(step("Mirror live execution to Trading MySQL"),
    /if: always\(\) && \(steps\.touched\.outputs\.touched != 'false' \|\| steps\.execute\.outcome != 'success'\)/);
});
