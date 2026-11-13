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
const localHttps = /^https:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(base);
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

const sweepContacts = [];
const sweepCallTasks = [];
async function seedCallTask(label) {
  if (!env.CRM_AGENT_TOKEN) return null;
  const stamp = `${label}${Date.now().toString(36)}`;
  const contact = await api("/contacts", {
    method: "POST",
    body: JSON.stringify({ firstName: "Sweep", lastName: `Caller ${stamp}`, email: `sweep-${stamp}@example.com`, phone: "+44 7700 900123", companyId: sweepTask?.companyId ?? null }),
  });
  if (!contact?.ok) {
    console.log(`could not add a contact to check calls (${contact?.status ?? "no answer"})`);
    return null;
  }
  const contactId = (await contact.json()).contact.id;
  sweepContacts.push(contactId);
  const title = `Call Sweep Caller ${stamp}`;
  const task = await api("/tasks", { method: "POST", body: JSON.stringify({ title, contactId, dueAt: new Date(Date.now() + 3_600_000).toISOString() }) });
  if (!task?.ok) return null;
  const id = (await task.json()).task.id;
  sweepCallTasks.push(id);
  return { id, title };
}

function londonDay(offset) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + offset * 86_400_000));
}

async function seedBlock(page, device) {
  if (!env.CRM_AGENT_TOKEN) return null;
  const stamp = `${device}${Date.now().toString(36)}`;
  await goto(page, `${base}/tasks`);
  await page.waitForTimeout(1200);
  const pad = page.locator('textarea[data-shortcut="add-record"]').first();
  if ((await pad.count()) === 0 || !(await pad.isVisible())) return null;
  await pad.click();
  await pad.fill(`Sweep owner ${stamp}`);
  await page.waitForTimeout(800);
  await pad.press("Enter");
  let mine = null;
  for (let attempt = 0; attempt < 4 && !mine; attempt += 1) {
    await page.waitForTimeout(1000);
    const found = await api(`/tasks?q=${encodeURIComponent(stamp)}&view=all&limit=5`);
    mine = found?.ok ? ((await found.json()).data ?? [])[0] : null;
  }
  if (mine) await api(`/tasks/${mine.id}`, { method: "DELETE" });
  if (!mine?.ownerId) return null;
  const add = async (title, dueAt) => {
    const created = await api("/tasks", { method: "POST", body: JSON.stringify({ title, dueAt, durationMinutes: 30, ownerId: mine.ownerId }) });
    return created?.ok ? (await created.json()).task.id : null;
  };
  const day = londonDay(1);
  const title = `Sweep block ${stamp}`;
  const id = await add(title, `${day}T10:00`);
  const overdueDay = londonDay(-1);
  const overdueId = await add(`Sweep overdue ${stamp}`, `${overdueDay}T10:00`);
  const created = await api("/tasks", { method: "POST", body: JSON.stringify({ title: `Sweep plain ${stamp}`, ownerId: mine.ownerId, companyId: null, contactId: null, opportunityId: null }) });
  const plainId = created?.ok ? (await created.json()).task.id : null;
  const ids = [id, overdueId, plainId].filter(Boolean);
  if (!id || !overdueId || !plainId) {
    await dropTasks(ids);
    return null;
  }
  return { id, title, day, overdueId, overdueDay, plainId, ids };
}

async function dropTasks(ids) {
  for (const id of ids) await api(`/tasks/${id}`, { method: "DELETE" });
}

async function focusedTaskId(page) {
  return page.evaluate(() => (document.activeElement?.closest("[data-task-block]") ? document.activeElement.getAttribute("data-task-id") : null));
}

async function touchTarget(locator) {
  return locator
    .evaluate((circle) => {
      const block = circle.closest("[data-task-block]");
      const open = block.querySelector("button[data-task-id]");
      const own = circle.getBoundingClientRect();
      const hit = document.elementFromPoint(own.left + own.width / 2, own.top + own.height / 2);
      const box = open.getBoundingClientRect();
      return { opens: open.contains(hit), width: box.width, height: box.height, blockHeight: block.getBoundingClientRect().height };
    })
    .catch(() => null);
}

