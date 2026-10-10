import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

const publicDir = resolve(import.meta.dirname, "../public");

type Listener = (event: { waitUntil: (promise: Promise<unknown>) => void }) => void;

/** Runs a worker script against a fake `self`, returning its listeners. */
const loadWorkerScript = (file: string, scope: Record<string, unknown>): Map<string, Listener> => {
    const listeners = new Map<string, Listener>();
    const self = {
        ...scope,
        addEventListener: (type: string, listener: Listener) => {
            listeners.set(type, listener);
        },
    };

    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func -- evaluating the shipped worker file as-is
    new Function("self", readFileSync(resolve(publicDir, file), "utf8"))(self);

    return listeners;
};

describe("sw-cache-cleanup.js", () => {
    it("deletes the legacy per-user runtime caches on activate, inside waitUntil", async () => {
        const deleted: string[] = [];
        const caches = {
            delete: vi.fn(async (name: string) => {
                deleted.push(name);

                return true;
            }),
        };
        const listeners = loadWorkerScript("sw-cache-cleanup.js", { caches });
        const activate = listeners.get("activate");

        expect(activate).toBeDefined();

        const waited: Promise<unknown>[] = [];

        activate?.({ waitUntil: (promise) => waited.push(promise) });

        expect(waited).toHaveLength(1);

        await Promise.all(waited);

        expect(deleted.toSorted()).toStrictEqual(["api-cache", "convex-http-cache", "navigation-cache"]);
    });

    it("is imported by the generated service worker", () => {
        const script = readFileSync(resolve(import.meta.dirname, "generate-sw.mjs"), "utf8");

        expect(script).toMatch(/importScripts: \[[^\]]*"sw-cache-cleanup\.js"/u);
    });
});

describe("generate-sw.mjs navigations", () => {
    it("never runtime-caches navigations, and falls back to the precached offline page", () => {
        const script = readFileSync(resolve(import.meta.dirname, "generate-sw.mjs"), "utf8");

        expect(script).not.toContain('cacheName: "navigation-cache"');
        expect(script).toMatch(/handler: "NetworkOnly",\s*options: \{\s*precacheFallback: \{ fallbackURL: OFFLINE_FALLBACK_URL \}/u);
        expect(script).toContain('const OFFLINE_FALLBACK_URL = "/offline.html"');
        expect(readFileSync(resolve(publicDir, "offline.html"), "utf8")).not.toMatch(/<script/iu);
    });
});
