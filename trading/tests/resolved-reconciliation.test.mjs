import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const STORAGE = readFileSync(new URL("../storage.php", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const API = readFileSync(new URL("../api.php", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const WORKFLOW = readFileSync(
  new URL("../../.github/workflows/trading-archive-resolved-observations.yml", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");
const RESOLUTION_WORKER = readFileSync(
  new URL("../tools/reconcile-observation-resolutions.mjs", import.meta.url), "utf8",
).replace(/\r\n/g, "\n");
const RESOLUTION_WORKFLOW = readFileSync(
  new URL("../../.github/workflows/trading-reconcile-observation-resolutions.yml", import.meta.url), "utf8",
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

test("reconciliation preserves the first terminal timestamp and exposes guarded storage operations", () => {
  const start = STORAGE.indexOf("function trading_storage_reconcile_resolved_observations");
  assert.ok(start >= 0);
  const body = STORAGE.slice(start, STORAGE.indexOf("\n}\n", start) + 2);
  assert.match(body, /ORDER BY updated_at ASC/);
  assert.match(body, /resolvedAt.*\$row\['updated_at'\]/s);
  assert.match(API, /operation === 'reconcile-resolved-observations'/);
  assert.match(API, /operation === 'resolution-candidates'/);
  assert.match(API, /operation === 'apply-remote-resolutions'/);
});

test("remote resolution never uses a fixture slug or an end date as settlement proof", () => {
  assert.match(RESOLUTION_WORKER, /marketSlug/);
  assert.doesNotMatch(RESOLUTION_WORKER, /eventSlug/,
    "the worker must not fall back to a fixture-level sibling market");
  assert.match(RESOLUTION_WORKER, /bool\(market\.closed\)/);
  assert.match(RESOLUTION_WORKER, /price <= 0\.001 \|\| price >= 0\.999/);
  assert.doesNotMatch(RESOLUTION_WORKER, /endDate/,
    "an estimated end date cannot be used as settlement evidence");
  assert.match(RESOLUTION_WORKFLOW, /17,47 \* \* \* \*/);
});

test("the scheduled archive reconciles stale terminal rows first and keeps a seven-day live window", () => {
  const reconcileAt = WORKFLOW.indexOf("Reconcile terminal snapshots before archival");
  const archiveAt = WORKFLOW.indexOf("Archive settled observations, verifying before each delete");
  assert.ok(reconcileAt >= 0 && archiveAt > reconcileAt, "reconciliation must run before archival");
  assert.match(WORKFLOW, /"operation": "reconcile-resolved-observations"/);
  assert.match(WORKFLOW, /KEEP_DAYS: \$\{\{ github\.event\.inputs\.keep_days \|\| '7' \}\}/);
});

test("resolved archival protects the exact current statistics fold rather than a stale historic count", () => {
  assert.match(API, /\$operation === 'resolved-stats-status'/);
  assert.match(API, /trading_storage_resolved_stats_load\(\$pdo\)/);
  assert.match(WORKFLOW, /"operation": "resolved-stats-status"/);
  assert.match(WORKFLOW, /PRICED_BASELINE/);
  assert.match(WORKFLOW, /if priced < baseline:/);
});
