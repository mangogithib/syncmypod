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
from functools import lru_cache
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

    # -- the database itself ------------------------------------------------

    @property
    def has_database(self) -> bool:
        """Whether this iPod has an iTunesDB at all.

        An iPod restored in iTunes and never synced since does not have one. The
        folder structure is there, ``iPod_Control/iTunes`` holds the
        pre-allocated ``iTunesControl`` file, and the database itself only
        appears the first time something writes music. So does an iPod restored
        by any other tool, and an iPod somebody has just wiped.

        That is an ordinary state for a device being set up, not a fault, and it
        is the state this application has to be able to start from.
        """
        try:
            from pypodlib.device.info import resolve_itdb_path

            return bool(resolve_itdb_path(str(self.mount_path)))
        except Exception:
            # Never let a question about the database stop a caller. The write
            # path checks properly; this is for deciding what to show.
            return False

    def ensure_database(self) -> bool:
        """Create an empty database when the iPod has none.

        Returns whether one was created; False means there already was one and
        nothing was touched.

        **Why this is safe, and where it stops being safe.** Creating a database
        where there is none takes nothing away - there is nothing there to lose,
        and without it the iPod cannot hold music at all. But a device holding
        audio files and *no* database is a different situation: those files are
        already invisible to the iPod, and writing an empty database over the
        top would make that permanent. That is somebody's music, so it refuses
        and says what it found rather than guessing.

        This was found on a real 5.5th gen that had been restored and never
        synced. It had never shown up in testing because a *simulated* iPod
        rebuilds its own database the moment it is connected, so every test in
        the suite starts from a device that already has one.
        """
        if self._handle is None:
            raise DeviceError("This device is not open.")
        if self.has_database:
            return False

        stranded = _count_audio_files(self.mount_path)
        if stranded:
            raise DeviceError(
                f"This iPod has {stranded} audio file(s) but no database, so the "
                "device cannot see them. Creating a new database would make that "
                "permanent, so nothing has been changed. Restore the iPod in "
                "iTunes to start cleanly, or copy those files off first."
            )

        from pypodlib.device.bootstrap import ensure_device_itunes_database

        try:
            created = ensure_device_itunes_database(str(self.mount_path), self._handle.info)
        except Exception as err:
            raise DeviceError(f"Could not set up a database on this iPod: {err}") from err

        if not created:
            # The library returns None rather than raising when it cannot sign a
            # database this device's firmware would accept. Saying so beats a
            # later failure that looks like a write error.
            raise DeviceError(
                "This iPod needs a signed database and the material to sign one "
                "could not be read from the device, so an empty database was not "
                "created. Restoring the iPod in iTunes puts that material back."
            )

        logger.info("Created an empty iTunesDB at %s", created)
        # The handle was opened against a device with no database and caches
        # that fact, so it is reopened rather than reused.
        self._handle = _connect(self.mount_path)
        return True

    # -- reading the library ------------------------------------------------

    def tracks(self, *, reload: bool = False) -> list[IpodTrack]:
        """Everything currently in the iPod's database.

        Includes tracks this tool never touched. The sync needs to see them:
        they occupy space, they must not be removed, and one of them may be the
        same recording the library is about to add.

        An iPod with no database yet holds no tracks, and that is the honest
        answer rather than an error - it lets a plan be worked out and shown
        before anything is written to a device being set up.
        """
        if not self.has_database:
            return []
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
                        artwork_id=int(track.get("artwork_id_ref") or 0),
                    )
                )
            except Exception:
                # One malformed row must not make the whole device unreadable.
                continue
        return found

    def playlist_contents(self) -> dict[str, list[str]]:
        """Each user playlist on the device, as name to track locations.

        Locations rather than ids, because that is what the rest of this
        application identifies a track by and the numeric ids are reassigned
        every time the database is written. Used to answer "has anything about
        the playlists changed" without writing anything.

        **A playlist counts as being on the device only if it is in both
        datasets.** The iPod reads MHSD 3 and this library's playlist list is
        MHSD 2 - see `_mirror_into_dataset_three`. Reporting a playlist that
        exists only in dataset 2 would make the sync decide nothing had changed
        and skip the write, leaving a device already in that state broken for
        good. Omitting it instead means the next sync repairs it.
        """
        if not self.has_database:
            return {}
        library = self._library()
        by_id = {t.db_track_id: t.location for t in library.tracks if t.location}
        mirrored = _dataset_three_counts(library)

        contents: dict[str, list[str]] = {}
        for playlist in library.playlists:
            if playlist.master:
                continue
            locations = [
                by_id[track_id] for track_id in playlist.track_ids if track_id in by_id
            ]
            if mirrored.get(playlist.name) != len(playlist.track_ids):
                logger.info(
                    "%r is missing from the dataset the iPod reads; it will be rewritten",
                    playlist.name,
                )
                continue
            contents[playlist.name] = locations
        return contents

    def playlist_names(self) -> list[str]:
        """User playlists, excluding the master playlist and the smart ones.

        The master playlist is the whole library and is maintained by the
        database writer; the smart playlists are the device's own Music, Movies
        and Podcasts categories. Neither is ours to write.
        """
        if not self.has_database:
            return []
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
        # Before rather than after. `add_tracks` commits the database itself, so
        # correcting the existing rows first folds the repair into that write
        # instead of needing a second full rewrite of the iTunesDB per batch.
        try:
            repair_filetypes(library)
        except Exception as err:  # pragma: no cover - defensive
            logger.warning("Could not correct the recorded track formats: %s", err)

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
            _mirror_into_dataset_three(library, playlist, ordered)

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

    def write_artwork(self, locations: list[str]) -> int:
        """Write the iPod's artwork database so covers appear on the device.

        Album art lives in two places on an iPod and both are needed. The file's
        own tags are what a computer reads, and this application writes those
        from the manifest. The *device* reads a separate database of pre-scaled
        images in ``iPod_Control/Artwork`` - so art embedded in a file but absent
        from that database is invisible on the iPod's screen, which looks exactly
        like the feature not working.

        ``locations`` names the tracks this tool manages. That restriction is the
        important part. pyPodLib converges the device to a final state: a track
        it is given a source file for has its art rebuilt from that file, and a
        track it is *not* given one for keeps whatever it already had. Handing it
        every track on the device would mean re-encoding artwork this tool never
        wrote - and clearing it outright for any track whose file has no embedded
        cover but whose art was put there by iTunes from some other source.

        Returns how many tracks ended up linked to an image.
        """
        if self._handle is None:
            raise DeviceError("This device is not open.")
        if not locations:
            return 0

        from pypodlib.artworkdb_writer import write_artworkdb

        library = self._library(reload=True)
        wanted = set(locations)

        # The artwork writer keys everything on db_track_id, and reads the art
        # out of the audio file itself - so the "PC source" it is given is the
        # copy already on the iPod, which carries the tags written from the
        # manifest. Nothing has to survive from the download.
        sources: dict[int, str] = {}
        rows = []
        for track in library.tracks:
            rows.append(track.data)
            if track.location in wanted and track.db_track_id:
                path = _file_for(self.mount_path, track.location)
                if path.is_file():
                    sources[track.db_track_id] = str(path)

        if not sources:
            return 0

        try:
            written = write_artworkdb(
                ipod_path=str(self.mount_path),
                tracks=rows,
                pc_file_paths=sources,
            )
        except Exception as err:
            raise DeviceError(f"Could not write the iPod's artwork database: {err}") from err

        # The images are on the device; the database rows still have to point at
        # them. These are the parsed field names, which differ from the ones the
        # library uses internally - `artwork_id_ref` is what becomes mhii_link.
        linked = 0
        for row in rows:
            info = written.get(int(row.get("db_track_id") or row.get("db_id") or 0))
            if not info:
                continue
            image_id, source_size = info
            row["artwork_id_ref"] = image_id
            row["artwork_count"] = 1
            row["artwork_size"] = source_size
            row["has_artwork"] = True
            linked += 1

        self._commit()
        return linked

    def eject(self) -> tuple[bool, str]:
        """Flush and unmount the device, so it is safe to unplug.

        The moment after a sync is exactly when an iPod gets pulled out of the
        socket, and it is the worst moment to do it: a freshly written database
        can still be sitting in the operating system's write cache. The library
        recognises a simulated device and declines to hand one to the operating
        system, which would otherwise unmount whatever real volume the folder
        happens to live on.

        Returns whether it worked and a message written to be shown as-is.
        """
        from pypodlib.device.eject import eject_ipod

        try:
            ok, message = eject_ipod(str(self.mount_path))
        except Exception as err:
            return False, f"Could not eject the iPod: {err}"

        if ok:
            return True, message

        # A reported failure is not always a failure that matters. Windows
        # ejects in two steps - dismount the volume, then tell the hardware it
        # may go - and something holding a handle for an instant (a search
        # indexer, a sync client) vetoes the second while the first has already
        # happened. Seen on the real device: the volume was flushed and gone,
        # and the tool still said it had not been ejected.
        #
        # What the user needs to know is whether anything can still write to the
        # iPod, so that is what gets checked rather than what was returned.
        if not self.mount_path.exists():
            return True, (
                "The iPod was flushed and unmounted, so it is safe to unplug. "
                "Windows did not confirm the final step, which is cosmetic."
            )
        return False, message

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
        # Every save re-serialises every row, so this is the moment a device
        # written by an older version heals - at no cost, in a write that was
        # happening anyway. A failure here must not take the commit with it:
        # not repairing leaves the device exactly as this tool used to leave it,
        # whereas not committing loses the tracks the run just copied.
        try:
            repair_filetypes(self._library())
        except Exception as err:  # pragma: no cover - defensive
            logger.warning("Could not correct the recorded track formats: %s", err)
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
    # The image this row points at in the iPod's artwork database, or 0. Art in
    # the file's own tags is invisible on the device without this, so it is the
    # only way to tell whether a track will actually show a cover.
    artwork_id: int = 0

    @property
    def has_artwork(self) -> bool:
        return self.artwork_id > 0


