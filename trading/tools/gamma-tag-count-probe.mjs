// Read-only measurement. Answers one question before any UI is built on it: can Polymarket
// tell us, per category and fast enough for a select box, how many events it currently has
// that we have not stored?
//
// "Fast enough" was given as two seconds for the whole picker. That is the whole test --
// if the answer costs more than that, the label stays a plain category name, because a
// number that arrives late is worse than no number.
//
// Nothing is written and no credentials are used.
import { pathToFileURL } from "node:url";

const GAMMA = "https://gamma-api.polymarket.com";

// The picker's categories, with the tag ids the scanner already knows.
const CATEGORIES = [
  { slug: "politics", id: "2" },
  { slug: "geopolitics", id: "100265" },
  { slug: "sports", id: "1" },
  { slug: "esports", id: "64" },
  { slug: "crypto", id: "21" },
  { slug: "finance", id: "120" },
  { slug: "business", id: "107" },
  { slug: "technology", id: "22" },
  { slug: "science", id: "74" },
  { slug: "news", id: "38" },
  { slug: "weather", id: "84" },
  { slug: "video-games", id: "3" },
  { slug: "music", id: "100" },
  { slug: "movies", id: "53" },
];

async function timed(label, url) {
  const started = Date.now();
  try {
    const response = await fetch(url, { headers: { "User-Agent": "GammaTagCountProbe/1.0" } });
    const text = await response.text();
    const elapsed = Date.now() - started;
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Left null: a non-JSON answer is a result too.
    }
    return { label, url, ok: response.ok, status: response.status, elapsed, parsed, raw: text.slice(0, 200) };
  } catch (error) {
    return { label, url, ok: false, status: "network", elapsed: Date.now() - started, error: String(error?.message || error) };
  }
}

function shapeOf(parsed) {
  if (Array.isArray(parsed)) return `array(${parsed.length})`;
  if (parsed && typeof parsed === "object") return `object{${Object.keys(parsed).slice(0, 8).join(",")}}`;
  return typeof parsed;
}

async function main() {
  console.log(`Gamma tag-count probe at ${new Date().toISOString()}`);
  console.log("Read-only: nothing is written, no credentials are used.\n");

  // Does any endpoint report a total without returning every row? That is the only way a
  // per-category count can be cheap; paging to count would cost one request per page.
  console.log("== Does Gamma report a total anywhere");
  const single = CATEGORIES[0];
  for (const [label, url] of Object.entries({
    "events?limit=1": `${GAMMA}/events?tag_id=${single.id}&closed=false&limit=1`,
    "events/pagination": `${GAMMA}/events/pagination?tag_id=${single.id}&closed=false&limit=1`,
    "markets?limit=1": `${GAMMA}/markets?tag_id=${single.id}&closed=false&limit=1`,
    "events/keyset": `${GAMMA}/events/keyset?tag_id=${single.id}&closed=false&limit=1`,
  })) {
    const result = await timed(label, url);
    console.log(`   ${label}: HTTP ${result.status} in ${result.elapsed}ms -> ${shapeOf(result.parsed)}`);
    if (result.parsed && !Array.isArray(result.parsed)) {
      console.log(`     keys: ${JSON.stringify(result.parsed).slice(0, 300)}`);
    }
    if (!result.ok && result.raw) console.log(`     ${result.raw.slice(0, 120)}`);
  }

  // And what one round of the real thing costs: every category at once, as a picker would.
  console.log(`\n== All ${CATEGORIES.length} categories in parallel, as the picker would`);
  const started = Date.now();
  const results = await Promise.all(CATEGORIES.map((category) =>
    timed(category.slug, `${GAMMA}/events/pagination?tag_id=${category.id}&closed=false&limit=1`)));
  const wall = Date.now() - started;
  for (const result of results) {
    const total = result.parsed?.pagination?.totalResults ?? result.parsed?.pagination?.total ?? null;
    console.log(`   ${result.label}: HTTP ${result.status} in ${result.elapsed}ms`
      + (total == null ? ` (no total in ${shapeOf(result.parsed)})` : ` total=${total}`));
  }
  console.log(`   wall clock for the whole picker: ${wall}ms -- the budget is 2000ms`);

  // The raw total counts every open event in the category, and the scheduled scan only
  // takes those above its liquidity floor and inside its window. A picker that showed the
  // raw number would report thousands of "missing" sports events the scan will never
  // fetch by design. So measure the total the scan's own filters would see -- that is the
  // only number a "not scraped yet" label can honestly be built from.
  const liquidityMin = 40000;
  const endDateMin = new Date(Date.now() - 6 * 3600000).toISOString();
  const endDateMax = new Date(Date.now() + 2 * 86400000).toISOString();
  const filter = `&liquidity_min=${liquidityMin}&end_date_min=${encodeURIComponent(endDateMin)}&end_date_max=${encodeURIComponent(endDateMax)}`;
  console.log(`\n== Same categories under the scheduled scan's own filters`);
  console.log(`   liquidity_min=${liquidityMin}, end_date within -6h..+2d`);
  const filteredStarted = Date.now();
  const filtered = await Promise.all(CATEGORIES.map((category) =>
    timed(category.slug, `${GAMMA}/events/pagination?tag_id=${category.id}&closed=false&limit=1${filter}`)));
  const filteredWall = Date.now() - filteredStarted;
  for (const result of filtered) {
    const total = result.parsed?.pagination?.totalResults ?? null;
    console.log(`   ${result.label}: ${total == null ? `no total (${shapeOf(result.parsed)})` : total} in ${result.elapsed}ms`);
  }
  console.log(`   wall clock: ${filteredWall}ms`);
}

const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (invokedDirectly) {
  await main();
}

export { CATEGORIES };
