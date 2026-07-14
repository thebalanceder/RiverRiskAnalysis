"""River Detective - Full System with ALL data integration"""
import json, os, sys, random, sqlite3, hashlib, secrets, base64, io, time, re, math, asyncio
import numpy as np
import joblib
import uvicorn
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, RedirectResponse, StreamingResponse, Response
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi import Depends
from pydantic import BaseModel
from datetime import datetime, timedelta
from typing import List, Optional
from collections import defaultdict

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
        CREATE TABLE IF NOT EXISTS risk_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            segment_id INTEGER NOT NULL,
            risk_score REAL,
            risk_level TEXT,
            ml_score REAL,
            timestamp TEXT
        );
        CREATE TABLE IF NOT EXISTS image_analysis (
            report_id INTEGER PRIMARY KEY,
            pollution_type TEXT,
            confidence REAL,
            description TEXT,
            color_rgb TEXT,
            timestamp TEXT
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
try:
    tracer = joblib.load(os.path.join(_model_dir, "source_tracer.pkl"))
    model = tracer["model"]
    transport = tracer["transport"]
    N_SENSORS = 10
    _tracer_loaded = True
except Exception:
    model = None
    transport = None
    # Station identities are part of the deployed network, not part of the
    # optional model artifact. Keep real readings usable in triage mode.
    N_SENSORS = 10
    _tracer_loaded = False
    print("Warning: source_tracer.pkl not found — using sensor-gradient triage fallback")

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
    if hasattr(_risk_model, 'n_jobs'):
        _risk_model.n_jobs = 1
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
    full_feat, _ = extract_ml_features(seg)
    feat = _select_active_risk_features(full_feat)
    names = _risk_feature_names
    pred = float(_risk_model.predict(feat.reshape(1, -1))[0])
    pred = max(0, min(100, pred))
    level = 'RENDAH' if pred < 30 else 'SEDERHANA' if pred < 55 else 'TINGGI' if pred < 75 else 'KRITIKAL'
    contribs = sorted(zip(names, _risk_model.feature_importances_ * feat), key=lambda x: -abs(x[1]))[:5]
    return pred, level, contribs


def batch_ml_scores(segs):
    """Score all segments with ML in a single predict() call."""
    if _risk_model is None:
        return [None] * len(segs)
    feats = []
    valid = []
    for seg in segs:
        try:
            full_f, _ = extract_ml_features(seg)
            f = _select_active_risk_features(full_f)
            feats.append(f)
            valid.append(True)
        except Exception:
            feats.append(np.zeros(len(_risk_feature_names), dtype=np.float32))
            valid.append(False)
    mat = np.array(feats, dtype=np.float32)
    preds = _risk_model.predict(mat)
    results = []
    for i, pred in enumerate(preds):
        if not valid[i]:
            results.append((None, None, None))
            continue
        p = max(0, min(100, float(pred)))
        lvl = 'RENDAH' if p < 30 else 'SEDERHANA' if p < 55 else 'TINGGI' if p < 75 else 'KRITIKAL'
        names = _risk_feature_names
        contribs = sorted(zip(names, _risk_model.feature_importances_ * feats[i]), key=lambda x: -abs(x[1]))[:5]
        results.append((p, lvl, contribs))
    return results


def _full_model_feature_ids():
    return ([f"lu_count_{t}" for t in _ALL_LU_TYPES] +
            [f"lu_min_dist_{t}" for t in _ALL_LU_TYPES] +
            ["pipe_count", "has_pipe", "pipe_type_paip", "pipe_type_parit", "pipe_type_other",
             "has_community", "community_dist_km", "land_use_diversity", "center_x", "center_y"])


def _select_active_risk_features(full_feat):
    if not _risk_feature_names or len(_risk_feature_names) == len(full_feat):
        return full_feat
    id_to_idx = {fid: i for i, fid in enumerate(_full_model_feature_ids())}
    selected = []
    for fid in _risk_feature_names:
        idx = id_to_idx.get(fid)
        selected.append(float(full_feat[idx]) if idx is not None and idx < len(full_feat) else 0.0)
    return np.array(selected, dtype=np.float32)

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

# ---- WebSocket Alert Manager ----
class AlertManager:
    def __init__(self):
        self.connections: list[WebSocket] = []
    async def connect(self, ws: WebSocket):
        await ws.accept()
        self.connections.append(ws)
    def disconnect(self, ws: WebSocket):
        if ws in self.connections:
            self.connections.remove(ws)
    async def broadcast(self, message: dict):
        dead = []
        for ws in self.connections:
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)

alert_manager = AlertManager()

# ---- Topology + Spread Simulation ----
topology = None
spread_sim = None

def _init_topology():
    global topology, spread_sim
    if segment_geometries and segment_wgs84_centers:
        try:
            from river_detective.model.topology import RiverTopology
            from river_detective.model.spread import PollutionSpread
            topology = RiverTopology(segment_geometries, segment_wgs84_centers, segment_name_map)
            # Pass enriched segments so spread sim derives velocity/diffusion from real data
            enriched = enforcer.enriched if enforcer else []
            spread_sim = PollutionSpread(topology, enriched_segments=enriched)
            print(f"Topology built: {topology.to_dict()['total_nodes']} nodes, {topology.to_dict()['total_edges']} edges")
        except Exception as e:
            print(f"Warning: topology init failed ({e})")

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
    # A trained tracer is used when present.  The deterministic fallback keeps
    # field triage usable when the optional model artifact is not deployed.
    if _tracer_loaded:
        source_frac = model.predict(source_features.reshape(1, -1))[0]
        method = "trained sensor-pattern model"
    else:
        source_frac = peak_idxs[0] / max(N_SENSORS - 1, 1)
        method = "sensor-gradient triage fallback"
    distance_m = source_frac * transport.L if transport is not None else None
    upstream_idx = peak_idxs[0]
    likely_source = SENSOR_NAMES[upstream_idx] if upstream_idx < len(SENSOR_NAMES) else f"Zona {upstream_idx}"
    return {"estimated_distance_from_head_m": float(distance_m) if distance_m is not None else None,
            "upstream_epicenter": likely_source,
            "top_suspect_sensors": [SENSOR_NAMES[i] for i in peak_idxs if i < len(SENSOR_NAMES)],
            "confidence": float(min(combined[peak_idxs[0]] * 100, 95)),
            "method": method}


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

    # Build detailed context strings
    lu_lines = []
    for lu in land_use[:6]:
        t = lu.get('type', 'unknown')
        d = lu.get('distance_m', 0)
        lu_lines.append(f"  - {t} ({d:.0f}m dari segmen)")
    lu_str = '\n'.join(lu_lines) if lu_lines else '  Tiada data guna tanah'

    pipe_lines = []
    for p in pipes[:5]:
        pipe_lines.append(f"  - {p.get('type', '')} '{p.get('name', '')}' ({p.get('distance_m', 0):.0f}m)")
    pipe_str = '\n'.join(pipe_lines) if pipe_lines else '  Tiada paip/parit berdekatan'

    cc_str = f"  {cc.get('name', '')} ({cc.get('distance_km', 0):.2f}km)" if cc else '  Tiada pusat komuniti'

    juris_str = f"  Balai Polis: {juris.get('police_station', '')} ({juris.get('distance_km', 0):.2f}km)\n  IPD: {juris.get('ipd', '')}\n  Mukim: {juris.get('mukim', '')}" if juris else '  Tiada data bidang kuasa'

    pop_str = f"  Zon: {pop.get('name', '')}\n  Penduduk: ~{pop.get('population', 0):,}\n  Kepadatan: {pop.get('density_km2', 0):,}/km2\n  Jarak: {pop.get('distance_km', 0):.2f}km" if pop else '  Tiada data populasi'

    # Topology context
    topo_str = '  Tiada data topologi'
    if topology:
        up_count = len(topology.upstream.get(seg_id, []))
        ds_count = len(topology.downstream.get(seg_id, []))
        topo_str = f"  Segmen hulu: {up_count} terus\n  Segmen hilir: {ds_count} terus\n  Kedudukan: {'Hulu (sumber)' if up_count == 0 else 'Hilir (penerima)' if ds_count == 0 else 'Pertengahan (laluan)'}"

    # Segment geometry
    geo_pts = segment_geometries.get(seg_id, [[]])
    seg_len = 'tidak diketahui'
    if geo_pts and geo_pts[0] and len(geo_pts[0]) >= 2:
        path = np.array(geo_pts[0])
        diffs = np.diff(path, axis=0)
        dlat = diffs[:, 0] * 111000
        dlon = diffs[:, 1] * 110960
        length_m = float(np.sum(np.sqrt(dlat**2 + dlon**2)))
        seg_len = f"~{length_m:.0f}m"

    prompt = f"""Anda pakar alam sekitar di Iskandar Puteri, Johor. Berikut data LENGKAP segmen sungai:

=== IDENTITI ===
Nama: {name}
ID: {seg_id}
Panjang: {seg_len}

=== PENILAIAN RISIKO ===
Skor Gabungan: {s}/100 ({lvl})
Faktor risiko: {', '.join(facts) if facts else 'tiada faktor spesifik'}

=== GUNA TANAH (sekitar segmen) ===
{lu_str}

=== INFRASTRUTUR AIR (paip/parit) ===
{pipe_str}

=== PUSAT KOMUNITI ===
{cc_str}

=== BIDANG KUASA (polis) ===
{juris_str}

=== DATA PENDUDUK ===
{pop_str}

=== KEDUDUKAN DALAM RANGKAIAN SUNGAI ===
{topo_str}

=== ARAHAN ===
Tulis analisis dalam Bahasa Melayu (4-5 ayat) berdasarkan HANYA data di atas. JANGAN reka maklumat tambahan.
1. PUNCA utama risiko pencemaran di segmen ini (berdasarkan guna tanah dan infrastruktur)
2. IMPAK jika berlaku pencemaran (siapa terjejas berdasarkan data penduduk dan pusat komuniti)
3. TINDAKAN spesifik untuk penduduk setempat dan pihak berkuasa (berdasarkan balai polis dan mukim)
4. CADANGAN pemulihan (berdasarkan guna tanah dan jarak ke pusat komuniti)"""
    try:
        from groq import Groq
        client = Groq(api_key=GROQ_API_KEY, timeout=15.0)
        resp = client.chat.completions.create(
            messages=[{"role": "user", "content": prompt}],
            model="llama-3.3-70b-versatile", max_tokens=450, temperature=0.2,
        )
        analysis = resp.choices[0].message.content.strip()
    except Exception as e:
        analysis = (
            f"<b>Risiko: {lvl} ({s}/100)</b>\n"
            f"Faktor utama: {', '.join(facts[:3]) if facts else 'umum'}.\n"
            f"<i>AI Groq gagal ({e}) — tekan lagi untuk cuba semula.</i>"
        )
        return analysis
    # Persist to DB only on success
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
        client = Groq(api_key=GROQ_API_KEY, timeout=10.0)
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
try:
    import pyproj
except ImportError:
    pyproj = None
    print("Warning: pyproj not installed — authoritative map geometry is unavailable")
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
    if pyproj is None:
        raise RuntimeError("pyproj is required to convert the authoritative ArcGIS geometry")
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
if pyproj is not None:
    load_segment_geometry()
    print(f"Loaded {len(segment_geometries)} segment geometries")
else:
    print("Skipped geometry conversion; install requirements to enable map geometry")
_init_topology()

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

