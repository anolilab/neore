import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    currentUnlockProof,
    forgetAllUnlockProofs,
    isThreadLockedError,
    noteUnlockActivity,
    onUnlockExpired,
    rememberUnlockProof,
    UNLOCK_IDLE_MS,
    withUnlockProof,
    withUnlockProofBody,
} from "./unlock-proofs";

const NOW = 1_700_000_000_000;

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
});

afterEach(() => {
    forgetAllUnlockProofs();
    vi.useRealTimers();
});

describe("unlock proofs in memory", () => {
    it("forgets a proof at its expiry, and tells the listeners", () => {
        const expired = vi.fn();

        onUnlockExpired(expired);
        rememberUnlockProof("t1", "proof", NOW + 60_000, NOW);

        vi.advanceTimersByTime(60_000);

        expect(expired).toHaveBeenCalledWith("t1");
        expect(currentUnlockProof("t1")).toBeUndefined();
    });

    it("forgets a proof after the idle timeout", () => {
        const expired = vi.fn();

        onUnlockExpired(expired);
        rememberUnlockProof("t1", "proof", NOW + 10 * UNLOCK_IDLE_MS, NOW);

        vi.advanceTimersByTime(UNLOCK_IDLE_MS);

        expect(expired).toHaveBeenCalledWith("t1");
        expect(currentUnlockProof("t1")).toBeUndefined();
    });

    it("reading the proof does not count as activity; user input does", () => {
        const expired = vi.fn();

        onUnlockExpired(expired);
        rememberUnlockProof("t1", "proof", NOW + 10 * UNLOCK_IDLE_MS, NOW);

        vi.advanceTimersByTime(UNLOCK_IDLE_MS / 2);
        expect(currentUnlockProof("t1")).toBe("proof");

        noteUnlockActivity();
        vi.advanceTimersByTime(UNLOCK_IDLE_MS / 2 + 1000);
        expect(expired).not.toHaveBeenCalled();

        vi.advanceTimersByTime(UNLOCK_IDLE_MS);
        expect(expired).toHaveBeenCalledWith("t1");
    });

    it("adds the proof to args for the chat they name, and nothing else", () => {
        rememberUnlockProof("t1", "proof", NOW + 60_000);

        expect(withUnlockProof({ threadId: "t1", x: 1 })).toEqual({ threadId: "t1", unlockProof: "proof", x: 1 });
        expect(withUnlockProof({ chatId: "t1" })).toEqual({ chatId: "t1", unlockProof: "proof" });
        expect(withUnlockProof({ threadId: "t2" })).toEqual({ threadId: "t2" });
        expect(withUnlockProof({ other: true })).toEqual({ other: true });
        expect(withUnlockProof(undefined)).toBeUndefined();
    });

    it("adds the proof to a plain fetch body for the same chat", () => {
        rememberUnlockProof("t1", "proof", NOW + 60_000);

        expect(withUnlockProofBody({ prompt: "hi" }, "t1")).toEqual({ prompt: "hi", unlockProof: "proof" });
        expect(withUnlockProofBody({ prompt: "hi" }, "t2")).toEqual({ prompt: "hi" });
        expect(withUnlockProofBody({ prompt: "hi" }, undefined)).toEqual({ prompt: "hi" });
    });

    it("recognises the locked-chat refusal", () => {
        expect(isThreadLockedError({ data: { code: "THREAD_LOCKED" } })).toBe(true);
        expect(isThreadLockedError({ data: { code: "TOO_MANY_REQUESTS" } })).toBe(false);
        expect(isThreadLockedError(new Error("nope"))).toBe(false);
    });
});
