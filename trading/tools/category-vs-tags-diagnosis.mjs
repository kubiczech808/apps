// Read-only diagnostic. Writes nothing, places nothing.
//
// The question: does Polymarket's Gamma API expose a genuine "category"/"categories" field
// on a market or event, distinct from "tags"? Answered by fetching real live responses and
// printing every top-level key each object actually has -- not by trusting a scraper's
// assumption or a third-party client's struct definition, which is what secondary research
// on this question turns up (conflicting claims, none first-party).
const GAMMA = process.env.GAMMA_HOST || "https://gamma-api.polymarket.com";

async function fetchJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  try {
    return { ok: response.ok, status: response.status, body: JSON.parse(text) };
  } catch {
    return { ok: false, status: response.status, error: text.slice(0, 300) };
  }
}

function fieldReport(objects, label) {
  console.log(`\n-- ${label}: ${objects.length} sampled --`);
  if (!objects.length) {
    console.log("   (no rows returned)");
    return;
  }
  const allKeys = new Set();
  for (const object of objects) for (const key of Object.keys(object || {})) allKeys.add(key);
  const sorted = [...allKeys].sort();
  console.log(`   all top-level keys seen (${sorted.length}): ${sorted.join(", ")}`);
  for (const needle of ["category", "categories", "tags", "subcategory", "tag"]) {
    const present = objects.filter((object) => Object.prototype.hasOwnProperty.call(object || {}, needle));
    if (!present.length) {
      console.log(`   "${needle}": absent from every sampled row`);
      continue;
    }
    const sample = present[0][needle];
    console.log(`   "${needle}": present on ${present.length}/${objects.length} rows`
      + ` -- example value: ${JSON.stringify(sample)?.slice(0, 200)}`);
  }
}

async function main() {
  console.log(`Category vs tags diagnosis at ${new Date().toISOString()}`);

  const markets = await fetchJson(`${GAMMA}/markets?limit=15&closed=false`);
  if (!markets.ok) {
    console.log(`!! markets fetch failed: HTTP ${markets.status} ${markets.error || ""}`);
  } else {
    fieldReport(Array.isArray(markets.body) ? markets.body : [], "GET /markets (open)");
  }

  const closedMarkets = await fetchJson(`${GAMMA}/markets?limit=15&closed=true`);
  if (closedMarkets.ok) {
    fieldReport(Array.isArray(closedMarkets.body) ? closedMarkets.body : [], "GET /markets (closed)");
  }

  const events = await fetchJson(`${GAMMA}/events?limit=15`);
  if (!events.ok) {
    console.log(`!! events fetch failed: HTTP ${events.status} ${events.error || ""}`);
  } else {
    fieldReport(Array.isArray(events.body) ? events.body : [], "GET /events");
  }

  // If a real "category"/"categories" endpoint exists at all, its own listing endpoint
  // would say so -- worth checking directly rather than only inferring from absence on
  // markets/events.
  for (const path of ["/categories", "/category"]) {
    const result = await fetchJson(`${GAMMA}${path}?limit=5`);
    console.log(`\n-- GET ${path} --`);
    console.log(`   HTTP ${result.status}${result.ok ? "" : ` (${result.error || "no body"})`}`);
    if (result.ok) console.log(`   body: ${JSON.stringify(result.body).slice(0, 300)}`);
  }

  const tags = await fetchJson(`${GAMMA}/tags?limit=10`);
  console.log(`\n-- GET /tags --`);
  if (!tags.ok) {
    console.log(`   HTTP ${tags.status} ${tags.error || ""}`);
  } else {
    const rows = Array.isArray(tags.body) ? tags.body : [];
    console.log(`   ${rows.length} sampled`);
    for (const row of rows.slice(0, 10)) console.log(`   ${JSON.stringify(row)}`);
  }
}

main().catch((error) => {
  console.log(`\n!! diagnosis stopped early: ${error?.message || error}`);
  process.exitCode = 1;
});
