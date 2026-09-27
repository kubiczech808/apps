// Read-only. Answers one question: is volume actually stored on markets the scan is
// scraping now?
//
// It matters because the folded statistics have no volume dimension at all, so the only
// place a volume rule can ever come from is the catalogue rows themselves -- and a field
// that silently lands as 0 is worse than a missing one, because 0 reads as "no volume"
// rather than as "not captured".
//
// Two halves, because either alone can mislead:
//
//   * What Gamma hands the scan. The scan pages events/keyset and reads markets nested
//     inside the events, and a nested market does not necessarily carry the same field
//     names as one fetched from /markets. preferredMarketObservation reads market.liquidity
//     directly, while Gamma's nested markets have historically carried liquidityNum -- so
//     the question is which keys are actually present, not which ones exist somewhere.
//   * What the stored catalogue holds. A field can be read correctly and still be lost on
//     the way to disk, and only the stored rows can say.

const HOST = process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading";
const GAMMA = "https://gamma-api.polymarket.com";

const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
const positive = (value) => (num(value) ?? 0) > 0;

// The fields the bot reads, named exactly as it reads them, so a gap here is a gap there.
// marketVolumeSnapshotUsdc tries volumeNum, volume, volume24hr in that order; liquidity and
// volume24hr are read straight off the market object with `|| 0` behind them.
export const VOLUME_SOURCE_FIELDS = ["volumeNum", "volume", "volume24hr", "liquidity", "liquidityNum", "volumeClob", "liquidityClob"];

// Which of those a market object actually carries, and with what. Reported per field rather
// than as a verdict: "liquidity missing, liquidityNum present" is the finding, and a boolean
// would throw it away.
export function fieldPresence(markets = []) {
  const presence = {};
  for (const field of VOLUME_SOURCE_FIELDS) {
    presence[field] = { present: 0, positive: 0, sample: null };
  }
  for (const market of markets) {
    for (const field of VOLUME_SOURCE_FIELDS) {
      const value = market?.[field];
      if (value === undefined || value === null) continue;
      presence[field].present += 1;
      if (positive(value)) presence[field].positive += 1;
      if (presence[field].sample === null) presence[field].sample = value;
    }
  }
  return presence;
}

// Coverage over stored rows, split by how recently the row was first seen. A catalogue that
// captured volume correctly last month and stopped today reads as healthy in a single total,
// which is exactly the failure this is looking for.
export function storedCoverage(rows = [], now = Date.now()) {
  const buckets = [
    { label: "first seen <= 24 h ago", within: 24 },
    { label: "first seen <= 7 d ago", within: 24 * 7 },
    { label: "older, or undated", within: Infinity },
  ];
  const counts = buckets.map((bucket) => ({
    ...bucket, rows: 0, volumeUsdc: 0, volume24hr: 0, liquidity: 0, firstVolumeUsdc: 0, firstLiquidity: 0,
  }));
  for (const row of rows) {
    const seen = Date.parse(String(row?.firstObservedAt || row?.observedAt || ""));
    const ageHours = Number.isFinite(seen) ? (now - seen) / 3600000 : Infinity;
    const bucket = counts.find((entry) => ageHours <= entry.within) ?? counts[counts.length - 1];
    bucket.rows += 1;
    if (positive(row?.volumeUsdc)) bucket.volumeUsdc += 1;
    if (positive(row?.volume24hr)) bucket.volume24hr += 1;
    if (positive(row?.liquidity)) bucket.liquidity += 1;
    if (positive(row?.firstVolumeUsdc)) bucket.firstVolumeUsdc += 1;
    if (positive(row?.firstLiquidity)) bucket.firstLiquidity += 1;
  }
  return counts;
}

async function getJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

async function fromGamma() {
  // Sports, open, ordered by volume, exactly the shape the scan's rotation asks for. The
  // point is the nested markets, so the events are only a wrapper here.
  const url = `${GAMMA}/events?closed=false&limit=8&tag_id=1&order=volume&ascending=false`;
  const events = await getJson(url);
  const markets = [];
  for (const event of Array.isArray(events) ? events : []) {
    for (const market of Array.isArray(event?.markets) ? event.markets : []) markets.push(market);
  }
  console.log(`   ${markets.length} nested market(s) from ${Array.isArray(events) ? events.length : 0} event(s)`);
  if (!markets.length) {
    console.log("   !! no nested markets came back; the check cannot say anything about the fields");
    return;
  }
  console.log(`   field            present  >0   sample`);
  for (const [field, stat] of Object.entries(fieldPresence(markets))) {
    console.log(`   ${field.padEnd(16)} ${String(stat.present).padStart(7)} ${String(stat.positive).padStart(3)}`
      + `   ${stat.sample === null ? "-" : JSON.stringify(stat.sample).slice(0, 24)}`);
  }
  // And one market whole, so a field nobody thought to list is still visible.
  console.log(`\n   every key on the first nested market:`);
  console.log(`   ${Object.keys(markets[0]).join(", ").slice(0, 1200)}`);
}

async function fromCatalogue() {
  // One page of the ACTIVE catalogue -- the same request the dashboard makes, and never the
  // resolved scope, which is the read that exhausted the host's memory limit.
  const url = `${HOST}/api.php?action=state&target=paper&summary=scraped&scope=active&offset=0`;
  const payload = await getJson(url);
  const rows = Array.isArray(payload?.marketObservations) ? payload.marketObservations : [];
  console.log(`   ${rows.length} active row(s) on the first page`);
  if (!rows.length) {
    console.log(`   response keys: ${Object.keys(payload || {}).join(", ")}`);
    return;
  }
  console.log(`   bucket                        rows  volumeUsdc  volume24hr  liquidity  firstVol  firstLiq`);
  for (const bucket of storedCoverage(rows)) {
    if (!bucket.rows) continue;
    console.log(`   ${bucket.label.padEnd(28)} ${String(bucket.rows).padStart(5)}`
      + ` ${String(bucket.volumeUsdc).padStart(11)} ${String(bucket.volume24hr).padStart(11)}`
      + ` ${String(bucket.liquidity).padStart(10)} ${String(bucket.firstVolumeUsdc).padStart(9)}`
      + ` ${String(bucket.firstLiquidity).padStart(9)}`);
  }
  const newest = rows
    .map((row) => String(row?.firstObservedAt || ""))
    .filter(Boolean)
    .sort()
    .slice(-1)[0];
  console.log(`   newest firstObservedAt on the page: ${newest || "(none recorded)"}`);
}

async function main() {
  console.log(`Volume capture check at ${new Date().toISOString()}`);
  console.log(`\n== what Gamma hands the scan (nested markets inside events)`);
  try {
    await fromGamma();
  } catch (error) {
    console.log(`   !! ${error?.message || error}`);
  }
  console.log(`\n== what the stored active catalogue holds`);
  try {
    await fromCatalogue();
  } catch (error) {
    console.log(`   !! ${error?.message || error}`);
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`Check failed: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
