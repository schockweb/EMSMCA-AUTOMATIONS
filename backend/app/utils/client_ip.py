"""
Trusted client-IP resolution — the ONE place that decides which IP an HTTP
request is attributed to. Used by the rate limiter and the login audit trail.

Threat model
------------
`X-Forwarded-For` is attacker-writable: nginx *appends* the true peer address
to whatever list the client sends, so the FIRST entry is chosen by the
attacker. Keying rate-limit buckets (or trusting an "internal IP" bypass) on
it lets an attacker mint a fresh bucket per request and brute-force logins
un-throttled.

What we trust instead, in order:

1. ``X-Real-IP`` — our nginx sets this from ``$remote_addr`` (the TCP peer it
   actually accepted the connection from), unconditionally overwriting any
   client-supplied value. It cannot be forged *through* our proxy.
2. The LAST entry of ``X-Forwarded-For`` — the one hop our own nginx appended.
3. The direct TCP peer of this request.

Headers (1) and (2) are only honoured when the request physically arrived
from a private/loopback address — i.e. from our reverse proxy inside the
Docker network. In production the backend publishes no ports (nginx is the
only way in), so every external request carries a trustworthy X-Real-IP.
A request that somehow reaches the backend from a public address gets its
raw TCP peer and its headers are ignored.
"""
from __future__ import annotations
import ipaddress

from fastapi import Request


def _parse_ip(value: str | None) -> str | None:
    """Return the normalised IP string, or None if it isn't a valid address."""
    if not value:
        return None
    candidate = value.strip()
    # Strip an optional ":port" suffix some proxies attach to IPv4 peers.
    if candidate.count(":") == 1 and "." in candidate:
        candidate = candidate.split(":")[0]
    try:
        return str(ipaddress.ip_address(candidate))
    except ValueError:
        return None


def _is_internal(ip: str) -> bool:
    """True for loopback / private / link-local addresses (RFC1918 CIDRs —
    not string prefixes, so public 172.217.x.x style addresses don't match)."""
    try:
        parsed = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return parsed.is_loopback or parsed.is_private or parsed.is_link_local


def get_trusted_client_ip(request: Request) -> str:
    """Best-effort real client IP that an attacker cannot choose."""
    peer = _parse_ip(request.client.host if request.client else None)

    # Proxy headers are only meaningful when the connection came from our own
    # reverse proxy on the internal Docker network.
    if peer and _is_internal(peer):
        real_ip = _parse_ip(request.headers.get("x-real-ip"))
        if real_ip:
            return real_ip
        forwarded = request.headers.get("x-forwarded-for")
        if forwarded:
            # nginx APPENDS the true peer — only the last entry is vouched for.
            last_hop = _parse_ip(forwarded.split(",")[-1])
            if last_hop:
                return last_hop

    return peer or "unknown"


def is_loopback_peer(request: Request) -> bool:
    """True only when the direct TCP peer is loopback (in-container health
    checks, CI, `docker exec` harnesses). Deliberately ignores all forwarded
    headers so it can never be triggered from outside the box."""
    peer = _parse_ip(request.client.host if request.client else None)
    if not peer:
        return False
    try:
        return ipaddress.ip_address(peer).is_loopback
    except ValueError:
        return False
