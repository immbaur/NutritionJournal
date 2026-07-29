const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const MEALS_DIR = path.join(DATA_DIR, 'meals');
const AGENT_WORKSPACE_DIR = path.join(DATA_DIR, 'agent-workspace');
const HISTORY_CSV_PATH = path.join(DATA_DIR, 'intake-history.csv');
const AUTH_PATH = path.join(DATA_DIR, 'auth.json');
const SESSIONS_PATH = path.join(DATA_DIR, 'sessions.json');
const TEMPLATES_DIR = path.join(__dirname, 'templates');
const ANALYZE_PROMPT_PATH = path.join(TEMPLATES_DIR, 'ANALYZE_INTAKE_PROMPT.md');

const AGENT_MODEL = process.env.NJ_MODEL || 'opus';
const ANALYSIS_TIMEOUT_MS = 5 * 60 * 1000;
const SCHEMA_VERSION = 1;

// Staging directories that are never confirmed or cancelled (tab closed,
// analysis timed out) are swept once they're older than this. (FR-12d)
const STAGING_RETENTION_MS = Number(process.env.NJ_STAGING_RETENTION_MS) || 24 * 60 * 60 * 1000;
const STAGING_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

// Two saved meals within this distance are treated as "the same place", so a
// place name typed once ("home", "office") is reused for later entries. (FR-14a)
const LOCATION_MATCH_METERS = Number(process.env.NJ_LOCATION_MATCH_METERS) || 75;

// Confidence at/above this reads as "confident"; below it the review UI nudges
// the user to add detail and re-run. (FR-9b) Stored value is always the raw number.
const CONFIDENCE_THRESHOLD = Number(process.env.NJ_CONFIDENCE_THRESHOLD) || 0.7;

const SESSION_COOKIE = 'nutrition_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 20;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 20;

// Meal-type windows, keyed by local hour [start, end). Anything not covered is
// a snack. (FR-13) Order matters: first matching window wins.
const MEAL_TYPE_WINDOWS = [
  { type: 'breakfast', start: 4, end: 11 },
  { type: 'lunch', start: 11, end: 15 },
  { type: 'dinner', start: 17, end: 22 }
];
const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack'];

// The five nutrients tracked in v1 (FR-6). fiber is optional: left null rather
// than guessed when unavailable. `value` is the point estimate (drives totals);
// `low`/`high` are an optional uncertainty range.
const NUTRIENTS = [
  { key: 'calories', unit: 'kcal', max: 20000, required: true },
  { key: 'protein_g', unit: 'g', max: 3000, required: true },
  { key: 'fat_g', unit: 'g', max: 3000, required: true },
  { key: 'carbs_g', unit: 'g', max: 3000, required: true },
  { key: 'fiber_g', unit: 'g', max: 500, required: false }
];

const LIMITS = {
  note: 4000,
  itemName: 120,
  itemAmount: 60,
  itemSource: 80,
  maxItems: 40,
  locationName: 120,
  confidenceNote: 400,
  modelUsed: 60,
  mealText: 4000
};

// Multiple photos + one audio clip per entry (FR-1). Caps keep a stray upload
// from filling the disk; personal single-user app, so they can stay generous.
const MAX_PHOTOS = 10;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const IMAGE_EXT = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
  'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic', 'image/heif': 'heif'
};
const AUDIO_EXT = {
  'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'mp4', 'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/aac': 'aac',
  'audio/x-m4a': 'm4a', 'audio/m4a': 'm4a'
};

// entry_id is sortable-by-time, e.g. 2026-07-29T12-30-05__a1b2c3, so listing
// data/meals/ is chronological. This pattern also guards path traversal.
const ENTRY_ID_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}__[0-9a-f]{6}$/;
const STAGING_ID_RE = /^\d{13}-[0-9a-f]{6}$/;
const MEDIA_NAME_RE = /^[A-Za-z0-9._-]+$/;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(MEALS_DIR)) fs.mkdirSync(MEALS_DIR, { recursive: true });
if (!fs.existsSync(AGENT_WORKSPACE_DIR)) fs.mkdirSync(AGENT_WORKSPACE_DIR, { recursive: true });

// --- JSON file helpers ----------------------------------------------------

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return null;
  }
}

// Atomic write (temp file + rename). Because each meal is its own folder, a
// bad or interrupted write can only ever affect that one entry. (FR-12)
function writeJson(filePath, data) {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, filePath);
}

// --- Text cleaning --------------------------------------------------------

// Strips control characters (keeps \n and \t) and caps length. Non-strings
// become '', so client/agent payload fields can be passed in directly.
function cleanText(value, maxLen) {
  if (typeof value !== "string") return "";
  // Strip control characters (keeps \n and \t), then cap length.
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0);
    const isControl = (code <= 0x08) || (code >= 0x0B && code <= 0x1F) || code === 0x7F;
    if (!isControl) out += ch;
  }
  return out.slice(0, maxLen);
}

function cleanLine(value, maxLen) {
  return cleanText(value, maxLen).replace(/\n/g, ' ');
}

// --- Time / meal type -----------------------------------------------------

