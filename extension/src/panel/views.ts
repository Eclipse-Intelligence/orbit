import type { CompanySummary, DiffField, PersonSummary, WorkspaceLookup } from "../../../lib/extension/protocol";
import { shortUrl } from "../urls";
import { cx, h, uid, type Child } from "./dom";
import { icon, type IconName } from "./icons";
import { clockTime, currentLookup, currentWorkspace, dueDate, firstNameOf, type Active, type Store } from "./state";
import {
  alert,
  areaField,
  button,
  card,
  checkbox,
  chips,
  facts,
  formActions,
  holdButton,
  initials,
  lifecycleColour,
  note,
  openInOrbit,
  quickActions,
  recordHead,
  recordTag,
  section,
  selectField,
  stack,
  status,
  textField,
  workspaceTile,
} from "./ui";

export type Actions = {
  render(): void;
  connect(): void;
  openApproveTab(): void;
  cancelPairing(): void;
  toggleMenu(menu: "workspace" | "more"): void;
  chooseWorkspace(id: string): void;
  openOrbit(path?: string): void;
  disconnect(): void;
  setActive(active: Active): void;
  setForm(key: string, value: string, rerender?: boolean): void;
  toggleEdit(): void;
  savePerson(): void;
  saveCompany(): void;
  confirmMatch(candidate: PersonSummary): void;
  confirmCompany(candidate: CompanySummary): void;
  rejectMatch(candidate: { id: string }): void;
  addTask(contactId: string | null, companyId: string | null): void;
  addNote(contactId: string | null, companyId: string | null): void;
  logMessage(contactId: string): void;
  toggleDiff(field: DiffField, on: boolean): void;
  applyDiff(): void;
  readConversation(): void;
  toggleMessage(index: number, on: boolean): void;
  logConversation(contactId: string): void;
  cancelConversation(): void;
  openLinkedin(url: string): void;
  retry(): void;
};

const PERSON_ACTIONS: { key: string; label: string; icon: IconName }[] = [
  { key: "task", label: "Add task", icon: "clipboard" },
  { key: "note", label: "Add note", icon: "note" },
  { key: "message", label: "Log message", icon: "mail" },
  { key: "update", label: "Update from page", icon: "refresh" },
];

const COMPANY_ACTIONS: { key: string; label: string; icon: IconName }[] = [
  { key: "task", label: "Add task", icon: "clipboard" },
  { key: "note", label: "Add note", icon: "note" },
  { key: "people", label: "People in Orbit", icon: "users" },
  { key: "update", label: "Update from page", icon: "refresh" },
];

const READS = [
  ["The page address", "To check if a person or company is in Orbit."],
  ["Name, headline, company and location", "Only while this panel is open, from the page you're on."],
  ["Thread header", "The name and profile link at the top of a message thread, while this panel is open."],
  ["Messages", "Only when you press Log this conversation."],
];

function readsList() {
  return section(
    "What it reads",
    [
      h(
        "ul",
        { class: "reads" },
        READS.map(([title, detail]) => h("li", null, h("span", null, title), h("span", { class: "caption subtle" }, detail))),
      ),
      note("Works on LinkedIn and Sales Navigator only. It never opens pages or clicks for you."),
    ],
  );
}

function shell(s: Store, a: Actions, body: Child[], footer?: Child[]) {
  return h(
    "div",
    { class: "panel" },
    header(s, a),
    s.flash ? h("div", { class: "flash" }, icon("check"), s.flash) : null,
    h("div", { class: "body" }, s.error ? alert(s.error) : null, body),
    footer ? h("div", { class: "footer" }, footer) : null,
  );
}

function header(s: Store, a: Actions) {
  const workspace = currentWorkspace(s);
  if (!workspace) return null;
  const menuOpen = s.menu === "workspace";
  const moreOpen = s.menu === "more";
  return h(
    "header",
    { class: "header" },
    h(
      "div",
      { class: "menu-anchor grow" },
      button(
        {
          variant: "ghost",
          size: "sm",
          className: cx("workspace-button", menuOpen && "is-open"),
          label: `Workspace: ${workspace.name}. Change workspace`,
          id: "workspace-menu-button",
          haspopup: true,
          expanded: menuOpen,
          onClick: () => a.toggleMenu("workspace"),
        },
        workspaceTile(workspace.id, workspace.name),
        h("span", { class: "ui truncate" }, workspace.name),
        icon("chevron", "icon icon-xs subtle"),
      ),
      menuOpen ? workspaceMenu(s, a) : null,
    ),
    h(
      "div",
      { class: "menu-anchor" },
      button(
        { variant: "ghost", size: "icon", label: "Orbit menu", id: "more-menu-button", haspopup: true, expanded: moreOpen, onClick: () => a.toggleMenu("more") },
        icon("more"),
      ),
      moreOpen
        ? h(
            "div",
            { class: "menu menu-right", role: "menu", "aria-label": "Orbit menu" },
            h("button", { type: "button", id: "menu-open-orbit", class: "menu-item ui", role: "menuitem", tabindex: "-1", onClick: () => a.openOrbit("/") }, "Open Orbit"),
            holdButton({ label: "Hold to disconnect", id: "menu-disconnect", className: "menu-item ui menu-item-danger", role: "menuitem", onConfirm: () => a.disconnect() }),
          )
        : null,
    ),
  );
}

