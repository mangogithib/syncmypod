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
    )


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
