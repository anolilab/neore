import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { forgetAllUnlockProofs, rememberUnlockProof, useUnlockProof } from "@/lib/lunora/unlock-proofs";

import { deckQueryArgs } from "./use-presentation-data";

afterEach(() => {
    forgetAllUnlockProofs();
});

describe("opening a deck in a locked chat", () => {
    it("the deck reads carry the chat's proof once it is unlocked", () => {
        rememberUnlockProof("thread-1", "proof-1", Date.now() + 60_000);

        const { result } = renderHook(() => useUnlockProof("thread-1"));

        expect(deckQueryArgs("deck-1", result.current)).toEqual({ presentationId: "deck-1", unlockProof: "proof-1" });
    });

    it("the deck reads carry no proof for a chat that is still locked", () => {
        const { result } = renderHook(() => useUnlockProof("thread-1"));

        expect(deckQueryArgs("deck-1", result.current)).toEqual({ presentationId: "deck-1", unlockProof: undefined });
    });

    it("the open viewer re-renders the moment the unlock lands", () => {
        const { result } = renderHook(() => useUnlockProof("thread-1"));

        expect(result.current).toBeUndefined();

        act(() => {
            rememberUnlockProof("thread-1", "proof-2", Date.now() + 60_000);
        });

        expect(result.current).toBe("proof-2");
    });

    it("a proof for another chat does not open this deck", () => {
        rememberUnlockProof("thread-2", "proof-other", Date.now() + 60_000);

        const { result } = renderHook(() => useUnlockProof("thread-1"));

        expect(result.current).toBeUndefined();
    });
});
