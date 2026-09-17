"""The sync run: what should be on the iPod, made to be on the iPod.

Everything else in this package does one thing - talk to the server, find audio,
tag it, convert it, write the database. This decides the order, what to skip,
what to do when a step fails, and what to tell the server.

Three properties shape the design.

**It must be safe to interrupt.** A sync is minutes of downloading over a home
connection, and it will be cancelled, lose its network, or have the iPod pulled
out of the socket. So results are reported as they happen rather than at the
end, the database is committed in batches rather than once, and every run starts
by taking a backup. The next run picks up where this one stopped.

**It must never remove something it did not add.** The iPod may well hold music
put there by iTunes years ago. This tool knows precisely which tracks are its
own - it wrote them down - and everything else is left exactly where it is.

**Nothing downloaded outlives the run.** Each track's files are deleted the
moment it has been written to the device, and the whole workspace goes when the
run ends, whether or not it ended well.
"""

from __future__ import annotations

import logging
import shutil
from collections.abc import Callable
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx

from . import config as config_module
from . import device as device_module
from . import downloader, ledger, tagging, transcode, workspace, youtube
from .api import ApiError, DeviceApi

logger = logging.getLogger(__name__)

# How many tracks are written to the device between database commits. Each
# commit rewrites the whole iTunesDB, so one per track would be slow on a large
# library; one per run would mean an interrupted sync left every track it had
# already copied invisible to the device.
DEFAULT_BATCH_SIZE = 5

# How many tracks are fetched at once.
#
# Downloading, converting and tagging a track touches nothing another track
# touches - a directory of its own, its own yt-dlp call - so the slow part of a
# sync parallelises cleanly. Only the write to the iPod has to stay serialised,
# and it already happens a batch at a time.
#
# Four, not sixteen. The limit here is YouTube rather than this machine: a run
# on 12 September took a `403 Forbidden` after eighteen downloads in quick
# succession, and asking for more at once is asking for more of those. Four is
# roughly a three-fold speed-up on a large library while still looking like
# somebody using a browser.
DEFAULT_CONCURRENCY = 4

# Below this, the sync stops rather than filling the device completely. An iPod
# with no free space cannot rewrite its own database, which is a much worse
# state to be in than one track short.
FREE_SPACE_FLOOR_BYTES = 200 * 1024 * 1024


class SyncError(Exception):
    """A sync that cannot continue, phrased for a user."""


Progress = Callable[[str, dict[str, Any]], None]


@dataclass(slots=True)
class TrackPlan:
    """One manifest track and what the run intends to do with it."""

    track: dict[str, Any]

    @property
    def id(self) -> int:
        return int(self.track["id"])

    @property
    def label(self) -> str:
        return (
            f"{self.track.get('artist') or 'Unknown'} - {self.track.get('title') or 'Untitled'}"
        )


@dataclass(slots=True)
class Removal:
    """A track this tool put on the device that the library no longer holds."""

    track_id: int
    location: str
    label: str


@dataclass(slots=True)
class Plan:
    """What a run would do, worked out before anything is written."""

    device: device_module.IpodDevice
    to_download: list[TrackPlan] = field(default_factory=list)
    already_present: list[TrackPlan] = field(default_factory=list)
    adopted: list[TrackPlan] = field(default_factory=list)
    removals: list[Removal] = field(default_factory=list)
    playlists: list[tuple[str, list[int]]] = field(default_factory=list)
    excluded: list[dict[str, Any]] = field(default_factory=list)
    manifest: dict[str, Any] = field(default_factory=dict)
    # Tracks already on the device whose covers would not show on its screen,
    # because nothing points at an image in the iPod's artwork database. Counts
    # as work: a library synced before artwork was implemented should pick it up
    # without having to be downloaded again.
    artwork_missing: list[str] = field(default_factory=list)
    # Whether the device's playlists already match the library's. Adding or
    # removing a song from a playlist is a change worth syncing even when every
    # track involved is already on the iPod, and before this was worked out a
    # run in that state reported "Already up to date" and wrote nothing.
    playlists_differ: bool = False
    # Tracks on the device whose recorded tags no longer match the library -
    # an artist corrected in the web tool, an album finally resolved. Counts as
    # work for the same reason missing artwork does: a correction nobody has to
    # re-download should still reach the iPod. See _retag_existing.
    tags_stale: list[str] = field(default_factory=list)

    @property
    def nothing_to_do(self) -> bool:
        return (
            not self.to_download
            and not self.removals
            and not self.artwork_missing
            and not self.playlists_differ
            and not self.tags_stale
        )


