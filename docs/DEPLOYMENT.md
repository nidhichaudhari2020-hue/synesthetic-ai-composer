# Deploying the Python service

This repository includes a public Sites studio, an offline browser build and a separately deployable Python service. The Sites version uses platform ChatGPT sign-in and D1 private libraries; see [hosted accounts](HOSTED-ACCOUNTS.md). Publishing it does **not** deploy PyTorch, provision Auth0, train a production model, or create the AWS resources below. No AWS account, domain, external identity provider or licensed training corpus was supplied for this build. The AWS configuration is delivered as infrastructure code, not claimed as a live deployment.

## Local dependencies

Install Docker Engine/Desktop and copy `.env.example` to `.env`. Set two different random, URL-safe, alphanumeric local database passwords. Keep `.env` out of source control. From the repository root:

```sh
docker compose up -d postgres redis
```

The first database initialization creates a migration administrator, a non-login table owner, and a restricted `app_runtime` user. SQL changes on an existing volume must be applied by the migration administrator; Docker initialization scripts run only on an empty volume. Do not delete a volume containing music merely to rerun a migration.

The dependencies bind only to loopback. Local Redis is unauthenticated and PostgreSQL is plaintext **inside this development setup**. The production configuration requires authenticated TLS Redis and PostgreSQL with certificate verification.

After configuring a real OIDC API and an appropriate model checkpoint, start the API:

```sh
docker compose --profile api up --build -d
```

It is available on `http://localhost:8080`; the container itself listens on port 8000. Development mode permits local transport but still validates bearer tokens. It does not create a fake authenticated user. The browser demonstration works without these services.

Run the native isolation check against the runtime account by setting `RLS_TEST_DATABASE_URL` securely in your shell environment, then:

```sh
python infra/tests/rls_probe.py
```

This is a real PostgreSQL check of negative authorization cases, including missing identity and connection reuse. It creates temporary rows inside a rolled-back transaction. CI runs it against PostgreSQL 17. The portable `infra/tests/rls_wasm.mjs` runs equivalent SQL against PostgreSQL compiled to WASM; it complements native integration checks and is not evidence of a cloud deployment.

## Identity and human verification

Create an Auth0 single-page application and a custom API (an equivalent standards-compliant OIDC provider can be substituted). Use the provider's supported Authorization Code + PKCE client flow; register exact callback, logout and allowed-origin URLs. Use RS256 access tokens with the API identifier as the audience. Enable API scopes `tracks:read` and `tracks:write` and authorize the SPA for them. Never send an ID token as the API bearer token. Browser configuration consists only of the public issuer, client ID, audience and API URL.

