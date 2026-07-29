const app = document.getElementById('app');
const pageTitle = document.getElementById('page-title');
const backBtn = document.getElementById('back-btn');
const menuBtn = document.getElementById('menu-btn');

const TITLES = {
  login: 'Nutrition Journal',
  today: 'Nutrition Journal',
  intake: 'New Intake',
  review: 'Review Estimate',
  history: 'History',
  meal: 'Meal'
};

// The five tracked nutrients (FR-6). Order drives display everywhere.
const NUTRIENTS = [
  { key: 'calories', label: 'Calories', unit: 'kcal', cls: 'cal' },
  { key: 'protein_g', label: 'Protein', unit: 'g', cls: 'protein' },
  { key: 'fat_g', label: 'Fat', unit: 'g', cls: 'fat' },
  { key: 'carbs_g', label: 'Carbs', unit: 'g', cls: 'carbs' },
  { key: 'fiber_g', label: 'Fiber', unit: 'g', cls: 'fiber' }
];
const MACROS = NUTRIENTS.filter((n) => n.key !== 'calories');

let currentView = 'login';
let viewDate = null;      // YYYY-MM-DD for the Today view
let pollTimer = null;

// In-progress intake being composed on the New Intake screen.
let intakeState = { photos: [], audio: null };
// Geolocation captured for the entry currently under review.
let reviewGeo = { lat: null, long: null };

backBtn.addEventListener('click', () => {
  if (currentView === 'meal' || currentView === 'history') navigate('today', viewDate);
  else navigate('today');
});
menuBtn.addEventListener('click', showMenu);

function navigate(view, arg) {
  currentView = view;
  clearTimeout(pollTimer);
  pollTimer = null;
  pageTitle.textContent = TITLES[view] || 'Nutrition Journal';
  backBtn.hidden = view === 'today' || view === 'login';
  menuBtn.hidden = view === 'login';
  app.innerHTML = '';
  const tpl = document.getElementById(`tpl-${view}`);
  app.appendChild(tpl.content.cloneNode(true));

  if (view === 'login') wireLogin();
  if (view === 'today') loadToday(arg || todayStr());
  if (view === 'intake') wireIntake();
  if (view === 'review') loadReview(arg);
  if (view === 'history') loadHistory();
  if (view === 'meal') loadMeal(arg);
}

// --- API helper -----------------------------------------------------------

async function api(path, options) {
  let res;
  try {
    res = await fetch(path, options);
  } catch (networkErr) {
    const err = new Error('Network error — check your connection.');
    err.status = 0;
    throw err;
  }
  if (res.status === 401) {
    navigate('login');
    const err = new Error('Signed out.');
    err.status = 401;
    throw err;
  }
  if (!res.ok) {
    let message = `Request failed (${res.status}).`;
    try {
      const body = await res.json();
      if (body && body.error) message = body.error;
    } catch (ignored) { /* non-JSON error body */ }
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  const type = res.headers.get('content-type') || '';
  return type.includes('application/json') ? res.json() : res.text();
}

// --- Login ----------------------------------------------------------------

function wireLogin() {
  const form = document.getElementById('login-form');
  const errorEl = document.getElementById('login-error');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.hidden = true;
    const button = form.querySelector('button');
    button.disabled = true;
    try {
      await api('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: new FormData(form).get('password') })
      });
      navigate('today');
    } catch (err) {
      errorEl.textContent = err.status === 401 ? 'Wrong password.' : err.message;
      errorEl.hidden = false;
      button.disabled = false;
    }
  });
}

// --- Today / day dashboard ------------------------------------------------

