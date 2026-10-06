"""Render the OCR test images. Run once; the PNGs are committed.

docker run --rm -v "$PWD/scripts/fixtures:/out" python:3.13-slim \
  sh -c 'pip install -q pillow && python /out/make-fixtures.py'
"""
from PIL import Image, ImageDraw, ImageFont

font = ImageFont.load_default(size=34)
small = ImageFont.load_default(size=28)

# 1. A short document with distinctive strings the OCR check looks for.
img = Image.new("RGB", (900, 420), "white")
d = ImageDraw.Draw(img)
lines = [
    (font, "LOCCI INVOICE 2026-0142"),
    (small, "Customer: Acme Ltd, Nairobi"),
    (small, "Service: GPU inference, 3 hours"),
    (small, "Total due: KES 12,450.00"),
]
y = 40
for f, text in lines:
    d.text((40, y), text, fill="black", font=f)
    y += 80
img.save("/out/ocr-text.png")

# 2. A small ruled table for `Table Recognition:`.
rows = [["Model", "Pool", "Size"], ["Qwen3-1.7B", "coder", "1.3 GB"], ["PaddleOCR-VL", "vision", "0.9 GB"]]
cw, rh, x0, y0 = 260, 70, 30, 30
img = Image.new("RGB", (x0 * 2 + cw * 3, y0 * 2 + rh * 3), "white")
d = ImageDraw.Draw(img)
for r, row in enumerate(rows):
    for c, cell in enumerate(row):
        x, y = x0 + c * cw, y0 + r * rh
        d.rectangle([x, y, x + cw, y + rh], outline="black", width=2)
        d.text((x + 16, y + 20), cell, fill="black", font=small)
img.save("/out/ocr-table.png")
print("ok")
