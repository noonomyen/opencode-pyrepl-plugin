"""Module entry: PYTHONPATH=src python3 -m pyrepl (dev) or python3 dist/pyrepl.pyz.

Direct directory execution (python3 src/pyrepl) is NOT supported: the
modules use package-relative imports, which need a parent package.
Use the pyrepl_server.py shim or the pyz instead.
"""

from .server import main

if __name__ == "__main__":
    main()
