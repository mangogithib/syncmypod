"""Signing in through a browser this application launched.

The frame reader is the part worth testing hard. It is a hand-written slice of
RFC 6455, it is the only place in this project doing binary protocol work, and
the failure it would produce - a cookie list truncated halfway - looks exactly
like a browser that did not sign in. A real signed-in reply is tens of
kilobytes, so the 16-bit length path is the normal case rather than an edge
one, and Chrome is free to split it across continuation frames.

The browser itself is not launched here. That needs Chrome, a window and a
human to type a password, which is what the `hardware` mark exists for; what is
covered is everything either side of it.
"""

from __future__ import annotations

import json
import re
import struct

import pytest

from syncmypod_local import browser_login


class FakeSocket:
    """Stands in for a connected socket, replaying prepared server frames."""

    def __init__(self, *messages: bytes) -> None:
        self.sent: list[bytes] = []
        self._to_read = b"".join(messages)

    def recv(self, count: int) -> bytes:
        chunk, self._to_read = self._to_read[:count], self._to_read[count:]
        return chunk

    def sendall(self, data: bytes) -> None:
        self.sent.append(data)

    def close(self) -> None:
        pass

    def settimeout(self, _value) -> None:
        pass


def server_frame(payload: bytes, *, opcode: int = 0x1, final: bool = True) -> bytes:
    """One unmasked server-to-client frame, the way Chrome sends them."""
    header = bytes([(0x80 if final else 0) | opcode])
    length = len(payload)
    if length < 126:
        header += bytes([length])
    elif length < 1 << 16:
        header += bytes([126]) + struct.pack(">H", length)
    else:
        header += bytes([127]) + struct.pack(">Q", length)
    return header + payload


def connection(*messages: bytes) -> browser_login._Socket:
    """A `_Socket` wired to a fake socket, skipping the HTTP handshake."""
    socket_object = browser_login._Socket.__new__(browser_login._Socket)
    socket_object._sock = FakeSocket(*messages)
    socket_object._buffer = b""
    socket_object._next_id = 0
    return socket_object


class TestReadingFrames:
    def test_a_short_frame(self):
        connected = connection(
            server_frame(json.dumps({"id": 1, "result": {"ok": True}}).encode())
        )
        assert connected.call("Anything") == {"ok": True}

    def test_a_frame_too_long_for_a_seven_bit_length(self):
        """Over 125 bytes the length moves into two extra bytes.

        This is not an edge case here: a signed-in cookie reply is tens of
        kilobytes, so it is the ordinary path.
        """
        cookies = [
            {"name": f"c{n}", "value": "x" * 200, "domain": ".youtube.com"} for n in range(40)
        ]
        payload = json.dumps({"id": 1, "result": {"cookies": cookies}}).encode()
        assert len(payload) > 1 << 8

        connected = connection(server_frame(payload))
        assert len(connected.call("Storage.getCookies")["cookies"]) == 40

    def test_a_frame_too_long_for_a_sixteen_bit_length(self):
        payload = json.dumps({"id": 1, "result": {"blob": "y" * 70000}}).encode()
        assert len(payload) > 1 << 16

        connected = connection(server_frame(payload))
        assert len(connected.call("Anything")["blob"]) == 70000

    def test_a_message_split_across_continuation_frames(self):
        """One logical message, several frames. Reassembly is not optional."""
        payload = json.dumps(
            {"id": 1, "result": {"cookies": [{"name": "LOGIN_INFO"}]}}
        ).encode()
        half = len(payload) // 2
        connected = connection(
            server_frame(payload[:half], opcode=0x1, final=False),
            server_frame(payload[half:], opcode=0x0, final=True),
        )
        assert connected.call("Storage.getCookies")["cookies"] == [{"name": "LOGIN_INFO"}]

    def test_events_arriving_before_the_reply_are_skipped(self):
        """The browser pushes events down the same socket, unasked."""
        connected = connection(
            server_frame(json.dumps({"method": "Target.targetCreated"}).encode()),
            server_frame(json.dumps({"method": "Network.requestWillBeSent"}).encode()),
            server_frame(json.dumps({"id": 1, "result": {"found": "it"}}).encode()),
        )
        assert connected.call("Anything") == {"found": "it"}

    def test_a_ping_is_answered_and_does_not_end_the_read(self):
        connected = connection(
            server_frame(b"keepalive", opcode=0x9),
            server_frame(json.dumps({"id": 1, "result": {"ok": 1}}).encode()),
        )
        assert connected.call("Anything") == {"ok": 1}
        # A pong went back, masked, as a client frame must be.
        assert any(frame[0] & 0x0F == 0xA for frame in connected._sock.sent[1:])

    def test_a_close_frame_is_the_window_being_closed(self):
        connected = connection(server_frame(b"", opcode=0x8))
        with pytest.raises(browser_login.BrowserLoginError, match="closed"):
            connected.call("Anything")

    def test_the_browser_going_away_mid_message_is_not_a_hang(self):
        connected = connection(server_frame(b"x" * 50, final=False)[:10])
        with pytest.raises(browser_login.BrowserLoginError):
            connected.call("Anything")

    def test_an_error_reply_carries_the_browsers_own_words(self):
        connected = connection(
            server_frame(
                json.dumps(
                    {"id": 1, "error": {"message": "'Network.getAllCookies' wasn't found"}}
                ).encode()
            )
        )
        with pytest.raises(browser_login.BrowserLoginError, match="wasn't found"):
            connected.call("Network.getAllCookies")


