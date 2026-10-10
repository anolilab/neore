/**
 * Speaks a reply: with the registry TTS model when the caller passes `tts`
 * (`voice_speech.synthesizeSpeech` — metered, nothing saved to the thread),
 * and with the browser's `speechSynthesis` otherwise or whenever TTS fails.
 *
 * TTS cannot stream (FAL renders the whole clip before answering), so the reply
 * is synthesised in pieces: a short first one so speaking starts after one
 * short round trip, then larger ones, each fetched while the previous plays.
 * A piece that fails to arrive or to play hands the REST of the reply to the
 * browser voice, so a reply is never cut off and never spoken twice.
 *
 * Only one reply speaks at a time: starting one cancels the last, and
 * `stopReplySpeech()` cancels whatever is speaking (the "Read aloud" button
 * calls it). The browser engine additionally cancels any `speechSynthesis`
 * queue, including a "Read aloud" in progress, whose own state clears on the
 * `error` event `cancel()` fires.
 */

import { splitForSpeech, toSpeakableText } from "@/features/chat/thread/read-aloud-text";

import { pickVoice } from "./reply-speech";

/** One TTS round trip: plain text in, base64 audio out (`voice_speech.synthesizeSpeech`). */
export type Synthesize = (request: { text: string; voice?: string }) => Promise<{ audio: string; mimeType: string }>;

export interface TtsOptions {
    /** Told why TTS gave way to the browser voice for (the rest of) a reply. */
    onUnavailable?: (error: unknown) => void;
    synthesize: Synthesize;
    /** A preset voice of the speech model. */
    voice?: string;
}

export interface SpeakOptions {
    /** Language of the reply, when known (thread language). */
    lang?: string;
    /** Registry TTS; without it the browser voice speaks. */
    tts?: TtsOptions;
    /** A browser voice NAME or BCP 47 tag — a skill's `config.voice`. */
    voice?: string;
}

export interface SpeechHandle {
    cancel: () => void;
    /** Resolves when the text finished speaking, was cancelled, or failed. */
    done: Promise<void>;
}

/** The first piece is short so speaking starts quickly; the rest are larger to keep round trips down. */
export const TTS_FIRST_CHUNK_CHARS = 200;
/** Under the backend's per-call cap (`MAX_SPEECH_CHARS`, 1,000). */
export const TTS_CHUNK_CHARS = 800;

export const isSpeechSynthesisSupported = (): boolean =>
    globalThis.window !== undefined && "speechSynthesis" in globalThis && "SpeechSynthesisUtterance" in globalThis;

const isAudioSupported = (): boolean => typeof Audio === "function" && typeof URL.createObjectURL === "function";

/** Voices load asynchronously in Chromium; wait briefly for the first list. */
const loadVoices = async (): Promise<SpeechSynthesisVoice[]> => {
    const voices = globalThis.speechSynthesis.getVoices();

    if (voices.length > 0) {
        return voices;
    }

    return await new Promise((resolve) => {
        const timer: { id?: ReturnType<typeof setTimeout> } = {};
        const finish = () => {
            globalThis.speechSynthesis.removeEventListener("voiceschanged", finish);
            clearTimeout(timer.id);
            resolve(globalThis.speechSynthesis.getVoices());
        };

        timer.id = setTimeout(finish, 1000);
        globalThis.speechSynthesis.addEventListener("voiceschanged", finish);
    });
};

const RESOLVED: SpeechHandle = { cancel: () => {}, done: Promise.resolve() };

/** A handle whose `done` settles once, from `finish()` or `cancel()`. */
const createHandle = (onCancel: () => void): SpeechHandle & { finish: () => void; isCancelled: () => boolean } => {
    let cancelled = false;
    const settlers: (() => void)[] = [];
    const done = new Promise<void>((resolve) => {
        settlers.push(resolve);
    });
    const settle = () => {
        for (const resolve of settlers) {
            resolve();
        }
    };

    return {
        cancel: () => {
            if (cancelled) {
                return;
            }

            cancelled = true;
            onCancel();
            settle();
        },
        done,
        finish: () => {
            settle();
        },
        isCancelled: () => cancelled,
    };
};

/** Speaks `chunks` (already plain text) with `speechSynthesis`. */
const speakWithBrowser = (chunks: ReadonlyArray<string>, options: Pick<SpeakOptions, "lang" | "voice">): SpeechHandle => {
    if (!isSpeechSynthesisSupported() || chunks.length === 0) {
        return RESOLVED;
    }

    const handle = createHandle(() => globalThis.speechSynthesis.cancel());

    globalThis.speechSynthesis.cancel();

    const queue = async (): Promise<void> => {
        const voices = await loadVoices();

        if (handle.isCancelled()) {
            return;
        }

        const voice = pickVoice(voices, options.voice, options.lang);

        chunks.forEach((chunk, index) => {
            const utterance = new SpeechSynthesisUtterance(chunk);

            if (voice) {
                utterance.voice = voice;
                utterance.lang = voice.lang;
            } else if (options.lang) {
                utterance.lang = options.lang;
            }

            // Any chunk failing (incl. `cancel()`, which fires `error` with
            // "interrupted") ends the whole reply.
            utterance.addEventListener("error", handle.finish);

            if (index === chunks.length - 1) {
                utterance.addEventListener("end", handle.finish);
            }

            globalThis.speechSynthesis.speak(utterance);
        });
    };

    void queue();

    return handle;
};

