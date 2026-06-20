"""River Detective - Full System with ALL data integration"""
import json, os, sys, random, sqlite3, hashlib, secrets
import numpy as np
import joblib
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi import Depends
from pydantic import BaseModel
from datetime import datetime

# ---- SQLite persistence ----
_cache_dir = os.environ.get("RD_CACHE_DIR") or os.path.join(os.path.dirname(__file__), "..", "data", "cache")
_uploads_dir = os.environ.get("RD_UPLOADS_DIR") or os.path.join(os.path.dirname(__file__), "..", "data", "uploads")
os.makedirs(_cache_dir, exist_ok=True)
_db_path = os.path.join(_cache_dir, 'river_detective.db')
os.makedirs(_uploads_dir, exist_ok=True)

def init_db():
    conn = sqlite3.connect(_db_path)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            user_id TEXT PRIMARY KEY,
            points INTEGER DEFAULT 0,
            streak INTEGER DEFAULT 0,
            trees_redeemed INTEGER DEFAULT 0,
            password TEXT DEFAULT '',
            is_admin INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS reports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            description TEXT,
            lat REAL,
            lon REAL,
            segment_id INTEGER,
            snap_segment_id INTEGER,
            severity TEXT DEFAULT 'low',
            points_earned INTEGER DEFAULT 0,
            accuracy REAL DEFAULT 0.0,
            verified INTEGER DEFAULT 0,
            verification_count INTEGER DEFAULT 0,
            timestamp TEXT,
            image_path TEXT DEFAULT '',
            ai_confidence INTEGER DEFAULT 0,
            ai_suggestion TEXT DEFAULT '',
            ai_reason TEXT DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS user_badges (
            user_id TEXT,
            badge_key TEXT,
            PRIMARY KEY (user_id, badge_key)
        );
        CREATE TABLE IF NOT EXISTS groq_cache (
            segment_id INTEGER PRIMARY KEY,
            analysis TEXT,
            timestamp TEXT
        );
        CREATE TABLE IF NOT EXISTS config (
            key TEXT PRIMARY KEY,
            value TEXT
        );
        CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            created_at TEXT
        );
    """)
    # Schema migrations
    for col_def in [
        "image_path TEXT DEFAULT ''",
        "ai_confidence INTEGER DEFAULT 0",
        "ai_suggestion TEXT DEFAULT ''",
        "ai_reason TEXT DEFAULT ''",
    ]:
        col_name = col_def.split()[0]
        try:
            conn.execute(f"ALTER TABLE reports ADD COLUMN {col_def}")
        except sqlite3.OperationalError:
            pass  # column already exists
    # Add password column to users table for existing DBs
    try:
        conn.execute("ALTER TABLE users ADD COLUMN password TEXT DEFAULT ''")
    except sqlite3.OperationalError:
        pass
    try:
        conn.execute("ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0")
    except sqlite3.OperationalError:
        pass
    conn.execute("INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)", ('report_model_mode', 'disabled'))
    conn.execute("INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)", ('ml_model_mode', 'heuristic'))
    conn.commit()
    conn.close()

def db_get_user(user_id):
    conn = sqlite3.connect(_db_path)
    conn.row_factory = sqlite3.Row
    cur = conn.execute("SELECT * FROM users WHERE user_id=?", (user_id,))
    row = cur.fetchone()
    conn.close()
    return dict(row) if row else None

def db_ensure_user(user_id):
    u = db_get_user(user_id)
    if not u:
        conn = sqlite3.connect(_db_path)
        conn.execute("INSERT INTO users (user_id, points, streak, trees_redeemed, password) VALUES (?,0,0,0,'')", (user_id,))
        conn.commit()
        conn.close()
        u = {"user_id": user_id, "points": 0, "streak": 0, "trees_redeemed": 0, "password": ""}
    return u

def db_get_badges(user_id):
    conn = sqlite3.connect(_db_path)
    cur = conn.execute("SELECT badge_key FROM user_badges WHERE user_id=?", (user_id,))
    rows = [r[0] for r in cur.fetchall()]
    conn.close()
    return rows

def db_add_badge(user_id, badge):
    conn = sqlite3.connect(_db_path)
    conn.execute("INSERT OR IGNORE INTO user_badges (user_id, badge_key) VALUES (?,?)", (user_id, badge))
    conn.commit()
    conn.close()

def db_get_reports(user_id=None, pending_only=False, limit=50):
    conn = sqlite3.connect(_db_path)
    conn.row_factory = sqlite3.Row
    if user_id:
        cur = conn.execute("SELECT * FROM reports WHERE user_id=? ORDER BY id DESC LIMIT ?", (user_id, limit))
    elif pending_only:
        cur = conn.execute("SELECT * FROM reports WHERE verified=0 ORDER BY id ASC LIMIT ?", (limit,))
    else:
        cur = conn.execute("SELECT * FROM reports ORDER BY id DESC LIMIT ?", (limit,))
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return rows

def db_add_report(user_id, desc, lat, lon, segment_id, snap_segment_id, severity, points, accuracy, image_path=''):
    conn = sqlite3.connect(_db_path)
    conn.execute("""INSERT INTO reports 
        (user_id, description, lat, lon, segment_id, snap_segment_id, severity, points_earned, accuracy, verified, verification_count, timestamp, image_path)
        VALUES (?,?,?,?,?,?,?,?,?,0,0,?,?)""",
        (user_id, desc, lat, lon, segment_id, snap_segment_id, severity, points, accuracy, datetime.now().isoformat(), image_path))
    conn.commit()
    conn.close()

def db_update_user_points(user_id, delta):
    conn = sqlite3.connect(_db_path)
    conn.execute("UPDATE users SET points = points + ? WHERE user_id=?", (delta, user_id))
    conn.commit()
    conn.close()

def db_update_user_streak(user_id):
    conn = sqlite3.connect(_db_path)
    conn.execute("UPDATE users SET streak = streak + 1 WHERE user_id=?", (user_id,))
    conn.commit()
    conn.close()

def db_get_config(key, default=None):
    conn = sqlite3.connect(_db_path)
    cur = conn.execute("SELECT value FROM config WHERE key=?", (key,))
    row = cur.fetchone()
    conn.close()
    return row[0] if row else default

def db_set_config(key, value):
    conn = sqlite3.connect(_db_path)
    conn.execute("INSERT OR REPLACE INTO config (key, value) VALUES (?,?)", (key, str(value)))
    conn.commit()
    conn.close()

def db_get_report_by_id(rid):
    conn = sqlite3.connect(_db_path)
    conn.row_factory = sqlite3.Row
    cur = conn.execute("SELECT * FROM reports WHERE id=?", (rid,))
    row = cur.fetchone()
    conn.close()
    return dict(row) if row else None

def db_verify_report(rid):
    conn = sqlite3.connect(_db_path)
    conn.execute("UPDATE reports SET verified=1, verification_count = verification_count + 1 WHERE id=?", (rid,))
    conn.commit()
    conn.close()

def db_get_report_count_for_segment(segment_id):
    conn = sqlite3.connect(_db_path)
    cur = conn.execute("SELECT COUNT(*), COALESCE(SUM(CASE WHEN verified THEN 1 ELSE 0 END),0), COALESCE(SUM(CASE WHEN severity='critical' THEN 4 WHEN severity='high' THEN 3 WHEN severity='medium' THEN 2 ELSE 1 END),0) FROM reports WHERE snap_segment_id=?", (segment_id,))
    row = cur.fetchone()
    conn.close()
    return row  # (total, verified, severity_sum)

def db_get_all_users():
    conn = sqlite3.connect(_db_path)
    conn.row_factory = sqlite3.Row
    cur = conn.execute("SELECT * FROM users ORDER BY points DESC LIMIT 20")
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return rows

def db_reset_report_model():
    conn = sqlite3.connect(_db_path)
    conn.execute("DELETE FROM reports")
    conn.execute("DELETE FROM user_badges")
    conn.execute("DELETE FROM users")
    conn.execute("INSERT OR REPLACE INTO config (key, value) VALUES ('report_model_mode','disabled')")
    conn.commit()
    conn.close()

# ---- Model (synthetic: pollution transport tracer for sensor detection) ----
_model_dir = os.path.join(os.path.dirname(__file__), "..", "model")
sys.path.insert(0, _model_dir)
tracer = joblib.load(os.path.join(_model_dir, "source_tracer.pkl"))
model = tracer["model"]
transport = tracer["transport"]
N_SENSORS = 10

_risk_model = None
_ALL_LU_TYPES = sorted([
    'Lain-lain (Badan Air)', 'Lain-lain (Hutan)', 'Lain-lain (Industri)',
    'Lain-lain (Infrastruktur dan Utiliti)', 'Lain-lain (Institusi dan Kemudahan Masyarakat)',
    'Lain-lain (Komersial)', 'Lain-lain (Pengangkutan)', 'Lain-lain (Pertanian)',
    'Lain-lain (Perumahan)', 'Lain-lain (Tanah Kosong)', 'Lain-lain (Tanah Lapang dan Rekreasi)'
])

try:
    _risk_pkg = joblib.load(os.path.join(_model_dir, "risk_model.pkl"))
    _risk_model = _risk_pkg["regressor"]
    _risk_feature_names = _risk_pkg["feature_names"]
    _risk_importances = dict(_risk_pkg["importances"])
    print(f"Loaded real-data risk model (R²={_risk_pkg['metrics']['r2']:.3f})")
except Exception as e:
    print(f"Warning: real-data risk model not loaded ({e})")
    _risk_model = None

def extract_ml_features(seg):
    from collections import Counter
    land_use = seg.get('land_use', [])
    pipes = seg.get('nearby_pipes', [])
    cc = seg.get('community_center')
    lu_types_seen = Counter(lu.get('type', '') for lu in land_use)
    lu_dists = {}
    for lu in land_use:
        t = lu.get('type', '')
        d = lu.get('distance_m', 0)
        if t not in lu_dists or d < lu_dists[t]:
            lu_dists[t] = d
    row = []
    for t in _ALL_LU_TYPES:
        row.append(lu_types_seen.get(t, 0))
    for t in _ALL_LU_TYPES:
        row.append(lu_dists.get(t, -1) if t in lu_dists else -1)
    row.append(len(pipes))
    row.append(1 if pipes else 0)
    pipe_types = Counter(p.get('type', '') for p in pipes)
    for pt in ['PAIP', 'PARIT', 'OTHER']:
        row.append(pipe_types.get(pt, 0) if pt != 'OTHER' else sum(c for t,c in pipe_types.items() if t not in ('PAIP','PARIT')))
    row.append(1 if cc else 0)
    row.append(cc.get('distance_km', -1) if cc else -1)
    row.append(len(set(lu.get('type', '') for lu in land_use)))
    center = seg.get('segment_center', [0, 0])
    row.append(center[0])
    row.append(center[1])
    return np.array(row, dtype=np.float32), _risk_feature_names if _risk_model else []

def risk_ml_score(seg):
    if _risk_model is None:
        return None, None, None
    feat, names = extract_ml_features(seg)
    pred = float(_risk_model.predict(feat.reshape(1, -1))[0])
    pred = max(0, min(100, pred))
    level = 'RENDAH' if pred < 30 else 'SEDERHANA' if pred < 55 else 'TINGGI' if pred < 75 else 'KRITIKAL'
    contribs = sorted(zip(names, _risk_model.feature_importances_ * feat), key=lambda x: -abs(x[1]))[:5]
    return pred, level, contribs

print("Initialising database...")
init_db()
print("Database ready.")

# ---- Enrichment (ALL data) ----
_cache_dir = os.path.join(os.path.dirname(__file__), "..", "data", "cache")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from river_detective.backend.enforcer import EnforcementEngine

_enriched_path = os.path.join(_cache_dir, "enriched.pkl")
enforcer = EnforcementEngine(_enriched_path) if os.path.exists(_enriched_path) else None

# ---- Sensor Names ----
SENSOR_NAMES = [
    "SG-01 Hulu", "SG-02 Tengah", "SG-03 Hilir",
    "SG-04 Industri", "SG-05 Residen", "SG-06 Komersial",
    "SG-07 Pertanian", "SG-08 Muara", "SG-09 Bandar", "SG-10 Estet"
]

# ---- Gamification ----
BADGE_DEFS = {
    "first_report": {"name": "Pertama Kali", "desc": "Laporkan pencemaran pertama"},
    "streak_3": {"name": "Pengawal Sungai", "desc": "Lapor 3 hari berturut-turut"},
    "streak_7": {"name": "Wira Sungai", "desc": "Lapor 7 hari berturut-turut"},
    "accuracy_80": {"name": "Mata-mata Tajam", "desc": "Ketepatan tekaan >80%"},
    "points_500": {"name": "Eco-Collector", "desc": "Kumpul 500 mata ekologi"},
}

# ---- App ----
app = FastAPI(title="River Detective (Full Data)", version="2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
_frontend_dir = os.path.join(os.path.dirname(__file__), "..", "frontend")


class SensorReading(BaseModel):
    sensor_id: str
    ph: float
    turbidity: float
    timestamp: str


class Report(BaseModel):
    user_id: str
    photo_description: str
    segment_id: int | None = None
    location_lat: float | None = None
    location_lon: float | None = None
    photo_base64: str | None = None


class RedeemIn(BaseModel):
    user_id: str
    count: int = 1


class VerifyIn(BaseModel):
    user_id: str
    report_id: int


class LoginIn(BaseModel):
    user_id: str
    password: str


class RegisterIn(BaseModel):
    user_id: str
    password: str


# ====== Auth helpers ======

def _hash_password(password: str) -> str:
    salt = secrets.token_hex(8)
    h = hashlib.sha256((salt + password).encode()).hexdigest()
    return f"{salt}${h}"


def _check_password(password: str, stored: str) -> bool:
    if "$" not in stored:
        return False
    salt, h = stored.split("$", 1)
    return hashlib.sha256((salt + password).encode()).hexdigest() == h


def _create_session(user_id: str) -> str:
    token = secrets.token_hex(32)
    conn = sqlite3.connect(_db_path)
    conn.execute("INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)",
                 (token, user_id, datetime.utcnow().isoformat()))
    conn.commit()
    conn.close()
    return token


# Create admin account (runs after _hash_password/_create_session defined)
def _create_admin():
    conn = sqlite3.connect(_db_path)
    admin_hash = _hash_password("admin")
    conn.execute("INSERT OR IGNORE INTO users (user_id, password, points, streak, trees_redeemed, is_admin) VALUES (?, ?, 0, 0, 0, 1)",
                 ("admin", admin_hash))
    conn.execute("UPDATE users SET is_admin=1, password=? WHERE user_id='admin'", (admin_hash,))
    conn.commit()
    conn.close()
_create_admin()


def get_current_user(auth: HTTPAuthorizationCredentials = Depends(HTTPBearer(auto_error=False))):
    if auth is None:
        raise HTTPException(401, "Sila log masuk dahulu")
    conn = sqlite3.connect(_db_path)
    cur = conn.execute("SELECT user_id FROM sessions WHERE token=?", (auth.credentials,))
    row = cur.fetchone()
    conn.close()
    if not row:
        raise HTTPException(401, "Sesi tidak sah, sila log masuk semula")
    return row[0]


def get_current_admin(auth: HTTPAuthorizationCredentials = Depends(HTTPBearer(auto_error=False))):
    uid = get_current_user(auth)
    conn = sqlite3.connect(_db_path)
    cur = conn.execute("SELECT is_admin FROM users WHERE user_id=?", (uid,))
    row = cur.fetchone()
    conn.close()
    if not row or not row[0]:
        raise HTTPException(403, "Akses ditolak — admin sahaja")
    return uid

def analyze_sensor_data(readings):
    ph_vals = np.array([r.ph for r in readings])
    turb_vals = np.array([r.turbidity for r in readings])
    ph_bad = (ph_vals < 5.5) | (ph_vals > 8.5)
    turb_bad = turb_vals > 50
    any_bad = ph_bad | turb_bad
    if not any_bad.any():
        return {"anomaly": False, "severity": "normal",
                "ph_avg": float(np.mean(ph_vals)),
                "turbidity_avg": float(np.mean(turb_vals))}
    max_severity = 0
    for i in range(len(readings)):
        if ph_vals[i] < 4.0 or ph_vals[i] > 9.5:
            max_severity = max(max_severity, 3)
        elif ph_bad[i] or turb_bad[i]:
            s = 1
            if turb_vals[i] > 100: s = 2
            if turb_vals[i] > 200: s = 3
            max_severity = max(max_severity, s)
    severity = {0: "normal", 1: "low", 2: "medium", 3: "high", 4: "critical"}[max_severity]
    anomaly_sensors = []
    for i in range(len(readings)):
        if any_bad[i]:
            sid = readings[i].sensor_id if i < len(readings) else SENSOR_NAMES[i] if i < N_SENSORS else f"Sensor-{i}"
            anomaly_sensors.append({"sensor": sid, "ph": float(ph_vals[i]),
                                    "turbidity": float(turb_vals[i])})
    return {"anomaly": True, "severity": severity,
            "ph_avg": float(np.mean(ph_vals)),
            "turbidity_avg": float(np.mean(turb_vals)),
            "anomaly_sensors": anomaly_sensors}


def trace_pollution_source(readings, analysis, severity):
    n_read = len(readings)
    ph_vals = np.array([r.ph for r in readings])
    turb_vals = np.array([r.turbidity for r in readings])
    ph_norm = (ph_vals - ph_vals.min()) / (ph_vals.max() - ph_vals.min() + 1e-8)
    turb_norm = (turb_vals - turb_vals.min()) / (turb_vals.max() - turb_vals.min() + 1e-8)
    combined_raw = ph_norm * 0.4 + turb_norm * 0.6
    # Pad or trim to N_SENSORS
    combined = np.zeros(N_SENSORS)
    k = min(n_read, N_SENSORS)
    combined[:k] = combined_raw[:k]
    peak_idxs = np.argsort(combined)[-3:][::-1]
    source_features = np.zeros(2 * N_SENSORS)
    source_features[:N_SENSORS] = combined
    for i, idx in enumerate(peak_idxs):
        if idx < N_SENSORS:
            source_features[N_SENSORS + idx] = 1.0 - i * 0.3
    source_frac = model.predict(source_features.reshape(1, -1))[0]
    distance_m = source_frac * transport.L
    upstream_idx = peak_idxs[0]
    likely_source = SENSOR_NAMES[upstream_idx] if upstream_idx < len(SENSOR_NAMES) else f"Zona {upstream_idx}"
    return {"estimated_distance_from_head_m": float(distance_m),
            "upstream_epicenter": likely_source,
            "top_suspect_sensors": [SENSOR_NAMES[i] for i in peak_idxs if i < len(SENSOR_NAMES)],
            "confidence": float(min(combined[peak_idxs[0]] * 100, 95))}


def calculate_eco_points(report, severity):
    base = {"low": 10, "medium": 25, "high": 50, "critical": 100}
    points = base.get(severity, 10)
    bonus = random.randint(1, 10) if severity in ["high", "critical"] else 0
    return points + bonus


def check_badges(user_id):
    user = db_get_user(user_id)
    if not user:
        return []
    badges = db_get_badges(user_id)
    reports = db_get_reports(user_id)
    points = user['points']
    streak = user.get('streak', 0)
    new_badges = []
    if len(reports) >= 1 and "first_report" not in badges:
        new_badges.append("first_report")
    if points >= 500 and "points_500" not in badges:
        new_badges.append("points_500")
    if streak >= 3 and "streak_3" not in badges:
        new_badges.append("streak_3")
    if streak >= 7 and "streak_7" not in badges:
        new_badges.append("streak_7")
    accuracies = [r.get("accuracy", 0) for r in reports if r.get("accuracy")]
    if accuracies and np.mean(accuracies) > 0.8 and "accuracy_80" not in badges:
        new_badges.append("accuracy_80")
    for b in new_badges:
        db_add_badge(user_id, b)
    return new_badges


# ====== Groq AI (set GROQ_API_KEY env var) ======
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")

def groq_analyze_segment(seg_id):
    # Check DB cache first
    conn = sqlite3.connect(_db_path)
    cur = conn.execute("SELECT analysis FROM groq_cache WHERE segment_id=?", (seg_id,))
    row = cur.fetchone()
    conn.close()
    if row:
        return row[0]
    if not enforcer:
        return "Data penilaian tidak tersedia."
    seg = None
    for e in enforcer.enriched:
        if e['segment_id'] == seg_id:
            seg = e
            break
    if not seg:
        return "Segmen tidak dijumpai."
    s, lvl, facts = score_segment(seg)
    name = segment_name_map.get(seg_id, f'Segmen {seg_id}')
    land_use = seg.get('land_use', [])
    pipes = seg.get('nearby_pipes', [])
    cc = seg.get('community_center')
    juris = seg.get('jurisdiction', {})
    pop = seg.get('population_zone', {})
    housing = seg.get('housing', {})
    lu_str = '; '.join(set([(x.get('type') or x.get('description', ''))[:40] for x in land_use[:8]])) if land_use else 'tiada'
    pipe_str = f"{len(pipes)} paip/parit berdekatan" if pipes else 'tiada infrastruktur'
    cc_str = f"Pusat komuniti: {cc.get('name', '')[:30]}" if cc else 'tiada pusat komuniti'
    juris_str = f"Balai: {juris.get('police_station', '')}, IPD: {juris.get('ipd', '')}" if juris else 'tiada bidang kuasa'
    pop_str = f"~{pop.get('estimated_population', 0):,} penduduk" if pop else 'tiada data populasi'
    prompt = f"""Anda pakar alam sekitar di Iskandar Puteri, Johor. Berikut data segmen sungai:

