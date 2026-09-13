"""The sync engine, run end to end against a simulated iPod.

The device is a real pypodlib virtual iPod of the model this project targets, so
the database really is parsed, written and signed - the part that cannot be
faked. Only the two things that reach the outside world are stubbed: the server
(mocked at the HTTP boundary with respx, so the client code is exercised) and
the audio source (replaced with a fixture file, because a test must not depend
on a video still being on YouTube).
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import httpx
import pytest
import respx

from helpers import CLASSIC_6G, SERVER, manifest, mock_server, reported, track
from syncmypod_local import config, device, downloader, ledger, sync, transcode, workspace

FIXTURES = Path(__file__).parent / "fixtures"


def workspaces_now() -> set:
    """Download folders in the system temp directory, right now.

    Compared before and after rather than asserted to be empty. The workspace
    lives in the shared system temp, so "there are none at all" is a claim about
    every process on the machine - a second test run, or the installed
    application doing a real sync - and it fails for reasons that have nothing
    to do with the code under test. What matters is that *this* run left nothing
    of its own.
    """
    import tempfile

    return set(Path(tempfile.gettempdir()).glob(f"{workspace._PREFIX}*"))


@pytest.fixture
def ipod(tmp_path):
    """A simulated Classic 6.5g - the model the project was tested against."""
    return device.create_virtual(tmp_path / "ipod", CLASSIC_6G, name="Test Classic")


@pytest.fixture
def paired():
    return config.Config(server_url=SERVER, token="smp_testtoken", device_name="Test PC")


@pytest.fixture
def audio_source(monkeypatch):
    """Replaces the download with a fixture, and records what was asked for."""
    asked: list[dict] = []

    def fake_fetch(track_dict, destination):
        asked.append(track_dict)
        destination.mkdir(parents=True, exist_ok=True)
        landed = destination / "source.m4a"
        shutil.copy(FIXTURES / "tagged.m4a", landed)
        return downloader.Download(
            path=landed,
            source="youtube",
            source_url="https://example/watch?v=test",
            duration_seconds=268.0,
            bitrate_kbps=128,
        )

    monkeypatch.setattr(downloader, "fetch", fake_fetch)
    return asked


# ---------------------------------------------------------------------------


class TestAFullRun:
    @respx.mock
    def test_tracks_reach_the_device_and_the_server_is_told(self, ipod, paired, audio_source):
        results, finish = mock_server(manifest())

        report = sync.run(paired, mount=str(ipod.mount_path))

        assert report.synced == 2
        assert not report.failed

        # On the device, in its database, not merely copied into a folder.
        on_device = device.open_at(ipod.mount_path).tracks()
        assert {t.title for t in on_device} == {"Track 1", "Track 2"}

        states = {r["trackId"]: r["state"] for r in reported(results)}
        assert states == {1: "synced", 2: "synced"}
        assert json.loads(finish.calls[0].request.content)["status"] == "done"

    @respx.mock
    def test_the_manifest_metadata_wins_over_the_source(self, ipod, paired, audio_source):
        """The rule, checked where it finally matters: in the iPod's database.

        The fixture is tagged "Lyric Video" by "Topic Channel". If any of that
        reaches the device, the architecture has failed at the only point the
        user would ever see.
        """
        mock_server(manifest(tracks=[track(1)]))

        sync.run(paired, mount=str(ipod.mount_path))

        written = device.open_at(ipod.mount_path).tracks()[0]
        assert written.title == "Track 1"
        assert written.artist == "Aurora Kane"
        assert written.album == "Longer Days"

    @respx.mock
    def test_nothing_downloaded_is_left_behind(self, ipod, paired, audio_source, tmp_path):
        mock_server(manifest())

        before = workspaces_now()
        sync.run(paired, mount=str(ipod.mount_path))

        assert not (workspaces_now() - before), "this run left its downloads behind"

    @respx.mock
    def test_a_backup_is_taken_before_anything_is_written(self, ipod, paired, audio_source):
        mock_server(manifest())
        report = sync.run(paired, mount=str(ipod.mount_path))
        assert report.backup_id


class TestTheDiff:
    @respx.mock
    def test_a_second_run_does_no_work(self, ipod, paired, audio_source):
        """The ledger's whole purpose: the same library twice is not two copies."""
        mock_server(manifest())
        sync.run(paired, mount=str(ipod.mount_path))

        second = sync.run(paired, mount=str(ipod.mount_path))
        assert second.synced == 0
        assert len(second.plan.already_present) == 2
        assert not second.plan.to_download

    @respx.mock
    def test_only_the_new_track_is_downloaded(self, ipod, paired, audio_source):
        mock_server(manifest(tracks=[track(1)]))
        sync.run(paired, mount=str(ipod.mount_path))

        respx.get(f"{SERVER}/api/sync/manifest").mock(
            return_value=httpx.Response(200, json=manifest(tracks=[track(1), track(2)]))
        )
        audio_source.clear()
        second = sync.run(paired, mount=str(ipod.mount_path))

        assert [t["id"] for t in audio_source] == [2]
        assert second.synced == 1

    @respx.mock
    def test_a_track_already_on_the_device_is_adopted_not_downloaded(
        self, ipod, paired, audio_source
    ):
        """First sync to an iPod that already holds the library does no work.

        The ledger will not exist - the tracks were put there by iTunes or
        another tool - so the fallback match on title, artist and album has to
        recognise them, or the user gets a duplicate of everything.
        """
        mock_server(manifest(tracks=[track(1)]))
        sync.run(paired, mount=str(ipod.mount_path))

        # Delete the ledger, leaving the tracks in place: exactly the state an
        # iPod filled by something else is in.
        (ipod.mount_path / "iPod_Control" / "Device" / "SyncMyPod.json").unlink()
        audio_source.clear()

        second = sync.run(paired, mount=str(ipod.mount_path))
        assert not audio_source, "re-downloaded a track that was already there"
        assert len(second.plan.adopted) == 1

    @respx.mock
    def test_a_track_deleted_from_the_device_is_downloaded_again(
        self, ipod, paired, audio_source
    ):
        """The server's deviceState says synced; the device says otherwise.

        Someone deleting a track with iTunes is exactly why the diff is made
        against the device rather than against what the server believes.
        """
        mock_server(manifest(tracks=[track(1)]))
        sync.run(paired, mount=str(ipod.mount_path))

        # Empty the device's database but keep the ledger, so the ledger points
        # at a location that no longer exists.
        handle = device.open_at(ipod.mount_path)._handle
        library = handle.library()
        for existing in list(library.tracks):
            library.remove_track(existing)
        handle.save()

        audio_source.clear()
        respx.get(f"{SERVER}/api/sync/manifest").mock(
            return_value=httpx.Response(
                200, json=manifest(tracks=[track(1, deviceState="synced")])
            )
        )
        second = sync.run(paired, mount=str(ipod.mount_path))

        assert [t["id"] for t in audio_source] == [1]
        assert second.synced == 1