// Local date/time parts, including the numeric UTC offset, so timestamps are
// unambiguous and entry ids sort chronologically in local time.
function localParts(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const y = d.getFullYear();
  const mo = pad(d.getMonth() + 1);
  const da = pad(d.getDate());
  const h = pad(d.getHours());
  const mi = pad(d.getMinutes());
  const s = pad(d.getSeconds());
  const offMin = -d.getTimezoneOffset();
  const sign = offMin >= 0 ? '+' : '-';
  const offAbs = Math.abs(offMin);
  const off = `${sign}${pad(Math.floor(offAbs / 60))}:${pad(offAbs % 60)}`;
  return {
    date: `${y}-${mo}-${da}`,
    timestamp: `${y}-${mo}-${da}T${h}:${mi}:${s}${off}`,
    idStamp: `${y}-${mo}-${da}T${h}-${mi}-${s}`
  };
}

function classifyMealType(d = new Date()) {
  const hour = d.getHours();
  for (const w of MEAL_TYPE_WINDOWS) {
    if (hour >= w.start && hour < w.end) return w.type;
  }
  return 'snack';
}

function makeEntryId(d = new Date()) {
  return `${localParts(d).idStamp}__${crypto.randomBytes(3).toString('hex')}`;
}

// --- Location -------------------------------------------------------------

function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.long - a.long);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function isFiniteCoord(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

// Scans already-saved meals for a named entry at (approximately) the same
// lat/long and returns its name, so "home"/"office"/etc. stay consistent
// across entries. (FR-14a step 1) Nearest match within tolerance wins.
function findNearbyLocationName(lat, long, meals) {
  if (!isFiniteCoord(lat) || !isFiniteCoord(long)) return '';
  let best = null;
  for (const meal of meals) {
    const loc = meal && meal.location;
    if (!loc || !loc.name || !isFiniteCoord(loc.lat) || !isFiniteCoord(loc.long)) continue;
    const dist = haversineMeters({ lat, long }, { lat: loc.lat, long: loc.long });
    if (dist <= LOCATION_MATCH_METERS && (!best || dist < best.dist)) {
      best = { dist, name: loc.name };
    }
  }
  return best ? best.name : '';
}

// --- Meal schema validation -----------------------------------------------
// Cleans a nutrient object { value, low, high } into a whitelisted copy with a
// fixed unit. Coerces strings to numbers, clamps to a sane max, and orders
// low<=high. Returns { nutrient } or { error }. Required nutrients must carry a
// finite value; optional ones (fiber) may be null.

function cleanNutrient(input, cfg) {
  const obj = input && typeof input === 'object' ? input : {};
  const label = cfg.key;

  let value;
  if (obj.value == null || obj.value === '') {
    if (cfg.required) return { error: `${label}: a value is required.` };
    value = null;
  } else {
    const n = Number(obj.value);
    if (!Number.isFinite(n) || n < 0) return { error: `${label}: value must be a non-negative number.` };
    value = Math.round(Math.min(n, cfg.max) * 100) / 100;
  }

  const cleanBound = (raw) => {
    if (raw == null || raw === '') return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.round(Math.min(n, cfg.max) * 100) / 100;
  };
  let low = cleanBound(obj.low);
  let high = cleanBound(obj.high);
  if (low != null && high != null && low > high) {
    [low, high] = [high, low];
  }

  return { nutrient: { value, low, high, unit: cfg.unit } };
}

function cleanItems(input) {
  if (!Array.isArray(input)) return [];
  const items = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const name = cleanLine(raw.name, LIMITS.itemName).trim();
    if (!name) continue;
    items.push({
      name,
      amount: cleanLine(raw.amount, LIMITS.itemAmount).trim(),
      source: cleanLine(raw.source, LIMITS.itemSource).trim()
    });
    if (items.length >= LIMITS.maxItems) break;
  }
  return items;
}

function cleanLocation(input) {
  const loc = input && typeof input === 'object' ? input : {};
  const lat = Number(loc.lat);
  const long = Number(loc.long);
  return {
    lat: isFiniteCoord(lat) ? Math.round(lat * 1e6) / 1e6 : null,
    long: isFiniteCoord(long) ? Math.round(long * 1e6) / 1e6 : null,
    name: cleanLine(loc.name, LIMITS.locationName).trim()
  };
}

function cleanConfidence(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.min(1, Math.max(0, n)) * 100) / 100;
}

// Validates the editable content of a meal (from the agent's proposal or a
// client confirm/edit) and returns a clean copy with only whitelisted fields,
// so forged fields (entry_id, timestamps, media_refs, …) can never be injected
// through the payload — the server owns those. Returns { content } or { error }.
function validateAndCleanMeal(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'Meal must be an object.' };
  }

  const nutritionInput = input.nutrition && typeof input.nutrition === 'object' ? input.nutrition : {};
  const nutrition = {};
  for (const cfg of NUTRIENTS) {
    const { nutrient, error } = cleanNutrient(nutritionInput[cfg.key], cfg);
    if (error) return { error };
    nutrition[cfg.key] = nutrient;
  }

  let mealType = typeof input.meal_type === 'string' ? input.meal_type.trim().toLowerCase() : '';
  if (!MEAL_TYPES.includes(mealType)) mealType = classifyMealType();

  return {
    content: {
      meal_type: mealType,
      nutrition,
      items: cleanItems(input.items),
      note: cleanText(input.note, LIMITS.note),
      location: cleanLocation(input.location),
      confidence: cleanConfidence(input.confidence),
      confidence_note: cleanLine(input.confidence_note, LIMITS.confidenceNote),
      model_used: cleanLine(input.model_used, LIMITS.modelUsed) || AGENT_MODEL
    }
  };
}

