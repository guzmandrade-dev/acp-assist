#!/usr/bin/env python3
"""Render the sidebar deck icon (extension/icon.png).

The deck IconURL (Sidebar.xcu) points at icon.png and LibreOffice
renders a PNG at native size in the deck bar, so this is a 32x32 RGBA.
The icon must stay high-contrast on the LIGHT deck bar: the previous
version was the app logo (light paper card on a transparent background)
and rendered as a near-invisible white square (user report 2026-11-07,
AGENTS.md rule 41). This design mirrors public/logo.svg — tilted paper
card with a LibreOffice-green title bar and a red AI spark — on a solid
dark rounded square. Drawn at 4x supersampling, downscaled with LANCZOS.

Usage: python scripts/generate-sidebar-icon.py [--out extension/icon.png] [--size 32]
"""

import argparse
import os

from PIL import Image, ImageDraw

S = 4                            # supersample factor
BG = (31, 35, 43, 255)           # dark slate rounded square
CARD = (250, 248, 242, 255)      # paper card
CARD_EDGE = (216, 210, 196, 255)
GREEN = (24, 163, 3, 255)        # LibreOffice green title bar
SPARK = (217, 79, 43, 255)       # red AI spark


def render(size: int) -> Image.Image:
    n = size * S
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, n - 1, n - 1], radius=7 * S, fill=BG)

    # Tilted paper card on its own layer, rotated -6 deg like logo.svg.
    card = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    cd = ImageDraw.Draw(card)
    cd.rounded_rectangle([8 * S, 6 * S, 24 * S, 27 * S], radius=3 * S,
                         fill=CARD, outline=CARD_EDGE, width=S)
    # Green title bar (body text lines vanish at 32px).
    cd.rounded_rectangle([11 * S, 10 * S, 21 * S, 13 * S], radius=1.5 * S,
                         fill=GREEN)
    card = card.rotate(-6, resample=Image.BICUBIC,
                       center=(16 * S, 16.5 * S))
    img = Image.alpha_composite(img, card)

    # Red 4-point spark overlapping the card's top-right corner.
    d = ImageDraw.Draw(img)
    sx, sy, sr = 24.5 * S, 7.5 * S, 5.5 * S
    k = 0.28
    pts = [(sx, sy - sr), (sx + k * sr, sy - k * sr), (sx + sr, sy),
           (sx + k * sr, sy + k * sr), (sx, sy + sr), (sx - k * sr, sy + k * sr),
           (sx - sr, sy), (sx - k * sr, sy - k * sr)]
    for i in range(len(pts)):
        d.line([pts[i], pts[(i + 1) % len(pts)]],
               fill=(255, 255, 255, 255), width=2 * S)
    d.polygon(pts, fill=SPARK)

    return img.resize((size, size), Image.LANCZOS)


def main() -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    repo = os.path.dirname(here)
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", default=os.path.join(repo, "extension", "icon.png"),
                    help="output PNG path (default: <repo>/extension/icon.png)")
    ap.add_argument("--size", type=int, default=32,
                    help="icon edge in px (default: 32, the deck-bar native size)")
    args = ap.parse_args()

    img = render(args.size)
    img.save(args.out)
    print(f"wrote {args.out} ({img.size[0]}x{img.size[1]}, {os.path.getsize(args.out)} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
