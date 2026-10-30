const HEADER_BYTES = 44;
const BITS_PER_SAMPLE = 16;

/** A RIFF/WAVE container around 16-bit mono PCM, which is what the recogniser reads from its stdin. */
const wavHeader = (pcmBytes: number, sampleRate: number): Buffer => {
    const header = Buffer.alloc(HEADER_BYTES);
    const blockAlign = BITS_PER_SAMPLE / 8;

    header.write("RIFF", 0, "ascii");
    header.writeUInt32LE(HEADER_BYTES - 8 + pcmBytes, 4);
    header.write("WAVEfmt ", 8, "ascii");
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(1, 22); // mono
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * blockAlign, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(BITS_PER_SAMPLE, 34);
    header.write("data", 36, "ascii");
    header.writeUInt32LE(pcmBytes, 40);

    return header;
};

export const wavBytes = (pcm: Buffer, sampleRate: number): Buffer => Buffer.concat([wavHeader(pcm.length, sampleRate), pcm]);
