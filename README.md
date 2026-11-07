# Auralis · A neural MIDI composer with a living interface

**[Open the live studio](https://auralis-synesthetic-composer-nidhichaudhari2020.web.app/)** · [Explore the source](https://github.com/nidhichaudhari2020-hue/synesthetic-ai-composer) · [Hear the 40-second sample](model-demo/lstm-demo-16-bars.wav) · [Download its MIDI](model-demo/lstm-demo-16-bars.mid)

Auralis turns four seed chords into 16 or 32 bars of melody. A PyTorch LSTM learns a vocabulary of 39 musical tokens. The demo runs its exported weights in a JavaScript worker, synthesizes audio on the device and animates a Three.js particle cloud from the audio spectrum.

Try generation without an account, or use email/Google sign-in for a private cloud library. The live page's **Engineering Breakdown** explains the learning pipeline, worker execution and storage boundaries, with an architecture diagram. This repository includes the browser studio, Firebase account integration, reproducible model evidence, and a separate FastAPI/PostgreSQL deployment path.

| Engineering question | Decision and measured result | Inspect |
|---|---|---|
| Does the LSTM improve next-token prediction? | The split holds out whole songs before windowing. On 384 targets from two synthetic validation files, the bigram scored **2.1015** and the LSTM **2.5467** nats per token. Lower is better. These two files also selected the best epoch. | [Evaluation report](model-demo/evaluation.json) · [Scorer](backend/app/ml/evaluate.py) |
| Does the browser run the same model? | The JavaScript LSTM matched 195 reference outputs from PyTorch with a maximum absolute logit difference of **2.39 × 10⁻⁷**. The test follows a seed and four subsequent token steps. | [Parity test](web/tests/neural.test.mjs) · [Browser worker](web/neural-worker.js) |
| Can users access each other’s tracks? | The Python service derives ownership from verified OIDC tokens and sets it for each PostgreSQL transaction. Native PostgreSQL 17.11 rejected cross-user access, and a reused connection cleared its prior identity on commit and rollback. | [RLS policy](infra/postgres/schema.sql) · [Isolation probes](infra/tests/rls_probe.py) · [Pool test](backend/tests/test_database.py) |

## Run the studio

Use Node.js **24.12+**. Clone the repository, install the locked dependencies and build the device-local studio:

```sh
git clone https://github.com/nidhichaudhari2020-hue/synesthetic-ai-composer.git
cd synesthetic-ai-composer
npm ci
npm run build
npm run dev
```

Open **http://127.0.0.1:4173/**. Choose a mood and chord progression, set the temperature and press **Create a composition**. Play the result to see its sound move the particle cloud, or export MIDI and WAV. The default build keeps the latest 25 tracks in the browser profile and needs no cloud credentials. Generated build output and installed dependencies are not committed.

The downloadable delivery ZIP additionally includes a prebuilt `dist/` directory and a standalone `Auralis-case-study.html`. On Windows, its **Start Auralis.cmd** launcher uses an installed Node.js or Python runtime.

The Firebase version supports **email/password and Google sign-in**. Verified users can create a private library of up to 50 tracks. Firestore rules enforce account ownership, strict score validation, and 10 save/delete operations per rolling minute. Guest history stays on its original device and is not automatically uploaded. The downloadable offline build remains device-local. [Firebase architecture and reproduction](firebase/README.md). The earlier Sites/D1 deployment and its records are retained separately; see [legacy hosted accounts](docs/HOSTED-ACCOUNTS.md).

## Reproduce the evidence

From the repository root, run the browser, model-parity and account-adapter tests:

```sh
npm test
```

The Firebase ownership and account-lifecycle suite runs against local emulators with disposable identities; it needs Java 21+ and the isolated test dependencies. See [Firebase setup and test commands](firebase/README.md). No cloud credentials are required for the emulator suite.

In a Python 3.12 virtual environment, install the backend and run the tests. PostgreSQL and Redis integration cases require the service settings described in the deployment guide and CI workflow.

```sh
python -m pip install -e "./backend[test]"
python -m pytest backend/tests -q
```

To reproduce the model comparison, run these commands **from the repository root** using the same environment. The evaluator verifies the input file hashes, split membership and checkpoint hash against the training manifest.

```sh
python -m app.ml.synth_dataset --output work/review-midi --count 12 --seed 37
python -m app.ml.evaluate --data work/review-midi --checkpoint model-demo/synthetic-demo.pt --manifest model-demo/synthetic-demo.json --output work/evaluation.json
```

## Release scope

The browser studio and the Python service have separate storage and deployment paths. The demo corpus comprises **12 original synthetic exercises**, with 10 used for training and two for validation. Checks establish inference parity and correct MIDI timing. Musical quality on human performances remains unevaluated. [Model notes](docs/MODEL.md) · [Baseline comparison](docs/EVALUATION.md)

The FastAPI service includes token verification, PostgreSQL RLS, Redis generation quotas, Turnstile checks, bounded inference workers and telemetry. Docker and CloudFormation files cover an HTTPS-only AWS deployment. Provisioning the cloud stack, connecting live identity and bot providers, running native Redis integration and approving a production model remain release steps. [Deployment guide](docs/DEPLOYMENT.md) · [Security model](docs/SECURITY.md) · [Verification record](docs/VALIDATION.md)
