"""Build the offline Auralis portfolio case study with Python's standard library."""

import argparse
import base64
import html
import json
import wave
from pathlib import Path
from string import Template


PROJECT = Path(__file__).resolve().parents[1]
MODEL = PROJECT / "model-demo"


def inline_asset(path, media_type):
    payload = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{media_type};base64,{payload}"


def evidence_paths(*paths):
    for path in paths:
        if not (PROJECT / path).is_file():
            raise FileNotFoundError(path)
    return " ".join(f"<code>{html.escape(path)}</code>" for path in paths)


def evaluation_table(report):
    """Read the evaluated models from the report written by app.ml.evaluate."""
    rows = "".join(
        f"<tr><th scope='row'>{html.escape(label)}</th>"
        f"<td>{report['scores'][key]['cross_entropy_nats_per_token']:.4f}</td>"
        f"<td>{report['scores'][key]['perplexity']:.2f}</td></tr>"
        for key, label in [
            ("unigram", "Token-frequency baseline"),
            ("bigram", "Previous-token baseline"),
            ("lstm", "Two-layer LSTM"),
        ]
    )
    return (
        "<table><caption>Prediction on held-out MIDI windows. Lower values are better.</caption>"
        "<thead><tr><th scope='col'>Model</th><th scope='col'>Loss¹</th>"
        "<th scope='col'>Perplexity</th></tr></thead>"
        f"<tbody>{rows}</tbody></table>"
        "<p class='small'>¹ Mean cross-entropy in natural-log units per next token. "
        f"All three models score the same {report['scores']['lstm']['predicted_tokens']} targets. "
        f"The baselines use additive smoothing with α = {report['smoothing']['alpha']:g}.</p>"
    )


STYLE = """
* {box-sizing:border-box}
:root {color-scheme:light;--paper:#f6f6ef;--ink:#16261f;--muted:#435b50;
  --line:#cbd6cb;--dark:#142921;--mint:#c0f3d6;--violet:#5a4670}
html {scroll-behavior:smooth} body {margin:0;background:var(--paper);color:var(--ink);
  font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main,nav,footer {width:min(1120px,calc(100% - 2.8rem));margin:auto}
nav {display:flex;gap:1.4rem;align-items:center;padding:1.25rem 0;border-bottom:1px solid var(--line)}
nav strong {margin-right:auto;letter-spacing:-.07em;font-size:1.55rem}
a {color:inherit;text-underline-offset:.22em} nav a {font-size:.85rem}
:focus-visible {outline:3px solid #9361c9;outline-offset:4px}
.top {display:grid;grid-template-columns:1.35fr 1fr;gap:3rem;align-items:end;padding:3.3rem 0 2rem}
.kicker,.no,.meta {font-size:.7rem;letter-spacing:.13em;font-weight:700;text-transform:uppercase}
.kicker {color:var(--muted);margin:0 0 .5rem} h1,h2,h3,p {margin:0}
h1,h2 {font-family:Georgia,"Times New Roman",serif;font-weight:400;line-height:1.06}
h1 {font-size:clamp(3.8rem,9vw,7.5rem);letter-spacing:-.075em}
h2 {font-size:clamp(2rem,4.5vw,3.5rem);letter-spacing:-.045em}
h3 {font-size:1.12rem;line-height:1.3;letter-spacing:-.012em}
.lead {font-size:clamp(1.05rem,1.8vw,1.3rem);color:var(--muted);max-width:40ch}
.audition {background:var(--dark);color:#f4fcf7;padding:2rem;border-radius:1rem;
  display:grid;grid-template-columns:1fr 1fr;gap:2rem;align-items:center}
.audition .kicker {color:var(--mint)} .audition h2 {font-size:2rem}
.audition p.details {color:#c6d9cc;font-size:.9rem;margin:.55rem 0 0}
.player {width:100%;min-width:0} audio {width:100%;display:block}
.playerlinks {display:flex;flex-wrap:wrap;gap:.6rem 1rem;align-items:center;
  justify-content:space-between;margin:1rem .2rem 0;font-size:.82rem}
.playerlinks a {color:var(--mint)} .facts {color:#c1d4c8}
.spread {display:grid;grid-template-columns:1fr 1fr;gap:3.25rem;margin:2.7rem 0}
.spread>div {align-self:center} .spread p {margin:.8rem 0;color:var(--muted)}
figure {margin:0} figure img {display:block;width:100%;height:auto;border-radius:.6rem;
  border:1px solid #345143} figcaption {font-size:.76rem;color:var(--muted);margin-top:.5rem}
.band {border-top:1px solid var(--line);padding:2.5rem 0} .band>h2 {margin-bottom:1.4rem}
.decision {display:grid;grid-template-columns:.74fr 1.55fr;gap:2rem;padding:1.65rem 0;
  border-top:1px solid var(--line)} .decision h3 {margin-top:.55rem}
.no {color:var(--violet)} .decision p+p {margin-top:.75rem}
.src {color:var(--muted);font-size:.79rem;line-height:1.7}
code {display:inline-block;font: .8rem/1.55 ui-monospace,Consolas,monospace;
  max-width:100%;overflow-wrap:anywhere;background:#e7eee4;padding:.11rem .35rem;border-radius:.25rem;
  margin:.12rem .1rem .12rem 0}
table {border-collapse:collapse;width:100%;margin:1.15rem 0 .6rem;font-variant-numeric:tabular-nums}
caption {text-align:left;font-size:.82rem;margin-bottom:.5rem;color:var(--muted)}
th,td {padding:.52rem .62rem;border-bottom:1px solid var(--line);text-align:right}
th:first-child,td:first-child {text-align:left} thead th {font-size:.75rem;color:var(--muted)}
tbody th {font-weight:500} .small {font-size:.8rem;color:var(--muted)}
.scope {padding:1.5rem;border-left:3px solid #877297;background:#eeeaf0}
.scope h3 {color:var(--violet);margin-bottom:.5rem}.scope p {max-width:83ch}
footer {border-top:1px solid var(--line);display:flex;justify-content:space-between;gap:1rem;
  font-size:.78rem;color:var(--muted);padding:1.5rem 0 2.5rem}
@media(max-width:720px){.top,.spread,.audition,.decision{grid-template-columns:1fr;gap:1.1rem}
  main,nav,footer{width:min(100% - 1.75rem,1120px)} .top{padding:2rem 0 1.5rem}
  nav{gap:.75rem}.audition{padding:1.35rem}.spread{margin:1.8rem 0}.decision{padding:1.25rem 0}
  table{font-size:.85rem}th,td{padding:.4rem}.band{padding:1.8rem 0}footer{display:block}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
@media print{body{background:white}.audition{color:#15281f;background:#edf3ed}
  nav a,.player,footer a{display:none}.band,.decision,figure{break-inside:avoid}
  .audition .kicker,.audition p.details{color:#364e41}}
"""


