# Music engine

Auralis trains a PyTorch LSTM offline and samples new MIDI melodies from its learned weights. The browser demo runs the trained synthetic model in a JavaScript worker on the visitor's device. Its featured 40-second piece comes from that checkpoint. A round-trip test verifies that the browser score encodes to the exact checked-in MIDI bytes. The Python API loads the operator's approved checkpoint for authenticated generation.

## What the model learns

`music21` converts a local Standard MIDI File into an upper melodic voice on a sixteenth-note grid. Its 39 integer tokens represent rest, hold, and MIDI pitches 48 through 84. The tokenizer preserves notes tied across barlines, takes the highest note at a chord onset, and folds pitches by octaves into range. The representation retains one quantized voice and discards expressive timing, pedal, percussion, and additional voices. A major, minor, or seventh seed progression becomes an arpeggiated context phrase for the LSTM. Generated notes can depart from that harmony.

Inference samples from `softmax(logits / temperature)` with temperature between 0.2 and 1.5. The model emits 256 or 512 grid steps in 4/4. The MIDI writer encodes tempo, instrument program, meter, note-on and note-off events, and an end-of-track event at the selected bar count. The API supplies note timings in seconds for playback.

## Train on a licensed corpus

Run the following from `backend/`. Place flat `.mid` or `.midi` files in your selected data directory.

```sh
python -m pip install -e '.[test]'
python -m app.ml.train --data /licensed-midi --output /models/composer.pt --epochs 20
```

The trainer removes byte-identical duplicates, shuffles whole files using a recorded seed, and assigns about 20 percent to validation. It then creates sequence windows within each file. Training uses an embedding, two LSTM layers, AdamW, categorical cross-entropy, and gradient clipping on CPU. The saved checkpoint comes from the lowest held-out loss. Its JSON sidecar records file hashes, split membership, architecture, runtime versions, seed, per-epoch losses, validation perplexity, and checkpoint hash.

Group arrangements and alternate encodings of the same piece before preparing the corpus. Their hashes can differ even when their musical content matches. Training keeps its sequence tensors in memory, so larger collections need independent preprocessing and sharding.

## Included synthetic model

The included [checkpoint](../model-demo/synthetic-demo.pt) was trained on 12 original algorithmic MIDI exercises. Ten training files yielded 30 sequence windows and two validation files yielded six. Training used a 64-dimensional embedding, two LSTM layers with 32 hidden units, and six epochs. Held-out categorical cross-entropy fell from 3.5348 to 2.5467, with perplexity 12.7646 at epoch six. These numbers describe the synthetic exercises. The complete run is recorded in the [training manifest](../model-demo/synthetic-demo.json).

Recreate the exercise corpus and training run from `backend/` with the following commands. The recorded runtime used PyTorch 2.9.1, music21 9.9.1, and NumPy 2.5.4.

```sh
python -m app.ml.synth_dataset --output /tmp/auralis-smoke --count 12 --seed 37
python -m app.ml.train --data /tmp/auralis-smoke --output /models/synthetic-demo.pt --epochs 6 --hidden-dim 32 --batch-size 8 --seed 42 --synthetic-demo
python -m pytest tests/test_ml.py -q
```

The [example MIDI](../model-demo/lstm-demo-16-bars.mid) was sampled from this checkpoint at temperature 0.85 with the Am, F, C, G progression and piano program. Independent music21 event parsing found 109 note-ons, 109 note-offs, and an end-of-track event at tick 30,720. At 480 ticks per quarter and 96 BPM, the result is exactly 16 bars and 40 seconds.

The [WAV audition](../model-demo/lstm-demo-16-bars.wav) renders those same 109 MIDI notes with their original note times, pitches, and velocities using a damped piano-like synthesizer. It contains 40 seconds of 44.1 kHz, 16-bit mono PCM. Its measured peak is 28,835 on the 32,767-point positive PCM scale.

The browser export of the same checkpoint occupies 136,735 bytes. Its parity test compared 195 JavaScript logits with PyTorch values at the end of the seed context and after four continuation steps. The maximum absolute difference was 0.000000239. Both 16-bar and 32-bar duration and grid checks passed. Sampling uses fresh randomness, so two generations can differ despite matching logits.

The Python runtime rejects synthetic checkpoints by default. Its internal development setting enables this model explicitly and every result carries `lstm-synthetic-demo`. The public request schema accepts only the composer's musical controls and challenge token. The production runtime requires its own approved checkpoint. Before promoting a model, assess listening quality, corpus rights, similarity to training sequences, and latency under target load.

## Parser and checkpoint boundaries

MIDI input first passes binary framing checks with limits of 1 MiB, 16 tracks, 50,000 events, and 4,096 quantized steps. Meta and system events have payload caps. Music21 then parses the validated bytes in a separate process with a 25-second timeout. On Linux that process also has a 1 GiB address-space limit and a 20-second CPU limit. Corpus ingestion is an offline operation with a local path supplied by the operator.

The Python service reads a trusted local model artifact of at most 32 MiB using `torch.load(..., weights_only=True)`. It checks the vocabulary, architecture bounds, parameter shapes, and finite parameter values. Deploy operators should verify the sidecar hash and mount the approved artifact read-only. The browser export contains only synthetic model parameters and reference logits intended for distribution.

See the [music21 MIDI translation reference](https://music21.org/music21docs/moduleReference/moduleMidiTranslate.html) and [PyTorch checkpoint guide](https://docs.pytorch.org/tutorials/beginner/saving_loading_models).
