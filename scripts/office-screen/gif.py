#!/usr/bin/env python3
"""Development only: draws a film that run.mjs recorded (the record and stop steps: <name>.frames.json) as a GIF.

Needs Python 3 and Pillow (pip install pillow). Block elements and box lines are drawn as rectangles and lines, so
they meet cell to cell as a terminal draws them; every other character comes from a monospace font (Cascadia Mono,
else Consolas), and a mark that font lacks from a symbol font (Segoe UI Symbol). The colours are the ones the film
recorded; the terminal's own two and its palette are those of Windows Terminal's default dark scheme.

  python scripts/office-screen/gif.py <frames.json> -o <out.gif> [options]

  --crop pane|all|X,Y,W,H  the part of the screen: pane (the plugin pane right of the chat, rows blank in every
                           frame left out; default), all, or cells (0-based column and row, width, height)
  --from S --to S          the part of the film, in seconds from its start
  --fps N                  frames a second in the GIF (default 10); frames that look the same are one
  --speed F                faster (2) or slower (0.5) than it was filmed
  --hold S                 how long the last frame stays before the GIF starts over (default 1.5)
  --font-size N            the font's size in pixels (default 16); a cell is as wide as its letters, twice as tall
  --pad N                  pixels around the crop, in its own background (default 10)
  --png S[,S...]           also writes the frame shown at these seconds of the GIF as PNG
  --png-dir DIR            where those go (default: beside the GIF)
  --text FILE              writes the crop's text of every frame of the GIF, to read for what must not show
"""

import argparse
import bisect
import json
import math
import os
import sys

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    sys.exit('gif.py needs Pillow: pip install pillow')

# Windows Terminal's default dark scheme (Campbell): its foreground and background, then its sixteen colours
DEFAULT_FG = (0xCC, 0xCC, 0xCC)
DEFAULT_BG = (0x0C, 0x0C, 0x0C)
BASE16 = ['0C0C0C', 'C50F1F', '13A10E', 'C19C00', '0037DA', '881798', '3A96DD', 'CCCCCC',
          '767676', 'E74856', '16C60C', 'F9F1A5', '3B78FF', 'B4009E', '61D6D6', 'F2F2F2']


def palette256():
    pal = [tuple(int(h[i:i + 2], 16) for i in (0, 2, 4)) for h in BASE16]
    steps = [0, 95, 135, 175, 215, 255]
    pal += [(r, g, b) for r in steps for g in steps for b in steps]
    pal += [(8 + 10 * i,) * 3 for i in range(24)]
    return pal


PALETTE = palette256()
BOLD, DIM, ITALIC, UNDERLINE, INVERSE, INVISIBLE, STRIKE = 1, 2, 4, 8, 16, 32, 64


def colour(c, default):
    if c is None:
        return default
    if isinstance(c, int):
        return PALETTE[c] if 0 <= c < 256 else default
    return tuple(int(c[i:i + 2], 16) for i in (1, 3, 5))


def mix(a, b, f):
    """a toward b by f (0..1)."""
    return tuple(round(x + (y - x) * f) for x, y in zip(a, b))


def resolve(style):
    """A recorded style as it is drawn: (fg, bg, bold, italic, underline, strike)."""
    fg, bg, flags = style
    if isinstance(fg, int) and fg < 8 and flags & BOLD:
        fg += 8                                  # Windows Terminal draws bold in the bright colours
    f, b = colour(fg, DEFAULT_FG), colour(bg, DEFAULT_BG)
    if flags & INVERSE:
        f, b = b, f
    if flags & DIM:
        f = mix(f, b, 0.5)
    if flags & INVISIBLE:
        f = b
    return f, b, bool(flags & BOLD), bool(flags & ITALIC), bool(flags & UNDERLINE), bool(flags & STRIKE)


# ------------------------------------------------------------------ fonts

def font_dirs():
    dirs = [os.path.join(os.environ.get('WINDIR', r'C:\Windows'), 'Fonts')]
    if os.environ.get('LOCALAPPDATA'):
        dirs.append(os.path.join(os.environ['LOCALAPPDATA'], 'Microsoft', 'Windows', 'Fonts'))
    dirs += ['/usr/share/fonts', '/Library/Fonts', os.path.expanduser('~/Library/Fonts')]
    return dirs


def find_font(names):
    for d in font_dirs():
        for n in names:
            p = os.path.join(d, n)
            if os.path.isfile(p):
                return p
    return None


