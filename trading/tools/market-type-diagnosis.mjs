// Read-only diagnostic. Writes nothing, places nothing.
//
// Reported: the app has the wrong idea of what "multi-outcome" versus "Yes/No" means.
// Yes/No is any two-sided either-or event -- one team beats the other, the total lands
// over or under, a plain yes/no proposition -- and a football result being home/draw/away
// does not stop it being two-sided. Multi-outcome is a field of X mutually exclusive
// alternatives where exactly one of them wins: an election, an award, an outright winner.
// Each candidate there is quoted as its own Yes/No book, which is exactly why counting
// outcomes on a single market cannot tell the two apart.
//
// This prints how the current rule classifies real resolved rows, grouped so the
// misclassified families are visible as families rather than as anecdotes, and then asks
// Gamma whether negRisk -- Polymarket's own "one of these wins" flag -- agrees with the
// classification. negRisk is not stored on our rows, so whether it is worth capturing is
// exactly what this has to answer before any rule is rewritten.
import { reportMarketType } from "./paper-trading-bot.mjs";

const HOST = process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading";
const GAMMA = process.env.GAMMA_HOST || "https://gamma-api.polymarket.com";

async function fetchJson(url, attempts = 2) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      const text = await response.text();
      try {
        return { ok: response.ok, status: response.status, body: JSON.parse(text) };
      } catch {
        return { ok: false, status: response.status, error: text.slice(0, 200) };
      }
    } catch (error) {
      if (attempt < attempts) continue;
      return { ok: false, status: 0, error: `read failed: ${error?.message || error}` };
    }
  }
  return { ok: false, status: 0, error: "read failed" };
}

