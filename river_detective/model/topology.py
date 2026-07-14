"""River topology graph builder — connects segments by proximity."""
import numpy as np
from scipy.spatial import cKDTree
from collections import defaultdict, deque


class RiverTopology:
    """Builds a directed graph of river segments from their endpoint geometry."""

    def __init__(self, segment_geometries, segment_wgs84_centers, segment_name_map, threshold_m=0.0005):
        """
        Args:
            segment_geometries: {sid: [[[lat, lon], ...], ...]}  (WGS84 paths)
            segment_wgs84_centers: {sid: (lat, lon)}
            segment_name_map: {sid: name}
            threshold_m: max distance in degrees (~50m) to consider endpoints connected
        """
        self.segment_geometries = segment_geometries
        self.segment_wgs84_centers = segment_wgs84_centers
        self.segment_name_map = segment_name_map
        self.threshold = threshold_m
        self.adjacency = defaultdict(list)   # sid -> [(neighbor_sid, direction)]
        self.upstream = defaultdict(list)    # sid -> [upstream_sids]
        self.downstream = defaultdict(list)  # sid -> [downstream_sids]
        self._build()

    def _get_endpoints(self, sid):
        """Get first and last point of the segment's primary path."""
        geo = self.segment_geometries.get(sid, [])
        if not geo or not geo[0]:
            return None, None
        path = geo[0]
        return tuple(path[0]), tuple(path[-1])

    def _build(self):
        """Build adjacency by matching segment endpoints."""
        endpoints = []
        for sid in self.segment_geometries:
            start, end = self._get_endpoints(sid)
            if start:
                endpoints.append((sid, 'start', start))
            if end:
                endpoints.append((sid, 'end', end))

        if not endpoints:
            return

        coords = np.array([e[2] for e in endpoints])
        tree = cKDTree(coords)

        connected = set()
        for i, (sid1, role1, pt1) in enumerate(endpoints):
            dists, idxs = tree.query(pt1, k=min(6, len(endpoints)))
            if np.isscalar(dists):
                dists = [dists]
                idxs = [idxs]
            for j, d in zip(idxs, dists):
                if i == j or d > self.threshold:
                    continue
                sid2, role2, pt2 = endpoints[j]
                if sid1 == sid2:
                    continue
                pair = tuple(sorted([sid1, sid2]))
                if pair in connected:
                    continue
                connected.add(pair)

                # Determine flow direction: if role1=='end' and role2=='start',
                # then sid1 flows into sid2 (sid1 is upstream of sid2)
                if role1 == 'end' and role2 == 'start':
                    self.upstream[sid2].append(sid1)
                    self.downstream[sid1].append(sid2)
                    self.adjacency[sid1].append((sid2, 'downstream'))
                    self.adjacency[sid2].append((sid1, 'upstream'))
                elif role1 == 'start' and role2 == 'end':
                    self.upstream[sid1].append(sid2)
                    self.downstream[sid2].append(sid1)
                    self.adjacency[sid2].append((sid1, 'downstream'))
                    self.adjacency[sid1].append((sid2, 'upstream'))
                else:
                    # Same-endpoint connections (ambiguous direction)
                    self.adjacency[sid1].append((sid2, 'lateral'))
                    self.adjacency[sid2].append((sid1, 'lateral'))

    def get_downstream_chain(self, source_sid, max_depth=20):
        """BFS downstream from source, returns list of (sid, distance_hops, severity_decay)."""
        visited = {source_sid}
        queue = deque([(source_sid, 0, 1.0)])
        chain = []
        while queue:
            sid, depth, decay = queue.popleft()
            if depth > 0:
                chain.append({"sid": sid, "depth": depth, "decay": round(decay, 3),
                              "name": self.segment_name_map.get(sid, f"Segmen {sid}")})
            for neighbor, direction in self.adjacency.get(sid, []):
                if neighbor not in visited and direction in ('downstream', 'lateral'):
                    visited.add(neighbor)
                    new_decay = decay * 0.7 if direction == 'downstream' else decay * 0.4
                    queue.append((neighbor, depth + 1, new_decay))
        return chain

    def get_upstream_chain(self, source_sid, max_depth=20):
        """BFS upstream from source."""
        visited = {source_sid}
        queue = deque([(source_sid, 0)])
        chain = []
        while queue:
            sid, depth = queue.popleft()
            if depth > 0:
                chain.append({"sid": sid, "depth": depth,
                              "name": self.segment_name_map.get(sid, f"Segmen {sid}")})
            for neighbor in self.upstream.get(sid, []):
                if neighbor not in visited:
                    visited.add(neighbor)
                    queue.append((neighbor, depth + 1))
        return chain

    def to_dict(self):
        """Serialize topology for API response."""
        nodes = []
        for sid in self.segment_geometries:
            center = self.segment_wgs84_centers.get(sid, [0, 0])
            nodes.append({
                "id": sid,
                "name": self.segment_name_map.get(sid, f"Segmen {sid}"),
                "center": list(center) if center else [0, 0],
                "upstream_count": len(self.upstream.get(sid, [])),
                "downstream_count": len(self.downstream.get(sid, [])),
                "neighbor_count": len(self.adjacency.get(sid, [])),
            })
        edges = []
        seen = set()
        for sid, neighbors in self.adjacency.items():
            for neighbor, direction in neighbors:
                pair = tuple(sorted([sid, neighbor]))
                if pair not in seen:
                    seen.add(pair)
                    edges.append({"from": sid, "to": neighbor, "direction": direction})
        return {"nodes": nodes, "edges": edges,
                "total_nodes": len(nodes), "total_edges": len(edges)}
