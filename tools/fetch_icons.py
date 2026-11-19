"""Download item icons from the CloverPit Wiki and convert them to small WebP files.

Usage:  python3 tools/fetch_icons.py
Needs   Pillow (pip install pillow), data/items.json, tools/.cache/images.json
Writes  assets/icons/{charms,phone,memory,game}/*.webp
Game art belongs to Panik Arcade; files are hosted by the CloverPit Wiki.
"""
import io, json, os, sys, time, urllib.request
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..'))
UA = "CloverPitBuilder-fan-tool/1.0 (+https://github.com/Somikyy/CloverPitBuilder)"
SIZES = {'charms': (128, 128), 'phone': (96, 96), 'memory': (160, 232), 'game': (128, 128)}
GAME = ['SymbolLemon.webp', 'SymbolCherry.webp', 'SymbolClover.webp', 'SymbolBell.webp', 'SymbolDiamond.webp',
        'SymbolTreasureChest.webp', 'SymbolSeven.webp', 'PatternHor.webp', 'PatternHorL.webp', 'PatternHorXL.webp',
        'PatternVer.webp', 'PatternDiag.webp', 'PatternZig.webp', 'PatternZag.webp', 'PatternAbove.webp',
        'PatternBelow.webp', 'PatternEye.webp', 'PatternJackpot.webp', 'PatternHorS.webp', 'PatternVerS.webp',
        'PatternDiagS.webp', 'ModifierGolden.webp', 'ModifierToken.webp', 'ModifierTicket.webp',
        'ModifierRepetition.webp', 'ModifierBattery.webp', 'ModifierChain.webp', 'ModifierInvestor.webp',
        'ModifierRising.webp', 'ModifierCopy.webp', 'ModifierRevenge.webp', 'Coin.webp', 'Ticket.webp', 'Energy.webp',
        'RedButton.webp', 'Number6.webp', 'Number9.webp']


def fetch(url, cache_dir):
    os.makedirs(cache_dir, exist_ok=True)
    fn = os.path.join(cache_dir, url.split('/')[-1].split('?')[0])
    if not os.path.exists(fn):
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=60) as r:
            open(fn, 'wb').write(r.read())
        time.sleep(0.15)
    return fn


def convert(src, dst, size):
    im = Image.open(src).convert('RGBA')
    im.thumbnail(size, Image.LANCZOS)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    im.save(dst, 'WEBP', quality=88, method=6)


def main():
    images = {x['name']: x for x in json.load(open(os.path.join(HERE, '.cache', 'images.json')))}
    items = json.load(open(os.path.join(ROOT, 'data', 'items.json')))
    cache_dir = os.path.join(HERE, '.cache', 'img')
    n = 0
    for coll, folder in (('charms', 'charms'), ('phone', 'phone'), ('memory', 'memory')):
        for x in items[coll]:
            if not x.get('iconSrc'):
                continue
            info = images.get(x['iconSrc'])
            if not info:
                print('no image info for', x['iconSrc'], file=sys.stderr)
                continue
            convert(fetch(info['url'], cache_dir), os.path.join(ROOT, x['icon']), SIZES[folder])
            n += 1
    for name in GAME:
        info = images.get(name)
        if not info:
            print('missing game icon', name, file=sys.stderr)
            continue
        base = name.rsplit('.', 1)[0]
        base = base.replace('SymbolTreasureChest', 'SymbolTreasure')
        convert(fetch(info['url'], cache_dir), os.path.join(ROOT, 'assets', 'icons', 'game', base + '.webp'), SIZES['game'])
        n += 1
    print('icons written:', n)


if __name__ == '__main__':
    main()
