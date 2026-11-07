import asyncio
import os
import time
from datetime import datetime, timezone
from types import SimpleNamespace
from uuid import uuid4

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError
from redis.exceptions import ConnectionError as RedisConnectionError
from starlette.requests import Request

from app.auth import Principal, TokenVerifier
from app.config import Settings
from app.inference import InferenceService
from app.main import create_app
from app.schemas import GenerationRequest
from app.security import RateLimiter, client_ip, verify_turnstile


def settings(**overrides):
    values = dict(environment="development", database_url="postgresql://unused", redis_url="redis://unused",
                  oidc_issuer="https://identity.example/", oidc_audience="https://api.example",
                  rate_limit_secret="a" * 32, metrics_token="b" * 32,
                  allowed_hosts=["testserver"], cors_origins=["https://studio.example"])
    values.update(overrides)
    return Settings(**values)


@pytest.mark.parametrize("changes", [
    {"temperature": float("nan")}, {"temperature": float("inf")}, {"temperature": 1.6},
    {"bars": 64}, {"bars": "16"}, {"tempo": True}, {"tempo": 181},
    {"owner_id": "victim"}, {"seed_chords": ["__import__('os').system('id')"]},
    {"seed_chords": []}, {"seed_chords": ["C"] * 9}, {"title": "<script>alert(1)</script>"},
    {"title": "   "}, {"instrument": "shell"}, {"turnstile_token": "x" * 2049},
])
def test_invalid_generation_inputs(changes):
    with pytest.raises(ValidationError):
        GenerationRequest(**changes)


@pytest.mark.parametrize("changes", [{"allowed_hosts": ["*"]}, {"cors_origins": ["*"]},
                                       {"oidc_issuer": "http://identity.example/"},
                                       {"oidc_jwks_url": "https://attacker.example/keys"},
                                       {"trusted_proxy_cidrs": ["0.0.0.0/0"]},
                                       {"rate_limit_secret": "short"}, {"environment": "production"}])
def test_unsafe_configuration_rejected(changes):
    with pytest.raises(ValidationError):
        settings(**changes)


@pytest.fixture(scope="module")
def signing_key():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def token(signing_key, **overrides):
    claims = {"iss": "https://identity.example/", "aud": "https://api.example", "sub": "user-a",
              "iat": int(time.time()) - 1, "exp": int(time.time()) + 60, "scope": "tracks:read tracks:write"}
    claims.update(overrides)
    return jwt.encode(claims, signing_key, algorithm="RS256", headers={"kid": "test-key"})


def verifier(signing_key):
    result = TokenVerifier(settings())
    result.jwks = SimpleNamespace(get_signing_key_from_jwt=lambda _: SimpleNamespace(key=signing_key.public_key()))
    return result


@pytest.mark.parametrize("claim", [{"iss": "https://attacker.example/"}, {"aud": "wrong-api"},
                                   {"exp": int(time.time()) - 100}, {"sub": ""}, {"iat": int(time.time()) + 100}])
def test_oidc_claim_rejection(signing_key, claim):
    with pytest.raises(jwt.PyJWTError):
        verifier(signing_key).verify(token(signing_key, **claim))


def test_token_signature_and_algorithm_confusion(signing_key):
    check = verifier(signing_key)
    hostile = jwt.encode({"sub": "victim"}, "this-is-not-the-public-key-32-bytes", algorithm="HS256", headers={"kid": "test-key"})
    with pytest.raises(jwt.PyJWTError):
        check.verify(hostile)
    other_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    with pytest.raises(jwt.PyJWTError):
        check.verify(token(other_key))
    a = check.verify(token(signing_key))
    b = check.verify(token(signing_key, sub="user-b"))
    assert a.owner_id != b.owner_id and "user-a" not in a.owner_id
    assert a.scopes == {"tracks:read", "tracks:write"}


class FakeRepository:
    def __init__(self):
        self.records = {}

    async def open(self):
        pass

    async def close(self):
        pass

    async def create(self, owner, title, metadata, midi):
        record = {"id": uuid4(), "title": title, "created_at": datetime.now(timezone.utc), **metadata}
        self.records[record["id"]] = owner, record, midi
        return record

    async def list(self, owner, limit, offset):
        return {"tracks": [row for user, row, _ in self.records.values() if user == owner], "next_offset": None}

    async def midi(self, owner, track_id):
        found = self.records.get(track_id)
        return found[2] if found and found[0] == owner else None

    async def delete(self, owner, track_id):
        found = self.records.get(track_id)
        if found and found[0] == owner:
            del self.records[track_id]
            return True
        return False