class TestPlaylists:
    @respx.mock
    def test_written_in_the_manifest_order(self, ipod, paired, audio_source):
        mock_server(
            manifest(
                tracks=[track(1), track(2), track(3)],
                playlists=[{"id": 1, "name": "Morning Drive", "trackIds": [3, 1, 2]}],
            )
        )
        report = sync.run(paired, mount=str(ipod.mount_path))
        assert report.playlists_written == 1

        library = device.open_at(ipod.mount_path)._handle.library()
        playlist = library.get_playlist("Morning Drive")
        by_id = {t.db_track_id: t.title for t in library.tracks}
        assert [by_id[i] for i in playlist.track_ids] == ["Track 3", "Track 1", "Track 2"]

    @respx.mock
    def test_a_track_that_failed_is_dropped_rather_than_leaving_a_gap(
        self, ipod, paired, audio_source, monkeypatch
    ):
        def fail_for_two(track_dict, destination):
            if track_dict["id"] == 2:
                raise downloader.DownloadError("nothing found")
            destination.mkdir(parents=True, exist_ok=True)
            landed = destination / "source.m4a"
            shutil.copy(FIXTURES / "tagged.m4a", landed)
            return downloader.Download(landed, "youtube", "https://x", 268.0, 128)

        monkeypatch.setattr(downloader, "fetch", fail_for_two)
        mock_server(
            manifest(
                tracks=[track(1), track(2)],
                playlists=[{"id": 1, "name": "Mixed", "trackIds": [1, 2]}],
            )
        )
        sync.run(paired, mount=str(ipod.mount_path))

        library = device.open_at(ipod.mount_path)._handle.library()
        assert len(library.get_playlist("Mixed").track_ids) == 1

    @respx.mock
    def test_a_playlist_on_the_device_that_the_library_does_not_have_is_left_alone(
        self, ipod, paired, audio_source
    ):
        """Someone may have made it on the iPod. It is not ours to delete."""
        handle = device.open_at(ipod.mount_path)._handle
        handle.library().create_playlist("Made on the iPod")
        handle.save()

        mock_server(
            manifest(tracks=[track(1)], playlists=[{"id": 1, "name": "Mine", "trackIds": [1]}])
        )
        sync.run(paired, mount=str(ipod.mount_path))

        names = device.open_at(ipod.mount_path).playlist_names()
        assert "Made on the iPod" in names
        assert "Mine" in names