# ---- Seed time-series with initial snapshot on startup ----
def _seed_timeseries_snapshot():
    """Create initial risk snapshot so Trend page has data from first launch."""
    if not enforcer:
        return
    try:
        conn = sqlite3.connect(_db_path)
        existing = conn.execute("SELECT COUNT(*) FROM risk_snapshots").fetchone()[0]
        if existing > 0:
            conn.close()
            return  # already has data, don't re-seed
        now = datetime.now().isoformat()
        ml_mode = db_get_config('ml_model_mode', 'heuristic')
        batch_ml = batch_ml_scores(enforcer.enriched) if (ml_mode == 'ml' and _risk_model is not None) else [None] * len(enforcer.enriched)
        count = 0
        for i, seg in enumerate(enforcer.enriched):
            sid = seg['segment_id']
            orig_score, orig_level, orig_facts = score_segment(seg)
            ml_score, ml_level, ml_contribs = batch_ml[i] if i < len(batch_ml) and batch_ml[i] is not None else (None, None, None)
            if ml_score is not None:
                s, lvl = ml_score, ml_level
            else:
                s, lvl = orig_score, orig_level
            conn.execute("INSERT INTO risk_snapshots (segment_id, risk_score, risk_level, ml_score, timestamp) VALUES (?,?,?,?,?)",
                         (sid, s, lvl, ml_score, now))
            count += 1
        conn.commit()
        conn.close()
        print(f"Seeded {count} initial risk snapshots for Trend page")
    except Exception as e:
        print(f"Warning: snapshot seed failed ({e})")

import threading
threading.Thread(target=_seed_timeseries_snapshot, daemon=True).start()

# ---- Broadcast critical alerts on startup ----
def _broadcast_startup_alerts():
    """Push alerts for any KRITIKAL segments on server start."""
    if not enforcer:
        return
    import asyncio
    critical = []
    ml_mode = db_get_config('ml_model_mode', 'heuristic')
    batch_ml = batch_ml_scores(enforcer.enriched) if (ml_mode == 'ml' and _risk_model is not None) else [None] * len(enforcer.enriched)
    for i, seg in enumerate(enforcer.enriched):
        orig_score, orig_level, _ = score_segment(seg)
        ml_score, ml_level, _ = batch_ml[i] if i < len(batch_ml) and batch_ml[i] is not None else (None, None, None)
        s, lvl = (ml_score, ml_level) if ml_score is not None else (orig_score, orig_level)
        if lvl == 'KRITIKAL':
            critical.append({"segment_id": seg['segment_id'],
                             "name": segment_name_map.get(seg['segment_id'], ''),
                             "score": round(s, 1)})
    if not critical:
        return
    alert_msg = {
        "type": "alert",
        "severity": "critical",
        "message": f"⚠ {len(critical)} segmen KRITIKAL aktif pada permulaan sistem",
        "segments": critical[:10],
        "timestamp": datetime.now().isoformat(),
    }
    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            asyncio.ensure_future(alert_manager.broadcast(alert_msg))
        else:
            loop.run_until_complete(alert_manager.broadcast(alert_msg))
    except Exception:
            pass

threading.Thread(target=_broadcast_startup_alerts, daemon=True).start()

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

    # ---- WebSocket alert for critical/high severity reports ----
    if severity in ('critical', 'high') and sid:
        import asyncio
        alert_msg = {
            "type": "alert",
            "segment_id": sid,
            "risk_level": severity.upper(),
            "severity": severity,
            "message": f"Laporan {'KRITIKAL' if severity == 'critical' else 'TINGGI'}: Segmen {segment_name_map.get(sid, sid)} — {report.photo_description[:80]}",
            "reporter": report.user_id,
            "timestamp": datetime.now().isoformat(),
        }
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                asyncio.ensure_future(alert_manager.broadcast(alert_msg))
            else:
                loop.run_until_complete(alert_manager.broadcast(alert_msg))
        except Exception:
            pass  # best-effort; don't block report filing

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
    cache_key = ('priority', limit, db_get_config('ml_model_mode', 'heuristic'))
    cached = _explore_payload_cache.get(cache_key)
    if cached and time.monotonic() - cached[0] < _EXPLORE_CACHE_SECONDS:
        return cached[1]
    ml_mode = db_get_config('ml_model_mode', 'heuristic')
    batch_ml = batch_ml_scores(enforcer.enriched) if (ml_mode == 'ml' and _risk_model is not None) else [None] * len(enforcer.enriched)
    scored = []
    for i, seg in enumerate(enforcer.enriched):
        sid = seg['segment_id']
        orig_score, orig_level, orig_facts = score_segment(seg)
        ml_score, ml_level, ml_contribs = batch_ml[i] if i < len(batch_ml) and batch_ml[i] is not None else (None, None, None)
        if ml_score is not None:
            s, lvl = ml_score, ml_level
        else:
            s, lvl = orig_score, orig_level
        center = segment_wgs84_centers.get(sid) or seg.get('wgs84', [0, 0])
        entry = {"id": sid, "name": segment_name_map.get(sid, f'Segmen {sid}'),
                 "risk_score": s, "risk_level": lvl, "factors": orig_facts,
                 "center": center,
                 "pipe_count": len(seg.get('nearby_pipes', [])),
                 "land_use_count": len(seg.get('land_use', [])),
                 "jurisdiction": seg.get('jurisdiction'),
                 "population_zone": seg.get('population_zone')}
        if ml_score is not None:
            entry["ml_risk_score"] = ml_score
        scored.append(entry)
    scored.sort(key=lambda x: x['risk_score'], reverse=True)
    result = {"total": len(scored), "priority": scored[:limit]}
    _explore_payload_cache[cache_key] = (time.monotonic(), result)
    return result


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
    sources = [
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
    ]
    if not enforcer:
        return {
            "total_river_segments": 0,
            "segments_with_land_use_data": 0,
            "segments_with_nearby_pipes": 0,
            "segments_with_jurisdiction": 0,
            "segments_with_population_data": 0,
            "segments_with_community_centers": 0,
            "data_sources": sources,
        }
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
        "data_sources": sources,
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
    _clear_explore_cache()
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
    _clear_explore_cache()
    db_set_config('ml_model_mode', m.mode)
    return {"status": "ok", "mode": m.mode}

@api.post("/model/reset")
def reset_report_model():
    db_reset_report_model()
    return {"status": "ok", "message": "Laporan model telah direset. Model kini: disabled."}


# ====== Feature Selection & Custom ML Training ======

_MODEL_FEATURE_DEFS = []
for _i, _t in enumerate(_ALL_LU_TYPES):
    _label = _t.replace('Lain-lain (', '').replace(')', '')
    _fid = f"lu_count_{_t}"
    _MODEL_FEATURE_DEFS.append({"id": _fid, "name": f"Bilangan: {_label}", "category": "Guna Tanah (Bilangan)", "description": f"Jumlah plot guna tanah '{_label}' dalam/berdekatan segmen"})
for _i, _t in enumerate(_ALL_LU_TYPES):
    _label = _t.replace('Lain-lain (', '').replace(')', '')
    _fid = f"lu_min_dist_{_t}"
    _MODEL_FEATURE_DEFS.append({"id": _fid, "name": f"Jarak min: {_label}", "category": "Guna Tanah (Jarak)", "description": f"Jarak minimum (m) ke guna tanah '{_label}'"})
_MODEL_FEATURE_DEFS += [
    {"id": "pipe_count", "name": "Bilangan Paip/Parit", "category": "Infrastruktur", "description": "Jumlah paip dan parit berhampiran segmen"},
    {"id": "has_pipe", "name": "Ada Paip/Parit", "category": "Infrastruktur", "description": "1 jika ada paip/parit, 0 jika tiada"},
    {"id": "pipe_type_paip", "name": "Bilangan Paip", "category": "Infrastruktur", "description": "Jumlah paip sahaja"},
    {"id": "pipe_type_parit", "name": "Bilangan Parit", "category": "Infrastruktur", "description": "Jumlah parit sahaja"},
    {"id": "pipe_type_other", "name": "Bilangan Lain-lain Paip", "category": "Infrastruktur", "description": "Paip/jenis lain"},
    {"id": "has_community", "name": "Ada Pusat Komuniti", "category": "Komuniti", "description": "1 jika ada pusat komuniti berhampiran"},
    {"id": "community_dist_km", "name": "Jarak Pusat Komuniti (km)", "category": "Komuniti", "description": "Jarak ke pusat komuniti terdekat (km)"},
    {"id": "land_use_diversity", "name": "Kepelbagaian Guna Tanah", "category": "Guna Tanah", "description": "Bilangan jenis guna tanah unik dalam segmen"},
    {"id": "center_x", "name": "Longitud Pusat", "category": "Geografi", "description": "Longitud pusat segmen"},
    {"id": "center_y", "name": "Latitud Pusat", "category": "Geografi", "description": "Latitud pusat segmen"},
]

_custom_model = None
_custom_model_info = {"r2": None, "rmse": None, "mae": None, "n_features": 0, "features": [], "trained_at": None}
_custom_runoff_model = None
_custom_runoff_model_info = {"r2": None, "rmse": None, "mae": None, "n_features": 0, "features": [], "trained_at": None}

class FeatureTrainIn(BaseModel):
    feature_ids: List[str]
    target: str = 'risk'  # 'risk' or 'runoff'

class FeatureDeployIn(BaseModel):
    model_id: str  # 'heuristic', 'pretrained', or 'custom'

class FeatureCommentaryIn(BaseModel):
    feature_ids: List[str]

@api.get("/model/features")
def list_features():
    categories = {}
    for f in _MODEL_FEATURE_DEFS:
        cat = f["category"]
        if cat not in categories:
            categories[cat] = []
        categories[cat].append(f)
    return {
        "features": _MODEL_FEATURE_DEFS,
        "categories": categories,
        "active_model": _custom_model_info if _custom_model_info["r2"] is not None else None,
        "current_features": _risk_feature_names if _risk_model else [],
    }


