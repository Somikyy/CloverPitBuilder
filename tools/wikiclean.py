import json, os, re
# {{CharmModifierInfo<Name>}} is the wiki's grey line explaining a modifier; the same explanations are in
# data/mechanics.json, so the line is written out instead of a dead "(see ... modifier)" reference.
_MECH = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data', 'mechanics.json')
MOD_INFO = {m['id']: (m['name'], m['effect']) for m in json.load(open(_MECH, encoding='utf-8'))['modifiers']}
def _mod_info(m):
    k = m.group(1).lower()
    if k not in MOD_INFO: return '(see ' + m.group(1) + ' modifier)'  # a modifier mechanics.json doesn't know yet
    name, effect = MOD_INFO[k]
    return name + ' Modifier [' + name + ' modifier]: ' + effect
SYM = {'SymbolLemon':'Lemon','SymbolCherry':'Cherry','SymbolClover':'Clover','SymbolBell':'Bell','SymbolDiamond':'Diamond','SymbolTreasureChest':'Treasure','SymbolSeven':'Seven'}
def clean(s):
    if s is None: return ''
    s = s.replace('&#43;', '+')
    # files -> tokens
    def f(m):
        name = m.group(1).strip()
        base = re.sub(r'\.(webp|png|jpg|gif)$', '', name, flags=re.I)
        for k,v in SYM.items():
            if base.lower()==k.lower(): return '['+v+']'
        if base.lower().startswith('pattern'): return '['+base[7:]+']'
        if base.lower().startswith('modifier'): return '['+base[8:]+' modifier]'
        lb = base.lower()
        if lb in ('coin',): return '[Coins]'
        if lb in ('ticket',): return '[Tickets]'
        if lb in ('energy',): return '[Charge]'
        if lb in ('redbutton',): return '[Red Button]'
        if lb.startswith('charge'): return ''
        if lb in ('number6',): return '[6]'
        if lb in ('number9',): return '[9]'
        return '['+base+']'
    s = re.sub(r'\[\[(?:File|file|Image):([^|\]]+)(?:\|[^\]]*)?\]\]', f, s)
    # templates
    reps = {
        r'\{\{\s*Luck\s*\}\}': 'Luck', r'\{\{\s*Symbols Multiplier\s*\}\}': 'Symbols Multiplier',
        r'\{\{\s*Patterns Multiplier\s*\}\}': 'Patterns Multiplier', r'\{\{\s*666\s*\}\}': '666',
        r'\{\{\s*999\s*\}\}': '999', r'\{\{\s*666\|1\s*\}\}': '6', r'\{\{\s*666\|2\s*\}\}': '66',
        r'\{\{\s*Triggers Randomly\s*\}\}': 'Triggers randomly', r'\{\{\s*Free Restocks\s*\}\}': 'Free Restocks',
        r'\{\{\s*ChargeItemsInfoText\s*\}\}': '', r'\{\{\s*AllSymbolsBaseValues\s*\}\}': 'all symbols base values',
        r'\{\{\s*AllPatternBaseValues\s*\}\}': 'all patterns base values', r'\{\{\s*AllSymbols\s*\}\}': 'all symbols',
        r'\{\{\s*AllPatterns\s*\}\}': 'all patterns', r'\{\{\s*Coin\s*\}\}': '[Coins]', r'\{\{\s*Ticket\s*\}\}': '[Tickets]',
        r'\{\{\s*cp\s*\}\}': 'CloverPit',
    }
    for k,v in reps.items(): s = re.sub(k, v, s, flags=re.I)
    s = re.sub(r'\{\{\s*CharmModifierInfo(\w+)\s*\}\}', _mod_info, s)
    s = re.sub(r'\{\{\s*Currency\s*\|\s*amount=([^|}]*)\|\s*currency=(\w+)\s*\}\}', lambda m: m.group(1)+' '+m.group(2)+'s', s)
    s = re.sub(r'\{\{\s*(?:IconLink|lct|il)\s*\|([^}|]+)(?:\|[^}]*)?\}\}', r'\1', s)
    s = re.sub(r'\{\{\s*Trait\s*\|\s*s\s*\}\}', 'Traits', s, flags=re.I)
    s = re.sub(r'\{\{\s*Trait\s*\|\s*(\w+)\s*\}\}', lambda m: m.group(1).capitalize()+' Trait', s, flags=re.I)
    s = re.sub(r'\{\{\s*Trait\|s\s*\}\}', 'Traits', s)
    s = re.sub(r'\{\{\s*Trait\s*\}\}', 'Trait', s, flags=re.I)
    s = re.sub(r'\{\{\s*RedButton\s*\|\s*trigger\s*\}\}', '(Red Button)', s)
    s = re.sub(r'\{\{\s*RedButton\s*\}\}', '[Red Button]', s)
    s = re.sub(r'\{\{\s*Spins\s*\|\s*most\s*\}\}', '"Most Spins"', s)
    s = re.sub(r'\{\{\s*Spins\s*\|\s*few\s*\}\}', '"Fewer Spins"', s)
    s = re.sub(r'\{\{\s*Spoiler\s*\|(.*?)\}\}', r'\1', s, flags=re.S)
    s = re.sub(r'\{\{\s*(?:CharmRarity|LuckyCharmRarity|rarity|Rarity)\s*\|\s*rarity=(\w+)[^}]*\}\}', r'\1', s, flags=re.I)
    # links
    s = re.sub(r'\[\[([^|\]]+)\|([^\]]+)\]\]', r'\2', s)
    s = re.sub(r'\[\[([^\]]+)\]\]', r'\1', s)
    s = re.sub(r'\[https?://\S+ ([^\]]+)\]', r'\1', s)
    # html
    s = re.sub(r'<br\s*/?>', '\n', s)
    s = re.sub(r'<[^>]+>', '', s)
    s = s.replace("'''", '').replace("''", '')
    s = re.sub(r'\{\{[^}]*\}\}', '', s)
    s = re.sub(r'[ \t]+', ' ', s)
    s = re.sub(r'\n\s*\n+', '\n', s)
    return s.strip()
