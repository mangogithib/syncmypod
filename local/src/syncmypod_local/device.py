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

import contextlib
import logging
import re
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

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

        # The destination is named explicitly. Left to itself the library files
        # snapshots under the name of the project it was extracted from, which
        # is not a directory anyone would think to look in.
        from .config import backups_dir

        destination = backups_dir()
        destination.mkdir(parents=True, exist_ok=True)
        try:
            return self._handle.backup(str(destination), reason=reason)
        except Exception as err:
            raise DeviceError(f"Could not back up the iPod database: {err}") from err

    # -- reading the library ------------------------------------------------

    def tracks(self, *, reload: bool = False) -> list[IpodTrack]:
        """Everything currently in the iPod's database.

        Includes tracks this tool never touched. The sync needs to see them:
        they occupy space, they must not be removed, and one of them may be the
        same recording the library is about to add.
        """
        library = self._library(reload=reload)
        found = []
        for track in library.tracks:
            try:
                found.append(
                    IpodTrack(
                        db_track_id=track.db_track_id,
                        location=track.location,
                        title=track.title,
                        artist=track.artist,
                        album=track.album,
                    )
                )
            except Exception:
                # One malformed row must not make the whole device unreadable.
                continue
        return found

    def playlist_names(self) -> list[str]:
        """User playlists, excluding the master playlist and the smart ones.

        The master playlist is the whole library and is maintained by the
        database writer; the smart playlists are the device's own Music, Movies
        and Podcasts categories. Neither is ours to write.
        """
        library = self._library()
        return [p.name for p in library.playlists if not p.master]

    # -- writing ------------------------------------------------------------

    def add_files(self, paths: list[Path]) -> dict[str, str]:
        """Copy files onto the device and return where each one landed.

        The return value maps the source path given here to the colon-separated
        location the iPod knows it by, which is the only durable handle on a
        track once the source file has been deleted. Without it there would be
        no way to say "library track 412 is this row" on the next run.

        Committing the database is part of this, so an interrupted sync leaves
        a device that still boots.
        """
        if self._handle is None:
            raise DeviceError("This device is not open.")
        if not paths:
            return {}

        resolved = [str(Path(p).resolve()) for p in paths]

        # The library object has to be held before add_tracks runs. pypodlib
        # appends its new rows to the instance it is already holding and then
        # drops its cache, so asking for the library afterwards re-reads from
        # disk and the source paths - the only link back to what was asked for -
        # are gone. Holding the reference keeps them.
        library = self._library()
        try:
            added = self._handle.add_tracks(resolved, raise_on_error=True)
        except Exception as err:
            raise DeviceError(f"Could not write to the iPod: {err}") from err

        wanted = set(resolved)
        landed: dict[str, str] = {}
        for track in library.tracks:
            source = str(track.get("source_path") or "")
            if source in wanted and track.location:
                landed[source] = track.location

        if added and not landed:
            raise DeviceError(
                "The iPod accepted the files but reported no locations for them, "
                "so the sync cannot record what was written. Stopping rather than "
                "guessing."
            )
        return landed

    def write_playlists(self, playlists: list[tuple[str, list[str]]]) -> None:
        """Replace the named playlists with the given tracks, in the given order.

        Named rather than wholesale: a playlist on the device that the library
        does not have is left alone. Someone may have made it on the iPod, and
        deleting it because the server has never heard of it would be the tool
        overstepping.

        Tracks are identified by location, because that is what survives a
        database rewrite - the numeric ids do not.
        """
        if self._handle is None:
            raise DeviceError("This device is not open.")

        library = self._library(reload=True)
        by_location = {t.location: t for t in library.tracks if t.location}

        for name, locations in playlists:
            playlist = library.get_playlist(name)
            if playlist is None:
                playlist = library.create_playlist(name)
            elif playlist.master or playlist.is_smart:
                # The master playlist is the library itself and the smart ones
                # are the device's own categories. Overwriting either would take
                # the iPod's navigation with it.
                raise DeviceError(
                    f"{name!r} is a built-in iPod playlist and cannot be replaced. "
                    "Rename the playlist in the web interface."
                )
            ordered = [by_location[loc].db_track_id for loc in locations if loc in by_location]
            playlist.track_ids = ordered

        self._commit()

    def remove_locations(self, locations: list[str]) -> int:
        """Delete tracks from the database and their files from the device.

        Both halves matter and in this order: a row without a file is a track
        that plays silence, and a file without a row is invisible space that
        nothing will ever reclaim.
        """
        if self._handle is None:
            raise DeviceError("This device is not open.")
        if not locations:
            return 0

        library = self._library(reload=True)
        wanted = set(locations)
        removed = 0
        files: list[Path] = []

        for track in library.tracks:
            if track.location in wanted:
                files.append(_file_for(self.mount_path, track.location))
                library.remove_track(track)
                removed += 1

        if not removed:
            return 0

        self._commit()

        for path in files:
            try:
                path.unlink(missing_ok=True)
            except OSError as err:
                # The database no longer references it, so the track is gone as
                # far as the user is concerned. Worth a log line, not a failure.
                logger.warning("Could not delete %s from the iPod: %s", path, err)
        return removed

    def refresh_free_space(self) -> int | None:
        """Re-read free space after writing, for reporting to the server."""
        with contextlib.suppress(OSError):
            self.free_bytes = shutil.disk_usage(self.mount_path).free
        return self.free_bytes

    # -- internals ----------------------------------------------------------

    def _library(self, *, reload: bool = False) -> Any:
        if self._handle is None:
            raise DeviceError("This device is not open.")
        try:
            return self._handle.library(reload=reload)
        except Exception as err:
            raise DeviceError(
                f"Could not read the iPod's database: {err}. "
                "If the device was disconnected mid-transfer, reconnect it and try again."
            ) from err

    def _commit(self) -> None:
        try:
            ok = self._handle.save(raise_on_error=True)
        except Exception as err:
            raise DeviceError(f"Could not write the iPod's database: {err}") from err
        if not ok:
            raise DeviceError("The iPod's database was not written, and no reason was given.")


@dataclass(slots=True, frozen=True)
class IpodTrack:
    """One row of the iPod's database, in the terms the sync needs.

    ``location`` is the iPod's own colon-separated path and is the identity that
    matters: it is stable across database rewrites, whereas the numeric ids are
    reassigned every time the database is written.
    """

    db_track_id: int
    location: str
    title: str
    artist: str
    album: str


def _file_for(mount: Path, location: str) -> Path:
    """``:iPod_Control:Music:F00:ABCD.m4a`` to a real path on this machine."""
    parts = [p for p in location.split(":") if p]
    return Path(mount).joinpath(*parts)


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
