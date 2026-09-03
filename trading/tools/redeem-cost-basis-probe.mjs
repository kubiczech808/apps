// Read-only probe. Writes nothing, publishes nothing, needs no secrets.
//
// 52 of 137 stored closed rows are redemptions with no stake, no entry price and no P/L,
// and the measurement that found them (tools/unmatched-redeem-diagnosis.mjs) ruled out the
// explanation the code was written on: they are the NEWEST rows, not the oldest -- median
// 36 h old, 34 of 52 closed within 48 h -- so "the buy aged out of a capped feed" is not
// what is happening. For 50 of the 52, no buy is findable in the retained history by token,
// condition, slug or question. The buys are not late; they are absent.
//
// Absent from OUR retained copy, that is. This asks Polymarket where they actually are.
// The leading suspicion is the shape of the request rather than the size of it: this account
// rests limit orders and is filled by whoever crosses them, which makes it the MAKER, and
// data-api's /trades is documented to return taker-side rows by default. If that is it,
// every maker fill this account has ever made is invisible to the sync -- which would
// explain an absence that no window size could.
//
// So for a handful of the affected markets, taken from our own stored rows, this tries the
// endpoints and parameters that could carry the cost basis and reports which one answers.
// Whichever wins is what the fix has to use.
const HOST = process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading";
const DATA_API = process.env.POLYMARKET_DATA_API || "https://data-api.polymarket.com";
const SAMPLE = Math.max(1, Number(process.env.PROBE_SAMPLE || 4));

const text = (value) => String(value == null ? "" : value).trim();

