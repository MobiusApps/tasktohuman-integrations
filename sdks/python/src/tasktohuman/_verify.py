"""Callback signature verification, as described on the Callbacks page."""

from __future__ import annotations

import hashlib
import hmac
import json
import math
import re
import time
from typing import Any, Mapping, Sequence, cast

from ._errors import SignatureVerificationError
from ._types import CallbackTask

SIGNATURE_HEADER = "TTH-Signature"
DEFAULT_TOLERANCE = 300

_HEX64 = re.compile(r"[0-9a-f]{64}")


def verify_callback(
    body: bytes | bytearray,
    signature: str | Mapping[str, str] | None,
    secret: str | Sequence[str],
    *,
    tolerance: int = DEFAULT_TOLERANCE,
    now: float | None = None,
) -> CallbackTask:
    """Check a callback's ``TTH-Signature`` and return the parsed task.

    body:      the raw request body exactly as it arrived (bytes), before any
               JSON parsing. A ``str`` raises ``TypeError``.
    signature: the ``TTH-Signature`` header value, or the request's headers
               (any mapping; the name is matched without regard to case).
    secret:    your workspace's signing secret (``whsec_...``), or several while
               you roll out a new one. A missing or empty secret raises ``TypeError``.

    Raises ``SignatureVerificationError`` (with ``reason``) when the callback
    must be refused. Skip a ``TTH-Event-Id`` you already handled, and act on
    the decision only when ``decision["automatic"]`` is ``False``.
    """
    if not isinstance(body, (bytes, bytearray)):
        raise TypeError("body must be the raw request body as bytes, not parsed or decoded")
    # NaN or infinity would make the tolerance check always pass and turn off the replay window.
    if not _finite(tolerance) or tolerance < 0:
        raise TypeError("tolerance must be a finite number >= 0")
    if now is not None and not _finite(now):
        raise TypeError("now must be a finite number")
    secrets = _secrets(secret)
    header = _header_value(signature)
    if not header or not header.strip():
        raise SignatureVerificationError("missing_header")

    timestamp, candidates = _parse(header)
    current = time.time() if now is None else now
    if abs(current - int(timestamp)) > tolerance:
        raise SignatureVerificationError("timestamp_out_of_tolerance")

    signed = timestamp.encode("ascii") + b"." + bytes(body)
    matched = False
    for key in secrets:
        expected = hmac.new(key.encode("utf-8"), signed, hashlib.sha256).hexdigest()
        for candidate in candidates:
            if hmac.compare_digest(expected, candidate):
                matched = True
    if not matched:
        raise SignatureVerificationError("no_matching_signature")
    return cast(CallbackTask, json.loads(bytes(body)))


def _finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _secrets(secret: Any) -> list[str]:
    values = [secret] if isinstance(secret, str) else list(secret) if isinstance(secret, (list, tuple)) else None
    if not values or not all(isinstance(s, str) and s for s in values):
        # An HMAC keyed with nothing can be forged by anyone: refuse loudly.
        raise TypeError("secret must be a non-empty string or a non-empty list of non-empty strings")
    return values


def _header_value(signature: Any) -> str | None:
    if signature is None or isinstance(signature, str):
        return signature
    value = signature.get(SIGNATURE_HEADER) or signature.get(SIGNATURE_HEADER.lower())
    if value is None and hasattr(signature, "items"):
        for name, item in signature.items():
            if isinstance(name, str) and name.lower() == SIGNATURE_HEADER.lower():
                return cast(str, item)
    return cast("str | None", value)


def _parse(header: str) -> tuple[str, list[str]]:
    timestamps: list[str] = []
    candidates: list[str] = []
    for part in header.split(","):
        key, _, value = part.strip().partition("=")
        if key == "t":
            timestamps.append(value)
        elif key == "v1":
            if not _HEX64.fullmatch(value):
                raise SignatureVerificationError("malformed_header")
            candidates.append(value)
    if len(timestamps) != 1 or not candidates:
        raise SignatureVerificationError("malformed_header")
    timestamp = timestamps[0]
    if not (timestamp.isascii() and timestamp.isdigit()):
        raise SignatureVerificationError("malformed_header")
    return timestamp, candidates