@api.get("/model/available")
def list_available_models():
    global _custom_runoff_model, _custom_runoff_model_info
    active_mode = db_get_config('ml_model_mode', 'heuristic')
    rpt_mode = db_get_config('report_model_mode', 'disabled')
    fid_to_def = {f["id"]: f for f in _MODEL_FEATURE_DEFS}
    models = [
        {
            "id": "heuristic",
            "name": "Heuristik (Peraturan)",
            "description": "Model berdasarkan peraturan tangan. Tiada latihan data — menggunakan formula berat tetap untuk jarak paip, guna tanah, dan pusat komuniti.",
            "type": "heuristic",
            "active": active_mode == 'heuristic',
            "features": [],
            "n_features": 0,
            "metrics": {"r2": None, "rmse": None, "mae": None},
            "feature_names": [],
        }
    ]
    orig_path = os.path.join(_model_dir, "risk_model.pkl")
    if os.path.isfile(orig_path):
        try:
            pkg = joblib.load(orig_path)
            fnames = pkg.get("feature_names", [])
            m = pkg.get("metrics", {})
            imp = pkg.get("importances", {})
            is_active = active_mode == 'ml' and _custom_model_info["r2"] is None
            feat_labels = []
            for fid in fnames:
                fdef = fid_to_def.get(fid)
                feat_labels.append(fdef["name"] if fdef else fid)
            models.append({
                "id": "pretrained",
                "name": "ML Asal (RandomForest, R²=0.953)",
                "description": "Model RandomForest yang dilatih daripada 376 segmen data sebenar MBIP. Menggunakan 31 ciri guna tanah, infrastruktur, dan geografi.",
                "type": "ml",
                "active": is_active,
                "features": fnames,
                "n_features": len(fnames),
                "metrics": {"r2": round(m.get("r2", 0), 4), "rmse": round(m.get("rmse", 0), 4), "mae": round(m.get("mae", 0), 4)},
                "feature_names": feat_labels,
                "importances": {k: round(v, 4) for k, v in (imp.items() if isinstance(imp, dict) else imp)[:10]} if imp else {},
            })
        except Exception:
            pass
    custom_path = os.path.join(_model_dir, "custom_model.pkl")
    if os.path.isfile(custom_path) and _custom_model_info["r2"] is not None:
        ci = _custom_model_info
        feat_labels = []
        for fid in ci["features"]:
            fdef = fid_to_def.get(fid)
            feat_labels.append(fdef["name"] if fdef else fid)
        imp = {}
        if _custom_model and hasattr(_custom_model, 'feature_importances_'):
            imp = dict(zip(ci["features"], [round(float(x), 4) for x in _custom_model.feature_importances_]))
            imp = dict(sorted(imp.items(), key=lambda x: -abs(x[1]))[:10])
        models.append({
            "id": "custom",
            "name": "Model Custom (Latihan Sendiri)",
            "description": f"Model RandomForest dilatih dengan {ci['n_features']} ciri pilihan daripada {ci.get('n_segments', 376)} segmen.",
            "type": "ml",
            "active": active_mode == 'ml' and ci["r2"] is not None,
            "features": ci["features"],
            "n_features": ci["n_features"],
            "metrics": {"r2": ci["r2"], "rmse": ci["rmse"], "mae": ci["mae"]},
            "feature_names": feat_labels,
            "importances": imp,
            "trained_at": ci.get("trained_at"),
            "n_segments": ci.get("n_segments"),
        })
    custom_runoff_path = os.path.join(_model_dir, "custom_runoff_model.pkl")
    if os.path.isfile(custom_runoff_path) and _custom_runoff_model_info.get("r2") is None:
        try:
            pkg = joblib.load(custom_runoff_path)
            _custom_runoff_model = pkg.get("regressor")
            metrics = pkg.get("metrics", {})
            _custom_runoff_model_info = {
                "r2": round(float(metrics.get("r2", 0)), 4),
                "rmse": round(float(metrics.get("rmse", 0)), 4),
                "mae": round(float(metrics.get("mae", 0)), 4),
                "n_features": int(pkg.get("n_features", len(pkg.get("feature_ids", [])))),
                "features": pkg.get("feature_ids", []),
                "trained_at": None,
            }
        except Exception:
            pass
    return {
        "models": models,
        "active_model_id": "heuristic" if active_mode == 'heuristic' else ("custom" if _custom_model_info["r2"] is not None else "pretrained"),
        "report_model_mode": rpt_mode,
        "runoff_custom_model": _custom_runoff_model_info if _custom_runoff_model_info.get("r2") is not None else None,
    }


@api.get("/model/eval")
def evaluate_models():
    if not enforcer or not enforcer.enriched:
        raise HTTPException(503, "Data tidak tersedia")
    segs = enforcer.enriched
    heuristic_scores = []
    heuristic_levels = []
    ml_scores = []
    ml_levels = []
    for seg in segs:
        sc, lv, _ = score_segment(seg)
        heuristic_scores.append(sc)
        heuristic_levels.append(lv)
    heuristic_scores = np.array(heuristic_scores, dtype=np.float32)
    ml_pred_ready = _risk_model is not None and db_get_config('ml_model_mode', 'heuristic') == 'ml'
    if _risk_model is not None:
        feats = []
        valid_mask = []
        for seg in segs:
            try:
                full_f, _ = extract_ml_features(seg)
                f = _select_active_risk_features(full_f)
                feats.append(f)
                valid_mask.append(True)
            except Exception:
                feats.append(np.zeros(len(_risk_feature_names), dtype=np.float32))
                valid_mask.append(False)
        mat = np.array(feats, dtype=np.float32)
        preds = _risk_model.predict(mat)
        for i, pred in enumerate(preds):
            if not valid_mask[i]:
                ml_scores.append(None)
                ml_levels.append(None)
                continue
            p = max(0, min(100, float(pred)))
            ml_scores.append(p)
            ml_levels.append('RENDAH' if p < 30 else 'SEDERHANA' if p < 55 else 'TINGGI' if p < 75 else 'KRITIKAL')
    ml_scores_arr = np.array([s for s in ml_scores if s is not None], dtype=np.float32)
    heuristic_for_ml = np.array([heuristic_scores[i] for i in range(len(heuristic_scores)) if ml_scores[i] is not None], dtype=np.float32)
    ml_r2 = float(1 - np.sum((ml_scores_arr - heuristic_for_ml) ** 2) / np.sum((heuristic_for_ml - np.mean(heuristic_for_ml)) ** 2)) if len(ml_scores_arr) > 1 else None
    ml_rmse = float(np.sqrt(np.mean((ml_scores_arr - heuristic_for_ml) ** 2))) if len(ml_scores_arr) > 0 else None
    ml_mae = float(np.mean(np.abs(ml_scores_arr - heuristic_for_ml))) if len(ml_scores_arr) > 0 else None
    h_mean = float(np.mean(heuristic_scores))
    h_std = float(np.std(heuristic_scores))
    h_min = float(np.min(heuristic_scores))
    h_max = float(np.max(heuristic_scores))
    h_median = float(np.median(heuristic_scores))
    h_counts = {}
    for lv in heuristic_levels:
        h_counts[lv] = h_counts.get(lv, 0) + 1
    stored_pkg = None
    try:
        stored_pkg = joblib.load(os.path.join(_model_dir, "risk_model.pkl"))
    except Exception:
        pass
    stored_metrics = stored_pkg.get("metrics", {}) if stored_pkg else {}
    return {
        "heuristic": {
            "r2_vs_ml": ml_r2, "rmse_vs_ml": ml_rmse, "mae_vs_ml": ml_mae,
            "score_mean": round(h_mean, 2), "score_std": round(h_std, 2),
            "score_min": round(h_min, 2), "score_max": round(h_max, 2),
            "score_median": round(h_median, 2),
            "level_counts": h_counts,
            "n_segments": len(segs),
        },
        "ml_asal": {
            "r2": round(stored_metrics.get("r2", 0), 4),
            "mae": round(stored_metrics.get("mae", 0), 4),
            "rmse": round(ml_rmse, 4) if ml_rmse else None,
            "n_segments": len(ml_scores_arr),
        },
        "ml_custom": _custom_model_info if _custom_model_info["r2"] is not None else None,
    }


def _build_custom_features(segs, feature_ids):
    full_feat_matrix = []
    valid_indices = []
    for seg in segs:
        try:
            feat, _ = extract_ml_features(seg)
            full_feat_matrix.append(feat)
            valid_indices.append(True)
        except Exception:
            full_feat_matrix.append(np.zeros(len(_risk_feature_names), dtype=np.float32))
            valid_indices.append(False)
    id_to_idx = {fid: i for i, fid in enumerate(_risk_feature_names)}
    sel_indices = [id_to_idx[fid] for fid in feature_ids if fid in id_to_idx]
    if not sel_indices:
        raise HTTPException(400, "Tiada ciri sah dipilih")
    mat = np.array(full_feat_matrix, dtype=np.float32)[:, sel_indices]
    return mat, valid_indices


def _compute_runoff_training_labels(segs):
    if not topology:
        raise HTTPException(503, "Topologi sungai tidak tersedia")
    flow_data = _compute_flow_accumulation(segs, topology)
    max_flow = max((f['flow_volume'] for f in flow_data.values()), default=1.0)
    labels = []
    for seg in segs:
        sid = seg['segment_id']
        c, _, _ = _estimate_runoff_coefficient(seg)
        fd = flow_data.get(sid, {'upstream_count': 0, 'flow_volume': c})
        seg_length = _compute_segment_length_m(sid)
        slope_factor = min(2.0, 500.0 / max(seg_length, 100.0))
        drainage_factor = min(1.5, 1.0 + 0.1 * len(seg.get('nearby_pipes', [])))
        source_score = c * slope_factor * drainage_factor * 100
        impact_score = (fd['flow_volume'] / max_flow * 100) if max_flow > 0 else 0
        if fd['upstream_count'] == 0:
            runoff_risk = source_score * 0.7 + impact_score * 0.3
        else:
            runoff_risk = source_score * 0.4 + impact_score * 0.6
        labels.append(max(0.0, min(100.0, runoff_risk)))
    return np.array(labels, dtype=np.float32)


@api.post("/model/train")
def train_custom_model(m: FeatureTrainIn):
    global _custom_model, _custom_model_info, _custom_runoff_model, _custom_runoff_model_info
    if not enforcer or not enforcer.enriched:
        raise HTTPException(503, "Data segmen tidak tersedia")
    if _risk_model is None:
        raise HTTPException(503, "Model asas tidak tersedia")
    target = (m.target or 'risk').lower().strip()
    if target not in ('risk', 'runoff'):
        raise HTTPException(400, "target mesti 'risk' atau 'runoff'")
    segs = enforcer.enriched
    mat, valid = _build_custom_features(segs, m.feature_ids)
    source_labels = _compute_runoff_training_labels(segs) if target == 'runoff' else None
    labels = []
    valid_rows = []
    for i, seg in enumerate(segs):
        if not valid[i]:
            continue
        try:
            sc = float(source_labels[i]) if target == 'runoff' else score_segment(seg)[0]
            labels.append(sc)
            valid_rows.append(i)
        except Exception:
            continue
    if len(valid_rows) < 20:
        raise HTTPException(400, f"Hanya {len(valid_rows)} segmen layak (minimum 20)")
    X = mat[valid_rows]
    y = np.array(labels, dtype=np.float32)
    from sklearn.ensemble import RandomForestRegressor
    from sklearn.model_selection import cross_val_score
    model = RandomForestRegressor(n_estimators=100, max_depth=10, random_state=42, n_jobs=1)
    cv_scores = cross_val_score(model, X, y, cv=min(5, len(valid_rows)), scoring='r2', n_jobs=1)
    model.fit(X, y)
    r2 = float(cv_scores.mean())
    preds = model.predict(X)
    rmse = float(np.sqrt(np.mean((preds - y) ** 2)))
    mae = float(np.mean(np.abs(preds - y)))
    model_path = os.path.join(_model_dir, "custom_runoff_model.pkl" if target == 'runoff' else "custom_model.pkl")
    joblib.dump({
        "regressor": model,
        "feature_ids": m.feature_ids,
        "feature_names": m.feature_ids,
        "metrics": {"r2": r2, "rmse": rmse, "mae": mae},
        "n_features": len(m.feature_ids),
        "target": target,
    }, model_path)
    info = {
        "r2": round(r2, 4),
        "rmse": round(rmse, 4),
        "mae": round(mae, 4),
        "n_features": len(m.feature_ids),
        "features": m.feature_ids,
        "trained_at": time.time(),
        "n_segments": len(valid_rows),
    }
    if target == 'runoff':
        _custom_runoff_model = model
        _custom_runoff_model_info = info
    else:
        _custom_model = model
        _custom_model_info = info
    return {
        "status": "ok",
        "target": target,
        "r2": round(r2, 4),
        "rmse": round(rmse, 4),
        "mae": round(mae, 4),
        "n_features": len(m.feature_ids),
        "n_segments": len(valid_rows),
        "importances": dict(zip(m.feature_ids, [round(float(x), 4) for x in model.feature_importances_])) if hasattr(model, 'feature_importances_') else {},
    }


