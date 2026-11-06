import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { build } from "esbuild";
import { zipSync } from "fflate";

const zip = process.argv.includes("--zip");
const source = "extension";
const out = "extension/dist";
const orbitUrl = (process.env.ORBIT_URL || "https://orbit.geteclipse.co").replace(/\/+$/, "");
const linkedinUrl = (process.env.LINKEDIN_URL || "https://www.linkedin.com").replace(/\/+$/, "");
const version = JSON.parse(readFileSync(`${source}/version.json`, "utf8")).version;
const chromeVersion = "116";
const target = `chrome${chromeVersion}`;
const font = `${source}/fonts/geist-latin.woff2`;

if (!existsSync(font)) {
  console.error(`Missing ${font}. The panel font must be bundled with the extension.`);
  process.exit(1);
}

function origin(value, name) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") throw new Error("https only");
    return url.origin;
  } catch {
    console.error(`${name} must be an https origin such as https://example.com (http is allowed for localhost).`);
    process.exit(1);
  }
}

const orbitOrigin = origin(orbitUrl, "ORBIT_URL");
const linkedinOrigin = origin(linkedinUrl, "LINKEDIN_URL");
const publicKey = readFileSync(`${source}/key.pub`, "utf8").trim();

function extensionId(key) {
  const hex = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32);
  return [...hex].map((char) => String.fromCharCode(97 + parseInt(char, 16))).join("");
}

rmSync(out, { recursive: true, force: true });
mkdirSync(`${out}/icons`, { recursive: true });

await build({
  entryPoints: {
    background: `${source}/src/background.ts`,
    panel: `${source}/src/panel/main.ts`,
  },
  outdir: out,
  bundle: true,
  format: "esm",
  target,
  platform: "browser",
  minify: zip,
  legalComments: "none",
  loader: { ".svg": "text" },
  define: {
    __ORBIT_URL__: JSON.stringify(orbitOrigin),
    __LINKEDIN_URL__: JSON.stringify(linkedinOrigin),
  },
  logLevel: "warning",
});

await build({
  entryPoints: { content: `${source}/src/content.ts` },
  outdir: out,
  bundle: true,
  format: "iife",
  target,
  platform: "browser",
  minify: zip,
  legalComments: "none",
  logLevel: "warning",
});

copyFileSync(`${source}/src/panel/panel.html`, `${out}/panel.html`);
copyFileSync(`${source}/src/panel/panel.css`, `${out}/panel.css`);
copyFileSync(font, `${out}/geist-latin.woff2`);
for (const size of [16, 32, 48, 128]) copyFileSync(`${source}/icons/icon-${size}.png`, `${out}/icons/icon-${size}.png`);

const icons = { 16: "icons/icon-16.png", 32: "icons/icon-32.png", 48: "icons/icon-48.png", 128: "icons/icon-128.png" };
const manifest = {
  manifest_version: 3,
  name: "Orbit LinkedIn capture",
  short_name: "Orbit",
  description: "Look up and save LinkedIn people and companies in Orbit, and log conversations when you ask.",
  version,
  minimum_chrome_version: chromeVersion,
  ...(zip ? {} : { key: publicKey }),
  permissions: ["sidePanel", "storage"],
  host_permissions: [`${linkedinOrigin}/*`, `${orbitOrigin}/*`],
  background: { service_worker: "background.js", type: "module" },
  side_panel: { default_path: "panel.html" },
  action: { default_title: "Orbit", default_icon: icons },
  icons,
  content_scripts: [{ matches: [`${linkedinOrigin}/*`], js: ["content.js"], run_at: "document_idle" }],
};
writeFileSync(`${out}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Built ${out} for Orbit ${orbitOrigin} and LinkedIn ${linkedinOrigin}.`);
if (!zip) console.log(`Unpacked extension ID: ${extensionId(publicKey)}`);

if (zip) {
  const files = {};
  const walk = (folder) => {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (!name.endsWith(".zip")) files[relative(out, path)] = readFileSync(path);
    }
  };
  walk(out);
  writeFileSync(`${out}/orbit-linkedin-capture.zip`, zipSync(files, { level: 9 }));
  console.log(`Zipped ${out}/orbit-linkedin-capture.zip (no key, the Chrome Web Store assigns the ID).`);
}