async function loadToday(date) {
  viewDate = date;
  const container = document.getElementById('today-content');
  container.innerHTML = '<p class="empty-state">Loading…</p>';
  let day;
  try {
    day = await api(`/api/day/${date}`);
  } catch (err) {
    if (err.status === 401) return;
    container.innerHTML = `<p class="empty-state">Could not load the day: ${escapeHtml(err.message)}</p>`;
    return;
  }

  const isToday = date === todayStr();
  const mealsHtml = day.meals.length
    ? day.meals.map(mealRowHtml).join('')
    : '<p class="empty-state">No meals logged for this day.<br>Tap <strong>+ New Intake</strong> to add one.</p>';

  container.innerHTML = `
    <div class="day-nav">
      <button class="icon-btn" id="prev-day">&larr;</button>
      <div class="day-label">
        <strong>${escapeHtml(dayLabel(date))}</strong>
        <input type="date" id="date-picker" value="${date}" max="${todayStr()}">
      </div>
      <button class="icon-btn" id="next-day" ${isToday ? 'disabled' : ''}>&rarr;</button>
    </div>
    ${totalsCardHtml(day.totals)}
    <div class="fab-row">
      <button class="primary-btn" id="new-intake-btn">+ New Intake</button>
    </div>
    <div class="card" style="padding:0.25rem 1.25rem;">${mealsHtml}</div>
  `;

  document.getElementById('prev-day').addEventListener('click', () => navigate('today', shiftDate(date, -1)));
  const next = document.getElementById('next-day');
  if (!isToday) next.addEventListener('click', () => navigate('today', shiftDate(date, 1)));
  document.getElementById('date-picker').addEventListener('change', (e) => {
    if (e.target.value) navigate('today', e.target.value);
  });
  document.getElementById('new-intake-btn').addEventListener('click', () => navigate('intake'));
  container.querySelectorAll('[data-meal-id]').forEach((row) => {
    row.addEventListener('click', () => navigate('meal', row.dataset.mealId));
  });
}

function totalsCardHtml(totals) {
  return `
    <div class="totals-card">
      <div class="totals-hero">
        <div class="kcal-value">${Math.round(totals.calories)}</div>
        <div class="kcal-label">kcal today</div>
      </div>
      <div class="macro-grid">
        ${MACROS.map((m) => `
          <div class="macro-box ${m.cls}">
            <div class="value">${formatNum(totals[m.key])}</div>
            <div class="label">${m.label} (g)</div>
          </div>`).join('')}
      </div>
    </div>`;
}

function mealRowHtml(meal) {
  const thumb = firstPhoto(meal);
  const thumbHtml = thumb
    ? `<img class="meal-thumb" src="/api/meals/${meal.entry_id}/media/${thumb}" alt="">`
    : `<div class="meal-thumb placeholder">&#127869;</div>`;
  const title = mealTitle(meal);
  const kcal = meal.nutrition && meal.nutrition.calories ? Math.round(meal.nutrition.calories.value || 0) : 0;
  return `
    <div class="meal-row" data-meal-id="${meal.entry_id}">
      ${thumbHtml}
      <div class="meal-row-main">
        <div class="meal-title">${escapeHtml(title)}</div>
        <div class="meal-sub"><span class="pill">${escapeHtml(meal.meal_type)}</span> · ${escapeHtml(timeOf(meal.timestamp))}</div>
      </div>
      <div class="meal-row-kcal"><span class="value">${kcal}</span><br><span class="unit">kcal</span></div>
    </div>`;
}

// --- New intake -----------------------------------------------------------

function wireIntake() {
  intakeState = { photos: [], audio: null };
  const form = document.getElementById('intake-form');
  const photoInput = document.getElementById('photo-input');
  const errorEl = document.getElementById('intake-error');

  photoInput.addEventListener('change', () => {
    for (const file of photoInput.files) {
      if (intakeState.photos.length >= 10) break;
      intakeState.photos.push(file);
    }
    photoInput.value = '';
    renderPhotoPreviews();
  });

  renderPhotoPreviews();
  wireAudio();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.hidden = true;
    const text = document.getElementById('intake-text').value.trim();
    if (!intakeState.photos.length && !intakeState.audio && !text) {
      errorEl.textContent = 'Add at least a photo, an audio note, or some text.';
      errorEl.hidden = false;
      return;
    }
    const submitBtn = document.getElementById('intake-submit');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Uploading…';

    const fd = new FormData();
    intakeState.photos.forEach((p) => fd.append('photos', p, p.name || 'photo.jpg'));
    if (intakeState.audio) fd.append('audio', intakeState.audio, 'audio.webm');
    if (text) fd.append('text', text);

    try {
      const res = await api('/api/intake', { method: 'POST', body: fd });
      navigate('review', res.staging_id);
    } catch (err) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Analyze meal';
      if (err.status !== 401) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
      }
    }
  });
}

function renderPhotoPreviews() {
  const wrap = document.getElementById('photo-previews');
  wrap.innerHTML = intakeState.photos.map((file, i) => {
    const url = URL.createObjectURL(file);
    return `<div class="photo-preview"><img src="${url}" alt=""><button type="button" data-remove-photo="${i}">&times;</button></div>`;
  }).join('');
  wrap.querySelectorAll('[data-remove-photo]').forEach((btn) => {
    btn.addEventListener('click', () => {
      intakeState.photos.splice(Number(btn.dataset.removePhoto), 1);
      renderPhotoPreviews();
    });
  });
}

