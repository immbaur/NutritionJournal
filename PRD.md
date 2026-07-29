# Nutrition Journal — Product Requirements Document

**Status:** Draft v2 (adds §5.9 Pantry)
**Author:** Immanuel Baur
**Date:** 2026-07-29
**Audience:** Personal use (single user)

---

## 1. Summary

Nutrition Journal is a personal web app for logging daily food intake. The user
records a meal by describing it in whatever form is convenient at the moment —
one or more **photos**, an **audio** note, **text**, or any mix of the three — and
a background AI agent analyzes the inputs to estimate nutrition facts (calories,
protein, fat, carbs, and more) as accurately as the provided evidence allows.
The user reviews the estimate, confirms it, and the entry is saved as its **own
folder** (a `meal.json` plus the original photos/audio/text) with a timestamp,
date, location, and an auto-classified meal type. A human-readable CSV of the full
history can be exported/derived from those meal files on demand.

Storing each meal in its own folder (rather than appending to one shared file)
means a bad or interrupted write can only ever affect that single meal — never the
whole history.

The app also keeps a **pantry**: a small store of packaged products whose nutrition
facts the user has captured once — usually by photographing the label after a
shopping trip. When a later meal mentions a known item ("50 ml of almond milk"),
its nutrition is **computed from the stored facts rather than estimated**. Items
are added deliberately from a shopping trip, or **on the fly** when a meal's inputs
happen to contain a nutrition label the app hasn't seen before. So the things the
user buys repeatedly get measured once and reused exactly, instead of being
re-guessed every meal.

The app opens on a **daily dashboard**: today's running nutrition totals so far
plus the day's meals, with easy navigation back through yesterday, the day
before, and a multi-day history — so the user can always see where they stand
today and how they've been eating over time.

The guiding principle is **minimum friction for the user, maximum inference by
the agent**. The user should be able to log a meal in seconds; the agent does the
work of turning messy multi-modal input into structured numbers.

---

## 2. Goals & Non-Goals

### Goals
- Log a food intake with **any combination** of photo(s), audio, and text.
- Have an agent estimate nutrition stats **as accurately as the evidence allows**,
  using explicit facts (weights in grams, nutrition labels) when provided and
  reasonable estimation when not.
- Build up a **pantry of known packaged products** over time — captured once from a
  nutrition label — and **compute from those stored facts instead of estimating**
  whenever a logged meal uses one, so precision improves with use.
- Let the pantry grow **without extra work**: items are proposed automatically when
  a meal's inputs contain a label the app hasn't seen yet.
- Show the estimate for **user confirmation before saving** (with the ability to
  edit).
- Persist each entry as its **own JSON file** (corruption-resistant), with a
  **human-readable CSV** derivable/exportable from the JSON files on demand.
- Keep the user-facing flow **as simple as possible** — auto-classify meal type
  and capture location/time automatically.

### Non-Goals (v1)
- No multi-user support, accounts, or sharing.
- No SQL/NoSQL engine — the "pantry database" (§5.9) and the meal history are both
  flat per-record JSON folders on disk (CSV as a derived export).
- No barcode scanning, no third-party nutrition API integration — pantry items come
  from labels the user photographs (or states), never from an external catalogue.
- **No recipes / composed items** in the pantry: it holds packaged products only.
  A dish made of several things is estimated per meal as usual; saving "my usual
  protein shake" as a reusable unit is out of scope (the schema shouldn't preclude
  it later).
- No goal-setting / calorie-budgeting / coaching features (may come later).
- No native mobile app (responsive web only).

---

## 3. Users & Context

- **Single user** (the author), on personal devices.
- Primary device is a **phone** (photos of food and nutrition labels, voice notes
  on the go), with occasional desktop use for review.
- Sometimes the user has a **kitchen scale** and provides exact grams; often they
  don't and rely on the agent's visual/textual estimate.
- The app is exposed publicly (via tunnel or a small server), so it must be
  **password-protected**.

---

## 4. User Stories

1. **As the user**, I can start a new intake entry and attach one or more photos,
   record or upload an audio note, and/or type a text description — in any
   combination — so I can capture a meal however is easiest right now.
