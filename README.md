# Nutrition Journal

A personal web app for tracking daily nutrition intake with minimum friction.

Log a meal however is easiest in the moment — one or more **photos** (food or
nutrition labels), a short **audio** note, **text**, or any mix — and a
background AI agent analyzes everything and estimates the nutrition facts
(calories, protein, fat, carbs, fiber) as accurately as the evidence allows. It
prefers hard facts you give it (grams from a scale, values off a label) and
falls back to best-effort estimation otherwise. You review the estimate, tweak
it if needed, and confirm before anything is saved.

The app opens on a **daily dashboard** — today's running totals so far plus the
day's meals — and lets you step back through yesterday, the day before, and a
multi-day history to see how you've been eating over time.

It also keeps a **pantry** of packaged products whose nutrition labels you've
captured once. When a later meal mentions a known item ("50 ml almond milk"), its
numbers are **computed from the stored label, not re-estimated** — so the things
you buy repeatedly get measured once and reused exactly. See
[Pantry](#pantry--known-items-store).

No cloud hosting, no database, no build step — Node/Express serving static
files + a few JSON/multipart endpoints, exposed with a Cloudflare quick tunnel
so you can use it from your phone. It mirrors the [Momentum](../Momentum) app's
stack.

## Running it

```bash
PORT=3100 ./start.sh
```

This installs dependencies on first run, starts the server, waits until it
answers on the port, then prints a `https://xxxxx.trycloudflare.com` URL — that's
your public link for the session. Leave the terminal open; closing it (or
Ctrl+C) stops both the server and the tunnel. The URL changes every restart.

### Local test server (no tunnel)

To run it on your own machine without the Cloudflare tunnel — the quickest way to
try it or develop against it:

```bash
npm install                 # first time only
NUTRITION_PASSWORD=test PORT=3100 npm start
```

Then open <http://localhost:3100> and sign in with the password you set (here,
`test`). Omit `NUTRITION_PASSWORD` and the server generates one and prints it to
the terminal instead. `PORT` defaults to `3000`. The app writes everything under
`data/` (gitignored); delete that folder to reset to a clean slate.