// Audio: in-browser recording via MediaRecorder, capped at 15s. (FR-1)
function wireAudio() {
  const area = document.getElementById('audio-area');
  let mediaRecorder = null;
  let chunks = [];
  let stopTimer = null;

  function renderIdle() {
    area.innerHTML = `<button type="button" class="audio-record-btn" id="rec-btn">&#127908; Record (max 15s)</button>
      <label class="audio-record-btn" style="cursor:pointer;">&#128193; Or upload audio<input type="file" id="audio-upload" accept="audio/*" hidden></label>`;
    document.getElementById('rec-btn').addEventListener('click', startRec);
    document.getElementById('audio-upload').addEventListener('change', (e) => {
      if (e.target.files[0]) { intakeState.audio = e.target.files[0]; renderPlayer(); }
    });
  }

  function renderRecording() {
    area.innerHTML = `<button type="button" class="audio-record-btn recording" id="stop-btn">&#9209; Stop recording…</button>`;
    document.getElementById('stop-btn').addEventListener('click', stopRec);
  }

  function renderPlayer() {
    const url = URL.createObjectURL(intakeState.audio);
    area.innerHTML = `<div class="audio-player"><audio controls src="${url}"></audio><button type="button" class="remove-btn" id="clear-audio">&times;</button></div>`;
    document.getElementById('clear-audio').addEventListener('click', () => { intakeState.audio = null; renderIdle(); });
  }

  async function startRec() {
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      await showMessage('In-browser recording is not supported here. You can upload an audio file instead.');
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      await showMessage('Microphone access was denied. You can upload an audio file instead.');
      return;
    }
    chunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    mediaRecorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      intakeState.audio = new Blob(chunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      renderPlayer();
    };
    mediaRecorder.start();
    renderRecording();
    stopTimer = setTimeout(stopRec, 15000);
  }

  function stopRec() {
    clearTimeout(stopTimer);
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  }

  if (intakeState.audio) renderPlayer(); else renderIdle();
}

// --- Review & confirm -----------------------------------------------------

async function loadReview(stagingId) {
  const container = document.getElementById('review-content');
  container.innerHTML = `<div class="pending-box"><div class="spinner"></div><p><strong>Analyzing your meal…</strong></p><p class="muted">The agent is reading your photos and notes to estimate the nutrition. This usually takes under a minute — this page updates automatically.</p><div class="action-row single"><button class="danger-btn" id="cancel-analyzing">Cancel</button></div></div>`;
  const cancelBtn = document.getElementById('cancel-analyzing');
  if (cancelBtn) cancelBtn.addEventListener('click', () => cancelIntake(stagingId));

  let data;
  try {
    data = await api(`/api/intake/${stagingId}`);
  } catch (err) {
    if (err.status === 401) return;
    container.innerHTML = `<p class="empty-state">${escapeHtml(err.message)}</p><div class="action-row single"><button class="secondary-btn" id="back-today">Back to today</button></div>`;
    const b = document.getElementById('back-today');
    if (b) b.addEventListener('click', () => navigate('today'));
    return;
  }

  if (data.status === 'analyzing') {
    pollTimer = setTimeout(() => { if (currentView === 'review') loadReview(stagingId); }, 2500);
    return;
  }

  if (data.status === 'error') {
    container.innerHTML = `
      <div class="card pending-box">
        <p><strong>Analysis failed.</strong></p>
        <p class="muted">${escapeHtml(data.message || 'Unknown error.')}</p>
        <div class="action-row">
          <button class="danger-btn" id="discard-failed">Discard</button>
          <button class="secondary-btn" id="retry-failed">Retry</button>
        </div>
      </div>`;
    document.getElementById('discard-failed').addEventListener('click', () => cancelIntake(stagingId));
    document.getElementById('retry-failed').addEventListener('click', async () => {
      try {
        await api(`/api/intake/${stagingId}/rerun`, { method: 'POST', body: new FormData() });
        navigate('review', stagingId);
      } catch (err) {
        if (err.status !== 401) await showMessage(`Could not retry: ${err.message}`);
      }
    });
    return;
  }

  renderReviewForm(container, stagingId, data);
  captureGeolocation();
}

