// Runs offline: publish_staged() is imported from the real tool file and EXECUTED against an
// in-memory FTP directory. No network, no FTP.
//
// On 2026-09-30 one push started two Deploy Trading runs at once. Both staged api.php as
// .deploy-api.php. The first published it. The second's rename found no source, so its
// fallback deleted the api.php just published and its own second rename failed. The site
// served 404 until the next deploy.

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const TOOL = fileURLToPath(new URL("../tools/deploy-publish.py", import.meta.url));
const WORKFLOW = fileURLToPath(new URL("../../.github/workflows/trading-deploy.yml", import.meta.url));

// An FTP directory as a name -> content map. `overwrite: false` is a server that refuses RNTO
// onto an existing path, which is the case the fallback exists for. `size: false` is one
// without SIZE, and `listing: false` one whose listing comes back empty. Each deploy in
// `deploys` publishes its staged name in turn against the same directory.
function publish({ files, deploys, overwrite = false, size = true, listing = true }) {
  const script = `
import ftplib, importlib.util, json, sys
spec = importlib.util.spec_from_file_location("publish", ${JSON.stringify(TOOL)})
publish = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publish)
args = json.loads(sys.stdin.read())

class Directory:
    def __init__(self):
        self.files = dict(args["files"])
    def size(self, name):
        if not args["size"]:
            raise ftplib.error_perm("502 SIZE not implemented")
        if name not in self.files:
            raise ftplib.error_perm(f"550 {name}: No such file or directory")
        return len(self.files[name])
    def rename(self, source, target):
        if source not in self.files:
            raise ftplib.error_perm(f"550 {source}: No such file or directory")
        if target in self.files and not args["overwrite"]:
            raise ftplib.error_perm(f"553 {target}: File exists")
        self.files[target] = self.files.pop(source)
    def delete(self, name):
        if name not in self.files:
            raise ftplib.error_perm(f"550 {name}: No such file or directory")
        del self.files[name]

directory = Directory()
listing = (lambda ftp: sorted(ftp.files)) if args["listing"] else (lambda ftp: [])
results = []
for staged, name in args["deploys"]:
    try:
        results.append({"outcome": publish.publish_staged(directory, staged, name, listing)})
    except SystemExit as stopped:
        results.append({"refused": str(stopped)})
print(json.dumps({"results": results, "files": directory.files}))
`;
  return JSON.parse(execFileSync("python3", ["-c", script], {
    input: JSON.stringify({ files, deploys, overwrite, size, listing }),
    encoding: "utf8",
  }));
}

const API = [".deploy-api.php", "api.php"];

test("a server that renames over the live file: one rename, nothing deleted", () => {
  const run = publish({ files: { "api.php": "old", ".deploy-api.php": "new" }, deploys: [API], overwrite: true });
  assert.deepEqual(run.results, [{ outcome: "renamed" }]);
  assert.deepEqual(run.files, { "api.php": "new" });
});

test("a server that refuses to rename over it: delete, then rename", () => {
  const run = publish({ files: { "api.php": "old", ".deploy-api.php": "new" }, deploys: [API] });
  assert.deepEqual(run.results, [{ outcome: "replaced" }]);
  assert.deepEqual(run.files, { "api.php": "new" });
});

test("2026-09-30: two deploys sharing one staged name leave api.php in place", () => {
  // Both runs uploaded .deploy-api.php, so one staged file is there for two publishes.
  const run = publish({ files: { "api.php": "old", ".deploy-api.php": "new" }, deploys: [API, API] });
  assert.deepEqual(run.results[0], { outcome: "replaced" }, "the first run publishes");
  assert.match(run.results[1].refused ?? "", /staged copy \.deploy-api\.php is gone.*left untouched/,
    "the second fails loudly");
  assert.deepEqual(run.files, { "api.php": "new" }, "and the file the first one published is still served");
});

test("the same race on a server that does rename over: the second run still deletes nothing", () => {
  const run = publish({ files: { "api.php": "old", ".deploy-api.php": "new" }, deploys: [API, API], overwrite: true });
  assert.deepEqual(run.results[0], { outcome: "renamed" });
  assert.ok(run.results[1].refused);
  assert.deepEqual(run.files, { "api.php": "new" });
});

test("no SIZE on the server: the listing decides, both ways", () => {
  const present = publish({ files: { "api.php": "old", ".deploy-api.php": "new" }, deploys: [API], size: false });
  assert.deepEqual(present.results, [{ outcome: "replaced" }], "listed, so it is replaced");
  const gone = publish({ files: { "api.php": "live" }, deploys: [API], size: false });
  assert.ok(gone.results[0].refused, "not listed, so it is refused");
  assert.deepEqual(gone.files, { "api.php": "live" });
});

test("neither SIZE nor a listing can confirm the staged copy: refuse, live untouched", () => {
  const run = publish({ files: { "api.php": "live" }, deploys: [API], size: false, listing: false });
  assert.ok(run.results[0].refused);
  assert.deepEqual(run.files, { "api.php": "live" });
});

test("SIZE says it is there but the listing hides dotfiles: still replaced", () => {
  const run = publish({ files: { "api.php": "old", ".deploy-api.php": "new" }, deploys: [API], listing: false });
  assert.deepEqual(run.results, [{ outcome: "replaced" }]);
  assert.deepEqual(run.files, { "api.php": "new" });
});

test("the deploy workflow queues its runs and publishes through the tested function", () => {
  const source = readFileSync(WORKFLOW, "utf8");
  const block = source.match(/^concurrency:\n {2}group: (.+)\n {2}cancel-in-progress: (.+)$/m);
  assert.ok(block, "a top-level concurrency group");
  // Every branch deploys into the same /www/trading, so a group keyed on the ref or the run
  // would let two of them race exactly as before.
  assert.doesNotMatch(block[1], /\$\{\{/, `one fixed group for every run: ${block[1]}`);
  assert.equal(block[2].trim(), "false", "a queued deploy waits; cancelling one mid-upload is its own hazard");
  assert.match(source, /spec_from_file_location\(\s*"deploy_publish", pathlib\.Path\("trading\/tools\/deploy-publish\.py"\)\)/);
  assert.match(source, /publish_staged\(ftp, staged, path\.name, list_names\)/);
  assert.doesNotMatch(source, /ftp\.delete\(path\.name\)/, "no inline delete of the live file is left beside it");
});
