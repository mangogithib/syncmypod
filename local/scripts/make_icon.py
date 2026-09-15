"""Draws the application icon, so the .ico is reproducible rather than mystery bytes.

The artwork is the same mark as ``gui/static/favicon.svg`` and the header of
both interfaces: an iPod outline on a rounded blue tile. It is drawn here with
primitives rather than rasterised from the SVG because that would need a
renderer nothing else in this project uses, for one small file.

Run it when the mark changes:

    python scripts/make_icon.py

Needs Pillow, which is already a dependency through pypodlib's artwork extra.
The result is committed - a few kilobytes, unlike ffmpeg - so a build needs
neither this script nor Pillow.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "packaging" / "icon.ico"

TILE = "#3b62d4"
INK = "#ffffff"
# Every size Windows asks for. Each is drawn at its own scale rather than
# downsampled from one big one, so the 16px version keeps a readable outline
# instead of turning into four grey pixels.
SIZES = (16, 24, 32, 48, 64, 128, 256)


def draw(size: int) -> Image.Image:
    # 4x supersampling, then one resize. Pillow has no antialiased drawing, and
    # a 1px stroke at 16px without it is a staircase.
    scale = 4
    px = size * scale
    image = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    pen = ImageDraw.Draw(image)

    unit = px / 32.0
    stroke = max(1, round(1.9 * unit))

    pen.rounded_rectangle((0, 0, px - 1, px - 1), radius=round(7 * unit), fill=TILE)

    # The body: a rounded rectangle, inset the way the SVG has it.
    pen.rounded_rectangle(
        (round(9 * unit), round(5 * unit), round(23 * unit), round(27 * unit)),
        radius=round(3.2 * unit),
        outline=INK,
        width=stroke,
    )
    # The screen, reduced to the line it becomes at this size.
    pen.line(
        (round(12.5 * unit), round(9.5 * unit), round(19.5 * unit), round(9.5 * unit)),
        fill=INK,
        width=stroke,
    )
    # The wheel, and its centre.
    pen.ellipse(
        (round(12 * unit), round(15 * unit), round(20 * unit), round(23 * unit)),
        outline=INK,
        width=stroke,
    )
    pen.ellipse(
        (round(14.9 * unit), round(17.9 * unit), round(17.1 * unit), round(20.1 * unit)),
        fill=INK,
    )

    return image.resize((size, size), Image.LANCZOS)


def main() -> int:
    frames = [draw(size) for size in SIZES]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    frames[-1].save(OUT, format="ICO", sizes=[(s, s) for s in SIZES], append_images=frames[:-1])
    print(f"Wrote {OUT} ({OUT.stat().st_size} bytes, {len(SIZES)} sizes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