function workspaceMenu(s: Store, a: Actions) {
  return h(
    "div",
    { class: "menu", role: "menu", "aria-label": "Workspaces" },
    h("p", { class: "caption subtle menu-title" }, "Save and look up in"),
    (s.me?.workspaces ?? []).map((item) => {
      const selected = item.id === s.workspaceId;
      const presence = s.lookup?.workspaces.find((entry) => entry.workspaceId === item.id)?.presence ?? null;
      return h(
        "button",
        {
          type: "button",
          id: `menu-workspace-${item.id}`,
          class: cx("menu-item ui", !selected && "menu-item-other"),
          role: "menuitemradio",
          tabindex: "-1",
          "aria-checked": String(selected),
          onClick: () => a.chooseWorkspace(item.id),
        },
        workspaceTile(item.id, item.name),
        h("span", { class: "menu-item-text" }, h("span", { class: "truncate" }, item.name), presence ? h("span", { class: "caption subtle" }, presence) : null),
        selected ? icon("check", "icon icon-sm") : null,
      );
    }),
  );
}

export function connectView(s: Store, a: Actions) {
  return h(
    "div",
    { class: "panel" },
    h(
      "div",
      { class: "body" },
      h(
        "div",
        { class: "connect" },
        icon("logo", "logo-mark"),
        h("h2", null, "Connect to Orbit"),
        h("p", { class: "subtle body-text" }, "Approve this browser in Orbit and choose its workspaces."),
        s.connectNotice ? alert(s.connectNotice) : null,
        button({ variant: "primary", size: "md", className: "wide tall", onClick: () => a.connect(), disabled: s.busy }, s.busy ? "Connecting" : "Connect"),
      ),
      readsList(),
    ),
  );
}

export function waitingView(s: Store, a: Actions) {
  return h(
    "div",
    { class: "panel" },
    h(
      "div",
      { class: "body" },
      h(
        "div",
        { class: "waiting" },
        status("wait", "Enter this code in Orbit", "Orbit opened in a new tab. Type this code there to approve this browser."),
        card(h("span", { class: "code", "aria-label": `Code ${s.pairing?.code ?? ""}` }, s.pairing?.code ?? ""), "code-card"),
        h(
          "div",
          { class: "row" },
          button({ variant: "secondary", size: "sm", onClick: () => a.openApproveTab() }, "Open the tab again"),
          button({ variant: "ghost", size: "sm", onClick: () => a.cancelPairing() }, "Cancel"),
        ),
        note("The code works for 10 minutes."),
      ),
    ),
  );
}

export function loadingView() {
  return h("div", { class: "panel" }, h("div", { class: "body" }, h("p", { class: "caption subtle" }, "Loading")));
}

function idleView(s: Store, a: Actions) {
  return shell(s, a, [
    status("new", "Nothing to look up here", "Open a LinkedIn profile, company page, Sales Navigator lead or message thread."),
  ]);
}

function pageLoading(s: Store, a: Actions) {
  return shell(s, a, [h("p", { class: "caption subtle" }, "Looking this up in Orbit")]);
}

function lookupFailed(s: Store, a: Actions) {
  return shell(s, a, [
    alert(s.lookupError ?? "Couldn't look this up in Orbit."),
    h("div", { class: "row" }, button({ variant: "secondary", size: "sm", onClick: () => a.retry() }, "Try again")),
  ]);
}

function otherWorkspaceHint(s: Store) {
  const elsewhere = s.lookup?.workspaces.find((item) => item.workspaceId !== s.workspaceId && item.status === "in");
  return elsewhere ? `In ${elsewhere.workspaceName}. Switch to see the record there.` : null;
}

function personMatchText(matchedOn: WorkspaceLookup["matchedOn"]) {
  if (matchedOn === "sales_navigator") return "Matched by Sales Navigator lead";
  if (matchedOn === "name") return "Matched by name and company";
  return "Matched by LinkedIn profile";
}

function companyMatchText(matchedOn: WorkspaceLookup["matchedOn"]) {
  if (matchedOn === "domain") return "Matched by domain";
  if (matchedOn === "name") return "Matched by name";
  return "Matched by LinkedIn page";
}

function dealValue(deal: PersonSummary["deal"]) {
  if (!deal) return null;
  return stack(deal.value ? `${deal.name} · ${deal.value}` : deal.name, [deal.board, deal.stage].filter(Boolean).join(", "));
}

