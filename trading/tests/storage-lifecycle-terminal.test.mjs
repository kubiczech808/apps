import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const STORAGE = readFileSync(new URL("../storage.php", import.meta.url), "utf8");
const start = STORAGE.indexOf("function trading_storage_observations_upsert");
const body = STORAGE.slice(start, STORAGE.indexOf("\n}\n", start));
const compactStart = STORAGE.indexOf("function trading_storage_compact_observations_upsert");
const compactBody = STORAGE.slice(compactStart, STORAGE.indexOf("\n}\n", compactStart));

test("resolved observation upserts are terminal", () => {
  assert.ok(start > 0, "observation upsert must exist");
  assert.match(body, /lifecycle = IF\(lifecycle = 'RESOLVED' OR VALUES\(lifecycle\) = 'RESOLVED', 'RESOLVED', VALUES\(lifecycle\)\)/);
  assert.match(body, /payload = IF\(payload_checksum = VALUES\(payload_checksum\)\s+OR \(lifecycle = 'RESOLVED' AND VALUES\(lifecycle\) <> 'RESOLVED'\), payload, VALUES\(payload\)\)/s);
  assert.match(body, /resolved_at = IF\(payload_checksum = VALUES\(payload_checksum\)\s+OR \(lifecycle = 'RESOLVED' AND VALUES\(lifecycle\) <> 'RESOLVED'\), resolved_at, VALUES\(resolved_at\)\)/s);
  assert.ok(compactStart > 0, "compact observation upsert must exist");
  assert.match(compactBody, /lifecycle = IF\(lifecycle = \\'RESOLVED\\' OR VALUES\(lifecycle\) = \\'RESOLVED\\', \\'RESOLVED\\', VALUES\(lifecycle\)\)/);
  assert.doesNotMatch(compactBody, /payload MEDIUMBLOB/);
});

test("archive workflow is scheduled often enough to bound the resolved backlog", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/trading-archive-resolved-observations.yml", import.meta.url), "utf8");
  assert.match(workflow, /cron: "\*\/30 \* \* \* \*"/);
  assert.match(workflow, /default: "12"/);
  assert.match(workflow, /default: "3000"/);
});
