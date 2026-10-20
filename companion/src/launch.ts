import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";

const LABEL = "co.geteclipse.orbit-agent";
const PLIST = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
export const LOG_FILE = join(homedir(), "Library", "Logs", "orbit-agent.log");

function escapeXml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function findOnPath(name: string) {
  try {
    return execFileSync("/usr/bin/which", [name], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

export function launchPath(npx: string) {
  const parts = [dirname(process.execPath), dirname(npx), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  return [...new Set(parts)].join(":");
}

export function launchPlist(input: { npx: string; url: string; path: string; log: string }) {
  const args = [input.npx, "-y", `--package=${input.url}/downloads/orbit-agent.tgz`, "orbit-agent", "--url", input.url];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((arg) => `    <string>${escapeXml(arg)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(input.path)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(input.log)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(input.log)}</string>
</dict>
</plist>
`;
}

function launchctl(args: string[]) {
  try {
    execFileSync("/bin/launchctl", args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export async function installLaunchAgent(url: string) {
  if (process.platform !== "darwin") throw new Error("Starting at login is only set up on a Mac. Run orbit-agent in a terminal on other computers.");
  const npx = findOnPath("npx");
  if (!npx) throw new Error("Couldn't find npx. Install Node.js from nodejs.org, then run this again.");
  await mkdir(dirname(PLIST), { recursive: true });
  await mkdir(dirname(LOG_FILE), { recursive: true });
  await writeFile(PLIST, launchPlist({ npx, url, path: launchPath(npx), log: LOG_FILE }), { mode: 0o644 });
  const domain = `gui/${userInfo().uid}`;
  launchctl(["bootout", domain, PLIST]);
  if (!launchctl(["bootstrap", domain, PLIST]) && !launchctl(["load", "-w", PLIST])) {
    throw new Error(`macOS didn't start Orbit Agent. The setup file is at ${PLIST}.`);
  }
}

export async function uninstallLaunchAgent() {
  if (process.platform !== "darwin") return false;
  const existed = existsSync(PLIST);
  if (!launchctl(["bootout", `gui/${userInfo().uid}`, PLIST])) launchctl(["unload", "-w", PLIST]);
  await rm(PLIST, { force: true });
  return existed;
}
