# Run with: uv run --with pillow dev/generate-icons.py
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

S = 1024
OUT = Path(__file__).resolve().parents[1] / "icons"
FONT = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
INK = (37, 48, 92, 255)


def gradient(c1, c2):
    img = Image.new("RGB", (S, S))
    px = img.load()
    for y in range(S):
        for x in range(S):
            t = (x + y) / (2 * S)
            px[x, y] = tuple(int(a + (b - a) * t) for a, b in zip(c1, c2))
    return img.convert("RGBA")


def card(w, h, fill, angle, shadow=False):
    pad = 120
    layer = Image.new("RGBA", (w + 2 * pad, h + 2 * pad), (0, 0, 0, 0))
    if shadow:
        ImageDraw.Draw(layer).rounded_rectangle((pad, pad + 18, pad + w, pad + h + 18), radius=64, fill=(0, 0, 0, 70))
        layer = layer.filter(ImageFilter.GaussianBlur(22))
    ImageDraw.Draw(layer).rounded_rectangle((pad, pad, pad + w, pad + h), radius=64, fill=fill)
    return layer.rotate(angle, resample=Image.Resampling.BICUBIC, expand=True)


def paste_center(base, layer, cx, cy):
    base.alpha_composite(layer, (int(cx - layer.width / 2), int(cy - layer.height / 2)))


img = gradient((72, 96, 235), (128, 70, 220))
W, H = 520, 380
cx, cy = S / 2, S / 2 + 10
# Everything stays inside Android's maskable safe circle (radius 409).
paste_center(img, card(W, H, (255, 255, 255, 110), 10), cx + 26, cy - 34)
paste_center(img, card(W, H, (255, 255, 255, 180), 5), cx + 12, cy - 16)
front = card(W, H, (255, 255, 255, 255), 0, shadow=True)
ImageDraw.Draw(front).text((front.width / 2, front.height / 2 - 6), "SRS",
                           font=ImageFont.truetype(FONT, 190), fill=INK, anchor="mm")
paste_center(img, front, cx, cy)

OUT.mkdir(exist_ok=True)
for name, size in [("icon-192", 192), ("icon-512", 512),
                   ("icon-maskable-512", 512), ("apple-touch-icon", 180)]:
    img.convert("RGB").resize((size, size), Image.Resampling.LANCZOS).save(OUT / f"{name}.png")
