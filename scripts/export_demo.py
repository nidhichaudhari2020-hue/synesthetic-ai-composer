"""Export the explicitly synthetic smoke checkpoint and a PyTorch parity vector.

Install the backend dependencies, then run python scripts/export_demo.py from
the repository root. The browser export contains only the public demo model.
"""
import base64
import hashlib
import json
import sys
from pathlib import Path

import torch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from app.ml.inference import _load_model, seed_tokens  # noqa: E402
from app.ml.tokenizer import VERSION, VOCAB_SIZE  # noqa: E402


def main():
    path = ROOT / "model-demo" / "synthetic-demo.pt"
    manifest = json.loads(path.with_suffix(".json").read_text(encoding="utf-8"))
    checksum = hashlib.sha256(path.read_bytes()).hexdigest()
    if manifest.get("synthetic_demo") is not True or manifest.get("checkpoint_sha256") != checksum:
        raise ValueError("The demo checkpoint must match a verified synthetic training manifest.")
    model, name = _load_model(path)
    if name != "lstm-synthetic-demo":
        raise ValueError("Only the explicitly synthetic demo can be exported to public assets.")
    torch.set_num_threads(1)
    tensors = {}
    for key, tensor in model.state_dict().items():
        array = tensor.detach().cpu().contiguous().numpy().astype("<f4", copy=False)
        tensors[key] = base64.b64encode(array.tobytes()).decode("ascii")
    chords = ["Am", "F", "C", "G"]
    context = seed_tokens(chords)
    continuation = [16, 1, 0, 23]
    with torch.inference_mode():
        logits, state = model(torch.tensor([context], dtype=torch.long))
        expected = [logits[0, -1].tolist()]
        for token in continuation:
            logits, state = model(torch.tensor([[token]], dtype=torch.long), state)
            expected.append(logits[0, -1].tolist())
    asset = {
        "format": "auralis-lstm-f32le-v1", "model": name, "tokenizer": VERSION,
        "vocabSize": VOCAB_SIZE, "architecture": model.architecture,
        "checkpointSha256": checksum, "tensors": tensors,
        "parity": {"chords": chords, "context": context, "continuation": continuation, "logits": expected},
    }
    output = ROOT / "web" / "demo-weights.json"
    temporary = output.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(asset, separators=(",", ":"), allow_nan=False) + "\n", encoding="utf-8")
    temporary.replace(output)
    print(f"Exported {output.stat().st_size:,} bytes from {name}, SHA-256 {checksum}")


if __name__ == "__main__":
    main()
