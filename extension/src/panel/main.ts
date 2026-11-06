import type {
  CaptureRequest,
  CaptureResponse,
  DiffField,
  DiffRequest,
  DiffResponse,
  LogCheckResponse,
  LogRequest,
  LogResponse,
  LookupQuery,
  LookupResponse,
  MatchStatus,
  MeResponse,
  NoteResponse,
  PairRedeemResponse,
  PairStartResponse,
  PersonSummary,
  TaskResponse,
} from "../../../lib/extension/protocol";
import { call, lookup, OrbitError, readToken } from "../api";
import { LINKEDIN_URL, orbitHref, TOKEN_KEY, WORKSPACE_KEY } from "../config";
import type { BackgroundMessage, ReadReply } from "../messages";
import type { ReadResult, ReadWhat } from "../parsers";
import { classifyUrl, domainFrom, onLinkedin } from "../urls";
import { connectView, loadingView, readyView, waitingView, type Actions } from "./views";
import { currentLookup, currentWorkspace, initialStore, localDateTime, shortLocation, tagList, type Active, type Store } from "./state";

const DISCONNECTED = "This browser was disconnected from Orbit. Connect again.";

let s: Store = initialStore();
let sequence = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let flashTimer: ReturnType<typeof setTimeout> | null = null;
let focusForm = false;
const readCache = new Map<string, ReadResult>();

const root = document.getElementById("app")!;

function render() {
  const active = document.activeElement as HTMLElement | null;
  const focusId = active?.id || null;
  const scroll = root.querySelector(".body")?.scrollTop ?? 0;
  const view =
    s.phase === "loading" ? loadingView() : s.phase === "connect" ? connectView(s, actions) : s.phase === "waiting" ? waitingView(s, actions) : readyView(s, actions);
  root.replaceChildren(view);
  const body = root.querySelector(".body");
  if (body) body.scrollTop = scroll;
  if (focusForm) {
    focusForm = false;
    const target = root.querySelector<HTMLElement>("[data-autofocus]");
    target?.focus();
    target?.scrollIntoView({ block: "nearest" });
    return;
  }
  if (focusId) document.getElementById(focusId)?.focus();
}

function showFlash(message: string) {
  s.flash = message;
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    s.flash = null;
    render();
  }, 4000);
}

async function signOut(notice: string | null) {
  stopPolling();
  await chrome.storage.local.remove(TOKEN_KEY);
  const message: BackgroundMessage = { type: "orbit:signed-out" };
  void chrome.runtime.sendMessage(message).catch(() => undefined);
  s = { ...initialStore(), phase: "connect", connectNotice: notice };
  render();
}

async function handleError(error: unknown) {
  if (error instanceof OrbitError && error.status === 401) {
    await signOut(DISCONNECTED);
    return;
  }
  s.error = error instanceof Error ? error.message : "Something went wrong. Try again.";
  if (error instanceof OrbitError && error.code === "workspace_not_allowed") void loadMe(false);
  s.busy = false;
  render();
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

async function loadMe(refresh = true) {
  if (!s.token) return;
  try {
    const me = (await call<MeResponse>("/api/extension/me", { token: s.token })).data;
    s.me = me;
    const stored = (await chrome.storage.local.get(WORKSPACE_KEY))[WORKSPACE_KEY];
    const known = me.workspaces.some((item) => item.id === s.workspaceId);
    if (!known) s.workspaceId = me.workspaces.find((item) => item.id === stored)?.id ?? me.workspaces[0]?.id ?? null;
    s.phase = "ready";
    s.error = null;
    if (refresh) await refreshPage(true);
    else render();
  } catch (error) {
    if (error instanceof OrbitError && error.status === 401) {
      await signOut(DISCONNECTED);
      return;
    }
    s.phase = "ready";
    s.error = error instanceof Error ? error.message : "Couldn't reach Orbit.";
    render();
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readTab(tabId: number, what: ReadWhat): Promise<ReadResult | null> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const reply = (await chrome.tabs.sendMessage(tabId, { type: "orbit:read", what })) as ReadReply | undefined;
      return reply && reply.ok ? reply.result : null;
    } catch {
      await sleep(500);
    }
  }
  return null;
}

