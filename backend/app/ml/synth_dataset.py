"""Generate original algorithmic MIDI exercises for smoke training, not quality claims."""
import argparse
import json
import random
from pathlib import Path

from .tokenizer import HOLD, REST, notes_to_midi, pitch_token, tokens_to_notes


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--count", type=int, default=24)
    parser.add_argument("--seed", type=int, default=37)
    args = parser.parse_args()
    if not 3 <= args.count <= 1000:
        parser.error("count must be between 3 and 1000")
    args.output.mkdir(parents=True, exist_ok=True)
    rng = random.Random(args.seed)
    for index in range(args.count):
        tokens = []
        root = rng.choice([48, 50, 52, 53, 55, 57])
        for bar in range(16):
            chord = [root, root + 3, root + 7, root + 10] if index % 2 else [root, root + 4, root + 7, root + 11]
            for step in range(16):
                if step % 2:
                    token = HOLD if tokens[-1] != REST else REST
                elif rng.random() < 0.12:
                    token = REST
                else:
                    pitch = rng.choice(chord) + (12 if (bar + step) % 3 else 0)
                    token = pitch_token(pitch)
                tokens.append(token)
        notes = tokens_to_notes(tokens, 96)
        (args.output / f"synthetic-{index:04}.mid").write_bytes(notes_to_midi(notes, 16, 96))
    (args.output / "DATASET.json").write_text(json.dumps({"kind": "original-algorithmic-smoke-data",
        "seed": args.seed, "files": args.count, "limitations": "Not a human-performance corpus; not suitable for production quality evaluation."}, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
