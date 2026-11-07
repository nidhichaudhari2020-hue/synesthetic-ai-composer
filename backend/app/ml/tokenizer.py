"""Versioned sixteenth-note vocabulary and bounded music21 parsing.

MIDI's upper melodic voice is quantized to a monophonic sequence. Simultaneous
notes are intentionally collapsed; the representation does not preserve drums,
pedal, microtiming, or polyphony. No URLs or arbitrary score formats are accepted.
"""
from __future__ import annotations

import math
import multiprocessing as mp
import os
import struct
from pathlib import Path

VERSION = "melody-grid-v1"
REST, HOLD, LOW_PITCH, HIGH_PITCH = 0, 1, 48, 84
VOCAB_SIZE = HIGH_PITCH - LOW_PITCH + 3
STEPS_PER_BAR = 16
MAX_FILE_BYTES = 1_048_576
MAX_TRACKS = 16
MAX_EVENTS = 50_000
MAX_STEPS = 4096


def pitch_token(pitch: int) -> int:
    if not LOW_PITCH <= pitch <= HIGH_PITCH:
        raise ValueError("Pitch is outside the supported melodic range.")
    return pitch - LOW_PITCH + 2


def token_pitch(token: int) -> int:
    if not 2 <= token < VOCAB_SIZE:
        raise ValueError("Token is not a pitch.")
    return token + LOW_PITCH - 2


def _vlq(data: bytes, pos: int) -> tuple[int, int]:
    value = 0
    for _ in range(4):
        if pos >= len(data):
            raise ValueError("Truncated MIDI variable-length number.")
        b = data[pos]
        pos += 1
        value = (value << 7) | (b & 0x7f)
        if b < 128:
            return value, pos
    raise ValueError("Overlong MIDI variable-length number.")