function renderReviewForm(container, stagingId, data) {
  const result = data.result;
  const threshold = data.confidence_threshold || 0.7;
  const conf = result.confidence;
  const lowConf = conf != null && conf < threshold;

  const photosHtml = (data.media.photos || []).map((name) =>
    `<div class="photo-preview"><img src="/api/intake/${stagingId}/media/${name}" alt=""></div>`).join('');

  container.innerHTML = `
    ${photosHtml ? `<div class="photo-previews">${photosHtml}</div>` : ''}
    ${confidenceHtml(conf, result.confidence_note, threshold)}
    ${lowConf ? `<div class="nudge">Confidence is on the low side. Adding a nutrition-label photo or the exact grams and re-running will sharpen the estimate — or edit the numbers directly below.</div>` : ''}

    <div class="card">
      <p class="section-title">Nutrition</p>
      ${nutrientEditorHtml(result.nutrition)}
    </div>

    <div class="card">
      <p class="section-title">Items</p>
      <div id="items-editor">${itemsEditorHtml(result.items)}</div>
      <button type="button" class="add-row-btn" id="add-item">+ Add item</button>
    </div>

    <div class="card">
      <label class="field-label">Meal type
        <select id="meal-type">${mealTypeOptions(result.meal_type)}</select>
      </label>
      <label class="field-label" style="margin-top:0.75rem;">Place (optional)
        <input type="text" id="location-name" value="${escapeAttr(result.location && result.location.name || '')}" placeholder="e.g. home, office">
      </label>
      <label class="field-label" style="margin-top:0.75rem;">Note
        <textarea id="review-note" rows="2">${escapeHtml(data.note || result.note || '')}</textarea>
      </label>
    </div>

    <details class="card">
      <summary style="cursor:pointer;color:var(--text-dim);">Add more detail &amp; re-analyze</summary>
      <div style="margin-top:0.75rem;">
        <div id="rerun-previews" class="photo-previews"></div>
        <label class="upload-btn"><span>&#128247; Add photos</span><input type="file" id="rerun-photos" accept="image/*" capture="environment" multiple hidden></label>
        <textarea id="rerun-text" rows="2" placeholder="Add detail, e.g. it was 200g, cooked in 1 tbsp olive oil" style="margin-top:0.6rem;"></textarea>
        <button type="button" class="secondary-btn" id="rerun-btn" style="margin-top:0.6rem;">Re-analyze</button>
      </div>
    </details>

    <div class="action-row">
      <button class="danger-btn" id="cancel-review">Cancel</button>
      <button class="primary-btn" id="confirm-review">Confirm &amp; Save</button>
    </div>
  `;

  wireNutrientEditor(container);
  wireItemsEditor(container.querySelector('#items-editor'), container.querySelector('#add-item'));
  wireRerun(stagingId);

  document.getElementById('cancel-review').addEventListener('click', () => cancelIntake(stagingId));
  document.getElementById('confirm-review').addEventListener('click', () => confirmReview(stagingId));
}

function wireRerun(stagingId) {
  const extraPhotos = [];
  const input = document.getElementById('rerun-photos');
  const previews = document.getElementById('rerun-previews');
  function render() {
    previews.innerHTML = extraPhotos.map((f, i) => `<div class="photo-preview"><img src="${URL.createObjectURL(f)}" alt=""><button type="button" data-x="${i}">&times;</button></div>`).join('');
    previews.querySelectorAll('[data-x]').forEach((b) => b.addEventListener('click', () => { extraPhotos.splice(Number(b.dataset.x), 1); render(); }));
  }
  input.addEventListener('change', () => { for (const f of input.files) extraPhotos.push(f); input.value = ''; render(); });
  document.getElementById('rerun-btn').addEventListener('click', async () => {
    const fd = new FormData();
    extraPhotos.forEach((p) => fd.append('photos', p, p.name || 'photo.jpg'));
    const t = document.getElementById('rerun-text').value.trim();
    if (t) fd.append('text', t);
    try {
      await api(`/api/intake/${stagingId}/rerun`, { method: 'POST', body: fd });
      navigate('review', stagingId);
    } catch (err) {
      if (err.status !== 401) await showMessage(`Could not re-analyze: ${err.message}`);
    }
  });
}

