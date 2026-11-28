export function remoteTitleToAdopt(remote: { title: string; at: number } | undefined, editedAt: number, current: string) {
  return remote && remote.at > editedAt && remote.title !== current ? remote.title : null;
}