2. **As the user**, I can take **multiple photos** for a single meal (e.g. one per
   ingredient's nutrition label) so the agent has all the facts.
3. **As the user**, when I have a scale, I can state the grams in text or audio so
   the estimate is exact.
4. **As the user**, after I submit, the agent analyzes everything and shows me an
   estimated nutrition breakdown before anything is saved.
5. **As the user**, I can review the estimate, tweak it if it's off, and confirm.
6. **As the user**, on confirmation the entry is saved with the current
   timestamp, date, and my location, and the meal type is filled in automatically.
7. **As the user**, I can view my history of logged intakes and daily totals.
8. **As the user**, when I open the app I immediately see **today's nutrition so
   far** (running totals + today's meals), so I always know where I stand for the
   day.
9. **As the user**, I can **step back through previous days** (yesterday, the day
   before, …) and skim a multi-day overview, so I can review how I've been eating
   over time.
10. **As the user**, after grocery shopping I can photograph the nutrition labels of
    what I bought (or say/type the values) and save them as **pantry items**, so the
    app knows those products exactly — several labels in one go.
11. **As the user**, when a meal I log mentions a product already in my pantry, its
    nutrition is **taken from the stored label, not estimated** — I state the amount
    ("50 ml almond milk") and the numbers are computed from the facts.
12. **As the user**, when I log a meal whose photos include a nutrition label for a
    product that isn't in my pantry yet, the app **offers to remember it** right
    there in the review step, so my pantry fills up without a separate chore.
13. **As the user**, I can browse, search, correct, and delete my pantry items, so
    a wrong or outdated entry never keeps poisoning future meals.

---

## 5. Functional Requirements

### 5.1 Add a new intake

- **FR-1** The app provides a "New Intake" action with input fields for:
  - **Photos**: one or more images (camera capture or file upload). Multiple
    images per entry are supported and treated as a single meal's evidence.
  - **Audio**: record in-browser or upload an audio file (one clip in v1,
    **max 15 seconds**).
  - **Text**: free-form description, including any explicit facts (grams,
    brand names, quantities).
- **FR-2** Any combination is valid, including a single modality alone. Submitting
  with **zero** inputs is blocked with a clear message.
- **FR-3** On submit, inputs are uploaded to an **isolated per-entry staging
  workspace** (e.g. `data/agent-workspace/<staging_id>/`), separate from the
  persistent meal store, for the agent to read. This is temporary scratch space,
  not the datastore (see 5.4.1 for its lifecycle).

### 5.2 Agent analysis

- **FR-4** A **background agent** (Claude Code CLI, mirroring Momentum's
  `spawn('claude', …)` pattern) receives all provided modalities and produces a
  structured nutrition estimate.
- **FR-5** The agent must:
  - Transcribe audio and read text for stated quantities/facts.
  - Read nutrition-label photos and food photos to identify items and portions.
  - **Match items against the pantry** (§5.9) and reference known products by id
    rather than estimating them (FR-21).
  - **Prefer explicit facts** — in order: a **pantry hit**, then a nutrition label
    read from this meal's photos, then grams stated by the user — over visual
    estimation; fall back to best-effort estimation only when none apply.
  - Return per-item breakdown **and** a total, with each item's **origin** recorded
    (`pantry` / `label` / `user-stated` / `estimate`).
- **FR-6** The estimate tracks these core nutrients (plus supporting fields):
  - `calories` (kcal)
  - `protein_g`
  - `fat_g`
  - `carbs_g`
  - `fiber_g` — **when available** (from a label or reliable data); left empty
    otherwise rather than guessed.
  - For **each** nutrient the agent returns a **point estimate**, and — when it
    can't be precise — an optional **low–high range** expressing its uncertainty.
    When confident, it may omit the range.
  - Plus a short `items` list (name + estimated amount), a numeric
    **`confidence` score (0.00–1.00)** with a short note (see 5.3.1), and the
    **model used** for the estimate.
  - No other nutrients (sugar/sodium/etc.) are tracked in v1 — keep the schema
    lean.
- **FR-7** While the agent runs, the UI shows a clear **"analyzing…"** state.
  Analysis should typically complete within a reasonable time; a timeout with a
  retry option is provided if it hangs.

### 5.3 Review & confirm

- **FR-8** Before saving, the app displays the agent's estimated breakdown (items
  + totals + assumptions).
- **FR-8a** Each item shows its **origin** — pantry hit (with the matched item's
  name/brand), label read from this meal, user-stated grams, or estimate — so the
  user can see at a glance which numbers are facts and which are guesses. Pantry
  hits can be **swapped or dismissed** here (FR-22).
- **FR-8b** Any **new pantry item the agent proposes** (FR-23) is shown in this same
  step as an editable card the user can accept or skip. It is written only when the
  meal is confirmed.
- **FR-9** The user can **edit** any value (correct a number, add/remove an item)
  and can **re-run** the agent or **cancel** entirely.
- **FR-10** Nothing is written to the **persistent meal store**
  (`data/meals/`) until the user **confirms**. Uploaded inputs and the agent's
  analysis result do exist temporarily beforehand, but only in the **isolated
  staging workspace** (FR-3, 5.4.1) — never in the datastore.

#### 5.3.1 Confidence & refinement loop

- **FR-9a** The agent returns a **numeric confidence score (0.00–1.00)** with a
  one-line reason, and it is **shown to the user** in the review step (the UI may
  present it as a percentage and/or bucket, but the underlying value is the raw
  number). Where the agent gave nutrient **ranges**, those are shown alongside the
  point estimates so the user sees the uncertainty directly.
- **FR-9b** When confidence is **low** (below a configurable threshold, e.g.
  `< 0.7`) or ranges are wide, the UI invites the user to **add more detail or
  more photos** (e.g. a missing nutrition label, the grams from a scale) and
  **re-run** the analysis on the enriched inputs — an iterative refine loop before
  confirming. Confirming a low-confidence estimate anyway is still allowed.
- **FR-9c** A pantry hit **raises** confidence but does not max it out. Exact
  nutrition density multiplied by an **estimated portion** still yields a range on
  the total; only when the amount is also stated (scale, or a whole package) does
  that item become fully precise. Confidence must reflect the weaker of the two.

### 5.4 Save

- **FR-11** On confirm, the app writes **this meal's folder**
  (`data/meals/<entry_id>/`, with `meal.json` inside — see §6.1) capturing:
  - Auto-generated `entry_id`
  - `timestamp` (local time) and `date`
  - `location` (see 5.6)
  - `meal_type` — **auto-classified from time of day** (breakfast/lunch/dinner/
    snack), with the option to override.
  - Nutrition values (calories, protein, fat, carbs, fiber-if-available), each
    with its point estimate and optional low–high range
  - `items` breakdown and the user's **original text input, stored verbatim**
  - References/paths to the stored raw inputs (photos, audio, and text) for that
    entry
  - `confidence` score + note, and `model_used`
- **FR-12** The **agent never writes to the persistent store directly.** It only
  produces a proposed estimate in an **isolated per-entry staging file** (in the
  agent workspace). On confirm, the **server** validates that proposal (plus any
  user edits) and writes the final `data/meals/<entry_id>/meal.json` atomically
  (write-temp-then-rename within the meal folder). Because each meal is its own
  folder, a malformed or interrupted write can only affect that one entry — the
  rest of the history is never touched.
- **FR-12a** There is **no single shared data file to corrupt.** The CSV is not a
  stored source of truth; it is generated on demand from the JSON files (see §6).

#### 5.4.1 Staging workspace lifecycle & cleanup

The staging workspace (`data/agent-workspace/`) holds temporary per-entry
directories created at submit time (FR-3), each containing the uploaded
photos/audio/text and the agent's proposed result. It must not accumulate
abandoned files. Rules:

- **FR-12b (Confirm → promote)** On confirm, the entry's inputs are **moved (or
  copied then deleted)** from its staging directory into the permanent
  `data/meals/<entry_id>/` folder, and the staging directory is removed. The
  persistent folder is a self-contained record; nothing it needs is left behind in
  staging. If the meal also produced an accepted **pantry item** (FR-23a), that
  item's label photo is **copied** into `data/pantry/<item_id>/` as well — both
  stores stay independently self-contained, neither referencing the other's files.
