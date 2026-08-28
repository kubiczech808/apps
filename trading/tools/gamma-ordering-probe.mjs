// Read-only diagnostic. Writes nothing, places nothing.
//
// Asked: does the Gamma API have a parameter that makes a scrape pull the events closest
// to resolution first, or the highest-volume ones -- and if so, use it.
//
// The scan already sends `order=endDate&ascending=true`. That is not the same as the
// server honouring it: this codebase has already found one parameter Gamma accepts and
// silently ignores (`start_date_max`), and a silently ignored ordering is worse than none,
// because the code then believes it is scanning the near-resolution frontier while Gamma
// returns whatever it likes.
//
// So this checks the ordering by its effect, not by whether the request 200s:
//   1. Is the returned page actually sorted by the field asked for?
//   2. Does reversing `ascending` reverse the page? A parameter that is ignored gives the
//      same page both ways.
//   3. Which order fields exist at all -- endDate, volume, volume24hr, liquidity.
//   4. Does the keyset endpoint the catalogue scan actually uses honour it too? That is
//      the one that matters; /events and /markets are used elsewhere.
const GAMMA = process.env.GAMMA_HOST || "https://gamma-api.polymarket.com";
const LIMIT = Number(process.env.PROBE_LIMIT || 50);

async function fetchJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  try {
    return { ok: response.ok, status: response.status, body: JSON.parse(text) };
  } catch {
    return { ok: false, status: response.status, error: text.slice(0, 200) };
  }
}

const num = (value) => (value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value));
const time = (value) => (Number.isFinite(Date.parse(value || "")) ? Date.parse(value) : null);

// A page is "sorted" if the field never moves the wrong way. Ties are allowed: many
// events share an end date, and a stable sort on equal keys is still sorted.
function sortedness(values, ascending) {
  const clean = values.filter((value) => value != null);
  if (clean.length < 2) return { pairs: 0, correct: 0, ratio: null };
  let correct = 0;
  for (let index = 1; index < clean.length; index += 1) {
    const delta = clean[index] - clean[index - 1];
    if (ascending ? delta >= 0 : delta <= 0) correct += 1;
  }
  return { pairs: clean.length - 1, correct, ratio: correct / (clean.length - 1) };
}

function describe(label, values, ascending) {
  const { pairs, correct, ratio } = sortedness(values, ascending);
  const verdict = ratio == null ? "too few rows"
    : ratio >= 0.99 ? "HONOURED"
      : ratio <= 0.6 ? "IGNORED"
        : "partial";
  console.log(`   ${label.padEnd(46)} ${String(correct).padStart(3)}/${String(pairs).padEnd(3)} in order  -> ${verdict}`);
  return ratio;
}

async function probeResource(resource, extra = "") {
  console.log(`\n=== ${resource} ${extra ? `(${extra})` : ""} ===`);
  const base = `${GAMMA}/${resource}?limit=${LIMIT}&active=true&closed=false${extra ? `&${extra}` : ""}`;
  const rows = (payload) => (Array.isArray(payload) ? payload : (payload?.events || payload?.data || []));

  for (const [field, reader] of [
    ["endDate", (row) => time(row.endDate)],
    ["startDate", (row) => time(row.startDate)],
    ["volume", (row) => num(row.volume ?? row.volumeNum)],
    ["volume24hr", (row) => num(row.volume24hr)],
    ["liquidity", (row) => num(row.liquidity ?? row.liquidityNum)],
  ]) {
    const asc = await fetchJson(`${base}&order=${field}&ascending=true`);
    const desc = await fetchJson(`${base}&order=${field}&ascending=false`);
    if (!asc.ok || !desc.ok) {
      console.log(`   ${field.padEnd(46)} request failed: HTTP ${asc.status}/${desc.status}`);
      continue;
    }
    const ascRows = rows(asc.body);
    const descRows = rows(desc.body);
    if (!ascRows.length) {
      console.log(`   ${field.padEnd(46)} empty page`);
      continue;
    }
    describe(`order=${field}&ascending=true`, ascRows.map(reader), true);
    describe(`order=${field}&ascending=false`, descRows.map(reader), false);
    // The decisive check: an ignored parameter returns the same page whichever way it is
    // asked, so identical first ids in both directions means the ordering did nothing.
    const firstAsc = String(ascRows[0]?.id ?? "");
    const firstDesc = String(descRows[0]?.id ?? "");
    console.log(`   ${" ".repeat(46)} reversing changes the page: ${firstAsc !== firstDesc ? "yes" : "NO -- parameter ignored"}`);
  }
}

