/**
 * Audio provider factory.
 *
 * Creates AI SDK speech and transcription model instances for each supported provider.
 */
import type { SpeechModelV4, TranscriptionModelV4 } from "@ai-sdk/provider";

import { GatewayError } from "../lib/errors.js";

/** TTS model metadata */
export interface TtsModelInfo {
    /** Cost per 1,000 characters in microdollars */
    costPer1KCharsMicrodollars: number;
    modelApiId: string;
    provider: "openai";
}

/** STT model metadata */
export interface SttModelInfo {
    /** Cost per minute of audio in microdollars */
    costPerMinuteMicrodollars: number;
    modelApiId: string;
    provider: "groq" | "openai";
}

export const TTS_MODELS: Record<string, TtsModelInfo> = {
    "gpt-4o-mini-tts": { costPer1KCharsMicrodollars: 6000, modelApiId: "gpt-4o-mini-tts", provider: "openai" },
    "tts-1": { costPer1KCharsMicrodollars: 15_000, modelApiId: "tts-1", provider: "openai" },
    "tts-1-hd": { costPer1KCharsMicrodollars: 30_000, modelApiId: "tts-1-hd", provider: "openai" },
};

export const STT_MODELS: Record<string, SttModelInfo> = {
    "gpt-4o-mini-transcribe": { costPerMinuteMicrodollars: 3000, modelApiId: "gpt-4o-mini-transcribe", provider: "openai" },
    "gpt-4o-transcribe": { costPerMinuteMicrodollars: 6000, modelApiId: "gpt-4o-transcribe", provider: "openai" },
    // OpenAI Whisper
    "whisper-1": { costPerMinuteMicrodollars: 6000, modelApiId: "whisper-1", provider: "openai" },
    // Groq Whisper — much faster and cheaper
    "whisper-large-v3": { costPerMinuteMicrodollars: 111, modelApiId: "whisper-large-v3", provider: "groq" },
    "whisper-large-v3-turbo": { costPerMinuteMicrodollars: 40, modelApiId: "whisper-large-v3-turbo", provider: "groq" },
};

/**
 * Create an AI SDK speech model instance for the given provider and model.
 */
export const createSpeechModel = async (provider: string, modelApiId: string, apiKey: string): Promise<SpeechModelV4> => {
    if (provider !== "openai") {
        throw new GatewayError("PROVIDER_NOT_CONFIGURED", `Unsupported TTS provider: ${provider}`);
    }

    const { createOpenAI } = await import("@ai-sdk/openai");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return createOpenAI({ apiKey }).speech(modelApiId as any);
};

/**
 * Create an AI SDK transcription model instance for the given provider and model.
 */
export const createTranscriptionModel = async (provider: string, modelApiId: string, apiKey: string): Promise<TranscriptionModelV4> => {
    switch (provider) {
        case "groq": {
            const { createGroq } = await import("@ai-sdk/groq");

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return createGroq({ apiKey }).transcription(modelApiId as any);
        }
        case "openai": {
            const { createOpenAI } = await import("@ai-sdk/openai");

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return createOpenAI({ apiKey }).transcription(modelApiId as any);
        }
        default: {
            throw new GatewayError("PROVIDER_NOT_CONFIGURED", `Unsupported STT provider: ${provider}`);
        }
    }
};