def _file_for(mount: Path, location: str) -> Path:
    """``:iPod_Control:Music:F00:ABCD.m4a`` to a real path on this machine."""
    parts = [p for p in location.split(":") if p]
    return Path(mount).joinpath(*parts)


def _dataset_three_counts(library: Any) -> dict[str, int]:
    """How many tracks each playlist has in the dataset the iPod reads."""
    inner = getattr(library, "_library", library)
    rows = getattr(inner, "_ds3", None) or []
    return {
        str(row.get("Title")): len(row.get("items") or [])
        for row in rows
        if not row.get("master_flag")
    }


def _mirror_into_dataset_three(library: Any, playlist: Any, ordered: list[int]) -> None:
    """Put a user playlist in the dataset the iPod actually reads.

    An iTunesDB carries its playlists twice. MHSD type 2 is the original list;
    type 3 is the one added for the 5th generation and read in preference to it
    by everything since. pypodlib's `create_playlist` appends only to type 2 -
    its own name for type 3 is "podcast playlists", which is what the field was
    first used for and not what it means now.

    The symptom is precise and was reported as "the playlist is not on the
    iPod": the database holds it, `playlist_names()` lists it, the music is all
    there, and the device's Playlists menu is empty. Measured on the real
    device, MHSD 3 held one entry - the master playlist - while MHSD 2 held
    three.

    So each user playlist is copied across by hand. The master is left alone:
    the database writer maintains it in both already.
    """
    inner = getattr(library, "_library", library)
    dataset_three = getattr(inner, "_ds3", None)
    if dataset_three is None or playlist.master:
        return

    name = playlist.name
    for row in dataset_three:
        if row.get("Title") == name:
            row["items"] = [{"db_track_id": int(v)} for v in ordered]
            row["mhip_child_count"] = len(ordered)
            return

    # Copied from the type 2 row rather than built fresh, so every field the
    # writer expects - the ids, the flags, the preferences blob - comes along
    # and only the dataset marker differs.
    mirrored = dict(playlist.data)
    mirrored["_mhsd_dataset_type"] = 3
    mirrored["items"] = [{"db_track_id": int(v)} for v in ordered]
    mirrored["mhip_child_count"] = len(ordered)
    dataset_three.append(mirrored)


