"""Download the CloverPit Wiki (cloverpit.wiki.gg) page sources and image list.

Usage:  python3 tools/fetch_wiki.py [cache_dir]
Writes  <cache_dir>/wiki_pages.json and <cache_dir>/images.json  (default: tools/.cache)
Wiki text is CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0).
"""
import json, os, sys, time, urllib.parse, urllib.request

UA = "CloverPitBuilder-fan-tool/1.0 (+https://github.com/Somikyy/CloverPitBuilder)"
API = "https://cloverpit.wiki.gg/api.php"


def get(params):
    params = dict(params, format="json", formatversion="2")
    req = urllib.request.Request(API + "?" + urllib.parse.urlencode(params), headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def main():
    cache = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), ".cache")
    os.makedirs(cache, exist_ok=True)
    titles, cont = [], {}
    while True:
        d = get(dict(action="query", list="allpages", aplimit="500", apnamespace="0", apfilterredir="nonredirects", **cont))
        titles += [p["title"] for p in d["query"]["allpages"]]
        if "continue" not in d:
            break
        cont = {"apcontinue": d["continue"]["apcontinue"]}
    pages = {}
    for i in range(0, len(titles), 50):
        d = get(dict(action="query", prop="revisions|categories", rvprop="content|timestamp", rvslots="main",
                     cllimit="max", titles="|".join(titles[i:i + 50])))
        for p in d["query"]["pages"]:
            rev = p.get("revisions", [{}])[0]
            pages[p["title"]] = {
                "content": rev.get("slots", {}).get("main", {}).get("content", ""),
                "timestamp": rev.get("timestamp"),
                "categories": [c["title"] for c in p.get("categories", [])],
            }
        time.sleep(0.5)
    json.dump(pages, open(os.path.join(cache, "wiki_pages.json"), "w"), indent=1, ensure_ascii=False)
    imgs, cont = [], {}
    while True:
        d = get(dict(action="query", list="allimages", ailimit="500", aiprop="url|size|mime", **cont))
        imgs += d["query"]["allimages"]
        if "continue" not in d:
            break
        cont = {"aicontinue": d["continue"]["aicontinue"]}
    json.dump(imgs, open(os.path.join(cache, "images.json"), "w"), indent=1)
    print(f"pages: {len(pages)}  images: {len(imgs)}  -> {cache}")


if __name__ == "__main__":
    main()
