import { deflateSync } from "node:zlib";

/**
 * The tray icon is drawn at runtime instead of shipped as a file: the app is
 * bundled into `dist/main.cjs`, so a relative asset path would depend on how
 * the build output is laid out (and on asar packing later). Drawing it costs a
 * fraction of a millisecond and keeps the shell dependency-free.
 *
 * The shape is the app's namesake — a ring — on a dark disc so the glyph stays
 * legible on both light and dark taskbars.
 */

const CRC_TABLE = buildCrcTable();

export function createTrayIconBuffer(size = 64): Buffer {
  const pixels = new Uint8Array(size * size * 4);
  const center = (size - 1) / 2;
  const radius = size / 2 - 1;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const distance = Math.hypot(x - center, y - center);
      // Start fully transparent so the disc's rounded edge keeps its own
      // anti-aliasing instead of inheriting the square canvas.
      let color: Rgba = [0, 0, 0, 0];
      color = over(color, [38, 42, 56, 255], coverage(radius - distance));
      color = over(color, [125, 156, 255, 255], ringCoverage(distance, size));
      color = over(color, [242, 245, 255, 255], coverage(size * 0.075 - distance));
      const offset = (y * size + x) * 4;
      pixels[offset] = color[0];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[2];
      pixels[offset + 3] = color[3];
    }
  }

  return encodePng(pixels, size, size);
}

type Rgba = [number, number, number, number];

/** Anti-aliased edge: 1 well inside the shape, 0 well outside, smooth between. */
function coverage(distanceInsideEdge: number, feather = 1.25): number {
  return clamp(distanceInsideEdge / feather + 0.5, 0, 1);
}

/** A ring, i.e. the area between two radii. */
function ringCoverage(distance: number, size: number): number {
  const thickness = size * 0.11;
  const middle = size * 0.29;
  return coverage(thickness - Math.abs(distance - middle));
}

/** Source-over compositing, with the source already pre-scaled by its alpha. */
function over(destination: Rgba, source: Rgba, alpha: number): Rgba {
  if (alpha <= 0) {
    return destination;
  }
  const a = alpha * (source[3] / 255);
  const remaining = 1 - a;
  return [
    Math.round(source[0] * a + destination[0] * remaining),
    Math.round(source[1] * a + destination[1] * remaining),
    Math.round(source[2] * a + destination[2] * remaining),
    Math.round(a * 255 + destination[3] * remaining)
  ];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function encodePng(rgba: Uint8Array, width: number, height: number): Buffer {
  // Filter byte 0 ("none") in front of every scanline — no need to implement
  // the other filters to produce a valid image.
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    raw[y * (1 + width * 4)] = 0;
    Buffer.from(rgba.buffer, y * width * 4, width * 4).copy(raw, y * (1 + width * 4) + 1);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: truecolour with alpha
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, crc]);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let round = 0; round < 8; round += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}
