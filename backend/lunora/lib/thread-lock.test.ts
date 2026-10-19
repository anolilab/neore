import { describe, expect, it } from "vitest";

import {
    isAcceptablePasscode,
    isThreadLocked,
    hashPasscode,
    mintUnlockProof,
    newPasscodeEpoch,
    PASSCODE_PBKDF2_ITERATIONS,
    toLockedThreadStub,
    UNLOCK_PROOF_TTL_MS,
    verifyPasscode,
    verifyUnlockProof,
} from "./thread-lock";

const SECRET = "s".repeat(40);
const NOW = 1_700_000_000_000;
const scope = { epoch: "epoch-1", threadId: "thread-1", userId: "user-1" };
const LEAKED_FIELD = /salary|private|secret|token|work/;

describe("passcode hashing", () => {
    it("verifies the right passcode and rejects a wrong one", async () => {
        const stored = await hashPasscode("correct horse", 1000);

        expect(await verifyPasscode("correct horse", stored)).toBe(true);
        expect(await verifyPasscode("correct hors", stored)).toBe(false);
        expect(await verifyPasscode("", stored)).toBe(false);
    });

    it("never stores the plaintext and salts every hash", async () => {
        const first = await hashPasscode("same passcode", 1000);
        const second = await hashPasscode("same passcode", 1000);

        expect(JSON.stringify(first)).not.toContain("same passcode");
        expect(first.salt).not.toBe(second.salt);
        expect(first.hash).not.toBe(second.hash);
    });

    it("records the iteration count with the hash", async () => {
        const stored = await hashPasscode("abcdef");

        expect(stored.iterations).toBe(PASSCODE_PBKDF2_ITERATIONS);
        expect(PASSCODE_PBKDF2_ITERATIONS).toBeLessThanOrEqual(1_000_000);
    });

    it("gates passcode length", () => {
        expect(isAcceptablePasscode("12345")).toBe(false);
        expect(isAcceptablePasscode("123456")).toBe(true);
        expect(isAcceptablePasscode("x".repeat(201))).toBe(false);
    });
});

describe("unlock proofs", () => {
    it("verifies a fresh proof for its own thread, user and epoch", async () => {
        const { proof } = await mintUnlockProof(scope, SECRET, NOW);

        expect(await verifyUnlockProof(proof, scope, SECRET, NOW)).toBe(true);
    });

    it("refuses an expired proof", async () => {
        const { expiresAt, proof } = await mintUnlockProof(scope, SECRET, NOW);

        expect(await verifyUnlockProof(proof, scope, SECRET, expiresAt + 1)).toBe(false);
        expect(expiresAt).toBe(NOW + UNLOCK_PROOF_TTL_MS);
    });

    it("refuses a proof from an older epoch (change, re-lock, removal)", async () => {
        const { proof } = await mintUnlockProof(scope, SECRET, NOW);

        expect(await verifyUnlockProof(proof, { ...scope, epoch: newPasscodeEpoch() }, SECRET, NOW)).toBe(false);
    });

    it("refuses a proof moved to another thread or user", async () => {
        const { proof } = await mintUnlockProof(scope, SECRET, NOW);

        expect(await verifyUnlockProof(proof, { ...scope, threadId: "thread-2" }, SECRET, NOW)).toBe(false);
        expect(await verifyUnlockProof(proof, { ...scope, userId: "user-2" }, SECRET, NOW)).toBe(false);
    });

    it("refuses a forged signature, another secret, and malformed input", async () => {
        const { proof } = await mintUnlockProof(scope, SECRET, NOW);
        const forged = proof.slice(0, -1) + (proof.endsWith("0") ? "1" : "0");

        expect(await verifyUnlockProof(forged, scope, SECRET, NOW)).toBe(false);
        expect(await verifyUnlockProof(proof, scope, "t".repeat(40), NOW)).toBe(false);
        expect(await verifyUnlockProof(undefined, scope, SECRET, NOW)).toBe(false);
        expect(await verifyUnlockProof("not:a:proof", scope, SECRET, NOW)).toBe(false);
        expect(await verifyUnlockProof(proof, scope, "", NOW)).toBe(false);
    });

    it("refuses to mint without a secret or with a ':' in an id", async () => {
        await expect(mintUnlockProof(scope, "", NOW)).rejects.toThrow();
        await expect(mintUnlockProof({ ...scope, threadId: "a:b" }, SECRET, NOW)).rejects.toThrow();
    });
});

describe("locked thread projection", () => {
    it("reports lock state from lockedAt", () => {
        expect(isThreadLocked({ lockedAt: NOW })).toBe(true);
        expect(isThreadLocked({})).toBe(false);
        expect(isThreadLocked({ lockedAt: null })).toBe(false);
    });

    it("drops the title, summary, tags, share token and prompt from the stub", () => {
        const stub = toLockedThreadStub({
            _creationTime: 1,
            _id: "t1",
            category: "work",
            customSystemPrompt: "secret",
            lockedAt: NOW,
            projectId: "p1",
            publicAccessToken: "token",
            status: "active",
            summary: "private",
            tags: ["x"],
            title: "Quarterly salary plan",
        });

        expect(stub).toEqual({ _creationTime: 1, _id: "t1", lockedAt: NOW, status: "active" });
        expect(JSON.stringify(stub)).not.toMatch(LEAKED_FIELD);
    });
});
