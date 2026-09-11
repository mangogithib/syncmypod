"""Shared test scaffolding: a fake library, and a server that serves it.

Lives here rather than in whichever test module happened to need it first, so
that reorganising one module cannot quietly break another.

Two things are faked and nothing else. The **server** is mocked at the HTTP
boundary with respx, so the real client code runs against the real contract in
docs/LOCAL_APP_API.md. The **audio source** is replaced with a fixture file,
because a test must not depend on a video still being on YouTube. The iPod is
not faked: it is a real pyPodLib virtual device of a real model, so the database
is genuinely parsed, written and signed.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import respx

SERVER = "https://pod.example.org:8444"

# The model this project was tested against in the flesh - an iPod Classic 6.5th
# gen, which requires a signed database. Using the real one means the tests
# exercise the same code path the hardware does.
CLASSIC_6G = "MB562"
VIDEO_5G = "MA146"  # no signature required


def track(track_id: int, **overrides: Any) -> dict[str, Any]:
    """One manifest track, in the shape docs/LOCAL_APP_API.md specifies."""
    base = {
        "id": track_id,
        "title": f"Track {track_id}",
        "artist": "Aurora Kane",
        "album": "Longer Days",
        "albumArtist": "Aurora Kane",
        "trackNo": track_id,
        "discNo": 1,
        "totalTracks": 11,
        "durationMs": 268000,
        "isrc": f"AA6Q7200004{track_id}",
        "genre": "Alternative",
        "explicit": False,
        "year": 2022,
        "artworkUrl": None,
        "sourceHint": None,
        "deviceState": None,
        "artists": [{"name": "Aurora Kane", "role": "primary", "position": 0}],
        "searchTerms": {
            "primary": f"Aurora Kane - Track {track_id}",
            "withAlbum": f"Aurora Kane Track {track_id} Longer Days",
            "isrc": None,
            "durationMs": 268000,
        },
    }
    return base | overrides


def manifest(tracks=None, playlists=None, excluded=None) -> dict[str, Any]:
    resolved = tracks if tracks is not None else [track(1), track(2)]
    return {
        "manifestVersion": 1,
        "generatedAt": "2026-09-11T10:00:00.000Z",
        "device": {"id": 2, "name": "Test PC", "ipodGeneration": "6.5th Gen"},
        "conventions": {"artistJoin": ", ", "retagFromManifest": True},
        "tracks": resolved,
        "playlists": playlists or [],
        "excluded": excluded or [],
        "counts": {
            "tracks": len(resolved),
            "playlists": len(playlists or []),
            "excluded": len(excluded or []),
        },
    }


def mock_server(manifest_body: dict[str, Any], *, run_id: int = 7):
    """Every endpoint a run touches. Returns the results and finish routes."""
    respx.get(f"{SERVER}/api/sync/hello").mock(
        return_value=httpx.Response(
            200,
            json={
                "ok": True,
                "manifestVersion": 1,
                "device": {"id": 2, "name": "Test PC"},
                "user": {"id": 1, "username": "mo"},
                "supportedManifestVersions": [1],
            },
        )
    )
    respx.post(f"{SERVER}/api/sync/device").mock(
        return_value=httpx.Response(200, json={"ok": True})
    )
    respx.get(f"{SERVER}/api/sync/manifest").mock(
        return_value=httpx.Response(200, json=manifest_body)
    )
    respx.post(f"{SERVER}/api/sync/runs").mock(
        return_value=httpx.Response(200, json={"id": run_id, "startedAt": "2026-09-11T10:00:00Z"})
    )
    results = respx.post(f"{SERVER}/api/sync/runs/{run_id}/results").mock(
        return_value=httpx.Response(200, json={"recorded": 1})
    )
    finish = respx.post(f"{SERVER}/api/sync/runs/{run_id}/finish").mock(
        return_value=httpx.Response(200, json={"ok": True})
    )
    return results, finish


def reported(route) -> list[dict[str, Any]]:
    """Every result payload a run posted, flattened across batches."""
    out: list[dict[str, Any]] = []
    for call in route.calls:
        out.extend(json.loads(call.request.content)["results"])
    return out