async function fetchJson(url) {
  const response = await fetch(url, { headers: { "User-Agent": "osobnizkusenosti-trading-live-sync" } });
  const body = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 120)}`);
  const payload = JSON.parse(body);
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  return payload;
}

function isUnmatchedRedeem(row = {}) {
  return text(row.status).toUpperCase() === "REDEEMED"
    && row.stakeUsdc == null
    && row.entryPrice == null;
}

// What a row would have to carry to give a stake back: a price paid and a size.
function costBasisOf(row = {}) {
  const price = Number(row?.avgPrice ?? row?.price ?? row?.entryPrice);
  const size = Number(row?.size ?? row?.shares ?? row?.initialSize);
  const cost = Number(row?.initialValue ?? row?.totalCost ?? row?.usdcSize);
  const parts = [];
  if (Number.isFinite(price) && price > 0) parts.push(`price ${price.toFixed(4)}`);
  if (Number.isFinite(size) && size > 0) parts.push(`size ${size}`);
  if (Number.isFinite(cost) && cost > 0) parts.push(`cost ${cost.toFixed(4)}`);
  if (Number.isFinite(Number(row?.realizedPnl))) parts.push(`realizedPnl ${Number(row.realizedPnl).toFixed(4)}`);
  return parts;
}

async function main() {
  console.log(`Redeem cost-basis probe at ${new Date().toISOString()}`);
  console.log(`Read-only: nothing is written, no credentials are used.\n`);

  const live = await fetchJson(`${HOST}/api.php?action=state&target=live`);
  const account = text(live?.account?.address || live?.account?.proxyWallet);
  if (!account) throw new Error("the served live state names no account address");
  console.log(`account ${account}\n`);

  const closed = Array.isArray(live?.closedTrades) ? live.closedTrades : [];
  const affected = closed.filter(isUnmatchedRedeem);
  console.log(`stake-less redemptions stored: ${affected.length} of ${closed.length} closed rows\n`);
  if (!affected.length) {
    console.log(`Nothing to probe.`);
    return;
  }

  // First the account-wide question, because it decides everything else: does /trades hide
  // the maker side by default?
  console.log(`== 1. does /trades hide this account's maker fills?`);
  for (const [label, url] of [
    ["/trades (as the sync asks)", `${DATA_API}/trades?user=${account}&limit=500`],
    ["/trades takerOnly=false", `${DATA_API}/trades?user=${account}&limit=500&takerOnly=false`],
    ["/activity (as the sync asks)", `${DATA_API}/activity?user=${account}&limit=500`],
  ]) {
    try {
      const rows = await fetchJson(url);
      const list = Array.isArray(rows) ? rows : [];
      const buys = list.filter((row) => text(row.side || row.type).toUpperCase().includes("BUY"));
      const oldest = list.map((row) => Number(row.timestamp)).filter(Number.isFinite).sort((a, b) => a - b)[0];
      console.log(`   ${label.padEnd(30)} ${String(list.length).padStart(4)} rows, ${String(buys.length).padStart(4)} buys`
        + `${oldest ? `, oldest ${new Date(oldest * 1000).toISOString().slice(0, 16)}` : ""}`);
    } catch (error) {
      console.log(`   ${label.padEnd(30)} failed: ${String(error.message).slice(0, 70)}`);
    }
  }

  console.log(`\n== 2. per market, which query returns a cost basis`);
  const verdicts = new Map();
  for (const row of affected.slice(0, SAMPLE)) {
    const conditionId = text(row.conditionId);
    const slug = text(row.slug || row.eventSlug);
    console.log(`\n-- "${text(row.question).slice(0, 62)}"  [${text(row.outcome) || "-"}]`);
    console.log(`   condition ${conditionId || "-"}   slug ${slug || "-"}   redeemed shares ${row.redeemedShares ?? row.shares ?? "-"}`);

    const attempts = [
      ...(conditionId ? [
        ["trades?market", `${DATA_API}/trades?user=${account}&market=${conditionId}&limit=100`],
        ["trades?market takerOnly=false", `${DATA_API}/trades?user=${account}&market=${conditionId}&limit=100&takerOnly=false`],
        ["activity?market", `${DATA_API}/activity?user=${account}&market=${conditionId}&limit=100`],
        ["positions?market", `${DATA_API}/positions?user=${account}&market=${conditionId}&limit=100`],
        ["positions?market sizeThreshold=0", `${DATA_API}/positions?user=${account}&market=${conditionId}&limit=100&sizeThreshold=0`],
      ] : []),
    ];

    for (const [label, url] of attempts) {
      let rows = null;
      try {
        rows = await fetchJson(url);
      } catch (error) {
        console.log(`   ${label.padEnd(32)} threw: ${String(error.message).slice(0, 50)}`);
        continue;
      }
      const list = Array.isArray(rows) ? rows : [];
      if (!list.length) {
        console.log(`   ${label.padEnd(32)} no row`);
        continue;
      }
      // The row that could give the stake back is the one describing the acquisition.
      const useful = list.find((entry) => costBasisOf(entry).length >= 2) || list[0];
      const basis = costBasisOf(useful);
      console.log(`   ${label.padEnd(32)} ${String(list.length).padStart(3)} rows`
        + `${basis.length ? `  -> ${basis.join(", ")}` : "  (nothing that prices it)"}`);
      if (basis.length >= 2) {
        verdicts.set(label, (verdicts.get(label) || 0) + 1);
        if (!verdicts.has(`__shape:${label}`)) {
          verdicts.set(`__shape:${label}`, 1);
          console.log(`     keys: ${Object.keys(useful).slice(0, 16).join(", ")}`);
        }
      }
    }
  }

  const sampled = Math.min(SAMPLE, affected.length);
  console.log(`\n== which queries returned a cost basis, and for how many of the sampled markets`);
  const ranked = [...verdicts.entries()]
    .filter(([label]) => !label.startsWith("__shape:"))
    .sort((a, b) => b[1] - a[1]);
  for (const [label, count] of ranked) console.log(`   ${String(count).padStart(3)} / ${sampled}  ${label}`);
  if (!ranked.length) console.log(`   none -- no query tried here prices these redemptions`);
}

main().catch((error) => {
  console.log(`\n!! probe stopped early: ${error?.message || error}`);
  process.exitCode = 1;
});