class TestRemovals:
    @respx.mock
    def test_nothing_is_removed_unless_asked(self, ipod, paired, audio_source):
        mock_server(manifest(tracks=[track(1), track(2)]))
        sync.run(paired, mount=str(ipod.mount_path))

        respx.get(f"{SERVER}/api/sync/manifest").mock(
            return_value=httpx.Response(200, json=manifest(tracks=[track(1)]))
        )
        second = sync.run(paired, mount=str(ipod.mount_path))

        assert len(second.plan.removals) == 1
        assert second.removed == 0
        assert len(device.open_at(ipod.mount_path).tracks()) == 2

    @respx.mock
    def test_removing_takes_the_file_as_well_as_the_row(self, ipod, paired, audio_source):
        """A row without a file plays silence; a file without a row is dead space."""
        mock_server(manifest(tracks=[track(1), track(2)]))
        sync.run(paired, mount=str(ipod.mount_path))

        record = ledger.load(ipod.mount_path, SERVER, 1)
        doomed = record.entries[2].location
        on_disk = ipod.mount_path.joinpath(*[p for p in doomed.split(":") if p])
        assert on_disk.exists()

        respx.get(f"{SERVER}/api/sync/manifest").mock(
            return_value=httpx.Response(200, json=manifest(tracks=[track(1)]))
        )
        second = sync.run(paired, mount=str(ipod.mount_path), remove=True)

        assert second.removed == 1
        assert not on_disk.exists()
        assert {t.title for t in device.open_at(ipod.mount_path).tracks()} == {"Track 1"}

    @respx.mock
    def test_a_track_this_tool_never_added_is_never_removed(self, ipod, paired, audio_source):
        """The iPod may hold years of music put there by something else.

        This is the single most important safety property in the engine: it
        knows exactly which tracks are its own, and everything else is somebody
        else's music.
        """
        stranger = ipod.mount_path / "iPod_Control" / "Music" / "F00" / "STRANGER.m4a"
        stranger.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(FIXTURES / "tagged.m4a", stranger)
        handle = device.open_at(ipod.mount_path)._handle
        handle.add_tracks([str(stranger)], raise_on_error=True)

        mock_server(manifest(tracks=[]))
        report = sync.run(paired, mount=str(ipod.mount_path), remove=True)

        assert report.removed == 0
        assert not report.plan.removals
        assert len(device.open_at(ipod.mount_path).tracks()) == 1