- **FR-12c (Cancel → delete)** If the user cancels/discards the entry, its staging
  directory (uploads and any proposed result) is **deleted immediately**.
- **FR-12d (Abandoned → expire)** Staging directories that are never confirmed or
  cancelled — e.g. the tab was closed, the analysis timed out — are **deleted
  after a retention period** (configurable, default ~24 h). A sweep runs on server
  start and periodically thereafter, removing any staging directory older than the
  retention window.
- **FR-12e** Cleanup only ever touches `data/agent-workspace/`; it must **never**
  delete anything under `data/meals/` or `data/pantry/`.

### 5.5 Meal-type auto-classification

- **FR-13** Meal type is inferred from local time (configurable default windows,
  e.g. breakfast 04–11, lunch 11–15, dinner 17–22, otherwise snack). User can
  override in the review step. Keep it invisible unless the user wants to change
  it.

### 5.6 Location

- **FR-14** Capture location at save time via browser Geolocation and
  **always store the raw lat/long** with the entry.
- **FR-14a** Resolve a **place name** for the entry:
  1. First, scan existing **meal JSON files** for a **previously saved entry at
     (approximately) the same lat/long** that already has a place name — if found,
     **reuse that name** (so "home", "office", the user's gym, etc. stay
     consistent). Matching uses a small distance tolerance (e.g. within ~50–100 m).
  2. If no known nearby location and the user **didn't mention** a place in their
     text/audio, the agent/app **suggests** a place name; the user can accept or
     edit it in the review step.
  3. If the user **did** mention a place, use what they said.
- **FR-14b** Must **degrade gracefully** — if Geolocation permission is denied or
  unavailable, save with empty lat/long (and no name) rather than blocking the
  entry.

### 5.7 Daily dashboard, history & review

