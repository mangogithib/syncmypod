"""Command line interface.

Subcommands, each doing one thing:

    syncmypod pair <server> <code>   link this computer to a library
    syncmypod status                 what is paired, what is plugged in
    syncmypod unpair                 forget the local pairing

The sync command itself arrives with the sync engine; the commands here are the
ones that can be used and tested without an iPod present.

Exit codes are meaningful, so this can be driven from a script or a scheduled
task: 0 success, 1 a problem the user can fix, 2 bad usage, 130 interrupted.
"""

from __future__ import annotations

import argparse
import logging
import platform
import sys
from typing import NoReturn

from rich.console import Console
from rich.logging import RichHandler
from rich.table import Table

from . import __version__, config, device
from . import ffmpeg as ffmpeg_finder
from . import sync as sync_engine
from .api import ApiError, DeviceApi, NotPairedError, claim_pairing_code

EXIT_OK = 0
EXIT_FAILURE = 1
EXIT_USAGE = 2
EXIT_INTERRUPTED = 130

console = Console()
err_console = Console(stderr=True)


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    if not getattr(args, "handler", None):
        parser.print_help()
        return EXIT_USAGE

    try:
        return int(args.handler(args))
    except KeyboardInterrupt:
        err_console.print("\n[yellow]Interrupted.[/yellow] Nothing was left half-written.")
        return EXIT_INTERRUPTED
    except (
        ApiError,
        device.DeviceError,
        config.ConfigError,
        sync_engine.SyncError,
        ffmpeg_finder.FfmpegMissing,
    ) as failure:
        # These carry messages written to be read by a person, so they are shown
        # as-is. A traceback here would be noise, not information.
        err_console.print(f"[red]Error:[/red] {failure}")
        return EXIT_FAILURE


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="syncmypod",
        description="Sync a SyncMyPod library to a classic iPod.",
        epilog="Start with:  syncmypod pair https://your-server:8444 ABCD1234",
    )
    parser.add_argument("--version", action="version", version=f"syncmypod {__version__}")

    subparsers = parser.add_subparsers(title="commands", metavar="<command>")

    pair = subparsers.add_parser(
        "pair",
        help="Link this computer to a library using a pairing code",
        description=(
            "Exchanges a short pairing code for a device token. Generate the code "
            "in the web interface under Devices. Your account password is never "
            "needed and never stored on this machine."
        ),
    )
    pair.add_argument("server", help="Server address, e.g. https://syncmypod.example.org:8444")
    pair.add_argument("code", help="The eight-character code shown in the web interface")
    pair.add_argument(
        "--name",
        default=None,
        help="How this computer appears in the web interface (default: its hostname)",
    )
    pair.set_defaults(handler=_cmd_pair)

    status = subparsers.add_parser(
        "status",
        help="Show the pairing, the server, and any attached iPod",
    )
    status.add_argument(
        "--mount",
        default=None,
        help="Check a specific mount point instead of scanning for one",
    )
    status.set_defaults(handler=_cmd_status)

    unpair = subparsers.add_parser(
        "unpair",
        help="Forget the local pairing",
        description=(
            "Removes the token from this computer only. The device stays listed "
            "on the server until it is revoked there - do that from the web "
            "interface if this machine was lost."
        ),
    )
    unpair.set_defaults(handler=_cmd_unpair)

    devices = subparsers.add_parser("devices", help="List attached iPods")
    devices.set_defaults(handler=_cmd_devices)

    sync = subparsers.add_parser(
        "sync",
        help="Sync the library to the attached iPod",
        description=(
            "Downloads whatever the library says should be on the iPod but is not, "
            "tags it from the server's resolved metadata, writes it to the device, "
            "and deletes every downloaded file afterwards. Start with --dry-run to "
            "see what it would do."
        ),
    )
    sync.add_argument("--mount", default=None, help="Sync a specific mount point")
    sync.add_argument(
        "--dry-run",
        action="store_true",
        help="Work out what would be done and stop. Writes nothing.",
    )
    sync.add_argument(
        "--remove",
        action="store_true",
        help="Also delete tracks this tool added that have left the library",
    )
    sync.add_argument(
        "--limit",
        type=int,
        default=None,
        metavar="N",
        help="Download at most N tracks, for a short first run",
    )
    sync.add_argument(
        "--batch",
        type=int,
        default=sync_engine.DEFAULT_BATCH_SIZE,
        metavar="N",
        help=f"Tracks per database commit (default {sync_engine.DEFAULT_BATCH_SIZE})",
    )
    sync.add_argument(
        "--keep-downloads",
        action="store_true",
        help="Leave downloaded files on disk for debugging. Prints where they are.",
    )
    sync.add_argument(
        "--yes", action="store_true", help="Do not ask before removing tracks"
    )
    sync.add_argument("--verbose", action="store_true", help="Log what each step is doing")
    sync.set_defaults(handler=_cmd_sync)

    gui = subparsers.add_parser(
        "gui",
        help="Open the window",
        description=(
            "Serves a small page to your browser and opens it. The server binds "
            "to this computer only, needs a token generated at startup, and "
            "stops when this command does."
        ),
    )
    gui.add_argument(
        "--no-browser",
        action="store_true",
        help="Print the address instead of opening a browser",
    )
    gui.add_argument(
        "--port",
        type=int,
        default=0,
        metavar="N",
        help="Listen on a specific port instead of one the system picks",
    )
    gui.add_argument("--verbose", action="store_true", help="Log what each step is doing")
    gui.set_defaults(handler=_cmd_gui)

    return parser


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------


