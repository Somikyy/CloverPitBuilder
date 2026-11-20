"""Validate item models against docs/MODEL_SPEC.md.

Usage:  python3 tools/validate_models.py [file_or_dir ...]   (default: data/models/)
Exit code 1 if any error. Warnings do not fail.
"""
import json, os, sys, glob

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..'))
items = json.load(open(os.path.join(ROOT, 'data', 'items.json')))
KIND = {}
for coll, kind in (('charms', 'charm'), ('phone', 'phone'), ('memory', 'memory')):
    for x in items[coll]:
        KIND[x['id']] = kind

SYMBOLS = {'lemon', 'cherry', 'clover', 'bell', 'diamond', 'treasure', 'seven'}
SYMBOL_GROUPS = {'all', 'fruit', 'yellow', 'nonYellow', 'gems', 'mostProbable', 'mostValuable', 'random'}
PATTERNS = {'HOR', 'VER', 'DIAG', 'HOR_L', 'HOR_XL', 'ZIG', 'ZAG', 'ABOVE', 'BELOW', 'EYE', 'JACKPOT', 'HOR_S', 'VER_S', 'DIAG_S'}
PATTERN_GROUPS = {'small', 'large', 'all'}
MODIFIERS = {'golden', 'token', 'ticket', 'repetition', 'battery', 'chain', 'investor', 'rising', 'copy', 'revenge'}
TRAITS = {'ambitious', 'avid', 'devious', 'florid', 'gambler', 'obsessive', 'speculative', 'random'}
TAGS = set('''lemon cherry clover bell diamond treasure seven fruit yellow nonYellow allSymbols
symbolValue symbolChance patternValue symbolsMult patternsMult luck retrigger jackpot eye aboveBelow zigZag horXL smallPatterns largePatterns patternCount
golden token ticketMod repetition battery chain investor rising copy revenge
tickets coins interest restock discount resell charmSpace spins rounds debt
redButton charges triggersRandomly phone phoneReroll traits discard purchase noReward roundSkip 666 999 sacred evil drawers surgery temporary instant deathSave store charmCount'''.split())
ARCH = set('lemon cherry clover bell diamond treasure seven fruit gems jackpot retrigger multiplier golden chain interest tickets redButton devil sacred noReward phone traits discard restock'.split())
EFFECTS = {'symbolChance', 'symbolValue', 'patternValue', 'symbolsMult', 'patternsMult', 'luck', 'retrigger', 'modifierChance',
           'forcePattern', 'addPatterns', 'transform', 'tickets', 'ticketIncome', 'coins', 'interest', 'freeRestocks', 'storeDiscount',
           'charmSpace', 'spins', 'rounds', 'chance666', 'protect666', 'debt', 'charges', 'redButton', 'phone', 'randomTriggers',
           'resellValue', 'trait', 'deathSave', 'spawnCharm', 'special'}
WHEN_KEYS = {'event', 'chance', 'spin', 'n', 'patternsAtLeast', 'patternsExactly', 'noPatterns', 'noRewardStreak', 'patternSizeAtLeast',
             'onlyPattern', 'scored', 'streak', 'scoredAll', 'on', 'redButton', 'round', 'noLargeStreak'}
ON_EVENTS = {'666', '999', 'jackpot', 'roundStart', 'roundEnd', 'deadlineStart', 'deadlineEnd', 'purchase', 'restock', 'discard',
             'phonePick', 'phoneReroll', 'roundSkipped', 'charmTriggers', 'dying'}
DURATIONS = {'spin', 'round', 'deadline', 'permanent'}
PER = {'instant', 'round', 'deadline', 'spin'}
REQ = ['id', 'kind', 'summary', 'tip', 'tier', 'ratings', 'archetypes', 'provides', 'cares', 'effects', 'synergies',
       'antiSynergies', 'confidence', 'assumptions']


def check_symbols(v, where, errs):
    if isinstance(v, str):
        if v not in SYMBOL_GROUPS: errs.append(f'{where}: bad symbols group {v!r}')
    elif isinstance(v, list):
        for s in v:
            if s not in SYMBOLS: errs.append(f'{where}: bad symbol {s!r}')
    else:
        errs.append(f'{where}: symbols must be list or group string')


def check_patterns(v, where, errs):
    if isinstance(v, str):
        if v not in PATTERN_GROUPS and v not in PATTERNS: errs.append(f'{where}: bad patterns {v!r}')
    elif isinstance(v, list):
        for s in v:
            if s not in PATTERNS: errs.append(f'{where}: bad pattern {s!r}')
    else:
        errs.append(f'{where}: patterns must be list or string')