PAGE = Template("""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; media-src data:; object-src 'none'; base-uri 'none'; form-action 'none'">
<title>Auralis | Engineering case study</title><style>$style</style></head>
<body><nav aria-label="Case study sections"><strong>auralis</strong>
<a href="#listen">Listen</a><a href="#engineering">Engineering</a><a href="#release">Release</a></nav>
<main><header class="top"><div><p class="kicker">Engineering case study / Applied ML &amp; full stack</p>
<h1>Auralis</h1></div><p class="lead">A small recurrent model turns four chords into a MIDI melody.
The studio runs the model on the listener’s device and animates particles from the generated sound.</p></header>
<section id="listen" class="audition" aria-labelledby="sample-title"><div>
<p class="kicker">Listen / PyTorch checkpoint sample</p><h2 id="sample-title">A four-chord study</h2>
<p class="details">Am → F → C → G · 96 BPM · Temperature 0.85<br>
This piano rendering follows the note times, pitches and velocities in the downloadable MIDI.</p>
</div><div class="player"><audio controls preload="metadata" aria-label="Play the forty-second LSTM sample" src="$wav">Your browser cannot play embedded WAV audio.</audio>
<div class="playerlinks"><span class="facts">16 bars · $seconds seconds · 109 notes</span>
<a download="auralis-lstm-16-bars.mid" href="$midi">Download MIDI ↓</a></div></div></section>
<div class="spread"><figure><img src="$screen" alt="Auralis studio showing a mint and violet particle cloud, chord controls and a composition player">
<figcaption>The studio pairs each composition with a Three.js particle scene.</figcaption></figure>
<div><p class="kicker">The interaction</p><h2>From seed to sound</h2>
<p>The composer turns a seed progression into a phrase and samples the next token from the model.
Temperature changes that sampling distribution. The result fills exactly 16 or 32 bars of 4/4.</p>
<p>During generation the particle orb opens into a spiral. Editing draws it into a brain shape.
During playback, a Web Audio analyser measures bass and treble to drive the motion.</p>
<p class="src">$web_sources</p></div></div>
<section id="engineering" class="band" aria-labelledby="engineering-title"><p class="kicker">Implementation &amp; evidence</p><h2 id="engineering-title">Three engineering decisions</h2>
<article class="decision"><header><span class="no">01 / Applied ML</span><h3>Split the songs before making windows</h3></header>
<div><p>Music21 extracts the upper voice on a sixteenth-note grid. A vocabulary of 39 tokens
represents pitches, rests and holds. Ten synthetic MIDI files supply training examples, and two whole files are held out. Windows from a single song stay in one split.</p>
$evaluation
<p>The previous-token baseline achieved the lowest loss on these exercises. The LSTM’s best epoch was selected on this same two-file validation split. A comparison on independent recordings and a listening study would be needed to assess musical quality.</p>
<p class="src">$model_sources</p></div></article>
<article class="decision"><header><span class="no">02 / ML systems</span><h3>Check the browser implementation against PyTorch</h3></header>
<div><p>The browser loads the public synthetic weights into a Web Worker. The UI stays interactive during sampling, and no composition request needs a model server.</p>
<p>The parity test compares all 39 next-token scores at five successive points in one seeded sequence. The largest absolute difference across 195 scores was 2.39 × 10<sup>−7</sup>. Separate checks verify both supported track lengths.</p>
<p class="src">$parity_sources</p></div></article>
<article class="decision"><header><span class="no">03 / Backend systems</span><h3>Bind the user to the database transaction</h3></header>
<div><p>The separate FastAPI service verifies OIDC access tokens, sets the subject in the current PostgreSQL transaction and applies forced row-level security to metadata and MIDI bytes. Every track query also filters by that owner.</p>
<p>On PostgreSQL 17.11, a second user could neither retrieve the first user’s MIDI nor alter or delete the record. A one-connection pool test checked that identity cleared after both commit and rollback.</p>
<p class="src">$security_sources</p></div></article></section>
<section id="release" class="band"><div class="scope"><h3>Release scope</h3>
<p>The public studio runs inference on the visitor’s device. ChatGPT sign-in and an explicit Auralis profile enable a private D1 library; guests keep local browser history. The downloadable studio remains offline and device-local.
The separate Python service includes Redis quotas, Turnstile checks, telemetry and an AWS ECS template. AWS provisioning, native Redis integration, an independent security review and production model evaluation remain release work.</p></div>
<p class="small" style="margin-top:1rem">The ZIP contains the studio launcher, source files and test commands in <code>auralis/README.md</code>. The paths above are relative to that directory.</p></section>
</main><footer><span>Auralis · Engineering case study</span><span>Audio, MIDI and screenshot are included in this file.</span></footer></body></html>""")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=PROJECT.parent / "Auralis-case-study.html")
    parser.add_argument("--screenshot", type=Path, default=PROJECT / "docs/assets/studio.png")
    args = parser.parse_args()
    manifest = json.loads((MODEL / "synthetic-demo.json").read_text(encoding="utf-8"))
    report_path = MODEL / "evaluation.json"
    report = json.loads(report_path.read_text(encoding="utf-8"))
    if report["checkpoint_sha256"] != manifest["checkpoint_sha256"]:
        raise ValueError("The evaluation and training records refer to different checkpoints.")
    sample = MODEL / "lstm-demo-16-bars.wav"
    with wave.open(str(sample), "rb") as audio:
        seconds = audio.getnframes() / audio.getframerate()
    source_paths = ["backend/app/ml/evaluate.py", "model-demo/evaluation.json"]
    page = PAGE.substitute(
        style=STYLE, seconds=f"{seconds:g}", wav=inline_asset(sample, "audio/wav"),
        midi=inline_asset(MODEL / "lstm-demo-16-bars.mid", "audio/midi"),
        screen=inline_asset(args.screenshot, "image/png"),
        evaluation=evaluation_table(report),
        model_sources=evidence_paths(*source_paths),
        web_sources=evidence_paths("web/visualizer.js", "web/music.js"),
        parity_sources=evidence_paths("web/neural-worker.js", "web/tests/neural.test.mjs"),
        security_sources=evidence_paths("infra/postgres/schema.sql", "infra/tests/rls_probe.py", "backend/tests/test_database.py"),
    )
    args.output.write_text(page, encoding="utf-8")
    print(f"Wrote {args.output.name} ({args.output.stat().st_size:,} bytes).")


if __name__ == "__main__":
    main()
