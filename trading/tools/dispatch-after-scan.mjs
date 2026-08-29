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
  // The after-scan worker applies each cron portfolio's own cadence before it
  // executes. Waking it here is therefore a reliable delivery mechanism for a
  // due hourly portfolio, not an instruction to trade on every scrape.
  //
  // GitHub's schedule delivery is opportunistic: a portfolio set to `cron`
  // could otherwise wait several hours despite the market scanner completing
  // every few minutes. Archived and disabled portfolios are deliberately not
  // a reason to dispatch work.
  const hasPaperExecution = Object.values(paper).some((portfolio) =>
    portfolio?.archived !== true
    && portfolio?.automationEnabled !== false
    && ["after_scrape", "cron"].includes(String(portfolio?.executionTrigger || "cron").trim().toLowerCase()),
  );
  if (hasPaperExecution) {
    planned.push({ workflow: "trading-paper-bot.yml", inputs: { mode: "after_scan" } });
  }
  // The live portfolios are woken on either trigger, for the same reason the paper ones
  // above are, and this is why they were not running at all.
  //
  // Both were dispatched only on `after_scrape`, so a live portfolio set to `cron` had
  // nothing but its own schedule -- and GitHub is dropping this repository's schedules
  // almost entirely. Measured: the live executor is configured for six runs an hour and
  // delivered three in a day, while every dispatch in the same window succeeded. A
  // portfolio set to "run on a schedule" was therefore running roughly never.
  //
  // Waking it is not the same as trading. The executor applies its own saved cadence and
  // logs CADENCE_WAIT when a review is not due, exactly as the paper worker does, so this
  // is a delivery mechanism for a due portfolio rather than an instruction to trade on
  // every scrape. It also honours the automation switch, because the dispatch says AUTO.
  // A portfolio the config says nothing about is not a portfolio: an empty entry must not
  // default into "cron" and have a live run dispatched for it.
  const wakeable = (portfolio) => Boolean(portfolio)
    && Object.keys(portfolio).length > 0
    && portfolio.archived !== true
    && portfolio.automationEnabled !== false
    && ["after_scrape", "cron"].includes(String(portfolio.executionTrigger || "cron").trim().toLowerCase());
  const liveTrigger = String(live.executionTrigger || "cron").trim().toLowerCase();
  if (wakeable(live)) {
    planned.push({
      workflow: "polymarket-live-limit-order-test.yml",
      inputs: {
        live_confirm: "true",
        live_execution_trigger: liveTrigger,
        live_run_source: "AUTO",
      },
    });
  }
  if (wakeable(fixedEntry)) {
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
  // Created live portfolios are dispatched the same way, through the same workflow, each
  // naming itself so the run writes its own state rather than the shared account's.
  for (const [id, portfolio] of Object.entries(config.livePortfolios || {})) {
    const trigger = String(portfolio?.executionTrigger || "cron").trim().toLowerCase();
    if (!wakeable(portfolio)) continue;
    planned.push({
      workflow: "polymarket-live-limit-order-test.yml",
      inputs: {
        live_confirm: "true",
        live_execution_trigger: trigger,
        live_run_source: "AUTO",
        live_portfolio_id: id,
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

  const failures = [];
  for (const { workflow, inputs } of planned) {
    const url = `https://api.github.com/repos/${repository}/actions/workflows/${workflow}/dispatches`;
    try {
      await readJson(url, {
        method: "POST",
        headers: { ...apiHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify({ ref, inputs }),
      });
      console.log(`Dispatched ${workflow} for ref ${ref}.`);
    } catch (error) {
      const message = error?.message || String(error);
      failures.push(`${workflow}: ${message}`);
      console.warn(`Post-scrape dispatch skipped ${workflow}: ${message}`);
    }
  }

  if (failures.length) {
    console.warn(`Post-scrape dispatch finished with ${failures.length} warning(s); market scan data remains published.`);
  }

  await ensurePacerIsRunning({ repository, token, ref });
}

// Whether the clock still has a link in flight. A pacer spends nearly its whole life
// asleep inside a run, so "is one in progress or queued" is the whole question.
export function pacerIsAlive(runs = []) {
  return (Array.isArray(runs) ? runs : [])
    .some((run) => ["queued", "in_progress", "waiting", "requested", "pending"].includes(String(run?.status || "")));
}

// The clock is a chain of runs, each dispatching the next, so it is exactly one cancelled
// run or one failed dispatch away from stopping -- and a stopped clock is silent. The
// pacer declares a schedule for that case, but this repository delivers roughly one
// scheduled run in fifty, so recovery could take until morning. That is the reported
// symptom: a three-hour gap overnight with nothing scraped.
//
// So every scan checks the clock and restarts it if it has stopped. A scan gets here
// however it was started -- by the chain, by the hourly heartbeat, or by a person -- which
// makes any run at all a recovery point, instead of recovery depending on the one trigger
// known not to arrive. Restarting a chain that is in fact alive is harmless: the pacer's
// concurrency group cancels in progress, so a duplicate collapses back to a single chain.
async function ensurePacerIsRunning({ repository, token, ref }) {
  const workflow = "trading-pacer.yml";
  try {
    const payload = await readJson(
      `https://api.github.com/repos/${repository}/actions/workflows/${workflow}/runs?per_page=20`,
      { headers: apiHeaders(token) },
    );
    if (pacerIsAlive(payload.workflow_runs)) {
      console.log("The pacer is running; the scan cadence is being kept.");
      return;
    }
    await readJson(`https://api.github.com/repos/${repository}/actions/workflows/${workflow}/dispatches`, {
      method: "POST",
      headers: { ...apiHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ ref, inputs: { interval_minutes: "10", tick: "0" } }),
    });
    console.log("The pacer had stopped; restarted it. The scan cadence resumes from here.");
  } catch (error) {
    // Never fatal. The scan has already published by this point, and losing the watchdog
    // costs the next scan's chance to notice rather than costing this scan.
    console.warn(`Could not check or restart the pacer: ${error?.message || error}`);
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
