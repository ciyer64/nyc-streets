// ── Borough config ────────────────────────────────────────────────────────────

const BOROUGH_META = {
  manhattan:     { name: 'Manhattan',     color: '#222222', bounds: [[-74.02, 40.695], [-73.906, 40.882]] },
  brooklyn:      { name: 'Brooklyn',      color: '#444444', bounds: [[-74.042, 40.568], [-73.833, 40.739]] },
  queens:        { name: 'Queens',        color: '#666666', bounds: [[-73.962, 40.541], [-73.700, 40.812]] },
  bronx:         { name: 'The Bronx',     color: '#333333', bounds: [[-73.933, 40.785], [-73.748, 40.918]] },
  staten_island: { name: 'Staten Island', color: '#555555', bounds: [[-74.259, 40.477], [-74.034, 40.651]] },
};

// ── State ─────────────────────────────────────────────────────────────────────

const state = {
  view: 'overview',      // 'overview' | 'borough'
  activeBorough: null,
  streetNames: {},       // { boroughId: string[] }
  progress: Object.fromEntries(
    Object.keys(BOROUGH_META).map(b => [b, { guessed: new Set(), total: 0 }])
  ),
};

// Load persisted progress from localStorage
function loadProgress() {
  try {
    const saved = JSON.parse(localStorage.getItem('nyc-street-progress') || '{}');
    for (const [b, guessed] of Object.entries(saved)) {
      if (state.progress[b]) {
        state.progress[b].guessed = new Set(guessed);
      }
    }
  } catch (e) { /* ignore */ }
}

function saveProgress() {
  const serialisable = Object.fromEntries(
    Object.entries(state.progress).map(([b, p]) => [b, [...p.guessed]])
  );
  localStorage.setItem('nyc-street-progress', JSON.stringify(serialisable));
}

// ── Map setup ─────────────────────────────────────────────────────────────────

const isMobile = () => window.innerWidth <= 767;

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/positron',
  center: [-73.97, 40.68],
  zoom: 10,
  minZoom: 9,
  maxZoom: 16,
  maxBounds: [[-75.2, 40.1], [-72.8, 41.3]], // prevent panning into white abyss
  attributionControl: false,
});

map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');

map.on('load', async () => {
  applyLightMapStyle();

  // Fit to all five boroughs — account for panel position per device
  map.fitBounds([[-74.26, 40.47], [-73.70, 40.93]], {
    padding: isMobile()
      ? { top: 200, bottom: 60, left: 20, right: 20 }
      : { top: 60,  bottom: 40, left: 40, right: 360 },
    duration: 0,
  });

  loadProgress();
  await loadBoroughBoundaries();
  await loadSummary();
  setupOverviewInteractions();
  updateScorePanel();

  // Lift the cover only after the map is fully styled and idle
  map.once('idle', () => {
    const cover = document.getElementById('map-cover');
    cover.style.opacity = '0';
    cover.addEventListener('transitionend', () => cover.remove(), { once: true });
  });
});

function applyLightMapStyle() {
  const WHITE      = '#f8f6f2';  // warm white background (matches website)
  const LAND       = '#f0ede8';  // warm cream for land areas
  const WATER      = '#dce8f2';  // light blue for water / coastline visibility
  const ROAD       = '#e2ddd7';  // very subtle road lines
  const BORDER     = '#d0ccc6';  // faint borders

  map.getStyle().layers.forEach(layer => {
    const id = layer.id;
    const src = layer['source-layer'];

    // Background → warm white
    if (id === 'background') {
      map.setPaintProperty(id, 'background-color', WHITE);
      return;
    }

    // Remove all place labels — no Hackensack, no Mount Vernon
    if (src === 'place' || src === 'aerodrome_label') {
      map.setLayoutProperty(id, 'visibility', 'none');
      return;
    }

    // Remove road/street name labels — spoilers
    if (src === 'transportation_name') {
      map.removeLayer(id);
      return;
    }

    // Water — light blue
    if (src === 'water' || src === 'waterway' || src === 'water_name') {
      if (layer.type === 'fill')   map.setPaintProperty(id, 'fill-color', WATER);
      if (layer.type === 'line')   map.setPaintProperty(id, 'line-color', WATER);
      if (layer.type === 'symbol') map.setLayoutProperty(id, 'visibility', 'none');
      return;
    }

    // All land fills → warm white/cream
    if (layer.type === 'fill') {
      map.setPaintProperty(id, 'fill-color', LAND);
      map.setPaintProperty(id, 'fill-opacity', 1);
      return;
    }

    // Road lines → very subtle, just enough to show the street grid when zoomed in
    if (src === 'transportation' && layer.type === 'line') {
      map.setPaintProperty(id, 'line-color', ROAD);
      map.setPaintProperty(id, 'line-opacity', 0.8);
      return;
    }

    // Borders → faint
    if (src === 'boundary' && layer.type === 'line') {
      map.setPaintProperty(id, 'line-color', BORDER);
      map.setPaintProperty(id, 'line-opacity', 0.4);
      return;
    }

    // Everything else — hide symbols, mute lines
    if (layer.type === 'symbol') map.setLayoutProperty(id, 'visibility', 'none');
    if (layer.type === 'line')   map.setPaintProperty(id, 'line-opacity', 0.1);
  });
}