Segmen: {name} (ID {seg_id})
Skor Risiko: {s}/100 ({lvl})
Faktor: {', '.join(facts) if facts else 'umum'}
Guna tanah: {lu_str}
{pipe_str}
{cc_str}
{juris_str}
{pop_str}

Tulis analisis ringkas dalam Bahasa Melayu (3-4 ayat) yang menerangkan:
1. PUNCA utama risiko pencemaran di segmen ini
2. IMPAK jika berlaku pencemaran (siapa terjejas, apa berlaku)
3. TINDAKAN untuk penduduk setempat dan pihak berkuasa"""
    try:
        from groq import Groq
        client = Groq(api_key=GROQ_API_KEY)
        resp = client.chat.completions.create(
            messages=[{"role": "user", "content": prompt}],
            model="llama-3.3-70b-versatile", max_tokens=350, temperature=0.3,
        )
        analysis = resp.choices[0].message.content.strip()
    except Exception as e:
        analysis = f"Analisis AI tidak tersedia. Punca utama: {', '.join(facts) if facts else 'pelbagai faktor'}. Risiko: {lvl} ({s}/100)."
    # Persist to DB
    conn = sqlite3.connect(_db_path)
    conn.execute("INSERT OR REPLACE INTO groq_cache (segment_id, analysis, timestamp) VALUES (?,?,?)",
                 (seg_id, analysis, datetime.now().isoformat()))
    conn.commit()
    conn.close()
    return analysis


def groq_analyze_report_text(description, segment_name, severity):
    """AI screening for a single report — returns confidence 0-100, suggestion, reason."""
    if not description or not description.strip():
        return {"confidence": 0, "suggestion": "sahkan", "reason": "Tiada penerangan untuk dianalisis."}
    seg_info = f"Segmen: {segment_name}" if segment_name else "Lokasi: tidak diketahui"
    prompt = f"""Anda pakar alam sekitar. Nilai laporan pencemaran ini:

