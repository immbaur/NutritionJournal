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

To run without the tunnel (local only):

```bash
PORT=3100 npm start
```

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
on-the-fly aggregation, and CSV generation.

## Hosting it permanently (DigitalOcean)

The tunnel is fine session-by-session, but the URL changes every restart and
your laptop has to stay awake. To run it 24/7 with a stable HTTPS URL, deploy it
to a droplet on its own `nutrition.heyimmi.com` subdomain — see
[`deploy/DIGITALOCEAN.md`](deploy/DIGITALOCEAN.md).

## Data

Everything under `data/` is generated at runtime and gitignored — it's your
personal nutrition data, not part of the app itself.
