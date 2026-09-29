import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const API = readFileSync(new URL("../api.php", import.meta.url), "utf8");
const WORKER = readFileSync(new URL("../tools/rpi-live-exit-worker.mjs", import.meta.url), "utf8");
const LIVE_WORKFLOW = readFileSync(
  new URL("../../.github/workflows/polymarket-live-limit-order-test.yml", import.meta.url),
  "utf8",
);
const FIXED_WORKFLOW = readFileSync(
  new URL("../../.github/workflows/trading-live-5050.yml", import.meta.url),
  "utf8",
);

test("a direct DIP fill uses a ledger that executor uploads cannot overwrite", () => {
  assert.match(API, /function live_dip_entry_ownership_path\(\): string/);
  assert.match(API, /live-dip-entry-ownership\.json/);
  assert.match(API, /function live_dip_entry_ownership_records\(\): array/);
  assert.match(API, /foreach \(live_dip_entry_ownership_records\(\) as \$record\)/);
  assert.match(API, /function live_portfolio_ownership_map\(array \$config\): array/,
    "DIP ownership must be shared by the exit policy and the account response");
  assert.match(API, /'dip-entry-ledger'/);
  const recorder = API.slice(
    API.indexOf("function record_live_dip_entry_ownership"),
    API.indexOf("// Which run records say", API.indexOf("function record_live_dip_entry_ownership")),
  );
  assert.match(recorder, /\$path = live_dip_entry_ownership_path\(\)/);
  assert.doesNotMatch(recorder, /live_execution_state_path_for_policy/,
    "direct fills must not write an executor state that the next upload replaces");
});

test("the live state decorates tokenized rows with durable ownership", () => {
  const state = API.slice(
    API.indexOf("function live_state_apply_portfolio_ownership"),
    API.indexOf("function live_entry_claim_key", API.indexOf("function live_state_apply_portfolio_ownership")),
  );
  assert.match(state, /\['positions', 'apiPositions', 'resolvedApiPositions', 'closedTrades', 'openOrders', 'unfilledLimitOrders'\]/);
  assert.match(state, /\['portfolioId'\] = \$ownerOf\[\$tokenId\]/);
  assert.match(state, /live_portfolio_ownership_map\(load_portfolio_config\(\)\)/);
  assert.match(state, /portfolioOwnershipSource/);
});

test("a position without durable ownership is excluded rather than given the base live stop", () => {
  const policy = API.slice(
    API.indexOf("function live_stop_loss_policy_payload"),
    API.indexOf("function workflow_target_key", API.indexOf("function live_stop_loss_policy_payload")),
  );
  assert.match(policy, /no durable portfolio ownership; automatic exits withheld/);
  assert.match(policy, /'defaultPolicy' => null/);
  assert.doesNotMatch(policy, /'source' => 'open-position'/,
    "an unknown position must never be silently adopted by a different portfolio");
});

test("an interrupted ownership acknowledgement is retried without placing another DIP order", () => {
  assert.match(WORKER, /function recoverDipEntryOwnershipFromHistory/);
  assert.match(WORKER, /\["DIP_ENTRY_SUBMITTED", "DIP_ENTRY_OWNERSHIP_RECORD_FAILED"\]\.includes\(event\.type\)/,
    "only confirmed historical fills, including a failed acknowledgement, may be backfilled");
  assert.match(WORKER, /async function retryPendingDipEntryOwnership/);
  assert.match(WORKER, /pendingDipEntryOwnership/);
  assert.match(WORKER, /recoverDipEntryOwnershipFromHistory\(context\);/);
  assert.match(WORKER, /await retryPendingDipEntryOwnership\(context\);/);
  const fire = WORKER.slice(WORKER.indexOf("async function fireDipEntries"), WORKER.indexOf("// ---------------------------------------------------------------------------------------", WORKER.indexOf("async function fireDipEntries")));
  assert.match(fire, /DIP_ENTRY_OWNERSHIP_RECORD_FAILED/);
  assert.match(fire, /pending\[ownershipKey\]/);
  assert.equal((fire.match(/submitDipEntry\(plan, book, cash\)/g) || []).length, 1,
    "retrying ownership must never repeat the already-filled buy");
});

test("an accepted DIP acknowledgement is confirmed against the account before it is rejected or attributed", () => {
  assert.match(WORKER, /export function dipEntryPendingMatch/);
  assert.match(WORKER, /function recoverPendingDipEntryFillsFromHistory/);
  assert.match(WORKER, /function pendingDipEntryMatchesAccountRow/);
  assert.match(WORKER, /async function reconcilePendingDipEntryFills/);
  assert.match(WORKER, /const confirmed = new Set\(events/,
    "a recovered historical acknowledgement must be confirmed once, not on every worker pass");
  assert.match(WORKER, /dipEntryConfirmationKey/);
  assert.match(WORKER, /\["DIP_ENTRY_REJECTED", "DIP_ENTRY_PENDING_MATCH"\]\.includes\(event\.type\)/,
    "a historical rejection may be repaired only after account-side confirmation");
  assert.match(WORKER, /DIP_ENTRY_ACCOUNT_CONFIRMED/);
  const fire = WORKER.slice(WORKER.indexOf("async function fireDipEntries"), WORKER.indexOf("// ---------------------------------------------------------------------------------------", WORKER.indexOf("async function fireDipEntries")));
  assert.match(fire, /type: filled \? "DIP_ENTRY_SUBMITTED" : \(pendingMatch \? "DIP_ENTRY_PENDING_MATCH" : "DIP_ENTRY_REJECTED"\)/);
  assert.match(fire, /context\.liveStateFetchedAt = 0/,
    "a pending acknowledgement forces an account refresh before another decision");
});

test("live scheduling is restored, but only an explicit confirmation or a scheduler can trade", () => {
  for (const workflow of [LIVE_WORKFLOW, FIXED_WORKFLOW]) {
    assert.match(workflow, /^\s*schedule:\s*$/m, "the recovery heartbeat must remain scheduled");
    assert.doesNotMatch(workflow, /POLYMARKET_DRY_RUN:\s*'true'/,
      "the emergency dry-run lock must not silently disable all execution");
    assert.match(workflow, /POLYMARKET_DRY_RUN: \$\{\{/);
    assert.doesNotMatch(workflow, /github\.event_name == 'push'.*?'false'/,
      "a code push must never be a live-money execution trigger");
  }
});
