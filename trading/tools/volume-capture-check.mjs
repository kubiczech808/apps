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
  // present AND positive, separately. "Is volume being saved" is not answered by counting
  // rows above zero: a field the writer never wrote and a market that genuinely has no
  // volume yet both read as not-positive, and only one of them is a fault. The Gamma half of
  // this check already made that distinction; leaving it out here asked a different
  // question and would have been reported as an answer to this one.
  // feeRate and the quote's two sides are here for the same reason as volume: the settled
  // statistics charge a fee only when the row recorded a rate, and they buy at
  // firstMarketProbability -- the quoted mid -- while a market order pays the ask. Both gaps
  // are invisible unless somebody counts how often the fields are even there.
  const FIELDS = ["volumeUsdc", "volume24hr", "liquidity", "firstVolumeUsdc", "firstLiquidity",
    "firstFeeRate", "feeRate", "firstSpread", "firstBestAsk", "firstBestBid"];
  const counts = buckets.map((bucket) => ({
    ...bucket,
    rows: 0,
    ...Object.fromEntries(FIELDS.map((field) => [field, { present: 0, positive: 0 }])),
  }));
  for (const row of rows) {
    const seen = Date.parse(String(row?.firstObservedAt || row?.observedAt || ""));
    const ageHours = Number.isFinite(seen) ? (now - seen) / 3600000 : Infinity;
    const bucket = counts.find((entry) => ageHours <= entry.within) ?? counts[counts.length - 1];
    bucket.rows += 1;
    for (const field of FIELDS) {
      const value = row?.[field];
      if (value === undefined || value === null || value === "") continue;
      bucket[field].present += 1;
      if (positive(value)) bucket[field].positive += 1;
    }
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
  console.log(`   Each cell is present/positive: how many rows carry the field at all, and how many`);
  console.log(`   carry it above zero. A field that is present on every row is being saved; a zero`);
  console.log(`   on a present field is a market with no volume yet, which is not a fault.\n`);
  console.log(`   bucket                        rows   volumeUsdc    volume24hr     liquidity      firstVol      firstLiq`);
  const cell = (stat, rows) => `${stat.present}/${stat.positive}`.padStart(13)
    + (stat.present < rows ? "!" : " ");
  for (const bucket of storedCoverage(rows)) {
    if (!bucket.rows) continue;
    console.log(`   ${bucket.label.padEnd(28)} ${String(bucket.rows).padStart(5)}`
      + cell(bucket.volumeUsdc, bucket.rows) + cell(bucket.volume24hr, bucket.rows)
      + cell(bucket.liquidity, bucket.rows) + cell(bucket.firstVolumeUsdc, bucket.rows)
      + cell(bucket.firstLiquidity, bucket.rows));
  }
  console.log(`   ("!" marks a field missing from some rows -- that is the one that means not saved.)`);
  // What a market order would actually have paid above the price the statistics simulate.
  // The settled tables buy at the quoted mid; a taker crosses to the ask. This is that gap,
  // measured on the rows that recorded both.
  const gaps = rows
    .map((row) => {
      const ask = num(row?.firstBestAsk);
      const mid = num(row?.firstMarketProbability);
      return ask != null && mid != null && ask > 0 && mid > 0 ? ask - mid : null;
    })
    .filter((gap) => gap != null)
    .sort((left, right) => left - right);
  const spreads = rows.map((row) => num(row?.firstSpread)).filter((value) => value != null)
    .sort((left, right) => left - right);
  const at = (list, q) => (list.length ? list[Math.min(list.length - 1, Math.floor(list.length * q))] : null);
  const show = (value) => (value == null ? "-" : `${(value * 100).toFixed(2)} pp`);
  console.log(`\n   ask minus simulated entry, on ${gaps.length} row(s) that recorded both:`);
  console.log(`      median ${show(at(gaps, 0.5))}, 75th ${show(at(gaps, 0.75))}, 90th ${show(at(gaps, 0.9))}`);
  console.log(`   recorded spread at discovery, on ${spreads.length} row(s):`);
  console.log(`      median ${show(at(spreads, 0.5))}, 75th ${show(at(spreads, 0.75))}, 90th ${show(at(spreads, 0.9))}`);
  const feeRates = rows.map((row) => num(row?.firstFeeRate ?? row?.feeRate)).filter((value) => value != null);
  const charged = feeRates.filter((rate) => rate > 0).length;
  console.log(`   fee rate recorded on ${feeRates.length}/${rows.length} row(s), above zero on ${charged}.`);
  console.log(`      A row with no recorded rate is simulated with NO fee at all.`);

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
