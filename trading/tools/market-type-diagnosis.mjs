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
// This prints how the rule classifies real resolved rows, grouped so a misclassified
// family is visible as a family rather than as an anecdote, and then what each portfolio's
// market-type filter matches before and after -- because a portfolio filtering on one kind
// trades a different pool once the rule changes.
//
// Polymarket's own negRisk flag would be the authoritative signal here and was tried:
// every one of 24 slug lookups against Gamma came back empty for these resolved markets,
// so the probe was removed rather than left printing 24 failures a run.
import { reportMarketType } from "./paper-trading-bot.mjs";

const HOST = process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading";

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

  // What this costs each portfolio. A portfolio filtering on one kind sees a different pool
  // once the rule changes, and for a portfolio configured "multi" the pool gets much
  // smaller -- that is a change in what it will trade from now on, not only a change in how
  // the statistics read, so it belongs in the same measurement.
  {
    console.log(`\n-- what each portfolio's market-type filter now matches --`);
    const configured = await fetchJson(`${HOST}/api.php?action=portfolio-config`);
    const paper = configured.ok ? (configured.body?.config?.paper || {}) : {};
    const computed = { binary: 0, multi: 0 };
    const stored = { binary: 0, multi: 0, all: 0 };
    for (const row of rows) {
      computed[row.computedType] = (computed[row.computedType] || 0) + 1;
      stored[row.storedType] = (stored[row.storedType] || 0) + 1;
    }
    console.log(`   sample of ${rows.length}: was binary=${stored.binary || 0} multi=${stored.multi || 0}`
      + ` -> now binary=${computed.binary} multi=${computed.multi}`);
    for (const [id, config] of Object.entries(paper)) {
      const required = String(config.marketType || "all");
      const matches = required === "all" ? rows.length : (computed[required] || 0);
      const before = required === "all" ? rows.length : (stored[required] || 0);
      console.log(`   ${id.padEnd(16)} filter=${required.padEnd(6)}`
        + ` matching rows ${String(before).padStart(5)} -> ${String(matches).padStart(5)}`
        + (required === "all" ? "  (unaffected)" : ""));
    }
  }
}

main().catch((error) => {
  console.log(`\n!! diagnosis stopped early: ${error?.message || error}`);
  process.exitCode = 1;
});
