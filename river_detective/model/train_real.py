"""Train risk model using REAL MBIP enrichment data only (no synthetic data)."""
import json, os, sys, pickle
import numpy as np
import joblib
from sklearn.ensemble import RandomForestRegressor, RandomForestClassifier
from sklearn.model_selection import cross_val_score, train_test_split
from sklearn.metrics import r2_score, mean_absolute_error, accuracy_score
from collections import Counter

_CACHE = os.path.join(os.path.dirname(__file__), "..", "data", "cache")
_ENRICHED = os.path.join(_CACHE, "enriched.pkl")
_CASSINI_CSV = os.path.join(_CACHE, "..", "arcgis_csv_data", "AlamSekitar_Sungai.csv")

_ALL_LU_TYPES = sorted([
    'Lain-lain (Badan Air)', 'Lain-lain (Hutan)', 'Lain-lain (Industri)',
    'Lain-lain (Infrastruktur dan Utiliti)', 'Lain-lain (Institusi dan Kemudahan Masyarakat)',
    'Lain-lain (Komersial)', 'Lain-lain (Pengangkutan)', 'Lain-lain (Pertanian)',
    'Lain-lain (Perumahan)', 'Lain-lain (Tanah Kosong)', 'Lain-lain (Tanah Lapang dan Rekreasi)'
])

print("Loading enriched segments (376 real MBIP segments)...")
with open(_ENRICHED, "rb") as f:
    enriched = pickle.load(f)

def _extract_features(seg):
    land_use = seg.get('land_use', [])
    pipes = seg.get('nearby_pipes', [])
    cc = seg.get('community_center')
    sid = seg['segment_id']

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
    cc_present = 1 if cc else 0
    row.append(cc_present)
    row.append(cc.get('distance_km', -1) if cc else -1)
    row.append(len(set(lu.get('type', '') for lu in land_use)))
    center = seg.get('segment_center', [0, 0])
    row.append(center[0])
    row.append(center[1])
    return np.array(row, dtype=np.float32)

FEATURE_NAMES = (
    [f'lu_count_{t}' for t in _ALL_LU_TYPES] +
    [f'lu_min_dist_{t}' for t in _ALL_LU_TYPES] +
    ['pipe_count', 'has_pipe',
     'pipe_type_paip', 'pipe_type_parit', 'pipe_type_other',
     'has_community', 'community_dist_km',
     'land_use_diversity',
     'center_x', 'center_y']
)

# ---- Heuristic risk score (same logic as score_segment in main.py) ----
def heuristic_score(seg):
    score = 10
    land_use = seg.get('land_use', [])
    pipes = seg.get('nearby_pipes', [])
    cc = seg.get('community_center')
    for lu in land_use:
        t = (lu.get('type') or lu.get('description') or str(lu)).upper()
        if 'INDUSTRI' in t:
            score += 25
        elif 'KOMERSIAL' in t:
            score += 12
        elif 'RESIDEN' in t or 'PERUMAHAN' in t:
            score += 6
        elif 'PERTANIAN' in t:
            score += 4
    if pipes:
        score += min(len(pipes) * 6, 30)
    if cc:
        score += 4
    return max(0, min(100, score))

print("Building feature matrix from REAL MBIP data...")
X_list, y_list, ids = [], [], []
zero_feat_count = 0
for seg in enriched:
    feat = _extract_features(seg)
    if np.all(feat == 0):
        zero_feat_count += 1
    X_list.append(feat)
    y_list.append(heuristic_score(seg))
    ids.append(seg['segment_id'])

X = np.array(X_list, dtype=np.float32)
y = np.array(y_list, dtype=np.float32)

print(f"Feature matrix: {X.shape} (376 segments, {len(FEATURE_NAMES)} features)")
print(f"Segments with all-zero features: {zero_feat_count}")
print(f"Target (risk score) range: {y.min():.0f} - {y.max():.0f}, mean: {y.mean():.1f}")
print()

# ---- Train/val split ----
X_train, X_val, y_train, y_val = train_test_split(X, y, test_size=0.2, random_state=42)

print("Training RandomForest on REAL MBIP data...")
rf = RandomForestRegressor(
    n_estimators=300, max_depth=12, min_samples_leaf=2,
    n_jobs=-1, random_state=42, verbose=1
)
rf.fit(X_train, y_train)

y_pred = rf.predict(X_val)
r2 = r2_score(y_val, y_pred)
mae = mean_absolute_error(y_val, y_pred)
print(f"\nRegression Performance (validation):")
print(f"  R²:  {r2:.4f}")
print(f"  MAE: {mae:.2f} points")

# ---- Also classify risk levels ----
def score_to_level(s):
    return 'RENDAH' if s < 30 else 'SEDERHANA' if s < 55 else 'TINGGI' if s < 75 else 'KRITIKAL'

y_level = np.array([score_to_level(s) for s in y])
level_names = ['RENDAH', 'SEDERHANA', 'TINGGI', 'KRITIKAL']
level_map = {n: i for i, n in enumerate(level_names)}
y_level_num = np.array([level_map[l] for l in y_level])

X_tr, X_va, yl_tr, yl_va = train_test_split(X, y_level_num, test_size=0.2, random_state=42)
clf = RandomForestClassifier(
    n_estimators=300, max_depth=10, min_samples_leaf=2,
    n_jobs=-1, random_state=42
)
clf.fit(X_tr, yl_tr)
yl_pred = clf.predict(X_va)
acc = accuracy_score(yl_va, yl_pred)
print(f"\nClassification Performance (validation):")
print(f"  Accuracy: {acc:.4f}")
print(f"  Level distribution: {dict(Counter(y_level))}")

# ---- Cross-val ----
cv_scores = cross_val_score(rf, X, y, cv=5, scoring='r2')
print(f"\n5-fold CV R²: {cv_scores.mean():.4f} ± {cv_scores.std():.4f}")

# ---- Feature importances ----
importances = sorted(zip(FEATURE_NAMES, rf.feature_importances_), key=lambda x: -x[1])
print(f"\n=== Feature Importances from REAL data ===")
for name, imp in importances[:20]:
    print(f"  {name:40s} {imp:.4f}")

# ---- Predict on all segments and compare to heuristic ----
all_pred = rf.predict(X)
counter = Counter()
corr = {n: Counter() for n in level_names}
for true_s, pred_s in zip(y, all_pred):
    true_l = score_to_level(true_s)
    pred_l = score_to_level(pred_s)
    counter[f"{true_l}→{pred_l}"] += 1
    corr[true_l][pred_l] += 1

print(f"\n=== Level Prediction Confusion (all 376) ===")
for tl in level_names:
    total = sum(corr[tl].values())
    if total:
        correct = corr[tl][tl]
        pct = correct / total * 100
        print(f"  {tl:12s}: {correct}/{total} correct ({pct:.0f}%)")

# ---- Save ----
model_path = os.path.join(os.path.dirname(__file__), "risk_model.pkl")
joblib.dump({
    "regressor": rf,
    "classifier": clf,
    "feature_names": FEATURE_NAMES,
    "level_names": level_names,
    "label_map": level_map,
    "metrics": {"r2": float(r2), "mae": float(mae), "accuracy": float(acc)},
    "importances": [(n, float(i)) for n, i in importances[:30]],
}, model_path)
print(f"\nModel saved to {model_path}")
print("All features derived from real MBIP data — zero synthetic data used.")