function emptyLookup(kind: LookupResponse["kind"]): LookupResponse {
  return {
    kind,
    url: null,
    workspaces: (s.me?.workspaces ?? []).map((item) => ({
      workspaceId: item.id,
      workspaceName: item.name,
      status: "none" as MatchStatus,
      matchedOn: null,
      person: null,
      company: null,
      candidates: [],
      presence: "Not in Orbit",
    })),
  };
}

function overall(result: LookupResponse | null): MatchStatus {
  if (!result) return "none";
  if (result.workspaces.some((item) => item.status === "in")) return "in";
  if (result.workspaces.some((item) => item.status === "maybe")) return "maybe";
  return "none";
}

function reportBadge() {
  if (s.tabId === null || !s.target.canonical) return;
  const message: BackgroundMessage = { type: "orbit:badge", tabId: s.tabId, url: s.target.canonical, status: overall(s.lookup) };
  void chrome.runtime.sendMessage(message).catch(() => undefined);
}

function defaultForm() {
  const workspace = currentWorkspace(s);
  const form: Record<string, string> = {
    owner: s.me?.user.id ?? "",
    tags: "",
    board: "",
    stage: "",
    "t.title": "",
    "t.due": "tomorrow",
    "t.remind": "0",
    "n.body": "",
    "m.direction": "received",
    "m.when": localDateTime(new Date()),
    "m.text": "",
  };
  const person = s.person;
  if (person) {
    form["p.firstName"] = person.firstName ?? "";
    form["p.lastName"] = person.lastName ?? "";
    form["p.jobTitle"] = person.jobTitle ?? "";
    form["p.company"] = person.companyName ?? "";
    form["p.location"] = shortLocation(person.location);
    form["p.linkedinUrl"] = person.linkedinUrl ?? (s.target.kind === "person" ? (s.target.canonical ?? "") : "");
    form["p.salesNavigatorUrl"] = person.salesNavigatorUrl ?? (s.target.kind === "lead" ? (s.target.canonical ?? "") : "");
    form["p.domain"] = "";
  } else if (s.target.kind === "person" || s.target.kind === "lead") {
    form["p.linkedinUrl"] = s.target.kind === "person" ? (s.target.canonical ?? "") : "";
    form["p.salesNavigatorUrl"] = s.target.kind === "lead" ? (s.target.canonical ?? "") : "";
  }
  const company = s.company;
  if (company || s.target.kind === "company") {
    form["c.name"] = company?.name ?? "";
    form["c.domain"] = domainFrom(company?.website) ?? "";
    form["c.lifecycle"] = workspace?.lifecycles[0]?.value ?? "lead";
  }
  const name = s.lookup ? currentLookup(s)?.person?.name ?? s.partner?.name : s.partner?.name;
  form["conv.title"] = name ? `LinkedIn messages with ${name}` : "LinkedIn messages";
  return form;
}

function whatFor(kind: Store["target"]["kind"]): ReadWhat | null {
  if (kind === "person") return "profile";
  if (kind === "lead") return "lead";
  if (kind === "company") return "company";
  if (kind === "conversation") return "thread-person";
  return null;
}

function lookupQuery(): LookupQuery | null {
  const target = s.target;
  if (!target.canonical) return null;
  if (target.kind === "person" || target.kind === "lead") {
    return {
      url: target.canonical,
      name: s.person?.name ?? undefined,
      company: s.person?.companyName ?? undefined,
      companyUrl: s.person?.companyLinkedinUrl ?? undefined,
    };
  }
  if (target.kind === "company") {
    return { url: target.canonical, name: s.company?.name ?? undefined, domain: domainFrom(s.company?.website) ?? undefined };
  }
  if (target.kind === "conversation" && s.partner?.profileUrl) return { url: s.partner.profileUrl, name: s.partner.name ?? undefined };
  return null;
}

