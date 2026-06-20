import json
import numpy as np
import pandas as pd

def parse_shape(shape_str):
    if isinstance(shape_str, str):
        d = json.loads(shape_str.replace("'", '"'))
    else:
        d = shape_str
    paths = d.get("paths", [])
    if paths:
        return np.array(paths[0])
    pt = d.get("x"), d.get("y")
    return np.array([pt])

def build_river_network(river_csv, station_csv):
    rivers = pd.read_csv(river_csv)
    stations = pd.read_csv(station_csv)

    segments = []
    for _, row in rivers.iterrows():
        coords = parse_shape(row["SHAPE"])
        segments.append({
            "id": int(row["FID"]),
            "name": row.get("nama", ""),
            "coords": coords,
            "length": row.get("Shape__Length", 0),
        })

    sensor_nodes = []
    for _, row in stations.iterrows():
        coords = parse_shape(row["SHAPE"])
        sensor_nodes.append({
            "id": int(row["FID"]),
            "name": row.get("stesen", ""),
            "reading": row.get("bacaan", 0),
            "coords": coords.flatten() if coords.ndim > 1 else coords,
        })

    return segments, sensor_nodes

def compute_flow_graph(segments):
    edges = []
    for seg in segments:
        pts = seg["coords"]
        if len(pts) < 2:
            continue
        start = pts[0]
        end = pts[-1]
        seg_len = seg["length"]
        edges.append({
            "from": (float(start[0]), float(start[1])),
            "to": (float(end[0]), float(end[1])),
            "length": seg_len,
            "name": seg["name"],
        })
    return edges

def discretize_river(segments, resolution=50):
    points = []
    for seg in segments:
        pts = seg["coords"]
        if len(pts) < 2:
            continue
        for i in range(len(pts) - 1):
            a, b = pts[i], pts[i + 1]
            dist = np.linalg.norm(b - a)
            n = max(1, int(dist / resolution))
            for j in range(n + 1):
                t = j / n
                p = a + t * (b - a)
                points.append({"x": p[0], "y": p[1], "seg_id": seg["id"]})
    return points

if __name__ == "__main__":
    base = "arcgis_csv_data"
    segs, sensors = build_river_network(
        f"{base}/AlamSekitar_Sungai_SUNGAI.csv",
        f"{base}/AlamSekitar_StesenAir_AIR.csv",
    )
    print(f"River segments: {len(segs)}")
    print(f"Sensor stations: {len(sensors)}")
    edges = compute_flow_graph(segs)
    print(f"Flow edges: {len(edges)}")
    pts = discretize_river(segs)
    print(f"Discretized points: {len(pts)}")
