#!/usr/bin/env node
// Read-only. Public GETs against the published state. No keys, no writes, no orders.
//
// Reported: the "dip 70+ to 30-56" portfolio shows "0 ready" while its own caption says
// "169 dip(s) recorded, newest 18. 09. 2026 09:57 at 56.0%", with an active opportunity
// visible on the exchange.
//
// A first theory was that the dashboard and the bot disagreed on the portfolio id -- the
// dashboard accepts a hit tagged "paper-<id>" OR the bare "<id>", the bot only the prefixed
// form. Checked against the code that writes them, and it does not hold: the watch plans are
// built with "paper-" already on them. So the mismatch is somewhere else, and this looks
// rather than guesses again.
//
// Every stage between a recorded dip and a ready candidate, counted, with the rows that fall
// out named at the stage they fall out:
//
//   recorded  -> for this portfolio  -> not already held  -> priced  -> inside the buy band
//
// The interesting number is wherever it drops to zero.
const HOST = (process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading").replace(/\/+$/, "");
const WANT = (process.env.PROBE_PORTFOLIO || "dip").toLowerCase();

async function json(path) {
  const response = await fetch(`${HOST}/${path}`, { headers: { Accept: "application/json" } });
  const text = await response.text();
  if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);

async function main() {
  console.log(`Dip shortlist probe, ${new Date().toISOString()}`);
  console.log("Read-only: nothing is written and no credentials are used.\n");

  const config = await json("api.php?action=portfolio-config");
  const body = config?.config || {};
  const candidates = Object.entries(body.paper || {})
    .map(([id, entry]) => ({ id, name: String(entry?.displayName || entry?.label || id), config: entry }));
  const match = candidates.find((entry) => entry.name.toLowerCase().includes(WANT)
    || entry.id.toLowerCase().includes(WANT));
  if (!match) {
    console.log(`No paper portfolio matching "${WANT}". Configured:`);
    for (const entry of candidates) console.log(`   ${entry.id.padEnd(24)} ${entry.name}`);
    return;
  }
  const prefixed = `paper-${match.id}`;
  console.log(`Portfolio: ${match.name}  (id=${match.id}, hits are filed under "${prefixed}")\n`);

  const rule = {
    openMin: num(match.config?.dipEntryOpenMin),
    openMax: num(match.config?.dipEntryOpenMax),
    buyMin: num(match.config?.dipEntryBuyMin) ?? num(match.config?.minProbability),
    buyMax: num(match.config?.dipEntryBuyMax) ?? num(match.config?.maxProbability),
    enabled: match.config?.dipEntryEnabled,
  };
  console.log("== the rule as configured");
  console.log(`   ${JSON.stringify(rule)}`);

  const [watch, hits] = await Promise.all([
    json(`api.php?action=dip-entry-watch&t=${Date.now()}`).catch((error) => ({ error: error.message })),
    json(`api.php?action=dip-entry-hits&t=${Date.now()}`).catch((error) => ({ error: error.message })),
  ]);

  console.log("\n== what is being watched");
  const plans = Array.isArray(watch?.watch) ? watch.watch : (Array.isArray(watch?.plans) ? watch.plans : []);
  if (watch?.error) console.log(`   could not read: ${watch.error}`);
  const byWatchPortfolio = new Map();
  for (const plan of plans) {
    const key = String(plan?.portfolioId ?? "(none)");
    byWatchPortfolio.set(key, (byWatchPortfolio.get(key) || 0) + 1);
  }
  console.log(`   ${plans.length} plan(s): ${[...byWatchPortfolio].map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`);

  console.log("\n== the recorded dips");
  const rows = Array.isArray(hits?.hits) ? hits.hits : [];
  if (hits?.error) console.log(`   could not read: ${hits.error}`);
  const byPortfolio = new Map();
  for (const hit of rows) {
    const key = String(hit?.portfolioId ?? "(none)");
    byPortfolio.set(key, (byPortfolio.get(key) || 0) + 1);
  }
  console.log(`   ${rows.length} hit(s) in total: ${[...byPortfolio].map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`);
  // The id question, settled rather than assumed either way.
  console.log(`   filed under "${prefixed}": ${byPortfolio.get(prefixed) || 0}`);
  console.log(`   filed under the bare "${match.id}": ${byPortfolio.get(match.id) || 0}`);

  const mine = rows.filter((hit) => String(hit?.portfolioId ?? "") === prefixed);
  if (!mine.length) {
    console.log("\n   NONE of the recorded dips are filed under this portfolio's id.");
    console.log("   That alone explains a shortlist of zero beside a caption counting hundreds,");
    console.log("   because the dashboard's caption accepts a second spelling and the bot does not.");
    return;
  }

  // What the bot's own row builder would reject. Each gate is the one named in
  // dipEntryCandidateRows, applied in the same order.
  console.log("\n== what happens to this portfolio's dips");
  const state = await json(
    `api.php?action=state&target=paper&summary=dashboard&strategy_id=${encodeURIComponent(match.id)}&t=${Date.now()}`)
    .catch((error) => ({ error: error.message }));
  const portfolio = state?.paperPortfolios?.[match.id] || {};
  const trades = Array.isArray(portfolio?.trades) ? portfolio.trades : [];
  const openTokens = new Set(trades
    .filter((trade) => ["OPEN", "LIMIT_ORDER_WAITING"].includes(String(trade?.status || "").toUpperCase()))
    .map((trade) => String(trade?.tokenId || "")));
  const everTokens = new Set(trades.map((trade) => String(trade?.tokenId || "")));

  let unpriced = 0;
  let held = 0;
  let traded = 0;
  let outsideBand = 0;
  let ended = 0;
  let ready = 0;
  const readyRows = [];
  const now = Date.now();
  for (const hit of mine) {
    const price = num(hit?.price);
    if (price === null || price <= 0 || price >= 1) { unpriced += 1; continue; }
    const token = String(hit?.tokenId || "");
    if (openTokens.has(token)) { held += 1; continue; }
    if (everTokens.has(token)) { traded += 1; continue; }
    const end = Date.parse(String(hit?.endDate || ""));
    if (Number.isFinite(end) && end <= now) { ended += 1; continue; }
    if ((rule.buyMin != null && price < rule.buyMin) || (rule.buyMax != null && price > rule.buyMax)) {
      outsideBand += 1;
      continue;
    }
    ready += 1;
    readyRows.push(hit);
  }

  console.log(`   recorded for this portfolio        ${mine.length}`);
  console.log(`   ... unusable price                 ${unpriced}`);
  console.log(`   ... already an OPEN position       ${held}`);
  console.log(`   ... already traded once            ${traded}`);
  console.log(`   ... market already ended           ${ended}`);
  console.log(`   ... dip price outside the buy band ${outsideBand}`);
  console.log(`   ... WOULD BE READY                 ${ready}`);

  for (const hit of readyRows.slice(0, 10)) {
    console.log(`      ${String(hit.question || hit.slug || "?").slice(0, 60).padEnd(60)}`
      + ` at ${(num(hit.price) * 100).toFixed(1)}%  opened ${hit.openProbability != null ? `${(num(hit.openProbability) * 100).toFixed(0)}%` : "?"}`
      + `  ends ${String(hit.endDate || "?").slice(0, 16)}`);
  }
  if (!ready) {
    console.log("\n   Nothing is ready, and the line above says which gate consumed them. If it is");
    console.log("   'already traded once', the rule is working as built: a dip is recorded once per");
    console.log("   token forever, so an old hit can never produce a second entry -- and the caption");
    console.log("   counts all 169 of those, which is why it disagrees with the shortlist.");
  }
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