Create a Cloudflare Turnstile widget for the frontend hostname. Store its secret in Secrets Manager and only its site key in the browser. Production generation verifies the server-side token, hostname and action. No cloud service account key belongs in frontend code. See [Auth0 access-token validation](https://auth0.com/docs/secure/tokens/access-tokens/validate-access-tokens) and [Turnstile server validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/).

## AWS prerequisites

The template creates billable resources: two NAT gateways, an HTTPS Application Load Balancer, WAF, multi-AZ RDS PostgreSQL, two-node ElastiCache Redis, ECS, secrets and logs. Review regional pricing and quotas before running it. There is no automatic apply/deploy action in this repository.

You need an AWS account and deployment principal, two availability zones, ECR repositories, a domain with DNS control, a validated ACM certificate in the deployment region, OIDC and Turnstile configuration, and an approved trained checkpoint. Set a budget and choose a region permitted for your users' data. The template uses commercial AWS partition endpoint behavior and requires a region supporting the selected PostgreSQL, Redis and instance versions; check these before deployment. PostgreSQL 17.11 is selected from the [RDS supported releases](https://docs.aws.amazon.com/AmazonRDS/latest/PostgreSQLReleaseNotes/postgresql-versions.html); recheck regional availability when provisioning.

Build/push the backend and migration images to ECR. Resolve each pushed image's digest and use `@sha256:...` URIs in stack parameters. Do not deploy mutable tags. The production API image must contain `/models/composer.pt`:

```sh
docker build -t auralis-api-base ./backend
docker build -f infra/migration.Dockerfile -t auralis-migration .
# Push the base image and resolve its immutable ECR digest first.
docker build -f infra/runtime.Dockerfile --build-arg BASE_IMAGE=YOUR_IMMUTABLE_BASE_IMAGE -t auralis-api .
```

Place the reviewed checkpoint at `models/composer.pt` before the last command. A synthetic smoke checkpoint, if generated with the included training tools, belongs in `model-demo/` rather than that production path. Such a run can check the training/inference path but cannot establish production musical quality. Follow `MODEL.md` for corpus licensing, held-out evaluation and training. Review image dependencies, scan the image and pin base images by digest in your release pipeline.

The browser's `web/config.json` defaults to `mode: "demo"`. To connect it after the backend is deployed, use the public-configuration helper with your real non-secret values:

```sh
python infra/configure_frontend.py --api-origin https://api.YOUR-DOMAIN.example --auth0-domain YOUR-TENANT.auth0.com --auth0-client-id PUBLIC_CLIENT_ID --auth0-audience https://api.YOUR-DOMAIN.example --turnstile-site-key PUBLIC_TURNSTILE_SITE_KEY
npm run build
```

Use lowercase real hostnames in that command. The helper writes `mode: "production"`, public OIDC settings and the public Turnstile site key, and updates the frontend Content Security Policy for the exact API/Auth0 origins. The build script also derives these origins when you edit public configuration directly. Serve `config.json` without caching when possible and deploy the resulting `dist/`. Register the final frontend origin with Auth0 and Turnstile. Never put the Auth0 client secret or Turnstile secret in this configuration. Demo and cloud libraries remain separate.

## Stack and bootstrap sequence

1. Validate `infra/aws/stack.yaml` with `cfn-lint` and AWS `validate-template`. Create a CloudFormation change set with the required certificate, API hostname, frontend origin, OIDC issuer/audience, immutable API and migration image URIs. Keep `DesiredCount=0`. Review and execute the change set with IAM capability acknowledgment. A zero-task stack still incurs infrastructure charges.
2. The stack outputs the ECS cluster, migration task ARN, two private subnet IDs, task security group, runtime secret ARN and ALB DNS name. Run the migration task **once** on Fargate in those private subnets with that security group and `assignPublicIp=DISABLED`. Run it using the supplied task definition, not an unreviewed override.
3. `provision.py` reads the RDS-managed administrator secret, applies the schema, sets the restricted runtime role password, executes negative RLS probes as `app_runtime`, and writes URL-encoded, TLS-verified connection strings to the runtime secret. It generates independent rate-limit and metrics secrets. The task reports only success/failure, never secret contents. Confirm task exit code 0 and the success message in the migration log group. A failure must be resolved before starting the API.
4. In the Secrets Manager console key/value editor, add `TURNSTILE_SECRET` to the runtime secret while preserving the generated keys. Do not pass secret values in CLI arguments, checked-in parameter files or shell history. The API execution role can retrieve only this runtime secret; the runtime task role has no AWS API permissions. Only the short-lived migration task uses database administration rights.
5. Create a DNS alias/CNAME for the API hostname to the stack's ALB. Update the stack to `DesiredCount=2` only after OIDC, Turnstile, model and DNS configuration is complete. Tasks have no public IP. Only ALB port 443 is open to the internet; there is no port-80 listener. The ALB reaches private API port 8000, and only task security-group traffic reaches database and cache ports.
6. Confirm `/health/ready`, then run a signed-in generation, MIDI download and two-user isolation check through the public API. Cross-user IDs must produce 404 with no bytes or metadata leaked. Check rate limits from more than one API task; Redis makes the counters shared. Repeat the bad-signature, issuer/audience, expired-token, invalid-turnstile and invalid-input tests.
7. Subscribe an on-call destination to the output SNS topic. Confirm a test notification reaches the actual responder. CloudWatch alarms exist for 5xx spikes, CPU pressure and authentication-denial bursts, but an unsubscribed topic notifies nobody. Add memory, database-storage, failover, readiness and latency alarms appropriate to measured traffic, and test recovery procedures before launch.

AWS WAF provides coarse IP rate protection at 100 requests/minute and managed common-threat rules. The application also applies a shared 100/minute per-IP ingress cap before `/v1` body parsing/token verification and the tighter 10-generation/minute policy per user and IP. WAF rate limiting is approximate; it is not the compute quota. Paid AWS Bot Control is an explicit opt-in parameter. Turnstile is required for production generation regardless of that option. [AWS WAF rate windows](https://docs.aws.amazon.com/waf/latest/developerguide/waf-rule-statement-type-rate-based-high-level-settings.html).

## Operations

Inspect JSON API logs and ECS Container Insights for request status, timing, errors, CPU and memory. Request IDs correlate failures without including music payloads, bearer tokens or credentials. `/metrics` is protected by a separate bearer secret; scrape it only from an approved internal collector and do not publish that secret. The provided stack does not install Grafana or a Prometheus server.

ECS injects secrets at container startup. Rotation requires a new task deployment. Rotate the runtime database password using the separate provisioner and coordinate the runtime secret and running tasks; do not rotate a password independently and strand the service. Redis AUTH rotation requires a dual-token rotation sequence, runtime secret update and task rollout before removing the old token. RDS manages the administrator secret separately. See [RDS Secrets Manager integration](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-secrets-manager.html).

Backups retain database snapshots for seven days and Redis snapshots for one day. RDS deletion protection is enabled; removing the stack requires a deliberate protection change and leaves a database snapshot. These are starting retention settings. Test restoration with tenant-isolation checks and define a user-data deletion/backup-expiry policy before production.

The current service bounds concurrent CPU inference and rejects excess work. It does not provide a durable job queue or autoscale model workers. Measure generation latency and memory at the intended model size; a 45-second timeout and 2-vCPU task may need adjustment. Add a queue with explicit per-user quotas and idempotency before accepting long-running/high-volume generation. Training belongs in a separate controlled job, not a public request handler.

Before a public launch, complete native container tests, a real deployment rehearsal, restoration and key-rotation drills, model quality/licensing review, dependency and image scans, accessibility/load testing, and an independent security review. Infrastructure source and local tests cannot establish those outcomes.
