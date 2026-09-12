// Runs offline: no secrets, no network, no database. api.php is executed as a real request
// against a stubbed storage.php.
//
// THE ROOT CAUSE, demonstrated rather than argued.
//
// The paper bot rebuilds its whole state from one read: summary=refresh. Served from the
// published files, that read answers with the core plus a manifest naming one segment per
// portfolio, and the bot fetches those itself. Served from the DATABASE, it answers with
// `state:paper` -- which holds the portfolios and their parameters but NOT their trades,
// because each portfolio's trades are a document of their own and only the one named by
// strategy_id is merged in. The refresh read names none.
//
// So the database answered with thirty-six portfolios, no trades, and no manifest: a state
// that is whole in shape and empty of history. The bot accepted it, traded against free=100
// on every portfolio, and published it back over the files. That is the whole incident.
//
// The first test shows what the database path used to hand back. The second shows that it
// now refuses instead.

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API_PATH = new URL("../api.php", import.meta.url).pathname;

// What `state:paper` actually holds: portfolios, parameters, and no trades anywhere.
const STORED_STATE = {
  schemaVersion: 7,
  generatedAt: "2026-09-12T08:50:00.000Z",
  paperPortfolios: {
    underwaycopy: { displayName: "Underway copy", portfolio: { equityUsdc: 91.11 } },
    newportfolio: { displayName: "0809 55+ underway + SL", portfolio: { equityUsdc: 102.3 } },
  },
};

function stateRequest({ storageActive, summary = "refresh", target = "paper" }) {
  const directory = mkdtempSync(join(tmpdir(), "refresh-source-"));
  try {
    mkdirSync(join(directory, "data"), { recursive: true });
    copyFileSync(API_PATH, join(directory, "api.php"));
    writeFileSync(join(directory, "config.php"), "<?php return ['trigger_key' => 'k'];");

    // The published files, holding what the database does not: the trades.
    writeFileSync(join(directory, "data", "paper-state.json"), JSON.stringify({
      schemaVersion: 7,
      paperPortfolios: {},
      stateSegments: { "portfolio:underwaycopy": { file: "paper-state.portfolio-underwaycopy.json" } },
    }));
    writeFileSync(join(directory, "data", "paper-state.portfolio-underwaycopy.json"), JSON.stringify({
      paperPortfolio: { displayName: "Underway copy", trades: [{ tokenId: "1", openedAt: "2026-09-11T10:00:00.000Z" }] },
    }));

    writeFileSync(join(directory, "storage.php"), `<?php
      function trading_storage_is_active(): bool { return ${storageActive ? "true" : "false"}; }
      function trading_storage_document_get(string $key) {
        return $key === 'state:paper'
          ? json_decode(file_get_contents(__DIR__ . '/stored.json'), true)
          : null;
      }
      function trading_storage_document_put(string $k, string $t, array $p): void {}
      function trading_storage_event_append(string $s, ?string $p, array $q, ?string $o = null): void {}
      function trading_storage_observations_fetch(string $l, int $a = 0, int $b = 0, bool $c = false): array { return []; }
    `);
    writeFileSync(join(directory, "stored.json"), JSON.stringify(STORED_STATE));
    writeFileSync(join(directory, "prelude.php"), `<?php
      $_GET['action'] = 'state';
      $_GET['target'] = '${target}';
      $_GET['summary'] = '${summary}';
      $_SERVER['REQUEST_METHOD'] = 'GET';
    `);
    const output = execFileSync("php", [
      "-d", `auto_prepend_file=${join(directory, "prelude.php")}`,
      join(directory, "api.php"),
    ], { encoding: "utf8" });
    return JSON.parse(output.slice(output.indexOf("{")));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("the refresh read from the files carries the trades and the manifest", () => {
  // The healthy path, so the contrast below is a measurement rather than a claim.
  const payload = stateRequest({ storageActive: false });
  assert.ok(payload.stateSegments, "the manifest is what tells the bot there is more to fetch");
  assert.ok(payload.stateSegments["portfolio:underwaycopy"],
    `each portfolio's segment must be named: ${JSON.stringify(payload.stateSegments)}`);
});

test("the database must not serve the read the bot rebuilds its state from", () => {
  // The read that emptied everything. The stored document has the portfolios and none of
  // the trades, and nothing in the response says so -- which is precisely why it has to be
  // refused rather than served and explained.
  const payload = stateRequest({ storageActive: true });
  assert.equal(payload.ok, false, "it must refuse rather than answer with a trade-less state");
  assert.equal(payload.reason, "storage-cannot-serve-refresh");

  // And the refusal must not be mistakable for the state itself.
  assert.equal(payload.paperPortfolios, undefined,
    "a refusal that still carries paperPortfolios would pass the bot's own shape check");
});

test("the shape the database used to answer with is the shape that wipes", () => {
  // Kept as a standing description of the hazard, driven through the real dispatch: with
  // the guard keyed to `refresh`, any OTHER summary served from the database still answers
  // with portfolios and no trades. That is fine for a view that renders a table and fatal
  // for a reader that publishes what it read, so if another writer is ever pointed at one
  // of these, this test is where the reason is written down.
  const payload = stateRequest({ storageActive: true, summary: "dashboard" });
  assert.ok(payload.paperPortfolios, "the dashboard summary still answers from the database");
  const trades = Object.values(payload.paperPortfolios)
    .reduce((sum, row) => sum + (Array.isArray(row?.trades) ? row.trades.length : 0), 0);
  assert.equal(trades, 0,
    "and it answers with no trades in it -- portfolios whole, history absent");
  assert.equal(payload.stateSegments, undefined,
    "with no manifest either, so nothing downstream can tell there is more to fetch");
});
