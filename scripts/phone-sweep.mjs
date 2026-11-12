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
const api = (route, init = {}) =>
  fetch(`${base}/api/v1${route}`, { ...init, headers: { authorization: `Bearer ${env.CRM_AGENT_TOKEN}`, "content-type": "application/json", ...init.headers } }).catch(() => null);
let sweepTask = null;
if (env.CRM_AGENT_TOKEN) {
  const listed = await api("/companies?limit=1");
  const company = listed?.ok ? ((await listed.json()).data ?? [])[0] : null;
  const seeded = await api("/tasks", {
    method: "POST",
    body: JSON.stringify({ title: "Sweep check task", dueAt: new Date(Date.now() + 2 * 3_600_000).toISOString(), companyId: company?.id ?? null, contactId: null, opportunityId: null }),
  });
  if (seeded?.ok) sweepTask = { id: (await seeded.json()).task.id, companyId: company?.id ?? null };
  else console.log(`could not add a task to check (${seeded?.status ?? "no answer"})`);
}

async function swipe(page, id, distance) {
  return page
    .evaluate(
      async ({ id, distance }) => {
        const element = document.querySelector(`li[data-task-id="${id}"] > div`);
        const box = element.getBoundingClientRect();
        const y = box.top + box.height / 2;
        const x = distance < 0 ? box.right - 40 : box.left + 40;
        const touch = (cx) => new Touch({ identifier: 1, target: element, clientX: cx, clientY: y });
        const fire = (type, cx) => element.dispatchEvent(new TouchEvent(type, { touches: type === "touchend" ? [] : [touch(cx)], changedTouches: [touch(cx)], bubbles: true, cancelable: true }));
        fire("touchstart", x);
        for (let step = 1; step <= 10; step += 1) {
          fire("touchmove", x + (distance * step) / 10);
          await new Promise((resolve) => setTimeout(resolve, 16));
        }
        fire("touchend", x + distance);
        return true;
      },
      { id, distance },
    )
    .catch(() => false);
}

async function setVisibility(page, state) {
  await page.evaluate((value) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => value });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
}

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
  if (hasMail) check(`${device} mail list loads`, true);
  else console.log(`skip ${device} mail list and thread (no mail yet, connect a mailbox to check them)`);
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
  const sweepRow = sweepTask ? page.locator(`li[data-task-id="${sweepTask.id}"]`) : page.locator("li[data-task-id]").first();
  check(`${device} tasks has the sweep task to check`, (await sweepRow.count()) > 0, (await sweepRow.count()) > 0 ? "" : "set CRM_AGENT_TOKEN so the sweep can add one");
  if ((await sweepRow.count()) > 0) {
    const id = await sweepRow.getAttribute("data-task-id");
    const row = page.locator(`li[data-task-id="${id}"]`);
    const toast = page.getByText("Task done.");
    check(`${device} tasks grouped by due date`, await visible(page.getByRole("heading", { name: /^(Overdue|Today|Upcoming|No date)/ })));

    await row.getByRole("button", { name: /^Mark .* done$/ }).tap();
    await page.waitForTimeout(500);
    check(`${device} Done hides the task with Undo`, (await row.count()) === 0 && (await visible(toast)));
    await page.getByRole("button", { name: "Undo" }).last().tap();
    await page.waitForTimeout(600);
    check(`${device} Undo brings the task back`, (await row.count()) === 1);

    await row.getByRole("button", { name: /^Mark .* done$/ }).tap();
    await page.waitForTimeout(400);
    await setVisibility(page, "hidden");
    await page.waitForTimeout(800);
    await setVisibility(page, "visible");
    await page.waitForTimeout(800);
    check(`${device} Undo still shows after the page comes back`, await visible(toast));
    await page.getByRole("button", { name: "Undo" }).last().tap();
    await page.waitForTimeout(2000);
    check(`${device} Undo after the page was hidden reopens the task`, (await row.count()) === 1);

    if (await swipe(page, id, -260)) {
      await page.waitForTimeout(700);
      check(`${device} swipe left is Done`, (await row.count()) === 0 && (await visible(toast)));
      await page.getByRole("button", { name: "Undo" }).last().tap();
      await page.waitForTimeout(600);
      await swipe(page, id, 260);
      await page.waitForTimeout(600);
      check(`${device} swipe right is Remind me`, await visible(page.getByRole("dialog", { name: "Remind me" })));
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
    } else console.log(`skip ${device} swipes (this browser can't simulate touch)`);

    await row.locator("button[aria-expanded]").first().tap();
    await page.waitForTimeout(600);
    check(`${device} task expands in place`, await visible(row.getByRole("button", { name: "Open", exact: true })));
    check(`${device} expanded task no overflow`, await noHorizontalScroll());
    const note = `Checked by the sweep ${Date.now()}`;
    const description = row.getByRole("textbox", { name: "Description" });
    await description.fill(note);
    await description.evaluate((field) => field.blur());
    await page.waitForTimeout(1000);
    check(`${device} description saves`, await visible(row.getByRole("status").filter({ hasText: "Saved" })));
    await shot("task-expanded");
    await row.getByRole("button", { name: "Open", exact: true }).tap();
    await page.waitForTimeout(800);
    const panel = page.getByRole("dialog", { name: "Task" });
    check(`${device} task panel opens as a modal`, (await visible(panel)) && (await panel.getAttribute("aria-modal")) === "true");
    check(`${device} task panel shows the saved description`, (await panel.getByRole("textbox", { name: "Description" }).inputValue()) === note);
    await shot("task-panel");
    await panel.getByRole("button", { name: "Close" }).tap();
    await page.waitForTimeout(600);
    check(`${device} task panel closes`, !(await visible(panel)));

    if (sweepTask?.companyId) {
      await page.goto(`${base}/companies/${sweepTask.companyId}`);
      await page.waitForTimeout(1500);
      const recordRow = page.locator(`li[data-task-id="${id}"]`);
      await recordRow.locator("button[aria-expanded]").first().tap();
      await page.waitForTimeout(600);
      await recordRow.getByRole("button", { name: "Open", exact: true }).tap();
      await page.waitForTimeout(800);
      check(`${device} record page task panel opens`, await visible(page.getByRole("dialog", { name: "Task" })));
      await shot("record-task-panel");
      await page.getByRole("dialog", { name: "Task" }).getByRole("button", { name: "Close" }).tap();
      await page.waitForTimeout(600);
    } else console.log(`skip ${device} record page task panel (no company to link the sweep task to)`);
  }
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

