import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { build } from "esbuild";

const output = "companion/dist/orbit-agent.mjs";
rmSync("companion/dist", { recursive: true, force: true });
await build({
  entryPoints: ["companion/src/index.ts"],
  outfile: output,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: ["@anthropic-ai/claude-agent-sdk", "zod"],
  banner: { js: "#!/usr/bin/env node" },
  legalComments: "none",
});
chmodSync(output, 0o755);
mkdirSync("public/downloads", { recursive: true });
const packed = execFileSync("npm", ["pack", "./companion", "--pack-destination", "public/downloads", "--silent"], { encoding: "utf8" }).trim().split("\n").pop();
renameSync(`public/downloads/${packed}`, "public/downloads/orbit-agent.tgz");
console.log("Packed public/downloads/orbit-agent.tgz");
