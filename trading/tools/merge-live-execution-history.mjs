// Publish-time guard for the live run log.
//
// The run log is append-only history: every live decision the executor makes is one
// row, and nothing ever legitimately removes a row. The upload, however, replaces the
// hosted file outright, so any run that started from an empty or partial local log
// published that shorter log over the real one and the history was gone. That is what
// emptied the Live run log.
//
// This runs immediately before the upload. It reads the currently published state and
// merges its rows into the local one, keyed the same way the restore step keys them, so
// the file about to be published can only ever contain more history than the file it
// replaces — never less. If the published state cannot be read at all, it refuses to
// let the upload proceed rather than risk overwriting rows it could not see.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const executionStateUrl = String(process.env.LIVE_EXECUTION_PUBLISHED_STATE_URL || "").trim();
const executionStatePath = String(process.env.LIVE_EXECUTION_STATE_PATH || "data/live-execution-state.json").trim();
const RUN_LOG_LIMIT = Math.max(1, Number(process.env.LIVE_RUN_LOG_LIMIT || 160) || 160);

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

// Same identity rule the restore step uses, so a row cannot be counted as new here and
// as a duplicate there.
function runLogKey(row) {
  return row.id || `${row.workflowRunId || ""}:${row.runAt || row.generatedAt || ""}:${row.action || ""}`;
}

function rowTime(row) {
  return Date.parse(row?.runAt || row?.generatedAt || 0) || 0;
}

function mergeRunLogs(localRows, publishedRows) {
  const merged = [];
  const seen = new Set();
  // Local rows win on a key collision: they carry this run's fresh decision.
  for (const row of [...(Array.isArray(localRows) ? localRows : []), ...(Array.isArray(publishedRows) ? publishedRows : [])]) {
    if (!row || typeof row !== "object") continue;
    const key = runLogKey(row);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(row);
  }
  return merged.sort((left, right) => rowTime(right) - rowTime(left)).slice(0, RUN_LOG_LIMIT);
}

async function fetchPublishedState(url) {
  const response = await fetch(`${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`, {
    headers: { "User-Agent": "LiveExecutionHistoryMerge/1.0" },
  });
  if (response.status === 404) return { payload: {}, existed: false };
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status} while loading ${url}`);
    error.status = response.status;
    throw error;
  }
  return { payload: asObject(await response.json()), existed: true };
}

async function main() {
  if (!executionStateUrl) throw new Error("LIVE_EXECUTION_PUBLISHED_STATE_URL is required");

  let local;
  try {
    local = asObject(JSON.parse(await readFile(executionStatePath, "utf8")));
  } catch {
    // Nothing was produced by this run, so there is nothing to publish and nothing to
    // protect. The upload step skips a missing file too.
    console.log(`No local ${executionStatePath} to merge; leaving the published state untouched.`);
    return 0;
  }

  const { payload: published, existed } = await fetchPublishedState(executionStateUrl);
  const localRows = Array.isArray(local.runLog) ? local.runLog : [];
  const publishedRows = Array.isArray(published.runLog) ? published.runLog : [];
  const merged = mergeRunLogs(localRows, publishedRows);

  // The invariant, stated as an assertion rather than a hope.
  if (merged.length < publishedRows.length) {
    throw new Error(
      `Refusing to publish a shorter run log: merged ${merged.length} rows but ${publishedRows.length} are already published.`,
    );
  }

  local.runLog = merged;
  await mkdir(dirname(executionStatePath), { recursive: true });
  await writeFile(executionStatePath, `${JSON.stringify(local, null, 2)}\n`, "utf8");
  console.log(
    `Run log ready to publish: ${merged.length} rows (${localRows.length} local, `
    + `${publishedRows.length} already published${existed ? "" : ", none published yet"}).`,
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(`Live execution history merge failed: ${error.message}`);
    process.exit(1);
  });
}

export { mergeRunLogs, runLogKey };