- **FR-15 (Today view — the home screen)** The app **opens on today**, showing
  **today's running totals so far** — calories, protein, fat, carbs, fiber —
  prominently at the top, plus the list of today's individual meals (breakfast /
  lunch / dinner / snacks) beneath. This is the default landing view so "how am I
  doing today?" is answerable at a glance without any navigation.
- **FR-15a (Day navigation)** The user can move **back a day at a time** —
  yesterday, the day before, and so on — and forward again, viewing that day's
  totals and its meals. A simple prev/next-day control (and ideally a date picker
  to jump to a specific day) drives this. Each day shows the same layout as Today:
  day totals on top, that day's meals below.
- **FR-15b (Multi-day history overview)** Provide a scrollable **history list of
  recent days**, each row summarizing one day's date + totals (and meal count), so
  the user can skim the last week/weeks and tap into any day for detail. Days with
  no logged meals are shown as empty (zero totals), not skipped.
- **FR-16 (On-the-fly aggregation)** All day totals and history are **computed on
  the fly** from the meal JSON files (grouped by the entry `date`); there is no
  stored aggregate to keep in sync. Totals sum each nutrient's **point `value`**.
  *(Trend charts across days — e.g. calories/protein over the last 7/30 days — are
  a nice-to-have, reusing Momentum's vendored Chart.js.)*
- **FR-16c (Tap-through to a meal)** From any day, tapping a meal opens its detail
  (items breakdown, ranges, confidence, original photos/audio/text, location),
  where the user can edit or delete it (FR-16a).
- **FR-16a** **Post-save editing:** the user can edit or delete a previously saved
  entry (correct any nutrient value, meal type, location name, or note; remove the
  entry entirely). An edit **rewrites only that entry's `meal.json`** atomically;
  a delete removes (or tombstones) that single meal folder. No other entry is
  affected, and totals recompute automatically.
- **FR-16b** **CSV export:** the user can export the full history to CSV
  on demand (a button/endpoint), and/or a small script (`export-csv`) regenerates
  `data/intake-history.csv` from all JSON files. The CSV is always a **derived
  artifact**, never edited in place.

### 5.8 Auth

- **FR-17** All data routes require login (password + session cookie), following
  Momentum's auth model (generated-or-env password, hashed in a local file,
  long-lived session cookies).

### 5.9 Pantry (known-items store)

The pantry turns FR-5's "prefer explicit facts" into something that **persists
across meals**: a nutrition label photographed once counts as a hard fact forever.
Its whole value is precision, so the governing rule is that **only label-grade
evidence may create a pantry entry** — an estimate stored as a fact would quietly
contaminate every future meal that reuses it.

#### 5.9.1 Scope & storage

- **FR-18** Pantry items live in `data/pantry/<item_id>/`, one folder per item,
  containing `item.json` (source of truth) plus the label photo(s) it was built
  from. Written atomically by the server (temp-file + rename), same as meals — one
  bad write can damage at most one item.
- **FR-19** An item is a **packaged product** (almond milk, a protein bar, a jar of
  sauce). Recipes and composed dishes are out of scope (§2 Non-Goals).
- **FR-20** Nutrition is stored on a **canonical basis** — per **100 g** or per
  **100 ml**, matching how the label reads — using the same five nutrients as a
  meal (`calories`, `protein_g`, `fat_g`, `carbs_g`, `fiber_g`), plus optional
  **serving size** and **package size** so "one bar", "half the jar", and "50 ml"
  all resolve. `fiber_g` is left empty when the label doesn't state it — never
  guessed (consistent with FR-6).

#### 5.9.2 Using a pantry item in a meal

- **FR-21** At analysis time the server injects a **compact pantry index** (id,
  name, brand, aliases, basis) into the agent prompt. The agent matches items in
  the meal against it and returns a **`pantry_item_id` reference** — it does not
  re-state the stored numbers. Matching is name/brand/alias based; each item keeps
  an **aliases** list so it survives however the user actually talks about it
  ("almond milk", "the Alpro one").
- **FR-22** When several items match, the agent picks its best candidate (**most
  recently used** breaks ties) and the review step shows **which** pantry item it
  used, with one tap to **swap to another item** or **dismiss the match** and fall
  back to estimation. No blocking prompt — the fast path stays fast.
- **FR-22a** **The server performs the arithmetic**, not the model: stored per-100
  values × the stated amount, using serving/package size when the user speaks in
  those units. The agent's job is identification and portion reading; multiplying
  known numbers must not route through a language model.

#### 5.9.3 Adding items on the fly

- **FR-23** During normal meal analysis, when the inputs contain **label-grade
  evidence** for a product not yet in the pantry — a readable nutrition label in a
  photo, or the user stating per-100 g/ml or per-serving values — the agent
  proposes a **new pantry item**. A merely *identified* or visually estimated food
  (e.g. "grilled chicken breast") is used for the meal and **never** stored.
