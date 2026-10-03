import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const STORAGE = readFileSync(new URL("../storage.php", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const API = readFileSync(new URL("../api.php", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const DEPLOY = readFileSync(
  new URL("../../.github/workflows/trading-deploy.yml", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const RETENTION_WORKFLOW = readFileSync(
  new URL("../../.github/workflows/trading-archive-untraded-observations.yml", import.meta.url), "utf8",
).replace(/\r\n/g, "\n");
const SCHEMA_WORKFLOW = readFileSync(
  new URL("../../.github/workflows/trading-storage-slim-observations.yml", import.meta.url), "utf8",
).replace(/\r\n/g, "\n");
const COMPACT_WORKFLOW = readFileSync(
  new URL("../../.github/workflows/trading-compact-observations.yml", import.meta.url), "utf8",
).replace(/\r\n/g, "\n");
const COMPACT_MIGRATION = readFileSync(
  new URL("../tools/migrate-observations-compact.mjs", import.meta.url), "utf8",
).replace(/\r\n/g, "\n");

function body(name) {
  const start = STORAGE.indexOf(`function ${name}`);
  assert.ok(start >= 0, `${name} must exist`);
  const next = STORAGE.indexOf("\nfunction ", start + 10);
  return STORAGE.slice(start, next < 0 ? undefined : next);
}

test("fresh observation storage retains a compact operational projection without a response payload", () => {
  const schema = body("trading_storage_compact_observations_ddl");
  assert.match(schema, /CREATE TABLE IF NOT EXISTS/);
  assert.doesNotMatch(schema, /payload MEDIUMBLOB/);
  assert.doesNotMatch(schema, /source_id/);
  assert.doesNotMatch(schema, /market_type/);
  assert.match(schema, /observation_key CHAR\(64\) CHARACTER SET ascii COLLATE ascii_bin/);
  assert.match(schema, /token_id VARCHAR\(191\) CHARACTER SET ascii COLLATE ascii_bin/,
    "the retained token joins an observation to a real trade during archival");
  assert.match(schema, /event_slug VARCHAR\(191\)/, "a market-specific slug is retained for settlement proof");
  assert.match(schema, /first_market_probability/, "the entry probability survives for dip and statistics logic");
  assert.match(schema, /final_outcome_price/, "the settled outcome survives without raw Gamma data");
  assert.match(schema, /payload_checksum BINARY\(32\)/, "the semantic checksum is stored in 32 bytes");
});

test("writes and archive restores work before and after the deliberate schema migration", () => {
  const upsert = body("trading_storage_observations_upsert");
  const compactUpsert = body("trading_storage_compact_observations_upsert");
  const restore = body("trading_storage_restore_observation_archives_from_root");
  assert.match(upsert, /trading_storage_observations_are_compact\(\$pdo\)/);
  assert.match(upsert, /source_id, token_id, event_slug/, "legacy writes remain supported until slim migration runs");
  assert.match(compactUpsert, /trading_storage_compact_observation_bindings/);
  assert.match(compactUpsert, /lifecycle = IF\(lifecycle = \\'RESOLVED\\'/,
    "terminal outcomes remain terminal after the cutover");
  assert.match(restore, /trading_storage_observation_insert_ignore_statement/);
  assert.match(restore, /trading_storage_observation_statement_bindings/);
});

test("legacy stale scraped snapshots remain separately restorable and never enter settled statistics", () => {
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

test("trade-aware retention keeps actual positions and archives only old non-traded snapshots", () => {
  const plan = body("trading_storage_traded_observation_retention_plan");
  const archive = body("trading_storage_archive_untraded_observations");
  const archivedStream = body("trading_storage_stream_archived_observations");
  assert.match(plan, /FROM trading_trades/, "the retention plan must be derived from actual trades");
  assert.match(plan, /protected_rows/, "the plan reports how many observation rows are protected");
  assert.match(plan, /\$keepDays = max\(3, min\(90, \$keepDays\)\)/,
    "the current operational working set cannot be reduced below three days");
  assert.match(archive, /untraded-observation-archive/);
  assert.match(archive, /\$tradedTokens = '\(SELECT DISTINCT token_id FROM trading_trades/,
    "the selected rows must have no durable trade-token match");
  assert.match(archive, /WHERE t\.token_id IS NULL/,
    "only observations without that real-trade token may be selected");
  assert.match(archive, /trading_storage_payload_proves_resolved\(\$payload\)/,
    "a terminal payload with an interrupted SCRAPED lifecycle must become RESOLVED in the archive");
  assert.match(archive, /'terminalReconciled' => \$terminalReconciled/,
    "the archival result must disclose how many terminal snapshots it repaired");
  assert.match(archive, /DELETE o FROM trading_observations o/,
    "delete must repeat the predicate instead of trusting an earlier select");
  assert.match(archive, /trading_storage_count_archived_rows\(\$path\)/,
    "a gzip archive is reopened and verified before deletion");
  assert.match(archivedStream, /untraded-observation-archive/,
    "resolved non-traded history still participates in aggregate statistics");
  assert.match(archivedStream, /\$lifecycle !== 'RESOLVED'/,
    "SCRAPED snapshots from that mixed archive must never be counted as outcomes");
  assert.match(body("trading_storage_restore_untraded_observation_archives"), /untraded-observation-archive/);
  const schemaPlan = body("trading_storage_observation_schema_plan");
  const slim = body("trading_storage_slim_observations_schema");
  assert.doesNotMatch(schemaPlan, /'token_id',/,
    "the slim schema plan must preserve the relation to historical trades");
  assert.match(slim, /MODIFY `token_id` VARCHAR\(191\) CHARACTER SET ascii COLLATE ascii_bin NULL/);
});

test("trade-aware retention is scheduled, rate-limited, and survives deploy cleanup", () => {
  assert.match(RETENTION_WORKFLOW, /cron: "17,47 \* \* \* \*"/);
  assert.match(RETENTION_WORKFLOW, /"operation": "traded-observation-retention-plan"/);
  assert.match(RETENTION_WORKFLOW, /"operation": "archive-untraded-observations"/);
  assert.match(RETENTION_WORKFLOW, /trade mirror has no token identities/,
    "the schedule must refuse a destructive empty-trade-mirror run");
  assert.match(RETENTION_WORKFLOW, /batch_deleted != batch_verified or batch_archived != batch_verified/,
    "a partial archive may not claim success");
  assert.match(RETENTION_WORKFLOW, /terminal repaired/,
    "maintenance output must disclose stale terminal snapshots repaired while archiving");
  assert.match(DEPLOY, /"untraded-observation-archive"/,
    "deployment cleanup must retain the trade-aware recovery archive");
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
  assert.match(API, /\$operation === 'compact-observations-prepare'/);
  assert.match(API, /ACTIVATE_PAYLOADLESS_OBSERVATIONS/);
  assert.match(COMPACT_WORKFLOW, /migrate-observations-compact\.mjs/);
  assert.match(COMPACT_WORKFLOW, /inputs\.confirm == true/);
  assert.match(COMPACT_MIGRATION, /attempt <= 5/,
    "a brief shared-hosting disconnect cannot abandon a verified long-running copy");
  assert.match(body("trading_storage_compact_observations_migration_verify"), /key_sum/,
    "cutover verifies the complete key set without an unbounded cross-table join");
  const activation = body("trading_storage_compact_observations_activate");
  assert.match(activation, /trading_storage_set_observation_cutover_gate\(\$pdo, 90\)/,
    "a short gate lets in-flight scanner writes finish before the atomic rename");
  assert.match(activation, /trading_storage_compact_observations_migration_verify\(\$pdo\)/,
    "the pair is reverified after new mirror writes are gated");
  assert.match(activation, /finally \{\s*\/\/ A failed cutover must never leave the mirror paused/s,
    "a failed cutover must reopen the SQL mirror");
  assert.match(body("trading_storage_observations_upsert"), /trading_storage_observation_cutover_gated\(\$pdo\)/,
    "new scans respect the cutover gate on both legacy and compact schemas");
  assert.match(COMPACT_WORKFLOW, /trading-observation-resolution-maintenance/,
    "archive and remote resolution cannot mutate a source row during the verified swap");
});