@api.post("/model/deploy")
def deploy_custom_model(m: FeatureDeployIn):
    global _risk_model, _risk_feature_names, _risk_importances, _custom_model
    if m.model_id not in ('heuristic', 'pretrained', 'custom'):
        raise HTTPException(400, "model_id mesti 'heuristic', 'pretrained', atau 'custom'")
    _clear_explore_cache()
    if m.model_id == 'heuristic':
        db_set_config('ml_model_mode', 'heuristic')
        return {"status": "ok", "message": "Model heuristik diaktifkan", "active_model_id": "heuristic"}
    if m.model_id == 'pretrained':
        orig_path = os.path.join(_model_dir, "risk_model.pkl")
        if not os.path.isfile(orig_path):
            raise HTTPException(400, "Model asal tidak ditemui")
        pkg = joblib.load(orig_path)
        _risk_model = pkg["regressor"]
        _risk_feature_names = pkg["feature_names"]
        _risk_importances = dict(pkg["importances"])
        if hasattr(_risk_model, 'n_jobs'):
            _risk_model.n_jobs = 1
        db_set_config('ml_model_mode', 'ml')
        return {"status": "ok", "message": "Model ML asal diaktifkan", "active_model_id": "pretrained"}
    if m.model_id == 'custom':
        custom_path = os.path.join(_model_dir, "custom_model.pkl")
        if _custom_model is None:
            if not os.path.isfile(custom_path):
                raise HTTPException(400, "Tiada model custom. Latih dahulu.")
            pkg = joblib.load(custom_path)
            _custom_model = pkg["regressor"]
            if _custom_model_info.get("r2") is None:
                metrics = pkg.get("metrics", {})
                _custom_model_info.update({
                    "r2": round(float(metrics.get("r2", 0)), 4),
                    "rmse": round(float(metrics.get("rmse", 0)), 4),
                    "mae": round(float(metrics.get("mae", 0)), 4),
                    "n_features": int(pkg.get("n_features", len(pkg.get("feature_ids", [])))),
                    "features": pkg.get("feature_ids", []),
                    "trained_at": None,
                })
        _risk_model = _custom_model
        _risk_feature_names = _custom_model_info["features"]
        _risk_importances = dict(zip(_custom_model_info["features"], _custom_model.feature_importances_)) if hasattr(_custom_model, 'feature_importances_') else {}
        db_set_config('ml_model_mode', 'ml')
        return {"status": "ok", "message": "Model custom diaktifkan", "active_model_id": "custom"}


@api.post("/model/delete")
def delete_custom_model(m: FeatureDeployIn, admin_id: str = Depends(get_current_admin)):
    global _risk_model, _risk_feature_names, _risk_importances, _custom_model, _custom_model_info, _custom_runoff_model, _custom_runoff_model_info
    if m.model_id not in ('custom', 'runoff_custom'):
        raise HTTPException(400, "Hanya model custom boleh dipadam")
    if m.model_id == 'custom':
        path = os.path.join(_model_dir, "custom_model.pkl")
        if os.path.isfile(path):
            os.remove(path)
        _custom_model = None
        _custom_model_info = {"r2": None, "rmse": None, "mae": None, "n_features": 0, "features": [], "trained_at": None}
        if db_get_config('ml_model_mode', 'heuristic') == 'ml':
            orig_path = os.path.join(_model_dir, "risk_model.pkl")
            if os.path.isfile(orig_path):
                pkg = joblib.load(orig_path)
                _risk_model = pkg["regressor"]
                _risk_feature_names = pkg["feature_names"]
                _risk_importances = dict(pkg["importances"])
            else:
                db_set_config('ml_model_mode', 'heuristic')
        _clear_explore_cache()
        return {"status": "ok", "message": "Model custom risiko telah dipadam"}
    path = os.path.join(_model_dir, "custom_runoff_model.pkl")
    if os.path.isfile(path):
        os.remove(path)
    _custom_runoff_model = None
    _custom_runoff_model_info = {"r2": None, "rmse": None, "mae": None, "n_features": 0, "features": [], "trained_at": None}
    return {"status": "ok", "message": "Model custom larian permukaan telah dipadam"}


@api.post("/model/ai-commentary")
async def model_ai_commentary(m: FeatureCommentaryIn):
    if not GROQ_API_KEY:
        return {"commentary": "GROQ API tidak dikonfigurasi."}
    feature_descs = []
    fid_to_def = {f["id"]: f for f in _MODEL_FEATURE_DEFS}
    for fid in m.feature_ids:
        fdef = fid_to_def.get(fid)
        if fdef:
            feature_descs.append(f"- {fdef['name']}: {fdef['description']} (Kategori: {fdef['category']})")
        else:
            feature_descs.append(f"- {fid}")
    feature_list = "\n".join(feature_descs)
    prompt = f"""Anda adalah pakar pencemaran sungai dan analisis data alam sekitar.

Berikut adalah senarai ciri (features) yang dipilih untuk model ramalan risiko pencemaran sungai:

{feature_list}

Jumlah ciri: {len(m.feature_ids)}

Tulis ulasan dalam Bahasa Melayu (3-5 ayat) yang menjelaskan:
1. Apakah kombinasi ciri ini mewakili dari sudut pencemaran sungai
2. Kekuatan gabungan ciri ini untuk meramalkan risiko pencemaran
3. Apakah jurang atau ciri tambahan yang mungkin berguna
4. Kesimpulan tentang keberkesanan model ini

JANGAN reka maklumat tambahan. Hanya ulas berdasarkan ciri yang diberikan."""
    try:
        import httpx
        async with httpx.AsyncClient(timeout=20) as hx:
            resp = await hx.post("https://api.groq.com/openai/v1/chat/completions", headers={"Authorization": f"Bearer {GROQ_API_KEY}", "Content-Type": "application/json"}, json={"model": "llama-3.1-8b-instant", "messages": [{"role": "user", "content": prompt}], "max_tokens": 500, "temperature": 0.3})
        data = resp.json()
        if "choices" in data and data["choices"]:
            return {"commentary": data["choices"][0]["message"]["content"]}
        return {"commentary": f"Ralat daripada AI: {data.get('error', {}).get('message', 'Unknown')}"}
    except Exception as e:
        return {"commentary": f"Ralat sambungan AI: {e}"}


# ====== Explore + Projection Endpoints ======

# The map is rendered frequently by the browser.  Scoring 376 segments (and,
# when enabled, evaluating the ML model) on every request made the first view
# feel slow.  Cache only derived API payloads; the authoritative ArcGIS cache
# and reports database remain the source of truth.
_explore_payload_cache = {}
_EXPLORE_CACHE_SECONDS = 120

def _clear_explore_cache():
    _explore_payload_cache.clear()

_story_cache = {"ts": 0, "payload": None}
_STORY_CACHE_SECONDS = 30

@api.get("/story/overview")
def story_overview():
    """Small, evidence-backed briefing payload for the first screen."""
    now = time.time()
    if _story_cache["payload"] and (now - _story_cache["ts"]) < _STORY_CACHE_SECONDS:
        return _story_cache["payload"]
    if not enforcer:
        conn = sqlite3.connect(_db_path)
        reports = conn.execute("SELECT COUNT(*) FROM reports").fetchone()[0]
        conn.close()
        return {
            "segment_count": 376,
            "critical_count": 0,
            "high_count": 0,
            "medium_count": 0,
            "low_count": 0,
            "top_segments": [],
            "report_count": reports,
            "model_active": False,
            "ml_active": False,
            "message": "Data enrichment masih dimuatkan. Peta risiko boleh digunakan selepas sistem sedia.",
        }
    counts = {"KRITIKAL": 0, "TINGGI": 0, "SEDERHANA": 0, "RENDAH": 0}
    scored = []
    for seg in enforcer.enriched:
        s, lvl, facts = score_segment(seg)
        counts[lvl] = counts.get(lvl, 0) + 1
        scored.append({"id": seg["segment_id"],
                        "name": segment_name_map.get(seg["segment_id"], f"Segmen {seg['segment_id']}"),
                        "risk_score": s, "risk_level": lvl, "factors": facts})
    top = sorted(scored, key=lambda x: x["risk_score"], reverse=True)[:3]
    conn = sqlite3.connect(_db_path)
    reports = conn.execute("SELECT COUNT(*) FROM reports").fetchone()[0]
    verified = conn.execute("SELECT COUNT(*) FROM reports WHERE verified=1").fetchone()[0]
    conn.close()
    lu_total = sum(len(e.get("land_use", [])) for e in enforcer.enriched)
    pipe_total = sum(len(e.get("nearby_pipes", [])) for e in enforcer.enriched)
    comm_total = sum(1 for e in enforcer.enriched if e.get("community_center"))
    result = {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "total_segments": len(enforcer.enriched),
        "risk_counts": counts,
        "top_priorities": [{"id": s["id"], "name": s["name"], "risk_score": s["risk_score"],
                            "risk_level": s["risk_level"], "factors": s["factors"][:3]}
                           for s in top],
        "reports": {"total": reports, "verified": verified},
        "evidence_coverage": {
            "land_use_links": lu_total,
            "drainage_links": pipe_total,
            "community_links": comm_total,
        },
        "geometry_available": bool(segment_geometries),
    }
    _story_cache["ts"] = time.time()
    _story_cache["payload"] = result
    return result

@api.get("/explore/segments")
def explore_segments(limit: int = 500, offset: int = 0):
    if not enforcer:
        raise HTTPException(503, "Enrichment not loaded")
    cache_key = (limit, offset, db_get_config('report_model_mode', 'disabled'), db_get_config('ml_model_mode', 'heuristic'))
    cached = _explore_payload_cache.get(cache_key)
    if cached and time.monotonic() - cached[0] < _EXPLORE_CACHE_SECONDS:
        return cached[1]
    segs = enforcer.enriched
    total = len(segs)
    segs = segs[offset:offset + limit]
    rpt_mode = db_get_config('report_model_mode', 'disabled')
    ml_mode = db_get_config('ml_model_mode', 'heuristic')
    batch_ml = batch_ml_scores(segs) if (ml_mode == 'ml' and _risk_model is not None) else [None] * len(segs)
    result = []
    for i, seg in enumerate(segs):
        sid = seg['segment_id']
        orig_score, orig_level, orig_facts = score_segment(seg)
        rpt_score = report_model_score(sid) if rpt_mode == 'enabled' else None
        ml_score, ml_level, ml_contribs = batch_ml[i] if i < len(batch_ml) and batch_ml[i] is not None else (None, None, None)
        if ml_score is not None:
            if rpt_mode == 'enabled' and rpt_score is not None:
                s = (ml_score + rpt_score) // 2
                lvl = 'RENDAH' if s < 30 else 'SEDERHANA' if s < 55 else 'TINGGI' if s < 75 else 'KRITIKAL'
            else:
                s, lvl = ml_score, ml_level
        else:
            s, lvl = orig_score, orig_level
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
            "factors": orig_facts,
            "geometry": geo,
            "land_use_count": len(land_use_list),
            "pipe_count": len(pipes),
            "land_use_types": land_use_types,
            "nearest_pipe": nearest_pipe,
            "nearest_community": comm,
        }
        if rpt_score is not None:
            entry["report_risk_score"] = rpt_score
        if ml_score is not None:
            entry["ml_risk_score"] = ml_score
            entry["ml_contributors"] = ml_contribs
        result.append(entry)
    response = {"total": total, "offset": offset, "limit": limit, "segments": result}
    _explore_payload_cache[cache_key] = (time.monotonic(), response)
    return response


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


# ====== NEW FEATURES: WebSocket, Topology, Spread, Image Analysis, PDF, Time-Series, Chatbot ======

# ---- WebSocket Endpoint ----
@app.websocket("/api/ws/alerts")
async def websocket_alerts(ws: WebSocket):
    await alert_manager.connect(ws)
    try:
        while True:
            data = await ws.receive_text()
            msg = json.loads(data)
            if msg.get("type") == "ping":
                await ws.send_json({"type": "pong"})
    except WebSocketDisconnect:
        alert_manager.disconnect(ws)
    except Exception:
        alert_manager.disconnect(ws)

