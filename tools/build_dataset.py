"""Build data/items.json (charms, phone abilities, memory cards) from the cached wiki dump.

Usage:  python3 tools/fetch_wiki.py && python3 tools/build_dataset.py
Reads   tools/.cache/wiki_pages.json, tools/.cache/images.json
Writes  data/items.json            (used by the website)
        tools/.cache/wiki_notes.json (community notes per item, used when curating data/models.json)
Item text comes from the CloverPit Wiki (cloverpit.wiki.gg), licensed CC BY-SA 4.0.
"""
import json, re, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wikiclean import clean
HERE = os.path.dirname(os.path.abspath(__file__))
RAW = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, '.cache')
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, '..', 'data')
pages = json.load(open(os.path.join(RAW, 'wiki_pages.json')))
images = {x['name']: x for x in json.load(open(os.path.join(RAW, 'images.json')))}
img_lower = {k.lower(): k for k in images}

def slug(name):
    s = name.lower().replace("'", '').replace('"', '')
    s = re.sub(r'[^a-z0-9]+', '_', s).strip('_')
    return s

def find_image(name, exts=('.png', '.webp', '.jpg')):
    base = name.replace(' ', '_')
    for e in exts:
        k = (base + e).lower()
        if k in img_lower: return img_lower[k]
    return None

def table_rows(txt):
    body = txt.split('\n|-', 1)[1] if '\n|-' in txt else txt
    rows = re.split(r'\n\|-[^\n]*', '\n' + body)
    out = []
    for r in rows:
        r = r.strip()
        if not r or r.startswith('|}'): continue
        r = r.split('\n|}')[0]
        cells = re.split(r'(?:^|\n)\|(?!\})|\|\|', r)
        cells = [c.strip().lstrip('|').strip() for c in cells]
        cells = [c for c in cells if c != '']
        if cells and cells[0].startswith('!'): continue
        out.append(cells)
    return out

def tables_in(txt):
    res = []; i = 0
    while True:
        a = txt.find('{|', i)
        if a < 0: break
        b = txt.find('\n|}', a)
        if b < 0: break
        res.append(txt[a:b + 3]); i = b + 3
    return res

def section(content, names):
    out = []
    for n in names:
        m = re.search(r'^==\s*' + re.escape(n) + r'\s*==\s*$(.*?)(?=^==[^=]|\Z)', content, re.M | re.S)
        if m:
            t = clean(m.group(1)).strip()
            if t: out.append(t)
    return '\n'.join(out)

def charges_of(raw):
    if raw is None: return None
    m = re.search(r'Triggered by Red Button\s*\(([█ ]+)\)', raw)
    if m: return m.group(1).count('█')
    low = raw.lower()
    if 'chargebracketleft' in low:
        seg = low[low.find('chargebracketleft'):low.find('chargebracketright')]
        return seg.count('chargebarsingle') + len(re.findall(r'chargebar\.webp', seg))
    return None

def page_template(title):
    p = pages.get(title)
    if not p: return None
    c = p['content']
    m = re.search(r'\{\{(?:LuckyCharm|Lucky charm layout|MemoryCard)\s*\n(.*?)\n\}\}', c, re.S)
    if not m: return None
    body = m.group(1)
    fields = {}
    for fm in re.finditer(r'^\|\s*([^=\n]+?)\s*=(.*?)(?=^\||\Z)', body, re.M | re.S):
        fields[fm.group(1).strip()] = fm.group(2).strip()
    return fields

# ---------- store reroll chances (rarity sub tiers)
store = pages['Store']['content']
reroll = {}
for cells in table_rows(tables_in(store)[0]):
    # last cell holds probability like 0% / 10% / ...
    pc = re.search(r'(\d+)%', cells[-1])
    if not pc: continue
    for nm in re.findall(r'IconLink\|([^}|]+)', ' '.join(cells)):
        reroll[slug(nm.strip())] = int(pc.group(1))

