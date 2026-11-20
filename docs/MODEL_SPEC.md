# Item model spec (data/models/*.json)

Every charm, phone ability and memory card in `data/items.json` (generated from the wiki) gets a
hand-curated **model** that tells the Build Helper engine what the item does in numbers, what it
works well with, and how strong it is in general. This file defines that format.

The engine uses models in two ways:

1. **Simulation**: the `effects` list is applied to a simulated slot machine (5x3 grid, real symbol
   chances, pattern shapes, luck, retriggers). This produces exact-ish answers like "+1 Lemon chance
   is worth +14% coins/spin for *your* build, +1 Cherry chance only +3%".
2. **Judgement**: `ratings`, `tier`, `provides`/`cares` tags and `synergies` cover everything the
   simulator can't (economy, safety, meta-effects like Megaphone or Vorago) and power the
   "why this pick" explanations.

So: encode what you can as `effects`, and always fill in the judgement fields.

---

## 1. Model object

```jsonc
{
  "id": "golden_lemon",            // MUST equal the id in data/items.json
  "kind": "charm",                 // charm | phone | memory
  "summary": "20% of Lemons become Golden; each scored Golden Lemon permanently adds +2 Lemon value.",
  "tip": "Great once Lemons are your most common symbol. Pair with Lemon chance boosts.",
  "tier": "B",                     // S | A | B | C | D  (general strength in an average run)
  "ratings": {                     // 0-10 each, generic (an average build where the item applies)
    "power": 3,                    // immediate coin impact
    "scaling": 7,                  // how much stronger it makes you over the rest of the run
    "economy": 0,                  // tickets / coins / interest / restocks / discounts
    "utility": 0,                  // survival, safety, charm space, flexibility
    "risk": 0                      // downside severity (666 chance, self-discard, debt, lost coins)
  },
  "archetypes": ["lemon", "golden"],          // builds this item belongs to (vocabulary §4)
  "provides": ["golden", "symbolValue", "lemon"], // what it gives a build (vocabulary §3)
  "cares": ["lemon"],                          // what it needs/benefits from (vocabulary §3)
  "effects": [ /* see §2 */ ],
  "synergies": [ { "id": "life_gave_me_lemons", "why": "More Lemons on the grid means more Golden Lemons scored." } ],
  "antiSynergies": [ { "id": "theres_nothing_to_eat_but_mould", "why": "Halves Lemon chance." } ],
  "confidence": "high",            // high | medium | low  (how sure you are of the encoding)
  "assumptions": []                // short notes on anything you had to guess
}
```

Rules:
- `summary` and `tip` are **your own words** (do not paste the wiki text). Max ~160 chars each.
  Plain English, no markdown. The UI shows the official description separately.
- `synergies`/`antiSynergies` reference **ids that exist** in `data/items.json` (charms, phone or
  memory). Keep the strongest 1-6 relationships, with a concrete reason.
- `tier` meaning: **S** run-defining / almost always take; **A** strong in most builds;
  **B** solid or strong in its archetype; **C** niche / situational; **D** weak, trap, or mostly
  negative.
- `ratings.risk` is about downsides of the item itself (not opportunity cost).

## 2. Effects

An effect is `{ "type": ..., <params>, "when"?: {...}, "duration"?: "...", <extras>? }`.

- No `when` = **passive**: active while the charm is equipped (charms) or applied once for good
  (phone abilities, memory cards – they are permanent by nature).
- `duration` only matters for triggered effects: `"spin" | "round" | "deadline" | "permanent"`.
- Use numbers exactly as the item text says. Chances are fractions (`0.2` = 20%), except
  `interest`, `chance666` which are percentage points (`5` = +5%).

### 2.1 Scoring effects (simulated)

