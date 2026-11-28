export function liveRemoteTitle(state: { remoteTitles: Record<string, string>; pages: Record<string, { title: string }> }, id: string) {
  const remote = state.remoteTitles[id];
  return remote !== undefined && state.pages[id]?.title === remote ? remote : undefined;
}
