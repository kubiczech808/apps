// Runs offline: api.php is executed as a real request against a fabricated resolved
// archive on disk. No network, no secrets, no database.
//
// Asked for: "potrebuji vyuzit resolved data a vytvorit souhrne statistiky. nikoliv jen na
// urovni portfolii ale dohromady z resolved udalosti. statistiky by mi meli pomoct odhalit
// idealni setup portfolia popr. kombinace vice portfolii. napriklad nejvydelecnejsi
// kombinaci probability threshold, jake tagy included only, jake typy obchodu napriklad
// excluded ... a vycislit nominalne i procentualne, jak bych na tom byl, kdybych sel do
// kazdeho obchodu v dane kombinaci. a ty kombinace chci vlastne vsechny."
//
// The numbers are checked by hand against the fixture rather than against the endpoint's
// own output, because the whole value of this page is that a person will change a live
// portfolio's settings on the strength of it.

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API_PATH = new URL("../api.php", import.meta.url).pathname;
const STAKE = 5;

// A resolved row as the archive stores it. The entry price is what the simulation buys at,
// and finalOutcomePrice is how it settled.
const row = (entry, won, { tags = ["esports"], question = "A vs B", firstObservedAt = "2026-09-10T00:00:00.000Z", endDate = "2026-09-10T12:00:00.000Z", feeRate = null } = {}) => ({
  tokenId: `${entry}-${won ? "w" : "l"}-${Math.random().toString(36).slice(2, 9)}`,
  question,
  status: "RESOLVED",
  firstMarketProbability: entry,
  finalOutcomePrice: won ? 1 : 0,
  spread: 0.02,
  firstPolymarketTags: tags,
  firstObservedAt,
  endDate,
  ...(feeRate == null ? {} : { feeRate }),
});

