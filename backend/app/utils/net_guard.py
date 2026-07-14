"""
Outbound URL guard — SSRF defense.

Single place to validate any URL the backend is about to fetch, *especially*
URLs whose value comes from outside our own source code: a third-party API
response, a DB row, or (in future) a client request. The rule we enforce is
"the backend does not fetch whatever URL it is handed" — a URL must be an
explicit http(s) address that resolves to a public IP (never loopback, private,
link-local, or cloud-metadata ranges), and optionally must sit on an allowlisted
host.

Fetches to fixed, hard-coded vendor endpoints in our own code (Mistral, Infobip,
Twilio, Nominatim, Claid's own API host) don't need this — they are not
attacker-influenced. Use it for the dynamic cases:

    from app.utils.net_guard import assert_public_http_url

    await assert_public_http_url(tmp_url)                     # any public https URL
    await assert_public_http_url(url, allow_hosts={"api.x"})  # host-restricted
"""
from __future__ import annotations

import asyncio
import ipaddress
import socket
from typing import Iterable, Optional
from urllib.parse import urlparse


class UnsafeURLError(ValueError):
    """Raised when a URL fails the SSRF safety checks."""


def _ip_is_blocked(ip: ipaddress._BaseAddress) -> bool:
    """True for any address that must never be reachable from a fetch."""
    return (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local     # 169.254.0.0/16 — includes 169.254.169.254 metadata
        or ip.is_reserved
        or ip.is_multicast
        or ip.is_unspecified
    )


def _check_sync(
    url: str,
    allow_hosts: Optional[Iterable[str]],
    allow_schemes: Iterable[str],
) -> str:
    parsed = urlparse(url)

    scheme = (parsed.scheme or "").lower()
    if scheme not in {s.lower() for s in allow_schemes}:
        raise UnsafeURLError(f"URL scheme '{parsed.scheme}' is not allowed")

    host = parsed.hostname
    if not host:
        raise UnsafeURLError("URL has no host")

    if allow_hosts is not None:
        allowed = {h.lower() for h in allow_hosts}
        if host.lower() not in allowed:
            raise UnsafeURLError(f"Host '{host}' is not on the allowlist")

    # Reject a raw IP literal that is itself in a blocked range, before any DNS.
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        literal = None
    if literal is not None and _ip_is_blocked(literal):
        raise UnsafeURLError(f"Host IP '{host}' is not a public address")

    # Resolve every A/AAAA record and require them all to be public — this
    # defeats DNS names that point at internal ranges (DNS-rebinding / SSRF).
    port = parsed.port or (443 if scheme == "https" else 80)
    try:
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except socket.gaierror as exc:
        raise UnsafeURLError(f"Host '{host}' could not be resolved: {exc}") from exc

    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if _ip_is_blocked(ip):
            raise UnsafeURLError(f"Host '{host}' resolves to non-public address {ip}")

    return url


async def assert_public_http_url(
    url: str,
    *,
    allow_hosts: Optional[Iterable[str]] = None,
    allow_schemes: Iterable[str] = ("https",),
) -> str:
    """Validate an outbound URL, raising UnsafeURLError if it is not safe to fetch.

    - `allow_hosts` — if given, the host must be one of these (exact match).
    - `allow_schemes` — permitted URL schemes; defaults to https only.

    DNS resolution runs in a worker thread so the event loop is never blocked.
    Returns the URL unchanged on success so it can be used inline.
    """
    return await asyncio.to_thread(_check_sync, url, allow_hosts, tuple(allow_schemes))