// ── Data loading ──────────────────────────────────────────────────────────────

// Build an inverted polygon: world rectangle with borough shapes as holes.
// This masks out everything outside the five boroughs.
function buildMaskFeature(features) {
  // Outer ring: CCW world-covering rectangle
  // Borough rings from source data are CW — opposite winding creates holes
  const outer = [[-180,-90],[-180,90],[180,90],[180,-90],[-180,-90]];
  const holes = [];
  for (const f of features) {
    const geom = f.geometry;
    if (geom.type === 'Polygon') {
      holes.push(geom.coordinates[0]);
    } else if (geom.type === 'MultiPolygon') {
      for (const poly of geom.coordinates) {
        holes.push(poly[0]);
      }
    }
  }
  return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [outer, ...holes] } };
}

async function loadBoroughBoundaries() {
  const res = await fetch('data/boroughs.geojson');
  const geojson = await res.json();

  // ── Mask: covers everything outside NYC ──────────────────────
  map.addSource('nyc-mask', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [buildMaskFeature(geojson.features)] },
  });
  map.addLayer({
    id: 'nyc-mask-fill',
    type: 'fill',
    source: 'nyc-mask',
    paint: { 'fill-color': '#f8f6f2', 'fill-opacity': 1 },
  });

  // ── Borough fills & outlines ──────────────────────────────────
  map.addSource('boroughs', { type: 'geojson', data: geojson, generateId: true });

  // Fill — dim normally, brighter on hover
  map.addLayer({
    id: 'boroughs-fill',
    type: 'fill',
    source: 'boroughs',
    paint: {
      'fill-color': buildColorMatch(),
      'fill-opacity': [
        'case', ['boolean', ['feature-state', 'hover'], false], 0.55, 0.30
      ],
    },
  });

  // Outline
  map.addLayer({
    id: 'boroughs-outline',
    type: 'line',
    source: 'boroughs',
    paint: {
      'line-color': buildColorMatch(),
      'line-width': 2,
      'line-opacity': 0.9,
    },
  });
}

async function loadSummary() {
  const res = await fetch('data/summary.json');
  const summary = await res.json();
  for (const [borough, stats] of Object.entries(summary)) {
    if (state.progress[borough]) {
      state.progress[borough].total = stats.street_count;
    }
  }
}

async function loadBoroughStreets(boroughId) {
  if (state.streetNames[boroughId]) return; // already loaded
  const res = await fetch(`data/${boroughId}_names.json`);
  state.streetNames[boroughId] = await res.json();
}

async function loadBoroughGeoJSON(boroughId) {
  const res = await fetch(`data/${boroughId}.geojson`);
  return res.json();
}

// ── Color helpers ─────────────────────────────────────────────────────────────

function buildColorMatch() {
  const expr = ['match', ['get', 'borough_id']];
  for (const [id, meta] of Object.entries(BOROUGH_META)) {
    expr.push(id, meta.color);
  }
  expr.push('#aaa'); // fallback
  return expr;
}

// ── Overview interactions ─────────────────────────────────────────────────────

let hoveredId = null;

