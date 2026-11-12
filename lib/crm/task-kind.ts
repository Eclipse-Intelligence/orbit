export type TaskKind = "call" | "email" | "meeting" | "todo";

const WORDS: [TaskKind, RegExp][] = [
  ["call", /^(call|calls|calling|ring|rings|ringing|phone|phones|phoning)$/],
  ["email", /^(email|emails|emailing|e-mail|e-mails|reply|replies|send|sends|sending)$/],
  ["meeting", /^(meet|meets|meeting|meetings|book|books|booking|schedule|schedules|scheduling|demo|demos)$/],
];

export function taskKind(title: string | null | undefined): TaskKind {
  const words = (title ?? "").toLowerCase().match(/[a-z]+(?:-[a-z]+)*/g) ?? [];
  for (const word of words) {
    const found = WORDS.find(([, pattern]) => pattern.test(word));
    if (found) return found[0];
  }
  return "todo";
}