- **FR-23a** The proposal appears in the meal's **review step** (FR-8b) as an
  editable card the user can correct or skip, and is written to `data/pantry/` only
  when the meal is **confirmed**. Cancelling the meal discards the proposal with the
  rest of the staging workspace (FR-12c). On confirm, the app **tells the user**
  what was added ("Added almond milk to your pantry").

#### 5.9.4 Adding items deliberately

- **FR-24** A **"New Item"** action accepts the same three modalities as a meal
  (photos / audio / text). One submission may carry **several labels** and produce
  **several items** — the after-shopping case. The agent extracts each item's
  fields, the user reviews and edits, and confirms.
- **FR-25** If an extracted item closely matches an existing entry (same
  name/brand), the app offers to **update that item** rather than creating a
  near-duplicate; updating refreshes its values, media, and `last_verified`.

#### 5.9.5 Provenance, freshness & units

- **FR-26** Every item records how it came to exist: `source`
  (`label-photo` / `user-stated`), a `confidence` score, `model_used`, and
  `last_verified` (date the facts were captured or refreshed), so a questionable
  entry is always identifiable — and so a reformulated product can be spotted and
  re-photographed.
- **FR-27** **Unit conversions are not faked.** An item stored per 100 ml used with
  a gram amount (or vice versa) requires a density the app does not have; that
  conversion is treated as an **estimate** and flagged as such in the item's origin
  and the meal's confidence, rather than being silently applied.

#### 5.9.6 Management & integrity

- **FR-28** A **Pantry screen** lists all items with search, and allows **editing**
  (any field, including aliases) and **deleting** an item. This is required, not
  optional: the on-the-fly path (FR-23) will produce entries that eventually need
  correcting.
- **FR-29** Meals store **resolved values**, not live references. A meal's
  `meal.json` keeps the computed numbers (plus the `pantry_item_id` for
  traceability), so **editing or deleting a pantry item never rewrites saved
  meals** and past totals never shift under the user.
- **FR-30** The **agent never writes the pantry directly** (mirroring FR-12). It
  proposes items in the isolated staging workspace; the **server** validates and
  writes `data/pantry/<item_id>/item.json` on user confirm.

---

## 6. Data Model

### 6.1 Source of truth: one folder per meal

Each confirmed meal gets its **own folder**, `data/meals/<entry_id>/`, containing
the structured entry plus its raw inputs. The `<entry_id>` is sortable by time
(e.g. `2026-07-29T12-30-05__a1b2c3`), so listing `data/meals/` is chronological.

```
data/meals/<entry_id>/
  meal.json        # the structured entry — the source of truth
  note.txt         # verbatim text input (present only if text was given)
  photo-1.jpg      # uploaded photo(s), original files
  photo-2.jpg
  audio.webm       # uploaded/recorded audio (present only if given)
```

- **`meal.json`** is the single source of truth for that entry (schema below).
- **`media_refs`** in `meal.json` lists filenames **relative to the meal folder**
  (`photo-1.jpg`, `audio.webm`, `note.txt`), never absolute paths.
- There is deliberately **no single shared data file** — so no write can corrupt
  the whole history; the blast radius of any bad write is one meal's folder.

Proposed `meal.json` schema:

```json
{
  "entry_id": "2026-07-29T12-30-05__a1b2c3",
  "timestamp": "2026-07-29T12:30:05+02:00",
  "date": "2026-07-29",
  "meal_type": "lunch",
  "nutrition": {
    "calories": { "value": 620, "low": 560, "high": 700, "unit": "kcal" },
    "protein_g": { "value": 38, "low": null, "high": null },
    "fat_g":     { "value": 22, "low": 18, "high": 27 },
    "carbs_g":   { "value": 61, "low": null, "high": null },
    "fiber_g":   { "value": 7,  "low": null, "high": null }
  },
  "items": [
    { "name": "grilled chicken breast", "amount": "150 g", "origin": "user-stated", "pantry_item_id": null },
    { "name": "white rice", "amount": "~200 g cooked", "origin": "estimate", "pantry_item_id": null },
    { "name": "almond milk", "amount": "50 ml", "origin": "pantry", "pantry_item_id": "almond-milk-alpro__7f3a91" }
  ],
  "note": "150g chicken, rice, and the sauce from the jar in the photo",
  "location": { "lat": 48.1371, "long": 11.5754, "name": "home" },
  "media_refs": ["photo-1.jpg", "photo-2.jpg", "audio.webm", "note.txt"],
  "confidence": 0.82,
  "confidence_note": "grams given for chicken; rice portion estimated from photo",
  "model_used": "opus",
  "schema_version": 1,
  "created_at": "2026-07-29T12:30:07+02:00",
  "updated_at": "2026-07-29T12:30:07+02:00"
}
```

