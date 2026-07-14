/* ============================================
   RIVER DETECTIVE — Research Journal Frontend
   Real data only · Leaflet map · Functional UI
   ============================================ */
const API = '/api';
// Keep verified API responses while the visitor moves between views. Pages
// render from this cache immediately, then explicitly live-refresh when needed.
const _apiCache = new Map();
const API_CACHE_TTL = 90 * 1000;
let currentPage = 'dashboard';

function getAuthToken() { return localStorage.getItem('rd_token'); }
function setAuthToken(t) { if (t) localStorage.setItem('rd_token', t); else localStorage.removeItem('rd_token'); }
function getUserId() { return localStorage.getItem('rd_user') || ''; }
function setUserId(u) { if (u) localStorage.setItem('rd_user', u); else localStorage.removeItem('rd_user'); }
let _authUser = '';  // current session user_id, verified by /api/me
let _isAdmin = false;
let _risikoRenderId = 0;
let riskFilter = 'all';
function loadSavedMapSnapshot() {
  try {
    const saved = JSON.parse(localStorage.getItem('rd_map_snapshot') || 'null');
    return saved && Array.isArray(saved.segments) ? saved : { segments: null, locations: null, ts: 0 };
  } catch { return { segments: null, locations: null, ts: 0 }; }
}
function saveMapSnapshot() {
  try { localStorage.setItem('rd_map_snapshot', JSON.stringify(_mapCache)); } catch { /* storage is optional */ }
}
let _mapCache = loadSavedMapSnapshot();
const MAP_CACHE_TTL = 5 * 60 * 1000;

// ===== RISK COLORS =====
const RISK_COLORS = {
  KRITIKAL: '#000000',
  TINGGI:   '#C43B29',
  SEDERHANA: '#B8860B',
  RENDAH:   '#2B6B5B',
};
const RISK_COLORS_SATELLITE = {
  KRITIKAL: '#FF4444',
  TINGGI:   '#FF6644',
  SEDERHANA: '#FFD700',
  RENDAH:   '#90EE90',
};
const RISK_ORDER = ['RENDAH', 'SEDERHANA', 'TINGGI', 'KRITIKAL'];
let _satelliteActive = false;
let _risikoRefreshTimer = null;
const RISIKO_REFRESH_MS = 15000;

function _fitMapToSegments() {
  if (!risiko_map || !risiko_segments.length) return;
  const allLats = risiko_segments.filter(s => s.center).map(s => s.center[0]);
  const allLons = risiko_segments.filter(s => s.center).map(s => s.center[1]);
  if (!allLats.length) return;
  risiko_map.fitBounds([
    [Math.min(...allLats) - 0.005, Math.min(...allLons) - 0.005],
    [Math.max(...allLats) + 0.005, Math.max(...allLons) + 0.005],
  ]);
}

function _openSegmentFromNav(segId, retries) {
  retries = retries || 0;
  if (!risiko_map || !risiko_segments.length) {
    if (retries < 40) setTimeout(() => _openSegmentFromNav(segId, retries + 1), 200);
    return;
  }
  const seg = risiko_segments.find(s => s.id === segId);
  if (!seg) return;
  showSegmentDetail(seg);
  if (seg.center) {
    risiko_map.flyTo([seg.center[0] + alignState.dlat, seg.center[1] + alignState.dlon], 15, { duration: 0.8 });
  }
}

// ===== Location Search =====
let _searchTimer = null;

function _wireLocationSearch() {
  const input = document.getElementById('sim-search-input');
  const resultsDiv = document.getElementById('sim-search-results');
  if (!input || !resultsDiv) return;

  input.addEventListener('input', () => {
    clearTimeout(_searchTimer);
    const q = input.value.trim();
    if (q.length < 3) { resultsDiv.style.display = 'none'; return; }
    _searchTimer = setTimeout(() => _geocodeSearch(q, resultsDiv), 350);
  });

  input.addEventListener('focus', () => {
    if (input.value.trim().length >= 3 && resultsDiv.children.length) resultsDiv.style.display = 'block';
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.sim-search')) resultsDiv.style.display = 'none';
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { resultsDiv.style.display = 'none'; input.blur(); }
  });
}