def load_fonts(size):
    """(regular, bold, symbol fallbacks): Cascadia Mono, else Consolas; then Segoe UI Symbol and the like."""
    cascadia = find_font(['CascadiaMono.ttf', 'CascadiaMono-Regular.ttf'])
    if cascadia:
        regular = ImageFont.truetype(cascadia, size)
        bold_path = find_font(['CascadiaMono-Bold.ttf'])
        if bold_path:
            bold = ImageFont.truetype(bold_path, size)
        else:
            bold = ImageFont.truetype(cascadia, size)
            try:
                bold.set_variation_by_name('Bold')
            except Exception:
                bold = regular
    else:
        consolas = find_font(['consola.ttf'])
        if not consolas:
            sys.exit('gif.py: neither Cascadia Mono nor Consolas is installed')
        regular = ImageFont.truetype(consolas, size)
        bold_path = find_font(['consolab.ttf'])
        bold = ImageFont.truetype(bold_path, size) if bold_path else regular
    fallbacks = [p for p in (find_font([n]) for n in ['seguisym.ttf', 'segoeui.ttf', 'msgothic.ttc', 'malgun.ttf']) if p]
    return regular, bold, fallbacks


class Glyphs:
    """Which font draws a character: the monospace one when it has it, else the first fallback that does."""

    def __init__(self, size):
        self.size = size
        self.regular, self.bold, self.fallback_paths = load_fonts(size)
        self.fallbacks = [ImageFont.truetype(p, size) for p in self.fallback_paths]
        self.cache = {}

    @staticmethod
    def has(font, ch):
        # a character a font lacks comes out as its .notdef box, the same as a private-use one
        try:
            m, n = font.getmask(ch), font.getmask('\ue000')
        except Exception:
            return False
        return not (m.size == n.size and bytes(m) == bytes(n))

    def pick(self, ch, bold):
        key = (ch, bold)
        if key not in self.cache:
            mono = self.bold if bold else self.regular
            font = mono if self.has(mono, ch) else next((f for f in self.fallbacks if self.has(f, ch)), mono)
            self.cache[key] = font
        return self.cache[key]


# ------------------------------------------------------------------ cells drawn by hand

QUADS = {  # upper-left, upper-right, lower-left, lower-right
    '▘': 'a', '▝': 'b', '▖': 'c', '▗': 'd', '▀': 'ab', '▄': 'cd', '▌': 'ac', '▐': 'bd', '█': 'abcd',
    '▙': 'acd', '▛': 'abc', '▜': 'abd', '▟': 'bcd', '▚': 'ad', '▞': 'bc',
}
LOWER = {chr(0x2581 + i): i + 1 for i in range(7)}           # ▁ … ▇: eighths from the bottom
LEFT = {chr(0x258F - i): i + 1 for i in range(7)}            # ▏ … ▉: eighths from the left
SHADES = {'░': 0.25, '▒': 0.5, '▓': 0.75}
# box lines: their arms (up, down, left, right) and whether the corner is round
ARMS = {
    '─': 'lr', '│': 'ud', '┌': 'dr', '┐': 'dl', '└': 'ur', '┘': 'ul', '├': 'udr', '┤': 'udl', '┬': 'dlr', '┴': 'ulr',
    '┼': 'udlr', '╭': 'dr', '╮': 'dl', '╰': 'ur', '╯': 'ul', '╴': 'l', '╶': 'r', '╵': 'u', '╷': 'd',
    '━': 'lr', '┃': 'ud',
}
ROUND = set('╭╮╰╯')
HEAVY = set('━┃')