# Every audio container an iPod will play. Used only to answer "is there music
# here that a new database would strand", so over-matching is the safe error.
_AUDIO_SUFFIXES = frozenset(
    {".mp3", ".m4a", ".m4b", ".m4p", ".aac", ".aif", ".aiff", ".wav", ".mp4", ".alac"}
)


# ---------------------------------------------------------------------------
# Telling the iPod what kind of file each track is
# ---------------------------------------------------------------------------
#
# Every row of the iTunesDB carries a four-character code naming the track's
# format - "M4A " for AAC, "MP3 " for MP3 - and a matching `mp3_flag`. It is how
# the iPod decides which decoder to hand the file to, and it is the one piece of
# metadata that has to agree with the bytes on disk.
#
# pypodlib 0.1.0 gets it wrong for everything except MP3, and the failure is a
# case mismatch between two of its own functions. `add_tracks` stages the value
# through `ipod_filetype_for_extension`, which returns `"m4a"`; the writer then
# resolves it through `track_dict_to_info`, which tests it against a list of
# capitalised needles with a plain `in`. `"M4A" in "m4a"` is False, every needle
# misses, and the function falls through to its `"mp3"` default.
#
# The result on a real device: an iPod told that 453 AAC files are MP3s. They
# play - the firmware recovers - but it is parsing an MP4 container as an MPEG
# frame stream, and where it resyncs on something that is not a frame header the
# output is a burst of noise. That is the screeching.
#
# Two things are needed. New rows must be staged with a spelling the writer
# recognises, which `_install_filetype_fix` does at source. Rows already on the
# device read back as "MP3" and are re-serialised on every save, so they stay
# wrong until something rewrites them - which `repair_filetypes` does, in memory,
# before a save this application was going to make anyway.
_FILETYPE_BY_SUFFIX = {
    # The value is not free-form: it is matched against pypodlib's own needle
    # list, so it has to be spelled the way that list expects rather than the
    # way the iTunesDB stores it. `test_device.py` asserts every line of this
    # map round-trips through pypodlib to the four-character code named below.
    ".mp3": "MP3",  # -> "MP3 "
    ".m4a": "M4A",  # -> "M4A "
    ".aac": "M4A",  # -> "M4A "  (AAC on an iPod is always in an MP4 container)
    ".alac": "M4A",  # -> "M4A "
    ".m4b": "Audiobook",  # -> "M4B "
    ".m4p": "Protected",  # -> "M4P "
    ".m4v": "M4V",  # -> "M4V "
    ".mov": "M4V",  # -> "M4V "
    ".mp4": "MP4",  # -> "MP4 "
    ".wav": "WAV",  # -> "WAV "
    ".aif": "AIFF",  # -> "AIFF"
    ".aiff": "AIFF",  # -> "AIFF"
}


