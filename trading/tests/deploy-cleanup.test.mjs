// Runs offline: stale_entries() is imported from the real tool file and EXECUTED. No network,
// no FTP.
//
// The bug, from trading-deploy.yml as it shipped:
//
//     for name in list_names(ftp):
//         if name == "data":
//             clean_data_dir(ftp)
//             continue
//     if name not in deploy_roots:        # <-- OUTSIDE the loop
//         remove_tree(ftp, name)
//
// Python leaves the loop variable bound to the last entry, so the removal ran exactly once
// against whichever name the server listed last. Every other stale directory was never
// cleaned, the one that was deleted was chosen by directory order, and an empty listing left
// the name unbound and killed the deploy with a NameError.
//
// Indenting the `if` is not the whole fix. It turns a loop that deleted at most one entry
// into one that deletes every entry not in deploy_roots, on the host that serves the live
// site, in the same file that took that site down on 2026-09-18. Measured before changing it:
// /www/trading lists .htaccess, api.php, assets, config.php, data, index.html, storage.php --
// every one of them a deploy root, so the corrected loop removes nothing today. That is what
// makes it safe to correct, and it is also exactly the state in which a wrong guard would go
// unnoticed until the day it matters.

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const TOOL = fileURLToPath(new URL("../tools/deploy-cleanup.py", import.meta.url));

function stale(names, deployRoots, keep = null) {
  const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("cleanup", ${JSON.stringify(TOOL)})
cleanup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cleanup)
args = json.loads(sys.stdin.read())
kwargs = {} if args["keep"] is None else {"keep": tuple(args["keep"])}
print(json.dumps(cleanup.stale_entries(args["names"], args["roots"], **kwargs)))
`;
  return JSON.parse(execFileSync("python3", ["-c", script], {
    input: JSON.stringify({ names, roots: deployRoots, keep }),
    encoding: "utf8",
  }));
}

// What the deploy actually uploads, so what deploy_roots actually holds.
const ROOTS = ["data", "index.html", "api.php", "storage.php", "config.php", ".htaccess", "assets"];
// What /www/trading actually listed on 2026-09-18, read before anything was changed.
const PUBLISHED = [".htaccess", "api.php", "assets", "config.php", "data", "index.html", "storage.php"];

test("today's published directory loses nothing", () => {
  // The measurement that made the correction safe to make at all. If this ever starts
  // removing something, the roots changed and the deploy is about to delete a live directory.
  const verdict = stale(PUBLISHED, ROOTS);
  assert.deepEqual(verdict.remove, [], `nothing published today is stale: ${verdict.remove}`);
  assert.equal(verdict.refuse, null);
});

test("a genuinely stale directory is removed, and every one of them, not just the last", () => {
  // The bug's actual effect: only the final listed entry was ever considered. Here the stale
  // ones sit in the middle and at the end.
  const verdict = stale([...PUBLISHED.slice(0, 3), "old-build", ...PUBLISHED.slice(3), "tmp"], ROOTS);
  assert.deepEqual(verdict.remove.sort(), ["old-build", "tmp"]);
});

test("BAIT: an empty listing removes nothing and says so", () => {
  // This is the NameError case. A listing that failed looks exactly like a directory that is
  // empty, and deleting on the strength of either is wrong.
  const verdict = stale([], ROOTS);
  assert.deepEqual(verdict.remove, []);
  assert.match(verdict.refuse, /listed no entries/);
});

test("BAIT: roots holding nothing but the kept names removes nothing", () => {
  // deploy_roots starts as {"data"} and grows per uploaded file. If the upload set were ever
  // empty, every published entry would read as stale and the whole site would be the
  // candidate list.
  const verdict = stale(PUBLISHED, ["data"]);
  assert.deepEqual(verdict.remove, []);
  assert.match(verdict.refuse, /no files were uploaded/);
});

test("BAIT: an implausibly large candidate list is refused, not obeyed", () => {
  const many = Array.from({ length: 12 }, (_, index) => `stray-${index}`);
  const verdict = stale([...PUBLISHED, ...many], ROOTS);
  assert.deepEqual(verdict.remove, []);
  assert.match(verdict.refuse, /more than the 8/);
  assert.equal(verdict.candidates.length, 12, "and it must still say what it saw");
});

test("BAIT: a name that could escape the directory is never passed to a delete", () => {
  // remove_tree() recurses. A name carrying a separator, or the directory's own links, is not
  // an entry to act on -- it is a way out of the directory the deploy is cleaning.
  const verdict = stale([...PUBLISHED, "..", ".", "../../www", "nested/dir", " spaced"], ROOTS);
  for (const dangerous of ["..", ".", "../../www", "nested/dir", " spaced"]) {
    assert.ok(!verdict.remove.includes(dangerous), `${dangerous} must never be removed`);
  }
  assert.deepEqual(verdict.remove, [], "and nothing else was stale here either");
  assert.ok(verdict.skipped.length >= 4, `the refused names must be reported: ${verdict.skipped}`);
});

test("the deploy applies the decision inside its loop", () => {
  // The fix is only a fix if the workflow uses it. The original `if` sat at the loop's
  // indentation, which is what made it run once.
  const workflow = readFileSync(
    new URL("../../.github/workflows/trading-deploy.yml", import.meta.url), "utf8");
  assert.match(workflow, /stale_entries\(/, "the deploy must ask this module what is stale");
  // And the dangling `if` is gone, in exactly the shape it had.
  assert.ok(!/\n              if name not in deploy_roots:/.test(workflow),
    "the removal must no longer sit outside the loop");
});
