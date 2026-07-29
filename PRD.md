# Nutrition Journal — Product Requirements Document

**Status:** Draft v1
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
JSON file** with a timestamp, date, location, and an auto-classified meal type. A
human-readable CSV of the full history can be exported/derived from those JSON
files on demand.

Storing each meal as a separate JSON file (rather than appending to one shared
file) means a bad or interrupted write can only ever affect that single meal —
never the whole history.

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
- Show the estimate for **user confirmation before saving** (with the ability to
  edit).
- Persist each entry as its **own JSON file** (corruption-resistant), with a
  **human-readable CSV** derivable/exportable from the JSON files on demand.
- Keep the user-facing flow **as simple as possible** — auto-classify meal type
  and capture location/time automatically.

### Non-Goals (v1)
- No multi-user support, accounts, or sharing.
- No real (SQL/NoSQL) database — flat per-meal JSON files for now (CSV as a
  derived export).
- No barcode scanning, no third-party nutrition API integration (agent estimates
  from the inputs it's given).
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
- **FR-3** On submit, inputs are uploaded/stored to a per-entry working area for
  the agent to read.

### 5.2 Agent analysis

- **FR-4** A **background agent** (Claude Code CLI, mirroring Momentum's
  `spawn('claude', …)` pattern) receives all provided modalities and produces a
  structured nutrition estimate.
- **FR-5** The agent must:
  - Transcribe audio and read text for stated quantities/facts.
  - Read nutrition-label photos and food photos to identify items and portions.
  - **Prefer explicit facts** (grams from a scale, label values) over visual
    estimation; fall back to best-effort estimation otherwise.
  - Return per-item breakdown **and** a total.
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
- **FR-9** The user can **edit** any value (correct a number, add/remove an item)
  and can **re-run** the agent or **cancel** entirely.
- **FR-10** Nothing is written to the datastore until the user **confirms**.

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

### 5.4 Save

- **FR-11** On confirm, the app writes **one JSON file for this meal** (e.g.
  `data/meals/<entry_id>.json`) capturing:
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
  user edits) and writes the final `data/meals/<entry_id>.json` atomically
  (write-temp-then-rename). Because each meal is its own file, a malformed or
  interrupted write can only affect that one entry — the rest of the history is
  never touched.
- **FR-12a** There is **no single shared data file to corrupt.** The CSV is not a
  stored source of truth; it is generated on demand from the JSON files (see §6).

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
  entry entirely). An edit **rewrites only that entry's JSON file** atomically; a
  delete removes (or tombstones) that single file. No other entry is affected, and
  totals recompute automatically.
- **FR-16b** **CSV export:** the user can export the full history to CSV
  on demand (a button/endpoint), and/or a small script (`export-csv`) regenerates
  `data/intake-history.csv` from all JSON files. The CSV is always a **derived
  artifact**, never edited in place.

### 5.8 Auth

- **FR-17** All data routes require login (password + session cookie), following
  Momentum's auth model (generated-or-env password, hashed in a local file,
  long-lived session cookies).

---

## 6. Data Model

### 6.1 Source of truth: one JSON file per meal

Each confirmed meal is stored as its own JSON file, e.g.
`data/meals/<entry_id>.json` (the filename sortable by time, e.g.
`2026-07-29T12-30-05__<shortid>.json`). This is the **only source of truth**.
There is deliberately **no single shared data file** — so no write can corrupt the
whole history; the blast radius of any bad write is one meal.

Proposed per-meal schema:

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
    { "name": "grilled chicken breast", "amount": "150 g", "source": "user-stated grams" },
    { "name": "white rice", "amount": "~200 g cooked", "source": "photo estimate" }
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
- **`model_used`**: model that produced the estimate (+ version if available).
- **`schema_version`**: lets the format evolve without breaking old files.

### 6.2 Raw inputs are preserved for every entry

All three modalities the user supplied are kept alongside the JSON, not just the
derived numbers — under a per-entry folder (e.g. `data/meals/<entry_id>/` or
`data/media/<entry_id>/`):
- **Photos & audio** → the uploaded files, referenced by `media_refs`.
- **Text** → stored verbatim in the JSON `note` field **and** as `note.txt` in the
  entry folder, so the folder is a complete record of what was submitted.