async function activeTab() {
  const self = await chrome.tabs.getCurrent().catch(() => undefined);
  if (!self) return (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  const others = await chrome.tabs.query({ active: true });
  return others.find((item) => item.id !== self.id && item.windowId !== self.windowId && item.url);
}

async function refreshPage(force: boolean, delay = 0) {
  if (s.phase !== "ready" || !s.token) return;
  const tab = await activeTab();
  const target = classifyUrl(tab?.url, LINKEDIN_URL);
  const key = target.canonical ? `${target.kind}:${target.canonical}` : `other:${tab?.url ?? ""}`;
  const samePage = key === s.pageKey;
  if (samePage && !force) return;
  const run = ++sequence;
  s.tabId = tab?.id ?? null;
  s.tabUrl = tab?.url ?? null;
  s.target = target;
  s.error = null;
  if (!samePage) {
    s.pageKey = key;
    s.person = null;
    s.company = null;
    s.partner = null;
    s.readNote = null;
    s.lookup = null;
    s.lookupError = null;
    s.active = null;
    s.menu = null;
    s.editing = false;
    s.rejected = new Set();
    s.diff = null;
    s.conversation = null;
    s.lastLogged = null;
    s.flash = null;
  }
  const what = whatFor(target.kind);
  if (!what || s.tabId === null) {
    s.loadingPage = false;
    render();
    return;
  }
  s.loadingPage = true;
  render();
  let read = readCache.get(key) ?? null;
  if (!read) {
    if (delay) await sleep(delay);
    read = await readTab(s.tabId, what);
    if (run !== sequence) return;
    if (read) readCache.set(key, read);
  }
  if (read?.what === "profile" || read?.what === "lead") s.person = read.person;
  if (read?.what === "company") s.company = read.company;
  if (read?.what === "thread-person") s.partner = read.partner;
  if (!read) s.readNote = "Couldn't read this page. Reload the tab, or fill in the fields yourself.";
  const query = lookupQuery();
  try {
    const result = query ? await lookup(s.token, query) : emptyLookup(target.kind);
    if (run !== sequence) return;
    s.lookup = result;
    s.lookupError = null;
    if (!samePage) {
      const stored = (await chrome.storage.local.get(WORKSPACE_KEY))[WORKSPACE_KEY];
      const allowed = s.me?.workspaces ?? [];
      const found = result.workspaces.find((item) => item.status === "in" && allowed.some((workspace) => workspace.id === item.workspaceId));
      s.workspaceId = found?.workspaceId ?? allowed.find((item) => item.id === stored)?.id ?? allowed[0]?.id ?? null;
    }
  } catch (error) {
    if (run !== sequence) return;
    if (error instanceof OrbitError && error.status === 401) {
      await signOut(DISCONNECTED);
      return;
    }
    s.lookup = null;
    s.lookupError = error instanceof Error ? error.message : "Couldn't look this up in Orbit.";
  }
  if (!samePage || force) {
    const kept = samePage ? s.form : {};
    s.form = { ...defaultForm(), ...pick(kept, ["owner", "tags", "board", "stage"]) };
  }
  s.loadingPage = false;
  reportBadge();
  render();
  if (target.kind === "conversation") void loadLastLogged(run);
}

function pick(form: Record<string, string>, keys: string[]) {
  const out: Record<string, string> = {};
  for (const key of keys) if (form[key] !== undefined) out[key] = form[key];
  return out;
}

async function loadLastLogged(run: number) {
  const person = currentLookup(s)?.person;
  if (!person || !s.token) return;
  try {
    const result = await call<LogCheckResponse>("/api/extension/log/check", {
      token: s.token,
      workspaceId: s.workspaceId,
      body: { contactId: person.id, messages: [] },
    });
    if (run !== sequence) return;
    s.lastLogged = result.data.lastLogged;
    render();
  } catch {}
}

async function write<T>(path: string, body: unknown): Promise<T | null> {
  if (!s.token) return null;
  s.busy = true;
  s.error = null;
  render();
  try {
    const result = await call<T>(path, { token: s.token, workspaceId: s.workspaceId, body });
    s.busy = false;
    return result.data;
  } catch (error) {
    await handleError(error);
    return null;
  }
}

async function done(message: string) {
  s.active = null;
  s.diff = null;
  s.conversation = null;
  s.busy = false;
  showFlash(message);
  await refreshPage(true);
}

function stageFor(boardId: string, stageId: string) {
  if (!boardId) return null;
  const board = currentWorkspace(s)?.boards.find((item) => item.id === boardId);
  return stageId || board?.stages[0]?.id || null;
}

function due(value: string) {
  return value || null;
}

const actions: Actions = {
  render,
  async connect() {
    s.busy = true;
    s.connectNotice = null;
    render();
    try {
      const started = (await call<PairStartResponse>("/api/extension/pair", { body: {} })).data;
      s.pairing = started;
      s.phase = "waiting";
      s.busy = false;
      render();
      actions.openApproveTab();
      stopPolling();
      pollTimer = setInterval(() => void poll(), 2000);
    } catch (error) {
      s.busy = false;
      s.connectNotice = error instanceof Error ? error.message : "Couldn't reach Orbit.";
      render();
    }
  },
  openApproveTab() {
    if (!s.pairing) return;
    const navigatorData = navigator as Navigator & { userAgentData?: { platform?: string } };
    const platform = navigatorData.userAgentData?.platform || navigator.platform || "this computer";
    const name = `Chrome on ${platform}`;
    void chrome.tabs.create({ url: `${s.pairing.approveUrl}${s.pairing.approveUrl.includes("?") ? "&" : "?"}name=${encodeURIComponent(name)}` });
  },
  cancelPairing() {
    stopPolling();
    s.pairing = null;
    s.phase = "connect";
    render();
  },
  toggleMenu(menu) {
    s.menu = s.menu === menu ? null : menu;
    render();
  },
  chooseWorkspace(id) {
    s.workspaceId = id;
    s.menu = null;
    s.active = null;
    s.diff = null;
    s.conversation = null;
    s.error = null;
    s.form = { ...s.form, board: "", stage: "", owner: s.me?.user.id ?? "" };
    void chrome.storage.local.set({ [WORKSPACE_KEY]: id });
    render();
    if (s.target.kind === "conversation") void loadLastLogged(sequence);
  },
  openOrbit(path = "/") {
    s.menu = null;
    void chrome.tabs.create({ url: orbitHref(path) });
    render();
  },
  async disconnect() {
    s.menu = null;
    if (s.token) await call("/api/extension/revoke", { token: s.token, body: {} }).catch(() => undefined);
    await signOut(null);
  },
  setActive(active: Active) {
    s.active = s.active === active ? null : active;
    s.error = null;
    s.diff = null;
    focusForm = Boolean(s.active && s.active !== "update" && s.active !== "people");
    render();
    if (s.active === "update") void loadDiff();
  },
  setForm(key, value, rerender = false) {
    s.form[key] = value;
    if (rerender) render();
  },
  toggleEdit() {
    s.editing = !s.editing;
    render();
  },
  async savePerson() {
    const f = s.form;
    if (!f["p.firstName"] && !f["p.lastName"] && !f["p.linkedinUrl"]) {
      s.error = "Add a name first. Press Edit to fill it in.";
      render();
      return;
    }
    const domain = f["p.domain"]?.trim() ? (domainFrom(f["p.domain"]) ?? f["p.domain"].trim()) : null;
    const body: CaptureRequest = {
      kind: "person",
      person: {
        firstName: f["p.firstName"] || null,
        lastName: f["p.lastName"] || null,
        jobTitle: f["p.jobTitle"] || null,
        location: f["p.location"] || null,
        linkedinUrl: f["p.linkedinUrl"] || null,
        salesNavigatorUrl: f["p.salesNavigatorUrl"] || null,
      },
      company: f["p.company"] || domain ? { name: f["p.company"] || null, domain, linkedinUrl: s.person?.companyLinkedinUrl ?? null } : null,
      ownerId: f.owner || null,
      tags: tagList(f.tags),
      boardId: f.board || null,
      stageId: stageFor(f.board, f.stage),
      sourceUrl: s.target.canonical,
    };
    const result = await write<CaptureResponse>("/api/extension/capture", body);
    if (result) await done(`Saved to ${currentWorkspace(s)?.name ?? "Orbit"}.`);
  },
  async saveCompany() {
    const f = s.form;
    if (!f["c.name"]?.trim()) {
      s.error = "Enter the company name.";
      render();
      return;
    }
    const body: CaptureRequest = {
      kind: "company",
      company: {
        name: f["c.name"].trim(),
        domain: f["c.domain"]?.trim() ? (domainFrom(f["c.domain"]) ?? f["c.domain"].trim()) : null,
        linkedinUrl: s.target.kind === "company" ? s.target.canonical : null,
        industry: s.company?.industry ?? null,
        sizeCategory: s.company?.sizeCategory ?? null,
        description: s.company?.tagline ?? null,
      },
      lifecycle: f["c.lifecycle"] || null,
      ownerId: f.owner || null,
      tags: tagList(f.tags),
      boardId: f.board || null,
      stageId: stageFor(f.board, f.stage),
      sourceUrl: s.target.canonical,
    };
    const result = await write<CaptureResponse>("/api/extension/capture", body);
    if (result) await done(`Saved to ${currentWorkspace(s)?.name ?? "Orbit"}.`);
  },
  async confirmMatch(candidate: PersonSummary) {
    const body: CaptureRequest = {
      kind: "link",
      contactId: candidate.id,
      linkedinUrl: s.target.kind === "person" ? s.target.canonical : (s.person?.linkedinUrl ?? null),
      salesNavigatorUrl: s.target.kind === "lead" ? s.target.canonical : null,
      sourceUrl: s.target.canonical,
    };
    const result = await write<CaptureResponse>("/api/extension/capture", body);
    if (result) await done(`Saved on ${candidate.name}'s record.`);
  },
  rejectMatch(candidate: PersonSummary) {
    s.rejected.add(candidate.id);
    render();
  },
  async addTask(contactId, companyId) {
    const title = s.form["t.title"]?.trim();
    if (!title) {
      s.error = "Enter a task.";
      render();
      return;
    }
    const remind = s.form["t.remind"];
    const result = await write<TaskResponse>("/api/extension/task", {
      title,
      due: due(s.form["t.due"]),
      remindMinutes: remind === "none" || remind === undefined ? null : Number(remind),
      contactId,
      companyId,
    });
    if (result) await done("Task added.");
  },
  async addNote(contactId, companyId) {
    const body = s.form["n.body"]?.trim();
    if (!body) {
      s.error = "Write the note first.";
      render();
      return;
    }
    const result = await write<NoteResponse>("/api/extension/note", { body, contactId, companyId });
    if (result) await done("Note added.");
  },
  async logMessage(contactId) {
    const text = s.form["m.text"]?.trim();
    if (!text) {
      s.error = "Paste or type the message.";
      render();
      return;
    }
    const when = s.form["m.when"] ? new Date(s.form["m.when"]) : null;
    const body: LogRequest = {
      kind: "message",
      contactId,
      direction: s.form["m.direction"] === "sent" ? "sent" : "received",
      occurredAt: when && !Number.isNaN(when.getTime()) ? when.toISOString() : null,
      text,
    };
    const result = await write<LogResponse>("/api/extension/log", body);
    if (result) await done("Message logged.");
  },
  toggleDiff(field: DiffField, on: boolean) {
    if (on) s.diffTicks.add(field);
    else s.diffTicks.delete(field);
    render();
  },
  async applyDiff() {
    const request = diffRequest();
    if (!request) return;
    const apply = [...s.diffTicks];
    const result = await write<DiffResponse>("/api/extension/diff", { ...request, apply });
    if (result) await done(apply.length === 1 ? "Updated 1 field." : `Updated ${apply.length} fields.`);
  },
  async readConversation() {
    const person = currentLookup(s)?.person;
    if (s.tabId === null || !person || !s.token) return;
    s.busy = true;
    render();
    const read = await readTab(s.tabId, "thread");
    const messages = read?.what === "thread" ? read.thread.messages : [];
    if (!read) {
      s.busy = false;
      s.error = "Couldn't read the messages. Reload the tab and try again.";
      render();
      return;
    }
    let checks: LogCheckResponse["messages"] = messages.map(() => ({ loggedAt: null, loggedLabel: null }));
    try {
      const checked = await call<LogCheckResponse>("/api/extension/log/check", {
        token: s.token,
        workspaceId: s.workspaceId,
        body: { contactId: person.id, messages },
      });
      checks = checked.data.messages;
      s.lastLogged = checked.data.lastLogged;
    } catch (error) {
      if (error instanceof OrbitError && error.status === 401) {
        await signOut(DISCONNECTED);
        return;
      }
    }
    s.conversation = {
      messages,
      checks,
      ticked: new Set(messages.map((_, index) => index).filter((index) => !checks[index]?.loggedAt)),
      readAt: new Date().toISOString(),
    };
    s.form["conv.title"] = `LinkedIn messages with ${person.name}`;
    s.busy = false;
    render();
  },
  toggleMessage(index, on) {
    if (!s.conversation) return;
    if (on) s.conversation.ticked.add(index);
    else s.conversation.ticked.delete(index);
    render();
  },
  async logConversation(contactId) {
    const conversation = s.conversation;
    if (!conversation) return;
    const messages = conversation.messages.filter((_, index) => conversation.ticked.has(index) && !conversation.checks[index]?.loggedAt);
    if (messages.length === 0) return;
    const body: LogRequest = {
      kind: "conversation",
      contactId,
      title: s.form["conv.title"]?.trim() || null,
      threadUrl: s.target.canonical,
      messages,
    };
    const result = await write<LogResponse>("/api/extension/log", body);
    if (result) await done(result.logged === 1 ? "Logged 1 message." : `Logged ${result.logged} messages.`);
  },
  cancelConversation() {
    s.conversation = null;
    render();
  },
  openLinkedin(url) {
    void chrome.tabs.create({ url: onLinkedin(url, LINKEDIN_URL) });
  },
  retry() {
    readCache.delete(s.pageKey ?? "");
    void refreshPage(true);
  },
};

function diffRequest(): DiffRequest | null {
  const wl = currentLookup(s);
  if (s.target.kind === "company" && wl?.company) {
    return { companyId: wl.company.id, company: s.company ?? { name: null, tagline: null, website: null, industry: null, sizeCategory: null, location: null, linkedinUrl: s.target.canonical } };
  }
  if (wl?.person && s.person) return { contactId: wl.person.id, person: { ...s.person, location: shortLocation(s.person.location) || null } };
  if (wl?.person) {
    return {
      contactId: wl.person.id,
      person: {
        name: null,
        firstName: null,
        lastName: null,
        headline: null,
        jobTitle: null,
        location: null,
        linkedinUrl: s.target.kind === "person" ? s.target.canonical : null,
        salesNavigatorUrl: s.target.kind === "lead" ? s.target.canonical : null,
        companyName: null,
        companyLinkedinUrl: null,
      },
    };
  }
  return null;
}

async function loadDiff() {
  const request = diffRequest();
  if (!request || !s.token) return;
  try {
    const result = await call<DiffResponse>("/api/extension/diff", { token: s.token, workspaceId: s.workspaceId, body: request });
    if (s.active !== "update") return;
    s.diff = result.data;
    s.diffTicks = new Set(result.data.changes.filter((row) => row.changed).map((row) => row.field));
    render();
  } catch (error) {
    s.active = null;
    await handleError(error);
  }
}

document.addEventListener("click", (event) => {
  if (!s.menu) return;
  const target = event.target as Element | null;
  if (target?.closest(".menu-anchor")) return;
  s.menu = null;
  render();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && s.menu) {
    s.menu = null;
    render();
  }
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (!tab.active) return;
  if (changeInfo.url) void refreshPage(false, 900);
  else if (changeInfo.status === "complete") void refreshPage(false);
});