@dataclass(slots=True)
class Result:
    """The outcome for one track, in the shape the server records."""

    track_id: int
    state: str
    label: str
    format: str | None = None
    bitrate: int | None = None
    file_size: int | None = None
    source_used: str | None = None
    error: str | None = None
    # Where it landed on the device. Local bookkeeping, never sent to the
    # server - it is how the artwork step finds the tracks this run added.
    location: str | None = None

    def as_payload(self) -> dict[str, Any]:
        payload: dict[str, Any] = {"trackId": self.track_id, "state": self.state}
        for key, value in (
            ("format", self.format),
            ("bitrate", self.bitrate),
            ("fileSize", self.file_size),
            ("sourceUsed", self.source_used),
            ("error", self.error),
        ):
            if value is not None:
                payload[key] = value
        return payload


@dataclass(slots=True)
class Report:
    """Everything a run did, for the CLI, the GUI, and the log."""

    plan: Plan
    results: list[Result] = field(default_factory=list)
    removed: int = 0
    playlists_written: int = 0
    artwork_linked: int = 0
    artwork_error: str | None = None
    # Tracks already on the device whose recorded tags were brought back in
    # line with the library. Almost always zero - see _retag_existing.
    retagged: int = 0
    backup_id: str | None = None
    # False only when the user turned backups off. Carried so the summary can
    # say so rather than leaving "no backup id" to be read as a failure.
    backed_up: bool = True
    run_id: int | None = None
    status: str = "done"
    message: str | None = None

    @property
    def synced(self) -> int:
        return sum(1 for r in self.results if r.state == "synced")

    @property
    def failed(self) -> list[Result]:
        return [r for r in self.results if r.state == "failed"]

    def stats(self) -> dict[str, int]:
        return {"synced": self.synced, "failed": len(self.failed), "removed": self.removed}


# ---------------------------------------------------------------------------
# Planning
# ---------------------------------------------------------------------------


def build_plan(
    ipod: device_module.IpodDevice,
    manifest: dict[str, Any],
    record: ledger.Ledger,
) -> Plan:
    """Work out what is missing, without touching anything.

    The server's ``deviceState`` is a hint, not evidence - it cannot see the
    iPod, and the device may have been restored or edited with iTunes since. So
    the diff is made against what is actually in the iPod's database, using the
    record this tool keeps on the device itself, and falling back to matching on
    title, artist and album when that record is missing or predates it.
    """
    plan = Plan(device=ipod, manifest=manifest)
    plan.excluded = list(manifest.get("excluded") or [])

    on_device = ipod.tracks()
    locations = {track.location for track in on_device if track.location}
    by_fingerprint = {
        ledger.fingerprint(track.title, track.artist, track.album): track for track in on_device
    }

    for raw in manifest.get("tracks") or []:
        item = TrackPlan(track=raw)
        entry = record.entries.get(item.id)

        if entry and entry.location in locations:
            plan.already_present.append(item)
            continue

        # Either this tool has no record of the track, or its record points at a
        # file the device no longer has. Fall back to matching what is written
        # in the tags. The match has to be exact across all three fields: title
        # alone collides constantly, and a wrong match here would mean a track
        # silently never syncing.
        match = by_fingerprint.get(
            ledger.fingerprint(
                str(raw.get("title") or ""),
                str(raw.get("artist") or ""),
                str(raw.get("album") or ""),
            )
        )
        if match is not None:
            # Already there, just unrecorded - adopt it rather than downloading a
            # second copy. This is what makes the first sync to an iPod that
            # already holds the library do almost no work.
            record.record(
                item.id,
                location=match.location,
                track=raw,
                file_format=Path(match.location).suffix.lstrip(".").lower(),
                size=0,
            )
            plan.adopted.append(item)
            continue

        plan.to_download.append(item)

    wanted_ids = {int(t["id"]) for t in manifest.get("tracks") or []}
    for track_id, entry in record.entries.items():
        if track_id not in wanted_ids and entry.location in locations:
            plan.removals.append(
                Removal(
                    track_id=track_id,
                    location=entry.location,
                    label=f"{entry.artist or 'Unknown'} - {entry.title or 'Untitled'}",
                )
            )

    by_location = {track.location: track for track in on_device if track.location}
    plan.tags_stale = _stale_tag_locations(manifest, record, by_location)
    plan.artwork_missing = [
        entry.location
        for track_id, entry in record.entries.items()
        if track_id in wanted_ids
        and entry.location in by_location
        and not by_location[entry.location].has_artwork
    ]

    plan.playlists = [
        (str(p.get("name") or "Untitled"), [int(t) for t in p.get("trackIds") or []])
        for p in manifest.get("playlists") or []
    ]

    # Whether the playlists on the device already say what the library says.
    #
    # A song added to or removed from a playlist is a real change even when
    # every track involved is already on the iPod, and without this the run
    # reported "Already up to date" and wrote nothing - which is exactly the
    # state somebody reorganising playlists is in.
    #
    # Compared by name and by the order of the locations, because order is part
    # of what a playlist is.
    if plan.playlists:
        try:
            on_device = ipod.playlist_contents()
        except device_module.DeviceError:
            # Never fail planning over this; assume a write is needed.
            plan.playlists_differ = True
        else:
            for name, locations in _playlist_specs(plan, record):
                if on_device.get(name) != locations:
                    plan.playlists_differ = True
                    break

    return plan


