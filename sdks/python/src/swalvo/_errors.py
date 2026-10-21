"""The one error type this SDK raises.

Built purely from the parsed response body (``{"message": ..., "code": ...}``,
matching ``AppError`` on the Swalvo API side) plus response metadata — never
from anything that could carry the API key, so there is no path by which a
key could end up here. Never includes a stack trace from the server, a
database error, or TURN/RTC credentials (Phase 10 spec Section 10).
"""

from __future__ import annotations

from typing import Any


class SwalvoError(Exception):
    """Raised for every non-2xx response and every transport-level failure."""

    def __init__(
        self,
        message: str,
        *,
        code: str = "RAVEN_UNKNOWN_ERROR",
        status_code: int | None = None,
        request_id: str | None = None,
        details: Any = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.code = code
        self.status_code = status_code
        self.request_id = request_id
        self.details = details

    def __repr__(self) -> str:
        return f"SwalvoError(code={self.code!r}, status_code={self.status_code!r}, message={self.message!r})"