| type | params | example |
|---|---|---|
| `symbolChance` | `symbols`, one of `add` (weight; "+1" = 1), `mulBase` (multiplies base chance, e.g. 0.5), `set` (0 = never appears) | `{"type":"symbolChance","symbols":["lemon"],"add":1}` |
| `symbolValue` | `symbols`, one of `mul`, `addBase` (adds N x base value), `add` (flat coins) | `{"type":"symbolValue","symbols":["lemon","cherry"],"mul":2}` |
| `patternValue` | `patterns`, one of `mul`, `addBase` | `{"type":"patternValue","patterns":"large","addBase":1}` |
| `symbolsMult` | `add` or `mul` | `{"type":"symbolsMult","add":1}` |
| `patternsMult` | `add` or `mul` | `{"type":"patternsMult","add":2}` |
| `luck` | `add` | `{"type":"luck","add":7,"when":{"spin":"last"}}` |
| `retrigger` | `add` (extra triggers), `scope` | `{"type":"retrigger","add":1,"scope":"all","when":{"spin":"first"}}` |
| `modifierChance` | `modifier`, `symbols`, `add` (0-1) | `{"type":"modifierChance","modifier":"golden","symbols":["lemon"],"add":0.2}` |
| `forcePattern` | `pattern` (id, or array = one of them, or `"both"` list via `all:true`) | `{"type":"forcePattern","pattern":["ZIG","ZAG"],"all":true,"when":{"spin":"every","n":7}}` |
| `addPatterns` | `patterns` (array), `pick` (`"random"`/`"all"`) | Angel's Hand |
| `transform` | `mode`: `"singlePatternToBest"`, `"spreadSinglePattern"`, `"rerollNonPattern"` | Pain Killers / Halo / D4 |

`symbols` values: an array of symbol ids (`lemon cherry clover bell diamond treasure seven`) or one
of `"all"`, `"fruit"` (lemon+cherry), `"yellow"` (lemon bell treasure seven), `"nonYellow"`
(cherry clover diamond), `"gems"` (diamond treasure seven), `"mostProbable"`, `"mostValuable"`,
`"random"` (with `"count": n`).

`patterns` values: an array of pattern ids (`HOR VER DIAG HOR_L HOR_XL ZIG ZAG ABOVE BELOW EYE
JACKPOT HOR_S VER_S DIAG_S`) or `"small"` (3 or fewer symbols), `"large"` (4+), `"all"`.

`retrigger.scope`: `"all"`, `"fruit"`, `"yellow"`, `"nonYellow"`, `"gems"`, an array of symbols,
`"lastPattern"` (Obsessive), `"singleDiamondTreasure"` (Necklace).

### 2.2 Run / economy effects (valued by formulas, not simulated)

| type | params | notes |
|---|---|---|
| `tickets` | `add` / `mul` / `set`, `per`: `"instant" "round" "deadline"` | `{"type":"tickets","add":5,"per":"instant"}` |
| `ticketIncome` | `mul` or `set` | multiplies tickets earned at round/deadline end |
| `coins` | `add` / `mul` / `set` / `debtFraction` / `interestMultiple`, `per` | Lucky Cat = `interestMultiple:1` with `when` |
| `interest` | `add` (pct points), `per` optional | Stonks = `{"type":"interest","add":5}` |
| `freeRestocks` | `add`, `per` | |
| `storeDiscount` | `add` (tickets off each charm) or `freeCharms` (count) | |
| `charmSpace` | `add` | negative for Megaphone etc. |
| `spins` | `add` (per round) or `set`; optional `luck` for the extra spins | with `when` for one-off extra spins (Cat Toy: `{"add":2,"luck":8,"when":{"noRewardStreak":3}}`) |
| `rounds` | `add` / `set`, `per` | |
| `chance666` | `add` (pct points) or `mul` | Necronomicon = `{"type":"chance666","add":3}` |
| `protect666` | `chance` (0-1), `discardChance` (0-1) | Holy Bible = `{"chance":1,"discardChance":0.5}` |
| `debt` | `mul` or `addPct` | |
| `charges` | `restore` (`"all"` or number), `targets` (`"all"`/`"random"`) | |
| `redButton` | `extraTriggers`, `costReduce`, `noConsumeChance` (0-1) or `noRecharge` (true) | Nuclear Button = `{"extraTriggers":1}`; Overdose adds `{"noRecharge":true}` |
| `phone` | `extraTriggers`, `extraOptions`, `ban` | Megaphone = `{"extraTriggers":1}` |
| `randomTriggers` | `mul` | Horseshoe = `{"mul":2}` (charms with Triggers randomly) |
| `resellValue` | `add` / `mul`, `per` | |
| `trait` | `apply` (trait id or `"random"`), `target`: `"randomEquipped" "allEquipped" "store"` | |
| `deathSave` | `rounds` or `payDebt:true` | |
| `spawnCharm` | `pool`: `"sacred" "evil" "surgery" "random"` , `where`: `"table" "drawer"` | |
| `special` | `text` | anything else; describe it. The engine values it with `ratings`. |

