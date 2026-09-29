import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const WORKER = readFileSync(new URL("../tools/rpi-live-exit-worker.mjs", import.meta.url), "utf8");
const API = readFileSync(new URL("../api.php", import.meta.url), "utf8");

test("DIP buys carry their owner to the final server-side Automation check", () => {
  assert.match(WORKER, /const claimContext = \{ portfolioId: String\(plan\.portfolioId \|\| ""\), entryKind: "dip-entry" \};/);
  assert.match(WORKER, /claimLiveEntry\(plan\.tokenId, claimId, claimContext\)/);
  assert.match(API, /function live_dip_entry_claim_admission_reason\(string \$portfolioId\): \?string/);
  assert.match(API, /\(\$portfolio\['automationEnabled'\] \?\? true\) !== true/);
  assert.match(API, /if \(\$operation === 'claim' && \$entryKind === 'dip-entry'\) \{[\s\S]*?live_dip_entry_claim_admission_reason\(\$portfolioId\)/);
});

test("the retained watch distinguishes a fallen market from a disabled portfolio", () => {
  assert.match(WORKER, /const activePortfolioIds = Array\.isArray\(payload\?\.activePortfolioIds\)/);
  assert.match(WORKER, /if \(!activePortfolioIds\.has\(String\(plan\?\.portfolioId \|\| ""\)\)\) merged\.delete\(key\);/);
  assert.match(API, /'activePortfolioIds' => array_keys\(\$active\)/);
  assert.match(API, /'activePortfolioIds' => \[\]/);
});
