import sys
from pathlib import Path

# Ensure scripts package is importable when running tests from repo root
ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
