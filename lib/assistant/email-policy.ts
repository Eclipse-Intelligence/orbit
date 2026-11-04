import { blockLinks } from "@/lib/proposals/agent";

type Args = Record<string, unknown>;

export type EmailPolicyContext = { requester: string[]; ownedDocs?: ReadonlySet<string> };

export type EmailRule = "confirm" | "auto" | ((args: Args, context: EmailPolicyContext) => boolean);

const CONTACTS_SOMEONE = "confirm";
const REMOVES = "confirm";
const SPENDS = "confirm";
const SHARES = "confirm";

function strings(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function bare(address: string) {
  const match = /<([^<>]+)>/.exec(address);
  return (match ? match[1] : address).trim().toLowerCase();
}

function onlyToRequester(args: Args, context: EmailPolicyContext) {
  if (text(args.contactId) || text(args.replyToEmailId) || text(args.draftId) || text(args.sendAt)) return false;
  const people = [...strings(args.to), ...strings(args.cc), ...strings(args.bcc)].map(bare);
  const own = new Set(context.requester.map(bare).filter(Boolean));
  return people.length > 0 && people.every((address) => own.has(address));
}

function changesOwnerOrMany(args: Args, many: string) {
  return text(args.ownerId).length > 0 || strings(args[many]).length > 1;
}

const MAIL_ACTIONS_WITHOUT_CONFIRM = new Set(["read", "unread", "flag", "unflag", "snooze", "remind_if_no_reply", "inbox"]);
const DOC_ACTIONS_TO_CONFIRM = new Set(["archive", "share", "unshare", "rename"]);
const CONTACT_ROUTES = ["email", "phone", "linkedinUrl"];

function docNeedsConfirm(args: Args, context: EmailPolicyContext) {
  const action = text(args.action);
  if (DOC_ACTIONS_TO_CONFIRM.has(action)) return true;
  if (action === "append_daily") return false;
  if (action === "create") return args.shared === true;
  if (action === "move" && args.allowVisibilityChange === true) return true;
  return !context.ownedDocs?.has(text(args.docId));
}

export const EMAIL_POLICY: Record<string, EmailRule> = {
  send_email: (args, context) => !onlyToRequester(args, context),
  save_email_draft: (args) => text(args.sendAt).length > 0,
  change_scheduled_email: CONTACTS_SOMEONE,
  create_meeting_invite: CONTACTS_SOMEONE,
  move_meeting: CONTACTS_SOMEONE,
  cancel_meeting: CONTACTS_SOMEONE,
  respond_to_meeting: CONTACTS_SOMEONE,
  send_proposal: CONTACTS_SOMEONE,
  update_proposal_steps: CONTACTS_SOMEONE,
  withdraw_proposal: CONTACTS_SOMEONE,
  revise_proposal: CONTACTS_SOMEONE,
  run_workflow: CONTACTS_SOMEONE,
  set_workflow_status: CONTACTS_SOMEONE,
  update_workflow: CONTACTS_SOMEONE,
  decide_workflow_approval: CONTACTS_SOMEONE,
  linear_create_issue: CONTACTS_SOMEONE,
  linear_update_issue: CONTACTS_SOMEONE,
  mail_action: (args) => strings(args.senders).length > 0 || !MAIL_ACTIONS_WITHOUT_CONFIRM.has(text(args.action)),
  update_proposal: (args) => blockLinks(args.blocks).length > 0,

  archive_records: REMOVES,
  archive_activity: REMOVES,
  remove_knowledge: REMOVES,
  delete_board: REMOVES,
  delete_workflow: REMOVES,
  remove_from_board: REMOVES,
  set_board_stages: REMOVES,
  merge_companies: REMOVES,
  merge_contacts: REMOVES,
  undo_change: REMOVES,
  save_email_template: (args) => args.archived === true,
  save_product: (args) => args.archived === true,
  update_proposal_template: (args) => text(args.status) === "archived",
  update_watchlist: (args) => Array.isArray(args.remove) && args.remove.length > 0,

  remember: (args) => text(args.forgetId).length > 0 || args.shared === true,
  share_workflow: SHARES,
  save_doc: docNeedsConfirm,
  add_to_knowledge: (args) => text(args.chatFileId).length > 0,
  update_company: (args) => changesOwnerOrMany(args, "companyIds"),
  update_contact: (args) => changesOwnerOrMany(args, "contactIds") || CONTACT_ROUTES.some((key) => args[key] !== undefined),
  update_opportunity: (args) => text(args.ownerId).length > 0,

  find_contact_details: SPENDS,
  verify_email: SPENDS,
  eclipse_action: SPENDS,
  run_learning: SPENDS,

  file_conversation: "auto",
  create_task: "auto",
  update_task: "auto",
  log_activity: "auto",
  update_activity: "auto",
  create_company: "auto",
  create_contact: "auto",
  set_relationship: "auto",
  create_opportunity: "auto",
  add_to_board: "auto",
  create_board: "auto",
  update_board: "auto",
  move_card: "auto",
  create_workflow: "auto",
  tag_records: "auto",
  create_proposal: "auto",
  create_proposal_template: "auto",
  add_proposal_image: "auto",
};

export function needsEmailConfirm(name: string, args: Args, context: EmailPolicyContext) {
  const rule = Object.hasOwn(EMAIL_POLICY, name) ? EMAIL_POLICY[name] : "confirm";
  if (rule === "confirm") return true;
  if (rule === "auto") return false;
  try {
    return rule(args, context) !== false;
  } catch {
    return true;
  }
}

export function docIdsIn(calls: { name: string; args: Args }[]) {
  return calls.flatMap((call) => (call.name === "save_doc" && text(call.args.docId) ? [text(call.args.docId)] : []));
}
