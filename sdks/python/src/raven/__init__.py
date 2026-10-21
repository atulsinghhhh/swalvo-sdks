"""Deprecated compatibility shim: the SDK's import package is now ``swalvo``.

``import raven`` / ``from raven import Raven`` / ``import raven.resources.rooms``
keep working and resolve to the very same objects in ``swalvo`` (so
``isinstance`` and ``except RavenError`` behave identically), but emit a
``DeprecationWarning``. Change ``raven`` to ``swalvo`` in your imports.
"""

from __future__ import annotations

import importlib
import importlib.abc
import importlib.machinery
import importlib.util
import sys
import warnings
from collections.abc import Sequence
from types import ModuleType

import swalvo as _swalvo
from swalvo import *  # noqa: F403
from swalvo import AsyncRaven, Raven, RavenError  # deprecated aliases

warnings.warn(
    "The 'raven' package has been renamed to 'swalvo'; import from 'swalvo' instead. "
    "The 'raven' alias will be removed in a future major release.",
    DeprecationWarning,
    stacklevel=2,
)

__all__ = [*_swalvo.__all__, "AsyncRaven", "Raven", "RavenError"]
__version__ = _swalvo.SDK_VERSION


class _SwalvoAliasLoader(importlib.abc.Loader):
    def __init__(self, target: str) -> None:
        self._target = target

    def create_module(self, spec: importlib.machinery.ModuleSpec) -> ModuleType:
        return importlib.import_module(self._target)

    def exec_module(self, module: ModuleType) -> None:
        return None


class _SwalvoAliasFinder(importlib.abc.MetaPathFinder):
    """Maps ``raven.<sub>`` to the already-importable ``swalvo.<sub>`` module."""

    def find_spec(
        self,
        fullname: str,
        path: Sequence[str] | None,
        target: ModuleType | None = None,
    ) -> importlib.machinery.ModuleSpec | None:
        if not fullname.startswith(__name__ + "."):
            return None
        target_name = "swalvo" + fullname[len(__name__) :]
        if importlib.util.find_spec(target_name) is None:
            return None
        return importlib.util.spec_from_loader(fullname, _SwalvoAliasLoader(target_name))


if not any(isinstance(finder, _SwalvoAliasFinder) for finder in sys.meta_path):
    sys.meta_path.insert(0, _SwalvoAliasFinder())
