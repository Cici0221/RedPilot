from pathlib import Path
import argparse
from PIL import Image, ImageDraw, ImageFont

PROJECT_ROOT = Path(__file__).resolve().parents[1]
ROOT = PROJECT_ROOT / 'design' / 'previews'
FONT_DIR = PROJECT_ROOT / 'assets' / 'fonts'
CJK_FONT = None
CJK_INDEX = 0
INK, PAPER, MINT = '#111E25', '#F4F3EB', '#B9F497'
MUTED, LINE = '#9AAEAC', '#35484C'


def font(size, kind='cn'):
    if kind == 'mono':
        return ImageFont.truetype(str(FONT_DIR / 'GeistMono-Regular.ttf'), size)
    if kind == 'latin':
        return ImageFont.truetype(str(FONT_DIR / 'InstrumentSans-Bold.ttf'), size)
    return ImageFont.truetype(str(CJK_FONT), size, index=CJK_INDEX)


def text(d, xy, value, size, fill, kind='cn'):
    f = font(size, kind)
    box = d.textbbox(xy, value, font=f)
    if not (box[0] >= 0 and box[1] >= 0 and box[2] <= d._image.width and box[3] <= d._image.height):
        raise ValueError(f'Text outside canvas: {value}: {box}')
    d.text(xy, value, font=f, fill=fill)
    return box


def center(d, cx, y, value, size, fill, kind='cn'):
    width = d.textlength(value, font=font(size, kind))
    return text(d, (cx - width / 2, y), value, size, fill, kind)


def arrow(d, xy, color, width=4):
    x1, y1, x2, y2 = xy
    d.line((x1, y1, x2, y2), fill=color, width=width)
    d.line((x2 - 13, y2 - 10, x2, y2, x2 - 13, y2 + 10), fill=color, width=width)


def base(bg, fg, category, no):
    im = Image.new('RGB', (1200, 1600), bg)
    d = ImageDraw.Draw(im)
    text(d, (78, 64), '人类补丁', 40, fg)
    text(d, (850, 72), 'SimHelper', 32, fg, 'latin')
    d.line((78, 142, 1122, 142), fill=fg, width=2)
    text(d, (78, 186), category, 27, fg)
    text(d, (1030, 183), no, 29, fg, 'mono')
    d.line((78, 1438, 1122, 1438), fill=fg, width=2)
    text(d, (78, 1472), '工程内测 · 记录真实问题', 29, fg)
    text(d, (875, 1478), 'P001 / SIM', 23, fg, 'mono')
    return im, d


def first():
    im, d = base(INK, PAPER, '通信小麻烦', '01')
    text(d, (76, 298), '备用号', 133, PAPER)
    text(d, (76, 466), '还要多带', 133, PAPER)
    text(d, (76, 634), '一台手机？', 133, MINT)
    # A relation diagram, deliberately not a depiction of a physical prototype.
    d.rounded_rectangle((88, 947, 252, 1147), radius=16, outline=MINT, width=3)
    d.line((201, 947, 252, 997), fill=MINT, width=3)
    d.rounded_rectangle((125, 1010, 215, 1090), radius=10, outline=MINT, width=2)
    for x in (155, 185):
        d.line((x, 1010, x, 1090), fill=MINT, width=2)
    d.line((125, 1050, 215, 1050), fill=MINT, width=2)
    center(d, 170, 1190, '备用 SIM', 30, PAPER)
    arrow(d, (285, 1045, 420, 1045), MUTED)
    d.rectangle((453, 962, 705, 1132), outline=MUTED, width=3)
    center(d, 579, 1004, '固定设备', 38, PAPER)
    center(d, 579, 1065, '电源 + Wi-Fi', 23, MUTED)
    arrow(d, (735, 1045, 861, 1045), MUTED)
    d.rounded_rectangle((904, 905, 1084, 1195), radius=25, outline=PAPER, width=3)
    d.line((962, 925, 1026, 925), fill=MUTED, width=4)
    center(d, 994, 1035, 'App', 42, MINT, 'latin')
    center(d, 994, 1214, '常用手机', 30, PAPER)
    text(d, (78, 1330), '关系示意｜SIM 移入设备，手机需联网', 28, MUTED)
    im.save(ROOT / '01-spare-number.png')
    return im