Field notes:
- **Nutrients** (`calories`, `protein_g`, `fat_g`, `carbs_g`, `fiber_g`): each is
  an object with a **`value`** (the point estimate — always present, drives daily
  totals and charts) and optional **`low`/`high`** range when the agent can't be
  precise (`null` when confident). `fiber_g` may be omitted entirely when
  unavailable.
- **`confidence`**: numeric `0.00`–`1.00` (e.g. `0.82`), not a low/med/high label.
  The review UI may bucket it for display, but the stored value is the raw number.
- **`location`**: raw `lat`/`long` always stored when available; `name` reused
  from a prior nearby entry, agent-suggested, or user-stated (any may be empty).
- **`items[].origin`**: `pantry` | `label` | `user-stated` | `estimate` — where that
  item's numbers came from (FR-5). When `pantry`, **`pantry_item_id`** records which
  item was used, for traceability; the values themselves are already resolved into
  this file and do not change if that pantry item is later edited (FR-29).
- **`model_used`**: model that produced the estimate (+ version if available).
- **`schema_version`**: lets the format evolve without breaking old files.

### 6.2 Raw inputs are preserved for every entry

All three modalities the user supplied are kept **inside the same meal folder**
(§6.1), not just the derived numbers:
- **Photos & audio** → the uploaded files, referenced by `media_refs`.
- **Text** → stored verbatim in `meal.json`'s `note` field **and** as `note.txt`,
  so the folder is a complete record of what was submitted.

This means an entry can always be **re-analyzed later from its original inputs**,
and the whole meal (data + media) can be backed up, moved, or deleted as one
directory. Transient inputs during analysis live in a separate agent workspace
dir, mirroring Momentum's `data/agent-workspace/`; only on confirm is the final
folder written under `data/meals/`.

### 6.3 CSV is a derived export (not a stored source of truth)

A flat, human-readable CSV (`data/intake-history.csv`) is produced **on demand**
by flattening every `data/meals/<entry_id>/meal.json` — one row per entry, one column per nutrient
`value` plus optional `_low`/`_high` columns, and the scalar fields (`entry_id`,
`timestamp`, `date`, `meal_type`, `items`, `note`, `lat`, `long`,
`location_name`, `media_refs`, `confidence`, `confidence_note`, `model_used`).
It is generated by an **`export-csv` script** and/or a download endpoint, and is
regenerable at any time. Because it is derived, it is never edited in place and
its loss is harmless — the JSON files remain authoritative.

### 6.4 Pantry: one folder per item

The pantry mirrors the meal store's shape — one folder per record, `item.json` as
the source of truth, raw evidence beside it:

```
data/pantry/<item_id>/
  item.json        # the structured item — the source of truth
  label-1.jpg      # the nutrition-label photo(s) it was built from
```

The `<item_id>` is a slug plus a short random suffix
(e.g. `almond-milk-alpro__7f3a91`), stable for the item's lifetime so meals can
reference it.

```json
{
  "item_id": "almond-milk-alpro__7f3a91",
  "name": "almond milk, unsweetened",
  "brand": "Alpro",
  "aliases": ["almond milk", "alpro almond", "the almond stuff"],
  "basis": { "amount": 100, "unit": "ml" },
  "nutrition": {
    "calories":  { "value": 13, "unit": "kcal" },
    "protein_g": { "value": 0.4 },
    "fat_g":     { "value": 1.1 },
    "carbs_g":   { "value": 0.0 },
    "fiber_g":   { "value": 0.4 }
  },
  "serving_size": { "amount": 250, "unit": "ml" },
  "package_size": { "amount": 1000, "unit": "ml" },
  "source": "label-photo",
  "added_via": "meal-auto",
  "added_from_entry_id": "2026-07-29T12-30-05__a1b2c3",
  "confidence": 0.95,
  "confidence_note": "all five values read directly from the carton label",
  "model_used": "opus",
  "media_refs": ["label-1.jpg"],
  "last_verified": "2026-07-29",
  "last_used_at": "2026-07-29T12:30:05+02:00",
  "schema_version": 1,
  "created_at": "2026-07-29T12:30:09+02:00",
  "updated_at": "2026-07-29T12:30:09+02:00"
}
```

Field notes:
- **`basis`**: the canonical reference amount the nutrition values describe — per
  `100 g` for solids, per `100 ml` for liquids, matching the label (FR-20). All
  meal math is `stored value × (amount used ÷ basis amount)`, done **server-side**
  (FR-22a).
- **`aliases`**: how the user actually refers to the item in speech/text; drives
  matching (FR-21) and grows as the user's phrasing varies.
- **`serving_size` / `package_size`**: optional, enabling "one bar" or "half the
  jar" to resolve without a scale. Omitted when the label doesn't state them.