/** Plain text → TTS pieces: a short first one, then pieces up to {@link TTS_CHUNK_CHARS}. */
export const splitForTts = (text: string): string[] => {
    const [first, ...others] = splitForSpeech(text, TTS_FIRST_CHUNK_CHARS);

    if (first === undefined) {
        return [];
    }

    return [first, ...splitForSpeech(others.join(" "), TTS_CHUNK_CHARS)].map((chunk) => chunk.slice(0, TTS_CHUNK_CHARS));
};

const toObjectUrl = ({ audio, mimeType }: { audio: string; mimeType: string }): string => {
    const bytes = Uint8Array.from(atob(audio), (char) => char.codePointAt(0) ?? 0);

    return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
};

/** Speaks `chunks` with the registry TTS, handing whatever is left to the browser voice on the first failure. */
const speakWithTts = (chunks: ReadonlyArray<string>, options: SpeakOptions & { tts: TtsOptions }): SpeechHandle => {
    if (chunks.length === 0) {
        return RESOLVED;
    }

    const urls = new Set<string>();
    const playing: { audio?: HTMLAudioElement; fallback?: SpeechHandle; stop?: () => void } = {};
    const handle = createHandle(() => {
        playing.audio?.pause();
        playing.stop?.();
        playing.fallback?.cancel();

        for (const url of urls) {
            URL.revokeObjectURL(url);
        }

        urls.clear();
    });

    const fetchChunk = (index: number): Promise<string> => {
        const pending = options.tts.synthesize({ text: chunks[index] ?? "", voice: options.tts.voice }).then((result) => {
            const url = toObjectUrl(result);

            // A piece that lands after `cancel()` is dropped straight away.
            if (handle.isCancelled()) {
                URL.revokeObjectURL(url);
            } else {
                urls.add(url);
            }

            return url;
        });

        // Prefetched pieces are awaited later, or never once cancelled.
        pending.catch(() => undefined);

        return pending;
    };

    const play = async (url: string): Promise<void> =>
        await new Promise<void>((resolve, reject) => {
            const audio = new Audio(url);

            playing.audio = audio;
            playing.stop = resolve;
            audio.addEventListener("ended", () => resolve());
            audio.addEventListener("error", () => reject(new Error("Audio playback failed")));
            audio.play().catch(reject);
        });

    const run = async (): Promise<void> => {
        let next: Promise<string> | undefined = fetchChunk(0);

        for (let index = 0; index < chunks.length && next; index += 1) {
            try {
                const url: string = await next;

                if (handle.isCancelled()) {
                    return;
                }

                next = index + 1 < chunks.length ? fetchChunk(index + 1) : undefined;
                await play(url);
                URL.revokeObjectURL(url);
                urls.delete(url);
            } catch (error) {
                if (handle.isCancelled()) {
                    return;
                }

                options.tts.onUnavailable?.(error);
                // Re-split: a TTS piece is longer than Chrome speaks in one utterance.
                playing.fallback = speakWithBrowser(splitForSpeech(chunks.slice(index).join(" ")), options);
                await playing.fallback.done;

                return;
            }

            if (handle.isCancelled()) {
                return;
            }
        }
    };

    // Stop a "Read aloud" (or any browser speech) before the first piece plays.
    if (isSpeechSynthesisSupported()) {
        globalThis.speechSynthesis.cancel();
    }

    void run().finally(handle.finish);

    return handle;
};

const current: { handle: SpeechHandle | null } = { handle: null };

/** Cancels whatever reply is speaking. */
export const stopReplySpeech = (): void => {
    current.handle?.cancel();
    current.handle = null;
};

/** Speaks `markdown` with code, links and formatting stripped. */
export const speakReply = (markdown: string, options: SpeakOptions = {}): SpeechHandle => {
    stopReplySpeech();

    const text = toSpeakableText(markdown);
    const handle =
        options.tts && isAudioSupported() ? speakWithTts(splitForTts(text), { ...options, tts: options.tts }) : speakWithBrowser(splitForSpeech(text), options);

    current.handle = handle;
    void handle.done.finally(() => {
        if (current.handle === handle) {
            current.handle = null;
        }
    });

    return handle;
};
