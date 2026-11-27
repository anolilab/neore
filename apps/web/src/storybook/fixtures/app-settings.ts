import { api } from "@neore/backend/api";

import { DAY, HOUR, STORY_NOW as NOW } from "../clock";
import type { LunoraFixture } from "../lunora";
import { lunora } from "../lunora";
import { OWNER } from "./owner";

/** A row id: fixtures carry plain strings where the generated types ask for a table's branded id. */
const rowId = (value: string): never => value as never;

const CREATED = NOW - 40 * DAY;

/** The system prompt presets the presets tab lists, newest first. */
export const PRESETS = [
    {
        _creationTime: CREATED,
        _id: rowId("preset_json"),
        createdAt: NOW - 20 * DAY,
        description: "Answers only in valid JSON that matches the schema it is given.",
        modelId: "openai/gpt-5",
        name: "Strict JSON coder",
        prompt: "You are a code generator. Reply with one JSON object and nothing else. Never add commentary.",
        updatedAt: NOW - 2 * DAY,
    },
    {
        _creationTime: CREATED,
        _id: rowId("preset_review"),
        createdAt: NOW - 30 * DAY,
        description: "A blunt reviewer that lists bugs first and style last.",
        modelId: null,
        name: "Code reviewer",
        prompt: "Review the change like a senior engineer. List correctness problems first, then risks, then style. Quote the line you mean.",
        updatedAt: NOW - 9 * DAY,
    },
    {
        _creationTime: CREATED,
        _id: rowId("preset_translate"),
        createdAt: NOW - 35 * DAY,
        description: null,
        modelId: null,
        name: "Translator",
        prompt: "Translate the user's text into the language they name. Keep names, numbers and formatting unchanged.",
        updatedAt: NOW - 20 * DAY,
    },
];

/** The knowledge base's collections and files. */
export const COLLECTIONS = [
    {
        _id: rowId("collection_product"),
        description: "Specs and release notes",
        createdAt: NOW - 30 * DAY,
        isOwner: true,
        name: "Product docs",
        shared: false,
        updatedAt: NOW - 3 * DAY,
    },
    { _id: rowId("collection_legal"), createdAt: NOW - 30 * DAY, isOwner: true, name: "Contracts", shared: false, updatedAt: NOW - 30 * DAY },
];

export const KNOWLEDGE_FILES = [
    {
        _creationTime: CREATED,
        _id: rowId("file_spec"),
        chunkCount: 42,
        collectionId: COLLECTIONS[0]?._id,
        createdAt: NOW - 3 * DAY,
        mimeType: "application/pdf",
        name: "Product spec v3.pdf",
        relativePath: undefined,
        size: 1_840_000,
        sourceUrl: undefined,
        status: "indexed",
        summary: "Scope, milestones and open questions for the v3 release.",
        userId: OWNER,
    },
    {
        _creationTime: CREATED,
        _id: rowId("file_notes"),
        chunkCount: 11,
        collectionId: COLLECTIONS[0]?._id,
        createdAt: NOW - 2 * DAY,
        mimeType: "text/markdown",
        name: "Release notes.md",
        relativePath: "docs/Release notes.md",
        size: 24_500,
        sourceUrl: undefined,
        status: "indexed",
        userId: OWNER,
    },
    {
        _creationTime: CREATED,
        _id: rowId("file_url"),
        chunkCount: undefined,
        collectionId: undefined,
        createdAt: NOW - HOUR,
        mimeType: "text/html",
        name: "Pricing page",
        size: 0,
        sourceUrl: "https://example.com/pricing",
        status: "processing",
        userId: OWNER,
    },
    {
        _creationTime: CREATED,
        _id: rowId("file_broken"),
        chunkCount: undefined,
        collectionId: undefined,
        createdAt: NOW - DAY,
        error: "The file is password protected.",
        mimeType: "application/pdf",
        name: "Signed contract.pdf",
        size: 310_000,
        status: "failed",
        userId: OWNER,
    },
];