def by_hand(draw, ch, x0, w, h, fg, bg):
    """Draws the cell's character as shapes; False when it is not one of them."""
    hw, hh = w // 2, h // 2
    rect = lambda a, b, c, d: draw.rectangle([x0 + a, b, x0 + c - 1, d - 1], fill=fg) if c > a and d > b else None
    if ch in QUADS:
        q = QUADS[ch]
        if 'a' in q: rect(0, 0, hw, hh)
        if 'b' in q: rect(hw, 0, w, hh)
        if 'c' in q: rect(0, hh, hw, h)
        if 'd' in q: rect(hw, hh, w, h)
        return True
    if ch in LOWER:
        rect(0, h - round(h * LOWER[ch] / 8), w, h)
        return True
    if ch in LEFT:
        rect(0, 0, round(w * LEFT[ch] / 8), h)
        return True
    if ch == '▔':
        rect(0, 0, w, max(1, round(h / 8)))
        return True
    if ch == '▕':
        rect(w - max(1, round(w / 8)), 0, w, h)
        return True
    if ch in SHADES:
        draw.rectangle([x0, 0, x0 + w - 1, h - 1], fill=mix(bg, fg, SHADES[ch]))
        return True
    if ch in ARMS:
        arms = ARMS[ch]
        t = max(1, round(w / 9)) * (2 if ch in HEAVY else 1)
        cx, cy = hw - t // 2, hh - t // 2            # the line's first pixel column and row
        if ch in ROUND:
            r = max(2, min(hw, hh) - 1)
            # the arms stop where the quarter circle takes over
            if 'u' in arms: rect(cx, 0, cx + t, cy - r + 1)
            if 'd' in arms: rect(cx, cy + r, cx + t, h)
            if 'l' in arms: rect(0, cy, cx - r + 1, cy + t)
            if 'r' in arms: rect(cx + r, cy, w, cy + t)
            ox = cx + r if 'r' in arms else cx - r
            oy = cy + r if 'd' in arms else cy - r
            start = {'╭': 180, '╮': 270, '╯': 0, '╰': 90}[ch]
            draw.arc([x0 + ox - r, oy - r, x0 + ox + r, oy + r], start, start + 90, fill=fg, width=t)
            return True
        if 'u' in arms: rect(cx, 0, cx + t, cy + t)
        if 'd' in arms: rect(cx, cy, cx + t, h)
        if 'l' in arms: rect(0, cy, cx + t, cy + t)
        if 'r' in arms: rect(cx, cy, w, cy + t)
        return True
    return False


# ------------------------------------------------------------------ the painter

