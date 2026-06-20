Projection Tuner

Use this small helper to view and adjust the Cassini projection parameters used by the backend.

GET current config:
  curl http://127.0.0.1:8010/api/proj

Update config (example):
  curl -X POST -H "Content-Type: application/json" -d '{"lat_0":2.054, "lon_0":103.582, "x_0":0, "y_0":0}' http://127.0.0.1:8010/api/proj

After updating, the server will rebuild segment geometries and risk scores using the new projection.

Workflow recommendation:
- Open the frontend map and keep it visible.
- Make small changes to lat_0 / lon_0 (±0.002 deg ~ ±200m) until the polylines align.
- If needed, adjust x_0/y_0 in meters for fine translation.
