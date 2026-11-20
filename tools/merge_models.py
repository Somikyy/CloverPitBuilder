"""Merge data/models/*.json into data/models.json (the file the website loads).

Usage:  python3 tools/merge_models.py
Runs the validator first; refuses to write if there are errors.
"""
import glob, json, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..'))


def main():
    r = subprocess.run([sys.executable, '-I', os.path.join(HERE, 'validate_models.py')], capture_output=True, text=True)
    print(r.stdout.strip().splitlines()[-1] if r.stdout.strip() else r.stderr)
    if r.returncode != 0:
        print(r.stdout)
        sys.exit('validation failed: fix errors before merging')
    items = json.load(open(os.path.join(ROOT, 'data', 'items.json')))
    order = {x['id']: i for i, x in enumerate(items['charms'] + items['phone'] + items['memory'])}
    models = {}
    for f in sorted(glob.glob(os.path.join(ROOT, 'data', 'models', '*.json'))):
        for m in json.load(open(f)):
            models[m['id']] = m
    out = sorted(models.values(), key=lambda m: order.get(m['id'], 1e9))
    missing = [i for i in order if i not in models]
    json.dump(out, open(os.path.join(ROOT, 'data', 'models.json'), 'w'), ensure_ascii=False, separators=(',', ':'))
    print(f'wrote data/models.json with {len(out)} models; missing {len(missing)}' + (f': {missing[:12]}...' if missing else ''))


if __name__ == '__main__':
    main()