async function skipOutcome(row) {
  const outcome = row.getByRole("group", { name: "Done with an outcome" });
  const offered = (await outcome.count()) > 0 && (await outcome.isVisible());
  if (offered) await outcome.getByRole("button", { name: "Skip" }).tap();
  return offered;
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
async function goto(page, url) {
  try {
    await page.goto(url);
  } catch (error) {
    if (!/interrupted by another navigation/.test(String(error))) throw error;
    await page.waitForLoadState("load");
    if (page.url() !== url) await page.goto(url);
  }
}
const problems = [];
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", new URL(base).hostname]);
const blocked = new Set();
async function offline(context) {
  await context.route(
    (url) => /^(https?|wss?):$/.test(url.protocol) && !LOCAL_HOSTS.has(url.hostname),
    (route) => {
      blocked.add(new URL(route.request().url()).host);
      return route.abort("blockedbyclient");
    },
  );
}
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) problems.push(name);
};

for (const [device, viewport] of [
  ["iphone", { width: 390, height: 844 }],
  ["ipad", { width: 820, height: 1180 }],
]) {
  const context = await browser.newContext({ viewport, isMobile: true, hasTouch: true, ignoreHTTPSErrors: localHttps, serviceWorkers: "block" });
  await offline(context);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message.slice(0, 120)));
  page.on("console", (message) => {
    if (message.type() === "error" && !/401|Invalid API key|Failed to load resource/.test(message.text())) errors.push(message.text().slice(0, 120));
  });

  await goto(page, `${base}/login`);
  await page.fill('input[name="email"]', env.DEV_USER_EMAIL);
  await page.fill('input[name="password"]', env.DEV_USER_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));

  const visible = async (locator) => (await locator.count()) > 0 && (await locator.first().isVisible());
  const fab = page.locator('button[aria-label*="add" i]').last();
  const shot = (name) => page.screenshot({ path: path.join(out, `${device}-${name}.png`) });
  const tapArea = (locator) =>
    locator
      .evaluate((element) => {
        const box = element.getBoundingClientRect();
        const after = getComputedStyle(element, "::after");
        const height = after.position === "absolute" ? Math.max(box.height, parseFloat(after.height)) : box.height;
        const x = box.left + box.width / 2;
        const ends = [box.top + box.height / 2 - height / 2 + 1, box.top + box.height / 2 + height / 2 - 1];
        const owns = ends.every((y) => element.contains(document.elementFromPoint(x, y)));
        return { height, owns };
      })
      .catch(() => null);
  const noHorizontalScroll = async () => page.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1);
  const fitsHeight = async () => page.evaluate(() => document.scrollingElement.scrollHeight <= window.innerHeight + 2);

  await goto(page, `${base}/mail`);
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

  await goto(page, `${base}/companies`);
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
    await goto(page, `${base}${company}`);
    await page.waitForTimeout(1500);
    check(`${device} company page back button`, await visible(page.getByRole("link", { name: /Back to Companies/ })));
    check(`${device} company page no overflow`, await noHorizontalScroll());
    await shot("company");
  }

  await goto(page, `${base}/opportunities?view=board`);
  await page.waitForTimeout(1500);
  check(`${device} board no page overflow`, await fitsHeight());
  await goto(page, `${base}/opportunities?view=list`);
  await page.waitForTimeout(1200);
  const opportunity = page.locator('a[href^="/opportunities/"]').first();
  if ((await opportunity.count()) > 0) {
    await opportunity.tap();
    await page.waitForTimeout(1500);
    check(`${device} opportunity page opens`, await visible(page.getByRole("button", { name: "Mark won" })));
    await shot("opportunity");
  }

  await goto(page, `${base}/tasks`);
  await page.waitForTimeout(1200);
  check(`${device} tasks loads`, await visible(page.getByRole("heading", { name: "Tasks" })));
  const pad = page.locator('textarea[data-shortcut="add-record"]').first();
  if (await visible(pad)) {
    await pad.tap();
    await pad.fill("Call Sweep Monday remind me 15 mins before");
    await page.waitForTimeout(700);
    check(`${device} Add task asks for a time for a reminder on a day`, await visible(page.getByRole("button", { name: "Pick a time for the reminder" })));
    await page.getByRole("button", { name: "Duration 15m. Change" }).first().tap();
    await page.waitForTimeout(400);
    await page.getByRole("group", { name: "Duration" }).getByRole("button", { name: "30m" }).tap();
    await page.waitForTimeout(400);
    check(`${device} Add task takes a duration`, await visible(page.getByRole("button", { name: "Duration 30m. Change" })));
    await pad.focus();
    await pad.press("Enter");
    await page.waitForTimeout(600);
    check(`${device} Enter asks for the reminder time instead of saving`, (await visible(page.getByText("Pick a time for the reminder", { exact: true }))) && (await pad.inputValue()) !== "");
    await shot("task-pad-reminder-time");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    await pad.fill("");
    await page.waitForTimeout(300);
  } else console.log(`skip ${device} Add task card (not found)`);
  const sweepRow = sweepTask ? page.locator(`li[data-task-id="${sweepTask.id}"]`) : page.locator("li[data-task-id]").first();
  check(`${device} tasks has the sweep task to check`, (await sweepRow.count()) > 0, (await sweepRow.count()) > 0 ? "" : "set CRM_AGENT_TOKEN so the sweep can add one");
  if ((await sweepRow.count()) > 0) {
    const id = await sweepRow.getAttribute("data-task-id");
    const row = page.locator(`li[data-task-id="${id}"]`);
    const toast = page.getByText("Task done.");
    check(`${device} tasks grouped by due date`, await visible(page.getByRole("heading", { name: /^(Overdue|Today|Upcoming|No date)/ })));

    await row.getByRole("button", { name: /^Mark .* done$/ }).tap();
    await page.waitForTimeout(700);
    const asked = await skipOutcome(row);
    await page.waitForTimeout(500);
    check(`${device} Done hides the task with Undo`, (await row.count()) === 0 && (await visible(toast)), asked ? "after Skip" : "");
    await page.getByRole("button", { name: "Undo" }).last().tap();
    await page.waitForTimeout(600);
    check(`${device} Undo brings the task back`, (await row.count()) === 1);

    await row.getByRole("button", { name: /^Mark .* done$/ }).tap();
    await page.waitForTimeout(700);
    await skipOutcome(row);
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
    check(`${device} expanded task shows its duration`, await visible(row.getByRole("button", { name: /^Duration / })));
    await row.getByRole("button", { name: /^Duration / }).tap();
    await page.waitForTimeout(500);
    await page.getByRole("group", { name: "Duration" }).getByRole("button", { name: "30m" }).tap();
    await page.waitForTimeout(1200);
    check(`${device} Duration saves`, await visible(row.getByRole("button", { name: "Duration 30m. Change" })));
    const openSchedule = async () => {
      await row.getByRole("button", { name: "Schedule" }).tap();
      await page.waitForTimeout(700);
      return device === "iphone" ? page.getByRole("dialog", { name: "Schedule" }) : page.getByRole("menu", { name: "Schedule" });
    };
    let schedule = await openSchedule();
    check(`${device} Schedule offers a date and time`, await visible(schedule.locator("button", { hasText: "Pick a date and time" })));
    await shot("task-schedule");
    await schedule.locator("button", { hasText: "Pick a date and time" }).tap();
    await page.waitForTimeout(400);
    const pickForm = page.getByRole("form", { name: "Pick a date and time" });
    check(`${device} Pick a date and time shows a date and a time`, (await visible(pickForm.getByLabel("Date", { exact: true }))) && (await visible(pickForm.getByLabel("Time", { exact: true }))));
    check(`${device} Pick a date and time starts on a time`, /^\d\d:\d\d$/.test(await pickForm.getByLabel("Time", { exact: true }).inputValue()));
    await shot("task-schedule-pick");
    await pickForm.getByRole("button", { name: "Cancel" }).tap();
    await page.waitForTimeout(400);
    const nextFree = schedule.locator("button", { hasText: /^Next free/ });
    await page.waitForTimeout(800);
    if ((await visible(nextFree)) && (await nextFree.isEnabled())) {
      await nextFree.tap();
      await page.waitForTimeout(1500);
      check(`${device} Next free gives the task a time today`, await visible(row.getByRole("button", { name: /^Due .*\d\d:\d\d\. Change$/ })));
      schedule = await openSchedule();
    } else console.log(`skip ${device} Next free (outside working hours, no free slot or no calendar)`);
    await schedule.locator("button", { hasText: /morning/ }).first().tap();
    await page.waitForTimeout(1500);
    check(`${device} Schedule sets a morning time`, await visible(row.getByRole("button", { name: /^Due .*09:00\. Change$/ })));
    schedule = await openSchedule();
    await schedule.locator("button", { hasText: "Remove the time" }).tap();
    await page.waitForTimeout(1500);
    const remind = row.getByRole("button", { name: "Remind me. Pick a time first" });
    check(`${device} Remove the time leaves the day`, (await visible(remind)) && !(await visible(row.getByRole("button", { name: /^Due .*\d\d:\d\d\. Change$/ }))));
    await remind.tap();
    await page.waitForTimeout(500);
    check(`${device} Remind me on a date-only task asks for a time`, await visible(page.getByText("Pick a time for the reminder")));
    await shot("task-reminder-time");
    await page.getByRole("button", { name: "Cancel" }).last().tap();
    await page.waitForTimeout(400);
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
      await goto(page, `${base}/companies/${sweepTask.companyId}`);
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

  const callTask = await seedCallTask(device);
  if (callTask) {
    await goto(page, `${base}/tasks`);
    await page.waitForTimeout(1500);
    const row = page.locator(`li[data-task-id="${callTask.id}"]`);
    await row.locator("button[aria-expanded]").first().tap({ position: { x: 3, y: 8 } });
    await page.waitForTimeout(1200);
    const call = row.locator('a:visible[href^="tel:"], a:visible[href^="msteams:"]').first();
    const callHref = (await call.getAttribute("href").catch(() => null)) ?? "";
    check(`${device} Call rings from the phone`, callHref.startsWith("tel:"), callHref);
    const callArea = await tapArea(call);
    check(`${device} Call is easy to tap`, Boolean(callArea && callArea.height >= 43 && callArea.owns), callArea ? `${Math.round(callArea.height)}px${callArea.owns ? "" : ", covered"}` : "missing");
    check(`${device} Call leads on a call task`, ((await call.getAttribute("class").catch(() => "")) ?? "").includes("bg-primary"));
    check(`${device} Copy and Email sit beside Call`, (await visible(row.getByRole("button", { name: /^Copy/ }))) && (await visible(row.getByRole("button", { name: "Email Sweep", exact: true }))));
    check(`${device} the task shows its context`, await visible(row.locator("[data-task-context]")));
    check(`${device} call task no overflow`, await noHorizontalScroll());
    await shot("task-call");
    await row.getByRole("button", { name: "Email Sweep", exact: true }).tap();
    await page.waitForTimeout(1500);
    const card = page.getByRole("dialog", { name: "New email" }).filter({ hasText: /Sweep Caller/ });
    check(`${device} Email opens a compose card to the contact`, await visible(card));
    await shot("task-email");
    await goto(page, `${base}/tasks`);
    await page.waitForTimeout(1500);
    await row.getByRole("button", { name: /^Mark .* done$/ }).tap();
    await page.waitForTimeout(800);
    const outcome = row.getByRole("group", { name: "Done with an outcome" });
    check(`${device} Done on a linked task offers an outcome`, await visible(outcome));
    check(`${device} Done takes effect at once with Undo`, await visible(page.getByText("Task done.")));
    check(`${device} the outcome starts as a call`, (await outcome.getByRole("button", { name: "Call" }).getAttribute("aria-pressed").catch(() => null)) === "true");
    const save = outcome.getByRole("button", { name: "Save" });
    const saveArea = await tapArea(save);
    check(`${device} Save is easy to tap`, Boolean(saveArea && saveArea.height >= 43 && saveArea.owns), saveArea ? `${Math.round(saveArea.height)}px${saveArea.owns ? "" : ", covered"}` : "missing");
    check(`${device} outcome no overflow`, await noHorizontalScroll());
    await outcome.getByRole("textbox", { name: "What happened" }).fill("Checked by the sweep");
    await outcome.getByRole("textbox", { name: "Next task" }).fill("Sweep follow-up");
    await shot("task-outcome");
    await save.tap();
    await page.waitForTimeout(1500);
    check(`${device} Save completes and logs the outcome`, (await row.count()) === 0 && (await visible(page.getByText(/Task done\. Note saved\. Next task added\./))));
    const followUp = page.locator("li[data-task-id]").filter({ hasText: "Sweep follow-up" }).first();
    if ((await followUp.count()) > 0) sweepCallTasks.push(await followUp.getAttribute("data-task-id"));
  } else check(`${device} call, email and outcome checks ran`, false, "set CRM_AGENT_TOKEN so the sweep can add a contact");

  const undoTask = await seedCallTask(`${device}u`);
  if (undoTask) {
    await goto(page, `${base}/tasks`);
    await page.waitForTimeout(1500);
    const row = page.locator(`li[data-task-id="${undoTask.id}"]`);
    const outcome = row.getByRole("group", { name: "Done with an outcome" });
    await row.getByRole("button", { name: /^Mark .* done$/ }).tap();
    await page.waitForTimeout(800);
    const undo = page.getByRole("button", { name: "Undo" }).last();
    check(`${device} the outcome's Done shows Undo`, await visible(undo));
    await undo.tap();
    await page.waitForTimeout(800);
    check(`${device} Undo closes the outcome and keeps the task`, (await row.count()) === 1 && !(await visible(outcome)));
    await row.getByRole("button", { name: /^Mark .* done$/ }).tap();
    await page.waitForTimeout(800);
    await outcome.getByRole("textbox", { name: "What happened" }).fill("Saved by Esc in the sweep");
    await outcome.getByRole("textbox", { name: "What happened" }).press("Escape");
    await page.waitForTimeout(1800);
    check(`${device} Esc with a note typed saves it`, (await row.count()) === 0 && (await visible(page.getByText(/Note saved\./).first())));
  } else check(`${device} Undo and Esc outcome checks ran`, false, "set CRM_AGENT_TOKEN so the sweep can add a task");

  const slowTask = await seedCallTask(`${device}s`);
  if (slowTask) {
    await goto(page, `${base}/tasks`);
    await page.waitForTimeout(1500);
    const row = page.locator(`li[data-task-id="${slowTask.id}"]`);
    const outcome = row.getByRole("group", { name: "Done with an outcome" });
    await row.getByRole("button", { name: /^Mark .* done$/ }).tap();
    await page.waitForTimeout(800);
    await outcome.getByRole("textbox", { name: "What happened" }).fill("Saved while Undo was pressed");
    const slow = async (route) => {
      if (route.request().method() === "POST" && route.request().headers()["next-action"]) await new Promise((resolve) => setTimeout(resolve, 2000));
      await route.continue().catch(() => undefined);
    };
    await page.route("**/tasks**", slow);
    await outcome.getByRole("button", { name: "Save" }).tap();
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: "Undo" }).last().tap();
    await page.waitForTimeout(4500);
    await page.unroute("**/tasks**", slow);
    check(`${device} Undo during Save reopens the task`, (await visible(page.getByText("Saved. Task reopened."))) && (await row.count()) === 1);
    await goto(page, `${base}/tasks`);
    await page.waitForTimeout(1500);
    check(`${device} the task stays open after Undo during Save`, (await page.locator(`li[data-task-id="${slowTask.id}"]`).count()) === 1);
  } else check(`${device} Undo during Save checked`, false, "set CRM_AGENT_TOKEN so the sweep can add a task");

  const panelTask = await seedCallTask(`${device}p`);
  if (panelTask) {
    await goto(page, `${base}/tasks?task=${panelTask.id}`);
    await page.waitForTimeout(1800);
    const panel = page.getByRole("dialog", { name: "Task" });
    await panel.getByRole("button", { name: /^Mark .* done$/ }).tap();
    await page.waitForTimeout(800);
    const inPanel = panel.getByRole("group", { name: "Done with an outcome" });
    check(`${device} the panel's Done offers the outcome`, await visible(inPanel));
    await shot("panel-outcome");
    await inPanel.getByRole("button", { name: "Skip" }).tap();
    await page.waitForTimeout(900);
    check(`${device} Skip in the panel leaves the task done`, !(await visible(inPanel)) && (await page.locator(`li[data-task-id="${panelTask.id}"]`).count()) === 0);
  } else check(`${device} panel outcome checks ran`, false, "set CRM_AGENT_TOKEN so the sweep can add a task");

  const recordTask = sweepTask?.companyId ? await seedCallTask(`${device}r`) : null;
  if (recordTask) {
    await goto(page, `${base}/companies/${sweepTask.companyId}`);
    await page.waitForTimeout(1800);
    const row = page.locator(`li[data-task-id="${recordTask.id}"]`);
    await row.getByRole("button", { name: /^Mark .* done$/ }).tap();
    await page.waitForTimeout(800);
    const outcome = row.getByRole("group", { name: "Done with an outcome" });
    check(`${device} record page Done offers the outcome`, await visible(outcome));
    check(`${device} record page outcome no overflow`, await noHorizontalScroll());
    await shot("record-outcome");
    await outcome.getByRole("button", { name: "Skip" }).tap();
    await page.waitForTimeout(800);
    check(`${device} record page Skip leaves the task done`, (await row.count()) === 0);
  } else check(`${device} record page outcome checks ran`, false, sweepTask?.companyId ? "couldn't add a task" : "add a company so the sweep can check a record page");
  await goto(page, `${base}/calendar`);
  await page.waitForTimeout(1200);
  check(`${device} calendar loads`, await visible(page.getByRole("heading", { name: "Calendar" })));
  await shot("calendar");
  const block = await seedBlock(page, device);
  if (block) {
    try {
      await goto(page, `${base}/calendar?date=${block.day}&view=day`);
      await page.waitForTimeout(1500);
      const card = page.locator(`[data-task-block="${block.id}"]`).filter({ visible: true });
      check(`${device} calendar shows the task as a block`, await visible(card));
      check(`${device} calendar with blocks no overflow`, await noHorizontalScroll());
      const circle = card.getByRole("button", { name: /^Mark .* done$/ });
      if (device === "iphone") {
        const area = await tapArea(circle);
        check(`${device} block's done circle is easy to tap`, Boolean(area && area.height >= 43 && area.owns), area ? `${Math.round(area.height)}px${area.owns ? "" : ", covered"}` : "missing");
      } else {
        const target = await touchTarget(circle);
        check(
          `${device} tapping a block's circle opens the task, with the whole block as the target`,
          Boolean(target?.opens && target.width >= 44 && target.height >= target.blockHeight - 1),
          target ? `${Math.round(target.width)}x${Math.round(target.height)}px` : "missing",
        );
      }
      await shot("calendar-block");
      await card.locator("button[data-task-id]").tap();
      await page.waitForTimeout(900);
      const panel = page.getByRole("dialog", { name: "Task" });
      check(
        `${device} a block opens its own task in the panel`,
        (await visible(panel)) && ((await panel.textContent()) ?? "").includes(block.title) && (await visible(panel.getByRole("button", { name: /^Duration 30m/ }))),
      );
      await shot("calendar-task-panel");
      await panel.getByRole("button", { name: "Close" }).tap();
      await page.waitForTimeout(700);
      check(`${device} closing the panel returns focus to the block`, (await focusedTaskId(page)) === block.id);
      if (device === "iphone") {
        await circle.tap();
      } else {
        const spot = await circle.boundingBox();
        await page.touchscreen.tap(spot.x + spot.width / 2, spot.y + spot.height / 2);
        await page.waitForTimeout(900);
        check(`${device} tapping the circle opens the panel where Done is`, await visible(panel));
        await panel.getByRole("button", { name: /^Mark .* done$/ }).tap();
        await page.waitForTimeout(500);
        await panel.getByRole("button", { name: "Close" }).tap();
      }
      await page.waitForTimeout(700);
      check(`${device} Done marks the block done with Undo`, (await visible(page.getByText("Task done."))) && (await visible(card.getByRole("button", { name: /^Done/ }))));
      if (device === "iphone") {
        await card.getByRole("button", { name: /^Done/ }).tap();
        await page.waitForTimeout(900);
        check(`${device} a done block's circle opens the task`, await visible(panel));
        await panel.getByRole("button", { name: "Close" }).tap();
        await page.waitForTimeout(600);
      }
      await page.getByRole("button", { name: "Undo" }).last().tap();
      await page.waitForTimeout(800);
      check(`${device} Undo brings the block back`, await visible(card.getByRole("button", { name: /^Mark .* done$/ })));
      await goto(page, `${base}/calendar?date=${block.overdueDay}&view=day`);
      await page.waitForTimeout(1500);
      const overdue = page.locator(`[data-task-block="${block.overdueId}"]`).filter({ visible: true });
      check(
        `${device} a past block stays on its day marked Overdue`,
        (await visible(overdue)) && ((await overdue.locator("button[data-task-id]").getAttribute("aria-label")) ?? "").includes("overdue") && (await visible(overdue.getByText("Overdue"))),
      );
      await goto(page, `${base}/calendar?date=${block.day}&view=day`);
      await page.waitForTimeout(1500);
      await page.getByRole("button", { name: "Calendars and tasks" }).tap();
      await page.waitForTimeout(700);
      const drawer = page.getByRole("dialog", { name: "Calendars and tasks" });
      const calendarsToggle = drawer.getByRole("button", { name: /^Calendars/ });
      check(
        `${device} drawer has Calendars collapsed and Tasks open`,
        (await calendarsToggle.getAttribute("aria-expanded")) === "false" && (await drawer.getByRole("button", { name: /^Tasks/ }).getAttribute("aria-expanded")) === "true",
      );
      const listRow = drawer.locator(`[data-task-id="${block.id}"]`);
      check(`${device} drawer lists the task`, await visible(listRow));
      check(`${device} drawer lists the overdue task under Overdue`, await visible(drawer.getByRole("region", { name: /^Overdue/ }).locator(`[data-task-id="${block.overdueId}"]`)));
      const rowArea = await tapArea(listRow);
      check(`${device} drawer rows are easy to tap`, Boolean(rowArea && rowArea.height >= 43 && rowArea.owns), rowArea ? `${Math.round(rowArea.height)}px` : "missing");
      const plainRow = drawer.locator(`[data-task-id="${block.plainId}"]`);
      await plainRow.scrollIntoViewIfNeeded().catch(() => undefined);
      const plainArea = await tapArea(plainRow);
      const plainLines = await plainRow.evaluate((row) => row.querySelectorAll("span.truncate").length).catch(() => 0);
      if (plainLines === 1) {
        check(`${device} a one-line drawer row is easy to tap`, Boolean(plainArea && plainArea.height >= 43 && plainArea.owns), plainArea ? `${Math.round(plainArea.height)}px${plainArea.owns ? "" : ", covered"}` : "missing");
      } else console.log(`skip ${device} one-line row (the sweep's user is in more than one workspace, so every row has a second line)`);
      await shot("calendar-drawer");
      await calendarsToggle.tap();
      await page.waitForTimeout(400);
      check(`${device} Calendars expands`, (await calendarsToggle.getAttribute("aria-expanded")) === "true");
      await listRow.tap();
      await page.waitForTimeout(900);
      check(`${device} a task in the drawer opens the panel`, (await visible(page.getByRole("dialog", { name: "Task" }))) && !(await visible(drawer)));
      await page.getByRole("dialog", { name: "Task" }).getByRole("button", { name: "Close" }).tap();
      await page.waitForTimeout(600);
      await page.reload();
      await page.waitForTimeout(1500);
      await page.getByRole("button", { name: "Calendars and tasks" }).tap();
      await page.waitForTimeout(700);
      const again = page.getByRole("dialog", { name: "Calendars and tasks" }).getByRole("button", { name: /^Calendars/ });
      check(`${device} Calendars stays expanded after a reload`, (await again.getAttribute("aria-expanded")) === "true");
      await again.tap();
      await page.waitForTimeout(300);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
    } finally {
      await dropTasks(block.ids);
    }
  } else check(`${device} calendar block checks ran`, false, "set CRM_AGENT_TOKEN and keep the Add task card so the sweep can add a task");
  await goto(page, `${base}/settings/general`);
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
  await goto(page, `${base}/workflows`);
  await page.waitForTimeout(1200);
  check(`${device} workflows loads`, await visible(page.getByRole("heading", { name: "Workflows" })));
  check(`${device} no page errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
  await context.close();
}

for (const width of [1100, 1280, 1440]) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, ignoreHTTPSErrors: localHttps, serviceWorkers: "block" });
  await offline(context);
  const page = await context.newPage();
  await goto(page, `${base}/login`);
  await page.fill('input[name="email"]', env.DEV_USER_EMAIL);
  await page.fill('input[name="password"]', env.DEV_USER_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  await goto(page, `${base}/tasks`);
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

  const callTask = width === 1280 ? await seedCallTask("desk") : null;
  if (callTask) {
    await goto(page, `${base}/tasks`);
    await page.waitForTimeout(1500);
    const row = page.locator(`li[data-task-id="${callTask.id}"]`);
    await row.focus();
    await page.keyboard.press("e");
    await page.waitForTimeout(700);
    const outcome = row.getByRole("group", { name: "Done with an outcome" });
    check(`${device} E on a linked task offers an outcome`, await outcome.isVisible().catch(() => false));
    check(`${device} E puts the caret in the note`, await outcome.getByRole("textbox", { name: "What happened" }).evaluate((field) => field === document.activeElement).catch(() => false));
    check(`${device} E takes effect at once with Undo`, await page.getByText("Task done.").first().isVisible().catch(() => false));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(700);
    check(`${device} Esc with nothing typed leaves the task done`, (await row.count()) === 0);
    await page.keyboard.press("z");
    await page.waitForTimeout(900);
    check(`${device} Z brings it back`, (await row.count()) === 1);
    await row.locator("button[aria-expanded]").first().click({ position: { x: 3, y: 8 } });
    await page.waitForTimeout(1200);
    const teams = (await row.locator('a:visible[href^="msteams:"], a:visible[href^="tel:"]').first().getAttribute("href").catch(() => null)) ?? "";
    check(`${device} Call opens Teams on desktop`, teams.startsWith("msteams:"), teams);
  } else if (width === 1280) check(`${device} keyboard outcome checks ran`, false, "set CRM_AGENT_TOKEN so the sweep can add a task");

  if (width === 1280) {
    const block = await seedBlock(page, "desk");
    if (block) {
      try {
        await goto(page, `${base}/calendar?date=${block.day}&view=week`);
        await page.waitForTimeout(1500);
        const menu = page.getByRole("complementary", { name: "Calendars and tasks" });
        check(`${device} calendar menu has Calendars and Tasks`, (await menu.getByRole("button", { name: /^Calendars/ }).isVisible()) && (await menu.getByRole("button", { name: /^Tasks/ }).isVisible()));
        const card = page.locator(`[data-task-block="${block.id}"]`).filter({ visible: true });
        check(`${device} the week shows the task block`, await card.isVisible().catch(() => false));
        check(`${device} a 30 minute block shows a second line with its duration`, ((await card.locator("[data-task-detail]").textContent().catch(() => "")) ?? "").includes("30m"));
        check(`${device} the menu lists the task`, await menu.locator(`[data-task-id="${block.id}"]`).isVisible().catch(() => false));
        console.log(`skip ${device} clash (the sweep can't add a calendar event offline; covered in tests/task-blocks.test.ts)`);
        console.log(`skip ${device} another workspace's block (the sweep's user and agent token share one workspace; covered in tests/task-blocks.test.ts)`);
        await page.screenshot({ path: path.join(out, `desktop-${width}-calendar.png`) });
        await card.locator("button[data-task-id]").click();
        await page.waitForTimeout(900);
        const panel = page.getByRole("dialog", { name: "Task" });
        check(`${device} a block opens its own task in the panel`, (await panel.isVisible().catch(() => false)) && ((await panel.textContent()) ?? "").includes(block.title));
        await page.keyboard.press("Escape");
        await page.waitForTimeout(600);
        check(`${device} Esc returns focus to the block`, (await focusedTaskId(page)) === block.id);
        await page.getByRole("button", { name: /^Hide calendars and tasks/ }).click();
        await page.waitForTimeout(400);
        check(`${device} the toolbar button hides the menu`, !(await menu.isVisible().catch(() => false)));
        await page.getByRole("button", { name: /^Show calendars and tasks/ }).click();
      } finally {
        await dropTasks(block.ids);
      }
    } else check(`${device} calendar block checks ran`, false, "set CRM_AGENT_TOKEN so the sweep can add a task");
  }

  await context.close();
}

if (sweepTask) await api(`/tasks/${sweepTask.id}`, { method: "DELETE" });
for (const id of sweepCallTasks) if (id) await api(`/tasks/${id}`, { method: "DELETE" });
for (const id of sweepContacts) await api(`/contacts/${id}`, { method: "DELETE" });

check("the browser stayed on this machine", blocked.size === 0, [...blocked].join(", "));
console.log(problems.length ? `\n${problems.length} problems. Screenshots are in ${out}` : `\nall checks passed. Screenshots are in ${out}`);
await browser.close();
process.exit(problems.length ? 1 : 0);
