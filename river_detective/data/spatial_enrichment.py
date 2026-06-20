"""Spatial enrichment: links ALL datasets to river network for pollution system."""
import json, os, sys
import numpy as np
import pandas as pd
from scipy.spatial import cKDTree

DATA_DIR = "arcgis_csv_data"


def parse_shape(shape_val):
    if shape_val is None or (isinstance(shape_val, float) and np.isnan(shape_val)):
        return None, None
    if isinstance(shape_val, str):
        d = json.loads(shape_val.replace("'", '"'))
    elif isinstance(shape_val, dict):
        d = shape_val
    else:
        return None, None
    if "paths" in d and d["paths"]:
        return np.array(d["paths"][0]), "line"
    if "rings" in d and d["rings"]:
        return np.array(d["rings"][0]), "polygon"
    if "x" in d and d["x"] is not None:
        return np.array([[d["x"], d["y"]]]), "point"
    return None, None


def centroid(coords):
    if coords is None or len(coords) == 0:
        return None
    return coords.mean(axis=0)


class RiverEnrichment:
    def __init__(self):
        self.river_segs = []
        self.river_tree = None

        self.landuse_data = []
        self.landuse_tree = None

        self.pipe_data = []
        self.pipe_tree = None

        self.jurisdiction_data = []
        self.population_data = []
        self.community_data = []
        self.community_tree = None
        self.tree_data = []
        self.parcel_data = []
        self.housing_data = []

    def load_sungai(self):
        """Load river segments with geometry."""
        df = pd.read_csv(f"{DATA_DIR}/AlamSekitar_Sungai_SUNGAI.csv")
        for _, r in df.iterrows():
            coords, kind = parse_shape(r["SHAPE"])
            if coords is not None:
                self.river_segs.append({
                    "id": int(r["FID"]),
                    "name": r.get("nama", ""),
                    "coords": coords,
                    "centroid": centroid(coords),
                    "length": r.get("Shape__Length", 0),
                })
        cents = np.array([s["centroid"] for s in self.river_segs if s["centroid"] is not None])
        self.river_tree = cKDTree(cents)
        print(f"  Sungai: {len(self.river_segs)} segen")

    def load_landuse(self, sample_ratio=0.1):
        """Load land use parcels, sample for performance."""
        df = pd.read_csv(f"{DATA_DIR}/Gunatanah_Semasa_G2013022402.csv",
                         usecols=["FID", "gtn1", "gtn2", "gtn3", "nama", "SHAPE"])
        sampled = df.sample(frac=sample_ratio, random_state=42) if sample_ratio < 1 else df
        for _, r in sampled.iterrows():
            coords, kind = parse_shape(r["SHAPE"])
            if coords is not None:
                c = centroid(coords)
                if c is not None:
                    self.landuse_data.append({
                        "type": str(r.get("gtn1", "")),
                        "subtype": str(r.get("gtn2", "")),
                        "name": str(r.get("nama", "")),
                        "centroid": c,
                        "coords": coords,
                    })
        cents = np.array([d["centroid"] for d in self.landuse_data])
        self.landuse_tree = cKDTree(cents)
        print(f"  Gunatanah: {len(self.landuse_data)} sampel")

    def landuse_label(self, code):
        labels = {
            "1": "Pertanian", "2": "Perindustrian", "3": "Perumahan",
            "4": "Perniagaan", "5": "Infrastruktur", "6": "Tanah Kosong",
            "7": "Perairan", "8": "Hutan", "9": "Perkhidmatan",
        }
        return labels.get(code.strip(), f"Lain-lain ({code})")

    def load_pipes(self):
        """Load discharge pipes that can carry pollution into rivers."""
        pipe_files = [
            ("Utiliti_PaipPembentungan_BETUNG1.csv", "Paip Kumbahan"),
            ("Utiliti_Parit_PARIT1.csv", "Parit"),
            ("Utiliti_PaipAirUtama_BKLAIR1.csv", "Paip Air"),
        ]
        for fname, label in pipe_files:
            path = f"{DATA_DIR}/{fname}"
            if not os.path.exists(path):
                continue
            df = pd.read_csv(path)
            for _, r in df.iterrows():
                coords, kind = parse_shape(r["SHAPE"])
                if coords is not None:
                    c = centroid(coords)
                    if c is not None:
                        self.pipe_data.append({
                            "type": label,
                            "jenis": str(r.get("jenis", "")),
                            "status": str(r.get("status", "")),
                            "name": str(r.get("nama", "")),
                            "centroid": c,
                            "coords": coords,
                        })
        if self.pipe_data:
            cents = np.array([p["centroid"] for p in self.pipe_data])
            self.pipe_tree = cKDTree(cents)
        print(f"  Paip/Parit: {len(self.pipe_data)} titik")

    def load_jurisdiction(self):
        """Load police stations and administrative boundaries."""
        df = pd.read_csv(f"{DATA_DIR}/Sempadan_BalaiPolis_mbip.sde.Sempadan_Balai_Polis.csv")
        for _, r in df.iterrows():
            coords, kind = parse_shape(r["SHAPE"])
            if coords is not None:
                c = centroid(coords)
                if c is not None:
                    self.jurisdiction_data.append({
                        "name": str(r.get("nama_balai", "")),
                        "ipd": str(r.get("ipd", "")),
                        "mukim": str(r.get("mukim", "")),
                        "centroid": c,
                        "type": "Balai Polis",
                    })
        print(f"  Balai Polis: {len(self.jurisdiction_data)}")

    def load_population(self):
        """Load population data zones."""
        df = pd.read_csv(f"{DATA_DIR}/Taburan_Penduduk2024_PDDK_2024.csv")
        for _, r in df.iterrows():
            coords, kind = parse_shape(r["SHAPE"])
            if coords is not None:
                c = centroid(coords)
                if c is not None:
                    self.population_data.append({
                        "name": str(r.get("nama", "")),
                        "pop2024": float(r.get("pdk_2024", 0)),
                        "density": float(r.get("kpdt", 0)),
                        "centroid": c,
                    })
        print(f"  Zon Penduduk: {len(self.population_data)}")

    def load_community(self):
        """Load community centers."""
        df = pd.read_csv(f"{DATA_DIR}/Sosial_KMasyarakat_KMYARAKAT.csv")
        for _, r in df.iterrows():
            coords, kind = parse_shape(r["SHAPE"])
            if coords is not None:
                c = centroid(coords)
                if c is not None:
                    self.community_data.append({
                        "name": str(r.get("nama", "")),
                        "jenis": str(r.get("jenis", "")),
                        "centroid": c,
                    })
        if self.community_data:
            cents = np.array([c["centroid"] for c in self.community_data])
            self.community_tree = cKDTree(cents)
        print(f"  Komuniti: {len(self.community_data)}")

    def load_housing(self):
        """Load housing data (sampled)."""
        df = pd.read_csv(f"{DATA_DIR}/Sosial_JenisPerumahan_PERUMAHAN.csv",
                         usecols=["FID", "nama", "jenis", "unit", "SHAPE"])
        sampled = df.sample(frac=0.05, random_state=42)
        for _, r in sampled.iterrows():
            coords, kind = parse_shape(r["SHAPE"])
            if coords is not None:
                c = centroid(coords)
                if c is not None:
                    self.housing_data.append({
                        "nama": str(r.get("nama", "")),
                        "jenis": str(r.get("jenis", "")),
                        "unit": float(r.get("unit", 0)) if pd.notna(r.get("unit")) else 0,
                        "centroid": c,
                    })
        print(f"  Perumahan: {len(self.housing_data)} sampel")

    def load_trees(self):
        """Load tree inventory for IMELC reforestation."""
        def safe_float(val, default=0.0):
            if pd.isna(val):
                return default
            try:
                return float(str(val).split("*")[0].split("x")[0].strip())
            except:
                return default
        df = pd.read_csv(f"{DATA_DIR}/Inventori_Pokok_Pokok.csv",
                         usecols=["FID", "tree_tag", "total_heig", "crown_widt", "SHAPE"])
        sampled = df.sample(frac=0.1, random_state=42)
        for _, r in sampled.iterrows():
            coords, kind = parse_shape(r["SHAPE"])
            if coords is not None:
                c = centroid(coords)
                if c is not None:
                    self.tree_data.append({
                        "tag": str(r.get("tree_tag", "")),
                        "height": safe_float(r.get("total_heig")),
                        "crown": safe_float(r.get("crown_widt")),
                        "centroid": c,
                    })
        print(f"  Pokok: {len(self.tree_data)} sampel")

    def load_all(self):
        print("Loading spatial data...")
        self.load_sungai()
        self.load_landuse(sample_ratio=0.5)
        self.load_pipes()
        self.load_jurisdiction()
        self.load_population()
        self.load_community()
        self.load_housing()
        self.load_trees()
        print("Load complete.")

    def enrich_segment(self, seg_idx, radius=300):
        """Get all enrichment data near a river segment."""
        seg = self.river_segs[seg_idx]
        c = seg["centroid"]
        if c is None:
            return seg

        enrich = {
            "segment_id": seg["id"],
            "segment_name": seg["name"],
            "segment_center": c.tolist(),
        }

        # Nearest land use
        if self.landuse_tree is not None:
            dists, idxs = self.landuse_tree.query(c.reshape(1, -1), k=5)
            nearby_landuse = []
            for d, idx in zip(dists[0], idxs[0]):
                if d < radius:
                    lu = self.landuse_data[idx]
                    nearby_landuse.append({
                        "type": self.landuse_label(lu["type"]),
                        "distance_m": float(d),
                    })
            enrich["land_use"] = nearby_landuse[:3]

        # Nearest pipes
        if self.pipe_tree is not None:
            dists, idxs = self.pipe_tree.query(c.reshape(1, -1), k=3)
            nearby_pipes = []
            for d, idx in zip(dists[0], idxs[0]):
                if d < radius:
                    p = self.pipe_data[idx]
                    nearby_pipes.append({
                        "type": p["type"],
                        "name": p["name"],
                        "distance_m": float(d),
                    })
            enrich["nearby_pipes"] = nearby_pipes

        # Nearest police station
        if self.jurisdiction_data:
            j_cents = np.array([j["centroid"] for j in self.jurisdiction_data])
            j_tree = cKDTree(j_cents)
            dist, idx = j_tree.query(c)
            if dist < radius * 5:
                j = self.jurisdiction_data[idx]
                enrich["jurisdiction"] = {
                    "police_station": j["name"],
                    "ipd": j["ipd"],
                    "mukim": j["mukim"],
                    "distance_km": float(dist / 1000),
                }

        # Nearest population zone
        if self.population_data:
            p_cents = np.array([p["centroid"] for p in self.population_data])
            p_tree = cKDTree(p_cents)
            dist, idx = p_tree.query(c)
            if dist < radius * 3:
                p = self.population_data[idx]
                enrich["population_zone"] = {
                    "name": p["name"],
                    "population": int(p["pop2024"]),
                    "density_km2": float(p["density"]),
                    "distance_km": float(dist / 1000),
                }

        # Nearest community center
        if self.community_tree is not None:
            dist, idx = self.community_tree.query(c)
            if dist < radius * 3:
                cc = self.community_data[idx]
                enrich["community_center"] = {
                    "name": cc["name"],
                    "distance_km": float(dist / 1000),
                }

        return enrich

    def enrich_all_segments(self, radius=300):
        """Enrich all river segments."""
        enriched = []
        for i in range(len(self.river_segs)):
            enriched.append(self.enrich_segment(i, radius))
        return enriched


if __name__ == "__main__":
    enrichment = RiverEnrichment()
    enrichment.load_all()
    enriched = enrichment.enrich_all_segments(radius=300)
    import pickle, json
    os.makedirs("river_detective/data/cache", exist_ok=True)
    with open("river_detective/data/cache/enriched.pkl", "wb") as f:
        pickle.dump(enriched, f)
    with open("river_detective/data/cache/enriched.json", "w") as f:
        json.dump(enriched, f, indent=2, default=str)
    print(f"\nSaved {len(enriched)} enriched segments to cache.")
    print("\n--- Sample: segment 0 ---")
    print(json.dumps(enriched[0], indent=2, default=str))