def check_model(m, errs, warns):
    mid = m.get('id', '?')
    for k in REQ:
        if k not in m: errs.append(f'{mid}: missing {k}')
    if mid not in KIND:
        errs.append(f'{mid}: unknown id'); return
    if m.get('kind') != KIND[mid]: errs.append(f'{mid}: kind should be {KIND[mid]}')
    if m.get('tier') not in ('S', 'A', 'B', 'C', 'D'): errs.append(f'{mid}: bad tier {m.get("tier")!r}')
    r = m.get('ratings', {})
    for k in ('power', 'scaling', 'economy', 'utility', 'risk'):
        v = r.get(k)
        if not isinstance(v, (int, float)) or not 0 <= v <= 10: errs.append(f'{mid}: ratings.{k} must be 0-10, got {v!r}')
    for a in m.get('archetypes', []):
        if a not in ARCH: errs.append(f'{mid}: bad archetype {a!r}')
    for fld in ('provides', 'cares'):
        for t in m.get(fld, []):
            if t not in TAGS: errs.append(f'{mid}: bad tag in {fld}: {t!r}')
    for fld in ('summary', 'tip'):
        v = m.get(fld, '')
        if not isinstance(v, str) or not v.strip(): errs.append(f'{mid}: empty {fld}')
        elif len(v) > 240: warns.append(f'{mid}: {fld} long ({len(v)} chars)')
    for fld in ('synergies', 'antiSynergies'):
        for s in m.get(fld, []):
            if not isinstance(s, dict) or s.get('id') not in KIND: errs.append(f'{mid}: {fld} bad id {s!r}')
            elif s['id'] == mid: errs.append(f'{mid}: {fld} references itself')
            elif not s.get('why'): warns.append(f'{mid}: {fld} {s["id"]} missing why')
    if m.get('confidence') not in ('high', 'medium', 'low'): errs.append(f'{mid}: bad confidence')
    for i, e in enumerate(m.get('effects', [])):
        w = f'{mid}.effects[{i}]'
        t = e.get('type')
        if t not in EFFECTS: errs.append(f'{w}: unknown type {t!r}'); continue
        if 'symbols' in e: check_symbols(e['symbols'], w, errs)
        if 'patterns' in e: check_patterns(e['patterns'], w, errs)
        if t == 'forcePattern':
            pv = e.get('pattern')
            check_patterns(pv if isinstance(pv, list) else [pv], w, errs)
        if t == 'modifierChance' and e.get('modifier') not in MODIFIERS: errs.append(f'{w}: bad modifier {e.get("modifier")!r}')
        if t == 'trait' and e.get('apply') not in TRAITS: errs.append(f'{w}: bad trait {e.get("apply")!r}')
        if t in ('symbolChance',) and not any(k in e for k in ('add', 'mulBase', 'set')): errs.append(f'{w}: needs add/mulBase/set')
        if t in ('symbolValue',) and not any(k in e for k in ('mul', 'addBase', 'add')): errs.append(f'{w}: needs mul/addBase/add')
        if t in ('patternValue',) and not any(k in e for k in ('mul', 'addBase')): errs.append(f'{w}: needs mul/addBase')
        if t in ('symbolsMult', 'patternsMult') and not any(k in e for k in ('add', 'mul')): errs.append(f'{w}: needs add/mul')
        if t == 'special' and not e.get('text'): errs.append(f'{w}: special needs text')
        if 'per' in e and e['per'] not in PER: errs.append(f'{w}: bad per {e["per"]!r}')
        if 'duration' in e and e['duration'] not in DURATIONS: errs.append(f'{w}: bad duration {e["duration"]!r}')
        wh = e.get('when')
        if wh is not None:
            if not isinstance(wh, dict): errs.append(f'{w}: when must be object'); continue
            for k in wh:
                if k not in WHEN_KEYS: errs.append(f'{w}: unknown when key {k!r}')
            if 'on' in wh and wh['on'] not in ON_EVENTS: errs.append(f'{w}: unknown when.on {wh["on"]!r}')
            if 'chance' in wh and not (isinstance(wh['chance'], (int, float)) and 0 < wh['chance'] <= 1): errs.append(f'{w}: chance must be 0-1')
            if 'spin' in wh and wh['spin'] not in ('first', 'last', 'every'): errs.append(f'{w}: bad when.spin')
            if 'event' in wh and wh['event'] != 'instant': errs.append(f'{w}: when.event only supports "instant"')
            if 'scored' in wh: check_symbols(wh['scored'], w, errs)
            if 'scoredAll' in wh: check_symbols(wh['scoredAll'], w, errs)


def main():
    targets = sys.argv[1:] or [os.path.join(ROOT, 'data', 'models')]
    files = []
    for t in targets:
        files += sorted(glob.glob(os.path.join(t, '*.json'))) if os.path.isdir(t) else [t]
    errs, warns, seen = [], [], {}
    for f in files:
        try:
            data = json.load(open(f))
        except Exception as ex:
            errs.append(f'{f}: invalid JSON: {ex}'); continue
        if isinstance(data, dict) and 'models' in data: data = data['models']
        if not isinstance(data, list): errs.append(f'{f}: top level must be a list of models'); continue
        for m in data:
            if not isinstance(m, dict): errs.append(f'{f}: model is not an object'); continue
            if m.get('id') in seen: errs.append(f'{m.get("id")}: duplicate (also in {seen[m["id"]]})')
            seen[m.get('id')] = os.path.basename(f)
            check_model(m, errs, warns)
    for w in warns: print('WARN ', w)
    for e in errs: print('ERROR', e)
    print(f'{len(seen)} models checked, {len(errs)} errors, {len(warns)} warnings')
    sys.exit(1 if errs else 0)


if __name__ == '__main__':
    main()