class TestSendingFrames:
    def test_client_frames_are_masked(self):
        """Not optional. An unmasked client frame is a protocol violation and
        the browser closes the connection rather than answering."""
        connected = connection(server_frame(json.dumps({"id": 1, "result": {}}).encode()))
        connected.call("Browser.getVersion")

        frame = connected._sock.sent[0]
        assert frame[1] & 0x80, "the mask bit was not set"

    def test_each_call_uses_a_new_id(self):
        connected = connection(
            server_frame(json.dumps({"id": 1, "result": {}}).encode()),
            server_frame(json.dumps({"id": 2, "result": {}}).encode()),
        )
        connected.call("One")
        connected.call("Two")
        assert connected._next_id == 2


class TestDecidingWhetherSomebodyIsSignedIn:
    def test_an_anonymous_session_is_not_signed_in(self):
        """What a fresh profile on youtube.com actually holds - measured."""
        cookies = [
            {"name": n, "domain": ".youtube.com"}
            for n in ("PREF", "VISITOR_PRIVACY_METADATA", "YSC", "__Secure-ROLLOUT_TOKEN")
        ]
        assert browser_login._is_signed_in(cookies) is False

    @pytest.mark.parametrize("marker", sorted(browser_login.SIGNED_IN_MARKERS))
    def test_any_account_cookie_counts(self, marker):
        cookies = [
            {"name": "YSC", "domain": ".youtube.com"},
            {"name": marker, "domain": ".youtube.com"},
        ]
        assert browser_login._is_signed_in(cookies) is True

    def test_the_same_cookie_on_another_site_does_not_count(self):
        """`SID` exists on google.com too, and this is a YouTube session."""
        assert browser_login._is_signed_in([{"name": "SID", "domain": ".google.com"}]) is False


class TestOnlyYouTubeCookiesLeave:
    """The browser profile holds whatever was visited in it, and the protocol
    hands over all of it. Filtering happens before the caller sees anything."""

    def test_other_sites_are_dropped(self):
        kept = browser_login._youtube_only(
            [
                {"name": "SID", "domain": ".youtube.com"},
                {"name": "SESSION", "domain": ".bank.example"},
                {"name": "APISID", "domain": ".google.com"},
                {"name": "X", "domain": "www.youtube.com"},
            ]
        )
        assert {c["name"] for c in kept} == {"SID", "X"}

    def test_a_lookalike_domain_is_not_youtube(self):
        kept = browser_login._youtube_only([{"name": "X", "domain": "notyoutube.com"}])
        assert kept == []


class TestFindingABrowser:
    def test_none_installed_says_what_to_do(self, monkeypatch, tmp_path):
        monkeypatch.setattr(browser_login, "find_browser", lambda: None)
        with pytest.raises(browser_login.BrowserLoginError, match=re.escape("cookies.txt")):
            browser_login.collect_cookies(tmp_path)

    def test_the_profile_lives_beside_the_other_settings(self, tmp_path):
        """Kept rather than temporary: the whole point is that the second
        sign-in needs no typing."""
        assert browser_login.profile_dir(tmp_path).parent == tmp_path
