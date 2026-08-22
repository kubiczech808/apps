// Read-only diagnostic. Writes nothing, places nothing.
//
// Reported: several portfolios skip with "no eligible non-correlated candidate" while free
// capital exists and candidates exist.
//
// That reason comes from findFirstOpenCandidate: every eligible candidate shared a risk
// group key with something the portfolio already holds. riskBlock() walks OPEN_STATUSES,
// which includes LIMIT_ORDER_WAITING -- so a resting, unfilled order blocks a new candidate
// exactly as a real position does. Portfolios now carry tens of resting orders, so the
// question is whether the blockers are positions (correlated risk, working as intended) or
// offers nobody has taken yet (no risk at all, blocking for nothing).
//
// So for each recent correlated skip this resolves every blocking trade id back to the
// portfolio's own rows and prints its status, and counts the split. It also prints which key
// did the blocking, because a key that groups half the catalogue is a different problem from
// a key that groups one fixture.
const HOST = process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading";
const RUNS_PER_PORTFOLIO = Math.max(1, Number(process.env.SKIP_DIAGNOSIS_RUNS || 3));

async function fetchJson(url, attempts = 2) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      const text = await response.text();
      try {
        return { ok: response.ok, status: response.status, body: JSON.parse(text) };
      } catch {
        return { ok: false, status: response.status, error: text.slice(0, 200) };
      }
    } catch (error) {
      if (attempt < attempts) continue;
      return { ok: false, status: 0, error: `read failed: ${error?.message || error}` };
    }
  }
  return { ok: false, status: 0, error: "read failed" };
}

const CORRELATED = /^no eligible non-(duplicate|correlated) candidate/;

async function main() {
  console.log(`Correlation skip diagnosis at ${new Date().toISOString()}\n`);

  const config = await fetchJson(`${HOST}/api.php?action=portfolio-config`);
  const paper = config.ok ? (config.body?.config?.paper || {}) : {};

  const blockerStatusTotals = new Map();
  const blockingKeyTotals = new Map();

  for (const id of Object.keys(paper)) {
    // The portfolio's own rows, so a blocking trade id can be resolved to what it actually
    // is rather than guessed at from the log alone.
    const served = await fetchJson(
      `${HOST}/api.php?action=state&target=paper&summary=dashboard&strategy_id=${encodeURIComponent(id)}`,
    );
    const entry = served.ok ? ((served.body?.paperPortfolios || {})[id] || {}) : {};
    const byId = new Map();
    for (const trade of (Array.isArray(entry.trades) ? entry.trades : [])) {
      if (trade?.id) byId.set(String(trade.id), trade);
    }
    const portfolio = entry.portfolio || {};

    const log = await fetchJson(
      `${HOST}/api.php?action=portfolio-run-log&strategy_id=${encodeURIComponent(id)}&page=0&page_size=24`,
    );
    const rows = (log.ok ? (log.body?.records || []) : []).filter((row) => CORRELATED.test(String(row?.reason || "")));
    if (!rows.length) continue;

    console.log(`=== ${id} -- free=${portfolio.freeCapitalUsdc ?? "-"}`
      + ` deployable=${portfolio.deployableCapitalUsdc ?? "-"}`
      + ` inPositions=${portfolio.positionRiskUsdc ?? "-"}`
      + ` inOrders=${portfolio.restingLimitOrderUsdc ?? "-"} ===`);

    for (const row of rows.slice(0, RUNS_PER_PORTFOLIO)) {
      const detail = await fetchJson(
        `${HOST}/api.php?action=portfolio-run-log-detail&strategy_id=${encodeURIComponent(id)}`
        + `&run_at=${encodeURIComponent(row.runAt)}`,
      );
      const batch = detail.ok ? (detail.body?.record?.batchLog || {}) : {};
      const counts = batch.counts || {};
      console.log(`  ${String(row.runAt).slice(0, 19)} ${detail.body?.record?.runSource ?? "-"}`
        + ` -- ${String(row.reason || "").slice(0, 44)}`);
      console.log(`     rankedEligible=${counts.rankedEligible ?? "-"} skippedForRisk=${counts.skippedForRisk ?? "-"}`
        + ` riskBlocked=${counts.riskBlocked ?? "-"} openTrades=${counts.openTrades ?? "-"}`
        + ` capitalAvailable=${batch.capital?.availableUsdc ?? "-"}`);

      const candidates = [
        ...(Array.isArray(batch.riskBlocked) ? batch.riskBlocked : []),
        ...(Array.isArray(batch.eligibleCandidates) ? batch.eligibleCandidates : []),
      ].filter((item) => item?.riskBlockedByTradeId);
      const seen = new Set();
      for (const candidate of candidates) {
        const key = `${candidate.tokenId}:${candidate.riskBlockedByTradeId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const blocker = byId.get(String(candidate.riskBlockedByTradeId));
        const status = blocker ? String(blocker.status || "?") : "NOT IN CURRENT TRADES";
        blockerStatusTotals.set(status, (blockerStatusTotals.get(status) || 0) + 1);
        // "already covers X, Y" -- the keys are what decides whether this is real
        // correlation or a bucket too broad to mean anything.
        const overlap = String(candidate.riskBlockedReason || "").replace(/^.*already covers /, "");
        for (const single of overlap.split(",").map((value) => value.trim()).filter(Boolean)) {
          blockingKeyTotals.set(single, (blockingKeyTotals.get(single) || 0) + 1);
        }
        if (seen.size <= 6) {
          console.log(`     blocked: ${String(candidate.question || "").slice(0, 46)}`);
          console.log(`        by ${status.padEnd(20)} ${String(blocker?.question || candidate.riskBlockedByTradeId).slice(0, 46)}`);
          console.log(`        on ${overlap.slice(0, 96)}`);
        }
      }
      if (seen.size > 6) console.log(`     ... and ${seen.size - 6} more blocked candidate(s)`);
    }
    console.log("");
  }

  // The finding, if there is one: a resting order is not exposure, so blocking a new
  // candidate on one costs a trade and prevents no risk.
  console.log(`-- what was doing the blocking --`);
  const totalBlocks = [...blockerStatusTotals.values()].reduce((sum, value) => sum + value, 0);
  if (!totalBlocks) console.log(`   no correlated skip carried a resolvable blocking trade`);
  for (const [status, count] of [...blockerStatusTotals].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${status.padEnd(24)} ${String(count).padStart(5)}`
      + ` (${((count / totalBlocks) * 100).toFixed(1)}%)`);
  }
  const resting = blockerStatusTotals.get("LIMIT_ORDER_WAITING") || 0;
  if (totalBlocks) {
    console.log(`   blocked by an unfilled offer: ${resting} of ${totalBlocks}`
      + ` (${((resting / totalBlocks) * 100).toFixed(1)}%)`);
  }

  console.log(`\n-- which keys blocked, most often first --`);
  for (const [key, count] of [...blockingKeyTotals].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    console.log(`   ${String(count).padStart(4)}  ${key.slice(0, 90)}`);
  }
}

main().catch((error) => {
  console.log(`\n!! diagnosis stopped early: ${error?.message || error}`);
  process.exitCode = 1;
});