function taskList(tasks: PersonSummary["tasks"]) {
  return h(
    "ul",
    { class: "tasks" },
    tasks.map((task) =>
      h(
        "li",
        null,
        h("span", { class: "truncate" }, task.title),
        task.dueLabel ? h("span", { class: cx("caption shrink-0", task.dueToday || task.overdue ? "warning" : "subtle") }, task.dueLabel) : null,
      ),
    ),
  );
}

function personLine(person: PersonSummary) {
  return [person.jobTitle, person.company?.name].filter(Boolean).join(" · ");
}

function personSummary(person: PersonSummary, compact: boolean) {
  if (compact) {
    const deal = person.deal ? [person.deal.name, person.deal.stage].filter(Boolean).join(", ") : null;
    const open = person.tasks.length ? `${person.tasks.length} open task${person.tasks.length === 1 ? "" : "s"}` : null;
    return card(recordHead({ initials: initials(person.name), name: person.name, lines: [personLine(person), [deal, open].filter(Boolean).join(" · ")] }));
  }
  const rows: { label: string; value: Child }[] = [];
  if (person.company)
    rows.push({
      label: "Company",
      value: h("span", { class: "inline-wrap" }, person.company.name, recordTag(person.company.lifecycleLabel, lifecycleColour(person.company.lifecycle))),
    });
  if (person.deal) rows.push({ label: "Deal", value: dealValue(person.deal) });
  if (person.lastContact)
    rows.push({ label: "Last contact", value: stack(h("span", { class: "truncate" }, person.lastContact.title), `${person.lastContact.kind}, ${person.lastContact.whenLabel}`) });
  if (person.tasks.length) rows.push({ label: "Open tasks", value: taskList(person.tasks) });
  if (person.location) rows.push({ label: "Location", value: person.location });
  rows.push({ label: "Owner", value: person.owner?.name ?? "Unassigned" });
  return card([
    recordHead({ initials: initials(person.name), name: person.name, lines: [personLine(person), person.email] }),
    person.tags.length ? chips(person.tags) : null,
    h("div", { class: "divider" }, facts(rows)),
  ]);
}

function taskForm(s: Store, a: Actions, contactId: string | null, companyId: string | null, onWhat: string) {
  const due = s.form["t.due"] ?? "tomorrow";
  const dateValue = dueDate(due);
  const dueId = uid("due");
  return section("New task", [
    textField({ label: "Title", value: s.form["t.title"] ?? "", onInput: (value) => a.setForm("t.title", value), autofocus: true }),
    h(
      "div",
      { class: "grid-due" },
      h(
        "div",
        { class: "field" },
        h("label", { class: "caption soft", for: dueId }, "Due"),
        h("input", { id: dueId, class: "input", type: "date", value: dateValue, onChange: (event: Event) => a.setForm("t.due", (event.target as HTMLInputElement).value, true) }),
      ),
      selectField({
        label: "Remind",
        value: s.form["t.remind"] ?? "0",
        options: [
          { value: "0", label: "At due time" },
          { value: "60", label: "1 hour before" },
          { value: "1440", label: "1 day before" },
          { value: "none", label: "No reminder" },
        ],
        onChange: (value) => a.setForm("t.remind", value),
      }),
    ),
    h(
      "div",
      { class: "chip-row", role: "group", "aria-label": "Due" },
      [
        ["today", "Today"],
        ["tomorrow", "Tomorrow"],
        ["next_week", "Next week"],
      ].map(([value, label]) =>
        button({ variant: due === value ? "muted" : "ghost", size: "sm", pressed: due === value, onClick: () => a.setForm("t.due", value, true) }, label),
      ),
    ),
    note(`On ${onWhat}. Yours.`),
    formActions(() => a.setActive(null), "Add task", () => a.addTask(contactId, companyId), s.busy),
  ]);
}

function noteForm(s: Store, a: Actions, contactId: string | null, companyId: string | null, onWhat: string) {
  return section("New note", [
    areaField({ label: "Note", rows: 5, value: s.form["n.body"] ?? "", onInput: (value) => a.setForm("n.body", value), autofocus: true }),
    note(`Saved as a note on ${onWhat}.`),
    formActions(() => a.setActive(null), "Add note", () => a.addNote(contactId, companyId), s.busy),
  ]);
}