def second():
    im, d = base(PAPER, INK, '接通实验', '02')
    text(d, (76, 298), '开会时', 133, INK)
    text(d, (76, 466), '这通来电', 133, INK)
    # A single mint highlight supports the question without an additional badge.
    d.rectangle((78, 620, 915, 808), fill=MINT)
    text(d, (76, 634), '谁先接？', 133, INK)
    cy = 1058
    for cx, label, idx in [(176, '来电', '01'), (583, 'AI 接待', '02'), (994, '本人接管', '03')]:
        d.ellipse((cx - 78, cy - 78, cx + 78, cy + 78), outline=INK, width=3)
        center(d, cx, cy - 29, idx, 43, INK, 'mono')
        center(d, cx, cy + 115, label, 33, INK)
    arrow(d, (268, cy, 487, cy), INK)
    arrow(d, (677, cy, 898, cy), INK)
    center(d, 786, cy - 58, '需要时', 25, INK)
    text(d, (78, 1330), '流程示意｜具体表现以最新版实机测试为准', 28, '#52635F')
    im.save(ROOT / '02-call-assistant.png')
    return im


def third():
    im, d = base(MINT, INK, '一起打磨', '03')
    text(d, (76, 298), '你的备用号', 128, INK)
    text(d, (76, 466), '平时', 133, INK)
    text(d, (76, 634), '怎么用？', 133, INK)
    # Typographic research cards rather than fabricated testimonials or metrics.
    cells = [(78, 956, '01', '保留旧号'), (620, 956, '02', '工作号码'), (78, 1124, '03', '忙时来电'), (620, 1124, '04', '你的场景')]
    for x, y, no, label in cells:
        d.line((x, y, x + 492, y), fill=INK, width=2)
        text(d, (x, y + 25), no, 24, INK, 'mono')
        text(d, (x + 67, y + 17), label, 43, INK)
    text(d, (78, 1330), '内测需求征集｜先聊具体场景', 30, INK)
    im.save(ROOT / '03-beta-interest.png')
    return im


def board(covers):
    im = Image.new('RGB', (2280, 1400), PAPER)
    d = ImageDraw.Draw(im)
    text(d, (96, 60), '人类补丁', 76, INK)
    text(d, (99, 172), 'SimHelper · 账号视觉方向', 32, '#52635F')
    text(d, (1720, 100), 'QUIET CONNECTION', 24, INK, 'mono')
    text(d, (1720, 146), '2026.10 / DIRECTION 01', 20, '#52635F', 'mono')
    for j, (cover, label) in enumerate(zip(covers, ['通信小麻烦 / 需求切入', '接通实验 / 过程解释', '一起打磨 / 内测交流'])):
        x, y = 96 + j * 728, 286
        thumb = cover.resize((632, 843), Image.Resampling.LANCZOS)
        im.paste(thumb, (x, y))
        text(d, (x, 1174), label, 29, INK)
    d.line((96, 1265, 2184, 1265), fill='#C6CDC6', width=2)
    text(d, (96, 1305), '原创排版样稿 · 示意图不代表实机外观或测试结果', 28, '#52635F')
    im.save(ROOT / 'simhelper-style-board.png')
    return im


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Generate RedPilot original cover samples.')
    parser.add_argument('--output-dir', type=Path, default=ROOT)
    parser.add_argument('--cjk-font', type=Path)
    parser.add_argument('--cjk-index', type=int, default=None)
    args = parser.parse_args()
    if args.cjk_font:
        CJK_FONT = args.cjk_font.expanduser().resolve()
        CJK_INDEX = args.cjk_index if args.cjk_index is not None else 0
    else:
        candidates = [
            (Path('/System/Library/Fonts/STHeiti Medium.ttc'), 1),
            (Path('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'), 2),
            (Path('/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf'), 0),
        ]
        selected = next(((path, index) for path, index in candidates if path.is_file()), None)
        if selected is None:
            parser.error('Chinese font not found. Provide --cjk-font with an installed CJK font.')
        CJK_FONT, CJK_INDEX = selected
        if args.cjk_index is not None:
            CJK_INDEX = args.cjk_index
    if not CJK_FONT.is_file():
        parser.error(f'Font file does not exist: {CJK_FONT}')
    try:
        ImageFont.truetype(str(CJK_FONT), 32, index=CJK_INDEX)
    except (OSError, ValueError) as error:
        parser.error(f'Cannot load the specified Chinese font: {error}')
    ROOT = args.output_dir.expanduser().resolve()
    ROOT.mkdir(parents=True, exist_ok=True)
    covers = [first(), second(), third()]
    board(covers)
    print(ROOT / 'simhelper-style-board.png')
