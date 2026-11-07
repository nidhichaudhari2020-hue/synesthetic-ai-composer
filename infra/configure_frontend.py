"""Write public browser configuration and matching CSP. No secret inputs allowed."""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import re
from urllib.parse import urlsplit


def https_origin(value: str) -> str:
    parsed = urlsplit(value)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.port not in (None, 443) or parsed.path or parsed.query or parsed.fragment:
        raise argparse.ArgumentTypeError("Use an HTTPS origin only, without a trailing slash, path or credentials")
    if not re.fullmatch(r"[a-z0-9.-]+", parsed.hostname):
        raise argparse.ArgumentTypeError("Use an ASCII HTTPS hostname")
    return value


def public_identifier(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,256}", value):
        raise argparse.ArgumentTypeError("Expected a public client identifier/site key")
    return value


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api-origin", required=True, type=https_origin)
    parser.add_argument("--auth0-domain", required=True)
    parser.add_argument("--auth0-client-id", required=True, type=public_identifier)
    parser.add_argument("--auth0-audience", required=True)
    parser.add_argument("--turnstile-site-key", required=True, type=public_identifier)
    parser.add_argument("--web-directory", type=Path, default=Path(__file__).resolve().parents[1] / "web")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z0-9.-]+", args.auth0_domain) or "." not in args.auth0_domain:
        parser.error("auth0-domain is a lowercase hostname, without https:// or a path")
    auth_origin = https_origin(f"https://{args.auth0_domain}")
    if not args.web_directory.is_dir():
        parser.error("web-directory must be an existing frontend directory")
    config = {
        "mode": "production", "apiBaseUrl": args.api_origin,
        "auth0Domain": args.auth0_domain, "auth0ClientId": args.auth0_client_id,
        "auth0Audience": args.auth0_audience, "turnstileSiteKey": args.turnstile_site_key,
    }
    headers = "\n".join([
        "/*", "  X-Content-Type-Options: nosniff", "  Referrer-Policy: no-referrer",
        "  Permissions-Policy: camera=(), microphone=(), geolocation=()",
        "  Strict-Transport-Security: max-age=31536000",
        "  Content-Security-Policy: default-src 'self'; script-src 'self' https://challenges.cloudflare.com; "
        "style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; "
        f"connect-src 'self' {args.api_origin} {auth_origin} https://challenges.cloudflare.com; "
        f"frame-src {auth_origin} https://challenges.cloudflare.com; "
        "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
        "/config.json", "  Cache-Control: no-store", "",
    ])
    (args.web_directory / "config.json").write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    (args.web_directory / "_headers").write_text(headers, encoding="utf-8")
    print("Public frontend configuration and matching security headers written. Rebuild and deploy the frontend.")


if __name__ == "__main__":
    main()
