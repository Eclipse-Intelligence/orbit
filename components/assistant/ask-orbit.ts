export const ASK_ORBIT_EVENT = "orbit:ask";

export type AskOrbitDetail = { text: string };

export function askOrbit(text: string) {
  const event = new CustomEvent<AskOrbitDetail>(ASK_ORBIT_EVENT, { detail: { text }, cancelable: true });
  return !window.dispatchEvent(event);
}
