// Read-only measurement. Writes nothing to production, publishes nothing, needs no secrets.
//
// The MySQL migration carries a hard constraint: the database must not grow by more than
// 300 MB. "Grow by" is only measurable against a recorded starting point, so this tool has
// two modes and the baseline is the first thing it does:
//
//   --save-baseline   record today's sizes into data/storage-size-baseline.json
//   (default)         measure now and report the delta against that recorded baseline
//
// Sizes come from api.php?action=storage-status, which reports information_schema's
// data_length + index_length per Trading table. Two properties of that source are worth
// stating rather than discovering later:
//
//   * InnoDB's table_rows is an estimate, so row counts here are indicative. The BYTES are
//     what the budget is about, and those are exact enough -- they are what the hosting
//     bills and what fills the quota.
//   * data_free is space InnoDB has reserved and not returned. It counts against the disk
//     even though nothing occupies it, so it is reported separately: a table that grew
//     only in data_free grew on disk without storing anything new, and that distinction
//     decides whether the answer is "compact it" or "store less".
const HOST = process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading";
const BUDGET_BYTES = Math.max(0, Number(process.env.STORAGE_BUDGET_MB || 300)) * 1024 * 1024;
const BASELINE_PATH = process.env.STORAGE_BASELINE_PATH || "data/storage-size-baseline.json";
const SAVE_BASELINE = process.argv.includes("--save-baseline");

const mb = (bytes) => `${(Number(bytes || 0) / (1024 * 1024)).toFixed(2)} MB`;

async function fetchJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

function totals(tables = {}) {
  let data = 0;
  let index = 0;
  let free = 0;
  let rows = 0;
  for (const stats of Object.values(tables)) {
    data += Number(stats?.dataBytes || 0);
    index += Number(stats?.indexBytes || 0);
    free += Number(stats?.freeBytes || 0);
    rows += Number(stats?.rows || 0);
  }
  return { data, index, free, rows, occupied: data + index, onDisk: data + index + free };
}

