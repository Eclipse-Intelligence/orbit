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
  const add = async (title, dueAt, durationMinutes = 30) => {
    const created = await api("/tasks", { method: "POST", body: JSON.stringify({ title, dueAt, durationMinutes, ownerId: mine.ownerId }) });
    return created?.ok ? (await created.json()).task.id : null;
  };
  const day = londonDay(1);
  const title = `Sweep block ${stamp}`;
  const id = await add(title, `${day}T10:00`);
  const overdueDay = londonDay(-1);
  const overdueId = await add(`Sweep overdue ${stamp}`, `${overdueDay}T10:00`);
  const created = await api("/tasks", { method: "POST", body: JSON.stringify({ title: `Sweep plain ${stamp}`, ownerId: mine.ownerId, companyId: null, contactId: null, opportunityId: null }) });
  const plainId = created?.ok ? (await created.json()).task.id : null;
  const earlyId = await add(`Sweep early ${stamp}`, `${day}T08:00`, 15);
  const stacked = [];
  for (const time of ["09:00", "09:15", "09:30"]) stacked.push(await add(`Sweep stacked ${time} ${stamp}`, `${day}T${time}`, 15));
  const ids = [id, overdueId, plainId, earlyId, ...stacked].filter(Boolean);
  if (!id || !overdueId || !plainId || !earlyId || stacked.some((item) => !item)) {
    await dropTasks(ids);
    return null;
  }
  return { id, title, day, overdueId, overdueDay, plainId, earlyId, stacked, ids };
}

async function dropTasks(ids) {
  for (const id of ids) await api(`/tasks/${id}`, { method: "DELETE" });
}

async function readTask(id) {
  const found = await api(`/tasks/${id}`);
  return found?.ok ? (await found.json()).task : null;
}

function londonClock(iso) {
  return iso ? new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso)) : "";
}

function timing(task) {
  return task ? `${task.dueDate} ${task.dueHasTime ? londonClock(task.dueAt) : "no time"} ${task.durationMinutes}m ${task.scheduledBy ?? "unplaced"}` : "missing";
}

async function gridPoint(page, day, minutes) {
  return page.evaluate(
    ({ day, minutes }) => {
      const scroller = [...document.querySelectorAll("[data-calendar-scroller]")].find((node) => node.getBoundingClientRect().width > 0);
      const column = scroller?.querySelector(`[data-day="${day}"]`);
      if (!column) return null;
      const box = column.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + (minutes / 1440) * box.height };
    },
    { day, minutes },
  );
}

async function mouseDrag(page, from, to, hold) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let step = 1; step <= 12; step += 1) {
    await page.mouse.move(from.x + ((to.x - from.x) * step) / 12, from.y + ((to.y - from.y) * step) / 12);
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(150);
  const seen = hold ? await hold() : null;
  await page.mouse.up();
  await page.waitForTimeout(300);
  return seen;
}

async function touchDrag(page, selector, to, options = {}) {
  return page
    .evaluate(
      async ({ selector, to, holdMs, fromTop, quick, reveal }) => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const element = [...document.querySelectorAll(selector)].find((node) => node.getBoundingClientRect().width > 0);
        if (!element) return null;
        if (reveal) {
          element.scrollIntoView({ block: "nearest" });
          await sleep(150);
        }
        const box = element.getBoundingClientRect();
        const from = { x: box.left + Math.min(60, box.width / 2), y: fromTop ? box.top + 6 : box.top + box.height / 2 };
        const touchEvent = (type, element, id, x, y) => {
          const point = { identifier: id, target: element, clientX: x, clientY: y, pageX: x, pageY: y };
          let touch = point;
          try {
            touch = new Touch(point);
          } catch {}
          const touches = type === "touchend" ? [] : [touch];
          try {
            return new TouchEvent(type, { touches, changedTouches: [touch], bubbles: true, cancelable: true });
          } catch {
            const event = new Event(type, { bubbles: true, cancelable: true });
            Object.defineProperty(event, "touches", { value: touches });
            Object.defineProperty(event, "changedTouches", { value: [touch] });
            return event;
          }
        };
        const fire = (type, x, y) => element.dispatchEvent(touchEvent(type, element, 7, x, y));
        element.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 7, pointerType: "touch", isPrimary: true, clientX: from.x, clientY: from.y, bubbles: true, cancelable: true }));
        fire("touchstart", from.x, from.y);
        if (quick) {
          await sleep(80);
          fire("touchend", from.x, from.y);
          await sleep(500);
          return { lifted: Boolean(document.querySelector("[data-task-lifted-card]")) };
        }
        await sleep(120);
        const ring = Boolean(document.querySelector(".animate-press-fill"));
        await sleep(holdMs);
        const target = to ?? { x: from.x, y: from.y };
        for (let step = 1; step <= 12; step += 1) {
          fire("touchmove", from.x + ((target.x - from.x) * step) / 12, from.y + ((target.y - from.y) * step) / 12);
          await sleep(20);
        }
        await sleep(200);
        const label = document.querySelector("[data-drop-label]")?.textContent ?? "";
        const lifted = Boolean(document.querySelector("[data-task-lifted-card]"));
        const drawerOpen = [...document.querySelectorAll('[role="dialog"][data-state="open"]')].some((node) => (node.textContent ?? "").includes("Choose which calendars"));
        fire("touchend", target.x, target.y);
        const clicked = element.isConnected;
        if (clicked) element.click();
        await sleep(300);
        return { ring, drawerOpen, label, lifted, clicked };
      },
      { selector, to, holdMs: options.holdMs ?? 450, fromTop: options.fromTop ?? false, quick: options.quick ?? false, reveal: options.reveal ?? false },
    )
    .catch((error) => ({ error: String(error).slice(0, 120) }));
}