async function _geocodeSearch(query, resultsDiv) {
  resultsDiv.innerHTML = '<div class="sim-search-loading">Mencari...</div>';
  resultsDiv.style.display = 'block';
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=6&countrycodes=my`;
    const resp = await fetch(url, { headers: { 'Accept': 'application/json' } });
    const data = await resp.json();
    if (!data.length) {
      resultsDiv.innerHTML = '<div class="sim-search-empty">Tiada hasil</div>';
      return;
    }
    resultsDiv.innerHTML = data.map((r, i) => {
      const shortName = r.display_name.length > 60 ? r.display_name.substring(0, 60) + '...' : r.display_name;
      return `<button class="sim-search-item" data-idx="${i}"><span class="sim-search-name">${r.display_name.split(',')[0]}</span><span class="sim-search-addr">${shortName}</span></button>`;
    }).join('');

    resultsDiv.querySelectorAll('.sim-search-item').forEach((btn, i) => {
      btn.onclick = () => {
        const r = data[i];
        const lat = parseFloat(r.lat), lon = parseFloat(r.lon);
        resultsDiv.style.display = 'none';
        document.getElementById('sim-search-input').value = r.display_name.split(',')[0];
        _goToLocation(lat, lon, r.display_name);
      };
    });
  } catch (err) {
    resultsDiv.innerHTML = '<div class="sim-search-empty">Ralat carian</div>';
  }
}

function _goToLocation(lat, lon, name) {
  if (!risiko_map) return;
  risiko_map.flyTo([lat, lon], 15, { duration: 0.8 });

  _search_layer.clearLayers();
  const pin = L.circleMarker([lat, lon], {
    radius: 8, color: '#fff', fillColor: '#6366f1', fillOpacity: 0.9, weight: 3,
  }).addTo(_search_layer);
  pin.bindPopup(`<b>${name.split(',').slice(0, 2).join(',')}</b><div id="search-nearby-info" style="margin-top:4px;font-size:0.65rem">Mengesan segmen berdekatan...</div>`).openPopup();

  setTimeout(() => _findNearbySegments(lat, lon, name), 600);
}

function _findNearbySegments(lat, lon, name) {
  if (!risiko_segments.length) return;
  const toRad = d => d * Math.PI / 180;
  const haversine = (lat1, lon1, lat2, lon2) => {
    const R = 6371000;
    const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  };

  const NEARBY_RADIUS = 2000;
  const nearby = risiko_segments
    .filter(s => s.center && haversine(lat, lon, s.center[0], s.center[1]) < NEARBY_RADIUS)
    .map(s => ({ seg: s, dist: haversine(lat, lon, s.center[0], s.center[1]) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 10);

  _search_layer.clearLayers();
  const pin = L.circleMarker([lat, lon], {
    radius: 8, color: '#fff', fillColor: '#6366f1', fillOpacity: 0.9, weight: 3,
  }).addTo(_search_layer);
  pin.bindPopup(`<b>${name.split(',').slice(0, 2).join(',')}</b><div id="search-nearby-info" style="margin-top:4px;font-size:0.65rem">...</div>`).openPopup();

  const riskColor2 = r => r === 'KRITIKAL' ? '#000' : r === 'TINGGI' ? '#C43B29' : r === 'SEDERHANA' ? '#B8860B' : '#2B6B5B';

  for (const { seg, dist } of nearby) {
    const c = riskColor2(seg.risk_level || 'RENDAH');
    const polyPts = seg.geometry && seg.geometry[0];
    if (polyPts && polyPts.length >= 2) {
      L.polyline(polyPts.map(p => [p[0] + alignState.dlat, p[1] + alignState.dlon]), {
        color: c, weight: 5, opacity: 0.85,
      }).addTo(_search_layer);
    }
    if (seg.center) {
      const m = L.circleMarker([seg.center[0] + alignState.dlat, seg.center[1] + alignState.dlon], {
        radius: 9, color: '#fff', fillColor: c, fillOpacity: 0.75, weight: 2,
      }).addTo(_search_layer);
      m.on('click', () => showSegmentDetail(seg));
      m.bindTooltip(`${seg.name} · ${seg.risk_level} (${seg.risk_score}/100)`, { direction: 'top', offset: [0, -8] });
    }
  }

  const infoEl = document.getElementById('search-nearby-info');
  if (infoEl) {
    const levels = {};
    nearby.forEach(({ seg }) => { const l = seg.risk_level || 'RENDAH'; levels[l] = (levels[l]||0) + 1; });
    const levelStr = Object.entries(levels).map(([l, n]) => `${n} ${l}`).join(', ');
    infoEl.innerHTML = nearby.length
      ? `<b>${nearby.length} segmen</b> dalam ${NEARBY_RADIUS/1000}km<br>${levelStr}<div style="margin-top:4px"><a href="#" onclick="event.preventDefault();document.getElementById('sim-search-input').value='';document.getElementById('sim-search-results').style.display='none'" style="color:#6366f1">Lihat semua →</a></div>`
      : 'Tiada segmen sungai dalam radius ini';
  }

  if (nearby.length) {
    const bounds = L.latLngBounds([[lat, lon]]);
    nearby.forEach(({ seg }) => {
      if (seg.center) bounds.extend([seg.center[0] + alignState.dlat, seg.center[1] + alignState.dlon]);
    });
    risiko_map.fitBounds(bounds, { padding: [50, 50], maxZoom: 15 });
  }
}

// ===== Real-time Auto-Refresh (Peta Risiko) =====
function _startRisikoRefresh() {
  _stopRisikoRefresh();
  _risikoRefreshTimer = setInterval(async () => {
    if (currentPage !== 'risiko' || !risiko_map) { _stopRisikoRefresh(); return; }
    try {
      const segData = await apiGet('/explore/segments?limit=500', true);
      if (currentPage !== 'risiko') return;
      const newSegs = segData.segments || [];
      if (newSegs.length && JSON.stringify(newSegs.map(s => s.risk_level)) !== JSON.stringify(risiko_segments.map(s => s.risk_level))) {
        risiko_segments = newSegs;
        _mapCache.segments = newSegs;
        _mapCache.ts = Date.now();
        saveMapSnapshot();
        renderSegmentsOnMap();
        updateRiskCounts();
        _flashLiveIndicator();
      } else {
        risiko_segments = newSegs.length ? newSegs : risiko_segments;
        _updateLiveTimestamp();
      }
    } catch (e) { /* silent retry next cycle */ }
  }, RISIKO_REFRESH_MS);
}

function _stopRisikoRefresh() {
  if (_risikoRefreshTimer) { clearInterval(_risikoRefreshTimer); _risikoRefreshTimer = null; }
}

function _initLiveIndicator(map) {
  const ctrl = L.control({ position: 'topleft' });
  ctrl.onAdd = function () {
    const div = L.DomUtil.create('div', 'live-indicator');
    div.id = 'live-badge';
    div.innerHTML = '<span class="live-dot"></span> LIVE';
    div.title = 'Data dikemas kini setiap 15 saat';
    return div;
  };
  ctrl.addTo(map);
}

function _flashLiveIndicator() {
  const badge = document.getElementById('live-badge');
  if (!badge) return;
  badge.classList.add('flash');
  setTimeout(() => badge.classList.remove('flash'), 1500);
  _updateLiveTimestamp();
}

function _updateLiveTimestamp() {
  const badge = document.getElementById('live-badge');
  if (!badge) return;
  const now = new Date();
  badge.title = 'Dikemas kini: ' + now.toLocaleTimeString('ms-MY');
}

function updateRiskCounts() {
  const counts = { KRITIKAL: 0, TINGGI: 0, SEDERHANA: 0, RENDAH: 0 };
  for (const s of risiko_segments) {
    const l = s.risk_level || 'RENDAH';
    if (counts[l] !== undefined) counts[l]++;
  }
  for (const [level, count] of Object.entries(counts)) {
    const el = document.getElementById('cnt-' + level.toLowerCase());
    if (el) el.textContent = count;
  }
}

// ===== Router =====
function navigate(page) {
  _stopRisikoRefresh();
  if (page !== 'risiko') _clearRunoffOverlay();
  currentPage = page;
  history.pushState(null, '', '#' + page);
  renderPage(page);
  document.querySelectorAll('.nav-link').forEach(el =>
    el.classList.toggle('active', el.dataset.page === page));
  closeMobile();
}

window.addEventListener('popstate', () => {
  const page = location.hash.replace('#', '') || 'dashboard';
  navigate(page);
});

function closeMobile() {
  document.getElementById('mobile-nav').classList.remove('open');
  document.getElementById('mobile-overlay').classList.remove('open');
}

// ===== Toast =====
function toast(msg, type) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ===== API =====
async function apiGet(path, fresh = false) {
  const cached = _apiCache.get(path);
  if (!fresh && cached && Date.now() - cached.ts < API_CACHE_TTL) return cached.data;
  const headers = {};
  const tok = getAuthToken();
  if (tok) headers['Authorization'] = 'Bearer ' + tok;
  const r = await fetch(API + path, { headers, cache: 'no-store' });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    const msg = Array.isArray(err.detail) ? err.detail.map(d => d.msg).join('; ') : (err.detail || `HTTP ${r.status}`);
    throw new Error(msg);
  }
  const data = await r.json();
  _apiCache.set(path, { ts: Date.now(), data });
  return data;
}

async function apiPost(path, body) {
  const headers = { 'Content-Type': 'application/json' };
  const tok = getAuthToken();
  if (tok) headers['Authorization'] = 'Bearer ' + tok;
  const r = await fetch(API + path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    const msg = Array.isArray(err.detail) ? err.detail.map(d => d.msg).join('; ') : (err.detail || `HTTP ${r.status}`);
    throw new Error(msg);
  }
  const data = await r.json();
  _apiCache.clear();
  return data;
}

// ===== Risk Color Helpers =====
function riskColor(level) {
  const palette = _satelliteActive ? RISK_COLORS_SATELLITE : RISK_COLORS;
  return palette[level] || (_satelliteActive ? '#90EE90' : '#2B6B5B');
}
function riskWeight(level) {
  return level === 'KRITIKAL' ? 4 : level === 'TINGGI' ? 3 : level === 'SEDERHANA' ? 2.5 : 2;
}
function riskOpacity(level) {
  return level === 'KRITIKAL' ? 1 : level === 'TINGGI' ? 0.9 : 0.75;
}
function riskRadius(level) {
  return level === 'KRITIKAL' ? 10 : level === 'TINGGI' ? 8 : level === 'SEDERHANA' ? 6 : 4;
}

// ===== Render Dispatch =====
function renderPage(page) {
  const el = document.getElementById('page-content');
  el.innerHTML = '';
  updateNavAuth();
  switch (page) {
    case 'mission': renderCitizenMission(el); break;
    case 'risiko': renderRisiko(el); break;
    case 'report': renderReport(el); break;
    case 'sahkan': if (!_isAdmin) { navigate('risiko'); return; } renderSahkan(el); break;
    case 'leaderboard': renderLeaderboard(el); break;
    case 'data': renderData(el); break;
    case 'model': renderModelML(el); break;
    case 'profile': renderProfile(el); break;
    case 'login': renderLogin(el); break;
    case 'trend': renderTrend(el); break;
    case 'panduan': renderPanduanSungai(el); break;
    default: renderRisiko(el);
  }
}

// ===== PANDUAN SUNGAI — compact public-facing reference =====
function renderPanduanSungai(el) {
  const tabs = [
    { id: 'intro', label: 'Pengenalan', title: 'Sungai bersih, komuniti lebih selamat', body: 'Pencemaran sungai menjejaskan bekalan air, habitat, kesihatan awam dan daya tahan bandar. River Detective menyokong pengesanan awal supaya tindakan boleh diberi keutamaan.' },
    { id: 'objektif', label: 'Objektif & tujuan', title: 'Daripada data kepada tindakan', body: 'Analisis ini mengenal pasti lokasi berisiko, menjejak kemungkinan punca dan menyokong keputusan pemeriksaan. Tujuannya ialah mencegah insiden, bukan sekadar merekodkannya.' },
    { id: 'jenis', label: 'Jenis pencemaran', title: 'Apa yang boleh mencemarkan sungai?', body: '<ul><li><strong>Fizikal:</strong> sampah, sedimen dan kekeruhan.</li><li><strong>Kimia:</strong> minyak, logam, racun perosak dan bahan pencuci.</li><li><strong>Biologi:</strong> kumbahan, patogen dan nutrien berlebihan.</li></ul>' },
    { id: 'faktor', label: 'Faktor risiko', title: 'Faktor yang meningkatkan risiko', body: '<ul><li>Pelepasan tidak terkawal dari premis dan kerja pembinaan.</li><li>Larian permukaan ketika hujan serta sistem saliran terbeban.</li><li>Guna tanah, kepadatan penduduk dan aktiviti di hulu sungai.</li></ul>' },
    { id: 'bioproses', label: 'Pakar bioproses', title: 'Perspektif kejuruteraan bioproses', body: 'Pakar bioproses menilai beban organik, nutrien, pH, oksigen terlarut dan mikroorganisma. Mereka boleh mencadangkan rawatan seperti proses biologi aerobik/anaerobik, biofilter dan pemulihan berasaskan mikroba—disahkan melalui pensampelan makmal dan pemantauan proses.' },
    { id: 'mbip', label: 'Usaha MBIP', title: 'Keutamaan pengurusan pencemaran MBIP', body: '<ul><li><strong>Kawal punca:</strong> pemeriksaan premis, saliran dan pelepasan mencurigakan.</li><li><strong>Pantau & respons:</strong> guna peta risiko, aduan komuniti dan pensampelan pantas.</li><li><strong>Pulih & cegah:</strong> pembersihan, pendidikan awam dan tindakan bersama agensi berkaitan.</li></ul><p class="guide-note">Cadangan ini menyokong perancangan dan perlu diselaras dengan prosedur serta pihak berkuasa yang berkenaan.</p>' }
  ];
  el.innerHTML = `<section class="page-header guide-header"><div><div class="eyebrow">RUJUKAN RINGKAS · MBIP</div><h1>Panduan Pencemaran Sungai</h1><p class="page-sub">Asas analisis, risiko dan pilihan tindakan dalam satu paparan.</p></div></section><section class="river-guide"><div class="guide-tabs" role="tablist">${tabs.map((tab, i) => `<button class="guide-tab${i === 0 ? ' active' : ''}" data-guide-tab="${tab.id}" role="tab" aria-selected="${i === 0}">${tab.label}</button>`).join('')}</div><article class="guide-panel" id="guide-panel" role="tabpanel"></article></section>`;
  const panel = document.getElementById('guide-panel');
  const showTab = (tab) => {
    panel.innerHTML = `<div class="guide-index">${String(tabs.indexOf(tab) + 1).padStart(2, '0')}</div><div><h2>${tab.title}</h2><div class="guide-copy">${tab.body}</div></div>`;
    document.querySelectorAll('.guide-tab').forEach(btn => { const active = btn.dataset.guideTab === tab.id; btn.classList.toggle('active', active); btn.setAttribute('aria-selected', active); });
  };
  document.querySelectorAll('.guide-tab').forEach(btn => btn.onclick = () => showTab(tabs.find(tab => tab.id === btn.dataset.guideTab)));
  showTab(tabs[0]);
}

// ============================================================
// MISI LIVE — turns the source-prediction model into a judge-friendly story
// ============================================================
async function renderMissionLegacy(el) {
  el.innerHTML = `
    <section class="mission-hero">
      <div>
        <div class="eyebrow">LIVE DECISION STORY · MBIP</div>
        <h1>Daripada air keruh kepada lokasi tindakan.</h1>
        <p>River Detective tidak sekadar memaparkan risiko. Ia membaca isyarat sensor, menganggar punca di hulu, dan menghubungkan bukti itu kepada aset serta komuniti yang perlu dilindungi.</p>
      </div>
      <div class="mission-status"><span class="pulse"></span> SIMULASI INSIDEN AKTIF<br><strong>Kes #RD-24</strong><br><small>Gunakan set bacaan contoh atau ubah sendiri.</small></div>
    </section>
    <section class="case-board">
      <div class="case-intro"><span class="case-number">01</span><div><div class="section-title">Bukti lapangan</div><strong>Jejak anomali sepanjang sungai</strong><p>pH normal: 5.5–8.5 · Kekeruhan normal: bawah 50 NTU</p></div>
        <button class="btn" id="load-case">Muat kes industri</button><button class="btn btn-primary" id="run-case">Siasat punca →</button></div>
      <div id="sensor-inputs" class="mission-sensors"></div>
    </section>
    <section id="mission-result" class="mission-result"><div class="empty"><div class="empty-icon">⌁</div><div class="empty-title">Tunggu bukti sensor untuk membuka jejak punca</div></div></section>
    <section class="story-proof">
      <div><span>01</span><strong>Kesan</strong><p>Sensor mengesan perubahan air yang tidak normal.</p></div>
      <div><span>02</span><strong>Jejak</strong><p>Corak bacaan menunjukkan zon punca paling mungkin.</p></div>
      <div><span>03</span><strong>Tindak</strong><p>Data ArcGIS menyusun bukti dan keutamaan pasukan.</p></div>
    </section>`;

  const sensors = await apiGet('/sensors').catch(() => ({ sensors: [] }));
  const names = sensors.sensors.length ? sensors.sensors : Array.from({length: 10}, (_, i) => ({ id:i, name:`SG-${String(i+1).padStart(2,'0')}` }));
  const grid = document.getElementById('sensor-inputs');
  const defaults = [[7.1,12],[7.0,18],[6.8,38],[4.2,260],[5.1,180],[6.1,92],[6.7,48],[7.0,30],[6.5,75],[6.8,42]];
  grid.innerHTML = names.map((s,i) => `<label class="mission-sensor"><span>${s.name}</span><div><input type="number" step="0.1" min="0" max="14" data-field="ph" data-id="${s.id}" value="${defaults[i]?.[0] || 7}"><small>pH</small></div><div><input type="number" step="1" min="0" data-field="turbidity" data-id="${s.id}" value="${defaults[i]?.[1] || 15}"><small>NTU</small></div></label>`).join('');
  document.getElementById('load-case').onclick = () => { grid.querySelectorAll('input').forEach(input => { const i = +input.dataset.id; input.value = input.dataset.field === 'ph' ? defaults[i][0] : defaults[i][1]; }); toast('Kes industri dimuatkan'); };
  document.getElementById('run-case').onclick = async () => {
    const button = document.getElementById('run-case'); button.disabled = true; button.textContent = 'Menganalisis…';
    const readings = names.map(s => ({ sensor_id:s.name, ph:+grid.querySelector(`[data-field="ph"][data-id="${s.id}"]`).value, turbidity:+grid.querySelector(`[data-field="turbidity"][data-id="${s.id}"]`).value, timestamp:new Date().toISOString() }));
    try {
      const d = await apiPost('/detect', readings);
      const out = document.getElementById('mission-result');
      if (d.status === 'clean') { out.innerHTML = `<div class="result-clean"><strong>Tiada pencemaran dikesan.</strong><span>Purata pH ${d.analysis.ph_avg.toFixed(1)} · ${d.analysis.turbidity_avg.toFixed(0)} NTU</span></div>`; return; }
      const t=d.trace, e=d.enrichment || {}, suspects=(t.top_suspect_sensors||[]).join(' → ');
      const cause = e.pollution_class?.likely_cause || 'Semakan guna tanah diperlukan';
      const asset = e.suspects?.[0] ? `${e.suspects[0].type} · ${Math.round(e.suspects[0].distance_m || 0)}m` : 'Tiada aset terdekat direkodkan';
      const community = e.impact?.population_zone || 'Zon komuniti sedang disemak';
      out.innerHTML = `<div class="result-head"><div><div class="eyebrow">KEPUTUSAN SIASATAN</div><h2>Punca paling mungkin: ${t.upstream_epicenter}</h2><p>Keyakinan ${Math.round(t.confidence)}% · anomali ${d.analysis.severity.toUpperCase()}</p></div><div class="confidence-ring"><strong>${Math.round(t.confidence)}%</strong><span>keyakinan</span></div></div>
      <div class="evidence-flow"><div><small>ISYARAT SENSOR</small><strong>${d.analysis.anomaly_sensors.length} anomali</strong><span>${suspects}</span></div><i>→</i><div><small>ANGGARAN HULU</small><strong>${Math.round(t.estimated_distance_from_head_m)} m</strong><span>dari kepala sungai</span></div><i>→</i><div><small>CADANGAN TINDAKAN</small><strong>Semak zon punca</strong><span>dan maklumkan komuniti</span></div></div>
      <div class="spatial-facts"><div><small>HIPOTESIS PUNCA</small><strong>${cause}</strong></div><div><small>ASET UNTUK DIPERIKSA</small><strong>${asset}</strong></div><div><small>KOMUNITI BERISIKO</small><strong>${community}</strong></div></div>
      <div class="result-note">Ini ialah <strong>decision narrative</strong>: bukan “model meramal”, tetapi bukti yang boleh digunakan pasukan operasi untuk memilih lokasi pemeriksaan pertama.</div>`;
    } catch (err) { document.getElementById('mission-result').innerHTML = `<div class="alert is-bad"><span class="alert-icon">!</span><div><div class="alert-title">Analisis tidak dapat dijalankan</div><div class="alert-body">${err.message}</div></div></div>`; }
    finally { button.disabled=false; button.textContent='Siasat punca →'; }
  };
}

async function renderMission(el) {
  el.innerHTML = `<section class="briefing-hero"><div class="river-current" aria-hidden="true"><i></i><i></i><i></i></div><div class="briefing-copy"><div class="eyebrow">MBIP · RIVER INTELLIGENCE BRIEFING</div><h1>See the river’s risk story before it becomes a crisis.</h1><p>Every figure is calculated from the integrated river network, land use, drainage, community and verified-report records.</p><div class="briefing-meta" id="briefing-meta">Connecting to the evidence register…</div></div><div class="briefing-orbit"><div class="orbit-core"><strong id="briefing-total">—</strong><span>river segments</span></div><span class="orbit-label">LIVE<br>BASELINE</span></div></section><section class="briefing-grid" id="briefing-grid"><div class="loading">Reading verified spatial evidence…</div></section><section class="priority-story"><div class="story-heading"><div><div class="eyebrow">WHERE TO LOOK FIRST</div><h2>Priority river watchlist</h2></div><button class="btn btn-primary" id="open-map">Open evidence map →</button></div><div class="priority-timeline" id="priority-timeline"></div></section><section class="case-board field-board"><div class="case-intro"><span class="case-number">FIELD</span><div><div class="section-title">Verified field reading</div><strong>Trace a source only when real readings are available.</strong><p>Enter measured pH and turbidity from three or more deployed stations. No prefilled scenario is used.</p></div><button class="btn btn-primary" id="run-case">Analyse field readings →</button></div><div id="sensor-inputs" class="mission-sensors"><div class="loading">Loading registered stations…</div></div></section><section id="mission-result" class="mission-result"><div class="empty"><div class="empty-icon">⌁</div><div class="empty-title">No investigation has been run. Results require real submitted measurements.</div></div></section>`;
  document.getElementById('open-map').onclick = () => navigate('risiko');
  const [overview, sensorResponse] = await Promise.all([apiGet('/story/overview'), apiGet('/sensors').catch(() => ({ sensors: [] }))]).catch(() => [null, { sensors: [] }]);
  if (overview) {
    document.getElementById('briefing-total').textContent = overview.total_segments;
    document.getElementById('briefing-meta').textContent = `Validated ${new Date(overview.generated_at).toLocaleString('ms-MY')} · ${overview.geometry_available ? 'authoritative geometry ready' : 'map geometry needs dependency setup'}`;
    const total = Math.max(overview.total_segments, 1), counts = overview.risk_counts;
    document.getElementById('briefing-grid').innerHTML = [['KRITIKAL', counts.KRITIKAL, 'Immediate investigation'], ['TINGGI', counts.TINGGI, 'Active watch'], ['SEDERHANA', counts.SEDERHANA, 'Preventive action'], ['RENDAH', counts.RENDAH, 'Baseline monitoring']].map(([level, value, note]) => `<article class="risk-story-card ${level.toLowerCase()}"><div><span>${level}</span><strong class="count-up" data-value="${value}">0</strong><small>${note}</small></div><div class="evidence-bar"><i style="--evidence-width:${(value / total * 100).toFixed(1)}%"></i></div></article>`).join('') + `<article class="coverage-story-card"><span>Evidence connections</span><strong>${overview.evidence_coverage.land_use_links.toLocaleString()}</strong><small>land-use links · ${overview.evidence_coverage.drainage_links.toLocaleString()} drainage links · ${overview.evidence_coverage.community_links.toLocaleString()} community links</small></article>`;
    document.getElementById('priority-timeline').innerHTML = overview.top_priorities.map((s, i) => `<button class="priority-node" data-segment="${s.id}"><b>0${i + 1}</b><span class="priority-line"></span><div><small>${s.risk_level} · ${s.risk_score}/100</small><strong>${s.name}</strong><p>${s.factors.join(' · ') || 'Spatial risk factors under review'}</p></div></button>`).join('');
    requestAnimationFrame(() => { document.querySelectorAll('.count-up').forEach(n => { const target = +n.dataset.value, start = performance.now(); const tick = now => { const value = Math.round(target * Math.min((now - start) / 700, 1)); n.textContent = value; if (value < target) requestAnimationFrame(tick); }; requestAnimationFrame(tick); }); document.querySelectorAll('.evidence-bar i').forEach(b => b.classList.add('revealed')); });
    document.querySelectorAll('.priority-node').forEach(btn => btn.onclick = () => {
      const segId = +btn.dataset.segment;
      navigate('risiko');
      _openSegmentFromNav(segId);
    });
  } else document.getElementById('briefing-grid').innerHTML = '<div class="alert is-bad">Evidence briefing is unavailable. Check the local service configuration.</div>';
  const names = sensorResponse.sensors || [], grid = document.getElementById('sensor-inputs');
  grid.innerHTML = names.length ? names.map(s => `<label class="mission-sensor"><span>${s.name}</span><div><input required type="number" step="0.1" min="0" max="14" data-field="ph" data-id="${s.id}" placeholder="—"><small>measured pH</small></div><div><input required type="number" step="1" min="0" data-field="turbidity" data-id="${s.id}" placeholder="—"><small>measured NTU</small></div></label>`).join('') : '<div class="empty">No registered sensor model is available in this environment.</div>';
  document.getElementById('run-case').onclick = async () => {
    const readings = names.map(s => ({ sensor_id:s.name, ph:+grid.querySelector(`[data-field="ph"][data-id="${s.id}"]`).value, turbidity:+grid.querySelector(`[data-field="turbidity"][data-id="${s.id}"]`).value, timestamp:new Date().toISOString() })).filter(r => Number.isFinite(r.ph) && Number.isFinite(r.turbidity));
    if (readings.length < 3) { toast('Enter measured pH and turbidity for at least three stations.'); return; }
    const button = document.getElementById('run-case'); button.disabled = true; button.textContent = 'Analysing evidence…';
    try { const d = await apiPost('/detect', readings); const out = document.getElementById('mission-result'); if (d.status === 'clean') { out.innerHTML = `<div class="result-clean"><strong>No anomaly detected.</strong><span>Measured average: pH ${d.analysis.ph_avg.toFixed(1)} · ${d.analysis.turbidity_avg.toFixed(0)} NTU</span></div>`; return; } const t = d.trace, e = d.enrichment || {}; out.innerHTML = `<div class="result-head"><div><div class="eyebrow">EVIDENCE-BASED INVESTIGATION</div><h2>Likely upstream origin: ${t.upstream_epicenter}</h2><p>${t.method} · ${d.analysis.severity.toUpperCase()} anomaly</p></div><div class="confidence-ring"><strong>${Math.round(t.confidence)}%</strong><span>confidence</span></div></div><div class="evidence-flow"><div><small>MEASURED SIGNAL</small><strong>${d.analysis.anomaly_sensors.length} anomalies</strong><span>${t.top_suspect_sensors.join(' → ')}</span></div><i>→</i><div><small>UPSTREAM ESTIMATE</small><strong>${Math.round(t.estimated_distance_from_head_m)} m</strong><span>from river head</span></div><i>→</i><div><small>FIRST ACTION</small><strong>Inspect nearby drainage</strong><span>${e.pollution_class?.likely_cause || 'land-use review required'}</span></div></div><div class="result-note">Inference, not proof: this result prioritises the first inspection location and must be confirmed in the field.</div>`; } catch (err) { document.getElementById('mission-result').innerHTML = `<div class="alert is-bad">${err.message}</div>`; } finally { button.disabled = false; button.textContent = 'Analyse field readings →'; }
  };
}

async function renderCitizenMission(el) {
  el.innerHTML = `
    <section class="mission-section mission-dashboard scroll-reveal" data-step="PAPAN PEMUKA">
      <div class="mission-section-head"><span>01</span><div><small>GAMBARAN SEMASA</small><h2>Papan pemuka utama</h2><p>Ringkasan status sungai, lokasi keutamaan dan data semasa sistem.</p></div></div>
      <section class="briefing-hero citizen-hero mission-live-hero">
      <div class="river-current" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
      <div class="mission-pulse-grid" aria-hidden="true"><span></span><span></span><span></span></div>
      <div class="briefing-copy">
        <div class="eyebrow">MBIP · PUSAT MISI SUNGAI</div>
        <h1>Daripada bukti sungai kepada tindakan komuniti.</h1>
        <p>Ikuti bagaimana sistem membaca data sungai, saliran, guna tanah, laporan komuniti, model risiko dan larian permukaan untuk membantu membuat keputusan lebih awal.</p>
        <div id="citizen-meta" class="briefing-meta">Memuatkan bukti semasa…</div>
      </div>
      <div class="briefing-orbit mission-orbit"><div class="orbit-core"><strong id="citizen-risk">—</strong><span>lokasi keutamaan</span></div><span class="orbit-label">AWAS<br>KOMUNITI</span></div>
      </section>
    </section>

    <section class="mission-section mission-story scroll-reveal" data-step="ALIRAN SISTEM">
      <div class="mission-section-head"><span>02</span><div><small>CERITA SISTEM</small><h2>Bagaimana sistem membuat penilaian</h2><p>Aliran data dari bukti mentah kepada tindakan lapangan.</p></div></div>
      <div class="mission-story-rail" aria-hidden="true"><i></i></div>
      <div class="mission-scroll-guide">
        <div><span>01</span><h3>Kumpul Bukti</h3><p>Data sungai, guna tanah, paip/parit, komuniti dan laporan disatukan dalam satu sistem.</p></div>
        <div><span>02</span><h3>Kira Risiko</h3><p>Model heuristik, ML asal dan model custom menilai risiko setiap segmen sungai.</p></div>
        <div><span>03</span><h3>Simulasi & Runoff</h3><p>Simulasi pencemaran dan larian permukaan membantu memahami pergerakan risiko.</p></div>
        <div><span>04</span><h3>Tindakan</h3><p>Pengguna boleh semak peta, hantar laporan, dan fokus kepada lokasi keutamaan.</p></div>
      </div>
    </section>

    <section class="mission-section mission-actions scroll-reveal" data-step="TINDAKAN">
      <div class="mission-section-head"><span>03</span><div><small>TINDAKAN PENGGUNA</small><h2>Apa yang pengguna boleh buat sekarang</h2><p>Pilih tindakan berdasarkan keadaan sebenar di lapangan.</p></div></div>
      <div class="citizen-action-grid" id="citizen-actions"><div class="loading">Menyediakan maklumat sungai tempatan anda…</div></div>
    </section>

    <section class="mission-section mission-watchlist scroll-reveal" data-step="KEUTAMAAN">
      <div class="mission-section-head"><span>04</span><div><small>SENARAI KEUTAMAAN</small><h2>Tempat yang perlu diberi perhatian dahulu</h2><p>Segmen dengan risiko tertinggi dipaparkan sebagai senarai pemerhatian hari ini.</p></div></div>
      <div class="priority-story"><div class="story-heading"><div><div class="eyebrow">SENARAI HARI INI</div><h2>Senarai risiko</h2></div><button class="btn btn-primary" id="citizen-map">Teroka peta bukti →</button></div><div class="priority-timeline" id="citizen-priority"></div></div>
    </section>

    <section class="mission-section mission-guide-block scroll-reveal" data-step="PANDUAN">
      <div class="mission-section-head"><span>05</span><div><small>PANDUAN SISTEM</small><h2>Cara membaca River Detective</h2><p>Gunakan panduan ini sebelum masuk ke peta dan analisis terperinci.</p></div></div>
      <div class="mission-system-guide">
        <div class="guide-copy"><div class="eyebrow">PANDUAN SISTEM</div><h2>Halaman utama sistem</h2><p>Setiap halaman mempunyai peranan jelas dalam aliran pemantauan sungai.</p></div>
        <div class="guide-steps">
          <article><b>Peta Risiko</b><span>Lihat skor, faktor risiko, carian lokasi, GPS, satelit dan simulasi pencemaran.</span></article>
          <article><b>Trend</b><span>Lihat perubahan agregat risiko daripada snapshot sejarah.</span></article>
          <article><b>Model ML</b><span>Latih model risiko atau larian permukaan menggunakan ciri drag-and-drop.</span></article>
          <article><b>Laporan</b><span>Hantar bukti sebenar untuk pengesahan dan tindakan komuniti.</span></article>
        </div>
      </div>
    </section>

    <section class="mission-section mission-guide-block scroll-reveal" data-step="KOMUNITI">
      <div class="mission-section-head"><span>06</span><div><small>PANDUAN KOMUNITI</small><h2>Peranan pengguna dalam sistem</h2><p>Ringkasan tingkah laku yang sistem mahu dorong kepada pengguna awam.</p></div></div>
      <div class="citizen-explainer"><div><span>LIHAT</span><h3>Semak sesuatu tempat</h3><p>Buka peta untuk memahami saliran, guna tanah dan pendedahan komuniti berdekatan — bukan amaran umum.</p></div><div><span>LAPORKAN</span><h3>Kongsi bukti sebenar</h3><p>Hantar gambar, masa dan lokasi hanya bila anda melihat isyu sungai sebenar. Laporan akan disahkan terlebih dahulu.</p></div><div><span>IKUTI</span><h3>Jejak tindakan</h3><p>Pantau laporan yang disahkan dan perubahan risiko; sistem memisahkan bukti yang diperhatikan daripada ramalan.</p></div></div>
    </section>

    <section class="mission-section mission-team-section scroll-reveal" data-step="PASUKAN">
      <div class="mission-section-head"><span>07</span><div><small>PASUKAN PEMBANGUN</small><h2>EnviroMind | UTM</h2><p>Pasukan yang membangunkan River Detective.</p></div></div>
      <div class="team-showcase"><div><div class="eyebrow">PASUKAN PEMBANGUN</div><h2>EnviroMind | UTM</h2><p>Sistem River Detective dibangunkan untuk menyokong pemantauan pencemaran sungai berasaskan data, komuniti dan kecerdasan buatan.</p></div>
        <div class="team-grid"><article>NORLILA BINTI AMIN CHNG</article><article>NG WEI FENG</article><article>CHEK CHEE HIM</article></div></div>
    </section>`;
  const overview = await apiGet('/story/overview').catch(() => null);
  if (!overview) { document.getElementById('citizen-actions').innerHTML = '<div class="alert is-bad">Bukti semasa tidak tersedia. Sila cuba lagi.</div>'; return; }
  const criticalWatch = overview.risk_counts.KRITIKAL + overview.risk_counts.TINGGI;
  document.getElementById('citizen-risk').textContent = criticalWatch;
  document.getElementById('citizen-meta').textContent = `Dikemas kini ${new Date(overview.generated_at).toLocaleString('ms-MY')} · ${overview.total_segments} segmen sungai dipeta`;
  document.getElementById('citizen-actions').innerHTML = `<button class="citizen-action report-action" id="citizen-report"><span class="action-icon">!</span><div><small>JIKA ANDA NAMPAK PENCEMARAN</small><strong>Laporkan apa yang anda lihat</strong><p>Gambar + lokasi + penerangan. Laporan anda akan disahkan sebelum mempengaruhi gambaran risiko.</p></div><b>Lapor →</b></button><button class="citizen-action map-action" id="citizen-view-map"><span class="action-icon">⌖</span><div><small>SEBELUM PERGI KE SUNGAI</small><strong>Semak bukti risiko tempatan</strong><p>${criticalWatch} lokasi kritikal/keutamaan tinggi dikenal pasti daripada bukti spatial.</p></div><b>Lihat peta →</b></button><button class="citizen-action evidence-action" id="citizen-trend"><span class="action-icon">✓</span><div><small>APA YANG SISTEM TAHU</small><strong>${overview.reports.verified} laporan komuniti disahkan</strong><p>${overview.evidence_coverage.drainage_links.toLocaleString()} pautan saliran dan ${overview.evidence_coverage.community_links.toLocaleString()} pautan komuniti menyokong siasatan.</p></div><b>Lihat trend →</b></button>`;
  const go = page => () => navigate(page); document.getElementById('citizen-report').onclick = go('report'); document.getElementById('citizen-view-map').onclick = go('risiko'); document.getElementById('citizen-map').onclick = go('risiko'); document.getElementById('citizen-trend').onclick = go('trend');
  document.getElementById('citizen-priority').innerHTML = overview.top_priorities.map((s, i) => `<button class="priority-node" data-sid="${s.id}"><b>0${i + 1}</b><div><small>${s.risk_level} · ${s.risk_score}/100</small><strong>${s.name}</strong><p>${s.factors.join(' · ') || 'Faktor spatial sedang dikaji'}</p></div></button>`).join('');
  document.querySelectorAll('#citizen-priority .priority-node').forEach(btn => btn.onclick = () => {
    const segId = +btn.dataset.sid;
    navigate('risiko');
    _openSegmentFromNav(segId);
  });
}

function updateNavAuth() {
  const loginEl = document.getElementById('nav-login');
  const userEl = document.getElementById('nav-user');
  if (!loginEl || !userEl) return;
  if (_authUser) {
    loginEl.style.display = 'none';
    userEl.style.display = 'inline';
    userEl.textContent = '👤 ' + _authUser + ' [Log Keluar]';
    userEl.style.cursor = 'pointer';
    userEl.onclick = async () => {
      try { await apiPost('/logout'); } catch {}
      setAuthToken('');
      setUserId('');
      _authUser = '';
      updateNavAuth();
      toast('Log keluar berjaya');
      navigate('risiko');
    };
    document.querySelectorAll('[data-page="profile"]').forEach(el => { if (el.tagName === 'A') el.style.display = ''; });
  } else {
    loginEl.style.display = '';
    userEl.style.display = 'none';
    document.querySelectorAll('[data-page="profile"]').forEach(el => { if (el.tagName === 'A') el.style.display = 'none'; });
  }
  document.querySelectorAll('[data-page="sahkan"]').forEach(el => {
    if (el.tagName === 'A') el.style.display = _isAdmin ? '' : 'none';
  });
}

// ============================================================
//  LOGIN — Auth page
// ============================================================
function renderLogin(el) {
  el.innerHTML = `
    <div class="page-header">
      <h2>Log Masuk</h2>
      <div class="page-sub">Daftar akaun atau log masuk untuk menyertai</div>
    </div>
    <div style="max-width:360px;margin:1rem auto">
      <div style="display:flex;gap:0;margin-bottom:0.75rem">
        <button class="btn login-tab active" data-tab="login" style="flex:1;border-radius:0;text-align:center">Log Masuk</button>
        <button class="btn login-tab" data-tab="register" style="flex:1;border-radius:0;text-align:center">Daftar</button>
      </div>
      <div id="login-form">
        <div class="form-group">
          <label>ID Pengguna</label>
          <input class="form-input" id="auth-user" placeholder="cth: ali123">
        </div>
        <div class="form-group">
          <label>Kata Laluan</label>
          <input class="form-input" id="auth-pass" type="password" placeholder="Minimum 4 aksara">
        </div>
        <button class="btn btn-primary" id="btn-auth" style="width:100%">Log Masuk</button>
        <div id="auth-result" style="margin-top:0.5rem"></div>
      </div>
    </div>
  `;

  let mode = 'login';

  document.querySelectorAll('.login-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.login-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      mode = tab.dataset.tab;
      document.getElementById('btn-auth').textContent = mode === 'login' ? 'Log Masuk' : 'Daftar Akaun';
    });
  });

  document.getElementById('btn-auth').addEventListener('click', async () => {
    const uid = document.getElementById('auth-user').value.trim();
    const pwd = document.getElementById('auth-pass').value.trim();
    const resEl = document.getElementById('auth-result');
    if (!uid || !pwd) { resEl.innerHTML = '<div class="mono" style="color:var(--alert);font-size:0.65rem">Sila isi semua ruangan</div>'; return; }
    try {
      const endpoint = mode === 'login' ? '/login' : '/register';
      const d = await apiPost(endpoint, { user_id: uid, password: pwd });
      setAuthToken(d.token);
      setUserId(d.user_id);
      _authUser = d.user_id;
      // Fetch admin status
      try { const me = await apiGet('/me'); _isAdmin = !!me.is_admin; } catch { _isAdmin = false; }
      updateNavAuth();
      resEl.innerHTML = '<div class="mono" style="color:var(--good);font-size:0.65rem">' + d.message + '</div>';
      setTimeout(() => navigate('risiko'), 600);
    } catch (e) {
      resEl.innerHTML = '<div class="mono" style="color:var(--alert);font-size:0.65rem">' + e.message + '</div>';
    }
  });
}


// ============================================================
//  SAHKAN — Verify Reports
// ============================================================
async function renderSahkan(el) {
  el.innerHTML = `
    <div class="page-header">
      <h2>Sahkan Laporan</h2>
      <div class="page-sub">Bantu komuniti mengesahkan laporan pencemaran</div>
    </div>
    ${_isAdmin ? `
    <div style="border:1px solid var(--border);padding:0.5rem 0.7rem;margin-bottom:0.5rem;background:var(--bg-card)">
      <div class="section-title">Panel Admin</div>
      <div style="display:flex;gap:0.75rem;flex-wrap:wrap;align-items:end">
        <div>
          <label style="font-size:0.6rem">Auto-Sah Threshold (0 = mati)</label>
          <div style="display:flex;gap:0.25rem;align-items:center">
            <input class="form-input" id="admin-threshold" type="number" min="0" max="100" value="0" style="width:60px;font-size:0.6rem">
            <span class="mono" style="font-size:0.55rem">%</span>
            <button class="btn" id="btn-set-threshold" style="font-size:0.55rem;padding:0.15rem 0.4rem">Set</button>
          </div>
        </div>
        <div>
          <label style="font-size:0.6rem">Model ML (Data Sebenar)</label>
          <div style="display:flex;gap:0.25rem;align-items:center">
            <span class="mono" id="ml-mode-label" style="font-size:0.6rem">...</span>
            <button class="btn" id="btn-toggle-ml-admin" style="font-size:0.55rem;padding:0.15rem 0.4rem">Tukar</button>
          </div>
        </div>
        <div>
          <label style="font-size:0.6rem">Padam Pengguna</label>
          <div style="display:flex;gap:0.25rem">
            <input class="form-input" id="admin-del-user" placeholder="ID pengguna" style="width:120px;font-size:0.6rem">
            <button class="btn" id="btn-del-user" style="font-size:0.55rem;padding:0.15rem 0.4rem;border-color:var(--alert);color:var(--alert)">Padam</button>
          </div>
        </div>
      </div>
      <div id="admin-msg" style="margin-top:0.3rem;font-size:0.6rem"></div>
    </div>
    ` : ''}
    <div class="section-title">Laporan Menunggu Pengesahan</div>
    <div id="sahkan-list">
      <div class="loading">Memuatkan ...</div>
    </div>
  `;

  if (_isAdmin) {
    // Load config
    let mlMode = 'heuristic';
    let cfg = null;
    try {
      cfg = await apiGet('/admin/config');
      document.getElementById('admin-threshold').value = cfg.auto_sah_threshold || 0;
      mlMode = cfg.ml_model_mode || 'heuristic';
    } catch {}
    const mlLabel = document.getElementById('ml-mode-label');
    const mlAvailable = cfg && cfg.ml_available === true;
    if (mlLabel) {
      if (!mlAvailable) mlLabel.textContent = 'Tidak tersedia';
      else mlLabel.textContent = mlMode === 'ml' ? 'ML (R²=0.95)' : 'Heuristik';
    }
    const mlBtn = document.getElementById('btn-toggle-ml-admin');
    if (mlBtn && !mlAvailable) mlBtn.style.display = 'none';
    if (mlBtn) mlBtn.addEventListener('click', async () => {
      const newMode = mlMode === 'ml' ? 'heuristic' : 'ml';
      await apiPost('/model/ml_mode', { mode: newMode });
      toast(`Model ML: ${newMode === 'ml' ? 'Diaktifkan' : 'Heuristik'}`);
      renderSahkan(el);
    });
    document.getElementById('btn-set-threshold').addEventListener('click', async () => {
      const val = document.getElementById('admin-threshold').value;
      try {
        await apiPost('/admin/config', { key: 'auto_sah_threshold', value: String(parseInt(val) || 0) });
        document.getElementById('admin-msg').innerHTML = '<span class="mono" style="color:var(--good)">Threshold dikemas kini</span>';
      } catch (e) {
        document.getElementById('admin-msg').innerHTML = `<span class="mono" style="color:var(--alert)">${e.message}</span>`;
      }
    });
    document.getElementById('btn-del-user').addEventListener('click', async () => {
      const target = document.getElementById('admin-del-user').value.trim();
      if (!target || target === 'admin') { document.getElementById('admin-msg').innerHTML = '<span class="mono" style="color:var(--alert)">ID tidak sah</span>'; return; }
      if (!confirm(`Padam pengguna "${target}"?`)) return;
      try {
        const d = await apiPost('/admin/delete-user', { target_user_id: target });
        document.getElementById('admin-msg').innerHTML = `<span class="mono" style="color:var(--good)">${d.message}</span>`;
      } catch (e) {
        document.getElementById('admin-msg').innerHTML = `<span class="mono" style="color:var(--alert)">${e.message}</span>`;
      }
    });
  }

  try {
    let data;
    try {
      data = await apiGet('/reports/pending');
      if (currentPage !== 'sahkan') return;
    } catch (e) {
      data = { total: 0, reports: [] };
    }
    const container = document.getElementById('sahkan-list');
    if (data.total === 0) {
      container.innerHTML = '<div class="empty" style="padding:1rem"><div class="empty-icon">✓</div><div class="empty-title">Tiada laporan menunggu pengesahan</div></div>';
      return;
    }
    container.innerHTML = data.reports.map(r => `
      <div class="report-card" style="border:1px solid var(--border);padding:0.5rem 0.7rem;margin-bottom:0.4rem;background:var(--bg-card)">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:0.25rem">
          <div>
            <div style="font-weight:600;font-size:0.8rem">${r.segment_name || 'Segmen ' + r.segment_id}</div>
            <div class="mono" style="font-size:0.6rem">${r.user_id} · ${r.severity}</div>
          </div>
          <div style="display:flex;gap:0.3rem;align-items:center">
            <span class="mono" style="font-size:0.55rem">${r.verifications || 0} pengesahan</span>
            ${_isAdmin ? `
            <input class="form-input" id="sahkan-user-${r.id}" value="${_authUser}" placeholder="ID pengguna" style="width:100px;font-size:0.6rem;padding:0.15rem 0.3rem">
            <button class="btn" style="font-size:0.6rem;padding:0.15rem 0.4rem" data-rid="${r.id}" data-action="verify">Sahkan</button>
            <button class="btn" style="font-size:0.6rem;padding:0.15rem 0.4rem;border-color:var(--alert);color:var(--alert)" data-rid="${r.id}" data-action="reject">Batalkan</button>
            ` : '<span class="mono" style="font-size:0.55rem;color:var(--ink-muted)">Admin sahaja boleh sahkan</span>'}
          </div>
        </div>
        <div class="mono" style="font-size:0.55rem;color:var(--ink-muted);margin-top:0.15rem">${(r.description || '').substring(0,120)}</div>
        <div style="display:flex;gap:0.4rem;align-items:center;margin-top:0.3rem;flex-wrap:wrap">
          ${r.ai_suggestion ? `
            <span class="pill" style="font-size:0.5rem;background:${r.ai_suggestion === 'sahkan' ? 'var(--good-light)' : 'var(--alert-light)'};border-color:${r.ai_suggestion === 'sahkan' ? 'var(--good)' : 'var(--alert)'}">
              AI: ${r.ai_suggestion} (${r.ai_confidence || '?'}%)
            </span>
            <span class="mono" style="font-size:0.5rem;color:var(--ink-dim);max-width:320px;word-break:break-word;overflow-wrap:break-word">${(r.ai_reason || '').substring(0,400)}</span>
          ` : '<span class="mono" style="font-size:0.5rem;color:var(--ink-dim)">AI screening tidak tersedia</span>'}
          ${r.image_path ? `<a href="/uploads/${r.image_path}" target="_blank" class="mono" style="font-size:0.5rem;color:var(--ink-dim);text-decoration:underline;cursor:pointer">📷 Ada gambar</a>` : ''}
        </div>
      </div>
    `).join('');
    container.querySelectorAll('[data-rid]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const rid = parseInt(btn.dataset.rid);
        const action = btn.dataset.action || 'verify';
        if (action === 'reject') {
          const uid = document.getElementById('sahkan-user-' + rid)?.value?.trim();
          if (!uid) { toast('Sila masukkan ID pengguna'); return; }
          try {
            const d = await apiPost('/reject', { user_id: uid, report_id: rid });
            toast(d.message);
            renderSahkan(el);
          } catch (e) {
            toast('Ralat: ' + e.message);
          }
          return;
        }
        const uid = document.getElementById('sahkan-user-' + rid)?.value?.trim();
        if (!uid) { toast('Sila masukkan ID pengguna'); return; }
        try {
          const d = await apiPost('/verify', { user_id: uid, report_id: rid });
          toast(d.message);
          renderSahkan(el);
        } catch (e) {
          toast('Ralat: ' + e.message);
        }
      });
    });
  } catch (e) {
    const sl = document.getElementById('sahkan-list');
    if (sl) sl.innerHTML = `<div class="alert is-bad"><span class="alert-icon">!</span><div><div class="alert-body">${e.message}</div></div></div>`;
  }
}

// ============================================================
//  REPORT
// ============================================================
function renderReport(el) {
  const userId = _authUser || getUserId();
  el.innerHTML = `
    <div class="page-header">
      <h2>Laporan Pencemaran</h2>
      <div class="page-sub">Laporkan kejadian pencemaran sungai untuk tindakan lanjut</div>
    </div>
    ${!_authUser ? '<div class="alert is-warn" style="margin-bottom:0.5rem"><span class="alert-icon">!</span><div><div class="alert-title">Belum log masuk</div><div class="alert-body"><a href="#login" style="color:var(--alert);text-decoration:underline">Log masuk</a> untuk menghantar laporan dan mendapat mata ekologi.</div></div></div>' : ''}

    <div style="display:grid;grid-template-columns:1fr 280px;gap:0.75rem">
      <div>
        <div class="section-title">Butiran Laporan</div>
        <div class="form-group">
          <label>Nama / ID Pengguna</label>
          <input class="form-input" id="rpt-user" value="${userId}" placeholder="cth: ali123">
        </div>
        <div class="form-group">
          <label>Huraian Pencemaran</label>
          <textarea class="form-input" id="rpt-desc" placeholder="Nyatakan lokasi, jenis pencemaran, warna air, bau, dsb."></textarea>
        </div>
        <div class="form-group">
          <label>Gambar Rujukan (pilihan)</label>
          <input type="file" class="form-input" id="rpt-photo" accept="image/*" style="font-size:0.65rem;padding:0.3rem">
          <div id="rpt-photo-preview" style="margin-top:0.3rem;max-width:200px;display:none"></div>
        </div>
        <div style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap">
          <button class="btn" id="btn-get-loc" type="button" style="font-size:0.65rem">📡 GPS</button>
          <span class="mono" id="rpt-loc-display" style="font-size:0.6rem;color:var(--ink-muted)">Klik peta atau GPS</span>
          <span style="font-size:0.55rem;color:var(--ink-dim)" id="rpt-loc-method"></span>
        </div>
        <div style="margin-top:0.4rem">
          <button class="btn btn-primary" id="btn-report">Hantar Laporan</button>
        <div id="report-result"></div>
      </div>
      <div>
        <div class="section-title">Tanda Lokasi</div>
        <div class="map-wrap">
          <div class="map-inner" id="rpt-map" style="height:340px"></div>
        </div>
        <div style="font-size:0.55rem;color:var(--ink-dim);margin-top:0.25rem">Klik pada peta untuk pin lokasi</div>
      </div>
    </div>
  `;

  let rptLat = null, rptLon = null, rptMarker = null;

  setTimeout(() => {
    const rptMap = L.map('rpt-map', { zoomControl: false }).setView([1.5, 103.6], 11);
    L.control.zoom({ position: 'topright' }).addTo(rptMap);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OSM', maxZoom: 19,
    }).addTo(rptMap);
    addSatelliteToggle(rptMap);

    function setRptLocation(lat, lon, method) {
      rptLat = lat; rptLon = lon;
      document.getElementById('rpt-loc-display').textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
      document.getElementById('rpt-loc-method').textContent = method;
      if (rptMarker) rptMap.removeLayer(rptMarker);
      rptMarker = L.marker([lat, lon], { draggable: true }).addTo(rptMap);
      rptMarker.on('dragend', () => {
        const p = rptMarker.getLatLng();
        setRptLocation(p.lat, p.lng, 'dilaras');
      });
      rptMap.setView([lat, lon], rptMap.getZoom());
      // Fetch nearest segment name from all segments list
      apiGet('/explore/segments?limit=500').then(d => {
        let best = null, bestDist = Infinity;
        for (const s of d.segments || []) {
          const c = s.center;
          if (!c) continue;
          const dlat = c[0] - lat, dlon = c[1] - lon;
          const dist = Math.sqrt(dlat*dlat + dlon*dlon);
          if (dist < bestDist) { bestDist = dist; best = s; }
        }
        if (best && bestDist < 0.02) {
          document.getElementById('rpt-loc-method').textContent = method + ' → Seg' + best.id;
        }
      }).catch(() => {});
    }

    rptMap.on('click', e => setRptLocation(e.latlng.lat, e.latlng.lng, 'pin manual'));
    setTimeout(() => rptMap.invalidateSize(), 200);

    document.getElementById('btn-get-loc').addEventListener('click', () => {
      if (!navigator.geolocation) { toast('Geolokasi tidak disokong'); return; }
      navigator.geolocation.getCurrentPosition(
        pos => { setRptLocation(pos.coords.latitude, pos.coords.longitude, 'GPS'); toast('Lokasi diperolehi'); },
        () => toast('Gagal mendapat lokasi. Cuba lagi.'),
        { enableHighAccuracy: true, timeout: 10000 }
      );
    });
  }, 50);

  // Photo preview
  document.getElementById('rpt-photo')?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    const preview = document.getElementById('rpt-photo-preview');
    if (!file) { preview.style.display = 'none'; return; }
    const reader = new FileReader();
    reader.onload = (ev) => {
      preview.innerHTML = `<img src="${ev.target.result}" style="max-width:100%;max-height:120px;border:1px solid var(--border);border-radius:2px">`;
      preview.style.display = 'block';
    };
    reader.readAsDataURL(file);
  });

  document.getElementById('btn-report').addEventListener('click', async () => {
    const user = document.getElementById('rpt-user').value.trim();
    if (!user) { toast('Sila masukkan nama pengguna'); return; }
    const desc = document.getElementById('rpt-desc').value.trim() || 'Tiada huraian';
    if (!rptLat) { toast('Sila tandakan lokasi di peta atau guna GPS'); return; }
    localStorage.setItem('rd_user', user);
    const btn = document.getElementById('btn-report');
    btn.disabled = true;
    btn.textContent = 'Menghantar ...';
    // Get photo base64
    let photoBase64 = null;
    const photoInput = document.getElementById('rpt-photo');
    if (photoInput?.files?.[0]) {
      try {
        photoBase64 = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result);
          r.onerror = reject;
          r.readAsDataURL(photoInput.files[0]);
        });
      } catch (e) { photoBase64 = null; }
    }
    try {
      const d = await apiPost('/report', {
        user_id: user, photo_description: desc,
        location_lat: rptLat, location_lon: rptLon,
        photo_base64: photoBase64,
      });
      document.getElementById('report-result').innerHTML = `
        <div class="result-box is-clean" style="margin-top:0.5rem">
          <div style="display:flex;align-items:center;gap:0.75rem;flex-wrap:wrap">
            <span style="font-size:1.5rem">✓</span>
            <div>
              <div style="font-weight:600;color:var(--good)">Laporan Diterima</div>
              <div class="mono">${d.message}</div>
            </div>
          </div>
          <div class="divider"></div>
          <table class="data-table">
            <tbody>
              <tr><td>Mata diperoleh</td><td style="font-weight:600">+${d.points_earned}</td></tr>
              <tr><td>Jumlah mata</td><td>${d.total_points}</td></tr>
              <tr><td>Ketepatan</td><td>${d.trace_accuracy}</td></tr>
              <tr><td>Pokok bakau tersedia</td><td style="color:var(--good);font-weight:600">${d.mangrove_trees_available}</td></tr>
            </tbody>
          </table>
          ${d.badges_earned.length ? `<div style="margin-top:0.4rem;display:flex;gap:0.3rem;flex-wrap:wrap">${d.badges_earned.map(b => `<span class="badge" style="background:var(--accent-dim)">${b.name}</span>`).join('')}</div>` : ''}
          ${d.imelc_recommendation ? `<div style="margin-top:0.4rem;font-size:0.75rem"><span class="mono">IMELC: ${d.imelc_recommendation.priority || 'RENDAH'}</span> ${(d.imelc_recommendation.recommended_species||[]).map(s => `<span class="tree-chip">${s}</span>`).join('')}</div>` : ''}
        </div>`;
      toast('Laporan berjaya! +' + d.points_earned + ' mata');
    } catch (e) { toast('Ralat: ' + e.message); }
    finally { btn.disabled = false; btn.textContent = 'Hantar Laporan'; }
  });
}

// ============================================================
//  LEADERBOARD
// ============================================================
async function renderLeaderboard(el) {
  el.innerHTML = `
    <div class="page-header">
      <h2>Papan Pemimpin</h2>
      <div class="page-sub">Pengguna paling aktif memulihara sungai</div>
    </div>

    <div class="stat-row" id="lb-stats"></div>

    <div class="section-title">Kedudukan</div>
    <table class="data-table lb-table">
      <thead><tr><th>#</th><th>Pengguna</th><th>Mata</th><th>Laporan</th><th>Badge</th></tr></thead>
      <tbody id="lb-body"></tbody>
    </table>
  `;

  try {
    const data = await apiGet('/leaderboard');
    if (currentPage !== 'leaderboard') return;
    const totalPts = data.leaderboard.reduce((s, u) => s + u.points, 0);
    const totalRpt = data.leaderboard.reduce((s, u) => s + u.reports, 0);
    const totalBdg = data.leaderboard.reduce((s, u) => s + (u.badges || []).length, 0);

    document.getElementById('lb-stats').innerHTML = `
      <div class="stat-box"><div class="stat-num">${data.leaderboard.length}</div><div class="stat-label">Pengguna</div></div>
      <div class="stat-box"><div class="stat-num">${totalPts}</div><div class="stat-label">Jumlah Mata</div></div>
      <div class="stat-box"><div class="stat-num">${totalRpt}</div><div class="stat-label">Jumlah Laporan</div></div>
      <div class="stat-box"><div class="stat-num">${totalBdg}</div><div class="stat-label">Badge</div></div>
    `;

    const tbody = document.getElementById('lb-body');
    if (data.leaderboard.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--ink-muted);padding:1rem">Belum ada peserta. Buat laporan pertama!</td></tr>';
    } else {
      tbody.innerHTML = data.leaderboard.map((u, i) =>
        `<tr>
          <td class="rank">${i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : u.rank}</td>
          <td>${u.user_id}</td>
          <td style="font-weight:600">${u.points}</td>
          <td>${u.reports}</td>
          <td>${(u.badges || []).map(b => `<span class="pill">${b}</span>`).join(' ')}</td>
        </tr>`
      ).join('');
    }
  } catch (e) {
    const bodyEl = document.getElementById('lb-body');
    if (bodyEl) bodyEl.innerHTML = `<tr><td colspan="5" style="color:var(--alert);padding:0.5rem">✗ ${e.message}</td></tr>`;
  }
}

// ============================================================
//  DATA
// ============================================================
async function renderData(el) {
  el.innerHTML = `
    <div class="page-header">
      <h2>Data Bersepadu</h2>
      <div class="page-sub">Semua dataset MBIP yang diintegrasikan</div>
    </div>

    <div class="stat-row" id="data-stats">
      <div class="stat-box"><div class="stat-num">—</div><div class="stat-label">Segmen Sungai</div></div>
      <div class="stat-box"><div class="stat-num">—</div><div class="stat-label">Guna Tanah</div></div>
      <div class="stat-box"><div class="stat-num">—</div><div class="stat-label">Paip/Parit</div></div>
      <div class="stat-box"><div class="stat-num">—</div><div class="stat-label">Populasi</div></div>
      <div class="stat-box"><div class="stat-num">—</div><div class="stat-label">Komuniti</div></div>
    </div>

    <div class="section-title">Sumber Data</div>
    <table class="data-table">
      <thead><tr><th></th><th>Sumber</th><th>Kuantiti</th></tr></thead>
      <tbody id="data-sources"></tbody>
    </table>
  `;

  try {
    const s = await apiGet('/data/summary');
    if (currentPage !== 'data') return;
    const stats = [
      s.total_river_segments,
      s.segments_with_land_use_data,
      s.segments_with_nearby_pipes,
      s.segments_with_population_data,
      s.segments_with_community_centers,
    ];
    document.querySelectorAll('#data-stats .stat-num').forEach((el, i) => {
      el.textContent = stats[i];
    });

    document.getElementById('data-sources').innerHTML = s.data_sources.map(src => {
      const icon = src.includes('Sungai') ? '🌊' : src.includes('Gunatanah') ? '🗺' : src.includes('Paip') || src.includes('Parit') ? '🔧' : src.includes('Balai') ? '👮' : src.includes('Penduduk') ? '👥' : src.includes('Komuniti') ? '🏫' : src.includes('Perumahan') ? '🏠' : src.includes('Pokok') ? '🌳' : src.includes('Topografi') ? '⛰' : src.includes('NDCDB') ? '📐' : src.includes('Hutan') ? '🌲' : '📊';
      const name = src.split('(')[0].trim();
      const detail = src.match(/\(([^)]+)\)/);
      return `<tr><td>${icon}</td><td>${name}</td><td>${detail ? detail[1] : ''}</td></tr>`;
    }).join('');
  } catch (e) {
    const srcEl = document.getElementById('data-sources');
    if (srcEl) srcEl.innerHTML = `<tr><td colspan="3" style="color:var(--alert);padding:0.5rem">✗ ${e.message}</td></tr>`;
  }
}

// ============================================================
//  MODEL ML — Feature Selection, Training & Deployment
// ============================================================
let _modelFeatures = [];
let _modelCategories = {};
let _selectedFeatureIds = new Set();
let _modelDragEl = null;

async function renderModelML(el) {
  el.innerHTML = `
    <div class="page-header">
      <h2>Model ML</h2>
      <div class="page-sub">Semua model ramalan risiko — maklumat, ciri, ketepatan</div>
    </div>
    <div id="model-ml-content" style="opacity:0.5;pointer-events:none">
      <div class="loading">Memuatkan maklumat model ...</div>
    </div>
  `;
  let modelsData, featData, evalData;
  try {
    [modelsData, featData, evalData] = await Promise.all([
      apiGet('/model/available'),
      apiGet('/model/features'),
      apiGet('/model/eval'),
    ]);
  } catch (e) {
    document.getElementById('model-ml-content').innerHTML = `<div style="color:var(--alert);padding:1rem">✗ Gagal memuatkan: ${e.message}</div>`;
    return;
  }
  if (currentPage !== 'model') return;
  _modelFeatures = featData.features;
  _modelCategories = featData.categories;
  _selectedFeatureIds = new Set(featData.current_features || []);
  _renderModelMLPage(modelsData, evalData);
}

function _modelCardHtml(m, isActive, evalData) {
  const fid_to_def = {};
  _modelFeatures.forEach(f => { fid_to_def[f.id] = f; });
  const accent = isActive ? 'var(--accent)' : 'var(--border)';
  const borderW = isActive ? '2px' : '1px';
  let r2 = m.metrics?.r2;
  let rmse = m.metrics?.rmse;
  let mae = m.metrics?.mae;
  let scoreStats = null;
  if (m.id === 'heuristic' && evalData?.heuristic) {
    const h = evalData.heuristic;
    r2 = h.r2_vs_ml; rmse = h.rmse_vs_ml; mae = h.mae_vs_ml;
    scoreStats = { mean: h.score_mean, std: h.score_std, min: h.score_min, max: h.score_max, median: h.score_median, levels: h.level_counts, n: h.n_segments };
  } else if (m.id === 'pretrained' && evalData?.ml_asal) {
    const ml = evalData.ml_asal;
    r2 = ml.r2; rmse = ml.rmse; mae = ml.mae;
  } else if (m.id === 'custom' && evalData?.ml_custom) {
    const c = evalData.ml_custom;
    r2 = c.r2; rmse = c.rmse; mae = c.mae;
  }
  const accColor = r2 == null ? 'var(--ink-dim)' : r2 >= 0.7 ? 'var(--good)' : r2 >= 0.4 ? 'var(--warn)' : 'var(--alert)';

  let featPreview = '';
  if (m.feature_names && m.feature_names.length > 0) {
    const shown = m.feature_names.slice(0, 6);
    const rest = m.feature_names.length - shown.length;
    featPreview = shown.join(', ');
    if (rest > 0) featPreview += ` (+${rest} lagi)`;
  } else if (m.type === 'heuristic') {
    featPreview = 'Formula berat tetap — jarak paip, guna tanah, pusat komuniti';
  }

  let impHtml = '';
  if (m.importances && Object.keys(m.importances).length > 0) {
    const sorted = Object.entries(m.importances).slice(0, 5);
    const maxImp = sorted[0][1] || 1;
    impHtml = '<div style="margin-top:0.35rem">';
    for (const [fid, imp] of sorted) {
      const fdef = fid_to_def[fid];
      const label = fdef ? fdef.name : fid;
      const pctBar = Math.round(imp * 100 / maxImp);
      impHtml += `<div style="display:flex;align-items:center;gap:0.25rem;margin:0.08rem 0">
        <span class="mono" style="font-size:0.48rem;width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${fid}">${label}</span>
        <div style="flex:1;height:3px;background:#e2e2e2;border-radius:2px;overflow:hidden"><div style="width:${pctBar}%;height:100%;background:${accent};border-radius:2px"></div></div>
        <span class="mono" style="font-size:0.43rem;color:var(--ink-dim)">${imp.toFixed(3)}</span>
      </div>`;
    }
    impHtml += '</div>';
  }

  return `
    <div class="ml-model-card" data-model-id="${m.id}" style="border:${borderW} solid ${accent};border-radius:8px;padding:0.6rem;margin-bottom:0.5rem;background:var(--bg);transition:border-color 0.2s,box-shadow 0.2s;${isActive ? 'box-shadow:0 0 0 3px color-mix(in srgb, var(--accent) 15%, transparent)' : ''}">
      <div style="display:flex;justify-content:space-between;align-items:start;gap:0.5rem;flex-wrap:wrap">
        <div style="flex:1;min-width:200px">
          <div style="display:flex;align-items:center;gap:0.4rem;flex-wrap:wrap">
            <span class="mono" style="font-size:0.75rem;font-weight:600">${m.name}</span>
            ${isActive ? '<span class="mono" style="font-size:0.5rem;padding:0.1rem 0.4rem;background:var(--accent);color:#fff;border-radius:10px">AKTIF</span>' : ''}
          </div>
          <div style="font-size:0.6rem;color:var(--ink-dim);margin-top:0.15rem;line-height:1.4">${m.description}</div>
        </div>
        <div style="display:flex;gap:0.5rem;flex-shrink:0;flex-wrap:wrap">
          <div style="text-align:center;min-width:50px">
            <div class="mono" style="font-size:0.75rem;font-weight:600;color:${accColor}">${r2 != null ? r2.toFixed(3) : '—'}</div>
            <div class="mono" style="font-size:0.45rem;color:var(--ink-dim)">R²</div>
          </div>
          <div style="text-align:center;min-width:50px">
            <div class="mono" style="font-size:0.75rem;font-weight:500">${rmse != null ? rmse.toFixed(2) : '—'}</div>
            <div class="mono" style="font-size:0.45rem;color:var(--ink-dim)">RMSE</div>
          </div>
          <div style="text-align:center;min-width:50px">
            <div class="mono" style="font-size:0.75rem;font-weight:500">${mae != null ? mae.toFixed(2) : '—'}</div>
            <div class="mono" style="font-size:0.45rem;color:var(--ink-dim)">MAE</div>
          </div>
        </div>
      </div>
      <div style="margin-top:0.35rem">
        <div class="mono" style="font-size:0.5rem;color:var(--ink-dim)">${m.n_features} ciri digunakan</div>
        <div style="font-size:0.55rem;color:var(--ink-muted);margin-top:0.1rem;font-style:italic">${featPreview}</div>
      </div>
      ${scoreStats ? `
      <div style="margin-top:0.35rem;padding:0.4rem 0.5rem;background:var(--bg-subtle);border-radius:6px;border:1px solid var(--border)">
        <div class="mono" style="font-size:0.5rem;font-weight:600;margin-bottom:0.2rem">📊 Taburan Skor Heuristik (${scoreStats.n} segmen)</div>
        <div style="display:flex;gap:0.6rem;flex-wrap:wrap;font-size:0.5rem">
          <span>Min: <b class="mono">${scoreStats.min.toFixed(1)}</b></span>
          <span>Max: <b class="mono">${scoreStats.max.toFixed(1)}</b></span>
          <span>Purata: <b class="mono">${scoreStats.mean.toFixed(1)}</b></span>
          <span>Sisihan Piawai: <b class="mono">${scoreStats.std.toFixed(1)}</b></span>
        </div>
        <div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-top:0.15rem;font-size:0.5rem">
          <span>RENDAH: <b class="mono" style="color:var(--good)">${scoreStats.levels?.RENDAH || 0}</b></span>
          <span>SEDERHANA: <b class="mono" style="color:var(--warn)">${scoreStats.levels?.SEDERHANA || 0}</b></span>
          <span>TINGGI: <b class="mono" style="color:#e67e22">${scoreStats.levels?.TINGGI || 0}</b></span>
          <span>KRITIKAL: <b class="mono" style="color:var(--alert)">${scoreStats.levels?.KRITIKAL || 0}</b></span>
        </div>
      </div>` : ''}
      ${impHtml}
      ${!isActive ? `<div style="margin-top:0.4rem"><button class="btn ml-deploy-card-btn" data-model-id="${m.id}" style="font-size:0.55rem;padding:0.2rem 0.5rem;background:var(--accent);color:#fff;border-color:var(--accent)">🚀 Aktifkan Model Ini</button></div>` : ''}
      ${_isAdmin && m.id === 'custom' ? `<div style="margin-top:0.35rem"><button class="btn ml-delete-model-btn" data-model-id="custom" style="font-size:0.55rem;padding:0.2rem 0.5rem;border-color:var(--alert);color:var(--alert)">Padam Model Custom</button></div>` : ''}
    </div>`;
}

function _runoffModelCardsHtml(modelsData) {
  const custom = modelsData.runoff_custom_model;
  if (_runoffModel === 'custom' && !custom) {
    _runoffModel = 'hybrid';
    localStorage.setItem('rd_runoff_model', _runoffModel);
  }
  const models = [
    {
      id: 'hybrid',
      name: 'Hibrid (SCS-CN + Infrastruktur)',
      tag: 'Seimbang',
      description: 'Gabungan guna tanah, saliran, kecerunan proksi dan akumulasi hulu.',
      why: 'Pilih ini untuk gambaran operasi paling seimbang apabila anda mahu melihat sumber larian dan titik akumulasi serentak.',
    },
    {
      id: 'scs',
      name: 'SCS-CN Guna Tanah',
      tag: 'Guna Tanah',
      description: 'Menekankan koefisien larian permukaan daripada jenis guna tanah berhampiran sungai.',
      why: 'Pilih ini apabila fokus utama ialah kesan permukaan tidak telap seperti industri, komersial dan perumahan.',
    },
    {
      id: 'infrastructure',
      name: 'Infrastruktur Saliran',
      tag: 'Paip/Parit',
      description: 'Menekankan paip, parit dan aliran terkumpul dari segmen hulu.',
      why: 'Pilih ini untuk siasatan rangkaian saliran, limpahan longkang, atau kawasan hilir yang menerima aliran terkumpul.',
    },
  ];
  if (custom) {
    models.push({
      id: 'custom',
      name: 'Model Custom Larian Permukaan',
      tag: 'Dilatih Pengguna',
      description: `RandomForest daripada ${custom.n_features || 0} ciri pilihan. R² ${custom.r2}, RMSE ${custom.rmse}, MAE ${custom.mae}.`,
      why: 'Pilih ini apabila anda mahu larian permukaan mengikut ciri yang anda sendiri latih melalui drag-and-drop.',
    });
  }
  return `<div class="runoff-model-grid">${models.map(m => `
    <button class="runoff-model-card ${m.id === _runoffModel ? 'active' : ''}" data-runoff-model="${m.id}">
      <span class="runoff-model-tag">${m.tag}</span>
      <strong>${m.name}</strong>
      <p>${m.description}</p>
      <small>${m.why}</small>
      <b>${m.id === _runoffModel ? '✓ Dipilih' : 'Pilih model ini →'}</b>
    </button>
  `).join('')}</div>`;
}

function _selectedRunoffModelSummaryHtml(modelsData) {
  const custom = modelsData.runoff_custom_model;
  const modelNames = {
    hybrid: 'Hibrid (SCS-CN + Infrastruktur)',
    scs: 'SCS-CN Guna Tanah',
    infrastructure: 'Infrastruktur Saliran',
    custom: 'Model Custom Larian Permukaan',
  };
  const modelDesc = {
    hybrid: 'Model formula seimbang. Tiada R²/RMSE/MAE kerana ia bukan model ML terlatih.',
    scs: 'Model formula guna tanah. Tiada R²/RMSE/MAE kerana ia bukan model ML terlatih.',
    infrastructure: 'Model formula saliran. Tiada R²/RMSE/MAE kerana ia bukan model ML terlatih.',
    custom: custom ? `Model ML terlatih. R² ${custom.r2?.toFixed ? custom.r2.toFixed(3) : custom.r2} · RMSE ${custom.rmse?.toFixed ? custom.rmse.toFixed(2) : custom.rmse} · MAE ${custom.mae?.toFixed ? custom.mae.toFixed(2) : custom.mae} · ${custom.n_features} ciri` : 'Model custom belum dilatih.',
  };
  return `<div class="runoff-selected-summary">
    <b class="mono">Model Larian Permukaan</b>
    <strong>${modelNames[_runoffModel] || modelNames.hybrid}</strong>
    <span>${modelDesc[_runoffModel] || modelDesc.hybrid}</span>
    ${_isAdmin && custom ? `<button class="btn ml-delete-model-btn" data-model-id="runoff_custom" style="font-size:0.55rem;padding:0.2rem 0.5rem;border-color:var(--alert);color:var(--alert)">Padam Model Custom Runoff</button>` : ''}
  </div>`;
}

function _renderModelMLPage(modelsData, evalData) {
  const ct = document.getElementById('model-ml-content');
  if (!ct) return;
  ct.style.opacity = '1';
  ct.style.pointerEvents = 'auto';

  const models = modelsData.models || [];
  const activeId = modelsData.active_model_id;
  if (_runoffModel === 'custom' && !modelsData.runoff_custom_model) {
    _runoffModel = 'hybrid';
    localStorage.setItem('rd_runoff_model', _runoffModel);
  }

  let cardsHtml = models.map(m => _modelCardHtml(m, m.id === activeId, evalData)).join('');

  ct.innerHTML = `
    <div class="section-title">Model Risiko</div>
    <div id="ml-model-list">${cardsHtml}</div>

    <div style="margin-top:0.95rem">
      <div class="section-title">Pilih Model Larian Permukaan</div>
      <div style="font-size:0.72rem;color:var(--ink-dim);margin:-0.25rem 0 0.55rem;line-height:1.5">
        Pilih model yang akan digunakan oleh lapisan <b>Larian Permukaan</b> di Peta Risiko. Setiap model memberi penekanan analisis yang berbeza.
      </div>
      ${_selectedRunoffModelSummaryHtml(modelsData)}
      ${_runoffModelCardsHtml(modelsData)}
    </div>

    <div style="margin-top:0.75rem">
      <div class="section-title">Latihan Model Custom</div>
      <div style="font-size:0.62rem;color:var(--ink-dim);line-height:1.45;margin:-0.25rem 0 0.5rem">
        Seret dan lepaskan ciri daripada <b>Ciri Tersedia</b> ke <b>Ciri Dipilih</b>, kemudian klik <b>Latih Model</b>. Model RandomForest akan dilatih hanya menggunakan ciri yang dipilih.
      </div>
      <div style="display:flex;gap:0.5rem;margin-bottom:0.5rem;flex-wrap:wrap">
        <label class="mono" style="font-size:0.58rem;color:var(--ink-muted);display:flex;align-items:center;gap:0.3rem">
          Sasaran
          <select id="ml-train-target" style="padding:0.25rem 0.45rem;border:1px solid var(--border);border-radius:5px;background:var(--bg);font-family:var(--font-mono);font-size:0.58rem">
            <option value="risk" selected>Risiko Sungai</option>
            <option value="runoff">Larian Permukaan</option>
          </select>
        </label>
        <button class="btn" id="ml-select-all" style="font-size:0.6rem;padding:0.25rem 0.6rem">Pilih Semua</button>
        <button class="btn" id="ml-clear-all" style="font-size:0.6rem;padding:0.25rem 0.6rem">Kosongkan</button>
        <button class="btn" id="ml-quick-geo" style="font-size:0.6rem;padding:0.25rem 0.6rem">Geografi + Infrastruktur</button>
        <button class="btn" id="ml-quick-lu" style="font-size:0.6rem;padding:0.25rem 0.6rem">Guna Tanah Sahaja</button>
        <span style="flex:1"></span>
        <button class="btn primary" id="ml-train-btn" style="font-size:0.65rem;padding:0.3rem 0.8rem;background:var(--accent);color:#fff;border-color:var(--accent)">
          ▶ Latih Model
        </button>
      </div>

      <div id="ml-progress-wrap" style="display:none;margin-bottom:0.5rem">
        <div style="display:flex;justify-content:space-between;font-size:0.6rem;margin-bottom:0.15rem">
          <span class="mono" id="ml-progress-label">Melatih model ...</span>
          <span class="mono" id="ml-progress-pct">0%</span>
        </div>
        <div style="background:#e2e2e2;border-radius:4px;height:8px;overflow:hidden">
          <div id="ml-progress-bar" style="width:0%;height:100%;background:var(--accent);border-radius:4px;transition:width 0.3s ease"></div>
        </div>
      </div>

      <div id="ml-result" style="display:none;margin-bottom:0.5rem"></div>

      <div style="display:flex;gap:0.75rem;flex-wrap:wrap;align-items:flex-start">
        <div style="flex:1;min-width:280px">
          <div class="section-title" style="font-size:0.6rem">Ciri Tersedia</div>
          <div id="ml-available" class="ml-feature-list"></div>
        </div>
        <div style="flex:1;min-width:280px">
          <div class="section-title" style="font-size:0.6rem">Ciri Dipilih <span id="ml-sel-count" style="font-weight:400;font-size:0.6rem;color:var(--ink-dim)"></span></div>
          <div id="ml-selected" class="ml-feature-list ml-selected-list"></div>
        </div>
      </div>
    </div>

    <div style="margin-top:0.75rem">
      <div class="section-title">Ulasan AI tentang Kombinasi Ciri</div>
      <div id="ml-ai-commentary" style="font-size:0.65rem;color:var(--ink-dim);padding:0.5rem;background:var(--bg-subtle);border-radius:6px;min-height:60px;border:1px solid var(--border)">
        Pilih ciri dan klik "Latih Model" untuk mendapat ulasan AI ...
      </div>
    </div>
  `;

  _renderFeatureLists();
  _wireModelMLEvents();

  ct.querySelectorAll('.ml-deploy-card-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = '⏳ ...';
      try {
        const r = await apiPost('/model/deploy', { model_id: btn.dataset.modelId });
        toast(r.message);
        renderModelML(document.getElementById('page-content'));
      } catch (e) {
        toast('Ralat: ' + e.message);
        btn.disabled = false;
        btn.textContent = '🚀 Aktifkan Model Ini';
      }
    });
  });
  ct.querySelectorAll('.ml-delete-model-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const label = btn.dataset.modelId === 'runoff_custom' ? 'model custom larian permukaan' : 'model custom risiko';
      if (!confirm('Padam ' + label + '? Tindakan ini hanya untuk admin dan tidak boleh dibatalkan.')) return;
      btn.disabled = true;
      try {
        const r = await apiPost('/model/delete', { model_id: btn.dataset.modelId });
        if (btn.dataset.modelId === 'runoff_custom' && _runoffModel === 'custom') {
          _runoffModel = 'hybrid';
          localStorage.setItem('rd_runoff_model', _runoffModel);
        }
        toast(r.message);
        renderModelML(document.getElementById('page-content'));
      } catch (e) {
        toast('Ralat: ' + e.message);
        btn.disabled = false;
      }
    });
  });
  ct.querySelectorAll('.runoff-model-card').forEach(btn => {
    btn.addEventListener('click', () => {
      _runoffModel = btn.dataset.runoffModel;
      localStorage.setItem('rd_runoff_model', _runoffModel);
      toast('Model Larian Permukaan dipilih: ' + btn.querySelector('strong')?.textContent);
      _renderModelMLPage(modelsData, evalData);
    });
  });
}

function _renderFeatureLists() {
  const availEl = document.getElementById('ml-available');
  const selEl = document.getElementById('ml-selected');
  if (!availEl || !selEl) return;

  const catEntries = Object.entries(_modelCategories);
  let availHtml = '';
  let selHtml = '';

  for (const [cat, feats] of catEntries) {
    const availFeats = feats.filter(f => !_selectedFeatureIds.has(f.id));
    const selFeats = feats.filter(f => _selectedFeatureIds.has(f.id));

    if (availFeats.length > 0) {
      availHtml += `<div class="ml-cat-group"><div class="ml-cat-title">${cat}</div>`;
      for (const f of availFeats) {
        availHtml += `<div class="ml-feat-item" draggable="true" data-fid="${f.id}" title="${f.description}">
          <span class="ml-feat-drag">⋮⋮</span>
          <span class="ml-feat-name">${f.name}</span>
          <span class="ml-feat-add">+</span>
        </div>`;
      }
      availHtml += '</div>';
    }

    if (selFeats.length > 0) {
      selHtml += `<div class="ml-cat-group"><div class="ml-cat-title">${cat}</div>`;
      for (const f of selFeats) {
        selHtml += `<div class="ml-feat-item selected" draggable="true" data-fid="${f.id}" title="${f.description}">
          <span class="ml-feat-drag">⋮⋮</span>
          <span class="ml-feat-name">${f.name}</span>
          <span class="ml-feat-remove">✕</span>
        </div>`;
      }
      selHtml += '</div>';
    }
  }

  if (!availHtml) availHtml = '<div style="font-size:0.6rem;color:var(--ink-dim);padding:0.5rem">Semua ciri telah dipilih</div>';
  if (!selHtml) selHtml = '<div style="font-size:0.6rem;color:var(--ink-dim);padding:0.5rem">Seret ciri ke sini atau klik +</div>';

  availEl.innerHTML = availHtml;
  selEl.innerHTML = selHtml;
  document.getElementById('ml-sel-count').textContent = `(${_selectedFeatureIds.size})`;

  availEl.querySelectorAll('.ml-feat-item').forEach(item => {
    item.addEventListener('click', (e) => {
      if (e.target.classList.contains('ml-feat-drag')) return;
      _selectedFeatureIds.add(item.dataset.fid);
      _renderFeatureLists();
    });
    item.addEventListener('dragstart', (e) => {
      _modelDragEl = item.dataset.fid;
      item.style.opacity = '0.4';
      e.dataTransfer.effectAllowed = 'move';
    });
    item.addEventListener('dragend', () => { item.style.opacity = '1'; });
  });

  selEl.querySelectorAll('.ml-feat-item').forEach(item => {
    item.addEventListener('click', (e) => {
      if (e.target.classList.contains('ml-feat-drag')) return;
      _selectedFeatureIds.delete(item.dataset.fid);
      _renderFeatureLists();
    });
    item.addEventListener('dragstart', (e) => {
      _modelDragEl = item.dataset.fid;
      item.style.opacity = '0.4';
      e.dataTransfer.effectAllowed = 'move';
    });
    item.addEventListener('dragend', () => { item.style.opacity = '1'; });
  });

  [availEl, selEl].forEach(zone => {
    zone.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; zone.classList.add('ml-drop-hover'); });
    zone.addEventListener('dragleave', () => { zone.classList.remove('ml-drop-hover'); });
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('ml-drop-hover');
      if (!_modelDragEl) return;
      const isAvail = zone.id === 'ml-available';
      if (isAvail) _selectedFeatureIds.delete(_modelDragEl);
      else _selectedFeatureIds.add(_modelDragEl);
      _modelDragEl = null;
      _renderFeatureLists();
    });
  });
}

function _wireModelMLEvents() {
  document.getElementById('ml-select-all')?.addEventListener('click', () => {
    _selectedFeatureIds = new Set(_modelFeatures.map(f => f.id));
    _renderFeatureLists();
  });
  document.getElementById('ml-clear-all')?.addEventListener('click', () => {
    _selectedFeatureIds.clear();
    _renderFeatureLists();
  });
  document.getElementById('ml-quick-geo')?.addEventListener('click', () => {
    _selectedFeatureIds = new Set(_modelFeatures.filter(f => ['Infrastruktur', 'Komuniti', 'Geografi'].includes(f.category)).map(f => f.id));
    _renderFeatureLists();
  });
  document.getElementById('ml-quick-lu')?.addEventListener('click', () => {
    _selectedFeatureIds = new Set(_modelFeatures.filter(f => f.category.startsWith('Guna Tanah')).map(f => f.id));
    _renderFeatureLists();
  });
  document.getElementById('ml-train-btn')?.addEventListener('click', () => _trainModel());
}

async function _trainModel() {
  if (_selectedFeatureIds.size < 3) { toast('Pilih sekurang-kurangnya 3 ciri'); return; }
  const wrap = document.getElementById('ml-progress-wrap');
  const bar = document.getElementById('ml-progress-bar');
  const label = document.getElementById('ml-progress-label');
  const pct = document.getElementById('ml-progress-pct');
  const result = document.getElementById('ml-result');
  const trainBtn = document.getElementById('ml-train-btn');
  const target = document.getElementById('ml-train-target')?.value || 'risk';
  wrap.style.display = 'block';
  result.style.display = 'none';
  trainBtn.disabled = true;
  trainBtn.textContent = '⏳ Melatih ...';

  const stages = [
    { p: 15, t: 'Mengira ciri ...' },
    { p: 35, t: 'Menyediakan data latihan ...' },
    { p: 55, t: 'Melatih RandomForest ...' },
    { p: 75, t: 'Menilai ketepatan (CV) ...' },
    { p: 90, t: 'Menyimpan model ...' },
  ];
  let si = 0;
  const iv = setInterval(() => {
    if (si < stages.length) {
      bar.style.width = stages[si].p + '%';
      label.textContent = stages[si].t;
      pct.textContent = stages[si].p + '%';
      si++;
    }
  }, 200);

  try {
    const r = await apiPost('/model/train', { feature_ids: Array.from(_selectedFeatureIds), target });
    clearInterval(iv);
    bar.style.width = '100%';
    pct.textContent = '100%';
    label.textContent = 'Selesai!';

    const accColor = r.r2 >= 0.7 ? 'var(--good)' : r.r2 >= 0.4 ? 'var(--warn)' : 'var(--alert)';

    let impHtml = '';
    if (r.importances && Object.keys(r.importances).length > 0) {
      const sorted = Object.entries(r.importances).sort((a, b) => b[1] - a[1]).slice(0, 8);
      const maxImp = sorted[0][1] || 1;
      impHtml = '<div style="margin-top:0.4rem"><div class="mono" style="font-size:0.55rem;color:var(--ink-dim)">Kepentingan Ciri (Top 8):</div>';
      for (const [fid, imp] of sorted) {
        const fdef = _modelFeatures.find(f => f.id === fid);
        const pctBar = Math.round(imp * 100 / maxImp);
        impHtml += `<div style="display:flex;align-items:center;gap:0.3rem;margin:0.1rem 0">
          <span class="mono" style="font-size:0.5rem;width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${fid}">${fdef ? fdef.name : fid}</span>
          <div style="flex:1;height:4px;background:#e2e2e2;border-radius:2px;overflow:hidden"><div style="width:${pctBar}%;height:100%;background:var(--accent);border-radius:2px"></div></div>
          <span class="mono" style="font-size:0.45rem;color:var(--ink-dim)">${imp.toFixed(3)}</span>
        </div>`;
      }
      impHtml += '</div>';
    }

    result.innerHTML = `
      <div style="padding:0.5rem;background:var(--bg-subtle);border-radius:6px;border:1px solid var(--border)">
        <div class="mono" style="font-size:0.65rem;font-weight:500;color:var(--good)">✓ Model ${r.target === 'runoff' ? 'Larian Permukaan' : 'Risiko Sungai'} berjaya dilatih</div>
        <div style="font-size:0.6rem;margin-top:0.2rem">
          <span class="mono">R² = </span><span class="mono" style="color:${accColor};font-weight:600">${r.r2.toFixed(4)}</span>
          <span class="mono" style="margin-left:0.5rem">RMSE = ${r.rmse.toFixed(2)}</span>
          <span class="mono" style="margin-left:0.5rem">MAE = ${r.mae.toFixed(2)}</span>
          <span class="mono" style="margin-left:0.5rem;color:var(--ink-dim)">${r.n_features} ciri · ${r.n_segments} segmen</span>
        </div>
        ${impHtml}
        ${r.target === 'runoff' ? `<div style="margin-top:0.4rem;font-size:0.58rem;color:var(--ink-dim)">Model ini kini tersedia sebagai pilihan <b>Model Custom Larian Permukaan</b>. Senarai model akan dikemas kini sebentar lagi.</div>` : `<div style="margin-top:0.4rem"><button class="btn ml-deploy-card-btn" data-model-id="custom" style="font-size:0.55rem;padding:0.2rem 0.5rem;background:var(--good);color:#fff;border-color:var(--good)">🚀 Aktifkan Model Custom Ini</button></div>`}
      </div>
    `;
    result.style.display = 'block';

    if (r.target === 'runoff') {
      _runoffModel = 'custom';
      localStorage.setItem('rd_runoff_model', _runoffModel);
      setTimeout(() => renderModelML(document.getElementById('page-content')), 900);
    }

    result.querySelectorAll('.ml-deploy-card-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true; btn.textContent = '⏳ ...';
        try {
          const dr = await apiPost('/model/deploy', { model_id: 'custom' });
          toast(dr.message);
          renderModelML(document.getElementById('page-content'));
        } catch (e) { toast('Ralat: ' + e.message); btn.disabled = false; btn.textContent = '🚀 Aktifkan Model Custom Ini'; }
      });
    });

    _getAICommentary();
  } catch (e) {
    clearInterval(iv);
    bar.style.width = '100%';
    bar.style.background = 'var(--alert)';
    label.textContent = 'Ralat!';
    pct.textContent = '✗';
    result.innerHTML = `<div style="padding:0.5rem;color:var(--alert);font-size:0.65rem">✗ ${e.message}</div>`;
    result.style.display = 'block';
  } finally {
    trainBtn.disabled = false;
    trainBtn.textContent = '▶ Latih Model';
  }
}

async function _getAICommentary() {
  const box = document.getElementById('ml-ai-commentary');
  if (!box) return;
  box.innerHTML = '<span class="mono" style="color:var(--ink-dim)">🤖 AI sedang menganalisis kombinasi ciri ...</span>';
  try {
    const r = await apiPost('/model/ai-commentary', { feature_ids: Array.from(_selectedFeatureIds) });
    box.innerHTML = `<div style="white-space:pre-wrap;line-height:1.5">${r.commentary}</div>`;
  } catch (e) {
    box.innerHTML = `<span style="color:var(--alert)">✗ Ralat: ${e.message}</span>`;
  }
}

// ============================================================
//  PETA RISIKO — River Segment Map + Alignment Controls
// ============================================================
let alignState = { dlat: 0, dlon: 0, stepDeg: 0.00045 };
let risiko_segments = [];
let risiko_map = null;
let risiko_layer = null;
let report_layer = null;
let report_layer_visible = true;
let sim_layer = null;
let _search_layer = null;
let _runoff_layer = null;
let riscoMarkers = null;
let lastSelected = null;

async function renderRisiko(el) {
  const renderId = ++_risikoRenderId;
  el.innerHTML = `
    <div class="page-header">
      <h2>Peta Risiko Pencemaran Sungai</h2>
      <div class="page-sub">376 segmen sungai MBIP — skor risiko berdasarkan data bersepadu</div>
    </div>

    <div id="risiko-toolbar" style="display:flex;gap:0.35rem;flex-wrap:wrap;align-items:center;margin-bottom:0.55rem">
      <button class="filter-btn active" data-risk="all">Semua</button>
      <button class="filter-btn" data-risk="KRITIKAL" style="border-color:#000;color:#000">KRITIKAL <span class="risk-count" id="cnt-kritikal"></span></button>
      <button class="filter-btn" data-risk="TINGGI" style="border-color:#C43B29;color:#C43B29">TINGGI <span class="risk-count" id="cnt-tinggi"></span></button>
      <button class="filter-btn" data-risk="SEDERHANA" style="border-color:#B8860B;color:#B8860B">SEDERHANA <span class="risk-count" id="cnt-sederhana"></span></button>
      <button class="filter-btn" data-risk="RENDAH" style="border-color:#2B6B5B;color:#2B6B5B">RENDAH <span class="risk-count" id="cnt-rendah"></span></button>
      <span style="flex:1"></span>
      <button class="btn" id="btn-toggle-reports" style="font-size:0.55rem;padding:0.15rem 0.4rem;border-color:#2563EB;color:#2563EB">📍 Laporan</button>
      <span id="risiko-count" class="mono" style="font-size:0.6rem">—</span>
    </div>

    <div class="risiko-grid">
      <div class="risiko-map-col">
        <div class="map-wrap" id="risiko-map-wrap">
          <div class="sim-search-wrap">
            <div class="sim-search">
              <span class="sim-search-icon">🔍</span>
              <input id="sim-search-input" class="sim-search-input" type="text" placeholder="Cari lokasi, tempat, atau alamat..." autocomplete="off" />
              <div id="sim-search-results" class="sim-search-results" style="display:none"></div>
            </div>
          </div>
          <div class="map-inner" id="risiko-map"></div>
        </div>
      </div>
      <div id="risiko-sidebar">
        ${_isAdmin ? `
        <div class="section-title">Penjajaran Peta</div>
        <div style="font-size:0.65rem;color:var(--ink-dim);margin-bottom:0.4rem">
          Gerakkan semua segmen sungai untuk selari dengan peta dasar.
        </div>
        <div class="align-grid">
          <div></div>
          <button class="align-btn" data-dlat="${alignState.stepDeg}" data-dlon="0" title="Gerak ke utara">↑</button>
          <div></div>
          <button class="align-btn" data-dlat="0" data-dlon="${-alignState.stepDeg}" title="Gerak ke barat">←</button>
          <button class="align-btn" data-dlat="${-alignState.stepDeg}" data-dlon="0" title="Gerak ke selatan">↓</button>
          <button class="align-btn" data-dlat="0" data-dlon="${alignState.stepDeg}" title="Gerak ke timur">→</button>
        </div>
        <div style="margin-top:0.4rem">
          <div class="section-title" style="font-size:0.6rem">Langkah</div>
          <div style="display:flex;gap:0.25rem">
            <button class="step-btn" data-deg="0.00009">10m</button>
            <button class="step-btn active" data-deg="0.00045">50m</button>
            <button class="step-btn" data-deg="0.0018">200m</button>
          </div>
        </div>
        <div class="divider"></div>
        <div>
          <div class="mono" style="font-size:0.55rem">Offset terkini</div>
          <div class="mono" id="align-offset-display" style="font-size:0.65rem;font-weight:600;margin-top:0.1rem">Δlat=0.0000 Δlon=0.0000</div>
        </div>
        <button class="btn btn-primary" id="btn-save-align" style="margin-top:0.35rem;width:100%">Set Position</button>
        <button class="btn" id="btn-reset-align" style="margin-top:0.2rem;width:100%">Reset</button>
        <div class="divider"></div>
        ` : ''}
        <div class="section-title">Model Risiko</div>
        <div id="model-mode-display" style="font-size:0.65rem">
          <span class="mono" style="color:var(--ink-muted)">Sedang dimuat ...</span>
        </div>
        <div class="divider"></div>
        <div id="risiko-segment-info">
          <div class="mono" style="font-size:0.55rem;color:var(--ink-muted)">Klik segmen untuk butiran</div>
        </div>
      </div>
    </div>
  `;

  // Init map immediately so tiles start loading while we fetch data
  if (risiko_map) { risiko_map.remove(); risiko_map = null; }
  risiko_map = L.map('risiko-map', {
    center: [1.463, 103.660],
    zoom: 12,
    zoomControl: true,
    attributionControl: false,
  });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(risiko_map);
  risiko_layer = L.layerGroup().addTo(risiko_map);
  report_layer = L.layerGroup().addTo(risiko_map);
  sim_layer = L.layerGroup().addTo(risiko_map);
  _search_layer = L.layerGroup().addTo(risiko_map);
  _runoff_layer = L.layerGroup().addTo(risiko_map);
  addSatelliteToggle(risiko_map);
  _initLiveIndicator(risiko_map);
  _addRunoffToggle(risiko_map);
  _addGpsControl(risiko_map);
  _wireLocationSearch();

  // Use cache for instant render if available
  const now = Date.now();
  const cacheOk = _mapCache.segments && (now - _mapCache.ts < MAP_CACHE_TTL);

  if (cacheOk) {
    risiko_segments = _mapCache.segments;
    renderSegmentsOnMap();
    renderReportMarkers(_mapCache.locations || []);
    const rcEl = document.getElementById('risiko-count');
    if (rcEl) rcEl.textContent = `${risiko_segments.length} segmen`;
    risiko_map.invalidateSize();
    _fitMapToSegments();
  }

  try {
    let segPromise = apiGet('/explore/segments?limit=500');
    let locPromise = apiGet('/reports/locations').catch(() => ({ locations: [] }));

    if (cacheOk) {
      // Background refresh: don't await, update cache when done
      segPromise.then(segData => {
        if (currentPage !== 'risiko' || renderId !== _risikoRenderId) return;
        _mapCache.segments = segData.segments || [];
        _mapCache.locations = null; // will be set by locPromise
        _mapCache.ts = Date.now();
        risiko_segments = _mapCache.segments;
        saveMapSnapshot();
        renderSegmentsOnMap();
        updateRiskCounts();
        const rcEl = document.getElementById('risiko-count');
        if (rcEl) rcEl.textContent = `${risiko_segments.length} segmen`;
        _fitMapToSegments();
      });
      locPromise.then(locData => {
        if (currentPage !== 'risiko' || renderId !== _risikoRenderId) return;
        _mapCache.locations = locData.locations || [];
        _mapCache.ts = Date.now();
        renderReportMarkers(_mapCache.locations);
        saveMapSnapshot();
      });
    } else {
      // First load: await both
      const [segData, locData] = await Promise.all([segPromise, locPromise]);
      if (currentPage !== 'risiko' || renderId !== _risikoRenderId) return;
      _mapCache.segments = segData.segments || [];
      _mapCache.locations = locData.locations || [];
      _mapCache.ts = Date.now();
      risiko_segments = _mapCache.segments;
      saveMapSnapshot();
      const rcEl = document.getElementById('risiko-count');
      if (rcEl) rcEl.textContent = `${risiko_segments.length} segmen`;
      renderSegmentsOnMap();
      renderReportMarkers(_mapCache.locations);
    }

    // Fit map once after data is ready
    risiko_map.invalidateSize();
    if (!cacheOk) _fitMapToSegments();

    // Load model mode
    (async () => {
      try {
        const m = await apiGet('/model/mode');
        let modelsData;
        try { modelsData = await apiGet('/model/available'); } catch { modelsData = null; }
        if (currentPage !== 'risiko' || renderId !== _risikoRenderId) return;
        const rptLabel = m.mode === 'enabled' ? 'Laporan + Asal (Digabung)' : 'Asal (Pemetaan)';
        const activeId = modelsData?.active_model_id || 'heuristic';
        const models = modelsData?.models || [];
        const activeModel = models.find(x => x.id === activeId);
        const activeName = activeModel ? activeModel.name : (m.ml_model_mode === 'ml' ? 'ML' : 'Heuristik');
        let modelOptions = models.map(mo => `<option value="${mo.id}" ${mo.id === activeId ? 'selected' : ''}>${mo.name}</option>`).join('');
        document.getElementById('model-mode-display').innerHTML = `
          <div class="mono" style="font-size:0.6rem;color:var(--ink-muted)">Model Laporan</div>
          <div style="display:flex;justify-content:space-between;align-items:center">
            <span class="mono" style="font-size:0.6rem">${rptLabel}</span>
            <button class="btn" id="btn-toggle-model" style="font-size:0.55rem;padding:0.15rem 0.4rem">Tukar</button>
          </div>
          <div class="mono" style="font-size:0.5rem;color:var(--ink-muted);margin-top:0.15rem">${m.total_reports_for_model} laporan</div>
          <div style="margin-top:0.35rem" class="mono" style="font-size:0.6rem;color:var(--ink-muted)">Model Pemarkahan Aktif</div>
          <div style="margin-top:0.15rem">
            <select id="risiko-model-select" style="width:100%;font-size:0.55rem;padding:0.2rem;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--ink);font-family:var(--font-mono)">
              ${modelOptions}
            </select>
          </div>
          ${activeModel && activeModel.metrics?.r2 != null ? `<div class="mono" style="font-size:0.48rem;color:var(--ink-muted);margin-top:0.15rem">R²=${activeModel.metrics.r2.toFixed(3)} · RMSE=${activeModel.metrics.rmse?.toFixed(2) ?? '—'} · ${activeModel.n_features} ciri</div>` : ''}
        `;
        document.getElementById('btn-toggle-model')?.addEventListener('click', async () => {
          const newMode = m.mode === 'enabled' ? 'disabled' : 'enabled';
          await apiPost('/model/mode', { mode: newMode });
          toast(`Model laporan: ${newMode === 'enabled' ? 'Gabungan' : 'Asal'}`);
          renderRisiko(el);
        });
        document.getElementById('risiko-model-select')?.addEventListener('change', async (ev) => {
          const selectedId = ev.target.value;
          try {
            const r = await apiPost('/model/deploy', { model_id: selectedId });
            _apiCache.clear();
            toast(r.message);
            renderRisiko(el);
          } catch (e) {
            toast('Ralat: ' + e.message);
          }
        });
      } catch (e) {
        const mmd = document.getElementById('model-mode-display');
        if (mmd) mmd.innerHTML = '<span class="mono" style="font-size:0.6rem;color:var(--ink-muted)">Model tidak tersedia</span>';
      }
    })();

    // Update risk counts
    const counts = { KRITIKAL: 0, TINGGI: 0, SEDERHANA: 0, RENDAH: 0 };
    for (const s of risiko_segments) {
      const l = s.risk_level || 'RENDAH';
      if (counts[l] !== undefined) counts[l]++;
    }
    for (const [level, count] of Object.entries(counts)) {
      const el = document.getElementById('cnt-' + level.toLowerCase());
      if (el) el.textContent = count;
    }

    // Fit map to segment bounds (no-op if already done by cache)
    _fitMapToSegments();
  } catch (e) {
    el.innerHTML += `<div class="alert is-bad" style="margin-top:0.5rem"><span class="alert-icon">!</span><div><div class="alert-title">Ralat</div><div class="alert-body">${e.message}</div></div></div>`;
  }

  // ---- Priority List ----
  try {
    const prio = await apiGet('/priority?limit=10');
    if (currentPage !== 'risiko' || renderId !== _risikoRenderId) return;
    const critical = prio.priority.filter(s => s.risk_level === 'KRITIKAL');
    const tinggi = prio.priority.filter(s => s.risk_level === 'TINGGI');
    const afterMap = document.querySelector('#risiko-sidebar');
    // Remove any existing priority section first
    const existingPrio = afterMap?.parentNode?.querySelector('.prio-wrapper');
    if (existingPrio) existingPrio.remove();
    if (afterMap && (critical.length || tinggi.length)) {
      const prioHtml = document.createElement('div');
      prioHtml.className = 'prio-wrapper';
      prioHtml.style.cssText = 'margin-top:0.75rem';
      prioHtml.innerHTML = `
        <div class="section-title">Keutamaan Risiko</div>
        ${critical.map(s => `
          <div style="border:1px solid #000;padding:0.3rem 0.5rem;margin-bottom:0.25rem;background:var(--bg-card);cursor:pointer" class="prio-item" data-sid="${s.id}">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <span style="font-weight:600;font-size:0.7rem">${s.name.substring(0,28)}</span>
              <span class="severity-tag critical" style="font-size:0.5rem">${s.risk_score}/100</span>
            </div>
            <div class="mono" style="font-size:0.55rem;margin-top:0.1rem">⚠ ${(s.factors||[]).slice(0,3).join(' · ')}</div>
          </div>
        `).join('')}
        ${tinggi.map(s => `
          <div style="border:1px solid var(--alert);padding:0.25rem 0.5rem;margin-bottom:0.2rem;background:var(--bg-card);cursor:pointer" class="prio-item" data-sid="${s.id}">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <span style="font-weight:500;font-size:0.65rem">${s.name.substring(0,28)}</span>
              <span class="severity-tag high" style="font-size:0.5rem">${s.risk_score}/100</span>
            </div>
            <div class="mono" style="font-size:0.5rem;margin-top:0.05rem">${(s.factors||[]).slice(0,2).join(' · ')}</div>
          </div>
        `).join('')}
      `;
      afterMap.parentNode.insertBefore(prioHtml, afterMap.nextSibling);

      document.querySelectorAll('.prio-item').forEach(el => {
        el.addEventListener('click', () => {
          const sid = parseInt(el.dataset.sid);
          const seg = risiko_segments.find(s => s.id === sid);
          if (seg) showSegmentDetail(seg);
        });
      });
    }
  } catch (e) { /* priority unavailable */ }

  // ---- Risk Filter ----
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      riskFilter = btn.dataset.risk;
      renderSegmentsOnMap();
    });
  });

  // ---- Report Toggle ----
  const rptBtn = document.getElementById('btn-toggle-reports');
  if (rptBtn) {
    rptBtn.addEventListener('click', () => {
      report_layer_visible = !report_layer_visible;
      if (report_layer) {
        if (report_layer_visible) {
          risiko_map.addLayer(report_layer);
          rptBtn.style.opacity = '1';
        } else {
          risiko_map.removeLayer(report_layer);
          rptBtn.style.opacity = '0.4';
        }
      }
    });
  }

  // ---- Alignment Controls (admin only) ----
  document.querySelectorAll('.align-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const dlat = parseFloat(btn.dataset.dlat);
      const dlon = parseFloat(btn.dataset.dlon);
      alignState.dlat += dlat;
      alignState.dlon += dlon;
      renderSegmentsOnMap();
      updateAlignDisplay();
    });
  });

  document.querySelectorAll('.step-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.step-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      alignState.stepDeg = parseFloat(btn.dataset.deg);
      document.querySelectorAll('.align-btn').forEach(b => {
        const dlatOrig = parseFloat(b.dataset.dlat);
        const dlonOrig = parseFloat(b.dataset.dlon);
        if (dlatOrig !== 0) b.dataset.dlat = (dlatOrig > 0 ? 1 : -1) * alignState.stepDeg;
        if (dlonOrig !== 0) b.dataset.dlon = (dlonOrig > 0 ? 1 : -1) * alignState.stepDeg;
      });
    });
  });

  document.getElementById('btn-save-align')?.addEventListener('click', saveAlignment);
  document.getElementById('btn-reset-align')?.addEventListener('click', resetAlignment);

  _startRisikoRefresh();
}

function renderSegmentsOnMap() {
  if (!risiko_layer || !risiko_segments.length) return;
  risiko_layer.clearLayers();

  for (const seg of risiko_segments) {
    const risk = seg.risk_level || 'RENDAH';
    if (riskFilter !== 'all' && risk !== riskFilter) continue;

    const color = riskColor(risk);
    const weight = riskWeight(risk);
    const opacity = riskOpacity(risk);

    // Polyline for the segment path
    const ptsRaw = seg.geometry && seg.geometry[0];
    if (ptsRaw && ptsRaw.length >= 2) {
      const pts = ptsRaw.map(p => [p[0] + alignState.dlat, p[1] + alignState.dlon]);
      const poly = L.polyline(pts, { color, weight, opacity }).addTo(risiko_layer);
      poly.segId = seg.id;
      poly.on('click', () => showSegmentDetail(seg));
    }

    // Circle marker at segment center for visible risk indicator
    if (seg.center && seg.center.length === 2) {
      const c = [seg.center[0] + alignState.dlat, seg.center[1] + alignState.dlon];
      const radius = riskRadius(risk);
      const marker = L.circleMarker(c, {
        radius,
        color,
        fillColor: color,
        fillOpacity: 0.35,
        weight: 1.5,
      }).addTo(risiko_layer);
      marker.segId = seg.id;
      marker.on('click', () => showSegmentDetail(seg));
    }
  }
}

function renderReportMarkers(locations) {
  if (!report_layer) return;
  report_layer.clearLayers();
  for (const loc of locations) {
    if (!loc.lat || !loc.lon) continue;
    const color = loc.severity === 'critical' ? '#000' : loc.severity === 'high' ? '#C43B29' : loc.severity === 'medium' ? '#B8860B' : '#2B6B5B';
    const marker = L.circleMarker([loc.lat, loc.lon], {
      radius: 6, color, fillColor: color, fillOpacity: 0.5, weight: 2,
    }).addTo(report_layer);
    const popupText = `<div style="font-size:0.65rem"><b>Laporan #${loc.id}</b><br>${(loc.description || '').substring(0,60)}<br>Tahap: ${loc.severity}</div>`;
    marker.bindPopup(popupText);
  }
}