{seg_info}
Keterangan: {description[:200]}
Tahap: {severity}

Berikan:
1. Skor keyakinan (0-100) — sejauh mana laporan ini boleh dipercayai?
2. Cadangan: sama ada "sahkan" atau "batalkan"
3. Sebab ringkas (1 ayat dalam Bahasa Melayu)

Format output:
KEYAKINAN: <angka>
CADANGAN: <sahkan/batalkan>
SEBAB: <ayat>"""
    try:
        from groq import Groq
        client = Groq(api_key=GROQ_API_KEY)
        resp = client.chat.completions.create(
            messages=[{"role": "user", "content": prompt}],
            model="llama-3.3-70b-versatile", max_tokens=120, temperature=0.2,
        )
        text = resp.choices[0].message.content.strip()
        conf = 50
        sug = "sahkan"
        reason = "Analisis AI tidak lengkap."
        for line in text.split('\n'):
            line = line.strip()
            if line.startswith('KEYAKINAN:'):
                try:
                    conf = max(0, min(100, int(line.split(':')[1].strip())))
                except: pass
            elif line.startswith('CADANGAN:'):
                sug = 'sahkan' if 'sahkan' in line.lower() else 'batalkan'
            elif line.startswith('SEBAB:'):
                reason = line.split(':', 1)[1].strip()
        return {"confidence": conf, "suggestion": sug, "reason": reason}
    except Exception as e:
        return {"confidence": 0, "suggestion": "sahkan", "reason": f"Ralat: {str(e)[:80]}"}


def db_set_report_ai(rid, confidence, suggestion, reason):
    conn = sqlite3.connect(_db_path)
    conn.execute("UPDATE reports SET ai_confidence=?, ai_suggestion=?, ai_reason=? WHERE id=?",
                 (confidence, suggestion, reason, rid))
    conn.commit()
    conn.close()


# ====== Coordinate Conversion (Cassini-Soldner → WGS84) ======
import pyproj
_cass_transformer = None
_proj_config_path = os.path.join(_cache_dir, 'proj_config.json')

def _load_proj_config():
    default = {"lat_0": 2.054, "lon_0": 103.582, "x_0": 0.0, "y_0": 0.0, "datum": "WGS84"}
    try:
        if os.path.exists(_proj_config_path):
            with open(_proj_config_path) as f:
                data = json.load(f)
                for k in default:
                    if k not in data:
                        data[k] = default[k]
                return data
    except Exception:
        pass
    return default

def _save_proj_config(cfg):
    os.makedirs(os.path.dirname(_proj_config_path), exist_ok=True)
    with open(_proj_config_path, 'w') as f:
        json.dump(cfg, f)

def get_cass_transformer():
    global _cass_transformer
    if _cass_transformer is None:
        cfg = _load_proj_config()
        proj = f"+proj=cass +lat_0={cfg['lat_0']} +lon_0={cfg['lon_0']} +x_0={cfg['x_0']} +y_0={cfg['y_0']} +datum={cfg['datum']} +units=m +no_defs"
        _cass_transformer = pyproj.Transformer.from_crs(proj, 'EPSG:4326', always_xy=True)
    return _cass_transformer

def to_wgs84(x, y):
    t = get_cass_transformer()
    lon, lat = t.transform(x, y)
    return round(lat, 5), round(lon, 5)

# ====== Segment Geometry + Risk ======
_csv_dir = os.path.join(os.path.dirname(__file__), "..", "..", "arcgis_csv_data")
segment_geometries = {}
segment_wgs84_centers = {}
segment_name_map = {}

def load_segment_geometry():
    global segment_geometries, segment_wgs84_centers, segment_name_map
    segment_geometries = {}
    segment_wgs84_centers = {}
    csv_path = os.path.join(_csv_dir, "AlamSekitar_Sungai_SUNGAI.csv")
    if not os.path.exists(csv_path):
        return False
    import csv
    with open(csv_path, encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            sid = int(row['FID'])
            name = row.get('nama', '') or row.get('gtn1', '') or f'Segmen {sid}'
            segment_name_map[sid] = name
            try:
                shape = json.loads(row['SHAPE'].replace("'", '"'))
            except:
                continue
            paths = shape.get('paths', [])
            if paths:
                wgs84_paths = []
                for path in paths:
                    wgs84_pts = [to_wgs84(p[0], p[1]) for p in path]
                    wgs84_paths.append(wgs84_pts)
                segment_geometries[sid] = wgs84_paths
                pts = wgs84_paths[0]
                mid = pts[len(pts) // 2]
                segment_wgs84_centers[sid] = mid
    return len(segment_geometries) > 0

def score_segment(seg):
    score = 10
    factors = []
    land_use = seg.get('land_use', [])
    pipes = seg.get('nearby_pipes', [])
    cc = seg.get('community_center')
    for lu in land_use:
        t = (lu.get('type') or lu.get('description') or str(lu)).upper()
        if 'INDUSTRI' in t:
            score += 25
            factors.append('INDUSTRI')
        elif 'KOMERSIAL' in t or 'COMMERCIAL' in t:
            score += 12
            factors.append('KOMERSIAL')
        elif 'RESIDEN' in t or 'PERUMAHAN' in t:
            score += 6
        elif 'PERTANIAN' in t or 'AGRICULTURE' in t:
            score += 4
    if pipes:
        score += min(len(pipes) * 6, 30)
        factors.append(f'{len(pipes)} PAIP')
    if cc:
        score += 4
    score = max(0, min(100, score))
    level = 'RENDAH' if score < 30 else 'SEDERHANA' if score < 55 else 'TINGGI' if score < 75 else 'KRITIKAL'
    return score, level, factors

# Load geometries on import
print("Loading segment geometry...")
load_segment_geometry()
print(f"Loaded {len(segment_geometries)} segment geometries")

# ---- Segment snapping (WGS84 KDTree) ----
from scipy.spatial import cKDTree
_snap_tree = None
_snap_ids = []

def build_snap_tree():
    global _snap_tree, _snap_ids
    pts, ids = [], []
    for sid, (lat, lon) in segment_wgs84_centers.items():
        pts.append([lat, lon])
        ids.append(sid)
    if pts:
        _snap_tree = cKDTree(np.array(pts))
        _snap_ids = ids
    else:
        _snap_tree = None
        _snap_ids = []

build_snap_tree()

def snap_segment(lat, lon):
    """Find nearest river segment ID from WGS84 coordinates."""
    if _snap_tree is None or lat is None or lon is None:
        return None
    dist, idx = _snap_tree.query(np.array([[lat, lon]]), k=1)
    d = dist[0]
    if d > 0.05:  # ~5km — too far, don't snap
        return None
    return _snap_ids[idx[0]]

# ---- Report-driven risk model ----
def report_model_score(segment_id):
    total, verified, severity_sum = db_get_report_count_for_segment(segment_id)
    if total == 0:
        return None
    score = 10 + verified * 6 + (total - verified) * 2
    if severity_sum:
        score += severity_sum * 2
    return min(100, max(0, int(score)))

def get_blended_score(seg):
    sid = seg['segment_id']
    orig_score, orig_level, orig_facts = score_segment(seg)
    rpt_mode = db_get_config('report_model_mode', 'disabled')
    rpt_score = report_model_score(sid) if rpt_mode == 'enabled' else None
    ml_mode = db_get_config('ml_model_mode', 'heuristic')
    ml_score, ml_level, ml_contribs = None, None, None
    if ml_mode == 'ml' and _risk_model is not None:
        ml_s, ml_l, ml_c = risk_ml_score(seg)
        if ml_s is not None:
            ml_score, ml_level, ml_contribs = ml_s, ml_l, ml_c
    if ml_mode == 'ml' and ml_score is not None:
        if rpt_mode == 'enabled' and rpt_score is not None:
            blended = (ml_score + rpt_score) // 2
            level = 'RENDAH' if blended < 30 else 'SEDERHANA' if blended < 55 else 'TINGGI' if blended < 75 else 'KRITIKAL'
            return blended, level, orig_facts, rpt_score, ml_score, ml_contribs
        return ml_score, ml_level, orig_facts, rpt_score, ml_score, ml_contribs
    return orig_score, orig_level, orig_facts, rpt_score, None, None

# ====== API Router (all under /api) ======
from fastapi import APIRouter
api = APIRouter(prefix="/api")


@api.get("/status")
def api_status():
    conn = sqlite3.connect(_db_path)
    cur = conn.execute("SELECT COUNT(*) FROM reports")
    rpt_count = cur.fetchone()[0]
    conn.close()
    return {"service": "River Detective (Full Data)", "version": "2.1",
            "status": "online", "sensors": N_SENSORS,
            "report_model_mode": db_get_config('report_model_mode', 'disabled'),
            "ml_model_mode": db_get_config('ml_model_mode', 'heuristic'),
            "total_reports_submitted": rpt_count,
            "data_integrations": {
                "river_segments": 376,
                "land_use": "111,911 parcels",
                "discharge_pipes": 947,
                "police_stations": 15,
                "population_zones": 10,
                "community_centers": 1036,
                "housing_units": "6,836 sampled",
                "trees": "3,100 sampled",
            }}


@api.get("/sensors")
def list_sensors():
    return {"sensors": [{"id": i, "name": SENSOR_NAMES[i]} for i in range(N_SENSORS)]}


@api.post("/detect")
def detect_pollution(readings: list[SensorReading]):
    if len(readings) < 3:
        raise HTTPException(400, "Need at least 3 sensor readings")
    analysis = analyze_sensor_data(readings)
    if not analysis["anomaly"]:
        return {"status": "clean", "message": "Air dalam keadaan selamat", "analysis": analysis}
    trace = trace_pollution_source(readings, analysis, analysis["severity"])
    enrich = {}
    if enforcer:
        enrich = enforcer.assess_pollution(readings, trace.get("upstream_epicenter", ""))
    return {"status": "alert", "message": "Pencemaran dikesan!",
            "analysis": analysis, "trace": trace, "enrichment": enrich}


@api.post("/report")
def submit_report(report: Report):
    db_ensure_user(report.user_id)

    sid = report.segment_id
    lat = report.location_lat
    lon = report.location_lon
    snap_sid = snap_segment(lat, lon) if lat and lon else None
    if not sid and snap_sid:
        sid = snap_sid

    seg = None
    if sid and enforcer:
        for e in enforcer.enriched:
            if e['segment_id'] == sid:
                seg = e; break
        if seg:
            s, lvl, _ = score_segment(seg)
            severity = 'critical' if s >= 75 else 'high' if s >= 55 else 'medium' if s >= 30 else 'low'
        else:
            severity = random.choice(["low", "medium"])
    else:
        severity = random.choice(["low", "medium"])

    points = calculate_eco_points(report, severity)
    accuracy = random.uniform(0.65, 0.95)
    sev_name = seg.get('segment_name', report.photo_description[:30]) if sid and seg else report.photo_description[:30]

    # Save photo
    img_path = ''
    if report.photo_base64:
        try:
            import base64
            img_data = base64.b64decode(report.photo_base64.split(',')[-1])
            img_path = f"report_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{random.randint(100,999)}.jpg"
            with open(os.path.join(_uploads_dir, img_path), 'wb') as f:
                f.write(img_data)
        except Exception:
            img_path = ''

    db_add_report(report.user_id, report.photo_description, lat, lon,
                  report.segment_id, snap_sid, severity, points, accuracy, img_path)
    db_update_user_points(report.user_id, points)
    db_update_user_streak(report.user_id)
    new_badges = check_badges(report.user_id)

    user = db_get_user(report.user_id)
    trees_avail = max(0, user['points'] // 200 - user.get('trees_redeemed', 0))

    imelc = enforcer._recommend_imelc({"segment_name": sev_name,
                                        "land_use": seg.get('land_use', []) if seg else [],
                                        "segment_center": None}) if enforcer else {}
    return {"status": "reported", "points_earned": points,
            "total_points": user['points'],
            "badges_earned": [BADGE_DEFS[b] for b in new_badges],
            "mangrove_trees_available": trees_avail,
            "trace_accuracy": f"{accuracy * 100:.0f}%",
            "imelc_recommendation": imelc,
            "message": f"Terima kasih! Anda menerima {points} mata ekologi."}


@api.post("/redeem")
def redeem_trees(redeem: RedeemIn):
    uid = redeem.user_id
    user = db_get_user(uid)
    if not user:
        raise HTTPException(404, "Pengguna tidak dijumpai")
    available = user['points'] // 200 - user.get('trees_redeemed', 0)
    count = min(redeem.count, available)
    if count <= 0:
        raise HTTPException(400, "Mata tidak cukup. 200 mata setiap pokok.")
    conn = sqlite3.connect(_db_path)
    conn.execute("UPDATE users SET trees_redeemed = trees_redeemed + ? WHERE user_id=?", (count, uid))
    conn.commit()
    conn.close()
    user = db_get_user(uid)
    still_avail = user['points'] // 200 - user['trees_redeemed']
    return {"status": "redeemed", "trees_redeemed": count,
            "total_trees_redeemed": user['trees_redeemed'],
            "points_remaining_for_trees": max(0, still_avail),
            "message": f"{count} pokok bakau akan ditanam melalui IMELC! Terima kasih."}


@api.get("/reports/pending")
def pending_reports():
    # Read auto-sah threshold
    conn = sqlite3.connect(_db_path)
    thr_row = conn.execute("SELECT value FROM config WHERE key='auto_sah_threshold'").fetchone()
    auto_threshold = int(thr_row[0]) if thr_row else 0
    conn.close()
    rows = db_get_reports(pending_only=True, limit=100)
    pending = []
    for r in rows:
        sid = r.get('snap_segment_id') or r.get('segment_id')
        seg_name = segment_name_map.get(sid, f"Segmen {sid}") if sid else "—"
        # AI screening (cached or compute)
        ai_conf = r.get('ai_confidence', 0)
        ai_sug = r.get('ai_suggestion', '')
        ai_reason = r.get('ai_reason', '')
        if not ai_sug and r.get('description', '').strip():
            res = groq_analyze_report_text(r.get('description', ''), seg_name, r.get('severity', 'low'))
            ai_conf, ai_sug, ai_reason = res['confidence'], res['suggestion'], res['reason']
            db_set_report_ai(r['id'], ai_conf, ai_sug, ai_reason)
        # Auto-sah if AI confidence >= threshold and suggestion is 'sahkan'
        if auto_threshold > 0 and ai_conf >= auto_threshold and ai_sug == 'sahkan' and not r.get('verified'):
            db_verify_report(r['id'])
            continue  # skip from pending list
        pending.append({
            "id": r['id'],
            "segment_id": sid,
            "segment_name": seg_name,
            "user_id": r['user_id'],
            "severity": r['severity'],
            "verifications": r.get('verification_count', 0),
            "description": r.get('description', ''),
            "timestamp": r.get('timestamp', ''),
            "image_path": r.get('image_path', '') or '',
            "ai_confidence": ai_conf,
            "ai_suggestion": ai_sug,
            "ai_reason": ai_reason,
        })
    return {"total": len(pending), "reports": pending}


@api.get("/reports/locations")
def report_locations():
    """Return verified reports with lat/lon for map markers."""
    conn = sqlite3.connect(_db_path)
    conn.row_factory = sqlite3.Row
    cur = conn.execute("SELECT id, lat, lon, severity, description, snap_segment_id, image_path, verified FROM reports WHERE lat IS NOT NULL AND lon IS NOT NULL ORDER BY id DESC LIMIT 200")
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return {"locations": rows}


@api.post("/verify")
def verify_report(v: VerifyIn, admin_id: str = Depends(get_current_admin)):
    r = db_get_report_by_id(v.report_id)
    if not r:
        raise HTTPException(404, "Laporan tidak dijumpai")
    db_verify_report(v.report_id)
    db_ensure_user(v.user_id)
    db_update_user_points(v.user_id, 5)
    return {"status": "verified", "message": "Laporan disahkan! +5 mata."}


@api.post("/reject")
def reject_report(v: VerifyIn, admin_id: str = Depends(get_current_admin)):
    r = db_get_report_by_id(v.report_id)
    if not r:
        raise HTTPException(404, "Laporan tidak dijumpai")
    conn = sqlite3.connect(_db_path)
    conn.execute("DELETE FROM reports WHERE id=?", (v.report_id,))
    conn.commit()
    conn.close()
    return {"status": "rejected", "message": "Laporan ditolak."}


@api.post("/register")
def register_user(r: RegisterIn):
    if len(r.user_id.strip()) < 2:
        raise HTTPException(400, "ID pengguna mesti sekurang-kurangnya 2 aksara")
    if len(r.password.strip()) < 4:
        raise HTTPException(400, "Kata laluan mesti sekurang-kurangnya 4 aksara")
    conn = sqlite3.connect(_db_path)
    existing = conn.execute("SELECT user_id FROM users WHERE user_id=?", (r.user_id.strip(),)).fetchone()
    if existing:
        conn.close()
        raise HTTPException(409, "ID pengguna sudah wujud")
    hashed = _hash_password(r.password.strip())
    conn.execute("INSERT INTO users (user_id, password, points, streak, trees_redeemed) VALUES (?, ?, 0, 0, 0)",
                 (r.user_id.strip(), hashed))
    conn.commit()
    conn.close()
    token = _create_session(r.user_id.strip())
    return {"token": token, "user_id": r.user_id.strip(), "message": "Akaun berjaya didaftarkan!"}


@api.post("/login")
def login_user(l: LoginIn):
    conn = sqlite3.connect(_db_path)
    cur = conn.execute("SELECT password FROM users WHERE user_id=?", (l.user_id.strip(),))
    row = cur.fetchone()
    conn.close()
    if not row:
        raise HTTPException(401, "ID pengguna atau kata laluan salah")
    if not _check_password(l.password.strip(), row[0]):
        raise HTTPException(401, "ID pengguna atau kata laluan salah")
    token = _create_session(l.user_id.strip())
    return {"token": token, "user_id": l.user_id.strip(), "message": "Log masuk berjaya!"}


@api.post("/logout")
def logout_user(auth: HTTPAuthorizationCredentials = Depends(HTTPBearer(auto_error=False))):
    if auth is None:
        return {"status": "ok", "message": "Tiada sesi aktif"}
    conn = sqlite3.connect(_db_path)
    conn.execute("DELETE FROM sessions WHERE token=?", (auth.credentials,))
    conn.commit()
    conn.close()
    return {"status": "ok", "message": "Log keluar berjaya!"}


@api.get("/me")
def me(user_id: str = Depends(get_current_user)):
    conn = sqlite3.connect(_db_path)
    cur = conn.execute("SELECT is_admin FROM users WHERE user_id=?", (user_id,))
    row = cur.fetchone()
    conn.close()
    return {"user_id": user_id, "is_admin": row[0] if row else 0}


class AdminDeleteUserIn(BaseModel):
    target_user_id: str


@api.post("/admin/delete-user")
def admin_delete_user(req: AdminDeleteUserIn, admin_id: str = Depends(get_current_admin)):
    if req.target_user_id == "admin":
        raise HTTPException(400, "Tidak boleh padam akaun admin")
    conn = sqlite3.connect(_db_path)
    conn.execute("DELETE FROM users WHERE user_id=?", (req.target_user_id,))
    conn.execute("DELETE FROM user_badges WHERE user_id=?", (req.target_user_id,))
    conn.execute("UPDATE reports SET user_id='[deleted]' WHERE user_id=?", (req.target_user_id,))
    conn.commit()
    conn.close()
    return {"status": "ok", "message": f"Pengguna '{req.target_user_id}' telah dipadam"}


class AdminConfigIn(BaseModel):
    key: str
    value: str


@api.get("/admin/config")
def admin_get_config(admin_id: str = Depends(get_current_admin)):
    conn = sqlite3.connect(_db_path)
    rows = conn.execute("SELECT key, value FROM config").fetchall()
    conn.close()
    cfg = {k: v for k, v in rows}
    return {
        "auto_sah_threshold": int(cfg.get("auto_sah_threshold", 0)),
        "ml_model_mode": cfg.get("ml_model_mode", "heuristic"),
        "ml_available": _risk_model is not None,
    }


@api.post("/admin/config")
def admin_set_config(req: AdminConfigIn, admin_id: str = Depends(get_current_admin)):
    conn = sqlite3.connect(_db_path)
    conn.execute("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)", (req.key, req.value))
    conn.commit()
    conn.close()
    return {"status": "ok", "message": f"{req.key} = {req.value}"}


@api.get("/priority")
def priority_segments(limit: int = 10):
    if not enforcer:
        raise HTTPException(503, "Enrichment not loaded")
    scored = []
    for seg in enforcer.enriched:
        sid = seg['segment_id']
        s, lvl, facts, rpt_s, ml_s, ml_c = get_blended_score(seg)
        center = segment_wgs84_centers.get(sid) or seg.get('wgs84', [0, 0])
        entry = {"id": sid, "name": segment_name_map.get(sid, f'Segmen {sid}'),
                 "risk_score": s, "risk_level": lvl, "factors": facts,
                 "center": center,
                 "pipe_count": len(seg.get('nearby_pipes', [])),
                 "land_use_count": len(seg.get('land_use', [])),
                 "jurisdiction": seg.get('jurisdiction'),
                 "population_zone": seg.get('population_zone')}
        if rpt_s is not None:
            entry["report_risk_score"] = rpt_s
        if ml_s is not None:
            entry["ml_risk_score"] = ml_s
        scored.append(entry)
    scored.sort(key=lambda x: x['risk_score'], reverse=True)
    return {"total": len(scored), "priority": scored[:limit]}


@api.get("/explore/ai/{segment_id}")
def explore_ai(segment_id: int):
    name = segment_name_map.get(segment_id, f'Segmen {segment_id}')
    ml_pred = None
    if _risk_model and enforcer:
        for seg in enforcer.enriched:
            if seg['segment_id'] == segment_id:
                ml_s, ml_l, ml_c = risk_ml_score(seg)
                if ml_s is not None:
                    ml_pred = {"risk_score": round(ml_s, 1), "risk_level": ml_l, "contributors": ml_c}
                break
    analysis = groq_analyze_segment(segment_id)
    return {"segment_id": segment_id, "name": name, "analysis": analysis, "ml_prediction": ml_pred}


@api.get("/assess")
def assess_segment(segment_id: int = None):
    if not enforcer:
        raise HTTPException(503, "Enrichment data not loaded")
    if segment_id is not None:
        for e in enforcer.enriched:
            if e["segment_id"] == segment_id:
                return {"segment": e}
        raise HTTPException(404, "Segment not found")
    return {"total_segments": len(enforcer.enriched), "sample": enforcer.enriched[0]}


@api.get("/assess/nearby")
def assess_nearby(x: float, y: float):
    if not enforcer:
        raise HTTPException(503, "Enrichment data not loaded")
    nearest = enforcer.find_nearest_segments(x, y, k=3)
    results = []
    for n in nearest:
        seg = n["segment"]
        assessment = enforcer.assess_pollution([], seg.get("segment_name", ""))
        results.append({"segment": seg, "enforcement": assessment, "distance_m": n["distance_m"]})
    return {"nearby_segments": results}


@api.get("/leaderboard")
def leaderboard():
    users = db_get_all_users()
    result = []
    for i, u in enumerate(users):
        badges = db_get_badges(u['user_id'])
        reports = db_get_reports(u['user_id'])
        result.append({"rank": i + 1, "user_id": u['user_id'], "points": u['points'],
                       "reports": len(reports), "badges": badges})
    return {"leaderboard": result}


@api.get("/user/{user_id}")
def user_profile(user_id: str):
    user = db_get_user(user_id)
    if not user:
        raise HTTPException(404, "User not found")
    badges = db_get_badges(user_id)
    reports = db_get_reports(user_id)
    trees_avail = user['points'] // 200 - user.get('trees_redeemed', 0)
    return {"user_id": user_id, "points": user['points'],
            "total_reports": len(reports), "streak": user.get('streak', 0),
            "badges": [BADGE_DEFS[b] for b in badges if b in BADGE_DEFS],
            "mangrove_trees": max(0, trees_avail),
            "trees_redeemed": user.get('trees_redeemed', 0),
            "recent_reports": reports[:5]}


@api.get("/data/summary")
def data_summary():
    if not enforcer:
        raise HTTPException(503, "Enrichment not loaded")
    total_land = sum(len(e.get("land_use", [])) for e in enforcer.enriched)
    total_pipes = sum(len(e.get("nearby_pipes", [])) for e in enforcer.enriched)
    total_juris = sum(1 for e in enforcer.enriched if e.get("jurisdiction"))
    total_pop = sum(1 for e in enforcer.enriched if e.get("population_zone"))
    total_cc = sum(1 for e in enforcer.enriched if e.get("community_center"))
    return {
        "total_river_segments": len(enforcer.enriched),
        "segments_with_land_use_data": total_land,
        "segments_with_nearby_pipes": total_pipes,
        "segments_with_jurisdiction": total_juris,
        "segments_with_population_data": total_pop,
        "segments_with_community_centers": total_cc,
        "data_sources": [
            "AlamSekitar_Sungai (376 segmen sungai)",
            "Gunatanah_Semasa (223,856 lot guna tanah)",
            "Utiliti_PaipPembentungan + Utiliti_Parit (947 titik paip/parit)",
            "Sempadan_BalaiPolis (15 balai)",
            "Taburan_Penduduk2024 (10 zon penduduk)",
            "Sosial_KMasyarakat (1,036 pusat komuniti)",
            "Sosial_JenisPerumahan (136,724 unit perumahan)",
            "Inventori_Pokok (31,002 pokok)",
            "AlamSekitar_Topografi (21,416 titik topografi)",
            "NDCDB_2023 (140,062 petak tanah)",
            "AlamSekitar_Hutan (34 kawasan hutan)",
        ],
    }


# ====== Report-Driven Model Control ======

class ModelModeIn(BaseModel):
    mode: str  # 'disabled' or 'enabled'

@api.get("/model/mode")
def get_model_mode():
    mode = db_get_config('report_model_mode', 'disabled')
    ml_mode = db_get_config('ml_model_mode', 'heuristic')
    conn = sqlite3.connect(_db_path)
    cur = conn.execute("SELECT COUNT(*) FROM reports")
    total_reports = cur.fetchone()[0]
    conn.close()
    return {"mode": mode, "ml_model_mode": ml_mode, "total_reports_for_model": total_reports, "ml_available": _risk_model is not None}

@api.post("/model/mode")
def set_model_mode(m: ModelModeIn):
    if m.mode not in ('disabled', 'enabled'):
        raise HTTPException(400, "Mode must be 'disabled' or 'enabled'")
    db_set_config('report_model_mode', m.mode)
    return {"status": "ok", "mode": m.mode}

class MlModeIn(BaseModel):
    mode: str  # 'heuristic' or 'ml'

@api.get("/model/ml_mode")
def get_ml_mode():
    return {"mode": db_get_config('ml_model_mode', 'heuristic'), "available": _risk_model is not None}

@api.post("/model/ml_mode")
def set_ml_mode(m: MlModeIn):
    if m.mode not in ('heuristic', 'ml'):
        raise HTTPException(400, "Mode must be 'heuristic' or 'ml'")
    db_set_config('ml_model_mode', m.mode)
    return {"status": "ok", "mode": m.mode}

@api.post("/model/reset")
def reset_report_model():
    db_reset_report_model()
    return {"status": "ok", "message": "Laporan model telah direset. Model kini: disabled."}


# ====== Explore + Projection Endpoints ======

@api.get("/explore/segments")
def explore_segments(limit: int = 500, offset: int = 0):
    if not enforcer:
        raise HTTPException(503, "Enrichment not loaded")
    segs = enforcer.enriched
    total = len(segs)
    segs = segs[offset:offset + limit]
    result = []
    for seg in segs:
        sid = seg['segment_id']
        s, lvl, facts, rpt_s, ml_s, ml_c = get_blended_score(seg)
        geo = segment_geometries.get(sid, [])
        center = segment_wgs84_centers.get(sid) or seg.get('wgs84', [0, 0])
        land_use_list = seg.get('land_use', [])
        land_use_types = sorted(set(lu['type'] for lu in land_use_list))[:3] if land_use_list else []
        pipes = seg.get('nearby_pipes', [])
        nearest_pipe = min(pipes, key=lambda p: p.get('distance_m', 9999)) if pipes else None
        comm = seg.get('community_center')
        entry = {
            "id": sid,
            "name": segment_name_map.get(sid, f'Segmen {sid}'),
            "center": center,
            "risk_score": s,
            "risk_level": lvl,
            "factors": facts,
            "geometry": geo,
            "land_use_count": len(land_use_list),
            "pipe_count": len(pipes),
            "land_use_types": land_use_types,
            "nearest_pipe": nearest_pipe,
            "nearest_community": comm,
        }
        if rpt_s is not None:
            entry["report_risk_score"] = rpt_s
        if ml_s is not None:
            entry["ml_risk_score"] = ml_s
            entry["ml_contributors"] = ml_c
        result.append(entry)
    return {"total": total, "offset": offset, "limit": limit, "segments": result}


@api.get("/explore/segment/{segment_id}")
def explore_segment(segment_id: int):
    if not enforcer:
        raise HTTPException(503, "Enrichment not loaded")
    for seg in enforcer.enriched:
        if seg['segment_id'] == segment_id:
            sid = seg['segment_id']
            s, lvl, facts, rpt_s, ml_s, ml_c = get_blended_score(seg)
            geo = segment_geometries.get(sid, [])
            center = segment_wgs84_centers.get(sid) or seg.get('wgs84', [0, 0])
            entry = {
                "id": sid,
                "name": segment_name_map.get(sid, f'Segmen {sid}'),
                "center": center,
                "risk_score": s,
                "risk_level": lvl,
                "factors": facts,
                "geometry": geo,
                "land_use": seg.get('land_use', []),
                "nearby_pipes": seg.get('nearby_pipes', []),
                "jurisdiction": seg.get('jurisdiction'),
                "population_zone": seg.get('population_zone'),
                "community_center": seg.get('community_center'),
                "housing": seg.get('housing'),
            }
            if rpt_s is not None:
                entry["report_risk_score"] = rpt_s
            if ml_s is not None:
                entry["ml_risk_score"] = ml_s
                entry["ml_contributors"] = ml_c
            return {"segment": entry}
    raise HTTPException(404, "Segment not found")


@api.get("/proj")
def get_projection():
    return _load_proj_config()


@api.post("/proj")
def update_projection(cfg: dict):
    if 'lat_0' not in cfg or 'lon_0' not in cfg:
        raise HTTPException(400, "lat_0 and lon_0 required")
    cur = _load_proj_config()
    for k in ['lat_0', 'lon_0', 'x_0', 'y_0', 'datum']:
        if k in cfg:
            cur[k] = cfg[k]
    _save_proj_config(cur)
    global _cass_transformer
    _cass_transformer = None
    load_segment_geometry()
    return {"status": "ok", "proj": cur}


# ====== Mount API router + Frontend ======
app.include_router(api)
app.mount("/uploads", StaticFiles(directory=_uploads_dir), name="uploads")


@app.get("/")
def serve_root():
    """Serve the SPA entry point."""
    idx = os.path.join(_frontend_dir, "index.html")
    if os.path.isfile(idx):
        return FileResponse(idx, media_type="text/html")
    return {"error": "Frontend not built"}


@app.get("/{path:path}")
def serve_frontend(path: str):
    """Serve static assets or SPA fallback."""
    # Block API-like paths from getting SPA fallback
    if path.startswith("api/"):
        raise HTTPException(404, "Not found")
    fp = os.path.join(_frontend_dir, path)
    if os.path.isfile(fp):
        return FileResponse(fp)
    # SPA fallback
    idx = os.path.join(_frontend_dir, "index.html")
    if os.path.isfile(idx):
        return FileResponse(idx, media_type="text/html")
    raise HTTPException(404, "Not found")


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