function combinations(rows, query = "min_trades=1", action = "resolved-combinations") {
  const directory = mkdtempSync(join(tmpdir(), "combinations-"));
  try {
    mkdirSync(join(directory, "data"), { recursive: true });
    copyFileSync(API_PATH, join(directory, "api.php"));
    writeFileSync(join(directory, "config.php"), `<?php return ['trigger_key' => 'k'];`);
    writeFileSync(join(directory, "storage.php"), `<?php
      function trading_storage_pdo() { return new PDO('sqlite::memory:'); }
      function trading_storage_bootstrap($pdo): void {}
      function trading_storage_is_active(): bool { return false; }
      function trading_storage_observation_counts(): array { return ['SCRAPED' => 0, 'RESOLVED' => 0]; }
      function trading_storage_event_stream_stats(): array { return []; }
      function trading_storage_observation_freshness(): array { return []; }
      function trading_storage_meta_get(string $key) { return null; }
      function trading_storage_document_get(string $key) { return null; }
      function trading_storage_document_put(string $k, string $t, array $p): void {}
      function trading_storage_event_append(string $s, ?string $p, array $q, ?string $o = null): void {}
    `);
    writeFileSync(join(directory, "data", "paper-state.json"), JSON.stringify({
      schemaVersion: 7,
      paperPortfolios: {},
      stateSegments: { resolvedObservations: { file: "paper-state.resolved.json" } },
    }));
    writeFileSync(join(directory, "data", "paper-state.resolved.json"),
      JSON.stringify({ resolvedMarketObservations: rows }));
    writeFileSync(join(directory, "prelude.php"), `<?php
      $_GET['action'] = ${JSON.stringify(action)};
      ${query.split("&").map((pair) => {
        // Split on the FIRST '=' only. A horizon band is literally "<= 3 h", so splitting on
        // every '=' hands the endpoint "<" and the filter silently matches nothing.
        const at = pair.indexOf("=");
        const key = at === -1 ? pair : pair.slice(0, at);
        const value = at === -1 ? "" : pair.slice(at + 1);
        return `$_GET[${JSON.stringify(key)}] = ${JSON.stringify(value)};`;
      }).join("\n      ")}
      $_SERVER['REQUEST_METHOD'] = 'GET';
    `);
    const output = execFileSync("php", [
      "-d", `auto_prepend_file=${join(directory, "prelude.php")}`,
      join(directory, "api.php"),
    ], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return JSON.parse(output.slice(output.indexOf("{")));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function tagProbabilityAnalysis(rows, tag, mode = "threshold") {
  return combinations(rows, `tag=${encodeURIComponent(tag)}&mode=${encodeURIComponent(mode)}`, "resolved-tag-probability-analysis");
}

const find = (rows, facets) => rows.find((entry) =>
  Object.entries(facets).every(([key, value]) => entry[key] === value));

test("a combination is priced the way a portfolio would have traded it", () => {
  // Four wins and one loss at 0.80. A $5 stake buys 6.25 shares, so a win returns $6.25 --
  // a profit of $1.25 -- and a loss costs the whole $5.
  const payload = combinations([
    ...Array.from({ length: 4 }, () => row(0.8, true)),
    row(0.8, false),
  ]);
  assert.equal(payload.ok, true, JSON.stringify(payload).slice(0, 300));
  assert.equal(payload.pricedRows, 5);

  const all = find(payload.best, { tag: "*", shape: "*", horizon: "*", probability: 80 });
  assert.ok(all, `the everything-combination must be there: ${JSON.stringify(payload.best.slice(0, 3))}`);
  assert.equal(all.trades, 5);
  assert.equal(all.wins, 4);
  assert.equal(all.accuracy, 0.8);
  assert.equal(all.stakedUsdc, 25);
  // 4 * 1.25 - 5 = 0. The break-even case on purpose: at a 0.80 entry, 80% accuracy is
  // exactly fair, and a table that cannot reproduce that cannot be trusted with the rest.
  assert.equal(all.pnlUsdc, 0);
  assert.equal(all.returnPct, 0);
});

test("tag probability ROI is a ratio so the browser does not multiply it twice", () => {
  // $20 invested and $10 P/L is a 50% return. The UI formatter receives a ratio and
  // multiplies by 100 for display, so this endpoint must return 0.5, never 50.
  const payload = tagProbabilityAnalysis([
    ...Array.from({ length: 3 }, () => row(0.5, true, { tags: ["weather"] })),
    row(0.5, false, { tags: ["weather"] }),
  ], "weather");
  assert.equal(payload.ok, true, JSON.stringify(payload).slice(0, 300));
  const atFifty = payload.rows.find((entry) => entry.minimumProbability === 50);
  assert.ok(atFifty, "the cumulative 50% floor must be returned");
  assert.equal(atFifty.stakedUsdc, 20);
  assert.equal(atFifty.pnlUsdc, 10);
  assert.equal(atFifty.returnPct, 0.5);
});

test("tag probability point mode isolates one whole-percent entry range", () => {
  const payload = tagProbabilityAnalysis([
    row(0.51, true, { tags: ["weather"] }),
    row(0.519, false, { tags: ["weather"] }),
    row(0.52, true, { tags: ["weather"] }),
  ], "weather", "point");
  assert.equal(payload.ok, true, JSON.stringify(payload).slice(0, 300));
  assert.equal(payload.mode, "point");
  const atFiftyOne = payload.rows.find((entry) => entry.minimumProbability === 51);
  assert.ok(atFiftyOne, "the 51.00%-51.99% bucket must be returned");
  assert.equal(atFiftyOne.trades, 2, "the 52% entry belongs only to its own bucket");
  assert.equal(atFiftyOne.wins, 1);
});

test("the probability column is a threshold, not a band", () => {
  // "pro probability nemusi byt range, staci mi jedno cele cislo jako vstup y probability".
  // A threshold is what a portfolio is actually set to, so 70 has to include the 90s.
  const payload = combinations([
    ...Array.from({ length: 3 }, () => row(0.9, true)),
    ...Array.from({ length: 3 }, () => row(0.7, false)),
  ]);
  const at70 = find(payload.best, { tag: "*", shape: "*", horizon: "*", probability: 70 });
  const at90 = find(payload.best, { tag: "*", shape: "*", horizon: "*", probability: 90 });
  assert.equal(at70.trades, 6, "at 70 every row counts");
  assert.equal(at90.trades, 3, "at 90 only the 90s do");
  assert.equal(at90.wins, 3);
  // 3 * (5/0.9 - 5) = 1.67; the 70 threshold drags in three total losses.
  assert.equal(at90.pnlUsdc, 1.67);
  assert.equal(at70.pnlUsdc, -13.33);
});

test("a row with several tags is one trade under 'any tag', not two", () => {
  // The trap in summing a tag dimension. A row tagged esports AND cs2 is two cells, which
  // is right for a portfolio including either -- and counting it twice in the any-tag total
  // would report more trades than exist and halve the loss per trade.
  const payload = combinations([
    row(0.8, false, { tags: ["esports", "cs2"] }),
    row(0.8, false, { tags: ["esports", "cs2"] }),
  ]);
  const any = find(payload.best, { tag: "*", shape: "*", horizon: "*", probability: 80 });
  assert.equal(any.trades, 2, "two rows are two trades however many tags they carry");
  assert.equal(any.stakedUsdc, 10);
  assert.equal(any.pnlUsdc, -10);

  // And each tag separately still sees both.
  for (const tag of ["esports", "cs2"]) {
    assert.equal(find(payload.best, { tag, shape: "*", horizon: "*", probability: 80 }).trades, 2);
  }
});

test("rows first recorded after their stated resolution are not proposed as historical setups", () => {
  // The portfolio trade analysis could not answer this: a trade's own daysToResolution is
  // recomputed on every mark, so on a closed position it holds the horizon at the LAST mark
  // and everything lands in "<= 1 day". A catalogue row is not marked, so the gap between
  // first seeing it and its due date is a real horizon -- including a negative one.
  const payload = combinations([
    row(0.8, true, { firstObservedAt: "2026-09-10T10:00:00.000Z", endDate: "2026-09-10T12:00:00.000Z" }),
    row(0.8, true, { firstObservedAt: "2026-09-10T00:00:00.000Z", endDate: "2026-09-10T12:00:00.000Z" }),
    row(0.8, true, { firstObservedAt: "2026-09-10T13:00:00.000Z", endDate: "2026-09-10T12:00:00.000Z" }),
  ]);
  const bands = payload.best.filter((entry) => entry.tag === "*" && entry.shape === "*" && entry.probability === 80)
    .map((entry) => entry.horizon);
  assert.ok(bands.includes("<= 3 h"), `two hours ahead: ${bands.join(", ")}`);
  assert.ok(bands.includes("<= 12 h"), `twelve hours ahead: ${bands.join(", ")}`);
  assert.ok(!bands.includes("under way"), `an after-due row must not become an in-play setup: ${bands.join(", ")}`);
  assert.equal(payload.afterDueRejected, 1);
});

test("a row priced on one side and settled on the other is not a winning setup", () => {
  // Reported as "nechce se mi tem vysledkum moc verit, jsou az moc dobre": multi-strikes and
  // 1h showed 120 trades, 120 wins, +93.2%. Reconstructing the entry price from the published
  // capital and P/L gives 5*120/(578.85+621.00) = 0.50006 -- every one of them bought at
  // exactly 50c and every one of them won.
  //
  // The cause is structural, not luck. A binary catalogue row is keyed by the MARKET
  // (binary:<slug>) and each rescan re-picks whichever side is above 50c as its outcome and
  // tokenId, while firstMarketProbability stays sticky from the first sighting. A market that
  // crosses 50c therefore holds the old side's entry price against the new side's settlement,
  // and the new side is the one that goes on to win. 50c is where the crossing happens, which
  // is why the sample piles up there.
  const flipped = {
    ...row(0.5, true),
    firstOutcome: "Yes", firstTokenId: "token-yes",
    outcome: "No", tokenId: "token-no",
  };
  const honest = {
    ...row(0.5, true),
    firstOutcome: "Yes", firstTokenId: "token-yes",
    outcome: "Yes", tokenId: "token-yes",
  };
  const payload = combinations([flipped, honest], "min_trades=1");
  assert.equal(payload.scannedRows, 2);
  assert.equal(payload.pricedRows, 1, "only the row whose priced side is the settled side");
  assert.equal(payload.sideFlippedRejected, 1, "and the count is published, not silently dropped");
  assert.equal(find(payload.best, { tag: "*", shape: "*", horizon: "*", probability: 50 }).trades, 1);

  // Matching on the outcome name alone is enough when no token was recorded, because that is
  // the pair older archive rows carry.
  const byNameOnly = combinations([
    { ...row(0.5, true), firstOutcome: "Yes", outcome: "No" },
  ], "min_trades=1");
  assert.equal(byNameOnly.pricedRows, 0);
  assert.equal(byNameOnly.sideFlippedRejected, 1);

  // A row that cannot answer is still admitted: most of the archive predates the field, and
  // rejecting all of it would empty the page rather than correct it.
  const unknown = combinations([{ ...row(0.5, true), firstOutcome: null, firstTokenId: null, outcome: null, tokenId: null }], "min_trades=1");
  assert.equal(unknown.pricedRows, 1);
  assert.equal(unknown.sideFlippedRejected, 0);
});

test("recorded entry fees are included in the Setup finder P/L", () => {
  const payload = combinations([
    row(0.5, true, { feeRate: 0.02 }),
    row(0.5, false, { feeRate: 0.02 }),
  ]);
  const all = find(payload.best, { tag: "*", shape: "*", horizon: "*", probability: 50 });
  // $5 at 50c buys 10 shares; its $0.05 fee makes the win +$4.95 and the loss -$5.05.
  assert.equal(all.stakedUsdc, 10.1);
  assert.equal(all.pnlUsdc, -0.1);
});

test("a combination too small to mean anything is not offered", () => {
  // The page exists to change a live portfolio's settings. One lucky trade at 99% would
  // otherwise top the table on return for ever.
  const rows = [
    ...Array.from({ length: 40 }, () => row(0.7, true)),
    row(0.99, true, { tags: ["lucky"] }),
  ];
  const payload = combinations(rows, "min_trades=30");
  assert.equal(payload.minTrades, 30);
  assert.ok(!payload.best.some((entry) => entry.tag === "lucky"),
    "a single trade must not be rankable");
  assert.ok(payload.best.every((entry) => entry.trades >= 30));
  // And loosening it brings the same combination back, so the filter is the cap rather
  // than a missing row.
  assert.ok(combinations(rows, "min_trades=1").best.some((entry) => entry.tag === "lucky"));
});

test("both ends of the ranking are reported", () => {
  // "melo by to zohlednovat jak uspesne tak neuspesne obchody". The losing setups are the
  // actionable half: what to exclude is a decision this page has to support.
  const payload = combinations([
    ...Array.from({ length: 10 }, () => row(0.9, true, { tags: ["good"] })),
    ...Array.from({ length: 10 }, () => row(0.9, false, { tags: ["bad"] })),
  ]);
  const best = find(payload.best, { tag: "good", shape: "*", horizon: "*", probability: 90 });
  const worst = find(payload.worst, { tag: "bad", shape: "*", horizon: "*", probability: 90 });
  assert.ok(best.returnPct > 0, `the winning tag must rank best: ${JSON.stringify(best)}`);
  assert.equal(worst.returnPct, -100, "and ten total losses are a -100% return");
  assert.equal(worst.pnlUsdc, -50, "stated nominally too");
});

test("a row the simulation cannot price is counted as such, not as a loss", () => {
  // A row that never carried a live quote has no entry price, and one that settled between
  // 0 and 1 was voided rather than won or lost. Inventing either would be a number somebody
  // sets a live portfolio by.
  const noQuote = { ...row(0.8, true), firstMarketProbability: null, marketProbability: null, marketPrice: null };
  const voided = { ...row(0.8, true), finalOutcomePrice: 0.5 };
  // Wide AT ENTRY: nobody could have got a fill, so it is not a trade we would have made.
  const wideAtEntry = { ...row(0.8, true), firstSpread: 0.9 };
  // Tight at entry and wide NOW. This one used to be excluded and must not be: the current
  // book on a resolved row is the book after the result was effectively known, and judging
  // by it kept winners and dropped losers -- valorant read 100.0% over 36 trades where the
  // archive holds 65 wins and 21 losses over 86. The fixture was changed from `spread` to
  // `firstSpread` above for the same reason: it was asserting the bias.
  const wideOnlyAfterwards = { ...row(0.8, true), firstSpread: 0.01, spread: 0.9 };
  const payload = combinations([row(0.8, true), noQuote, voided, wideAtEntry, wideOnlyAfterwards]);
  assert.equal(payload.scannedRows, 5);
  assert.equal(payload.pricedRows, 2, "the priceable one, and the one only its outcome made look untradable");
  assert.equal(find(payload.best, { tag: "*", shape: "*", horizon: "*", probability: 80 }).trades, 2);
});

test("the Setup finder is a settings tab, and it loads when it is opened", () => {
  // Asked for: "udelej to jako novou zalozku resp. stranku v settings". It was reported
  // missing before it existed -- "nikde nemohu najit tu souhrnou statistiku. cekal jsem
  // novou zalozku v settings" -- so the tab, the panel and the wiring are all checked.
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const app = readFileSync(new URL("../assets/app.js", import.meta.url), "utf8");

  assert.match(html, /data-settings-section="setup-finder"/, "the tab must exist");
  assert.match(html, /data-settings-panel="setup-finder"/, "and its panel");
  assert.match(html, /data-setup-finder-min-trades/, "with the minimum-trades control");
  assert.match(html, /data-setup-finder-run/);

  // Loaded when the tab is opened rather than with the page: it streams the whole archive
  // server-side, which is not work every visit to settings should pay for.
  assert.match(app, /if \(state\.settingsSection === "setup-finder" && !state\.setupFinder\) loadSetupFinder\(\);/);
  assert.match(app, /action=resolved-combinations&min_trades=\$\{minTrades\}/);
  // Recomputed on the server when the cap changes, not refiltered in the browser: the cap
  // decides which combinations exist at all.
  assert.match(app, /els\.setupFinderRun\?\.addEventListener\("click", \(\) => \{\n\s+\/\/[^\n]*\n\s+\/\/[^\n]*\n\s+state\.setupFinder = null;\n\s+loadSetupFinder\(\);/);
});

// "resi cely range napr. 51-99. ale ja teprve hledam ten ziskovy range a to mi ta statistika
// dat neumi" -- and "mel by umet klasifikovat nejen podle Other / unclassified a any, ale i
// prave over-under, outright".
//
// A band that earns and a ceiling above which it stops earning: the case a threshold cannot
// express, built so the two readings disagree in sign rather than in size.
const BAND_FIXTURE = [
  ...Array.from({ length: 40 }, () => row(0.55, true)),
  ...Array.from({ length: 40 }, () => row(0.75, false)),
];

test("a threshold hides a profitable band; the band mode shows it", () => {
  const threshold = combinations(BAND_FIXTURE, "min_trades=1");
  const at55 = find(threshold.best, { tag: "*", shape: "*", horizon: "*", probability: 55 });
  assert.equal(at55.trades, 80, "a threshold at 55 drags in the 75s as well");
  assert.ok(at55.returnPct < 0, `and so it reads as a loser: ${JSON.stringify(at55)}`);
  assert.equal(at55.probabilityMax, 99, "a threshold still runs to the top");

  const band = combinations(BAND_FIXTURE, "min_trades=1&mode=band");
  assert.equal(band.mode, "band");
  // The widest band holding only the winners. 75 is where the losses start and 55 is where
  // the wins sit, but nothing is recorded between 50 and 54 either -- so 50-74 and 55-74 hold
  // exactly the same 40 trades, and the wider one is the honest label: a narrower band claims
  // a floor or a ceiling that nothing in the sample sits against.
  const winners = find(band.best, { tag: "*", shape: "*", horizon: "*", probabilityMin: 50, probabilityMax: 74 });
  assert.ok(winners, `the profitable band must be found: ${JSON.stringify(band.best.slice(0, 3))}`);
  assert.equal(winners.trades, 40);
  assert.equal(winners.wins, 40);
  // $5 at 0.55 buys 9.0909 shares, so each win returns $4.09 on a $5 stake.
  assert.equal(winners.stakedUsdc, 200);
  assert.equal(winners.pnlUsdc, 163.64);
  assert.ok(winners.returnPct > 80, `and the band earns where the threshold lost: ${winners.returnPct}%`);

  // The old field keeps its old meaning, so a client written against the threshold-only
  // response is not silently handed a band floor under a name that used to mean a threshold.
  assert.equal(winners.probability, winners.probabilityMin);
});

// Two groups differing in ALL THREE filterable dimensions, so pinning any one of them has
// something to exclude. A fixture carrying one tag cannot tell a working tag filter from a
// missing one -- it was built that way first, and removing the filter from api.php did not
// fail the test, which is the finding that produced this fixture.
const FILTER_FIXTURE = [
  ...Array.from({ length: 20 }, () => row(0.8, true, {
    question: "A vs B", tags: ["esports"],
    firstObservedAt: "2026-09-10T10:00:00.000Z", endDate: "2026-09-10T12:00:00.000Z",
  })),
  ...Array.from({ length: 20 }, () => row(0.8, false, {
    question: "Total goals 2.5 - A vs B", tags: ["soccer"],
    firstObservedAt: "2026-09-09T16:00:00.000Z", endDate: "2026-09-10T12:00:00.000Z",
  })),
];

test("a pinned dimension is never also published as 'any'", () => {
  // The filtered sample under a '*' label would be a wrong answer, not a redundant one: it
  // would claim to span every event type while holding only one.
  const everything = combinations(FILTER_FIXTURE, "min_trades=1");
  const shapes = new Set(everything.best.map((entry) => entry.shape));
  assert.ok(shapes.has("outright") && shapes.has("over-under"),
    `both shapes are classified, and were always in the data: ${[...shapes].join(", ")}`);

  const outright = combinations(FILTER_FIXTURE, "min_trades=1&shape=outright");
  assert.equal(outright.shape, "outright");
  assert.ok(outright.best.every((entry) => entry.shape === "outright"),
    "no row may be labelled 'any event type' when one was pinned");
  assert.ok(!outright.best.some((entry) => entry.tag === "soccer"),
    "and the over-under group must not survive the shape filter under any label");
  const only = find(outright.best, { tag: "*", horizon: "*", probability: 80 });
  assert.equal(only.trades, 20, "it holds the outright rows alone");
  assert.equal(only.wins, 20);

  const tagged = combinations(FILTER_FIXTURE, "min_trades=1&tag=esports");
  assert.ok(tagged.best.every((entry) => entry.tag === "esports"), "same for a pinned tag");
  assert.ok(!tagged.best.some((entry) => entry.shape === "over-under"),
    "the soccer group is over-under, so it must be gone with the tag it carries");
  assert.equal(find(tagged.best, { shape: "*", horizon: "*", probability: 80 }).trades, 20);

  const horizon = combinations(FILTER_FIXTURE, "min_trades=1&horizon=<= 3 h");
  assert.equal(horizon.horizon, "<= 3 h");
  assert.ok(horizon.best.every((entry) => entry.horizon === "<= 3 h"), "and for a pinned horizon");
  assert.ok(!horizon.best.some((entry) => entry.tag === "soccer"),
    "the twenty-hour group belongs to another band and must not be counted here");
  assert.equal(find(horizon.best, { tag: "*", shape: "*", probability: 80 }).trades, 20);
});

test("the fine grid is granted only once the search has been narrowed", () => {
  // A 1pp grid is 1,275 bands per group against 50 thresholds. The same host's PHP limit has
  // already been exhausted once by a single heavy read, so the fine grid waits until a tag or
  // an event type has collapsed the number of groups to walk.
  const wide = combinations(BAND_FIXTURE, "min_trades=1&mode=band&band_step=1");
  assert.equal(wide.bandStepRequested, 1);
  assert.equal(wide.bandStep, 5, "unnarrowed, the fine grid is refused rather than served");

  const narrowed = combinations(BAND_FIXTURE, "min_trades=1&mode=band&band_step=1&shape=outright");
  assert.equal(narrowed.bandStep, 1, "a pinned event type is enough to afford it");
  // And it can express a floor the coarse grid cannot: 56 is not on a 5-point grid.
  assert.ok(narrowed.best.some((entry) => entry.probabilityMin % 5 !== 0),
    "the point of the fine grid is bounds the coarse one cannot reach");
});

test("an unknown filter value is refused rather than quietly matching nothing", () => {
  // Silently returning an empty ranking reads as "this setup never happened", which is the
  // answer somebody would act on by excluding it.
  for (const query of ["min_trades=1&shape=nonsense", "min_trades=1&horizon=whenever", "min_trades=1&tag=NOT A TAG"]) {
    const payload = combinations(BAND_FIXTURE, query);
    assert.equal(payload.ok, false, `${query} must be rejected: ${JSON.stringify(payload).slice(0, 200)}`);
  }
});

test("the Setup finder's filters are wired to the endpoint, and a band renders as a range", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const app = readFileSync(new URL("../assets/app.js", import.meta.url), "utf8");

  for (const control of ["tag", "shape", "horizon", "band-step"]) {
    assert.match(html, new RegExp(`data-setup-finder-${control}\\b`), `the ${control} control must exist`);
  }
  assert.match(html, /data-setup-finder-mode-option="band"/, "and the range grouping");
  assert.match(html, /<option value="outright">Outright<\/option>[\s\S]{0,400}data-setup-finder-band-step|data-setup-finder-shape[\s\S]{0,600}<option value="outright">/,
    "the event types the classifier produces must be offerable");

  assert.match(app, /&tag=\$\{encodeURIComponent\(tag\)\}&shape=\$\{encodeURIComponent\(shape\)\}/);
  assert.match(app, /&horizon=\$\{encodeURIComponent\(horizon\)\}&mode=\$\{encodeURIComponent\(mode\)\}&band_step=\$\{bandStep\}/);

  // A row carrying a ceiling must never be printed as a threshold.
  assert.match(app, /setupFinderProbabilityCell/);
  assert.match(app, /if \(!Number\.isFinite\(high\) \|\| high >= 99\) return `&ge; \$\{low\.toFixed\(0\)\}%`;/);
});

test("the page states what it is measured on", () => {
  // A number somebody sets a live portfolio by has to say what it excluded. The archive
  // holds rows that never carried a live quote and rows that settled between 0 and 1, and
  // both are dropped -- silently dropping them would overstate the sample.
  const app = readFileSync(new URL("../assets/app.js", import.meta.url), "utf8");
  assert.match(app, /resolved markets of \$\{formatInteger\(data\.scannedRows\)\} stored could be/);
  assert.match(app, /never carried a live quote, settled between 0 and 1, or had no tradable spread/);
  assert.match(app, /Recorded entry taker fees are included/, "the basis has to be stated, not assumed");
});
