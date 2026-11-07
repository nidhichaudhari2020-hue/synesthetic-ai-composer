import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  composeFromWeights,
  createLstm,
  sampleToken,
  seedTokens,
} from "../neural-worker.js";
import { trackSchema } from "../music.js";

const asset = JSON.parse(
  await readFile(new URL("../demo-weights.json", import.meta.url), "utf8"),
);
const config = {
  seed_chords: ["Am", "F", "C", "G"],
  temperature: 0.85,
  bars: 16,
  tempo: 92,
  instrument: "piano",
};

test("browser LSTM reproduces all PyTorch logits across seed and continued recurrent state", (t) => {
  const { context, chords, continuation, logits } = asset.parity;
  assert.deepEqual(seedTokens(chords), context);
  const model = createLstm(asset);
  let current;
  for (const token of context) current = model.step(token);
  const predicted = [[...current]];
  for (const token of continuation) predicted.push([...model.step(token)]);
  assert.equal(predicted.length, logits.length);
  let maxError = 0;
  for (let i = 0; i < logits.length; i++) {
    assert.equal(logits[i].length, 39);
    for (let j = 0; j < 39; j++)
      maxError = Math.max(maxError, Math.abs(predicted[i][j] - logits[i][j]));
  }
  t.diagnostic(
    `Maximum absolute error over ${logits.length * 39} PyTorch logits: ${maxError}`,
  );
  assert.ok(maxError < 0.00002);
});

test("16- and 32-bar neural tracks stay on the model's sixteenth-note grid", () => {
  for (const bars of [16, 32]) {
    let state = 42;
    const random = () =>
      (state = (Math.imul(1664525, state) + 1013904223) >>> 0) / 4294967296;
    const track = composeFromWeights({ ...config, bars }, asset, random);
    trackSchema.parse(track);
    assert.equal(track.model, "lstm-synthetic-demo");
    assert.equal(track.duration, (bars * 4 * 60) / config.tempo);
    assert.ok(track.notes.length > 0 && track.notes.length <= bars * 16);
    let previousEnd = 0;
    for (const note of track.notes) {
      assert.ok(note.pitch >= 48 && note.pitch <= 84);
      assert.ok(note.start >= previousEnd - 1e-8);
      const step = (note.start * config.tempo) / 15;
      assert.ok(Math.abs(step - Math.round(step)) < 1e-8);
      previousEnd = note.start + note.duration;
      assert.ok(previousEnd <= track.duration + 1e-8);
    }
  }
});

test("sampling masks an impossible HOLD and temperature changes the probability mass", () => {
  const logits = new Float32Array(39).fill(-100);
  logits[1] = 8;
  logits[2] = 1;
  logits[3] = 0;
  assert.equal(
    sampleToken(logits, 0.2, true, () => 0.5),
    1,
  );
  assert.equal(
    sampleToken(logits, 0.2, false, () => 0.8),
    2,
  );
  assert.equal(
    sampleToken(logits, 1.5, false, () => 0.8),
    3,
  );
});

test("browser refuses incompatible, oversized, and malformed tensor assets", () => {
  assert.throws(() => createLstm({ ...asset, model: "lstm-trained" }));
  assert.throws(() =>
    createLstm({
      ...asset,
      architecture: { ...asset.architecture, hidden_dim: 10000 },
    }),
  );
  assert.throws(() =>
    createLstm({
      ...asset,
      tensors: { ...asset.tensors, "embedding.weight": "AAAA" },
    }),
  );
});
