"""Where the device token and server address live on disk.

The whole point of the pairing design is that this machine never holds the
account password - only a token that can be revoked independently. So this
module's job is narrow: store two strings safely, and be obvious about where.
"""

from __future__ import annotations

import json
import os
import stat
from dataclasses import dataclass
from pathlib import Path

from platformdirs import user_config_dir

APP_NAME = "SyncMyPod"
CONFIG_FILENAME = "config.json"

# What can go in `Config.audio_quality`, and what each one means.
#
#   standard  Opus, re-encoded to 128kbps AAC. Roughly half the space.
#   high      Opus, re-encoded to 256kbps AAC. The default, and what the
#             iTunes Store sold; measured to reproduce the source to within
#             0.2dB in every band - see transcode.py.
#   premium   YouTube's own 256kbps AAC stream, written across untouched. Only
#             a YouTube Music Premium account is offered one, so this falls
#             back to `high` on an account that is not.
AUDIO_QUALITY_CHOICES = ("standard", "high", "premium")
DEFAULT_AUDIO_QUALITY = "high"


def normalise_quality(value: object) -> str:
    """A stored or submitted quality, or the default if it is not one of them."""
    text = str(value or "").strip().lower()
    return text if text in AUDIO_QUALITY_CHOICES else DEFAULT_AUDIO_QUALITY


def config_dir() -> Path:
    """The per-user config directory, chosen by the platform's own convention.

    ``%APPDATA%\\SyncMyPod`` on Windows, ``~/Library/Application Support`` on
    macOS, ``~/.config/SyncMyPod`` on Linux. Overridable with SYNCMYPOD_CONFIG_DIR,
    which is what makes the test suite able to run without touching a real
    user profile.
    """
    override = os.environ.get("SYNCMYPOD_CONFIG_DIR")
    if override:
        return Path(override)
    return Path(user_config_dir(APP_NAME, appauthor=False))


def config_path() -> Path:
    return config_dir() / CONFIG_FILENAME


def backups_dir() -> Path:
    """Where iPod snapshots are kept before a sync writes anything.

    Set explicitly rather than left to pypodlib, which otherwise files them
    under a directory named after the project it was extracted from. A user
    looking for "where are my iPod backups" should find them under this
    application's own name, next to its configuration.

    These are full snapshots of the device, so the directory grows to roughly
    the size of the music on the iPod. It is content-addressed, so a second
    snapshot of an unchanged device costs almost nothing.
    """
    override = os.environ.get("SYNCMYPOD_BACKUP_DIR")
    if override:
        return Path(override)
    return config_dir() / "backups"


@dataclass(slots=True)
class Config:
    """A paired server: where it is, and the token proving we may talk to it."""

    server_url: str = ""
    token: str = ""
    device_name: str = ""
    # Remembered so a later sync can tell the user which iPod this profile was
    # last used with, without needing the device present.
    last_ipod_name: str | None = None
    last_ipod_model: str | None = None
    # Whether to snapshot the iPod before a sync writes to it.
    #
    # On by default, and it should stay on: pypodlib is alpha and rewriting the
    # iTunesDB is the one operation here that can leave a device unusable. But a
    # snapshot is a full copy of the music on the iPod, so on a full 160GB
    # Classic the first one is slow and the disk it lands on may not have room.
    # That is a real reason to turn it off and it is the user's call to make,
    # so it is a setting rather than a rule.
    backup_before_sync: bool = True

    # Which audio to put on the iPod. One of AUDIO_QUALITY_CHOICES.
    #
    # There was no setting at all, and the reasoning for that was sound as far
    # as it went: YouTube offers one AAC stream to everybody and a second to
    # Premium, so there is nothing to choose between. What it missed is that
    # the *conversion* is a choice. An iPod cannot play Opus, so the Opus
    # stream is re-encoded on the way across, and 128kbps against 256 is a real
    # trade between space and sound on a device with a fixed disk.
    audio_quality: str = "high"

    # What the last check found the signed-in account is offered.
    #
    # Stored rather than re-probed, because asking costs a request and a couple
    # of seconds and the answer changes about as often as a subscription does.
    # It decides two things: whether the Premium option can be chosen at all,
    # and - see youtube.cookie_options - whether the saved session is used for
    # downloading, which it should not be when it buys nothing.
    youtube_premium: bool | None = None
    youtube_checked_at: float | None = None

    @property
    def is_paired(self) -> bool:
        return bool(self.server_url and self.token)

    def redacted(self) -> dict[str, object]:
        """Safe to print or log: the token is reduced to an identifying prefix.

        A token is a credential. The prefix is enough to answer "which pairing
        is this?" without putting the secret into a terminal transcript, a
        screenshot, or a support request.
        """
        return {
            "server_url": self.server_url,
            "device_name": self.device_name,
            "token": f"{self.token[:10]}..." if self.token else "",
            "last_ipod_name": self.last_ipod_name,
            "last_ipod_model": self.last_ipod_model,
            "backup_before_sync": self.backup_before_sync,
            "audio_quality": self.audio_quality,
        }


