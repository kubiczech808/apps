// Read-only diagnostic. Writes nothing, publishes nothing, needs no secrets.
//
// Reported: some paper portfolios are not running. One of them logged a candidate rejected
// with "probability NaN% below high-confidence threshold and edge-opportunity threshold;
// annualized EV 0.0% is non-profitable after fees; outside included tags
// (league-of-legends)" -- against a row the table showed at 74.0% with +6,219.9% p.a.
//
// Three separate claims are packed into that one string and they need separating before
// anything is fixed:
//
//   1. "outside included tags (league-of-legends)". The portfolio only accepts markets
//      carrying that tag. If the scraped catalogue does not carry it -- because Gamma
//      publishes a league tag somewhere the scan does not read -- then NO candidate can ever
//      pass, and the portfolio is stopped dead by its own filter rather than by the market.
//      That is the one that would explain a portfolio that never trades.
//   2. "probability NaN%". A stored reject reason, written when the market was scored, on a
//      row whose displayed probability is a perfectly good 74%. NaN is not a low number, it
//      is a missing one, and it needs finding rather than assuming.
//   3. "annualized EV 0.0% is non-profitable". Almost certainly a consequence of (2).
//
// So this measures, for every paper portfolio: what its tag filter requires, how many rows in
// the served catalogue actually carry those tags, and what the stored reject reasons say
// across the catalogue -- which is what turns "some portfolios are not running" into a list
// of which ones and why.
const HOST = process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading";

const text = (value) => String(value == null ? "" : value).trim();
const slugify = (value) => String(value ?? "")
  .trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");

