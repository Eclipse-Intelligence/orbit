import { deflateSync, inflateSync } from "node:zlib";
import { isDarkLogo } from "@/lib/proposals/logo-shade";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const MAX_PIXELS = 4_000_000;

export type Bitmap = { width: number; height: number; rgba: Uint8Array };

function paeth(left: number, up: number, upLeft: number) {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) return left;
  return toUp <= toUpLeft ? up : upLeft;
}

export function decodePng(file: Buffer): Bitmap | null {
  if (file.length < 33 || !file.subarray(0, 8).equals(SIGNATURE)) return null;
  let offset = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colour = 0;
  let interlace = 0;
  let palette: Buffer | null = null;
  let transparency: Buffer | null = null;
  const data: Buffer[] = [];
  while (offset + 8 <= file.length) {
    const length = file.readUInt32BE(offset);
    const type = file.toString("latin1", offset + 4, offset + 8);
    const body = file.subarray(offset + 8, offset + 8 + length);
    if (body.length < length) return null;
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8];
      colour = body[9];
      interlace = body[12];
    } else if (type === "PLTE") palette = body;
    else if (type === "tRNS") transparency = body;
    else if (type === "IDAT") data.push(body);
    else if (type === "IEND") break;
    offset += length + 12;
  }
  const channels = CHANNELS[colour];
  if (!channels || interlace !== 0 || !width || !height || width * height > MAX_PIXELS || ![1, 2, 4, 8, 16].includes(depth)) return null;
  if (colour === 3 && !palette) return null;
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(data));
  } catch {
    return null;
  }
  const bitsPerPixel = channels * depth;
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const step = Math.max(1, bitsPerPixel >> 3);
  if (raw.length < (stride + 1) * height) return null;
  const rows = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const source = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = rows.subarray(y * stride, (y + 1) * stride);
    const above = y > 0 ? rows.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= step ? row[x - step] : 0;
      const up = above ? above[x] : 0;
      const upLeft = above && x >= step ? above[x - step] : 0;
      const value = source[x];
      row[x] =
        filter === 0
          ? value
          : filter === 1
            ? value + left
            : filter === 2
              ? value + up
              : filter === 3
                ? value + ((left + up) >> 1)
                : filter === 4
                  ? value + paeth(left, up, upLeft)
                  : value;
    }
    if (filter > 4) return null;
  }
  const rgba = new Uint8Array(width * height * 4);
  const max = (1 << Math.min(depth, 8)) - 1;
  const sample = (row: Buffer, index: number) => {
    if (depth === 8) return row[index];
    if (depth === 16) return row[index * 2];
    const bit = index * depth;
    return (row[bit >> 3] >> (8 - depth - (bit & 7))) & max;
  };
  const scale = (value: number) => (depth >= 8 ? value : Math.round((value * 255) / max));
  for (let y = 0; y < height; y += 1) {
    const row = rows.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < width; x += 1) {
      const out = (y * width + x) * 4;
      if (colour === 3) {
        const index = sample(row, x);
        rgba[out] = palette![index * 3] ?? 0;
        rgba[out + 1] = palette![index * 3 + 1] ?? 0;
        rgba[out + 2] = palette![index * 3 + 2] ?? 0;
        rgba[out + 3] = transparency && index < transparency.length ? transparency[index] : 255;
      } else if (colour === 0 || colour === 4) {
        const grey = scale(sample(row, x * channels));
        rgba[out] = rgba[out + 1] = rgba[out + 2] = grey;
        rgba[out + 3] = colour === 4 ? scale(sample(row, x * channels + 1)) : 255;
      } else {
        rgba[out] = scale(sample(row, x * channels));
        rgba[out + 1] = scale(sample(row, x * channels + 1));
        rgba[out + 2] = scale(sample(row, x * channels + 2));
        rgba[out + 3] = colour === 6 ? scale(sample(row, x * channels + 3)) : 255;
      }
    }
  }
  return { width, height, rgba };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(buffer: Buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Buffer) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "latin1");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, tail]);
}

export function encodePng(bitmap: Bitmap) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(bitmap.width, 0);
  header.writeUInt32BE(bitmap.height, 4);
  header[8] = 8;
  header[9] = 6;
  const stride = bitmap.width * 4;
  const raw = Buffer.alloc((stride + 1) * bitmap.height);
  for (let y = 0; y < bitmap.height; y += 1) Buffer.from(bitmap.rgba.buffer, bitmap.rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  return Buffer.concat([SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function pngOf(dataUri: string) {
  const comma = dataUri.indexOf(",");
  return comma < 0 ? null : Buffer.from(dataUri.slice(comma + 1), "base64");
}

export function logoIsDark(dataUri: string | null | undefined) {
  if (!dataUri) return false;
  const file = pngOf(dataUri);
  const bitmap = file ? decodePng(file) : null;
  return bitmap ? isDarkLogo(bitmap.rgba) : true;
}

export function logoForDarkBand(dataUri: string | null | undefined) {
  if (!dataUri) return null;
  const file = pngOf(dataUri);
  if (!file) return null;
  const bitmap = decodePng(file);
  if (!bitmap) return file;
  if (!isDarkLogo(bitmap.rgba)) return file;
  const white = new Uint8Array(bitmap.rgba);
  for (let index = 0; index < white.length; index += 4) {
    white[index] = 255;
    white[index + 1] = 255;
    white[index + 2] = 255;
  }
  return encodePng({ width: bitmap.width, height: bitmap.height, rgba: white });
}
