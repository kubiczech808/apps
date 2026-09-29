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

test("an accepted DIP claim is a durable ownership fallback, never a cross-portfolio recovery guess", () => {
  assert.match(API, /strtolower\(trim\(\(string\) \(\$record\['entryKind'\] \?\? ''\)\)\) !== 'dip-entry'/);
  assert.match(API, /strtolower\(trim\(\(string\) \(\$record\['status'\] \?\? ''\)\)\) !== 'accepted'/);
  assert.match(API, /'live-entry-claim'/);
  assert.match(WORKER, /return String\(record\.tokenId \|\| ""\);/,
    "one shared-account token can be confirmed for only one DIP portfolio");
  assert.match(WORKER, /!event\.claimId\) continue;/,
    "historical events without a claim remain unattributed rather than being guessed");
  assert.match(WORKER, /return \{ \.\.\.response, \.\.\.quote, claimId \};/,
    "new recovery evidence contains the immutable server claim id");
});
