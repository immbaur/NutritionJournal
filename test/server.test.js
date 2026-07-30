const test = require('node:test');
const assert = require('node:assert/strict');

const {
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
  partsAtOffset,
  parseWallClock,
  byNewestFirst,
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
  slugify,
  makeItemId,
  cleanAmountUnit,
  cleanPantryNutrient,
  cleanAliases,
  validateAndCleanPantryItem,
  isRoundingFloor,
  withStagedProvenance,
  buildPantryIndex,
  findMatchingPantryItem,
  resolvePantryContribution,
  addNutritionInto,
  NUTRIENTS
} = require('../server.js');

// --- Text cleaning --------------------------------------------------------

test('cleanText strips control chars but keeps newlines/tabs and caps length', () => {
  assert.equal(cleanText('a' + String.fromCharCode(0) + 'bc' + String.fromCharCode(13, 10) + 'd\te', 100), 'abc\nd\te');
  assert.equal(cleanText('x'.repeat(50), 10).length, 10);
  assert.equal(cleanText(1234, 10), '');
  assert.equal(cleanText(null, 10), '');
});

test('cleanLine flattens newlines to spaces', () => {
  assert.equal(cleanLine('one\ntwo', 100), 'one two');
});

// --- Nutrient cleaning ----------------------------------------------------

const CAL = NUTRIENTS.find((n) => n.key === 'calories');
const FIBER = NUTRIENTS.find((n) => n.key === 'fiber_g');

test('cleanNutrient coerces strings, clamps, orders low<=high, sets unit', () => {
  const { nutrient } = cleanNutrient({ value: '620.005', low: 700, high: 560 }, CAL);
  assert.equal(nutrient.value, 620.01);
  assert.equal(nutrient.low, 560);
  assert.equal(nutrient.high, 700);
  assert.equal(nutrient.unit, 'kcal');
});

test('cleanNutrient errors on missing/invalid required value', () => {
  assert.ok(cleanNutrient({ value: '' }, CAL).error);
  assert.ok(cleanNutrient({ value: 'abc' }, CAL).error);
  assert.ok(cleanNutrient({ value: -5 }, CAL).error);
});

test('cleanNutrient allows null value for optional fiber', () => {
  const { nutrient, error } = cleanNutrient({ value: null }, FIBER);
  assert.equal(error, undefined);
  assert.equal(nutrient.value, null);
  assert.equal(nutrient.unit, 'g');
});

test('cleanNutrient clamps absurd values to the max', () => {
  const { nutrient } = cleanNutrient({ value: 999999 }, CAL);
  assert.equal(nutrient.value, CAL.max);
});

// --- Items / location / confidence ---------------------------------------

test('cleanItems keeps named items, drops blanks, caps count', () => {
  const items = cleanItems([
    { name: 'rice', amount: '200 g', source: 'photo estimate' },
    { name: '   ' },
    { amount: 'nameless' },
    'not an object'
  ]);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0], {
    name: 'rice', amount: '200 g', source: 'photo estimate',
    origin: 'estimate', pantry_item_id: null, pantry_name: ''
  });
});

test('cleanItems keeps a valid pantry reference and drops a forged one', () => {
  const items = cleanItems([
    { name: 'almond milk', amount: '50 ml', origin: 'pantry', pantry_item_id: 'almond-milk__7f3a91', matched_name: 'Almond milk — Alpro' },
    { name: 'mystery', origin: 'pantry', pantry_item_id: 'not a real id' }
  ]);
  assert.equal(items[0].origin, 'pantry');
  assert.equal(items[0].pantry_item_id, 'almond-milk__7f3a91');
  assert.equal(items[0].pantry_name, 'Almond milk — Alpro');
  // pantry origin without a well-formed id falls back to estimate
  assert.equal(items[1].origin, 'estimate');
  assert.equal(items[1].pantry_item_id, null);
});

test('cleanLocation rounds coords and keeps null when absent', () => {
  assert.deepEqual(cleanLocation({ lat: 48.13712345, long: 11.5754, name: 'home' }),
    { lat: 48.137123, long: 11.5754, name: 'home' });
  assert.deepEqual(cleanLocation({}), { lat: null, long: null, name: '' });
  assert.deepEqual(cleanLocation({ lat: 'x', long: 'y' }), { lat: null, long: null, name: '' });
});

