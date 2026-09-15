"""Command line interface.

Subcommands, each doing one thing:

    syncmypod pair <server> <code>   link this computer to a library
    syncmypod status                 what is paired, what is plugged in
    syncmypod devices                just the attached iPods
    syncmypod sync                   do the work
    syncmypod check-matches          which songs can be found, without syncing
    syncmypod gui                    the same thing, in a browser
    syncmypod youtube                sign in for higher quality audio
    syncmypod eject                  make it safe to unplug
    syncmypod unpair                 forget the local pairing

This is one of two front ends over the engine in ``sync.py``; the GUI is the
other. Neither owns any behaviour - the engine reports progress as events and
both of them only render those, so the two cannot drift apart.

Exit codes are meaningful, so this can be driven from a script or a scheduled
task: 0 success, 1 a problem the user can fix, 2 bad usage, 130 interrupted.
"""

from __future__ import annotations

import argparse
import contextlib
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
from . import youtube as youtube_module
from .api import ApiError, DeviceApi, NotPairedError, claim_pairing_code

EXIT_OK = 0
EXIT_FAILURE = 1
EXIT_USAGE = 2
EXIT_INTERRUPTED = 130


def _make_output_utf8_safe() -> None:
    """Stop a track name from crashing the run that is printing it.

    Windows consoles default to a legacy code page - cp1252 in western locales -
    and printing anything outside it raises UnicodeEncodeError. That is not a
    cosmetic problem here: the exception propagates out of the progress line and
    kills the sync. Found by packaging the application and syncing a library with
    Malayalam titles, where it died on the first track.

    Two fixes, because either alone leaves a gap. Switching the console to UTF-8
    makes the characters display properly where the font has them. Reconfiguring
    the streams with ``errors="replace"`` guarantees that a character neither can
    handle degrades to a question mark instead of ending the sync - which is the
    only acceptable outcome, since the name being printed has nothing to do with
    whether the track can be written to the iPod.
    """
    if sys.platform == "win32":
        try:
            import ctypes

            kernel32 = ctypes.windll.kernel32
            kernel32.SetConsoleOutputCP(65001)
            kernel32.SetConsoleCP(65001)
        except Exception:
            # No console at all - a scheduled task, or output redirected to a
            # file. The stream reconfiguration below is what matters there.
            pass

    for stream in (sys.stdout, sys.stderr):
        # AttributeError when the stream has been replaced by something without
        # reconfigure - a test harness, or a pipe wrapper.
        with contextlib.suppress(AttributeError, ValueError, OSError):
            stream.reconfigure(encoding="utf-8", errors="replace")


# Called at import rather than in main(), because rich reads a stream's encoding
# when the Console is built and both are module-level.
_make_output_utf8_safe()

console = Console()
err_console = Console(stderr=True)


def _owns_its_console() -> bool:
    """Whether this process was double-clicked rather than run from a shell.

    Windows gives a double-clicked executable a console of its own, and takes it
    away the instant the process ends. So the packaged application launched from
    Explorer with no arguments printed its help text and vanished - "a black box
    flashes and nothing happens", which is exactly what it looked like.

    The distinction is how many processes share the console. One means this
    program is alone in a window that was created for it; more means it was
    started from a shell that is still there, where printing help and exiting is
    the correct behaviour.
    """
    if sys.platform != "win32":
        return False
    try:
        import ctypes

        # The buffer only has to be big enough to tell "one" from "more than
        # one" - the count is returned whether or not it fits.
        buffer = (ctypes.c_uint * 2)()
        return ctypes.windll.kernel32.GetConsoleProcessList(buffer, 2) <= 1
    except Exception:
        return False


def _wait_before_closing() -> None:
    """Keep a double-clicked window open long enough to read it."""
    try:
        console.print()
        console.input("[dim]Press Enter to close...[/dim]")
    except (EOFError, KeyboardInterrupt, OSError):
        pass


def main(argv: list[str] | None = None) -> int:
    double_clicked = argv is None and len(sys.argv) == 1 and _owns_its_console()
    if double_clicked:
        # Someone who double-clicks wants the application, not a list of
        # subcommands they cannot type into a window that is about to close.
        argv = ["gui"]

    try:
        return _run(argv)
    finally:
        if double_clicked:
            _wait_before_closing()


