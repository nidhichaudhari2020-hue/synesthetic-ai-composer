"""python -m app.ml.train --data ./dataset --output ./models/melody.pt"""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import math
import random
from pathlib import Path

from .tokenizer import VERSION, VOCAB_SIZE, tokenize_midi


def split_files(paths: list[Path], seed: int = 42) -> tuple[list[Path], list[Path]]:
    """Split whole unique MIDI contents, never overlapping windows of one song."""
    if len(paths) > 10_000:
        raise ValueError("Dataset exceeds the 10,000-file training limit.")
    seen, unique = set(), []
    for path in sorted(paths):
        if path.stat().st_size > 1_048_576:
            raise ValueError(f"Oversized MIDI: {path.name}")
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest not in seen:
            seen.add(digest)
            unique.append(path)
    if len(unique) < 3:
        raise ValueError("At least three distinct MIDI files are needed for a held-out split.")
    random.Random(seed).shuffle(unique)
    holdout = max(1, round(len(unique) * 0.2))
    return unique[holdout:], unique[:holdout]


def windows(sequences: list[list[int]], length: int):
    for sequence in sequences:
        for start in range(0, len(sequence) - length, length):
            yield sequence[start:start + length], sequence[start + 1:start + length + 1]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--epochs", type=int, default=20)
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--sequence-length", type=int, default=64)
    parser.add_argument("--hidden-dim", type=int, default=128)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--synthetic-demo", action="store_true", help="Label an explicitly synthetic training run.")
    args = parser.parse_args()
    if not 1 <= args.epochs <= 200 or not 1 <= args.batch_size <= 256 or not 8 <= args.sequence_length <= 256 or not 16 <= args.hidden_dim <= 256:
        parser.error("Training parameters exceed documented bounds.")
    dataset_manifest = args.data / "DATASET.json"
    if dataset_manifest.is_file() and dataset_manifest.stat().st_size < 16_384:
        provenance = json.loads(dataset_manifest.read_text(encoding="utf-8"))
        if provenance.get("kind") == "original-algorithmic-smoke-data":
            args.synthetic_demo = True
    import torch
    from torch import nn
    from torch.utils.data import DataLoader, TensorDataset
    from .model import MelodyLSTM
    torch.manual_seed(args.seed)
    random.seed(args.seed)
    torch.set_num_threads(2)
    torch.use_deterministic_algorithms(True)
    paths = list(args.data.glob("*.mid")) + list(args.data.glob("*.midi"))
    train_paths, valid_paths = split_files(paths, args.seed)
    def make_dataset(selected):
        pairs = list(windows([tokenize_midi(path) for path in selected], args.sequence_length))
        if not pairs:
            raise ValueError("MIDI sequences must exceed the sequence length in both splits.")
        return TensorDataset(torch.tensor([x for x, _ in pairs], dtype=torch.long),
                             torch.tensor([y for _, y in pairs], dtype=torch.long))
    train_data, valid_data = make_dataset(train_paths), make_dataset(valid_paths)
    train_loader = DataLoader(train_data, batch_size=args.batch_size, shuffle=True,
                              generator=torch.Generator().manual_seed(args.seed))
    valid_loader = DataLoader(valid_data, batch_size=args.batch_size)
    model = MelodyLSTM(hidden_dim=args.hidden_dim)
    optimizer = torch.optim.AdamW(model.parameters(), lr=0.002, weight_decay=0.01)
    criterion = nn.CrossEntropyLoss()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    best, history = float("inf"), []
    for epoch in range(args.epochs):
        model.train()
        train_loss, count = 0.0, 0
        for x, y in train_loader:
            optimizer.zero_grad(set_to_none=True)
            logits, _ = model(x)
            loss = criterion(logits.reshape(-1, VOCAB_SIZE), y.reshape(-1))
            if not torch.isfinite(loss):
                raise RuntimeError("Non-finite training loss.")
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            train_loss += loss.item() * y.numel()
            count += y.numel()
        model.eval()
        validation_loss, validation_count = 0.0, 0
        with torch.inference_mode():
            for x, y in valid_loader:
                logits, _ = model(x)
                loss = criterion(logits.reshape(-1, VOCAB_SIZE), y.reshape(-1))
                validation_loss += loss.item() * y.numel()
                validation_count += y.numel()
        validation_loss /= validation_count
        row = {"epoch": epoch + 1, "train_cross_entropy": train_loss / count,
               "validation_cross_entropy": validation_loss,
               "validation_perplexity": math.exp(min(validation_loss, 20))}
        history.append(row)
        print(json.dumps(row), flush=True)
        if validation_loss < best:
            best = validation_loss
            torch.save({"state_dict": model.state_dict(), "architecture": model.architecture,
                        "tokenizer": VERSION, "vocab_size": VOCAB_SIZE,
                        "synthetic_demo": args.synthetic_demo, "seed": args.seed,
                        "best_epoch": epoch + 1, "validation_cross_entropy": best}, args.output)
    manifest = {"tokenizer": VERSION, "synthetic_demo": args.synthetic_demo,
                "seed": args.seed, "sequence_length": args.sequence_length,
                "architecture": model.architecture, "train_examples": len(train_data),
                "validation_examples": len(valid_data),
                "runtime": {name: importlib.metadata.version(name) for name in ("torch", "music21", "numpy")},
                "train_files": [{"name": p.name, "sha256": hashlib.sha256(p.read_bytes()).hexdigest()} for p in train_paths],
                "validation_files": [{"name": p.name, "sha256": hashlib.sha256(p.read_bytes()).hexdigest()} for p in valid_paths],
                "history": history, "checkpoint_sha256": hashlib.sha256(args.output.read_bytes()).hexdigest()}
    args.output.with_suffix(".json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
