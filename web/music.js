import { z } from "zod";
export const chords = {
  C: [60, 64, 67],
  Dm: [62, 65, 69],
  Em: [64, 67, 71],
  F: [65, 69, 72],
  G: [67, 71, 74],
  Am: [57, 60, 64],
  Bm: [59, 62, 66],
  D: [62, 66, 69],
  E: [64, 68, 71],
  A: [57, 61, 64],
  Cm: [60, 63, 67],
  Gm: [55, 58, 62],
  Bb: [58, 62, 65],
  Eb: [63, 67, 70],
};
export const compositionSchema = z
  .object({
    seed_chords: z.array(z.enum(Object.keys(chords))).length(4),
    temperature: z.number().min(0.2).max(1.5),
    bars: z.union([z.literal(16), z.literal(32)]),
    tempo: z.number().int().min(50).max(180),
    instrument: z.enum(["piano", "synth", "strings"]),
  })
  .strict();
export const trackSchema = z.object({
  id: z.string().max(100),
  title: z.string().max(100),
  created_at: z.string(),
  bars: z.union([z.literal(16), z.literal(32)]),
  tempo: z.number().min(40).max(180),
  temperature: z.number().min(0.2).max(1.5),
  instrument: z.enum(["piano", "synth", "strings"]),
  duration: z.number().positive().max(768),
  model: z.string().max(200),
  notes: z
    .array(
      z.object({
        pitch: z.number().int().min(0).max(127),
        start: z.number().nonnegative().max(768),
        duration: z.number().positive().max(768),
        velocity: z.number().min(0).max(127),
      }),
    )
    .max(8192),
});
export function composeDemo(input, random = Math.random) {
  const c = compositionSchema.parse(input);
  const beat = 60 / c.tempo;
  const notes = [];
  let last = 72;
  for (let bar = 0; bar < c.bars; bar++) {
    const chord = chords[c.seed_chords[bar % 4]];
    const root = chord[0] - 12;
    notes.push({
      pitch: root,
      start: bar * 4 * beat,
      duration: 3.8 * beat,
      velocity: 55,
    });
    chord.forEach((p, k) =>
      notes.push({
        pitch: p,
        start: (bar * 4 + k * 0.5) * beat,
        duration: 1.8 * beat,
        velocity: 40 + k * 3,
      }),
    );
    for (let step = 0; step < 8; step++) {
      if (random() < 0.12 && step > 0) continue;
      const palette = [...chord.map((n) => n + 12), ...chord];
      let pitch = palette[Math.floor(random() * palette.length)];
      if (c.temperature < 0.7)
        pitch = palette.reduce((a, b) =>
          Math.abs(b - last) < Math.abs(a - last) ? b : a,
        );
      else if (c.temperature > 1.05 && random() < 0.25)
        pitch += random() < 0.5 ? 2 : -2;
      last = pitch;
      notes.push({
        pitch,
        start: (bar * 4 + step * 0.5) * beat,
        duration: (step === 7 ? 0.45 : 0.38 + random() * 0.5) * beat,
        velocity: 65 + Math.floor(random() * 22),
      });
    }
  }
  notes.sort((a, b) => a.start - b.start);
  const duration = c.bars * 4 * beat;
  for (const n of notes) n.duration = Math.min(n.duration, duration - n.start);
  return {
    ...c,
    id: crypto.randomUUID(),
    title: "Untitled composition",
    created_at: new Date().toISOString(),
    duration,
    model: "procedural-browser-demo",
    notes,
  };
}
function vlq(value) {
  let b = [value & 127];
  while ((value >>= 7)) b.unshift((value & 127) | 128);
  return b;
}
export function midiBytes(track) {
  const ticksPerBeat = 480,
    events = [];
  const tempo = Math.round(60000000 / track.tempo);
  events.push(
    {
      tick: 0,
      order: 0,
      bytes: [
        0xff,
        0x51,
        3,
        (tempo >> 16) & 255,
        (tempo >> 8) & 255,
        tempo & 255,
      ],
    },
    { tick: 0, order: 0, bytes: [0xff, 0x58, 4, 4, 2, 24, 8] },
    {
      tick: 0,
      order: 0,
      bytes: [
        0xc0,
        { piano: 0, synth: 89, strings: 48 }[track.instrument] ?? 0,
      ],
    },
  );
  for (const n of track.notes) {
    const start = Math.round(((n.start * track.tempo) / 60) * ticksPerBeat),
      end = Math.round(
        (((n.start + n.duration) * track.tempo) / 60) * ticksPerBeat,
      );
    events.push(
      {
        tick: start,
        order: 2,
        bytes: [
          0x90,
          n.pitch,
          Math.min(127, Math.max(1, Math.round(n.velocity))),
        ],
      },
      { tick: end, order: 1, bytes: [0x80, n.pitch, 0] },
    );
  }
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  let prev = 0,
    bytes = [];
  for (const e of events) {
    bytes.push(...vlq(e.tick - prev), ...e.bytes);
    prev = e.tick;
  }
  bytes.push(
    ...vlq(Math.max(0, track.bars * 4 * ticksPerBeat - prev)),
    0xff,
    0x2f,
    0,
  );
  let len = bytes.length;
  return new Uint8Array([
    77,
    84,
    104,
    100,
    0,
    0,
    0,
    6,
    0,
    0,
    0,
    1,
    1,
    224,
    77,
    84,
    114,
    107,
    (len >>> 24) & 255,
    (len >>> 16) & 255,
    (len >>> 8) & 255,
    len & 255,
    ...bytes,
  ]);
}
export class Player {
  constructor() {
    this.context = null;
    this.playing = false;
    this.offset = 0;
    this.nodes = [];
    this.volume = 0.65;
    this.energy = 0;
    this.onEnd = () => {};
  }
  async init() {
    if (!this.context) {
      this.context = new AudioContext();
      this.gain = this.context.createGain();
      this.gain.gain.value = this.volume * 0.24;
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 256;
      this.gain.connect(this.analyser);
      this.analyser.connect(this.context.destination);
      this.bins = new Uint8Array(this.analyser.frequencyBinCount);
    }
    await this.context.resume();
  }
  async play(track) {
    await this.init();
    this.stop(false);
    this.track = track;
    if (this.offset >= track.duration) this.offset = 0;
    this.startedAt = this.context.currentTime - this.offset;
    this.playing = true;
    this.next = track.notes.findIndex((n) => n.start >= this.offset);
    if (this.next < 0) this.next = track.notes.length;
    this.schedule();
    this.timer = setInterval(() => this.schedule(), 60);
  }
  schedule() {
    const now = this.context.currentTime;
    while (
      this.next < this.track.notes.length &&
      this.track.notes[this.next].start < this.position() + 0.25
    ) {
      const n = this.track.notes[this.next++];
      const when = Math.max(now, this.startedAt + n.start);
      const osc = this.context.createOscillator(),
        gain = this.context.createGain();
      osc.type = this.track.instrument === "synth" ? "triangle" : "sine";
      osc.frequency.value = 440 * 2 ** ((n.pitch - 69) / 12);
      const sustain = this.track.instrument === "strings" ? 0.11 : 0.015;
      gain.gain.setValueAtTime(0, when);
      gain.gain.linearRampToValueAtTime(n.velocity / 127, when + sustain);
      gain.gain.exponentialRampToValueAtTime(
        0.001,
        when + Math.max(0.15, n.duration),
      );
      osc.connect(gain);
      gain.connect(this.gain);
      osc.start(when);
      osc.stop(when + Math.max(0.15, n.duration) + 0.06);
      const entry = { osc, gain };
      this.nodes.push(entry);
      osc.onended = () => {
        osc.disconnect();
        gain.disconnect();
        this.nodes = this.nodes.filter((x) => x !== entry);
      };
    }
    if (this.position() >= this.track.duration) {
      this.stop();
      this.onEnd();
    }
  }
  position() {
    return this.playing
      ? Math.max(0, this.context.currentTime - this.startedAt)
      : this.offset;
  }
  stop(reset = true) {
    clearInterval(this.timer);
    if (this.playing) this.offset = this.position();
    this.playing = false;
    for (const n of this.nodes) {
      try {
        n.osc.stop();
      } catch {}
    }
    this.nodes = [];
    if (reset) this.offset = 0;
  }
  setVolume(value) {
    this.volume = value;
    if (this.gain)
      this.gain.gain.setTargetAtTime(
        value * 0.24,
        this.context.currentTime,
        0.03,
      );
  }
  spectrum() {
    if (!this.analyser || !this.playing) return { bass: 0, treble: 0 };
    this.analyser.getByteFrequencyData(this.bins);
    const avg = (a, b) =>
      this.bins.slice(a, b).reduce((x, y) => x + y, 0) / (b - a) / 255;
    return { bass: avg(0, 16), treble: avg(16, 70) };
  }
}
