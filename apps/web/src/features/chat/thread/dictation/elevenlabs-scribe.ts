/**
 * ElevenLabs Scribe realtime speech-to-text client.
 *
 * Protocol (https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime):
 * - connect to `wss://api.elevenlabs.io/v1/speech-to-text/realtime` with the
 *   single-use `token` from our `/api/scribe-token` route as a query param —
 *   the API key never reaches the browser;
 * - send `{ message_type: "input_audio_chunk", audio_base_64, commit, sample_rate }`;
 * - receive `partial_transcript` / `committed_transcript` (`text`), plus a family
 *   of error message types (`warning` is advisory and deliberately not one).
 *
 * The final commit is an `input_audio_chunk` with an EMPTY `audio_base_64` and
 * `commit: true` — the same message `@elevenlabs/client`'s `commit()` sends.
 *
 * With `commit_strategy=vad` the server commits on pauses; stopping sends one
 * last chunk with `commit: true` so the tail of the utterance is finalised too.
 */

import { bytesToBase64, downsample, floatTo16BitPcm, TARGET_SAMPLE_RATE } from "./pcm";

const SCRIBE_URL = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";
const SCRIBE_MODEL_ID = "scribe_v2_realtime";
const WORKLET_URL = "/audio/pcm-capture-worklet.js";
/** How long `stop()` waits for the final commit before giving up on it. */
const FINAL_COMMIT_TIMEOUT_MS = 2000;
/** Audio captured before the socket opens is buffered, up to ~5 s. */
const MAX_BUFFERED_CHUNKS = 50;

const ERROR_MESSAGE_TYPES = new Set([
    "auth_error",
    "chunk_size_exceeded",
    "commit_throttled",
    "error",
    "input_error",
    "insufficient_audio_activity",
    "invalid_request",
    "queue_overflow",
    "quota_exceeded",
    "rate_limited",
    "resource_exhausted",
    "session_time_limit_exceeded",
    "transcriber_error",
    "unaccepted_terms",
]);

export interface ScribeCallbacks {
    /** A segment was finalised by the server. */
    onCommitted: (text: string) => void;

    /**
     * The server closed the session cleanly on its own (not after `stop()`).
     * Without it a caller waiting for the next commit would wait forever.
     */
    onEnd?: () => void;
    /** The session failed; the caller should tear its UI down. `stop()` is still safe to call. */
    onError: (message: string) => void;
    /** The in-progress (not yet committed) text changed. */
    onPartial: (text: string) => void;
}

export interface ScribeSession {
    /** Finalises the current utterance, then releases the microphone and socket. */
    stop: () => Promise<void>;
}

type ScribeServerMessage = { error?: string; message?: string; message_type?: string; text?: string };

/**
 * Statuses meaning "not for this user / not set up / over the dictation rate
 * limit" — expected, so not logged. Every non-OK status falls back to the Web
 * Speech API; only 404/503 are remembered, since a 401/403/429 can clear.
 */
const SCRIBE_UNAVAILABLE_STATUSES = new Set([401, 403, 404, 429, 503]);

/** Remembered for the page's lifetime once the route says it is not configured. */
const scribeAvailability = { unconfigured: false };

/**
 * Mints a single-use token via our server route. Returns `null` when realtime
 * dictation is not available to this user (route unconfigured, anonymous user)
 * so the caller falls back to the Web Speech API. An unconfigured route is
 * remembered for the page's lifetime rather than asked about on every click.
 */
export const fetchScribeToken = async (): Promise<string | null> => {
    if (scribeAvailability.unconfigured) {
        return null;
    }

    try {
        const response = await fetch("/api/scribe-token", { method: "POST" });

        if (!response.ok) {
            await response.body?.cancel();

            if (response.status === 404 || response.status === 503) {
                scribeAvailability.unconfigured = true;
            }

            if (!SCRIBE_UNAVAILABLE_STATUSES.has(response.status)) {
                console.warn(`[dictation] scribe token request failed: HTTP ${response.status}`);
            }

            return null;
        }

        const data = (await response.json()) as { token?: unknown };

        return typeof data.token === "string" && data.token ? data.token : null;
    } catch (error) {
        console.warn("[dictation] scribe token request failed", error);

        return null;
    }
};

export const buildScribeUrl = (token: string, languageCode?: string): string => {
    const parameters = new URLSearchParams({
        audio_format: `pcm_${TARGET_SAMPLE_RATE}`,
        commit_strategy: "vad",
        model_id: SCRIBE_MODEL_ID,
        token,
    });

    if (languageCode) {
        parameters.set("language_code", languageCode);
    }

    return `${SCRIBE_URL}?${parameters.toString()}`;
};

const encodeChunk = (samples: Float32Array, inputRate: number, commit: boolean): string => {
    const pcm = floatTo16BitPcm(downsample(samples, inputRate));

    return JSON.stringify({
        audio_base_64: bytesToBase64(pcm),
        commit,
        message_type: "input_audio_chunk",
        sample_rate: TARGET_SAMPLE_RATE,
    });
};

/**
 * Starts a session. `audioContext` must be created by the caller inside the
 * user gesture (click / shortcut) — one created after the token `await` starts
 * suspended under autoplay policy and would capture silence. The session owns
 * it from here on and closes it on stop.
 */
