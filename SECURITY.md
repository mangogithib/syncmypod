# Security

## Reporting a vulnerability

Please report privately rather than in a public issue. Use GitHub's
[private vulnerability reporting](../../security/advisories/new) on this
repository.

Include what an attacker can do, not only what looks wrong — a reproduction
against a local instance is worth more than a scanner result. Expect a first
reply within a week. This is a personal project maintained in spare time, so
please be realistic about timelines; there is no bounty.

## What this project is

A **single-tenant, self-hosted** tool. Each instance has one account, created
from the command line. There is no public sign-up, no multi-user separation to
get wrong, and no hosted service. The threat model is "somebody finds my
instance on the internet", not "one tenant reads another's data".

## How it is built

Worth knowing if you are reviewing it:

- **Two separate credentials.** A browser session cookie and a device bearer
  token, on deliberately separate paths. A CSRF against the web interface cannot
  reach a sync endpoint, and a leaked device token cannot change the account
  password. Device tokens are revocable individually from the Devices page.
- **Pairing codes, not passwords.** The desktop app never receives the account
  password. It exchanges a short single-use code, valid for ten minutes, for a
  token stored only on that machine. The password-based pairing route exists for
  headless setups and is **disabled unless `ALLOW_PASSWORD_PAIRING=1`**, so a
  default install has exactly one endpoint that accepts a password: the login
  form.
- **The server holds no audio.** There is no file path, byte or stream URL of
  music anywhere in its schema, so a compromised server leaks metadata and
  playlists — not a media library.
- **Loopback by default.** `BIND_ADDR` defaults to `127.0.0.1`. An instance is
  not reachable from the network until someone deliberately changes that.
- **Security headers are set by the application**, in one place, so a proxy
  change cannot silently drop them: a strict CSP with no `unsafe-inline` for
  scripts, `X-Frame-Options: DENY`, `nosniff`, and a referrer policy.
- **`TRUST_PROXY` takes a network, not a boolean.** Blanket-trusting
  `X-Forwarded-For` would let any client spoof its address past the rate
  limiter, so the setting names which peers may be believed.
- **Rate limits** apply to sign-in, device claim and token issue.

## One thing to know if you add a second account

The catalogue is shared. `tracks` is keyed globally by `match_key` and
`library_tracks` maps accounts onto it, so two people who add the same song
point at one row. That is what stops the same recording becoming two entries on
an iPod, and it is right for the tool as it is meant to be run — one household,
usually one person.

It does mean the accounts are not isolated from each other. A metadata
correction, or a merge of two rows found to be the same recording, is decided in
one account's context and changes the row every account sees. Nothing leaks
between libraries — who holds what stays separate — but the facts about a track
do not.

Treat extra accounts as people you would let edit your library, not as tenants.
If you need real separation, run a second instance; the whole stack is one
compose file and a database.

## Things that are deliberate, not bugs

Please do not report these as vulnerabilities:

- **No public registration.** Accounts are created with
  `docker compose exec app npm run create-user`. This is intentional.
- **HSTS ships disabled** (`HSTS_MAX_AGE=0`). Enabling it is a promise a browser
  remembers with no quick undo, so it is opt-in once you have confirmed your
  certificate works. Turn it on.
- **The local GUI binds to loopback with a random token** in the URL. It is a
  desktop application rendered as a page, not a web service.
- **Downloading from streaming platforms** generally breaches their terms. That
  is a legal question for whoever runs the instance, not a vulnerability. See the
  note at the end of the [README](README.md).

## If you run an instance

- Set `SESSION_SECRET` and `DB_PASSWORD` to generated values. Do not reuse a
  password you use elsewhere.
- Put TLS in front of it before exposing it beyond a network you control, and set
  `PUBLIC_URL` and `TRUST_PROXY` to match.
- Turn on `HSTS_MAX_AGE` once the certificate is confirmed.
- Revoke a device from the Devices page if you lose the computer it was paired
  with. The token is stored in plain text in that machine's config directory,
  because it has to be usable without a prompt.
- Back up with `pg_dump`. One dump is the whole library.