// The families the report is about. A row can match more than one, so these are probes
// rather than a classification -- the point is to count how the current rule treats each.
const FAMILIES = [
  ["over/under", (row) => /\bo\/u\b|\bover\b|\bunder\b/i.test(`${row.question} ${row.outcome}`)],
  ["team vs team", (row) => /\bvs\.?\b|\bv\.\b/i.test(row.question)],
  ["handicap/spread", (row) => /handicap|spread|\([-+]\d/i.test(row.question)],
  ["exact score", (row) => /exact score|correct score/i.test(row.question)],
  ["election/award", (row) => /election|primary|nominee|award|nomination|winner of/i.test(`${row.question} ${row.slug}`)],
  ["outright winner", (row) => /\bwin(s|ner)?\b.*\b(cup|league|championship|title|tournament|open|series)\b/i.test(row.question)],
];

function normalizeRow(item) {
  return {
    question: String(item?.question || ""),
    slug: String(item?.slug || ""),
    eventSlug: String(item?.eventSlug || ""),
    outcome: String(item?.outcome || ""),
    outcomeCount: Number(item?.outcomeCount),
    storedType: String(item?.marketType || ""),
    // What the live rule says today, from the row's own fields -- which is what the
    // statistics recompute on every rebuild, so it is the number that matters.
    computedType: reportMarketType(item),
  };
}

async function main() {
  console.log(`Market type classification diagnosis at ${new Date().toISOString()}\n`);

  const staticResult = await fetchJson(`${HOST}/data/paper-state.json`);
  if (!staticResult.ok) {
    console.log(`!! could not read state: HTTP ${staticResult.status} ${staticResult.error || ""}`);
    return;
  }
  const manifest = staticResult.body?.stateSegments || {};
  const recentFile = manifest.resolvedRecent?.file;
  if (!recentFile) {
    console.log(`!! no resolvedRecent page in the manifest -- nothing to sample`);
    return;
  }
  const page = await fetchJson(`${HOST}/data/${recentFile}`);
  if (!page.ok) {
    console.log(`!! could not read ${recentFile}: HTTP ${page.status} ${page.error || ""}`);
    return;
  }
  const rows = (Array.isArray(page.body?.resolvedMarketObservations) ? page.body.resolvedMarketObservations : [])
    .map(normalizeRow);
  console.log(`sampled ${rows.length} resolved rows from ${recentFile}\n`);

  // Stored versus recomputed. The statistics recompute, so a disagreement means the
  // dashboard's own market-type column and its statistics rows can already differ.
  {
    const counts = new Map();
    for (const row of rows) {
      const key = `stored=${row.storedType || "-"} computed=${row.computedType}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    console.log(`-- stored versus recomputed classification --`);
    for (const [key, count] of [...counts].sort((a, b) => b[1] - a[1])) {
      console.log(`   ${key.padEnd(34)} ${String(count).padStart(5)}`);
    }
  }

  // outcomeCount is the field the creation path trusts (> 2 means multi). If a two-sided
  // fixture with a draw shows up here as 3, that alone is the reported bug.
  {
    const counts = new Map();
    for (const row of rows) {
      const key = `${Number.isFinite(row.outcomeCount) ? row.outcomeCount : "absent"}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    console.log(`\n-- outcomeCount distribution --`);
    for (const [key, count] of [...counts].sort((a, b) => Number(b[1]) - Number(a[1]))) {
      console.log(`   outcomeCount=${key.padEnd(8)} ${String(count).padStart(5)}`);
    }
  }

  // The families, and how the current rule treats each. A family that is two-sided by the
  // reported definition and lands in "multi" is a misclassification with a size.
  console.log(`\n-- families, and how the current rule classifies them --`);
  for (const [name, matches] of FAMILIES) {
    const family = rows.filter(matches);
    if (!family.length) {
      console.log(`   ${name.padEnd(18)} 0 rows`);
      continue;
    }
    const multi = family.filter((row) => row.computedType === "multi").length;
    console.log(`   ${name.padEnd(18)} ${String(family.length).padStart(5)} rows`
      + ` -> multi=${String(multi).padStart(5)} binary=${String(family.length - multi).padStart(5)}`);
    for (const row of family.slice(0, 4)) {
      console.log(`      [${row.computedType}] outcome=${JSON.stringify(row.outcome).padEnd(12)}`
        + ` n=${row.outcomeCount} ${row.question.slice(0, 72)}`);
    }
  }

  // Distinct outcome labels: the classifier leans on outcomeKind(outcome), which only
  // knows "yes", "no" and "everything else". What "everything else" actually contains
  // decides whether that test can carry the weight the rule puts on it.
  {
    const counts = new Map();
    for (const row of rows) {
      const key = row.outcome.trim().toLowerCase() || "(empty)";
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const sorted = [...counts].sort((a, b) => b[1] - a[1]);
    console.log(`\n-- outcome labels: ${sorted.length} distinct, top 25 --`);
    for (const [label, count] of sorted.slice(0, 25)) {
      console.log(`   ${label.slice(0, 40).padEnd(42)} ${String(count).padStart(5)}`);
    }
  }

  // Does Polymarket's own flag agree? negRisk marks an event whose markets are mutually
  // exclusive and exactly one resolves YES -- the reported definition of multi-outcome,
  // stated by the exchange rather than guessed from a question. We do not store it, so
  // this asks Gamma for a spread of real slugs and prints the two side by side.
  {
    console.log(`\n-- negRisk versus our classification (Gamma lookup) --`);
    const seen = new Set();
    const probes = [];
    for (const row of rows) {
      if (!row.slug || seen.has(row.slug)) continue;
      seen.add(row.slug);
      probes.push(row);
      if (probes.length >= 24) break;
    }
    let agree = 0;
    let disagree = 0;
    let unknown = 0;
    for (const row of probes) {
      const result = await fetchJson(`${GAMMA}/markets?slug=${encodeURIComponent(row.slug)}`);
      const market = Array.isArray(result.body) ? result.body[0] : null;
      if (!result.ok || !market) {
        unknown += 1;
        console.log(`   ?        ${row.slug.slice(0, 58)} -- lookup failed`);
        continue;
      }
      const negRisk = market.negRisk === true;
      const impliedType = negRisk ? "multi" : "binary";
      const matched = impliedType === row.computedType;
      if (matched) agree += 1;
      else disagree += 1;
      console.log(`   ${matched ? "agree   " : "DISAGREE"} negRisk=${String(negRisk).padEnd(5)}`
        + ` ours=${row.computedType.padEnd(6)} n=${String(row.outcomeCount).padEnd(3)}`
        + ` ${row.question.slice(0, 56)}`);
    }
    console.log(`   agree=${agree} disagree=${disagree} unknown=${unknown} of ${probes.length} probed`);
  }
}

main().catch((error) => {
  console.log(`\n!! diagnosis stopped early: ${error?.message || error}`);
  process.exitCode = 1;
});
