"""Stateful stdlib-only Python REPL engine (package entry).

Split from the former single-file pyrepl_server.py for maintainability.
Run as a module (dev, readable tracebacks) or as a zipapp (prod)::

    PYTHONPATH=src python3 -m pyrepl   # dev, from the repo root
    python3 dist/pyrepl.pyz            # bundled single file

Protocol docs live in server.py. No third-party dependencies.
"""

VERSION = "0.1.0"