def _run(argv: list[str] | None) -> int:
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
        youtube_module.YouTubeError,
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

    youtube = subparsers.add_parser(
        "youtube",
        help="Sign in to YouTube for higher quality audio",
        description=(
            "Signed out, YouTube offers one AAC stream at about 128kbps. A "
            "YouTube Music Premium account is offered the same recording at "
            "256kbps. There is no password to type: the session is borrowed "
            "from a browser already signed in, and only youtube.com cookies "
            "are kept."
        ),
    )
    youtube_action = youtube.add_subparsers(dest="action", metavar="<action>")

    youtube_status = youtube_action.add_parser(
        "status", help="What YouTube is currently offering (default)"
    )
    youtube_status.set_defaults(handler=_cmd_youtube_status)

    youtube_login = youtube_action.add_parser(
        "sign-in", help="Borrow the YouTube session from a browser"
    )
    youtube_login.add_argument(
        "browser",
        nargs="?",
        default=None,
        choices=youtube_module.BROWSERS,
        help="Which browser to read the session from. Omit it and every browser "
        "is tried until one is found signed in to YouTube, which is what the "
        "window does.",
    )
    youtube_login.set_defaults(handler=_cmd_youtube_sign_in)

    youtube_out = youtube_action.add_parser(
        "sign-out", help="Delete the saved session from this computer"
    )
    youtube_out.set_defaults(handler=_cmd_youtube_sign_out)

    youtube.set_defaults(handler=_cmd_youtube_status)

    eject = subparsers.add_parser(
        "eject",
        help="Flush and unmount the iPod so it is safe to unplug",
        description=(
            "A freshly written database can still be sitting in the operating "
            "system's write cache. Pulling the cable then is how an iPod ends up "
            "with a library it cannot read."
        ),
    )
    eject.add_argument("--mount", default=None, help="Eject a specific mount point")
    eject.set_defaults(handler=_cmd_eject)

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
        "--at-once",
        type=int,
        default=sync_engine.DEFAULT_CONCURRENCY,
        metavar="N",
        help=(
            "Tracks to download at the same time "
            f"(default {sync_engine.DEFAULT_CONCURRENCY}). Raising this asks "
            "YouTube for more at once and invites rate limiting."
        ),
    )
    sync.add_argument(
        "--keep-downloads",
        action="store_true",
        help="Leave downloaded files on disk for debugging. Prints where they are.",
    )
    sync.add_argument(
        "--no-backup",
        action="store_true",
        help=(
            "Skip the snapshot taken before writing. Faster and uses no disk, "
            "but there is nothing to restore from if the write goes wrong."
        ),
    )
    sync.add_argument("--yes", action="store_true", help="Do not ask before removing tracks")
    sync.add_argument(
        "--eject",
        action="store_true",
        help="Unmount the iPod when the sync finishes, so it is safe to unplug",
    )
    sync.add_argument("--verbose", action="store_true", help="Log what each step is doing")
    sync.set_defaults(handler=_cmd_sync)

    matches = subparsers.add_parser(
        "check-matches",
        help="Find out which songs have audio available, without downloading any",
        description=(
            "Searches for every track that has no source link yet and reports "
            "back which ones can be found. Downloads nothing and needs no iPod "
            "attached. A track that is found gets its link saved, so the next "
            "sync skips the search for it."
        ),
    )
    matches.add_argument(
        "--limit",
        type=int,
        default=None,
        metavar="N",
        help="Check at most N tracks",
    )
    matches.add_argument(
        "--at-once",
        type=int,
        default=sync_engine.DEFAULT_CONCURRENCY,
        metavar="N",
        help=f"Searches at the same time (default {sync_engine.DEFAULT_CONCURRENCY})",
    )
    matches.add_argument("--verbose", action="store_true", help="Log what each step is doing")
    matches.set_defaults(handler=_cmd_check_matches)

    gui = subparsers.add_parser(
        "gui",
        help="Open the application window",
        description=(
            "Opens the application in a window of its own. The page is served "
            "on this computer only, needs a token generated at startup, and "
            "stops when the window is closed."
        ),
    )
    gui.add_argument(
        "--browser",
        action="store_true",
        help="Open in your default browser instead of a window of its own",
    )
    gui.add_argument(
        "--no-browser",
        action="store_true",
        help="Print the address and open nothing",
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

    console.print(f"[green]Paired.[/green] Saved to {_where(config.config_path())}")
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
    # Not probed here: checking costs a request to YouTube, and `status` is the
    # command people run when something is wrong and they want an answer now.
    table.add_row(
        "YouTube",
        "signed in" if youtube_module.is_signed_in() else "not signed in (128kbps)",
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
        concurrency=max(1, args.at_once),
        keep_downloads=args.keep_downloads,
        # None rather than True, so the stored preference is what applies when
        # the flag is not given. The flag only ever turns backups off.
        backup=False if args.no_backup else None,
        progress=reporter,
    )

    _print_summary(report, dry_run=args.dry_run)

    # After the summary, so the result of the sync is the last thing that was
    # read before the device goes away.
    if args.eject and not args.dry_run:
        ok, message = report.plan.device.eject()
        console.print()
        console.print(
            f"[green]Safe to unplug.[/green] {message}"
            if ok
            else f"[yellow]Could not eject:[/yellow] {message}"
        )

    # A run where every track failed is a failure even though the sync itself
    # completed, because nothing the user asked for actually happened.
    if report.failed and not report.synced:
        return EXIT_FAILURE
    return EXIT_OK


def _cmd_check_matches(args: argparse.Namespace) -> int:
    _configure_logging(args.verbose)

    stored = config.load()
    if not stored.is_paired:
        console.print("[yellow]Not paired.[/yellow]  Run:  syncmypod pair <server> <code>")
        return EXIT_FAILURE

    def progress(event: str, data: dict) -> None:
        if event == "checking":
            total, skipped = data["total"], data["skipped"]
            console.print(
                f"Checking [bold]{total}[/bold] track(s)"
                + (f"; {skipped} already have a source link" if skipped else "")
            )
        elif event == "no-match":
            console.print(f"  [yellow]not found[/yellow]  {data['label']}")
        elif event == "reporting":
            console.print(f"Sending {data['count']} result(s) to the library...")

    report = sync_engine.check_matches(
        stored,
        limit=args.limit,
        concurrency=max(1, args.at_once),
        progress=progress,
    )

    console.print()
    if report.status == "blocked":
        console.print(f"[red]Stopped.[/red] {report.message}")
        return EXIT_FAILURE
    if report.message and report.checked == 0:
        console.print(report.message)
        return EXIT_OK

    table = Table(show_header=False, box=None, padding=(0, 2, 0, 0))
    table.add_column(style="dim")
    table.add_column()
    table.add_row("Checked", str(report.checked))
    table.add_row("Found", f"[green]{report.found}[/green]")
    table.add_row("Not found", f"[yellow]{len(report.missing)}[/yellow]")
    if report.skipped:
        table.add_row("Already linked", str(report.skipped))
    console.print(table)

    if report.missing:
        console.print()
        console.print("[yellow]No audio found for:[/yellow]")
        for label, _reason in report.missing[:40]:
            console.print(f"  {label}")
        if len(report.missing) > 40:
            console.print(f"  ...and {len(report.missing) - 40} more")
        console.print()
        console.print(
            "[dim]Paste a source link for any of these in the web interface and "
            "they will sync.[/dim]"
        )
    return EXIT_OK


def _cmd_youtube_status(_args: argparse.Namespace) -> int:
    console.print("Asking YouTube what it will offer...")
    available = youtube_module.check()

    table = Table(show_header=False, box=None, padding=(0, 2, 0, 0))
    table.add_column(style="dim")
    table.add_column()
    table.add_row("Session", "saved" if available.signed_in else "none")
    table.add_row("Best AAC offered", available.describe())
    console.print(table)

    if not available.signed_in:
        console.print()
        console.print(
            "[dim]Sign in with a YouTube Music Premium account to get 256kbps "
            "instead of 128:[/dim]"
        )
        console.print("  syncmypod youtube sign-in firefox")
    elif not available.premium:
        console.print()
        console.print(
            "[yellow]The session works, but this account is not being offered "
            "the Premium stream.[/yellow] 256kbps needs an active YouTube Music "
            "Premium subscription."
        )
    return EXIT_OK


def _cmd_youtube_sign_in(args: argparse.Namespace) -> int:
    console.print(f"Reading the YouTube session from [bold]{args.browser}[/bold]...")
    available = youtube_module.sign_in(args.browser)

    console.print(f"[green]Saved.[/green] {_where(youtube_module.cookies_path())}")
    console.print(
        "[dim]Only youtube.com cookies were kept - nothing from any other site, "
        "and nothing from your Google account.[/dim]"
    )
    console.print()

    if available.premium:
        console.print(f"[green]Premium confirmed.[/green] {available.describe()}")
    elif available.error:
        console.print(f"[yellow]Saved, but the check failed:[/yellow] {available.error}")
    else:
        console.print(f"[yellow]Signed in, but still only {available.describe()}.[/yellow]")
        console.print(
            "256kbps needs an active YouTube Music Premium subscription on the "
            "account that browser is signed in with."
        )
    return EXIT_OK


def _cmd_youtube_sign_out(_args: argparse.Namespace) -> int:
    if youtube_module.forget():
        console.print("[green]Session deleted.[/green] Downloads will be 128kbps again.")
    else:
        console.print("There was no saved session.")
    return EXIT_OK


def _cmd_eject(args: argparse.Namespace) -> int:
    found = [device.open_at(args.mount)] if args.mount else device.scan()
    if not found:
        console.print("[yellow]No iPod detected.[/yellow]")
        return EXIT_OK

    failures = 0
    for ipod in found:
        ok, message = ipod.eject()
        if ok:
            console.print(f"[green]Safe to unplug.[/green] {message}")
        else:
            console.print(f"[red]Not ejected.[/red] {message}")
            failures += 1
    return EXIT_FAILURE if failures else EXIT_OK


def _cmd_gui(args: argparse.Namespace) -> int:
    from . import gui as gui_module
    from .gui import window as window_module

    _configure_logging(args.verbose)

    # A window by default, since 15 September. The page is identical either way
    # - see gui/window.py for why this is pywebview rather than a rewrite - and
    # the flags are the escape hatches: --browser for the old behaviour, and
    # --no-browser for a headless box or for debugging the server on its own.
    want_window = not args.browser and not args.no_browser

    server = gui_module.serve(
        open_browser=args.browser and not args.no_browser,
        port=args.port,
    )

    if want_window and window_module.available():
        # Said before the call, because the call blocks until the window is
        # closed - and a terminal with no output at all looks like a hang.
        console.print("[bold]SyncMyPod[/bold] is open in a window. Close it to stop.")

    # Blocks until the window is closed. False means none could be opened, and
    # the server is deliberately left running so the fallback below can use it.
    if want_window and window_module.run(server):
        console.print("Closed.")
        return EXIT_OK
    if want_window:
        gui_module.open_in_browser(server.url)

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
        elif event == "backup-skipped":
            self._console.print(
                "[yellow]Skipping the backup.[/yellow] Nothing to restore from "
                "if this write goes wrong."
            )
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
        elif event == "artwork":
            self._console.print(
                f"[dim]Building cover art for {data['count']} track(s)...[/dim]"
            )

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
        if plan.artwork_missing:
            table.add_row("Missing cover art", str(len(plan.artwork_missing)))
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
            console.print(
                f"Run without --dry-run to sync {len(report.plan.to_download)} track(s)."
            )
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
    if report.artwork_linked:
        parts.append(f"{report.artwork_linked} with cover art")
    console.print("  ".join(parts))

    if report.artwork_error:
        console.print()
        console.print(
            f"[yellow]The music synced, but the cover art did not:[/yellow] {report.artwork_error}"
        )

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


def _where(path) -> str:
    """A path the user can actually navigate to.

    Python installed from the Microsoft Store runs inside an app container that
    silently redirects writes under %LOCALAPPDATA% into a per-package
    ``AppData/Local/Packages/PythonSoftwareFoundation.../LocalCache`` tree. The
    redirect is invisible to the process doing the writing - it reads the file
    back from the path it asked for - but File Explorer and every other program
    see nothing there at all. Printing the resolved path is the difference
    between "your settings are saved somewhere you can find" and a directory
    that appears not to exist. Harmless everywhere else: without a redirect this
    resolves to the same path.
    """
    import os

    return os.path.realpath(path)


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
