// Read-only diagnostic. Answers one question: how does Polymarket's Gamma API
// describe the events shown on polymarket.com/sports/live and /esports/live?
//
// It writes nothing, publishes nothing, touches no state file and needs no secrets.
// It exists because the scan pipeline must not be changed on a guess: the egress
// policy in the authoring environment blocks gamma-api.polymarket.com, so the only
// way to learn the real response shape is to ask from a runner that can reach it.
//
// Everything it prints is public market metadata (slugs, titles, timestamps, field
// names) plus counts. No credentials, addresses or order ids are involved anywhere.
import { pathToFileURL } from "node:url";

const GAMMA = "https://gamma-api.polymarket.com";
// Tag ids as already used by the scanner's category scopes.
const SPORTS_TAG_ID = "1";
const ESPORTS_TAG_ID = "64";
const SAMPLE_ROWS = 3;

function isoIn(hours) {
  return new Date(Date.now() + hours * 3600000).toISOString();
}

// Mirrors gammaResourceUrl() in the bot so the probe measures the same base query
// the scanner would send, not a different one.
function gammaUrl(resource, params = {}) {
  const url = new URL(`${GAMMA}/${resource}`);
  url.searchParams.set("active", "true");
  url.searchParams.set("closed", "false");
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return url;
}

async function fetchGamma(url) {
  const response = await fetch(url, { headers: { "User-Agent": "PolymarketLiveProbe/1.0" } });
  const text = await response.text();
  if (!response.ok) {
    return { ok: false, status: response.status, error: text.slice(0, 300) };
  }
  try {
    return { ok: true, status: response.status, body: JSON.parse(text) };
  } catch (error) {
    return { ok: false, status: response.status, error: `unparseable JSON: ${String(error).slice(0, 200)}` };
  }
}

function parseJsonField(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function eventsFrom(body) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.events)) return body.events;
  return [];
}

// The decisive question: does Gamma expose a native "this is happening now" flag, or
// does the scanner have to derive it from start/end timestamps?
function fieldReport(rows, label) {
  const counts = new Map();
  const truthy = new Map();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    for (const [key, value] of Object.entries(row)) {
      counts.set(key, (counts.get(key) || 0) + 1);
      if (value === true || (typeof value === "string" && value && value !== "false")) {
        truthy.set(key, (truthy.get(key) || 0) + 1);
      }
    }
  }
  const interesting = [...counts.keys()]
    .filter((key) => /live|start|end|status|active|closed|accept|game|period|clock|score|elapsed/i.test(key))
    .sort();
  console.log(`  ${label}: ${rows.length} rows, ${counts.size} distinct fields`);
  console.log(`    time/live-related fields: ${interesting.join(", ") || "(none)"}`);
  const flags = interesting.filter((key) => /^(live|isLive|inPlay|started)$/i.test(key));
  if (flags.length) {
    for (const key of flags) {
      console.log(`    NATIVE FLAG ${key}: present on ${counts.get(key)} rows, truthy on ${truthy.get(key) || 0}`);
    }
  } else {
    console.log("    no native live/isLive/inPlay flag on these rows");
  }
  return { fields: counts, interesting };
}

function startedCount(events) {
  const now = Date.now();
  let started = 0;
  let withStart = 0;
  for (const event of events) {
    const raw = event?.gameStartTime || event?.eventStartTime || event?.startDate || event?.startDateIso;
    const time = Date.parse(String(raw || ""));
    if (!Number.isFinite(time)) continue;
    withStart += 1;
    if (time <= now) started += 1;
  }
  return { started, withStart };
}

function sampleLines(events, limit = SAMPLE_ROWS) {
  return events.slice(0, limit).map((event) => {
    const markets = parseJsonField(event?.markets);
    const prices = markets.length ? parseJsonField(markets[0]?.outcomePrices).join("/") : "";
    return [
      `slug=${String(event?.slug || "").slice(0, 60)}`,
      `start=${event?.gameStartTime || event?.startDate || "-"}`,
      `end=${event?.endDate || "-"}`,
      `markets=${markets.length}`,
      prices ? `firstPrices=${prices}` : "",
      markets[0]?.closed != null ? `closed=${markets[0].closed}` : "",
      markets[0]?.acceptingOrders != null ? `accepting=${markets[0].acceptingOrders}` : "",
    ].filter(Boolean).join(" ");
  });
}

// Each probe is one query the scanner could plausibly send. Only parameters already
// used by the existing scan are marked "proven"; the rest are being tested here
// precisely so they do not have to be guessed in the scan pipeline.
function probes() {
  return [
    {
      name: "sports, ending within 12h, ordered by endDate (proven params only)",
      resource: "events/keyset",
      params: { limit: 100, tag_id: SPORTS_TAG_ID, order: "endDate", ascending: "true", end_date_max: isoIn(12) },
    },
    {
      name: "esports, ending within 12h, ordered by endDate (proven params only)",
      resource: "events/keyset",
      params: { limit: 100, tag_id: ESPORTS_TAG_ID, order: "endDate", ascending: "true", end_date_max: isoIn(12) },
    },
    {
      name: "sports, no end-date bound (baseline for field discovery)",
      resource: "events/keyset",
      params: { limit: 100, tag_id: SPORTS_TAG_ID, order: "endDate", ascending: "true" },
    },
    {
      name: "sports with end_date_min=now (does Gamma honour a lower bound?)",
      resource: "events/keyset",
      params: {
        limit: 100, tag_id: SPORTS_TAG_ID, order: "endDate", ascending: "true",
        end_date_min: new Date().toISOString(), end_date_max: isoIn(12),
      },
    },
    {
      name: "sports with start_date_max=now (does Gamma expose a start-date filter?)",
      resource: "events/keyset",
      params: {
        limit: 100, tag_id: SPORTS_TAG_ID, order: "endDate", ascending: "true",
        start_date_max: new Date().toISOString(), end_date_max: isoIn(24),
      },
    },
  ];
}

async function main() {
  console.log(`Gamma live-event probe at ${new Date().toISOString()}`);
  console.log("Read-only: no state is written and no credentials are used.\n");

  let failures = 0;
  for (const probe of probes()) {
    const url = gammaUrl(probe.resource, probe.params);
    console.log(`== ${probe.name}`);
    console.log(`   ${url.toString()}`);
    const result = await fetchGamma(url);
    if (!result.ok) {
      failures += 1;
      console.log(`   HTTP ${result.status} -> ${result.error}\n`);
      continue;
    }
    const events = eventsFrom(result.body);
    const { started, withStart } = startedCount(events);
    console.log(`   HTTP ${result.status}: ${events.length} events`);
    console.log(`   with a parsable start time: ${withStart}; already started (live): ${started}`);
    fieldReport(events, "event");
    fieldReport(events.flatMap((event) => parseJsonField(event?.markets)).slice(0, 200), "market");
    for (const line of sampleLines(events)) console.log(`   sample: ${line}`);
    console.log("");
  }

  console.log(`Probes run: ${probes().length}; failed: ${failures}`);
  // A failed probe is information, not a broken job: the point is to learn which
  // queries work before the scan pipeline depends on any of them.
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(`probe failed: ${error?.message || error}`);
    process.exit(1);
  });
}

export { gammaUrl, probes, startedCount, eventsFrom, parseJsonField };
