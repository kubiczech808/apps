// Read-only diagnostic. Writes nothing, publishes nothing, needs no secrets.
//
// Reported: practically every position shows "no tags recorded", yet every Polymarket
// event carries at least one tag (sports, for instance). Two questions have to be answered
// separately, and the second one cannot be guessed:
//
//   1. HOW MANY stored rows actually lack tags -- positions, closed trades, unfilled
//      orders and scraped observations -- so the scale is a measurement, not an impression.
//   2. WHICH Gamma query returns tags at all. The scan builds its URLs through
//      gammaResourceUrl(), which sets `active` and `closed` and nothing about tags, and
//      marketPolymarketTags() then reads market.tags and market.events[].tags. If Gamma
//      omits tags from /markets unless asked, those reads find nothing and every row is
//      stored tagless -- but the parameter that changes that is Gamma's to define, so this
//      asks Gamma rather than assuming a name for it.
//
// The answer to (2) is what a fix has to be built on, and the same query is what a backfill
// over already-resolved events would use.
const HOST = process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading";
const GAMMA = process.env.POLYMARKET_GAMMA_API || "https://gamma-api.polymarket.com";
const SAMPLE = Math.max(1, Number(process.env.PROBE_SAMPLE || 4));

async function fetchJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 160)}`);
  return JSON.parse(text);
}

// portfolioAnalysisTags() in app.js, quoted, so "has tags" here means exactly what the
// dashboard means by it.
const tagOf = (value) => String(value && typeof value === "object"
  ? (value.slug || value.label || value.name || "")
  : value || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");

function storedTags(row = {}) {
  const tags = new Set();
  const source = row.sourceEvaluation || {};
  for (const values of [
    row.polymarketTags, row.tags, row.firstPolymarketTags,
    source.polymarketTags, source.tags, source.firstPolymarketTags,
  ]) {
    for (const value of (Array.isArray(values) ? values : [])) {
      const tag = tagOf(value);
      if (tag) tags.add(tag);
    }
  }
  for (const value of [row.category, row.riskCategory, source.category, source.riskCategory]) {
    const tag = tagOf(value);
    if (tag) tags.add(tag);
  }
  return [...tags];
}

function report(label, rows) {
  const list = Array.isArray(rows) ? rows : [];
  const tagged = list.filter((row) => storedTags(row).length);
  console.log(`   ${label.padEnd(34)} ${String(list.length).padStart(5)} rows, ${String(tagged.length).padStart(5)} with tags`
    + `${list.length ? ` (${((tagged.length / list.length) * 100).toFixed(1)}%)` : ""}`);
  return list;
}

async function main() {
  console.log(`Market tags coverage diagnosis at ${new Date().toISOString()}`);
  console.log("Read-only: nothing is written, no credentials are used.\n");

  console.log("== 1. how many stored rows carry a tag today");
  const live = await fetchJson(`${HOST}/api.php?action=state&target=live&t=${Date.now()}`)
    .then((payload) => payload?.state || payload || {});
  const livePositions = report("live positions", live.positions);
  const liveClosed = report("live closed trades", live.closedTrades);
  report("live unfilled limit orders", live.unfilledLimitOrders);

  const scraped = await fetchJson(`${HOST}/api.php?action=state&target=paper&summary=execution&t=${Date.now()}`)
    .then((payload) => payload?.state || payload || {})
    .catch(() => ({}));
  const observations = report("scraped observations (page 1)", scraped.marketObservations);

  const overview = await fetchJson(`${HOST}/api.php?action=state&target=paper&summary=portfolio-overview&t=${Date.now()}`)
    .then((payload) => payload?.state || payload || {})
    .catch(() => ({}));
  const paperIds = Object.keys(overview.paperPortfolios || {});
  let paperRows = [];
  for (const id of paperIds.slice(0, 6)) {
    const payload = await fetchJson(`${HOST}/api.php?action=state&target=paper&summary=dashboard&strategy_id=${encodeURIComponent(id)}&t=${Date.now()}`)
      .catch(() => null);
    const trades = (payload?.state || payload || {}).paperPortfolios?.[id]?.trades;
    if (Array.isArray(trades)) paperRows = paperRows.concat(trades);
  }
  report(`paper trades (${Math.min(6, paperIds.length)} portfolios)`, paperRows);

  // 2. Ask Gamma. The rows are taken from real stored positions so the probe is about
  // markets this account actually traded, not an arbitrary market that might behave
  // differently.
  const samples = [...livePositions, ...liveClosed, ...observations]
    .filter((row) => String(row?.tokenId || row?.assetId || "").trim())
    .filter((row) => !storedTags(row).length)
    .slice(0, SAMPLE);
  console.log(`\n== 2. which Gamma query returns tags (${samples.length} untagged market(s) from our own state)`);

  const verdicts = new Map();
  for (const row of samples) {
    const tokenId = String(row.tokenId || row.assetId || "").trim();
    const slug = String(row.slug || "").trim();
    const eventSlug = String(row.eventSlug || "").trim();
    const conditionId = String(row.conditionId || row.market || "").trim();
    console.log(`\n-- "${String(row.question || "").slice(0, 70)}"`);
    console.log(`   slug ${slug || "-"}   eventSlug ${eventSlug || "-"}`);

    const attempts = [
      ["markets?clob_token_ids", `${GAMMA}/markets?clob_token_ids=${encodeURIComponent(tokenId)}&closed=true`],
      ["markets + include_tag", `${GAMMA}/markets?clob_token_ids=${encodeURIComponent(tokenId)}&closed=true&include_tag=true`],
      ...(conditionId ? [["markets?condition_ids", `${GAMMA}/markets?condition_ids=${encodeURIComponent(conditionId)}&closed=true`]] : []),
      ...(slug ? [["markets?slug + include_tag", `${GAMMA}/markets?slug=${encodeURIComponent(slug)}&closed=true&include_tag=true`]] : []),
      ...(eventSlug ? [["events?slug", `${GAMMA}/events?slug=${encodeURIComponent(eventSlug)}&closed=true`]] : []),
      ...(eventSlug ? [["events?slug (unfiltered)", `${GAMMA}/events?slug=${encodeURIComponent(eventSlug)}`]] : []),
    ];

    for (const [label, url] of attempts) {
      let payload = null;
      try {
        payload = await fetchJson(url);
      } catch (error) {
        console.log(`   ${label.padEnd(28)} threw: ${String(error.message).slice(0, 54)}`);
        continue;
      }
      const list = Array.isArray(payload) ? payload : [];
      const hit = list[0] || null;
      if (!hit) {
        console.log(`   ${label.padEnd(28)} no row`);
        continue;
      }
      // Both shapes matter: /markets may carry tags directly or only inside its parent
      // events, and /events carries them at the top level.
      const own = Array.isArray(hit.tags) ? hit.tags : [];
      const viaEvents = (Array.isArray(hit.events) ? hit.events : [])
        .flatMap((event) => (Array.isArray(event?.tags) ? event.tags : []));
      const viaMarkets = (Array.isArray(hit.markets) ? hit.markets : [])
        .flatMap((market) => (Array.isArray(market?.tags) ? market.tags : []));
      const all = [...own, ...viaEvents, ...viaMarkets].map(tagOf).filter(Boolean);
      const unique = [...new Set(all)];
      console.log(`   ${label.padEnd(28)} tags ${String(unique.length).padStart(2)}`
        + `  own ${own.length} / events ${viaEvents.length} / markets ${viaMarkets.length}`
        + `${unique.length ? `  -> ${unique.slice(0, 8).join(", ")}` : ""}`);
      if (unique.length) verdicts.set(label, (verdicts.get(label) || 0) + 1);
      // Print the raw shape once, so a future change knows what it is reading.
      if (unique.length && !verdicts.has(`__shape:${label}`)) {
        verdicts.set(`__shape:${label}`, 1);
        const firstTag = own[0] || viaEvents[0] || viaMarkets[0];
        console.log(`     raw tag entry: ${JSON.stringify(firstTag).slice(0, 160)}`);
      }
    }
  }

  console.log(`\n== which queries produced tags, and for how many of the sampled markets`);
  for (const [label, count] of [...verdicts.entries()]
    .filter(([label]) => !label.startsWith("__shape:"))
    .sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(count).padStart(3)} / ${samples.length}  ${label}`);
  }
  if (![...verdicts.keys()].some((key) => !key.startsWith("__shape:"))) {
    console.log("   none -- no query tried here returns tags for these markets");
  }
}

main().catch((error) => {
  console.log(`\n!! diagnosis stopped early: ${error?.message || error}`);
  process.exitCode = 1;
});
