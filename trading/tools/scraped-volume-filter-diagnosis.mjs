// Read-only diagnostic. Writes nothing, places nothing.
//
// Reported: on /trading/opportunities/scraped/ with "Volume min >= 1000" set, rows still
// appear whose Volume column reads 0.
//
// The dashboard reads a row's volume through two different functions, and this checks
// whether they disagree on production data rather than only in the source:
//
//   * the Volume COLUMN uses firstScrapedVolumeUsdc(), which accepts a recorded 0 as an
//     answer (`>= 0`) and therefore stops at firstVolumeUsdc even when it is zero;
//   * the FILTER uses rowVolumeUsdc(), which skips zeros (`> 0`) and falls through
//     volumeUsdc -> volume24hr -> firstVolume24hr -> liquidity.
//
// So a market first scraped before it had traded keeps a zero in the column for ever,
// while the filter reads its real, current volume and lets it through. Both hypotheses --
// a stale zero in the display, and the filter passing on `liquidity` rather than on
// volume -- are counted separately below, because they call for different fixes.
const STATE_URL = process.env.PAPER_STATE_URL
  || "https://osobnizkusenosti.cz/trading/api.php?action=state&target=paper&summary=scraped";
const MIN_VOLUME = Number(process.env.DIAGNOSIS_MIN_VOLUME || 1000);

// Copied verbatim from assets/app.js. If these drift, the diagnosis stops describing the
// dashboard, so they are deliberately not "improved" here.
function rowVolumeUsdc(item = {}) {
  for (const candidate of [item?.volumeUsdc, item?.volume24hr, item?.firstVolume24hr, item?.liquidity]) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
  }
  return 0;
}

function firstScrapedVolumeUsdc(item = {}) {
  for (const candidate of [
    item?.firstVolumeUsdc, item?.firstVolume24hr, item?.volumeUsdc,
    item?.volume24hr, item?.firstLiquidity, item?.liquidity,
  ]) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric) && numeric >= 0) return numeric;
  }
  return null;
}

function resolvedScrapedVolumeUsdc(item = {}) {
  for (const candidate of [item?.resolvedVolumeUsdc, item?.resolvedVolume24hr]) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric) && numeric >= 0) return numeric;
  }
  return null;
}

function status(item = {}) {
  return String(item?.status || item?.selectionStatus || "").toUpperCase() === "RESOLVED" ? "RESOLVED" : "SCRAPED";
}

// What the Volume column prints, as a number.
function displayedVolume(item = {}) {
  const first = firstScrapedVolumeUsdc(item);
  if (status(item) !== "RESOLVED") return first ?? rowVolumeUsdc(item);
  const resolved = resolvedScrapedVolumeUsdc(item);
  return Number.isFinite(resolved) ? resolved : (first ?? rowVolumeUsdc(item));
}

const money = (value) => (Number.isFinite(Number(value)) ? `$${Math.round(Number(value)).toLocaleString("en-US")}` : "-");

async function main() {
  console.log(`Scraped volume filter diagnosis at ${new Date().toISOString()}`);
  console.log(`Filter under test: Volume min >= ${MIN_VOLUME}\n`);

  const response = await fetch(STATE_URL);
  if (!response.ok) throw new Error(`state HTTP ${response.status}`);
  const payload = await response.json();
  const rows = Array.isArray(payload?.marketObservations) ? payload.marketObservations
    : Array.isArray(payload?.scraped) ? payload.scraped
      : Array.isArray(payload?.observations) ? payload.observations : [];
  console.log(`catalogue rows: ${rows.length}`);
  if (!rows.length) {
    console.log(`payload keys: ${Object.keys(payload || {}).join(", ")}`);
    return;
  }

  const live = rows.filter((row) => status(row) !== "RESOLVED");
  console.log(`  of which SCRAPED (the default tab): ${live.length}\n`);

  let passes = 0;
  let mismatched = 0;
  let displayedZeroButPasses = 0;
  let passesOnLiquidityOnly = 0;
  const examples = [];

  for (const row of live) {
    const filterValue = rowVolumeUsdc(row);
    const shown = displayedVolume(row);
    const passesFilter = MIN_VOLUME <= 0 || (Number.isFinite(filterValue) && filterValue >= MIN_VOLUME);
    if (!passesFilter) continue;
    passes += 1;

    // The number the user reads is not the number the filter tested.
    if (Number(shown) !== Number(filterValue)) mismatched += 1;
    if (!(Number(shown) > 0)) displayedZeroButPasses += 1;

    // The filter was satisfied by resting order-book depth, not by traded volume: every
    // genuine volume field was absent or zero and only `liquidity` cleared the floor.
    const anyVolume = [row?.volumeUsdc, row?.volume24hr, row?.firstVolume24hr]
      .map(Number).some((value) => Number.isFinite(value) && value > 0);
    if (!anyVolume) passesOnLiquidityOnly += 1;

    if (!(Number(shown) > 0) && examples.length < 12) {
      examples.push({
        title: String(row.question || row.title || row.slug || "").slice(0, 46),
        shown,
        filterValue,
        firstVolumeUsdc: row.firstVolumeUsdc,
        firstVolume24hr: row.firstVolume24hr,
        volumeUsdc: row.volumeUsdc,
        volume24hr: row.volume24hr,
        liquidity: row.liquidity,
      });
    }
  }

  console.log(`rows passing the >= ${MIN_VOLUME} filter: ${passes}`);
  console.log(`  showing a Volume different from the one filtered on: ${mismatched}`);
  console.log(`  showing Volume 0 while passing  <-- the reported bug: ${displayedZeroButPasses}`);
  console.log(`  passing on liquidity alone, with no traded volume at all: ${passesOnLiquidityOnly}\n`);

  if (examples.length) {
    console.log(`Examples of rows that display 0 and still pass:`);
    for (const row of examples) {
      console.log(`  ${row.title.padEnd(48)} shown=${money(row.shown)} filtered=${money(row.filterValue)}`);
      console.log(`      firstVolumeUsdc=${row.firstVolumeUsdc}  firstVolume24hr=${row.firstVolume24hr}`
        + `  volumeUsdc=${row.volumeUsdc}  volume24hr=${row.volume24hr}  liquidity=${row.liquidity}`);
    }
  }

  // How often a stored zero is shadowing a real current volume, across the whole tab --
  // this is the display half of the bug and is visible with no filter set at all.
  const staleZeros = live.filter((row) => Number(firstScrapedVolumeUsdc(row)) === 0 && rowVolumeUsdc(row) > 0);
  console.log(`\nrows whose column shows 0 although a current volume is known: ${staleZeros.length}`);
  for (const row of staleZeros.slice(0, 5)) {
    console.log(`  ${String(row.question || row.title || "").slice(0, 46).padEnd(48)}`
      + ` current=${money(rowVolumeUsdc(row))}`);
  }
}

main().catch((error) => {
  console.log(`\n!! diagnosis stopped early: ${error?.message || error}`);
  process.exitCode = 1;
});
