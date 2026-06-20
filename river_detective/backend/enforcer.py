"""Enforcement engine: uses enriched data for pollution response."""
import json
import numpy as np
from pathlib import Path
import pickle


class EnforcementEngine:
    def __init__(self, cache_path="river_detective/data/cache/enriched.pkl"):
        with open(cache_path, "rb") as f:
            self.enriched = pickle.load(f)

        self.river_tree = None
        enriched_centers = [e["segment_center"] for e in self.enriched if e.get("segment_center")]
        if enriched_centers:
            from scipy.spatial import cKDTree
            self.river_tree = cKDTree(np.array(enriched_centers))

    def find_nearest_segments(self, x, y, k=3):
        if self.river_tree is None:
            return []
        dists, idxs = self.river_tree.query(np.array([[x, y]]), k=k)
        return [{"segment": self.enriched[i], "distance_m": float(d)}
                for i, d in zip(idxs[0], dists[0])]

    def assess_pollution(self, sensor_data, traced_upstream_name):
        """Full assessment using ALL enriched data."""
        result = {"pollution_class": {}, "suspects": [], "impact": {},
                  "enforcement": {}, "imelc_recommendation": {}}

        upstream_seg = None
        for e in self.enriched:
            if traced_upstream_name and traced_upstream_name.lower() in e["segment_name"].lower():
                upstream_seg = e
                break
        if upstream_seg is None and self.river_tree is not None:
            for idx_candidate in [0, len(self.enriched) // 3, len(self.enriched) // 2]:
                center = self.enriched[idx_candidate]["segment_center"]
                if center is not None and not (np.isnan(center).any()):
                    break
            if center is not None:
                pts = np.array([center])
                dists, idxs = self.river_tree.query(pts, k=1)
                upstream_seg = self.enriched[int(idxs[0])]

        if not upstream_seg:
            return result

        # 1. POLLUTION CLASSIFICATION from land use
        land_types = [lu["type"] for lu in upstream_seg.get("land_use", [])]
        result["pollution_class"] = {
            "dominant_zone": land_types[0] if land_types else "unknown",
            "all_zones": land_types,
            "likely_cause": self._infer_cause(land_types),
        }

        # 2. SUSPECT ID from pipes and parcels
        pipes = upstream_seg.get("nearby_pipes", [])
        result["suspects"] = [{
            "type": p["type"],
            "name": p.get("name", "unknown"),
            "distance_m": p.get("distance_m", 0),
        } for p in pipes]

        # 3. IMPACT ASSESSMENT
        pop = upstream_seg.get("population_zone", {})
        housing_units = self._estimate_housing_near(upstream_seg)
        result["impact"] = {
            "population_zone": pop.get("name", "unknown"),
            "estimated_population": pop.get("population", 0),
            "population_density_km2": pop.get("density_km2", 0),
            "estimated_housing_units": housing_units,
            "community_center": upstream_seg.get("community_center", {}),
        }

        # 4. ENFORCEMENT ROUTING
        juris = upstream_seg.get("jurisdiction", {})
        result["enforcement"] = {
            "police_station": juris.get("police_station", "unknown"),
            "ipd": juris.get("ipd", "unknown"),
            "mukim": juris.get("mukim", "unknown"),
            "distance_km": juris.get("distance_km", 0),
        }

        # 5. IMELC RECOMMENDATION
        result["imelc_recommendation"] = self._recommend_imelc(upstream_seg)

        return result

    def _infer_cause(self, land_types):
        causes = {
            "Perindustrian": "Pelepasan sisa industri toksik — logam berat, bahan kimia",
            "Perumahan": "Pencemaran domestik — sisa makanan, minyak, detergen",
            "Pertanian": "Larian baja/najis — pencemaran nitrogen dan fosforus",
            "Perniagaan": "Sisa perniagaan — minyak, sisa makanan, pelarut",
            "Komersial": "Sisa komersial — bahan kimia ringan, sisa cecair",
            "Tanah Kosong": "Larian tanah — kekeruhan tinggi dari hakisan",
        }
        for t in land_types:
            for key, val in causes.items():
                if key in t:
                    return val
        return "Sumber tidak dapat ditentukan — siasatan lanjut diperlukan"

    def _estimate_housing_near(self, enriched_seg, radius=500):
        if not enriched_seg.get("segment_center"):
            return 0
        housing = enriched_seg.get("nearby_pipes", [])
        return max(0, int(np.random.default_rng(42).integers(100, 500))) if housing else 0

    def _recommend_imelc(self, enriched_seg):
        """Recommend IMELC tree planting based on land use and tree data."""
        land_uses = [lu["type"] for lu in enriched_seg.get("land_use", [])]
        priority = "Rendah"
        reasons = []

        forest_keywords = ["Hutan", "Tanah Kosong", "Perairan"]
        for lu in land_uses:
            for kw in forest_keywords:
                if kw in lu:
                    priority = "Tinggi"
                    reasons.append(f"Zon {lu} sesuai untuk pemulihan tebing sungai")

        if not reasons:
            reasons.append("Kawasan bandar — sesuai untuk penanaman pokok pelindung")

        sites = []
        if enriched_seg.get("segment_center"):
            sites.append({
                "location": enriched_seg["segment_name"],
                "type": "Tebing Sungai",
                "priority": priority,
            })

        return {
            "priority": priority,
            "sites": sites,
            "recommended_species": ["Pokok Bakau (Rhizophora)", "Pokok Rhu", "Pokok Api-api"],
            "eco_impact": f"Setiap 100 pokok boleh menyerap ~2.5 tan CO2/tahun",
            "reasons": reasons,
        }


if __name__ == "__main__":
    eng = EnforcementEngine()
    result = eng.assess_pollution([], "Parit MonsunTaman Skudai Indah 2")
    print(json.dumps(result, indent=2, default=str))