class FakeLimiter:
    def __init__(self):
        self.redis = self
        self.counts = {}
        self.ingress_count = 0

    async def ping(self):
        return True

    async def allow(self, owner, ip, request_id):
        self.counts[owner] = self.counts.get(owner, 0) + 1
        return self.counts[owner] <= 10

    async def allow_request(self, ip, request_id):
        self.ingress_count += 1
        return self.ingress_count <= 100

    async def close(self):
        pass


class FakeInference:
    async def generate(self, config):
        return {"midi": b"MThd\x00\x00\x00\x06", "notes": [{"pitch": 60, "start": 0, "duration": 1, "velocity": 90}],
                "duration": 40.0, "model": "test-checkpoint"}


def client(signing_key, **overrides):
    app = create_app(settings(**overrides), repository=FakeRepository(), limiter=FakeLimiter(),
                     verifier=verifier(signing_key), inference=FakeInference())
    return TestClient(app)


def headers(signing_key, sub="user-a", scope="tracks:read tracks:write"):
    return {"Authorization": "Bearer " + token(signing_key, sub=sub, scope=scope)}


def test_two_user_api_cannot_list_download_delete_others(signing_key):
    with client(signing_key) as api:
        first = api.post("/v1/tracks", json={}, headers=headers(signing_key))
        assert first.status_code == 201
        track = first.json()["id"]
        second = headers(signing_key, "user-b")
        assert api.get("/v1/tracks", headers=second).json()["tracks"] == []
        assert api.get(f"/v1/tracks/{track}/midi", headers=second).status_code == 404
        assert api.delete(f"/v1/tracks/{track}", headers=second).status_code == 404
        own = api.get(f"/v1/tracks/{track}/midi", headers=headers(signing_key))
        assert own.status_code == 200 and own.content.startswith(b"MThd")
        assert own.headers["cache-control"] == "no-store"
        assert api.delete(f"/v1/tracks/{track}", headers=headers(signing_key)).status_code == 204


def test_auth_scope_input_leak_and_rate_boundaries(signing_key):
    with client(signing_key) as api:
        assert api.get("/v1/tracks").status_code == 401
        assert api.post("/v1/tracks", json={}, headers=headers(signing_key, scope="tracks:read")).status_code == 403
        bad = api.post("/v1/tracks", json={"owner_id": "private-victim-value"}, headers=headers(signing_key))
        assert bad.status_code == 422 and "private-victim-value" not in bad.text
        assert api.post("/v1/tracks", content=b"x" * 17000, headers=headers(signing_key)).status_code == 413
        assert api.get("/v1/tracks", headers={**headers(signing_key), "Host": "attacker.example"}).status_code == 400
        assert api.get("/health/live", headers={"Host": "10.0.0.2:8000"}).status_code == 200
        for _ in range(10):
            assert api.post("/v1/tracks", json={}, headers=headers(signing_key)).status_code == 201
        result = api.post("/v1/tracks", json={}, headers=headers(signing_key))
        assert result.status_code == 429 and result.headers["retry-after"] == "60"
        assert api.get("/metrics").status_code == 401
        metrics = api.get("/metrics", headers={"Authorization": "Bearer " + "b" * 32})
        assert metrics.status_code == 200 and "auralis_http_requests_total" in metrics.text


def test_proxy_spoofing_is_ignored_and_trusted_chain_walks_from_right():
    def request(peer, forwarded):
        return Request({"type": "http", "client": (peer, 123), "headers": [(b"x-forwarded-for", forwarded.encode())]})
    assert client_ip(request("8.8.8.8", "1.1.1.1"), ["10.0.0.0/24"]) == "8.8.8.8"
    assert client_ip(request("10.0.0.2", "1.1.1.1, 8.8.8.8"), ["10.0.0.0/24"]) == "8.8.8.8"


def test_invalid_bodies_and_tokens_cannot_bypass_ingress_quota(signing_key):
    with client(signing_key) as api:
        for _ in range(50):
            assert api.post("/v1/tracks", content="{", headers={"Content-Type": "application/json"}).status_code == 422
        for _ in range(50):
            assert api.get("/v1/tracks", headers={"Authorization": "Bearer invalid"}).status_code == 401
        response = api.post("/v1/tracks", content="{", headers={"Content-Type": "application/json"})
        assert response.status_code == 429 and response.headers["retry-after"] == "60"
        assert api.app.state.limiter.counts == {}


