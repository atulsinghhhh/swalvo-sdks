"""The pre-rename ``raven`` import package and ``Raven*`` names keep working."""

from __future__ import annotations

import hashlib
import hmac
import importlib
import json
import sys
import warnings
from types import ModuleType

import pytest

import swalvo
from swalvo import verify_webhook

SECRET = "whsec_test"
NOW = 1_800_000_000
BODY = json.dumps({"id": "evt_1", "type": "room.participant_joined"})


def _sign(body: str) -> str:
    digest = hmac.new(SECRET.encode(), f"{NOW}.{body}".encode(), hashlib.sha256).hexdigest()
    return f"t={NOW},v1={digest}"


def _fresh_import_raven() -> ModuleType:
    for name in [n for n in sys.modules if n == "raven" or n.startswith("raven.")]:
        del sys.modules[name]
    return importlib.import_module("raven")


def test_module_level_aliases_are_the_same_objects() -> None:
    assert swalvo.Raven is swalvo.Swalvo
    assert swalvo.AsyncRaven is swalvo.AsyncSwalvo
    assert swalvo.RavenError is swalvo.SwalvoError


def test_legacy_package_warns_and_reexports() -> None:
    with pytest.warns(DeprecationWarning, match="renamed to 'swalvo'"):
        raven = _fresh_import_raven()
    assert raven.Raven is swalvo.Swalvo
    assert raven.Swalvo is swalvo.Swalvo
    assert raven.RavenError is swalvo.SwalvoError
    assert raven.CreateTokenParams is swalvo.CreateTokenParams


def test_legacy_submodule_imports_resolve_to_swalvo_modules() -> None:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        _fresh_import_raven()
        rooms = importlib.import_module("raven.resources.rooms")
        errors = importlib.import_module("raven._errors")
    import swalvo.resources.rooms

    assert rooms is swalvo.resources.rooms
    assert errors.SwalvoError is swalvo.SwalvoError
    from raven.resources.rooms import RoomsResource  # type: ignore[import-untyped]

    assert RoomsResource is swalvo.resources.rooms.RoomsResource


def test_verify_webhook_prefers_swalvo_signature_from_a_headers_mapping() -> None:
    good = _sign(BODY)
    assert (
        verify_webhook(BODY, {"Swalvo-Signature": good, "raven-signature": "t=1,v1=bad"}, SECRET, now=NOW)["id"]
        == "evt_1"
    )


def test_verify_webhook_falls_back_to_legacy_raven_signature() -> None:
    assert verify_webhook(BODY, {"Raven-Signature": _sign(BODY)}, SECRET, now=NOW)["id"] == "evt_1"


def test_verify_webhook_rejects_a_mapping_without_signature_headers() -> None:
    with pytest.raises(swalvo.SwalvoError) as info:
        verify_webhook(BODY, {"content-type": "application/json"}, SECRET, now=NOW)
    assert info.value.code == "RAVEN_WEBHOOK_INVALID_SIGNATURE"