# ---------------------------------------------------------------------------
# Running
# ---------------------------------------------------------------------------


def run(
    stored: config_module.Config,
    *,
    mount: str | None = None,
    dry_run: bool = False,
    remove: bool = False,
    limit: int | None = None,
    batch_size: int = DEFAULT_BATCH_SIZE,
    concurrency: int = DEFAULT_CONCURRENCY,
    keep_downloads: bool = False,
    backup: bool | None = None,
    progress: Progress | None = None,
    cancel: Callable[[], bool] | None = None,
) -> Report:
    """Sync the library to the attached iPod.

    ``dry_run`` computes the plan and stops - the safe way to see what a sync
    would do before letting it. ``limit`` caps how many tracks are downloaded,
    which is how a first run against a large library is kept short enough to
    watch.

    ``backup`` overrides the stored preference for this run only; None uses it.
    Turning it off is supported and is not recommended - see ``Config``.

    ``cancel`` is polled between tracks. Stopping there rather than immediately
    means the database is never interrupted part-written and everything already
    copied stays usable, which is the difference between cancelling a sync and
    damaging one.
    """
    say = progress or (lambda event, data: None)
    stop = cancel or (lambda: False)

    if not stored.is_paired:
        raise SyncError(
            "This computer is not paired with a library. Run: syncmypod pair <server> <code>"
        )

    # A saved YouTube session goes stale on its own, and a stale one is refused
    # rather than downgraded - so a run weeks after the last one would quietly
    # lose the Premium stream it was set up for. Renewed here, silently, from
    # the browser profile the sign-in kept: no window, no password, and no
    # consequence at all if it cannot be done.
    if youtube.ensure_fresh():
        say("youtube-refreshed", {})

    with DeviceApi(stored.server_url, stored.token) as api:
        say("hello", {})
        hello = api.hello()
        user_id = (hello.get("user") or {}).get("id")

        ipod = _detect(mount)
        say("device", {"device": ipod})

        try:
            api.report_device(
                ipod.as_report() | {"appVersion": _version(), "platform": _platform()}
            )
        except ApiError as err:
            # Reporting the device is bookkeeping for the web UI. Losing it
            # should not stop a sync that can otherwise run.
            logger.warning("Could not report the device to the server: %s", err)

        say("manifest", {})
        manifest = api.manifest()

        record = ledger.load(ipod.mount_path, stored.server_url, user_id)
        plan = build_plan(ipod, manifest, record)
        if limit is not None and limit >= 0:
            plan.to_download = plan.to_download[:limit]
        say("plan", {"plan": plan})

        report = Report(plan=plan)

        if dry_run:
            report.status = "cancelled"
            report.message = "Dry run - nothing was written."
            return report

        if plan.nothing_to_do and not plan.adopted:
            report.message = "Already up to date."
            return report

        # A restored iPod has no database until something writes music to it,
        # and every read above treats that as "no tracks" rather than failing.
        # This is the point where it has to become real, and it comes before the
        # backup because there is nothing to back up until it exists.
        if not ipod.has_database:
            say("database", {})
            ipod.ensure_database()

        # Before anything is written. pypodlib is alpha and this is the one
        # operation that can leave a device unusable, so the default is on and
        # a failed backup stops the run. Turning it off is a deliberate choice
        # the user has made, and it is recorded in the report and the log rather
        # than passing silently - "I never turned that off" is exactly the thing
        # somebody says after losing a device.
        take_backup = stored.backup_before_sync if backup is None else backup
        if take_backup:
            say("backup", {})
            report.backup_id = _backup(ipod)
        else:
            logger.warning("Backups are turned off - nothing was snapshotted before this sync")
            report.backed_up = False
            say("backup-skipped", {})

        report.run_id = api.start_run(
            planned=len(plan.to_download) + len(plan.removals),
            to_download=len(plan.to_download),
            to_remove=len(plan.removals) if remove else 0,
        )

        try:
            _execute(
                api,
                ipod,
                plan,
                record,
                report,
                say,
                batch_size,
                remove,
                keep_downloads,
                stop,
                concurrency,
            )
        except KeyboardInterrupt:
            report.status = "cancelled"
            report.message = "Interrupted. What had already been written is on the iPod."
            _finish(api, report)
            raise
        except Exception as err:
            report.status = "error"
            report.message = str(err)
            _finish(api, report)
            raise
        else:
            _finish(api, report)

        return report