function updateAlignDisplay() {
  const el = document.getElementById('align-offset-display');
  if (el) el.textContent = `Δlat=${alignState.dlat.toFixed(4)} Δlon=${alignState.dlon.toFixed(4)}`;
}

async function saveAlignment() {
  const btn = document.getElementById('btn-save-align');
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = 'Menyimpan ...';
  try {
    // Get current projection config
    const proj = await apiGet('/proj');
    // Adjust lat_0/lon_0 by the current offset
    // (north shift = increase lat_0, east shift = increase lon_0)
    const newCfg = {
      lat_0: Math.round((proj.lat_0 + alignState.dlat) * 1000) / 1000,
      lon_0: Math.round((proj.lon_0 + alignState.dlon) * 1000) / 1000,
      x_0: proj.x_0 || 0,
      y_0: proj.y_0 || 0,
      datum: proj.datum || 'WGS84',
    };
    await apiPost('/proj', newCfg);
    alignState.dlat = 0;
    alignState.dlon = 0;
    updateAlignDisplay();
    toast('Penjajaran disimpan! Segmen akan dimuat semula.');
    // Reload segments with new projection
    const data = await apiGet('/explore/segments?limit=500');
    risiko_segments = data.segments || [];
    renderSegmentsOnMap();
  } catch (e) {
    toast('Ralat: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Set Position';
  }
}

function resetAlignment() {
  alignState.dlat = 0;
  alignState.dlon = 0;
  updateAlignDisplay();
  renderSegmentsOnMap();
}

let lastSelectedSegId = null;

function showSegmentDetail(seg) {
  const info = document.getElementById('risiko-segment-info');
  if (!info) return;

  // Reset previous selection
  if (lastSelectedSegId) {
    risiko_layer.eachLayer(l => {
      if (l.segId === lastSelectedSegId) {
        if (l instanceof L.Polyline) {
          const risk = seg.risk_level || 'RENDAH';
          l.setStyle({ weight: riskWeight(risk), color: riskColor(risk) });
        } else if (l instanceof L.CircleMarker) {
          l.setStyle({ radius: riskRadius(seg.risk_level || 'RENDAH'), color: riskColor(seg.risk_level || 'RENDAH'), fillOpacity: 0.35 });
        }
      }
    });
  }

  lastSelectedSegId = seg.id;
  // Highlight this segment
  risiko_layer.eachLayer(l => {
    if (l.segId === seg.id) {
      if (l instanceof L.Polyline) {
        l.setStyle({ weight: 5, color: '#1A1816' });
        l.bringToFront();
      } else if (l instanceof L.CircleMarker) {
        l.setStyle({ radius: 12, color: '#1A1816', fillColor: '#1A1816', fillOpacity: 0.5 });
      }
    }
  });

  const risk = seg.risk_level || 'RENDAH';
  const score = seg.risk_score !== undefined ? seg.risk_score : '—';
  const name = seg.name || `Segmen ${seg.id}`;
  const center = seg.center || [0, 0];

  // Pollution inference from land use
  const pollutionMap = {
    'Perindustrian': { label: 'Kimia/Toksik', color: 'var(--alert)' },
    'Perindustrian': { label: 'Kimia/Toksik', color: 'var(--alert)' },
    'Pertanian': { label: 'Baja/Najis', color: 'var(--warn)' },
    'Perumahan': { label: 'Domestik', color: 'var(--warn)' },
    'Komersial': { label: 'Sisa Komersial', color: 'var(--warn)' },
    'Pengangkutan': { label: 'Hakisan/Minyak', color: 'var(--warn)' },
    'Tanah Kosong': { label: 'Hakisan Tanah', color: 'var(--warn)' },
    'Hutan': { label: 'Rendah', color: 'var(--good)' },
    'Badan Air': { label: 'Rendah', color: 'var(--good)' },
  };
  const dominantLU = (seg.land_use_types || [])[0] || '';
  const pollutionInfo = Object.entries(pollutionMap).find(([k]) => dominantLU.includes(k));
  const pollLabel = pollutionInfo ? pollutionInfo[1].label : '—';
  const pollColor = pollutionInfo ? pollutionInfo[1].color : 'var(--ink-muted)';
  const pipe = seg.nearest_pipe;
  const comm = seg.nearest_community;

  const sevMap = { KRITIKAL: 'critical', TINGGI: 'high', SEDERHANA: 'medium', RENDAH: 'low' };

  info.innerHTML = `
    <div class="section-title" style="margin-top:0.4rem">Segmen ${seg.id}</div>
    <div style="font-size:0.78rem;font-weight:600;margin-bottom:0.2rem">${name}</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.25rem;font-size:0.65rem">
      <div><span class="mono" style="color:var(--ink-muted)">Risiko</span><br><span class="severity-tag ${sevMap[risk] || 'low'}" style="margin-top:0.1rem">${risk} ${score}/100</span></div>
      <div><span class="mono" style="color:var(--ink-muted)">Pusat</span><br><span class="mono">${center[0].toFixed(4)}, ${center[1].toFixed(4)}</span></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.25rem;font-size:0.65rem;margin-top:0.3rem">
      <div><span class="mono" style="color:var(--ink-muted)">Guna tanah</span><br><span class="mono">${seg.land_use_count || 0}</span></div>
      <div><span class="mono" style="color:var(--ink-muted)">Paip/Parit</span><br><span class="mono">${seg.pipe_count || 0}</span></div>
    </div>
    <div style="margin-top:0.4rem;display:flex;gap:0.25rem;flex-wrap:wrap">
      ${(seg.factors || []).map(f => `<span class="pill">${f}</span>`).join('')}
    </div>
    <div class="divider"></div>
    <div style="font-size:0.65rem">
      <div><span class="mono" style="color:var(--ink-muted)">Guna Tanah</span><br><span style="font-size:0.6rem">${(seg.land_use_types || ['—']).slice(0,3).join(', ')}</span></div>
      <div style="margin-top:0.2rem"><span class="mono" style="color:var(--ink-muted)">Ramalan Pencemaran</span><br><span style="color:${pollColor};font-weight:500">${pollLabel}</span> <span class="mono" style="font-size:0.5rem">(berdasarkan guna tanah)</span></div>
      ${pipe ? `<div style="margin-top:0.2rem"><span class="mono" style="color:var(--ink-muted)">Paip/Parit Terdekat</span><br><span class="mono" style="font-size:0.6rem">${pipe.type} ${pipe.name ? '· ' + pipe.name : ''} (${pipe.distance_m.toFixed(0)}m)</span></div>` : ''}
      ${comm ? `<div style="margin-top:0.2rem"><span class="mono" style="color:var(--ink-muted)">Komuniti Berhampiran</span><br><span class="mono" style="font-size:0.6rem">${comm.name} (${comm.distance_km.toFixed(3)}km)</span></div>` : ''}
    </div>
    <button class="btn" style="width:100%;margin-top:0.35rem;font-size:0.65rem" id="btn-ai-${seg.id}">Analisis AI</button>
    <div id="ai-result-${seg.id}"></div>
    <div class="divider"></div>
    <div style="margin-top:0.3rem">
      <div style="display:flex;gap:0.25rem;margin-bottom:0.3rem">
        <label class="mono" style="font-size:0.55rem;color:var(--ink-muted);align-self:center">Masa Simulasi</label>
        <select class="spread-dur-select" id="spread-dur-${seg.id}" style="flex:1;padding:0.15rem 0.3rem;font-size:0.6rem;border:1px solid var(--border);border-radius:5px;background:var(--bg);font-family:var(--font-mono)">
          <option value="60" selected>1 jam</option>
          <option value="720">1/2 hari</option>
          <option value="1440">1 hari</option>
          <option value="2880">2 hari</option>
          <option value="4320">3 hari</option>
          <option value="5760">4 hari</option>
          <option value="7200">5 hari</option>
          <option value="10080">1 minggu</option>
          <option value="20160">2 minggu</option>
          <option value="43200">1 bulan</option>
        </select>
      </div>
      <button class="btn" style="width:100%;font-size:0.65rem" onclick="runSpreadSim(${seg.id}, parseInt(document.getElementById('spread-dur-${seg.id}').value))">▶ Simulasi Pencemaran</button>
      <div id="spread-viz-${seg.id}" style="margin-top:0.3rem"></div>
    </div>
    <div style="margin-top:0.3rem">
      <button class="btn pdf-export-btn" style="width:100%;font-size:0.65rem" onclick="exportSegmentPDF(${seg.id})">📄 Muat Turun PDF</button>
    </div>
    <div id="topo-container-${seg.id}" style="margin-top:0.3rem"></div>
  `;

  requestAnimationFrame(() => { if (risiko_map) risiko_map.invalidateSize(); });

  // Load topology chain asynchronously
  loadTopologyPopup(seg.id).then(html => {
    const tc = document.getElementById('topo-container-' + seg.id);
    if (tc && html) tc.innerHTML = html;
    requestAnimationFrame(() => { if (risiko_map) risiko_map.invalidateSize(); });
  }).catch(() => {});
  setTimeout(() => {
    const btn = document.getElementById('btn-ai-' + seg.id);
    if (btn) btn.addEventListener('click', async () => {
      const res = document.getElementById('ai-result-' + seg.id);
      res.innerHTML = '<div class="mono" style="font-size:0.6rem;margin-top:0.25rem">Menganalisis ...</div>';
      btn.disabled = true;
      try {
        const d = await apiGet('/explore/ai/' + seg.id);
        let html = '';
        if (d.ml_prediction) {
          const ml = d.ml_prediction;
          html += '<div class="divider"></div><div style="margin-bottom:0.2rem"><span class="mono" style="color:var(--ink-muted)">Model ML (data sebenar)</span><br><span class="mono" style="font-size:0.65rem">Skor: ' + ml.risk_score + ' &middot; Tahap: ' + ml.risk_level + '</span></div>';
          if (ml.contributors && ml.contributors.length) {
            html += '<div style="font-size:0.55rem;margin-top:0.1rem"><span class="mono" style="color:var(--ink-muted)">Faktor utama:</span><br>';
            html += ml.contributors.slice(0, 5).map(c => {
              const fname = c[0].replace('lu_count_', '').replace('lu_min_dist_', 'Jarak ').replace('Lain-lain (', '').replace(')', '');
              return '<span class="mono">' + fname + ' (' + (c[1] > 0 ? '+' : '') + c[1].toFixed(2) + ')</span>';
            }).join(' &middot; ');
            html += '</div>';
          }
          html += '<div class="divider" style="margin:0.3rem 0"></div>';
        }
        html += '<div class="mono" style="font-size:0.6rem;line-height:1.5;word-break:break-word;overflow-wrap:break-word">' + (d.analysis || 'Analisis tidak tersedia').replace(/\\n/g, '<br>') + '</div>';
        res.innerHTML = html;
        requestAnimationFrame(() => { if (risiko_map) risiko_map.invalidateSize(); });
      } catch (e) {
        res.innerHTML = '<div class="mono" style="font-size:0.6rem;color:var(--alert);margin-top:0.25rem">Analisis tidak tersedia</div>';
      } finally { btn.disabled = false; }
    });
  }, 50);
}

// ============================================================
//  PROFILE
// ============================================================
async function renderProfile(el) {
  const userId = _authUser || getUserId();
  if (!userId) {
    el.innerHTML = `
      <div class="page-header">
        <h2>Profil Ekologi</h2>
        <div class="page-sub">Statistik dan pencapaian anda</div>
      </div>
      <div class="empty" style="padding:2rem"><div class="empty-icon">🔑</div><div class="empty-title"><a href="#login" style="color:var(--alert);text-decoration:underline">Log masuk</a> untuk melihat profil</div></div>
    `;
    return;
  }
  el.innerHTML = `
    <div class="page-header">
      <h2>Profil Ekologi</h2>
      <div class="page-sub">Statistik dan pencapaian anda</div>
    </div>

    <div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-bottom:0.75rem;align-items:center">
      <div class="stat-box" style="display:flex;align-items:center;gap:0.5rem;flex:1;min-width:180px">
        <span style="font-size:1.3rem">👤</span>
        <div>
          <div style="font-family:var(--font-mono);font-size:0.55rem;color:var(--ink-muted);text-transform:uppercase">Pengguna</div>
          <div style="font-weight:600;font-size:1rem" id="prof-name">${userId}</div>
        </div>
      </div>
      <button class="btn" id="btn-refresh">Muat Semula</button>
    </div>

    <div id="prof-content">
      <div class="empty"><div class="empty-icon">📋</div><div class="empty-title">Buat laporan untuk mula</div></div>
    </div>
  `;

  loadProfile(userId);
  document.getElementById('btn-refresh')?.addEventListener('click', () => {
    const u = _authUser || getUserId();
    if (u) loadProfile(u);
  });
}

async function loadProfile(userId) {
  try {
    const d = await apiGet(`/user/${encodeURIComponent(userId)}`);
    if (currentPage !== 'profile') return;
    document.getElementById('prof-name').textContent = userId;
    const treesAvail = d.mangrove_trees || 0;
    const ptsNeeded = 200 - (d.points % 200);

    document.getElementById('prof-content').innerHTML = `
      <div class="stat-row">
        <div class="stat-box"><div class="stat-num">${d.points}</div><div class="stat-label">Mata Ekologi</div></div>
        <div class="stat-box"><div class="stat-num">${d.total_reports}</div><div class="stat-label">Laporan</div></div>
        <div class="stat-box"><div class="stat-num">${d.streak}<span style="font-size:0.6rem;font-weight:400;color:var(--ink-muted)"> hari</span></div><div class="stat-label">Streak</div></div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem">
        <div>
          <div class="section-title">Laporan Terkini</div>
          ${d.recent_reports?.length
            ? '<table class="data-table"><tbody>' + d.recent_reports.slice().reverse().slice(0,5).map(r =>
              `<tr><td><span class="severity-tag ${r.severity}" style="font-size:0.5rem">${r.severity}</span></td><td style="font-size:0.75rem">${(r.description||'').substring(0,35)}</td><td style="text-align:right;font-weight:600">+${r.points_earned}</td></tr>`
            ).join('') + '</tbody></table>'
            : '<div class="empty" style="padding:1rem"><div class="empty-title">Tiada laporan</div></div>'
          }
        </div>
        <div>
          <div class="section-title">Badge Diraih</div>
          ${d.badges?.length
            ? d.badges.map(b => `<div class="badge" style="margin-bottom:0.25rem;display:flex">${b.name}: ${b.desc}</div>`).join('')
            : '<div class="empty" style="padding:1rem"><div class="empty-title">Belum ada badge</div></div>'
          }
        </div>
      </div>

      <div class="section-title" style="margin-top:0.75rem">IMELC — Tebus Pokok Bakau</div>
      <div style="border:1px solid var(--border);padding:0.75rem 1rem;background:var(--bg-card)">
        <div style="display:flex;align-items:center;gap:1.5rem;flex-wrap:wrap">
          <div style="text-align:center">
            <div style="font-size:2.5rem;font-weight:700;color:var(--good);line-height:1">${treesAvail}</div>
            <div class="mono" style="font-size:0.55rem">Pokok Tersedia</div>
          </div>
          <div style="flex:1;min-width:140px">
            <div class="progress-track"><div class="fill" style="width:${d.points % 200}%"></div></div>
            <div class="mono" style="font-size:0.55rem;color:var(--ink-muted);margin-top:0.2rem">${ptsNeeded} mata lagi untuk 1 pokok</div>
          </div>
          ${treesAvail > 0 ? `<button class="btn" id="btn-redeem">Tebus ${treesAvail} Pokok</button>` : ''}
        </div>
      </div>
    `;

    if (treesAvail > 0) {
      document.getElementById('btn-redeem')?.addEventListener('click', async () => {
        const uid = _authUser || getUserId();
        if (!uid) { toast('Sila daftar ID pengguna di Profil'); return; }
        try {
          const d = await apiPost('/redeem', { user_id: uid, count: treesAvail });
          toast(d.message);
          loadProfile(uid);
        } catch (e) { toast('Ralat: ' + e.message); }
      });
    }
  } catch (e) {
    const pc = document.getElementById('prof-content');
    if (!pc) return;
    if (e.message.includes('t found') || e.message.includes('404')) {
      pc.innerHTML = '<div class="alert is-warn" style="margin-top:0.5rem"><span class="alert-icon">!</span><div><div class="alert-title">Pengguna Baru</div><div class="alert-body">Buat laporan pertama untuk bermula.</div></div></div>';
    } else {
      pc.innerHTML = `<div class="alert is-bad" style="margin-top:0.5rem"><span class="alert-icon">!</span><div><div class="alert-title">Ralat</div><div class="alert-body">${e.message}</div></div></div>`;
    }
  }
}

// ============================================================
// NEW FEATURES — v4.0
// WebSocket Alerts · Chatbot · Trend · Topology ·
// Spread Simulation · Satellite Overlay · PDF Export · Image Analysis
// ============================================================

// ---- WebSocket Real-time Alerts ----
let _wsConn = null;
let _wsReconnectTimer = null;

function connectWebSocket() {
  if (_wsConn && (_wsConn.readyState === WebSocket.OPEN || _wsConn.readyState === WebSocket.CONNECTING)) return;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = proto + '//' + location.host + API + '/ws/alerts';
  try {
    _wsConn = new WebSocket(url);
    _wsConn.onopen = () => { console.log('[WS] Connected'); };
    _wsConn.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        handleWSMessage(msg);
  } catch(e) {
    // Show error in chart area instead of silently failing
    const ctx = document.getElementById('trend-summary-chart');
    if (ctx) {
      const parent = ctx.parentElement;
      if (parent) parent.innerHTML = `<div style="padding:2rem;text-align:center;font-family:var(--font-mono);font-size:0.7rem;color:var(--ink-muted)">
        Tiada data trend tersedia.<br><span style="font-size:0.6rem">${e.message || 'Ralat tidak diketahui'}</span><br>
        <span style="font-size:0.55rem;color:var(--ink-dim);margin-top:0.5rem;display:block">Ambil snapshot untuk mewujudkan data trend.</span>
      </div>`;
    }
    const container = document.getElementById('trend-summary-cards');
    if (container) container.innerHTML = `<div class="trend-summary-card"><div class="label">Status</div><div class="value" style="font-size:0.8rem;color:var(--ink-muted)">Tiada data</div></div>`;
  }
    };
    _wsConn.onclose = () => {
      console.log('[WS] Disconnected, reconnecting in 10s...');
      clearTimeout(_wsReconnectTimer);
      _wsReconnectTimer = setTimeout(connectWebSocket, 10000);
    };
    _wsConn.onerror = () => {};
  } catch(e) {}
}