def _cmd_pair(args: argparse.Namespace) -> int:
    name = args.name or _default_device_name()

    console.print(f"Pairing with [bold]{args.server}[/bold] as [bold]{name}[/bold]...")
    pairing = claim_pairing_code(args.server, args.code, name, platform.system().lower())

    config.save(
        config.Config(
            server_url=pairing.server_url,
            token=pairing.token,
            device_name=pairing.device_name,
        )
    )

    console.print(f"[green]Paired.[/green] Saved to {config.config_path()}")
    console.print(
        "\nThe token is stored on this computer only. Revoke it any time from "
        "the web interface under Devices."
    )
    return EXIT_OK


def _cmd_status(args: argparse.Namespace) -> int:
    stored = config.load()

    table = Table(show_header=False, box=None, padding=(0, 2, 0, 0))
    table.add_column(style="dim")
    table.add_column()

    if not stored.is_paired:
        console.print("[yellow]Not paired.[/yellow]")
        console.print("\nRun:  syncmypod pair <server> <code>")
        console.print("Generate the code in the web interface under Devices.")
        return EXIT_FAILURE

    table.add_row("Server", stored.server_url)
    table.add_row("This device", stored.device_name or "(unnamed)")
    table.add_row("Token", f"{stored.token[:10]}...")
    # Worth surfacing before a sync rather than at the first track that needs
    # converting: without ffmpeg nothing can be downloaded at all.
    found = ffmpeg_finder.find()
    table.add_row(
        "ffmpeg",
        ffmpeg_finder.describe() if found else "[red]not found[/red] - audio cannot be fetched",
    )
    console.print(table)

    # Reaching the server is a separate question from being paired, and worth
    # answering separately: an unreachable server and a revoked token need
    # completely different fixes.
    console.print()
    try:
        with DeviceApi(stored.server_url, stored.token) as api:
            hello = api.hello()
        user = (hello.get("user") or {}).get("username", "?")
        console.print(f"[green]Server reachable.[/green] Signed in as [bold]{user}[/bold].")
    except NotPairedError as failure:
        console.print(f"[red]Token rejected.[/red] {failure}")
        console.print("Run:  syncmypod pair <server> <code>")
        return EXIT_FAILURE
    except ApiError as failure:
        console.print(f"[red]Server unreachable.[/red] {failure}")
        return EXIT_FAILURE

    console.print()
    return _report_devices(args.mount)


def _cmd_devices(_args: argparse.Namespace) -> int:
    return _report_devices(None)


