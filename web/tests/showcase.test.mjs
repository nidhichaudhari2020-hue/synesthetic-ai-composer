import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { midiBytes } from "../music.js";
import { createShowcaseTrack, SHOWCASE_ID } from "../showcase.js";

test("the built-in opening track re-encodes byte-for-byte to the verified PyTorch MIDI", async () => {
  const reference = await readFile(new URL("../../model-demo/lstm-demo-16-bars.mid", import.meta.url));
  const sample = createShowcaseTrack();
  assert.equal(sample.id, SHOWCASE_ID);
  assert.equal(sample.notes.length, 109);
  assert.equal(sample.duration, 40);
  assert.deepEqual(Buffer.from(midiBytes(sample)), reference);
});