test('cleanConfidence clamps to 0..1 or null', () => {
  assert.equal(cleanConfidence(0.82), 0.82);
  assert.equal(cleanConfidence(1.7), 1);
  assert.equal(cleanConfidence(-3), 0);
  assert.equal(cleanConfidence(''), null);
  assert.equal(cleanConfidence('abc'), null);
});

// --- Full meal validation -------------------------------------------------

function sampleMealInput() {
  return {
    meal_type: 'lunch',
    nutrition: {
      calories: { value: 620, low: 560, high: 700 },
      protein_g: { value: 38 },
      fat_g: { value: 22, low: 18, high: 27 },
      carbs_g: { value: 61 },
      fiber_g: { value: 7 }
    },
    items: [{ name: 'chicken', amount: '150 g', source: 'user-stated grams' }],
    note: '150g chicken and rice',
    location: { lat: 48.1371, long: 11.5754, name: '' },
    confidence: 0.82,
    confidence_note: 'grams given for chicken',
    model_used: 'opus'
  };
}

test('validateAndCleanMeal accepts a well-formed meal', () => {
  const { content, error } = validateAndCleanMeal(sampleMealInput());
  assert.equal(error, undefined);
  assert.equal(content.meal_type, 'lunch');
  assert.equal(content.nutrition.calories.value, 620);
  assert.equal(content.nutrition.calories.unit, 'kcal');
  assert.equal(content.items.length, 1);
  assert.equal(content.confidence, 0.82);
});

test('validateAndCleanMeal drops forged/unknown fields', () => {
  const input = { ...sampleMealInput(), entry_id: 'x', created_at: 'y', schema_version: 99, junk: 1 };
  const { content } = validateAndCleanMeal(input);
  assert.equal(content.entry_id, undefined);
  assert.equal(content.created_at, undefined);
  assert.equal(content.schema_version, undefined);
  assert.equal(content.junk, undefined);
});

test('validateAndCleanMeal rejects non-objects and missing calories', () => {
  assert.ok(validateAndCleanMeal(null).error);
  assert.ok(validateAndCleanMeal([]).error);
  const noCal = sampleMealInput();
  delete noCal.nutrition.calories;
  assert.ok(validateAndCleanMeal(noCal).error);
});

test('validateAndCleanMeal falls back to a time-based meal type when invalid', () => {
  const input = sampleMealInput();
  input.meal_type = 'brunch';
  const { content } = validateAndCleanMeal(input);
  assert.ok(['breakfast', 'lunch', 'dinner', 'snack'].includes(content.meal_type));
});

// --- Meal type / ids / time ----------------------------------------------

test('classifyMealType maps hours to windows', () => {
  assert.equal(classifyMealType(8), 'breakfast');
  assert.equal(classifyMealType(12), 'lunch');
  assert.equal(classifyMealType(19), 'dinner');
  assert.equal(classifyMealType(2), 'snack');
  assert.equal(classifyMealType(16), 'snack');
});

test('makeEntryId is sortable and matches the id pattern', () => {
  const id = makeEntryId(localParts(new Date(2026, 6, 29, 12, 30, 5)));
  assert.match(id, /^2026-07-29T12-30-05__[0-9a-f]{6}$/);
});

test('localParts produces date, timestamp, and idStamp', () => {
  const p = localParts(new Date(2026, 6, 29, 12, 30, 5));
  assert.equal(p.date, '2026-07-29');
  assert.equal(p.idStamp, '2026-07-29T12-30-05');
  assert.match(p.timestamp, /^2026-07-29T12:30:05[+-]\d{2}:\d{2}$/);
});