async function main() {
  const { readFile, writeFile, mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");

  console.log(`Storage size budget check at ${new Date().toISOString()}`);
  console.log(`budget: ${mb(BUDGET_BYTES)} of growth   baseline file: ${BASELINE_PATH}`);
  console.log(`Read-only against production: nothing is written there, no credentials used.\n`);

  const status = await fetchJson(`${HOST}/api.php?action=storage-status&t=${Date.now()}`);
  const storage = status?.storage || {};
  const tables = storage.tradingTables && typeof storage.tradingTables === "object" ? storage.tradingTables : {};

  console.log("== the storage layer right now");
  console.log(`   configured / connected / schemaReady   ${storage.configured} / ${storage.connected} / ${storage.schemaReady}`);
  console.log(`   storage active (reads served by SQL)   ${status?.active}`);
  console.log(`   json imported at                       ${status?.jsonImportedAt || "(never)"}`);
  console.log(`   last ingest at                         ${status?.lastIngestAt || "(never)"}`);
  console.log(`   last migration error                   ${status?.lastMigrationError || "(none)"}`);
  console.log(`   observation counts                     SCRAPED ${status?.counts?.SCRAPED ?? "?"} / RESOLVED ${status?.counts?.RESOLVED ?? "?"}`);
  console.log(`   whole database                         ${mb(storage.databaseSizeBytes)}`);
  console.log(`   trading tables                         ${mb(storage.tradingSizeBytes)}`);

  const now = totals(tables);
  console.log(`\n== per table (rows are InnoDB estimates; bytes are what the budget measures)`);
  for (const [name, stats] of Object.entries(tables).sort()) {
    console.log(`   ${name.padEnd(24)} rows ~${String(stats.rows ?? 0).padStart(7)}`
      + `   data ${mb(stats.dataBytes).padStart(10)}   index ${mb(stats.indexBytes).padStart(10)}`
      + `   free ${mb(stats.freeBytes).padStart(10)}`);
  }
  console.log(`   ${"TOTAL".padEnd(24)} rows ~${String(now.rows).padStart(7)}`
    + `   data ${mb(now.data).padStart(10)}   index ${mb(now.index).padStart(10)}   free ${mb(now.free).padStart(10)}`);
  console.log(`   occupied (data + index)  ${mb(now.occupied)}`);
  console.log(`   on disk (incl. free)     ${mb(now.onDisk)}`);

  const snapshot = {
    recordedAt: new Date().toISOString(),
    budgetBytes: BUDGET_BYTES,
    databaseSizeBytes: Number(storage.databaseSizeBytes || 0),
    tradingSizeBytes: Number(storage.tradingSizeBytes || 0),
    tables,
    totals: now,
    counts: status?.counts || null,
  };

  if (SAVE_BASELINE) {
    await mkdir(dirname(BASELINE_PATH), { recursive: true });
    await writeFile(BASELINE_PATH, `${JSON.stringify(snapshot, null, 2)}\n`);
    console.log(`\n== baseline recorded to ${BASELINE_PATH}`);
    console.log(`   Commit this file. Every later run compares against it, so the 300 MB`);
    console.log(`   limit is measured from a real starting point rather than a remembered one.`);
    return;
  }

  let baseline = null;
  try {
    baseline = JSON.parse(await readFile(BASELINE_PATH, "utf8"));
  } catch {
    console.log(`\n!! no baseline at ${BASELINE_PATH}, so growth cannot be measured yet.`);
    console.log(`   Run this with --save-baseline first, and commit the file it writes.`);
    process.exitCode = 1;
    return;
  }

  const before = baseline.totals || totals(baseline.tables || {});
  console.log(`\n== growth since the baseline recorded ${baseline.recordedAt}`);
  for (const [name, stats] of Object.entries(tables).sort()) {
    const prior = (baseline.tables || {})[name] || {};
    const deltaOccupied = (Number(stats.dataBytes || 0) + Number(stats.indexBytes || 0))
      - (Number(prior.dataBytes || 0) + Number(prior.indexBytes || 0));
    const deltaRows = Number(stats.rows || 0) - Number(prior.rows || 0);
    console.log(`   ${name.padEnd(24)} occupied ${(deltaOccupied >= 0 ? "+" : "")}${mb(deltaOccupied).padStart(10)}`
      + `   rows ${deltaRows >= 0 ? "+" : ""}${deltaRows}`);
  }

  const grownOccupied = now.occupied - Number(before.occupied || 0);
  const grownOnDisk = now.onDisk - Number(before.onDisk || 0);
  // A baseline that never captured the whole-database figure must not be read as zero:
  // that would report the entire database as growth and fail every run.
  const hadDatabaseSize = Number.isFinite(Number(baseline.databaseSizeBytes));
  const grownDatabase = hadDatabaseSize
    ? Number(storage.databaseSizeBytes || 0) - Number(baseline.databaseSizeBytes)
    : null;
  console.log(`\n   trading tables, occupied   ${grownOccupied >= 0 ? "+" : ""}${mb(grownOccupied)}`);
  console.log(`   trading tables, on disk    ${grownOnDisk >= 0 ? "+" : ""}${mb(grownOnDisk)}`);
  console.log(`   whole database             ${grownDatabase == null
    ? "(the baseline did not record it, so only the Trading tables are compared)"
    : `${grownDatabase >= 0 ? "+" : ""}${mb(grownDatabase)}`}`);
  console.log(`   budget                     ${mb(BUDGET_BYTES)}`);

  // The whole database is what the hosting quota actually measures, so it decides the
  // verdict even though the Trading tables are what this migration adds to.
  const worst = Math.max(grownOccupied, grownOnDisk, ...(grownDatabase == null ? [] : [grownDatabase]));
  const within = worst <= BUDGET_BYTES;
  console.log(`\n   -> ${within ? "WITHIN BUDGET" : "OVER BUDGET"}`
    + ` by ${mb(Math.abs(BUDGET_BYTES - worst))} ${within ? "remaining" : "excess"}`);
  if (grownOnDisk - grownOccupied > 8 * 1024 * 1024) {
    console.log(`   note: ${mb(grownOnDisk - grownOccupied)} of the growth is InnoDB free space rather than`);
    console.log(`   stored data, which a table rebuild can return -- that is a compaction`);
    console.log(`   question, not a "store less" one.`);
  }
  if (!within) process.exitCode = 1;
}

main().catch((error) => {
  console.log(`\n!! size check stopped early: ${error?.message || error}`);
  process.exitCode = 1;
});
