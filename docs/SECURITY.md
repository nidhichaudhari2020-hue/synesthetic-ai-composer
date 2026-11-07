# Security model and verification boundaries

The public Sites deployment uses the [hosted account boundary](HOSTED-ACCOUNTS.md): dispatch-owned ChatGPT authentication and owner-scoped D1 queries. It does not run the PostgreSQL/AWS architecture described below. That separate Python service is supplied as source, not deployed.

The API treats every client field as untrusted. The authenticated OIDC subject determines ownership; no request may choose an owner ID. A token must have the configured issuer, audience, supported signature algorithm, validity claims and API scope. The browser contains public OIDC configuration only. An API secret, database URL, Turnstile secret or metrics bearer credential must never appear in a `VITE_*` variable or browser bundle.

## Tenant boundary

`infra/postgres/schema.sql` separates a non-login table owner from `app_runtime`. The runtime role is neither superuser nor `BYPASSRLS`, is not the owner, and receives only SELECT/INSERT/UPDATE/DELETE on the music table. RLS is enabled and forced. Every policy reads the transaction-local `app.user_id`; missing/empty identity denies access. Writes must preserve the same owner. The API binds subject context inside the same transaction as each query, and also includes explicit owner predicates. PostgreSQL transaction-local settings are cleared before pooled connections can be reused.

MIDI bytes reside in the same protected record as their metadata. Downloads pass through the authenticated API query, so there are no public object keys or reusable unsigned object URLs. Unknown and inaccessible record IDs return the same 404 response. The negative SQL tests exercise cross-tenant read, download, update and delete, owner forgery, absent identity and transaction reuse. PostgreSQL's distinction between ordinary roles, owners and bypass roles is documented in [row security policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html).

This is context-based isolation with a trusted API. A compromised database administrator or a fully compromised API process with the ability to execute arbitrary SQL can set session context or alter policies. RLS is not a defense against those privileged attackers. Prevent SQL injection with parameter binding, restrict admin access, isolate workloads and review privileged operations. Tenant isolation tests are necessary, not a substitute for a security assessment.

## Transport and abuse boundaries

Production connections terminate at an HTTPS-only ALB with a TLS 1.2/1.3 policy. Security groups make the API reachable only from that ALB, and database/cache reachable only from private tasks. PostgreSQL verifies the RDS certificate chain and hostname; Redis requires authentication and encrypted transport. API proxy headers are trusted only from explicitly listed ALB subnet CIDRs. Internet-supplied `X-Forwarded-For` is not an authority by itself.

Redis performs atomic, expiring limits shared across API replicas: a 100-request/minute per-IP ingress cap before `/v1` body parsing and token verification, then 10 generations/minute for both identity and IP. Separate identity and IP counters bound authenticated abuse and account rotation. Loss of the rate-limit store must deny generation. CPU work is bounded and timed out. WAF blocks common attack patterns and coarse IP floods; production generation additionally requires a verified Turnstile token with the expected host/action. Authentication is required before accessing user records.

Schema validation limits seed-chord vocabulary, bar count, tempo, temperature, instrument, title and payload size, and rejects unknown fields. There is no natural-language prompt sent to a language model. Validation here prevents malformed musical data and resource abuse; it does not constitute a general solution to prompt injection in future text-based features. MIDI parsing/training is an offline path with parser limits and should run in a separate constrained environment using a trusted licensed corpus.

## Secrets and logging

CloudFormation retrieves generated Redis authentication through Secrets Manager dynamic references. RDS manages its administrator password. A separate one-off task provisions the runtime role and secret, then exits. The API never receives administrator credentials. Production runtime values are injected from Secrets Manager and omitted from build arguments, source archives and client code. The example environment file contains only nonfunctional examples.

API logs use request IDs, normalized routes, statuses and timing. They must not contain bearer tokens, MIDI content, raw database URLs, Turnstile tokens or seed uploads. CloudWatch request sampling in the WAF template is disabled to avoid retaining bodies/credentials by default. The metrics endpoint requires a separate secret and should be collected through internal access controls. Turnstile and OIDC are external trust dependencies; failure should not create an authentication bypass.

## Release checks and remaining work

- Run backend tests plus the native PostgreSQL isolation probe; repeat through HTTP using two real OIDC users in staging.
- Verify every worker uses `app_runtime`, forced RLS remains enabled, and a missing subject yields no records.
- Exercise invalid/expired JWTs, wrong scopes, spoofed forwarding headers, CAPTCHA failures, concurrent quota bursts and backend outages.
- Scan dependencies, containers and source for secrets; pin release artifacts by digest and verify checkpoint provenance.
- Rehearse credential rotation, database restoration, deployment rollback and on-call alerts.
- Establish retention/deletion, incident response, training-data licensing and abuse response procedures.
- Commission an independent assessment before describing the service as audited or certified.

The downloadable browser demonstration stores music locally. The hosted studio adds private D1 libraries, while model inference and audio synthesis still happen on each visitor's device. The separate AWS infrastructure is not live until an operator supplies account/provider details and completes the deployment sequence.