def _execute(
    api: DeviceApi,
    ipod: device_module.IpodDevice,
    plan: Plan,
    record: ledger.Ledger,
    report: Report,
    say: Progress,
    batch_size: int,
    remove: bool,
    keep_downloads: bool,
    stop: Callable[[], bool],
    concurrency: int = DEFAULT_CONCURRENCY,
) -> None:
    """Download in parallel, then write to the device a batch at a time.

    The two halves are deliberately different shapes. Fetching a track is
    network-bound, touches only its own directory, and is the part that takes
    the time - so several run at once. Writing to the iPod rewrites the whole
    database and must happen on one thread, in order, a batch at a time.

    So this keeps ``concurrency`` fetches in flight and drains them as they
    finish. Completion order is not plan order and does not need to be: every
    result carries its own track id, and the device write is what imposes an
    order.
    """
    with (
        workspace.Workspace(keep=keep_downloads) as work,
        httpx.Client(timeout=20.0, follow_redirects=True) as artwork_client,
        ThreadPoolExecutor(max_workers=max(1, concurrency)) as pool,
    ):
        pending: list[Result] = []
        staged: list[tuple[TrackPlan, Path, Result]] = []
        queue = list(plan.to_download)
        total = len(queue)
        in_flight: dict[Future, TrackPlan] = {}
        done_count = 0
        cancelled = False
        out_of_space = False
        blocked: str | None = None

        def submit_until_full() -> None:
            nonlocal cancelled, out_of_space
            while queue and len(in_flight) < max(1, concurrency):
                if blocked:
                    return
                if stop():
                    cancelled = True
                    return
                # Checked before starting a track rather than during one, so
                # what is already staged still gets written and recorded below.
                if _free_bytes(ipod) < FREE_SPACE_FLOOR_BYTES:
                    out_of_space = True
                    return
                item = queue.pop(0)
                in_flight[pool.submit(_prepare_one, item, work, artwork_client)] = item

        submit_until_full()

        while in_flight:
            finished, _ = wait(set(in_flight), return_when=FIRST_COMPLETED)
            for future in finished:
                item = in_flight.pop(future)
                done_count += 1
                # Reported on completion rather than on start: with several in
                # flight at once, "starting track 7" while 4, 5 and 6 are still
                # running is a count of nothing in particular.
                say("track", {"index": done_count, "total": total, "item": item})
                try:
                    prepared, result = future.result()
                except downloader.BlockedError as err:
                    # Not this track's problem: YouTube has stopped serving this
                    # machine entirely, so every remaining track would fail the
                    # same way and take an hour doing it. Stop and say so, and
                    # keep what already downloaded.
                    blocked = str(err)
                    logger.warning("YouTube is refusing this machine: %s", err)
                    pending.append(
                        Result(
                            track_id=item.id,
                            state="failed",
                            label=item.label,
                            error=str(err)[:500],
                        )
                    )
                    work.discard(item.id)
                    say("track-failed", {"item": item, "error": str(err)})
                    continue
                except Exception as err:  # a failed track must not end the run
                    logger.warning("%s failed: %s", item.label, err)
                    pending.append(
                        Result(
                            track_id=item.id,
                            state="failed",
                            label=item.label,
                            error=str(err)[:500],
                        )
                    )
                    work.discard(item.id)
                    say("track-failed", {"item": item, "error": str(err)})
                    continue

                staged.append((item, prepared, result))
                say("track-ready", {"item": item, "result": result})

            if len(staged) >= batch_size:
                pending.extend(_commit_batch(ipod, record, staged, work, say))
                staged.clear()
                pending = _flush(api, report, pending)

            submit_until_full()

        remaining = len(queue)
        if blocked:
            report.status = "error"
            report.message = f"Stopped with {remaining} track(s) left. {blocked}"
        elif cancelled:
            report.status = "cancelled"
            report.message = (
                f"Cancelled with {remaining} track(s) left. "
                "What had already been written is on the iPod."
            )
        elif out_of_space:
            report.message = f"Stopped with {remaining} tracks left: the iPod is nearly full."
            logger.warning(report.message)

        if staged:
            pending.extend(_commit_batch(ipod, record, staged, work, say))
            staged.clear()
        _flush(api, report, pending, force=True)

    # Playlists after every track, so a playlist never references something that
    # failed to download.
    if plan.playlists:
        say("playlists", {"count": len(plan.playlists)})
        report.playlists_written = _write_playlists(ipod, plan, record)

    # Everything already on the device, brought up to date - see below for why
    # a track's tags go stale at all. Never fatal, for the same reason artwork
    # is not: the music is on the iPod, and failing a sync over a tag would be
    # the wrong trade.
    try:
        report.retagged = _retag_existing(ipod, plan, record, say)
    except Exception as err:  # pragma: no cover - defensive
        logger.warning("Could not correct the tags already on the device: %s", err)

    # Artwork last, and never fatal. A cover is decoration: a sync that got the
    # music onto the device has done its job, and failing it at the final step
    # over a picture would be the wrong trade.
    #
    # Only the tracks that need it are passed. Every other track on the device
    # keeps the artwork it already has, so this costs one image decode per track
    # that gained one rather than a full re-encode of the library every run.
    needs_artwork = sorted(
        {r.location for r in report.results if r.state == "synced" and r.location}
        | set(plan.artwork_missing)
    )
    if needs_artwork:
        say("artwork", {"count": len(needs_artwork)})
        try:
            report.artwork_linked = ipod.write_artwork(needs_artwork)
        except device_module.DeviceError as err:
            logger.warning("Could not write the artwork database: %s", err)
            report.artwork_error = str(err)

    if remove and plan.removals:
        say("removing", {"count": len(plan.removals)})
        report.removed = ipod.remove_locations([r.location for r in plan.removals])
        removed_results = []
        for removal in plan.removals:
            record.forget(removal.track_id)
            removed_results.append(
                Result(track_id=removal.track_id, state="removed", label=removal.label)
            )
        report.results.extend(removed_results)
        _report(api, report, removed_results)
    elif plan.removals:
        logger.info(
            "%d track(s) are on the iPod but no longer in the library. "
            "Run with --remove to delete them.",
            len(plan.removals),
        )

    record.save()
    ipod.refresh_free_space()