// --- Aggregation ----------------------------------------------------------

function emptyTotals() {
  const totals = {};
  for (const cfg of NUTRIENTS) totals[cfg.key] = 0;
  return totals;
}

function addToTotals(totals, meal) {
  const nutrition = meal && meal.nutrition;
  if (!nutrition) return;
  for (const cfg of NUTRIENTS) {
    const v = nutrition[cfg.key] && nutrition[cfg.key].value;
    if (typeof v === 'number' && Number.isFinite(v)) totals[cfg.key] += v;
  }
}

function roundTotals(totals) {
  const out = {};
  for (const cfg of NUTRIENTS) out[cfg.key] = Math.round(totals[cfg.key] * 10) / 10;
  return out;
}

// Reads every meal.json under data/meals/, newest first. Aggregation is always
// computed on the fly from these files — there is no stored aggregate. (FR-16)
function listMeals() {
  let ids;
  try {
    ids = fs.readdirSync(MEALS_DIR);
  } catch (err) {
    return [];
  }
  const meals = [];
  for (const id of ids) {
    if (!ENTRY_ID_RE.test(id)) continue;
    const meal = readJson(path.join(MEALS_DIR, id, 'meal.json'));
    if (meal && meal.entry_id) meals.push(meal);
  }
  meals.sort((a, b) => (a.entry_id < b.entry_id ? 1 : -1));
  return meals;
}

function summariseMeal(meal) {
  return {
    entry_id: meal.entry_id,
    timestamp: meal.timestamp,
    date: meal.date,
    meal_type: meal.meal_type,
    nutrition: meal.nutrition,
    items: meal.items || [],
    note: meal.note || '',
    location: meal.location || { lat: null, long: null, name: '' },
    media_refs: meal.media_refs || [],
    confidence: meal.confidence != null ? meal.confidence : null,
    confidence_note: meal.confidence_note || '',
    model_used: meal.model_used || ''
  };
}

function dayView(date, meals) {
  const dayMeals = meals
    .filter((m) => m.date === date)
    .sort((a, b) => (a.entry_id < b.entry_id ? 1 : -1));
  const totals = emptyTotals();
  dayMeals.forEach((m) => addToTotals(totals, m));
  return {
    date,
    totals: roundTotals(totals),
    meals: dayMeals.map(summariseMeal)
  };
}

// --- CSV export -----------------------------------------------------------

