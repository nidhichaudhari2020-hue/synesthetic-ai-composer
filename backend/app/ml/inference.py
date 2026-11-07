"""Inference uses only a trusted, operator-provisioned checkpoint; no fallback."""
from __future__ import annotations

import math
import pickle
import secrets
from pathlib import Path
from typing import Mapping

from .tokenizer import (HOLD, REST, STEPS_PER_BAR, VERSION, VOCAB_SIZE,
                        notes_to_midi, pitch_token, tokens_to_notes)

ROOTS = {"C": 0, "C#": 1, "D": 2, "D#": 3, "E": 4, "F": 5,
         "F#": 6, "G": 7, "G#": 8, "A": 9, "A#": 10, "B": 11,
         "Db": 1, "Eb": 3, "Gb": 6, "Ab": 8, "Bb": 10}
INTERVALS = {"": (0, 4, 7, 4), "m": (0, 3, 7, 3), "7": (0, 4, 7, 10),
             "maj7": (0, 4, 7, 11), "m7": (0, 3, 7, 10)}
CHORDS = {name + suffix: (root, intervals)
          for name, root in ROOTS.items() for suffix, intervals in INTERVALS.items()}
PROGRAMS = {"piano": 0, "strings": 48, "synth": 89}


class ModelUnavailableError(RuntimeError):
    """Operator must provision or repair the model artifact."""


def validate_config(config) -> dict:
    if hasattr(config, "model_dump"):
        config = config.model_dump()
    if not isinstance(config, Mapping):
        raise ValueError("Expected a generation configuration.")
    bars, tempo, temperature = config.get("bars"), config.get("tempo"), config.get("temperature")
    chords, instrument = config.get("seed_chords"), config.get("instrument")
    if type(bars) is not int or bars not in (16, 32):
        raise ValueError("Choose 16 or 32 bars.")
    if type(tempo) is not int or not 40 <= tempo <= 200:
        raise ValueError("Tempo must be an integer between 40 and 200 BPM.")
    if isinstance(temperature, bool) or not isinstance(temperature, (int, float)) or not math.isfinite(temperature) or not 0.2 <= temperature <= 1.5:
        raise ValueError("Temperature must be finite and between 0.2 and 1.5.")
    if not isinstance(chords, list) or not 1 <= len(chords) <= 8 or any(not isinstance(c, str) or c not in CHORDS for c in chords):
        raise ValueError("Supply one to eight supported major or minor chords.")
    if not isinstance(instrument, str) or instrument not in PROGRAMS:
        raise ValueError("Unsupported instrument.")
    allow_synthetic_demo = config.get("allow_synthetic_demo", False)
    if type(allow_synthetic_demo) is not bool:
        raise ValueError("Invalid internal model configuration.")
    return {"bars": bars, "tempo": tempo, "temperature": float(temperature),
            "seed_chords": chords, "instrument": instrument,
            "allow_synthetic_demo": allow_synthetic_demo}


def seed_tokens(chords: list[str]) -> list[int]:
    tokens = []
    for name in chords:
        root, intervals = CHORDS[name]
        for interval in intervals:
            tokens.extend([pitch_token(60 + root + interval), HOLD])
    return tokens


def _load_model(path: Path):
    if not path.is_file() or not 1 <= path.stat().st_size <= 32 * 1024**2:
        raise ModelUnavailableError("A trusted trained checkpoint is not provisioned.")
    try:
        import torch
        from .model import MelodyLSTM
        checkpoint = torch.load(path, map_location="cpu", weights_only=True)
        if not isinstance(checkpoint, dict):
            raise ValueError("Expected a model checkpoint mapping.")
        if checkpoint.get("tokenizer") != VERSION or checkpoint.get("vocab_size") != VOCAB_SIZE:
            raise ValueError("Incompatible token vocabulary.")
        architecture = checkpoint["architecture"]
        if set(architecture) != {"embedding_dim", "hidden_dim", "layers"}:
            raise ValueError("Invalid model architecture.")
        if any(type(architecture[key]) is not int or not 1 <= architecture[key] <= ceiling
               for key, ceiling in (("embedding_dim", 128), ("hidden_dim", 256), ("layers", 3))):
            raise ValueError("Model architecture exceeds inference limits.")
        model = MelodyLSTM(**architecture)
        model.load_state_dict(checkpoint["state_dict"], strict=True)
        model.eval()
        if any(not torch.isfinite(parameter).all() for parameter in model.parameters()):
            raise ValueError("Non-finite checkpoint parameters.")
        model_name = "lstm-synthetic-demo" if checkpoint.get("synthetic_demo") else "lstm-trained"
        return model, model_name
    except (ImportError, OSError, RuntimeError, ValueError, KeyError, TypeError,
            AttributeError, EOFError, pickle.UnpicklingError) as error:
        raise ModelUnavailableError("Model checkpoint could not be loaded.") from error


def generate_track(config, checkpoint_path: str | Path) -> dict:
    settings = validate_config(config)
    model, model_name = _load_model(Path(checkpoint_path))
    if model_name == "lstm-synthetic-demo" and not settings["allow_synthetic_demo"]:
        raise ModelUnavailableError("Synthetic smoke checkpoints are disabled for this deployment.")
    import torch
    torch.set_num_threads(1)
    generator = torch.Generator(device="cpu").manual_seed(secrets.randbits(63))
    context = seed_tokens(settings["seed_chords"])
    result: list[int] = []
    has_active = False
    with torch.inference_mode():
        logits, state = model(torch.tensor([context], dtype=torch.long))
        for _ in range(settings["bars"] * STEPS_PER_BAR):
            scores = logits[0, -1].clone() / settings["temperature"]
            if not has_active:
                scores[HOLD] = float("-inf")
            probabilities = torch.softmax(scores, dim=-1)
            if not torch.isfinite(probabilities).all() or probabilities.sum() <= 0:
                raise ModelUnavailableError("Model produced invalid probabilities.")
            token = int(torch.multinomial(probabilities, 1, generator=generator).item())
            result.append(token)
            has_active = token >= 2 or (token == HOLD and has_active)
            logits, state = model(torch.tensor([[token]], dtype=torch.long), state)
    notes = tokens_to_notes(result, settings["tempo"])
    midi = notes_to_midi(notes, settings["bars"], settings["tempo"], PROGRAMS[settings["instrument"]])
    return {"midi": midi, "notes": notes,
            "duration": settings["bars"] * 4 * 60 / settings["tempo"], "model": model_name}
