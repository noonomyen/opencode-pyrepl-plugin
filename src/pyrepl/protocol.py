"""NDJSON protocol writer. Responses bypass task buffers via sys.__stdout__."""

import json
import sys


def _respond(payload):
    try:
        text = json.dumps(payload)
    except (TypeError, ValueError):
        try:
            text = json.dumps(
                {"id": payload.get("id"), "status": "error", "message": "unserializable response"}
            )
        except (TypeError, ValueError):
            return
    sys.__stdout__.write(text + "\n")
    sys.__stdout__.flush()
