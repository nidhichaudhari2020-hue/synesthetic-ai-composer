from pathlib import Path
from typing import Literal
from urllib.parse import parse_qs, urlparse

from pydantic import Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=None, extra="ignore")

    environment: Literal["development", "production"] = "production"
    database_url: SecretStr
    redis_url: SecretStr
    oidc_issuer: str
    oidc_audience: str
    oidc_jwks_url: str = ""
    cors_origins: list[str] = Field(default_factory=list)
    allowed_hosts: list[str] = Field(default_factory=lambda: ["localhost", "127.0.0.1"])
    trusted_proxy_cidrs: list[str] = Field(default_factory=list)
    turnstile_secret: SecretStr = SecretStr("")
    turnstile_hostname: str = ""
    rate_limit_secret: SecretStr = Field(min_length=32)
    metrics_token: SecretStr = Field(min_length=32)
    checkpoint_path: Path = Path("/models/composer.pt")
    generation_timeout_seconds: int = Field(default=45, ge=5, le=180)
    generation_concurrency: int = Field(default=1, ge=1, le=4)

    @model_validator(mode="after")
    def secure_configuration(self):
        issuer = urlparse(self.oidc_issuer)
        if issuer.scheme != "https" or not issuer.netloc or not self.oidc_issuer.endswith("/"):
            raise ValueError("OIDC_ISSUER must be an HTTPS origin/path ending in /")
        if not self.oidc_audience:
            raise ValueError("OIDC_AUDIENCE must be configured")
        if not self.oidc_jwks_url:
            self.oidc_jwks_url = self.oidc_issuer + ".well-known/jwks.json"
        jwks = urlparse(self.oidc_jwks_url)
        if jwks.scheme != "https" or jwks.netloc != issuer.netloc:
            raise ValueError("JWKS must be on the configured HTTPS issuer host")
        if "*" in self.allowed_hosts or "*" in self.cors_origins:
            raise ValueError("Wildcard hosts and CORS origins are forbidden")
        import ipaddress
        for cidr in self.trusted_proxy_cidrs:
            network = ipaddress.ip_network(cidr)
            if network.prefixlen == 0:
                raise ValueError("Do not trust every proxy address")
        if self.environment == "production":
            db_query = parse_qs(urlparse(self.database_url.get_secret_value()).query)
            if db_query.get("sslmode") != ["verify-full"]:
                raise ValueError("Production DATABASE_URL requires sslmode=verify-full")
            if urlparse(self.redis_url.get_secret_value()).scheme != "rediss":
                raise ValueError("Production REDIS_URL requires TLS (rediss)")
            if not self.turnstile_secret.get_secret_value() or not self.turnstile_hostname:
                raise ValueError("Production Turnstile secret and hostname are required")
            if not self.cors_origins or any(urlparse(x).scheme != "https" for x in self.cors_origins):
                raise ValueError("Production CORS origins must be explicit HTTPS origins")
        return self