export const startScribeSession = async ({
    audioContext,
    callbacks,
    languageCode,
    token,
}: {
    audioContext: AudioContext;
    callbacks: ScribeCallbacks;
    languageCode?: string;
    token: string;
}): Promise<ScribeSession> => {
    let stream: MediaStream | undefined;

    try {
        stream = await navigator.mediaDevices.getUserMedia({
            audio: { autoGainControl: true, channelCount: 1, echoCancellation: true, noiseSuppression: true },
        });

        if (audioContext.sampleRate < TARGET_SAMPLE_RATE) {
            throw new Error(`Audio device sample rate ${audioContext.sampleRate} Hz is below ${TARGET_SAMPLE_RATE} Hz`);
        }

        await audioContext.resume();
        await audioContext.audioWorklet.addModule(WORKLET_URL);
    } catch (error) {
        const tracks = stream?.getTracks() ?? [];

        for (const track of tracks) {
            track.stop();
        }

        void audioContext.close().catch(() => undefined);

        throw error;
    }

    const source = audioContext.createMediaStreamSource(stream);
    const worklet = new AudioWorkletNode(audioContext, "pcm-capture");
    // A worklet that reaches no destination is not guaranteed to be pulled, so
    // route it through a muted gain node rather than leaving it dangling.
    const sink = audioContext.createGain();

    sink.gain.value = 0;
    source.connect(worklet);
    worklet.connect(sink);
    sink.connect(audioContext.destination);

    const socket = new WebSocket(buildScribeUrl(token, languageCode));
    const pending: string[] = [];
    let released = false;
    let failed = false;
    let stopping = false;
    /** Whether the server has shown partial text it has not committed yet. */
    let hasUncommitted = false;
    let resolveFinalCommit: (() => void) | undefined;

    const onAudioFrame = (event: MessageEvent<Float32Array>): void => {
        const chunk = encodeChunk(event.data, audioContext.sampleRate, false);

        if (socket.readyState === WebSocket.OPEN) {
            socket.send(chunk);
        } else if (socket.readyState === WebSocket.CONNECTING && pending.length < MAX_BUFFERED_CHUNKS) {
            pending.push(chunk);
        }
    };

    const release = () => {
        if (released) {
            return;
        }

        released = true;
        worklet.port.removeEventListener("message", onAudioFrame);
        worklet.port.close();

        for (const track of stream.getTracks()) {
            track.stop();
        }

        source.disconnect();
        worklet.disconnect();
        sink.disconnect();
        void audioContext.close().catch(() => undefined);

        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
            socket.close();
        }
    };

    const fail = (message: string) => {
        if (failed || released) {
            return;
        }

        // Once stopping, a late error (e.g. about the final empty commit) only
        // means there is nothing more to finalise.
        if (stopping) {
            resolveFinalCommit?.();

            return;
        }

        failed = true;
        release();
        callbacks.onError(message);
    };

    // addEventListener (unlike onmessage) does not start a MessagePort on its own.
    worklet.port.addEventListener("message", onAudioFrame);
    worklet.port.start();

    socket.addEventListener("open", () => {
        for (const chunk of pending) {
            socket.send(chunk);
        }

        pending.length = 0;
    });

    socket.addEventListener("message", (event: MessageEvent<string>) => {
        let data: ScribeServerMessage;

        try {
            data = JSON.parse(event.data) as ScribeServerMessage;
        } catch {
            return;
        }

        switch (data.message_type) {
            case "committed_transcript": {
                hasUncommitted = false;
                callbacks.onCommitted(data.text ?? "");
                resolveFinalCommit?.();
                break;
            }
            case "partial_transcript": {
                hasUncommitted = Boolean(data.text?.trim());
                callbacks.onPartial(data.text ?? "");
                break;
            }
            default: {
                if (data.message_type && ERROR_MESSAGE_TYPES.has(data.message_type)) {
                    fail(data.error ?? data.message ?? data.message_type);
                }
            }
        }
    });

    socket.addEventListener("error", () => fail("Connection to the transcription service failed"));
    socket.addEventListener("close", (event) => {
        if (released || failed) {
            return;
        }

        if (!event.wasClean) {
            fail("Connection to the transcription service was lost");

            return;
        }

        // A clean close while `stop()` finalises is that stop's own doing.
        if (stopping) {
            resolveFinalCommit?.();

            return;
        }

        release();
        callbacks.onEnd?.();
    });

    return {
        stop: async () => {
            if (released) {
                return;
            }

            stopping = true;
            // Stop capturing first so no audio lands after the commit.
            worklet.port.removeEventListener("message", onAudioFrame);

            for (const track of stream.getTracks()) {
                track.stop();
            }

            if (socket.readyState === WebSocket.OPEN && hasUncommitted) {
                const finalCommit = new Promise<void>((resolve) => {
                    resolveFinalCommit = resolve;
                    setTimeout(resolve, FINAL_COMMIT_TIMEOUT_MS);
                });

                socket.send(encodeChunk(new Float32Array(0), TARGET_SAMPLE_RATE, true));
                await finalCommit;
            }

            release();
        },
    };
};
