"""Server API client tests.

Mocked at the HTTP boundary with respx, so these assert the contract in the
server's docs/LOCAL_APP_API.md rather than reaching a live instance. The live
check belongs in an integration run, not here.
"""

from __future__ import annotations

import httpx
import pytest
import respx

from syncmypod_local.api import (
    ApiError,
    DeviceApi,
    NotPairedError,
    UnsupportedServerError,
    claim_pairing_code,
)

SERVER = "https://pod.example.org:8444"


@pytest.fixture
def api():
    with DeviceApi(SERVER, "smp_testtoken") as client:
        yield client


@respx.mock
def test_pairing_returns_the_servers_canonical_url():
    """The stored address is the server's own, not whatever the user typed.

    Someone pairing against `http://10.0.0.5:3010/` should end up with whatever
    the server calls itself, or the pairing works once and then cannot find its
    way back.
    """
    respx.post(f"{SERVER}/api/devices/claim").mock(
        return_value=httpx.Response(
            200,
            json={
                "token": "smp_abc123",
                "device": {"id": 7, "name": "Studio PC"},
                "serverUrl": "https://pod.example.org:8444",
            },
        )
    )

    pairing = claim_pairing_code(f"{SERVER}/", "ABCD1234", "Studio PC", "windows")

    assert pairing.token == "smp_abc123"
    assert pairing.device_id == 7
    assert pairing.server_url == "https://pod.example.org:8444"


@respx.mock
def test_pairing_code_is_normalised_before_sending():
    """Users type what they see on screen, spaces and hyphens included."""
    route = respx.post(f"{SERVER}/api/devices/claim").mock(
        return_value=httpx.Response(
            200, json={"token": "t", "device": {"id": 1, "name": "n"}, "serverUrl": SERVER}
        )
    )

    claim_pairing_code(SERVER, " abcd-1234 ", "PC", "linux")

    assert route.calls.last.request.read().decode().count("ABCD1234") == 1


@respx.mock
def test_a_rejected_code_reports_the_servers_wording():
    respx.post(f"{SERVER}/api/devices/claim").mock(
        return_value=httpx.Response(
            400, json={"error": "That code is not valid, has expired, or was already used."}
        )
    )

    with pytest.raises(ApiError, match="not valid, has expired"):
        claim_pairing_code(SERVER, "WRONG123", "PC", "linux")


@respx.mock
def test_an_unreachable_server_says_so_plainly():
    respx.post(f"{SERVER}/api/devices/claim").mock(side_effect=httpx.ConnectError("refused"))

    with pytest.raises(ApiError, match="Could not reach"):
        claim_pairing_code(SERVER, "ABCD1234", "PC", "linux")


@respx.mock
def test_hello_accepts_a_supported_manifest(api):
    respx.get(f"{SERVER}/api/sync/hello").mock(
        return_value=httpx.Response(
            200,
            json={
                "ok": True,
                "manifestVersion": 1,
                "supportedManifestVersions": [1],
                "user": {"id": 1, "username": "mo"},
            },
        )
    )

    assert api.hello()["user"]["username"] == "mo"


@respx.mock
def test_hello_refuses_a_manifest_this_build_cannot_read(api):
    """Stopping is better than guessing.

    A newer server may have changed what a field means. Misreading one writes
    wrong tags to an iPod, which is worse than refusing to run.
    """
    respx.get(f"{SERVER}/api/sync/hello").mock(
        return_value=httpx.Response(
            200, json={"manifestVersion": 99, "supportedManifestVersions": [99]}
        )
    )

    with pytest.raises(UnsupportedServerError, match="Update the local app"):
        api.hello()


@respx.mock
def test_a_revoked_token_is_distinguishable_from_other_failures(api):
    """A 401 needs "pair again"; everything else needs a different fix."""
    respx.get(f"{SERVER}/api/sync/manifest").mock(
        return_value=httpx.Response(
            401, json={"error": "Token is not valid or has been revoked."}
        )
    )

    with pytest.raises(NotPairedError, match="revoked"):
        api.manifest()


@respx.mock
def test_server_errors_are_marked_retryable(api):
    respx.get(f"{SERVER}/api/sync/manifest").mock(return_value=httpx.Response(503, json={}))

    with pytest.raises(ApiError) as caught:
        api.manifest()
    assert caught.value.retryable is True


@respx.mock
def test_a_non_json_body_is_surfaced_not_swallowed(api):
    """A proxy error page should be readable, not a parse failure saying nothing."""
    respx.get(f"{SERVER}/api/sync/hello").mock(
        return_value=httpx.Response(502, text="<html>502 Bad Gateway</html>")
    )

    with pytest.raises(ApiError, match="502 Bad Gateway"):
        api.hello()


@respx.mock
def test_results_are_batched_to_the_servers_limit(api):
    route = respx.post(f"{SERVER}/api/sync/runs/5/results").mock(
        return_value=httpx.Response(200, json={"recorded": 500})
    )

    api.report_results(5, [{"trackId": n, "state": "synced"} for n in range(900)])

    sent = route.calls.last.request.read().decode()
    assert sent.count('"trackId"') == 500


@respx.mock
def test_reporting_nothing_makes_no_request(api):
    route = respx.post(f"{SERVER}/api/sync/runs/5/results")

    assert api.report_results(5, []) == {"recorded": 0}
    assert not route.called


@respx.mock
def test_device_report_omits_undetected_fields(api):
    """Omitting a field leaves the server's stored value alone; sending null would not."""
    route = respx.post(f"{SERVER}/api/sync/device").mock(
        return_value=httpx.Response(200, json={})
    )

    api.report_device({"ipodName": "Mo iPod", "ipodSerial": None, "ipodNeedsHash": True})

    sent = route.calls.last.request.read().decode()
    assert "ipodName" in sent
    assert "ipodSerial" not in sent