### 2.3 Conditions (`when`)

| when | meaning |
|---|---|
| `{"event":"instant"}` | once, when obtained ("Doesn't take space" charms, instant phone effects) |
| `{"chance":0.4}` | "Triggers randomly (40%)" – rolled each spin |
| `{"spin":"first"}` / `{"spin":"last"}` | first / last spin of each Round |
| `{"spin":"every","n":7}` | every N spins |
| `{"patternsAtLeast":3}` | when 3+ Patterns trigger in a spin (retriggers count) |
| `{"patternsExactly":1}` / `{"noPatterns":true}` | exactly one / zero Patterns in the spin |
| `{"noRewardStreak":2}` | after N consecutive spins with no reward |
| `{"noLargeStreak":3}` | after N consecutive spins without a Pattern of 5+ symbols (Nose) |
| `{"patternSizeAtLeast":4}` | a Pattern of 4+ symbols is seen in the spin |
| `{"onlyPattern":"EYE"}` | the only Pattern of the spin is EYE |
| `{"scored":["diamond","treasure","seven"],"streak":3}` | scored those symbols N spins in a row |
| `{"scoredAll":["clover","bell"]}` | scored all listed symbols in the same spin |
| `{"on":"666"}` / `{"on":"999"}` / `{"on":"jackpot"}` | when that happens |
| `{"redButton":true}` | activated with the Red Button (charges come from items.json) |
| `{"on":"roundStart"}` `roundEnd` `deadlineStart` `deadlineEnd` `purchase` `restock` `discard` `phonePick` `phoneReroll` `roundSkipped` `charmTriggers` `dying` | events; add `"n": k` for "every k times" |
| `{"round":"first"}` / `{"round":"last"}` | first / last Round of a Deadline (whole round) |

Extras on any effect:
- `"note": "..."` – free text explaining an encoding choice (shown to maintainers, ignored by the engine except for a few documented hints).
- `"stack": true` – the effect accumulates every time the condition happens (scaling charms).
- `"reset": "round" | "deadline" | "never"` – when an accumulated/temporary bonus resets.
- `"cap": n` – maximum accumulated value.
- `"decay": {"add": -0.05, "per": "round"}` – passive value shrinks over time.
- `"discardAfter": {"count": 12, "of": "activations" | "rounds" | "uses"}` – charm breaks.
- `"perUnit": {"of": "tickets" | "freeRestocks" | "phoneRerolls" | "redCallsRefused" | "traitsEquipped" | "resellTotal" | "skippedRounds", "per": 15}` – value scales with a resource
  (e.g. Lost Wallet: `{"type":"patternsMult","add":1,"perUnit":{"of":"tickets","per":15}}`).

## 3. Tag vocabulary (`provides` / `cares`)

Symbols: `lemon cherry clover bell diamond treasure seven fruit yellow nonYellow allSymbols`
Scoring: `symbolValue symbolChance patternValue symbolsMult patternsMult luck retrigger jackpot eye aboveBelow zigZag horXL smallPatterns largePatterns patternCount`
Modifiers: `golden token ticketMod repetition battery chain investor rising copy revenge`
Economy: `tickets coins interest restock discount resell charmSpace spins rounds debt`
Mechanics: `redButton charges triggersRandomly phone phoneReroll traits discard purchase noReward roundSkip 666 999 sacred evil drawers surgery temporary instant deathSave store charmCount`

`cares` should list what makes the item better (e.g. Lucky Cat cares `patternCount interest`;
Horseshoe cares `triggersRandomly`; Nuclear Button cares `redButton`; Toy Train cares `noReward`).

## 4. Archetype vocabulary

`lemon cherry clover bell diamond treasure seven fruit gems jackpot retrigger multiplier golden chain interest tickets redButton devil sacred noReward phone traits discard restock`

