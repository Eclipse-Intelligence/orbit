const PREFIX = "data:image/png;base64,";
const IMAGE_MAX = 300_000;
const WIDTH_MAX = 2400;
const HEIGHT_MAX = 1200;
const MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function signatureImage(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith(PREFIX) || value.length > IMAGE_MAX) return null;
  const base64 = value.slice(PREFIX.length);
  if (!/^[A-Za-z0-9+/]+=*$/.test(base64)) return null;
  const head = Buffer.from(base64.slice(0, 44), "base64");
  if (head.length < 24 || MAGIC.some((byte, index) => head[index] !== byte) || head.toString("latin1", 12, 16) !== "IHDR") return null;
  const width = head.readUInt32BE(16);
  const height = head.readUInt32BE(20);
  return width > 0 && height > 0 && width <= WIDTH_MAX && height <= HEIGHT_MAX ? value : null;
}

export function cleanSignerText(value: unknown, max: number) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";
}
