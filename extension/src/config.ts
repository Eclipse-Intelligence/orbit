export const ORBIT_URL = (typeof __ORBIT_URL__ === "string" ? __ORBIT_URL__ : "https://orbit.geteclipse.co").replace(/\/+$/, "");
export const LINKEDIN_URL = (typeof __LINKEDIN_URL__ === "string" ? __LINKEDIN_URL__ : "https://www.linkedin.com").replace(/\/+$/, "");
export const TOKEN_KEY = "orbitToken";
export const WORKSPACE_KEY = "orbitWorkspace";

export function orbitHref(path: string) {
  const root = `${ORBIT_URL}/`;
  try {
    const url = new URL(path, root);
    return url.origin === new URL(root).origin ? url.toString() : root;
  } catch {
    return root;
  }
}