async function main() {
  console.log(`Gamma ordering probe at ${new Date().toISOString()}`);
  console.log(`Asking: can a scrape be told to fetch nearest-resolution first, or highest volume?\n`);

  await probeResource("events");
  await probeResource("markets");

  // The one the catalogue scan actually pages through. If ordering is ignored here, the
  // "preferred near-resolution" scope is a label rather than a behaviour.
  //
  // The scan's real query is not a bare one: scanEventRequestParams always adds
  // `end_date_min` and `end_date_max`, and the rotating scopes add `tag_id`. Ordering
  // that works bare and breaks under a filter would still leave the scan unordered, so
  // this asks the question with the parameters the scan actually sends.
  const scanBounds = `&end_date_min=${encodeURIComponent(new Date(Date.now() - 6 * 3600000).toISOString())}`
    + `&end_date_max=${encodeURIComponent(new Date(Date.now() + 7 * 86400000).toISOString())}`;
  console.log(`\n=== events/keyset (the endpoint the catalogue scan pages) ===`);
  for (const [label, field, ascending, reader, extra] of [
    ["bare", "endDate", "true", (row) => time(row.endDate), ""],
    ["with the scan's date bounds", "endDate", "true", (row) => time(row.endDate), scanBounds],
    ["bare", "volume24hr", "false", (row) => num(row.volume24hr), ""],
    ["bare", "volume", "false", (row) => num(row.volume ?? row.volumeNum), ""],
    ["with the scan's date bounds", "volume24hr", "false", (row) => num(row.volume24hr), scanBounds],
  ]) {
    const url = `${GAMMA}/events/keyset?limit=${LIMIT}&active=true&closed=false`
      + `&order=${field}&ascending=${ascending}${extra}`;
    const result = await fetchJson(url);
    if (!result.ok) {
      console.log(`   order=${field} (${label}): HTTP ${result.status} ${result.error || ""}`);
      continue;
    }
    const events = Array.isArray(result.body?.events) ? result.body.events : [];
    // loadEventMarketScanBatch reads `next_cursor`, so that is the field that decides
    // whether the scan can page at all -- not a camelCase guess.
    const cursor = typeof result.body?.next_cursor === "string" ? result.body.next_cursor.trim() : "";
    console.log(`   order=${field}&ascending=${ascending} (${label}): ${events.length} events`
      + `, next_cursor=${cursor ? "yes" : "NO"}`);
    describe(`   page 1 sorted by ${field}`, events.map(reader), ascending === "true");
    for (const event of events.slice(0, 3)) {
      console.log(`      ${String(event.endDate || "-").slice(0, 16)}  vol24h=${event.volume24hr}`
        + `  vol=${event.volume}  ${String(event.title || event.slug || "").slice(0, 40)}`);
    }

    // The decisive one for this codebase. The scan persists a cursor and continues from
    // it on the next run, so ordering only means anything if the continuation keeps it:
    // page 2 must be sorted too, and must start after page 1 rather than back at the top.
    if (!cursor) continue;
    const next = await fetchJson(`${url}&after_cursor=${encodeURIComponent(cursor)}`);
    if (!next.ok) {
      console.log(`      page 2: HTTP ${next.status}`);
      continue;
    }
    const nextEvents = Array.isArray(next.body?.events) ? next.body.events : [];
    describe(`   page 2 sorted by ${field}`, nextEvents.map(reader), ascending === "true");
    const lastOfFirst = reader(events[events.length - 1] ?? {});
    const firstOfNext = reader(nextEvents[0] ?? {});
    const continues = lastOfFirst == null || firstOfNext == null
      ? "cannot tell"
      : (ascending === "true" ? firstOfNext >= lastOfFirst : firstOfNext <= lastOfFirst)
        ? "yes"
        : "NO -- page 2 restarts, the cursor drops the ordering";
    console.log(`      page 2 continues page 1: ${continues}`);
  }

  // Whether a volume or liquidity floor can be pushed to the server instead of filtered
  // locally. Each parameter is checked against the field it names -- a volume floor read
  // off the liquidity column, or the reverse, measures nothing.
  console.log(`\n=== server-side volume/liquidity floors ===`);
  const FLOOR = 50000;
  for (const [param, reader] of [
    ["volume_min", (row) => num(row.volume ?? row.volumeNum)],
    ["volume_num_min", (row) => num(row.volumeNum ?? row.volume)],
    ["volume24hr_min", (row) => num(row.volume24hr)],
    ["liquidity_min", (row) => num(row.liquidity ?? row.liquidityNum)],
    ["liquidity_num_min", (row) => num(row.liquidityNum ?? row.liquidity)],
  ]) {
    const result = await fetchJson(`${GAMMA}/events?limit=${LIMIT}&active=true&closed=false&${param}=${FLOOR}`);
    if (!result.ok) {
      console.log(`   ${param.padEnd(20)} HTTP ${result.status}`);
      continue;
    }
    const events = Array.isArray(result.body) ? result.body : [];
    const values = events.map(reader);
    const missing = values.filter((value) => value == null).length;
    const below = values.filter((value) => value != null && value < FLOOR).length;
    const verdict = !events.length ? "no rows"
      : below ? "IGNORED"
        : missing === values.length ? "field not returned -- cannot tell"
          : "HONOURED";
    console.log(`   ${param.padEnd(20)} ${events.length} events, ${below} below the floor`
      + `${missing ? `, ${missing} without the field` : ""} -> ${verdict}`);
  }
}

main().catch((error) => {
  console.log(`\n!! probe stopped early: ${error?.message || error}`);
  process.exitCode = 1;
});
