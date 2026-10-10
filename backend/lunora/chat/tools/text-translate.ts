/**
 * Text Translate Tool
 * Translate text between languages using AI
 */
import z from "zod/v4";

import type { ToolCtx as ToolContext } from "../../agent/client";
import { createTool } from "../../agent/client";

/**
 * Common language codes with names
 */
const SUPPORTED_LANGUAGES: Record<string, string> = {
    ar: "Arabic",
    bg: "Bulgarian",
    cs: "Czech",
    da: "Danish",
    de: "German",
    el: "Greek",
    en: "English",
    es: "Spanish",
    fi: "Finnish",
    fr: "French",
    he: "Hebrew",
    hi: "Hindi",
    hu: "Hungarian",
    id: "Indonesian",
    it: "Italian",
    ja: "Japanese",
    ko: "Korean",
    ms: "Malay",
    nl: "Dutch",
    no: "Norwegian",
    pl: "Polish",
    pt: "Portuguese",
    ro: "Romanian",
    ru: "Russian",
    sv: "Swedish",
    th: "Thai",
    tr: "Turkish",
    uk: "Ukrainian",
    vi: "Vietnamese",
    zh: "Chinese",
};

/**
 * Get language name from code.
 */
const getLanguageName = (code: string): string => SUPPORTED_LANGUAGES[code.toLowerCase()] ?? code;

/**
 * Text Translate Tool
 * Note: This tool provides the translation interface but relies on the AI model
 * for the actual translation. The tool returns the translation request which
 * the model should process.
 */
export const textTranslateTool = createTool<
    {
        sourceLanguage?: string;
        targetLanguage: string;
        text: string;
    },
    {
        supportedLanguages: Record<string, string>;
        translationRequest: {
            sourceLanguage?: string;
            sourceLanguageName?: string;
            targetLanguage: string;
            targetLanguageName: string;
            text: string;
        };
    },
    ToolContext
>({
    description: `Translate text from one language to another. Supports major world languages.
The model should perform the translation based on the request returned by this tool.
Supported language codes: ${Object.keys(SUPPORTED_LANGUAGES).join(", ")}`,
    execute: async (_context, input) => {
        const { sourceLanguage, targetLanguage, text } = input;

        return {
            supportedLanguages: SUPPORTED_LANGUAGES,
            translationRequest: {
                sourceLanguage: sourceLanguage?.toLowerCase(),
                sourceLanguageName: sourceLanguage ? getLanguageName(sourceLanguage) : undefined,
                targetLanguage: targetLanguage.toLowerCase(),
                targetLanguageName: getLanguageName(targetLanguage),
                text,
            },
        };
    },
    inputSchema: z
        .object({
            sourceLanguage: z.string().min(2).max(5).optional().meta({ description: "Source language code (optional, will be auto-detected if not provided)" }),
            targetLanguage: z.string().min(2).max(5).meta({ description: "Target language code (ISO 639-1, e.g., 'en', 'es', 'fr', 'de', 'zh', 'ja')" }),
            text: z.string().min(1).max(10_000).meta({ description: "Text to translate" }),
        })
        .strict(),
    title: "Text Translate",
    toModelOutput: (_context, { output }) => {
        const { translationRequest } = output;
        const sourceLang = translationRequest.sourceLanguageName ?? "the source language (auto-detect)";

        return {
            type: "text" as const,
            value: `Please translate the following text from ${sourceLang} to ${translationRequest.targetLanguageName}:\n\n"${translationRequest.text}"\n\nProvide only the translated text without any additional explanation.`,
        };
    },
});

/**
 * List Supported Languages Tool
 */
export const listLanguagesTool = createTool<
    Record<string, never>,
    {
        count: number;
        languages: { code: string; name: string }[];
    },
    ToolContext
>({
    description: "Get a list of all supported language codes for translation.",
    execute: async () => {
        const languages = Object.entries(SUPPORTED_LANGUAGES).map(([code, name]) => {
            return {
                code,
                name,
            };
        });

        return {
            count: languages.length,
            languages,
        };
    },
    inputSchema: z.object({}).strict(),
    title: "List Languages",
});
