#!/usr/bin/env python3
"""Generate the extension icons (src/icons/icon-*.png) plus a matching SVG.

Pure stdlib (zlib + struct): a rounded indigo gradient square with a white
dictionary-card motif. 16/32/48/96/128 px PNGs plus icons/icon.svg.

Usage:  python tools/make_icons.py
"""

from __future__ import annotations

import math
import os
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "src", "icons")

TOP = (79, 70, 229)      # indigo-600
BOTTOM = (124, 58, 237)  # violet-600
WHITE = (255, 255, 255)
INK = (49, 46, 129)
SOFT = (199, 210, 254)


def clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def sdf_rounded_rect(x, y, x0, y0, x1, y1, radius):
    cx = max(x0 + radius, min(x, x1 - radius))
    cy = max(y0 + radius, min(y, y1 - radius))
    dx = x - cx
    dy = y - cy
    outside = math.hypot(max(abs(x - (x0 + x1) / 2) - (x1 - x0) / 2 + radius, 0.0),
                         max(abs(y - (y0 + y1) / 2) - (y1 - y0) / 2 + radius, 0.0))
    inside = min(max(x0 - x, x - x1, y0 - y, y - y1), 0.0)
    return outside + inside - radius


def coverage(sdf: float) -> float:
    return clamp(0.5 - sdf, 0.0, 1.0)


def over(dst, src):
    """Porter-Duff source-over for premultiplied-free RGBA floats."""
    (dr, dg, db, da) = dst
    (sr, sg, sb, sa) = src
    out_a = sa + da * (1.0 - sa)
    if out_a <= 0.0:
        return (0.0, 0.0, 0.0, 0.0)
    return ((sr * sa + dr * da * (1.0 - sa)) / out_a,
            (sg * sa + dg * da * (1.0 - sa)) / out_a,
            (sb * sa + db * da * (1.0 - sa)) / out_a,
            out_a)


def mix(first, second, t):
    return tuple(first[i] + (second[i] - first[i]) * t for i in range(3))


def render(size: int) -> bytes:
    pixels = bytearray()
    for py in range(size):
        row = bytearray([0])
        for px in range(size):
            x = px + 0.5
            y = py + 0.5
            t = y / size
            base = mix(TOP, BOTTOM, t)
            color = (base[0] / 255.0, base[1] / 255.0, base[2] / 255.0, 0.0)
            # background rounded square
            bg = sdf_rounded_rect(x, y, 1, 1, size - 1, size - 1, size * 0.22)
            color = over(color, (base[0] / 255.0, base[1] / 255.0, base[2] / 255.0,
                                 coverage(bg)))
            # white dictionary card
            card = sdf_rounded_rect(x, y, size * 0.30, size * 0.18,
                                    size * 0.76, size * 0.84, size * 0.05)
            color = over(color, (1.0, 1.0, 1.0, coverage(card) * 0.96))
            # three text lines
            for i, (yy, x1) in enumerate(((0.34, 0.66), (0.47, 0.70), (0.60, 0.62))):
                line = sdf_rounded_rect(x, y, size * 0.38, size * yy - size * 0.02,
                                        size * x1, size * yy + size * 0.02, size * 0.02)
                color = over(color, (INK[0] / 255.0, INK[1] / 255.0, INK[2] / 255.0,
                                     coverage(line) * 0.92))
            # accent lookup dot with a soft halo
            cx = size * 0.76
            cy = size * 0.76
            dist = math.hypot(x - cx, y - cy)
            halo = over((0, 0, 0, 0), (SOFT[0] / 255.0, SOFT[1] / 255.0, SOFT[2] / 255.0,
                                       clamp(1.0 - dist / (size * 0.16), 0.0, 1.0) * 0.9))
            color = over(color, halo)
            dot = over((0, 0, 0, 0), (INK[0] / 255.0, INK[1] / 255.0, INK[2] / 255.0,
                                      coverage(dist - size * 0.075)))
            color = over(color, dot)
            row += bytes((int(clamp(color[0]) * 255 + 0.5),
                          int(clamp(color[1]) * 255 + 0.5),
                          int(clamp(color[2]) * 255 + 0.5),
                          int(clamp(color[3]) * 255 + 0.5)))
        pixels += row
    return bytes(pixels)


def chunk(kind: bytes, data: bytes) -> bytes:
    body = kind + data
    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))


def write_png(path: str, size: int, raw: bytes) -> None:
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    with open(path, "wb") as handle:
        handle.write(b"\x89PNG\r\n\x1a\n")
        handle.write(chunk(b"IHDR", ihdr))
        handle.write(chunk(b"IDAT", zlib.compress(raw, 9)))
        handle.write(chunk(b"IEND", b""))


SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#4f46e5"/>
      <stop offset="1" stop-color="#7c3aed"/>
    </linearGradient>
  </defs>
  <rect x="2" y="2" width="124" height="124" rx="28" fill="url(#g)"/>
  <rect x="38" y="23" width="42" height="82" rx="6" fill="#ffffff" opacity="0.96"/>
  <rect x="49" y="40" width="24" height="5" rx="2.5" fill="#312e81" opacity="0.92"/>
  <rect x="49" y="56" width="29" height="5" rx="2.5" fill="#312e81" opacity="0.92"/>
  <rect x="49" y="72" width="21" height="5" rx="2.5" fill="#312e81" opacity="0.92"/>
  <circle cx="97" cy="97" r="12" fill="#a5b4fc" opacity="0.9"/>
  <circle cx="97" cy="97" r="7" fill="#312e81"/>
</svg>
"""


def main() -> int:
    os.makedirs(OUT, exist_ok=True)
    for size in (16, 32, 48, 96, 128):
        path = os.path.join(OUT, "icon-%d.png" % size)
        write_png(path, size, render(size))
        print("wrote", path, "(%d bytes)" % os.path.getsize(path))
    svg_path = os.path.join(OUT, "icon.svg")
    with open(svg_path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(SVG)
    print("wrote", svg_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