def _prepare_one(
    item: TrackPlan, work: workspace.Workspace, artwork_client: httpx.Client
) -> tuple[Path, Result]:
    """Download one track, convert it if needed, and tag it from the manifest.

    The order matters. Converting before tagging, because ffmpeg does not carry
    every tag across and a re-encode would drop what had just been written.
    Tagging last, so the file that reaches the iPod carries the server's
    metadata and nothing the source put there.
    """
    directory = work.track_dir(item.id)

    download = downloader.fetch(item.track, directory)
    converted = transcode.prepare(download.path, directory)

    artwork = tagging.fetch_artwork(item.track.get("artworkUrl"), client=artwork_client)
    tagging.apply(converted.path, item.track, artwork)

    return converted.path, Result(
        track_id=item.id,
        state="synced",
        label=item.label,
        format=converted.format,
        bitrate=download.bitrate_kbps,
        file_size=converted.path.stat().st_size,
        source_used=download.source,
    )


@dataclass(slots=True)
class MatchReport:
    """What a match check found, for the CLI and the GUI."""

    checked: int = 0
    found: int = 0
    missing: list[tuple[str, str]] = field(default_factory=list)
    skipped: int = 0
    status: str = "done"
    message: str | None = None


def check_matches(
    stored: config_module.Config,
    *,
    limit: int | None = None,
    concurrency: int = DEFAULT_CONCURRENCY,
    progress: Progress | None = None,
    cancel: Callable[[], bool] | None = None,
) -> MatchReport:
    """Find out which tracks have audio available, without downloading any.

    **Why this exists.** Until now the only way to discover that a song could
    not be found was to run a whole sync with the iPod plugged in and read the
    failures afterwards - minutes of downloading before the first bad news. The
    search is the cheap half of a sync and needs no device at all, so it can be
    run on its own and the answer sent to the server, where the web tool shows
    it per track.

    **Why it runs here and not on the server.** Searching from the server would
    be the obvious design and it does not work: a home connection was blocked
    after one large sync on 13 September, with every search returning the bot
    check, and a datacentre address is what that check is aimed at. The only
    known remedy is a signed-in session, which would mean a Google credential on
    a public box. So the searching stays on this machine and only the result
    travels.

    A track that already has a ``sourceHint`` is skipped: somebody has already
    said where the audio is, and confirming it would cost a search to learn
    nothing.
    """
    say = progress or (lambda event, data: None)
    stop = cancel or (lambda: False)

    if not stored.is_paired:
        raise SyncError(
            "This computer is not paired with a library. Run: syncmypod pair <server> <code>"
        )

    report = MatchReport()

    with DeviceApi(stored.server_url, stored.token) as api:
        say("hello", {})
        api.hello()

        manifest = api.manifest()
        tracks = list(manifest.get("tracks") or [])
        queue = [t for t in tracks if not (t.get("sourceHint") or "").strip()]
        report.skipped = len(tracks) - len(queue)
        if limit is not None:
            queue = queue[:limit]

        say("checking", {"total": len(queue), "skipped": report.skipped})
        if not queue:
            report.message = "Every track already has a source link."
            return report

        # The same fan-out the download path uses, and for the same reason: a
        # search is mostly waiting. Four, not sixteen - this is the operation
        # that got a machine bot-checked in the first place, so it must not look
        # more like a robot than a sync already does.
        results: list[dict[str, Any]] = []
        with ThreadPoolExecutor(max_workers=max(1, concurrency)) as pool:
            in_flight: dict[Future, dict[str, Any]] = {}
            pending = list(queue)

            def fill() -> None:
                while pending and len(in_flight) < max(1, concurrency):
                    item = pending.pop(0)
                    in_flight[pool.submit(_best_match, item)] = item

            fill()
            while in_flight:
                if stop():
                    report.status = "cancelled"
                    report.message = "Stopped before the rest were checked."
                    break
                done, _ = wait(list(in_flight), return_when=FIRST_COMPLETED)
                for future in done:
                    item = in_flight.pop(future)
                    label = _label(item)
                    report.checked += 1
                    try:
                        candidate = future.result()
                    except downloader.BlockedError as err:
                        # The bot check. Every remaining search would fail the
                        # same way, so stopping and saying so beats reporting a
                        # hundred tracks as unfindable when they are not.
                        report.status = "blocked"
                        report.message = str(err)
                        pending.clear()
                        in_flight.clear()
                        break
                    except Exception as err:  # pragma: no cover - yt-dlp raises broadly
                        logger.info("Could not check %s: %s", label, err)
                        candidate = None

                    if candidate is not None:
                        report.found += 1
                        results.append({"trackId": item["id"], "sourceUrl": candidate.url})
                        say("match", {"label": label, "url": candidate.url})
                    else:
                        report.missing.append((label, "no usable result"))
                        results.append({"trackId": item["id"], "sourceUrl": None})
                        say("no-match", {"label": label})
                fill()

        if results:
            say("reporting", {"count": len(results)})
            # In batches, because the server caps one request at 500 and a
            # cancelled check should still have recorded what it learned.
            for start in range(0, len(results), 500):
                api.report_matches(results[start : start + 500])

    return report