@app.websocket("/api/ws/spread")
async def websocket_spread(ws: WebSocket):
    await ws.accept()
    try:
        raw = await ws.receive_text()
        msg = json.loads(raw)
        segment_id = msg.get("segment_id")
        if not segment_id:
            await ws.send_json({"type": "error", "message": "segment_id diperlukan"})
            await ws.close()
            return
        if not spread_sim:
            await ws.send_json({"type": "error", "message": "Simulasi belum tersedia"})
            await ws.close()
            return

        kwargs = {}
        if msg.get("total_time_min"):
            kwargs["total_time"] = msg["total_time_min"] * 60
        if msg.get("concentration") is not None:
            kwargs["initial_concentration"] = msg["concentration"]
        if msg.get("velocity") is not None:
            kwargs["velocity"] = msg["velocity"]
        if msg.get("diffusion") is not None:
            kwargs["diffusion"] = msg["diffusion"]

        for update in spread_sim.simulate_stream(segment_id, **kwargs):
            await ws.send_json(update)
            if update["type"] == "step" and update["t"] > 0:
                await asyncio.sleep(0.03)

        await ws.close()
    except WebSocketDisconnect:
        pass
    except Exception as e:
        try:
            await ws.send_json({"type": "error", "message": str(e)})
            await ws.close()
        except Exception:
            pass


# ---- Topology Endpoints ----
@api.get("/topology")
def get_topology():
    if not topology:
        raise HTTPException(503, "Topologi sungai belum dibina")
    return topology.to_dict()

@api.get("/topology/downstream/{segment_id}")
def topology_downstream(segment_id: int):
    if not topology:
        raise HTTPException(503, "Topologi belum tersedia")
    chain = topology.get_downstream_chain(segment_id)
    return {"source": segment_id, "chain": chain, "count": len(chain)}

@api.get("/topology/upstream/{segment_id}")
def topology_upstream(segment_id: int):
    if not topology:
        raise HTTPException(503, "Topologi belum tersedia")
    chain = topology.get_upstream_chain(segment_id)
    return {"source": segment_id, "chain": chain, "count": len(chain)}

@api.get("/topology/graph")
def topology_graph():
    if not topology:
        raise HTTPException(503, "Topologi belum tersedia")
    td = topology.to_dict()
    edges_with_geometry = []
    for edge in td["edges"]:
        geo_from = segment_geometries.get(edge["from"], [[]])
        geo_to = segment_geometries.get(edge["to"], [[]])
        pt_from = geo_from[0][-1] if geo_from and geo_from[0] else None
        pt_to = geo_to[0][0] if geo_to and geo_to[0] else None
        edge["geometry"] = [pt_from, pt_to] if pt_from and pt_to else None
        edges_with_geometry.append(edge)
    td["edges"] = edges_with_geometry
    return td


# ---- Pollution Spread Simulation ----
class SpreadRequest(BaseModel):
    segment_id: int
    concentration: float | None = None  # None = derive from risk score
    velocity: float | None = None       # None = derive from segment geometry
    diffusion: float | None = None      # None = derive from land use
    total_time_min: float = 60.0

@api.post("/spread/simulate")
def simulate_spread(req: SpreadRequest):
    if not spread_sim:
        raise HTTPException(503, "Simulasi belum tersedia")
    kwargs = {"total_time": req.total_time_min * 60}
    if req.concentration is not None:
        kwargs["initial_concentration"] = req.concentration
    if req.velocity is not None:
        kwargs["velocity"] = req.velocity
    if req.diffusion is not None:
        kwargs["diffusion"] = req.diffusion
    # When params are None, PollutionSpread derives them from real segment data
    result = spread_sim.simulate(req.segment_id, **kwargs)
    return result

@api.get("/spread/impact/{segment_id}")
def quick_impact(segment_id: int, severity: float = 1.0):
    if not spread_sim:
        raise HTTPException(503, "Simulasi belum tersedia")
    impacts = spread_sim.quick_impact(segment_id, severity_factor=severity)
    return {"impacts": impacts, "total_affected": len(impacts)}


# ---- Image Analysis (Groq Vision) ----
class ImageAnalysisRequest(BaseModel):
    report_id: int | None = None
    image_base64: str
    description: str = ""

def _analyze_image_internal(image_base64: str, description: str = ""):
    """Analyze pollution image using Groq vision model."""
    if not GROQ_API_KEY:
        return {"pollution_type": "tidak_diketahui", "confidence": 0,
                "description": "Analisis imej tidak tersedia — GROQ_API_KEY belum ditetapkan.",
                "color_rgb": None}
    try:
        from groq import Groq
        client = Groq(api_key=GROQ_API_KEY, timeout=20.0)
        img_data = image_base64
        if "," in img_data:
            img_data = img_data.split(",", 1)[1]
        prompt = f"""Analisis imej pencemaran sungai ini. Penerangan pengguna: {description[:200]}

Identifikasi:
1. JENIS PENCEMARAN: (minyak/lemak, kekeruhan, warna tidak normal, buih, sampah, sisa kimia, tiada)
2. KEYAKINAN (0-100)
3. PENERANGAN RINGKAS (1-2 ayat dalam Bahasa Melayu)
4. WARNA DOMINAN: RGB value (contoh: 128,64,32)

Format:
JENIS: <jenis>
KEYAKINAN: <angka>
PENERANGAN: <ayat>
WARNA: <R>,<G>,<B>"""
        resp = client.chat.completions.create(
            model="llama-3.2-11b-vision-preview",
            messages=[{
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{img_data}"}},
                ],
            }],
            max_tokens=200,
            temperature=0.2,
        )
        text = resp.choices[0].message.content.strip()
        result = {"pollution_type": "tidak_diketahui", "confidence": 0, "description": text, "color_rgb": None}
        for line in text.split("\n"):
            line = line.strip()
            if line.upper().startswith("JENIS:"):
                result["pollution_type"] = line.split(":", 1)[1].strip()
            elif line.upper().startswith("KEYAKINAN:"):
                try:
                    result["confidence"] = max(0, min(100, int(line.split(":")[1].strip())))
                except: pass
            elif line.upper().startswith("PENERANGAN:"):
                result["description"] = line.split(":", 1)[1].strip()
            elif line.upper().startswith("WARNA:"):
                try:
                    rgb = [int(x.strip()) for x in line.split(":", 1)[1].strip().split(",")]
                    result["color_rgb"] = rgb[:3]
                except: pass
        return result
    except Exception as e:
        return {"pollution_type": "ralat", "confidence": 0,
                "description": f"Analisis imej gagal: {str(e)[:100]}",
                "color_rgb": None}

@api.post("/analyze-image")
def analyze_image(req: ImageAnalysisRequest):
    result = _analyze_image_internal(req.image_base64, req.description)
    if req.report_id:
        conn = sqlite3.connect(_db_path)
        conn.execute("INSERT OR REPLACE INTO image_analysis (report_id, pollution_type, confidence, description, color_rgb, timestamp) VALUES (?,?,?,?,?,?)",
                     (req.report_id, result["pollution_type"], result["confidence"],
                      result["description"], json.dumps(result["color_rgb"]), datetime.now().isoformat()))
        conn.commit()
        conn.close()
    return result

@api.get("/report/{report_id}/image-analysis")
def get_image_analysis(report_id: int):
    conn = sqlite3.connect(_db_path)
    conn.row_factory = sqlite3.Row
    row = conn.execute("SELECT * FROM image_analysis WHERE report_id=?", (report_id,)).fetchone()
    conn.close()
    if not row:
        return {"analysis": None}
    r = dict(row)
    if r.get("color_rgb"):
        r["color_rgb"] = json.loads(r["color_rgb"])
    return {"analysis": r}


# ---- Time-Series Risk Tracking ----
@api.post("/timeseries/snapshot")
def take_risk_snapshot():
    """Snapshot all segment risk scores for historical tracking."""
    if not enforcer:
        raise HTTPException(503, "Data belum tersedia")
    now = datetime.now().isoformat()
    conn = sqlite3.connect(_db_path)
    ml_mode = db_get_config('ml_model_mode', 'heuristic')
    batch_ml = batch_ml_scores(enforcer.enriched) if (ml_mode == 'ml' and _risk_model is not None) else [None] * len(enforcer.enriched)
    count = 0
    for i, seg in enumerate(enforcer.enriched):
        sid = seg['segment_id']
        orig_score, orig_level, _ = score_segment(seg)
        ml_score, ml_level, _ = batch_ml[i] if i < len(batch_ml) and batch_ml[i] is not None else (None, None, None)
        s, lvl = (ml_score, ml_level) if ml_score is not None else (orig_score, orig_level)
        conn.execute("INSERT INTO risk_snapshots (segment_id, risk_score, risk_level, ml_score, timestamp) VALUES (?,?,?,?,?)",
                     (sid, s, lvl, ml_score, now))
        count += 1
    conn.commit()
    conn.close()
    return {"status": "ok", "snapshots": count, "timestamp": now}

@api.get("/timeseries/{segment_id}")
def get_timeseries(segment_id: int, days: int = 30):
    conn = sqlite3.connect(_db_path)
    conn.row_factory = sqlite3.Row
    cutoff = (datetime.now() - timedelta(days=days)).isoformat()
    rows = conn.execute(
        "SELECT * FROM risk_snapshots WHERE segment_id=? AND timestamp>? ORDER BY timestamp ASC",
        (segment_id, cutoff)).fetchall()
    conn.close()
    data = [{"risk_score": r["risk_score"], "risk_level": r["risk_level"],
             "ml_score": r["ml_score"], "timestamp": r["timestamp"]} for r in rows]
    return {"segment_id": segment_id, "days": days, "data_points": len(data), "data": data}

@api.get("/timeseries")
def get_all_timeseries_summary(days: int = 30):
    conn = sqlite3.connect(_db_path)
    conn.row_factory = sqlite3.Row
    cutoff = (datetime.now() - timedelta(days=days)).isoformat()
    rows = conn.execute(
        "SELECT segment_id, AVG(risk_score) as avg_score, MIN(risk_score) as min_score, MAX(risk_score) as max_score, COUNT(*) as readings FROM risk_snapshots WHERE timestamp>? GROUP BY segment_id ORDER BY avg_score DESC",
        (cutoff,)).fetchall()
    conn.close()
    return {"days": days, "segments": len(rows),
            "data": [{"segment_id": r["segment_id"], "avg_score": round(r["avg_score"], 1),
                       "min_score": round(r["min_score"], 1), "max_score": round(r["max_score"], 1),
                       "readings": r["readings"]} for r in rows]}

@api.get("/timeseries/stats/overall")
def get_overall_stats():
    conn = sqlite3.connect(_db_path)
    row = conn.execute("SELECT COUNT(*) as total, MIN(timestamp) as first, MAX(timestamp) as last FROM risk_snapshots").fetchone()
    conn.close()
    return {"total_snapshots": row[0], "first_snapshot": row[1], "last_snapshot": row[2]}


