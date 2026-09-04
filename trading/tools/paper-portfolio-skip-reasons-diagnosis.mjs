// Read-only diagnostic. Writes nothing, publishes nothing, needs no secrets.
//
// Reported, on counter-strike-2 and asked of every other paper portfolio too:
//
//   Action: SKIP
//   Reason: No order placed: no candidate passed this portfolio's current rules.
//   Note:   No counter-strike-2 trade was opened: no candidates passed counter-strike-2
//           portfolio filters.
//
// That message names no rule, but the bot already recorded which one. storedExecutionShortlist
// runs portfolioFilterResult over the whole candidate pool and keeps `reasonCounts`, a
// histogram of every rejection reason, in the run's batchLog.prevalidationFilter. So this
// reads the published run log rather than re-deriving anything: what it reports is what the
// bot decided at that moment.
//
// The distinction that matters when reading the output: a portfolio rejecting candidates on
// PRICE, EDGE or RETURN is working -- the market simply is not offering what it asks for,
// and that resolves itself. A portfolio whose every candidate dies on the same structural
// gate (a tag it cannot carry, a market type nothing matches, a horizon no market has) is
// stopped by its own configuration and will never trade until that is changed.
const HOST = process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading";
const ONLY = process.env.PAPER_DIAGNOSIS_STRATEGY_ID || "";
const RUNS_TO_READ = Number(process.env.PAPER_DIAGNOSIS_RUNS || 6);

const text = (value) => String(value == null ? "" : value).trim();

