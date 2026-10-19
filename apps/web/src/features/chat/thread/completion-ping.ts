/** Two short rising notes, synthesised so there is no audio file to ship or load. */
const NOTES = [
    { frequency: 880, offset: 0 },
    { frequency: 1318.5, offset: 0.12 },
] as const;

const NOTE_SECONDS = 0.18;
const PEAK_GAIN = 0.08;
const CLOSE_AFTER_MS = 600;

/** Plays the "reply finished" ping. Silent where there is no Web Audio or the browser refuses to start it. */
const playCompletionPing = (): void => {
    const AudioContextConstructor = globalThis.AudioContext;

    if (!AudioContextConstructor) {
        return;
    }

    // One context per ping, closed when the last note ends: browsers cap how many may be open at once.
    const context = new AudioContextConstructor();

    context.resume().catch(() => {});

    for (const { frequency, offset } of NOTES) {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const start = context.currentTime + offset;

        oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(PEAK_GAIN, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + NOTE_SECONDS);
        oscillator.connect(gain).connect(context.destination);
        oscillator.start(start);
        oscillator.stop(start + NOTE_SECONDS);
    }

    setTimeout(() => context.close().catch(() => {}), CLOSE_AFTER_MS);
};

export default playCompletionPing;