def validate_midi(data: bytes) -> None:
    """Bound events, lengths, tracks, and timeline before invoking music21."""
    if not 14 <= len(data) <= MAX_FILE_BYTES or data[:4] != b"MThd":
        raise ValueError("Expected a MIDI file no larger than 1 MiB.")
    header_len, fmt, tracks, division = struct.unpack(">IHHH", data[4:14])
    if header_len != 6 or fmt not in (0, 1) or not 1 <= tracks <= MAX_TRACKS:
        raise ValueError("Unsupported MIDI header or track count.")
    if not 1 <= division <= 32767 or (fmt == 0 and tracks != 1):
        raise ValueError("Only positive PPQ MIDI timing is supported.")
    pos, event_count = 14, 0
    for _ in range(tracks):
        if data[pos:pos + 4] != b"MTrk" or pos + 8 > len(data):
            raise ValueError("Missing MIDI track.")
        length = struct.unpack(">I", data[pos + 4:pos + 8])[0]
        pos += 8
        end = pos + length
        if end > len(data):
            raise ValueError("Truncated MIDI track.")
        track, p, tick, running = data[pos:end], 0, 0, None
        while p < len(track):
            delta, p = _vlq(track, p)
            tick += delta
            event_count += 1
            if event_count > MAX_EVENTS or tick > division * (MAX_STEPS // 4):
                raise ValueError("MIDI event count or duration exceeds limit.")
            if p >= len(track):
                raise ValueError("Missing MIDI event.")
            status = track[p]
            if status >= 128:
                p += 1
                if status < 240:
                    running = status
            elif running is not None:
                status = running
            else:
                raise ValueError("Invalid MIDI running status.")
            if status == 255:
                running = None
                if p >= len(track):
                    raise ValueError("Missing MIDI meta event.")
                meta_type = track[p]
                p += 1
                size, p = _vlq(track, p)
                if size > 16_384 or (meta_type == 47 and size != 0):
                    raise ValueError("MIDI meta event exceeds limit.")
                p += size
            elif status in (240, 247):
                running = None
                size, p = _vlq(track, p)
                if size > 16_384:
                    raise ValueError("MIDI system event exceeds limit.")
                p += size
            elif 128 <= status < 240:
                size = 1 if status >> 4 in (12, 13) else 2
                if any(b >= 128 for b in track[p:p + size]):
                    raise ValueError("Invalid MIDI channel event.")
                p += size
            else:
                raise ValueError("Unsupported MIDI system event.")
            if p > len(track):
                raise ValueError("Truncated MIDI event.")
        pos = end
    if pos != len(data):
        raise ValueError("Trailing MIDI data is not accepted.")


def _parse_music21(data: bytes) -> list[int]:
    from music21 import chord, converter, note

    score = converter.parseData(data, format="midi", quantizePost=False)
    flat = score.flatten()
    end_step = max(1, math.ceil(float(flat.highestTime) * 4))
    if end_step > MAX_STEPS:
        raise ValueError("Parsed score exceeds duration limit.")
    frames: list[tuple[int, bool] | None] = [None] * end_step
    for item in flat.notes:
        if isinstance(item, chord.Chord):
            source_note = max(item.notes, key=lambda part: part.pitch.midi)
        elif isinstance(item, note.Note):
            source_note = item
        else:
            continue
        pitch = source_note.pitch.midi
        # music21 splits a sustained MIDI note at a barline into tied notes.
        # Continuations must stay HOLD tokens instead of retriggering the pitch.
        has_onset = not (source_note.tie and source_note.tie.type in ("continue", "stop"))
        # Octave folding keeps pitch class while bounding the vocabulary.
        while pitch < LOW_PITCH:
            pitch += 12
        while pitch > HIGH_PITCH:
            pitch -= 12
        start = max(0, round(float(item.offset) * 4))
        stop = min(end_step, max(start + 1, round(float(item.offset + item.quarterLength) * 4)))
        for step in range(start, stop):
            if frames[step] is None or pitch > frames[step][0]:
                frames[step] = (pitch, step == start and has_onset)
    tokens, previous = [], None
    for frame in frames:
        if frame is None:
            tokens.append(REST)
            previous = None
        else:
            pitch, onset = frame
            tokens.append(HOLD if pitch == previous and not onset else pitch_token(pitch))
            previous = pitch
    return tokens


def _parser_worker(data: bytes, connection) -> None:
    try:
        # Avoid unbounded BLAS thread stacks consuming the parser memory budget.
        os.environ["OPENBLAS_NUM_THREADS"] = "1"
        os.environ["OMP_NUM_THREADS"] = "1"
        os.environ["MKL_NUM_THREADS"] = "1"
        # Enforce a process memory/CPU ceiling on Linux deployment hosts.
        try:
            import resource
            resource.setrlimit(resource.RLIMIT_AS, (1024**3, 1024**3))
            resource.setrlimit(resource.RLIMIT_CPU, (20, 20))
        except ImportError:
            pass
        connection.send((True, _parse_music21(data)))
    except Exception as error:
        connection.send((False, type(error).__name__))
    finally:
        connection.close()


def tokenize_midi(path: str | Path, timeout: float = 25) -> list[int]:
    """Read a bounded local MIDI, parse in a killable child, return integer IDs."""
    source = Path(path)
    if source.suffix.lower() not in (".mid", ".midi") or not source.is_file():
        raise ValueError("A local .mid or .midi file is required.")
    with source.open("rb") as handle:
        data = handle.read(MAX_FILE_BYTES + 1)
    validate_midi(data)
    context = mp.get_context("spawn")
    parent, child = context.Pipe(duplex=False)
    process = context.Process(target=_parser_worker, args=(data, child), daemon=True)
    process.start()
    child.close()
    try:
        if not parent.poll(timeout):
            raise ValueError("MIDI parser exceeded its time limit.")
        try:
            success, value = parent.recv()
        except EOFError as error:
            raise ValueError("MIDI parser stopped unexpectedly.") from error
        if not success:
            raise ValueError(f"MIDI parser rejected input ({value}).")
        return value
    finally:
        if process.is_alive():
            process.terminate()
        process.join(timeout=2)
        parent.close()


def tokens_to_notes(tokens: list[int], tempo: int) -> list[dict]:
    seconds_per_step = 15.0 / tempo
    notes: list[dict] = []
    active = None
    for step, token in enumerate(tokens):
        if token == HOLD and active is not None:
            active["duration"] += seconds_per_step
        else:
            active = None
            if token >= 2:
                active = {"pitch": token_pitch(token), "start": step * seconds_per_step,
                          "duration": seconds_per_step, "velocity": 82 if step % 4 else 94}
                notes.append(active)
    return notes


def _encode_vlq(value: int) -> bytes:
    result = [value & 127]
    value >>= 7
    while value:
        result.insert(0, (value & 127) | 128)
        value >>= 7
    return bytes(result)


def notes_to_midi(notes: list[dict], bars: int, tempo: int, program: int = 0) -> bytes:
    """Write a format-0 MIDI with an exact bar-aligned end-of-track tick."""
    ppq, final_tick = 480, bars * 4 * 480
    events = [(0, 0, b"\xff\x51\x03" + int(60_000_000 / tempo).to_bytes(3, "big")),
              (0, 1, b"\xff\x58\x04\x04\x02\x18\x08"),
              (0, 2, bytes([0xc0, program]))]
    for n in notes:
        start = round(n["start"] * tempo / 60 * ppq)
        stop = min(final_tick, round((n["start"] + n["duration"]) * tempo / 60 * ppq))
        if 0 <= start < stop <= final_tick:
            events.extend([(start, 4, bytes([0x90, n["pitch"], n["velocity"]])),
                           (stop, 3, bytes([0x80, n["pitch"], 0]))])
    events.append((final_tick, 5, b"\xff\x2f\x00"))
    previous, track = 0, bytearray()
    for tick, _, event in sorted(events):
        track.extend(_encode_vlq(tick - previous) + event)
        previous = tick
    return b"MThd" + struct.pack(">IHHH", 6, 0, 1, ppq) + b"MTrk" + struct.pack(">I", len(track)) + track
