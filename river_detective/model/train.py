"""Train the pollution source tracing model."""
import numpy as np
import joblib
from sklearn.ensemble import RandomForestRegressor
from sklearn.model_selection import train_test_split
from sklearn.metrics import r2_score, mean_absolute_error
from pollution_transport import PollutionTransport, generate_training_data

print("Initializing river transport model...")
transport = PollutionTransport(river_len_km=30, n_segments=120, 流速_ms=0.4)

print("Generating training data (5000 samples)...")
X, y = generate_training_data(transport, n_samples=5000, n_sensors=10)

X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

print(f"Training RandomForest on {len(X_train)} samples...")
model = RandomForestRegressor(
    n_estimators=200, max_depth=20, min_samples_leaf=2,
    n_jobs=-1, random_state=42, verbose=1
)
model.fit(X_train, y_train)

y_pred = model.predict(X_test)
r2 = r2_score(y_test, y_pred)
mae = mean_absolute_error(y_test, y_pred)

print(f"\nModel Performance:")
print(f"  R² Score:  {r2:.4f}")
print(f"  MAE:       {mae:.4f} (fraction of river)")
print(f"  MAE (m):   {mae * transport.L:.0f} m")

joblib.dump({"model": model, "transport": transport, "r2": r2, "mae": mae},
             "source_tracer.pkl")
print("\nModel saved to source_tracer.pkl")
