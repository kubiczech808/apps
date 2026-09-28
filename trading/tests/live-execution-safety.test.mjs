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
  const recorder = API.slice(
    API.indexOf("function record_live_dip_entry_ownership"),
    API.indexOf("// Which run records say", API.indexOf("function record_live_dip_entry_ownership")),
  );
  assert.match(recorder, /\$path = live_dip_entry_ownership_path\(\)/);
  assert.doesNotMatch(recorder, /live_execution_state_path_for_policy/,
    "direct fills must not write an executor state that the next upload replaces");
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
  assert.match(WORKER, /async function retryPendingDipEntryOwnership/);
  assert.match(WORKER, /pendingDipEntryOwnership/);
  assert.match(WORKER, /await retryPendingDipEntryOwnership\(context\);/);
  const fire = WORKER.slice(WORKER.indexOf("async function fireDipEntries"), WORKER.indexOf("// ---------------------------------------------------------------------------------------", WORKER.indexOf("async function fireDipEntries")));
  assert.match(fire, /DIP_ENTRY_OWNERSHIP_RECORD_FAILED/);
  assert.match(fire, /pending\[ownershipKey\]/);
  assert.equal((fire.match(/submitDipEntry\(plan, book, cash\)/g) || []).length, 1,
    "retrying ownership must never repeat the already-filled buy");
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