# ---------- charms
lc = pages['Lucky Charms']['content']
i = lc.find('== List of Lucky Charms =='); j = lc.find('=== Surgery Charms ==='); k = lc.find('== Charm Space ==')
main_t = tables_in(lc[i:j])[0]; surg_t = tables_in(lc[j:k])[0]
charms = []
def mk_charm(name, rarity, cost, raw_desc, unlock, category, recipe=None):
    cid = slug(name)
    pt = page_template(name)
    page_desc_raw = pt.get('Description') if pt else None
    d_over = clean(raw_desc) if raw_desc else ''
    d_page = clean(page_desc_raw) if page_desc_raw else ''
    desc = d_over if d_over and 'For more information' not in d_over else (d_page or d_over)
    if not desc and pt: desc = d_page
    raw_for_flags = (raw_desc or '') + ' ' + (page_desc_raw or '')
    ch = charges_of(raw_desc) or charges_of(page_desc_raw)
    if pt and pt.get('Charges') and not ch:
        try: ch = int(pt['Charges'])
        except: pass
    rb = bool(re.search(r'Red ?Button', raw_for_flags)) and bool(re.search(r'Triggered by Red Button', raw_for_flags)) or (pt is not None and bool(pt.get('Charges')))
    tr = re.search(r'Triggers Randomly\s*\}\}\s*\((\d+)%\)', raw_for_flags, re.I)
    content = pages.get(name, {}).get('content', '')
    notes = section(content, ['Notes', 'Strategy', 'Synergies', 'Effects']) if content else ''
    if cost is not None:
        mc = re.search(r'amount=(\d+)', cost) or re.search(r'(\d+)', clean(cost))
        cost_v = int(mc.group(1)) if mc else None
    else: cost_v = None
    if cost_v is None and pt and pt.get('Cost'):
        mm = re.search(r'(\d+)', pt['Cost']); cost_v = int(mm.group(1)) if mm else None
    img = find_image(name)
    return {
        'id': cid, 'name': name, 'kind': 'charm', 'category': category,
        'dlc': category in ('surgery', 'evil'),
        'rarity': clean(rarity) if rarity else (pt.get('Rarity') if pt else None),
        'cost': cost_v, 'description': desc, 'descriptionPage': d_page if d_page and d_page != desc else None,
        'unlock': clean(unlock) if unlock else (clean(pt.get('Unlocking', '')) if pt else ''),
        'recipe': recipe, 'redButtonCharges': ch if rb else None,
        'triggersRandomly': int(tr.group(1)) if tr else None,
        'noSpace': bool(re.match(r"\s*Doesn't take space", desc)),
        'storeRerollChance': reroll.get(cid),
        'icon': img, 'wiki': 'https://cloverpit.wiki.gg/wiki/' + name.replace(' ', '_'),
        'wikiNotes': notes[:2500] if notes else '',
    }
for cells in table_rows(main_t):
    if len(cells) < 5: print('skip main', cells[:1], file=sys.stderr); continue
    name = clean(cells[0]); unlock = clean(cells[4])
    if 'phone call' in unlock.lower():
        cat = 'evil' if 'Unholy Fusion' in unlock else 'sacred'
    elif name.startswith('Corpse') or name == 'Skull': cat = 'cadaver'
    else: cat = 'store'
    charms.append(mk_charm(name, cells[1], cells[2], cells[3], cells[4], cat))
for cells in table_rows(surg_t):
    if len(cells) < 4: print('skip surg', cells[:1], file=sys.stderr); continue
    name = clean(cells[0])
    recipe_names = [clean(x) for x in re.findall(r'\{\{lct\|([^}]+)\}\}', cells[3])]
    recipe = [slug(x) for x in recipe_names] if recipe_names else [clean(cells[3])]
    charms.append(mk_charm(name, cells[1], None, cells[2], 'Created at the Surgery Machine (Unholy Fusion DLC).', 'surgery', recipe))

