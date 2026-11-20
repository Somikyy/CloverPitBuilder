# CloverPit Build Helper

An unofficial fan website for **CloverPit** players. Tell it what you have (charms, phone calls,
memory card, your in-game numbers) and it ranks which charm or phone call makes your build
stronger, explaining why.

- **Helper**: your run on one screen. The top three picks land on the slot machine's reels;
  every pick lists its reasons (coins now, growth over the next rounds, combos with what you
  own, risks). Type in what the store or phone is offering to rank exactly those options,
  prices included.
- **Items**: every lucky charm (201), phone call (41) and memory card (27) with the in-game
  text, strength ratings, synergies and unlock conditions. Searchable and filterable.
- **Tier list**: general tiers, or a tier list re-ranked for *your* build.
- **Share links**: "Copy share link" puts your whole build in the URL (no server needed).
  Builds also save in your browser; opening someone else's link keeps your own build under
  Saved builds.

It is a static site: plain HTML, CSS and JavaScript modules. No build step, no backend.

## How the picks are worked out

1. **A real slot machine simulation.** `assets/js/core/sim.js` plays thousands of spins on the
   3x5 grid with your symbol chances, luck (including the machine's own lucky spins), the
   wiki's pattern shapes and the "bigger pattern hides the smaller one" rule, retriggers,
   symbol modifiers, 6/66/666 and Red Button charms.
2. **Every item has a model.** `data/models.json` describes what each item does in numbers
   (effects), what it works with (tags, synergies) and how strong it is in general (ratings,
   tier). The format is in [docs/MODEL_SPEC.md](docs/MODEL_SPEC.md).
3. **Scoring.** For each candidate, `assets/js/core/engine.js` adds it to your build and
   compares coins per round now and on average over your horizon (the "Survive this deadline
   / Scale for later" slider), plus permanent growth, tickets, safety, risk and synergy with
   what you own. Effects the simulator can't express fall back on the curated ratings.

Numbers are estimates. If the advice looks wrong for a case you know well, open an issue with
the share link of your build.

## Run it locally

Any static file server works, for example:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000. (Opening `index.html` straight from disk does not work,
because browsers block loading the data files from `file://`.)

## Tests

```bash
node --test tests/*.test.mjs
```

```bash
python3 tools/validate_models.py
```

## Updating the data after a game patch

Item text and icons come from the [CloverPit Wiki](https://cloverpit.wiki.gg).

```bash
python3 tools/fetch_wiki.py
```

```bash
python3 tools/build_dataset.py
```

```bash
python3 tools/fetch_icons.py
```

New or changed items then need a model in `data/models/` (see the spec), followed by:

```bash
python3 tools/merge_models.py
```

## Publish on GitHub Pages

1. Merge this branch into `main`.
2. In the repository on GitHub: **Settings → Pages → Build and deployment → Source:
   GitHub Actions**.
3. The workflow in `.github/workflows/pages.yml` runs the tests and publishes the site on every
   push to `main`. The address appears in the workflow run and under Settings → Pages.
4. Link previews (Discord, etc.) use `assets/og.png` via an absolute URL that assumes the default
   address `https://somikyy.github.io/CloverPitBuilder/`. If you use a custom domain, update the
   `og:image` tags in the three HTML pages.

## Credits

- Item names, descriptions and icons: [CloverPit Wiki](https://cloverpit.wiki.gg) contributors;
  wiki text is licensed [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
- CloverPit and its art belong to Panik Arcade and Future Friends Games. This project is not
  affiliated with them.
- Fonts: [Handjet](https://github.com/rosettatype/Handjet) and Barlow Semi Condensed, under
  the SIL Open Font License (see `assets/fonts/`).
- Models, tiers, synergies and advice are this project's own estimates.