class TestFailures:
    @respx.mock
    def test_one_track_failing_does_not_stop_the_others(self, ipod, paired, monkeypatch):
        def fail_for_two(track_dict, destination):
            if track_dict["id"] == 2:
                raise downloader.DownloadError("No source found")
            destination.mkdir(parents=True, exist_ok=True)
            landed = destination / "source.m4a"
            shutil.copy(FIXTURES / "tagged.m4a", landed)
            return downloader.Download(landed, "youtube", "https://x", 268.0, 128)

        monkeypatch.setattr(downloader, "fetch", fail_for_two)
        results, _ = mock_server(manifest(tracks=[track(1), track(2), track(3)]))

        report = sync.run(paired, mount=str(ipod.mount_path))

        assert report.synced == 2
        assert [r.track_id for r in report.failed] == [2]
        states = {r["trackId"]: r["state"] for r in reported(results)}
        assert states == {1: "synced", 2: "failed", 3: "synced"}

    @respx.mock
    def test_results_are_reported_as_the_run_goes_not_only_at_the_end(
        self, ipod, paired, audio_source
    ):
        """An interrupted sync must not re-download what already landed."""
        results, _ = mock_server(manifest(tracks=[track(i) for i in range(1, 6)]))

        sync.run(paired, mount=str(ipod.mount_path), batch_size=2)

        assert len(results.calls) > 1, "everything was reported in one batch at the end"

    @respx.mock
    def test_a_server_that_stops_answering_does_not_lose_the_sync(
        self, ipod, paired, audio_source
    ):
        """Reporting is bookkeeping. The iPod still gets its music."""
        mock_server(manifest(tracks=[track(1)]))
        respx.post(f"{SERVER}/api/sync/runs/7/results").mock(
            side_effect=httpx.ConnectError("server went away")
        )

        report = sync.run(paired, mount=str(ipod.mount_path))
        assert report.synced == 1
        assert len(device.open_at(ipod.mount_path).tracks()) == 1


class TestDryRun:
    @respx.mock
    def test_writes_nothing(self, ipod, paired, audio_source):
        mock_server(manifest())
        report = sync.run(paired, mount=str(ipod.mount_path), dry_run=True)

        assert len(report.plan.to_download) == 2
        assert not audio_source, "a dry run downloaded something"
        assert device.open_at(ipod.mount_path).tracks() == []

    @respx.mock
    def test_does_not_open_a_run_on_the_server(self, ipod, paired, audio_source):
        mock_server(manifest())
        route = respx.post(f"{SERVER}/api/sync/runs")
        sync.run(paired, mount=str(ipod.mount_path), dry_run=True)
        assert not route.calls


class TestGuards:
    def test_an_unpaired_computer_is_told_what_to_do(self, ipod):
        with pytest.raises(sync.SyncError, match="not paired"):
            sync.run(config.Config(), mount=str(ipod.mount_path))

    @respx.mock
    def test_excluded_tracks_are_surfaced_not_silently_dropped(
        self, ipod, paired, audio_source
    ):
        """The fix is in the web interface, so the user has to hear about it."""
        mock_server(
            manifest(
                tracks=[track(1)],
                excluded=[{"id": 9, "title": "Halfway Down", "metadataState": "unresolved"}],
            )
        )
        report = sync.run(paired, mount=str(ipod.mount_path))
        assert len(report.plan.excluded) == 1

    @respx.mock
    def test_limit_caps_how_much_a_first_run_does(self, ipod, paired, audio_source):
        mock_server(manifest(tracks=[track(i) for i in range(1, 6)]))
        report = sync.run(paired, mount=str(ipod.mount_path), limit=2)
        assert report.synced == 2


@pytest.mark.skipif(not transcode.available(), reason="ffmpeg is not installed")
class TestTranscoding:
    @respx.mock
    def test_opus_is_converted_because_an_ipod_cannot_play_it(self, ipod, paired, monkeypatch):
        """The one format conversion that is not optional."""

        def opus_source(track_dict, destination):
            destination.mkdir(parents=True, exist_ok=True)
            landed = destination / "source.opus"
            shutil.copy(FIXTURES / "source.opus", landed)
            return downloader.Download(landed, "youtube", "https://x", 1.0, 64)

        monkeypatch.setattr(downloader, "fetch", opus_source)
        mock_server(manifest(tracks=[track(1)]))

        report = sync.run(paired, mount=str(ipod.mount_path))

        assert report.synced == 1
        assert report.results[0].format in {"m4a", "mp3"}
        written = device.open_at(ipod.mount_path).tracks()[0]
        assert written.location.lower().endswith((".m4a", ".mp3"))

    @respx.mock
    def test_aac_is_passed_through_untouched(self, ipod, paired, audio_source):
        """Re-encoding a lossy source a second time is pure loss."""
        mock_server(manifest(tracks=[track(1)]))
        sync.run(paired, mount=str(ipod.mount_path))
        assert device.open_at(ipod.mount_path).tracks()[0].location.lower().endswith(".m4a")