async function stackedHits(page, ids) {
  return page.evaluate((ids) => {
    const owner = (x, y) => document.elementFromPoint(x, y)?.closest("[data-task-block]")?.getAttribute("data-task-block") ?? null;
    const wrong = [];
    for (const id of ids) {
      const box = [...document.querySelectorAll(`[data-task-block="${id}"]`)].find((node) => node.getBoundingClientRect().width > 0)?.getBoundingClientRect();
      if (!box) return { wrong: [`${id} missing`] };
      for (const x of [box.left + 30, box.left + box.width / 2, box.right - 6])
        for (const y of [box.top + 2, box.top + box.height / 2, box.bottom - 2]) if (owner(x, y) !== id) wrong.push(`${id.slice(0, 4)}@${Math.round(x)},${Math.round(y)}=${owner(x, y)?.slice(0, 4)}`);
    }
    const last = [...document.querySelectorAll(`[data-task-block="${ids.at(-1)}"]`)].find((node) => node.getBoundingClientRect().width > 0).getBoundingClientRect();
    for (const x of [last.left + 30, last.right - 6]) for (const below of [3, 8, 13]) if (owner(x, last.bottom + below)) wrong.push(`below ${below}px`);
    return { wrong };
  }, ids);
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
    await call.evaluate((link) => link.scrollIntoView({ block: "center" })).catch(() => undefined);
    await page.waitForTimeout(300);
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
  if (device === "iphone") check(`${device} has no Plan`, !(await page.getByRole("button", { name: "Plan", exact: true }).isVisible().catch(() => false)));
  await goto(page, `${base}/settings/calendars`);
  await page.waitForTimeout(1200);
  const hoursList = page.getByRole("list", { name: "Working hours" });
  await hoursList.waitFor({ timeout: 10_000 }).catch(() => undefined);
  const workingDays = await hoursList.getByRole("switch", { checked: true }).count().catch(() => 0);
  const starts = await hoursList.getByRole("combobox", { name: / start$/ }).evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().left))).catch(() => []);
  check(`${device} working hours list every working day evenly`, starts.length > 0 && starts.length === workingDays && new Set(starts).size === 1, JSON.stringify(starts));
  check(`${device} working hours no overflow`, await noHorizontalScroll());
  await shot("working-hours");
  const learned = page.getByRole("region", { name: "Learned times" });
  await learned.scrollIntoViewIfNeeded().catch(() => undefined);
  const strips = learned.getByRole("img");
  check(`${device} learned times shows calls, emails and other`, (await learned.getByRole("listitem").count().catch(() => 0)) === 3 && (await strips.count().catch(() => 0)) === 3);
  const cells = await strips
    .first()
    .evaluate((strip) => [...strip.querySelectorAll("span[title]")].map((cell) => cell.getBoundingClientRect()).map((box) => ({ width: Math.round(box.width), height: Math.round(box.height) })))
    .catch(() => []);
  check(`${device} learned times strip shows 5 days of 20 half hours`, cells.length === 100 && cells.every((cell) => cell.width >= 6 && cell.height >= 10), JSON.stringify(cells[0] ?? null));
  check(`${device} learned times Reset`, await visible(learned.getByRole("button", { name: "Reset" })));
  check(`${device} learned times no overflow`, await noHorizontalScroll());
  await shot("learned-times");
  await goto(page, `${base}/calendar`);
  await page.waitForTimeout(800);
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
      if (device === "ipad") {
        console.log(`note ${device} the drag checks below use synthetic touch events, not a real iPad; check on an iPad before relying on them`);
        const synthetic = (name) => `${device} synthetic touch: ${name}`;
        await goto(page, `${base}/calendar?date=${block.day}&view=day`);
        await page.waitForTimeout(1500);
        const target = await gridPoint(page, block.day, 12 * 60 + 8);
        const lifted = await touchDrag(page, `[data-task-block="${block.id}"] button[data-task-id]`, target, { fromTop: true });
        check(synthetic("holding a block fills the ring, then lifts it"), Boolean(lifted && !lifted.error && lifted.ring && lifted.lifted), JSON.stringify(lifted));
        check(synthetic("the slot label shows the new time"), (lifted?.label ?? "").includes("12:00 to 12:30"), lifted?.label);
        await page.waitForTimeout(1200);
        const moved = await readTask(block.id);
        check(synthetic("long-press drag moves the block"), Boolean(moved?.dueHasTime && londonClock(moved.dueAt) === "12:00" && moved.durationMinutes === 30 && moved.scheduledBy === "person"), timing(moved));
        check(synthetic("the click after a drop doesn't open the task"), Boolean(lifted?.clicked) && !(await visible(page.getByRole("dialog", { name: "Task" }))), lifted?.clicked ? "" : "no click sent");
        await shot("calendar-long-press-drop");
        const quick = await touchDrag(page, `[data-task-block="${block.id}"] button[data-task-id]`, null, { quick: true });
        await page.waitForTimeout(600);
        check(synthetic("a quick touch on a block doesn't lift it"), Boolean(quick && !quick.error && !quick.lifted && londonClock((await readTask(block.id))?.dueAt) === "12:00"), JSON.stringify(quick));
        await page.getByRole("button", { name: "Calendars and tasks" }).tap();
        await page.waitForTimeout(700);
        const before = await readTask(block.plainId);
        const held = await touchDrag(page, `[role="dialog"] [data-task-id="${block.plainId}"]`, null, { reveal: true });
        await page.waitForTimeout(900);
        const after = await readTask(block.plainId);
        check(
          synthetic("holding a task in the drawer and letting go saves nothing and keeps the drawer"),
          Boolean(held && !held.error && held.drawerOpen && timing(after) === timing(before)),
          `${JSON.stringify(held)} ${timing(after)}`,
        );
        if (await visible(page.getByRole("dialog", { name: "Task" }))) {
          await page.getByRole("dialog", { name: "Task" }).getByRole("button", { name: "Close" }).tap();
          await page.waitForTimeout(600);
          await page.getByRole("button", { name: "Calendars and tasks" }).tap();
          await page.waitForTimeout(700);
        }
        const toGrid = await gridPoint(page, block.day, 15 * 60 + 8);
        const carried = await touchDrag(page, `[role="dialog"] [data-task-id="${block.plainId}"]`, toGrid, { reveal: true });
        await page.waitForTimeout(1200);
        check(synthetic("moving a held task out of the drawer closes it and carries the task onto the grid"), Boolean(carried && !carried.error && !carried.drawerOpen && carried.lifted), JSON.stringify(carried));
        const dropped = await readTask(block.plainId);
        check(synthetic("the carried task lands at its time"), Boolean(dropped?.dueHasTime && dropped.dueDate === block.day && londonClock(dropped.dueAt) === "15:00" && dropped.scheduledBy === "person"), timing(dropped));
        check(synthetic("the carried task shows as a block"), await visible(page.locator(`[data-task-block="${block.plainId}"]`).filter({ visible: true })));
        await goto(page, `${base}/calendar?date=${block.day}&view=day`);
        await page.waitForTimeout(1500);
        const hits = await stackedHits(page, block.stacked);
        check(`${device} back-to-back blocks each own their whole area, and nothing reaches below the last`, hits.wrong.length === 0, hits.wrong.slice(0, 4).join(" "));
        const middle = await page.locator(`[data-task-block="${block.stacked[1]}"]`).filter({ visible: true }).boundingBox();
        await page.touchscreen.tap(middle.x + middle.width - 6, middle.y + middle.height / 2);
        await page.waitForTimeout(900);
        const tapped = page.getByRole("dialog", { name: "Task" });
        check(`${device} tapping the corner of the middle back-to-back block opens that block`, ((await tapped.textContent().catch(() => "")) ?? "").includes("Sweep stacked 09:15"));
        if (await visible(tapped)) {
          await tapped.getByRole("button", { name: "Close" }).tap();
          await page.waitForTimeout(600);
        }
        const stackedBefore = await Promise.all(block.stacked.map((id) => readTask(id).then(timing)));
        const corner = await touchDrag(page, `[data-task-block="${block.stacked[1]}"] [data-task-resize]`, null, { holdMs: 300 });
        await page.waitForTimeout(900);
        const stackedAfter = await Promise.all(block.stacked.map((id) => readTask(id).then(timing)));
        check(synthetic("holding the middle block's corner and letting go changes nothing"), Boolean(corner && !corner.error) && stackedAfter.join() === stackedBefore.join(), `${JSON.stringify(corner)} ${stackedAfter.join(", ")}`);
        if (await visible(page.getByRole("dialog", { name: "Task" }))) {
          await page.getByRole("dialog", { name: "Task" }).getByRole("button", { name: "Close" }).tap();
          await page.waitForTimeout(600);
        }
        await goto(page, `${base}/calendar?date=${block.day}&view=day`);
        await page.waitForTimeout(1500);
        const earlyBefore = timing(await readTask(block.earlyId));
        const scrollBefore = await page.evaluate(() => [...document.querySelectorAll("[data-calendar-scroller]")].find((node) => node.getBoundingClientRect().width > 0)?.scrollTop ?? -1);
        const early = await touchDrag(page, `[data-task-block="${block.earlyId}"] button[data-task-id]`, null, { holdMs: 600 });
        await page.waitForTimeout(900);
        const scrollAfter = await page.evaluate(() => [...document.querySelectorAll("[data-calendar-scroller]")].find((node) => node.getBoundingClientRect().width > 0)?.scrollTop ?? -1);
        const earlyAfter = timing(await readTask(block.earlyId));
        check(
          synthetic("holding a block at the top edge, under the drop zone, and letting go changes nothing and doesn't scroll"),
          Boolean(early && !early.error) && earlyAfter === earlyBefore && scrollAfter === scrollBefore,
          `${earlyAfter}, scroll ${scrollBefore} to ${scrollAfter}`,
        );
        if (await visible(page.getByRole("dialog", { name: "Task" }))) {
          await page.getByRole("dialog", { name: "Task" }).getByRole("button", { name: "Close" }).tap();
          await page.waitForTimeout(600);
        }
        const scrolled = await page.evaluate(async () => {
          const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          const scroller = [...document.querySelectorAll("[data-calendar-scroller]")].find((node) => node.getBoundingClientRect().width > 0);
          const element = [...document.querySelectorAll("[data-task-block] button[data-task-id]")].find((node) => node.getBoundingClientRect().width > 0);
          if (!scroller || !element) return null;
          const area = scroller.getBoundingClientRect();
          const box = element.getBoundingClientRect();
          const touchEvent = (type, element, id, x, y) => {
            const point = { identifier: id, target: element, clientX: x, clientY: y, pageX: x, pageY: y };
            let touch = point;
            try {
              touch = new Touch(point);
            } catch {}
            const touches = type === "touchend" ? [] : [touch];
            try {
              return new TouchEvent(type, { touches, changedTouches: [touch], bubbles: true, cancelable: true });
            } catch {
              const event = new Event(type, { bubbles: true, cancelable: true });
              Object.defineProperty(event, "touches", { value: touches });
              Object.defineProperty(event, "changedTouches", { value: [touch] });
              return event;
            }
          };
          const fire = (type, x, y) => element.dispatchEvent(touchEvent(type, element, 9, x, y));
          const x = box.left + 20;
          element.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 9, pointerType: "touch", isPrimary: true, clientX: x, clientY: box.top + 4, bubbles: true, cancelable: true }));
          fire("touchstart", x, box.top + 4);
          await sleep(450);
          const before = scroller.scrollTop;
          fire("touchmove", x, area.bottom - 8);
          await sleep(150);
          const edge = Boolean(document.querySelector('[data-drag-edge="bottom"]'));
          await sleep(250);
          const after = scroller.scrollTop;
          fire("touchmove", x, area.top - 40);
          await sleep(100);
          fire("touchend", x, area.top - 40);
          return { before, after, edge };
        });
        check(synthetic("dragging to the grid's bottom edge scrolls it"), Boolean(scrolled && scrolled.after > scrolled.before && scrolled.edge), JSON.stringify(scrolled));
      }
      if (device === "ipad") {
        await goto(page, `${base}/calendar`);
        await page.waitForTimeout(1200);
        const planButton = page.getByRole("button", { name: "Plan", exact: true });
        check(`${device} shows Plan next to Day and Week`, await planButton.isVisible().catch(() => false));
        await planButton.tap({ timeout: 5_000 }).catch(() => undefined);
        const planPanel = page.getByRole("complementary", { name: "Plan" });
        await planPanel.getByText(/^Placed/).first().waitFor({ timeout: 25_000 }).catch(() => undefined);
        check(`${device} Plan opens its preview`, await planPanel.isVisible().catch(() => false));
        const firstEntry = await planPanel.locator("[data-plan-entry]").first().getAttribute("data-plan-entry").catch(() => null);
        check(`${device} Plan proposes a block`, Boolean(firstEntry));
        if (firstEntry) await page.locator(`[data-task-proposed][data-task-block="${firstEntry}"]`).first().scrollIntoViewIfNeeded().catch(() => undefined);
        check(`${device} the proposal shows on the grid`, Boolean(firstEntry) && (await page.locator(`[data-task-proposed][data-task-block="${firstEntry}"]`).filter({ visible: true }).first().isVisible().catch(() => false)));
        check(`${device} Plan preview no overflow`, await noHorizontalScroll());
        await shot("calendar-plan");
        await planPanel.getByRole("button", { name: "Cancel", exact: true }).tap({ timeout: 5_000 }).catch(() => undefined);
        await page.waitForTimeout(500);
        check(`${device} Cancel closes the plan`, !(await planPanel.isVisible().catch(() => false)) && (await page.locator("[data-task-proposed]").count()) === 0);
      }
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
        await page.getByRole("button", { name: "Plan", exact: true }).click({ timeout: 5_000 }).catch(() => undefined);
        const planPanel = page.getByRole("complementary", { name: "Plan" });
        await planPanel.getByText(/^Placed/).first().waitFor({ timeout: 25_000 }).catch(() => undefined);
        check(`${device} Plan replaces the left menu with its preview`, (await planPanel.isVisible().catch(() => false)) && !(await menu.isVisible().catch(() => false)));
        const proposedPlain = planPanel.locator(`[data-plan-entry="${block.plainId}"]`);
        check(`${device} Plan proposes the task with no date`, await proposedPlain.isVisible().catch(() => false));
        check(`${device} proposals show dashed on the grid`, await page.locator(`[data-task-proposed][data-task-block="${block.plainId}"]`).filter({ visible: true }).first().isVisible().catch(() => false));
        check(`${device} Plan leaves a block placed by hand alone`, (await planPanel.locator(`[data-plan-entry="${block.id}"]`).count()) === 0 && (await card.isVisible().catch(() => false)));
        const overdueCard = planPanel.locator(`[data-plan-overdue="${block.overdueId}"]`);
        check(
          `${device} Plan lists the overdue task with Move and Leave`,
          (await overdueCard.getByRole("button", { name: "Move", exact: true }).isVisible().catch(() => false)) && (await overdueCard.getByRole("button", { name: "Leave", exact: true }).isVisible().catch(() => false)),
        );
        await overdueCard.getByRole("button", { name: "Leave", exact: true }).click({ timeout: 5_000 }).catch(() => undefined);
        check(`${device} Leave offers Undo`, await overdueCard.getByRole("button", { name: "Undo", exact: true }).isVisible().catch(() => false));
        await overdueCard.getByRole("button", { name: "Undo", exact: true }).click({ timeout: 5_000 }).catch(() => undefined);
        check(`${device} Plan preview no overflow`, await page.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1));
        const apply = planPanel.getByRole("button", { name: "Apply", exact: true });
        const applyBox = await apply.boundingBox();
        const applyHit = applyBox ? await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("button")?.textContent ?? "", { x: applyBox.x + applyBox.width / 2, y: applyBox.y + applyBox.height / 2 }) : "";
        check(`${device} Apply isn't covered by quick add or Ask Orbit`, applyHit.includes("Apply"), applyHit);
        await page.screenshot({ path: path.join(out, `desktop-${width}-plan.png`) });
        const before = (await planPanel.locator("[data-plan-entry]").count());
        await proposedPlain.getByRole("button", { name: /^Remove .* from the plan$/ }).click({ timeout: 5_000 }).catch(() => undefined);
        await page.waitForTimeout(300);
        check(`${device} a proposal can be removed`, (await planPanel.locator("[data-plan-entry]").count()) === before - 1);
        await planPanel.getByRole("button", { name: "Cancel", exact: true }).click({ timeout: 5_000 }).catch(() => undefined);
        await page.waitForTimeout(500);
        check(`${device} Cancel discards the preview`, !(await planPanel.isVisible().catch(() => false)) && (await page.locator("[data-task-proposed]").filter({ visible: true }).count()) === 0 && (await menu.isVisible().catch(() => false)));
        check(`${device} the preview wrote nothing`, (await readTask(block.plainId))?.dueAt === null);
        await page.getByRole("button", { name: /^Hide calendars and tasks/ }).click();
        await page.waitForTimeout(400);
        check(`${device} the toolbar button hides the menu`, !(await menu.isVisible().catch(() => false)));
        await page.getByRole("button", { name: /^Show calendars and tasks/ }).click();
        await page.waitForTimeout(500);
        const plainRow = menu.locator(`[data-task-id="${block.plainId}"]`);
        await plainRow.scrollIntoViewIfNeeded().catch(() => undefined);
        const rowBox = await plainRow.boundingBox();
        const slot = await gridPoint(page, block.day, 14 * 60 + 5);
        const fromList =
          rowBox && slot
            ? await mouseDrag(page, { x: rowBox.x + 40, y: rowBox.y + rowBox.height / 2 }, slot, async () => {
                const seen = {
                  slot: await page.locator("[data-drop-slot]").isVisible().catch(() => false),
                  label: (await page.locator("[data-drop-label]").textContent().catch(() => "")) ?? "",
                  held: (await plainRow.getAttribute("data-task-held").catch(() => null)) !== null,
                  lifted: await page.locator("[data-task-lifted-card]").isVisible().catch(() => false),
                };
                await page.screenshot({ path: path.join(out, `desktop-${width}-drag-from-list.png`) });
                return seen;
              })
            : null;
        check(`${device} dragging a task shows the slot, its time and a placeholder in the list`, Boolean(fromList?.slot && fromList.held && fromList.lifted && fromList.label.includes("14:00 to 14:15")), JSON.stringify(fromList));
        const plainBlock = page.locator(`[data-task-block="${block.plainId}"]`).filter({ visible: true });
        check(`${device} a task dropped on the grid shows as a block at once`, await plainBlock.isVisible().catch(() => false));
        check(`${device} a drop doesn't open the task or a new event`, (await page.getByRole("dialog").filter({ visible: true }).count()) === 0);
        await page.waitForTimeout(1500);
        const listed = await readTask(block.plainId);
        check(`${device} the drop gives the task its day, time and duration, placed by you`, Boolean(listed?.dueHasTime && listed.dueDate === block.day && londonClock(listed.dueAt) === "14:00" && listed.durationMinutes === 15 && listed.scheduledBy === "person"), timing(listed));
        const hourDown = (await gridPoint(page, block.day, 11 * 60)).y - (await gridPoint(page, block.day, 10 * 60)).y;
        const blockBox = await card.boundingBox();
        const from = { x: blockBox.x + blockBox.width / 2, y: blockBox.y + 8 };
        const to = { x: from.x, y: from.y + hourDown };
        const moving = await mouseDrag(page, from, to, async () => ({
          ghost: await card.getAttribute("data-task-lifted").then((value) => value !== null).catch(() => false),
          label: (await page.locator("[data-drop-label]").textContent().catch(() => "")) ?? "",
        }));
        check(`${device} moving a block ghosts it and shows the new time`, Boolean(moving?.ghost && moving.label.includes("11:00 to 11:30")), JSON.stringify(moving));
        await page.waitForTimeout(1500);
        const moved = await readTask(block.id);
        check(`${device} a moved block keeps its duration`, Boolean(moved?.dueHasTime && londonClock(moved.dueAt) === "11:00" && moved.durationMinutes === 30), timing(moved));
        await card.hover();
        const edge = await card.locator("[data-task-resize]").boundingBox();
        const end = await gridPoint(page, block.day, 12 * 60 + 2);
        const resizing =
          edge && end
            ? await mouseDrag(page, { x: edge.x + edge.width / 2, y: edge.y + edge.height / 2 }, { x: edge.x + edge.width / 2, y: end.y }, async () => {
                await page.screenshot({ path: path.join(out, `desktop-${width}-resize.png`) });
                return (await page.locator("[data-drop-label]").textContent().catch(() => "")) ?? "";
              })
            : null;
        check(`${device} resizing shows the new duration first`, (resizing ?? "").startsWith("1h") && (resizing ?? "").includes("11:00 to 12:00"), resizing ?? "no handle");
        await page.waitForTimeout(1500);
        const resized = await readTask(block.id);
        check(`${device} resizing changes the duration in 15 minute steps`, resized?.durationMinutes === 60 && londonClock(resized.dueAt) === "11:00", timing(resized));
        await card.hover();
        await card.locator("[data-task-resize]").click();
        await page.waitForTimeout(900);
        const handlePanel = page.getByRole("dialog", { name: "Task" });
        check(`${device} clicking the resize handle opens the task`, await handlePanel.isVisible().catch(() => false));
        await page.keyboard.press("Escape");
        await page.waitForTimeout(600);
        const cardBox = await card.boundingBox();
        const menuBox = await menu.boundingBox();
        const back =
          cardBox && menuBox
            ? await mouseDrag(page, { x: cardBox.x + 30, y: cardBox.y + 10 }, { x: menuBox.x + menuBox.width / 2, y: menuBox.y + Math.min(240, menuBox.height / 2) }, async () => {
                const zone = page.locator("[data-task-drop-zone]").filter({ visible: true }).first();
                const seen = { zone: await zone.isVisible().catch(() => false), text: (await zone.textContent().catch(() => "")) ?? "" };
                await page.screenshot({ path: path.join(out, `desktop-${width}-drop-on-list.png`) });
                return seen;
              })
            : null;
        check(`${device} dragging a block over the list says the day stays`, Boolean(back?.zone && back.text.includes("Keep the day, remove the time")), JSON.stringify(back));
        await page.waitForTimeout(1500);
        const unplaced = await readTask(block.id);
        check(`${device} a block dropped on the list is date only on the same day`, Boolean(unplaced && !unplaced.dueHasTime && unplaced.dueDate === block.day && unplaced.scheduledBy === null), timing(unplaced));
        check(`${device} the block leaves the grid`, !(await card.isVisible().catch(() => false)));
        await page.getByRole("button", { name: /^Hide calendars and tasks/ }).click();
        await page.waitForTimeout(500);
        const early = page.locator(`[data-task-block="${block.earlyId}"]`).filter({ visible: true });
        const earlyBox = await early.boundingBox();
        const earlyBefore = timing(await readTask(block.earlyId));
        const scrollOf = () => page.evaluate(() => [...document.querySelectorAll("[data-calendar-scroller]")].find((node) => node.getBoundingClientRect().width > 0)?.scrollTop ?? -1);
        const scrollBefore = await scrollOf();
        if (earlyBox) {
          const spot = { x: earlyBox.x + earlyBox.width / 2, y: earlyBox.y + earlyBox.height / 2 };
          await page.mouse.move(spot.x, spot.y);
          await page.mouse.down();
          await page.mouse.move(spot.x + 3, spot.y - 4);
          await page.waitForTimeout(400);
          await page.mouse.up();
          await page.waitForTimeout(1200);
        }
        const earlyAfter = timing(await readTask(block.earlyId));
        check(`${device} a wobbly click on a block at the top edge, with the menu hidden, changes nothing and doesn't scroll`, Boolean(earlyBox) && earlyAfter === earlyBefore && (await scrollOf()) === scrollBefore, `${earlyAfter}, scroll ${scrollBefore} to ${await scrollOf()}`);
        check(`${device} the wobbly click opens the task, as a click would`, ((await page.getByRole("dialog", { name: "Task" }).textContent().catch(() => "")) ?? "").includes("Sweep early"));
        await page.keyboard.press("Escape");
        await page.waitForTimeout(500);
        const newEvent = page.getByRole("dialog", { name: "New event" });
        const shortDrag = async (locator, dy) => {
          const box = await locator.boundingBox();
          if (!box) return false;
          const spot = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
          await page.mouse.move(spot.x, spot.y);
          await page.mouse.down();
          for (let step = 1; step <= 4; step += 1) await page.mouse.move(spot.x, spot.y + (dy * step) / 4);
          await page.waitForTimeout(200);
          await page.mouse.up();
          await page.waitForTimeout(1000);
          return true;
        };
        const stackedFirst = page.locator(`[data-task-block="${block.stacked[0]}"]`).filter({ visible: true });
        const firstBefore = timing(await readTask(block.stacked[0]));
        const shortMoved = await shortDrag(stackedFirst, 6);
        check(
          `${device} a 6px drag of a block moves nothing, opens the task and never New event`,
          shortMoved && !(await newEvent.isVisible().catch(() => false)) && timing(await readTask(block.stacked[0])) === firstBefore && (await page.getByRole("dialog", { name: "Task" }).isVisible().catch(() => false)),
          timing(await readTask(block.stacked[0])),
        );
        await page.keyboard.press("Escape");
        await page.waitForTimeout(500);
        if (await newEvent.isVisible().catch(() => false)) await page.keyboard.press("Escape");
        await stackedFirst.hover();
        const shortResized = await shortDrag(stackedFirst.locator("[data-task-resize]"), 5);
        check(
          `${device} a 5px resize changes nothing and never opens New event`,
          shortResized && !(await newEvent.isVisible().catch(() => false)) && timing(await readTask(block.stacked[0])) === firstBefore,
          timing(await readTask(block.stacked[0])),
        );
        await page.keyboard.press("Escape");
        await page.waitForTimeout(500);
        if (await newEvent.isVisible().catch(() => false)) await page.keyboard.press("Escape");
        const earlyCard = page.locator(`[data-task-block="${block.earlyId}"]`).filter({ visible: true });
        await earlyCard.hover();
        const grip = await earlyCard.locator("[data-task-resize]").boundingBox();
        const resizeScroll = await scrollOf();
        if (grip) await mouseDrag(page, { x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 }, { x: grip.x + grip.width / 2, y: grip.y - 12 });
        await page.waitForTimeout(1000);
        const shrunk = await readTask(block.earlyId);
        check(`${device} shrinking an 08:00 block doesn't scroll the grid`, Boolean(grip) && (await scrollOf()) === resizeScroll && londonClock(shrunk?.dueAt) === "08:00" && shrunk?.durationMinutes === 15, `${timing(shrunk)}, scroll ${resizeScroll} to ${await scrollOf()}`);
        await page.keyboard.press("Escape");
        await page.waitForTimeout(400);
        const moveBox = await earlyCard.boundingBox();
        const moveScroll = await scrollOf();
        const headings = moveBox
          ? await mouseDrag(page, { x: moveBox.x + 30, y: moveBox.y + moveBox.height / 2 }, { x: moveBox.x + 30, y: moveBox.y + moveBox.height / 2 + 100 }, async () => {
              await page.screenshot({ path: path.join(out, `desktop-${width}-drop-bar.png`) });
              return page.evaluate(() => {
                const scroller = [...document.querySelectorAll("[data-calendar-scroller]")].find((node) => node.getBoundingClientRect().width > 0);
                const label = document.querySelector("[data-task-drop-zone] span[aria-hidden]");
                if (!scroller || !label) return { bar: false, covered: [] };
                const box = label.getBoundingClientRect();
                const covered = [...(scroller.previousElementSibling?.querySelectorAll("span") ?? [])]
                  .filter((span) => {
                    const own = span.getBoundingClientRect();
                    return own.width > 0 && own.left < box.right && own.right > box.left && own.top < box.bottom && own.bottom > box.top;
                  })
                  .map((span) => span.textContent);
                return { bar: true, covered };
              });
            })
          : null;
        check(`${device} with the menu hidden the drop bar shows and leaves every day heading readable`, Boolean(headings?.bar) && headings.covered.length === 0, JSON.stringify(headings));
        await page.waitForTimeout(1200);
        const lowered = await readTask(block.earlyId);
        check(
          `${device} dragging an 08:00 block down 100px moves it down without scrolling`,
          Boolean(moveBox) && (await scrollOf()) === moveScroll && londonClock(lowered?.dueAt) > "09:00",
          `${timing(lowered)}, scroll ${moveScroll} to ${await scrollOf()}`,
        );
        await page.getByRole("button", { name: /^Show calendars and tasks/ }).click();
        await page.waitForTimeout(400);
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
