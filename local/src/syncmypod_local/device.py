"""iPod detection and iTunesDB access.

Everything that knows pyPodLib exists is in this file, on purpose.

pyPodLib is the right library - MIT, extracted from iOpenPod, and the only
open-source implementation covering the database signatures a post-2007 iPod
requires. But at 0.1.0 it is alpha with a single release, and it is the
component that rewrites the database an iPod boots from. So the rest of the
application talks to the small vocabulary below (``IpodDevice``) and never
imports pypodlib directly. If that library has to be replaced or forked, this is
the only file that changes.

The import is deferred into the functions that need it so that a missing or
broken pypodlib produces a clear message from ``syncmypod status`` rather than
an ImportError traceback at startup.
"""

from __future__ import annotations

import re
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

_CAPACITY = re.compile(r"([\d.]+)\s*(TB|GB|MB)", re.IGNORECASE)
_CAPACITY_UNITS = {"MB": 1024**2, "GB": 1024**3, "TB": 1024**4}


class DeviceError(Exception):
    """Something went wrong talking to the iPod, phrased for a user."""


class DependencyMissing(DeviceError):
    """pypodlib is not installed or failed to import."""


@dataclass(slots=True)
class IpodDevice:
    """A mounted iPod, described in the terms this application cares about."""

    mount_path: Path
    name: str | None
    model: str | None
    model_number: str | None
    generation: str | None
    serial: str | None
    capacity_bytes: int | None
    free_bytes: int | None
    # Which database signature this device demands. "NONE" for a 5th gen Video;
    # "HASH58" for a Classic. Kept as the library's own name rather than a
    # boolean so a support question can be answered precisely.
    checksum_type: str
    _handle: Any = field(default=None, repr=False)

    @property
    def needs_signature(self) -> bool:
        """Whether the database must be signed for this device to read it.

        Getting this wrong in one direction is far worse than the other: an
        unsigned database on a device that wanted one leaves an iPod that boots
        to an empty library with every file still on disk. So anything not
        explicitly NONE counts as requiring a signature.
        """
        return self.checksum_type.upper() not in {"NONE", ""}

    def as_report(self) -> dict[str, Any]:
        """The shape the server's ``POST /api/sync/device`` expects."""
        return {
            "ipodName": self.name,
            "ipodModel": self.model,
            "ipodGeneration": self.generation,
            "ipodSerial": self.serial,
            "ipodCapacityBytes": self.capacity_bytes,
            "ipodFreeBytes": self.free_bytes,
            "ipodNeedsHash": self.needs_signature,
        }

    def describe(self) -> str:
        return self.model or self.name or str(self.mount_path)

    def backup(self, reason: str = "before sync") -> str | None:
        """Snapshot the iPod's database before modifying it.

        Worth doing every run. Writing a database is the one operation here that
        can leave a device unusable, and pypodlib is alpha, so a restore point
        costs a moment and removes the worst outcome. Returns the snapshot id,
        or None if the library declined - a failed backup is reported by the
        caller, never silently swallowed.
        """
        if self._handle is None:
            raise DeviceError("This device is not open.")
        try:
            return self._handle.backup(reason=reason)
        except Exception as err:
            raise DeviceError(f"Could not back up the iPod database: {err}") from err


def _pypodlib() -> Any:
    """Import pypodlib, turning a missing dependency into a clear message."""
    try:
        import pypodlib
    except Exception as err:  # pragma: no cover - environment-specific
        raise DependencyMissing(
            "pypodlib is not available, so the iPod cannot be read or written. "
            "Reinstall the application, or run: pip install 'pypodlib==0.1.0'"
        ) from err
    return pypodlib


def scan() -> list[IpodDevice]:
    """Find every mounted iPod.

    Returns an empty list rather than raising when there is none: "no iPod
    plugged in" is an ordinary state, not an error.
    """
    lib = _pypodlib()
    try:
        found = lib.scan_ipods()
    except Exception as err:
        raise DeviceError(f"Could not scan for iPods: {err}") from err

    devices = []
    for handle in found or []:
        try:
            devices.append(_describe(handle))
        except DeviceError:
            # One unreadable device must not hide the others.
            continue
    return devices


