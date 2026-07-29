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

## Design highlights

- **Multi-modal input** — photos (multiple, e.g. one per ingredient label),
  audio, and text, in any combination.
- **Agent-estimated nutrition** — runs the Claude Code CLI (Opus) on your Claude
  subscription; no pay-per-token API. Each nutrient gets a point estimate plus an
  optional low–high range and a numeric confidence score.
- **Review before save** — nothing is written until you confirm; low confidence
  invites you to add more detail or photos and re-run.
- **Corruption-resistant storage** — each meal is its own JSON file, so a bad
  write can only ever affect that one entry. A human-readable CSV is exportable
  on demand.
- **No build step** — Node.js + Express serving static files, mirroring the
  [Momentum](../Momentum) app's stack.

## Status

Early stage — see [`PRD.md`](PRD.md) for the full product requirements. No
application code yet.
