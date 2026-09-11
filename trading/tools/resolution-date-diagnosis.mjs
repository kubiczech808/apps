// Read-only diagnostic. Writes nothing, publishes nothing, needs no secrets.
//
// Reported: every open position in the active live portfolio shows the same resolution,
// "12. 09. 2026 01:59, 16.1 h left", for fixtures that are being played today and will be
// over within the hour.
//
// 01:59 local is 23:59:59Z the day before. That is not a time anything resolves at -- it is
// the marker this codebase uses for a WHOLE-DAY bucket: a date with no clock, stretched to
// the last second of its day so that "is it past" only turns true once the day is over.
// Three places can produce one:
//
//   1. isoTime() on a date-only endDate from the positions API
//   2. the fixture day recovered from the market SLUG, when nothing else carries a date
//   3. inferredEndDateFromQuestion() on a question naming a month and a day
//
// Each of the three is reached under different conditions, and the fix is different for
// each, so this prints which one produced the value on every open position -- alongside
// what Gamma actually holds for the same token. If Gamma has a precise endDate or kickoff
// that the stored row does not, the data is not missing: it is being discarded.
const HOST = process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading";
const GAMMA = process.env.GAMMA_HOST || "https://gamma-api.polymarket.com";

async function fetchJson(url, label) {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status}: ${text.slice(0, 160)}`);
  return JSON.parse(text);
}

const iso = (value) => (Number.isFinite(Date.parse(value || "")) ? new Date(value).toISOString() : null);

// The signature of a whole-day bucket, and the whole point of this report: 23:59:59 UTC.
const isWholeDayBucket = (value) => /T23:59:59(\.000)?Z$/.test(String(value || ""));

function hoursFromNow(value) {
  const ms = Date.parse(value || "");
  if (!Number.isFinite(ms)) return null;
  return (ms - Date.now()) / 3600000;
}

function cell(value, width) {
  return String(value ?? "-").slice(0, width).padEnd(width);
}

async function gammaMarket(tokenId) {
  try {
    const rows = await fetchJson(
      `${GAMMA}/markets?clob_token_ids=${encodeURIComponent(tokenId)}`,
      `gamma ${tokenId}`,
    );
    const market = Array.isArray(rows) ? rows[0] : rows;
    if (!market || typeof market !== "object") return null;
    const event = Array.isArray(market.events) ? market.events.find((item) => item?.slug) : null;
    return {
      endDate: market.endDate ?? market.endDateIso ?? event?.endDate ?? null,
      gameStartTime: market.gameStartTime ?? event?.gameStartTime ?? null,
      eventStartTime: market.eventStartTime ?? event?.eventStartTime ?? event?.startTime ?? null,
      startDate: market.startDate ?? event?.startDate ?? null,
      closed: market.closed ?? null,
      slug: market.slug ?? event?.slug ?? null,
    };
  } catch (error) {
    return { error: error?.message || String(error) };
  }
}

async function main() {
  const state = await fetchJson(`${HOST}/api.php?action=state&target=live`, "live state");
  const positions = (Array.isArray(state?.positions) ? state.positions : [])
    .filter((row) => Number(row?.shares ?? row?.size ?? 0) > 0);

  console.log(`live state generated ${state?.generatedAt || "(unknown)"}`);
  console.log(`open positions: ${positions.length}`);
  console.log(`now: ${new Date().toISOString()}\n`);

  // Grouped first, because the report is "they are ALL the same date". If one bucket holds
  // every row, the value is not being read from the market at all.
  const byEndDate = new Map();
  for (const row of positions) {
    const key = iso(row?.endDate) || "(none)";
    byEndDate.set(key, (byEndDate.get(key) || 0) + 1);
  }
  console.log("stored endDate, collapsed:");
  for (const [value, count] of [...byEndDate].sort((a, b) => b[1] - a[1])) {
    const hours = hoursFromNow(value);
    console.log(`   ${String(count).padStart(3)}x  ${cell(value, 26)}`
      + ` ${isWholeDayBucket(value) ? "WHOLE-DAY BUCKET" : "precise          "}`
      + ` ${hours == null ? "" : `${hours.toFixed(1)}h from now`}`);
  }

  const sources = new Map();
  for (const row of positions) sources.set(row?.endDateSource || "(unset)", (sources.get(row?.endDateSource || "(unset)") || 0) + 1);
  console.log("\nendDateSource, collapsed:");
  for (const [value, count] of [...sources].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(count).padStart(3)}x  ${value}`);
  }

  console.log("\nper position -- what is stored, and what Gamma holds for the same token:");
  for (const row of positions) {
    const tokenId = String(row?.tokenId || row?.assetId || "").trim();
    const gamma = tokenId ? await gammaMarket(tokenId) : null;
    console.log(`\n   ${String(row?.question || "").slice(0, 72)}  [${row?.outcome || "?"}]`);
    console.log(`      stored   endDate ${cell(iso(row?.endDate), 26)} ${isWholeDayBucket(row?.endDate) ? "WHOLE-DAY" : "precise"}`
      + `  source ${row?.endDateSource || "(unset)"}`);
    console.log(`               scheduledEventDate ${cell(iso(row?.scheduledEventDate), 26)}`
      + ` resolutionEndDate ${cell(iso(row?.resolutionEndDate), 26)}`);
    console.log(`               daysToResolution ${row?.daysToResolution ?? "-"}   slug ${String(row?.slug || row?.eventSlug || "-").slice(0, 50)}`);
    if (!gamma) {
      console.log("      gamma    (no token id on the stored row)");
      continue;
    }
    if (gamma.error) {
      console.log(`      gamma    lookup failed: ${gamma.error}`);
      continue;
    }
    console.log(`      gamma    endDate ${cell(iso(gamma.endDate), 26)} ${isWholeDayBucket(gamma.endDate) ? "WHOLE-DAY" : "precise"}`);
    console.log(`               gameStartTime ${cell(iso(gamma.gameStartTime), 26)} eventStartTime ${cell(iso(gamma.eventStartTime), 26)}`);
    // The verdict per row, which is the only line that has to be read: is there a precise
    // date on Gamma that the stored row replaced with a day bucket.
    const storedIsBucket = isWholeDayBucket(row?.endDate);
    const gammaPrecise = [gamma.endDate, gamma.gameStartTime, gamma.eventStartTime]
      .map(iso)
      .find((value) => value && !isWholeDayBucket(value));
    if (storedIsBucket && gammaPrecise) {
      console.log(`      -> DISCARDED: Gamma has ${gammaPrecise}, the row stored an end-of-day bucket instead.`);
    } else if (storedIsBucket) {
      console.log("      -> no precise date anywhere; the day bucket is the best that exists for this market.");
    } else {
      console.log("      -> stored date is precise.");
    }
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
