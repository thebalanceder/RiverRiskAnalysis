/* ============================================
   RIVER DETECTIVE — Research Journal Frontend
   Real data only · Leaflet map · Functional UI
   ============================================ */
const API = '/api';
let currentPage = 'dashboard';

function getAuthToken() { return localStorage.getItem('rd_token'); }
function setAuthToken(t) { if (t) localStorage.setItem('rd_token', t); else localStorage.removeItem('rd_token'); }
function getUserId() { return localStorage.getItem('rd_user') || ''; }
function setUserId(u) { if (u) localStorage.setItem('rd_user', u); else localStorage.removeItem('rd_user'); }
let _authUser = '';  // current session user_id, verified by /api/me
let _isAdmin = false;
let _risikoRenderId = 0;
let riskFilter = 'all';
let _mapCache = { segments: null, locations: null, ts: 0 };
const MAP_CACHE_TTL = 5 * 60 * 1000;

// ===== RISK COLORS =====
const RISK_COLORS = {
  KRITIKAL: '#000000',
  TINGGI:   '#C43B29',
  SEDERHANA: '#B8860B',
  RENDAH:   '#2B6B5B',
};
const RISK_ORDER = ['RENDAH', 'SEDERHANA', 'TINGGI', 'KRITIKAL'];

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

// ===== Router =====
function navigate(page) {
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
async function apiGet(path) {
  const headers = {};
  const tok = getAuthToken();
  if (tok) headers['Authorization'] = 'Bearer ' + tok;
  const r = await fetch(API + path, { headers });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    const msg = Array.isArray(err.detail) ? err.detail.map(d => d.msg).join('; ') : (err.detail || `HTTP ${r.status}`);
    throw new Error(msg);
  }
  return r.json();
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
  return r.json();
}

