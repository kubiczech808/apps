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
const row = (entry, won, { tags = ["esports"], question = "A vs B", firstObservedAt = "2026-09-10T00:00:00.000Z", endDate = "2026-09-10T12:00:00.000Z" } = {}) => ({
  tokenId: `${entry}-${won ? "w" : "l"}-${Math.random().toString(36).slice(2, 9)}`,
  question,
  status: "RESOLVED",
  firstMarketProbability: entry,
  finalOutcomePrice: won ? 1 : 0,
  spread: 0.02,
  firstPolymarketTags: tags,
  firstObservedAt,
  endDate,
});

function combinations(rows, query = "min_trades=1") {
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
      $_GET['action'] = 'resolved-combinations';
      ${query.split("&").map((pair) => {
        const [key, value] = pair.split("=");
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

test("the horizon band is measured from when the row was first seen", () => {
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
  // An hour AFTER the stated end date: the fixture was already under way, which is its own
  // band rather than being folded into the shortest one.
  assert.ok(bands.includes("under way"), `opened after the end date: ${bands.join(", ")}`);
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
  const wideSpread = { ...row(0.8, true), spread: 0.9 };
  const payload = combinations([row(0.8, true), noQuote, voided, wideSpread]);
  assert.equal(payload.scannedRows, 4);
  assert.equal(payload.pricedRows, 1, "only the one that can be priced");
  assert.equal(find(payload.best, { tag: "*", shape: "*", horizon: "*", probability: 80 }).trades, 1);
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

test("the page states what it is measured on", () => {
  // A number somebody sets a live portfolio by has to say what it excluded. The archive
  // holds rows that never carried a live quote and rows that settled between 0 and 1, and
  // both are dropped -- silently dropping them would overstate the sample.
  const app = readFileSync(new URL("../assets/app.js", import.meta.url), "utf8");
  assert.match(app, /resolved markets of \$\{formatInteger\(data\.scannedRows\)\} stored could be/);
  assert.match(app, /never carried a live quote, settled between 0 and 1, or had no tradable spread/);
  assert.match(app, /Gross of fees/, "the basis has to be stated, not assumed");
});
