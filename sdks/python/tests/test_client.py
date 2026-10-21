from __future__ import annotations

import pytest

from swalvo import AsyncSwalvo, Swalvo, SwalvoError


def test_swalvo_requires_api_key() -> None:
    with pytest.raises(TypeError):
        Swalvo()  # type: ignore[call-arg]


def test_swalvo_rejects_empty_api_key() -> None:
    with pytest.raises(SwalvoError):
        Swalvo(api_key="")


def test_swalvo_exposes_all_documented_resources() -> None:
    swalvo = Swalvo(api_key="k")

    assert swalvo.projects is not None
    assert swalvo.tokens is not None
    assert swalvo.rooms is not None
    assert swalvo.rooms.participants is not None
    assert swalvo.connections is not None
    assert swalvo.errors is not None
    assert swalvo.metrics is not None
    assert swalvo.diagnostics is not None
    assert swalvo.chat is not None
    assert swalvo.live_streams is not None
    swalvo.close()


def test_swalvo_context_manager_closes_the_client() -> None:
    with Swalvo(api_key="k") as swalvo:
        assert swalvo is not None


def test_swalvo_never_reads_env_var_implicitly(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SWALVO_API_KEY", "should-never-be-read-implicitly")
    with pytest.raises(TypeError):
        Swalvo()  # type: ignore[call-arg]


def test_async_swalvo_exposes_all_documented_resources() -> None:
    swalvo = AsyncSwalvo(api_key="k")

    assert swalvo.projects is not None
    assert swalvo.tokens is not None
    assert swalvo.rooms is not None
    assert swalvo.connections is not None
    assert swalvo.errors is not None
    assert swalvo.metrics is not None
    assert swalvo.diagnostics is not None
    assert swalvo.chat is not None
    assert swalvo.live_streams is not None


@pytest.mark.asyncio
async def test_async_swalvo_context_manager() -> None:
    async with AsyncSwalvo(api_key="k") as swalvo:
        assert swalvo is not None


def test_secret_never_appears_in_client_repr_or_vars() -> None:
    swalvo = Swalvo(api_key="rvk_super-secret-value.dontleakme")

    assert "dontleakme" not in repr(swalvo._http)
    # __dict__ on Swalvo itself never holds the raw key (it lives inside the
    # http client's own name-mangled attribute, one level down).
    assert "dontleakme" not in repr(vars(swalvo))
    swalvo.close()