async function fetchJson(url) {
  const response = await fetch(url);
  const body = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 140)}`);
  return JSON.parse(body);
}

// Collapse the numbers so shapes group: "probability 62.0% below 70.0%" and "probability
// 41.0% below 70.0%" are one finding, not two hundred.
const shapeOf = (reason) => text(reason).replace(/-?\d[\d.,]*/g, "N");

// Which reasons are a configuration dead end rather than a market that did not suit today.
function isStructural(shape) {
  return /included tags|excluded tag|market type|over\/under|most probable|resolution|horizon|days/i.test(shape);
}

async function main() {
  console.log(`Paper portfolio skip reasons at ${new Date().toISOString()}`);
  console.log(`Read-only: nothing is written, no credentials are used.\n`);

  const config = await fetchJson(`${HOST}/api.php?action=portfolio-config&t=${Date.now()}`).catch(() => null);
  const paper = config?.config?.paper || {};
  const ids = Object.keys(paper).filter((id) => !ONLY || id === ONLY);
  if (!ids.length) {
    console.log(`no paper portfolios returned under config.paper${ONLY ? ` matching "${ONLY}"` : ""}.`);
    return;
  }
  console.log(`${ids.length} paper portfolio(s): ${ids.join(", ")}\n`);

  const stuck = [];
  for (const id of ids) {
    const settings = paper[id] || {};
    const label = text(settings.label) || id;
    let state = null;
    try {
      state = await fetchJson(
        `${HOST}/api.php?action=state&target=paper&summary=dashboard`
        + `&strategy_id=${encodeURIComponent(id)}&t=${Date.now()}`,
      );
    } catch (error) {
      console.log(`== ${label} (${id})\n   state unavailable: ${error.message}\n`);
      continue;
    }

    const portfolio = state?.paperPortfolios?.[id] || {};
    const runLog = Array.isArray(portfolio.runLog) ? portfolio.runLog : [];
    console.log(`== ${label} (${id})`);
    console.log(`   automation ${settings.automationEnabled ? "on" : "OFF"}`
      + `   archived ${settings.archived ? "yes" : "no"}`
      + `   cron ${settings.executionCronMinutes ?? "-"} min`
      + `   run log ${runLog.length} entr${runLog.length === 1 ? "y" : "ies"}`);
    if (settings.includeOnlyMarketTags) {
      console.log(`   includeOnlyMarketTags: ${JSON.stringify(settings.includeOnlyMarketTags)}`);
    }
    if (!runLog.length) {
      console.log(`   no runs recorded -- nothing has executed for this portfolio at all.\n`);
      continue;
    }

    const recent = runLog.slice(0, RUNS_TO_READ);
    const actions = new Map();
    for (const run of recent) actions.set(text(run.action) || "-", (actions.get(text(run.action) || "-") || 0) + 1);
    console.log(`   last ${recent.length} run(s): ${[...actions.entries()].map(([a, n]) => `${a} x${n}`).join(", ")}`);
    console.log(`   newest ${text(recent[0]?.generatedAt || recent[0]?.at)}  ${text(recent[0]?.reason).slice(0, 96)}`);

    // The histogram the bot itself kept, from the NEWEST run that carries one -- and the
    // run it came from is named, because it need not be the newest run.
    //
    // This previously preferred the newest run with a non-empty reasonCounts and printed it
    // directly under the newest run's action. When a portfolio had just started trading
    // again, that paired an old SKIP's counts with a new OPENED headline: the block read
    // "eligible after revalidation 0" for a portfolio that had, on its most recent run,
    // opened a trade. Reporting two different runs as one is exactly the confusion this
    // tool exists to remove.
    const sourceRun = recent.find((run) => run?.batchLog?.prevalidationFilter);
    const filter = sourceRun?.batchLog?.prevalidationFilter || null;
    if (!filter) {
      console.log(`   no prevalidationFilter recorded on these runs, so the pool cannot be read here.\n`);
      continue;
    }
    const sourceIsNewest = sourceRun === recent[0];
    console.log(`   figures below are from the ${sourceIsNewest ? "newest" : "most recent run that recorded them"}:`
      + ` ${text(sourceRun.action) || "-"} ${text(sourceRun.generatedAt || sourceRun.at)}`
      + `${sourceIsNewest ? "" : "  <- NOT the newest run; the newest is above"}`);

    const pool = Number(filter.uniqueEvaluations ?? 0);
    const passed = Number(filter.portfolioPrefilterPassed ?? filter.prefilterPassed ?? 0);
    console.log(`   candidate pool ${pool}`
      + `   scanned observations ${filter.scannedMarketObservations ?? "-"}`
      + `   passed this portfolio's filter ${passed}`
      + `   revalidated ${filter.revalidatedCount ?? "-"}`
      + `   eligible after revalidation ${filter.revalidatedPortfolioEligible ?? "-"}`);

    const counts = filter.reasonCounts || {};
    const ranked = Object.entries(counts)
      .map(([reason, count]) => [shapeOf(reason), Number(count) || 0])
      .reduce((map, [shape, count]) => map.set(shape, (map.get(shape) || 0) + count), new Map());
    const sorted = [...ranked.entries()].sort((a, b) => b[1] - a[1]);
    if (!sorted.length) {
      console.log(`   no rejection reasons recorded on this run.`);
    } else {
      console.log(`   why every candidate was rejected:`);
      for (const [shape, count] of sorted.slice(0, 10)) {
        const flag = isStructural(shape) ? "!" : " ";
        const share = pool > 0 ? ` (${((count / pool) * 100).toFixed(0)}% of the pool)` : "";
        console.log(`   ${flag}${String(count).padStart(5)}  ${shape.slice(0, 92)}${share}`);
      }
    }

    // Stage two, which the pool histogram above cannot see. Those counts are the whole
    // catalogue measured against the portfolio's rules; what happens NEXT is that the
    // survivors are re-quoted against the live CLOB, and a portfolio can lose every one of
    // them there. That is a different failure with different causes, and the run log keeps
    // its reasons separately in revalidatedRejectedSample.
    const revalidated = Number(filter.revalidatedCount ?? 0);
    const survived = Number(filter.revalidatedPortfolioEligible ?? 0);
    const sample = Array.isArray(filter.revalidatedRejectedSample) ? filter.revalidatedRejectedSample : [];
    if (revalidated > 0 && survived === 0) {
      const stageTwo = new Map();
      for (const row of sample) {
        for (const reason of (Array.isArray(row.portfolioRejectReasons) ? row.portfolioRejectReasons : [])) {
          const shape = shapeOf(reason);
          stageTwo.set(shape, (stageTwo.get(shape) || 0) + 1);
        }
      }
      console.log(`   all ${revalidated} candidate(s) that passed the filter then died at revalidation:`);
      if (!stageTwo.size) {
        console.log(`      no per-candidate reasons recorded on this run.`);
      }
      for (const [shape, count] of [...stageTwo.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
        console.log(`      ${String(count).padStart(4)}  ${shape.slice(0, 92)}`);
      }
    }

    // The findings that matter, in order of how badly they strand a portfolio.
    const skipRuns = recent.filter((run) => text(run.action).toUpperCase() === "SKIP").length;
    const blocking = sorted.filter(([shape, count]) => pool > 0 && count >= pool && isStructural(shape));
    // A tag no market carries. Not "every candidate failed" -- a whitelist is SUPPOSED to
    // reject most of the catalogue -- but a whitelist matching a rounding error of it, which
    // is what a misspelt or non-existent tag looks like from here.
    const tagShape = sorted.find(([shape]) => /included tags/.test(shape));
    const matched = pool > 0 && tagShape ? pool - tagShape[1] : null;
    const tagIsPhantom = matched != null && pool >= 500 && matched <= Math.max(2, pool * 0.001);

    if (blocking.length) {
      stuck.push({ id, label, why: `every one of the ${pool} candidates fails: ${blocking.map(([s]) => s).join("; ")}` });
      console.log(`   -> STUCK: every one of the ${pool} candidates fails a structural gate here,`);
      console.log(`      so no market can pass until the setting changes.`);
    } else if (pool === 0) {
      stuck.push({ id, label, why: "the candidate pool itself is empty" });
      console.log(`   -> STUCK: the candidate pool is empty, so there is nothing to filter.`);
    } else if (tagIsPhantom) {
      stuck.push({
        id,
        label,
        phantomTags: settings.includeOnlyMarketTags,
        why: `only ${matched} of ${pool} markets carry ${JSON.stringify(settings.includeOnlyMarketTags)}`
          + ` -- the tag looks wrong, not the market`,
      });
      console.log(`   -> STUCK: only ${matched} of the ${pool} markets carry the required tag. A`);
      console.log(`      whitelist is meant to reject most of a catalogue, but not all but ${matched} of it:`);
      console.log(`      that is a tag string no market actually uses.`);
    } else if (revalidated > 0 && survived === 0 && skipRuns >= recent.length && sourceIsNewest) {
      stuck.push({
        id,
        label,
        why: `finds ${revalidated} candidate(s) every run and loses all of them at revalidation,`
          + ` ${skipRuns} SKIP run(s) in a row`,
      });
      console.log(`   -> STALLED: it does find candidates (${revalidated}) and loses every one of them`);
      console.log(`      at revalidation, on ${skipRuns} consecutive SKIP runs. See the stage-two reasons above.`);
    }
    console.log("");
  }

  console.log(`== portfolios that are not going to start trading on their own`);
  if (!stuck.length) {
    console.log(`   none -- every portfolio is rejecting on price/edge/return, which the market fixes by itself.`);
    return;
  }
  for (const entry of stuck) {
    console.log(`   ${entry.label} (${entry.id})`);
    console.log(`      ${entry.why}`);
  }
  console.log(`\n   A portfolio turning candidates down on price, edge or return is working: the`);
  console.log(`   market will eventually offer what it asks for. These will not, on their own.`);

  // For a tag nothing carries, saying so is only half an answer. What the markets it is
  // plainly meant to trade ARE tagged with is the other half, and it comes from the served
  // catalogue -- matched on the words in the question, precisely because the tags are the
  // thing under suspicion.
  const phantom = stuck.filter((entry) => Array.isArray(entry.phantomTags) && entry.phantomTags.length);
  if (!phantom.length) return;
  const catalogue = await fetchJson(
    `${HOST}/api.php?action=state&target=paper&summary=execution&t=${Date.now()}`,
  ).catch(() => null);
  const rows = Array.isArray(catalogue?.marketObservations) ? catalogue.marketObservations : [];
  if (!rows.length) return;

  const slugify = (value) => String(value ?? "")
    .trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  const tagsOf = (item) => {
    const slugs = new Set();
    for (const field of ["polymarketTags", "tags", "firstPolymarketTags", "firstTags",
      "polymarketCategories", "firstPolymarketCategories"]) {
      for (const raw of (Array.isArray(item?.[field]) ? item[field] : [])) {
        const tag = slugify(raw && typeof raw === "object" ? (raw.slug || raw.label || raw.name || "") : raw);
        if (tag) slugs.add(tag);
      }
    }
    for (const field of ["riskCategory", "category", "firstCategory"]) {
      const tag = slugify(item?.[field]);
      if (tag) slugs.add(tag);
    }
    return slugs;
  };

  console.log(`\n== what the markets those portfolios want are actually tagged with`);
  for (const entry of phantom) {
    const words = entry.phantomTags
      .flatMap((tag) => String(tag).split("-"))
      .filter((word) => word.length > 2 && !/^\d+$/.test(word));
    const relevant = rows.filter((row) => {
      const haystack = `${text(row.question)} ${text(row.slug)} ${text(row.eventSlug)}`.toLowerCase();
      return words.some((word) => haystack.includes(word));
    });
    console.log(`\n   ${entry.label} (${entry.id}) wants ${JSON.stringify(entry.phantomTags)}`);
    console.log(`   markets whose question or slug mentions it: ${relevant.length}`);
    const histogram = new Map();
    for (const row of relevant) for (const tag of tagsOf(row)) histogram.set(tag, (histogram.get(tag) || 0) + 1);
    const ranked = [...histogram.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
    if (!ranked.length) {
      console.log(`   those markets carry no tags at all, so no tag whitelist can select them.`);
      continue;
    }
    console.log(`   the tags they DO carry: ${ranked.map(([tag, count]) => `${tag} (${count})`).join(", ")}`);
    for (const row of relevant.slice(0, 3)) {
      console.log(`      "${text(row.question).slice(0, 52)}"`);
      console.log(`        tagged: ${[...tagsOf(row)].join(", ") || "(nothing)"}`);
    }
  }
}

main().catch((error) => {
  console.log(`\n!! diagnosis stopped early: ${error?.message || error}`);
  process.exitCode = 1;
});
