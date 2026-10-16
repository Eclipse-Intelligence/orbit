import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_DIR = join(homedir(), ".config", "orbit-agent");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
export const WORKSPACE_DIR = join(CONFIG_DIR, "workspace");

export type Config = { url: string; token: string; email: string | null };

export async function loadConfig(): Promise<Partial<Config>> {
  try {
    return JSON.parse(await readFile(CONFIG_FILE, "utf8")) as Partial<Config>;
  } catch {
    return {};
  }
}

export async function saveConfig(config: Config) {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
  await chmod(CONFIG_FILE, 0o600);
}

export async function clearConfig() {
  await rm(CONFIG_FILE, { force: true });
}

export async function prepareWorkspace() {
  await mkdir(WORKSPACE_DIR, { recursive: true, mode: 0o700 });
  return WORKSPACE_DIR;
}
