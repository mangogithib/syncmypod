"""A record, kept on the iPod itself, of what this tool put there.

The server knows what it *believes* is on a device, and the manifest reports it
as ``deviceState``. That is a good starting point and a bad source of truth: the
server cannot see the iPod, and between two syncs someone may have used iTunes,
deleted tracks from the device, or restored it outright. The API contract says
as much - trust ``deviceState``, then verify against the device.

Verifying needs an answer to "which row in the iTunesDB is library track 412?",
and the iTunesDB has nowhere to write a foreign identifier. Matching on title
and artist alone is close but not exact, and the case where it is wrong - two
different recordings with the same name - is the case where being wrong means
deleting the user's music.

So the mapping is written down, in a small file inside ``iPod_Control/Device``
where the device's own configuration lives. Keeping it on the iPod rather than
in this machine's config directory means a library synced from the desktop and
then from the laptop is still one history rather than two, which is the whole
premise of the pairing design.

The file is a convenience, never a dependency. Losing it costs a fuzzy match
against titles on the next run, not a broken sync.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

LEDGER_VERSION = 1
_RELATIVE_PATH = Path("iPod_Control") / "Device" / "SyncMyPod.json"

# Apostrophes are deleted rather than turned into a space, because "Don't Stop"
# and "Dont Stop" are the same track and a source will write either. Every other
# mark becomes a space, so "Rock&Roll" and "Rock & Roll" also agree.
#
# Written as code points rather than literals: the curly quotes are
# indistinguishable from a backtick in most editors, and a character set is not
# a place for a reader to have to guess.
_APOSTROPHE_CHARS = "'`" + chr(0x2018) + chr(0x2019) + chr(0x02BC)
_APOSTROPHES = re.compile(f"[{re.escape(_APOSTROPHE_CHARS)}]")
_NON_WORD = re.compile(r"[^\w\s]", re.UNICODE)


@dataclass(slots=True)
class Entry:
    """One track this tool knows about, and how to find it again."""

    track_id: int
    location: str
    title: str
    artist: str
    album: str
    format: str
    size: int
    added_at: str
    # Whether this file was recognised rather than written.
    #
    # A first sync to an iPod that already holds the library matches tracks on
    # title, artist and album and records them, so they are not downloaded a
    # second time. That is a claim about identity, not about ownership: the file
    # was put there by iTunes, or by another tool, or by this one before the
    # ledger existed. The module's governing rule is that nothing this tool did
    # not add is ever removed, so an adopted entry is remembered for the diff
    # and excluded from deletion. Writing the track properly later clears it.
    adopted: bool = False

    def as_json(self) -> dict[str, Any]:
        payload = {
            "location": self.location,
            "title": self.title,
            "artist": self.artist,
            "album": self.album,
            "format": self.format,
            "size": self.size,
            "addedAt": self.added_at,
        }
        # Only when true, so the common case stays the shape it always was and
        # a ledger written by an older version reads back identically.
        if self.adopted:
            payload["adopted"] = True
        return payload

    @property
    def fingerprint(self) -> str:
        """The fallback identity, for when the ledger is missing or stale."""
        return fingerprint(self.title, self.artist, self.album)


@dataclass(slots=True)
class Ledger:
    """The entries belonging to one library on one iPod."""

    path: Path
    library_key: str
    entries: dict[int, Entry] = field(default_factory=dict)
    _others: dict[str, Any] = field(default_factory=dict, repr=False)

    def record(
        self,
        track_id: int,
        *,
        location: str,
        track: dict[str, Any],
        file_format: str,
        size: int,
        adopted: bool = False,
    ) -> None:
        self.entries[int(track_id)] = Entry(
            track_id=int(track_id),
            location=location,
            title=str(track.get("title") or ""),
            artist=str(track.get("artist") or ""),
            album=str(track.get("album") or ""),
            format=file_format,
            size=int(size or 0),
            added_at=datetime.now(UTC).isoformat(timespec="seconds"),
            adopted=adopted,
        )

    def forget(self, track_id: int) -> None:
        self.entries.pop(int(track_id), None)

    def by_location(self) -> dict[str, Entry]:
        return {entry.location: entry for entry in self.entries.values()}

    def by_fingerprint(self) -> dict[str, Entry]:
        return {entry.fingerprint: entry for entry in self.entries.values()}

    def save(self) -> None:
        """Write the file, never failing a sync over it.

        A read-only or full device must not turn a successful sync into an
        error at the last step. The cost of losing this file is one fuzzy match
        next time, so a warning is the right response.
        """
        payload = dict(self._others)
        payload.update(
            {
                "version": LEDGER_VERSION,
                "updatedAt": datetime.now(UTC).isoformat(timespec="seconds"),
                "libraries": {
                    **(self._others.get("libraries") or {}),
                    self.library_key: {
                        "tracks": {
                            str(track_id): entry.as_json()
                            for track_id, entry in sorted(self.entries.items())
                        }
                    },
                },
            }
        )
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temp = self.path.with_suffix(".tmp")
            temp.write_text(json.dumps(payload, indent=1), encoding="utf-8")
            temp.replace(self.path)
        except OSError as err:
            logger.warning("Could not write the sync record to the iPod: %s", err)


def load(mount_path: Path, server_url: str, user_id: Any) -> Ledger:
    """Read the ledger for one library, or start an empty one.

    Entries for other libraries are carried through untouched, so an iPod shared
    between two accounts keeps both histories rather than the second sync
    erasing the first.
    """
    path = Path(mount_path) / _RELATIVE_PATH
    key = library_key(server_url, user_id)

    raw: dict[str, Any] = {}
    if path.exists():
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                raw = loaded
        except (OSError, json.JSONDecodeError) as err:
            # A corrupt ledger is not worth stopping for. It degrades to the
            # fingerprint match, which is what would happen without one at all.
            logger.warning("Ignoring an unreadable sync record at %s: %s", path, err)

    entries: dict[int, Entry] = {}
    stored = ((raw.get("libraries") or {}).get(key) or {}).get("tracks") or {}
    for track_id, value in stored.items():
        try:
            entries[int(track_id)] = Entry(
                track_id=int(track_id),
                location=str(value.get("location") or ""),
                title=str(value.get("title") or ""),
                artist=str(value.get("artist") or ""),
                album=str(value.get("album") or ""),
                format=str(value.get("format") or ""),
                size=int(value.get("size") or 0),
                added_at=str(value.get("addedAt") or ""),
                adopted=bool(value.get("adopted")),
            )
        except (TypeError, ValueError):
            continue

    return Ledger(path=path, library_key=key, entries=entries, _others=raw)


def library_key(server_url: str, user_id: Any) -> str:
    """Identifies one account on one server, so two libraries can share an iPod."""
    return f"{str(server_url).rstrip('/')}#{user_id}"


def fingerprint(title: str, artist: str, album: str) -> str:
    """The fallback identity for a track, from what the iTunesDB actually stores.

    Deliberately loose about punctuation and case, which differ between a tag
    written here and one written by iTunes, and strict about the three fields
    together, since any one of them alone collides constantly.
    """
    parts = [_normalise(title), _normalise(artist), _normalise(album)]
    return "\x1f".join(parts)


def _normalise(value: str) -> str:
    without_apostrophes = _APOSTROPHES.sub("", str(value or ""))
    return " ".join(_NON_WORD.sub(" ", without_apostrophes).lower().split())
