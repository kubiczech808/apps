// Read-only diagnostic. Writes nothing, places nothing.
//
// Reported: the scrape lands too early, while a fixture has no volume and a massive
// bid/ask spread. The row then looks lucrative at a price no order could ever be filled at,
// because there is no counterparty. The proposed fix is to count only markets whose spread
// is under 5 points, in the statistics as well as at entry.
//
// That is implementable but not yet: a scraped observation stores no spread at all, because
// the market scan reads Gamma and never touches an orderbook. Gamma does return spread,
// bestAsk and bestBid on markets, so the field can be captured for nothing -- but before a
// 5-point gate is wired to anything, this measures what such a gate would actually do.
//
// What it has to answer: is Gamma's spread populated and plausible, how is it distributed,
// how much of the catalogue a 5-point rule keeps, and whether wide spreads really do
// coincide with no volume -- which is the reported mechanism, and the part that would make
// the rule a real quality filter rather than an arbitrary cut.
const GAMMA = process.env.GAMMA_HOST || "https://gamma-api.polymarket.com";
const PAGES = Math.max(1, Number(process.env.SPREAD_AUDIT_PAGES || 6));
const LIMIT = 100;

async function fetchJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  try {
    return { ok: response.ok, status: response.status, body: JSON.parse(text) };
  } catch {
    return { ok: false, status: response.status, error: text.slice(0, 200) };
  }
}

const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
const pctOf = (part, whole) => (whole ? `${((part / whole) * 100).toFixed(1)}%` : "n/a");

async function main() {
  console.log(`Market spread quality diagnosis at ${new Date().toISOString()}\n`);

  const markets = [];
  for (let page = 0; page < PAGES; page += 1) {
    const result = await fetchJson(
      `${GAMMA}/markets?limit=${LIMIT}&offset=${page * LIMIT}&closed=false&order=volume24hr&ascending=false`,
    );
    if (!result.ok || !Array.isArray(result.body)) {
      console.log(`!! page ${page} failed: HTTP ${result.status} ${result.error || ""}`);
      break;
    }
    markets.push(...result.body);
    if (result.body.length < LIMIT) break;
  }
  console.log(`sampled ${markets.length} open markets\n`);
  if (!markets.length) return;

  // Is the field even there, and does it look like a price difference rather than a percent
  // or a basis point? bestAsk minus bestBid is the cross-check: if spread tracks that, it is
  // in probability units and a "5 points" rule means 0.05.
  {
    const withSpread = markets.filter((market) => num(market.spread) != null);
    const withBook = markets.filter((market) => num(market.bestAsk) != null && num(market.bestBid) != null);
    console.log(`-- is the field usable --`);
    console.log(`   spread present     : ${withSpread.length} of ${markets.length} (${pctOf(withSpread.length, markets.length)})`);
    console.log(`   bestAsk and bestBid: ${withBook.length} of ${markets.length} (${pctOf(withBook.length, markets.length)})`);
    let agree = 0;
    let checked = 0;
    for (const market of withBook) {
      const stated = num(market.spread);
      if (stated == null) continue;
      checked += 1;
      if (Math.abs(stated - (num(market.bestAsk) - num(market.bestBid))) < 0.005) agree += 1;
    }
    console.log(`   spread == bestAsk - bestBid: ${agree} of ${checked} (${pctOf(agree, checked)})`
      + ` -- if so, spread is in probability units and "5 points" is 0.05`);
    for (const market of markets.slice(0, 5)) {
      console.log(`   e.g. spread=${market.spread} bestAsk=${market.bestAsk} bestBid=${market.bestBid}`
        + ` vol24h=${market.volume24hr} ${String(market.question || "").slice(0, 44)}`);
    }
  }

  // The distribution, and what a 5-point rule keeps.
  {
    const spreads = markets.map((market) => num(market.spread)).filter((value) => value != null);
    const sorted = [...spreads].sort((a, b) => a - b);
    const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
    console.log(`\n-- spread distribution over ${sorted.length} markets, in points --`);
    if (sorted.length) {
      for (const [label, fraction] of [["p10", 0.1], ["p25", 0.25], ["median", 0.5], ["p75", 0.75], ["p90", 0.9], ["p99", 0.99]]) {
        console.log(`   ${label.padEnd(7)} ${(at(fraction) * 100).toFixed(1)}`);
      }
      console.log(`   max     ${(sorted[sorted.length - 1] * 100).toFixed(1)}`);
    }
    console.log(`\n-- what each gate would keep --`);
    for (const gate of [0.01, 0.02, 0.03, 0.05, 0.08, 0.1, 0.2]) {
      const kept = spreads.filter((value) => value <= gate).length;
      console.log(`   spread <= ${String((gate * 100).toFixed(0)).padStart(2)} pts: keeps ${String(kept).padStart(4)}`
        + ` of ${spreads.length} (${pctOf(kept, spreads.length)})`
        + (Math.abs(gate - 0.05) < 1e-9 ? "   <- proposed" : "")
        + (Math.abs(gate - 0.08) < 1e-9 ? "   <- today's PAPER_MAX_SPREAD at entry" : ""));
    }
  }

  // The reported mechanism: scraped too early, so no volume and therefore no counterparty.
  // If wide spreads really do sit on dead markets, a spread gate is a liquidity gate too.
  {
    console.log(`\n-- does a wide spread mean no volume --`);
    const buckets = [
      ["<= 1 pt", (value) => value <= 0.01],
      ["1-3 pts", (value) => value > 0.01 && value <= 0.03],
      ["3-5 pts", (value) => value > 0.03 && value <= 0.05],
      ["5-10 pts", (value) => value > 0.05 && value <= 0.1],
      ["> 10 pts", (value) => value > 0.1],
    ];
    for (const [label, test] of buckets) {
      const rows = markets.filter((market) => {
        const value = num(market.spread);
        return value != null && test(value);
      });
      if (!rows.length) {
        console.log(`   ${label.padEnd(9)} none`);
        continue;
      }
      const vols = rows.map((market) => num(market.volume24hr) ?? 0).sort((a, b) => a - b);
      const liqs = rows.map((market) => num(market.liquidityNum ?? market.liquidity) ?? 0).sort((a, b) => a - b);
      const zeroVol = vols.filter((value) => value <= 0).length;
      console.log(`   ${label.padEnd(9)} n=${String(rows.length).padStart(4)}`
        + ` medianVol24h=$${vols[Math.floor(vols.length / 2)].toFixed(0).padStart(7)}`
        + ` medianLiq=$${liqs[Math.floor(liqs.length / 2)].toFixed(0).padStart(7)}`
        + ` zeroVolume=${String(zeroVol).padStart(4)} (${pctOf(zeroVol, rows.length)})`);
    }
  }
}

main().catch((error) => {
  console.log(`\n!! diagnosis stopped early: ${error?.message || error}`);
  process.exitCode = 1;
});
