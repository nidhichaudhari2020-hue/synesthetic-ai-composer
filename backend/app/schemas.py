from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

CHORDS = frozenset(root + suffix for root in ("C", "C#", "Db", "D", "D#", "Eb", "E", "F", "F#", "Gb", "G", "G#", "Ab", "A", "A#", "Bb", "B") for suffix in ("", "m", "7", "maj7", "m7"))


class GenerationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    title: str = Field(default="Untitled composition", min_length=1, max_length=100, pattern=r"^[\w .,'()&—-]+$")
    seed_chords: list[str] = Field(default_factory=lambda: ["Am", "F", "C", "G"], min_length=1, max_length=8)
    temperature: float = Field(default=0.8, ge=0.2, le=1.5, allow_inf_nan=False)
    bars: Literal[16, 32] = 16
    tempo: int = Field(default=96, ge=40, le=180)
    instrument: Literal["piano", "synth", "strings"] = "piano"
    turnstile_token: str | None = Field(default=None, min_length=1, max_length=2048, repr=False)

    @field_validator("seed_chords")
    @classmethod
    def known_chords(cls, values):
        if any(chord not in CHORDS for chord in values):
            raise ValueError("Seed chords must use supported note names and chord qualities")
        return values

    @field_validator("title")
    @classmethod
    def visible_title(cls, value):
        value = value.strip()
        if not value:
            raise ValueError("Title cannot be blank")
        return value


class Note(BaseModel):
    model_config = ConfigDict(extra="forbid")
    pitch: int = Field(ge=0, le=127)
    start: float = Field(ge=0, le=768, allow_inf_nan=False)
    duration: float = Field(gt=0, le=192, allow_inf_nan=False)
    velocity: int = Field(ge=1, le=127)


class Track(BaseModel):
    id: UUID
    title: str
    created_at: datetime
    bars: Literal[16, 32]
    tempo: int
    temperature: float
    instrument: Literal["piano", "synth", "strings"]
    notes: list[Note] = Field(max_length=4096)
    duration: float = Field(gt=0, le=768)
    model: str = Field(max_length=200)


class TrackPage(BaseModel):
    tracks: list[Track]
    next_offset: int | None
