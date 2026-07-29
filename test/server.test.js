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
  assert.deepEqual(items[0], { name: 'rice', amount: '200 g', source: 'photo estimate' });
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
  assert.equal(classifyMealType(new Date(2026, 6, 29, 8)), 'breakfast');
  assert.equal(classifyMealType(new Date(2026, 6, 29, 12)), 'lunch');
  assert.equal(classifyMealType(new Date(2026, 6, 29, 19)), 'dinner');
  assert.equal(classifyMealType(new Date(2026, 6, 29, 2)), 'snack');
  assert.equal(classifyMealType(new Date(2026, 6, 29, 16)), 'snack');
});

test('makeEntryId is sortable and matches the id pattern', () => {
  const id = makeEntryId(new Date(2026, 6, 29, 12, 30, 5));
  assert.match(id, /^2026-07-29T12-30-05__[0-9a-f]{6}$/);
});

test('localParts produces date, timestamp, and idStamp', () => {
  const p = localParts(new Date(2026, 6, 29, 12, 30, 5));
  assert.equal(p.date, '2026-07-29');
  assert.equal(p.idStamp, '2026-07-29T12-30-05');
  assert.match(p.timestamp, /^2026-07-29T12:30:05[+-]\d{2}:\d{2}$/);
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
    entry_id: makeEntryId(new Date(date + 'T12:00:00')),
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