class TestFetchingSeveralAtOnce:
    """Downloads run in parallel; writes to the device do not.

    The slow part of a sync is the network, and a track's download, conversion
    and tagging touch nothing another track touches. Writing the iTunesDB does,
    so it stays on one thread in batches - the property worth protecting is that
    parallelism never reaches the device.
    """

    @pytest.fixture
    def slow_source(self, monkeypatch):
        """A download that takes long enough for overlap to be observable."""
        import threading
        import time

        active = 0
        peak = 0
        guard = threading.Lock()

        def fake_fetch(track_dict, destination):
            nonlocal active, peak
            with guard:
                active += 1
                peak = max(peak, active)
            try:
                time.sleep(0.15)
                destination.mkdir(parents=True, exist_ok=True)
                landed = destination / "source.m4a"
                shutil.copy(FIXTURES / "tagged.m4a", landed)
                return downloader.Download(
                    path=landed,
                    source="youtube",
                    source_url="https://example/watch?v=test",
                    duration_seconds=268.0,
                    bitrate_kbps=128,
                )
            finally:
                with guard:
                    active -= 1

        monkeypatch.setattr(downloader, "fetch", fake_fetch)
        return lambda: peak

    @respx.mock
    def test_more_than_one_download_is_in_flight(self, ipod, paired, slow_source):
        mock_server(manifest([track(n) for n in range(1, 9)]))

        report = sync.run(paired, mount=str(ipod.mount_path), concurrency=4)

        assert report.synced == 8
        assert slow_source() > 1, "downloads ran one at a time"
        assert slow_source() <= 4, "more were in flight than were asked for"

    @respx.mock
    def test_one_at_a_time_is_still_possible(self, ipod, paired, slow_source):
        """The old behaviour, for a connection that cannot take four at once."""
        mock_server(manifest([track(n) for n in range(1, 5)]))

        report = sync.run(paired, mount=str(ipod.mount_path), concurrency=1)

        assert report.synced == 4
        assert slow_source() == 1

    @respx.mock
    def test_every_track_arrives_whatever_order_they_finish_in(self, ipod, paired, monkeypatch):
        """Completion order is not plan order, and nothing may depend on it."""
        import time

        def fake_fetch(track_dict, destination):
            # Later ids finish first, so completion order is reversed.
            time.sleep(0.4 / max(1, int(track_dict["id"])))
            destination.mkdir(parents=True, exist_ok=True)
            landed = destination / "source.m4a"
            shutil.copy(FIXTURES / "tagged.m4a", landed)
            return downloader.Download(
                path=landed,
                source="youtube",
                source_url="https://example/watch?v=test",
                duration_seconds=268.0,
                bitrate_kbps=128,
            )

        monkeypatch.setattr(downloader, "fetch", fake_fetch)
        mock_server(manifest([track(n) for n in range(1, 7)]))

        report = sync.run(paired, mount=str(ipod.mount_path), concurrency=4)

        assert report.synced == 6
        assert {r.track_id for r in report.results if r.state == "synced"} == set(range(1, 7))
        assert len(ipod.tracks(reload=True)) == 6

    @respx.mock
    def test_one_failure_does_not_take_the_others_with_it(self, ipod, paired, monkeypatch):
        def fake_fetch(track_dict, destination):
            if int(track_dict["id"]) == 3:
                raise downloader.DownloadError("nothing playable was found")
            destination.mkdir(parents=True, exist_ok=True)
            landed = destination / "source.m4a"
            shutil.copy(FIXTURES / "tagged.m4a", landed)
            return downloader.Download(
                path=landed,
                source="youtube",
                source_url="https://example/watch?v=test",
                duration_seconds=268.0,
                bitrate_kbps=128,
            )

        monkeypatch.setattr(downloader, "fetch", fake_fetch)
        mock_server(manifest([track(n) for n in range(1, 6)]))

        report = sync.run(paired, mount=str(ipod.mount_path), concurrency=4)

        assert report.synced == 4
        assert [r.track_id for r in report.failed] == [3]

    @respx.mock
    def test_cancelling_stops_submitting_and_keeps_what_finished(
        self, ipod, paired, slow_source
    ):
        """Stopping between tracks, not during one.

        Anything already fetched is still written and recorded, because the
        alternative is throwing away work that is already paid for and leaving
        the device's database part-written.
        """
        mock_server(manifest([track(n) for n in range(1, 21)]))

        calls = {"n": 0}

        def cancel_after_a_moment() -> bool:
            calls["n"] += 1
            return calls["n"] > 4

        report = sync.run(
            paired,
            mount=str(ipod.mount_path),
            concurrency=4,
            cancel=cancel_after_a_moment,
        )

        assert report.status == "cancelled"
        assert "left" in (report.message or "")
        assert report.synced < 20
        # Whatever was written is really on the device, not half-written.
        assert len(ipod.tracks(reload=True)) == report.synced

    @respx.mock
    def test_nothing_is_left_on_disk_when_several_ran_at_once(
        self, ipod, paired, slow_source, tmp_path
    ):
        mock_server(manifest([track(n) for n in range(1, 9)]))

        before = workspaces_now()
        sync.run(paired, mount=str(ipod.mount_path), concurrency=4)

        assert not (workspaces_now() - before), "this run left its downloads behind"