/** What the memory section lists: one of every kind of row it draws. */
export const MEMORIES = [
    {
        _creationTime: CREATED,
        _id: rowId("memory_name"),
        createdAt: NOW - 30 * DAY,
        fromBot: false,
        hasEvidence: true,
        lastConfirmedAt: NOW - 2 * DAY,
        memory: "Works as a product designer in Berlin and prefers metric units.",
        pinned: true,
        source: "auto",
        threadId: undefined,
        type: "identity" as const,
    },
    {
        _creationTime: CREATED,
        _id: rowId("memory_trip"),
        createdAt: NOW - 6 * DAY,
        eventEnd: "2026-11-14",
        eventStart: "2026-11-10",
        fromBot: false,
        hasEvidence: false,
        lastConfirmedAt: NOW - 6 * DAY,
        memory: "Travels to Lisbon for a design conference.",
        pinned: false,
        source: "reflection",
        type: "activity" as const,
    },
    {
        _creationTime: CREATED,
        _id: rowId("memory_style"),
        createdAt: NOW - 12 * DAY,
        fromBot: false,
        hasEvidence: false,
        lastConfirmedAt: NOW - 5 * HOUR,
        memory: "Likes short answers with the conclusion first.",
        pinned: false,
        source: "manual",
        type: "preference" as const,
    },
    {
        _creationTime: CREATED,
        _id: rowId("memory_import"),
        createdAt: NOW - 20 * DAY,
        fromBot: false,
        hasEvidence: false,
        importedFrom: "chatgpt" as const,
        lastConfirmedAt: NOW - 20 * DAY,
        memory: "Writes TypeScript with React and runs everything on Cloudflare.",
        pinned: false,
        source: "imported",
        type: "context" as const,
    },
];

/** The notification push endpoints: configured, with nothing subscribed here. */
const pushFixtures = (): LunoraFixture[] => [
    lunora(api.notifications.push.getPushConfig, {
        publicKey: "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U",
        subscriptionCount: 0,
    }),
    lunora(api.notifications.push.getPushSubscriptionStatus, { subscribed: false }),
];

/**
 * What the app group's tabs read beyond the user rows: presets, the knowledge base, memories and push. Spread after
 * `userFixtures()`.
 */
export const appSettingsFixtures = (options: { memories?: typeof MEMORIES } = {}): LunoraFixture[] => {
    const memories = options.memories ?? MEMORIES;

    return [
        lunora(api.system_prompts.functions.listPresets, PRESETS),
        lunora(api.knowledge.functions.listFiles, KNOWLEDGE_FILES),
        lunora(api.knowledge.collections.listCollections, COLLECTIONS),
        lunora(api.memory.functions.listUserMemories, memories),
        lunora(api.memory.functions.getMemoryStats, () => {
            const byType: Record<string, number> = {};

            for (const memory of memories) {
                byType[memory.type] = (byType[memory.type] ?? 0) + 1;
            }

            return { byType, pinned: memories.filter((memory) => memory.pinned).length, total: memories.length };
        }),
        lunora(api.memory.reflection.getLatestMemoryDigest, {
            _id: rowId("digest_today"),
            createdAt: NOW - 8 * HOUR,
            learned: [{ memory: "Likes short answers with the conclusion first.", memoryId: rowId("memory_style"), type: "preference" }],
            localDay: "2026-11-05",
            stats: { contradictionsResolved: 0, decayed: 1, merged: 2, newMemories: 3, promoted: 1, retired: 0 },
            summary: "You asked for shorter answers twice, so that preference is now pinned in your notes.",
        }),
        ...pushFixtures(),
    ];
};

/** The tab's own user settings: memory on, a few favourites with nicknames, one retired nickname. */
export const APP_SETTINGS = {
    favoriteModels: ["anthropic/claude-sonnet-4.5", "google/gemini-2.5-flash", "openai/gpt-5"],
    memoryEnabled: true,
    modelNicknames: { "anthropic/claude-sonnet-4.5": "Sonnet", "cf-llama-4-scout": "Scout", "retired/old-model": "Old reliable" },
    nickname: "Dani",
    profession: "Product designer",
    aboutMe: "I design interfaces for developer tools and work from Berlin.",
    customInstructions: "Answer in short paragraphs and put the conclusion first.",
    threadTitleInstructions: "Keep titles under four words.",
};
