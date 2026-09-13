# Run with: uv run --with pillow dev/generate-icons.py
from pathlib import Path

from PIL import Image, ImageDraw

out = Path(__file__).resolve().parents[1] / "icons"
out.mkdir(exist_ok=True)
image = Image.new("RGB", (1024, 1024), "#2f6fed")
draw = ImageDraw.Draw(image)
# A stack of flashcards; the symbol stays inside Android's maskable safe area.
draw.rounded_rectangle((268, 242, 756, 682), radius=48, fill="#92b5ff")
draw.rounded_rectangle((242, 292, 730, 732), radius=48, fill="white")
draw.line((322, 442, 622, 442), fill="#2f6fed", width=32)
draw.line((322, 514, 542, 514), fill="#2f6fed", width=24)
draw.line((496, 612, 536, 652, 622, 566), fill="#2f6fed", width=28, joint="curve")
for name, size in [("icon-192", 192), ("icon-512", 512),
                   ("icon-maskable-512", 512), ("apple-touch-icon", 180)]:
    image.resize((size, size), Image.Resampling.LANCZOS).save(out / f"{name}.png")