To run the automated test suite instead of the server, see [Tests](#tests).

## Password / login

The app is public through the tunnel, so every `/api` route requires a login.
On first start the server generates a password and prints it to the terminal;
enter it on the landing page. To pick your own instead:

```bash
NUTRITION_PASSWORD=your-password PORT=3100 ./start.sh
```

- The password hash lives in `data/auth.json` (delete it to regenerate a random
  one on next start).
- Changing `NUTRITION_PASSWORD` invalidates all existing sessions.
- Sessions are 30-day cookies (`data/sessions.json`), so you won't retype the
  password every meal.

## How a meal gets logged

1. **New Intake** — add any mix of photo(s), an audio note (≤15 s), and text
   (e.g. "150 g chicken" + a photo of the rice + a photo of a sauce label).
2. **Analyze meal** uploads the inputs to an isolated staging workspace under
   `data/agent-workspace/<staging_id>/` and spawns the Claude Code CLI (Opus,
   Read/Write only, no Bash) to read them and write a proposed estimate.
3. **Review** the estimate — per-item breakdown, totals with optional low–high
   ranges, and a confidence score. Edit any value, or add a missing label /
   the exact grams and **re-analyze**. Low confidence nudges you to do so.
4. **Confirm & Save** writes this meal's own folder,
   `data/meals/<entry_id>/meal.json`, alongside the raw photos/audio/`note.txt`,
   with the timestamp, date, auto-classified meal type, and location. The
   staging workspace is then removed.
5. Back on the **Today** dashboard, the new meal appears and today's totals
   update — all computed live from the JSON files.

Meal type is inferred from the time of day (breakfast/lunch/dinner/snack) and
can be overridden. Location uses the browser's Geolocation: the raw lat/long is
always stored, and a place name is reused from a nearby saved entry ("home",
"office", …), suggested, or taken from what you said — degrading gracefully to
no location if permission is denied.

See [`templates/ANALYZE_INTAKE_PROMPT.md`](templates/ANALYZE_INTAKE_PROMPT.md)
for exactly what the agent is told. Agent runs are sandboxed: no Bash, and each
runs inside its own staging directory containing only that entry's inputs. The
server schema-validates whatever the agent wrote before showing it to you, and
validates every browser payload the same way before saving.

## Pantry — known-items store

The pantry turns "prefer explicit facts" into something that **persists across
meals**: a nutrition label photographed once counts as a hard fact forever. Open
it from the menu (**Pantry**).

**Two ways items get in:**

- **On the fly** — when a meal you log includes a photo of a nutrition label for a
  product that isn't in your pantry yet, the review step offers an editable card
  to **remember it**. It's saved only when you confirm the meal, and you're told
  what was added. The pantry fills itself as a side effect of normal logging.
- **Deliberately** — **Pantry → New Item** takes the same photos / audio / text as
  a meal. Photograph the labels of what you bought (several at once), review the
  extracted items, add aliases, and save. Products that match something you
  already have are offered as an **update** instead of a duplicate.

**Using an item:** at analysis time the server hands the agent a compact index of
your pantry (id / name / brand / aliases / basis). The agent only **identifies**
which items a meal used and reads the portion — **the server does the
arithmetic** (stored per-100 g/ml values × the amount), so known numbers never
route through the model. Each item in the review is tagged with its **origin**
(`pantry` / `label` / `you stated` / `estimate`) so you can see at a glance which
numbers are facts and which are guesses.

Only **label-grade evidence** (a readable label, or values you state) can create a
pantry item — a visual guess is never stored as a fact. Meals save the
**resolved numbers** plus the `pantry_item_id` for traceability, so editing or
deleting a pantry item later never rewrites meals you've already saved. Manage
items (search, edit any field including aliases, delete) on the Pantry screen. The
extraction agent's instructions live in
[`templates/EXTRACT_ITEM_PROMPT.md`](templates/EXTRACT_ITEM_PROMPT.md).

## Storage — one folder per meal

Each confirmed meal is its **own folder** under `data/meals/`:

```
data/meals/2026-07-29T12-30-05__a1b2c3/
  meal.json        # the structured entry — the source of truth
  note.txt         # verbatim text input (if any)
  photo-1.jpg      # uploaded photo(s)
  audio.webm       # recorded/uploaded audio (if any)
```

There is deliberately **no single shared data file to corrupt** — a bad or
interrupted write can only ever affect one meal's folder. All day totals and
history are computed on the fly from these files; there is no stored aggregate
to keep in sync. The `<entry_id>` sorts chronologically, so listing
`data/meals/` is time-ordered.

The **pantry** uses the identical pattern under `data/pantry/`, one folder per
item:

```
data/pantry/almond-milk-alpro__7f3a91/
  item.json        # the structured item — the source of truth
  label-1.jpg      # the nutrition-label photo(s) it was built from
```

The two stores are independently self-contained — there is no shared index or
shared media. A meal may retain a pantry item's id for traceability, but it also
stores the resolved nutrition values, so changing or deleting that pantry item
cannot alter meal history. The match index the agent sees is built in memory from
the item folders at analysis time, so there is nothing to keep in sync and nothing
whose corruption could take out the pantry.

## CSV export

The full history is a **derived** CSV — one row per meal, one column per
nutrient value (plus `_low`/`_high`) and the scalar fields. It's never edited in
place and its loss is harmless; regenerate it anytime:

- **Export CSV** in the app menu (downloads it), or
- `npm run export-csv` (writes `data/intake-history.csv`).

## Tests

```bash
npm test
```

Covers input/schema validation, meal-type classification, location matching,
on-the-fly aggregation, CSV generation, and the pantry (item validation, id
slugs, match lookup, and the server-side per-100 arithmetic).

## Hosting it permanently (DigitalOcean)

The tunnel is fine session-by-session, but the URL changes every restart and
your laptop has to stay awake. To run it 24/7 with a stable HTTPS URL, deploy it
to a droplet on its own `nutrition.heyimmi.com` subdomain — see
[`deploy/DIGITALOCEAN.md`](deploy/DIGITALOCEAN.md).

## Data

Everything under `data/` is generated at runtime and gitignored — it's your
personal nutrition data, not part of the app itself.
