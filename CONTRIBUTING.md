# Contributing

Thanks for looking. This is a small, self-hosted tool with a narrow purpose, so
the most useful contributions are usually bug reports from real hardware rather
than new features.

## Before you open a pull request

**Say what problem it solves.** A change that makes the code tidier but changes
no outcome is a hard sell, because every line here is one more thing to be
correct about the iTunesDB.

**Keep the two halves apart.** Nothing in `web/` may import from `local/`, or the
reverse. The only thing crossing that boundary is the HTTP contract in
[`docs/LOCAL_APP_API.md`](docs/LOCAL_APP_API.md). If your change alters the
manifest, change the contract document in the same commit.

**Comments explain why, not what.** The existing comments are long on purpose:
they record the reasoning and the traps, because the iTunesDB is unforgiving and
the next person will otherwise repeat the mistake. Match that. Do not write
project chronology ("this was changed in March") — a reader wants the rule, not
its history.

## The rules that are not negotiable

These are invariants, not preferences. A change that breaks one will be
rejected even if it passes the tests.

1. **The server never stores audio.** There is no column for a file path, a byte
   or a stream URL, and there will not be one.
2. **A download source's own metadata is never trusted as metadata.** Every
   track is re-tagged from a real catalogue. A track nothing can confirm is
   written title-only.
3. **The local app never removes music it did not add.** The ledger on the
   device records what this tool wrote; a file it merely recognised is never a
   candidate for deletion.
4. **Nothing downloaded outlives the sync.** Every downloaded file is deleted
   once the track is on the device.
5. **A sync must be safe to interrupt.** Results are reported as they happen and
   the database is committed in batches, so pulling the cable costs the current
   track and nothing else.

## Working on the web tool

```bash
cd web
cp .env.example .env     # set DB_PASSWORD and SESSION_SECRET
docker compose up -d --build
```

The frontend has no build step — it is ES modules served as-is, so a reload is
the whole edit cycle. There is no unit suite yet. What CI does check is the set
of mistakes this project has actually made: a file that does not parse, an
identifier that is called but never defined, an `api.something()` the client does
not have, a compose file that no longer interpolates, and an image that stopped
building.

```bash
node scripts/check-references.mjs .
```

Run that before pushing. It is fast and it has caught real breakage.

## Working on the local app

```bash
cd local
pip install -e ".[dev]"
ruff check src tests && ruff format --check src tests
pytest -m "not hardware"
```

The suite runs against pyPodLib's **simulated iPods**, so the database really is
parsed, written and signed — that part is not mocked and should not become
mocked. Only two things are faked: the server, at the HTTP boundary, and the
audio source, replaced with a fixture file so a test never depends on a video
still existing.

Tests marked `hardware` need a real iPod attached and are excluded by default.

If you have no Python to hand:

```bash
docker build -f Dockerfile.dev -t syncmypod-local-dev .
docker run --rm -v "$PWD:/app" syncmypod-local-dev pytest
```

## Reporting a bug against real hardware

This is the most valuable kind of report, and it needs specifics:

- the output of `syncmypod devices` (model number, generation, signature type)
- what you expected and what the iPod did
- whether the music is on the device but invisible, or genuinely absent
- the run's log with `--verbose`

Do not paste your device token. `syncmypod status` truncates it; keep it that
way.

## Commit messages

A sentence saying what changed and why, in the imperative. The repository's
history is meant to be readable as a series of decisions.

## Licence

By contributing you agree your work is licensed under the MIT licence that
covers the project.
