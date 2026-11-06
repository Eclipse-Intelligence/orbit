import MailComposer from "nodemailer/lib/mail-composer";
import { all, first, param, parseIcs, textOf } from "@/lib/ical/parse";
import { canonicalEmail } from "@/lib/crm/normalize";

export type ItipMethod = "REQUEST" | "CANCEL";

export type ItipPerson = { email: string; name: string | null };

export type ItipEvent = {
  method: ItipMethod;
  uid: string;
  sequence: number;
  organizer: ItipPerson;
  guests: ItipPerson[];
  subject: string;
  start: Date;
  end: Date;
  notes: string | null;
  link: string | null;
  stamp: Date;
};

export type ItipReply = {
  uid: string;
  sequence: number;
  responses: { email: string; response: string }[];
};

export type ItipEmail = {
  kind: "invite" | "update" | "cancel";
  when: string;
  previousWhen?: string | null;
  message?: string | null;
};

const PARTSTAT: Record<string, string> = {
  ACCEPTED: "accepted",
  DECLINED: "declined",
  TENTATIVE: "tentativelyAccepted",
  "NEEDS-ACTION": "none",
  DELEGATED: "none",
};

const STYLE = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5";

function stampOf(date: Date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function escapeText(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n|\r|\n/g, "\\n");
}