function handleWSMessage(msg) {
  if (msg.type === 'alert' && msg.segment_id) {
    const banner = document.getElementById('alert-banner');
    const text = document.getElementById('alert-banner-text');
    if (banner && text) {
      text.textContent = msg.message || `⚠ Segmen ${msg.segment_id} — risiko ${msg.risk_level || 'tinggi'}`;
      banner.style.display = 'flex';
    }
    toast(msg.message || '⚠ Amaran pencemaran baru!');
  }
}

function sendWSMessage(data) {
  if (_wsConn && _wsConn.readyState === WebSocket.OPEN) {
    _wsConn.send(JSON.stringify(data));
  }
}

// ---- Chatbot ----
function toggleChatbot() {
  const box = document.getElementById('chatbot-box');
  if (!box) return;
  const visible = box.style.display !== 'none';
  box.style.display = visible ? 'none' : 'flex';
  if (!visible) {
    document.getElementById('chatbot-input')?.focus();
  }
}

async function sendChatbot() {
  const input = document.getElementById('chatbot-input');
  const msgEl = document.getElementById('chatbot-messages');
  if (!input || !msgEl) return;
  const msg = input.value.trim();
  if (!msg) return;
  input.value = '';

  // User bubble
  const userDiv = document.createElement('div');
  userDiv.className = 'chatbot-msg user';
  userDiv.textContent = msg;
  msgEl.appendChild(userDiv);

  // Typing indicator
  const typingDiv = document.createElement('div');
  typingDiv.className = 'chatbot-msg bot';
  typingDiv.textContent = '...';
  msgEl.appendChild(typingDiv);
  msgEl.scrollTop = msgEl.scrollHeight;

  try {
    const res = await Promise.race([
      apiPost('/chatbot', { message: msg }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Analisis AI mengambil masa terlalu lama. Sila cuba semula atau tanya soalan yang lebih spesifik.')), 45000)),
    ]);
    typingDiv.textContent = res.reply;
    if (res.data && res.data.critical_segments) {
      typingDiv.innerHTML += '<br><small>' + res.data.critical_segments.slice(0, 5).map(s => `#${s.id} ${s.name} (${s.score})`).join(' · ') + '</small>';
    }
    if (res.data && res.data.industrial_segments) {
      typingDiv.innerHTML += '<br><small>' + res.data.industrial_segments.slice(0, 5).map(s => `#${s.id} ${s.name} (${s.risk_level})`).join(' · ') + '</small>';
    }
    if (res.data && res.data.pipe_segments) {
      typingDiv.innerHTML += '<br><small>' + res.data.pipe_segments.slice(0, 5).map(s => `#${s.id} ${s.name} (${s.pipe_count} paip)`).join(' · ') + '</small>';
    }
    if (res.data && res.data.community_segments) {
      typingDiv.innerHTML += '<br><small>' + res.data.community_segments.slice(0, 5).map(s => `#${s.id} ${s.name} → ${s.community} (${s.distance_km?.toFixed(2)}km)`).join(' · ') + '</small>';
    }
  } catch(e) {
    typingDiv.className = 'chatbot-msg error';
    typingDiv.textContent = 'Ralat: ' + e.message;
  }
  msgEl.scrollTop = msgEl.scrollHeight;
}

// ---- Trend Page ----
let _trendCharts = {};

function _trendColor(level) {
  return level === 'KRITIKAL' ? '#000' : level === 'TINGGI' ? '#C43B29' : level === 'SEDERHANA' ? '#B8860B' : '#2B6B5B';
}

async function renderTrend(el) {
  el.innerHTML = `
    <div class="page-header">
      <h2>Analisis Trend Risiko</h2>
      <div class="page-sub">Statistik perubahan risiko sungai dari semasa ke semasa</div>
    </div>

    <div class="stat-row" id="trend-live-stats"></div>

    <div class="trend-charts-grid">
      <div class="trend-chart-card">
        <div class="trend-chart-title">Taburan Tahap Risiko</div>
        <div class="trend-chart-desc">Proporsi segmen mengikut tahap risiko</div>
        <div class="trend-chart-box"><canvas id="trend-doughnut"></canvas></div>
      </div>
      <div class="trend-chart-card">
        <div class="trend-chart-title">Taburan Skor Risiko</div>
        <div class="trend-chart-desc">Histogram penyebaran skor segmen</div>
        <div class="trend-chart-box"><canvas id="trend-histogram"></canvas></div>
      </div>
    </div>

    <div id="trend-movers-wrap" style="display:none">
      <div class="section-title">Perubahan Signifikan</div>
      <div id="trend-movers" class="trend-movers-list"></div>
    </div>

    <div class="section-title">Taburan Semua Segmen</div>
    <div class="trend-charts-grid">
      <div class="trend-chart-card" style="grid-column:1/-1">
        <div class="trend-chart-title">Carta Bar: Top 25 Segmen Berisiko</div>
        <div class="trend-chart-desc">Segmen dengan skor risiko tertinggi</div>
        <div class="trend-chart-box" style="height:280px"><canvas id="trend-bar-top"></canvas></div>
      </div>
    </div>
  `;

  Object.values(_trendCharts).forEach(c => { try { c.destroy(); } catch {} });
  _trendCharts = {};

  _loadTrendDashboard();
}

async function _loadTrendDashboard() {
  const days = 30;
  let rich;
  try { rich = await apiGet('/timeseries/stats/rich?days=' + days); } catch { return; }

  const ls = rich.live_stats || {};
  const el = document.getElementById('trend-live-stats');
  if (el) {
    el.innerHTML = `
      <div class="stat-box"><div class="stat-num">${ls.total_segments || 0}</div><div class="stat-label">Jumlah Segmen</div></div>
      <div class="stat-box"><div class="stat-num" style="color:${(ls.avg_score||0) > 65 ? '#C43B29' : '#2B6B5B'}">${ls.avg_score || '—'}</div><div class="stat-label">Purata Skor</div></div>
      <div class="stat-box"><div class="stat-num">${ls.std_dev || '—'}</div><div class="stat-label">Sisihan Piawai</div></div>
      <div class="stat-box"><div class="stat-num" style="color:#C43B29">${ls.p90 || '—'}</div><div class="stat-label">P90 (10% tertinggi)</div></div>
    `;
  }

  const dist = rich.distribution || [];
  if (dist.length && typeof Chart !== 'undefined') {
    const ctxD = document.getElementById('trend-doughnut');
    if (ctxD) {
      if (_trendCharts.doughnut) _trendCharts.doughnut.destroy();
      const levels = ['KRITIKAL', 'TINGGI', 'SEDERHANA', 'RENDAH'];
      const distMap = {}; dist.forEach(d => distMap[d.level] = d.count);
      _trendCharts.doughnut = new Chart(ctxD, {
        type: 'doughnut',
        data: {
          labels: levels,
          datasets: [{ data: levels.map(l => distMap[l] || 0), backgroundColor: levels.map(l => _trendColor(l)), borderWidth: 2, borderColor: '#fff' }],
        },
        options: { responsive: true, maintainAspectRatio: false, cutout: '55%',
          plugins: { legend: { position: 'right', labels: { font: { size: 11 }, padding: 12 } } } },
      });
    }

    const ctxH = document.getElementById('trend-histogram');
    if (ctxH) {
      if (_trendCharts.histogram) _trendCharts.histogram.destroy();
      const buckets = Array(10).fill(0);
      if (ls.total_segments) {
        try {
          const allSeg = await apiGet('/explore/segments?limit=500');
          (allSeg.segments || []).forEach(s => {
            const b = Math.min(Math.floor((s.risk_score || 0) / 10), 9);
            buckets[b]++;
          });
        } catch {}
      }
      _trendCharts.histogram = new Chart(ctxH, {
        type: 'bar',
        data: {
          labels: buckets.map((_, i) => `${i*10}-${(i+1)*10}`),
          datasets: [{ data: buckets, backgroundColor: buckets.map((_, i) => i >= 8 ? '#000' : i >= 6 ? '#C43B29' : i >= 5 ? '#B8860B' : '#2B6B5B'), borderRadius: 4 }],
        },
        options: { responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: { y: { beginAtZero: true, ticks: { font: { size: 10 } } }, x: { ticks: { font: { size: 9 } } } } },
      });
    }
  }

  const movers = rich.top_movers || [];
  const moversWrap = document.getElementById('trend-movers-wrap');
  const moversEl = document.getElementById('trend-movers');
  if (moversWrap && moversEl) {
    if (!movers.length) {
      moversWrap.style.display = 'none';
    } else {
      moversWrap.style.display = '';
      moversEl.innerHTML = movers.map(m => {
        const dir = m.delta > 0 ? '\u25B2' : '\u25BC';
        const color = m.delta > 0 ? '#C43B29' : '#2B6B5B';
        return `<div class="trend-mover-item">
          <div class="trend-mover-name">#${m.segment_id} ${m.name}</div>
          <div class="trend-mover-scores"><span>${m.from}</span> <span style="color:${color}">${dir} ${Math.abs(m.delta)}</span> <span>${m.to}</span></div>
        </div>`;
      }).join('');
    }
  }

  if (ls.total_segments) {
    try {
      const allSeg = await apiGet('/explore/segments?limit=500');
      const segs = (allSeg.segments || []).sort((a, b) => (b.risk_score || 0) - (a.risk_score || 0)).slice(0, 25);
      const ctxBar = document.getElementById('trend-bar-top');
      if (ctxBar && segs.length) {
        if (_trendCharts.barTop) _trendCharts.barTop.destroy();
        _trendCharts.barTop = new Chart(ctxBar, {
          type: 'bar',
          data: {
            labels: segs.map(s => `#${s.id}`),
            datasets: [{ label: 'Skor Risiko', data: segs.map(s => s.risk_score),
              backgroundColor: segs.map(s => _trendColor(s.risk_level || 'RENDAH')), borderRadius: 3 }],
          },
          options: { responsive: true, maintainAspectRatio: false, indexAxis: 'y',
            plugins: { legend: { display: false }, tooltip: { callbacks: { title: (items) => segs[items[0].dataIndex]?.name || '', label: (item) => `Skor: ${item.raw} · ${segs[item.dataIndex]?.risk_level}` } } },
            scales: { x: { beginAtZero: true, max: 100, title: { display: true, text: 'Skor', font: { size: 10 } } }, y: { ticks: { font: { size: 9 } } } } },
        });
      }
    } catch {}
  }
}

// ---- Topology Visualization (in segment detail popup) ----
async function loadTopologyPopup(segmentId) {
  try {
    const ds = await apiGet('/topology/downstream/' + segmentId);
    const us = await apiGet('/topology/upstream/' + segmentId);
    let html = '<div class="topo-container">';
    html += '<h4>Rantaian Sungai</h4>';

    if (us.chain && us.chain.length) {
      html += '<div style="font-family:var(--font-mono);font-size:0.55rem;color:var(--ink-muted);margin-bottom:0.2rem">HULU (atas)</div>';
      html += '<div class="topo-chain">';
      us.chain.slice(-5).reverse().forEach((seg, i) => {
        const segId = seg.sid || seg;
        const segName = seg.name || '';
        if (i > 0) html += '<span class="topo-arrow">\u2191</span>';
        html += `<span class="topo-node" onclick="navigate('risiko');setTimeout(()=>loadSegmentDetail(${segId}),200)" title="${segName}">${segId}</span>`;
      });
      html += `<span class="topo-arrow">\u2191</span><span class="topo-node" style="border-style:dashed">HULU</span>`;
      html += '</div>';
    }

    html += '<div class="topo-chain" style="margin:0.3rem 0"><span class="topo-node source" style="font-weight:700">\u{1F4CD} ' + segmentId + '</span></div>';

    if (ds.chain && ds.chain.length) {
      html += '<div style="font-family:var(--font-mono);font-size:0.55rem;color:var(--ink-muted);margin:0.2rem 0 0.1rem">HILIR (bawah)</div>';
      html += '<div class="topo-chain">';
      html += `<span class="topo-node" style="border-style:dashed">HILIR</span>`;
      ds.chain.slice(0, 5).forEach((seg, i) => {
        const segId = seg.sid || seg;
        const segName = seg.name || '';
        html += `<span class="topo-arrow">\u2193</span>`;
        html += `<span class="topo-node" onclick="navigate('risiko');setTimeout(()=>loadSegmentDetail(${segId}),200)" title="${segName}">${segId}</span>`;
      });
      if (ds.count > 5) html += `<span class="topo-arrow">\u2193</span><span class="topo-node" style="opacity:0.5">+${ds.count - 5}</span>`;
      html += '</div>';
    }

    html += `<div style="margin-top:0.3rem;font-family:var(--font-mono);font-size:0.55rem;color:var(--ink-dim)">${us.count} segmen hulu · ${ds.count} segmen hiril</div>`;
    html += '</div>';
    return html;
  } catch(e) {
    return '';
  }
}

// ---- Spread Simulation UI (WebSocket streaming) ----
let _spreadWs = null;
let _spreadSimState = null;

function _spreadConcToColor(c) {
  if (c <= 0.01) return '#8fb3c4';
  if (c < 0.2) return '#22c55e';
  if (c < 0.5) return '#B8860B';
  if (c < 0.8) return '#C43B29';
  return '#000';
}

function _spreadConcLabel(c) {
  if (c <= 0.01) return 'Bersih';
  if (c < 0.2) return 'Rendah';
  if (c < 0.5) return 'Sederhana';
  if (c < 0.8) return 'Tinggi';
  return 'Kritikal';
}

async function runSpreadSim(segmentId, durationMin) {
  const vizEl = document.getElementById('spread-viz-' + segmentId);
  if (!vizEl) return;
  vizEl.innerHTML = '<div class="loading">Menyambung ke simulasi...</div>';

  if (_spreadWs) { try { _spreadWs.close(); } catch(e){} }

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/api/ws/spread`);
  _spreadWs = ws;

  let setup = null;
  const segConcs = [];
  let totalSteps = 0;

  const dur = durationMin || 60;
  ws.onopen = () => ws.send(JSON.stringify({ segment_id: segmentId, total_time_min: dur }));

  ws.onmessage = (evt) => {
    const msg = JSON.parse(evt.data);

    if (msg.type === 'error') {
      vizEl.innerHTML = `<div class="alert is-bad"><span class="alert-icon">!</span><div><div class="alert-title">Ralat</div><div class="alert-body">${msg.message}</div></div></div>`;
      return;
    }

    if (msg.type === 'setup') {
      setup = msg;
      totalSteps = msg.total_steps;
      msg.segments.forEach(() => segConcs.push([]));
      _buildSpreadShell(vizEl, msg);
      _clearSimMapOverlay();
      if (risiko_map && risiko_segments.length) {
        _initSimMapOverlay(msg);
        const wrap = document.getElementById('risiko-map-wrap');
        if (wrap) wrap.classList.add('sim-active');
        setTimeout(() => {
          if (risiko_map) {
            risiko_map.invalidateSize();
            const bounds = _getSimBounds();
            if (bounds) risiko_map.fitBounds(bounds, { padding: [40, 40] });
          }
        }, 300);
      }
      requestAnimationFrame(() => { if (risiko_map) risiko_map.invalidateSize(); });
      return;
    }

    if (msg.type === 'step' && setup) {
      msg.concentrations.forEach((c, i) => { if (segConcs[i]) segConcs[i].push(c); });
      _updateSpreadFrame(setup, segConcs, msg.t, totalSteps);
      _updateSimMapOverlay(setup, segConcs, msg.t);
    }

    if (msg.type === 'done') {
      _finishSpreadSimulation(setup, segConcs);
    }
  };

  ws.onerror = () => {
    vizEl.innerHTML = '<div class="alert is-bad"><span class="alert-icon">!</span><div><div class="alert-title">Ralat WebSocket</div><div class="alert-body">Gagal menyambung ke simulasi</div></div></div>';
  };
}

function _buildSpreadShell(container, setup) {
  const segs = setup.segments;
  const nSegs = segs.length;
  const maxSegName = 20;

  let html = '<div class="spread-wrap" id="spread-anim">';

  // ---- Header ----
  html += '<div class="spread-header">';
  html += '<div class="spread-header-left">';
  html += '<div class="spread-title">Pencemaran Sungai — Simulasi Masa Nyata</div>';
  html += `<div class="spread-subtitle">${setup.source_name} → ${nSegs} segmen hiril · ${setup.total_time_min} min simulasi</div>`;
  html += '</div>';
  html += '<div class="spread-status" id="spread-status-lbl">● Mengira...</div>';
  html += '</div>';

  // ---- Big Timer ----
  html += '<div class="spread-timer">';
  html += '<div class="spread-timer-value" id="spread-time-big">0:00</div>';
  html += '<div class="spread-timer-label">masa simulasi</div>';
  html += '</div>';

  // ---- Legend ----
  html += '<div class="spread-legend-bar">';
  html += '<div class="spread-legend-item"><span class="spread-legend-dot" style="background:#8fb3c4"></span> Bersih</div>';
  html += '<div class="spread-legend-item"><span class="spread-legend-dot" style="background:#22c55e"></span> Rendah</div>';
  html += '<div class="spread-legend-item"><span class="spread-legend-dot" style="background:#B8860B"></span> Sederhana</div>';
  html += '<div class="spread-legend-item"><span class="spread-legend-dot" style="background:#C43B29"></span> Tinggi</div>';
  html += '<div class="spread-legend-item"><span class="spread-legend-dot" style="background:#000"></span> Kritikal</div>';
  html += '</div>';

  // ---- Vertical River Waterfall ----
  html += '<div class="spread-waterfall">';
  segs.forEach((seg, i) => {
    const isSource = i === 0;
    const label = seg.name ? seg.name.substring(0, maxSegName) : 'Segmen ' + seg.segment_id;
    html += `<div class="spread-seg-row" id="seg-row-${i}">`;

    // Connector line (except first)
    if (i > 0) {
      html += '<div class="spread-connector"><div class="spread-connector-line" id="conn-line-' + i + '"></div><div class="spread-connector-arrow">▼</div></div>';
    }

    // Segment card
    html += `<div class="spread-seg-card${isSource ? ' source' : ''}" id="seg-card-${i}">`;
    html += '<div class="spread-seg-top">';
    html += `<span class="spread-seg-idx">${isSource ? '📍' : i}</span>`;
    html += `<span class="spread-seg-name" title="${seg.name || ''}">${label}</span>`;
    html += `<span class="spread-seg-tag" id="seg-tag-${i}">—</span>`;
    html += '</div>';
    html += '<div class="spread-seg-bar-track">';
    html += `<div class="spread-seg-bar-fill" id="seg-bar-${i}" style="width:0%"></div>`;
    html += '</div>';
    html += `<div class="spread-seg-num" id="seg-num-${i}">0%</div>`;
    html += '</div>';

    html += '</div>';
  });
  html += '</div>';

  // ---- Info row ----
  html += '<div class="spread-info-grid">';
  html += `<div class="spread-info-cell"><div class="spread-info-val" id="spread-seg-count">${nSegs}</div><div class="spread-info-lbl">Segmen terjejas</div></div>`;
  html += `<div class="spread-info-cell"><div class="spread-info-val" id="spread-max-conc">0%</div><div class="spread-info-lbl">Kepekatan maks</div></div>`;
  html += `<div class="spread-info-cell"><div class="spread-info-val" id="spread-max-reach">—</div><div class="spread-info-lbl">Jarak terjauh</div></div>`;
  html += `<div class="spread-info-cell"><div class="spread-info-val" id="spread-vel">${segs[0] ? segs[0].velocity_ms : 0} m/s</div><div class="spread-info-lbl">Halaju arus</div></div>`;
  html += '</div>';

  // ---- Controls ----
  html += '<div class="spread-controls">';
  html += '<button id="spread-play" class="spread-btn-main" title="Jeda / Main">⏸ Jeda</button>';
  html += '<button id="spread-slower" title="Perlahan">−</button>';
  html += '<span id="spread-speed">1×</span>';
  html += '<button id="spread-faster" title="Pantas">+</button>';
  html += '<div class="spread-timeline" id="spread-timeline">';
  html += '<div class="spread-timeline-fill" id="spread-timeline-fill"></div>';
  html += '<div class="spread-timeline-marker" id="spread-timeline-marker"></div>';
  html += '</div>';
  html += `<span id="spread-step-label">0 / ${setup.total_steps}</span>`;
  html += '</div>';

  html += '</div>';
  container.innerHTML = html;

  // Wire up controls
  const state = { paused: false, finished: false };
  document.getElementById('spread-play')?.addEventListener('click', () => {
    const btn = document.getElementById('spread-play');
    if (state.finished) {
      runSpreadSim(setup.source_segment_id, setup.total_time_min);
      return;
    }
    state.paused = !state.paused;
    if (state.paused) {
      btn.textContent = '▶ Sambung';
      btn.classList.remove('active-play');
    } else {
      btn.textContent = '⏸ Jeda';
      btn.classList.add('active-play');
    }
  });
  document.getElementById('spread-faster')?.addEventListener('click', () => {
    // Signal server is already streaming — just visual feedback
    const el = document.getElementById('spread-speed');
    if (el) { const cur = parseFloat(el.textContent) || 1; el.textContent = Math.min(cur * 2, 8) + '×'; }
  });
  document.getElementById('spread-slower')?.addEventListener('click', () => {
    const el = document.getElementById('spread-speed');
    if (el) { const cur = parseFloat(el.textContent) || 1; el.textContent = Math.max(cur / 2, 0.5) + '×'; }
  });
  // Store state on the container for access from update
  container._spreadState = state;
  _spreadSimState = state;
}

// ---- Map Simulation Overlay ----
let _simSegGeo = [];
let _simWavefront = null;
let _simWaveGlow = null;
let _simRadiation = [];

function _simSegLengthM(pts) {
  if (!pts || pts.length < 2) return 500;
  let d = 0;
  for (let i = 1; i < pts.length; i++) {
    const dy = (pts[i][0] - pts[i-1][0]) * 111000;
    const dx = (pts[i][1] - pts[i-1][1]) * 110960;
    d += Math.sqrt(dy*dy + dx*dx);
  }
  return Math.max(d, 100);
}

function _simSegMidPt(pts) {
  if (!pts || !pts.length) return null;
  return pts[Math.floor(pts.length / 2)];
}

function _initSimMapOverlay(setup) {
  if (!sim_layer || !risiko_map) return;
  sim_layer.clearLayers();
  _simSegGeo = [];
  _simWavefront = null;
  _simWaveGlow = null;
  _simRadiation = [];
  const segGeo = {};

  if (!risiko_segments || !risiko_segments.length) return;
  for (const rs of risiko_segments) {
    segGeo[rs.id] = rs;
  }

  for (const seg of setup.segments) {
    const rs = segGeo[seg.segment_id];
    const ptsRaw = rs && rs.geometry && rs.geometry[0];
    if (ptsRaw && ptsRaw.length >= 2) {
      _simSegGeo.push({ seg_id: seg.segment_id, pts: ptsRaw, rs });
    } else {
      _simSegGeo.push({ seg_id: seg.segment_id, pts: null, rs });
    }
  }

  for (const geo of _simSegGeo) {
    if (!geo.pts) continue;
    const pts = geo.pts.map(p => [p[0] + alignState.dlat, p[1] + alignState.dlon]);

    const glow = L.polyline(pts, {
      color: '#8fb3c4', weight: 14, opacity: 0, className: 'sim-glow-line',
    }).addTo(sim_layer);
    geo._glow = glow;

    const polyline = L.polyline(pts, {
      color: '#8fb3c4', weight: 5, opacity: 0.7, className: 'sim-seg-line',
    }).addTo(sim_layer);
    geo._line = polyline;

    const mid = _simSegMidPt(geo.pts);
    geo._label = L.marker([mid[0] + alignState.dlat, mid[1] + alignState.dlon], {
      icon: L.divIcon({
        className: 'sim-conc-label',
        iconSize: [40, 16],
        iconAnchor: [20, 8],
        html: '<span></span>',
      }),
      interactive: false,
    }).addTo(sim_layer);

    // Radiation rings placeholder — will be shown/hidden per step
    const segLen = _simSegLengthM(geo.pts);
    const midAdj = [mid[0] + alignState.dlat, mid[1] + alignState.dlon];
    const rings = [];
    const numRings = 6;
    for (let r = 0; r < numRings; r++) {
      const circle = L.circle(midAdj, {
        radius: 0,
        color: '#8fb3c4',
        fillColor: '#8fb3c4',
        fillOpacity: 0,
        weight: 0,
        className: 'sim-radiation-ring',
      }).addTo(sim_layer);
      rings.push(circle);
    }
    geo._rings = rings;
    geo._segLen = segLen;
    geo._midAdj = midAdj;
  }

  const srcInfo = setup.segments[0];
  const srcGeo = _simSegGeo[0];
  if (srcGeo && srcGeo.pts && srcGeo.pts.length > 0) {
    const mid = _simSegMidPt(srcGeo.pts);
    const srcLat = mid[0] + alignState.dlat, srcLon = mid[1] + alignState.dlon;
    L.circleMarker([srcLat, srcLon], {
      radius: 18, color: '#C43B29', fillColor: '#C43B29', fillOpacity: 0.12, weight: 0, className: 'sim-source-ring',
    }).addTo(sim_layer);
    L.circleMarker([srcLat, srcLon], {
      radius: 8, color: '#fff', fillColor: '#C43B29', fillOpacity: 0.95, weight: 3,
    }).addTo(sim_layer).bindPopup(`<b>Sumber Pencemaran</b><br>${srcInfo.name}`);
  }

  _simWaveGlow = L.circleMarker([0, 0], {
    radius: 0, color: '#ff4444', fillColor: '#ff4444', fillOpacity: 0, weight: 0,
  }).addTo(sim_layer);
  _simWavefront = L.circleMarker([0, 0], {
    radius: 0, color: '#fff', fillColor: '#ff4444', fillOpacity: 0, weight: 0,
  }).addTo(sim_layer);
}

function _updateSimMapOverlay(setup, segConcs, t) {
  if (!sim_layer || !_simSegGeo.length) return;
  let wfLat = 0, wfLon = 0, wfFound = false;

  for (let i = 0; i < _simSegGeo.length; i++) {
    const c = segConcs[i] ? (segConcs[i][t] || 0) : 0;
    const geo = _simSegGeo[i];
    if (!geo.pts) continue;

    const color = _spreadConcToColor(c);
    const isContaminated = c > 0.01;
    const isHigh = c > 0.5;
    const isCritical = c >= 0.8;

    // Segment line
    if (geo._line) {
      const weight = isCritical ? 10 : isHigh ? 8 : c > 0.2 ? 7 : isContaminated ? 6 : 5;
      geo._line.setStyle({ color, weight, opacity: isContaminated ? 0.92 : 0.35 });
    }

    // Glow behind segment
    if (geo._glow) {
      if (isContaminated) {
        geo._glow.setStyle({ color, weight: 28, opacity: isCritical ? 0.35 : isHigh ? 0.25 : 0.15 });
      } else {
        geo._glow.setStyle({ opacity: 0 });
      }
    }

    // Concentration label
    if (geo._label) {
      const el = geo._label._icon ? geo._label._icon.querySelector('span') : null;
      if (el) {
        if (isContaminated) {
          el.textContent = Math.round(c * 100) + '%';
          el.style.color = isHigh ? '#fff' : '#111';
          el.style.background = color;
          el.style.border = '1px solid ' + (isHigh ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.15)');
          el.style.display = 'block';
        } else {
          el.style.display = 'none';
        }
      }
    }

    // Radiation circles — concentric rings expanding outward
    if (geo._rings) {
      const numRings = geo._rings.length;
      for (let r = 0; r < numRings; r++) {
        const ring = geo._rings[r];
        if (isContaminated) {
          // Outermost ring (r=numRings-1) is largest, innermost (r=0) is smallest
          const ringFrac = (r + 1) / numRings;
          const maxRadius = Math.sqrt(geo._segLen) * 3.0 * c;
          const radius = maxRadius * ringFrac;
          // Opacity: innermost=0.22, outermost=0.06 — visible but not overwhelming
          const ringOpacity = 0.22 * c * (1 - ringFrac * 0.72);
          ring.setRadius(radius);
          ring.setStyle({ color, fillColor: color, fillOpacity: ringOpacity, weight: 0.5, opacity: ringOpacity * 0.6 });
        } else {
          ring.setRadius(0);
          ring.setStyle({ fillOpacity: 0, weight: 0 });
        }
      }
    }

    if (isContaminated && geo.pts.length > 0) {
      const lastPt = geo.pts[geo.pts.length - 1];
      wfLat = lastPt[0] + alignState.dlat;
      wfLon = lastPt[1] + alignState.dlon;
      wfFound = true;
    }
  }

  if (wfFound) {
    if (_simWavefront) {
      _simWavefront.setLatLng([wfLat, wfLon]);
      _simWavefront.setStyle({ radius: 8, color: '#fff', fillColor: '#ff4444', fillOpacity: 0.9, weight: 3 });
    }
    if (_simWaveGlow) {
      _simWaveGlow.setLatLng([wfLat, wfLon]);
      _simWaveGlow.setStyle({ radius: 22, color: '#ff4444', fillColor: '#ff4444', fillOpacity: 0.15, weight: 0 });
    }
  }
}

function _clearSimMapOverlay() {
  if (sim_layer) sim_layer.clearLayers();
  _simSegGeo = [];
  _simRadiation = [];
  const wrap = document.getElementById('risiko-map-wrap');
  if (wrap) wrap.classList.remove('sim-active');
}

function _getSimBounds() {
  if (!_simSegGeo.length) return null;
  let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
  for (const geo of _simSegGeo) {
    if (!geo.pts) continue;
    for (const p of geo.pts) {
      const lat = p[0] + alignState.dlat;
      const lon = p[1] + alignState.dlon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
    }
  }
  if (minLat === Infinity) return null;
  return [[minLat, minLon], [maxLat, maxLon]];
}

function _updateSpreadFrame(setup, segConcs, t, totalSteps) {
  const segs = setup.segments;
  const nSegs = segs.length;

  // Check pause state
  const container = document.getElementById('spread-anim');
  if (container && container._spreadState && container._spreadState.paused) return;

  // Time display
  const mins = Math.floor((setup.time_steps_minutes[t] || 0));
  const secs = Math.round(((setup.time_steps_minutes[t] || 0) % 1) * 60);
  const bigTime = document.getElementById('spread-time-big');
  if (bigTime) bigTime.textContent = `${mins}:${String(secs).padStart(2, '0')}`;

  let maxC = 0;
  let furthestIdx = -1;

  segs.forEach((seg, i) => {
    const c = segConcs[i] ? (segConcs[i][t] || 0) : 0;
    const color = _spreadConcToColor(c);
    const pct = Math.round(c * 100);

    if (c > maxC) maxC = c;
    if (c > 0.02) furthestIdx = i;

    const card = document.getElementById('seg-card-' + i);
    const bar = document.getElementById('seg-bar-' + i);
    const tag = document.getElementById('seg-tag-' + i);
    const num = document.getElementById('seg-num-' + i);
    const conn = document.getElementById('conn-line-' + i);

    if (card) {
      card.style.borderColor = color;
      card.style.boxShadow = c > 0.1 ? `0 0 12px ${color}44` : 'none';
    }
    if (bar) {
      bar.style.width = pct + '%';
      bar.style.background = color;
    }
    if (tag) {
      tag.textContent = _spreadConcLabel(c);
      tag.style.color = color;
      tag.style.fontWeight = c > 0.3 ? '700' : '500';
    }
    if (num) {
      num.textContent = pct + '%';
      num.style.color = color;
    }
    if (conn && c > 0.1) {
      conn.style.background = color;
    }
  });

  // Info grid
  const maxConcEl = document.getElementById('spread-max-conc');
  const maxReachEl = document.getElementById('spread-max-reach');
  if (maxConcEl) maxConcEl.textContent = Math.round(maxC * 100) + '%';
  if (maxReachEl && furthestIdx >= 0) {
    const seg = segs[furthestIdx];
    maxReachEl.textContent = `${furthestIdx} segmen`;
  }

  // Timeline
  const pct = totalSteps > 0 ? (t / totalSteps) * 100 : 0;
  const fillEl = document.getElementById('spread-timeline-fill');
  const markerEl = document.getElementById('spread-timeline-marker');
  if (fillEl) fillEl.style.width = pct + '%';
  if (markerEl) markerEl.style.left = pct + '%';

  const stepLabel = document.getElementById('spread-step-label');
  if (stepLabel) stepLabel.textContent = `${t} / ${totalSteps}`;
}

function _finishSpreadSimulation(setup, segConcs) {
  if (_spreadSimState) _spreadSimState.finished = true;
  const wrap = document.getElementById('spread-anim');
  const lbl = document.getElementById('spread-status-lbl');
  if (lbl) { lbl.textContent = '✓ Simulasi selesai'; lbl.style.background = '#22c55e22'; lbl.style.color = '#16a34a'; }
  const playBtn = document.getElementById('spread-play');
  if (playBtn) { playBtn.textContent = '↺ Ulang'; playBtn.classList.remove('active-play'); }

  if (!wrap) return;
  wrap.classList.add('spread-done');

  const nSegs = (setup.segments || []).length;
  const lastConcs = segConcs.map(arr => arr.length ? arr[arr.length - 1] : 0);
  const maxC = Math.max(0, ...lastConcs);
  const affected = lastConcs.filter(c => c > 0.01).length;

  const banner = document.createElement('div');
  banner.className = 'spread-summary-banner';
  banner.innerHTML = `
    <div class="spread-summary-grid">
      <div class="spread-summary-cell">
        <div class="spread-summary-val">${nSegs}</div>
        <div class="spread-summary-lbl">Segmen Dilalui</div>
      </div>
      <div class="spread-summary-cell">
        <div class="spread-summary-val">${affected}</div>
        <div class="spread-summary-lbl">Terjejas</div>
      </div>
      <div class="spread-summary-cell">
        <div class="spread-summary-val">${Math.round(maxC * 100)}%</div>
        <div class="spread-summary-lbl">Kepekatan Maks</div>
      </div>
      <div class="spread-summary-cell">
        <div class="spread-summary-val">${setup.total_time_min} min</div>
        <div class="spread-summary-lbl">Tempoh Simulasi</div>
      </div>
    </div>
    <div class="spread-summary-title">Kesimpulan Simulasi</div>
    <div class="spread-summary-text">
      Pencemaran bergerak sepanjang ${nSegs} segmen sungai selama ${setup.total_time_min} min.
      ${affected > 0 ? `${affected} segmen terjejas dengan kepekatan sehingga ${Math.round(maxC * 100)}%.` : 'Tiada kesan pencemaran signifikan.'}
    </div>
    <div style="display:flex;gap:0.4rem;margin-top:0.5rem">
      <button class="btn btn-primary" style="font-size:0.6rem" onclick="var b=_getSimBounds();if(b)risiko_map.fitBounds(b,{padding:[40,40]})">Tunjuk Peta</button>
      <button class="btn" style="font-size:0.6rem" onclick="_clearSimMapOverlay();renderSegmentsOnMap()">Padam Lapisan</button>
    </div>
  `;
  wrap.appendChild(banner);

  const grid = wrap.querySelector('.spread-info-grid');
  if (grid) grid.classList.add('spread-info-glow');

  const cards = wrap.querySelectorAll('.spread-seg-card');
  cards.forEach((card, i) => {
    setTimeout(() => {
      card.classList.add('spread-seg-final');
      const c = lastConcs[i] || 0;
      if (c > 0.1) card.style.boxShadow = `0 0 20px ${_spreadConcToColor(c)}55, 0 0 40px ${_spreadConcToColor(c)}22`;
    }, i * 60);
  });

  const timer = document.getElementById('spread-time-big');
  if (timer) {
    timer.classList.add('spread-timer-done');
    timer.textContent = `${setup.total_time_min} min`;
  }
  requestAnimationFrame(() => { if (risiko_map) risiko_map.invalidateSize(); });
}

// ---- Satellite Overlay ----
let _satelliteLayer = null;
const SATELLITE_URLS = {
  'Satelit (Esri)': 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  'Topografi': 'https://server.arcgisonline.com/ArcGIS/rest/services/Topo/MapServer/tile/{z}/{y}/{x}',
  'Terrain': 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Terrain_Base/MapServer/tile/{z}/{y}/{x}',
};

function addSatelliteToggle(map) {
  if (!map) return;
  const ctrl = L.control({ position: 'topright' });
  ctrl.onAdd = function() {
    const div = L.DomUtil.create('div', 'satellite-controls');
    div.style.background = 'var(--bg-card)';
    div.style.padding = '0.3rem 0.5rem';
    div.style.border = '1px solid var(--border)';
    div.innerHTML = `
      <label style="display:flex;align-items:center;gap:0.3rem;cursor:pointer;font-family:var(--font-mono);font-size:0.6rem">
        <input type="checkbox" id="sat-toggle"> 🛰 Satelit
      </label>
    `;
    L.DomEvent.disableClickPropagation(div);
    div.querySelector('#sat-toggle').addEventListener('change', function() {
      _satelliteActive = this.checked;
      if (this.checked) {
        _satelliteLayer = L.tileLayer(SATELLITE_URLS['Satelit (Esri)'], {
          maxZoom: 19, opacity: 0.7,
        }).addTo(map);
      } else if (_satelliteLayer) {
        map.removeLayer(_satelliteLayer);
        _satelliteLayer = null;
      }
      // Re-render segments with satellite-aware colors
      renderSegmentsOnMap();
    });
    return div;
  };
  ctrl.addTo(map);
}

// ---- Surface Runoff Prediction Overlay ----
let _runoffData = null;
let _runoffModel = localStorage.getItem('rd_runoff_model') || 'hybrid';

function _runoffColor(risk, level) {
  if (level === 'TINGGI') return '#e74c3c';
  if (level === 'SEDERHANA') return '#f39c12';
  return '#27ae60';
}

function _runoffSourceIcon(sourceType) {
  if (sourceType === 'Sumber Utama') return '\u{1F534}';
  if (sourceType === 'Hulu') return '\u{1F7E0}';
  if (sourceType === 'Titik Akumulasi') return '\u{1F535}';
  return '\u{1F7E2}';
}

function _flowLineColor(c) {
  if (c >= 0.8) return '#c0392b';
  if (c >= 0.6) return '#e67e22';
  if (c >= 0.4) return '#f1c40f';
  if (c >= 0.25) return '#2ecc71';
  return '#3498db';
}

function _genFlowSources(seg) {
  const center = seg.center;
  if (!center || !center.length) return [];
  const bd = seg.land_use_breakdown || [];
  if (!bd.length) return [];
  const sources = [];
  const goldenAngle = 137.508;
  const baseAngle = (seg.segment_id * goldenAngle) % 360;
  const n = Math.min(bd.length, 5);
  for (let i = 0; i < n; i++) {
    const angle = ((baseAngle + i * (360 / n)) * Math.PI) / 180;
    const distDeg = (bd[i].distance_m || 300) / 111000;
    sources.push({
      lat: center[0] + distDeg * Math.cos(angle),
      lon: center[1] + distDeg * Math.sin(angle),
      type: bd[i].type,
      c: bd[i].c,
    });
  }
  return sources;
}

function _bezierCurve(from, to, n) {
  n = n || 14;
  const dx = to[1] - from[1];
  const dy = to[0] - from[0];
  const cpLat = (from[0] + to[0]) / 2 + dy * 0.25;
  const cpLon = (from[1] + to[1]) / 2 - dx * 0.25;
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    pts.push([
      u * u * from[0] + 2 * u * t * cpLat + t * t * to[0],
      u * u * from[1] + 2 * u * t * cpLon + t * t * to[1],
    ]);
  }
  return pts;
}

function _makeArrowIcon(color, size) {
  const s = size || 8;
  return L.divIcon({
    className: 'runoff-arrow',
    iconSize: [s, s],
    iconAnchor: [s / 2, s / 2],
    html: `<svg width="${s}" height="${s}" viewBox="0 0 10 10"><polygon points="5,0 10,8 5,6 0,8" fill="${color}" opacity="0.7"/></svg>`,
  });
}

function _octagonPts(center, radiusDeg, n) {
  n = n || 8;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const angle = (2 * Math.PI * i) / n;
    pts.push([
      center[0] + radiusDeg * Math.cos(angle),
      center[1] + radiusDeg * Math.sin(angle),
    ]);
  }
  pts.push(pts[0]);
  return pts;
}

async function toggleRunoffOverlay() {
  if (_runoffData) { _clearRunoffOverlay(); return; }
  await _loadRunoffOverlay();
}

async function _loadRunoffOverlay() {
  toast('Memuatkan data larian permukaan...');
  try {
    _runoffData = await apiGet('/runoff/prediction?model=' + encodeURIComponent(_runoffModel), true);
    _drawRunoffOverlay();
    _showRunoffPanel();
    toast(`Data larian permukaan dimuatkan \u2014 ${_runoffData.summary.total} segmen`);
  } catch (e) { toast('Gagal memuat data larian permukaan: ' + e.message); }
}

function _drawRunoffOverlay() {
  if (!_runoff_layer || !_runoffData) return;
  _runoff_layer.clearLayers();
  const segs = _runoffData.segments || [];

  for (const seg of segs) {
    if (!seg.center || !seg.center.length) continue;
    const cLat = seg.center[0] + alignState.dlat;
    const cLon = seg.center[1] + alignState.dlon;
    const color = _runoffColor(seg.runoff_risk, seg.risk_level);
    const flowColor = _flowLineColor(seg.runoff_coefficient);

    // 1. Catchment zone polygon (octagon)
    if (seg.drainage_factor > 1.0 || seg.runoff_coefficient > 0.5) {
      const radiusDeg = Math.min(0.005, 0.0015 + seg.runoff_coefficient * 0.004);
      const polyPts = _octagonPts([cLat, cLon], radiusDeg, 8);
      L.polygon(polyPts, {
        color: flowColor,
        fillColor: flowColor,
        fillOpacity: 0.10 * seg.runoff_coefficient,
        weight: 1.5,
        opacity: 0.25,
        className: 'runoff-catchment',
      }).addTo(_runoff_layer);
    }

    // 2. Flow lines FROM synthetic land use positions TOWARD segment
    const flowSources = _genFlowSources(seg);
    for (const src of flowSources) {
      const srcLat = src.lat + alignState.dlat;
      const srcLon = src.lon + alignState.dlon;
      const lineColor = _flowLineColor(src.c);
      const curve = _bezierCurve([srcLat, srcLon], [cLat, cLon], 14);

      // Flow line
      L.polyline(curve, {
        color: lineColor,
        weight: 2.5,
        opacity: 0.5 + 0.2 * src.c,
        className: 'runoff-flow-line',
      }).addTo(_runoff_layer);

      // Arrow at midpoint of flow (shows direction toward river)
      const midIdx = Math.floor(curve.length / 2);
      const arrowPt = curve[midIdx];
      if (arrowPt) {
        L.marker(arrowPt, {
          icon: _makeArrowIcon(lineColor, 9),
          interactive: false,
        }).addTo(_runoff_layer);
      }
    }

    // 3. Segment river line
    if (seg.geometry && seg.geometry.length >= 2) {
      const pts = seg.geometry.map(p => [p[0] + alignState.dlat, p[1] + alignState.dlon]);
      const weight = seg.source_type === 'Sumber Utama' ? 6 :
                     seg.source_type === 'Titik Akumulasi' ? 5 : 4;
      const line = L.polyline(pts, {
        color: color, weight: weight, opacity: 0.7, className: 'runoff-seg-line',
      }).addTo(_runoff_layer);
      line.bindTooltip(
        `<div style="font-family:var(--font-mono);font-size:0.6rem;line-height:1.5">
          <b>${_runoffSourceIcon(seg.source_type)} ${seg.name}</b><br>
          Jenis: ${seg.source_type}<br>
          Koef. Larian: ${seg.runoff_coefficient}<br>
          Guna Tanah: ${seg.dominant_land_use}<br>
          Hulu: ${seg.upstream_count} segmen<br>
          Risiko Larian: <b style="color:${color}">${seg.runoff_risk.toFixed(1)}</b>
        </div>`,
        { sticky: true, className: 'runoff-tooltip' }
      );
      line.on('click', () => {
        showSegmentDetail(seg.segment_id);
        risiko_map.flyTo(seg.center, 14, { duration: 0.8 });
      });
    }
  }

  // Source markers (headwater + high C)
  const sources = _runoffData.top_sources || [];
  for (const src of sources) {
    if (!src.center) continue;
    const icon = L.divIcon({
      className: 'runoff-source-marker',
      html: `<div style="background:${_runoffColor(src.runoff_risk, src.runoff_risk > 65 ? 'TINGGI' : 'SEDERHANA')};width:12px;height:12px;border-radius:50%;border:2px solid white;box-shadow:0 0 6px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;font-size:7px;color:white;font-weight:bold">${_runoffSourceIcon(src.source_type)}</div>`,
      iconSize: [12, 12], iconAnchor: [6, 6],
    });
    L.marker(src.center, { icon }).addTo(_runoff_layer)
      .bindTooltip(
        `<div style="font-family:var(--font-mono);font-size:0.6rem">
          <b>${src.name}</b><br>
          Sumber: ${src.source_type}<br>
          C = ${src.runoff_coefficient}<br>
          Risiko: ${src.runoff_risk.toFixed(1)}
        </div>`,
        { sticky: true }
      )
      .on('click', () => {
        showSegmentDetail(src.segment_id);
        risiko_map.flyTo(src.center, 14, { duration: 0.8 });
      });
  }
}

function _clearRunoffOverlay() {
  if (_runoff_layer) _runoff_layer.clearLayers();
  _runoffData = null;
  const panel = document.getElementById('runoff-panel');
  if (panel) panel.remove();
}

function _showRunoffPanel() {
  if (!_runoffData) return;
  const existing = document.getElementById('runoff-panel');
  if (existing) existing.remove();
  const s = _runoffData.summary;
  const sources = _runoffData.top_sources || [];
  const accum = _runoffData.top_accumulation || [];
  const modelOptions = (s.available_models || [
    { id: 'hybrid', name: 'Hibrid (SCS-CN + Infrastruktur)' },
    { id: 'scs', name: 'SCS-CN Guna Tanah' },
    { id: 'infrastructure', name: 'Infrastruktur Saliran' },
  ]).map(m => `<option value="${m.id}" ${m.id === (s.model_id || _runoffModel) ? 'selected' : ''}>${m.name}</option>`).join('');
  const html = `
    <div id="runoff-panel" style="position:absolute;top:8px;left:8px;width:280px;max-height:calc(100vh - 100px);
      background:var(--bg-card);border:1px solid var(--border);border-radius:10px;
      padding:0.6rem;z-index:1100;overflow-y:auto;font-family:var(--font-mono);font-size:0.6rem;
      box-shadow:0 4px 20px rgba(0,0,0,0.3)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem">
        <b style="color:var(--accent)">\u{1F30A} Larian Permukaan</b>
        <button class="btn" style="font-size:0.55rem;padding:0.15rem 0.3rem" onclick="_clearRunoffOverlay()">\u2715 Tutup</button>
      </div>
      <label style="display:block;color:var(--ink-muted);margin-bottom:0.15rem">Model Ramalan</label>
      <select id="runoff-model-select" style="width:100%;padding:0.25rem 0.35rem;margin-bottom:0.2rem;border:1px solid var(--border);border-radius:5px;background:var(--bg);font-family:var(--font-mono);font-size:0.58rem">
        ${modelOptions}
      </select>
      <div style="color:var(--ink-muted);font-size:0.52rem;line-height:1.35;margin-bottom:0.5rem">${s.model_description || ''}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.3rem;margin-bottom:0.5rem">
        <div style="background:var(--bg);padding:0.3rem;border-radius:5px;text-align:center">
          <div style="color:var(--ink-muted)">Jumlah</div>
          <div style="font-size:0.85rem;font-weight:bold">${s.total}</div>
        </div>
        <div style="background:var(--bg);padding:0.3rem;border-radius:5px;text-align:center">
          <div style="color:var(--ink-muted)">Purata Risiko</div>
          <div style="font-size:0.85rem;font-weight:bold">${s.avg_risk}</div>
        </div>
        <div style="background:var(--bg);padding:0.3rem;border-radius:5px;text-align:center">
          <div style="color:var(--ink-muted)">Hulu</div>
          <div style="font-size:0.85rem;font-weight:bold;color:#f39c12">${s.total_headwater}</div>
        </div>
        <div style="background:var(--bg);padding:0.3rem;border-radius:5px;text-align:center">
          <div style="color:var(--ink-muted)">C Purata</div>
          <div style="font-size:0.85rem;font-weight:bold">${s.avg_runoff_coefficient}</div>
        </div>
      </div>
      <div style="display:flex;gap:0.3rem;margin-bottom:0.5rem">
        <div style="flex:1;background:#e74c3c22;border:1px solid #e74c3c44;border-radius:5px;text-align:center;padding:0.2rem">
          <div style="color:#e74c3c;font-weight:bold">${s.levels.TINGGI}</div>
          <div style="font-size:0.5rem;color:var(--ink-muted)">TINGGI</div>
        </div>
        <div style="flex:1;background:#f39c1222;border:1px solid #f39c1244;border-radius:5px;text-align:center;padding:0.2rem">
          <div style="color:#f39c12;font-weight:bold">${s.levels.SEDERHANA}</div>
          <div style="font-size:0.5rem;color:var(--ink-muted)">SEDERHANA</div>
        </div>
        <div style="flex:1;background:#27ae6022;border:1px solid #27ae6044;border-radius:5px;text-align:center;padding:0.2rem">
          <div style="color:#27ae60;font-weight:bold">${s.levels.RENDAH}</div>
          <div style="font-size:0.5rem;color:var(--ink-muted)">RENDAH</div>
        </div>
      </div>
      <div style="font-weight:bold;margin-bottom:0.3rem;color:#e74c3c">\u{1F4CD} Sumber Utama Larian</div>
      <div style="max-height:120px;overflow-y:auto">
        ${sources.map(src => `
          <div class="runoff-src-item" onclick="showSegmentDetail(${src.segment_id});risiko_map.flyTo([${src.center}],14,{duration:0.8})"
            style="display:flex;justify-content:space-between;padding:0.2rem;border-bottom:1px solid var(--border);cursor:pointer;transition:background 0.2s"
            onmouseenter="this.style.background='var(--bg)'" onmouseleave="this.style.background=''">
            <span>${_runoffSourceIcon(src.source_type)} ${src.name.substring(0,25)}</span>
            <span style="color:${_runoffColor(src.runoff_risk, src.runoff_risk > 65 ? 'TINGGI' : 'SEDERHANA')}">${src.runoff_risk.toFixed(0)}</span>
          </div>
        `).join('')}
      </div>
      ${accum.length > 0 ? `
        <div style="font-weight:bold;margin:0.4rem 0 0.3rem;color:#3498db">\u{1F53D} Titik Akumulasi</div>
        <div style="max-height:100px;overflow-y:auto">
          ${accum.map(a => `
            <div class="runoff-accum-item" onclick="showSegmentDetail(${a.segment_id});risiko_map.flyTo([${a.center}],14,{duration:0.8})"
              style="display:flex;justify-content:space-between;padding:0.2rem;border-bottom:1px solid var(--border);cursor:pointer;transition:background 0.2s"
              onmouseenter="this.style.background='var(--bg)'" onmouseleave="this.style.background=''">
              <span>\u{1F535} ${a.name.substring(0,25)}</span>
              <span style="color:#3498db">${a.upstream_count}\u2191 ${a.runoff_risk.toFixed(0)}</span>
            </div>
          `).join('')}
        </div>
      ` : ''}
    </div>
  `;
  const mapWrap = document.getElementById('risiko-map-wrap');
  if (mapWrap) {
    mapWrap.style.position = 'relative';
    mapWrap.insertAdjacentHTML('beforeend', html);
    document.getElementById('runoff-model-select')?.addEventListener('change', async e => {
      _runoffModel = e.target.value;
      localStorage.setItem('rd_runoff_model', _runoffModel);
      _clearRunoffOverlay();
      await _loadRunoffOverlay();
    });
  }
}

function _addRunoffToggle(map) {
  const ctrl = L.control({ position: 'topleft' });
  ctrl.onAdd = function() {
    const div = L.DomUtil.create('div', 'runoff-toggle-ctrl');
    div.style.cssText = 'background:var(--bg-card);padding:0.3rem 0.5rem;border:1px solid var(--border);border-radius:5px;cursor:pointer;font-family:var(--font-mono);font-size:0.6rem';
    div.innerHTML = '\u{1F30A} Larian Permukaan';
    div.title = 'Toggle lapisan larian permukaan';
    L.DomEvent.disableClickPropagation(div);
    div.addEventListener('click', () => toggleRunoffOverlay());
    return div;
  };
  ctrl.addTo(map);
}

function _addGpsControl(map) {
  const ctrl = L.control({ position: 'topleft' });
  ctrl.onAdd = function() {
    const div = L.DomUtil.create('div', 'gps-ctrl');
    div.style.cssText = 'background:var(--bg-card);padding:0.3rem 0.5rem;border:1px solid var(--border);border-radius:5px;cursor:pointer;font-family:var(--font-mono);font-size:0.6rem';
    div.innerHTML = '\u{1F4CD} GPS';
    div.title = 'Terbang ke lokasi saya';
    L.DomEvent.disableClickPropagation(div);
    div.addEventListener('click', () => {
      if (!navigator.geolocation) { toast('Geolokasi tidak disokong'); return; }
      div.innerHTML = '\u{1F504} ...';
      navigator.geolocation.getCurrentPosition(
        pos => {
          const { latitude: lat, longitude: lon } = pos.coords;
          map.flyTo([lat, lon], 14, { duration: 1 });
          let gpsMarker = map._gpsMarker;
          if (gpsMarker) map.removeLayer(gpsMarker);
          gpsMarker = L.circleMarker([lat, lon], {
            radius: 7, color: '#3b82f6', fillColor: '#3b82f6', fillOpacity: 0.9, weight: 2, opacity: 1,
          }).addTo(map).bindPopup('<b>Lokasi Anda</b><br>' + lat.toFixed(5) + ', ' + lon.toFixed(5));
          map._gpsMarker = gpsMarker;
          div.innerHTML = '\u{1F4CD} GPS';
          toast('Lokasi diperolehi');
        },
        () => { div.innerHTML = '\u{1F4CD} GPS'; toast('Gagal mendapat lokasi'); },
        { enableHighAccuracy: true, timeout: 10000 }
      );
    });
    return div;
  };
  ctrl.addTo(map);
}

// ---- PDF Export ----
async function exportSegmentPDF(segmentId) {
  toast('Menjana PDF...');
  try {
    const resp = await fetch(API + '/export/pdf/' + segmentId, {
      headers: getAuthToken() ? { 'Authorization': 'Bearer ' + getAuthToken() } : {},
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.detail || 'PDF gagal');
    }
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'river_detective_seg_' + segmentId + '.pdf';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast('PDF berjaya dimuat turun!');
  } catch(e) {
    toast('Ralat PDF: ' + e.message);
  }
}

// ---- Image Analysis ----
function setupImageUpload(containerId, reportId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = `
    <div class="image-upload-area" id="img-upload-area">
      <div class="upload-icon">📷</div>
      <div class="upload-text">Klik atau seret gambar pencemaran di sini</div>
      <input type="file" id="img-upload-input" accept="image/*">
    </div>
    <div id="img-preview-container"></div>
    <div id="img-analysis-result"></div>
  `;
  const area = document.getElementById('img-upload-area');
  const input = document.getElementById('img-upload-input');
  area.addEventListener('click', () => input.click());
  area.addEventListener('dragover', (e) => { e.preventDefault(); area.style.borderColor = 'var(--accent)'; });
  area.addEventListener('dragleave', () => { area.style.borderColor = ''; });
  area.addEventListener('drop', (e) => {
    e.preventDefault();
    area.style.borderColor = '';
    if (e.dataTransfer.files.length) analyzeUploadedImage(e.dataTransfer.files[0], reportId);
  });
  input.addEventListener('change', () => {
    if (input.files.length) analyzeUploadedImage(input.files[0], reportId);
  });
}

async function analyzeUploadedImage(file, reportId) {
  const preview = document.getElementById('img-preview-container');
  const result = document.getElementById('img-analysis-result');
  if (!preview || !result) return;

  // Preview
  const reader = new FileReader();
  reader.onload = (e) => {
    preview.innerHTML = `<img src="${e.target.result}" class="image-preview" alt="Preview">`;
  };
  reader.readAsDataURL(file);

  result.innerHTML = '<div class="loading">Menganalisis imej...</div>';

  // Convert to base64
  const b64 = await new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.readAsDataURL(file);
  });

  try {
    const data = await apiPost('/analyze-image', {
      report_id: reportId || null,
      image_base64: b64,
      description: '',
    });
    result.innerHTML = `
      <div class="image-analysis-result">
        <div class="result-row"><span class="result-label">Jenis Pencemaran</span><span class="result-value">${data.pollution_type || '—'}</span></div>
        <div class="result-row"><span class="result-label">Keyakinan</span><span class="result-value">${data.confidence || 0}%</span></div>
        <div class="result-row"><span class="result-label">Penerangan</span><span class="result-value">${data.description || '—'}</span></div>
        ${data.color_rgb ? `<div class="result-row"><span class="result-label">Warna Dominan</span><span class="result-value" style="display:flex;align-items:center;gap:0.3rem"><span style="width:16px;height:16px;background:rgb(${data.color_rgb.join(',')});border:1px solid var(--border);display:inline-block"></span>rgb(${data.color_rgb.join(',')})</span></div>` : ''}
      </div>
    `;
  } catch(e) {
    result.innerHTML = `<div class="alert is-bad"><span class="alert-icon">!</span><div><div class="alert-title">Ralat Analisis</div><div class="alert-body">${e.message}</div></div></div>`;
  }
}

// ---- Enriched segment detail enhancement (add topology, spread, image analysis, PDF) ----
const _origLoadSegmentDetail = typeof loadSegmentDetail === 'function' ? loadSegmentDetail : null;

async function loadSegmentDetailEnhanced(segmentId) {
  if (_origLoadSegmentDetail) await _origLoadSegmentDetail(segmentId);

  // Enhance the detail panel with new features
  const detailEl = document.getElementById('risiko-segment-info');
  if (!detailEl) return;

  let extraHtml = '';

  // Topology
  try {
    const topoHtml = await loadTopologyPopup(segmentId);
    if (topoHtml) extraHtml += topoHtml;
  } catch(e) {}

  // Spread simulation button + container
  extraHtml += `
    <div style="margin-top:0.5rem">
      <div style="display:flex;gap:0.25rem;margin-bottom:0.3rem">
        <label class="mono" style="font-size:0.55rem;color:var(--ink-muted);align-self:center">Masa Simulasi</label>
        <select class="spread-dur-select" id="spread-dur-${segmentId}" style="flex:1;padding:0.15rem 0.3rem;font-size:0.6rem;border:1px solid var(--border);border-radius:5px;background:var(--bg);font-family:var(--font-mono)">
          <option value="60" selected>1 jam</option>
          <option value="720">1/2 hari</option>
          <option value="1440">1 hari</option>
          <option value="2880">2 hari</option>
          <option value="4320">3 hari</option>
          <option value="5760">4 hari</option>
          <option value="7200">5 hari</option>
          <option value="10080">1 minggu</option>
          <option value="20160">2 minggu</option>
          <option value="43200">1 bulan</option>
        </select>
      </div>
      <button class="btn" id="spread-run-btn-${segmentId}" onclick="runSpreadSim(${segmentId}, parseInt(document.getElementById('spread-dur-${segmentId}').value))">▶ Simulasi Pencemaran</button>
      <div id="spread-viz-${segmentId}" style="margin-top:0.3rem"></div>
    </div>
  `;

  // PDF export button
  extraHtml += `
    <div style="margin-top:0.5rem">
      <button class="btn pdf-export-btn" onclick="exportSegmentPDF(${segmentId})">📄 Muat Turun PDF</button>
    </div>
  `;

  detailEl.insertAdjacentHTML('beforeend', extraHtml);
}


// ===== Init =====
document.addEventListener('DOMContentLoaded', () => {
  updateNavAuth();

  // Connect WebSocket for real-time alerts
  connectWebSocket();

  document.getElementById('hamburger').addEventListener('click', () => {
    document.getElementById('mobile-nav').classList.toggle('open');
    document.getElementById('mobile-overlay').classList.toggle('open');
  });
  document.getElementById('mobile-close').addEventListener('click', closeMobile);
  document.getElementById('mobile-overlay').addEventListener('click', closeMobile);
  document.querySelectorAll('.nav-link').forEach(el => {
    el.addEventListener('click', () => { if (el.dataset.page) navigate(el.dataset.page); });
  });
  navigate(location.hash.replace('#', '') || 'risiko');

  // Verify existing session in the background so Render cold starts do not block page navigation.
  const tok = getAuthToken();
  if (tok) {
    apiGet('/me', true).then(me => {
      _authUser = me.user_id;
      _isAdmin = !!me.is_admin;
      setUserId(me.user_id);
      updateNavAuth();
      if (currentPage === 'sahkan' && !_isAdmin) navigate('risiko');
    }).catch(() => {
      setAuthToken('');
      setUserId('');
      _authUser = '';
      _isAdmin = false;
      updateNavAuth();
    });
  }
});
