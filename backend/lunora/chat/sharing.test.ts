import { describe, expect, it } from "vitest";

import { api } from "../_generated/api";
// Statically imported. As a dynamic `await import(…)` inside the assertion this
// timed out at vitest's 5s default once the module graph grew — a timing
// sensitivity the test never needed.
import * as sharing from "./sharing";
import { compareStrings } from "../lib/collections";

describe("sharing API exports", () => {
    const expectedFunctions = {
        acceptThreadInvite: api.chat.sharing.acceptThreadInvite,
        createThreadInvite: api.chat.sharing.createThreadInvite,
        getPublicThread: api.chat.sharing.getPublicThread,
        getThreadAccess: api.chat.sharing.getThreadAccess,
        getThreadInvites: api.chat.sharing.getThreadInvites,
        getThreadShareToken: api.chat.sharing.getThreadShareToken,
        removeThreadAccess: api.chat.sharing.removeThreadAccess,
        resolveThreadShard: api.chat.sharing.resolveThreadShard,
        revokeThreadInvite: api.chat.sharing.revokeThreadInvite,
        toggleThreadVisibility: api.chat.sharing.toggleThreadVisibility,
    };

    // A Lunora reference is `{ __lunoraRef: "<flattened module>:<fn>" }`, not a
    // bare string.
    it("should export all sharing functions as Lunora function references", () => {
        for (const [name, handler] of Object.entries(expectedFunctions)) {
            const reference = handler as unknown as { __lunoraRef?: string };

            expect(reference, `sharing.${name} should be defined`).toBeDefined();
            expect(reference.__lunoraRef, `sharing.${name} should carry a reference`).toBe(`chat_sharing:${name}`);
        }
    });

    // Asserted against the MODULE, not `api.chat.sharing`. The generated api is a
    // Proxy (`anyApi`), so `Object.keys` on a namespace returns nothing — the
    // old count check compared 0 to 8 and would have "passed" only by accident.
    // The module's own exports are the real source of truth for what exists.
    it("should register every PUBLIC function", () => {
        // `checkThreadAccess` / `checkThreadAccessWithData` are `internalQuery`, so
        // they are reachable as `internal.chat.sharing.*` and never appear on the
        // public `api` surface this list tracks. Excluded by name rather than by
        // inspecting the builder, because a registration carries no runtime marker
        // for its visibility.
        // `getPublicThreadOwner` / `readPublicThread` are `getPublicThread`'s two
        // halves (docs/plans/per-user-sharding.md), `readThreadShareToken`
        // `getThreadShareToken`'s owner-shard read.
        const INTERNAL_ONLY = new Set(["checkThreadAccess", "checkThreadAccessWithData", "getPublicThreadOwner", "readPublicThread", "readThreadShareToken"]);
        const registered = Object.keys(sharing).filter((name) => !INTERNAL_ONLY.has(name));

        expect(registered.toSorted(compareStrings)).toEqual(Object.keys(expectedFunctions).toSorted(compareStrings));
    });
});