chrome.tabs.onActivated.addListener(() => {
  void refreshPage(false);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !(TOKEN_KEY in changes)) return;
  const next = changes[TOKEN_KEY].newValue;
  if (!next && s.token && s.phase === "ready") void signOut(DISCONNECTED);
});

async function poll() {
  if (!s.pairing) return;
  if (Date.parse(s.pairing.expiresAt) < Date.now()) {
    stopPolling();
    s.pairing = null;
    s.phase = "connect";
    s.connectNotice = "The code expired. Connect again.";
    render();
    return;
  }
  try {
    const result = await call<PairRedeemResponse>("/api/extension/pair/redeem", { body: { code: s.pairing.code, secret: s.pairing.secret } });
    if (result.data.status !== "approved") return;
    stopPolling();
    await chrome.storage.local.set({ [TOKEN_KEY]: result.data.token });
    s.token = result.data.token;
    s.pairing = null;
    s.phase = "loading";
    render();
    await loadMe(true);
  } catch (error) {
    if (error instanceof OrbitError && (error.status === 410 || error.status === 400 || error.status === 404)) {
      stopPolling();
      s.pairing = null;
      s.phase = "connect";
      s.connectNotice = error.message;
      render();
    }
  }
}

async function start() {
  render();
  s.token = await readToken();
  if (!s.token) {
    s.phase = "connect";
    render();
    return;
  }
  await loadMe(true);
}

void start();