@api.get("/timeseries/stats/rich")
def get_rich_trend_stats(days: int = 30):
    """Rich statistics for the Trend page — risk distribution, temporal trend, top movers, land-use breakdown."""
    conn = sqlite3.connect(_db_path)
    conn.row_factory = sqlite3.Row
    cutoff = (datetime.now() - timedelta(days=days)).isoformat()

    # 1. Risk level distribution (current latest snapshot per segment)
    dist_rows = conn.execute("""
        SELECT risk_level, COUNT(*) as cnt FROM risk_snapshots
        WHERE timestamp = (SELECT MAX(timestamp) FROM risk_snapshots)
        GROUP BY risk_level ORDER BY cnt DESC
    """).fetchall()
    distribution = [{"level": r["risk_level"], "count": r["cnt"]} for r in dist_rows]

    # 2. Temporal trend — avg risk score per day
    trend_rows = conn.execute("""
        SELECT DATE(timestamp) as day, AVG(risk_score) as avg_score,
               AVG(ml_score) as avg_ml, COUNT(DISTINCT segment_id) as seg_count
        FROM risk_snapshots WHERE timestamp > ?
        GROUP BY DATE(timestamp) ORDER BY day ASC
    """, (cutoff,)).fetchall()
    temporal_trend = [{"day": r["day"], "avg_score": round(r["avg_score"], 1),
                       "avg_ml": round(r["avg_ml"], 1) if r["avg_ml"] else None,
                       "segments": r["seg_count"]} for r in trend_rows]

    # 3. Top movers — segments with biggest score changes
    movers = []
    if len(trend_rows) >= 2:
        first_day = trend_rows[0]["day"]
        last_day = trend_rows[-1]["day"]
        first_scores = {r["segment_id"]: r["risk_score"] for r in conn.execute(
            "SELECT segment_id, risk_score FROM risk_snapshots WHERE DATE(timestamp)=?", (first_day,)).fetchall()}
        last_scores = {r["segment_id"]: r["risk_score"] for r in conn.execute(
            "SELECT segment_id, risk_score FROM risk_snapshots WHERE DATE(timestamp)=?", (last_day,)).fetchall()}
        for sid in set(first_scores) & set(last_scores):
            delta = last_scores[sid] - first_scores[sid]
            if abs(delta) >= 1:
                name = segment_name_map.get(sid, f"Segmen {sid}")
                movers.append({"segment_id": sid, "name": name, "from": round(first_scores[sid], 1),
                               "to": round(last_scores[sid], 1), "delta": round(delta, 1)})
        movers.sort(key=lambda x: abs(x["delta"]), reverse=True)
        movers = movers[:10]

    # 4. Risk level time-series (stacked area data)
    level_trend = conn.execute("""
        SELECT DATE(timestamp) as day, risk_level, COUNT(*) as cnt
        FROM risk_snapshots WHERE timestamp > ?
        GROUP BY DATE(timestamp), risk_level ORDER BY day ASC
    """, (cutoff,)).fetchall()
    lt_map = {}
    for r in level_trend:
        d = r["day"]
        if d not in lt_map: lt_map[d] = {"day": d}
        lt_map[d][r["risk_level"]] = r["cnt"]
    level_trend_data = sorted(lt_map.values(), key=lambda x: x["day"])

    # 5. Current stats from live segments
    if enforcer:
        scores = [score_segment(s)[0] for s in enforcer.enriched[:200]]
        avg_live = sum(scores) / len(scores) if scores else 0
        std_live = (sum((s - avg_live)**2 for s in scores) / len(scores))**0.5 if scores else 0
        p90_live = sorted(scores)[int(len(scores)*0.9)] if scores else 0
    else:
        avg_live = std_live = p90_live = 0

    conn.close()
    return {
        "days": days,
        "distribution": distribution,
        "temporal_trend": temporal_trend,
        "top_movers": movers,
        "level_trend": level_trend_data,
        "live_stats": {"avg_score": round(avg_live, 1), "std_dev": round(std_live, 1), "p90": round(p90_live, 1), "total_segments": len(enforcer.enriched) if enforcer else 0},
    }


# ---- Surface Runoff Prediction ----
# SCS Curve Number approximation by land use type
# C = runoff coefficient (fraction of rainfall that becomes surface runoff)
# Based on NRCS SCS-CN method, adapted for Iskandar Puteri tropical conditions
RUNOFF_COEFFICIENTS = {
    'perindustrian': 0.85,   # High impervious surface (factories, warehouses)
    'komersial': 0.80,       # Commercial areas (parking, roofs)
    'perniagaan': 0.80,      # Business/commercial
    'perumahan': 0.55,       # Residential (mixed impervious/pervious)
    'taman': 0.35,           # Parks/gardens (more pervious)
    'pertanian': 0.30,       # Agriculture (pervious, some runoff)
    'hutan': 0.10,           # Forest (high infiltration)
    'tanah kosong': 0.45,    # Empty land (variable)
    'perairan': 0.05,        # Water bodies (already saturated)
    'guna tanah campuran': 0.50,  # Mixed use
}

RUNOFF_MODELS = {
    'hybrid': {
        'name': 'Hibrid (SCS-CN + Infrastruktur)',
        'description': 'Menggabungkan guna tanah, saliran, kecerunan proksi dan akumulasi aliran.',
    },
    'scs': {
        'name': 'SCS-CN Guna Tanah',
        'description': 'Memberi tumpuan kepada koefisien larian berdasarkan guna tanah berhampiran sungai.',
    },
    'infrastructure': {
        'name': 'Infrastruktur Saliran',
        'description': 'Memberi tumpuan kepada paip/parit dan akumulasi aliran dari segmen hulu.',
    },
}

def _estimate_runoff_coefficient(seg):
    """Estimate surface runoff coefficient from land use composition.
    Returns (C, dominant_type, breakdown)."""
    land_uses = seg.get('land_use', [])
    if not land_uses:
        return 0.50, 'unknown', []

    weighted_c = 0.0
    total_weight = 0.0
    breakdown = []
    type_counts = {}

    for lu in land_uses:
        lu_type = (lu.get('type') or '').lower().strip()
        # Find matching runoff coefficient
        c = 0.50  # default
        matched = False
        for key, val in RUNOFF_COEFFICIENTS.items():
            if key in lu_type:
                c = val
                matched = True
                break
        if not matched:
            # Try partial matches
            if 'industri' in lu_type:
                c = 0.85
            elif 'komersial' in lu_type or 'perniagaan' in lu_type:
                c = 0.80
            elif 'residen' in lu_type or 'perumahan' in lu_type:
                c = 0.55
            elif 'pertanian' in lu_type or 'agrikultur' in lu_type:
                c = 0.30
            elif 'hutan' in lu_type or 'forest' in lu_type:
                c = 0.10

        # Weight by inverse distance (closer = more influence)
        dist = lu.get('distance_m', 500)
        weight = 1.0 / max(dist / 100.0, 0.5)
        weighted_c += c * weight
        total_weight += weight

        type_counts[lu_type] = type_counts.get(lu_type, 0) + 1
        breakdown.append({'type': lu_type, 'c': c, 'distance_m': dist})

    final_c = weighted_c / total_weight if total_weight > 0 else 0.50
    dominant = max(type_counts, key=type_counts.get) if type_counts else 'unknown'
    return round(final_c, 3), dominant, breakdown


def _compute_flow_accumulation(enriched_segments, topology_obj):
    """Compute upstream flow accumulation for all segments using BFS.
    Returns {sid: {'upstream_count': N, 'flow_volume': weighted_sum, 'upstream_ids': [...]}}"""
    from collections import deque

    result = {}
    # Build upstream map from topology
    upstream_map = topology_obj.upstream if topology_obj else {}

    # For each segment, BFS upstream to count contributors
    all_sids = [s['segment_id'] for s in enriched_segments]
    c_map = {}
    for seg in enriched_segments:
        c, _, _ = _estimate_runoff_coefficient(seg)
        c_map[seg['segment_id']] = c

    for seg in enriched_segments:
        sid = seg['segment_id']
        visited = {sid}
        queue = deque([(sid, 0)])
        upstream_ids = []
        total_flow = c_map.get(sid, 0.5)  # Include self

        while queue:
            current, depth = queue.popleft()
            for upstream_sid in upstream_map.get(current, []):
                if upstream_sid not in visited:
                    visited.add(upstream_sid)
                    # Decay contribution by distance (each hop loses 15% to infiltration)
                    decay = 0.85 ** depth
                    flow_contrib = c_map.get(upstream_sid, 0.5) * decay
                    total_flow += flow_contrib
                    upstream_ids.append(upstream_sid)
                    if depth < 25:  # max depth
                        queue.append((upstream_sid, depth + 1))

        result[sid] = {
            'upstream_count': len(upstream_ids),
            'flow_volume': round(total_flow, 3),
            'upstream_ids': upstream_ids[:50],  # cap for response size
        }

    return result


def _compute_segment_length_m(sid):
    """Compute segment length in meters."""
    geo = segment_geometries.get(sid, [[]])
    if not geo or not geo[0] or len(geo[0]) < 2:
        return 1000.0
    path = np.array(geo[0])
    diffs = np.diff(path, axis=0)
    lat_m = diffs[:, 0] * 111000
    lon_m = diffs[:, 1] * 110960
    return max(float(np.sum(np.sqrt(lat_m**2 + lon_m**2))), 100.0)


