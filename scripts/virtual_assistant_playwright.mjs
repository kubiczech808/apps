#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

async function loadPlaywright() {
  const candidates = [
    "playwright",
    "playwright-core",
    "/home/openclaw2/.openclaw/virtual-assistant-node/node_modules/playwright/index.js",
    "/home/openclaw2/.openclaw/virtual-assistant-node/node_modules/playwright-core/index.js",
  ];
  const errors = [];
  for (const candidate of candidates) {
    try {
      const mod = await import(candidate);
      const api = mod.chromium ? mod : mod.default;
      if (api?.chromium) {
        return api;
      }
      errors.push(`${candidate}: imported module has no chromium export`);
    } catch (error) {
      errors.push(`${candidate}: ${error.message}`);
    }
  }
  throw new Error(`Playwright module is not available: ${errors.join(" | ")}`);
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function chromiumExecutable() {
  if (process.env.VIRTUAL_ASSISTANT_CHROMIUM_PATH && await pathExists(process.env.VIRTUAL_ASSISTANT_CHROMIUM_PATH)) {
    return process.env.VIRTUAL_ASSISTANT_CHROMIUM_PATH;
  }
  const candidates = [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  return "";
}

function requireString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function isSubmitLike(selector, text = "") {
  const low = `${selector} ${text}`.toLowerCase();
  return (
    low.includes("[type=submit]") ||
    low.includes('[type="submit"]') ||
    low.includes("submit") ||
    low.includes("odeslat") ||
    low.includes("publik") ||
    low.includes("post comment") ||
    low.includes("send")
  );
}

async function elementSummary(page) {
  return await page.evaluate(() => {
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style && style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };
    const fields = [...document.querySelectorAll("input, textarea, select, button")]
      .filter(visible)
      .slice(0, 80)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute("type") || "",
        name: el.getAttribute("name") || "",
        id: el.id || "",
        placeholder: el.getAttribute("placeholder") || "",
        ariaLabel: el.getAttribute("aria-label") || "",
        text: (el.innerText || el.value || "").trim().slice(0, 120),
      }));
    const forms = [...document.querySelectorAll("form")]
      .slice(0, 20)
      .map((form) => ({
        action: form.getAttribute("action") || "",
        method: form.getAttribute("method") || "get",
        id: form.id || "",
        fields: [...form.querySelectorAll("input, textarea, select, button")]
          .slice(0, 40)
          .map((el) => ({
            tag: el.tagName.toLowerCase(),
            type: el.getAttribute("type") || "",
            name: el.getAttribute("name") || "",
            id: el.id || "",
            placeholder: el.getAttribute("placeholder") || "",
            text: (el.innerText || el.value || "").trim().slice(0, 80),
          })),
      }));
    return {
      title: document.title,
      url: location.href,
      forms,
      fields,
    };
  });
}

async function run() {
  const taskPath = process.argv[2];
  if (!taskPath) {
    throw new Error("Usage: virtual_assistant_playwright.mjs task.json");
  }
  const task = JSON.parse(await fs.readFile(taskPath, "utf8"));
  const url = requireString(task.url, "url");
  const actions = Array.isArray(task.actions) ? task.actions : [];
  const allowSubmit = task.allowSubmit !== false;
  const screenshotPath = task.screenshotPath ? String(task.screenshotPath) : "";
  const timeoutMs = Number.isFinite(Number(task.timeoutMs)) ? Number(task.timeoutMs) : 45000;
  const { chromium } = await loadPlaywright();
  const executablePath = await chromiumExecutable();
  const launchOptions = {
    headless: task.headless !== false,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  };
  if (executablePath) {
    launchOptions.executablePath = executablePath;
  }
  const browser = await chromium.launch(launchOptions);
  const page = await browser.newPage({
    viewport: { width: Number(task.width || 1280), height: Number(task.height || 900) },
  });
  const result = {
    ok: false,
    url,
    finalUrl: "",
    title: "",
    actions: [],
    summary: null,
    screenshotPath: "",
  };
  try {
    await page.goto(url, { waitUntil: task.waitUntil || "domcontentloaded", timeout: timeoutMs });
    for (const action of actions) {
      const type = String(action.type || "").toLowerCase();
      const selector = requireString(action.selector, "action.selector");
      const note = { type, selector, ok: false };
      if (type === "fill") {
        await page.locator(selector).first().fill(String(action.value ?? ""), { timeout: timeoutMs });
        note.ok = true;
      } else if (type === "check") {
        await page.locator(selector).first().check({ timeout: timeoutMs });
        note.ok = true;
      } else if (type === "select") {
        await page.locator(selector).first().selectOption(String(action.value ?? ""), { timeout: timeoutMs });
        note.ok = true;
      } else if (type === "click") {
        const text = await page.locator(selector).first().innerText({ timeout: 3000 }).catch(() => "");
        if (!allowSubmit && isSubmitLike(selector, text)) {
          note.blocked = "submit-like click blocked because allowSubmit=false";
        } else {
          await page.locator(selector).first().click({ timeout: timeoutMs });
          await Promise.race([
            page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {}),
            page.waitForTimeout(2500),
          ]);
          note.ok = true;
        }
      } else {
        note.blocked = `unknown action type ${type}`;
      }
      result.actions.push(note);
    }
    if (screenshotPath) {
      await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
      await page.screenshot({ path: screenshotPath, fullPage: true });
      result.screenshotPath = screenshotPath;
    }
    result.summary = await elementSummary(page);
    result.submitMarker = await page.evaluate(() => ({
      bodySubmitted: document.body?.dataset?.submitted || "",
      resultText: document.querySelector("#result")?.textContent?.trim() || "",
    })).catch(() => ({}));
    result.pageText = await page.evaluate(() => (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 5000)).catch(() => "");
    result.finalUrl = page.url();
    result.title = await page.title();
    result.ok = result.actions.every((item) => item.ok || item.blocked);
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify(result, null, 2));
}

run().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exit(1);
});
