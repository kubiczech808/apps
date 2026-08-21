// Read-only diagnostic. For every paper portfolio, compares what the three layers
// report about its trades: the core paper-state.json (which now carries only a
// compacted portfolio with trades: []), that portfolio's own state segment (which
// carries the real trades), and what api.php actually serves the dashboard for that
// portfolio. A run log that shows OPENED while the positions list is empty is exactly
// this kind of split, so the three columns localize which layer lost the rows.
// Writes nothing.
const HOST = process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading";

async function fetchJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  try {
    return { ok: response.ok, status: response.status, body: JSON.parse(text) };
  } catch {
    return { ok: false, status: response.status, error: text.slice(0, 300) };
  }
}

const OPEN_STATUSES = new Set([
  "OPEN",
  "PENDING_RESOLUTION",
  "MARKET_NOT_FOUND",
  "STOP_BREACH",
  "LIMIT_ORDER_WAITING",
]);

function tradeSplit(trades) {
  if (!Array.isArray(trades)) return "trades=(absent)";
  let open = 0;
  let closed = 0;
  for (const trade of trades) {
    if (OPEN_STATUSES.has(String(trade?.status || ""))) open += 1;
    else closed += 1;
  }
  return `trades=${trades.length} (open=${open} closed=${closed})`;
}

async function main() {
  console.log(`Portfolio consistency diagnosis at ${new Date().toISOString()}\n`);

  const staticResult = await fetchJson(`${HOST}/data/paper-state.json`);
  if (!staticResult.ok) {
    console.log(`!! could not read static state: HTTP ${staticResult.status} ${staticResult.error || ""}`);
    return;
  }
  const core = staticResult.body || {};
  const manifest = core.stateSegments || {};
  console.log(`core generatedAt   : ${core.generatedAt}`);
  console.log(`core portfolio ids : ${Object.keys(core.paperPortfolios || {}).join(", ") || "(none)"}`);
  console.log(`manifest segments  : ${Object.keys(manifest).join(", ") || "(none)"}`);

  // Exactly what the overview table above the selector reads: one dashboard request for a
  // selected portfolio, then every row's portfolio.equityUsdc out of that one response.
  // A row that renders "-" means this number was missing, so printing all of them for a
  // single response says whether the payload is short or the table is.
  for (const summary of ["dashboard", "portfolio-overview"]) {
    const selected = "conservative";
    const url = summary === "dashboard"
      ? `${HOST}/api.php?action=state&target=paper&summary=dashboard&strategy_id=${selected}`
      : `${HOST}/api.php?action=state&target=paper&summary=portfolio-overview`;
    const payload = await fetchJson(url);
    if (!payload.ok) {
      console.log(`\n-- ${summary} (selected=${selected}) -- HTTP ${payload.status} ${payload.error || ""}`);
      continue;
    }
    const rows = payload.body?.paperPortfolios || {};
    console.log(`\n-- ${summary} (selected=${selected}) -- what the overview table reads --`);
    for (const [id, row] of Object.entries(rows)) {
      console.log(`   ${id.padEnd(16)} equity=${row?.portfolio?.equityUsdc ?? "MISSING"}`
        + ` risk=${row?.portfolio?.openRiskUsdc ?? "MISSING"}`
        + ` free=${row?.portfolio?.freeCapitalUsdc ?? "MISSING"}`
        + ` archived=${Boolean(row?.archived)}`);
    }
  }

  const configResult = await fetchJson(`${HOST}/api.php?action=portfolio-config`);
  const paperConfig = configResult.ok ? (configResult.body?.config?.paper || {}) : {};

  // Every configured portfolio, not only the ones the core happens to carry: a
  // configured id the core never wrote is itself a finding.
  const ids = [...new Set([...Object.keys(paperConfig), ...Object.keys(core.paperPortfolios || {})])];

  for (const id of ids) {
    const label = paperConfig[id]?.displayName ?? core.paperPortfolios?.[id]?.label ?? "(unnamed)";
    console.log(`\n=== ${id} -- ${JSON.stringify(label)} ===`);

    const coreEntry = core.paperPortfolios?.[id];
    if (!coreEntry) {
      console.log(`  core     : MISSING from paperPortfolios`);
    } else {
      console.log(`  core     : equity=${coreEntry.portfolio?.equityUsdc ?? "-"} ${tradeSplit(coreEntry.trades)}`
        + ` lastDecision=${coreEntry.lastDecision?.action ?? "-"}`);
    }

    // The segment the writer declared for this portfolio, read straight off the
    // hosting so a stale or unpublished file shows up as its own failure.
    const entry = manifest[`portfolio:${id}`];
    if (!entry?.file) {
      console.log(`  segment  : NO manifest entry "portfolio:${id}"`);
    } else {
      const segResult = await fetchJson(`${HOST}/data/${entry.file}`);
      if (!segResult.ok) {
        console.log(`  segment  : ${entry.file} HTTP ${segResult.status} ${segResult.error || ""}`);
      } else {
        const seg = segResult.body?.paperPortfolio;
        console.log(`  segment  : ${entry.file} manifestTrades=${entry.counts?.trades ?? "-"}`
          + ` actual ${tradeSplit(seg?.trades)} runLog=${Array.isArray(seg?.runLog) ? seg.runLog.length : "-"}`);
      }
    }

    // What the browser really receives for this portfolio when it is the selected one.
    const served = await fetchJson(
      `${HOST}/api.php?action=state&target=paper&summary=dashboard&strategy_id=${encodeURIComponent(id)}`,
    );
    if (!served.ok) {
      console.log(`  served   : HTTP ${served.status} ${served.error || ""}`);
    } else {
      const servedEntry = (served.body?.paperPortfolios || {})[id];
      console.log(`  served   : ${servedEntry ? tradeSplit(servedEntry.trades) : "portfolio MISSING from response"}`
        + ` runLog=${Array.isArray(servedEntry?.runLog) ? servedEntry.runLog.length : "-"}`);
    }

    // The run log is archived to its own NDJSON files and served by its own endpoint,
    // independent of the state above -- which is how a portfolio can show OPENED rows
    // here and nothing in its positions list.
    const runLog = await fetchJson(
      `${HOST}/api.php?action=portfolio-run-log&strategy_id=${encodeURIComponent(id)}&page=1&page_size=24`,
    );
    if (!runLog.ok) {
      console.log(`  run log  : HTTP ${runLog.status} ${runLog.error || ""}`);
    } else {
      const rows = runLog.body?.records || runLog.body?.rows || [];
      const actions = {};
      for (const row of rows) {
        const action = String(row?.action || row?.decision?.action || "-");
        actions[action] = (actions[action] || 0) + 1;
      }
      const summary = Object.entries(actions).map(([a, n]) => `${a}:${n}`).join(" ") || "(no rows)";
      console.log(`  run log  : ${rows.length} row(s) on page 1 -- ${summary}`);
    }
  }
}

main();