function paramValue(value: string) {
  const clean = value.replace(/["\r\n]/g, "").trim();
  return /[;:,]/.test(clean) ? `"${clean}"` : clean;
}

function foldLine(line: string) {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let current = "";
  let size = 0;
  let limit = 75;
  for (const char of line) {
    const width = Buffer.byteLength(char, "utf8");
    if (size + width > limit) {
      parts.push(current);
      current = "";
      size = 0;
      limit = 74;
    }
    current += char;
    size += width;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

function person(kind: "ORGANIZER" | "ATTENDEE", value: ItipPerson, extra: string[] = []) {
  const params = [value.name ? `CN=${paramValue(value.name)}` : null, ...extra].filter(Boolean);
  return `${kind}${params.length ? `;${params.join(";")}` : ""}:mailto:${value.email}`;
}

function description(event: Pick<ItipEvent, "notes" | "link">) {
  return [event.notes, event.link ? `Join: ${event.link}` : null].filter(Boolean).join("\n\n");
}

export function inviteUid(transactionId: string, organizerEmail: string) {
  const domain = organizerEmail.split("@")[1] || "orbit";
  return `orbit-${transactionId}@${domain}`;
}

export function buildItip(event: ItipEvent) {
  const cancelled = event.method === "CANCEL";
  const text = description(event);
  const lines = [
    "BEGIN:VCALENDAR",
    "PRODID:-//Eclipse//Orbit//EN",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    `METHOD:${event.method}`,
    "BEGIN:VEVENT",
    `UID:${event.uid}`,
    `SEQUENCE:${event.sequence}`,
    `DTSTAMP:${stampOf(event.stamp)}`,
    `DTSTART:${stampOf(event.start)}`,
    `DTEND:${stampOf(event.end)}`,
    `SUMMARY:${escapeText(event.subject)}`,
    text ? `DESCRIPTION:${escapeText(text)}` : null,
    event.link ? `LOCATION:${escapeText(event.link)}` : null,
    event.link ? `URL:${event.link}` : null,
    person("ORGANIZER", event.organizer),
    ...event.guests.map((guest) =>
      person("ATTENDEE", guest, [
        "CUTYPE=INDIVIDUAL",
        "ROLE=REQ-PARTICIPANT",
        `PARTSTAT=${cancelled ? "DECLINED" : "NEEDS-ACTION"}`,
        cancelled ? null : "RSVP=TRUE",
      ].filter((item): item is string => Boolean(item))),
    ),
    `STATUS:${cancelled ? "CANCELLED" : "CONFIRMED"}`,
    "TRANSP:OPAQUE",
    "END:VEVENT",
    "END:VCALENDAR",
  ].filter((line): line is string => line !== null);
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function personLabel(value: ItipPerson) {
  return value.name ? `${value.name} (${value.email})` : value.email;
}

function emailLines(event: ItipEvent, email: ItipEmail) {
  const organiser = event.organizer.name ?? event.organizer.email;
  const lead =
    email.kind === "cancel"
      ? `${organiser} cancelled ${event.subject}.`
      : email.kind === "update"
        ? `${organiser} moved ${event.subject}.`
        : `${organiser} invited you to ${event.subject}.`;
  const rows: [string, string][] = [
    ["When", email.when],
    ...(email.previousWhen ? ([["Was", email.previousWhen]] as [string, string][]) : []),
    ...(event.link && email.kind !== "cancel" ? ([["Join", event.link]] as [string, string][]) : []),
    ["Organiser", personLabel(event.organizer)],
    ["Guests", event.guests.map(personLabel).join(", ")],
  ];
  return { lead, rows };
}

export function itipSubject(event: Pick<ItipEvent, "subject">, kind: ItipEmail["kind"]) {
  if (kind === "cancel") return `Cancelled: ${event.subject}`;
  if (kind === "update") return `Updated invitation: ${event.subject}`;
  return `Invitation: ${event.subject}`;
}

export function itipText(event: ItipEvent, email: ItipEmail) {
  const { lead, rows } = emailLines(event, email);
  return [
    lead,
    "",
    ...rows.map(([label, value]) => `${label}: ${value}`),
    email.message ? `\n${email.message}` : null,
    event.notes && email.kind !== "cancel" ? `\n${event.notes}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export function itipHtml(event: ItipEvent, email: ItipEmail) {
  const { lead, rows } = emailLines(event, email);
  const paragraph = (value: string) => `<p>${escapeHtml(value).replace(/\r\n|\r|\n/g, "<br>")}</p>`;
  const value = (label: string, text: string) =>
    label === "Join" ? `<a href="${escapeHtml(text)}">${escapeHtml(text)}</a>` : escapeHtml(text);
  return [
    `<div style="${STYLE}">`,
    paragraph(lead),
    `<p>${rows.map(([label, text]) => `<strong>${escapeHtml(label)}:</strong> ${value(label, text)}`).join("<br>")}</p>`,
    email.message ? paragraph(email.message) : "",
    event.notes && email.kind !== "cancel" ? paragraph(event.notes) : "",
    "</div>",
  ].join("");
}

export async function buildItipMime(event: ItipEvent, email: ItipEmail) {
  const domain = event.organizer.email.split("@")[1] || "orbit";
  const composer = new MailComposer({
    from: { name: event.organizer.name ?? "", address: event.organizer.email },
    to: event.guests.map((guest) => ({ name: guest.name ?? "", address: guest.email })),
    subject: itipSubject(event, email.kind),
    text: itipText(event, email),
    html: itipHtml(event, email),
    icalEvent: { method: event.method, filename: "invite.ics", content: buildItip(event) },
    date: event.stamp,
    messageId: `<${event.uid.replace(/@.*$/, "")}-${event.sequence}-${event.method.toLowerCase()}-${event.stamp.getTime()}@${domain}>`,
  });
  const built = await composer.compile().build();
  return built.toString("utf8");
}

export function readItipReply(text: string): ItipReply | null {
  let roots;
  try {
    roots = parseIcs(text);
  } catch {
    return null;
  }
  const calendar = roots.find((component) => component.name === "VCALENDAR");
  if (!calendar || (textOf(calendar, "METHOD") ?? "").trim().toUpperCase() !== "REPLY") return null;
  const event = calendar.components.find((component) => component.name === "VEVENT");
  if (!event) return null;
  const uid = textOf(event, "UID")?.trim();
  if (!uid || uid.length > 400) return null;
  const sequence = Number(first(event, "SEQUENCE")?.value ?? 0);
  const responses: ItipReply["responses"] = [];
  for (const attendee of all(event, "ATTENDEE")) {
    const email = canonicalEmail(attendee.value.replace(/^mailto:/i, "").trim());
    const status = PARTSTAT[(param(attendee, "PARTSTAT") ?? "").toUpperCase()];
    if (email && status) responses.push({ email, response: status });
  }
  if (responses.length === 0) return null;
  return { uid, sequence: Number.isInteger(sequence) && sequence >= 0 ? sequence : 0, responses };
}
