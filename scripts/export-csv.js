#!/usr/bin/env node
// Regenerates data/intake-history.csv from every data/meals/<entry_id>/meal.json.
// The CSV is a derived artifact (§6.3) — never a stored source of truth — so it
// is safe to run this anytime; it simply overwrites the file from the JSON.
//
//   npm run export-csv
//   node scripts/export-csv.js [output.csv]

const fs = require('fs');
const { listMeals, buildHistoryCsv, HISTORY_CSV_PATH } = require('../server.js');

const outPath = process.argv[2] || HISTORY_CSV_PATH;
const meals = listMeals();
const csv = buildHistoryCsv(meals);
fs.writeFileSync(outPath, csv);
console.log(`Wrote ${meals.length} meal(s) to ${outPath}`);