@api.get("/runoff/prediction")
def runoff_prediction(model: str = 'hybrid'):
    """Surface runoff source prediction for all river segments.
    Returns runoff coefficients, flow accumulation, source/impact scores, and geometry."""
    if not enforcer or not topology:
        raise HTTPException(503, "Data belum tersedia")
    global _custom_runoff_model, _custom_runoff_model_info
    available_runoff_models = dict(RUNOFF_MODELS)
    custom_runoff_path = os.path.join(_model_dir, "custom_runoff_model.pkl")
    if os.path.isfile(custom_runoff_path) and _custom_runoff_model_info.get("r2") is None:
        try:
            pkg = joblib.load(custom_runoff_path)
            _custom_runoff_model = pkg.get("regressor")
            metrics = pkg.get("metrics", {})
            _custom_runoff_model_info = {
                "r2": round(float(metrics.get("r2", 0)), 4),
                "rmse": round(float(metrics.get("rmse", 0)), 4),
                "mae": round(float(metrics.get("mae", 0)), 4),
                "n_features": int(pkg.get("n_features", len(pkg.get("feature_ids", [])))),
                "features": pkg.get("feature_ids", []),
                "trained_at": None,
            }
        except Exception:
            _custom_runoff_model = None
    if _custom_runoff_model is not None and _custom_runoff_model_info.get("r2") is not None:
        available_runoff_models['custom'] = {
            'name': 'Model Custom Larian Permukaan',
            'description': f"Model RandomForest dilatih dengan {_custom_runoff_model_info.get('n_features', 0)} ciri pilihan pengguna.",
            'metrics': {k: _custom_runoff_model_info.get(k) for k in ('r2', 'rmse', 'mae')},
        }
    if model not in available_runoff_models:
        raise HTTPException(400, "Model larian permukaan tidak sah")

    enriched = enforcer.enriched
    flow_data = _compute_flow_accumulation(enriched, topology)

    # Find max values for normalization
    max_flow = max((f['flow_volume'] for f in flow_data.values()), default=1.0)
    max_upstream = max((f['upstream_count'] for f in flow_data.values()), default=1)

    results = []
    custom_preds = None
    if model == 'custom' and _custom_runoff_model is not None:
        mat, valid = _build_custom_features(enriched, _custom_runoff_model_info.get("features", []))
        preds = _custom_runoff_model.predict(mat)
        custom_preds = [max(0.0, min(100.0, float(preds[i]))) if valid[i] else None for i in range(len(enriched))]

    for idx, seg in enumerate(enriched):
        sid = seg['segment_id']
        c, dominant_lu, breakdown = _estimate_runoff_coefficient(seg)
        fd = flow_data.get(sid, {'upstream_count': 0, 'flow_volume': c})
        seg_length = _compute_segment_length_m(sid)
        pipes = seg.get('nearby_pipes', [])

        # Slope proxy: shorter segments = steeper = faster runoff
        slope_factor = min(2.0, 500.0 / max(seg_length, 100.0))

        # Drainage factor: more pipes = more impervious drainage network
        drainage_factor = min(1.5, 1.0 + 0.1 * len(pipes))

        # RUNOFF SOURCE SCORE: How much runoff this segment GENERATES
        # High C + steeper slope + impervious drainage = high source potential
        source_score = c * slope_factor * drainage_factor * 100

        # RUNOFF IMPACT SCORE: How much accumulated runoff passes THROUGH this
        # High upstream count + high flow volume = accumulation point
        normalized_flow = fd['flow_volume'] / max_flow if max_flow > 0 else 0
        impact_score = normalized_flow * 100

        # COMBINED RUNOFF RISK
        # Model choices shift emphasis between land-use source generation and downstream accumulation.
        is_headwater = fd['upstream_count'] == 0
        if custom_preds is not None and custom_preds[idx] is not None:
            runoff_risk = custom_preds[idx]
        elif model == 'scs':
            runoff_risk = source_score * 0.85 + impact_score * 0.15
        elif model == 'infrastructure':
            infra_score = min(100.0, (drainage_factor - 1.0) / 0.5 * 70.0 + impact_score * 0.5)
            runoff_risk = source_score * 0.25 + impact_score * 0.45 + infra_score * 0.30
        elif is_headwater:
            runoff_risk = source_score * 0.7 + impact_score * 0.3
        else:
            runoff_risk = source_score * 0.4 + impact_score * 0.6
        runoff_risk = max(0.0, min(100.0, runoff_risk))

        # Classify
        if runoff_risk > 65:
            risk_level = 'TINGGI'
        elif runoff_risk > 40:
            risk_level = 'SEDERHANA'
        else:
            risk_level = 'RENDAH'

        # Source classification
        if is_headwater and c > 0.6:
            source_type = 'Sumber Utama'
        elif is_headwater:
            source_type = 'Hulu'
        elif fd['upstream_count'] > 5:
            source_type = 'Titik Akumulasi'
        else:
            source_type = 'Laluan'

        geo = segment_geometries.get(sid, [])
        wgs84_path = geo[0] if geo and geo[0] else []
        center = segment_wgs84_centers.get(sid) or seg.get('wgs84', [0, 0])

        results.append({
            'segment_id': sid,
            'name': segment_name_map.get(sid, f'Segmen {sid}'),
            'center': center,
            'geometry': wgs84_path,
            'runoff_coefficient': c,
            'dominant_land_use': dominant_lu,
            'land_use_breakdown': breakdown,
            'upstream_count': fd['upstream_count'],
            'flow_volume': round(fd['flow_volume'], 3),
            'segment_length_m': round(seg_length, 1),
            'slope_factor': round(slope_factor, 3),
            'drainage_factor': round(drainage_factor, 3),
            'source_score': round(source_score, 1),
            'impact_score': round(impact_score, 1),
            'runoff_risk': round(runoff_risk, 1),
            'risk_level': risk_level,
            'source_type': source_type,
            'is_headwater': is_headwater,
            'pipe_count': len(pipes),
        })

    # Sort by runoff risk descending
    results.sort(key=lambda x: x['runoff_risk'], reverse=True)

    # Summary stats
    scores = [r['runoff_risk'] for r in results]
    levels = {'TINGGI': 0, 'SEDERHANA': 0, 'RENDAH': 0}
    for r in results:
        levels[r['risk_level']] += 1

    # Top sources (headwater + high C)
    top_sources = [r for r in results if r['source_type'] in ('Sumber Utama', 'Hulu')][:20]

    # Top accumulation points
    top_accumulation = [r for r in results if r['source_type'] == 'Titik Akumulasi'][:20]

    return {
        'segments': results,
        'summary': {
            'model_id': model,
            'model_name': available_runoff_models[model]['name'],
            'model_description': available_runoff_models[model]['description'],
            'available_models': [{'id': k, **v} for k, v in available_runoff_models.items()],
            'total': len(results),
            'avg_risk': round(np.mean(scores), 1) if scores else 0,
            'max_risk': round(max(scores), 1) if scores else 0,
            'min_risk': round(min(scores), 1) if scores else 0,
            'levels': levels,
            'total_headwater': sum(1 for r in results if r['is_headwater']),
            'avg_runoff_coefficient': round(np.mean([r['runoff_coefficient'] for r in results]), 3),
        },
        'top_sources': [{
            'segment_id': r['segment_id'],
            'name': r['name'],
            'center': r['center'],
            'runoff_coefficient': r['runoff_coefficient'],
            'dominant_land_use': r['dominant_land_use'],
            'runoff_risk': r['runoff_risk'],
            'source_type': r['source_type'],
        } for r in top_sources],
        'top_accumulation': [{
            'segment_id': r['segment_id'],
            'name': r['name'],
            'center': r['center'],
            'upstream_count': r['upstream_count'],
            'flow_volume': r['flow_volume'],
            'runoff_risk': r['runoff_risk'],
        } for r in top_accumulation],
    }


# ---- PDF Report Generation ----
@api.get("/export/pdf/{segment_id}")
def export_segment_pdf(segment_id: int):
    """Generate a PDF report for a river segment."""
    try:
        from reportlab.lib.pagesizes import A4
        from reportlab.lib import colors
        from reportlab.lib.units import mm
        from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
        from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    except ImportError:
        raise HTTPException(500, "reportlab belum dipasang. Jalankan: pip install reportlab")

    seg_data = None
    if enforcer:
        for seg in enforcer.enriched:
            if seg['segment_id'] == segment_id:
                sid = seg['segment_id']
                s, lvl, facts, rpt_s, ml_s, ml_c = get_blended_score(seg)
                geo = segment_geometries.get(sid, [])
                center = segment_wgs84_centers.get(sid) or seg.get('wgs84', [0, 0])
                land_use_list = seg.get('land_use', [])
                pipes = seg.get('nearby_pipes', [])
                cc = seg.get('community_center')
                seg_data = {
                    "id": sid, "name": segment_name_map.get(sid, f'Segmen {sid}'),
                    "center": center, "risk_score": s, "risk_level": lvl, "factors": facts,
                    "land_use_count": len(land_use_list), "pipe_count": len(pipes),
                    "land_use_types": sorted(set(lu['type'] for lu in land_use_list))[:5] if land_use_list else [],
                    "nearest_pipe": min(pipes, key=lambda p: p.get('distance_m', 9999)) if pipes else None,
                    "community_center": cc,
                }
                break
    if not seg_data:
        raise HTTPException(404, "Segmen tidak dijumpai")

    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, topMargin=20*mm, bottomMargin=20*mm)
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle('CustomTitle', parent=styles['Title'], fontSize=16, spaceAfter=12)
    elements = []

    elements.append(Paragraph("River Detective — Laporan Analisis Risiko", title_style))
    elements.append(Spacer(1, 8*mm))
    elements.append(Paragraph(f"<b>Segmen:</b> {seg_data['name']} (ID {seg_data['id']})", styles['Normal']))
    elements.append(Paragraph(f"<b>Pusat:</b> {seg_data['center'][0]:.5f}, {seg_data['center'][1]:.5f}", styles['Normal']))
    elements.append(Spacer(1, 4*mm))

    sev_colors = {'KRITIKAL': colors.black, 'TINGGI': colors.red, 'SEDERHANA': colors.orange, 'RENDAH': colors.green}
    level_text = f"<b>Tahap Risiko:</b> <font color='{sev_colors.get(seg_data['risk_level'], colors.black)}'>{seg_data['risk_level']}</font> ({seg_data['risk_score']:.1f}/100)"
    elements.append(Paragraph(level_text, styles['Normal']))
    elements.append(Spacer(1, 4*mm))

    if seg_data['factors']:
        elements.append(Paragraph(f"<b>Faktor Risiko:</b> {', '.join(seg_data['factors'])}", styles['Normal']))
    elements.append(Paragraph(f"<b>Guna Tanah:</b> {', '.join(seg_data['land_use_types'])}", styles['Normal']))
    elements.append(Paragraph(f"<b>Jumlah Guna Tanah:</b> {seg_data['land_use_count']}", styles['Normal']))
    elements.append(Paragraph(f"<b>Paip/Parit:</b> {seg_data['pipe_count']}", styles['Normal']))
    if seg_data['nearest_pipe']:
        p = seg_data['nearest_pipe']
        elements.append(Paragraph(f"<b>Paip Terdekat:</b> {p.get('type','')} {p.get('name','')} ({p.get('distance_m',0):.0f}m)", styles['Normal']))
    if seg_data['community_center']:
        cc = seg_data['community_center']
        elements.append(Paragraph(f"<b>Pusat Komuniti:</b> {cc.get('name','')} ({cc.get('distance_km',0):.3f}km)", styles['Normal']))

    elements.append(Spacer(1, 6*mm))
    elements.append(Paragraph(f"<b>Dihasilkan:</b> {datetime.now().strftime('%Y-%m-%d %H:%M')} oleh River Detective v4.0", styles['Normal']))

    doc.build(elements)
    buf.seek(0)
    filename = f"river_detective_seg_{segment_id}.pdf"
    return StreamingResponse(buf, media_type="application/pdf",
                             headers={"Content-Disposition": f"attachment; filename={filename}"})


# ---- Chatbot (Groq NL Query) ----
def _build_chatbot_system_context():
    counts = {"KRITIKAL": 0, "TINGGI": 0, "SEDERHANA": 0, "RENDAH": 0}
    top_segments = []
    total = 0
    avg_score = 0.0
    ml_mode = db_get_config('ml_model_mode', 'heuristic')
    if enforcer and enforcer.enriched:
        total = len(enforcer.enriched)
        batch_ml = batch_ml_scores(enforcer.enriched) if (ml_mode == 'ml' and _risk_model is not None) else [None] * total
        scores = []
        for i, seg in enumerate(enforcer.enriched):
            orig_score, orig_level, factors = score_segment(seg)
            ml_score, ml_level, _ = batch_ml[i] if i < len(batch_ml) and batch_ml[i] is not None else (None, None, None)
            s, lvl = (ml_score, ml_level) if ml_score is not None else (orig_score, orig_level)
            counts[lvl] = counts.get(lvl, 0) + 1
            scores.append(float(s))
            top_segments.append({
                "id": seg['segment_id'],
                "name": segment_name_map.get(seg['segment_id'], f"Segmen {seg['segment_id']}"),
                "risk_score": round(float(s), 1),
                "risk_level": lvl,
                "factors": factors[:4],
                "pipe_count": len(seg.get('nearby_pipes', [])),
                "land_use_count": len(seg.get('land_use', [])),
            })
        avg_score = round(float(np.mean(scores)), 2) if scores else 0.0
    top_segments.sort(key=lambda x: -x["risk_score"])
    report_stats = {"total": 0, "verified": 0, "pending": 0}
    try:
        conn = sqlite3.connect(_db_path)
        report_stats["total"] = conn.execute("SELECT COUNT(*) FROM reports").fetchone()[0]
        report_stats["verified"] = conn.execute("SELECT COUNT(*) FROM reports WHERE verified=1").fetchone()[0]
        report_stats["pending"] = conn.execute("SELECT COUNT(*) FROM reports WHERE verified=0").fetchone()[0]
        conn.close()
    except Exception:
        pass
    model_eval = {}
    try:
        ev = evaluate_models()
        model_eval = {
            "heuristic_r2_vs_ml": ev.get("heuristic", {}).get("r2_vs_ml"),
            "heuristic_rmse_vs_ml": ev.get("heuristic", {}).get("rmse_vs_ml"),
            "ml_asal": ev.get("ml_asal"),
            "custom": ev.get("ml_custom"),
        }
    except Exception:
        pass
    runoff_summary = {}
    try:
        ro = runoff_prediction('hybrid')
        runoff_summary = ro.get('summary', {})
        runoff_summary["top_sources"] = [{"id": r["segment_id"], "name": r["name"], "risk": r["runoff_risk"], "type": r["source_type"]} for r in ro.get('top_sources', [])[:5]]
    except Exception:
        pass
    return {
        "system": "River Detective MBIP Iskandar Puteri",
        "team": "EnviroMind | UTM",
        "members": ["NORLILA BINTI AMIN CHNG", "NG WEI FENG", "CHEK CHEE HIM"],
        "pages": ["Pusat Misi", "Peta Risiko", "Trend", "Laporan", "Sahkan", "Papan", "Data", "Model ML", "Profil"],
        "data_sources": ["376 segmen sungai", "guna tanah", "paip/parit", "komuniti", "laporan pengguna", "topologi sungai", "model risiko", "model larian permukaan"],
        "risk_summary": {"total_segments": total, "avg_score": avg_score, "counts": counts, "active_model_mode": ml_mode, "top_segments": top_segments[:10]},
        "reports": report_stats,
        "model_metrics": model_eval,
        "runoff": runoff_summary,
        "capabilities": [
            "Peta Risiko memaparkan skor risiko, faktor risiko, carian lokasi dan simulasi pencemaran.",
            "Trend memaparkan agregat sejarah risiko berdasarkan snapshot pangkalan data.",
            "Model ML melatih RandomForest daripada ciri drag-and-drop untuk risiko atau larian permukaan.",
            "Larian Permukaan menyokong model Hibrid, SCS-CN, Infrastruktur dan Custom jika dilatih.",
            "Chatbot boleh menerangkan hasil sistem, analisis, model, laporan, runoff, dan cara guna halaman.",
        ],
    }


