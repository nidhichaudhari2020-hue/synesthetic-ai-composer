import test from "node:test";
import assert from "node:assert/strict";
import {
  composeDemo,
  compositionSchema,
  midiBytes,
  trackSchema,
} from "../music.js";
const config = {
  seed_chords: ["Am", "F", "C", "G"],
  temperature: 0.85,
  bars: 16,
  tempo: 92,
  instrument: "piano",
};
test("composition stays inside exact bar duration and MIDI pitch bounds", () => {
  for (const bars of [16, 32]) {
    const t = composeDemo({ ...config, bars });
    assert.equal(t.duration, (bars * 4 * 60) / 92);
    assert.ok(t.notes.length > 100);
    assert.ok(
      t.notes.every(
        (n) =>
          n.start + n.duration <= t.duration + 0.00001 &&
          n.pitch >= 0 &&
          n.pitch <= 127,
      ),
    );
    trackSchema.parse(t);
  }
});
test("rejects untrusted fields, excessive bars and invalid controls", () => {
  for (const bad of [
    { ...config, owner_id: "another-user" },
    { ...config, bars: 999 },
    { ...config, temperature: NaN },
    { ...config, seed_chords: ["__import__(os)", "F", "C", "G"] },
    { ...config, tempo: 1 },
  ])
    assert.equal(compositionSchema.safeParse(bad).success, false);
});
test("MIDI uses valid format-0 header, track length and end marker", () => {
  const bytes = midiBytes(composeDemo(config));
  const v = new DataView(bytes.buffer);
  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), "MThd");
  assert.equal(v.getUint16(8), 0);
  assert.equal(v.getUint16(10), 1);
  assert.equal(v.getUint16(12), 480);
  assert.equal(new TextDecoder().decode(bytes.slice(14, 18)), "MTrk");
  assert.equal(v.getUint32(18), bytes.length - 22);
  assert.deepEqual([...bytes.slice(-3)], [255, 47, 0]);
});