function messageForm(s: Store, a: Actions, person: PersonSummary) {
  const received = uid("received");
  const sent = uid("sent");
  const direction = s.form["m.direction"] ?? "received";
  return section("Log LinkedIn message", [
    h(
      "fieldset",
      { class: "fieldset" },
      h("legend", { class: "caption soft" }, "Direction"),
      h(
        "span",
        { class: "radios" },
        h(
          "label",
          { class: "ui radio-label", for: received },
          h("input", { id: received, type: "radio", class: "radio", name: "direction", checked: direction === "received", onChange: () => a.setForm("m.direction", "received") }),
          `From ${firstNameOf(person.firstName ?? person.name)}`,
        ),
        h(
          "label",
          { class: "ui radio-label", for: sent },
          h("input", { id: sent, type: "radio", class: "radio", name: "direction", checked: direction === "sent", onChange: () => a.setForm("m.direction", "sent") }),
          "From you",
        ),
      ),
    ),
    textField({ label: "When", type: "datetime-local", value: s.form["m.when"] ?? "", onInput: (value) => a.setForm("m.when", value) }),
    areaField({ label: "Message", rows: 4, placeholder: "Paste or type the message", value: s.form["m.text"] ?? "", onInput: (value) => a.setForm("m.text", value), autofocus: true }),
    note(`Saved as a LinkedIn activity on ${person.name}. In a message thread, Log this conversation does this for you.`),
    formActions(() => a.setActive(null), "Log message", () => a.logMessage(person.id), s.busy),
  ]);
}

function diffForm(s: Store, a: Actions, person: PersonSummary | null) {
  if (!s.diff) return section("Update from page", [h("p", { class: "caption subtle" }, "Comparing with the page")]);
  const ticked = s.diff.changes.filter((row) => row.changed && s.diffTicks.has(row.field)).length;
  return section("Update from page", [
    h(
      "ul",
      { class: "diff" },
      s.diff.changes.map((row) => {
        const id = uid(`diff-${row.field}`);
        return h(
          "li",
          null,
          checkbox({ id, checked: row.changed && s.diffTicks.has(row.field), disabled: !row.changed, label: `Update ${row.label}`, onChange: (on) => a.toggleDiff(row.field, on) }),
          h(
            "label",
            { class: "diff-text", for: id },
            h("span", { class: "caption subtle" }, row.label),
            row.changed
              ? h("span", { class: "ui-13" }, h("span", { class: "subtle strike" }, row.before || "Empty"), h("span", { class: "subtle" }, " to "), h("span", null, row.after || "Empty"))
              : h("span", { class: "ui-13 soft" }, row.after || row.before || "Empty", h("span", { class: "subtle" }, " · same")),
          ),
        );
      }),
    ),
    note(person ? `Only ticked changes are saved. A new company would move ${firstNameOf(person.firstName ?? person.name)} and keep their history.` : "Only ticked changes are saved."),
    h(
      "div",
      { class: "form-actions" },
      button({ variant: "ghost", size: "sm", onClick: () => a.setActive(null), disabled: s.busy }, "Cancel"),
      button({ variant: "primary", size: "sm", onClick: () => a.applyDiff(), disabled: s.busy || ticked === 0 }, ticked === 1 ? "Update 1 field" : `Update ${ticked} fields`),
    ),
  ]);
}

function inOrbitPerson(s: Store, a: Actions, wl: WorkspaceLookup, person: PersonSummary) {
  const onWhat = person.company ? `${person.name} and ${person.company.name}` : person.name;
  return shell(s, a, [
    h("div", { class: "status-row" }, status("in", "In Orbit", personMatchText(wl.matchedOn)), openInOrbit(() => a.openOrbit(person.url))),
    personSummary(person, Boolean(s.active)),
    quickActions(PERSON_ACTIONS, s.active, (key) => a.setActive(key as Active)),
    s.readNote ? note(s.readNote) : null,
    s.active === "task" ? taskForm(s, a, person.id, person.company?.id ?? null, onWhat) : null,
    s.active === "note" ? noteForm(s, a, person.id, person.company?.id ?? null, onWhat) : null,
    s.active === "message" ? messageForm(s, a, person) : null,
    s.active === "update" ? diffForm(s, a, person) : null,
  ]);
}

function companyFromPage(s: Store, wl: WorkspaceLookup | null) {
  if (!s.form["p.company"]) return null;
  return wl?.company ? "In Orbit" : "New company";
}

