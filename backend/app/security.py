import hashlib
import hmac
import ipaddress
import json
from uuid import uuid4

import httpx
from fastapi import HTTPException, Request
from redis.asyncio import Redis
from redis.exceptions import RedisError
from starlette.middleware.trustedhost import TrustedHostMiddleware


class HealthAwareTrustedHost:
    def __init__(self, app, allowed_hosts):
        self.app = app
        self.checked = TrustedHostMiddleware(app, allowed_hosts=allowed_hosts)

    async def __call__(self, scope, receive, send):
        # ALB health probes use the task IP as Host; health never returns data.
        if scope["type"] == "http" and scope["path"] in {"/health/live", "/health/ready"}:
            return await self.app(scope, receive, send)
        return await self.checked(scope, receive, send)

# Redis TIME provides a shared clock. Both rolling windows are checked before
# either is consumed, and the entire decision is atomic across all replicas.
SLIDING_WINDOW = """
local now = redis.call('TIME')
local nowms = now[1] * 1000 + math.floor(now[2] / 1000)
local window = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
for _,key in ipairs(KEYS) do
  redis.call('ZREMRANGEBYSCORE', key, '-inf', nowms-window)
  if redis.call('ZCARD', key) >= limit then return 0 end
end
for _,key in ipairs(KEYS) do
  redis.call('ZADD', key, nowms, ARGV[3])
  redis.call('PEXPIRE', key, window)
end
return 1
"""


class RateLimiter:
    def __init__(self, redis_url: str, secret: str):
        self.redis = Redis.from_url(redis_url, socket_connect_timeout=3, socket_timeout=3, decode_responses=True)
        self.secret = secret.encode()

    def key(self, kind: str, value: str):
        digest = hmac.new(self.secret, value.encode(), hashlib.sha256).hexdigest()
        # Common hash tag allows atomic dual-key Lua on Redis cluster, too.
        return f"rate:{{composition}}:{kind}:{digest}"

    async def allow(self, owner: str, ip: str, request_id: str):
        return await self._consume([self.key("user", owner), self.key("ip", ip)], 10, request_id)

    async def allow_request(self, ip: str, request_id: str):
        return await self._consume([self.key("ingress", ip)], 100, request_id)

    async def _consume(self, keys: list[str], limit: int, request_id: str):
        try:
            return bool(await self.redis.eval(SLIDING_WINDOW, len(keys), *keys, 60000, limit, request_id))
        except RedisError:
            raise HTTPException(503, "Rate limiter unavailable") from None

    async def close(self):
        await self.redis.aclose()


def trusted_peer(peer: str, cidrs: list[str]) -> bool:
    try:
        address = ipaddress.ip_address(peer)
        return any(address in ipaddress.ip_network(cidr) for cidr in cidrs)
    except ValueError:
        return False


def client_ip(request, cidrs: list[str]) -> str:
    peer = request.client.host if request.client else "0.0.0.0"
    if not trusted_peer(peer, cidrs):
        return peer
    # Walk from the immediate trusted proxy toward the client; never trust the
    # user-supplied leftmost XFF address. ALB appends the verified peer address.
    chain = request.headers.get("x-forwarded-for", "").split(",")
    if len(chain) > 16:
        raise HTTPException(400, "Invalid proxy chain")
    current = peer
    for hop in reversed(chain):
        if not trusted_peer(current, cidrs):
            break
        try:
            current = str(ipaddress.ip_address(hop.strip()))
        except ValueError:
            raise HTTPException(400, "Invalid proxy chain") from None
    return current


async def verify_turnstile(settings, token: str | None, ip: str):
    # Development can omit a challenge only when no secret has been configured.
    if settings.environment == "development" and not settings.turnstile_secret.get_secret_value():
        return
    if not token:
        raise HTTPException(403, "Complete the generation challenge")
    try:
        async with httpx.AsyncClient(timeout=5, follow_redirects=False) as client:
            response = await client.post("https://challenges.cloudflare.com/turnstile/v0/siteverify", data={
                "secret": settings.turnstile_secret.get_secret_value(), "response": token, "remoteip": ip,
            })
            response.raise_for_status()
            result = response.json()
    except (httpx.HTTPError, ValueError):
        raise HTTPException(503, "Challenge verification unavailable") from None
    if result.get("success") is not True or result.get("hostname") != settings.turnstile_hostname or result.get("action") != "generate":
        raise HTTPException(403, "Generation challenge rejected")


class RequestGuard:
    """Bound bodies even for chunked requests; apply TLS and security headers."""
    def __init__(self, app, settings, max_body=16384, limiter=None):
        self.app, self.settings, self.max_body = app, settings, max_body
        self.limiter = limiter

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = {k.lower(): v for k, v in scope["headers"]}
        peer = scope.get("client", ("", 0))[0]
        tls = scope.get("scheme") == "https" or (trusted_peer(peer, self.settings.trusted_proxy_cidrs) and headers.get(b"x-forwarded-proto") == b"https")
        if self.settings.environment == "production" and not tls and scope["path"] not in ("/health/live", "/health/ready"):
            return await self.reject(send, 400, "HTTPS required")
        # Bound authentication, malformed JSON, and unknown API endpoints before
        # reading bodies or contacting the OIDC provider. The generation quota
        # below the auth boundary remains a separate user + IP limit.
        if self.limiter and scope["path"].startswith("/v1/"):
            try:
                ip = client_ip(Request(scope), self.settings.trusted_proxy_cidrs)
                if not await self.limiter.allow_request(ip, str(uuid4())):
                    return await self.reject(send, 429, "Request limit reached", [(b"retry-after", b"60")])
            except HTTPException as exc:
                return await self.reject(send, exc.status_code, exc.detail)
        if scope["method"] in ("POST", "PUT", "PATCH"):
            try:
                length = int(headers.get(b"content-length", b"0"))
            except ValueError:
                return await self.reject(send, 400, "Invalid Content-Length")
            if length < 0 or length > self.max_body:
                return await self.reject(send, 413, "Request too large")
            chunks, size = [], 0
            while True:
                message = await receive()
                if message["type"] == "http.disconnect":
                    return
                body = message.get("body", b"")
                size += len(body)
                if size > self.max_body:
                    return await self.reject(send, 413, "Request too large")
                chunks.append(body)
                if not message.get("more_body", False):
                    break
            delivered = False
            original_receive = receive

            async def bounded_receive():
                nonlocal delivered
                if not delivered:
                    delivered = True
                    return {"type": "http.request", "body": b"".join(chunks), "more_body": False}
                return await original_receive()
            receive = bounded_receive

        async def protected_send(message):
            if message["type"] == "http.response.start":
                message.setdefault("headers", []).extend([
                    (b"x-content-type-options", b"nosniff"), (b"cache-control", b"no-store"),
                    (b"referrer-policy", b"no-referrer"), (b"x-frame-options", b"DENY"),
                    (b"content-security-policy", b"default-src 'none'; frame-ancestors 'none'"),
                ])
                if tls:
                    message["headers"].append((b"strict-transport-security", b"max-age=31536000; includeSubDomains"))
            await send(message)
        await self.app(scope, receive, protected_send)

    @staticmethod
    async def reject(send, status, message, extra_headers=None):
        await send({"type": "http.response.start", "status": status, "headers": [(b"content-type", b"application/json"), (b"cache-control", b"no-store"), *(extra_headers or [])]})
        await send({"type": "http.response.body", "body": json.dumps({"detail": message}).encode()})