This means an entry can always be **re-analyzed later from its original inputs**.
Transient per-entry inputs also live in an agent workspace dir during analysis,
mirroring Momentum's `data/agent-workspace/`.

### 6.3 CSV is a derived export (not a stored source of truth)

A flat, human-readable CSV (`data/intake-history.csv`) is produced **on demand**
by flattening all meal JSON files — one row per entry, one column per nutrient
`value` plus optional `_low`/`_high` columns, and the scalar fields (`entry_id`,
`timestamp`, `date`, `meal_type`, `items`, `note`, `lat`, `long`,
`location_name`, `media_refs`, `confidence`, `confidence_note`, `model_used`).
It is generated by an **`export-csv` script** and/or a download endpoint, and is
regenerable at any time. Because it is derived, it is never edited in place and
its loss is harmless — the JSON files remain authoritative.

---

## 7. Technical Approach (mirrors Momentum)

- **Runtime:** Node.js + **Express**, **no build step**. Vanilla JS/HTML/CSS
  frontend served as static files, plus JSON/multipart API endpoints.
- **Agent:** the **Claude Code CLI** invoked non-interactively via
  `spawn('claude', ['-p', prompt, '--allowedTools', 'Read,Write', '--model', 'opus'])`,
  with the prompt driven by a markdown template in `templates/`
  (e.g. `ANALYZE_INTAKE_PROMPT.md`). The agent reads the entry's media/text from a
  workspace dir and writes its proposed estimate to an **isolated staging JSON**
  in that workspace — it **never** touches the persistent `data/meals/` store.
  The server parses/validates the staging JSON and only writes the final per-meal
  file on user confirm.
- **Model & billing:** use **Opus**. The agent runs through the Claude Code CLI,
  which bills against the **Claude subscription (Max plan)** — **not** the
  pay-per-token API. No API key / metered usage. Opus is vision-capable, which is
  required since photos (food + nutrition labels) are core to the analysis.
- **Uploads:** multipart handling for images/audio (multiple files per request).
- **Datastore:** **one JSON file per meal** under `data/meals/` (source of truth),
  written atomically (temp-file + rename) by the server only. CSV is a derived
  export regenerated from the JSON files on demand. JSON files also hold
  auth/sessions/transient state, as in Momentum.
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
5. Background agent transcribes/reads/estimates → returns items + totals +
   assumptions.
6. App shows the **estimated breakdown**.
7. User reviews, optionally edits or re-runs, then taps **Confirm**.
8. Server writes the meal's **own JSON file** (`data/meals/<entry_id>.json`) with
   timestamp, date, location, auto meal-type, and the confirmed values.
9. App returns to the **Today dashboard** with the new meal listed and today's
   running totals updated (read live from the JSON files); CSV can be exported any
   time.

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
8. **Storage architecture:** **one JSON file per meal** is the source of truth
   (corruption-resistant — one bad write ≠ whole history). The **agent never
   writes the persistent store**; it writes an isolated staging file and the
   server writes the final per-meal JSON on confirm. **CSV is a derived export**
   regenerated from the JSON files on demand. (Ref. §6, FR-11/12, FR-16b)

### Remaining to confirm during build
- Audio accepted formats and in-browser recording approach.
- Lat/long **match tolerance** for reusing a saved location name (default ~50–100 m).
- Whether to reverse-geocode suggested names offline vs. leaving suggestion to the
  agent from context.

---

## 10. Success Criteria

- Logging a typical meal (photo + a few words) takes **well under a minute** end
  to end.
- Each meal is a **self-contained JSON file**; a corrupt or interrupted write can
  never damage more than that one entry.
- The exported CSV is **openable in any spreadsheet app** and immediately
  understandable, and can be regenerated from the JSON files at any time.
- When explicit grams/labels are provided, the saved numbers **match the facts**
  (agent doesn't override hard data with guesses).
- The app runs from a single `start.sh` with no build step, reachable from the
  phone.