def _label(track: dict[str, Any]) -> str:
    """ "Artist - Title" for a raw manifest track, for logs and progress."""
    return f"{track.get('artist') or 'Unknown'} - {track.get('title') or 'Untitled'}"


def _best_match(track: dict[str, Any]) -> downloader.Candidate | None:
    """The top-scoring search result for a track, or None.

    Deliberately the same `downloader.search` a real sync uses, scoring and all,
    so the answer this reports is the answer a sync would act on. A separate,
    simpler check would be able to disagree with the thing it is predicting.
    """
    candidates = downloader.search(track)
    return candidates[0] if candidates else None


def _commit_batch(
    ipod: device_module.IpodDevice,
    record: ledger.Ledger,
    staged: list[tuple[TrackPlan, Path, Result]],
    work: workspace.Workspace,
    say: Progress,
) -> list[Result]:
    """Write a batch to the device, then delete what it was written from.

    **One bad file must not end the run.** `add_files` writes the batch and
    commits the database in a single call, so anything it refuses takes the
    whole batch with it - and on 12 September that ended a 431-track sync after
    45, because one downloaded file was no longer on disk when its turn came.
    An hour of downloading thrown away over one track is the wrong trade.

    So the batch is tried, and if it fails the files are written one at a time:
    whatever is wrong then fails alone and is reported as a failed track, which
    is what the web tool already knows how to show.
    """
    say("writing", {"count": len(staged)})

    # Checked first because it is the failure that actually happened, it is
    # cheap, and it gives a better message than the library's - which is the
    # bare path with no word about what is wrong with it.
    usable: list[tuple[TrackPlan, Path, Result]] = []
    results: list[Result] = []
    for item, path, result in staged:
        if path.exists():
            usable.append((item, path, result))
            continue
        logger.warning("%s: the downloaded file is gone before writing", item.label)
        results.append(
            Result(
                track_id=item.id,
                state="failed",
                label=item.label,
                error="The downloaded file disappeared before it could be written.",
            )
        )

    landed = _write_batch(ipod, usable, say)

    for item, path, result in usable:
        location = landed.get(str(path.resolve()))
        if not location:
            # The file was handed over and the device did not report taking it.
            # Reporting it as synced would mean the next run skipping a track
            # that is not there.
            results.append(
                Result(
                    track_id=item.id,
                    state="failed",
                    label=item.label,
                    error="The iPod did not accept this file.",
                )
            )
            continue
        record.record(
            item.id,
            location=location,
            track=item.track,
            file_format=result.format or "",
            size=result.file_size or 0,
        )
        result.location = location
        results.append(result)

    # The rule the architecture rests on: nothing downloaded outlives the sync.
    # Per track rather than at the end, so peak disk use stays at one batch.
    for item, _path, _result in staged:
        work.discard(item.id)

    return results


