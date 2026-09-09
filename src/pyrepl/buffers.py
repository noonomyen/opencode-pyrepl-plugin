"""Bounded per-task output buffers and stream writers."""

import collections
import io
import threading

from . import config


def _utf8_len(text):
    """Byte length for buffer accounting. surrogatepass keeps lone
    surrogates (agent printing weird data) from crashing the task."""
    return len(text.encode("utf-8", "surrogatepass"))


class LineBuffer:
    """Thread-safe bounded ring buffer of (stream, line) tuples.

    Bounded by line count AND total bytes; lines longer than MAX_LINE_CHARS
    are split into multiple entries so one huge print cannot blow memory.
    """

    def __init__(self, maxlen=config.MAX_LINES, max_bytes=config.MAX_BYTES, max_line=config.MAX_LINE_CHARS):
        self._buf = collections.deque()
        self._maxlen = maxlen
        self._max_bytes = max_bytes
        self._max_line = max_line
        self._bytes = 0
        self._lock = threading.Lock()
        self.dropped = 0
        # Lifetime totals (pre-eviction): the true output size even when the
        # ring already dropped the oldest entries. Granularity is logical
        # lines: total_lines counts one per append() call even when a long
        # line is split into several physical entries, while total_bytes
        # counts the same logical content in bytes.
        self.total_bytes = 0
        self.total_lines = 0

    def _push(self, stream, text, size=None):
        if size is None:
            size = _utf8_len(text)
        if len(self._buf) >= self._maxlen:
            old = self._buf.popleft()
            self._bytes -= _utf8_len(old[1])
            self.dropped += 1
        self._buf.append((stream, text))
        self._bytes += size
        while self._bytes > self._max_bytes and len(self._buf) > 1:
            old = self._buf.popleft()
            self._bytes -= _utf8_len(old[1])
            self.dropped += 1

    def append(self, stream, text):
        self.total_lines += 1
        encoded_len = _utf8_len(text)
        self.total_bytes += encoded_len
        with self._lock:
            if len(text) <= self._max_line:
                self._push(stream, text, encoded_len)
                return
            while len(text) > self._max_line:
                self._push(stream, text[: self._max_line] + " [line split]")
                text = text[self._max_line :]
            self._push(stream, text)

    def snapshot(self):
        with self._lock:
            return list(self._buf), self.dropped


class StreamWriter(io.TextIOBase):
    """File-like object routing writes into a LineBuffer, split per line.

    User code may print from several threads at once, so the pending
    fragment is guarded by a lock.
    """

    def __init__(self, buffer, stream):
        self._buffer = buffer
        self._stream = stream
        self._pending = ""
        self._lock = threading.Lock()

    def write(self, text):
        if not isinstance(text, str):
            text = str(text)
        with self._lock:
            data = self._pending + text
            parts = data.split("\n")
            self._pending = parts.pop()
            for part in parts:
                self._buffer.append(self._stream, part)
        return len(text)

    def flush(self):
        with self._lock:
            if self._pending:
                self._buffer.append(self._stream, self._pending)
                self._pending = ""
