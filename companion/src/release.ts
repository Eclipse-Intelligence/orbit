import manifest from "../package.json";

export const AGENT_VERSION: string = manifest.version;

export function agentPackageUrl(origin: string) {
  return `${origin}/downloads/orbit-agent-${AGENT_VERSION}.tgz`;
}
