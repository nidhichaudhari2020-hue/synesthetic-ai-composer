// Render the notes already authorized for playback, entirely on this device.
export async function renderWav(track) {
  const rate = 22050;
  if (
    !(track.duration > 0 && track.duration <= 192) ||
    track.notes.length > 8192
  )
    throw new Error("Track exceeds the audio export limit.");
  const frames = Math.ceil(track.duration * rate);
  const context = new OfflineAudioContext(1, frames, rate);
  for (const note of track.notes) {
    const end = Math.min(track.duration, note.start + note.duration);
    if (end <= note.start) continue;
    const voice = context.createOscillator(),
      gain = context.createGain();
    voice.type = track.instrument === "synth" ? "triangle" : "sine";
    voice.frequency.value = 440 * 2 ** ((note.pitch - 69) / 12);
    gain.gain.setValueAtTime(0, note.start);
    const attack = Math.min(
      (end - note.start) / 3,
      track.instrument === "strings" ? 0.11 : 0.015,
    );
    gain.gain.linearRampToValueAtTime(
      (0.23 * note.velocity) / 127,
      note.start + attack,
    );
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    voice.connect(gain).connect(context.destination);
    voice.start(note.start);
    voice.stop(end);
  }
  const buffer = await context.startRendering();
  const samples = buffer.getChannelData(0);
  const wav = new ArrayBuffer(44 + frames * 2),
    view = new DataView(wav);
  const tag = (offset, s) => {
    for (let i = 0; i < s.length; i++)
      view.setUint8(offset + i, s.charCodeAt(i));
  };
  tag(0, "RIFF");
  view.setUint32(4, wav.byteLength - 8, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, frames * 2, true);
  let peak = 1;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  for (let i = 0; i < frames; i++)
    view.setInt16(44 + i * 2, Math.round((samples[i] * 32760) / peak), true);
  return new Blob([wav], { type: "audio/wav" });
}