async function confirmReview(stagingId) {
  const btn = document.getElementById('confirm-review');
  btn.disabled = true;
  const payload = {
    nutrition: readNutritionFromDom(),
    items: readItemsFromDom(),
    meal_type: document.getElementById('meal-type').value,
    note: document.getElementById('review-note').value,
    location: {
      lat: reviewGeo.lat,
      long: reviewGeo.long,
      name: document.getElementById('location-name').value.trim()
    },
    confidence: currentConfidence,
    confidence_note: currentConfidenceNote,
    model_used: currentModelUsed
  };
  try {
    const res = await api(`/api/intake/${stagingId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    navigate('today', res.date);
  } catch (err) {
    btn.disabled = false;
    if (err.status !== 401) await showMessage(`Could not save: ${err.message}`);
  }
}

async function cancelIntake(stagingId) {
  if (!(await showConfirm('Discard this intake? Nothing will be saved.'))) return;
  try {
    await api(`/api/intake/${stagingId}`, { method: 'DELETE' });
  } catch (err) { /* best effort; staging expires anyway */ }
  navigate('today');
}

// Geolocation is captured at review time and used on confirm. Degrades
// gracefully: if denied/unavailable, lat/long stay null. (FR-14, FR-14b)
function captureGeolocation() {
  reviewGeo = { lat: null, long: null };
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    (pos) => { reviewGeo = { lat: pos.coords.latitude, long: pos.coords.longitude }; },
    () => { /* denied or unavailable — save without location */ },
    { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 }
  );
}

// --- Nutrient / item editors (shared by review and meal edit) -------------

// Confidence carried alongside edits so it round-trips on confirm/save.
let currentConfidence = null;
let currentConfidenceNote = '';
let currentModelUsed = '';

function confidenceHtml(conf, note, threshold) {
  currentConfidence = conf != null ? conf : null;
  currentConfidenceNote = note || '';
  if (conf == null) return '';
  const pct = Math.round(conf * 100);
  const cls = conf < threshold ? 'confidence-low' : 'confidence-high';
  return `
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:baseline;">
        <span class="section-title" style="margin:0;">Confidence</span>
        <strong>${pct}%</strong>
      </div>
      <div class="confidence-bar-wrap ${cls}"><div class="confidence-bar"><div style="width:${pct}%"></div></div></div>
      ${note ? `<p class="muted" style="margin:0.4rem 0 0;">${escapeHtml(note)}</p>` : ''}
    </div>`;
}

function nutrientEditorHtml(nutrition) {
  const head = `<div class="nutrient-head"><span></span><span>value</span><span>low</span><span>high</span></div>`;
  const rows = NUTRIENTS.map((n) => {
    const v = (nutrition && nutrition[n.key]) || {};
    return `
      <div class="nutrient-edit" data-nutrient="${n.key}">
        <span class="n-label">${n.label} <span class="muted">${n.unit}</span></span>
        <input type="number" inputmode="decimal" step="any" data-field="value" value="${v.value != null ? v.value : ''}" placeholder="${n.key === 'fiber_g' ? '—' : '0'}">
        <input type="number" inputmode="decimal" step="any" data-field="low" value="${v.low != null ? v.low : ''}" placeholder="–">
        <input type="number" inputmode="decimal" step="any" data-field="high" value="${v.high != null ? v.high : ''}" placeholder="–">
      </div>`;
  }).join('');
  return head + rows;
}

function wireNutrientEditor() { /* inputs are read on demand from the DOM */ }

function readNutritionFromDom() {
  const nutrition = {};
  document.querySelectorAll('[data-nutrient]').forEach((row) => {
    const key = row.dataset.nutrient;
    const get = (f) => {
      const el = row.querySelector(`[data-field="${f}"]`);
      const val = el.value.trim();
      return val === '' ? null : Number(val);
    };
    nutrition[key] = { value: get('value'), low: get('low'), high: get('high') };
  });
  return nutrition;
}

function itemsEditorHtml(items) {
  const list = (items && items.length) ? items : [];
  return list.map(itemRowHtml).join('');
}

function itemRowHtml(item) {
  return `
    <div class="item-edit">
      <input type="text" data-item-field="name" value="${escapeAttr(item.name || '')}" placeholder="Item">
      <input type="text" data-item-field="amount" value="${escapeAttr(item.amount || '')}" placeholder="Amount">
      <button type="button" class="remove-btn" data-remove-item>&times;</button>
    </div>`;
}

function wireItemsEditor(listEl, addBtn) {
  function wireRow(row) {
    row.querySelector('[data-remove-item]').addEventListener('click', () => row.remove());
  }
  listEl.querySelectorAll('.item-edit').forEach(wireRow);
  addBtn.addEventListener('click', () => {
    const tmp = document.createElement('div');
    tmp.innerHTML = itemRowHtml({});
    const row = tmp.firstElementChild;
    listEl.appendChild(row);
    wireRow(row);
  });
}

function readItemsFromDom() {
  const items = [];
  document.querySelectorAll('.item-edit').forEach((row) => {
    const name = row.querySelector('[data-item-field="name"]').value.trim();
    const amount = row.querySelector('[data-item-field="amount"]').value.trim();
    if (name) items.push({ name, amount });
  });
  return items;
}

function mealTypeOptions(selected) {
  return ['breakfast', 'lunch', 'dinner', 'snack']
    .map((t) => `<option value="${t}"${t === selected ? ' selected' : ''}>${t[0].toUpperCase() + t.slice(1)}</option>`)
    .join('');
}

// --- History --------------------------------------------------------------

async function loadHistory() {
  const container = document.getElementById('history-content');
  container.innerHTML = '<p class="empty-state">Loading…</p>';
  let data;
  try {
    data = await api('/api/history?days=30');
  } catch (err) {
    if (err.status === 401) return;
    container.innerHTML = `<p class="empty-state">Could not load history: ${escapeHtml(err.message)}</p>`;
    return;
  }
  container.innerHTML = `<div class="card" style="padding:0.25rem 1.25rem;">${data.days.map(historyRowHtml).join('')}</div>`;
  container.querySelectorAll('[data-date]').forEach((row) => {
    if (row.classList.contains('empty')) return;
    row.addEventListener('click', () => navigate('today', row.dataset.date));
  });
}

function historyRowHtml(day) {
  const empty = day.meal_count === 0;
  return `
    <div class="history-row ${empty ? 'empty' : ''}" data-date="${day.date}">
      <div class="history-row-date">
        <strong>${escapeHtml(dayLabel(day.date))}</strong>
        <span class="sub">${empty ? 'No meals' : `${day.meal_count} meal${day.meal_count > 1 ? 's' : ''} · P ${formatNum(day.totals.protein_g)} · F ${formatNum(day.totals.fat_g)} · C ${formatNum(day.totals.carbs_g)}`}</span>
      </div>
      <div class="history-row-kcal"><span class="value">${Math.round(day.totals.calories)}</span><br><span class="unit">kcal</span></div>
    </div>`;
}

// --- Meal detail + edit ---------------------------------------------------

async function loadMeal(entryId) {
  const container = document.getElementById('meal-content');
  container.innerHTML = '<p class="empty-state">Loading…</p>';
  let meal;
  try {
    meal = await api(`/api/meals/${entryId}`);
  } catch (err) {
    if (err.status === 401) return;
    container.innerHTML = `<p class="empty-state">${escapeHtml(err.message)}</p>`;
    return;
  }
  renderMealDetail(container, meal);
}

function renderMealDetail(container, meal) {
  const photos = (meal.media_refs || []).filter((r) => /\.(jpg|jpeg|png|webp|gif|heic|heif)$/i.test(r));
  const audio = (meal.media_refs || []).find((r) => /\.(webm|ogg|mp4|mp3|wav|aac|m4a)$/i.test(r));
  const photosHtml = photos.length
    ? `<div class="detail-photos">${photos.map((p) => `<img class="${photos.length > 1 ? 'multi' : ''}" src="/api/meals/${meal.entry_id}/media/${p}" alt="">`).join('')}</div>`
    : '';

  container.innerHTML = `
    ${photosHtml}
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem;">
        <h2 style="margin:0;font-size:1.2rem;">${escapeHtml(mealTitle(meal))}</h2>
        <span class="pill">${escapeHtml(meal.meal_type)}</span>
      </div>
      <p class="muted" style="margin:0;">${escapeHtml(formatDateTime(meal.timestamp))}${meal.location && meal.location.name ? ' · ' + escapeHtml(meal.location.name) : ''}</p>
    </div>

    <div class="card">
      <p class="section-title">Nutrition</p>
      ${NUTRIENTS.map((n) => nutrientDetailRow(n, meal.nutrition[n.key])).join('')}
    </div>

    ${(meal.items && meal.items.length) ? `<div class="card"><p class="section-title">Items</p>${meal.items.map(itemDetailHtml).join('')}</div>` : ''}

    ${meal.confidence != null ? `<div class="card"><p class="section-title">Confidence</p><strong>${Math.round(meal.confidence * 100)}%</strong>${meal.confidence_note ? `<p class="muted" style="margin:0.4rem 0 0;">${escapeHtml(meal.confidence_note)}</p>` : ''}</div>` : ''}

    ${meal.note ? `<div class="card"><p class="section-title">Note</p><p style="margin:0;line-height:1.5;">${escapeHtml(meal.note)}</p></div>` : ''}
    ${audio ? `<div class="card"><p class="section-title">Audio</p><audio controls src="/api/meals/${meal.entry_id}/media/${audio}" style="width:100%;"></audio></div>` : ''}

    <div class="card muted" style="font-size:0.75rem;">Model: ${escapeHtml(meal.model_used || 'n/a')} · ${meal.location && meal.location.lat != null ? `${meal.location.lat.toFixed(4)}, ${meal.location.long.toFixed(4)}` : 'no location'}</div>

    <div class="action-row">
      <button class="danger-btn" id="delete-meal">Delete</button>
      <button class="secondary-btn" id="edit-meal">Edit</button>
    </div>
  `;

  document.getElementById('edit-meal').addEventListener('click', () => renderMealEdit(container, meal));
  document.getElementById('delete-meal').addEventListener('click', async () => {
    if (!(await showConfirm('Delete this meal? This cannot be undone.'))) return;
    try {
      await api(`/api/meals/${meal.entry_id}`, { method: 'DELETE' });
      navigate('today', meal.date);
    } catch (err) {
      if (err.status !== 401) await showMessage(`Could not delete: ${err.message}`);
    }
  });
}

function nutrientDetailRow(n, data) {
  const d = data || {};
  const val = d.value != null ? `${formatNum(d.value)} ${n.unit}` : '—';
  const range = (d.low != null || d.high != null) ? `<span class="range">${d.low != null ? formatNum(d.low) : '?'}–${d.high != null ? formatNum(d.high) : '?'}</span>` : '';
  return `<div class="kv-row"><span class="k">${n.label}</span><span>${val} ${range}</span></div>`;
}

function itemDetailHtml(item) {
  return `<div class="detail-item"><strong>${escapeHtml(item.name)}</strong>${item.amount ? ` — ${escapeHtml(item.amount)}` : ''}${item.source ? `<div class="src">${escapeHtml(item.source)}</div>` : ''}</div>`;
}

function renderMealEdit(container, meal) {
  currentConfidence = meal.confidence != null ? meal.confidence : null;
  currentConfidenceNote = meal.confidence_note || '';
  currentModelUsed = meal.model_used || '';

  container.innerHTML = `
    <div class="card">
      <p class="section-title">Nutrition</p>
      ${nutrientEditorHtml(meal.nutrition)}
    </div>
    <div class="card">
      <p class="section-title">Items</p>
      <div id="items-editor">${itemsEditorHtml(meal.items)}</div>
      <button type="button" class="add-row-btn" id="add-item">+ Add item</button>
    </div>
    <div class="card">
      <label class="field-label">Meal type <select id="meal-type">${mealTypeOptions(meal.meal_type)}</select></label>
      <label class="field-label" style="margin-top:0.75rem;">Place <input type="text" id="location-name" value="${escapeAttr(meal.location && meal.location.name || '')}"></label>
      <label class="field-label" style="margin-top:0.75rem;">Note <textarea id="review-note" rows="2">${escapeHtml(meal.note || '')}</textarea></label>
    </div>
    <div class="action-row">
      <button class="secondary-btn" id="cancel-edit">Cancel</button>
      <button class="primary-btn" id="save-edit">Save</button>
    </div>
  `;
  wireNutrientEditor(container);
  wireItemsEditor(container.querySelector('#items-editor'), container.querySelector('#add-item'));
  document.getElementById('cancel-edit').addEventListener('click', () => renderMealDetail(container, meal));
  document.getElementById('save-edit').addEventListener('click', async () => {
    const btn = document.getElementById('save-edit');
    btn.disabled = true;
    const payload = {
      nutrition: readNutritionFromDom(),
      items: readItemsFromDom(),
      meal_type: document.getElementById('meal-type').value,
      note: document.getElementById('review-note').value,
      location: { name: document.getElementById('location-name').value.trim() },
      confidence: currentConfidence,
      confidence_note: currentConfidenceNote,
      model_used: currentModelUsed
    };
    try {
      const updated = await api(`/api/meals/${meal.entry_id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      renderMealDetail(container, updated);
    } catch (err) {
      btn.disabled = false;
      if (err.status !== 401) await showMessage(`Could not save: ${err.message}`);
    }
  });
}