function personFactsCard(s: Store, a: Actions, wl: WorkspaceLookup | null) {
  const name = [s.form["p.firstName"], s.form["p.lastName"]].filter(Boolean).join(" ") || "Unknown name";
  const editButton = button({ variant: "ghost", size: "sm", onClick: () => a.toggleEdit(), expanded: s.editing }, s.editing ? "Done" : "Edit");
  if (s.editing) {
    return card([
      recordHead({ initials: initials(name), name, lines: [s.person?.headline ?? null], action: editButton }),
      h(
        "div",
        { class: "divider form-stack" },
        h(
          "div",
          { class: "grid-2" },
          textField({ label: "First name", value: s.form["p.firstName"] ?? "", onInput: (value) => a.setForm("p.firstName", value) }),
          textField({ label: "Last name", value: s.form["p.lastName"] ?? "", onInput: (value) => a.setForm("p.lastName", value) }),
        ),
        textField({ label: "Job title", value: s.form["p.jobTitle"] ?? "", onInput: (value) => a.setForm("p.jobTitle", value) }),
        textField({ label: "Company", value: s.form["p.company"] ?? "", onInput: (value) => a.setForm("p.company", value) }),
        textField({ label: "Location", value: s.form["p.location"] ?? "", onInput: (value) => a.setForm("p.location", value) }),
        textField({ label: "LinkedIn", value: s.form["p.linkedinUrl"] ?? "", onInput: (value) => a.setForm("p.linkedinUrl", value) }),
      ),
    ]);
  }
  const rows: { label: string; value: Child }[] = [
    { label: "Job title", value: s.form["p.jobTitle"] || h("span", { class: "subtle" }, "Not read") },
    { label: "Company", value: s.form["p.company"] ? stack(s.form["p.company"], companyFromPage(s, wl)) : h("span", { class: "subtle" }, "Not read") },
    { label: "Location", value: s.form["p.location"] || h("span", { class: "subtle" }, "Not read") },
  ];
  if (s.form["p.linkedinUrl"]) rows.push({ label: "LinkedIn", value: h("span", { class: "soft" }, shortUrl(s.form["p.linkedinUrl"])) });
  if (s.form["p.salesNavigatorUrl"]) rows.push({ label: "Sales Nav", value: h("span", { class: "soft" }, "Lead page") });
  return card([recordHead({ initials: initials(name), name, lines: [s.person?.headline ?? null], action: editButton }), h("div", { class: "divider" }, facts(rows))]);
}

function boardOptions(s: Store, a: Actions, includeLifecycle: boolean) {
  const workspace = currentWorkspace(s);
  const members = workspace?.members ?? [];
  const boards = workspace?.boards ?? [];
  const board = boards.find((item) => item.id === s.form.board);
  const owner = selectField({
    label: "Owner",
    value: s.form.owner ?? "",
    options: [...members.map((member) => ({ value: member.id, label: member.name })), { value: "", label: "Unassigned" }],
    onChange: (value) => {
      a.setForm("ownerTouched", "1");
      a.setForm("owner", value);
    },
  });
  const boardField = selectField({
    label: "Board",
    value: s.form.board ?? "",
    options: [{ value: "", label: "No board" }, ...boards.map((item) => ({ value: item.id, label: item.name }))],
    onChange: (value) => {
      a.setForm("stage", "", false);
      a.setForm("board", value, true);
    },
  });
  const stageField = selectField({
    label: "Stage",
    value: s.form.stage ?? board?.stages[0]?.id ?? "",
    options: board ? board.stages.map((stage) => ({ value: stage.id, label: stage.name })) : [{ value: "", label: "Choose a board" }],
    onChange: (value) => a.setForm("stage", value),
    disabled: !board,
  });
  const tags = textField({ label: "Tags", value: s.form.tags ?? "", placeholder: "agency, geo", onInput: (value) => a.setForm("tags", value) });
  if (!includeLifecycle) return h("div", { class: "grid-2" }, owner, tags, boardField, stageField);
  const lifecycles = workspace?.lifecycles ?? [];
  const lifecycle = selectField({
    label: "Lifecycle",
    value: s.form["c.lifecycle"] ?? lifecycles[0]?.value ?? "lead",
    options: lifecycles.length ? lifecycles.map((item) => ({ value: item.value, label: item.label })) : [{ value: "lead", label: "Lead" }],
    onChange: (value) => a.setForm("c.lifecycle", value),
  });
  return [h("div", { class: "grid-2" }, lifecycle, owner), h("div", { class: "grid-2" }, boardField, stageField), tags];
}

function newPerson(s: Store, a: Actions, wl: WorkspaceLookup | null) {
  const workspace = currentWorkspace(s);
  const name = [s.form["p.firstName"], s.form["p.lastName"]].filter(Boolean).join(" ") || "this person";
  const company = s.form["p.company"];
  const domainId = uid("domain");
  return shell(
    s,
    a,
    [
      status("new", `Not in ${workspace?.name ?? "Orbit"}`, otherWorkspaceHint(s) ?? "No one with this profile, or this name at this company."),
      section("From this page", [
        personFactsCard(s, a, wl),
        note(s.readNote ?? "Read from the page you're on. Nothing is saved until you press Save."),
      ]),
      h(
        "div",
        { class: "field" },
        h("label", { class: "caption soft", for: domainId }, "Company domain"),
        h("input", {
          id: domainId,
          class: "input",
          value: s.form["p.domain"] ?? "",
          placeholder: "example.com",
          "aria-describedby": `${domainId}-hint`,
          onInput: (event: Event) => a.setForm("p.domain", (event.target as HTMLInputElement).value),
        }),
        h("span", { id: `${domainId}-hint`, class: "caption subtle" }, "Optional. Matches an existing company and fills in its details."),
      ),
      section("Options", boardOptions(s, a, false)),
    ],
    [
      button({ variant: "primary", size: "md", className: "wide tall", onClick: () => a.savePerson(), disabled: s.busy }, s.busy ? "Saving" : "Save to Orbit"),
      h("p", { class: "caption subtle center" }, company ? `Adds ${name} and ${company} to ${workspace?.name}.` : `Adds ${name} to ${workspace?.name}.`),
    ],
  );
}