@pytest.mark.asyncio
async def test_chunked_body_is_bounded_before_parsing():
    from app.security import RequestGuard
    reached, sent = [], []
    async def inner(scope, receive, send):
        reached.append(True)
    chunks = iter([{"type": "http.request", "body": b"x" * 9000, "more_body": True},
                   {"type": "http.request", "body": b"x" * 9000, "more_body": False}])
    async def receive():
        return next(chunks)
    async def send(message):
        sent.append(message)
    guard = RequestGuard(inner, settings())
    await guard({"type": "http", "method": "POST", "path": "/v1/tracks", "scheme": "http", "client": ("127.0.0.1", 1), "headers": []}, receive, send)
    assert sent[0]["status"] == 413 and not reached


@pytest.mark.asyncio
async def test_redis_outage_fails_closed_without_leaking_identity():
    rate = RateLimiter("redis://unused", "a" * 32)
    async def failure(*args):
        raise RedisConnectionError("private connection string")
    rate.redis.eval = failure
    assert "user-secret" not in rate.key("user", "user-secret")
    with pytest.raises(HTTPException) as exc:
        await rate.allow("user-secret", "8.8.8.8", "request")
    assert exc.value.status_code == 503 and "private" not in exc.value.detail
    await rate.close()


@pytest.mark.asyncio
async def test_no_checkpoint_fails_closed(tmp_path):
    service = InferenceService(settings(checkpoint_path=tmp_path / "missing.pt"))
    with pytest.raises(HTTPException) as exc:
        await service.generate({})
    assert exc.value.status_code == 503


@pytest.mark.asyncio
async def test_cancelled_request_keeps_worker_capacity_reserved(tmp_path, monkeypatch):
    import threading
    import app.inference as module
    checkpoint = tmp_path / "test.pt"
    checkpoint.write_bytes(b"test")
    started, release = threading.Event(), threading.Event()
    def blocked(*args):
        started.set()
        release.wait(timeout=3)
        return {"completed": True}
    monkeypatch.setattr(module, "run_isolated", blocked)
    service = InferenceService(settings(checkpoint_path=checkpoint))
    request = asyncio.create_task(service.generate({}))
    await asyncio.to_thread(started.wait, 1)
    request.cancel()
    with pytest.raises(asyncio.CancelledError):
        await request
    with pytest.raises(HTTPException) as exc:
        await service.generate({})
    assert exc.value.status_code == 503
    release.set()
    for _ in range(100):
        if not service.capacity.locked():
            break
        await asyncio.sleep(0.01)
    assert not service.capacity.locked()


def _sleeping_worker(connection, config, checkpoint):
    time.sleep(20)


def test_worker_timeout_terminates_compute(monkeypatch):
    import app.inference as module
    monkeypatch.setattr(module, "_child_generate", _sleeping_worker)
    start = time.monotonic()
    with pytest.raises(TimeoutError):
        module.run_isolated({}, "unused", 0.2)
    assert time.monotonic() - start < 6


@pytest.mark.asyncio
async def test_turnstile_requires_matching_host_and_action(monkeypatch):
    import app.security as module
    result = {"success": True, "hostname": "attacker.example", "action": "generate"}
    class Http:
        def __init__(self, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def post(self, *args, **kwargs):
            return SimpleNamespace(raise_for_status=lambda: None, json=lambda: result)
    monkeypatch.setattr(module.httpx, "AsyncClient", Http)
    config = settings(turnstile_secret="secret", turnstile_hostname="studio.example")
    with pytest.raises(HTTPException) as exc:
        await verify_turnstile(config, "token", "8.8.8.8")
    assert exc.value.status_code == 403
    result["hostname"] = "studio.example"
    result["action"] = "wrong-action"
    with pytest.raises(HTTPException):
        await verify_turnstile(config, "token", "8.8.8.8")
    result["action"] = "generate"
    await verify_turnstile(config, "token", "8.8.8.8")


@pytest.mark.integration
@pytest.mark.asyncio
async def test_actual_redis_atomic_limits():
    url = os.getenv("TEST_REDIS_URL")
    if not url:
        pytest.skip("Set TEST_REDIS_URL to run actual Redis integration")
    rate = RateLimiter(url, str(uuid4()))
    owner, ip = str(uuid4()), str(uuid4())
    results = await asyncio.gather(*(rate.allow(owner, ip, str(uuid4())) for _ in range(25)))
    assert sum(results) == 10
    assert not await rate.allow(str(uuid4()), ip, str(uuid4()))
    assert not await rate.allow(owner, str(uuid4()), str(uuid4()))
    await rate.close()
