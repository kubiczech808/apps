// Read-only diagnostic. Lists every paper portfolio's real strategy id next to its current
// display label and capital-adjustment fields, so a portfolio named on the dashboard (e.g.
// "Stop loss") can be matched to the id a fix must actually target. Writes nothing.
const HOST = process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading";

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
  console.log(`Portfolio labels diagnosis at ${new Date().toISOString()}\n`);
  const paper = await fetchJson(`${HOST}/api.php?action=state&target=paper&summary=dashboard`);
  if (!paper.ok) {
    console.log(`!! could not read paper state: HTTP ${paper.status} ${paper.error || ""}`);
    return;
  }
  const state = paper.body?.state || paper.body || {};
  const portfolios = state.paperPortfolios || {};
  console.log(`generatedAt (api.php dashboard) : ${state.generatedAt}`);
  for (const [strategyId, portfolio] of Object.entries(portfolios)) {
    console.log(`id=${strategyId} label=${JSON.stringify(portfolio.label)} archived=${Boolean(portfolio.archived)}`);
    console.log(`   capitalAdjustmentUsdc=${portfolio.capitalAdjustmentUsdc ?? "-"} capitalAdjustmentAt=${portfolio.capitalAdjustmentAt ?? "-"}`);
    console.log(`   equityUsdc=${portfolio.portfolio?.equityUsdc ?? "-"} tradeCount=${Array.isArray(portfolio.trades) ? portfolio.trades.length : "-"}`);
  }

  const configResult = await fetchJson(`${HOST}/api.php?action=portfolio-config`);
  if (configResult.ok) {
    const paperConfig = configResult.body?.config?.paper || {};
    console.log("\n-- saved portfolio-config displayNames --");
    for (const [strategyId, row] of Object.entries(paperConfig)) {
      console.log(`id=${strategyId} displayName=${JSON.stringify(row.displayName)}`);
    }
  }

  // Bypasses api.php entirely: reads the raw file the workflow's FTP upload
  // wrote, so a mismatch against the api.php-served list above localizes the
  // bug to either the publish step or the read/serve layer.
  console.log("\n-- raw static paper-state.json (bypasses api.php) --");
  const staticResult = await fetchJson(`${HOST}/data/paper-state.json`);
  if (!staticResult.ok) {
    console.log(`!! could not read static state: HTTP ${staticResult.status} ${staticResult.error || ""}`);
  } else {
    const staticPortfolios = staticResult.body?.paperPortfolios || {};
    console.log(`generatedAt (raw static)        : ${staticResult.body?.generatedAt}`);
    console.log(`stateSegments keys: ${Object.keys(staticResult.body?.stateSegments || {}).join(", ") || "(none)"}`);
    console.log(`portfolio ids: ${Object.keys(staticPortfolios).join(", ") || "(none)"}`);
  }
}

main();
