"""Best-effort secret redaction for text that ends up in logs/observations.

Not exhaustive by design — a net, not a guarantee. Shared by
session_recorder.py (observations.jsonl, plaintext by design) and the
provider error-mapping paths (SDK exception messages can carry a raw HTTP
response body, which may echo request headers/payloads back).
"""
from __future__ import annotations

import re

_SECRET_PATTERNS = [
    # KEY=value / KEY: value assignments for common credential-shaped names.
    re.compile(
        r'(?i)\b([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|ACCESS[_-]?KEY)[A-Z0-9_]*\s*[=:]\s*)(\S+)'  # NOSONAR python:S8786 — input is always internal trusted text, not adversarial
    ),
    # HTTP Authorization headers.
    re.compile(r'(?i)\b(Authorization:\s*Bearer\s+)(\S+)'),
    # Recognizable provider key prefixes, matched even outside a KEY= assignment.
    re.compile(r'\b(sk-[A-Za-z0-9_-]{10,})\b'),
    re.compile(r'\b(ghp_[A-Za-z0-9]{20,})\b'),
    re.compile(r'\b(AKIA[0-9A-Z]{12,})\b'),
    re.compile(r'\b(xox[baprs]-[A-Za-z0-9-]{10,})\b'),
]


def redact_secrets(text: str | None) -> str | None:
    if not text:
        return text
    redacted = text
    for pattern in _SECRET_PATTERNS:
        if pattern.groups == 2:
            redacted = pattern.sub(lambda m: m.group(1) + "<REDACTED>", redacted)
        else:
            redacted = pattern.sub("<REDACTED>", redacted)
    return redacted
