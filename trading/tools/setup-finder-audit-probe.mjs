#!/usr/bin/env node
// Read-only. Public GETs against the published state. No keys, no writes, no orders.
//
// Reported, with a screenshot: the Setup finder says 100.0% accuracy for valorant over 36
// trades, and for japan-j-league over 50. "neverim jim. ja sam jsem mel otevrene pozice v
// valorant a kazda vyherni nebyla" -- with a losing position named.
//
// A 100% column is not a good result, it is a broken measurement, and the way this endpoint
// is built there are exactly three ways to produce one. This tells them apart on real data
// rather than by reading the code again:
//
//   1. losers are being SKIPPED     -- a row with no usable final price is passed over, and
//                                      if losers lack that field while winners carry it, the
//                                      survivors are all winners
//   2. losers are being MISFILED    -- the band is taken from the entry quote, and if that
//                                      falls back to the settlement price then a loser lands
//                                      in bucket 0 and a winner in bucket 99, so every high
//                                      bucket is pure winners
//   3. the population is genuinely  -- possible, and the least likely: it would mean every
//      all winners                     valorant market we ever resolved settled our way
//
// So for each row it reports which probability field the entry came from, whether a final
// price was present, and what the outcome was -- summed by tag, and then in full for the
// tags named in the report.
const HOST = (process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading").replace(/\/+$/, "");
const FOCUS = (process.env.PROBE_TAGS || "valorant,japan-j-league,argcopa")
  .split(",").map((tag) => tag.trim().toLowerCase()).filter(Boolean);

async function json(path) {
  const response = await fetch(`${HOST}/${path}`, { headers: { Accept: "application/json" } });
  const text = await response.text();
  if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

const numeric = (value) => (value !== null && value !== "" && Number.isFinite(Number(value)) ? Number(value) : null);

// api.php's simulation_entry_probability, field order included, so this reports what the
// endpoint actually used rather than what it ought to have used.
const ENTRY_FIELDS = ["firstMarketProbability", "lastLiveMarketProbability", "marketProbability", "marketPrice"];
function entryProbability(row) {
  for (const field of ENTRY_FIELDS) {
    const value = numeric(row[field]);
    if (value !== null && value > 0 && value < 1) return { value, field };
  }
  return { value: null, field: null };
}

// And its outcome rule: strictly settled, or nothing.
function outcome(row) {
  const value = numeric(row.finalOutcomePrice);
  if (value === null) return { outcome: null, reason: "no finalOutcomePrice" };
  if (value <= 0.005) return { outcome: 0, reason: null };
  if (value >= 0.995) return { outcome: 1, reason: null };
  return { outcome: null, reason: `final price ${value} is neither settled end` };
}

function tagsOf(row) {
  const lists = [row.firstPolymarketTags, row.polymarketTags, row.tags, row.eventTags, row.categoryTags];
  const out = new Set();
  for (const list of lists) {
    for (const tag of Array.isArray(list) ? list : []) {
      const slug = String(tag?.slug ?? tag?.label ?? tag ?? "").trim().toLowerCase();
      if (slug) out.add(slug);
    }
  }
  return out;
}

async function main() {
  console.log(`Setup finder audit, ${new Date().toISOString()}`);
  console.log("Read-only: nothing is written and no credentials are used.\n");

  // What the endpoint itself says, so the audit and the screen can be compared directly.
  const finder = await json("api.php?action=resolved-combinations&min_trades=25");
  const best = Array.isArray(finder?.best) ? finder.best : [];
  console.log("== what the Setup finder reports now");
  for (const row of best.slice(0, 8)) {
    console.log(`   >= ${String(row.probability ?? "?").padStart(3)}%  ${String(row.tag ?? "any").padEnd(18)}`
      + `${String(row.shape ?? "any").padEnd(12)}${String(row.horizon ?? "any").padEnd(12)}`
      + `trades=${String(row.trades ?? "?").padStart(4)}  accuracy=${row.accuracy ?? "?"}`);
  }
  for (const field of ["scanned", "priced", "rows", "generatedAt"]) {
    if (finder[field] !== undefined) console.log(`   ${field}: ${JSON.stringify(finder[field])}`);
  }

  // The rows themselves. The resolved archive is what the endpoint streams, so this reads
  // the same segment rather than a summary of it.
  console.log("\n== the resolved rows the finder counts");
  const state = await json(`api.php?action=state&target=paper&summary=scraped&t=${Date.now()}`);
  const manifest = state?.stateSegments || {};
  let rows = Array.isArray(state?.resolvedMarketObservations) ? state.resolvedMarketObservations : [];
  if (!rows.length && manifest.resolvedObservations?.file) {
    try {
      const segment = await json(`data/${manifest.resolvedObservations.file}`);
      rows = Array.isArray(segment?.resolvedMarketObservations) ? segment.resolvedMarketObservations : [];
    } catch (error) {
      console.log(`   could not read the resolved segment: ${error.message}`);
    }
  }
  console.log(`   ${rows.length} resolved row(s) readable`
    + `${rows.length ? "" : " -- the audit below has nothing to work with"}`);
  if (!rows.length) {
    console.log(`   (state keys: ${Object.keys(state || {}).slice(0, 14).join(", ")})`);
    console.log(`   (segments: ${Object.keys(manifest).join(", ")})`);
    return;
  }

  // Per tag: how many rows, how many were counted, and WHY the rest were not.
  const byTag = new Map();
  const bucket = (tag) => {
    if (!byTag.has(tag)) {
      byTag.set(tag, {
        rows: 0, counted: 0, wins: 0, losses: 0,
        noEntry: 0, noFinal: 0, midFinal: 0,
        entryFields: new Map(), highBand: 0, highBandWins: 0,
      });
    }
    return byTag.get(tag);
  };

  for (const row of rows) {
    const entry = entryProbability(row);
    const settled = outcome(row);
    for (const tag of tagsOf(row)) {
      const cell = bucket(tag);
      cell.rows += 1;
      if (entry.value === null) { cell.noEntry += 1; continue; }
      cell.entryFields.set(entry.field, (cell.entryFields.get(entry.field) || 0) + 1);
      if (settled.outcome === null) {
        if (settled.reason === "no finalOutcomePrice") cell.noFinal += 1;
        else cell.midFinal += 1;
        continue;
      }
      cell.counted += 1;
      if (settled.outcome === 1) cell.wins += 1; else cell.losses += 1;
      // The band the screen actually shows, so the audit lands on the same population.
      if (entry.value >= 0.5) {
        cell.highBand += 1;
        cell.highBandWins += settled.outcome;
      }
    }
  }

  console.log("\n   tag                 rows  counted  wins  losses   >=50%  acc@>=50%   skipped(noEntry/noFinal/midFinal)");
  const ranked = [...byTag].sort((left, right) => right[1].counted - left[1].counted).slice(0, 20);
  for (const [tag, cell] of ranked) {
    const accuracy = cell.highBand ? `${((cell.highBandWins / cell.highBand) * 100).toFixed(1)}%` : "-";
    console.log(`   ${tag.slice(0, 18).padEnd(20)}${String(cell.rows).padStart(5)}`
      + `${String(cell.counted).padStart(9)}${String(cell.wins).padStart(6)}${String(cell.losses).padStart(8)}`
      + `${String(cell.highBand).padStart(8)}${accuracy.padStart(11)}`
      + `   ${cell.noEntry}/${cell.noFinal}/${cell.midFinal}`);
  }

  // The verdict, for the tags the report named.
  console.log("\n== the named tags, in detail");
  for (const tag of FOCUS) {
    const cell = byTag.get(tag);
    if (!cell) {
      console.log(`\n   ${tag}: NOT PRESENT in the resolved archive at all.`);
      console.log("   The finder reports it, so it is counting rows this audit cannot see --");
      console.log("   check the tag spelling the finder groups by against the one the filter offers.");
      continue;
    }
    console.log(`\n   ${tag}`);
    console.log(`      rows carrying the tag            ${cell.rows}`);
    console.log(`      counted by the finder's rule     ${cell.counted}  (${cell.wins} win / ${cell.losses} loss)`);
    console.log(`      inside the >= 50% band           ${cell.highBand}  (${cell.highBandWins} win)`);
    console.log(`      skipped: no entry quote          ${cell.noEntry}`);
    console.log(`      skipped: no final price          ${cell.noFinal}`);
    console.log(`      skipped: final price mid-range   ${cell.midFinal}`);
    console.log(`      entry quote came from            ${[...cell.entryFields].map(([f, n]) => `${f}=${n}`).join(", ") || "nothing"}`);

    if (cell.losses === 0 && cell.counted > 0) {
      console.log("      -> EVERY counted row is a win. With "
        + `${cell.noFinal} row(s) skipped for a missing final price and ${cell.noEntry} for a`);
      console.log("         missing entry quote, the population being averaged is not the population");
      console.log("         of trades -- it is the subset that survived those two filters.");
    }
    if (cell.entryFields.has("marketProbability") || cell.entryFields.has("lastLiveMarketProbability")) {
      console.log("      -> Some rows took their ENTRY band from a late or settlement quote rather");
      console.log("         than from firstMarketProbability. On a resolved row that value has moved");
      console.log("         toward the outcome, so winners drift into high bands and losers into low");
      console.log("         ones -- which manufactures a high-probability band made only of winners.");
    }
  }
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