def load() -> Config:
    """Read the stored pairing, or an empty Config if there is none."""
    path = config_path()
    if not path.exists():
        return Config()

    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as err:
        raise ConfigError(
            f"Could not read {path}: {err}. Delete the file and pair again."
        ) from err

    if not isinstance(raw, dict):
        raise ConfigError(f"{path} is not a valid config file. Delete it and pair again.")

    return Config(
        server_url=str(raw.get("server_url") or "").rstrip("/"),
        token=str(raw.get("token") or ""),
        device_name=str(raw.get("device_name") or ""),
        last_ipod_name=raw.get("last_ipod_name"),
        last_ipod_model=raw.get("last_ipod_model"),
        # Absent means a config written before the setting existed, and the
        # safe reading of that is the default rather than "switched off".
        backup_before_sync=bool(raw.get("backup_before_sync", True)),
        # An unrecognised value - hand-edited, or written by a newer build -
        # falls back rather than being passed on to an encoder that will not
        # understand it.
        audio_quality=normalise_quality(raw.get("audio_quality")),
        youtube_premium=_optional_bool(raw.get("youtube_premium")),
        youtube_checked_at=_optional_float(raw.get("youtube_checked_at")),
    )


def _optional_bool(value: object) -> bool | None:
    return None if value is None else bool(value)


def _optional_float(value: object) -> float | None:
    try:
        return None if value is None else float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def save(config: Config) -> Path:
    """Write the pairing, readable only by this user.

    The file holds a bearer token, so the permissions matter. On POSIX it is
    chmod 600. Windows has no equivalent one-liner, and the config directory is
    already inside the user's profile, so it is left to the filesystem ACL
    there rather than pretending to do something.
    """
    path = config_path()
    path.parent.mkdir(parents=True, exist_ok=True)

    payload = {
        "server_url": config.server_url.rstrip("/"),
        "token": config.token,
        "device_name": config.device_name,
        "last_ipod_name": config.last_ipod_name,
        "last_ipod_model": config.last_ipod_model,
        "backup_before_sync": config.backup_before_sync,
        "audio_quality": config.audio_quality,
        "youtube_premium": config.youtube_premium,
        "youtube_checked_at": config.youtube_checked_at,
    }

    # Written to a temporary file and moved into place, so an interrupted write
    # cannot leave a half-written config that fails to parse next run.
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    if os.name != "nt":
        temp.chmod(stat.S_IRUSR | stat.S_IWUSR)
    temp.replace(path)
    return path


def clear() -> bool:
    """Forget the pairing. Returns whether there was one to forget.

    This only removes the local copy. The token stays valid on the server until
    it is revoked there - the UI does that, and the distinction matters: a lost
    laptop needs the server-side revoke, not this.
    """
    path = config_path()
    if not path.exists():
        return False
    path.unlink()
    return True


class ConfigError(Exception):
    """A stored config that cannot be used, with a message worth showing."""