class Painter:
    def __init__(self, size, levels):
        self.glyphs = Glyphs(size)
        mono = self.glyphs.regular
        self.cw = max(1, round(mono.getlength('M')))
        self.ch = self.cw * 2
        asc, desc = mono.getmetrics()
        self.baseline = (self.ch - (asc + desc)) // 2 + asc
        self.levels = levels
        self.tiles = {}

    def alpha(self, mask):
        """The glyph's coverage in a few steps, so that its edges take few colours."""
        n = self.levels - 1
        return mask.point(lambda v: round(round(v / 255 * n) * 255 / n))

    def tile(self, ch, width, style):
        key = (ch, width, style)
        if key in self.tiles:
            return self.tiles[key]
        fg, bg, bold, italic, underline, strike = style
        w, h = self.cw * width, self.ch
        im = Image.new('RGB', (w, h), bg)
        draw = ImageDraw.Draw(im)
        if ch.strip() and ch != '\u00a0' and not by_hand(draw, ch, 0, w, h, fg, bg):
            font = self.glyphs.pick(ch, bold)
            mask = Image.new('L', (w, h), 0)
            md = ImageDraw.Draw(mask)
            size = self.glyphs.size
            f = font
            # a mark of another font may come out larger than the cell: smaller until it fits
            while True:
                box = f.getbbox(ch, anchor='ls')
                if (box[2] - box[0] <= w and box[3] - box[1] <= h) or size <= self.glyphs.size * 0.6:
                    break
                size -= 1
                f = font.font_variant(size=size)
            bx0, by0, bx1, by1 = box
            if f is self.glyphs.regular or f is self.glyphs.bold:
                x = (w - f.getlength(ch)) / 2
            else:
                x = (w - (bx1 - bx0)) / 2 - bx0
            y = self.baseline
            if self.baseline + by0 < 0 or self.baseline + by1 > h:   # a tall mark: centred in the cell instead
                y = (h - (by1 - by0)) / 2 - by0
            md.text((round(x), round(y)), ch, font=f, fill=255, anchor='ls')
            im.paste(Image.new('RGB', (w, h), fg), (0, 0), self.alpha(mask))
        if underline:
            draw.rectangle([0, h - 2, w - 1, h - 2], fill=fg)
        if strike:
            draw.rectangle([0, h // 2, w - 1, h // 2], fill=fg)
        self.tiles[key] = im
        return im


# ------------------------------------------------------------------ the film

PLAIN = resolve([None, None, 0])


def expand(rows, cols, nrows, styles):
    """A frame's rows as cells: (character, width, resolved style); None after a wide cell."""
    grid = []
    for y in range(nrows):
        cells = []
        for run in (rows[y] if y < len(rows) else []):
            st = styles[run[0]]
            if len(run) == 2:
                cells += [(c, 1, st) for c in run[1]]
            else:
                cells.append((run[1], run[2], st))
                cells += [None] * (run[2] - 1)
        cells = cells[:cols] + [(' ', 1, PLAIN)] * max(0, cols - len(cells))
        grid.append(cells)
    return grid


def pane_crop(grid):
    """The plugin pane: the columns right of the longest line of │ that starts at the top row."""
    rows, cols = len(grid), len(grid[0])
    best, at = 0, -1
    for x in range(cols // 4, cols - 10):
        n = 0
        while n < rows and grid[n][x] and grid[n][x][0] == '│':
            n += 1
        if n > best:
            best, at = n, x
    if at < 0 or best < rows // 2:
        sys.exit('gif.py: no pane beside the chat on this screen; give --crop X,Y,W,H or --crop all')
    return at + 1, 0, cols - at - 1, best


def blank_row(cells):
    bgs = {c[2][1] for c in cells if c}
    return len(bgs) <= 1 and all(c is None or (c[0] in (' ', '\u00a0') and not c[2][4] and not c[2][5]) for c in cells)


def main():
    ap = argparse.ArgumentParser(description='Draws a film of run.mjs (<name>.frames.json) as a GIF.')
    ap.add_argument('film')
    ap.add_argument('-o', '--out', required=True)
    ap.add_argument('--crop', default='pane')
    ap.add_argument('--from', dest='start', type=float, default=0)
    ap.add_argument('--to', dest='stop', type=float, default=None)
    ap.add_argument('--fps', type=float, default=10)
    ap.add_argument('--speed', type=float, default=1)
    ap.add_argument('--hold', type=float, default=1.5)
    ap.add_argument('--font-size', type=int, default=16)
    ap.add_argument('--pad', type=int, default=10)
    ap.add_argument('--png', default='')
    ap.add_argument('--png-dir', default='')
    ap.add_argument('--text', default='')
    a = ap.parse_args()

    with open(a.film, encoding='utf-8') as fh:
        film = json.load(fh)
    styles = [resolve(s) for s in film['styles']]
    frames = film['frames']
    if not frames:
        sys.exit('gif.py: the film has no frames')
    size_of = lambda fr: fr.get('size', [film['cols'], film['rows']])
    times = [fr['t'] for fr in frames]
    start = a.start * 1000
    stop = film['end'] if a.stop is None else min(film['end'], a.stop * 1000)
    if stop <= start:
        sys.exit('gif.py: --from is not before --to')

    # which recorded frame each frame of the GIF shows
    step = 1000 * a.speed / a.fps
    picks = []
    k = 0
    while start + k * step < stop:
        picks.append(max(0, bisect.bisect_right(times, start + k * step) - 1))
        k += 1

    grids = {}
    def grid_of(i):
        if i not in grids:
            c, r = size_of(frames[i])
            grids[i] = expand(frames[i]['rows'], c, r, styles)
        return grids[i]

    first = grid_of(picks[0])
    if a.crop == 'pane':
        x0, y0, w, h = pane_crop(first)
    elif a.crop == 'all':
        x0, y0, w, h = 0, 0, len(first[0]), len(first)
    else:
        try:
            x0, y0, w, h = (int(v) for v in a.crop.split(','))
        except ValueError:
            sys.exit('gif.py: --crop is pane, all or X,Y,W,H')

    def crop(i):
        g = grid_of(i)
        rows = []
        for y in range(y0, y0 + h):
            row = g[y][x0:x0 + w] if y < len(g) else []
            row = list(row) + [(' ', 1, PLAIN)] * (w - len(row))
            # a wide cell cut at the crop's left edge leaves its second half: drawn as blank
            if row and row[0] is None:
                row[0] = (' ', 1, row[1][2] if len(row) > 1 and row[1] else PLAIN)
            rows.append(tuple(row))
        return tuple(rows)

    crops = {}
    for i in set(picks):
        crops[i] = crop(i)
    # rows blank in every frame, above and below what is drawn, are left out
    used = [any(not blank_row(crops[i][y]) for i in crops) for y in range(h)]
    top = next((y for y in range(h) if used[y]), 0)
    bottom = next((y for y in range(h - 1, -1, -1) if used[y]), h - 1) + 1
    for i in crops:
        crops[i] = crops[i][top:bottom]

    # the frames of the GIF: one for each change in what the crop shows
    shown = []
    for i in picks:
        if shown and crops[shown[-1][0]] == crops[i]:
            shown[-1][1] += 1
        else:
            shown.append([i, 1])
    durations = [round(n * 1000 / a.fps / 10) * 10 for _, n in shown]
    durations[-1] += round(a.hold * 1000 / 10) * 10

    # the padding takes the crop's own background: the commonest among its cells
    tally = {}
    for row in crops[shown[0][0]]:
        for c in row:
            if c:
                tally[c[2][1]] = tally.get(c[2][1], 0) + 1
    pad_bg = max(tally, key=tally.get) if tally else DEFAULT_BG

    def render(levels):
        painter = Painter(a.font_size, levels)
        cw, chh = painter.cw, painter.ch
        strips = {}
        def strip(row):
            if row not in strips:
                im = Image.new('RGB', (cw * w, chh), pad_bg)
                x = 0
                for c in row:
                    if c is not None:
                        im.paste(painter.tile(c[0], c[1], c[2]), (x * cw, 0))
                    x += 1
                strips[row] = im
            return strips[row]
        images = []
        for i, _ in shown:
            rows = crops[i]
            im = Image.new('RGB', (cw * w + 2 * a.pad, chh * len(rows) + 2 * a.pad), pad_bg)
            for y, row in enumerate(rows):
                im.paste(strip(row), (a.pad, a.pad + y * chh))
            images.append(im)
        colours = set()
        for s in strips.values():
            colours.update(c for _, c in s.getcolors(1 << 16) or [])
        colours.add(pad_bg)
        return images, colours, painter

    for levels in (5, 3, 2):
        images, colours, painter = render(levels)
        if len(colours) <= 255:
            break
    if len(colours) <= 255:
        pal = Image.new('P', (1, 1))
        flat = [v for c in sorted(colours) for v in c]
        pal.putpalette(flat)
        frames_p = [im.quantize(palette=pal, dither=Image.Dither.NONE) for im in images]
    else:
        # too many colours for one table: one adaptive table for the whole GIF
        sheet = Image.new('RGB', (images[0].width, images[0].height * min(len(images), 8)))
        for k, im in enumerate(images[:8]):
            sheet.paste(im, (0, k * im.height))
        pal = sheet.quantize(colors=255, method=Image.Quantize.MEDIANCUT)
        frames_p = [im.quantize(palette=pal, dither=Image.Dither.NONE) for im in images]

    out_dir = os.path.dirname(os.path.abspath(a.out))
    os.makedirs(out_dir, exist_ok=True)
    frames_p[0].save(a.out, save_all=True, append_images=frames_p[1:], duration=durations, loop=0, optimize=True, disposal=1)

    total = sum(durations) / 1000
    print(f'{os.path.normpath(a.out)}: {os.path.getsize(a.out) / 1024:.0f} KB, {images[0].width}x{images[0].height}, {len(images)} frames, '
          f'{total:.1f} s ({total - a.hold:.1f} s of film and {a.hold:.1f} s held), {len(colours)} colours, '
          f'cell {painter.cw}x{painter.ch}, crop {x0},{y0 + top} {w}x{bottom - top}')

    ends = [sum(durations[:k + 1]) for k in range(len(durations))]
    if a.png:
        png_dir = a.png_dir or out_dir
        os.makedirs(png_dir, exist_ok=True)
        stem = os.path.splitext(os.path.basename(a.out))[0]
        for s in a.png.split(','):
            at = float(s) * 1000
            k = min(len(ends) - 1, bisect.bisect_right(ends, at))
            p = os.path.normpath(os.path.join(png_dir, f'{stem}-{float(s):04.1f}s.png'))
            images[k].save(p)
            print(f'  {p}')
    if a.text:
        with open(a.text, 'w', encoding='utf-8', newline='\n') as fh:
            for k, (i, _) in enumerate(shown):
                fh.write(f'--- frame {k + 1} at {(ends[k] - durations[k]) / 1000:.1f} s\n')
                for row in crops[i]:
                    fh.write(''.join(c[0] for c in row if c is not None).rstrip() + '\n')


if __name__ == '__main__':
    main()
