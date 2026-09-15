"""The local GUI server.

Mostly about what it refuses. This is a server listening on a machine that also
browses the web, and a page you happen to have open can make requests to
localhost - so the interesting assertions here are the ones about requests that
must not work.
"""

from __future__ import annotations

import json
import threading
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest

from syncmypod_local import gui


@pytest.fixture
def server():
    running = gui.GuiServer()
    thread = threading.Thread(target=running.serve_forever, daemon=True)
    thread.start()
    yield running
    running.shutdown()
    thread.join(timeout=5)


def call(server, path, *, token=None, method="GET", host=None, body=None):
    headers = {"Host": host or server.address}
    if token:
        headers["X-SyncMyPod-Token"] = token
    if body is not None:
        headers["Content-Type"] = "application/json"
    request = Request(
        f"http://{server.address}{path}",
        method=method,
        headers=headers,
        data=json.dumps(body).encode() if body is not None else None,
    )
    with urlopen(request, timeout=10) as response:
        return response.status, json.loads(response.read() or b"{}")


class TestItRefuses:
    def test_an_api_request_without_the_token(self, server):
        """The token is the only thing a hostile page cannot guess."""
        with pytest.raises(HTTPError) as raised:
            call(server, "/api/state")
        assert raised.value.code == 401

    def test_a_wrong_token(self, server):
        with pytest.raises(HTTPError) as raised:
            call(server, "/api/state", token="not-the-token")
        assert raised.value.code == 401

    def test_a_host_header_pointing_somewhere_else(self, server):
        """A hostile DNS name resolving to 127.0.0.1 is the attack this stops.

        Without the check, a page at evil.example whose domain resolves to
        loopback would be same-origin with this server and could read its
        responses.
        """
        with pytest.raises(HTTPError) as raised:
            call(server, "/api/state", token=server.session.token, host="evil.example")
        assert raised.value.code == 403

    def test_a_static_path_that_tries_to_climb_out(self, server):
        """The config file, holding the device token, is two directories up."""
        with pytest.raises(HTTPError) as raised:
            call(
                server,
                "/static/..%2f..%2fconfig.py",
                token=server.session.token,
            )
        assert raised.value.code == 404

    def test_the_index_without_a_token(self, server):
        with pytest.raises(HTTPError) as raised:
            call(server, "/", host=server.address)
        assert raised.value.code == 401


class TestItServes:
    def test_the_page_when_the_token_is_in_the_url(self, server):
        request = Request(
            f"http://{server.address}/?t={server.session.token}",
            headers={"Host": server.address},
        )
        with urlopen(request, timeout=10) as response:
            assert response.status == 200
            assert b"SyncMyPod" in response.read()
            # Exchanged for a cookie immediately, so the credential does not
            # stay in the address bar for the rest of the session.
            assert "syncmypod_gui=" in response.headers["Set-Cookie"]

    def test_state_describes_both_halves(self, server):
        status, body = call(server, "/api/state", token=server.session.token)
        assert status == 200
        assert set(body) >= {"paired", "ffmpeg", "ipod", "running"}

    def test_events_start_empty(self, server):
        _status, body = call(server, "/api/events?since=0", token=server.session.token)
        assert body == {"events": [], "running": False, "summary": None, "error": None}

    def test_it_binds_to_loopback_only(self, server):
        assert server.address.startswith("127.0.0.1:")


class TestRuns:
    def test_a_second_sync_is_refused_while_one_is_going(self, server):
        server.session.running = True
        _status, body = call(
            server, "/api/sync", token=server.session.token, method="POST", body={}
        )
        assert body == {"started": False, "error": "A sync is already running."}

    def test_an_unpaired_computer_fails_with_a_message_not_a_crash(self, server, monkeypatch):
        from syncmypod_local import config

        monkeypatch.setattr(config, "load", lambda: config.Config())
        call(server, "/api/sync", token=server.session.token, method="POST", body={})

        for _ in range(100):
            _status, body = call(server, "/api/events?since=0", token=server.session.token)
            if not body["running"] and body["error"]:
                break
        assert "not paired" in (body["error"] or "")

    def test_cancelling_sets_the_flag_the_engine_polls(self, server):
        _status, body = call(
            server, "/api/cancel", token=server.session.token, method="POST", body={}
        )
        assert body == {"cancelling": True}
        assert server.session.cancelled is True