def _filetype_for(location: str) -> str | None:
    """The database's format token for an on-device path, or None if unknown.

    None means "leave this row alone". A container this map has never heard of
    is one where guessing is worse than whatever is already recorded.
    """
    suffix = Path(location.replace(":", "/")).suffix.lower()
    return _FILETYPE_BY_SUFFIX.get(suffix)


def repair_filetypes(library: Any) -> int:
    """Correct every row whose recorded format disagrees with its file.

    Returns how many rows were changed, so a caller can tell whether a save is
    worth making. Idempotent: once a device has been healed this does nothing
    and costs one pass over the track list.

    Tracks this tool never added are repaired too. That is deliberate and it is
    not the ledger rule being broken - nothing is added, removed or moved, and
    an MP3 put there by iTunes is already recorded as an MP3 and will not be
    touched. A track mislabelled by some other tool gets the same fix.
    """
    changed = 0
    for track in library.tracks:
        location = track.location or ""
        if not location:
            continue
        wanted = _filetype_for(location)
        if wanted is None:
            continue
        current = str(track.get("filetype") or "")
        # Compared through pypodlib's own resolver rather than by string. "M4A"
        # and "AAC audio file" are different strings that mean the same code,
        # and rewriting one into the other every save would be churn.
        if _resolved_filetype(current) == _resolved_filetype(wanted):
            continue
        track["filetype"] = wanted
        changed += 1
    if changed:
        logger.info("Corrected the recorded format of %d track(s) on the device", changed)
    return changed


