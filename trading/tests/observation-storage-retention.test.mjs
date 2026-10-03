import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const STORAGE = readFileSync(new URL("../storage.php", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const API = readFileSync(new URL("../api.php", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const DEPLOY = readFileSync(
  new URL("../../.github/workflows/trading-deploy.yml", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const RETENTION_WORKFLOW = readFileSync(
  new URL("../../.github/workflows/trading-archive-stale-scraped-observations.yml", import.meta.url), "utf8",
).replace(/\r\n/g, "\n");
const SCHEMA_WORKFLOW = readFileSync(
  new URL("../../.github/workflows/trading-storage-slim-observations.yml", import.meta.url), "utf8",
).replace(/\r\n/g, "\n");

function body(name) {
  const start = STORAGE.indexOf(`function ${name}`);
  assert.ok(start >= 0, `${name} must exist`);
  const next = STORAGE.indexOf("\nfunction ", start + 10);
  return STORAGE.slice(start, next < 0 ? undefined : next);
}

test("fresh observation storage has no duplicate projections beside the payload", () => {
  const start = STORAGE.indexOf("CREATE TABLE IF NOT EXISTS trading_observations");
  assert.ok(start >= 0, "observation table DDL must exist");
  const schema = STORAGE.slice(start, STORAGE.indexOf("    );", start));

  for (const redundant of [
    "source_id", "token_id", "event_slug", "market_slug", "outcome_label", "market_type",
    "observed_at", "resolved_at", "net_yield", "tags_json",
  ]) {
    assert.ok(!schema.includes(redundant), `${redundant} must not be projected in new rows`);
  }
  assert.match(schema, /observation_key CHAR\(64\) CHARACTER SET ascii COLLATE ascii_bin/);
  assert.match(schema, /payload_checksum CHAR\(64\) CHARACTER SET ascii COLLATE ascii_bin/);
  assert.match(schema, /payload MEDIUMBLOB NOT NULL/);
  assert.match(schema, /payload_checksum CHAR\(64\)/);
});

test("writes and archive restores work before and after the deliberate schema migration", () => {
  const upsert = body("trading_storage_observations_upsert");
  const restore = body("trading_storage_restore_observation_archives_from_root");
  assert.match(upsert, /trading_storage_observations_use_lean_schema\(\$pdo\)/);
  assert.match(upsert, /source_id, token_id, event_slug/, "legacy writes remain supported until slim migration runs");
  assert.match(upsert, /observation_key, lifecycle, end_at, market_probability, annualized_return, volume_usdc/,
    "lean writes retain exactly the queryable execution scope");
  assert.match(upsert, /payload_checksum = IF\(/, "checksum remains the terminal-update guard");
  assert.match(restore, /trading_storage_observation_insert_ignore_statement/);
  assert.match(restore, /trading_storage_observation_statement_bindings/);
});

test("stale scraped snapshots are separately restorable and never enter settled statistics", () => {
  const archive = body("trading_storage_archive_stale_scraped_observations");
  const archivedStream = body("trading_storage_stream_archived_observations");
  assert.match(archive, /scraped-observation-archive/);
  assert.match(archive, /lifecycle = :lifecycle/);
  assert.match(archive, /\['lifecycle' => 'SCRAPED', 'keepDays' => \$keepDays\]/);
  assert.match(archive, /\$keepDays = max\(7, min\(90, \$keepDays\)\)/,
    "the call cannot shrink the active recovery window below seven days");
  assert.match(archive, /trading_storage_count_archived_rows\(\$path\)/,
    "archive contents must be reopened and verified before a delete");
  assert.match(archive, /\$verified !== \$written/);
  assert.match(archivedStream, /data\/observation-archive/,
    "settled statistics read only the resolved archive root, never stale SCRAPED rows");
  assert.match(body("trading_storage_restore_stale_scraped_observation_archives"), /scraped-observation-archive/);
});

test("retention is scheduled, rate-limited, and survives deploy cleanup", () => {
  assert.match(RETENTION_WORKFLOW, /cron: "17,47 \* \* \* \*"/);
  assert.match(RETENTION_WORKFLOW, /"operation": "archive-stale-scraped-observations"/);
  assert.match(RETENTION_WORKFLOW, /batch_deleted != batch_verified or batch_archived != batch_verified/,
    "a partial archive may not claim success");
  assert.match(DEPLOY, /"scraped-observation-archive"/,
    "deployment cleanup must retain the recovery archive");
});

test("schema rebuild stays opt-in and behind the shared-quota guard", () => {
  assert.match(API, /\$operation === 'observation-schema-plan'/);
  assert.match(API, /\$operation === 'slim-observations-schema'/);
  assert.match(API, /REBUILD_LEAN_OBSERVATIONS/);
  assert.match(SCHEMA_WORKFLOW, /rebuild-guard\.py/);
  assert.match(SCHEMA_WORKFLOW, /inputs\.confirm_slim == true/);
  assert.match(SCHEMA_WORKFLOW, /"operation": "slim-observations-schema"/);
});