for (const width of [1100, 1440]) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${base}/login`);
  await page.fill('input[name="email"]', env.DEV_USER_EMAIL);
  await page.fill('input[name="password"]', env.DEV_USER_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  await page.goto(`${base}/tasks`);
  await page.waitForTimeout(1500);
  const first = page.locator("li[data-task-id]").first();
  const device = `desktop ${width}`;
  if ((await first.count()) === 0) {
    check(`${device} has a task to open`, false);
    await context.close();
    continue;
  }
  await first.locator("button[aria-expanded]").first().click();
  await page.waitForTimeout(400);
  await first.getByRole("button", { name: "Open", exact: true }).click();
  await page.waitForTimeout(900);
  const panel = page.getByRole("dialog", { name: "Task" });
  const panelBox = await panel.boundingBox();
  check(`${device} task panel sits beside the list`, (await panel.isVisible()) && (await panel.getAttribute("aria-modal")) !== "true");
  const fab = page.getByRole("button", { name: "Quick add", exact: true });
  const fabBox = (await fab.isVisible()) ? await fab.boundingBox() : null;
  check(`${device} quick add stays usable beside the panel`, Boolean(panelBox && fabBox && fabBox.x + fabBox.width <= panelBox.x));
  const pill = page.getByRole("button", { name: /^(Ask Orbit|Continue your chat)/ });
  const pillBox = (await pill.isVisible()) ? await pill.boundingBox() : null;
  const clear = (box) => !box || !panelBox || box.x + box.width <= panelBox.x;
  const apart = (box) => !box || !fabBox || box.x + box.width <= fabBox.x || box.y + box.height <= fabBox.y;
  check(`${device} closed Ask Orbit sits clear of the panel and quick add`, clear(pillBox) && apart(pillBox) && (!pillBox || pillBox.x >= 0), pillBox ? "" : "tucked away");
  await page.screenshot({ path: path.join(out, `desktop-${width}-task-panel.png`) });
  await page.evaluate(() => {
    document.querySelector('[data-kb-active="true"]')?.removeAttribute("data-kb-active");
    (document.activeElement instanceof HTMLElement ? document.activeElement : null)?.blur();
  });
  await page.keyboard.press("o");
  await page.waitForTimeout(800);
  const dock = page.getByRole("region", { name: "Orbit assistant" }).or(page.locator('section[aria-label="Orbit assistant"]')).first();
  const dockBox = (await dock.isVisible()) ? await dock.boundingBox() : null;
  const onTop = dockBox
    ? await page.evaluate(({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest('section[aria-label="Orbit assistant"]')), { x: dockBox.x + dockBox.width - 24, y: dockBox.y + dockBox.height - 24 })
    : false;
  check(`${device} open Ask Orbit is usable with the panel open`, Boolean(dockBox) && (clear(dockBox) || onTop) && dockBox.width >= 300, dockBox ? `${Math.round(dockBox.width)}px wide` : "didn't open");
  await page.screenshot({ path: path.join(out, `desktop-${width}-assistant.png`) });
  await context.close();
}

if (sweepTask) await api(`/tasks/${sweepTask.id}`, { method: "DELETE" });

console.log(problems.length ? `\n${problems.length} problems. Screenshots are in ${out}` : `\nall checks passed. Screenshots are in ${out}`);
await browser.close();
process.exit(problems.length ? 1 : 0);
