#!/usr/bin/env python3
"""Generate Annotate & Edit toolbar icons (stdlib only).

Design: indigo circle with a subtle diagonal gradient, carrying a white
"AI sparkle" — a 4-point star with a pinched waist — plus a small
companion sparkle. Rendered at 4x and downsampled for smooth edges.

Usage: python3 tools/gen_icons.py
"""
import math
import os
import struct
import zlib

SIZES = [16, 32, 48, 128]
SS = 4  # supersample factor

BG_TOP = (107, 141, 255)   # lighter indigo, top-left
BG_BOT = (61, 95, 230)     # deeper indigo, bottom-right
FG = (255, 255, 255)       # white sparkle


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def in_poly(x, y, pts):
    """Even-odd point-in-polygon test."""
    inside = False
    n = len(pts)
    for i in range(n):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % n]
        if (y1 > y) != (y2 > y):
            if x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
                inside = not inside
    return inside


def sparkle(cx, cy, R, waist):
    """4-point star polygon: tips at N/E/S/W radius R, concave pinches on
    the diagonals at radius waist."""
    pts = []
    for i in range(8):
        ang = math.radians(i * 45 - 90)
        rad = R if i % 2 == 0 else waist
        pts.append((cx + rad * math.cos(ang), cy + rad * math.sin(ang)))
    return pts


def pixel(x, y, size):
    # --- tile: full circle with a diagonal gradient
    c = size * 0.5
    r = size * 0.48
    if (x - c) ** 2 + (y - c) ** 2 > r * r:
        return (0, 0, 0, 0)
    t = (x + y) / (2 * size)                       # 0 top-left → 1 bottom-right
    bg = lerp(BG_TOP, BG_BOT, t)

    # --- sparkles: big centered star + small companion top-right
    big = sparkle(size * 0.50, size * 0.50, size * 0.31, size * 0.078)
    small = sparkle(size * 0.71, size * 0.28, size * 0.095, size * 0.026)
    if in_poly(x, y, big) or in_poly(x, y, small):
        return (*FG, 255)
    return (*bg, 255)


def write_png(path, size):
    big = size * SS
    rows_big = [[pixel(x + 0.5, y + 0.5, big) for x in range(big)] for y in range(big)]
    raw = bytearray()
    for y in range(size):
        raw.append(0)  # filter type none
        for x in range(size):
            acc = [0, 0, 0, 0]
            for sy in range(SS):
                for sx in range(SS):
                    p = rows_big[y * SS + sy][x * SS + sx]
                    for i in range(4):
                        acc[i] += p[i]
            raw.extend(bytes(v // (SS * SS) for v in acc))

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as f:
        f.write(png)
    print(f"wrote {path} ({size}x{size})")


if __name__ == "__main__":
    out = os.path.join(os.path.dirname(__file__), "..", "extension", "icons")
    os.makedirs(out, exist_ok=True)
    for s in SIZES:
        write_png(os.path.join(out, f"icon{s}.png"), s)