async function fetchJson(url) {
  const response = await fetch(url);
  const body = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 140)}`);
  return JSON.parse(body);
}

// rowTagSlugs() from paper-trading-bot.mjs, quoted, so "carries the tag" here means exactly
// what the filter means by it.
function rowTagSlugs(item = {}) {
  const slugs = new Set();
  for (const list of [item.polymarketTags, item.tags, item.firstTags]) {
    for (const raw of (Array.isArray(list) ? list : [])) {
      const tag = slugify(raw && typeof raw === "object" ? (raw.slug || raw.label || raw.name || "") : raw);
      if (tag) slugs.add(tag);
    }
  }
  for (const key of [item.riskCategory, item.category, item.firstCategory]) {
    const tag = slugify(key);
    if (tag) slugs.add(tag);
  }
  return slugs;
}

function tagListOf(portfolio = {}) {
  const raw = portfolio.includeOnlyMarketTags;
  const list = Array.isArray(raw) ? raw : String(raw || "").split(",");
  return [...new Set(list.map(slugify).filter(Boolean))];
}

// execution_scope_observation_tags() in api.php, quoted. It reads a DIFFERENT set of fields
// from the bot's rowTagSlugs above -- firstPolymarketTags and polymarketCategories here,
// firstTags and category/firstCategory there -- so the server's serving filter and the
// portfolio's own filter can disagree about whether a row carries a tag at all.
function serverTagSlugs(item = {}) {
  const slugs = new Set();
  for (const key of ["polymarketTags", "tags", "firstPolymarketTags", "firstTags",
    "polymarketCategories", "firstPolymarketCategories", "riskCategory"]) {
    const raw = item?.[key];
    for (const entry of (Array.isArray(raw) ? raw : [raw])) {
      const tag = slugify(entry && typeof entry === "object" ? (entry.slug || entry.label || entry.name || "") : entry);
      if (tag) slugs.add(tag);
    }
  }
  return slugs;
}

async function main() {
  console.log(`Paper portfolio standstill diagnosis at ${new Date().toISOString()}`);
  console.log(`Read-only: nothing is written, no credentials are used.\n`);

  const scraped = await fetchJson(`${HOST}/api.php?action=state&target=paper&summary=execution&t=${Date.now()}`);
  const rows = Array.isArray(scraped?.marketObservations) ? scraped.marketObservations : [];
  console.log(`catalogue rows served: ${rows.length}\n`);

  console.log(`== 1. what the catalogue is actually tagged with`);
  const histogram = new Map();
  let untagged = 0;
  for (const row of rows) {
    const slugs = rowTagSlugs(row);
    if (!slugs.size) untagged += 1;
    for (const slug of slugs) histogram.set(slug, (histogram.get(slug) || 0) + 1);
  }
  console.log(`   rows with no tag at all: ${untagged}`);
  console.log(`   distinct tags: ${histogram.size}`);
  const ranked = [...histogram.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`   most common: ${ranked.slice(0, 14).map(([tag, count]) => `${tag} (${count})`).join(", ")}`);

  console.log(`\n== 2. each paper portfolio's tag filter against that catalogue`);
  const config = await fetchJson(`${HOST}/api.php?action=portfolio-config&t=${Date.now()}`).catch(() => null);
  // api.php keeps paper settings under config.paper -- execution_scope_strategy_config()
  // reads $config['paper'][$strategyId]. The first version of this tool looked in
  // paperPortfolios, found nothing, and reported "no tag filter" for every portfolio
  // including the one whose log says otherwise: a wrong answer, not a null result.
  const paper = config?.config?.paper || {};
  const ids = Object.keys(paper);
  if (!ids.length) console.log(`   no paper portfolios were returned under config.paper.`);
  for (const id of ids) {
    const settings = paper[id] || {};
    const required = tagListOf(settings);
    if (!required.length) {
      console.log(`   ${id.padEnd(22)} no tag filter -- every market is allowed through on tags`);
      continue;
    }
    const matching = rows.filter((row) => {
      const slugs = rowTagSlugs(row);
      return required.some((tag) => slugs.has(tag));
    });
    const flag = matching.length ? " " : "!";
    console.log(`  ${flag}${id.padEnd(22)} requires ${required.join(", ")}`
      + `   -> ${matching.length} of ${rows.length} catalogue rows carry one`);
    if (!matching.length) {
      console.log(`   ${" ".repeat(23)} NOTHING can pass this filter, so the portfolio cannot trade at all.`);
      // What the markets it is clearly meant to trade are actually tagged with. Matching on
      // the words in the question rather than on tags, precisely because the tags are the
      // thing under suspicion.
      const words = required.flatMap((tag) => tag.split("-")).filter((word) => word.length > 3);
      const looksRelevant = rows.filter((row) => {
        const haystack = `${text(row.question)} ${text(row.slug)} ${text(row.eventSlug)}`.toLowerCase();
        return words.some((word) => haystack.includes(word));
      });
      console.log(`   ${" ".repeat(23)} rows whose question or slug mentions it: ${looksRelevant.length}`);
      for (const row of looksRelevant.slice(0, 5)) {
        console.log(`   ${" ".repeat(23)}   "${text(row.question).slice(0, 44)}"`
          + `  slug ${text(row.slug).slice(0, 26)}`);
        console.log(`   ${" ".repeat(23)}     tagged: ${[...rowTagSlugs(row)].join(", ") || "(nothing)"}`);
      }
    }
  }

  console.log(`\n== 3. the catalogue each portfolio actually receives`);
  console.log(`   api.php filters the served rows by the portfolio's own tag list before the`);
  console.log(`   bot ever sees them, so an empty scoped page means nothing to trade.`);
  for (const id of ids) {
    const scoped = await fetchJson(
      `${HOST}/api.php?action=state&target=paper&summary=execution&strategy_id=${encodeURIComponent(id)}&t=${Date.now()}`,
    ).catch(() => null);
    const served = Array.isArray(scoped?.marketObservations) ? scoped.marketObservations : null;
    const required = tagListOf(paper[id] || {});
    if (served == null) {
      console.log(`   ${id.padEnd(22)} scoped page unavailable`);
      continue;
    }
    // The disagreement that matters: a row the server let through on its own tag reading,
    // which the bot's reading then rejects. Every one of those is a candidate the portfolio
    // is offered and cannot use.
    const rejectedByBot = required.length
      ? served.filter((row) => !required.some((tag) => rowTagSlugs(row).has(tag)))
      : [];
    const flag = served.length ? (rejectedByBot.length ? "?" : " ") : "!";
    console.log(`  ${flag}${id.padEnd(22)} ${String(served.length).padStart(4)} row(s) served`
      + `${required.length ? `   of which the bot's own tag reading rejects ${rejectedByBot.length}` : ""}`);
    for (const row of rejectedByBot.slice(0, 3)) {
      console.log(`   ${" ".repeat(23)} "${text(row.question).slice(0, 42)}"`);
      console.log(`   ${" ".repeat(23)}   server sees: ${[...serverTagSlugs(row)].join(", ") || "(nothing)"}`);
      console.log(`   ${" ".repeat(23)}   bot sees:    ${[...rowTagSlugs(row)].join(", ") || "(nothing)"}`);
    }
  }

  console.log(`\n== 4. what the stored reject reasons say across the catalogue`);
  const reasons = new Map();
  let withReasons = 0;
  for (const row of rows) {
    const list = Array.isArray(row?.rejectReasons) ? row.rejectReasons : [];
    if (list.length) withReasons += 1;
    for (const reason of list) {
      // Collapse the numbers so the shapes group: "probability 12.3% below" and
      // "probability 45.6% below" are one finding, not two hundred.
      const shape = text(reason).replace(/-?\d[\d.,]*/g, "N");
      reasons.set(shape, (reasons.get(shape) || 0) + 1);
    }
  }
  console.log(`   rows carrying a stored reject reason: ${withReasons} of ${rows.length}`);
  for (const [shape, count] of [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`   ${String(count).padStart(5)}  ${shape.slice(0, 96)}`);
  }

  console.log(`\n== 5. the NaN probability`);
  const nan = rows.filter((row) => (Array.isArray(row?.rejectReasons) ? row.rejectReasons : [])
    .some((reason) => /NaN/.test(text(reason))));
  console.log(`   rows whose stored reasons contain NaN: ${nan.length}`);
  for (const row of nan.slice(0, 5)) {
    console.log(`\n   "${text(row.question).slice(0, 58)}"  [${text(row.outcome)}]`);
    console.log(`      status ${text(row.status)}   evaluatedAt ${text(row.evaluatedAt)}`);
    console.log(`      marketPrice ${row.marketPrice ?? "null"}   marketProbability ${row.marketProbability ?? "null"}`
      + `   aiProbability ${row.aiProbability ?? "null"}   bestAsk ${row.bestAsk ?? "null"}   bestBid ${row.bestBid ?? "null"}`);
    console.log(`      annualizedReturn ${row.annualizedReturn ?? "null"}   expectedValueUsdc ${row.expectedValueUsdc ?? "null"}`);
    console.log(`      reasons: ${(row.rejectReasons || []).join("; ").slice(0, 150)}`);
  }
  if (nan.length) {
    console.log(`\n   A NaN here is a MISSING probability, not a low one. The row is stored with a`);
    console.log(`   verdict computed from a number that was never there, and every portfolio then`);
    console.log(`   reads that verdict.`);
  }
}

main().catch((error) => {
  console.log(`\n!! diagnosis stopped early: ${error?.message || error}`);
  process.exitCode = 1;
});