// --- Menu -----------------------------------------------------------------

function showMenu() {
  const existing = document.querySelector('.menu-sheet');
  if (existing) { existing.remove(); return; }
  const sheet = document.createElement('div');
  sheet.className = 'menu-sheet';
  sheet.innerHTML = `
    <button data-act="today">Today</button>
    <button data-act="history">History</button>
    <button data-act="export">Export CSV</button>
    <button data-act="logout">Log out</button>`;
  document.body.appendChild(sheet);
  const close = (e) => {
    if (sheet.contains(e.target) || e.target === menuBtn) return;
    sheet.remove();
    document.removeEventListener('click', close);
  };
  setTimeout(() => document.addEventListener('click', close), 0);
  sheet.addEventListener('click', async (e) => {
    const act = e.target.dataset.act;
    if (!act) return;
    sheet.remove();
    document.removeEventListener('click', close);
    if (act === 'today') navigate('today');
    if (act === 'history') navigate('history');
    if (act === 'export') window.location.href = '/api/export/csv';
    if (act === 'logout') {
      try { await api('/api/logout', { method: 'POST' }); } catch (err) { /* ignore */ }
      navigate('login');
    }
  });
}

// --- Overlays -------------------------------------------------------------

function showConfirm(message) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
      <div class="confirm-box">
        <p>${escapeHtml(message)}</p>
        <div class="action-row">
          <button class="secondary-btn" data-choice="cancel">Cancel</button>
          <button class="danger-btn" data-choice="ok">Confirm</button>
        </div>
      </div>`;
    overlay.addEventListener('click', (e) => {
      const choice = e.target.dataset.choice;
      if (!choice) return;
      overlay.remove();
      resolve(choice === 'ok');
    });
    document.body.appendChild(overlay);
  });
}

function showMessage(message) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
      <div class="confirm-box">
        <p>${escapeHtml(message)}</p>
        <div class="action-row single"><button class="primary-btn" data-choice="ok">OK</button></div>
      </div>`;
    overlay.addEventListener('click', (e) => {
      if (!e.target.dataset.choice) return;
      overlay.remove();
      resolve();
    });
    document.body.appendChild(overlay);
  });
}