def _report_devices(mount: str | None) -> int:
    try:
        found = [device.open_at(mount)] if mount else device.scan()
    except device.DependencyMissing as failure:
        console.print(f"[red]{failure}[/red]")
        return EXIT_FAILURE

    if not found:
        console.print("[yellow]No iPod detected.[/yellow]")
        console.print(
            "Plug one in and make sure it is mounted as a drive. If it is "
            "mounted somewhere unusual, pass it explicitly:  syncmypod status --mount D:\\"
        )
        return EXIT_OK

    for ipod in found:
        table = Table(title=ipod.describe(), show_header=False, box=None, title_justify="left")
        table.add_column(style="dim")
        table.add_column()
        table.add_row("Mounted at", str(ipod.mount_path))
        table.add_row("Model", ipod.model or "unknown")
        table.add_row("Generation", ipod.generation or "unknown")
        if ipod.capacity_bytes:
            table.add_row("Capacity", _bytes(ipod.capacity_bytes))
        if ipod.free_bytes:
            table.add_row("Free", _bytes(ipod.free_bytes))
        # Named precisely rather than as a yes/no: when a sync goes wrong on an
        # unusual device, the scheme is the first thing worth knowing.
        table.add_row(
            "Database signature",
            f"[yellow]required[/yellow] ({ipod.checksum_type.lower()})"
            if ipod.needs_signature
            else "not required",
        )
        if ipod.model_number:
            table.add_row("Model number", ipod.model_number)
        console.print(table)
        console.print()

    return EXIT_OK


def _cmd_sync(args: argparse.Namespace) -> int:
    _configure_logging(args.verbose)

    stored = config.load()
    if not stored.is_paired:
        console.print("[yellow]Not paired.[/yellow]  Run:  syncmypod pair <server> <code>")
        return EXIT_FAILURE

    remove = args.remove
    reporter = _SyncReporter(console)

    # The plan is shown before anything is written, and removals are confirmed
    # against that plan. Deleting music is the one thing here that cannot be
    # undone from the web interface, so it is never the default and never silent.
    if remove and not args.yes and sys.stdin.isatty():
        preview = sync_engine.run(stored, mount=args.mount, dry_run=True, progress=reporter)
        if preview.plan.removals:
            console.print()
            for removal in preview.plan.removals:
                console.print(f"  [red]-[/red] {removal.label}")
            console.print()
            answer = console.input(
                f"Delete {len(preview.plan.removals)} track(s) from the iPod? [y/N] "
            )
            if answer.strip().lower() not in {"y", "yes"}:
                console.print("Leaving them in place.")
                remove = False
        reporter.reset()

    report = sync_engine.run(
        stored,
        mount=args.mount,
        dry_run=args.dry_run,
        remove=remove,
        limit=args.limit,
        batch_size=max(1, args.batch),
        keep_downloads=args.keep_downloads,
        progress=reporter,
    )

    _print_summary(report, dry_run=args.dry_run)

    # A run where every track failed is a failure even though the sync itself
    # completed, because nothing the user asked for actually happened.
    if report.failed and not report.synced:
        return EXIT_FAILURE
    return EXIT_OK


def _cmd_gui(args: argparse.Namespace) -> int:
    from . import gui as gui_module

    _configure_logging(args.verbose)

    server = gui_module.serve(open_browser=not args.no_browser, port=args.port)
    console.print(f"[bold]SyncMyPod[/bold] is running at [link]{server.url}[/link]")
    console.print(
        "\n[dim]Reachable from this computer only. The link contains a one-time "
        "token, so opening the address without it will not work.[/dim]"
    )
    console.print("[dim]Press Ctrl+C to stop.[/dim]")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        console.print("\nStopped.")
    finally:
        server.shutdown()
    return EXIT_OK


