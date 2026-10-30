#!/usr/bin/env node
// A stand-in for `whisper-cli` in tests: the same arguments in, text on stdout out. It reads a WAV from
// stdin (`-f -`), checks the model path it was given, and says how much audio it heard.
// The helper's environment is allowlisted, so its behaviour comes from the model file's text instead:
//   "blank" → prints only a silence annotation
//   "die"   → kills itself once the audio has arrived
//   anything else → recognises
import { existsSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
const valueOf = (flag) => args[args.indexOf(flag) + 1];
const model = valueOf("-m");

if (args.includes("-h") || args.includes("--help")) {
    process.stdout.write("fake whisper-cli\n");
    process.exit(0);
}

if (valueOf("-f") !== "-" || model === undefined || !existsSync(model)) {
    process.stderr.write(`fake-whisper-cli: bad arguments ${args.join(" ")}\n`);
    process.exit(2);
}

const mode = readFileSync(model, "utf8").slice(0, 16).trim();
const chunks = [];

for await (const chunk of process.stdin) {
    chunks.push(chunk);
}

const wav = Buffer.concat(chunks);

if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE" || wav.readUInt32LE(24) !== 16_000 || wav.readUInt16LE(22) !== 1) {
    process.stderr.write("fake-whisper-cli: not a 16 kHz mono WAV\n");
    process.exit(3);
}

if (mode === "die") {
    process.kill(process.pid, "SIGKILL");
}

const samples = (wav.length - 44) / 2;

if (mode === "blank") {
    process.stdout.write(" [BLANK_AUDIO]\n");
} else {
    process.stdout.write(` Hello from the fake recogniser, ${samples} samples.\n Second segment.\n`);
}
