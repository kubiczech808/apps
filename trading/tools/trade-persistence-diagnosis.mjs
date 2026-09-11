// Read-only diagnostic. Writes nothing, publishes nothing, needs no secrets.
//
// Asked for: every trade should be written to the database when it opens and updated when it
// closes, each one carrying the portfolio that placed it, kept long-term so statistics and
// reposting can be built on top of it later.
//
// Three separate things have to be true for that, and they fail independently:
//
//   1. the database is reachable and its schema exists
//   2. it has been ACTIVATED -- reads and writes only go through it once a migration has run
//      and the flag is set, and until then every ingest fails quietly by design
//   3. trades are actually stored as TRADES -- rows that can be queried and updated per
//      portfolio, rather than only as a blob inside the state document
//
// The first two are answered by the public storage-status endpoint. The third is answered by
// the trade-rows endpoint: a count of stored trades per portfolio, and how many of them are
// open versus closed. A schema that is ready and active but holds no trade rows is the case
// that looks healthy and stores nothing.
const HOST = process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading";

async function fetchJson(url, label) {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

async function main() {
  const status = await fetchJson(`${HOST}/api.php?action=storage-status`, "storage status");
  const storage = status?.storage || {};
  console.log("== database");
  console.log(`   configured    ${storage.configured === true ? "yes" : "NO"}`);
  console.log(`   reachable     ${storage.connected === true ? "yes" : "NO"}`);
  console.log(`   schema ready  ${storage.schemaReady === true ? "yes" : "NO"}`);
  console.log(`   ACTIVE        ${status.active === true ? "yes" : "NO"}`);
  console.log(`   json imported ${status.jsonImportedAt || "(never)"}`);
  console.log(`   last ingest   ${status.lastIngestAt || "(never)"}`);
  console.log(`   last error    ${status.lastMigrationError || "(none)"}`);
  console.log(`   observations  ${JSON.stringify(status.counts || {})}`);
  if (storage.error) console.log(`   error         ${storage.error}`);
  console.log(`   raw storage   ${JSON.stringify(storage)}`);

  // The point of the whole exercise: are the trades themselves in there, per portfolio.
  let trades = null;
  try {
    trades = await fetchJson(`${HOST}/api.php?action=trade-rows-summary`, "trade rows");
  } catch (error) {
    console.log(`\n== stored trades\n   the summary endpoint did not answer: ${error?.message || error}`);
  }
  if (trades) {
    console.log(`\n== stored trades (${trades.total ?? 0} rows, generated ${trades.generatedAt || "-"})`);
    if (trades.storageActive !== true) {
      console.log("   !! storage is not active, so nothing is being written and nothing can be read back");
    }
    const rows = Array.isArray(trades.portfolios) ? trades.portfolios : [];
    if (!rows.length) console.log("   (no trade rows at all)");
    for (const row of rows) {
      console.log(`   ${String(row.portfolioId || "(none)").padEnd(28)}`
        + ` ${String(row.total ?? 0).padStart(5)} rows`
        + `   open ${String(row.open ?? 0).padStart(4)}`
        + `   closed ${String(row.closed ?? 0).padStart(5)}`
        + `   first ${String(row.firstOpenedAt || "-").slice(0, 19)}`
        + `   last ${String(row.lastUpdatedAt || "-").slice(0, 19)}`);
    }
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