function csvEscape(value) {
  const str = value === null || value === undefined ? '' : String(value);
  if (/[",\n]/.test(str)) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function csvColumns() {
  const cols = ['entry_id', 'timestamp', 'date', 'meal_type'];
  for (const cfg of NUTRIENTS) {
    cols.push(cfg.key, `${cfg.key}_low`, `${cfg.key}_high`);
  }
  cols.push('items', 'note', 'lat', 'long', 'location_name', 'media_refs',
    'confidence', 'confidence_note', 'model_used');
  return cols;
}

function mealToCsvRow(meal) {
  const row = {
    entry_id: meal.entry_id,
    timestamp: meal.timestamp,
    date: meal.date,
    meal_type: meal.meal_type
  };
  for (const cfg of NUTRIENTS) {
    const n = (meal.nutrition && meal.nutrition[cfg.key]) || {};
    row[cfg.key] = n.value != null ? n.value : '';
    row[`${cfg.key}_low`] = n.low != null ? n.low : '';
    row[`${cfg.key}_high`] = n.high != null ? n.high : '';
  }
  row.items = (meal.items || [])
    .map((it) => (it.amount ? `${it.name} (${it.amount})` : it.name))
    .join('; ');
  row.note = meal.note || '';
  const loc = meal.location || {};
  row.lat = loc.lat != null ? loc.lat : '';
  row.long = loc.long != null ? loc.long : '';
  row.location_name = loc.name || '';
  row.media_refs = (meal.media_refs || []).join('; ');
  row.confidence = meal.confidence != null ? meal.confidence : '';
  row.confidence_note = meal.confidence_note || '';
  row.model_used = meal.model_used || '';
  return row;
}

// Regenerates the whole CSV from the meal folders — a derived artifact, never a
// stored source of truth (FR-12a, §6.3). Safe to call anytime.
function buildHistoryCsv(meals) {
  const cols = csvColumns();
  const header = cols.join(',') + '\n';
  const ordered = meals.slice().sort((a, b) => (a.entry_id < b.entry_id ? -1 : 1));
  const body = ordered.map((meal) => {
    const row = mealToCsvRow(meal);
    return cols.map((c) => csvEscape(row[c])).join(',');
  }).join('\n');
  return header + body + (body ? '\n' : '');
}

// --- Auth -----------------------------------------------------------------
// All /api routes (except login/status/health) require a session cookie
// obtained by posting the password to /api/login. The password comes from
// NUTRITION_PASSWORD, or is generated once and printed at startup.

let auth = null;

function scryptHash(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function verifyPassword(password, authRecord) {
  const record = authRecord || auth;
  if (!record || typeof password !== 'string') return false;
  const expected = Buffer.from(record.passwordHash, 'hex');
  const actual = crypto.scryptSync(password, record.salt, expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function initAuth() {
  const stored = readJson(AUTH_PATH);
  const envPassword = process.env.NUTRITION_PASSWORD;
  if (envPassword) {
    if (stored && verifyPassword(envPassword, stored)) {
      auth = stored;
      return;
    }
    const salt = crypto.randomBytes(16).toString('hex');
    auth = { salt, passwordHash: scryptHash(envPassword, salt) };
    writeJson(AUTH_PATH, auth);
    writeJson(SESSIONS_PATH, []); // password changed -> everyone logged out
    return;
  }
  if (stored) {
    auth = stored;
    return;
  }
  const generated = crypto.randomBytes(9).toString('base64url');
  const salt = crypto.randomBytes(16).toString('hex');
  auth = { salt, passwordHash: scryptHash(generated, salt) };
  writeJson(AUTH_PATH, auth);
  console.log('');
  console.log(`  Nutrition Journal password (generated): ${generated}`);
  console.log('  Use it on the login page. Set NUTRITION_PASSWORD to choose your');
  console.log('  own, or delete data/auth.json to generate a new one.');
  console.log('');
}

function loadSessions() {
  const sessions = readJson(SESSIONS_PATH);
  if (!Array.isArray(sessions)) return [];
  const cutoff = Date.now() - SESSION_TTL_MS;
  return sessions.filter((s) => s && typeof s.token === 'string' && s.createdAt >= cutoff);
}

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  const sessions = loadSessions();
  sessions.push({ token, createdAt: Date.now() });
  writeJson(SESSIONS_PATH, sessions.slice(-MAX_SESSIONS));
  return token;
}

function isValidSession(token) {
  if (typeof token !== 'string' || !token) return false;
  const candidate = Buffer.from(token);
  return loadSessions().some((s) => {
    const stored = Buffer.from(s.token);
    return stored.length === candidate.length && crypto.timingSafeEqual(stored, candidate);
  });
}

function getSessionToken(req) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

// Brute-force throttle for /api/login. Behind the Cloudflare quick tunnel
// every request shares one upstream IP, so this is effectively a global
// cap — acceptable for a single-user app.
const loginAttempts = new Map();

function loginRateLimited(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now - entry.windowStart > LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { count: 1, windowStart: now });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_LOGIN_ATTEMPTS;
}

// --- Staging workspace ----------------------------------------------------
// Each intake is uploaded to an isolated per-entry directory under
// data/agent-workspace/ (FR-3). The agent reads the media/text from there and
// writes its proposed estimate to result.json in the same dir — it never
// touches data/meals/. status.json is the server's authoritative record of the
// run for the client to poll.

const runningAnalyses = new Map(); // stagingId -> child process

function stagingDir(stagingId) {
  return path.join(AGENT_WORKSPACE_DIR, stagingId);
}

function isValidStagingId(id) {
  return typeof id === 'string' && STAGING_ID_RE.test(id);
}

function readStagingStatus(stagingId) {
  return readJson(path.join(stagingDir(stagingId), 'status.json'));
}

function writeStagingStatus(stagingId, status) {
  const dir = stagingDir(stagingId);
  if (!fs.existsSync(dir)) return;
  writeJson(path.join(dir, 'status.json'), status);
}

function removeStaging(stagingId) {
  const child = runningAnalyses.get(stagingId);
  if (child) {
    child.kill('SIGTERM');
    runningAnalyses.delete(stagingId);
  }
  fs.rmSync(stagingDir(stagingId), { recursive: true, force: true });
}

// Removes staging dirs older than the retention window. Only ever touches
// data/agent-workspace/ — never data/meals/. (FR-12d, FR-12e)
function sweepStaging() {
  let entries;
  try {
    entries = fs.readdirSync(AGENT_WORKSPACE_DIR);
  } catch (err) {
    return 0;
  }
  const cutoff = Date.now() - STAGING_RETENTION_MS;
  let removed = 0;
  for (const id of entries) {
    if (runningAnalyses.has(id)) continue; // never sweep an in-flight run
    const dir = path.join(AGENT_WORKSPACE_DIR, id);
    let createdAt = null;
    const status = readJson(path.join(dir, 'status.json'));
    if (status && Number.isFinite(status.createdAt)) createdAt = status.createdAt;
    if (createdAt == null) {
      try { createdAt = fs.statSync(dir).mtimeMs; } catch (err) { continue; }
    }
    if (createdAt < cutoff) {
      fs.rmSync(dir, { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
}

// --- Agent analysis -------------------------------------------------------
// Runs templates/ANALYZE_INTAKE_PROMPT.md through the Claude Code CLI
// (non-interactive, Read/Write only, cwd = the staging dir) so it can read the
// uploaded photos/audio/note and write result.json — its proposed estimate.
// The server validates that JSON; nothing is written to data/meals/ until the
// user confirms.

function getAnalyzePromptText(meta) {
  const raw = fs.readFileSync(ANALYZE_PROMPT_PATH, 'utf8');
  const marker = '\n---\n';
  const idx = raw.indexOf(marker);
  const template = idx === -1 ? raw : raw.slice(idx + marker.length).trim();
  const photoList = meta.photos.length
    ? meta.photos.map((p) => `- ${p}`).join('\n')
    : '- (none)';
  const audioLine = meta.audio ? meta.audio : '(none)';
  const noteLine = meta.hasNote ? 'note.txt' : '(none)';
  return template
    .replace('{{PHOTO_LIST}}', photoList)
    .replace('{{AUDIO_FILE}}', audioLine)
    .replace('{{NOTE_FILE}}', noteLine);
}

function startAnalysis(stagingId) {
  const dir = stagingDir(stagingId);
  const meta = readJson(path.join(dir, 'meta.json'));
  if (!meta) return;

  writeStagingStatus(stagingId, {
    status: 'analyzing',
    createdAt: (readStagingStatus(stagingId) || {}).createdAt || Date.now(),
    startedAt: Date.now()
  });

  const existing = runningAnalyses.get(stagingId);
  if (existing) existing.kill('SIGTERM');

  const promptText = getAnalyzePromptText(meta);
  let child;
  try {
    child = spawn('claude', ['-p', promptText, '--allowedTools', 'Read,Write', '--model', AGENT_MODEL], {
      cwd: dir
    });
  } catch (err) {
    writeStagingStatus(stagingId, {
      status: 'error',
      createdAt: (readStagingStatus(stagingId) || {}).createdAt || Date.now(),
      message: `Could not start the agent: ${err.message}`
    });
    return;
  }
  runningAnalyses.set(stagingId, child);

  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  const timer = setTimeout(() => child.kill('SIGTERM'), ANALYSIS_TIMEOUT_MS);

  const finish = (status) => {
    const base = readStagingStatus(stagingId) || {};
    writeStagingStatus(stagingId, { ...status, createdAt: base.createdAt || Date.now() });
  };

  child.on('close', (code) => {
    clearTimeout(timer);
    // A superseded (re-run) or removed staging must not publish a result.
    if (runningAnalyses.get(stagingId) !== child) return;
    runningAnalyses.delete(stagingId);
    if (!fs.existsSync(dir)) return;

    const output = readJson(path.join(dir, 'result.json'));
    if (!output) {
      finish({
        status: 'error',
        message: code === 0
          ? 'The agent finished but did not produce a result file.'
          : `Analysis failed (exit code ${code}). ${stderr.slice(-500)}`
      });
      return;
    }
    const { content, error } = validateAndCleanMeal(output);
    if (error) {
      finish({ status: 'error', message: `The agent produced an invalid estimate: ${error}` });
      return;
    }
    // Meal type is decided server-side from the entry time (reliable), not by
    // the agent; the user can still override it in review. (FR-13)
    content.meal_type = classifyMealType();
    content.model_used = content.model_used || AGENT_MODEL;
    finish({ status: 'ready', result: content, analyzedAt: Date.now() });
  });

  child.on('error', (err) => {
    clearTimeout(timer);
    if (runningAnalyses.get(stagingId) !== child) return;
    runningAnalyses.delete(stagingId);
    finish({ status: 'error', message: `Could not start the agent: ${err.message}` });
  });
}

// --- Media handling -------------------------------------------------------

function pickExt(file, table, fallback) {
  const byMime = table[file.mimetype];
  if (byMime) return byMime;
  const ext = path.extname(file.originalname || '').replace('.', '').toLowerCase();
  return ext && MEDIA_NAME_RE.test(ext) ? ext : fallback;
}

// Writes uploaded photos/audio/text into the staging dir with canonical names
// (photo-1.jpg, audio.webm, note.txt) and records them in meta.json. Returns
// the meta describing what was stored.
function persistUploads(dir, files, text) {
  const photos = [];
  (files.photos || []).slice(0, MAX_PHOTOS).forEach((file, i) => {
    const name = `photo-${i + 1}.${pickExt(file, IMAGE_EXT, 'jpg')}`;
    fs.writeFileSync(path.join(dir, name), file.buffer);
    photos.push(name);
  });

  let audio = null;
  if (files.audio && files.audio[0]) {
    const name = `audio.${pickExt(files.audio[0], AUDIO_EXT, 'webm')}`;
    fs.writeFileSync(path.join(dir, name), files.audio[0].buffer);
    audio = name;
  }

  const note = cleanText(text, LIMITS.mealText);
  const hasNote = note.trim().length > 0;
  if (hasNote) fs.writeFileSync(path.join(dir, 'note.txt'), note);

  const meta = { photos, audio, hasNote, note, createdAt: Date.now() };
  writeJson(path.join(dir, 'meta.json'), meta);
  return meta;
}

function moveInto(srcDir, destDir, name) {
  const src = path.join(srcDir, name);
  const dest = path.join(destDir, name);
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if (err.code === 'EXDEV') {
      fs.copyFileSync(src, dest);
      fs.unlinkSync(src);
    } else {
      throw err;
    }
  }
}

// --- App ------------------------------------------------------------------

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: MAX_PHOTOS + 1 }
});
const intakeUpload = upload.fields([
  { name: 'photos', maxCount: MAX_PHOTOS },
  { name: 'audio', maxCount: 1 }
]);

// Unauthenticated: readiness probe for start.sh.
app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

// Unauthenticated: lets the client decide whether to show the login page.
app.get('/api/auth/status', (req, res) => {
  res.json({ authenticated: isValidSession(getSessionToken(req)) });
});

app.post('/api/login', (req, res) => {
  if (loginRateLimited(req.ip)) {
    return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  }
  const password = (req.body || {}).password;
  if (!verifyPassword(password)) {
    return res.status(401).json({ error: 'Wrong password.' });
  }
  const token = createSession();
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  const token = getSessionToken(req);
  if (token) {
    writeJson(SESSIONS_PATH, loadSessions().filter((s) => s.token !== token));
  }
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

// Every other /api route requires a valid session.
app.use('/api', (req, res, next) => {
  if (!isValidSession(getSessionToken(req))) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }
  next();
});

// --- Intake / analysis routes ---------------------------------------------

// Start a new intake: upload any mix of photos/audio/text into an isolated
// staging dir and kick off the background agent. (FR-1, FR-2, FR-3, FR-4)
app.post('/api/intake', intakeUpload, (req, res) => {
  const files = req.files || {};
  const text = (req.body || {}).text || '';
  const hasPhotos = (files.photos || []).length > 0;
  const hasAudio = (files.audio || []).length > 0;
  const hasText = typeof text === 'string' && text.trim().length > 0;
  if (!hasPhotos && !hasAudio && !hasText) {
    return res.status(400).json({ error: 'Add at least a photo, an audio note, or some text.' });
  }

  const stagingId = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const dir = stagingDir(stagingId);
  fs.mkdirSync(dir, { recursive: true });
  writeStagingStatus(stagingId, { status: 'analyzing', createdAt: Date.now() });

  try {
    persistUploads(dir, files, text);
  } catch (err) {
    removeStaging(stagingId);
    return res.status(500).json({ error: `Could not save the upload: ${err.message}` });
  }

  startAnalysis(stagingId);
  res.json({ staging_id: stagingId, status: 'analyzing' });
});

// Poll the analysis status/result for a staging entry. (FR-7)
app.get('/api/intake/:id', (req, res) => {
  const stagingId = req.params.id;
  if (!isValidStagingId(stagingId)) return res.status(400).json({ error: 'Invalid id.' });
  const status = readStagingStatus(stagingId);
  if (!status) return res.status(404).json({ error: 'This intake is no longer available.' });
  const meta = readJson(path.join(stagingDir(stagingId), 'meta.json')) || {};
  res.json({
    staging_id: stagingId,
    status: status.status,
    message: status.message || '',
    result: status.result || null,
    media: { photos: meta.photos || [], audio: meta.audio || null, hasNote: !!meta.hasNote },
    note: meta.note || '',
    confidence_threshold: CONFIDENCE_THRESHOLD
  });
});

// Serve a staged upload so the review screen can preview photos before saving.
app.get('/api/intake/:id/media/:name', (req, res) => {
  const stagingId = req.params.id;
  const name = req.params.name;
  if (!isValidStagingId(stagingId) || !MEDIA_NAME_RE.test(name)) {
    return res.status(400).json({ error: 'Invalid request.' });
  }
  const filePath = path.join(stagingDir(stagingId), name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found.' });
  res.sendFile(filePath);
});

// Re-run analysis, optionally with enriched inputs (more photos, more text) —
// the iterative refine loop for low-confidence estimates. (FR-9, FR-9b)
app.post('/api/intake/:id/rerun', intakeUpload, (req, res) => {
  const stagingId = req.params.id;
  if (!isValidStagingId(stagingId)) return res.status(400).json({ error: 'Invalid id.' });
  const dir = stagingDir(stagingId);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'This intake is no longer available.' });

  const files = req.files || {};
  const meta = readJson(path.join(dir, 'meta.json')) || { photos: [], audio: null, hasNote: false, note: '' };

  // Append any newly supplied photos, keeping canonical numbering.
  (files.photos || []).forEach((file) => {
    if (meta.photos.length >= MAX_PHOTOS) return;
    const name = `photo-${meta.photos.length + 1}.${pickExt(file, IMAGE_EXT, 'jpg')}`;
    fs.writeFileSync(path.join(dir, name), file.buffer);
    meta.photos.push(name);
  });
  if (files.audio && files.audio[0]) {
    const name = `audio.${pickExt(files.audio[0], AUDIO_EXT, 'webm')}`;
    fs.writeFileSync(path.join(dir, name), files.audio[0].buffer);
    meta.audio = name;
  }
  if (req.body && typeof req.body.text === 'string' && req.body.text.trim().length > 0) {
    meta.note = cleanText(req.body.text, LIMITS.mealText);
    meta.hasNote = meta.note.trim().length > 0;
    fs.writeFileSync(path.join(dir, 'note.txt'), meta.note);
  }
  writeJson(path.join(dir, 'meta.json'), meta);

  try { fs.unlinkSync(path.join(dir, 'result.json')); } catch (err) { /* none yet */ }
  startAnalysis(stagingId);
  res.json({ staging_id: stagingId, status: 'analyzing' });
});

// Confirm the (possibly edited) estimate: write this meal's own folder under
// data/meals/, promote the raw inputs into it, and remove the staging dir.
// (FR-10, FR-11, FR-12, FR-12b)
app.post('/api/intake/:id/confirm', (req, res) => {
  const stagingId = req.params.id;
  if (!isValidStagingId(stagingId)) return res.status(400).json({ error: 'Invalid id.' });
  const dir = stagingDir(stagingId);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'This intake is no longer available.' });

  const { content, error } = validateAndCleanMeal(req.body);
  if (error) return res.status(400).json({ error });

  // Resolve the place name: user-stated wins; else reuse a nearby saved name;
  // else leave blank. Raw lat/long are always kept when present. (FR-14, FR-14a)
  const meals = listMeals();
  if (!content.location.name && content.location.lat != null && content.location.long != null) {
    content.location.name = findNearbyLocationName(content.location.lat, content.location.long, meals);
  }

  const now = new Date();
  const parts = localParts(now);
  const entryId = makeEntryId(now);
  const mealDir = path.join(MEALS_DIR, entryId);
  fs.mkdirSync(mealDir, { recursive: true });

  const meta = readJson(path.join(dir, 'meta.json')) || { photos: [], audio: null, hasNote: false };
  const mediaRefs = [];
  try {
    (meta.photos || []).forEach((name) => {
      if (fs.existsSync(path.join(dir, name))) { moveInto(dir, mealDir, name); mediaRefs.push(name); }
    });
    if (meta.audio && fs.existsSync(path.join(dir, meta.audio))) {
      moveInto(dir, mealDir, meta.audio);
      mediaRefs.push(meta.audio);
    }
    // note.txt is rewritten from the confirmed note so the folder is a complete,
    // consistent record even if the user edited the text in review. (§6.2)
    if (content.note.trim().length > 0) {
      fs.writeFileSync(path.join(mealDir, 'note.txt'), content.note);
      mediaRefs.push('note.txt');
    }
  } catch (err) {
    fs.rmSync(mealDir, { recursive: true, force: true });
    return res.status(500).json({ error: `Could not save the meal files: ${err.message}` });
  }

  const meal = {
    entry_id: entryId,
    timestamp: parts.timestamp,
    date: parts.date,
    meal_type: content.meal_type,
    nutrition: content.nutrition,
    items: content.items,
    note: content.note,
    location: content.location,
    media_refs: mediaRefs,
    confidence: content.confidence,
    confidence_note: content.confidence_note,
    model_used: content.model_used,
    schema_version: SCHEMA_VERSION,
    created_at: parts.timestamp,
    updated_at: parts.timestamp
  };
  writeJson(path.join(mealDir, 'meal.json'), meal);

  removeStaging(stagingId);
  res.json({ entry_id: entryId, date: meal.date });
});

// Cancel/discard an intake: delete its staging dir immediately. (FR-12c)
app.delete('/api/intake/:id', (req, res) => {
  const stagingId = req.params.id;
  if (!isValidStagingId(stagingId)) return res.status(400).json({ error: 'Invalid id.' });
  removeStaging(stagingId);
  res.json({ ok: true });
});

// --- Dashboard / history / meal routes ------------------------------------

// A single day's totals + meals. Defaults to today. (FR-15, FR-15a)
app.get('/api/day/:date', (req, res) => {
  const date = req.params.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date.' });
  res.json(dayView(date, listMeals()));
});

// Multi-day overview: one row per recent calendar day, totals + meal count,
// including empty days. (FR-15b) `days` (default 30) sets the window length,
// `end` (YYYY-MM-DD, default today) its most recent day.
app.get('/api/history', (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 366);
  const endStr = /^\d{4}-\d{2}-\d{2}$/.test(req.query.end || '') ? req.query.end : localParts().date;
  const meals = listMeals();

  const byDate = new Map();
  meals.forEach((m) => {
    if (!byDate.has(m.date)) byDate.set(m.date, { totals: emptyTotals(), count: 0 });
    const bucket = byDate.get(m.date);
    addToTotals(bucket.totals, m);
    bucket.count += 1;
  });

  const [ey, em, ed] = endStr.split('-').map(Number);
  const cursor = new Date(ey, em - 1, ed);
  const rows = [];
  for (let i = 0; i < days; i++) {
    const dateStr = localParts(cursor).date;
    const bucket = byDate.get(dateStr);
    rows.push({
      date: dateStr,
      totals: roundTotals(bucket ? bucket.totals : emptyTotals()),
      meal_count: bucket ? bucket.count : 0
    });
    cursor.setDate(cursor.getDate() - 1);
  }
  res.json({ days: rows });
});