class TestOneBadFileDoesNotEndTheRun:
    """What stopped a 431-track sync after 45 on 12 September.

    `add_files` writes the batch and commits the database in one call, so a file
    the device will not take used to take the whole batch - and the whole run -
    with it. An hour of downloading thrown away over one track is the wrong
    trade, especially when the web tool already knows how to show a failed one.
    """

    @respx.mock
    def test_a_download_that_vanished_fails_alone(
        self, ipod, paired, audio_source, monkeypatch
    ):
        """The exact failure seen: the file is gone by the time it is written.

        pypodlib reports it as the bare path with no word about what is wrong
        with it, which is why it is checked before the handover rather than
        after.
        """
        original = sync._commit_batch

        def delete_track_two_first(ipod_arg, record, staged, work, say):
            for item, path, _result in staged:
                if item.id == 2 and path.exists():
                    path.unlink()
            return original(ipod_arg, record, staged, work, say)

        monkeypatch.setattr(sync, "_commit_batch", delete_track_two_first)
        mock_server(manifest([track(n) for n in range(1, 5)]))

        report = sync.run(paired, mount=str(ipod.mount_path))

        assert report.status == "done", "the run ended instead of failing one track"
        assert report.synced == 3
        assert [r.track_id for r in report.failed] == [2]
        assert "disappeared" in (report.failed[0].error or "")
        assert len(ipod.tracks(reload=True)) == 3

    @respx.mock
    def test_a_file_the_device_refuses_fails_alone(
        self, ipod, paired, audio_source, monkeypatch
    ):
        """Anything else the device will not take, found by retrying singly."""
        real_add = device.IpodDevice.add_files
        seen = {"batches": 0}

        def add_files(self, paths):
            if len(paths) > 1:
                seen["batches"] += 1
                raise device.DeviceError("the whole batch was refused")
            if any(Path(p).parent.name == "2" for p in paths):
                raise device.DeviceError("this one file was refused")
            return real_add(self, paths)

        # The class, not the instance: IpodDevice uses __slots__, so an
        # attribute cannot be attached to one.
        monkeypatch.setattr(device.IpodDevice, "add_files", add_files)
        mock_server(manifest([track(n) for n in range(1, 5)]))

        report = sync.run(paired, mount=str(ipod.mount_path))

        assert seen["batches"] >= 1, "the batch path was never taken"
        assert report.status == "done"
        assert report.synced == 3
        assert [r.track_id for r in report.failed] == [2]