function possibleMatch(s: Store, a: Actions, candidates: PersonSummary[]) {
  const lead = s.target.kind === "lead";
  return shell(
    s,
    a,
    [
      status(
        "maybe",
        "Possible match",
        lead ? "Lead pages have no public profile link, so this is matched by name and company." : "Matched by name and company only. Check it's the same person.",
      ),
      candidates.map((candidate) =>
        card([
          recordHead({
            initials: initials(candidate.name),
            name: candidate.name,
            lines: [personLine(candidate), `${candidate.linkedinUrl ? "LinkedIn saved" : "No LinkedIn saved"} · ${candidate.addedLabel}`],
          }),
          h(
            "div",
            { class: "row" },
            button({ variant: "primary", size: "sm", onClick: () => a.confirmMatch(candidate), disabled: s.busy }, "Same person"),
            button({ variant: "secondary", size: "sm", onClick: () => a.rejectMatch(candidate), disabled: s.busy }, "Not them"),
            h("span", { class: "push" }, openInOrbit(() => a.openOrbit(candidate.url), "Open")),
          ),
          note(
            lead
              ? `Same person saves this lead page on ${firstNameOf(candidate.firstName ?? candidate.name)}'s record, so it matches straight away next time.`
              : `Same person saves this profile on ${firstNameOf(candidate.firstName ?? candidate.name)}'s record, so it matches straight away next time.`,
          ),
        ]),
      ),
      section(
        "From this page",
        facts([
          { label: "Name", value: [s.form["p.firstName"], s.form["p.lastName"]].filter(Boolean).join(" ") || "Not read" },
          { label: "Job title", value: s.form["p.jobTitle"] || "Not read" },
          { label: "Company", value: s.form["p.company"] || "Not read" },
          { label: "Location", value: s.form["p.location"] || "Not read" },
        ]),
      ),
      section("Quick actions", [
        h("div", { class: "disabled-block", "aria-disabled": "true" }, quickActions(PERSON_ACTIONS, null, () => undefined, true)),
        note(`Confirm the match first, or press Not them to save ${firstNameOf(s.form["p.firstName"])} as a new person.`),
      ]),
    ],
    lead ? [h("p", { class: "caption subtle center" }, "Doesn't change your lead lists or Sales Navigator notes.")] : undefined,
  );
}

function personView(s: Store, a: Actions) {
  const wl = currentLookup(s);
  if (wl?.status === "in" && wl.person) return inOrbitPerson(s, a, wl, wl.person);
  const candidates = (wl?.candidates ?? []).filter((candidate) => !s.rejected.has(candidate.id));
  if (wl?.status === "maybe" && candidates.length > 0) return possibleMatch(s, a, candidates);
  return newPerson(s, a, wl);
}

function companySummary(company: CompanySummary) {
  const rows: { label: string; value: Child }[] = [{ label: "Lifecycle", value: recordTag(company.lifecycleLabel, lifecycleColour(company.lifecycle)) }];
  if (company.deal) rows.push({ label: "Deal", value: dealValue(company.deal) });
  if (company.people.length) rows.push({ label: "People", value: company.people.map((person) => person.name).join(", ") });
  rows.push({
    label: "Open tasks",
    value: company.openTasks ? `${company.openTasks}${company.nextDueLabel ? `, next due ${company.nextDueLabel.toLowerCase()}` : ""}` : "None",
  });
  rows.push({ label: "Owner", value: company.owner?.name ?? "Unassigned" });
  return card([
    recordHead({ initials: initials(company.name).slice(0, 1), name: company.name, lines: [company.domain ?? shortUrl(company.website)], square: true }),
    company.tags.length ? chips(company.tags) : null,
    h("div", { class: "divider" }, facts(rows)),
  ]);
}

function peopleList(company: CompanySummary, a: Actions) {
  return section(
    "People in Orbit",
    company.people.length
      ? h(
          "ul",
          { class: "people" },
          company.people.map((person) =>
            h("li", null, h("span", { class: "stack" }, h("span", null, person.name), person.jobTitle ? h("span", { class: "caption subtle" }, person.jobTitle) : null)),
          ),
        )
      : note("No one at this company is in Orbit yet."),
    button({ variant: "ghost", size: "sm", onClick: () => a.setActive(null) }, "Close"),
  );
}

function aiFields(company: CompanySummary) {
  if (!company.aiFields.length) return null;
  return section(
    "AI fields",
    h(
      "dl",
      { class: "facts ai" },
      company.aiFields.map((field) => [
        h("dt", { class: "caption subtle" }, field.label),
        h(
          "dd",
          { class: "stack" },
          h("span", null, field.value, field.detail ? h("span", { class: "caption subtle" }, ` ${field.detail}`) : null),
          field.meta ? h("span", { class: "caption subtle" }, field.meta) : null,
        ),
      ]),
    ),
  );
}

