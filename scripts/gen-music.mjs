// scripts/gen-music.mjs — synthesizes royalty-free demo loops as 16-bit mono WAVs.
// Run: node scripts/gen-music.mjs
//
// Each track is 24s at 44.1kHz with a kick on every beat at the listed BPM, plus a
// simple mid sine and noise hiss. Not concert-quality — just enough to demonstrate
// beat-locked editing across different tempos.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const SAMPLE_RATE = 44100;
const DURATION_S = 24;

const TRACKS = [
  { id: "summer-sprint", bpm: 128, root: 220.0 },
  { id: "open-road", bpm: 112, root: 196.0 },
  { id: "festival-glow", bpm: 100, root: 174.6 },
  { id: "deep-cove", bpm: 92, root: 146.8 },
];

function generate(bpm, rootHz) {
  const samples = SAMPLE_RATE * DURATION_S;
  const data = new Float32Array(samples);
  const beatPeriod = 60 / bpm;

  for (let i = 0; i < samples; i += 1) {
    const t = i / SAMPLE_RATE;
    const beatPhase = (t % beatPeriod) / beatPeriod;

    const kickEnv = Math.exp(-9 * beatPhase);
    const kick = kickEnv * Math.sin(2 * Math.PI * rootHz * 0.5 * t);

    const padEnv = 0.5 + 0.5 * Math.sin((2 * Math.PI * t) / 6);
    const pad =
      0.18 *
      padEnv *
      (Math.sin(2 * Math.PI * rootHz * t) +
        0.5 * Math.sin(2 * Math.PI * rootHz * 1.5 * t));

    const hatEnv = beatPhase > 0.45 && beatPhase < 0.55 ? 0.4 : 0;
    const hat = hatEnv * (Math.random() * 2 - 1);

    const fadeIn = Math.min(1, t / 0.4);
    const fadeOut = Math.min(1, (DURATION_S - t) / 0.4);
    const env = Math.max(0, Math.min(fadeIn, fadeOut));

    data[i] = (kick * 0.6 + pad + hat * 0.15) * env * 0.55;
  }

  return data;
}

function toWavBuffer(data) {
  const sampleCount = data.length;
  const dataBytes = sampleCount * 2;
  const buf = Buffer.alloc(44 + dataBytes);

  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataBytes, 40);

  for (let i = 0; i < sampleCount; i += 1) {
    const clamped = Math.max(-1, Math.min(1, data[i]));
    buf.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  }

  return buf;
}

const outDir = "public/music";
mkdirSync(dirname(`${outDir}/.`), { recursive: true });

for (const track of TRACKS) {
  const samples = generate(track.bpm, track.root);
  const wav = toWavBuffer(samples);
  const path = `${outDir}/${track.id}-loop.wav`;
  writeFileSync(path, wav);
  console.log(`wrote ${path} (${track.bpm} BPM, ${(wav.length / 1024).toFixed(0)} KB)`);
}