class TestWhenYouTubeRefusesTheMachine:
    """ "Sign in to confirm you're not a bot" is not "track not found".

    Measured on 13 September, after a 399-track sync: every search from this
    machine came back with six bot-check errors and no results - including
    "Queen - Bohemian Rhapsody". The search runs with `ignoreerrors`, so those
    errors were swallowed and every track was recorded as "No audio could be
    found", which sent everyone looking at the metadata rather than at YouTube.
    """

    @respx.mock
    def test_the_run_stops_instead_of_failing_every_track(self, ipod, paired, monkeypatch):
        def blocked(track_dict, destination):
            raise downloader.BlockedError(
                "YouTube is asking this computer to prove it is not a robot."
            )

        monkeypatch.setattr(downloader, "fetch", blocked)
        mock_server(manifest([track(n) for n in range(1, 41)]))

        report = sync.run(paired, mount=str(ipod.mount_path), concurrency=4)

        assert report.status == "error"
        assert "robot" in (report.message or "")
        # Four in flight when the first came back blocked, so a handful are
        # reported and the other thirty-odd are not even attempted.
        assert len(report.failed) <= 4, "it kept going after YouTube said no"
        assert "left" in (report.message or "")

    @respx.mock
    def test_what_was_already_downloaded_is_still_written(self, ipod, paired, monkeypatch):
        """Stopping early must not throw away work already paid for."""
        calls = {"n": 0}

        def fail_after_a_few(track_dict, destination):
            calls["n"] += 1
            if calls["n"] > 6:
                raise downloader.BlockedError("not a bot")
            destination.mkdir(parents=True, exist_ok=True)
            landed = destination / "source.m4a"
            shutil.copy(FIXTURES / "tagged.m4a", landed)
            return downloader.Download(landed, "youtube", "https://x", 268.0, 128)

        monkeypatch.setattr(downloader, "fetch", fail_after_a_few)
        mock_server(manifest([track(n) for n in range(1, 41)]))

        report = sync.run(paired, mount=str(ipod.mount_path), concurrency=1)

        assert report.status == "error"
        assert report.synced == 6
        assert len(ipod.tracks(reload=True)) == 6


class TestPlaylistsAreReconciledEverySync:
    """A playlist edit is work, even when every song is already on the iPod.

    Asked for on 13 September: "even if all songs are already there, check if
    there is any update in the playlist". Before this, `nothing_to_do` looked
    only at downloads, removals and artwork, so a run in that state reported
    "Already up to date" and never touched the playlists.
    """

    @respx.mock
    def test_a_song_added_to_a_playlist_is_picked_up(self, ipod, paired, audio_source):
        first = manifest(
            tracks=[track(1), track(2)],
            playlists=[{"id": 1, "name": "Liked", "trackIds": [1]}],
        )
        mock_server(first)
        sync.run(paired, mount=str(ipod.mount_path))

        library = device.open_at(ipod.mount_path)._handle.library()
        assert len(library.get_playlist("Liked").track_ids) == 1

        # Nothing new to download - both tracks are already there - but the
        # playlist now names both.
        respx.mock.reset()
        mock_server(
            manifest(
                tracks=[track(1), track(2)],
                playlists=[{"id": 1, "name": "Liked", "trackIds": [1, 2]}],
            )
        )
        report = sync.run(paired, mount=str(ipod.mount_path))

        assert report.message != "Already up to date."
        library = device.open_at(ipod.mount_path)._handle.library()
        assert len(library.get_playlist("Liked").track_ids) == 2

    @respx.mock
    def test_a_song_removed_from_a_playlist_is_picked_up(self, ipod, paired, audio_source):
        mock_server(
            manifest(
                tracks=[track(1), track(2)],
                playlists=[{"id": 1, "name": "Liked", "trackIds": [1, 2]}],
            )
        )
        sync.run(paired, mount=str(ipod.mount_path))

        respx.mock.reset()
        mock_server(
            manifest(
                tracks=[track(1), track(2)],
                playlists=[{"id": 1, "name": "Liked", "trackIds": [2]}],
            )
        )
        sync.run(paired, mount=str(ipod.mount_path))

        library = device.open_at(ipod.mount_path)._handle.library()
        assert len(library.get_playlist("Liked").track_ids) == 1

    @respx.mock
    def test_an_unchanged_playlist_is_not_counted_as_work(self, ipod, paired, audio_source):
        """The other half: this must not make every run look like work.

        Asserted on the flag rather than on "Already up to date", because the
        fixture's audio carries no embedded cover and so every run legitimately
        finds artwork to build. That is a separate quirk and not this one.
        """
        payload = manifest(
            tracks=[track(1), track(2)],
            playlists=[{"id": 1, "name": "Liked", "trackIds": [1, 2]}],
        )
        mock_server(payload)
        sync.run(paired, mount=str(ipod.mount_path))

        respx.mock.reset()
        mock_server(payload)
        report = sync.run(paired, mount=str(ipod.mount_path))

        assert report.plan.playlists_differ is False
        assert not report.plan.to_download
