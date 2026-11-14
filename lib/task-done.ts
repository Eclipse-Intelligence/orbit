export type DoneState = { done: Set<string>; awaiting: Set<string>; confirmed: Set<string>; sent: Set<string> };

export function reconcileDone(open: Set<string>, state: DoneState): DoneState {
  const back = new Set([...state.awaiting, ...state.confirmed].filter((id) => open.has(id)));
  const confirmed = new Set([...state.confirmed, ...state.awaiting, ...state.sent].filter((id) => !open.has(id)));
  const sent = new Set([...state.sent].filter((id) => open.has(id) && !state.awaiting.has(id)));
  const done = new Set([...state.done].filter((id) => !back.has(id)));
  return { done, awaiting: new Set(), confirmed, sent };
}