def _write_batch(
    ipod: device_module.IpodDevice,
    staged: list[tuple[TrackPlan, Path, Result]],
    say: Progress,
) -> dict[str, str]:
    """Hand the batch to the device, falling back to one file at a time.

    Returns the source-path to device-location map, with anything the device
    would not take simply absent - the caller already treats a missing entry as
    a failed track.
    """
    if not staged:
        return {}

    paths = [path for _item, path, _result in staged]
    try:
        return ipod.add_files(paths)
    except device_module.DeviceError as err:
        if len(paths) == 1:
            logger.warning("%s: %s", staged[0][0].label, err)
            return {}
        logger.warning(
            "Writing %d track(s) together failed (%s); trying them one at a time",
            len(paths),
            err,
        )

    landed: dict[str, str] = {}
    for item, path, _result in staged:
        try:
            landed.update(ipod.add_files([path]))
        except device_module.DeviceError as err:
            logger.warning("%s could not be written: %s", item.label, err)
    return landed


def _retag_existing(
    ipod: device_module.IpodDevice, plan: Plan, record: ledger.Ledger, say: Progress
) -> int:
    """Bring the tags of tracks already on the device up to date.

    A track is tagged from the manifest when it is copied across and never
    again, so anything that changes afterwards - an artist corrected in the web
    tool, an album finally resolved, or this application's own rules about what
    to write - leaves the device holding what was true at the time. Those
    fields are what an iPod files a track by, so a stale one shows as a song
    under the wrong artist, or an album that has split in two.

    Two places hold it: the file's own tags, which a computer reads, and the
    row in the iPod's database, which the *device* reads. Both are corrected,
    and the row is the one that decides what appears on screen.

    Which tracks is decided in the plan - see `_stale_tag_locations` - so a
    device that is already right does no work here and says so before anything
    is opened.

    A file that cannot be written is logged and skipped. Its database row is
    still corrected, so the iPod files it properly even if the copy on disk
    keeps an old tag.
    """
    if not plan.tags_stale:
        return 0

    by_id = {int(track["id"]): track for track in plan.manifest.get("tracks") or []}
    owner = {
        entry.location: track_id for track_id, entry in record.entries.items() if entry.location
    }

    say("retagging", {"count": len(plan.tags_stale)})

    # The files first, the database last. The database write is the one that
    # has to land atomically and the one the device actually reads, so a file
    # that could not be written still gets its row put right.
    wanted: dict[str, dict[str, str]] = {}
    for location in plan.tags_stale:
        track = by_id.get(owner.get(location, -1))
        if track is None:
            continue
        wanted[location] = _wanted_tags(track)
        path = ipod.file_for(location)
        if not path.is_file():
            continue
        try:
            # The cover has to be read back out and written in again. `apply`
            # clears every tag first, and the artwork database is rebuilt by
            # reading covers out of these same files - so re-tagging without
            # this would strip the art off the device a sync at a time.
            tagging.apply(path, track, artwork=tagging.embedded_artwork(path))
        except Exception as err:
            logger.warning("Could not re-tag %s on the device: %s", path.name, err)

    changed = ipod.retag(wanted)

    # The ledger is what identifies a track when the database has nothing to
    # say about it, so what it remembers has to move with the tags.
    for location, fields in wanted.items():
        entry = record.entries.get(owner.get(location, -1))
        if entry is None:
            continue
        entry.title = fields["title"]
        entry.artist = fields["artist"]
        entry.album = fields["album"]
    record.save()

    return changed


def _wanted_tags(track: dict[str, Any]) -> dict[str, str]:
    """The four fields an iPod files a track by, as the library has them now."""
    album = str(track.get("album") or "")
    return {
        "title": str(track.get("title") or ""),
        "artist": str(track.get("artist") or ""),
        "album": album,
        # Stored as 0/1 in the database rather than as a boolean.
        "compilation_flag": 1 if track.get("compilation") else 0,
        # The same rule the file tagger follows, for the same reason: an album
        # artist for a track that is on no album is a contradiction, and it is
        # the only thing left to group album-less tracks by - so writing one
        # gives every such song an "Unknown Album" of its own.
        "album_artist": (
            str(track.get("albumArtist") or track.get("artist") or "") if album else ""
        ),
    }