// A single saved meal's full record. (FR-16c)
app.get('/api/meals/:id', (req, res) => {
  const id = req.params.id;
  if (!ENTRY_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid id.' });
  const meal = readJson(path.join(MEALS_DIR, id, 'meal.json'));
  if (!meal) return res.status(404).json({ error: 'Meal not found.' });
  res.json(meal);
});

// Post-save edit: rewrite only this entry's meal.json atomically. No other
// entry is affected; totals recompute on the fly. (FR-16a)
app.put('/api/meals/:id', (req, res) => {
  const id = req.params.id;
  if (!ENTRY_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid id.' });
  const mealDir = path.join(MEALS_DIR, id);
  const existing = readJson(path.join(mealDir, 'meal.json'));
  if (!existing) return res.status(404).json({ error: 'Meal not found.' });

  const { content, error } = validateAndCleanMeal(req.body);
  if (error) return res.status(400).json({ error });

  // Keep raw lat/long fixed; only the name is user-editable post-save.
  const location = {
    lat: existing.location ? existing.location.lat : null,
    long: existing.location ? existing.location.long : null,
    name: content.location.name
  };

  const updated = {
    ...existing,
    meal_type: content.meal_type,
    nutrition: content.nutrition,
    items: content.items,
    note: content.note,
    location,
    confidence: content.confidence,
    confidence_note: content.confidence_note,
    updated_at: localParts().timestamp
  };

  // Keep note.txt consistent with the edited note.
  try {
    const notePath = path.join(mealDir, 'note.txt');
    if (updated.note.trim().length > 0) {
      fs.writeFileSync(notePath, updated.note);
      if (!updated.media_refs.includes('note.txt')) updated.media_refs = [...updated.media_refs, 'note.txt'];
    } else if (fs.existsSync(notePath)) {
      fs.unlinkSync(notePath);
      updated.media_refs = updated.media_refs.filter((r) => r !== 'note.txt');
    }
  } catch (err) { /* note.txt is a convenience mirror; meal.json is source of truth */ }

  writeJson(path.join(mealDir, 'meal.json'), updated);
  res.json(updated);
});

// Delete a single meal folder. Only this entry is removed. (FR-16a)
app.delete('/api/meals/:id', (req, res) => {
  const id = req.params.id;
  if (!ENTRY_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid id.' });
  const mealDir = path.join(MEALS_DIR, id);
  if (!fs.existsSync(mealDir)) return res.status(404).json({ error: 'Meal not found.' });
  fs.rmSync(mealDir, { recursive: true, force: true });
  res.json({ ok: true });
});

// Serve a saved meal's raw media (photo/audio), guarded by media_refs.
app.get('/api/meals/:id/media/:name', (req, res) => {
  const id = req.params.id;
  const name = req.params.name;
  if (!ENTRY_ID_RE.test(id) || !MEDIA_NAME_RE.test(name)) {
    return res.status(400).json({ error: 'Invalid request.' });
  }
  const meal = readJson(path.join(MEALS_DIR, id, 'meal.json'));
  if (!meal || !(meal.media_refs || []).includes(name)) {
    return res.status(404).json({ error: 'Not found.' });
  }
  res.sendFile(path.join(MEALS_DIR, id, name));
});

// CSV export: regenerate from all meal folders and download. (FR-16b, §6.3)
app.get('/api/export/csv', (req, res) => {
  const csv = buildHistoryCsv(listMeals());
  try { fs.writeFileSync(HISTORY_CSV_PATH, csv); } catch (err) { /* download still works */ }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="intake-history.csv"');
  res.send(csv);
});

if (require.main === module) {
  initAuth();
  sweepStaging();
  setInterval(sweepStaging, STAGING_SWEEP_INTERVAL_MS).unref();
  // HOST=127.0.0.1 keeps the app reachable only through a local reverse proxy;
  // unset, it listens on all interfaces for local/tunnel use.
  const HOST = process.env.HOST || '0.0.0.0';
  app.listen(PORT, HOST, () => {
    console.log(`Nutrition Journal running at http://localhost:${PORT}`);
  });
}

module.exports = {
  cleanText,
  cleanLine,
  cleanNutrient,
  cleanItems,
  cleanLocation,
  cleanConfidence,
  validateAndCleanMeal,
  classifyMealType,
  makeEntryId,
  localParts,
  haversineMeters,
  findNearbyLocationName,
  emptyTotals,
  addToTotals,
  roundTotals,
  dayView,
  csvEscape,
  csvColumns,
  mealToCsvRow,
  buildHistoryCsv,
  listMeals,
  NUTRIENTS,
  MEAL_TYPES,
  MEALS_DIR,
  HISTORY_CSV_PATH
};