- **`fiber_g`**: omitted entirely when the label doesn't list it — never guessed.
- **`source`** (`label-photo` | `user-stated`) records the **evidence class**;
  only these two exist, because estimated values may never create an item (FR-23).
  **`added_via`** (`manual` | `meal-auto`) records the **route** in, and
  `added_from_entry_id` links back to the meal that produced an auto-added item.
- **`last_verified`**: when the facts were captured or refreshed — the handle for
  spotting reformulated products. **`last_used_at`** breaks ties when several items
  match the same name (FR-22).
- The pantry has **no shared index file**: the match index (FR-21) is built in
  memory from the item folders at analysis time, so there is nothing to keep in
  sync and nothing whose corruption could take out the pantry.

---

## 7. Technical Approach (mirrors Momentum)

- **Runtime:** Node.js + **Express**, **no build step**. Vanilla JS/HTML/CSS
  frontend served as static files, plus JSON/multipart API endpoints.
- **Agent:** the **Claude Code CLI** invoked non-interactively via
  `spawn('claude', ['-p', prompt, '--allowedTools', 'Read,Write', '--model', 'opus'])`,
  with the prompt driven by a markdown template in `templates/`
  (e.g. `ANALYZE_INTAKE_PROMPT.md`). The agent reads the entry's media/text from a
  workspace dir and writes its proposed estimate to an **isolated staging JSON**
  in that workspace — it **never** touches the persistent `data/meals/` or
  `data/pantry/` stores. The server parses/validates the staging JSON and only
  writes the final per-meal file on user confirm.
- **Pantry in the prompt:** the server builds the pantry index in memory from
  `data/pantry/*/item.json` and injects it into the prompt (a compact list of id /
  name / brand / aliases / basis). The agent returns `pantry_item_id` references and
  amounts; **the server does the multiplication** (FR-22a). A second template
  (e.g. `EXTRACT_ITEM_PROMPT.md`) drives the deliberate "New Item" flow.
- **Model & billing:** use **Opus**. The agent runs through the Claude Code CLI,
  which bills against the **Claude subscription (Max plan)** — **not** the
  pay-per-token API. No API key / metered usage. Opus is vision-capable, which is
  required since photos (food + nutrition labels) are core to the analysis.
- **Uploads:** multipart handling for images/audio (multiple files per request).
- **Datastore:** **one folder per meal** under `data/meals/<entry_id>/`, whose
  `meal.json` is the source of truth (raw media/`note.txt` live beside it),
  written atomically (temp-file + rename) by the server only. The **pantry** uses
  the identical pattern under `data/pantry/<item_id>/` (`item.json` + label
  photos) — two independent stores, no shared index, no cross-store write. CSV is a
  derived export regenerated from the meal folders on demand. Separate JSON files
  hold auth/sessions/transient state, as in Momentum.
- **Auth:** password + session cookies, as in Momentum.
- **Deployment:** local run script + Cloudflare quick tunnel for session use;
  optional DigitalOcean droplet for a stable URL — reusing Momentum's
  `deploy/` patterns.
- **Dependencies:** keep minimal (Express, a multipart parser, optionally
  Chart.js vendored for history charts).

---

## 8. Primary User Flow

1. User opens app → logs in (if session expired) → lands on the **Today
   dashboard** (running totals so far + today's meals; can swipe/step back to
   previous days).
2. Taps **New Intake**.
3. Adds any mix of: photo(s), audio, text (e.g. "150g rice" + photo of chicken +
   photo of a sauce label).
4. Taps **Submit** → UI shows **"Analyzing…"**.
5. Background agent transcribes/reads/estimates, **matches items against the
   pantry**, and returns items + totals + assumptions.
6. App shows the **estimated breakdown**, each item tagged with its origin —
   including any **pantry hits** (numbers computed from stored label facts, not
   estimated) and any **new item it proposes remembering**.
7. User reviews, optionally swaps a pantry match, edits, or re-runs, then taps
   **Confirm**.
8. Server writes the meal's **own folder** (`data/meals/<entry_id>/` with
   `meal.json` + the raw inputs) with timestamp, date, location, auto meal-type,
   and the confirmed values — plus any **accepted new pantry item** to
   `data/pantry/<item_id>/`.
9. App returns to the **Today dashboard** with the new meal listed and today's
   running totals updated (read live from the JSON files), noting any item added to
   the pantry; CSV can be exported any time.

### 8.1 Secondary flow — stocking the pantry after shopping

1. User gets home from the shop, opens the app → **Pantry** → **New Item**.
2. Photographs the nutrition labels of what they bought (several in one go), or
   dictates/types the values.
3. Taps **Submit** → agent extracts one candidate item per label: name, brand,
   per-100 g/ml values, serving and package size.
4. App shows the extracted items for review; the user corrects anything off, adds
   aliases, and drops any it doesn't want. Items matching something already stored
   are offered as an **update** instead of a duplicate.
