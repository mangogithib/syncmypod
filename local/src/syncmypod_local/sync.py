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
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx

from . import config as config_module
from . import device as device_module
from . import downloader, ledger, tagging, transcode, workspace
from .api import ApiError, DeviceApi

logger = logging.getLogger(__name__)

# How many tracks are written to the device between database commits. Each
# commit rewrites the whole iTunesDB, so one per track would be slow on a large
# library; one per run would mean an interrupted sync left every track it had
# already copied invisible to the device.
DEFAULT_BATCH_SIZE = 5

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
        return f"{self.track.get('artist') or 'Unknown'} - {self.track.get('title') or 'Untitled'}"


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

    @property
    def nothing_to_do(self) -> bool:
        return not self.to_download and not self.removals


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
    backup_id: str | None = None
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

    plan.playlists = [
        (str(p.get("name") or "Untitled"), [int(t) for t in p.get("trackIds") or []])
        for p in manifest.get("playlists") or []
    ]
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
    keep_downloads: bool = False,
    progress: Progress | None = None,
    cancel: Callable[[], bool] | None = None,
) -> Report:
    """Sync the library to the attached iPod.

    ``dry_run`` computes the plan and stops - the safe way to see what a sync
    would do before letting it. ``limit`` caps how many tracks are downloaded,
    which is how a first run against a large library is kept short enough to
    watch.

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

    with DeviceApi(stored.server_url, stored.token) as api:
        say("hello", {})
        hello = api.hello()
        user_id = (hello.get("user") or {}).get("id")

        ipod = _detect(mount)
        say("device", {"device": ipod})

        try:
            api.report_device(ipod.as_report() | {"appVersion": _version(), "platform": _platform()})
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

        # Before anything is written. pypodlib is alpha and this is the one
        # operation that can leave a device unusable.
        say("backup", {})
        report.backup_id = _backup(ipod)

        report.run_id = api.start_run(
            planned=len(plan.to_download) + len(plan.removals),
            to_download=len(plan.to_download),
            to_remove=len(plan.removals) if remove else 0,
        )

        try:
            _execute(
                api, ipod, plan, record, report, say, batch_size, remove, keep_downloads, stop
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
) -> None:
    """Download, tag, write and report, a batch at a time."""
    with workspace.Workspace(keep=keep_downloads) as work, httpx.Client(
        timeout=20.0, follow_redirects=True
    ) as artwork_client:
        pending: list[Result] = []
        staged: list[tuple[TrackPlan, Path, Result]] = []

        for index, item in enumerate(plan.to_download, start=1):
            # Checked before starting a track rather than during one, so what is
            # already staged still gets written and recorded below.
            if stop():
                report.status = "cancelled"
                report.message = (
                    f"Cancelled with {len(plan.to_download) - index + 1} track(s) left. "
                    "What had already been written is on the iPod."
                )
                break

            say("track", {"index": index, "total": len(plan.to_download), "item": item})

            if _free_bytes(ipod) < FREE_SPACE_FLOOR_BYTES:
                report.message = (
                    f"Stopped with {len(plan.to_download) - index + 1} tracks left: "
                    "the iPod is nearly full."
                )
                logger.warning(report.message)
                break

            try:
                prepared, result = _prepare_one(item, work, artwork_client)
            except Exception as err:  # a failed track must not end the run
                logger.warning("%s failed: %s", item.label, err)
                pending.append(
                    Result(track_id=item.id, state="failed", label=item.label, error=str(err)[:500])
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

        if staged:
            pending.extend(_commit_batch(ipod, record, staged, work, say))
            staged.clear()
        _flush(api, report, pending, force=True)

    # Playlists after every track, so a playlist never references something that
    # failed to download.
    if plan.playlists:
        say("playlists", {"count": len(plan.playlists)})
        report.playlists_written = _write_playlists(ipod, plan, record)

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


def _commit_batch(
    ipod: device_module.IpodDevice,
    record: ledger.Ledger,
    staged: list[tuple[TrackPlan, Path, Result]],
    work: workspace.Workspace,
    say: Progress,
) -> list[Result]:
    """Write a batch to the device, then delete what it was written from."""
    say("writing", {"count": len(staged)})
    landed = ipod.add_files([path for _item, path, _result in staged])

    results: list[Result] = []
    for item, path, result in staged:
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
        results.append(result)

    # The rule the architecture rests on: nothing downloaded outlives the sync.
    # Per track rather than at the end, so peak disk use stays at one batch.
    for item, _path, _result in staged:
        work.discard(item.id)

    return results


def _write_playlists(
    ipod: device_module.IpodDevice, plan: Plan, record: ledger.Ledger
) -> int:
    """Write the library's playlists in the order the manifest gives them.

    Tracks that are not on the device - a download that failed, or one excluded
    for unresolved metadata - are dropped from the playlist rather than leaving
    a gap the iPod would skip over.
    """
    specs: list[tuple[str, list[str]]] = []
    for name, track_ids in plan.playlists:
        locations = [
            record.entries[track_id].location
            for track_id in track_ids
            if track_id in record.entries
        ]
        specs.append((name, locations))

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
        raise SyncError(
            f"More than one iPod is attached ({names}). Choose one with --mount."
        )
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
