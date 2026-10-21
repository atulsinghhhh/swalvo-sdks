"""Webhook signature verification.

Every delivery carries ``swalvo-signature: t=<unix seconds>,v1=<hex>`` (and,
for older integrations, the identical legacy ``raven-signature`` header), where the
hex is HMAC-SHA256 of ``"<t>.<raw body>"`` with your endpoint's signing secret
(the same scheme as apps/api's ``webhook-signature.util.ts``).
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from collections.abc import Mapping, Sequence
from typing import Any

from ._errors import SwalvoError

SWALVO_WEBHOOK_SIGNATURE_HEADER = "swalvo-signature"
"""The header Swalvo signs every webhook delivery with."""
WEBHOOK_SIGNATURE_HEADER = "raven-signature"  # legacy: kept for wire compatibility
"""Legacy twin of :data:`SWALVO_WEBHOOK_SIGNATURE_HEADER`, still sent on every delivery."""
WEBHOOK_SIGNATURE_HEADERS = (SWALVO_WEBHOOK_SIGNATURE_HEADER, WEBHOOK_SIGNATURE_HEADER)
"""Signature headers in the order they are tried when ``verify_webhook`` is given a headers mapping."""
WEBHOOK_TOLERANCE_SECONDS = 300
"""Default replay window, in seconds."""


def verify_webhook(
    raw_body: str | bytes,
    signature_header: str | Mapping[str, str] | None,
    secret: str | Sequence[str],
    *,
    tolerance_seconds: int = WEBHOOK_TOLERANCE_SECONDS,
    now: int | None = None,
) -> dict[str, Any]:
    """Verify a webhook delivery and return the parsed event, or raise ``SwalvoError``.

    Error codes: ``RAVEN_WEBHOOK_INVALID_SIGNATURE``,
    ``RAVEN_WEBHOOK_TIMESTAMP_OUT_OF_TOLERANCE``, ``RAVEN_WEBHOOK_INVALID_PAYLOAD``.

    Pass the body exactly as received (``request.body`` in Django,
    ``await request.body()`` in FastAPI), never a re-serialized dict. Every
    ``signature_header`` is either the header value, or the request's whole
    headers mapping — then ``swalvo-signature`` is used, falling back to the
    legacy ``raven-signature``. Every
    ``v1=`` value in the header is tried, and ``secret`` may be a list of
    secrets while you rotate one. Comparisons are constant-time.
    """
    body = raw_body if isinstance(raw_body, bytes) else raw_body.encode("utf-8")
    secrets = [secret] if isinstance(secret, str) else list(secret)
    secrets = [candidate for candidate in secrets if candidate]
    if not secrets:
        raise SwalvoError("verify_webhook needs your webhook signing secret", code="RAVEN_INVALID_CONFIG")

    if isinstance(signature_header, Mapping):
        signature_header = _pick_signature_header(signature_header)
    timestamp, signatures = _parse_header(signature_header or "")
    if timestamp is None or not signatures:
        raise SwalvoError("The swalvo-signature header is missing or malformed", code="RAVEN_WEBHOOK_INVALID_SIGNATURE")

    current = int(time.time()) if now is None else now
    if abs(current - timestamp) > tolerance_seconds:
        raise SwalvoError(
            f"The webhook timestamp is more than {tolerance_seconds}s from now; possible replay",
            code="RAVEN_WEBHOOK_TIMESTAMP_OUT_OF_TOLERANCE",
        )

    signed = str(timestamp).encode("ascii") + b"." + body
    matched = False
    for candidate in secrets:
        expected = hmac.new(candidate.encode("utf-8"), signed, hashlib.sha256).hexdigest()
        for provided in signatures:
            if hmac.compare_digest(provided, expected):
                matched = True
    if not matched:
        raise SwalvoError("The webhook signature does not match", code="RAVEN_WEBHOOK_INVALID_SIGNATURE")

    try:
        event = json.loads(body)
    except ValueError as error:
        raise SwalvoError("The webhook body is not valid JSON", code="RAVEN_WEBHOOK_INVALID_PAYLOAD") from error
    if not isinstance(event, dict):
        raise SwalvoError("The webhook body is not a JSON object", code="RAVEN_WEBHOOK_INVALID_PAYLOAD")
    return event


def _pick_signature_header(headers: Mapping[str, str]) -> str | None:
    lowered = {str(key).lower(): value for key, value in headers.items()}
    for name in WEBHOOK_SIGNATURE_HEADERS:
        value = lowered.get(name)
        if value:
            return value
    return None


def _parse_header(header: str) -> tuple[int | None, list[str]]:
    timestamp: int | None = None
    signatures: list[str] = []
    for part in header.split(","):
        key, sep, value = part.partition("=")
        if not sep:
            continue
        key, value = key.strip(), value.strip()
        if key == "t" and value.isdigit():
            timestamp = int(value)
        elif key == "v1" and value:
            signatures.append(value)
    return timestamp, signatures
