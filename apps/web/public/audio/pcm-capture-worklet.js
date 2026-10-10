// AudioWorklet processor for realtime dictation (features/chat/thread/dictation).
// Served from /public rather than a blob: URL because the app CSP's
// script-src (which governs worklet modules) allows 'self' but not blob:.
// Batches mono Float32 frames to ~100 ms and posts them to the main thread,
// which resamples and encodes them (see dictation/pcm.ts).

class PcmCaptureProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.chunkSize = Math.round(sampleRate / 10);
        this.buffer = new Float32Array(this.chunkSize);
        this.offset = 0;
    }

    process(inputs) {
        const channel = inputs[0] && inputs[0][0];

        if (!channel) {
            return true;
        }

        let read = 0;

        while (read < channel.length) {
            const count = Math.min(channel.length - read, this.chunkSize - this.offset);

            this.buffer.set(channel.subarray(read, read + count), this.offset);
            this.offset += count;
            read += count;

            if (this.offset === this.chunkSize) {
                this.port.postMessage(this.buffer);
                this.buffer = new Float32Array(this.chunkSize);
                this.offset = 0;
            }
        }

        return true;
    }
}

registerProcessor("pcm-capture", PcmCaptureProcessor);
