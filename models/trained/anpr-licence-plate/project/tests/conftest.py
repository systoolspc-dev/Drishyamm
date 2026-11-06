"""
pytest bootstrap — the worker's pure logic WITHOUT models, a backend or a
camera. Run inside the worker container:

    docker exec -w /srv/anpr trinetra-anpr-worker python -m pytest tests -q

Importing `worker` under ANPR_DRY_RUN=1 loads no YOLO / OCR weights (Models
is only built in run_cams) and starts no threads. The container's compose
environment pins ANPR_* knobs (e.g. ANPR_MIN_AGREEMENT=0.7), so every ANPR_*
variable is cleared first: the tests exercise the CODE defaults, and anything
the worker might write goes to a throw-away data dir.
"""

import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)  # the anpr_worker folder
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

for _k in [k for k in os.environ if k.startswith("ANPR_")]:
    del os.environ[_k]
os.environ["ANPR_DRY_RUN"] = "1"  # no backend, log only
os.environ["ANPR_DATA_DIR"] = tempfile.mkdtemp(prefix="anpr-tests-")
os.environ["ANPR_SAVE_CROPS"] = "0"
os.environ["ANPR_SAVE_FRAMES"] = "0"
os.environ["ANPR_CLIPS"] = "0"
