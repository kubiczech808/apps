import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const executionStateUrl = String(process.env.LIVE_EXECUTION_STATE_URL || "").trim();
const executionStatePath = String(process.env.LIVE_EXECUTION_STATE_PATH || "data/live-execution-state.json").trim();
const shouldRecoverHistory = String(process.env.LIVE_RUN_LOG_RECOVER || "false").toLowerCase() === "true";
const githubToken = String(process.env.GITHUB_TOKEN || "").trim();
const githubRepository = String(process.env.GITHUB_REPOSITORY || "").trim();
const githubRef = String(process.env.GITHUB_REF_NAME || "").trim();
const workflowFile = String(process.env.LIVE_EXECUTION_WORKFLOW_FILE || "polymarket-live-limit-order-test.yml").trim();
const confirmedManualRunIds = new Set(
  String(process.env.LIVE_CONFIRMED_MANUAL_RUN_IDS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizedRunLog(rows) {
  const seen = new Set();
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row && typeof row === "object")
    .filter((row) => {
      const key = row.id || `${row.workflowRunId || ""}:${row.runAt || row.generatedAt || ""}:${row.action || ""}`;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => Date.parse(right.runAt || right.generatedAt || 0) - Date.parse(left.runAt || left.generatedAt || 0))
    .slice(0, 160);
}

async function fetchJson(url, headers = {}) {
  const response = await fetch(url, { headers: { Accept: "application/vnd.github+json", ...headers } });
  if (!response.ok) throw new Error(`HTTP ${response.status} while loading ${url}`);
  return response.json();
}

function findMatchingStoredRun(rows, run) {
  const remoteTime = Date.parse(run.updated_at || run.created_at || 0);
  return rows.find((row) => {
    if (String(row.workflowRunId || "") === String(run.id)) return true;
    const rowTime = Date.parse(row.runAt || row.generatedAt || 0);
    return Number.isFinite(rowTime) && Number.isFinite(remoteTime) && Math.abs(rowTime - remoteTime) <= 180000;
  });
}

function applyConfirmedManualSources(rows) {
  return rows.map((row) => {
    if (!confirmedManualRunIds.has(String(row.workflowRunId || ""))) return row;
    return {
      ...row,
      runSource: "MANUAL",
      manualRunOnce: true,
      sourceVerifiedByUser: true,
    };
  });
}

async function restoreHistoricalRows(payload) {
  if (!shouldRecoverHistory || payload.historyRecoveryCompletedAt || !githubToken || !githubRepository) return payload;

  const search = new URLSearchParams({ per_page: "100" });
  if (githubRef) search.set("branch", githubRef);
  const url = `https://api.github.com/repos/${githubRepository}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?${search}`;
  const response = await fetchJson(url, { Authorization: `Bearer ${githubToken}` });
  const existingRows = normalizedRunLog(payload.runLog);
  const recoveredRows = (Array.isArray(response.workflow_runs) ? response.workflow_runs : [])
    .filter((run) => run?.status === "completed" && run?.conclusion && run.conclusion !== "skipped")
    .map((run) => {
      const matched = findMatchingStoredRun(existingRows, run);
      if (matched) {
        return {
          ...matched,
          workflowRunId: run.id,
          workflowUrl: run.html_url,
        };
      }
      const manuallyConfirmed = confirmedManualRunIds.has(String(run.id));
      const source = manuallyConfirmed ? "MANUAL" : (run.event === "schedule" ? "AUTO" : "RECOVERED");
      return {
        id: `github-live-history-${run.id}`,
        workflowRunId: run.id,
        workflowUrl: run.html_url,
        runAt: run.updated_at || run.created_at,
        generatedAt: run.updated_at || run.created_at,
        strategyId: "live",
        strategyLabel: "Live",
        runSource: source,
        manualRunOnce: manuallyConfirmed,
        action: "HISTORY_RECOVERED",
        reason: `Historical GitHub Actions run completed with ${run.conclusion}.`,
        explanation: run.event === "workflow_dispatch"
          ? "The previous detailed decision payload was overwritten. Its dispatch source is not recoverable from GitHub's run metadata."
          : "The previous detailed decision payload was overwritten; this scheduled execution was recovered from GitHub Actions metadata.",
        historicalRecovery: true,
        sourceVerifiedByUser: manuallyConfirmed,
      };
    });

  return {
    ...payload,
    runLog: normalizedRunLog(recoveredRows),
    historyRecoveryCompletedAt: new Date().toISOString(),
  };
}

async function main() {
  if (!executionStateUrl) throw new Error("LIVE_EXECUTION_STATE_URL is required");
  let payload = asObject(await fetchJson(executionStateUrl));

  payload.runLog = normalizedRunLog(payload.runLog);
  payload = await restoreHistoricalRows(payload);
  payload.runLog = normalizedRunLog(applyConfirmedManualSources(payload.runLog));
  await mkdir(dirname(executionStatePath), { recursive: true });
  await writeFile(executionStatePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`Restored ${payload.runLog.length} live execution run-log rows.`);
}

main().catch((error) => {
  console.error(`Live execution history restore failed: ${error.message}`);
  process.exitCode = 1;
});
