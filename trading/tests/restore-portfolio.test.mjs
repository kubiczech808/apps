// Runs offline: no secrets, no network, no database. api.php is executed as a real request
// against a real segment file on disk, and the file is read back afterwards.
//
// The restore itself -- the one operation in this incident that WRITES. Everything else
// built today measures; this puts 6,368 trades back, and it is being added because a write
// that looked right is what lost them in the first place.
//
// So the assertions are about the file after the write, not about the response. A response
// saying "restored 3" while the segment on disk lost today's trades would be the same
// failure again, one layer up.

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API_PATH = new URL("../api.php", import.meta.url).pathname;
const STORAGE = readFileSync(new URL("../storage.php", import.meta.url), "utf8");
const TRIGGER_KEY = "test-trigger-key";
const PORTFOLIO = "underwaycopy";
const UNIT_SEPARATOR = "\x1f";

const REAL_TRADE_KEY = (() => {
  const start = STORAGE.indexOf("function trading_storage_trade_key(array $trade): string");
  assert.ok(start > 0, "trading_storage_trade_key must be findable in storage.php");
  const end = STORAGE.indexOf("\n}", start);
  return STORAGE.slice(start, end + 2);
})();

const tradeKey = ({ tokenId, roundTrip = 1, portfolioId = PORTFOLIO, account = "paper" }) =>
  createHash("sha256")
    .update([account, portfolioId, `token:${tokenId}`, String(Math.max(1, roundTrip))].join(UNIT_SEPARATOR))
    .digest("hex");

const trade = (tokenId, openedAt, extra = {}) => ({
  tokenId, openedAt, roundTrip: 1, status: "WON", shares: 5, realizedPnlUsdc: 0.4, ...extra,
});

