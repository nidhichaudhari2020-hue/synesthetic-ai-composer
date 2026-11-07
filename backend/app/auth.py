import asyncio
import hashlib
from dataclasses import dataclass

import jwt
from fastapi import HTTPException, Request, Security
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

bearer = HTTPBearer(auto_error=False)


@dataclass(frozen=True)
class Principal:
    owner_id: str
    scopes: frozenset[str]


class TokenVerifier:
    def __init__(self, settings):
        self.settings = settings
        self.jwks = jwt.PyJWKClient(settings.oidc_jwks_url, cache_jwk_set=True, lifespan=300, timeout=5)

    def verify(self, token: str) -> Principal:
        if len(token) > 16384:
            raise jwt.InvalidTokenError("Token too long")
        header = jwt.get_unverified_header(token)
        if header.get("alg") != "RS256" or not isinstance(header.get("kid"), str):
            raise jwt.InvalidTokenError("Unsupported signing method")
        key = self.jwks.get_signing_key_from_jwt(token).key
        claims = jwt.decode(token, key, algorithms=["RS256"], audience=self.settings.oidc_audience,
                            issuer=self.settings.oidc_issuer, leeway=10,
                            options={"require": ["exp", "iat", "iss", "aud", "sub"]})
        subject = claims["sub"]
        if not isinstance(subject, str) or not 1 <= len(subject) <= 256:
            raise jwt.InvalidTokenError("Invalid subject")
        scope = claims.get("scope", "")
        if not isinstance(scope, str) or len(scope) > 4096:
            raise jwt.InvalidTokenError("Invalid scope")
        owner = hashlib.sha256((self.settings.oidc_issuer + "\0" + subject).encode()).hexdigest()
        return Principal(owner_id=owner, scopes=frozenset(scope.split()))


async def current_principal(request: Request, credentials: HTTPAuthorizationCredentials | None = Security(bearer)):
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(401, "Authentication required", headers={"WWW-Authenticate": "Bearer"})
    try:
        return await asyncio.to_thread(request.app.state.verifier.verify, credentials.credentials)
    except jwt.PyJWTError:
        request.app.state.security_events.labels("invalid_token").inc()
        raise HTTPException(401, "Invalid access token", headers={"WWW-Authenticate": "Bearer"}) from None


def require_scope(principal: Principal, scope: str):
    if scope not in principal.scopes:
        raise HTTPException(403, "Insufficient scope")
