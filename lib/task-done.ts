export type DoneState = { done: Set<string>; awaiting: Set<string>; confirmed: Set<string> };

export function reconcileDone(open: Set<string>, state: DoneState): DoneState {
  const back = new Set([...state.awaiting, ...state.confirmed].filter((id) => open.has(id)));
  const confirmed = new Set([...state.confirmed, ...state.done].filter((id) => !open.has(id)));
  const done = new Set([...state.done].filter((id) => !back.has(id)));
  return { done, awaiting: state.awaiting.size > 0 ? new Set() : state.awaiting, confirmed };
}