function inOrbitCompany(s: Store, a: Actions, wl: WorkspaceLookup, company: CompanySummary) {
  return shell(s, a, [
    h("div", { class: "status-row" }, status("in", "In Orbit", companyMatchText(wl.matchedOn)), openInOrbit(() => a.openOrbit(company.url))),
    companySummary(company),
    h(
      "div",
      { class: "section tight" },
      quickActions(COMPANY_ACTIONS, s.active, (key) => a.setActive(key as Active)),
      !company.linkedinUrl ? note("Its LinkedIn page isn't saved yet. Update from page adds it.") : null,
    ),
    s.active === "task" ? taskForm(s, a, null, company.id, company.name) : null,
    s.active === "note" ? noteForm(s, a, null, company.id, company.name) : null,
    s.active === "people" ? peopleList(company, a) : null,
    s.active === "update" ? diffForm(s, a, null) : null,
    s.active ? null : aiFields(company),
  ]);
}

function newCompany(s: Store, a: Actions) {
  const workspace = currentWorkspace(s);
  const page = s.company;
  const rows: { label: string; value: Child }[] = [];
  if (page?.website) rows.push({ label: "Website", value: shortUrl(page.website) });
  if (page?.industry) rows.push({ label: "Industry", value: page.industry });
  if (page?.sizeCategory) rows.push({ label: "Size", value: page.sizeCategory });
  if (page?.location) rows.push({ label: "Location", value: page.location });
  const name = page?.name ?? s.form["c.name"] ?? "This company";
  return shell(
    s,
    a,
    [
      status("new", `Not in ${workspace?.name ?? "Orbit"}`, otherWorkspaceHint(s) ?? "No company with this domain or LinkedIn page."),
      section("From this page", [
        card([
          recordHead({ initials: initials(name).slice(0, 1), name, lines: [page?.tagline ?? null], square: true }),
          rows.length ? h("div", { class: "divider" }, facts(rows)) : null,
        ]),
        s.readNote ? note(s.readNote) : null,
      ]),
      section("Company", [
        textField({ label: "Name", value: s.form["c.name"] ?? "", onInput: (value) => a.setForm("c.name", value) }),
        textField({
          label: "Domain",
          value: s.form["c.domain"] ?? "",
          placeholder: "example.com",
          hint: "Orbit fills in the logo, description and links from the domain.",
          onInput: (value) => a.setForm("c.domain", value),
        }),
        boardOptions(s, a, true),
      ]),
    ],
    [
      button({ variant: "primary", size: "md", className: "wide tall", onClick: () => a.saveCompany(), disabled: s.busy }, s.busy ? "Saving" : "Save company"),
      h("p", { class: "caption subtle center" }, "Fit and AI fields are checked after it's saved."),
    ],
  );
}

function possibleCompany(s: Store, a: Actions, candidates: CompanySummary[]) {
  const pageName = s.company?.name ?? s.form["c.name"] ?? "this company";
  return shell(s, a, [
    status("maybe", "Possible match", "Same name, but a different LinkedIn page or domain. Check it's the same company."),
    candidates.map((candidate) =>
      card([
        recordHead({
          initials: initials(candidate.name).slice(0, 1),
          name: candidate.name,
          lines: [candidate.domain ?? shortUrl(candidate.website), candidate.linkedinUrl ? `LinkedIn: ${shortUrl(candidate.linkedinUrl)}` : "No LinkedIn page saved"],
          square: true,
        }),
        h(
          "div",
          { class: "row" },
          candidate.linkedinUrl
            ? null
            : button({ variant: "primary", size: "sm", onClick: () => a.confirmCompany(candidate), disabled: s.busy }, "Same company"),
          button({ variant: "secondary", size: "sm", onClick: () => a.rejectMatch(candidate), disabled: s.busy }, "Not them"),
          h("span", { class: "push" }, openInOrbit(() => a.openOrbit(candidate.url), "Open")),
        ),
        note(
          candidate.linkedinUrl
            ? `${candidate.name} already has another LinkedIn page. Press Not them to save ${pageName} as a new company.`
            : `Same company saves this LinkedIn page on ${candidate.name}, so it matches straight away next time.`,
        ),
      ]),
    ),
  ]);
}

function companyView(s: Store, a: Actions) {
  const wl = currentLookup(s);
  if (wl?.status === "in" && wl.company) return inOrbitCompany(s, a, wl, wl.company);
  const candidates = (wl?.companyCandidates ?? []).filter((candidate) => !s.rejected.has(candidate.id));
  if (wl?.status === "maybe" && candidates.length > 0) return possibleCompany(s, a, candidates);
  return newCompany(s, a);
}

