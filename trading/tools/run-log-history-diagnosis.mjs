// Read-only diagnostic. Confirms action=portfolio-run-log actually works end to end on the
// live hosting: the workflow step wrote a real per-portfolio archive file over FTP, and this
// asks the real endpoint to page through it, exactly as the dashboard's "Load older runs"
// button would. Writes nothing, needs no secrets.
const HOST = process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading";
const STRATEGY_ID = process.env.RUN_LOG_DIAGNOSIS_STRATEGY_ID || "moreProbable";

async function fetchJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  try {
    return { ok: response.ok, status: response.status, body: JSON.parse(text) };
  } catch {
    return { ok: false, status: response.status, error: text.slice(0, 300) };
  }
}

async function main() {
  console.log(`Run-log history diagnosis at ${new Date().toISOString()}`);
  console.log(`Strategy: ${STRATEGY_ID}\n`);

  for (const page of [0, 1]) {
    const url = `${HOST}/api.php?action=portfolio-run-log&strategy_id=${encodeURIComponent(STRATEGY_ID)}&page=${page}&page_size=5`;
    const result = await fetchJson(url);
    if (!result.ok) {
      console.log(`page ${page}: HTTP ${result.status} ${result.error || JSON.stringify(result.body)}`);
      continue;
    }
    const { records, total, hasMore } = result.body;
    console.log(`page ${page}: total=${total} hasMore=${hasMore} returned=${records.length}`);
    for (const record of records) {
      console.log(`   runAt=${record.runAt} action=${record.action} reason=${String(record.reason || "").slice(0, 60)}`);
    }
  }
}

main();
