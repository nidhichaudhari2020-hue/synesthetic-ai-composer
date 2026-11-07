# Held-out next-token evaluation

The first-order bigram gave the lowest loss on the two held-out synthetic MIDI files. Both count models predicted the held-out tokens better than the bundled six-epoch LSTM. The LSTM’s cross-entropy was 0.4451 nats per token higher than the bigram’s. [Machine-readable scores](../model-demo/evaluation.json)

| Model | Predicted tokens | Cross-entropy, nats/token ↓ | Perplexity ↓ |
| --- | ---: | ---: | ---: |
| Add-one bigram | 384 | 2.10153 | 8.17867 |
| Add-one unigram | 384 | 2.45575 | 11.65512 |
| Saved LSTM | 384 | 2.54667 | 12.76456 |

## What was scored

All three models predicted the same next token at each position in six 64-step windows. For each model, cross-entropy is the mean negative natural logarithm of the probability assigned to the observed next token. Perplexity is the exponential of that mean. The LSTM received the observed preceding tokens, used raw logits at temperature 1, and started each window with zero recurrent state.

The count models learned from the same 1,920 transitions in the 30 windows used to train the LSTM. The unigram estimates each target token’s frequency across training windows. The bigram estimates it after a particular preceding token. Each model adds a fixed pseudocount of one to every possible target in the 39-token vocabulary. Each score uses all 384 validation positions, including targets or contexts missing from the training counts.

## Reproduction

Run these commands from `backend/` in the project’s Python environment. The training manifest records PyTorch 2.9.1, music21 9.9.1, and NumPy 2.5.4. The output path below is a comparison copy. [Training manifest](../model-demo/synthetic-demo.json)

```sh
python -m app.ml.synth_dataset --output /tmp/auralis-eval-midi --count 12 --seed 37
python -m app.ml.evaluate --data /tmp/auralis-eval-midi --checkpoint ../model-demo/synthetic-demo.pt --manifest ../model-demo/synthetic-demo.json --output /tmp/auralis-evaluation.json
```

The evaluator verifies the checkpoint SHA-256, replays the split with seed 42, and checks file names and SHA-256 digests against the manifest. It reruns the training tokenizer and window function and checks the window counts. The ten training files and two validation files matched. Validation contained `synthetic-0007.mid` and `synthetic-0005.mid`. The measured LSTM loss reproduced the recorded best-epoch loss within 0.00000035 nats per token.

## Interpretation

These exercises come from one procedural generator. Its short-range regularities include note onsets followed by holds, a pattern a bigram can represent directly. The validation files also selected the checkpoint epoch during training, so this comparison uses validation data rather than an independent final test. Musical quality, originality, and generalization to human performances remain unevaluated.