class TestPairing:
    """Pairing from the page, so nothing needs a terminal."""

    @pytest.fixture
    def fresh(self, tmp_path, monkeypatch):
        monkeypatch.setenv("SYNCMYPOD_CONFIG_DIR", str(tmp_path))
        return tmp_path

    def test_an_empty_server_is_refused_before_any_request(self, server, fresh):
        _status, body = call(
            server,
            "/api/pair",
            token=server.session.token,
            method="POST",
            body={"server": "", "code": "ABCD1234"},
        )
        assert body["paired"] is False
        assert "address" in body["error"]

    def test_an_empty_code_is_refused(self, server, fresh):
        _status, body = call(
            server,
            "/api/pair",
            token=server.session.token,
            method="POST",
            body={"server": "https://pod.example", "code": "  "},
        )
        assert body["paired"] is False
        assert "code" in body["error"]

    def test_a_server_that_cannot_be_reached_reports_it(self, server, fresh):
        """An unreachable address is the commonest typo, and the message has to
        be the one the user sees rather than a traceback."""
        _status, body = call(
            server,
            "/api/pair",
            token=server.session.token,
            method="POST",
            body={"server": "https://127.0.0.1:1", "code": "ABCD1234"},
        )
        assert body["paired"] is False
        assert body["error"]

    def test_it_needs_the_token(self, server, fresh):
        with pytest.raises(HTTPError) as raised:
            call(server, "/api/pair", method="POST", body={"server": "x", "code": "y"})
        assert raised.value.code == 401

    def test_unpairing_reports_whether_there_was_anything_to_forget(self, server, fresh):
        from syncmypod_local import config

        config.save(config.Config(server_url="https://pod.example", token="smp_t"))
        _status, body = call(
            server, "/api/unpair", token=server.session.token, method="POST", body={}
        )
        assert body == {"unpaired": True}
        assert not config.load().is_paired


class TestEvents:
    def test_they_are_numbered_so_a_reload_can_catch_up(self, server):
        server.session.add("track", label="one")
        server.session.add("track", label="two")

        _status, body = call(server, "/api/events?since=1", token=server.session.token)
        assert [event["label"] for event in body["events"]] == ["two"]

    def test_the_backlog_is_capped(self, server):
        """A long sync must not grow the process without limit."""
        for index in range(2200):
            server.session.add("track", label=str(index))
        assert len(server.session.events) <= 2000


class TestTheBackupSetting:
    """Turning off the snapshot taken before a sync writes anything.

    Saved as soon as it is changed rather than only when a sync starts, because
    the page presents it as a setting and closing the window must not discard it.
    """

    @pytest.fixture
    def fresh(self, tmp_path, monkeypatch):
        monkeypatch.setenv("SYNCMYPOD_CONFIG_DIR", str(tmp_path))
        return tmp_path

    def test_it_is_on_by_default(self, server, fresh):
        _status, body = call(server, "/api/state", token=server.session.token)
        assert body["backupBeforeSync"] is True

    def test_turning_it_off_is_remembered(self, server, fresh):
        from syncmypod_local import config

        call(
            server,
            "/api/settings",
            token=server.session.token,
            method="POST",
            body={"backupBeforeSync": False},
        )

        assert config.load().backup_before_sync is False
        _status, body = call(server, "/api/state", token=server.session.token)
        assert body["backupBeforeSync"] is False

    def test_turning_it_back_on_is_remembered(self, server, fresh):
        from syncmypod_local import config

        for enabled in (False, True):
            call(
                server,
                "/api/settings",
                token=server.session.token,
                method="POST",
                body={"backupBeforeSync": enabled},
            )
        assert config.load().backup_before_sync is True

    def test_it_needs_the_token(self, server, fresh):
        """It writes to the config file, so it is not an open endpoint."""
        with pytest.raises(HTTPError) as raised:
            call(
                server,
                "/api/settings",
                method="POST",
                body={"backupBeforeSync": False},
            )
        assert raised.value.code == 401