function setupOverviewInteractions() {
  map.on('mousemove', 'boroughs-fill', (e) => {
    if (!e.features.length) return;
    if (hoveredId !== null) {
      map.setFeatureState({ source: 'boroughs', id: hoveredId }, { hover: false });
    }
    hoveredId = e.features[0].id;
    map.setFeatureState({ source: 'boroughs', id: hoveredId }, { hover: true });
    map.getCanvas().style.cursor = 'pointer';
  });

  map.on('mouseleave', 'boroughs-fill', () => {
    if (hoveredId !== null) {
      map.setFeatureState({ source: 'boroughs', id: hoveredId }, { hover: false });
    }
    hoveredId = null;
    map.getCanvas().style.cursor = '';
  });

  map.on('click', 'boroughs-fill', (e) => {
    const boroughId = e.features[0]?.properties?.borough_id;
    if (boroughId) enterBorough(boroughId);
  });
}

// ── Borough detail view ───────────────────────────────────────────────────────

async function enterBorough(boroughId) {
  const meta = BOROUGH_META[boroughId];
  state.view = 'borough';
  state.activeBorough = boroughId;

  // Zoom to borough — on mobile leave room for the top bar (~140px) and bottom input (~80px)
  map.fitBounds(meta.bounds, {
    padding: isMobile()
      ? { top: 150, bottom: 90, left: 20, right: 20 }
      : 60,
    duration: 800,
  });

  // Load street data
  await Promise.all([
    loadBoroughStreets(boroughId),
    addStreetLayers(boroughId),
  ]);

  // Swap panels
  document.getElementById('score-panel').classList.add('hidden');
  document.getElementById('overview-prompt').classList.add('hidden');
  document.getElementById('detail-panel').classList.remove('hidden');
  document.getElementById('detail-name').textContent = meta.name;

  // Rebuild found order from saved progress (alphabetical on restore)
  foundOrder.length = 0;
  foundOrder.push(...[...state.progress[boroughId].guessed].sort());

  // Style active borough brighter, dim others
  map.setPaintProperty('boroughs-fill', 'fill-opacity', [
    'case',
    ['==', ['get', 'borough_id'], boroughId], 0.0,
    0.06,
  ]);
  map.setPaintProperty('boroughs-outline', 'line-opacity', [
    'case',
    ['==', ['get', 'borough_id'], boroughId], 0.9,
    0.2,
  ]);

  updateDetailPanel();
  updateFoundList(boroughId);
  setupGuessInput();

  // On mobile: collapse found list by default; tap header to expand
  if (isMobile()) {
    const list   = document.getElementById('found-list');
    const header = document.getElementById('found-header');
    list.classList.add('mobile-hidden');
    header.classList.remove('list-open');
  }
}

async function addStreetLayers(boroughId) {
  const sourceId = `streets-${boroughId}`;
  if (map.getSource(sourceId)) return; // already added

  const geojson = await loadBoroughGeoJSON(boroughId);
  const meta = BOROUGH_META[boroughId];

  map.addSource(sourceId, { type: 'geojson', data: geojson });

  // Dim layer — all streets, grey
  map.addLayer({
    id: `${sourceId}-dim`,
    type: 'line',
    source: sourceId,
    paint: {
      'line-color': '#888',
      'line-width': 1,
      'line-opacity': 0.25,
    },
  });

  // Lit layer — guessed streets, dark/black
  map.addLayer({
    id: `${sourceId}-lit`,
    type: 'line',
    source: sourceId,
    filter: buildGuessedFilter(boroughId),
    paint: {
      'line-color': '#1a1a1a',
      'line-width': 2.5,
      'line-opacity': 0.9,
    },
  });
}

function buildGuessedFilter(boroughId) {
  const guessed = [...state.progress[boroughId].guessed];
  if (guessed.length === 0) return ['==', 'name', '__none__'];
  return ['in', ['get', 'name'], ['literal', guessed]];
}

function refreshStreetLayer(boroughId) {
  const litLayerId = `streets-${boroughId}-lit`;
  if (map.getLayer(litLayerId)) {
    map.setFilter(litLayerId, buildGuessedFilter(boroughId));
  }
}

// ── Guess input ───────────────────────────────────────────────────────────────

function setupGuessInput() {
  // Remove old listener by cloning
  const input = document.getElementById('guess-input');
  const feedback = document.getElementById('guess-feedback');
  const fresh = input.cloneNode(true);
  input.parentNode.replaceChild(fresh, input);

  fresh.value = '';
  fresh.focus();

  fresh.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const guess = fresh.value.trim();
    fresh.value = '';
    if (!guess) return;
    handleGuess(guess, feedback);
    // Re-focus after handling so user can keep typing
    fresh.focus();
  });
}

