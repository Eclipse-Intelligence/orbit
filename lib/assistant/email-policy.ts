type Args = Record<string, unknown>;

export type EmailPolicyContext = { requester: string[] };

export type EmailRule = "confirm" | "auto" | ((args: Args, context: EmailPolicyContext) => boolean);

const CONTACTS_SOMEONE = "confirm";
const REMOVES = "confirm";
const SPENDS = "confirm";

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

const MAIL_ACTIONS_WITHOUT_CONFIRM = new Set(["read", "unread", "flag", "unflag", "snooze", "remind_if_no_reply", "inbox"]);
const DOC_ACTIONS_TO_CONFIRM = new Set(["archive", "share", "unshare"]);

export const EMAIL_POLICY: Record<string, EmailRule> = {
  send_email: (args, context) => !onlyToRequester(args, context),
  save_email_draft: (args, context) => !onlyToRequester(args, context),
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
  linear_update_issue: (args) => text(args.comment).length > 0 || text(args.body).length > 0,
  mail_action: (args) => strings(args.senders).length > 0 || !MAIL_ACTIONS_WITHOUT_CONFIRM.has(text(args.action)),

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
  remember: (args) => text(args.forgetId).length > 0,
  update_watchlist: (args) => Array.isArray(args.remove) && args.remove.length > 0,
  save_doc: (args) => DOC_ACTIONS_TO_CONFIRM.has(text(args.action)),

  find_contact_details: SPENDS,
  verify_email: SPENDS,
  eclipse_action: SPENDS,
  run_learning: SPENDS,

  file_conversation: "auto",
  add_to_knowledge: "auto",
  create_task: "auto",
  update_task: "auto",
  log_activity: "auto",
  update_activity: "auto",
  create_company: "auto",
  update_company: "auto",
  create_contact: "auto",
  update_contact: "auto",
  set_relationship: "auto",
  create_opportunity: "auto",
  update_opportunity: "auto",
  add_to_board: "auto",
  create_board: "auto",
  update_board: "auto",
  move_card: "auto",
  create_workflow: "auto",
  share_workflow: "auto",
  tag_records: "auto",
  create_proposal: "auto",
  update_proposal: "auto",
  create_proposal_template: "auto",
  update_proposal_template: "auto",
  add_proposal_image: "auto",
  linear_create_issue: "auto",
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
