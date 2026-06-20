"""Netlify Functions entry point — wraps FastAPI app via Mangum."""
import sys, os

# Add project root to sys.path so 'from river_detective.backend.main' works
_root = os.path.realpath(os.path.join(os.path.dirname(__file__), "..", ".."))
if _root not in sys.path:
    sys.path.insert(0, _root)
    sys.path.insert(0, os.path.join(_root, "river_detective", "backend"))
    sys.path.insert(0, os.path.join(_root, "river_detective", "model"))

# Override cache directory to /tmp on serverless (ephemeral, restarts each cold start)
os.environ.setdefault("RD_CACHE_DIR", "/tmp/river_detective_cache")
os.environ.setdefault("RD_UPLOADS_DIR", "/tmp/river_detective_uploads")

from river_detective.backend.main import app
from mangum import Mangum

handler = Mangum(app)
