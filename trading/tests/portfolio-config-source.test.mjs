// Runs offline: no secrets, no network, no database.
//
// Reported, and it was right: after reads were switched to the database, portfolios were
// missing from the dashboard -- "my paper portfolios are now wiped". Nothing had been
// deleted. load_portfolio_config() read a STORED copy of the config while the database was
// serving, and nothing ever updated that copy: the mirror sends state, portfolios, events,
// trades and observations, and the portfolio config was written once by the one-off import
// and then frozen. Every portfolio created or renamed after that import was simply absent.
//
// A portfolio that cannot be seen cannot be traded, edited or compared, so this is the one
// document where being out of date is not a slower page -- it is missing work.

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API = readFileSync(new URL("../api.php", import.meta.url), "utf8");

// api.php, loaded up to its request dispatch, with a storage.php that reports the switch as
// ON and hands back a deliberately STALE stored config -- the exact situation that hid the
// portfolios.
function runWithStaleStoredConfig({ fileConfig, storedConfig, storageActive = true }) {
  const directory = mkdtempSync(join(tmpdir(), "config-source-"));
  try {
    const cut = API.indexOf("\ntry {");
    assert.ok(cut > 0, "api.php still ends with its request dispatch");
    mkdirSync(join(directory, "data"), { recursive: true });
    if (fileConfig) {
      writeFileSync(join(directory, "data", "portfolio-config.json"), JSON.stringify(fileConfig));
    }
    writeFileSync(join(directory, "storage.php"), `<?php
      function trading_storage_is_active(): bool { return ${storageActive ? "true" : "false"}; }
      function trading_storage_document_get(string $key) {
        return $key === 'portfolio-config'
          ? json_decode(file_get_contents(__DIR__ . '/stored.json'), true)
          : null;
      }
      $GLOBALS['documentPuts'] = [];
      function trading_storage_document_put(string $key, string $type, array $payload): void {
        $GLOBALS['documentPuts'][] = $key;
      }
      function trading_storage_event_append(string $s, ?string $p, array $q, ?string $o = null): void {}
    `);
    writeFileSync(join(directory, "stored.json"), JSON.stringify(storedConfig || {}));
    writeFileSync(join(directory, "definitions.php"), API.slice(0, cut) + "\n");
    const output = execFileSync("php", ["-r",
      `require '${join(directory, "definitions.php")}';`
      + " $config = load_portfolio_config();"
      + " echo json_encode(['paper' => array_keys($config['paper'] ?? []),"
      + " 'live' => array_keys($config['livePortfolios'] ?? [])]);",
    ], { encoding: "utf8" });
    return JSON.parse(output);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const FILE_CONFIG = {
  paper: { conservative: { displayName: "93+ Conservative" }, newportfolio: { displayName: "0809 55+ underway + SL" } },
  livePortfolios: { underwaysllive: { displayName: "0809 55+ underway + SL live" } },
};

// What the import wrote and then never updated: the portfolios that existed that day.
const STALE_STORED_CONFIG = {
  paper: { conservative: { displayName: "93+ Conservative" } },
  livePortfolios: {},
};

test("the portfolio list comes from the file, even while the database is serving", () => {
  const active = runWithStaleStoredConfig({
    fileConfig: FILE_CONFIG,
    storedConfig: STALE_STORED_CONFIG,
    storageActive: true,
  });
  assert.ok(active.paper.includes("newportfolio"),
    `a portfolio in the file must be listed with the database active: ${JSON.stringify(active)}`);
  assert.ok(active.live.includes("underwaysllive"),
    `and so must a live one -- this is the portfolio that "did not exist": ${JSON.stringify(active)}`);

  // And with the switch off, unchanged.
  const inactive = runWithStaleStoredConfig({
    fileConfig: FILE_CONFIG,
    storedConfig: STALE_STORED_CONFIG,
    storageActive: false,
  });
  assert.deepEqual(inactive.paper.sort(), active.paper.sort(), "the switch must not change the list at all");
  assert.deepEqual(inactive.live.sort(), active.live.sort());
});

test("the stored copy is still the fallback when there is no file", () => {
  // It is not useless -- it is just not the first reader. With the file gone it is the best
  // record of the configuration there is.
  const noFile = runWithStaleStoredConfig({
    fileConfig: null,
    storedConfig: FILE_CONFIG,
    storageActive: true,
  });
  assert.ok(noFile.paper.includes("newportfolio"), `the stored copy must be read when no file exists: ${JSON.stringify(noFile)}`);
});

test("saving writes the file, and the stored copy beside it rather than instead of it", () => {
  const save = API.slice(API.indexOf("function save_portfolio_config"), API.indexOf("function live_state_path"));
  assert.ok(save.length > 0, "save_portfolio_config must be findable");

  // The file write must not be behind a storage branch any more: writing only the database
  // while it served meant a portfolio saved in that window lived in one place and one saved
  // outside it lived in the other, with nothing reconciling them.
  assert.doesNotMatch(save, /if \(trading_storage_is_active\(\)\) \{\s*\n\s*\$before = load_portfolio_config\(\);/,
    "saving must not take a database-only path");
  assert.match(save, /file_put_contents\(\$path, \$encoded \. "\\n", LOCK_EX\)/, "the file is always written");
  assert.match(save, /trading_storage_document_put\('portfolio-config', 'portfolio-config', \$normalized\)/,
    "and the stored copy is written too");
  // A failed mirror write must not fail the save: the file is already on disk by then.
  assert.match(save, /try \{\s*\n\s*trading_storage_document_put\('portfolio-config'[\s\S]*?\n\s*\} catch \(Throwable\) \{/,
    "a mirror failure must not turn a saved portfolio into a lost one");
  assert.ok(save.indexOf("file_put_contents($path") < save.indexOf("trading_storage_document_put('portfolio-config'"),
    "the file is written first, so the mirror can only ever be the second copy");
});