// --- Utils ----------------------------------------------------------------

function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
function escapeAttr(str) { return escapeHtml(str); }

function formatNum(n) {
  const num = Number(n) || 0;
  return Math.round(num * 10) / 10;
}

function todayStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function shiftDate(dateStr, delta) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d + delta);
  const pad = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

function dayLabel(dateStr) {
  if (dateStr === todayStr()) return 'Today';
  if (dateStr === shiftDate(todayStr(), -1)) return 'Yesterday';
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function timeOf(timestamp) {
  const d = new Date(timestamp);
  if (isNaN(d)) return '';
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function formatDateTime(timestamp) {
  const d = new Date(timestamp);
  if (isNaN(d)) return timestamp || '';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function firstPhoto(meal) {
  return (meal.media_refs || []).find((r) => /\.(jpg|jpeg|png|webp|gif|heic|heif)$/i.test(r)) || null;
}

// A short label for a meal: first item name(s), else the note, else meal type.
function mealTitle(meal) {
  if (meal.items && meal.items.length) {
    const names = meal.items.map((i) => i.name).filter(Boolean);
    if (names.length) return names.slice(0, 3).join(', ') + (names.length > 3 ? '…' : '');
  }
  if (meal.note) return meal.note.length > 60 ? meal.note.slice(0, 57) + '…' : meal.note;
  return meal.meal_type ? meal.meal_type[0].toUpperCase() + meal.meal_type.slice(1) : 'Meal';
}

// --- Startup --------------------------------------------------------------

(async () => {
  try {
    const res = await fetch('/api/auth/status');
    const status = await res.json();
    navigate(status.authenticated ? 'today' : 'login');
  } catch (err) {
    navigate('login');
  }
})();
