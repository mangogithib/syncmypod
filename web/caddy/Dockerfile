# Caddy with the DuckDNS DNS provider compiled in.
#
# Why a custom build rather than the stock caddy:2-alpine image:
#
# Let's Encrypt offers three ways to prove you control a name. Two of them need
# a specific port:
#
#   HTTP-01     needs inbound port 80
#   TLS-ALPN-01 needs inbound port 443
#   DNS-01      needs no inbound port at all - it answers with a TXT record
#
# On the reference deployment ports 80 and 443 are already taken by an unrelated
# application, so neither of the first two is available. DNS-01 is the only
# option, and it requires a provider module for the DNS host - here DuckDNS -
# which is not in the stock image. Hence xcaddy.
#
# The upside is that this also works with no inbound HTTP at all, so the cert
# can be issued before any port is opened.

FROM caddy:2-builder-alpine AS builder

RUN xcaddy build \
    --with github.com/caddy-dns/duckdns

FROM caddy:2-alpine

COPY --from=builder /usr/bin/caddy /usr/bin/caddy

# Baked in rather than bind-mounted, so the running proxy config is whatever is
# committed to the repository - no drift between the file on disk and the file
# in git.
COPY Caddyfile /etc/caddy/Caddyfile

# Confirm the module is actually present, so a broken build fails here rather
# than at 3am when a certificate needs renewing.
RUN caddy list-modules | grep -q "dns.providers.duckdns" \
    && echo "duckdns DNS provider present"

# Refuse to start without the two settings that matter.
#
# This check lives here rather than in docker-compose.yml because Compose
# interpolates variables for every service even when its profile is inactive, so
# a required-variable guard in the compose file would break the ordinary
# non-public deployment.
#
# It is worth guarding at all because the failure is otherwise silent rather than
# loud: with an empty PUBLIC_HOSTNAME the site address collapses from
# "host:8444" to ":8444", which Caddy happily serves as plain HTTP with no
# certificate. An instance that looks up and is quietly unencrypted is the worst
# outcome here, given this port carries pairing codes and device tokens.
RUN printf '%s\n' \
    '#!/bin/sh' \
    'set -e' \
    'if [ -z "$PUBLIC_HOSTNAME" ]; then' \
    '  echo "FATAL: PUBLIC_HOSTNAME is not set. Set it in .env (bare hostname, no scheme or port)." >&2' \
    '  exit 1' \
    'fi' \
    'case "$PUBLIC_HOSTNAME" in' \
    '  *://*|*:*|*/*)' \
    '    echo "FATAL: PUBLIC_HOSTNAME must be a bare hostname - no scheme, port or path. Got: $PUBLIC_HOSTNAME" >&2' \
    '    exit 1 ;;' \
    'esac' \
    'if [ -z "$DUCKDNS_TOKEN" ]; then' \
    '  echo "FATAL: DUCKDNS_TOKEN is not set. Certificates use the DNS-01 challenge and cannot be issued without it." >&2' \
    '  exit 1' \
    'fi' \
    'if [ -z "$ACME_EMAIL" ]; then' \
    '  echo "FATAL: ACME_EMAIL is not set. Let'"'"'s Encrypt only sends renewal-failure warnings to a registered contact." >&2' \
    '  exit 1' \
    'fi' \
    'exec "$@"' \
    > /usr/local/bin/require-config && chmod +x /usr/local/bin/require-config

ENTRYPOINT ["/usr/local/bin/require-config", "caddy"]
CMD ["run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