// ===== Risk Color Helpers =====
function riskColor(level) {
  return RISK_COLORS[level] || '#2B6B5B';
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
    case 'risiko': renderRisiko(el); break;
    case 'report': renderReport(el); break;
    case 'sahkan': renderSahkan(el); break;
    case 'leaderboard': renderLeaderboard(el); break;
    case 'data': renderData(el); break;
    case 'profile': renderProfile(el); break;
    case 'login': renderLogin(el); break;
    default: renderRisiko(el);
  }
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
    // Also update profile page nav
    document.querySelectorAll('[data-page="profile"]').forEach(el => { if (el.tagName === 'A') el.style.display = ''; });
  } else {
    loginEl.style.display = '';
    userEl.style.display = 'none';
    document.querySelectorAll('[data-page="profile"]').forEach(el => { if (el.tagName === 'A') el.style.display = 'none'; });
  }
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
    try {
      const cfg = await apiGet('/admin/config');
      document.getElementById('admin-threshold').value = cfg.auto_sah_threshold || 0;
      mlMode = cfg.ml_model_mode || 'heuristic';
    } catch {}
    const mlLabel = document.getElementById('ml-mode-label');
    const mlAvailable = cfg.ml_available === true;
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
    const el = document.getElementById('lb-body');
    if (el) el.innerHTML = `<tr><td colspan="5" style="color:var(--alert);padding:0.5rem">✗ ${e.message}</td></tr>`;
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
      <div class="stat-box"><div class="stat-num">—</div><div class="stat-label">Balai Polis</div></div>
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
      s.segments_with_jurisdiction,
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
    const el = document.getElementById('data-sources');
    if (el) el.innerHTML = `<tr><td colspan="3" style="color:var(--alert);padding:0.5rem">✗ ${e.message}</td></tr>`;
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

    <div style="display:grid;grid-template-columns:1fr 220px;gap:0.75rem">
      <div class="map-wrap" id="risiko-map-wrap">
        <div class="map-inner" id="risiko-map" style="min-height:520px;height:100%"></div>
      </div>
      <div id="risiko-sidebar">
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

  // Use cache for instant render if available
  const now = Date.now();
  const cacheOk = _mapCache.segments && (now - _mapCache.ts < MAP_CACHE_TTL);

  if (cacheOk) {
    risiko_segments = _mapCache.segments;
    renderSegmentsOnMap();
    renderReportMarkers(_mapCache.locations || []);
    const rcEl = document.getElementById('risiko-count');
    if (rcEl) rcEl.textContent = `${risiko_segments.length} segmen`;
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
        renderSegmentsOnMap();
        const rcEl = document.getElementById('risiko-count');
        if (rcEl) rcEl.textContent = `${risiko_segments.length} segmen`;
        _fitMapToSegments();
      });
      locPromise.then(locData => {
        if (currentPage !== 'risiko' || renderId !== _risikoRenderId) return;
        _mapCache.locations = locData.locations || [];
        _mapCache.ts = Date.now();
        renderReportMarkers(_mapCache.locations);
      });
    } else {
      // First load: await both
      const [segData, locData] = await Promise.all([segPromise, locPromise]);
      if (currentPage !== 'risiko' || renderId !== _risikoRenderId) return;
      _mapCache.segments = segData.segments || [];
      _mapCache.locations = locData.locations || [];
      _mapCache.ts = Date.now();
      risiko_segments = _mapCache.segments;
      const rcEl = document.getElementById('risiko-count');
      if (rcEl) rcEl.textContent = `${risiko_segments.length} segmen`;
      renderSegmentsOnMap();
      renderReportMarkers(_mapCache.locations);
    }

    // Fit map once after data is ready
    if (!cacheOk) _fitMapToSegments();

    // Load model mode
    (async () => {
      try {
        const m = await apiGet('/model/mode');
        if (currentPage !== 'risiko' || renderId !== _risikoRenderId) return;
        const rptLabel = m.mode === 'enabled' ? 'Laporan + Asal (Digabung)' : 'Asal (Pemetaan)';
        const mlAvailable = m.ml_available === true;
        const mlLabel = m.ml_model_mode === 'ml' ? 'ML (Data Sebenar)' : 'Heuristik (Peraturan)';
        document.getElementById('model-mode-display').innerHTML = `
          <div class="mono" style="font-size:0.6rem;color:var(--ink-muted)">Model Laporan</div>
          <div style="display:flex;justify-content:space-between;align-items:center">
            <span class="mono" style="font-size:0.6rem">${rptLabel}</span>
            <button class="btn" id="btn-toggle-model" style="font-size:0.55rem;padding:0.15rem 0.4rem">Tukar</button>
          </div>
          <div class="mono" style="font-size:0.5rem;color:var(--ink-muted);margin-top:0.15rem">${m.total_reports_for_model} laporan</div>
          <div style="margin-top:0.3rem" class="mono" style="font-size:0.6rem;color:var(--ink-muted)">Model Pemarkahan</div>
          <div style="display:flex;justify-content:space-between;align-items:center">
            <span class="mono" style="font-size:0.6rem">${mlAvailable ? mlLabel : 'ML tidak tersedia'}</span>
            ${mlAvailable ? '<button class="btn" id="btn-toggle-ml" style="font-size:0.55rem;padding:0.15rem 0.4rem">Tukar</button>' : ''}
          </div>
          ${mlAvailable ? '<div class="mono" style="font-size:0.5rem;color:var(--ink-muted);margin-top:0.15rem">RandomForest (R²=0.95) 376 segmen sebenar</div>' : ''}
        `;
        document.getElementById('btn-toggle-model')?.addEventListener('click', async () => {
          const newMode = m.mode === 'enabled' ? 'disabled' : 'enabled';
          await apiPost('/model/mode', { mode: newMode });
          toast(`Model laporan: ${newMode === 'enabled' ? 'Gabungan' : 'Asal'}`);
          renderRisiko(el);
        });
        document.getElementById('btn-toggle-ml')?.addEventListener('click', async () => {
          const newMode = m.ml_model_mode === 'ml' ? 'heuristic' : 'ml';
          await apiPost('/model/ml_mode', { mode: newMode });
          toast(`Model pemarkahan: ${newMode === 'ml' ? 'ML' : 'Heuristik'}`);
          renderRisiko(el);
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

  // ---- Alignment Controls ----
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
      // Update arrow button data attributes
      document.querySelectorAll('.align-btn').forEach(b => {
        const dlatOrig = parseFloat(b.dataset.dlat);
        const dlonOrig = parseFloat(b.dataset.dlon);
        if (dlatOrig !== 0) b.dataset.dlat = (dlatOrig > 0 ? 1 : -1) * alignState.stepDeg;
        if (dlonOrig !== 0) b.dataset.dlon = (dlonOrig > 0 ? 1 : -1) * alignState.stepDeg;
      });
    });
  });

  document.getElementById('btn-save-align').addEventListener('click', saveAlignment);
  document.getElementById('btn-reset-align').addEventListener('click', resetAlignment);
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
    ${seg.ml_risk_score != null ? `<div style="margin-top:0.15rem;font-size:0.6rem"><span class="mono" style="color:var(--ink-muted)">ML (Data Sebenar):</span> <span class="mono" style="font-weight:500">${seg.ml_risk_score}/100</span></div>` : ''}
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
  `;

  requestAnimationFrame(() => { if (risiko_map) risiko_map.invalidateSize(); });
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

// ===== Init =====
document.addEventListener('DOMContentLoaded', async () => {
  // Verify existing session
  const tok = getAuthToken();
  if (tok) {
    try {
      const me = await apiGet('/me');
      _authUser = me.user_id;
      _isAdmin = !!me.is_admin;
      setUserId(me.user_id);
    } catch {
      setAuthToken('');
      setUserId('');
      _isAdmin = false;
    }
  }
  updateNavAuth();

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
});