// The bug this guards: rendering an instant with the *server's* zone filed a
// 19:26 PDT dinner as 2026-07-30 (UTC), a day the Today view never shows.
test('partsAtOffset renders an instant at the given offset, not the process zone', () => {
  const instant = new Date('2026-07-30T02:26:57Z');
  const pdt = partsAtOffset(instant, -420);
  assert.equal(pdt.date, '2026-07-29');
  assert.equal(pdt.timestamp, '2026-07-29T19:26:57-07:00');
  assert.equal(pdt.idStamp, '2026-07-29T19-26-57');
  assert.equal(pdt.hour, 19);

  const utc = partsAtOffset(instant, 0);
  assert.equal(utc.date, '2026-07-30');
  assert.equal(utc.timestamp, '2026-07-30T02:26:57+00:00');

  const kathmandu = partsAtOffset(instant, 345);
  assert.equal(kathmandu.timestamp, '2026-07-30T08:11:57+05:45');
});

test('parseWallClock reads a client wall clock and keeps its offset', () => {
  const p = parseWallClock('2026-07-29T19:26:57-07:00');
  assert.equal(p.date, '2026-07-29');
  assert.equal(p.timestamp, '2026-07-29T19:26:57-07:00');
  assert.equal(p.hour, 19);
  assert.equal(p.offsetMinutes, -420);
  assert.equal(p.ms, Date.parse('2026-07-30T02:26:57Z'));

  // Seconds optional, Z accepted.
  assert.equal(parseWallClock('2026-07-29T08:15Z').timestamp, '2026-07-29T08:15:00+00:00');
});

