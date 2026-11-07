# Auralis Firebase deployment

This deployment runs the trained model in a browser Web Worker. It uses Firebase Authentication for email/password and Google sign-in, and Firestore for private score storage. It does not deploy the separate Python/AWS inference service.

Project: `auralis-nidhi-composer`. Hosting site: `auralis-synesthetic-composer-nidhichaudhari2020`. Default Firestore database: Standard edition, Mumbai (`asia-south1`). No billing upgrade is needed for this configuration; service quotas still apply.

`public-config.json` contains public Firebase web identifiers, including the public API key. It contains no service-account credentials or administrative keys. Authorization is enforced by `firestore.rules`, not by hiding these identifiers.

Build from the Auralis project directory:

```powershell
npm ci
node scripts/build.mjs firebase/public-config.json firebase/public
npx -y firebase-tools@latest deploy --config firebase/firebase.json --only auth,firestore,hosting --project auralis-nidhi-composer
```

Validate security before updating deployed rules. Java 21+ and Node 24.12+ are required by the current test dependencies. Install isolated rule-test dependencies with `npm ci --prefix firebase/tests`, then run:

```powershell
npx -y firebase-tools@latest emulators:exec --config firebase/emulator-config.json --only auth,firestore --project demo-auralis-rules "node --test --test-concurrency=1 firebase/tests/firestore.test.mjs firebase/firebase-account.test.mjs"
```

The emulator uses loopback-only ports 8085 and 9099. Tests use disposable identities and do not send real verification or reset emails.

## Account and data boundaries

- Verification is required before a user can create or access a cloud library. Google sign-in normally supplies a verified email; password users must follow their verification link.
- Each profile and its tracks live under `/users/{Firebase UID}`. Every library request must satisfy ownership and verification rules.
- Save/delete transactions update the score and account metadata together. Rules enforce 50 tracks maximum and 10 mutations per rolling minute, even when callers bypass the UI.
- Scores use a bounded 39-character alphabet. Rules validate every pitch/rest/hold token and reject extra fields. MIDI round-trip tests check that storage preserves the generated score.
- Auth persistence is limited to the browser session. Private scores use an in-memory Firestore cache and are cleared from the visible studio on sign-out or account change. Guest scores remain in LocalStorage on their original origin.
- Guest histories and the legacy Sites/D1 accounts are not migrated or linked by email. Their existing data remains on the previous host.

The rules are designed and tested for this portfolio prototype. A broader production release still requires independent security review, operational monitoring, abuse/load testing, and a recovery plan. Per-user write limits do not prevent all read-quota exhaustion or creation of multiple accounts. Firebase App Check is not configured in this release. The app does not initialize Analytics.