class _SyncReporter:
    """Turns the engine's progress events into something worth watching.

    The engine reports events rather than printing, so the same run can drive a
    terminal, a GUI, or a log file without any of them knowing about the others.
    """

    def __init__(self, output: Console):
        self._console = output
        self._planned = False

    def reset(self) -> None:
        self._planned = False

    def __call__(self, event: str, data: dict) -> None:
        if event == "device":
            ipod = data["device"]
            self._console.print(
                f"[bold]{ipod.describe()}[/bold] at {ipod.mount_path}"
                + (f"  ({_bytes(ipod.free_bytes)} free)" if ipod.free_bytes else "")
            )
        elif event == "plan" and not self._planned:
            self._planned = True
            self._print_plan(data["plan"])
        elif event == "backup":
            self._console.print("Backing up the iPod database...")
        elif event == "track":
            index, total = data["index"], data["total"]
            self._console.print(f"[dim]{index}/{total}[/dim] {data['item'].label}")
        elif event == "track-failed":
            self._console.print(f"      [red]failed[/red]  {data['error']}")
        elif event == "track-ready":
            result = data["result"]
            self._console.print(
                f"      [green]ready[/green]  {result.format}"
                + (f", {result.bitrate}kbps" if result.bitrate else "")
                + f", {_bytes(result.file_size or 0)}"
            )
        elif event == "writing":
            self._console.print(f"[dim]Writing {data['count']} track(s) to the iPod...[/dim]")
        elif event == "playlists":
            self._console.print(f"[dim]Writing {data['count']} playlist(s)...[/dim]")
        elif event == "removing":
            self._console.print(f"[dim]Removing {data['count']} track(s)...[/dim]")

    def _print_plan(self, plan: sync_engine.Plan) -> None:
        table = Table(show_header=False, box=None, padding=(0, 2, 0, 0))
        table.add_column(style="dim")
        table.add_column(justify="right")
        table.add_row("Already on the iPod", str(len(plan.already_present)))
        if plan.adopted:
            table.add_row("Matched by tags", str(len(plan.adopted)))
        table.add_row("To download", str(len(plan.to_download)))
        if plan.removals:
            table.add_row("No longer in the library", str(len(plan.removals)))
        if plan.playlists:
            table.add_row("Playlists", str(len(plan.playlists)))
        if plan.excluded:
            table.add_row("Excluded (unresolved metadata)", str(len(plan.excluded)))
        self._console.print()
        self._console.print(table)
        self._console.print()


def _print_summary(report: sync_engine.Report, *, dry_run: bool) -> None:
    console.print()
    if dry_run:
        console.print("[yellow]Dry run.[/yellow] Nothing was written to the iPod.")
        if report.plan.to_download:
            console.print(f"Run without --dry-run to sync {len(report.plan.to_download)} track(s).")
        return

    if report.message and not report.results:
        console.print(report.message)
        return

    parts = [f"[green]{report.synced} synced[/green]"]
    if report.failed:
        parts.append(f"[red]{len(report.failed)} failed[/red]")
    if report.removed:
        parts.append(f"{report.removed} removed")
    if report.playlists_written:
        parts.append(f"{report.playlists_written} playlist(s) written")
    console.print("  ".join(parts))

    if report.failed:
        console.print()
        console.print("[red]Failed:[/red]")
        for result in report.failed:
            console.print(f"  {result.label}")
            console.print(f"    [dim]{result.error}[/dim]")

    if report.plan.excluded:
        console.print()
        console.print(
            f"[yellow]{len(report.plan.excluded)} track(s) were skipped[/yellow] because their "
            "metadata is not confirmed. Resolve them in the web interface."
        )

    if report.message:
        console.print()
        console.print(report.message)


def _configure_logging(verbose: bool) -> None:
    logging.basicConfig(
        level=logging.INFO if verbose else logging.WARNING,
        format="%(message)s",
        datefmt="%H:%M:%S",
        handlers=[RichHandler(console=err_console, show_path=False, rich_tracebacks=False)],
    )
    if not verbose:
        # pypodlib narrates its own internal decisions at WARNING - which
        # platform flag it preserved, that the play-count table is shorter than
        # the track list. All expected on an iPod that has seen another tool,
        # and none of it actionable, so it drowns out the run without --verbose.
        logging.getLogger("pypodlib").setLevel(logging.ERROR)


def _cmd_unpair(_args: argparse.Namespace) -> int:
    if config.clear():
        console.print("[green]Pairing removed from this computer.[/green]")
        console.print(
            "The device is still listed on the server. Revoke it there if this "
            "machine should no longer have access."
        )
    else:
        console.print("Nothing to remove - this computer was not paired.")
    return EXIT_OK


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _default_device_name() -> str:
    """A name the user will recognise in the device list."""
    host = platform.node().strip()
    return host or f"{platform.system()} computer"


def _bytes(value: int) -> str:
    size = float(value)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if size < 1024 or unit == "TB":
            return f"{size:.0f} {unit}" if unit in {"B", "KB"} else f"{size:.1f} {unit}"
        size /= 1024
    return f"{value} B"


def _entrypoint() -> NoReturn:  # pragma: no cover - thin wrapper
    sys.exit(main())


if __name__ == "__main__":  # pragma: no cover
    _entrypoint()