5. **Confirm** → server writes each `data/pantry/<item_id>/item.json` with its
   label photo.
6. From then on, any meal mentioning those products is **computed, not estimated**.

---

## 9. Resolved Decisions

1. **Model / billing:** **Opus**, run via the Claude Code CLI on the **Claude
   subscription (Max plan)** — not the pay-per-token API. (Ref. §7)
2. **Location:** **always store raw lat/long.** Reuse a place name from a prior
   nearby entry if one exists; otherwise suggest a name when the user didn't state
   one; use the user's stated place when they did. (Ref. FR-14)
3. **Post-save editing:** **yes** — entries can be edited or deleted after saving.
   (Ref. FR-16a)
4. **Audio:** one clip, **max 15 seconds**. (Ref. FR-1)
5. **Nutrients tracked:** **Calories, Protein, Fat, Carbs, and Fiber** (fiber
   when available) — no other nutrients in v1. Each has a **point estimate** plus
   an optional **low–high range** when the agent can't be precise. (Ref. FR-6)
6. **Confidence:** a **numeric score (0.00–1.00)**, shown to the user with a short
   note. When low (or ranges are wide), the UI prompts the user to add more
   detail/photos and re-run. (Ref. FR-9a/9b)
7. **Provenance:** each entry records the **`model_used`** that produced its
   estimate. (Ref. §6)
8. **Storage architecture:** **one folder per meal** (`data/meals/<entry_id>/`
   with `meal.json` + raw inputs) is the source of truth (corruption-resistant —
   one bad write ≠ whole history). The **agent never writes the persistent
   store**; it writes an isolated staging file and the server writes the final
   `meal.json` on confirm. **CSV is a derived export** regenerated from the meal
   folders on demand. (Ref. §6, FR-11/12, FR-16b)
9. **Pantry — evidence bar:** an item is created **only from label-grade
   evidence** (a readable nutrition label, or user-stated per-100/per-serving
   values). Visually estimated foods are used for the meal and **never** stored, so
   a guess can never masquerade as a fact in later meals. (Ref. FR-23)
10. **Pantry — auto-add UX:** on-the-fly items are **proposed in the meal's review
    step** as an editable, skippable card and written only on confirm; the user is
    told what was added. Nothing enters the pantry unseen. (Ref. FR-8b, FR-23a)
11. **Pantry — match conflicts:** the agent picks its best match (most recently
    used breaks ties) and the review step **shows which item it used**, with one tap
    to swap or fall back to estimation — no blocking prompt on the fast path.
    (Ref. FR-22)
12. **Pantry — scope:** **packaged products only**, stored per **100 g / 100 ml**
    with optional serving and package size. No recipes or composed items in this
    version. (Ref. FR-19/20)
13. **Pantry — arithmetic:** the **server** multiplies stored values by the amount
    used; the agent only identifies items and reads portions. Known numbers never
    route through the model. (Ref. FR-22a)
14. **Pantry — snapshot semantics:** meals store **resolved values** plus a
    `pantry_item_id` for traceability. Editing or deleting a pantry item never
    rewrites saved meals. (Ref. FR-29)

### Remaining to confirm during build
- Audio accepted formats and in-browser recording approach.
- Lat/long **match tolerance** for reusing a saved location name (default ~50–100 m).
- Whether to reverse-geocode suggested names offline vs. leaving suggestion to the
  agent from context.
- Pantry **matching strictness** — how close a name/alias must be before the agent
  claims a hit, and whether near-misses should surface as a suggestion rather than
  a silent estimate.
- Whether `last_verified` should drive a gentle **staleness hint** ("this label is
  a year old") or stay purely informational.
- How to handle a **partially readable label** (e.g. fiber missing, or a blurred
  row): store the item with gaps, or reject it until re-photographed.

---

## 10. Success Criteria

- Logging a typical meal (photo + a few words) takes **well under a minute** end
  to end.
- Each meal is a **self-contained folder** (`meal.json` + its raw inputs); a
  corrupt or interrupted write can never damage more than that one entry.
- The exported CSV is **openable in any spreadsheet app** and immediately
  understandable, and can be regenerated from the JSON files at any time.
- When explicit grams/labels are provided, the saved numbers **match the facts**
  (agent doesn't override hard data with guesses).
- A product photographed **once** is never estimated again: logging "50 ml almond
  milk" months later yields numbers derived from that stored label, and the review
  step makes clear that's where they came from.
- The pantry fills itself **as a side effect of normal logging** — after a few
  weeks of ordinary use, the user's regular products are in it without a dedicated
  data-entry session having been needed.
- **Nothing in the pantry is a guess.** Every item traces back to a label photo or
  values the user stated, visible on the item itself.
- The app runs from a single `start.sh` with no build step, reachable from the
  phone.