def open_at(path: str | Path) -> IpodDevice:
    """Open a specific mount point, for when detection needs overriding."""
    lib = _pypodlib()
    mount = Path(path)
    if not mount.exists():
        raise DeviceError(f"{mount} does not exist.")

    try:
        handle = lib.connect(mount)
    except Exception as err:
        raise DeviceError(
            f"{mount} does not look like an iPod: {err}. Point this at the "
            "drive's root - the folder containing iPod_Control."
        ) from err
    return _describe(handle)


def create_virtual(
    path: str | Path, model_number: str, name: str = "Virtual iPod"
) -> IpodDevice:
    """Create a simulated iPod on disk.

    Not a test-only convenience: it is how the sync path can be exercised
    end to end - including writing and signing a database - without risking a
    real device. Every model pypodlib knows is available, so the exact hardware
    being targeted can be simulated before it is ever plugged in.
    """
    lib = _pypodlib()
    root = Path(path)
    root.mkdir(parents=True, exist_ok=True)
    try:
        lib.device.create_virtual_ipod(root, model_number, ipod_name=name)
    except Exception as err:
        raise DeviceError(f"Could not create a virtual {model_number}: {err}") from err
    return open_at(root)


def virtual_models() -> list[dict[str, str]]:
    """Every model that can be simulated, for `syncmypod devices --list-models`."""
    lib = _pypodlib()
    try:
        return list(lib.device.available_virtual_ipod_models())
    except Exception as err:
        raise DeviceError(f"Could not list models: {err}") from err


def _describe(handle: Any) -> IpodDevice:
    """Normalise a pypodlib IPod into our own shape.

    Read defensively - the library is alpha and its surface is the most likely
    thing to shift between releases. A renamed property should degrade to
    "unknown" rather than crash a sync.
    """

    def prop(name: str) -> Any:
        try:
            return getattr(handle, name, None)
        except Exception:
            return None

    raw_path = prop("path")
    if not raw_path:
        raise DeviceError("A device was detected but reported no mount point.")
    mount = Path(str(raw_path))

    # `capacity` is the marketing figure as a string ("160GB"), which is what
    # belongs in a device description. Actual free space has to come from the
    # filesystem, and is the number that decides whether a sync will fit.
    capacity_bytes = _parse_capacity(prop("capacity"))
    free_bytes = None
    try:
        usage = shutil.disk_usage(mount)
        free_bytes = usage.free
        # Trust the filesystem over the marketing figure when both exist: a
        # 160GB Classic with an SSD swapped in reports whatever is really there.
        capacity_bytes = usage.total or capacity_bytes
    except OSError:
        pass

    return IpodDevice(
        mount_path=mount,
        name=_as_str(prop("name")),
        model=_as_str(prop("display_name")) or _as_str(prop("model_family")),
        model_number=_as_str(prop("model_number")),
        generation=_as_str(prop("generation")),
        serial=_as_str(prop("serial")),
        capacity_bytes=capacity_bytes,
        free_bytes=free_bytes,
        checksum_type=_checksum_name(prop("checksum_type")),
        _handle=handle,
    )


def _checksum_name(value: Any) -> str:
    """The signature scheme's name, however the library chose to express it.

    pypodlib returns an IntEnum, so `.name` is the reliable read; the fallbacks
    cover it becoming a plain string or int in a later version.
    """
    if value is None:
        return "UNKNOWN"
    name = getattr(value, "name", None)
    if isinstance(name, str):
        return name.upper()
    return str(value).split(".")[-1].upper()


def _parse_capacity(value: Any) -> int | None:
    """'160GB' -> 171798691840. None for anything unparseable."""
    if value is None:
        return None
    if isinstance(value, int):
        return value
    match = _CAPACITY.search(str(value))
    if not match:
        return None
    amount, unit = match.groups()
    try:
        return int(float(amount) * _CAPACITY_UNITS[unit.upper()])
    except (ValueError, KeyError):
        return None


def _as_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None
