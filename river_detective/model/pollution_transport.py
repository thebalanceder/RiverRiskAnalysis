"""Advection-diffusion pollution transport model along river network."""
import numpy as np
from scipy import sparse
from scipy.sparse.linalg import spsolve


class PollutionTransport:
    def __init__(self, river_len_km=50, n_segments=100,流速_ms=0.5):
        self.L = river_len_km * 1000
        self.n = n_segments
        self.dx = self.L / n_segments
        self.v = 流速_ms
        self.D = 5.0
        self.dt = self.dx / (self.v * 2)

    def build_advection_diffusion_matrix(self):
        alpha = self.D * self.dt / (self.dx ** 2)
        beta = self.v * self.dt / (2 * self.dx)
        diag = (1 - 2 * alpha) * np.ones(self.n)
        lower = (alpha + beta) * np.ones(self.n - 1)
        upper = (alpha - beta) * np.ones(self.n - 1)
        A = sparse.diags([lower, diag, upper], [-1, 0, 1], format="csr")
        A[0, 0] = 1
        A[0, 1] = 0
        A[-1, -2] = -1
        A[-1, -1] = 1
        return A

    def simulate(self, source_idx, source_mass=100, t_max=3600):
        A = self.build_advection_diffusion_matrix()
        n_steps = int(t_max / self.dt)
        C = np.zeros(self.n)
        C[source_idx] = source_mass
        history = [C.copy()]
        for _ in range(n_steps):
            C[:] = spsolve(A, C)
            history.append(C.copy())
        return np.array(history)

    def simulate_multisensor(self, source_idx, sensor_idxs, source_mass=100, t_max=3600):
        C_hist = self.simulate(source_idx, source_mass, t_max)
        sensor_readings = C_hist[:, sensor_idxs]
        return sensor_readings


def generate_training_data(transport, n_samples=5000, n_sensors=8):
    """Generate (sensor_pattern, source_location) pairs."""
    sensor_idxs = np.linspace(0, transport.n - 1, n_sensors, dtype=int)
    X, y = [], []
    possible_sources = list(range(5, transport.n - 5, 3))

    for _ in range(n_samples):
        src = np.random.choice(possible_sources)
        mass = np.random.uniform(50, 500)
        readings = transport.simulate_multisensor(src, sensor_idxs, mass)
        peak_readings = readings.max(axis=0)
        peak_times = readings.argmax(axis=0) * transport.dt

        features = np.concatenate([peak_readings / peak_readings.max(),
                                   peak_times / peak_times.max()])
        X.append(features)
        y.append(src / transport.n)

    return np.array(X), np.array(y)
