from __future__ import annotations

import pytest

from swalvo._errors import SwalvoError
from swalvo._http import SwalvoHttpClient


def test_missing_api_key_raises_synchronously() -> None:
    with pytest.raises(SwalvoError, match="api_key is required"):
        SwalvoHttpClient(api_key="")


def test_sends_authorization_and_user_agent_headers(mock_transport) -> None:
    transport = mock_transport([{"status": 200, "body": []}])
    client = SwalvoHttpClient(api_key="rvk_abc.secret", transport=transport)

    client.request("/v1/rooms")

    request = transport.calls[0]
    assert request.headers["authorization"] == "Bearer rvk_abc.secret"
    assert request.headers["user-agent"].startswith("Swalvo-Server-SDK/")
    assert "(python)" in request.headers["user-agent"]


def test_defaults_to_localhost_base_url(mock_transport) -> None:
    transport = mock_transport([{"status": 200, "body": []}])
    client = SwalvoHttpClient(api_key="k", transport=transport)

    client.request("/v1/rooms")

    assert str(transport.calls[0].url) == "http://localhost:4100/v1/rooms"


def test_omits_none_query_params(mock_transport) -> None:
    transport = mock_transport([{"status": 200, "body": []}])
    client = SwalvoHttpClient(api_key="k", transport=transport)

    client.request("/v1/connections", query={"roomId": "room-1", "state": None, "limit": 10})

    url = str(transport.calls[0].url)
    assert "roomId=room-1" in url
    assert "limit=10" in url
    assert "state=" not in url


def test_returns_none_for_204(mock_transport) -> None:
    transport = mock_transport([{"status": 204}])
    client = SwalvoHttpClient(api_key="k", transport=transport)

    assert client.request("/v1/rooms/r1", method="DELETE") is None


def test_maps_401_to_swalvo_error_with_request_id(mock_transport) -> None:
    transport = mock_transport(
        [
            {
                "status": 401,
                "body": {"message": "Invalid or missing credentials", "code": "UNAUTHORIZED"},
                "headers": {"x-request-id": "req-123"},
            }
        ]
    )
    client = SwalvoHttpClient(api_key="bad-key", transport=transport)

    with pytest.raises(SwalvoError) as exc_info:
        client.request("/v1/rooms")

    error = exc_info.value
    assert error.status_code == 401
    assert error.request_id == "req-123"
    assert error.message == "Invalid or missing credentials"


def test_retries_503_then_succeeds(mock_transport) -> None:
    transport = mock_transport(
        [{"status": 503, "body": {"message": "unavailable"}}, {"status": 200, "body": [{"id": "r1"}]}]
    )
    client = SwalvoHttpClient(api_key="k", transport=transport)

    result = client.request("/v1/rooms")

    assert result == [{"id": "r1"}]
    assert len(transport.calls) == 2


def test_retries_429(mock_transport) -> None:
    transport = mock_transport([{"status": 429, "body": {"message": "rate limited"}}, {"status": 200, "body": []}])
    client = SwalvoHttpClient(api_key="k", transport=transport)

    client.request("/v1/rooms")
    assert len(transport.calls) == 2


@pytest.mark.parametrize("status", [400, 401, 403, 404])
def test_never_retries_client_errors(mock_transport, status: int) -> None:
    transport = mock_transport([{"status": status, "body": {"message": "nope"}}])
    client = SwalvoHttpClient(api_key="k", transport=transport)

    with pytest.raises(SwalvoError) as exc_info:
        client.request("/v1/rooms")
    assert exc_info.value.status_code == status
    assert len(transport.calls) == 1


def test_retryable_false_never_retries_even_a_503(mock_transport) -> None:
    transport = mock_transport([{"status": 503, "body": {"message": "unavailable"}}])
    client = SwalvoHttpClient(api_key="k", transport=transport)

    with pytest.raises(SwalvoError):
        client.request("/v1/rooms", retryable=False)
    assert len(transport.calls) == 1


class _RedactionCheck:
    """Sanity object used only to assert a secret never appears in a serialized error."""


def test_secret_redaction_never_appears_in_repr_or_error(mock_transport) -> None:
    transport = mock_transport([{"status": 400, "body": {"message": "bad input", "code": "VALIDATION_FAILED"}}])
    client = SwalvoHttpClient(api_key="rvk_super-secret-value.dontleakme", transport=transport)

    assert "dontleakme" not in repr(client)
    assert "dontleakme" not in str(client)

    with pytest.raises(SwalvoError) as exc_info:
        client.request("/v1/rooms")
    assert "dontleakme" not in repr(exc_info.value)
    assert "dontleakme" not in str(exc_info.value)
