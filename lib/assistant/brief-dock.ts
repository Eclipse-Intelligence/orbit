export type DockBrief = { id: string; createdAt: string };

export function briefKey(brief: DockBrief) {
  return `${brief.id}:${brief.createdAt}`;
}

export function pendingBrief<T extends DockBrief>(brief: T | null, handled: string | null) {
  return brief && briefKey(brief) !== handled ? brief : null;
}

export function opensBriefOnExpand(state: { pending: boolean; busy: boolean; working: boolean; messages: number }) {
  return state.pending && !state.busy && !state.working && state.messages === 0;
}
