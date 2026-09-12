"""Pushing the YouTube library to the server.

Three steps, and the middle one is why they are separate:

    1. Read the account's playlists here and send the list.
    2. The server says which of them the user ticked in the web interface.
    3. Read those, and only those, and send their contents.

Sending everything up front would mean walking a whole YouTube account to import
two playlists. The user's choice sits in the middle, so the expensive read
happens after it rather than before.

Nothing here downloads audio and nothing here decides metadata. A video title
goes up as a hint; the server resolves it against a real catalogue, and a track
no catalogue recognises is stored with its title and nothing else. That rule is
enforced server-side precisely so that no client can bypass it.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

from . import ytlibrary
from .api import ApiError, DeviceApi

logger = logging.getLogger(__name__)


@dataclass
class LibraryReport:
    """What a push did, in the terms the user cares about."""

    playlists_found: int = 0
    playlists_followed: int = 0
    tracks_sent: int = 0
    warnings: list[str] = field(default_factory=list)
    failures: list[str] = field(default_factory=list)

    @property
    def needs_choosing(self) -> bool:
        """Playlists were found, but none are ticked yet."""
        return self.playlists_found > 0 and self.playlists_followed == 0

    def describe(self) -> str:
        if self.needs_choosing:
            return (
                f"Found {self.playlists_found} playlists. Choose which to follow in "
                "the web interface, then sync again."
            )
        parts = [
            f"{self.playlists_followed} playlist"
            f"{'' if self.playlists_followed == 1 else 's'} followed",
            f"{self.tracks_sent} track{'' if self.tracks_sent == 1 else 's'} sent",
        ]
        if self.failures:
            parts.append(f"{len(self.failures)} failed")
        return ", ".join(parts) + "."


def push_library(
    api: DeviceApi,
    *,
    on_progress=None,
) -> LibraryReport:
    """Read the YouTube library and hand it to the server.

    ``on_progress`` is called with a short sentence before each slow step, so a
    GUI can say what is happening rather than showing a spinner for a minute.
    """
    report = LibraryReport()
    say = on_progress or (lambda _message: None)

    say("Reading your YouTube playlists...")
    snapshot = ytlibrary.read_library()
    report.playlists_found = len(snapshot.playlists)
    report.warnings.extend(snapshot.warnings)

    say(f"Sending {report.playlists_found} playlists to the server...")
    answer = api.push_youtube_library([item.as_payload() for item in snapshot.playlists])

    wanted = {str(entry) for entry in (answer.get("selected") or [])}
    report.playlists_followed = len(wanted)
    if not wanted:
        # Not a failure. A first run always lands here, because nothing can be
        # ticked before the list exists.
        return report

    # The names are wanted for progress messages, and the server has them
    # already, so they are asked for rather than carried through.
    titles = {
        str(entry.get("youtubeId")): str(entry.get("title") or entry.get("youtubeId"))
        for entry in api.selected_youtube_playlists()
    }

    for index, youtube_id in enumerate(sorted(wanted), start=1):
        title = titles.get(youtube_id, youtube_id)
        say(f"Reading {title} ({index} of {len(wanted)})...")
        try:
            entries = ytlibrary.read_playlist(youtube_id)
        except ytlibrary.LibraryError as err:
            # One unreadable playlist must not lose the others. A liked list can
            # be enormous and occasionally rate limited where a small playlist
            # succeeds seconds later.
            report.failures.append(f"{title}: {err}")
            continue

        say(f"Sending {len(entries)} tracks from {title}...")
        try:
            api.push_youtube_playlist(youtube_id, [entry.as_payload() for entry in entries])
        except ApiError as err:
            report.failures.append(f"{title}: {err}")
            continue

        report.tracks_sent += len(entries)

    return report