// While in borough view, any keystroke refocuses the input
window.addEventListener('keydown', (e) => {
  if (state.view !== 'borough') return;
  if (e.target?.id === 'guess-input') return;          // already in input
  if (e.metaKey || e.ctrlKey || e.altKey) return;      // ignore shortcuts
  if (e.key.length !== 1 && e.key !== 'Backspace') return;
  const input = document.getElementById('guess-input');
  if (input) input.focus();
});

const ABBREVS = [
  [/\bAve\.?$/i,        'Avenue'],
  [/\bSt\.?$/i,         'Street'],
  [/\bBlvd\.?$/i,       'Boulevard'],
  [/\bDr\.?$/i,         'Drive'],
  [/\bRd\.?$/i,         'Road'],
  [/\bLn\.?$/i,         'Lane'],
  [/\bPl\.?$/i,         'Place'],
  [/\bCt\.?$/i,         'Court'],
  [/\bPkwy\.?$/i,       'Parkway'],
  [/\bTer\.?$/i,        'Terrace'],
  [/\bHwy\.?$/i,        'Highway'],
  [/\bExpy\.?$/i,       'Expressway'],
  [/\bBridge\.?$/i,     'Bridge'],
];

function expandAbbreviations(s) {
  let out = s.trim();
  for (const [re, full] of ABBREVS) {
    if (re.test(out)) {
      out = out.replace(re, full);
      break;
    }
  }
  return out;
}

function handleGuess(raw, feedbackEl) {
  const boroughId = state.activeBorough;
  const names = state.streetNames[boroughId] || [];
  const progress = state.progress[boroughId];

  const q = expandAbbreviations(raw).toLowerCase().trim();

  // 1. Exact match — only one street, return early
  const exact = names.find(n => n.toLowerCase() === q);
  if (exact) {
    if (progress.guessed.has(exact)) {
      showFeedback(feedbackEl, `Already got ${exact}`, 'already');
      return;
    }
    progress.guessed.add(exact);
    saveProgress();
    refreshStreetLayer(boroughId);
    updateDetailPanel();
    updateFoundList(boroughId, exact);
    updateScorePanel();
    showFeedback(feedbackEl, `✓ ${exact}`, 'correct');
    return;
  }

  // 2. Prefix match — "9th" matches "9th Avenue" AND "9th Street" at once.
  //    Next char must be a space so "Park" doesn't match "Parkway".
  const matches = names.filter(n => n.toLowerCase().startsWith(q + ' '));

  if (matches.length === 0) {
    showFeedback(feedbackEl, '', '');
    return;
  }

  const fresh = matches.filter(m => !progress.guessed.has(m));

  if (fresh.length === 0) {
    const label = matches.length === 1 ? matches[0] : `${matches[0]} (+${matches.length - 1})`;
    showFeedback(feedbackEl, `Already got ${label}`, 'already');
    return;
  }

  fresh.forEach(m => progress.guessed.add(m));
  saveProgress();
  refreshStreetLayer(boroughId);
  updateDetailPanel();
  // Add each new street to the found list (most recent last so top entry = last added)
  fresh.forEach(m => updateFoundList(boroughId, m));
  updateScorePanel();

  const label = fresh.length === 1
    ? `✓ ${fresh[0]}`
    : `✓ ${fresh[0]} (+${fresh.length - 1} more)`;
  showFeedback(feedbackEl, label, 'correct');
}

let feedbackTimer = null;
function showFeedback(el, msg, cls) {
  el.textContent = msg;
  el.className = cls;
  clearTimeout(feedbackTimer);
  if (msg) {
    feedbackTimer = setTimeout(() => {
      el.textContent = '';
      el.className = '';
    }, 1800);
  }
}

// ── Back to overview ──────────────────────────────────────────────────────────

