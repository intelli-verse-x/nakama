// Capture full-page screenshots of every admin LiveOps page using
// Playwright's bundled Chromium. The dashboard must already be running
// on http://127.0.0.1:3100 with ADMIN_DASHBOARD_DEV_BYPASS=1.
//
// Usage: node scripts/capture-admin-pages.mjs

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(
  "file:///Users/devashishbadlani/dev/Intelliverse-X-User-Webfrontend/",
);
const { chromium } = require("playwright-core");

const OUT_DIR = resolve(
  "/Users/devashishbadlani/dev/nakama/.firecrawl/snapshots/admin-ui",
);
const BASE = process.env.ADMIN_BASE ?? "http://127.0.0.1:3100/admin-dashboard";
const USER = process.env.ADMIN_USER ?? "admin";
const PASS = process.env.ADMIN_PASS ?? "x";

const PAGES = [
  ["dashboard", "/dashboard"],
  ["funnels", "/funnels"],
  ["metrics", "/metrics"],
  ["roas", "/roas"],
  ["category-labels", "/category-labels"],
  ["integrations", "/integrations"],
  ["sessions", "/sessions"],
  ["managed-audiences", "/managed-audiences"],
  ["events", "/events"],
  ["experiments", "/experiments"],
  ["audiences", "/audiences"],
  ["flags", "/flags"],
  ["messages", "/messages"],
  ["dashboards", "/dashboards"],
  ["alerts", "/alerts"],
  ["identities", "/identities"],
];

mkdirSync(OUT_DIR, { recursive: true });

const log = (msg) => console.log(`[capture] ${msg}`);

async function main() {
  log("launching Chromium…");
  const executablePath =
    "/Users/devashishbadlani/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
  const browser = await chromium.launch({
    headless: true,
    executablePath,
    args: ["--hide-scrollbars"],
  });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  page.setDefaultNavigationTimeout(20000);
  page.setDefaultTimeout(15000);

  log(`opening ${BASE}/`);
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);

  // Try login form first.
  const userInput = await page
    .locator('input[name="username"], input[type="text"], input')
    .first();
  if (await userInput.count()) {
    log("logging in…");
    try {
      await userInput.fill(USER);
      const pwd = page.locator('input[type="password"]').first();
      if (await pwd.count()) await pwd.fill(PASS);
      const submit = page.locator('button[type="submit"]').first();
      if (await submit.count()) await submit.click();
      await page.waitForTimeout(2000);
    } catch (err) {
      log(`login skipped: ${err.message}`);
    }
  }

  for (const [name, path] of PAGES) {
    const url = `${BASE}${path}`;
    log(`→ ${name} (${url})`);
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
      await page.waitForTimeout(2200);
      const out = join(OUT_DIR, `admin-${name}.png`);
      await page.screenshot({ path: out, fullPage: true, timeout: 15000 });
      log(`   saved ${out}`);
    } catch (err) {
      log(`   FAILED ${name}: ${err.message}`);
    }
  }

  await browser.close();
  log("done");
}

main().catch((err) => {
  console.error("[capture] FATAL", err);
  process.exit(1);
});
