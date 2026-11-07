import hmac
import json
import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path
from uuid import UUID, uuid4

from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from prometheus_client import CONTENT_TYPE_LATEST, CollectorRegistry, Counter, Gauge, Histogram, generate_latest, ProcessCollector

from app.auth import Principal, TokenVerifier, current_principal, require_scope
from app.config import Settings
from app.database import TrackRepository
from app.inference import InferenceService
from app.schemas import GenerationRequest, Track, TrackPage
from app.security import HealthAwareTrustedHost, RateLimiter, RequestGuard, client_ip, verify_turnstile

logger = logging.getLogger("auralis.audit")
logger.setLevel(logging.INFO)
if not logger.handlers:
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(message)s"))
    logger.addHandler(handler)
logger.propagate = False


def create_app(settings: Settings | None = None, repository=None, limiter=None, verifier=None, inference=None):
    settings = settings or Settings()
    registry = CollectorRegistry()
    ProcessCollector(registry=registry)
    requests = Counter("auralis_http_requests_total", "Responses by normalized route", ["route", "method", "status"], registry=registry)
    latency = Histogram("auralis_http_seconds", "HTTP latency", ["route"], registry=registry)
    security_events = Counter("auralis_security_events_total", "Security boundary failures", ["event"], registry=registry)
    active = Gauge("auralis_generation_requests", "Active generation HTTP requests", registry=registry)

    @asynccontextmanager
    async def lifespan(app):
        await app.state.repository.open()
        try:
            await app.state.limiter.redis.ping()
            yield
        finally:
            await app.state.limiter.close()
            await app.state.repository.close()

    app = FastAPI(title="Auralis Composition API", version="1.0.0", lifespan=lifespan,
                  docs_url="/docs" if settings.environment == "development" else None,
                  redoc_url=None, openapi_url="/openapi.json" if settings.environment == "development" else None)
    app.state.settings = settings
    app.state.repository = repository or TrackRepository(settings.database_url.get_secret_value())
    app.state.limiter = limiter or RateLimiter(settings.redis_url.get_secret_value(), settings.rate_limit_secret.get_secret_value())
    app.state.verifier = verifier or TokenVerifier(settings)
    app.state.inference = inference or InferenceService(settings)
    app.state.security_events = security_events

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, exc):
        # Pydantic's default errors echo raw input; never echo challenge tokens.
        return JSONResponse(status_code=422, content={"detail": [{"loc": list(e["loc"]), "msg": e["msg"], "type": e["type"]} for e in exc.errors()]})

    @app.exception_handler(Exception)
    async def internal_error(request, exc):
        logger.error(json.dumps({"event": "internal_error", "request_id": getattr(request.state, "request_id", "unknown"), "error_type": type(exc).__name__}))
        return JSONResponse(status_code=500, content={"detail": "Internal service error"})

    app.add_middleware(RequestGuard, settings=settings, limiter=app.state.limiter)
    app.add_middleware(HealthAwareTrustedHost, allowed_hosts=settings.allowed_hosts)
    app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins, allow_credentials=False,
                       allow_methods=["GET", "POST", "DELETE"], allow_headers=["Authorization", "Content-Type"],
                       expose_headers=["X-Request-ID", "Retry-After"])

    @app.middleware("http")
    async def observe(request: Request, call_next):
        request.state.request_id = str(uuid4())
        started, status = time.perf_counter(), 500
        try:
            response = await call_next(request)
            status = response.status_code
            response.headers["X-Request-ID"] = request.state.request_id
            return response
        finally:
            route = getattr(request.scope.get("route"), "path", "unmatched")
            # Unknown methods and paths cannot create unbounded metric labels.
            method = request.method if request.method in {"GET", "POST", "DELETE", "OPTIONS", "HEAD", "PUT", "PATCH"} else "OTHER"
            elapsed = time.perf_counter() - started
            requests.labels(route, method, str(status)).inc()
            latency.labels(route).observe(elapsed)
            if route not in {"/health/live", "/health/ready", "/metrics"}:
                logger.info(json.dumps({"event": "http_request", "request_id": request.state.request_id, "route": route, "method": method, "status": status, "duration_ms": round(elapsed * 1000)}))

    @app.get("/health/live", include_in_schema=False)
    async def live():
        return {"status": "alive"}

    @app.get("/health/ready", include_in_schema=False)
    async def ready():
        try:
            await app.state.limiter.redis.ping()
            async with app.state.repository.pool.connection() as conn:
                await conn.execute("SELECT 1")
            if not Path(settings.checkpoint_path).is_file():
                raise ValueError("No checkpoint")
        except Exception:
            raise HTTPException(503, "Service not ready") from None
        return {"status": "ready"}

    @app.get("/metrics", include_in_schema=False)
    async def metrics(request: Request):
        expected = "Bearer " + settings.metrics_token.get_secret_value()
        if not hmac.compare_digest(request.headers.get("authorization", "").encode(), expected.encode()):
            raise HTTPException(401, "Authentication required")
        return Response(content=generate_latest(registry), media_type=CONTENT_TYPE_LATEST)

    @app.post("/v1/tracks", response_model=Track, status_code=201)
    async def create_track(payload: GenerationRequest, request: Request, principal: Principal = Depends(current_principal)):
        require_scope(principal, "tracks:write")
        ip = client_ip(request, settings.trusted_proxy_cidrs)
        if not await app.state.limiter.allow(principal.owner_id, ip, request.state.request_id):
            security_events.labels("generation_rate_limit").inc()
            raise HTTPException(429, "Generation limit reached; retry in one minute", headers={"Retry-After": "60"})
        await verify_turnstile(settings, payload.turnstile_token, ip)
        config = payload.model_dump(exclude={"turnstile_token", "title"})
        active.inc()
        try:
            result = await app.state.inference.generate(config)
        finally:
            active.dec()
        midi = result["midi"]
        if not isinstance(midi, bytes) or len(midi) > 1_048_576 or not midi.startswith(b"MThd"):
            raise HTTPException(503, "Invalid model output")
        metadata = {key: config[key] for key in ("bars", "tempo", "temperature", "instrument")}
        metadata.update({key: result[key] for key in ("notes", "duration", "model")})
        # Validate trusted worker output before committing it, too.
        from datetime import datetime, timezone
        Track(id=uuid4(), title=payload.title, created_at=datetime.now(timezone.utc), **metadata)
        return await app.state.repository.create(principal.owner_id, payload.title, metadata, midi)

    @app.get("/v1/tracks", response_model=TrackPage)
    async def list_tracks(principal: Principal = Depends(current_principal), limit: int = Query(default=20, ge=1, le=50), offset: int = Query(default=0, ge=0, le=10000)):
        require_scope(principal, "tracks:read")
        return await app.state.repository.list(principal.owner_id, limit, offset)

    @app.get("/v1/tracks/{track_id}/midi")
    async def download_track(track_id: UUID, principal: Principal = Depends(current_principal)):
        require_scope(principal, "tracks:read")
        midi = await app.state.repository.midi(principal.owner_id, track_id)
        if midi is None:
            security_events.labels("record_not_visible").inc()
            raise HTTPException(404, "Track not found")
        return Response(midi, media_type="audio/midi", headers={"Content-Disposition": f'attachment; filename="auralis-{track_id}.mid"'})

    @app.delete("/v1/tracks/{track_id}", status_code=204)
    async def delete_track(track_id: UUID, principal: Principal = Depends(current_principal)):
        require_scope(principal, "tracks:write")
        if not await app.state.repository.delete(principal.owner_id, track_id):
            security_events.labels("record_not_visible").inc()
            raise HTTPException(404, "Track not found")
        return Response(status_code=204)

    return app