class TestTheApplicationWindow:
    """Showing the page in a window of its own rather than a browser tab.

    The interaction under test is small and the bug it is here to prevent was
    not: 0.1.8 shut the server down when the window failed to open and then
    handed its address to a browser, so the user got a connection refused page
    beside a console claiming the application was running.
    """

    def test_it_leaves_the_server_running_when_no_window_can_open(self, monkeypatch):
        """The bug from 0.1.8, asserted.

        The caller falls back to the default browser when this returns False,
        and that browser needs something to connect to.
        """
        from syncmypod_local.gui import window

        monkeypatch.setattr(window, "find_browser", lambda: None)

        shutdowns = []

        class Fake:
            url = "http://127.0.0.1:1/"
            idle_for = 0.0

            def serve_forever(self):
                pass

            def shutdown(self):
                shutdowns.append(True)

        assert window.run(Fake()) is False
        assert shutdowns == [], "the server was stopped with nothing else serving"

    @staticmethod
    def _quick(monkeypatch):
        """Shrinks the timers so a test does not take 45 seconds."""
        from syncmypod_local.gui import window

        monkeypatch.setattr(window, "IDLE_TIMEOUT", 0.6)
        monkeypatch.setattr(window, "STARTUP_GRACE", 0.3)
        monkeypatch.setattr(window, "POLL_SECONDS", 0.05)
        return window

    def test_closing_the_window_stops_the_server(self, monkeypatch, tmp_path):
        """Closing an application's only window should end it."""
        window = self._quick(monkeypatch)
        monkeypatch.setenv("SYNCMYPOD_CONFIG_DIR", str(tmp_path))
        monkeypatch.setattr(window, "find_browser", lambda: "browser")

        class Gone:
            def poll(self):
                return 0

            def terminate(self):
                pass

        monkeypatch.setattr(window.subprocess, "Popen", lambda *a, **k: Gone())

        shutdowns = []

        class Fake:
            url = "http://127.0.0.1:1/"
            # Nothing has asked for a page in a long time, so there is no window.
            idle_for = 9999.0

            def serve_forever(self):
                pass

            def shutdown(self):
                shutdowns.append(True)

        assert window.run(Fake()) is True
        assert shutdowns == [True]

    def test_a_browser_that_hands_off_and_exits_does_not_kill_the_window(
        self, monkeypatch, tmp_path
    ):
        """The bug 0.1.9 shipped, asserted.

        A Chromium launcher passes the request to a session process and exits,
        so waiting on the process returns while the window is still on screen.
        0.1.9 shut the server down at that point, and the window - which had
        opened correctly, with no tabs and no address bar - showed "can't reach
        this page".

        Whether the launcher does this depends on whether that profile already
        had a browser running, which is why it worked once in testing and not on
        the machine it shipped to. So the page is the authority now: it pings,
        and while pings arrive the server stays up however the process behaves.
        """
        window = self._quick(monkeypatch)
        monkeypatch.setenv("SYNCMYPOD_CONFIG_DIR", str(tmp_path))
        monkeypatch.setattr(window, "find_browser", lambda: "browser")

        class HandedOffAndExited:
            def poll(self):
                return 0

            def terminate(self):
                pass

        monkeypatch.setattr(window.subprocess, "Popen", lambda *a, **k: HandedOffAndExited())

        shutdowns = []

        class StillOpen:
            """A window that is alive and saying so."""

            url = "http://127.0.0.1:1/"

            def __init__(self):
                self._pings = 0

            @property
            def idle_for(self):
                # Answers "just pinged" a few times, then falls silent as if
                # the window had been closed.
                self._pings += 1
                return 0.0 if self._pings < 8 else 9999.0

            def serve_forever(self):
                pass

            def shutdown(self):
                shutdowns.append(True)

        server = StillOpen()
        window.run(server)

        assert shutdowns == [True], "the server should stop once the window really goes"
        assert server._pings >= 8, "it gave up while the page was still pinging"

    def test_the_window_gets_a_profile_of_its_own(self, monkeypatch, tmp_path):
        """Without it there is no process to wait on.

        `msedge --app=...` against the user's normal profile is handed to the
        browser they already have open and returns immediately, so the server
        would be shut down while the window was still on screen.
        """
        window = self._quick(monkeypatch)
        monkeypatch.setenv("SYNCMYPOD_CONFIG_DIR", str(tmp_path))
        monkeypatch.setattr(window, "find_browser", lambda: "browser")

        seen = {}

        class Gone:
            def poll(self):
                return 0

            def terminate(self):
                pass

        def capture(command, **_kwargs):
            seen["command"] = command
            return Gone()

        monkeypatch.setattr(window.subprocess, "Popen", capture)

        class Fake:
            url = "http://127.0.0.1:1/"
            idle_for = 9999.0

            def serve_forever(self):
                pass

            def shutdown(self):
                pass

        window.run(Fake())

        assert any(arg.startswith("--app=") for arg in seen["command"])
        assert any("--user-data-dir=" in arg for arg in seen["command"])

    def test_a_browser_that_will_not_start_is_not_fatal(self, monkeypatch, tmp_path):
        from syncmypod_local.gui import window

        monkeypatch.setenv("SYNCMYPOD_CONFIG_DIR", str(tmp_path))
        monkeypatch.setattr(window, "find_browser", lambda: "browser")
        monkeypatch.setattr(
            window.subprocess, "Popen", lambda *a, **k: (_ for _ in ()).throw(OSError("nope"))
        )

        shutdowns = []

        class Fake:
            url = "http://127.0.0.1:1/"
            idle_for = 0.0

            def serve_forever(self):
                pass

            def shutdown(self):
                shutdowns.append(True)

        assert window.run(Fake()) is False
        assert shutdowns == [], "the fallback browser needs the server still up"