@lru_cache(maxsize=64)
def _resolved_filetype(value: str) -> str:
    """What pypodlib's writer would make of a row's ``filetype`` value.

    Cached because it is asked twice per track on every commit and the answer
    depends only on the string - a large library would otherwise build a
    throwaway TrackInfo a thousand times to learn the same dozen answers.
    """
    from pypodlib.sync._track_conversion import track_dict_to_info

    try:
        return str(track_dict_to_info({"filetype": value}).filetype)
    except Exception:  # pragma: no cover - defensive; the call is pure
        return ""


def _install_filetype_fix() -> None:
    """Make pypodlib stage new tracks with a format its own writer recognises.

    Reaching into a dependency is not something to do lightly, and this is the
    file where it belongs if it is done at all. The alternative was to let
    `add_tracks` write the wrong code and then rewrite the database a second
    time to correct it - a full iTunesDB rewrite per batch, on every sync,
    forever.

    The patch is applied only when the round-trip is actually broken, so the day
    pypodlib fixes this upstream it quietly stops doing anything instead of
    having to be found and removed.
    """
    from pypodlib.sync import _track_conversion as conversion

    if getattr(conversion, "_syncmypod_filetype_fix", False):
        return

    original = conversion.ipod_filetype_for_extension
    if _resolved_filetype(original(".m4a")) == "m4a":
        # Already correct. Nothing to do, and nothing left behind.
        conversion._syncmypod_filetype_fix = True
        return

    def corrected(extension: str) -> str:
        return _FILETYPE_BY_SUFFIX.get(
            "." + str(extension).casefold().lstrip("."), original(extension)
        )

    conversion.ipod_filetype_for_extension = corrected
    conversion._syncmypod_filetype_fix = True
    logger.debug("Applied the pypodlib track-format fix")


def _count_audio_files(mount: Path) -> int:
    """How many audio files sit in the iPod's music folders.

    The iPod stores music under ``iPod_Control/Music/F00``..``F49`` regardless of
    what the database says, so this answers the question the database cannot when
    there is no database to ask.
    """
    music = mount / "iPod_Control" / "Music"
    if not music.is_dir():
        return 0
    found = 0
    with contextlib.suppress(OSError):
        for path in music.rglob("*"):
            if path.suffix.lower() in _AUDIO_SUFFIXES and path.is_file():
                found += 1
    return found


def _connect(mount: Path) -> Any:
    """Open a mount point with pypodlib, as a pypodlib handle."""
    lib = _pypodlib()
    try:
        return lib.connect(mount)
    except Exception as err:
        raise DeviceError(
            f"{mount} does not look like an iPod: {err}. Point this at the "
            "drive's root - the folder containing iPod_Control."
        ) from err


def _pypodlib() -> Any:
    """Import pypodlib, turning a missing dependency into a clear message."""
    try:
        import pypodlib
    except Exception as err:  # pragma: no cover - environment-specific
        raise DependencyMissing(
            "pypodlib is not available, so the iPod cannot be read or written. "
            "Reinstall the application, or run: pip install 'pypodlib==0.1.0'"
        ) from err

    # Here because it is the one place every path into the library passes
    # through, and because it must be in place before the first track is staged.
    try:
        _install_filetype_fix()
    except Exception as err:  # pragma: no cover - defensive
        logger.warning("Could not apply the pypodlib track-format fix: %s", err)
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
    mount = Path(path)
    if not mount.exists():
        raise DeviceError(f"{mount} does not exist.")
    return _describe(_connect(mount))


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
