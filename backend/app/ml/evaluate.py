"""Reproduce validation loss and compare the saved LSTM with two count models."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from collections import Counter
from pathlib import Path

from .inference import _load_model
from .tokenizer import VERSION, VOCAB_SIZE, tokenize_midi
from .train import split_files, windows


def sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def verify_split(data: Path, manifest: dict):
    paths = list(data.glob("*.mid")) + list(data.glob("*.midi"))
    groups = split_files(paths, manifest["seed"])
    for expected, actual in zip(("train_files", "validation_files"), groups):
        records = [{"name": path.name, "sha256": sha256(path)} for path in actual]
        if records != manifest[expected]:
            raise ValueError(f"File hash or split mismatch in {expected}.")
    return groups


def metrics(negative_log_likelihood: float, count: int) -> dict:
    if count <= 0 or not math.isfinite(negative_log_likelihood):
        raise ValueError("An evaluation requires finite scores on at least one token.")
    mean = negative_log_likelihood / count
    return {"cross_entropy_nats_per_token": mean, "perplexity": math.exp(mean),
            "predicted_tokens": count}


def baseline_scores(train_pairs, validation_pairs) -> dict:
    """Fit only training transitions. Add one pseudocount to every token class."""
    targets, contexts, transitions = Counter(), Counter(), Counter()
    for inputs, labels in train_pairs:
        targets.update(labels)
        contexts.update(inputs)
        transitions.update(zip(inputs, labels, strict=True))
    unigram_denominator = targets.total() + VOCAB_SIZE
    unigram_loss = bigram_loss = 0.0
    count = 0
    for inputs, labels in validation_pairs:
        for previous, target in zip(inputs, labels, strict=True):
            unigram_probability = (targets[target] + 1) / unigram_denominator
            bigram_probability = (transitions[previous, target] + 1) / (contexts[previous] + VOCAB_SIZE)
            unigram_loss -= math.log(unigram_probability)
            bigram_loss -= math.log(bigram_probability)
            count += 1
    return {"unigram": metrics(unigram_loss, count), "bigram": metrics(bigram_loss, count)}


def evaluate(data: Path, checkpoint: Path, manifest_path: Path) -> dict:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest["tokenizer"] != VERSION:
        raise ValueError("Training and evaluation tokenizer versions differ.")
    if checkpoint.stat().st_size > 32 * 1024**2 or sha256(checkpoint) != manifest["checkpoint_sha256"]:
        raise ValueError("Checkpoint size or SHA-256 does not match the training artifact.")
    train_files, validation_files = verify_split(data, manifest)
    length = manifest["sequence_length"]
    if type(length) is not int or not 8 <= length <= 256:
        raise ValueError("Manifest has an unsupported sequence length.")
    train_pairs = list(windows([tokenize_midi(path) for path in train_files], length))
    valid_pairs = list(windows([tokenize_midi(path) for path in validation_files], length))
    if (len(train_pairs), len(valid_pairs)) != (manifest["train_examples"], manifest["validation_examples"]):
        raise ValueError("Tokenization did not reproduce the training window counts.")
    scores = baseline_scores(train_pairs, valid_pairs)

    import torch
    from torch.nn import functional as F
    torch.set_num_threads(2)
    torch.use_deterministic_algorithms(True)
    model, model_name = _load_model(checkpoint)
    loss_sum = 0.0
    count = 0
    with torch.inference_mode():
        # Each batch entry starts with zero state, exactly as in training validation.
        for start in range(0, len(valid_pairs), 32):
            batch = valid_pairs[start:start + 32]
            inputs = torch.tensor([x for x, _ in batch], dtype=torch.long)
            labels = torch.tensor([y for _, y in batch], dtype=torch.long)
            logits, _ = model(inputs)
            loss_sum += F.cross_entropy(logits.reshape(-1, VOCAB_SIZE).double(), labels.flatten(),
                                        reduction="sum").item()
            count += labels.numel()
    scores["lstm"] = metrics(loss_sum, count)
    recorded = min(row["validation_cross_entropy"] for row in manifest["history"])
    if not math.isclose(scores["lstm"]["cross_entropy_nats_per_token"], recorded, abs_tol=1e-5):
        raise ValueError("Validation loss does not reproduce the recorded best checkpoint.")
    return {"model": model_name, "checkpoint_sha256": manifest["checkpoint_sha256"],
            "manifest_sha256": sha256(manifest_path), "tokenizer": VERSION, "vocab_size": VOCAB_SIZE,
            "split_seed": manifest["seed"], "sequence_length": length,
            "train_files": len(train_files), "validation_files": len(validation_files),
            "train_windows": len(train_pairs), "validation_windows": len(valid_pairs),
            "train_transitions": sum(len(y) for _, y in train_pairs),
            "validation_filenames": [p.name for p in validation_files],
            "smoothing": {"method": "additive", "alpha": 1.0},
            "scoring": "teacher-forced next-token probabilities on identical validation windows",
            "recorded_best_validation_cross_entropy": recorded, "scores": scores,
            "limitations": ["Synthetic exercises from one generator.",
                            "Two validation files, also used to select the best epoch.",
                            "Token loss does not measure musical quality or originality."]}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    for option in ("data", "checkpoint", "manifest", "output"):
        parser.add_argument(f"--{option}", type=Path, required=True)
    args = parser.parse_args()
    result = evaluate(args.data, args.checkpoint, args.manifest)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result["scores"], indent=2))


if __name__ == "__main__":
    main()
