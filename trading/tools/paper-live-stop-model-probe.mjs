#!/usr/bin/env node
// Read-only. Public GETs against the hosting, no keys, no writes, no orders.
//
// Reported: three paper portfolios have fantastic results, their live copies lose money, and
// the closed rows differ -- paper shows "Protective exit", live shows only closed or lost.
//
// There is a mechanism behind that, and it is not cosmetic. When a PROTECTED paper position
// settles at zero, the bot does not book the whole stake. It books a fill at the stop floor,
// reasoning that the price passed through the floor on its way down and a sell resting there
// is taken out by the crossing. That models a resting limit order.
//
// The live system has no resting exit order. The RPi worker polls, and when it sees the bid
// at the trigger it submits a fill-or-kill -- which it also refuses on a gapped or
// counterparty-less book, deliberately, after a position once sold at 1.5 cents. So the same
// losing trade is booked at the floor in paper and at zero in live.
//
// This measures the size of that, per portfolio, before anything is changed:
//
//   * how many closed trades were booked FILLED_AT_FLOOR -- the ones no live twin could have
//     had, because nothing was resting in the book;
//   * what those trades booked, against what they would have booked at settlement;
//   * the portfolio's total P&L with and without the assumption.
//
// If the fantastic numbers survive it, the divergence is elsewhere. If they do not, the
// simulation has been flattering itself and every comparison drawn from it is off by this.
const HOST = (process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading").replace(/\/+$/, "");
const FOCUS = (process.env.PROBE_PORTFOLIOS || "").split(",").map((one) => one.trim().toLowerCase()).filter(Boolean);

async function get(path) {
  const response = await fetch(`${HOST}/${path}`, { headers: { Accept: "application/json" } });
  const text = await response.text();
  if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status}: ${text.slice(0, 160)}`);
  return JSON.parse(text);
}

const money = (value) => `${value < 0 ? "-" : "+"}$${Math.abs(Number(value) || 0).toFixed(2)}`;
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);

// What the position would have been worth had nothing sold it: a market that settled at zero
// returns nothing, so the loss is the whole cost.
function settlementPnl(trade) {
  const cost = num(trade.totalCostUsdc) ?? num(trade.stakeUsdc);
  return cost == null ? null : -cost;
}

async function main() {
  console.log(`Paper stop-fill model, ${new Date().toISOString()}`);
  console.log("Read-only: nothing is written, no credentials are used.\n");

  const state = await get("api.php?action=state&target=paper&summary=dashboard");
  const portfolios = state?.paperPortfolios || state?.state?.paperPortfolios || {};
  const ids = Object.keys(portfolios);
  if (!ids.length) {
    console.log("no paper portfolios in the published state");
    return 0;
  }

  console.log("portfolio                     closed  atFloor   booked@floor   at settlement    difference");
  let totalDifference = 0;
  const flagged = [];
  for (const id of ids) {
    const row = portfolios[id] || {};
    const name = String(row.displayName || id);
    if (FOCUS.length && !FOCUS.some((want) => name.toLowerCase().includes(want) || id.toLowerCase().includes(want))) continue;
    // The dashboard summary carries one portfolio's trades at a time, so the rows are asked
    // for per portfolio rather than assumed to be in the overview.
    let trades = Array.isArray(row.trades) ? row.trades : [];
    if (!trades.length) {
      try {
        const detail = await get(`api.php?action=state&target=paper&summary=dashboard&strategy_id=${encodeURIComponent(id)}`);
        const detailed = (detail?.paperPortfolios || detail?.state?.paperPortfolios || {})[id] || {};
        trades = Array.isArray(detailed.trades) ? detailed.trades : [];
      } catch {
        // A portfolio whose detail cannot be read is reported as unreadable rather than as
        // having no trades: those look identical in a table and mean opposite things.
        console.log(`   ${name.padEnd(28)} (trades could not be read)`);
        continue;
      }
    }
    const closed = trades.filter((trade) => String(trade.status || "").toUpperCase() !== "OPEN" && trade.closedAt);
    const atFloor = closed.filter((trade) => String(trade.stopLossStatus || "") === "FILLED_AT_FLOOR");
    const booked = atFloor.reduce((sum, trade) => sum + (num(trade.realizedPnlUsdc) ?? 0), 0);
    const settled = atFloor.reduce((sum, trade) => sum + (settlementPnl(trade) ?? 0), 0);
    const difference = booked - settled;
    totalDifference += difference;
    console.log(`   ${name.padEnd(28)}${String(closed.length).padStart(5)}${String(atFloor.length).padStart(8)}`
      + `${money(booked).padStart(15)}${money(settled).padStart(16)}${money(difference).padStart(14)}`);
    if (atFloor.length) flagged.push({ name, atFloor: atFloor.length, closed: closed.length, difference });
  }

  console.log(`\n   total difference across the portfolios shown: ${money(totalDifference)}`);
  console.log("\n   \"at settlement\" is what the same trade books in LIVE, where nothing rests in");
  console.log("   the book and the worker's fill-or-kill either lands or does not. The difference");
  console.log("   is the part of a paper portfolio's result that has no live counterpart.");

  if (flagged.length) {
    console.log("\n== the portfolios this actually moves");
    for (const row of flagged.sort((a, b) => b.difference - a.difference)) {
      const share = row.closed ? (row.atFloor / row.closed) * 100 : 0;
      console.log(`   ${row.name.padEnd(28)} ${row.atFloor} of ${row.closed} closed trades`
        + ` (${share.toFixed(1)}%), worth ${money(row.difference)}`);
    }
  } else {
    console.log("\n   No closed trade anywhere was booked at its floor, so this assumption is not");
    console.log("   what separates the paper results from the live ones -- look elsewhere.");
  }
  return 0;
}

main().then((code) => process.exit(code), (error) => {
  console.log(`\n!! probe stopped early: ${error?.message || error}`);
  process.exit(1);
});
