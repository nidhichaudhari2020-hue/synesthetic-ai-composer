# Public studio and private accounts

[Auralis](https://auralis-synesthetic-composer.nidhichaudhari2020.chatgpt.site) remains publicly accessible. Guests generate, play and download music without an account. **Sign in / Create account → Continue with ChatGPT → Create my account** creates a site profile. A visitor needs a ChatGPT identity; there is no separate Auralis password or email registration system.

After profile creation, new compositions save to the signed-in user's library. It holds up to 50 compositions. MIDI and WAV exports are reconstructed on the device from that user's authorized note data. Library deletion removes a composition from the active database. Guest history remains in the originating browser profile (up to 25 tracks) and is never silently uploaded. The offline ZIP uses `mode: demo`, so hosted accounts are available at the website only.

## Trust boundary

Sites dispatch owns HTTPS, sign-in, sign-out and visitor session cookies. Server handlers use only its site-specific `oai-authenticated-user-id` header for ownership. This API must stay behind Sites dispatch and must never be mounted on a public origin that accepts that header directly. Names are optional display fields and are not stored; passwords, tokens and email addresses are not persisted in D1.

`hosted/api.js` supplies `/api/account` and `/api/library`. Every record query binds the authenticated owner. Payloads cannot supply ownership. Composite `(owner_id,id)` primary keys prevent accidental collisions between tenants. Unknown and inaccessible delete targets both return 404. D1 does not provide PostgreSQL RLS here: isolation is enforced by the trusted server and explicit owner predicates. A compromised privileged worker/database administrator remains outside this boundary.

Mutations require the same Origin, a custom request header and strict bounded JSON. Bodies are capped at 64 KiB. Titles, UUIDs, instrument, timing, pitches, velocities and configuration fields are allowlisted. D1 transactional batches cap successful saves/deletes at 10 per minute per account and enforce capacity atomically. Identical saves are idempotent; deleted tracks do not refund quota. These are library-write quotas, not a claim of deployed per-IP WAF rules or server inference protection. Inference uses visitor CPU, not a public model-compute endpoint.

Private responses use `Cache-Control: private, no-store`. Cloud records are never written into guest localStorage. Sign-out clears private UI state and playback; returning to a hidden tab rechecks identity. A failed save leaves a playable/downloadable score with an explicit warning. Model labels describe the supported demo score format, not server-verified provenance of arbitrary client submissions.

## Reproduce and publish

Use Node.js 22.13+ and the installed Sites plugin's supported Vinext workflow. From `auralis/`, `npm ci`, `npm test`, and `npm run build` produce the offline build and run browser/account tests. `hosted/prepare.mjs ABSOLUTE_VINEXT_CHECKOUT EXISTING_SITE_ID` copies only compiled browser assets, the hosted handler and schema into a separately prepared Vinext starter. It preserves Site identity and sets `d1: DB`, `r2: null`, removing the former static-only declaration.

The generated initial schema and Drizzle snapshot/journal are under `hosted/drizzle/`. Preserve applied migrations and append future ones. Sites runs these schema-only migrations before uploading the worker. Local preview uses a separate D1 database and the starter's development-only simulated identity. That simulation is absent from production builds.

Keep `.wrangler`, `.sites-runtime`, node_modules, environment files and local test records out of repository uploads. The supported Sites source helper pushes the exact source and packages the build; public sites use save-version followed by deploy-version. The full Python source/checkpoint and personal compositions are not part of that upload.

## Verification and limits

The 18 Node tests pass, including the real generated SQL in SQLite: two-user ownership boundaries, invalid payloads/CSRF, idempotency, quota bursts, capacity and client failure handling. Local Vinext/D1 browser checks cover sign-in return, explicit profile creation, generation/save, persistence after reload, and sign-out clearing private music. Local browser sign-in is the starter's test identity and is not evidence of a real provider login.

Deployment results and live checks are recorded in [VALIDATION.md](VALIDATION.md). An independent security audit, two separate real-user sessions, backup restoration, account-wide erasure/retention policies and production model quality evaluation remain additional work. No external Auth0, AWS WAF, Turnstile, Redis or CloudWatch deployment is implied by this Sites account feature.
