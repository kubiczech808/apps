// Not a test file (the runner's glob is *.test.mjs): the harness that runs api.php's
// live-revalidation-merge endpoint as a real POST against real segment files on disk.
//
// It is shared because two tests need it from opposite ends. tests/live-revalidation-merge
// drives it with fabricated verdicts to pin the merge rules; tests/live-rotation drives it
// with the verdict the live executor actually produced, so the flag one side emits and the
// flag the other side reads cannot drift apart while both files keep passing.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API_PATH = new URL("../api.php", import.meta.url).pathname;
export const TRIGGER_KEY = "test-trigger-key";
const EVALUATIONS = "paper-state.evaluations.json";
const OBSERVATIONS = "paper-state.observations.json";

// A catalogue row as the scan writes it: the economics the shortlist reads, and no verdict
// yet. Both segments hold rows of this shape, which is why a token in both has to be
// updated in both.
export const row = (tokenId, extra = {}) => ({
  tokenId,
  question: `Market ${tokenId}`,
  status: "SCRAPED",
  selectionStatus: "READY",
  marketPrice: 0.62,
  marketProbability: 0.62,
  annualizedReturn: 1.9,
  expectedValueUsdc: 0.44,
  liquidity: 4200,
  updatedAt: "2026-09-17T06:00:00.000Z",
  ...extra,
});

// Runs one merge against a fresh copy of the world and hands back the response, both
// segments as they are on disk afterwards, and the raw bytes so an untouched file can be
// told from one that was rewritten identically.
export function merge({
  updates,
  evaluations = [row("aaa"), row("bbb")],
  observations = [row("aaa"), row("ccc")],
  key = TRIGGER_KEY,
  method = "POST",
  segmented = true,
  source = null,
}) {
  const directory = mkdtempSync(join(tmpdir(), "revalidation-merge-"));
  try {
    mkdirSync(join(directory, "data"), { recursive: true });
    if (source === null) {
      copyFileSync(API_PATH, join(directory, "api.php"));
    } else {
      writeFileSync(join(directory, "api.php"), source);
    }
    writeFileSync(join(directory, "config.php"), `<?php return ['trigger_key' => '${TRIGGER_KEY}'];`);
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

    const core = {
      schemaVersion: 7,
      paperPortfolios: {},
      ...(segmented
        ? {
          stateSegments: {
            evaluations: { file: EVALUATIONS },
            observations: { file: OBSERVATIONS },
          },
          evaluations: [],
          marketObservations: [],
        }
        // A state written before segmentation carries the rows in the core itself. Production
        // is segmented, but the Python followed the manifest and fell back to the core, and a
        // merge that silently does nothing on an unsegmented state is the exact failure this
        // whole script was written to fix the first time.
        : { evaluations, marketObservations: observations }),
    };
    writeFileSync(join(directory, "data", "paper-state.json"), JSON.stringify(core));
    if (segmented) {
      writeFileSync(join(directory, "data", EVALUATIONS), JSON.stringify({ evaluations }));
      writeFileSync(join(directory, "data", OBSERVATIONS), JSON.stringify({ marketObservations: observations }));
    }

    writeFileSync(join(directory, "body.json"), JSON.stringify({ updates }));
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
      $_GET['action'] = 'live-revalidation-merge';
      $_SERVER['REQUEST_METHOD'] = '${method}';
      ${key === null ? "" : `$_SERVER['HTTP_X_TRADING_TRIGGER_KEY'] = '${key}';`}
    `);

    const output = execFileSync("php", [
      "-d", `auto_prepend_file=${join(directory, "prelude.php")}`,
      join(directory, "api.php"),
    ], { encoding: "utf8" });

    const readRaw = (name) => {
      try {
        return readFileSync(join(directory, "data", name), "utf8");
      } catch {
        return null;
      }
    };
    const evaluationsRaw = readRaw(segmented ? EVALUATIONS : "paper-state.json");
    const observationsRaw = readRaw(segmented ? OBSERVATIONS : "paper-state.json");
    return {
      payload: JSON.parse(output.slice(output.indexOf("{"))),
      evaluations: JSON.parse(evaluationsRaw).evaluations,
      observations: JSON.parse(observationsRaw).marketObservations,
      raw: { evaluations: evaluationsRaw, observations: observationsRaw },
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

