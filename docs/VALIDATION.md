# Verification record

| Area | Result |
|---|---|
| Model training | Trained a two-layer PyTorch LSTM for six epochs on original synthetic MIDI exercises. Ten files were used for training and two were held out. Final validation cross-entropy was 2.5467. The checkpoint and file hashes are in `model-demo/`. |
| MIDI and inference | All 24 Python ML tests passed, including real music21 parsing, malformed inputs, notes tied across barlines, invalid checkpoints, and exact 16/32-bar end ticks. The 16-bar sample has 109 note-ons, 109 note-offs and lasts 40 seconds at 96 BPM. |
| Browser | All nine Node tests passed, including a byte-for-byte MIDI round-trip for the featured sample. The worker matched 195 PyTorch logits within 2.39 × 10⁻⁷. Browser checks covered the desktop and narrow layouts, generation, playback, library storage, MIDI download and WAV export. The revised opening audition, its 109-note timeline and Model notes dialog were also checked in the browser. |
| Comparative evaluation | Two evaluation tests passed. The evaluator verified the source and checkpoint hashes and scored the same 384 validation tokens for three models. The bigram scored 2.10153, unigram 2.45575, and LSTM 2.54667 nats per token. The two synthetic validation files were also used to choose the checkpoint. [Method and results](EVALUATION.md). |
| API | 38 security and service tests passed in the run without external database services. They cover OIDC signature and claim rejection, scopes, tenant boundaries, malformed bodies, concurrency, timeouts, bot checks, proxy handling, and rate-limit failures. Service-dependent tests have separate verification below. |
| Database policies | Native PostgreSQL 17.11 passed the restricted-role probes for cross-user reads, MIDI access, update, delete, forged ownership, missing identity, and transaction context reset. The separate API pool integration test passed on the same SCRAM-authenticated server and verified identity clearing after commit and rollback. The server shut down after testing. Equivalent SQL probes also passed on PostgreSQL compiled to WebAssembly. |
| Infrastructure | CloudFormation passed cfn-lint 1.59.0. Production configuration and matching CSP passed fixture checks. Compose and CI configuration passed parsing and wiring checks. |

## Firebase account release verification

The Firebase studio is available at [the public Auralis address](https://auralis-synesthetic-composer-nidhichaudhari2020.web.app/). Email/password and Google providers are enabled. The default Firestore database is provisioned in Mumbai (`asia-south1`). These services are separate from the older Sites/D1 account system described below.

All **24 Node tests** passed for the browser, model parity, public configuration, score codec and legacy account API. All **16 Firebase emulator tests** passed with Node 24 and Java 21. The latter exercise real Auth/Firestore emulator requests and the checked-in rules, including:

- Email verification before profile creation, private score save/list/delete, score-to-MIDI byte parity, sign-out clearing and stale-session read rejection.
- Isolation across two identities, rejection of unauthenticated/unverified access, and strict profile/score field validation.
- Atomic score/metadata transitions, the 50-track cap, ten mutations per rolling minute, and rejection of quota resets, orphan tracks and malformed batches.

The account lifecycle tests use disposable emulator identities and do not send real verification or password-reset email. The public deployment was checked for anonymous studio loading and 16-bar generation. A complete production Google sign-in and real email-delivery lifecycle have not yet been verified. The final Firebase release successfully deployed the tested private-library rules, Firestore indexes and six hosting files, including the Engineering Breakdown and public GitHub source link. The CLI confirmed both the rules release and hosting release.

The checked-in [CI workflow](../.github/workflows/security-checks.yml) runs browser builds and Firebase emulators as well as the Python/PostgreSQL/Redis checks. Hosted runner status must be verified after publication. [Firebase reproduction and limits](../firebase/README.md).

## Earlier Sites deployment and service boundaries

Sites reported successful **public** deployment of version 3 on November 4, 2026. Source commit: `f567d892b5479868d7a993f4d14674e764a8a045`. The deployed artifact contains the browser studio, Vinext account worker and D1 schema migration. [Open the studio](https://auralis-synesthetic-composer.nidhichaudhari2020.chatgpt.site).

All **18 Node tests** passed for this release. Six account API tests execute the generated schema and real queries in SQLite, checking tenant isolation, exact retries, atomic write/capacity limits, malformed input and CSRF rejection. Three added frontend adapter tests cover same-origin calls, credential-free configuration, session failures and malformed responses. Nine model/browser tests remain passing.

Local Vinext/D1 browser verification passed sign-in return, explicit profile creation, generation/save, reload persistence and sign-out clearing private tracks. The deployed site passed anonymous HTTP 200 for the public studio, anonymous `/api/library` rejection with 401, no-store account responses and rejection of fabricated `oai-authenticated-user-*` headers. In the owner's existing real ChatGPT session, profile creation and generation/save succeeded; a full reload retrieved the new composition from the private library. Earlier guest history was not uploaded. Two independent real-user sessions and a fresh external provider signup were not tested; cross-user query isolation was tested with separate identities in the SQL harness.

Model inference and synthesis still happen on the visitor's device. The downloadable build remains offline/device-local. The executable Python backend and AWS stack are supplied separately in source. Auth0 login, Turnstile validation with production keys, AWS WAF traffic, CloudWatch notifications, native Redis integration, Docker image builds, and ECS deployment still require provisioned services or a suitable test environment. CI includes service containers for PostgreSQL and Redis. The workflow has not been executed on a hosted runner in this project.

The release procedure includes two-user tests against the deployed API, dependency and image scanning, load testing, checkpoint review, backup restoration and alert delivery. See [deployment](DEPLOYMENT.md), [model evaluation](MODEL.md), and [security](SECURITY.md).
