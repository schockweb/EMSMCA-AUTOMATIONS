#!/usr/bin/env bash
#
# Render nginx/nginx.conf from nginx/nginx.conf.template for THIS deployment.
#
# The committed nginx/nginx.conf hardcoded portal.emsmca.co.za — in server_name
# and in both ssl_certificate paths. On a client's own VM that config makes
# nginx fail to start (no such certificate directory), taking the entire site
# down with the reason buried in a container log. Run this once per install.
#
# Usage:
#   PORTAL_DOMAIN=portal.client.co.za \
#   PORTAL_HOST_IP=203.0.113.10 \
#   PORTAL_ADMIN_EMAIL=admin@client.co.za \
#   bash deploy/scripts/render-nginx.sh
#
# Then issue the certificate and restart nginx:
#   docker compose -f docker-compose.prod.yml run --rm ems_certbot \
#     certonly --webroot -w /var/www/certbot \
#     -d "$PORTAL_DOMAIN" --agree-tos -m "$PORTAL_ADMIN_EMAIL"
#   docker compose -f docker-compose.prod.yml restart ems_nginx
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEMPLATE="$REPO_ROOT/nginx/nginx.conf.template"
OUTPUT="$REPO_ROOT/nginx/nginx.conf"

if [[ ! -f "$TEMPLATE" ]]; then
    echo "ERROR: template not found at $TEMPLATE" >&2
    exit 1
fi

if [[ -z "${PORTAL_DOMAIN:-}" ]]; then
    echo "ERROR: PORTAL_DOMAIN is not set. Use the public hostname, e.g. portal.client.co.za" >&2
    exit 1
fi
: "${PORTAL_HOST_IP:=}"
: "${PORTAL_ADMIN_EMAIL:=admin@${PORTAL_DOMAIN#*.}}"

# Reject a domain that still looks like a placeholder — rendering that produces
# a config that fails exactly the same way the hardcoded one did.
case "$PORTAL_DOMAIN" in
    *CHANGE_ME*|*example.com*|"")
        echo "ERROR: PORTAL_DOMAIN is still a placeholder ('$PORTAL_DOMAIN')." >&2
        exit 1
        ;;
esac

if [[ -f "$OUTPUT" ]]; then
    cp "$OUTPUT" "$OUTPUT.bak"
    echo "Backed up existing config to nginx/nginx.conf.bak"
fi

# Substitute ONLY our placeholders. A bare `envsubst` would also eat nginx's own
# runtime variables ($host, $remote_addr, $binary_remote_addr, $uri ...) and
# silently blank them, producing a config that loads but proxies wrong headers.
export PORTAL_DOMAIN PORTAL_HOST_IP PORTAL_ADMIN_EMAIL
if command -v envsubst >/dev/null 2>&1; then
    envsubst '${PORTAL_DOMAIN} ${PORTAL_HOST_IP} ${PORTAL_ADMIN_EMAIL}' \
        < "$TEMPLATE" > "$OUTPUT"
else
    # envsubst lives in gettext, which is not installed everywhere. Same
    # restricted substitution, no extra dependency.
    sed -e "s|\${PORTAL_DOMAIN}|${PORTAL_DOMAIN}|g" \
        -e "s|\${PORTAL_HOST_IP}|${PORTAL_HOST_IP}|g" \
        -e "s|\${PORTAL_ADMIN_EMAIL}|${PORTAL_ADMIN_EMAIL}|g" \
        "$TEMPLATE" > "$OUTPUT"
fi

# Fail loudly rather than shipping a half-rendered config.
if grep -q '\${PORTAL_' "$OUTPUT"; then
    echo "ERROR: unsubstituted placeholders remain in $OUTPUT:" >&2
    grep -n '\${PORTAL_' "$OUTPUT" >&2
    exit 1
fi

echo "Rendered nginx/nginx.conf for domain: $PORTAL_DOMAIN"
echo
echo "Verify the config before restarting nginx:"
echo "  docker compose -f docker-compose.prod.yml exec ems_nginx nginx -t"
