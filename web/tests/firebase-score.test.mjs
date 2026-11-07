import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { encodeFirebaseScore, decodeFirebaseScore } from "../firebase-score.js";
import { composeFromWeights } from "../neural-worker.js";
import { createShowcaseTrack } from "../showcase.js";
import { midiBytes } from "../music.js";

const id = "01234567-89ab-4def-8123-456789abcdef";
const createdAt = { toDate: () => new Date("2026-11-05T00:00:00Z") };
const asset = JSON.parse(await readFile(new URL("../demo-weights.json", import.meta.url), "utf8"));
function roundTrip(track) {
  const encoded = encodeFirebaseScore(track);
  assert.equal(encoded.tokens.length, track.bars * 16);
  assert.deepEqual(Object.keys(encoded).sort(), ["bars", "instrument", "temperature", "tempo", "title", "tokens"]);
  const decoded = decodeFirebaseScore(track.id, { ...encoded, createdAt });
  assert.deepEqual(midiBytes(decoded), midiBytes(track), "Cloud representation must preserve exported MIDI bytes");
  assert.equal(decoded.duration, track.duration);
  assert.equal(decoded.notes.length, track.notes.length);
  return encoded;
}

test("16/32-bar model compositions round-trip with byte-identical MIDI at tempo limits", () => {
  for (const bars of [16, 32]) for (const tempo of [50, 92, 180]) {
    let state = 42;
    const random = () => (state = (Math.imul(1664525, state) + 1013904223) >>> 0) / 4294967296;
    roundTrip(composeFromWeights({ bars, tempo, seed_chords: ["Am", "F", "C", "G"], temperature: 0.85, instrument: "piano" }, asset, random));
  }
});

test("the actual PyTorch showcase survives the storage representation unchanged", () => {
  roundTrip({ ...createShowcaseTrack(), id });
});

test("rests, adjacent repeated notes, long holds and the last grid step remain distinct", () => {
  const score = { title: "Grid edge cases", bars: 16, tempo: 60, instrument: "strings", temperature: 1.5,
    tokens: "0221" + "1".repeat(248) + "000c", createdAt };
  const track = decodeFirebaseScore(id, score);
  assert.equal(track.notes.length, 3);
  assert.equal(track.notes[0].pitch, track.notes[1].pitch);
  assert.equal(track.notes[2].pitch, 84);
  assert.equal(track.notes[2].start + track.notes[2].duration, track.duration);
  assert.equal(roundTrip(track).tokens, score.tokens);
  const silence = { ...score, tokens: "0".repeat(256) };
  assert.equal(decodeFirebaseScore(id, silence).notes.length, 0);
  assert.equal(encodeFirebaseScore(decodeFirebaseScore(id, silence)).tokens, silence.tokens);
});

test("unsupported notes are rejected instead of silently quantizing or losing data", () => {
  const valid = { ...createShowcaseTrack(), id };
  const mutate = (change) => {
    const copy = structuredClone(valid); change(copy); assert.throws(() => encodeFirebaseScore(copy));
  };
  mutate(t => { t.notes[0].start += 0.01; });
  mutate(t => { t.notes[0].duration += 0.01; });
  mutate(t => { t.notes[1].start = t.notes[0].start; });
  mutate(t => { t.notes[0].pitch = 47; });
  mutate(t => { t.notes[0].velocity = 100; });
  mutate(t => { t.duration += 1; });
  mutate(t => { t.notes[0].duration = t.duration + 1; });
  mutate(t => { t.id = "../../another-user"; });
  mutate(t => { t.tempo = 40; });
});

test("untrusted stored token strings, fields, IDs and timestamps fail validation", () => {
  const encoded = { ...encodeFirebaseScore({ ...createShowcaseTrack(), id }), createdAt };
  for (const tokens of ["1" + "0".repeat(255), "01" + "0".repeat(254), "d".repeat(256), "0".repeat(255), "0".repeat(513), "0".repeat(255) + "\n"])
    assert.throws(() => decodeFirebaseScore(id, { ...encoded, tokens }));
  for (const patch of [{ ownerId: "someone-else" }, { createdAt: "now" }, { createdAt: { toDate: () => new Date(NaN) } },
    { title: "<script>" }, { title: "x".repeat(101) }, { title: "Valid title\n" }, { temperature: Infinity }, { tempo: 100.5 }])
    assert.throws(() => decodeFirebaseScore(id, { ...encoded, ...patch }));
  assert.throws(() => decodeFirebaseScore("not-a-uuid", encoded));
  assert.throws(() => decodeFirebaseScore(id + "\n", encoded));
});