## 5. Worked examples

```json
[
 {"id":"golden_lemon","kind":"charm","summary":"20% of Lemons become Golden; every scored Golden Lemon permanently adds +2 Lemon value.","tip":"Take it when Lemons already carry your build; stack Lemon chance to score more Golden Lemons.","tier":"B","ratings":{"power":2,"scaling":7,"economy":0,"utility":0,"risk":0},"archetypes":["lemon","golden"],"provides":["golden","symbolValue","lemon"],"cares":["lemon","symbolChance"],"effects":[{"type":"modifierChance","modifier":"golden","symbols":["lemon"],"add":0.2}],"synergies":[{"id":"life_gave_me_lemons","why":"More Lemons on the grid means more Golden Lemons scored."},{"id":"lemon_picture","why":"+2 Lemon chance for the deadline feeds the gilding."}],"antiSynergies":[{"id":"theres_nothing_to_eat_but_mould","why":"Halves Lemon chance."}],"confidence":"high","assumptions":[]},
 {"id":"pentacle","kind":"charm","summary":"Symbols Multiplier +1 that grows by 1 every spin with 5+ Patterns.","tip":"A core scaling piece for retrigger and jackpot builds.","tier":"A","ratings":{"power":3,"scaling":8,"economy":0,"utility":0,"risk":0},"archetypes":["multiplier","retrigger","jackpot"],"provides":["symbolsMult"],"cares":["patternCount","retrigger","luck"],"effects":[{"type":"symbolsMult","add":1},{"type":"symbolsMult","add":1,"when":{"patternsAtLeast":5},"stack":true,"reset":"never"}],"synergies":[{"id":"hamsa","why":"Retriggers push spins over 5 patterns."}],"antiSynergies":[],"confidence":"high","assumptions":[]},
 {"id":"lucky_cat","kind":"charm","summary":"Pays your current Interest in coins whenever a spin triggers 3+ Patterns.","tip":"Cheap early money; scales with Interest boosts like Stonks.","tier":"B","ratings":{"power":3,"scaling":3,"economy":5,"utility":0,"risk":0},"archetypes":["interest"],"provides":["coins"],"cares":["patternCount","interest"],"effects":[{"type":"coins","interestMultiple":1,"when":{"patternsAtLeast":3}}],"synergies":[{"id":"stonks","why":"+5% Interest raises every payout."}],"antiSynergies":[],"confidence":"high","assumptions":[]},
 {"id":"lemon_picture","kind":"charm","summary":"Red Button: Lemons appear more often (+2) for the rest of the Deadline.","tip":"Cheap way to push a Lemon build; useless if Lemons are not your scorer.","tier":"C","ratings":{"power":4,"scaling":2,"economy":0,"utility":0,"risk":0},"archetypes":["lemon","redButton"],"provides":["symbolChance","lemon","redButton"],"cares":["lemon","charges"],"effects":[{"type":"symbolChance","symbols":["lemon"],"add":2,"when":{"redButton":true},"duration":"deadline"}],"synergies":[{"id":"golden_lemon","why":"More Lemons = more gilding."}],"antiSynergies":[],"confidence":"high","assumptions":[]},
 {"id":"necronomicon","kind":"charm","summary":"Patterns Multiplier +2, but +3% chance of 666.","tip":"Huge flat multiplier; protect it with Holy Bible/Rosary or lean into 666 charms.","tier":"A","ratings":{"power":7,"scaling":2,"economy":0,"utility":0,"risk":5},"archetypes":["multiplier","devil"],"provides":["patternsMult","666"],"cares":[],"effects":[{"type":"patternsMult","add":2},{"type":"chance666","add":3}],"synergies":[{"id":"demons_horn","why":"Turns the extra 666s into Luck."}],"antiSynergies":[],"confidence":"high","assumptions":[]},
 {"id":"horseshoe","kind":"charm","summary":"Charms that trigger randomly roll twice as often.","tip":"Only worth a slot with 2+ random-trigger charms (Peppers, Broken Calculator, Rosary...).","tier":"C","ratings":{"power":1,"scaling":2,"economy":0,"utility":2,"risk":0},"archetypes":["jackpot"],"provides":["triggersRandomly"],"cares":["triggersRandomly"],"effects":[{"type":"randomTriggers","mul":2}],"synergies":[{"id":"broken_calculator","why":"35% retrigger becomes 70%."}],"antiSynergies":[],"confidence":"high","assumptions":[]},
 {"id":"personal_trainer","kind":"charm","summary":"25% of all Symbols get Repetition (retrigger their Patterns); -5% each Round, breaks at 0%.","tip":"Strong burst for 5 rounds; great right before a big deadline.","tier":"B","ratings":{"power":7,"scaling":2,"economy":0,"utility":0,"risk":3},"archetypes":["retrigger"],"provides":["repetition","retrigger"],"cares":["patternCount"],"effects":[{"type":"modifierChance","modifier":"repetition","symbols":"all","add":0.25,"decay":{"add":-0.05,"per":"round"},"discardAfter":{"count":5,"of":"rounds"}}],"synergies":[],"antiSynergies":[],"confidence":"high","assumptions":[]},
 {"id":"hamsa","kind":"charm","summary":"All Patterns trigger one extra time on the first spin of every Round.","tip":"Good with Golden/Chain modifiers and pattern-count charms.","tier":"B","ratings":{"power":3,"scaling":2,"economy":0,"utility":0,"risk":0},"archetypes":["retrigger"],"provides":["retrigger","patternCount"],"cares":[],"effects":[{"type":"retrigger","add":1,"scope":"all","when":{"spin":"first"}}],"synergies":[{"id":"rotated_hamsa","why":"Both Hamsas fuse into 10 Fingers Hamsa (DLC)."}],"antiSynergies":[],"confidence":"high","assumptions":[]},
 {"id":"megaphone","kind":"charm","summary":"Every phone ability you pick triggers one more time; -1 charm space.","tip":"Keep it in a drawer and equip it right before answering the phone.","tier":"A","ratings":{"power":0,"scaling":8,"economy":0,"utility":2,"risk":2},"archetypes":["phone"],"provides":["phone"],"cares":["phone","drawers"],"effects":[{"type":"phone","extraTriggers":1},{"type":"charmSpace","add":-1}],"synergies":[{"id":"barathrum","why":"Stack retriggers of the same phone ability."},{"id":"please_dont_throw_my_stuff_away","why":"+2 charm space instead of +1."}],"antiSynergies":[],"confidence":"high","assumptions":[]},
 {"id":"red_pepper","kind":"charm","summary":"20% chance each spin for +5 Luck; breaks after 12 activations.","tip":"Cheap early luck; Horseshoe doubles how often it fires.","tier":"C","ratings":{"power":3,"scaling":0,"economy":0,"utility":0,"risk":2},"archetypes":["jackpot"],"provides":["luck","triggersRandomly","temporary"],"cares":["triggersRandomly"],"effects":[{"type":"luck","add":5,"when":{"chance":0.2},"duration":"spin","discardAfter":{"count":12,"of":"activations"}}],"synergies":[{"id":"horseshoe","why":"Fires twice as often."}],"antiSynergies":[],"confidence":"high","assumptions":[]},
 {"id":"cigarettes","kind":"charm","summary":"Instantly raises every Symbol by its base value, then restocks the store (price +1 each buy).","tip":"Buy repeatedly when tickets are plentiful; permanent value for every symbol.","tier":"A","ratings":{"power":4,"scaling":6,"economy":1,"utility":1,"risk":0},"archetypes":["multiplier"],"provides":["symbolValue","allSymbols","instant","restock"],"cares":["tickets"],"effects":[{"type":"symbolValue","symbols":"all","addBase":1,"when":{"event":"instant"},"duration":"permanent"},{"type":"special","text":"Restocks the store and reappears; price rises by 1 per purchase until the deadline ends."}],"synergies":[{"id":"abyssu","why":"Can bank a Cigarettes activation."}],"antiSynergies":[],"confidence":"high","assumptions":[]},
 {"id":"life_gave_me_lemons","kind":"phone","summary":"Lemons appear more often (+1), permanently.","tip":"Commit only if Lemons are your engine; hard to undo.","tier":"C","ratings":{"power":3,"scaling":3,"economy":0,"utility":0,"risk":0},"archetypes":["lemon","fruit"],"provides":["symbolChance","lemon"],"cares":["lemon"],"effects":[{"type":"symbolChance","symbols":["lemon"],"add":1}],"synergies":[{"id":"golden_lemon","why":"More Lemons, more gilding."}],"antiSynergies":[],"confidence":"high","assumptions":[]},
 {"id":"i_need_supplements","kind":"phone","summary":"Doubles the current value of Lemons and Cherries.","tip":"Take it after raising fruit values, not before: doubling a bigger number gains more.","tier":"B","ratings":{"power":5,"scaling":3,"economy":0,"utility":0,"risk":0},"archetypes":["fruit","lemon","cherry"],"provides":["symbolValue","fruit"],"cares":["fruit","symbolValue"],"effects":[{"type":"symbolValue","symbols":"fruit","mul":2}],"synergies":[],"antiSynergies":[],"confidence":"high","assumptions":[]},
 {"id":"first_love","kind":"memory","summary":"Phone abilities trigger twice, but the store starts empty every Deadline.","tip":"Phone-centric run: value ticket-free power from calls; restocks become your shop.","tier":"A","ratings":{"power":0,"scaling":7,"economy":0,"utility":0,"risk":4},"archetypes":["phone"],"provides":["phone"],"cares":["restock"],"effects":[{"type":"phone","extraTriggers":1},{"type":"special","text":"Store is empty at the start of every Deadline (restock to fill it)."}],"synergies":[{"id":"megaphone","why":"Phone abilities trigger three times."}],"antiSynergies":[],"confidence":"high","assumptions":[]}
]
```

