import { describe, expect, it } from "vitest";

import { createTrayIconBuffer } from "../src/tray-icon";
import { DEFAULT_HOTKEY, HOTKEY_CANDIDATES, describeAccelerator } from "../src/tray";

describe("describeAccelerator", () => {
  it("spells out modifiers on Windows and Linux", () => {
    expect(describeAccelerator(DEFAULT_HOTKEY, "win32")).toBe("Ctrl + Shift + K");
    expect(describeAccelerator(DEFAULT_HOTKEY, "linux")).toBe("Ctrl + Shift + K");
  });

  it("uses glyphs on macOS", () => {
    expect(describeAccelerator(DEFAULT_HOTKEY, "darwin")).toBe("⌘⇧K");
  });

  it("keeps long key names readable and upper-cases single letters", () => {
    expect(describeAccelerator("Alt+Space", "win32")).toBe("Alt + Space");
    expect(describeAccelerator("CommandOrControl+Return", "darwin")).toBe("⌘↩");
  });
});

describe("hotkey candidates", () => {
  it("offers a fallback so an occupied shortcut degrades instead of vanishing", () => {
    expect(HOTKEY_CANDIDATES[0]).toBe(DEFAULT_HOTKEY);
    expect(HOTKEY_CANDIDATES.length).toBeGreaterThan(1);
    // Both must name a portable modifier; hard-coding Ctrl would break macOS.
    for (const candidate of HOTKEY_CANDIDATES) {
      expect(candidate).toContain("CommandOrControl");
    }
  });
});

describe("createTrayIconBuffer", () => {
  const png = createTrayIconBuffer();

  it("produces a valid 64x64 RGBA PNG", () => {
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.readUInt32BE(16)).toBe(64); // width
    expect(png.readUInt32BE(20)).toBe(64); // height
    expect(png[24]).toBe(8); // bit depth
    expect(png[25]).toBe(6); // truecolour + alpha
    expect(png.toString("ascii", 12, 16)).toBe("IHDR");
  });

  it("has a transparent corner and an opaque centre", () => {
    const pixels = decode(png, 64, 64);
    expect(alphaAt(pixels, 64, 0, 0)).toBe(0);
    expect(alphaAt(pixels, 64, 32, 32)).toBeGreaterThan(200);
  });

  it("draws a ring, not a filled disc", () => {
    const pixels = decode(png, 64, 64);
    // Centre dot, then a gap, then the ring: an opaque middle with a darker
    // band between it and the rim is what makes the glyph read as a ring.
    const centre = alphaAt(pixels, 64, 32, 32);
    const band = brightnessAt(pixels, 64, 32, 32 - 10);
    const rim = brightnessAt(pixels, 64, 32, 32 - 19);
    expect(centre).toBeGreaterThan(200);
    expect(rim).toBeGreaterThan(band);
  });
});

function decode(png: Buffer, width: number, height: number): Buffer {
  // Walk the chunks, inflate IDAT, and strip the per-scanline filter byte.
  let offset = 8;
  const idat: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") {
      idat.push(png.subarray(offset + 8, offset + 8 + length));
    }
    offset += 12 + length;
  }
  const { inflateSync } = require("node:zlib") as typeof import("node:zlib");
  const raw = inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    expect(raw[y * (1 + width * 4)]).toBe(0);
    raw.copy(pixels, y * width * 4, y * (1 + width * 4) + 1, (y + 1) * (1 + width * 4));
  }
  return pixels;
}

function alphaAt(pixels: Buffer, width: number, x: number, y: number): number {
  return pixels[(y * width + x) * 4 + 3];
}

function brightnessAt(pixels: Buffer, width: number, x: number, y: number): number {
  const offset = (y * width + x) * 4;
  return (pixels[offset] + pixels[offset + 1] + pixels[offset + 2]) / 3;
}
