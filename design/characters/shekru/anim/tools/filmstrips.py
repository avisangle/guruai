"""Renders the posed SVG frames from filmstrips.mjs and assembles a contact sheet.
usage: python filmstrips.py <framesDir> <sheet.png> [cell_px] [--rows-dir DIR]
"""
import io, json, os, sys
import cairosvg
from PIL import Image, ImageDraw, ImageFont

src, out = sys.argv[1], sys.argv[2]
cell = int(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3].isdigit() else 256
rows_dir = sys.argv[sys.argv.index('--rows-dir') + 1] if '--rows-dir' in sys.argv else None
rows = json.load(open(os.path.join(src, 'manifest.json')))['rows']
try:
    font = ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc', max(12, cell // 16))
except OSError:
    font = ImageFont.load_default()
label_h = cell // 9
bg = (255, 250, 240)

def row_image(row):
    n = len(row['frames'])
    img = Image.new('RGB', (n * cell, cell + label_h), bg)
    d = ImageDraw.Draw(img)
    for i, f in enumerate(row['frames']):
        png = cairosvg.svg2png(url=os.path.join(src, f['file']), output_width=cell, output_height=cell)
        im = Image.open(io.BytesIO(png)).convert('RGBA')
        img.paste(im, (i * cell, label_h), im)
        d.rectangle([i * cell, label_h, (i + 1) * cell - 1, cell + label_h - 1], outline=(225, 215, 195))
        d.text((i * cell + 6, 4), f"{row['label']}  t={f['t']}s  [{f['state']}]", fill=(70, 50, 40), font=font)
    return img

imgs = [row_image(r) for r in rows]
if rows_dir:
    os.makedirs(rows_dir, exist_ok=True)
    for r, im in zip(rows, imgs):
        im.save(os.path.join(rows_dir, ''.join(c if c.isalnum() else '_' for c in r['label']) + '.png'))
w = max(im.width for im in imgs)
sheet = Image.new('RGB', (w, sum(im.height for im in imgs)), bg)
y = 0
for im in imgs:
    sheet.paste(im, (0, y)); y += im.height
sheet.save(out)
print(out, sheet.size)