## 6. How the engine reads effects (write effects in these forms)

Check any model with `node tools/explain_models.mjs <id ...>`: it lists effects the engine
could not use ("unhandled") and the item's simulated value on a reference build.

| You want to say | Write it like this |
|---|---|
| Permanent bonus while equipped | no `when` (e.g. `{"type":"patternsMult","add":2}`) |
| One-time permanent change when bought | `"when":{"event":"instant"}` (+ `"duration":"permanent"`) |
| Bonus that grows forever on a trigger | trigger in `when` + `"stack":true` (or `"duration":"permanent"`). Supported triggers: `patternsAtLeast`, `patternsExactly`, `noPatterns`, `patternSizeAtLeast`, `onlyPattern`, `noRewardStreak`, `scoredAll`, `on:666/999/jackpot`, `chance`, and events (`on:deadlineEnd`, `roundEnd`, `purchase`, `restock`, `discard`, `phonePick`, `phoneReroll`, `roundSkipped`, `charmTriggers`) |
| Buff until the end of the round / deadline after a trigger | trigger in `when` + `"duration":"round"` or `"deadline"` (symbolValue `mul`/`addBase`, patternValue `mul`/`addBase`, symbolsMult `mul`/`add`, retrigger) |
| Luck on specific spins | `luck` with `when` `spin:first/last`, `spin:every`, `round:first/last`, `chance`, `noRewardStreak` (next spin), `on:666` (next spin), `on:roundStart`, `on:charmTriggers` |
| Red Button activation | `"when":{"redButton":true}`; symbolChance (`"duration":"deadline"`), retrigger (round), luck (next spin), spins (extra spin), addPatterns, forcePattern, symbolsMult/patternsMult `add` (permanent), symbolValue `addBase` (scored this round, permanent), rounds, interest |
| Value that depends on a resource the player has right now | `perUnit` on symbolsMult/patternsMult with `of`: `tickets`, `freeRestocks`, `traitsEquipped`, `resellTotal`, or run-wide counters the text says count "during the run" (`phoneRerolls`, `redCallsRefused`). Do NOT use perUnit for bonuses that only start counting after you buy the charm (e.g. Calendar): that is growth on an event (`on:deadlineEnd` + `stack`) |
| Extra spins | `spins` `add` (passive, per round) or with `when.chance` / a trigger (one-off extra spins) |
| Things the engine cannot express (bans, respawns, store manipulation, random effects, accumulating luck pools) | a `special` effect with a clear `text`; the engine then values the item from `ratings`, `cares` and `synergies`, so make those accurate |