function conversationPick(s: Store, a: Actions, person: PersonSummary) {
  const conversation = s.conversation!;
  const chosen = conversation.messages.filter((_, index) => conversation.ticked.has(index) && !conversation.checks[index]?.loggedAt).length;
  return shell(
    s,
    a,
    [
      status(
        "wait",
        `${conversation.messages.length} message${conversation.messages.length === 1 ? "" : "s"} on screen`,
        `Read when you pressed Log this conversation at ${clockTime(conversation.readAt)}. Untick any you don't want.`,
      ),
      conversation.messages.length === 0 ? alert("No messages were found on screen. Open the conversation and try again.") : null,
      section(
        "Messages",
        h(
          "ul",
          { class: "messages" },
          conversation.messages.map((message, index) => {
            const id = uid(`message-${index}`);
            const logged = conversation.checks[index]?.loggedAt ?? null;
            return h(
              "li",
              { class: cx(logged && "is-logged") },
              checkbox({
                id,
                checked: !logged && conversation.ticked.has(index),
                disabled: Boolean(logged),
                label: `Log message from ${message.mine ? "you" : message.from}${message.when ? `, ${message.when}` : ""}`,
                onChange: (on) => a.toggleMessage(index, on),
              }),
              h(
                "label",
                { class: "message-text", for: id },
                h(
                  "span",
                  { class: "caption message-meta" },
                  h("span", { class: "soft truncate" }, message.mine ? "You" : message.from),
                  h("span", { class: "subtle shrink-0" }, logged ? (conversation.checks[index]?.loggedLabel ?? "Logged") : (message.when ?? "")),
                ),
                h("span", { class: "ui-13 message-body" }, message.text),
              ),
            );
          }),
        ),
      ),
      section("Log to", [
        facts([
          { label: "Person", value: person.name },
          { label: "Company", value: person.company?.name ?? "None" },
          { label: "Type", value: "LinkedIn" },
        ]),
        textField({ label: "Title", value: s.form["conv.title"] ?? "", onInput: (value) => a.setForm("conv.title", value) }),
      ]),
    ],
    [
      h(
        "div",
        { class: "row" },
        button({ variant: "ghost", size: "md", className: "tall", onClick: () => a.cancelConversation(), disabled: s.busy }, "Cancel"),
        button(
          { variant: "primary", size: "md", className: "tall grow", onClick: () => a.logConversation(person.id), disabled: s.busy || chosen === 0 },
          s.busy ? "Logging" : chosen === 1 ? "Log 1 message" : `Log ${chosen} messages`,
        ),
      ),
      h("p", { class: "caption subtle center" }, "Saved as one LinkedIn activity. Nothing else from the thread is kept."),
    ],
  );
}

function conversationView(s: Store, a: Actions) {
  const wl = currentLookup(s);
  const person = wl?.status === "in" ? wl.person : null;
  if (!person) {
    const workspace = currentWorkspace(s);
    const profile = s.partner?.profileUrl ?? null;
    return shell(s, a, [
      status(
        "new",
        s.partner?.name ? `${s.partner.name} isn't in ${workspace?.name ?? "Orbit"}` : `Not in ${workspace?.name ?? "Orbit"}`,
        otherWorkspaceHint(s) ?? (profile ? "Open their profile to save them first, then log this conversation." : "Couldn't find a profile link in this thread."),
      ),
      profile ? h("div", { class: "row" }, button({ variant: "secondary", size: "sm", onClick: () => a.openLinkedin(profile), iconAfter: "external" }, "Open their profile")) : null,
    ]);
  }
  if (s.conversation && s.conversation.pageKey === s.pageKey) return conversationPick(s, a, person);
  const last = s.lastLogged ? `Last logged here ${s.lastLogged.label}, ${s.lastLogged.count} message${s.lastLogged.count === 1 ? "" : "s"}` : null;
  return shell(s, a, [
    h("div", { class: "status-row" }, status("in", "In Orbit", "Matched by the profile link in this thread"), openInOrbit(() => a.openOrbit(person.url))),
    card(recordHead({ initials: initials(person.name), name: person.name, lines: [personLine(person), last] })),
    section("This conversation", [
      button({ variant: "primary", size: "md", className: "wide taller", onClick: () => a.readConversation(), icon: "mail", disabled: s.busy }, "Log this conversation"),
      h(
        "ul",
        { class: "caption subtle bullets" },
        h("li", null, "Logs only the messages on screen when you press it."),
        h("li", null, "Orbit never reads your messages on its own. Scroll up first to include older ones."),
        h("li", null, "Messages you've logged before are skipped."),
      ),
    ]),
  ]);
}

export function readyView(s: Store, a: Actions) {
  if (s.target.kind === "other") return idleView(s, a);
  if (s.loadingPage && !s.lookup) return pageLoading(s, a);
  if (!s.lookup) return s.lookupError ? lookupFailed(s, a) : pageLoading(s, a);
  if (s.target.kind === "company") return companyView(s, a);
  if (s.target.kind === "conversation") return conversationView(s, a);
  return personView(s, a);
}
