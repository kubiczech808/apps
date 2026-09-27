// Read-only. Shows what actually links two markets in the diversification rule, for rows
// matching a question filter.
//
// Reported with two screenshots: "Will Israel win on 2026-09-27?" and "Will Republic of
// Ireland win on 2026-09-27?" both sat in the candidates list, both on the No side, both
// ending 20:45. They are the two sides of one match -- Israel v Republic of Ireland in the
// UEFA Nations League -- and a portfolio that takes both has one bet, not two.
//
// riskProfile() builds the keys that diversification groups on. For a question naming ONE
// team it produces `team:<that team>` and whatever `event:` key the row's slug and eventSlug
// yield, and never the `match:` key, because that needs two teams in one question. So
// whether the two rows are linked at all comes down to their eventSlug -- which is a stored
// value, not something to reason about. This prints it.
//
// Reads one page of the ACTIVE catalogue, the same request the dashboard makes. Never the
// resolved scope: that read exhausted the host's memory limit once.

const HOST = process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading";
const FILTERS = String(process.env.QUESTION_FILTERS || "israel,republic of ireland")
  .split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
// A team plays many times. Narrowing by the instant the market ends is what isolates ONE
// fixture out of a season, and it is the only thing the screenshots gave to go on: both
// rows ended 2026-09-27 20:45.
const END_FILTERS = String(process.env.END_FILTERS || "")
  .split(",").map((entry) => entry.trim()).filter(Boolean);
const SHOW = Math.max(1, Math.min(200, Number(process.env.SHOW_ROWS || 20)));
const SHOW_PAIRS = Math.max(1, Math.min(200, Number(process.env.SHOW_PAIRS || 40)));

// Keys that can only group markets that genuinely share an event, as opposed to a topic.
// `topic:iran-war` matches on the word "israel" alone, so it links an Israeli football match
// to an oil market -- useful as a topic cluster, useless as proof two rows are one bet.
export const EVENT_SCOPED_PREFIXES = ["event:", "match:", "market:"];

export function eventScopedKeys(row) {
  const keys = Array.isArray(row?.riskGroupKeys) ? row.riskGroupKeys : [];
  return keys.filter((key) => EVENT_SCOPED_PREFIXES.some((prefix) => String(key).startsWith(prefix)));
}

// What two rows actually share, split by whether the shared key ties them to one event or
// merely to one subject. A portfolio diversifies on the first kind; the second kind is where
// "linked" and "about the same thing" get confused.
export function sharedKeys(left, right) {
  const leftKeys = new Set(Array.isArray(left?.riskGroupKeys) ? left.riskGroupKeys : []);
  const shared = (Array.isArray(right?.riskGroupKeys) ? right.riskGroupKeys : [])
    .filter((key) => leftKeys.has(key));
  return {
    all: shared,
    eventScoped: shared.filter((key) => EVENT_SCOPED_PREFIXES.some((prefix) => String(key).startsWith(prefix))),
  };
}

// Both filters, as the run applies them: the question has to name the subject AND, when an
// end filter is given, the row has to end at that instant. Exported so the pairing and the
// selection are tested on the same rule the run uses.
export function rowMatches(row, questionFilters = FILTERS, endFilters = END_FILTERS) {
  const question = String(row?.question || "").toLowerCase();
  if (questionFilters.length && !questionFilters.some((filter) => question.includes(filter))) return false;
  if (!endFilters.length) return true;
  const endDate = String(row?.endDate || "");
  return endFilters.some((filter) => endDate.includes(filter));
}

// The active catalogue is paged at SCRAPED_SCOPE_PAGE_LIMIT rows, and there are several
// thousand of them. One page found nothing and said "0 match" -- which reads like the rows
// are absent rather than on page four. So it walks, bounded, and stops at the first short
// page.
async function loadActiveRows(maxPages) {
  const rows = [];
  for (let page = 0; page < maxPages; page += 1) {
    const offset = rows.length;
    const url = `${HOST}/api.php?action=state&target=paper&summary=scraped&scope=active&offset=${offset}`;
    const response = await fetch(url);
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status} at offset ${offset}: ${text.slice(0, 200)}`);
    const payload = JSON.parse(text);
    const batch = Array.isArray(payload?.marketObservations) ? payload.marketObservations : [];
    rows.push(...batch);
    if (!batch.length) break;
    // A page shorter than the one before it is the last one.
    if (page > 0 && batch.length < 1200) break;
    if (batch.length < 1200) break;
  }
  return rows;
}

async function main() {
  console.log(`Risk group check at ${new Date().toISOString()}`);
  const rows = await loadActiveRows(Math.max(1, Math.min(40, Number(process.env.MAX_PAGES || 8))));
  // Whether the walk reached the end or ran out of pages. "0 match" after a walk that was
  // cut short says the rows are absent when they are merely further on, which is the mistake
  // the first run of this made twice.
  const full = rows.length % 1200 === 0 && rows.length > 0;
  console.log(`   ${rows.length} active row(s) read${full ? "  !! exactly a whole number of pages -- the walk may have been cut short, raise max_pages" : ""}`);

  const matched = rows.filter((row) => rowMatches(row));
  console.log(`   ${matched.length} match ${JSON.stringify(FILTERS)}${END_FILTERS.length ? ` ending ${JSON.stringify(END_FILTERS)}` : ""}\n`);

  for (const row of matched.slice(0, SHOW)) {
    console.log(`   ${row.question}`);
    console.log(`      slug        ${row.slug || "-"}`);
    console.log(`      eventSlug   ${row.eventSlug || "-"}`);
    console.log(`      endDate     ${row.endDate || "-"}   outcome ${row.outcome || "-"}`);
    console.log(`      keys        ${(row.riskGroupKeys || []).join(", ") || "(none)"}`);
    console.log("");
  }

  // Every pair that ends at the same instant, which for a fixture means the same match.
  // Printed because the question is not "does each row have keys" but "do these two share
  // one", and only a pair can answer that.
  console.log(`   pairs ending at the same instant:`);
  let pairs = 0;
  for (let i = 0; i < matched.length; i += 1) {
    for (let j = i + 1; j < matched.length; j += 1) {
      const left = matched[i];
      const right = matched[j];
      if (!left.endDate || left.endDate !== right.endDate) continue;
      pairs += 1;
      // A whole fixture's markets pair with each other, so an unfiltered run prints
      // hundreds of pairs and buries the one that matters. The count below still reports
      // them all.
      if (pairs > SHOW_PAIRS) continue;
      const shared = sharedKeys(left, right);
      console.log(`      ${String(left.question).slice(0, 44)}`);
      console.log(`      ${String(right.question).slice(0, 44)}`);
      console.log(`         shared keys        ${shared.all.join(", ") || "(none)"}`);
      console.log(`         event-scoped ones  ${shared.eventScoped.join(", ") || "(NONE -- these read as unrelated bets)"}`);
    }
  }
  if (!pairs) console.log("      (none found)");
  else if (pairs > SHOW_PAIRS) console.log(`      ... ${pairs - SHOW_PAIRS} further pair(s) not printed`);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`Check failed: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
