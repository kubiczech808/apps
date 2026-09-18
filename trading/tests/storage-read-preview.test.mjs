// Runs offline: api.php is executed as a real request, and storage.php's own preview
// functions are lifted into the stub so the flag logic under test is the deployed one. No
// database, no network, no secrets.
//
// Asked for: "dokonci prechod na mysql databazi."
//
// The switch that completes it is one meta row, and flipping it is not the hard part. The
// hard part is that the last attempt to serve reads from the database ran the host out of
// its 512 MB on the catalogue decode, and a switch that changes what every visitor sees is
// a bad instrument for finding that out. So one request at a time can be told to read from
// the database, with nothing about the stored switch changed.
//
// Two things make it a measurement rather than a second way to turn the migration on:
// it needs the trigger key, and it is refused on anything but a GET -- every WRITE that
// consults trading_storage_is_active() sits behind a POST.

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API_PATH = new URL("../api.php", import.meta.url).pathname;
const STORAGE = readFileSync(new URL("../storage.php", import.meta.url), "utf8");

// The two functions that decide this, taken from storage.php rather than restated. Only the
// meta lookup underneath them is stubbed, because that is the database.
function extractPhpFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start > 0, `${signature} must exist in storage.php`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, "the function must be complete");
  return source.slice(start, end + 2);
}

const PREVIEW_FUNCTIONS = [
  extractPhpFunction(STORAGE, "function trading_storage_preview_reads(bool $enable): void"),
  extractPhpFunction(STORAGE, "function trading_storage_is_active(): bool"),
].join("\n");

function request({ method = "GET", preview = null, key = null, storedActive = false }) {
  const directory = mkdtempSync(join(tmpdir(), "storage-preview-"));
  try {
    mkdirSync(join(directory, "data"), { recursive: true });
    copyFileSync(API_PATH, join(directory, "api.php"));
    writeFileSync(join(directory, "config.php"), "<?php return ['trigger_key' => 'k'];");

    // The published files hold the trades; the stored state does not. That difference is
    // what the refresh read refuses over, and it is the observable this test reads the
    // preview flag through -- a real behaviour of the real code path, not a probe field.
    writeFileSync(join(directory, "data", "paper-state.json"), JSON.stringify({
      schemaVersion: 7,
      paperPortfolios: {},
      stateSegments: { "portfolio:a": { file: "paper-state.portfolio-a.json" } },
    }));
    writeFileSync(join(directory, "data", "paper-state.portfolio-a.json"), JSON.stringify({
      paperPortfolio: { displayName: "A", trades: [{ tokenId: "1", openedAt: "2026-09-11T10:00:00.000Z" }] },
    }));

    writeFileSync(join(directory, "storage.php"), `<?php
      ${PREVIEW_FUNCTIONS}
      function trading_storage_meta_get(string $key) { return ${storedActive ? "'1'" : "'0'"}; }
      function trading_storage_document_get(string $key) {
        return $key === 'state:paper'
          ? ['schemaVersion' => 7, 'paperPortfolios' => ['a' => ['displayName' => 'A']]]
          : null;
      }
      function trading_storage_document_put(string $k, string $t, array $p): void {}
      function trading_storage_event_append(string $s, ?string $p, array $q, ?string $o = null): void {}
      function trading_storage_observations_fetch(string $l, int $a = 0, int $b = 0, bool $c = false): array { return []; }
    `);
    writeFileSync(join(directory, "prelude.php"), `<?php
      $_GET['action'] = 'state';
      $_GET['target'] = 'paper';
      $_GET['summary'] = 'refresh';
      ${preview === null ? "" : `$_GET['storage_preview'] = ${JSON.stringify(String(preview))};`}
      $_SERVER['REQUEST_METHOD'] = ${JSON.stringify(method)};
      ${key === null ? "" : `$_SERVER['HTTP_X_TRADING_TRIGGER_KEY'] = ${JSON.stringify(key)};`}
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

// "Served from the database" is observed through the refusal that only the database path
// produces; "served from the files" through the manifest only the file path carries.
const servedFromDatabase = (payload) => payload.reason === "storage-cannot-serve-refresh";
const servedFromFiles = (payload) => Boolean(payload.stateSegments?.["portfolio:a"]);

test("without the preview the stored switch alone decides, exactly as before", () => {
  assert.ok(servedFromFiles(request({})), "switch off, no preview: the files");
  assert.ok(servedFromDatabase(request({ storedActive: true })), "switch on: the database");
});

test("a GET with the key reads the database for that one request", () => {
  const payload = request({ preview: 1, key: "k" });
  assert.ok(servedFromDatabase(payload), `the preview must reach the read path: ${JSON.stringify(payload)}`);
  // And it changed nothing for the next request: the stub's stored switch is still off and
  // the very next call without the preview goes back to the files.
  assert.ok(servedFromFiles(request({})), "a preview must not be a second way to turn it on");
});

test("the key is required, and a missing one does not quietly fall back to the files", () => {
  // The dangerous failure is not the 403 -- it is answering 200 from the files while the
  // caller believes it is measuring the database, which would report a cutover as safe on
  // evidence from the path it is replacing.
  for (const key of [null, "wrong"]) {
    const payload = request({ preview: 1, key });
    assert.equal(payload.ok, false, `key ${key}: must refuse`);
    assert.match(String(payload.error), /storage administration key/i);
    assert.ok(!servedFromFiles(payload), "a refusal must not carry a state payload");
  }
});

test("a POST is never previewed, whoever is asking", () => {
  // Every WRITE that consults trading_storage_is_active() sits behind a POST, so honouring
  // the preview on one would let a measurement redirect a write into the database. It is
  // ignored rather than refused: a POST carrying the parameter is a caller mistake, not an
  // attack, and failing the write would be the worse outcome.
  const payload = request({ method: "POST", preview: 1, key: "k" });
  assert.ok(!servedFromDatabase(payload),
    `a POST must be served exactly as it was before this existed: ${JSON.stringify(payload).slice(0, 200)}`);
});

test("only the exact opt-in counts", () => {
  // Bait for a truthy check. "0", "false" and "" all read as on under a loose test, and the
  // first of those is what a UI sends for a switch that is off.
  for (const value of ["0", "false", "", "true", "yes"]) {
    assert.ok(!servedFromDatabase(request({ preview: value, key: "k" })),
      `storage_preview=${JSON.stringify(value)} must not enable the preview`);
  }
});

test("the flag cannot be set by anything but the guarded entry point", () => {
  const api = readFileSync(API_PATH, "utf8");
  const calls = api.match(/trading_storage_preview_reads\(/g) || [];
  assert.equal(calls.length, 1, "exactly one caller, or the guard is not the only way in");

  const start = api.indexOf("if (\n        ($_GET['storage_preview'] ?? '') === '1'");
  assert.ok(start > 0, "the guard must be at the request entry point");
  const guard = api.slice(start, start + 600);
  assert.match(guard, /\$_SERVER\['REQUEST_METHOD'\] === 'GET'/);
  assert.match(guard, /require_trading_trigger_key\(\);/);
  // The key is demanded BEFORE the flag is set, not after.
  assert.ok(guard.indexOf("require_trading_trigger_key();") < guard.indexOf("trading_storage_preview_reads(true);"));

  // And the deployed storage.php prefers the preview over the stored value rather than
  // AND-ing with it, or a preview would do nothing until the migration was already on.
  assert.match(STORAGE, /\$GLOBALS\['trading_storage_preview_reads'\] \?\? false\) === true\) \{\n\s+return true;/);
});
