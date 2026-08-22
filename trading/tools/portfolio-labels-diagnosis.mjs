// Read-only diagnostic. For every paper portfolio, compares what the three layers
// report about its trades: the core paper-state.json (which now carries only a
// compacted portfolio with trades: []), that portfolio's own state segment (which
// carries the real trades), and what api.php actually serves the dashboard for that
// portfolio. A run log that shows OPENED while the positions list is empty is exactly
// this kind of split, so the three columns localize which layer lost the rows.
// Writes nothing.
const HOST = process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading";

// Network failures are reported, not thrown. This host closes a connection part-way
// through a multi-megabyte file often enough that one dropped read used to take the whole
// diagnostic down with an unhandled rejection -- losing every check that had not run yet
// to a transport hiccup that says nothing about what is being diagnosed. One retry, then a
// line saying so and on to the next check.
async function fetchJson(url, attempts = 2) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response;
    let text;
    try {
      response = await fetch(url);
      text = await response.text();
    } catch (error) {
      if (attempt < attempts) continue;
      return { ok: false, status: 0, error: `read failed: ${error?.message || error}` };
    }
    try {
      return { ok: response.ok, status: response.status, body: JSON.parse(text) };
    } catch {
      return { ok: false, status: response.status, error: text.slice(0, 300) };
    }
  }
  return { ok: false, status: 0, error: "read failed" };
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

  // The resolved archive is carried over untouched by an execution pass rather than
  // downloaded and uploaded back unchanged. The manifest entry is the whole mechanism: it
  // has to keep naming the hosted file and keep the real row count, because a count of 0
  // would mean the archive really had been replaced by an empty one.
  {
    const archive = manifest.resolvedObservations || {};
    const recent = manifest.resolvedRecent || {};
    console.log(`\n-- resolved archive -- carried over by execution passes --`);
    console.log(`   archive  : file=${archive.file || "MISSING"} carriedOver=${Boolean(archive.carriedOver)}`
      + ` rows=${archive.counts?.resolvedMarketObservations ?? "MISSING"}`);
    console.log(`   recent   : file=${recent.file || "MISSING"} carriedOver=${Boolean(recent.carriedOver)}`
      + ` rows=${recent.counts?.resolvedMarketObservations ?? "MISSING"}`
      + ` truncatedFrom=${recent.truncatedFrom ?? "-"}`);
    if (archive.file) {
      // HEAD, not GET: the point is that the file is still there and still large, not to
      // pull 143 MB through a diagnostic.
      try {
        const response = await fetch(`${HOST}/data/${archive.file}`, { method: "HEAD" });
        console.log(`   hosted   : HTTP ${response.status} contentLength=${response.headers.get("content-length") ?? "-"}`);
      } catch (error) {
        console.log(`   hosted   : HEAD failed -- ${error?.message || error}`);
      }
    }
  }

  // Every statistics tab renders one object. Segmenting it emptied all of them: the
  // dashboard summary loads no segments, so the page had nothing to draw and said "No
  // category statistics are available yet" while the data sat in a file nobody fetched.
  // What matters is that it is in the payload the dashboard actually receives.
  {
    const payload = await fetchJson(`${HOST}/api.php?action=state&target=paper&summary=dashboard&strategy_id=conservative`);
    const report = payload.ok ? payload.body?.latestCalculationReport : null;
    console.log(`\n-- statistics tabs -- what renderCalculationReport reads --`);
    if (!payload.ok) {
      console.log(`   dashboard payload HTTP ${payload.status} ${payload.error || ""}`);
    } else if (!report) {
      console.log(`   latestCalculationReport MISSING from the dashboard payload -- every tab would be empty`);
    } else {
      const rows = (key) => (Array.isArray(report[key]) ? report[key].length : "MISSING");
      // Whether the report was rebuilt by the pass that wrote this state or carried over
      // from an earlier one: if its generatedAt matches the state's, the writing pass built
      // it, and a sampleSize of 0 then means that pass was holding no resolved rows.
      console.log(`   state generatedAt=${payload.body?.generatedAt ?? "-"} lastPass=${payload.body?.lastPassTiming?.at ?? "-"}`
        + ` executionPass=${payload.body?.lastPassTiming?.executionPass ?? "-"}`);
      console.log(`   report generatedAt=${report.generatedAt}`
        + ` -> ${report.generatedAt === payload.body?.generatedAt ? "REBUILT by this pass" : "carried over"}`);
      console.log(`   observedSampleSize=${report.observedSampleSize ?? "-"} sampleSize=${report.sampleSize ?? "-"} openSampleSize=${report.openSampleSize ?? "-"}`);
      console.log(`   parameterSummaries=${rows("parameterSummaries")}`
        + ` categorySummaries=${rows("categorySummaries")} tagSummaries=${rows("tagSummaries")}`);
    }
  }

  // High reward measured "since the reset" against a baseline of 0, so its whole balance
  // read as profit. A reset always puts equity on a positive target, so a stored 0 can only
  // be the Number(null) trap -- and these tiles are what the report was about.
  {
    const payload = await fetchJson(`${HOST}/api.php?action=state&target=paper&summary=portfolio-overview`);
    console.log(`\n-- since-the-reset baselines -- a rebaseEquity of 0 is the bug --`);
    if (!payload.ok) {
      console.log(`   overview payload HTTP ${payload.status} ${payload.error || ""}`);
    } else {
      const rows = Object.entries(payload.body?.paperPortfolios || {});
      const rebased = rows.filter(([, row]) => (row?.capitalAdjustmentAt ?? row?.portfolio?.capitalAdjustmentAt) != null);
      if (!rebased.length) console.log(`   no portfolio reports a capital adjustment`);
      for (const [id, row] of rebased) {
        const portfolio = row?.portfolio || {};
        console.log(`   ${id.padEnd(16)} rebaseEquity=${portfolio.rebaseEquityUsdc ?? "MISSING"}`
          + ` equity=${portfolio.equityUsdc ?? "-"}`
          + ` totalSince=${portfolio.totalPnlSinceAdjustmentUsdc ?? "-"}`
          + ` (${portfolio.totalPnlSinceAdjustmentPct ?? "-"})`);
      }
    }
  }

  // Where the last run's time went, as the bot recorded it. The budget is a minute for the
  // whole job, and this is the part of it the bot controls.
  {
    const timing = core.lastPassTiming;
    console.log(`\n-- last pass timing --`);
    if (!timing) console.log(`   lastPassTiming absent -- the state predates the phase breakdown`);
    else {
      console.log(`   at=${timing.at} executionPass=${timing.executionPass} total=${(Number(timing.totalMs || 0) / 1000).toFixed(1)}s`);
      for (const [name, ms] of Object.entries(timing.phasesMs || {})) {
        console.log(`   ${name.padEnd(24)} ${(Number(ms) / 1000).toFixed(2)}s`);
      }
    }
  }

  // What the resolved rows actually settled at.
  //
  // Reported: rows in the Resolved view showing "Final 50.0%", which is not a settlement --
  // a contract settles to 0 or 1. scrapedSimulationOutcome scores anything >= 0.5 as a win,
  // so every one of those counts as a full winning trade, which is what a 92.7% accuracy on
  // a 55% threshold looks like. Before changing the rule, this says how many rows sit at
  // exactly 0.5, how many are cleanly settled, and how many are somewhere in between.
  //
  // Read off the capped recent page rather than the whole archive: a few thousand rows is
  // plenty for a distribution and does not pull 143 MB through a diagnostic.
  {
    console.log(`\n-- resolved settlement prices -- 0.5 is not a settlement --`);
    const recentFile = manifest.resolvedRecent?.file;
    const page = recentFile ? await fetchJson(`${HOST}/data/${recentFile}`) : { ok: false, error: "no recent page in the manifest" };
    if (!page.ok) {
      console.log(`   could not read the recent page: ${page.error || `HTTP ${page.status}`}`);
    } else {
      const rows = Array.isArray(page.body?.resolvedMarketObservations) ? page.body.resolvedMarketObservations : [];
      const buckets = { "null": 0, "exactly 0.5": 0, "0 or 1": 0, "<0.02 or >0.98": 0, "in between": 0 };
      const middleExamples = [];
      for (const row of rows) {
        const value = row?.finalOutcomePrice;
        if (value == null || value === "") { buckets["null"] += 1; continue; }
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) { buckets["null"] += 1; continue; }
        if (numeric === 0.5) {
          buckets["exactly 0.5"] += 1;
          if (middleExamples.length < 5) {
            middleExamples.push(`${numeric} closed=${row.marketClosed} accepting=${row.acceptingOrders} status=${row.resolutionStatus} ${String(row.question || "").slice(0, 48)}`);
          }
          continue;
        }
        if (numeric === 0 || numeric === 1) { buckets["0 or 1"] += 1; continue; }
        if (numeric < 0.02 || numeric > 0.98) { buckets["<0.02 or >0.98"] += 1; continue; }
        buckets["in between"] += 1;
        if (middleExamples.length < 5) {
          middleExamples.push(`${numeric} closed=${row.marketClosed} accepting=${row.acceptingOrders} status=${row.resolutionStatus} ${String(row.question || "").slice(0, 48)}`);
        }
      }
      console.log(`   rows on the recent page: ${rows.length}`);
      for (const [name, count] of Object.entries(buckets)) {
        const share = rows.length ? ((count / rows.length) * 100).toFixed(1) : "0.0";
        console.log(`   ${name.padEnd(16)} ${String(count).padStart(6)}  (${share}%)`);
      }
      // How many of those the current rule would score as wins.
      const scoredWins = rows.filter((row) => {
        const numeric = Number(row?.finalOutcomePrice);
        return Number.isFinite(numeric) && numeric >= 0.5 && numeric <= 1;
      }).length;
      const cleanWins = rows.filter((row) => Number(row?.finalOutcomePrice) > 0.98).length;
      console.log(`   scored as wins by the >= 0.5 rule: ${scoredWins}`);
      console.log(`   settled clearly toward 1 (> 0.98) : ${cleanWins}`);
      for (const example of middleExamples) console.log(`   example  : ${example}`);
    }
  }

  // Which row is which.
  //
  // Reported as impossible: a row labelled 55.0% multi-outcome claiming 26,209 of 28,269
  // correct. The threshold is a floor -- scrapedSimulationMatchesRule keeps every row with
  // entry >= threshold -- so a row labelled 55% summarises everything from 0.55 upward and
  // its win rate belongs to that sample, not to 55% trades. avgProbability is what says
  // which, so every populated row prints both, biggest sample first, and the one the report
  // is about can be picked out by its counts instead of guessed at.
  {
    const payload = await fetchJson(`${HOST}/api.php?action=state&target=paper&summary=dashboard&strategy_id=conservative`);
    const report = payload.ok ? payload.body?.latestCalculationReport : null;
    const rows = Array.isArray(report?.parameterSummaries) ? report.parameterSummaries : [];
    console.log(`\n-- parameter rows: threshold is a floor, avgEntry is the sample --`);
    console.log(`   report generatedAt=${report?.generatedAt ?? "-"} sampleSize=${report?.sampleSize ?? "-"}`);
    const populated = rows.filter((row) => Number(row.resolved) > 0)
      .sort((a, b) => Number(b.resolved) - Number(a.resolved));
    if (!populated.length) {
      console.log(`   every parameter row reports resolved=0 out of ${rows.length} rows`);
    }
    for (const row of populated.slice(0, 16)) {
      const pct = (value) => (value == null ? "-" : `${(Number(value) * 100).toFixed(1)}%`);
      console.log(`   ${String(row.marketType).padEnd(6)} floor=${pct(row.threshold).padStart(6)}`
        + ` maxDays=${String(row.maxResolutionDays ?? "-").padStart(3)}`
        + ` resolved=${String(row.resolved).padStart(6)} wins=${String(row.wins).padStart(6)}`
        + ` winRate=${pct(row.winRate).padStart(6)} avgEntry=${pct(row.avgProbability).padStart(6)}`
        + ` roi=${row.roi ?? "-"}`);
    }
  }

  // Why a pass skipped, from the pass's own record.
  //
  // Reported: a portfolio on the hourly cron trigger logged "no eligible non-duplicate
  // candidate" and "no eligible non-correlated candidate", and began opening positions once
  // switched to after-scrape. Those two reasons are the two arms of findFirstOpenCandidate:
  // the first means every eligible candidate was a market the portfolio already held, the
  // second that some were blocked as correlated with a holding. Both are transient states,
  // so how often a portfolio gets to look matters as much as what it sees -- which is why
  // the gap between consecutive runs is printed too.
  {
    console.log(`\n-- SKIP decisions, and how often each portfolio got to look --`);
    const configured = await fetchJson(`${HOST}/api.php?action=portfolio-config`);
    const paper = configured.ok ? (configured.body?.config?.paper || {}) : {};
    for (const id of Object.keys(paper)) {
      const rows = [];
      for (const page of [0, 1, 2]) {
        const list = await fetchJson(
          `${HOST}/api.php?action=portfolio-run-log&strategy_id=${encodeURIComponent(id)}&page=${page}&page_size=24`,
        );
        if (!list.ok) break;
        rows.push(...(list.body?.records || []));
        if (!list.body?.hasMore) break;
      }
      if (!rows.length) {
        console.log(`   ${id}: no run-log rows`);
        continue;
      }
      // Median gap between consecutive runs: what the configured cadence actually delivers.
      const times = rows.map((row) => Date.parse(row?.runAt || "")).filter(Number.isFinite).sort((a, b) => b - a);
      const gaps = times.slice(0, -1).map((at, index) => (at - times[index + 1]) / 60000).filter((value) => value > 0);
      const median = gaps.length ? gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : null;
      const config = paper[id] || {};
      console.log(`   ${id.padEnd(16)} trigger=${config.executionTrigger ?? "-"}`
        + ` cronMinutes=${config.executionCronMinutes ?? "-"}`
        + ` rotation=${config.autoRotatePositions === true ? "on" : "off"}`
        + ` rows=${rows.length} medianGap=${median == null ? "-" : `${median.toFixed(1)}min`}`);

      // The two reasons the report is about, wherever they appear in this window.
      // Anchored on "no eligible": the OPENED reason also contains "non-correlated"
      // ("best Reward / risk non-correlated candidate"), so an unanchored match reports
      // successful opens as if they were the skips being investigated.
      const wanted = rows
        .filter((row) => /^no eligible non-(duplicate|correlated) candidate/.test(String(row?.reason || "")))
        .slice(0, 2);
      for (const row of wanted) {
        const detail = await fetchJson(
          `${HOST}/api.php?action=portfolio-run-log-detail&strategy_id=${encodeURIComponent(id)}`
          + `&run_at=${encodeURIComponent(row.runAt)}`,
        );
        const record = detail.ok ? detail.body?.record : null;
        const batch = record?.batchLog || {};
        const counts = batch.counts || {};
        console.log(`      ${row.runAt} ${record?.runSource ?? "-"} -- ${String(row.reason || "").slice(0, 46)}`);
        console.log(`         trigger=${batch.settings?.executionTrigger ?? "-"}`
          + ` rotation=${batch.rotationReview?.action ?? "-"}`
          + ` openTrades=${counts.openTrades ?? "-"}`
          + ` rankedEligible=${counts.rankedEligible ?? "-"}`
          + ` skippedForRisk=${counts.skippedForRisk ?? "-"}`);
        // Whether that pass requoted its shortlist. The stored-candidates path sets this on
        // every candidate it considered; the full-evaluation path never revalidates at all.
        const verified = (batch.eligibleCandidates || []).filter((c) => c && c.executionQuoteVerified === true).length;
        console.log(`         eligibleLogged=${(batch.eligibleCandidates || []).length} quoteVerified=${verified}`);
      }
    }
  }

  // What a limit-order portfolio has promised versus what it can still deploy.
  //
  // A resting buy is not exposure: it may never fill, and when the event ends unfilled it
  // is discarded having cost nothing. Free capital still counts it, because it is what is
  // currently allocated -- so a portfolio resting several orders could report almost no
  // free capital and skip for "not enough free paper capital" while risking nothing. The
  // next order is now sized against a different figure, and both are published, so this
  // prints them side by side with the waiting rows they came from. deployable == free on a
  // portfolio that does not rest orders; deployable > free is the whole point on one that
  // does. A missing deployable field means the state predates the change.
  {
    console.log(`\n-- limit orders: what is promised is not what is at risk --`);
    const configured = await fetchJson(`${HOST}/api.php?action=portfolio-config`);
    const paper = configured.ok ? (configured.body?.config?.paper || {}) : {};
    for (const [id, config] of Object.entries(paper)) {
      const served = await fetchJson(
        `${HOST}/api.php?action=state&target=paper&summary=dashboard&strategy_id=${encodeURIComponent(id)}`,
      );
      if (!served.ok) {
        console.log(`   ${id.padEnd(16)} served HTTP ${served.status} ${served.error || ""}`);
        continue;
      }
      const entry = (served.body?.paperPortfolios || {})[id] || {};
      const portfolio = entry.portfolio || {};
      const trades = Array.isArray(entry.trades) ? entry.trades : [];
      const waiting = trades.filter((trade) => String(trade?.status || "") === "LIMIT_ORDER_WAITING");
      const waitingRisk = waiting.reduce(
        (sum, trade) => sum + (Number(trade?.maxLossUsdc) || Number(trade?.stakeUsdc) || 0),
        0,
      );
      const num = (value) => (value == null ? "MISSING" : Number(value).toFixed(2));
      console.log(`   ${id.padEnd(16)} limitOrders=${config.useLimitOrders === true ? "on " : "off"}`
        + ` free=${num(portfolio.freeCapitalUsdc).padStart(7)}`
        + ` resting=${num(portfolio.restingLimitOrderUsdc).padStart(7)}`
        + ` deployable=${num(portfolio.deployableCapitalUsdc).padStart(7)}`
        + ` waitingRows=${String(waiting.length).padStart(2)} (${waitingRisk.toFixed(2)} USDC)`);
      // The split the overview table now shows as two columns. Printed with the total so a
      // mismatch is visible: the halves have to add up to it, or the table and the Risk
      // tile are describing different accounts.
      const positions = Number(portfolio.positionRiskUsdc);
      const resting = Number(portfolio.restingLimitOrderUsdc);
      const total = Number(portfolio.openRiskUsdc);
      const reconciles = [positions, resting, total].every(Number.isFinite)
        && Math.abs(positions + resting - total) < 0.02;
      console.log(`      risk split  : inPositions=${num(portfolio.positionRiskUsdc).padStart(7)}`
        + ` inOrders=${num(portfolio.restingLimitOrderUsdc).padStart(7)}`
        + ` total=${num(portfolio.openRiskUsdc).padStart(7)}`
        + ` -> ${Number.isFinite(positions) ? (reconciles ? "adds up" : "DOES NOT ADD UP") : "positionRiskUsdc MISSING"}`);
      // The skip this is meant to stop, and the clause that says the new rule ran.
      const log = await fetchJson(
        `${HOST}/api.php?action=portfolio-run-log&strategy_id=${encodeURIComponent(id)}&page=0&page_size=24`,
      );
      const capitalSkips = (log.ok ? (log.body?.records || []) : [])
        .filter((row) => /not enough free paper capital/i.test(String(row?.reason || "")))
        .slice(0, 2);
      for (const row of capitalSkips) {
        // The clause is only written when there was something resting to discount, because
        // with nothing resting the two rules produce the same number and naming a rule
        // would be inventing a difference. So a skip without it is only evidence of the old
        // rule on a portfolio that had orders waiting -- read the other way it reports every
        // genuinely broke portfolio as un-migrated.
        const counted = /unfilled limit orders is not counted against this/i.test(String(row.reason || ""));
        const verdict = counted
          ? "NEW rule applied"
          : config.useLimitOrders !== true
            ? "no limit orders, rule does not apply"
            : "nothing resting on this row, both rules agree";
        console.log(`      ${row.runAt} capital skip -- ${verdict}`);
        console.log(`         ${String(row.reason || "").slice(0, 150)}`);
      }
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
    // page=0 is the first page. This asked for page 1 and reported "0 rows" for every
    // portfolio whose log is shorter than one page -- which reads exactly like lost
    // history and was only the second page of a short list. The total is printed beside
    // the count now, so a partial page can never be mistaken for an empty log again.
    const runLog = await fetchJson(
      `${HOST}/api.php?action=portfolio-run-log&strategy_id=${encodeURIComponent(id)}&page=0&page_size=24`,
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
      const total = runLog.body?.total;
      console.log(`  run log  : ${rows.length} of ${total ?? "?"} row(s) -- ${summary}`);
    }
  }
}

// A read-only diagnostic that dies on a dropped connection is worse than one that says so:
// the exit code then reads as "something is wrong with production" when the finding is
// only that a shared host hung up.
main().catch((error) => {
  console.log(`\n!! diagnosis stopped early: ${error?.message || error}`);
  process.exitCode = 1;
});
