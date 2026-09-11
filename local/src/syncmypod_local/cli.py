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
import platform
import sys
from typing import NoReturn

from rich.console import Console
from rich.table import Table

from . import __version__, config, device
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
    except (ApiError, device.DeviceError, config.ConfigError) as failure:
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
