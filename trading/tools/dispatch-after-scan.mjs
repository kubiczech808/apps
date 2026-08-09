import { pathToFileURL } from "node:url";

const configUrl = "https://www.osobnizkusenosti.cz/trading/api.php?action=portfolio-config";

const apiHeaders = (token) => ({
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "X-GitHub-Api-Version": "2022-11-28",
});

async function readJson(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.text();
  let payload;
  try {
    payload = body ? JSON.parse(body) : {};
  } catch {
    payload = { raw: body.slice(0, 500) };
  }
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

// Which workflows a finished scrape should wake, given the saved portfolio config.
// Kept separate from the dispatching so the decision can be checked without a network.
export function plannedDispatches(config = {}) {
  const paper = config.paper || {};
  const live = config.live || {};
  // 5050 was missing here entirely, so however its execution trigger was set it was
  // never dispatched after a scrape -- its only trigger was its own half-hourly cron,
  // and it looked like the setting was being ignored. It was not being read.
  const fixedEntry = config.live5050 || {};

  const planned = [];
  if (Object.values(paper).some((portfolio) => portfolio?.executionTrigger === "after_scrape")) {
    planned.push({ workflow: "trading-paper-bot.yml", inputs: { mode: "after_scan" } });
  }
  if (live.executionTrigger === "after_scrape") {
    planned.push({
      workflow: "polymarket-live-limit-order-test.yml",
      inputs: {
        live_confirm: "true",
        live_execution_trigger: "after_scrape",
        live_run_source: "AUTO",
      },
    });
  }
  if (fixedEntry.executionTrigger === "after_scrape") {
    planned.push({
      workflow: "trading-live-5050.yml",
      inputs: {
        // live_confirm because a dispatch without it is a dry run and would rest nothing.
        live_confirm: "true",
        // live_run_source because a dispatch defaults to MANUAL, and manual means both
        // "a person asked" in the run log and "ignore the automation switch". This run
        // is the portfolio's schedule doing its job, so it must obey that switch.
        live_run_source: "AUTO",
      },
    });
  }
  return planned;
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  const ref = process.env.GITHUB_REF_NAME || "main";
  if (!repository || !token) {
    throw new Error("GITHUB_REPOSITORY and GITHUB_TOKEN are required to dispatch post-scrape execution.");
  }

  const configPayload = await readJson(configUrl, {
    headers: { "User-Agent": "trading-post-scrape-dispatch/1.0" },
  });
  const planned = plannedDispatches(configPayload.config || {});

  if (!planned.length) {
    console.log("No portfolio is configured for execution after scraping; no execution workflow dispatched.");
    return;
  }

  for (const { workflow, inputs } of planned) {
    const url = `https://api.github.com/repos/${repository}/actions/workflows/${workflow}/dispatches`;
    await readJson(url, {
      method: "POST",
      headers: { ...apiHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ ref, inputs }),
    });
    console.log(`Dispatched ${workflow} for ref ${ref}.`);
  }
}

// Importing this module must plan nothing and dispatch nothing; only the
// `node tools/dispatch-after-scan.mjs` invocation talks to GitHub.
const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (invokedDirectly) {
  await main();
}