document.getElementById('back-btn').addEventListener('click', () => {
  state.view = 'overview';
  state.activeBorough = null;

  map.fitBounds([[-74.26, 40.47], [-73.70, 40.93]], {
    padding: isMobile()
      ? { top: 200, bottom: 60, left: 20, right: 20 }
      : { top: 60,  bottom: 40, left: 40, right: 360 },
    duration: 800,
  });

  document.getElementById('detail-panel').classList.add('hidden');
  document.getElementById('score-panel').classList.remove('hidden');
  document.getElementById('overview-prompt').classList.remove('hidden');

  // Reset mobile found-list state
  document.getElementById('found-list').classList.remove('mobile-hidden');
  document.getElementById('found-header').classList.remove('list-open');

  // Restore overview fill/outline opacities
  map.setPaintProperty('boroughs-fill', 'fill-opacity', [
    'case', ['boolean', ['feature-state', 'hover'], false], 0.35, 0.18
  ]);
  map.setPaintProperty('boroughs-outline', 'line-opacity', 0.7);
});

// ── Score panel ───────────────────────────────────────────────────────────────

function updateScorePanel() {
  let totalGuessed = 0, totalStreets = 0;

  const list = document.getElementById('borough-list');
  list.innerHTML = '';

  for (const [id, meta] of Object.entries(BOROUGH_META)) {
    const { guessed, total } = state.progress[id];
    const count = guessed.size;
    const pct = total > 0 ? Math.round(100 * count / total) : 0;
    totalGuessed += count;
    totalStreets += total;

    const row = document.createElement('div');
    row.className = 'borough-row';
    row.innerHTML = `
      <div style="width:100%">
        <div style="display:flex;align-items:center;gap:8px">
          <span class="borough-dot" style="background:${meta.color}"></span>
          <span class="borough-label">${meta.name}</span>
          <span class="borough-pct">${pct}%</span>
        </div>
        <div class="borough-mini-bar-wrap">
          <div class="borough-mini-bar" style="width:${pct}%;background:${meta.color}"></div>
        </div>
      </div>`;
    row.addEventListener('click', () => enterBorough(id));
    list.appendChild(row);
  }

  const overallPct = totalStreets > 0 ? Math.round(100 * totalGuessed / totalStreets) : 0;
  document.getElementById('overall-pct').textContent = `${overallPct}%`;
  document.getElementById('overall-bar').style.width = `${overallPct}%`;
}

function formatPct(count, total) {
  if (total === 0) return '0%';
  const pct = 100 * count / total;
  if (pct === 0) return '0%';
  if (pct < 1)   return pct.toFixed(1) + '%';
  return Math.round(pct) + '%';
}

// Tracks insertion order for the found list (most recent first)
const foundOrder = [];

function updateFoundList(boroughId, newStreet = null) {
  const header = document.getElementById('found-header');
  const list   = document.getElementById('found-list');
  const { guessed } = state.progress[boroughId];

  if (guessed.size === 0) {
    header.classList.add('hidden');
    list.classList.add('hidden');
    return;
  }

  // Keep insertion order — prepend new street
  if (newStreet && !foundOrder.includes(newStreet)) {
    foundOrder.unshift(newStreet);
  }

  header.classList.remove('hidden');
  list.classList.remove('hidden');
  document.getElementById('found-count').textContent =
    `${guessed.size} street${guessed.size === 1 ? '' : 's'} found`;

  const total = foundOrder.length;
  list.innerHTML = '';
  foundOrder.forEach((name, i) => {
    const row = document.createElement('div');
    row.className = 'found-row';
    row.innerHTML = `
      <span class="found-name">${name}</span>
      <span class="found-num">#${total - i}</span>`;
    list.appendChild(row);
  });

  // Scroll to top so newest entry (#N) is always visible
  if (newStreet) list.scrollTop = 0;
}

function updateDetailPanel() {
  const boroughId = state.activeBorough;
  const { guessed, total } = state.progress[boroughId];
  const count = guessed.size;
  const pct = total > 0 ? 100 * count / total : 0;

  document.getElementById('detail-pct').textContent = formatPct(count, total);
  document.getElementById('detail-bar').style.width = `${pct}%`;
  document.getElementById('detail-bar').style.background = '#1a1a1a';
  document.getElementById('detail-count').textContent =
    `${count} of ${total} streets`;
}

// ── Mobile: tap found-header to show/hide the list ────────────────────────────
document.getElementById('found-header').addEventListener('click', () => {
  if (!isMobile()) return;
  const list   = document.getElementById('found-list');
  const header = document.getElementById('found-header');
  const isHidden = list.classList.toggle('mobile-hidden');
  header.classList.toggle('list-open', !isHidden);
});
