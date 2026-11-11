import fs from "node:fs";
import path from "node:path";
import { chromium, webkit } from "playwright-core";

function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(
    fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => /^[A-Z0-9_]+=/.test(line))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
}

const env = { ...readEnvFile(path.resolve(".env.local")), ...process.env };
const base = (env.SWEEP_URL || "http://localhost:3000").replace(/\/$/, "");
const out = path.resolve(env.SWEEP_OUT || "sweep-results");
const engine = env.BROWSER === "webkit" ? webkit : chromium;
const launch = env.BROWSER === "webkit" ? {} : env.CHROME_PATH ? { executablePath: env.CHROME_PATH } : { channel: "chrome" };

if (!env.DEV_USER_EMAIL || !env.DEV_USER_PASSWORD) {
  console.error("Set DEV_USER_EMAIL and DEV_USER_PASSWORD in .env.local or the environment.");
  process.exit(1);
}

fs.mkdirSync(out, { recursive: true });
const browser = await engine.launch(launch);
const problems = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) problems.push(name);
};

for (const [device, viewport] of [
  ["iphone", { width: 390, height: 844 }],
  ["ipad", { width: 820, height: 1180 }],
]) {
  const context = await browser.newContext({ viewport, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message.slice(0, 120)));
  page.on("console", (message) => {
    if (message.type() === "error" && !/401|Invalid API key|Failed to load resource/.test(message.text())) errors.push(message.text().slice(0, 120));
  });

  await page.goto(`${base}/login`);
  await page.fill('input[name="email"]', env.DEV_USER_EMAIL);
  await page.fill('input[name="password"]', env.DEV_USER_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));

  const visible = async (locator) => (await locator.count()) > 0 && (await locator.first().isVisible());
  const fab = page.locator('button[aria-label*="add" i]').last();
  const shot = (name) => page.screenshot({ path: path.join(out, `${device}-${name}.png`) });
  const noHorizontalScroll = async () => page.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1);
  const fitsHeight = async () => page.evaluate(() => document.scrollingElement.scrollHeight <= window.innerHeight + 2);

  await page.goto(`${base}/mail`);
  await page.waitForTimeout(1500);
  const hasMail = await visible(page.locator("[data-mail-row]"));
  check(`${device} mail list loads`, hasMail, hasMail ? "" : "no mail rows, connect a mailbox or use a copy of real data");
  check(`${device} mail no page overflow`, (await noHorizontalScroll()) && (await fitsHeight()));
  check(`${device} + button visible`, await visible(fab));
  await shot("mail");

  await page.getByText("Ask Orbit").first().tap();
  await page.waitForTimeout(800);
  const assistant = page.locator('section[aria-label="Orbit assistant"]');
  check(`${device} assistant opens visibly`, await visible(page.getByRole("region", { name: "Orbit assistant" }).or(assistant)));
  check(`${device} + button still visible with assistant open`, await visible(fab));
  check(`${device} page not stretched with assistant open`, await fitsHeight());
  await shot("assistant-open");
  await page
    .getByRole("button", { name: /Minimise|Close assistant|Hide/i })
    .first()
    .tap()
    .catch(() => page.keyboard.press("Escape"));
  await page.waitForTimeout(600);
  check(`${device} assistant closes`, !(await visible(assistant)));

  if (hasMail) {
    await page.locator("[data-mail-row]").first().tap();
    await page.waitForTimeout(1500);
    check(`${device} thread opens`, await visible(page.getByRole("button", { name: /^Reply$/ }).or(page.getByRole("textbox", { name: /Reply/i }))));
    await shot("thread");
    if (device === "iphone") {
      await page.getByRole("button", { name: "Back to the list" }).tap();
      await page.waitForTimeout(800);
      check(`${device} back to list`, await visible(page.locator("[data-mail-row]")));
    }
  }

  await page.goto(`${base}/companies`);
  await page.waitForTimeout(1500);
  check(`${device} companies loads`, await visible(page.getByRole("heading", { name: "Companies" })));
  check(`${device} companies no page overflow`, await fitsHeight());
  await fab.tap();
  await page.waitForTimeout(700);
  check(`${device} quick add opens`, (await page.getByRole("dialog").count()) > 0 || (await page.getByRole("menu").count()) > 0);
  await shot("quick-add");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);

  const company = await page.evaluate(async () => (await (await fetch("/companies")).text()).match(/\/companies\/([0-9a-f-]{36})/)?.[0]);
  if (company) {
    await page.goto(`${base}${company}`);
    await page.waitForTimeout(1500);
    check(`${device} company page back button`, await visible(page.getByRole("link", { name: /Back to Companies/ })));
    check(`${device} company page no overflow`, await noHorizontalScroll());
    await shot("company");
  }

  await page.goto(`${base}/opportunities?view=board`);
  await page.waitForTimeout(1500);
  check(`${device} board no page overflow`, await fitsHeight());
  await page.goto(`${base}/opportunities?view=list`);
  await page.waitForTimeout(1200);
  const opportunity = page.locator('a[href^="/opportunities/"]').first();
  if ((await opportunity.count()) > 0) {
    await opportunity.tap();
    await page.waitForTimeout(1500);
    check(`${device} opportunity page opens`, await visible(page.getByRole("button", { name: "Mark won" })));
    await shot("opportunity");
  }

  await page.goto(`${base}/tasks`);
  await page.waitForTimeout(1200);
  check(`${device} tasks loads`, await visible(page.getByRole("heading", { name: "Tasks" })));
  await page.goto(`${base}/calendar`);
  await page.waitForTimeout(1200);
  check(`${device} calendar loads`, await visible(page.getByRole("heading", { name: "Calendar" })));
  await shot("calendar");
  await page.goto(`${base}/settings/general`);
  await page.waitForTimeout(1200);
  check(`${device} settings loads`, await visible(page.getByRole("heading", { name: "General" })));
  await page.getByRole("button", { name: "Open navigation" }).tap();
  await page.waitForTimeout(600);
  check(`${device} nav menu opens`, await visible(page.getByRole("button", { name: "Close menu" })));
  await page.getByRole("button", { name: "Close menu" }).tap();
  await page.waitForTimeout(500);
  check(`${device} nav menu closes`, !(await visible(page.getByRole("button", { name: "Close menu" }))));
  await page.getByRole("button", { name: /Account menu/ }).tap();
  await page.waitForTimeout(400);
  check(`${device} account menu opens`, await visible(page.getByRole("menuitem", { name: "Settings" })));
  await page.keyboard.press("Escape");
  await page.goto(`${base}/workflows`);
  await page.waitForTimeout(1200);
  check(`${device} workflows loads`, await visible(page.getByRole("heading", { name: "Workflows" })));
  check(`${device} no page errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
  await context.close();
}

console.log(problems.length ? `\n${problems.length} problems. Screenshots are in ${out}` : `\nall checks passed. Screenshots are in ${out}`);
await browser.close();
process.exit(problems.length ? 1 : 0);
