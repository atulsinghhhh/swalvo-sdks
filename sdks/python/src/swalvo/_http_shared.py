"""Pure helpers shared by the sync (_http.py) and async (_async_http.py) transports.

Keeping these here means the actual retry/error-mapping *policy* is defined
exactly once, even though the sync and async I/O paths can't otherwise share
code (``httpx.Client`` vs ``httpx.AsyncClient``).
"""

from __future__ import annotations

from typing import Any

from ._errors import SwalvoError

RETRYABLE_STATUS_CODES = frozenset({429, 502, 503, 504})
DEFAULT_BASE_URL = "http://localhost:4100"
DEFAULT_TIMEOUT_SECONDS = 10.0
DEFAULT_MAX_RETRIES = 2
BASE_RETRY_DELAY_SECONDS = 0.3


def validate_api_key(api_key: str | None) -> str:
    if not api_key or not isinstance(api_key, str):
        raise SwalvoError(
            "api_key is required — pass your Swalvo project API key, e.g. api_key=os.environ['SWALVO_API_KEY']",
            code="RAVEN_INVALID_CONFIG",
        )
    return api_key


def build_headers(api_key: str, sdk_version: str) -> dict[str, str]:
    return {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
        "User-Agent": f"Swalvo-Server-SDK/{sdk_version} (python)",
    }


def should_retry_status(status_code: int) -> bool:
    return status_code in RETRYABLE_STATUS_CODES


def backoff_delay_seconds(attempt: int) -> float:
    return float(BASE_RETRY_DELAY_SECONDS * (2**attempt))


def code_for_status(status_code: int) -> str:
    if status_code == 401:
        return "RAVEN_AUTH_ERROR"
    if status_code == 403:
        return "RAVEN_PERMISSION_DENIED"
    if status_code == 404:
        return "RAVEN_NOT_FOUND"
    if status_code == 429:
        return "RAVEN_RATE_LIMITED"
    if status_code >= 500:
        return "RAVEN_INTERNAL_ERROR"
    return "VALIDATION_ERROR"


def map_error_response(status_code: int, payload: Any, request_id: str | None) -> SwalvoError:
    message = _extract_message(payload) or f"Request failed with status {status_code}"
    code = _extract_code(payload) or code_for_status(status_code)
    return SwalvoError(message, code=code, status_code=status_code, request_id=request_id, details=payload)


def _extract_message(payload: Any) -> str | None:
    if not isinstance(payload, dict):
        return None
    message = payload.get("message")
    if isinstance(message, str):
        return message
    if isinstance(message, list):
        return "; ".join(str(m) for m in message)
    return None


def _extract_code(payload: Any) -> str | None:
    if not isinstance(payload, dict):
        return None
    code = payload.get("code")
    return code if isinstance(code, str) else None
