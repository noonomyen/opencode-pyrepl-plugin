#!/usr/bin/env python3
"""Backward-compatible single-file entry. The engine now lives in src/pyrepl/.

Run the package directly (readable tracebacks) or the bundled zipapp
(single-file deploy)::

    PYTHONPATH=src python3 -m pyrepl   # dev, from the repo root
    python3 dist/pyrepl.pyz            # prod bundle

This shim stays so existing installs and tests keep working. It also
re-exports the public engine names so `import pyrepl_server` keeps working.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))

from pyrepl import VERSION
from pyrepl.server import ReplServer, main

__all__ = ["VERSION", "ReplServer", "main"]

if __name__ == "__main__":
    main()
