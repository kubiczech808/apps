import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const STORAGE = readFileSync(new URL("../storage.php", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const API = readFileSync(new URL("../api.php", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const WORKFLOW = readFileSync(
  new URL("../../.github/workflows/trading-archive-resolved-observations.yml", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");

test("only durable terminal proof can turn an old scraped row into a resolved archival candidate", () => {
  const start = STORAGE.indexOf("function trading_storage_payload_proves_resolved");
  assert.ok(start >= 0, "the storage layer must prove settlement before changing lifecycle");
  const body = STORAGE.slice(start, STORAGE.indexOf("\n}\n", start) + 2);
  assert.match(body, /finalOutcomePrice/);
  assert.match(body, /price <= 0\.001 \|\| \$price >= 0\.999/);
  assert.match(body, /marketClosed/);
  assert.doesNotMatch(body, /endDate/, "an estimated end date must never settle a market");
});

test("reconciliation preserves historical ordering and exposes one guarded storage operation", () => {
  const start = STORAGE.indexOf("function trading_storage_reconcile_resolved_observations");
  assert.ok(start >= 0);
  const body = STORAGE.slice(start, STORAGE.indexOf("\n}\n", start) + 2);
  assert.match(body, /ORDER BY updated_at ASC/);
  assert.match(body, /updated_at = :updatedAt/);
  assert.doesNotMatch(body, /resolvedAt\s*=/, "the repair must not rewrite the resolved timestamp");
  assert.match(API, /operation === 'reconcile-resolved-observations'/);
});

test("the scheduled archive reconciles stale terminal rows first and keeps a seven-day live window", () => {
  const reconcileAt = WORKFLOW.indexOf("Reconcile terminal snapshots before archival");
  const archiveAt = WORKFLOW.indexOf("Archive settled observations, verifying before each delete");
  assert.ok(reconcileAt >= 0 && archiveAt > reconcileAt, "reconciliation must run before archival");
  assert.match(WORKFLOW, /"operation": "reconcile-resolved-observations"/);
  assert.match(WORKFLOW, /KEEP_DAYS: \$\{\{ github\.event\.inputs\.keep_days \|\| '7' \}\}/);
});