def _stale_tag_locations(
    manifest: dict[str, Any],
    record: ledger.Ledger,
    by_location: dict[str, device_module.IpodTrack],
) -> list[str]:
    """Where the device's own database disagrees with the library.

    **Only tracks in the ledger**, which is the rule removals follow too: this
    tool does not touch what it did not put there. A track added by iTunes
    keeps its tags whatever the library says.

    Compared against the database row rather than the file, because the row is
    what the iPod reads and what decides which list a track appears in. None
    and "" are the same thing here - the database stores an absent field as an
    empty string and the manifest omits it, and treating those as different
    would rewrite the database on every sync for no change at all.
    """
    by_id = {int(track["id"]): track for track in manifest.get("tracks") or []}
    stale = []
    for track_id, entry in record.entries.items():
        track = by_id.get(int(track_id))
        current = by_location.get(entry.location or "")
        if track is None or current is None:
            continue
        wanted = _wanted_tags(track)
        # `compilation_flag` is named for the database record; on the device
        # row this application reads it is `compilation`.
        current_values = {
            "title": current.title or "",
            "artist": current.artist or "",
            "album": current.album or "",
            "album_artist": current.album_artist or "",
            "compilation_flag": current.compilation,
        }
        if any(
            str(current_values.get(name, "")) != str(value) for name, value in wanted.items()
        ):
            stale.append(entry.location)
    return stale


def _playlist_specs(plan: Plan, record: ledger.Ledger) -> list[tuple[str, list[str]]]:
    """The playlists the library wants, as names and device locations.

    Tracks that are not on the device - a download that failed, or one excluded
    for unresolved metadata - are dropped rather than leaving a gap the iPod
    would skip over.
    """
    specs: list[tuple[str, list[str]]] = []
    for name, track_ids in plan.playlists:
        locations = [
            record.entries[track_id].location
            for track_id in track_ids
            if track_id in record.entries
        ]
        specs.append((name, locations))
    return specs


def _write_playlists(ipod: device_module.IpodDevice, plan: Plan, record: ledger.Ledger) -> int:
    """Write the library's playlists in the order the manifest gives them.

    Tracks that are not on the device - a download that failed, or one excluded
    for unresolved metadata - are dropped from the playlist rather than leaving
    a gap the iPod would skip over.
    """
    specs = _playlist_specs(plan, record)
    if not specs:
        return 0
    ipod.write_playlists(specs)
    return len(specs)


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------


def _flush(
    api: DeviceApi, report: Report, pending: list[Result], *, force: bool = False
) -> list[Result]:
    """Send results to the server, keeping them if the send fails.

    Reporting is bookkeeping, not the work. A server that has gone away must not
    cost the user a sync that is otherwise succeeding - the results stay in the
    queue and go with the next batch, or are lost, which costs a re-download
    next run and nothing else.
    """
    if not pending and not force:
        return pending
    report.results.extend(pending)
    if pending:
        _report(api, report, pending)
    return []


def _report(api: DeviceApi, report: Report, results: list[Result]) -> None:
    if report.run_id is None or not results:
        return
    try:
        api.report_results(report.run_id, [r.as_payload() for r in results])
    except ApiError as err:
        logger.warning("Could not report results to the server: %s", err)


def _finish(api: DeviceApi, report: Report) -> None:
    if report.run_id is None:
        return
    try:
        api.finish_run(
            report.run_id,
            status=report.status,
            stats=report.stats(),
            message=report.message,
        )
    except ApiError as err:
        logger.warning("Could not close the sync run on the server: %s", err)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _detect(mount: str | None) -> device_module.IpodDevice:
    if mount:
        return device_module.open_at(mount)

    found = device_module.scan()
    if not found:
        raise SyncError(
            "No iPod detected. Plug one in and make sure it is mounted as a drive, "
            "or point at it directly:  syncmypod sync --mount D:\\"
        )
    if len(found) > 1:
        names = ", ".join(f"{d.describe()} at {d.mount_path}" for d in found)
        raise SyncError(f"More than one iPod is attached ({names}). Choose one with --mount.")
    return found[0]


def _backup(ipod: device_module.IpodDevice) -> str | None:
    """Snapshot the database, refusing to continue if it cannot be taken."""
    snapshot = ipod.backup(reason="before sync")
    if snapshot is None:
        raise SyncError(
            "The iPod's database could not be backed up, so the sync stopped before "
            "writing anything. Check there is free space on the device and try again."
        )
    return str(getattr(snapshot, "snapshot_id", None) or snapshot)


def _free_bytes(ipod: device_module.IpodDevice) -> int:
    try:
        return shutil.disk_usage(ipod.mount_path).free
    except OSError:
        return ipod.free_bytes or 0


def _version() -> str:
    from . import __version__

    return __version__


def _platform() -> str:
    import platform

    return platform.system().lower()
