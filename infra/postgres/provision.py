"""One-off ECS migration. Retrieves secrets in memory and never prints them."""
from __future__ import annotations

import json
import os
from pathlib import Path
import secrets
from urllib.parse import quote, urlencode

import boto3
import psycopg
from psycopg import sql

from rls_probe import verify_isolation


def main() -> None:
    client = boto3.client("secretsmanager", region_name=os.environ["AWS_REGION"])

    def read(env_name: str) -> str:
        return client.get_secret_value(SecretId=os.environ[env_name])["SecretString"]

    admin = json.loads(read("ADMIN_SECRET_ARN"))
    app_password = read("APP_PASSWORD_SECRET_ARN")
    redis_password = read("REDIS_PASSWORD_SECRET_ARN")
    host = os.environ["DATABASE_HOST"]
    ssl = {"sslmode": "verify-full", "sslrootcert": "/etc/ssl/certs/rds-global-bundle.pem"}
    with psycopg.connect(host=host, dbname="auralis", user=admin["username"], password=admin["password"], **ssl) as conn:
        conn.execute(Path(__file__).with_name("schema.sql").read_text(encoding="utf-8"))
        conn.execute(sql.SQL("ALTER ROLE app_runtime PASSWORD {}").format(sql.Literal(app_password)))
    database_url = f"postgresql://app_runtime:{quote(app_password, safe='')}@{host}:5432/auralis?{urlencode(ssl)}"
    # Validate RLS using the actual runtime account, never the migration account.
    verify_isolation(database_url)
    previous = json.loads(read("RUNTIME_SECRET_ARN"))
    previous.pop("NOT_CONFIGURED", None)
    previous.update({
        "DATABASE_URL": database_url,
        "REDIS_URL": f"rediss://:{quote(redis_password, safe='')}@{os.environ['REDIS_HOST']}:6379/0?ssl_cert_reqs=required",
        "RATE_LIMIT_SECRET": previous.get("RATE_LIMIT_SECRET") or secrets.token_urlsafe(48),
        "METRICS_TOKEN": previous.get("METRICS_TOKEN") or secrets.token_urlsafe(48),
    })
    # TURNSTILE_SECRET remains operator-supplied. Missing key prevents ECS startup.
    client.put_secret_value(SecretId=os.environ["RUNTIME_SECRET_ARN"], SecretString=json.dumps(previous))
    print("Schema applied, tenant isolation verified, runtime connection secrets provisioned. Supply Turnstile before starting API tasks.")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Connection exception messages can contain credentials/DSNs. Do not emit them.
        print("Provisioning failed. Inspect database connectivity, role privileges and AWS permissions without logging secret values.")
        raise SystemExit(1) from None
