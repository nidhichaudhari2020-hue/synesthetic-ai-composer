import struct
from pathlib import Path

import pytest

from app.ml.inference import ModelUnavailableError, generate_track, seed_tokens, validate_config
from app.ml.tokenizer import (HOLD, REST, VOCAB_SIZE, _vlq, notes_to_midi,
                              pitch_token, token_pitch, tokens_to_notes,
                              tokenize_midi, validate_midi)
from app.ml.train import split_files


CONFIG = {"bars": 16, "tempo": 96, "temperature": 0.8,
          "seed_chords": ["Am", "F", "C", "G"], "instrument": "piano"}


def midi_end_tick(data):
    """Independent traversal of generated events; return the actual EOT tick."""
    p, tick = 22, 0
    while p < len(data):
        delta, p = _vlq(data, p)
        tick += delta
        status = data[p]
        p += 1
        if status == 255:
            kind = data[p]
            p += 1
            length, p = _vlq(data, p)
            p += length
            if kind == 47:
                assert p == len(data)
                return tick
        else:
            p += 1 if status >> 4 in (12, 13) else 2
    raise AssertionError("No EOT")


def test_token_mapping_and_held_notes():
    assert token_pitch(pitch_token(60)) == 60
    notes = tokens_to_notes([pitch_token(60), HOLD, REST, HOLD, pitch_token(64)], 120)
    assert notes == [{"pitch": 60, "start": 0, "duration": 0.25, "velocity": 94},
                     {"pitch": 64, "start": 0.5, "duration": 0.125, "velocity": 94}]


@pytest.mark.parametrize("bars", [16, 32])
def test_midi_has_exact_bar_aligned_end_including_trailing_silence(bars):
    notes = [{"pitch": 60, "start": 0.0, "duration": 0.5, "velocity": 80}]
    data = notes_to_midi(notes, bars, 96)
    validate_midi(data)
    assert midi_end_tick(data) == bars * 4 * 480


@pytest.mark.parametrize("field,value", [("temperature", float("nan")), ("temperature", float("inf")),
    ("temperature", 0), ("temperature", True), ("bars", 64), ("bars", "16"),
    ("tempo", 500), ("seed_chords", ["C;__import__('os')"]), ("instrument", "../secret")])
def test_inference_rejects_invalid_controls(field, value):
    with pytest.raises(ValueError):
        validate_config({**CONFIG, field: value})


def test_missing_checkpoint_fails_without_demo_fallback(tmp_path):
    with pytest.raises(ModelUnavailableError):
        generate_track(CONFIG, tmp_path / "missing.pt")


def test_aliases_and_sevenths_stay_inside_vocabulary():
    tokens = seed_tokens(["Dbmaj7", "Bb7", "Gm7", "Bmaj7"])
    assert len(tokens) == 32
    assert all(0 <= token < VOCAB_SIZE for token in tokens)


@pytest.mark.parametrize("data", [b"<xml>not MIDI</xml>", b"MThd" + b"x" * 1_048_577,
    b"MThd" + struct.pack(">IHHH", 6, 2, 1, 480),
    b"MThd" + struct.pack(">IHHH", 6, 0, 1, 480) + b"MTrk" + struct.pack(">I", 4) + b"\x81\x81\x81\x81"],
    ids=["xml", "oversized", "format-2", "overlong-delta"])
def test_preflight_rejects_unsupported_or_malformed_midi(data):
    with pytest.raises(ValueError):
        validate_midi(data)


def test_duplicate_files_never_cross_train_validation_boundary(tmp_path):
    paths = []
    for index, payload in enumerate([b"one", b"one", b"two", b"three", b"four"]):
        path = tmp_path / f"{index}.mid"
        path.write_bytes(payload)
        paths.append(path)
    train, valid = split_files(paths)
    assert {p.read_bytes() for p in train}.isdisjoint({p.read_bytes() for p in valid})
    assert len(train) + len(valid) == 4


def test_music21_round_trip(tmp_path):
    pytest.importorskip("music21")
    path = tmp_path / "test.mid"
    path.write_bytes(notes_to_midi(tokens_to_notes([pitch_token(60), HOLD, pitch_token(64), HOLD], 120), 16, 120))
    tokens = tokenize_midi(path)
    assert tokens[:4] == [pitch_token(60), HOLD, pitch_token(64), HOLD]


def test_music21_preserves_note_sustained_across_barline(tmp_path):
    pytest.importorskip("music21")
    path = tmp_path / "held.mid"
    tokens = [pitch_token(60)] + [HOLD] * 19
    path.write_bytes(notes_to_midi(tokens_to_notes(tokens, 120), 16, 120))
    assert tokenize_midi(path)[:20] == tokens


@pytest.mark.parametrize("bars", [16, 32])
def test_small_checkpoint_generates_valid_midi(tmp_path, bars):
    torch = pytest.importorskip("torch")
    from app.ml.model import MelodyLSTM
    from app.ml.tokenizer import VERSION
    model = MelodyLSTM(embedding_dim=16, hidden_dim=16, layers=1)
    checkpoint = tmp_path / "test.pt"
    torch.save({"state_dict": model.state_dict(), "architecture": model.architecture,
                "tokenizer": VERSION, "vocab_size": VOCAB_SIZE, "synthetic_demo": True}, checkpoint)
    with pytest.raises(ModelUnavailableError):
        generate_track({**CONFIG, "bars": bars}, checkpoint)
    result = generate_track({**CONFIG, "bars": bars, "allow_synthetic_demo": True}, checkpoint)
    assert result["model"] == "lstm-synthetic-demo"
    assert result["duration"] == bars * 2.5
    assert midi_end_tick(result["midi"]) == bars * 4 * 480
    assert all(0 <= note["start"] < result["duration"] and note["duration"] > 0 for note in result["notes"])
    validate_midi(result["midi"])


def test_corrupted_checkpoint_is_unavailable(tmp_path):
    pytest.importorskip("torch")
    checkpoint = tmp_path / "broken.pt"
    checkpoint.write_bytes(b"This is not a checkpoint")
    with pytest.raises(ModelUnavailableError):
        generate_track(CONFIG, checkpoint)
