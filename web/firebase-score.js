import { z } from "zod";
import { trackSchema } from "./music.js";

// A bounded string lets Firestore validate every token, including HOLD placement.
// It is the model's monophonic 16th-note representation, not a general MIDI codec.
export const SCORE_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabc";
export const firebaseTrackIdSchema = z.string().length(36).regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const metadataSchema = z.object({
  // The final negative lookahead prevents JS '$' accepting a trailing newline.
  title: z.string().regex(/^[A-Za-z0-9 ,.!?()'_-]{1,100}$(?![\s\S])/),
  bars: z.union([z.literal(16), z.literal(32)]),
  tempo: z.number().int().min(50).max(180),
  instrument: z.enum(["piano", "synth", "strings"]),
  temperature: z.number().min(0.2).max(1.5),
});
const scoreSchema = metadataSchema.extend({
  tokens: z.string().regex(/^(0|[2-9A-Za-c]1*)+$(?![\s\S])/).max(512),
}).strict().refine((score) => score.tokens.length === score.bars * 16);

function gridIndex(seconds, step) {
  const index = seconds / step;
  if (!Number.isFinite(index) || Math.abs(index - Math.round(index)) > 1e-7)
    throw new Error("Only compositions on the model's sixteenth-note grid can be saved.");
  return Math.round(index);
}

export function encodeFirebaseScore(input) {
  const track = trackSchema.parse(input);
  firebaseTrackIdSchema.parse(track.id);
  const metadata = metadataSchema.parse(track);
  const step = 15 / track.tempo, total = track.bars * 16;
  if (Math.abs(track.duration - total * step) > 1e-7)
    throw new Error("The composition duration does not match its bar count.");
  const tokens = Array(total).fill("0");
  let previousEnd = 0;
  for (const note of track.notes) {
    const start = gridIndex(note.start, step);
    const length = gridIndex(note.duration, step);
    if (start < previousEnd || length < 1 || start + length > total ||
        note.pitch < 48 || note.pitch > 84 || note.velocity !== (start % 4 ? 82 : 94))
      throw new Error("This composition cannot be saved without changing its notes.");
    tokens[start] = SCORE_ALPHABET[note.pitch - 46];
    for (let i = start + 1; i < start + length; i++) tokens[i] = "1";
    previousEnd = start + length;
  }
  return scoreSchema.parse({ ...metadata, tokens: tokens.join("") });
}

export function decodeFirebaseScore(id, data) {
  firebaseTrackIdSchema.parse(id);
  if (!data || typeof data !== "object" ||
      Object.keys(data).some((key) => !["title", "bars", "tempo", "instrument", "temperature", "tokens", "createdAt"].includes(key)) ||
      typeof data.createdAt?.toDate !== "function")
    throw new Error("The saved composition is invalid.");
  const { createdAt, ...encoded } = data;
  const score = scoreSchema.parse(encoded);
  const created = createdAt.toDate();
  if (!(created instanceof Date) || !Number.isFinite(created.getTime()))
    throw new Error("The saved composition timestamp is invalid.");
  const step = 15 / score.tempo, notes = [];
  let active = null;
  for (let i = 0; i < score.tokens.length; i++) {
    const token = SCORE_ALPHABET.indexOf(score.tokens[i]);
    if (token === 0) active = null;
    else if (token === 1) active.duration += step;
    else {
      active = { pitch: token + 46, start: i * step, duration: step, velocity: i % 4 ? 82 : 94 };
      notes.push(active);
    }
  }
  const { tokens, ...metadata } = score;
  return trackSchema.parse({ ...metadata, id, created_at: created.toISOString(),
    model: "lstm-synthetic-demo", duration: score.bars * 240 / score.tempo, notes });
}