test('parseWallClock rejects anything ambiguous, impossible, or out of range', () => {
  assert.equal(parseWallClock('2026-07-29T19:26:57'), null, 'no offset is ambiguous');
  assert.equal(parseWallClock('2026-02-30T12:00:00Z'), null, 'date does not exist');
  assert.equal(parseWallClock('1999-12-31T23:59:59Z'), null, 'implausibly old');
  assert.equal(parseWallClock('not a date'), null);
  assert.equal(parseWallClock(''), null);
  assert.equal(parseWallClock(null), null);
  const farFuture = new Date(Date.now() + 40 * 60 * 60 * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
  assert.equal(parseWallClock(farFuture), null, 'beyond tolerated clock skew');
});

test('byNewestFirst orders by timestamp, using entry_id only to break ties', () => {
  // An edited meal keeps its original entry_id, so ordering must follow the
  // timestamp even when the two disagree. (FR-16d)
  const early = { entry_id: '2026-07-30T02-03-05__aaaaaa', timestamp: '2026-07-29T09:00:00-07:00' };
  const late = { entry_id: '2026-07-29T23-23-28__bbbbbb', timestamp: '2026-07-29T19:00:00-07:00' };
  assert.deepEqual([early, late].sort(byNewestFirst), [late, early]);

  const sameTime = [
    { entry_id: '2026-07-29T12-00-00__aaaaaa', timestamp: '2026-07-29T12:00:00-07:00' },
    { entry_id: '2026-07-29T12-00-00__bbbbbb', timestamp: '2026-07-29T12:00:00-07:00' }
  ];
  assert.equal(sameTime.slice().sort(byNewestFirst)[0].entry_id, '2026-07-29T12-00-00__bbbbbb');
});

// --- Location matching ----------------------------------------------------

test('haversineMeters is ~0 for same point and grows with distance', () => {
  const a = { lat: 48.1371, long: 11.5754 };
  assert.ok(haversineMeters(a, a) < 0.01);
  assert.ok(haversineMeters(a, { lat: 48.13755, long: 11.5754 }) > 40);
});

test('findNearbyLocationName reuses a name within tolerance, else empty', () => {
  const meals = [
    { location: { lat: 48.1371, long: 11.5754, name: 'home' } },
    { location: { lat: 48.2000, long: 11.6000, name: 'office' } }
  ];
  assert.equal(findNearbyLocationName(48.13715, 11.5754, meals), 'home');
  assert.equal(findNearbyLocationName(49.0, 12.0, meals), '');
  assert.equal(findNearbyLocationName(null, null, meals), '');
});

// --- Aggregation ----------------------------------------------------------

function meal(date, cals, protein) {
  return {
    entry_id: makeEntryId(localParts(new Date(date + 'T12:00:00'))),
    date,
    timestamp: date + 'T12:00:00+00:00',
    meal_type: 'lunch',
    nutrition: {
      calories: { value: cals }, protein_g: { value: protein },
      fat_g: { value: 10 }, carbs_g: { value: 20 }, fiber_g: { value: null }
    }
  };
}

test('totals sum point values and skip nulls', () => {
  const totals = emptyTotals();
  addToTotals(totals, meal('2026-07-29', 500, 30));
  addToTotals(totals, meal('2026-07-29', 700, 40));
  const rounded = roundTotals(totals);
  assert.equal(rounded.calories, 1200);
  assert.equal(rounded.protein_g, 70);
  assert.equal(rounded.fiber_g, 0);
});

test('dayView filters by date and totals only that day', () => {
  const meals = [meal('2026-07-29', 500, 30), meal('2026-07-28', 999, 99), meal('2026-07-29', 100, 10)];
  const view = dayView('2026-07-29', meals);
  assert.equal(view.meals.length, 2);
  assert.equal(view.totals.calories, 600);
});

// --- CSV ------------------------------------------------------------------

test('csvEscape quotes commas, quotes, and newlines', () => {
  assert.equal(csvEscape('plain'), 'plain');
  assert.equal(csvEscape('a,b'), '"a,b"');
  assert.equal(csvEscape('a"b'), '"a""b"');
  assert.equal(csvEscape('a\nb'), '"a\nb"');
  assert.equal(csvEscape(null), '');
});

test('csv columns include a value/low/high triple per nutrient', () => {
  const cols = csvColumns();
  for (const n of NUTRIENTS) {
    assert.ok(cols.includes(n.key));
    assert.ok(cols.includes(`${n.key}_low`));
    assert.ok(cols.includes(`${n.key}_high`));
  }
  assert.ok(cols.includes('entry_id') && cols.includes('location_name') && cols.includes('model_used'));
});

test('mealToCsvRow flattens nutrition, items, and location', () => {
  const m = {
    ...meal('2026-07-29', 620, 38),
    items: [{ name: 'rice', amount: '200 g' }, { name: 'chicken', amount: '' }],
    note: 'hi', location: { lat: 48.1, long: 11.5, name: 'home' },
    media_refs: ['photo-1.jpg', 'note.txt'], confidence: 0.8, model_used: 'opus'
  };
  m.nutrition.calories = { value: 620, low: 560, high: 700 };
  const row = mealToCsvRow(m);
  assert.equal(row.calories, 620);
  assert.equal(row.calories_low, 560);
  assert.equal(row.fiber_g, '');
  assert.equal(row.items, 'rice (200 g); chicken');
  assert.equal(row.location_name, 'home');
  assert.equal(row.media_refs, 'photo-1.jpg; note.txt');
});

test('buildHistoryCsv emits a header plus one row per meal, oldest first', () => {
  const meals = [meal('2026-07-29', 500, 30), meal('2026-07-28', 700, 40)];
  const csv = buildHistoryCsv(meals);
  const lines = csv.trim().split('\n');
  assert.equal(lines.length, 3); // header + 2
  assert.equal(lines[0], csvColumns().join(','));
  assert.ok(lines[1].startsWith('2026-07-28T'));
  assert.ok(lines[2].startsWith('2026-07-29T'));
});

test('buildHistoryCsv on no meals is just the header', () => {
  const csv = buildHistoryCsv([]);
  assert.equal(csv.trim(), csvColumns().join(','));
});

// --- Pantry: ids & slugs --------------------------------------------------

test('slugify lowercases, strips accents, and collapses to hyphens', () => {
  assert.equal(slugify('Almond Milk, Unsweetened'), 'almond-milk-unsweetened');
  assert.equal(slugify('  Café Latté!!  '), 'cafe-latte');
  assert.equal(slugify('***'), '');
});

test('makeItemId is a slug plus a 6-hex suffix and matches the id pattern', () => {
  const id = makeItemId('almond milk', 'Alpro');
  assert.match(id, /^[a-z0-9-]+__[0-9a-f]{6}$/);
  assert.ok(id.startsWith('almond-milk-alpro__'));
  assert.equal(makeItemId('', '').startsWith('item__'), true);
});

// --- Pantry: amount/unit, nutrient, aliases -------------------------------

test('cleanAmountUnit validates amount and constrains the unit', () => {
  assert.deepEqual(cleanAmountUnit({ amount: 100, unit: 'ml' }, ['g', 'ml'], 'g'), { amount: 100, unit: 'ml' });
  assert.deepEqual(cleanAmountUnit({ amount: 250, unit: 'oz' }, ['g', 'ml'], 'g'), { amount: 250, unit: 'g' });
  assert.equal(cleanAmountUnit({ amount: 0 }, ['g', 'ml'], 'g'), null);
  assert.equal(cleanAmountUnit(null, ['g', 'ml'], 'g'), null);
});

test('cleanPantryNutrient requires a value for macros but allows null fiber', () => {
  const cal = NUTRIENTS.find((n) => n.key === 'calories');
  const fiber = NUTRIENTS.find((n) => n.key === 'fiber_g');
  assert.deepEqual(cleanPantryNutrient({ value: '13.005' }, cal), { nutrient: { value: 13.01, unit: 'kcal' } });
  assert.ok(cleanPantryNutrient({ value: '' }, cal).error);
  assert.deepEqual(cleanPantryNutrient({ value: null }, fiber), { nutrient: { value: null, unit: 'g' } });
});

test('cleanAliases trims, de-dupes case-insensitively, and drops blanks', () => {
  assert.deepEqual(cleanAliases(['Almond milk', 'almond milk', '  ', 'Alpro']), ['Almond milk', 'Alpro']);
  assert.deepEqual(cleanAliases('not an array'), []);
});

// --- Pantry: full item validation -----------------------------------------

function samplePantryInput() {
  return {
    name: 'almond milk, unsweetened',
    brand: 'Alpro',
    aliases: ['almond milk', 'the alpro one'],
    basis: { amount: 100, unit: 'ml' },
    nutrition: {
      calories: { value: 13 }, protein_g: { value: 0.4 },
      fat_g: { value: 1.1 }, carbs_g: { value: 0.0 }, fiber_g: { value: 0.4 }
    },
    serving_size: { amount: 250, unit: 'ml' },
    package_size: { amount: 1000, unit: 'ml' },
    source: 'label-photo',
    confidence: 0.95,
    model_used: 'opus'
  };
}

test('validateAndCleanPantryItem accepts a well-formed item and whitelists it', () => {
  const { content, error } = validateAndCleanPantryItem(samplePantryInput());
  assert.equal(error, undefined);
  assert.equal(content.name, 'almond milk, unsweetened');
  assert.equal(content.basis.unit, 'ml');
  assert.equal(content.nutrition.calories.value, 13);
  assert.equal(content.nutrition.calories.unit, 'kcal');
  assert.equal(content.source, 'label-photo');
});

test('validateAndCleanPantryItem drops forged/server-owned fields', () => {
  const input = { ...samplePantryInput(), item_id: 'x', created_at: 'y', added_via: 'meal-auto', last_used_at: 'z' };
  const { content } = validateAndCleanPantryItem(input);
  assert.equal(content.item_id, undefined);
  assert.equal(content.created_at, undefined);
  assert.equal(content.added_via, undefined);
  assert.equal(content.last_used_at, undefined);
});

test('validateAndCleanPantryItem requires a name, basis, and macro values', () => {
  assert.ok(validateAndCleanPantryItem(null).error);
  const noName = samplePantryInput(); noName.name = '   ';
  assert.ok(validateAndCleanPantryItem(noName).error);
  const noBasis = samplePantryInput(); delete noBasis.basis;
  assert.ok(validateAndCleanPantryItem(noBasis).error);
  const noCal = samplePantryInput(); delete noCal.nutrition.calories;
  assert.ok(validateAndCleanPantryItem(noCal).error);
});

test('validateAndCleanPantryItem falls back to label-photo for an unknown source', () => {
  const input = samplePantryInput(); input.source = 'made-up';
  assert.equal(validateAndCleanPantryItem(input).content.source, 'label-photo');
});

test('validateAndCleanPantryItem keeps the confidence it was given', () => {
  const { content } = validateAndCleanPantryItem(samplePantryInput());
  assert.equal(content.confidence, 0.95);
  assert.equal(content.rounding_floor, false);
});

// --- Pantry: rounding floor (all-zero macros) ------------------------------

function zeroMacroInput() {
  const input = samplePantryInput();
  input.name = 'organic yellow mustard';
  input.basis = { amount: 100, unit: 'g' };
  input.nutrition = {
    calories: { value: 0 }, protein_g: { value: 0 },
    fat_g: { value: 0 }, carbs_g: { value: 0 }, fiber_g: { value: null }
  };
  input.serving_size = { amount: 5, unit: 'g' };
  return input;
}

test('isRoundingFloor spots all-zero macros and ignores fiber', () => {
  assert.equal(isRoundingFloor(zeroMacroInput().nutrition), true);
  assert.equal(isRoundingFloor(samplePantryInput().nutrition), false);
  // A zero-carb food is not a rounding floor — only all four together.
  const gruyere = {
    calories: { value: 393 }, protein_g: { value: 28.6 },
    fat_g: { value: 32.1 }, carbs_g: { value: 0 }, fiber_g: { value: 0 }
  };
  assert.equal(isRoundingFloor(gruyere), false);
});

test('an all-zero-macro item is flagged and capped to low confidence', () => {
  const { content } = validateAndCleanPantryItem(zeroMacroInput());
  assert.equal(content.rounding_floor, true);
  assert.ok(content.confidence <= 0.25, `expected a capped confidence, got ${content.confidence}`);
  assert.match(content.confidence_note, /rounding floor/);
});

test('the rounding-floor cap cannot be overridden by a high confidence claim', () => {
  const input = zeroMacroInput();
  input.confidence = 1;
  input.confidence_note = 'read every value off the label';
  const { content } = validateAndCleanPantryItem(input);
  assert.ok(content.confidence <= 0.25);
  // The original note is preserved alongside the warning, not discarded.
  assert.match(content.confidence_note, /read every value off the label/);
});

test('a missing confidence on a normal item stays null rather than inventing one', () => {
  const input = samplePantryInput();
  delete input.confidence;
  const { content } = validateAndCleanPantryItem(input);
  assert.equal(content.confidence, null);
  assert.equal(content.rounding_floor, false);
});

// --- Pantry: provenance survives the review round-trip ---------------------

test('withStagedProvenance restores confidence the review form dropped', () => {
  const staged = [{ confidence: 0.93, confidence_note: 'clean carton label', model_used: 'opus' }];
  // What the client posts back: edited values, no provenance fields at all.
  const posted = { name: 'almond milk', proposal_index: 0 };
  const merged = withStagedProvenance(posted, staged);
  assert.equal(merged.confidence, 0.93);
  assert.equal(merged.confidence_note, 'clean carton label');
  assert.equal(merged.model_used, 'opus');
});

test('withStagedProvenance lets an explicit client value win', () => {
  const staged = [{ confidence: 0.93, confidence_note: 'agent note', model_used: 'opus' }];
  const merged = withStagedProvenance({ proposal_index: 0, confidence: 0.4 }, staged);
  assert.equal(merged.confidence, 0.4);
});

test('withStagedProvenance is a no-op for an unknown or missing index', () => {
  const staged = [{ confidence: 0.93 }];
  assert.equal(withStagedProvenance({ name: 'x' }, staged).confidence, undefined);
  assert.equal(withStagedProvenance({ name: 'x', proposal_index: 7 }, staged).confidence, undefined);
  assert.equal(withStagedProvenance({ name: 'x', proposal_index: 0 }, []).confidence, undefined);
});

test('a confirmed item carries the staged confidence end to end', () => {
  const staged = [{ confidence: 0.88, confidence_note: 'label read cleanly', model_used: 'opus' }];
  const posted = { ...samplePantryInput(), proposal_index: 0 };
  delete posted.confidence;
  delete posted.model_used;
  const { content } = validateAndCleanPantryItem(withStagedProvenance(posted, staged));
  assert.equal(content.confidence, 0.88);
  assert.equal(content.confidence_note, 'label read cleanly');
  assert.equal(content.model_used, 'opus');
});

// --- Pantry: index & matching ---------------------------------------------

test('buildPantryIndex exposes only match fields, never the numbers', () => {
  const idx = buildPantryIndex([{
    item_id: 'a__000000', name: 'x', brand: 'b', aliases: ['y'], basis: { amount: 100, unit: 'g' },
    nutrition: { calories: { value: 500 } }
  }]);
  assert.deepEqual(idx[0], { id: 'a__000000', name: 'x', brand: 'b', aliases: ['y'], basis: { amount: 100, unit: 'g' } });
  assert.equal(idx[0].nutrition, undefined);
});

test('findMatchingPantryItem matches on name+brand case-insensitively', () => {
  const items = [
    { item_id: 'a__000000', name: 'Almond Milk', brand: 'Alpro' },
    { item_id: 'b__000000', name: 'Oat Milk', brand: '' }
  ];
  assert.equal(findMatchingPantryItem('almond milk', 'ALPRO', items).item_id, 'a__000000');
  assert.equal(findMatchingPantryItem('oat milk', '', items).item_id, 'b__000000');
  assert.equal(findMatchingPantryItem('almond milk', 'other', items), null);
});

// --- Pantry: server-side arithmetic (FR-22a, FR-27) -----------------------

const ALMOND = {
  item_id: 'almond-milk__7f3a91',
  basis: { amount: 100, unit: 'ml' },
  nutrition: {
    calories: { value: 13 }, protein_g: { value: 0.4 },
    fat_g: { value: 1.1 }, carbs_g: { value: 0.0 }, fiber_g: { value: null }
  },
  serving_size: { amount: 250, unit: 'ml' },
  package_size: { amount: 1000, unit: 'ml' }
};

test('resolvePantryContribution scales stored per-100 values by a ml amount', () => {
  const r = resolvePantryContribution(ALMOND, { amount: 50, unit: 'ml' });
  assert.equal(r.origin, 'pantry');
  assert.equal(r.estimated, false);
  assert.equal(r.nutrition.calories.value, 6.5); // 13 * 50/100
  assert.equal(r.nutrition.fat_g.value, 0.55);
  assert.equal(r.nutrition.fiber_g.value, null); // null stays null, never guessed
});

test('resolvePantryContribution resolves servings and packages', () => {
  const serv = resolvePantryContribution(ALMOND, { amount: 2, unit: 'serving' }); // 2 * 250 ml
  assert.equal(serv.nutrition.calories.value, 65); // 13 * 500/100
  const pkg = resolvePantryContribution(ALMOND, { amount: 1, unit: 'package' }); // 1000 ml
  assert.equal(pkg.nutrition.calories.value, 130);
});

test('resolvePantryContribution flags a g/ml mismatch as an estimate (FR-27)', () => {
  const r = resolvePantryContribution(ALMOND, { amount: 50, unit: 'g' }); // basis is ml
  assert.equal(r.estimated, true);
  assert.equal(r.origin, 'estimate');
  assert.ok(r.note.includes('mismatch'));
});

test('resolvePantryContribution returns null on unusable input', () => {
  assert.equal(resolvePantryContribution(ALMOND, { amount: 0, unit: 'ml' }), null);
  assert.equal(resolvePantryContribution(ALMOND, { amount: 5, unit: 'bogus' }), null);
  const noServing = { ...ALMOND, serving_size: null };
  assert.equal(resolvePantryContribution(noServing, { amount: 1, unit: 'serving' }), null);
});

test('addNutritionInto sums a contribution into a meal nutrition object', () => {
  const nutrition = {
    calories: { value: 200, low: 180, high: 220, unit: 'kcal' },
    protein_g: { value: 10, low: null, high: null, unit: 'g' },
    fat_g: { value: 5, low: null, high: null, unit: 'g' },
    carbs_g: { value: 20, low: null, high: null, unit: 'g' },
    fiber_g: { value: null, low: null, high: null, unit: 'g' }
  };
  const contribution = resolvePantryContribution(ALMOND, { amount: 100, unit: 'ml' }).nutrition;
  addNutritionInto(nutrition, contribution);
  assert.equal(nutrition.calories.value, 213); // 200 + 13
  assert.equal(nutrition.calories.low, 180);   // band preserved
  assert.equal(nutrition.fat_g.value, 6.1);    // 5 + 1.1
  assert.equal(nutrition.fiber_g.value, null); // null + null stays null
});