# ---------- phone abilities
tel = pages['The Telephone']['content']
cut = tel.find('== Unused Abilities ==')
tel_main = tel[:cut]
blocks = [('normal', tel_main.find('=== Normal Calls ===')), ('red', tel_main.find('=== Red Calls ===')), ('sacred', tel_main.find('=== Sacred Calls ===')), ('end', len(tel_main))]
phone = []
for (typ, a), (_, b) in zip(blocks, blocks[1:]):
    seg = tel_main[a:b]
    for t in tables_in(seg):
        for cells in table_rows(t):
            if len(cells) < 4: print('skip phone', cells[:1], file=sys.stderr); continue
            name = clean(cells[0]).strip()
            mu = clean(cells[3]); mu_v = None if mu in ('∞', '') else (int(mu) if mu.isdigit() else mu)
            rar = clean(cells[2]); rar = None if rar in ('?', '') else rar
            phone.append({'id': slug(name), 'name': name, 'kind': 'phone', 'type': typ,
                'dlc': name == 'Alexithymia', 'rarity': rar, 'maxUses': mu_v,
                'description': clean(cells[1]), 'response': clean(cells[4]) if len(cells) > 4 else '',
                'icon': find_image(name), 'wiki': 'https://cloverpit.wiki.gg/wiki/The_Telephone'})

# ---------- memory cards
mcp = pages['Memory Cards']['content']
mc_cut = mcp.find('===Unholy Fusion===')
memory = []
for part, dlc in ((mcp[:mc_cut], False), (mcp[mc_cut:], True)):
    for t in tables_in(part)[:1]:
        for cells in table_rows(t):
            if len(cells) < 2: continue
            name = clean(cells[0]); pt = page_template(name)
            memory.append({'id': slug(name), 'name': name, 'kind': 'memory', 'dlc': dlc,
                'rarity': pt.get('Rarity') if pt else None, 'description': clean(cells[1]),
                'dialogue': clean(cells[2]) if len(cells) > 2 else '', 'icon': find_image(name),
                'wiki': 'https://cloverpit.wiki.gg/wiki/' + name.replace(' ', '_')})

# ---------- jimbo special
for c in charms:
    if c['id'] == 'jimbo':
        c['description'] = 'Randomly generated: 1 downside + 2 upsides. Downsides: 666 chance +1.5% or +3%, -2 or -3 spins per Round, or discard after 3/5 Rounds. Upsides: all Patterns trigger one more time, +5% Interest, Symbols Multiplier +5, Patterns Multiplier +3, +3 Tickets per Deadline, Luck+5 on first spin of every Round, +2 spins per Round, two symbols manifest more often (+2), or +2 Free Restocks when a Deadline begins.'
    if c['id'] == 'ring_bell' and not c['description']:
        c['description'] = '[Red Button] Triggered by Red Button (3 charges): Symbols Multiplier +1 permanently.'
        c['redButtonCharges'] = 3
os.makedirs(OUT, exist_ok=True)
notes = {}
for coll, folder in ((charms, 'charms'), (phone, 'phone'), (memory, 'memory')):
    for x in coll:
        x['iconSrc'] = x.pop('icon')
        x['icon'] = f'assets/icons/{folder}/{x["id"]}.webp' if x['iconSrc'] else None
        if x.get('wikiNotes'): notes[x['id']] = x['wikiNotes']
        x.pop('wikiNotes', None)
import datetime
meta = {'source': 'https://cloverpit.wiki.gg', 'license': 'CC BY-SA 4.0',
        'generated': datetime.date.today().isoformat(),
        'counts': {'charms': len(charms), 'phone': len(phone), 'memory': len(memory)}}
json.dump({'meta': meta, 'charms': charms, 'phone': phone, 'memory': memory},
          open(os.path.join(OUT, 'items.json'), 'w'), indent=1, ensure_ascii=False)
json.dump(notes, open(os.path.join(RAW, 'wiki_notes.json'), 'w'), indent=1, ensure_ascii=False)
from collections import Counter
print('charms', len(charms), Counter(c['category'] for c in charms))
print('phone', len(phone), Counter(p['type'] for p in phone))
print('memory', len(memory))
print('missing icons:', [x['name'] for x in charms + phone + memory if not x['icon']])
print('no desc:', [x['name'] for x in charms + phone + memory if not x['description']])
print('red button:', sorted((c['name'], c['redButtonCharges']) for c in charms if c['redButtonCharges']))
print('random:', sorted((c['name'], c['triggersRandomly']) for c in charms if c['triggersRandomly']))
print('nospace:', sorted(c['name'] for c in charms if c['noSpace']))
print('no reroll info (store):', sorted(c['name'] for c in charms if c['category']=='store' and c['storeRerollChance'] is None))
print('desc differs from page:', len([c for c in charms if c['descriptionPage']]))