class ChatbotRequest(BaseModel):
    message: str

@api.post("/chatbot")
def chatbot(req: ChatbotRequest):
    """Natural language query for river data."""
    msg = req.message.strip().lower()

    # Rule-based fast path for common queries
    if any(w in msg for w in ["berapa banyak", "berapa banyak segmen", "jumlah segmen", "how many segment"]):
        total = len(enforcer.enriched) if enforcer else 376
        return {"reply": f"Terdapat {total} segmen sungai dalam sistem River Detective.", "data": {"total_segments": total}}

    if any(w in msg for w in ["kritikal", "critical", "kritis"]):
        scored = []
        if enforcer:
            ml_mode = db_get_config('ml_model_mode', 'heuristic')
            batch_ml = batch_ml_scores(enforcer.enriched) if (ml_mode == 'ml' and _risk_model is not None) else [None] * len(enforcer.enriched)
            for i, seg in enumerate(enforcer.enriched):
                orig_score, orig_level, _ = score_segment(seg)
                ml_score, ml_level, _ = batch_ml[i] if i < len(batch_ml) and batch_ml[i] is not None else (None, None, None)
                s, lvl = (ml_score, ml_level) if ml_score is not None else (orig_score, orig_level)
                if lvl == 'KRITIKAL':
                    scored.append({"id": seg['segment_id'], "name": segment_name_map.get(seg['segment_id'], ""), "score": round(s, 1)})
        scored.sort(key=lambda x: -x['score'])
        return {"reply": f"Terdapat {len(scored)} segmen berisiko KRITIKAL. Berikut senarai:", "data": {"critical_segments": scored}}

    if any(w in msg for w in ["tinggi", "high risk"]):
        scored = []
        if enforcer:
            ml_mode = db_get_config('ml_model_mode', 'heuristic')
            batch_ml = batch_ml_scores(enforcer.enriched) if (ml_mode == 'ml' and _risk_model is not None) else [None] * len(enforcer.enriched)
            for i, seg in enumerate(enforcer.enriched):
                orig_score, orig_level, _ = score_segment(seg)
                ml_score, ml_level, _ = batch_ml[i] if i < len(batch_ml) and batch_ml[i] is not None else (None, None, None)
                s, lvl = (ml_score, ml_level) if ml_score is not None else (orig_score, orig_level)
                if lvl == 'TINGGI':
                    scored.append({"id": seg['segment_id'], "name": segment_name_map.get(seg['segment_id'], ""), "score": round(s, 1)})
        scored.sort(key=lambda x: -x['score'])
        return {"reply": f"Terdapat {len(scored)} segmen berisiko TINGGI.", "data": {"high_segments": scored}}

    if any(w in msg for w in ["industri", "industrial"]):
        matches = []
        if enforcer:
            ml_mode = db_get_config('ml_model_mode', 'heuristic')
            batch_ml = batch_ml_scores(enforcer.enriched) if (ml_mode == 'ml' and _risk_model is not None) else [None] * len(enforcer.enriched)
            for i, seg in enumerate(enforcer.enriched):
                lu_types = [lu.get('type', '') for lu in seg.get('land_use', [])]
                if any('industri' in t.lower() for t in lu_types):
                    orig_score, orig_level, _ = score_segment(seg)
                    ml_score, ml_level, _ = batch_ml[i] if i < len(batch_ml) and batch_ml[i] is not None else (None, None, None)
                    s, lvl = (ml_score, ml_level) if ml_score is not None else (orig_score, orig_level)
                    matches.append({"id": seg['segment_id'], "name": segment_name_map.get(seg['segment_id'], ""), "risk_level": lvl, "score": round(s, 1)})
        matches.sort(key=lambda x: -x['score'])
        return {"reply": f"Terdapat {len(matches)} segmen berdekatan kawasan industri.", "data": {"industrial_segments": matches}}

    if any(w in msg for w in ["paip", "pipe", "parit", "drain"]):
        matches = []
        if enforcer:
            for seg in enforcer.enriched:
                pipes = seg.get('nearby_pipes', [])
                if pipes:
                    matches.append({"id": seg['segment_id'], "name": segment_name_map.get(seg['segment_id'], ""), "pipe_count": len(pipes)})
        matches.sort(key=lambda x: -x['pipe_count'])
        top = matches[:10]
        return {"reply": f"Terdapat {len(matches)} segmen mempunyai paip/parit berdekatan. 10 teratas:", "data": {"pipe_segments": top}}

    if any(w in msg for w in ["sekolah", "school", "komuniti", "community", "pusat"]):
        matches = []
        if enforcer:
            for seg in enforcer.enriched:
                cc = seg.get('community_center')
                if cc:
                    matches.append({"id": seg['segment_id'], "name": segment_name_map.get(seg['segment_id'], ""), "community": cc.get('name', ''), "distance_km": cc.get('distance_km', 0)})
        matches.sort(key=lambda x: x['distance_km'])
        return {"reply": f"Terdapat {len(matches)} segmen berdekatan pusat komuniti. 10 terdekat:", "data": {"community_segments": matches[:10]}}

    if any(w in msg for w in ["rendah", "low risk", "selamat", "clean", "safe"]):
        count = 0
        if enforcer:
            ml_mode = db_get_config('ml_model_mode', 'heuristic')
            batch_ml = batch_ml_scores(enforcer.enriched) if (ml_mode == 'ml' and _risk_model is not None) else [None] * len(enforcer.enriched)
            for i, seg in enumerate(enforcer.enriched):
                orig_score, orig_level, _ = score_segment(seg)
                ml_score, ml_level, _ = batch_ml[i] if i < len(batch_ml) and batch_ml[i] is not None else (None, None, None)
                lvl = ml_level if ml_score is not None else orig_level
                if lvl == 'RENDAH':
                    count += 1
        return {"reply": f"Terdapat {count} segmen berisiko RENDAH (selamat).", "data": {"rendah_count": count}}

    if any(w in msg for w in ["terima kasih", "thanks", "thank you", "terima kasih"]):
        return {"reply": "Sama-sama! River Detective sentiasa membantu melindungi sungai kita. 🌊", "data": None}

    if any(w in msg for w in ["team", "pasukan", "ahli", "enviromind", "utm"]):
        return {"reply": "Sistem ini dibangunkan oleh EnviroMind | UTM: NORLILA BINTI AMIN CHNG, NG WEI FENG, dan CHEK CHEE HIM.", "data": None}

    if any(w in msg for w in ["siapa", "who", "apa itu", "what is", "about river detective"]):
        return {"reply": "River Detective ialah sistem pengesanan pencemaran sungai bersepadu untuk MBIP (Iskandar Puteri). Ia mengintegrasikan 11 sumber data ArcGIS, model ML, dan laporan komuniti.", "data": None}

    if any(w in msg for w in ["bantuan", "help", "boleh buat apa", "what can you"]):
        return {"reply": "Saya boleh membantu tentang hasil Peta Risiko, Trend, laporan komuniti, Model ML, simulasi pencemaran, Larian Permukaan, metrik model, dan cara guna sistem. Contoh: 'segmen paling berisiko', 'terangkan model runoff', atau 'bagaimana train model custom'.", "data": None}

    if any(w in msg for w in ["runoff", "larian", "permukaan", "air hujan"]):
        try:
            ro = runoff_prediction('hybrid')
            s = ro.get('summary', {})
            top = ro.get('top_sources', [])[:3]
            names = ', '.join([f"#{x['segment_id']} {x['name']} ({x['runoff_risk']})" for x in top])
            return {"reply": f"Larian Permukaan menggunakan model {s.get('model_name')} dengan purata risiko {s.get('avg_risk')}. Model tersedia termasuk Hibrid, SCS-CN, Infrastruktur dan Custom selepas dilatih. Sumber utama teratas: {names}.", "data": {"runoff_summary": s, "top_sources": top}}
        except Exception:
            return {"reply": "Model Larian Permukaan menilai potensi air larian daripada guna tanah, paip/parit, kecerunan proksi dan akumulasi aliran hulu.", "data": None}

    # Fallback to Groq AI for complex queries
    if GROQ_API_KEY:
        try:
            from groq import Groq
            client = Groq(api_key=GROQ_API_KEY, timeout=10.0)
            context = _build_chatbot_system_context()
            prompt = f"""Anda ialah River Detective AI untuk MBIP, Johor. Anda mempunyai akses kepada ringkasan live sistem di bawah dan mesti menjawab berdasarkan data ini, bukan secara umum.

KONTEKS SISTEM JSON:
{json.dumps(context, ensure_ascii=False)[:9000]}

Soalan pengguna: {req.message}

Arahan jawapan:
- Jawab dalam Bahasa Melayu.
- Jika soalan meminta nombor/senarai, gunakan angka sebenar daripada konteks.
- Jika data tidak mencukupi, nyatakan had data secara jelas dan cadangkan tab paling sesuai.
- Ringkas tetapi berguna; maksimum 5 ayat kecuali pengguna minta perincian.
"""
            resp = client.chat.completions.create(
                model="llama-3.3-70b-versatile",
                messages=[{"role": "user", "content": prompt}],
                max_tokens=450, temperature=0.2,
            )
            return {"reply": resp.choices[0].message.content.strip(), "data": None}
        except Exception:
            pass

    return {"reply": "Maaf, saya tidak pasti apa yang anda maksudkan. Cuba tanya tentang:\n• Jumlah segmen sungai\n• Segmen berisiko tinggi\n• Kawasan industri\n• Paip/parit\n• Pusat komuniti", "data": None}


# ====== Mount API router + Frontend ======
app.include_router(api)
app.mount("/uploads", StaticFiles(directory=_uploads_dir), name="uploads")


def _frontend_file(path, media_type=None):
    headers = {
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        "Pragma": "no-cache",
        "Expires": "0",
    }
    return FileResponse(path, media_type=media_type, headers=headers)


@app.get("/")
def serve_root():
    """Serve the SPA entry point."""
    idx = os.path.join(_frontend_dir, "index.html")
    if os.path.isfile(idx):
        return _frontend_file(idx, media_type="text/html")
    return {"error": "Frontend not built"}


@app.head("/")
def serve_root_head():
    """Render health checks use HEAD /. Return OK without loading the SPA body."""
    return Response(status_code=200, headers={
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        "Pragma": "no-cache",
        "Expires": "0",
    })


@app.get("/{path:path}")
def serve_frontend(path: str):
    """Serve static assets or SPA fallback."""
    # Block API-like paths from getting SPA fallback
    if path.startswith("api/"):
        raise HTTPException(404, "Not found")
    if path == "logo.png":
        logo_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "logo.png"))
        if os.path.isfile(logo_path):
            return _frontend_file(logo_path)
    fp = os.path.join(_frontend_dir, path)
    if os.path.isfile(fp):
        return _frontend_file(fp)
    # SPA fallback
    idx = os.path.join(_frontend_dir, "index.html")
    if os.path.isfile(idx):
        return _frontend_file(idx, media_type="text/html")
    raise HTTPException(404, "Not found")


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
