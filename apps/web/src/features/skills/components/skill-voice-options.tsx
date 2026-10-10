"use client";

import type { FC } from "react";
import { useSyncExternalStore } from "react";

import { SPEECH_VOICES, speechVoiceLabel } from "@/features/chat/voice-mode/tts-availability";

interface VoiceOption {
    lang: string;
    name: string;
}

const EMPTY: VoiceOption[] = [];
const cache: { voices: VoiceOption[] } = { voices: EMPTY };

const isSupported = (): boolean => "speechSynthesis" in globalThis;

const readVoices = (): VoiceOption[] =>
    globalThis.speechSynthesis.getVoices().map((voice) => {
        return { lang: voice.lang, name: voice.name };
    });

const subscribe = (onChange: () => void): (() => void) => {
    if (!isSupported()) {
        return () => {};
    }

    const update = () => {
        cache.voices = readVoices();
        onChange();
    };

    globalThis.speechSynthesis.addEventListener("voiceschanged", update);

    return () => globalThis.speechSynthesis.removeEventListener("voiceschanged", update);
};

/** Stable between changes: re-read only while nothing has loaded yet (Firefox never fires `voiceschanged` for a list it already has). */
const getSnapshot = (): VoiceOption[] => {
    if (cache.voices.length === 0 && isSupported()) {
        const voices = readVoices();

        if (voices.length > 0) {
            cache.voices = voices;
        }
    }

    return cache.voices;
};

const getServerSnapshot = (): VoiceOption[] => EMPTY;

/**
 * `<datalist>` suggestions for a skill's voice field: the hands-free TTS
 * presets, then the voices this browser can speak with. Any value is still
 * accepted — a browser voice is resolved on the device that reads the reply,
 * where other voices may exist.
 */
const SkillVoiceOptions: FC<{ id: string }> = ({ id }) => {
    const voices = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

    return (
        <datalist id={id}>
            {SPEECH_VOICES.map((voice) => (
                <option key={voice} value={voice}>
                    {speechVoiceLabel(voice)}
                </option>
            ))}
            {voices.map((voice) => (
                <option key={`${voice.name}-${voice.lang}`} value={voice.name}>
                    {voice.lang}
                </option>
            ))}
        </datalist>
    );
};

export default SkillVoiceOptions;