// Runs one restore against a fresh copy of the world and hands back both the response and
// what is actually on disk afterwards.
function restore({
  publishedTrades,
  storedTrades,
  portfolio = PORTFOLIO,
  ask = portfolio,
  confirm = ask,
  withSegment = true,
  operation = "restore-portfolio",
}) {
  const directory = mkdtempSync(join(tmpdir(), "restore-portfolio-"));
  try {
    mkdirSync(join(directory, "data"), { recursive: true });
    copyFileSync(API_PATH, join(directory, "api.php"));
    writeFileSync(join(directory, "config.php"), `<?php return ['trigger_key' => '${TRIGGER_KEY}'];`);

    const segmentFile = `paper-state.portfolio-${portfolio}.json`;
    writeFileSync(join(directory, "data", "paper-state.json"), JSON.stringify({
      schemaVersion: 7,
      paperPortfolios: {},
      stateSegments: { [`portfolio:${portfolio}`]: { file: segmentFile } },
    }));
    if (withSegment) {
      writeFileSync(join(directory, "data", segmentFile), JSON.stringify({
        paperPortfolio: {
          displayName: "Underway copy",
          // Carried alongside the trades, and it has to survive the write: a restore that
          // brought back the history and dropped the run log would be a second loss.
          runLog: [{ at: "2026-09-12T08:54:00.000Z", note: "a pass that must still be here" }],
          portfolio: { equityUsdc: 91.11, freeCapitalUsdc: 67.72 },
          trades: publishedTrades,
        },
      }));
    }

    // The mirror: keys for the cheap comparison, payloads for the restore itself.
    const keyed = Object.fromEntries(storedTrades.map((row) => [
      tradeKey({ tokenId: row.tokenId, roundTrip: row.roundTrip ?? 1 }),
      row,
    ]));
    writeFileSync(join(directory, "storage.php"), `<?php
      ${REAL_TRADE_KEY}
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
      function stored_rows(): array {
        return json_decode(<<<'JSON'
${JSON.stringify(keyed)}
JSON, true);
      }
      function trading_storage_trade_keys_for(string $account, string $portfolio): array {
        $out = [];
        foreach (stored_rows() as $key => $row) {
          $out[$key] = ['status' => $row['status'] ?? '', 'openedAt' => $row['openedAt'] ?? null];
        }
        return $out;
      }
      function trading_storage_trade_payloads_for(string $account, string $portfolio, array $keys): array {
        $rows = stored_rows();
        $out = [];
        foreach ($keys as $key) {
          if (isset($rows[$key])) { $out[$key] = $rows[$key]; }
        }
        return $out;
      }
    `);

    writeFileSync(join(directory, "body.json"), JSON.stringify({
      operation, portfolio: ask, confirm, account: "paper",
    }));
    writeFileSync(join(directory, "prelude.php"), `<?php
      class TestInputStream {
        public $context;
        private $offset = 0;
        private $body = '';
        public function stream_open($path, $mode, $options, &$opened) {
          $this->body = (string) file_get_contents(__DIR__ . '/body.json');
          return true;
        }
        public function stream_read($count) {
          $chunk = substr($this->body, $this->offset, $count);
          $this->offset += strlen($chunk);
          return $chunk;
        }
        public function stream_eof() { return $this->offset >= strlen($this->body); }
        public function stream_stat() { return ['size' => strlen($this->body)]; }
        public function stream_seek($offset, $whence = SEEK_SET) { $this->offset = $offset; return true; }
        public function stream_tell() { return $this->offset; }
      }
      stream_wrapper_unregister('php');
      stream_wrapper_register('php', 'TestInputStream');
      $_GET['action'] = 'storage-admin';
      $_SERVER['REQUEST_METHOD'] = 'POST';
      $_SERVER['HTTP_X_TRADING_TRIGGER_KEY'] = '${TRIGGER_KEY}';
    `);
    const output = execFileSync("php", [
      "-d", `auto_prepend_file=${join(directory, "prelude.php")}`,
      join(directory, "api.php"),
    ], { encoding: "utf8" });

    let onDisk = null;
    try {
      onDisk = JSON.parse(readFileSync(join(directory, "data", segmentFile), "utf8"));
    } catch {
      onDisk = null;
    }
    return { payload: JSON.parse(output.slice(output.indexOf("{"))), onDisk };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// Today's trades, in the published state and in the mirror both -- the real situation.
const TODAY = [
  trade("111", "2026-09-12T08:54:06.000Z", { status: "PENDING_RESOLUTION" }),
  trade("222", "2026-09-12T10:00:19.000Z", { status: "OPEN" }),
];
const HISTORY = [
  trade("old-1", "2026-09-10T18:48:20.000Z"),
  trade("old-2", "2026-09-11T20:11:02.000Z", { status: "LOST", realizedPnlUsdc: -5 }),
  trade("old-3", "2026-09-12T06:30:00.000Z"),
];

test("the history comes back and today's trades are still there", () => {
  const { payload, onDisk } = restore({ publishedTrades: TODAY, storedTrades: [...TODAY, ...HISTORY] });
  assert.equal(payload.ok, true, `the restore must run: ${JSON.stringify(payload).slice(0, 400)}`);
  assert.equal(payload.restored, 3);
  assert.equal(payload.tradesBefore, 2);
  assert.equal(payload.tradesAfter, 5);

  // The file, not the response. A response is a claim; the file is the outcome.
  const written = onDisk.paperPortfolio.trades;
  assert.equal(written.length, 5, "every trade, old and new, has to be on disk");
  const tokens = written.map((row) => row.tokenId);
  assert.deepEqual([...tokens].sort(), ["111", "222", "old-1", "old-2", "old-3"]);

  // Oldest first, so a restored history reads like one that was never lost.
  const opened = written.map((row) => String(row.openedAt));
  assert.deepEqual(opened, [...opened].sort(), `the merged list must be in order: ${opened.join(", ")}`);

  // And nothing else in the segment may be collateral damage.
  assert.equal(onDisk.paperPortfolio.displayName, "Underway copy");
  assert.equal(onDisk.paperPortfolio.runLog.length, 1, "the run log must survive the write");
  assert.equal(onDisk.paperPortfolio.portfolio.equityUsdc, 91.11,
    "the published numbers are left alone: the bot recomputes them from the trades");
});

test("a published trade the database does not have stops the restore dead", () => {
  // The refusal that matters. If the mirror is missing something the state holds, this
  // operation must not touch the file at all -- not merge it, not reorder it, nothing.
  const { payload, onDisk } = restore({
    publishedTrades: [...TODAY, trade("999", "2026-09-12T10:30:00.000Z", { status: "OPEN" })],
    storedTrades: [...TODAY, ...HISTORY],
  });
  assert.equal(payload.ok, false, "it must refuse");
  assert.equal(payload.publishedButNotStored, 1);
  assert.match(String(payload.error), /Refusing to restore/);
  assert.equal(onDisk.paperPortfolio.trades.length, 3,
    "and the segment must be exactly as it was, untouched");
});

test("the portfolio id has to be typed back before anything is written", () => {
  // A boolean confirm is one keystroke from being set on the wrong portfolio, and this
  // writes over live data.
  const { payload, onDisk } = restore({
    publishedTrades: TODAY, storedTrades: [...TODAY, ...HISTORY], confirm: "yes",
  });
  assert.equal(payload.ok, false);
  assert.match(String(payload.error), /confirm must repeat the portfolio id/);
  assert.equal(onDisk.paperPortfolio.trades.length, 2, "nothing may be written without it");
});

test("a portfolio with no published segment is refused, not created", () => {
  // Writing a new segment for a portfolio the state does not publish would invent a
  // portfolio rather than restore one, and the manifest would not name the file anyway.
  const { payload } = restore({
    publishedTrades: TODAY, storedTrades: [...TODAY, ...HISTORY], withSegment: false,
  });
  assert.equal(payload.ok, false);
  assert.match(String(payload.error), /no published segment/);
});

test("running it twice changes nothing the second time", () => {
  // Restores get re-run: a timeout, a half-read response, a nervous operator. The second
  // run has to be a no-op rather than a list of duplicated trades.
  const merged = [...TODAY, ...HISTORY];
  const { payload, onDisk } = restore({ publishedTrades: merged, storedTrades: merged });
  assert.equal(payload.ok, true);
  assert.equal(payload.restored, 0, "there is nothing left to bring back");
  assert.equal(onDisk.paperPortfolio.trades.length, 5, "and no trade may be duplicated");
});

test("a re-entry into the same market is restored as its own trade", () => {
  // Portfolios re-enter markets. If the identity collapsed those into one, a restore would
  // quietly merge two trades into one and report a tidy number while doing it.
  const reentry = trade("old-1", "2026-09-12T07:00:00.000Z", { roundTrip: 2, status: "OPEN" });
  const { payload, onDisk } = restore({
    publishedTrades: TODAY,
    storedTrades: [...TODAY, ...HISTORY, reentry],
  });
  assert.equal(payload.ok, true);
  assert.equal(payload.restored, 4, "the second round trip is a fourth trade, not a duplicate");
  const olds = onDisk.paperPortfolio.trades.filter((row) => row.tokenId === "old-1");
  assert.equal(olds.length, 2);
  assert.deepEqual(olds.map((row) => row.roundTrip).sort(), [1, 2]);
});
