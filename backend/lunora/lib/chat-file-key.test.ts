import { describe, expect, it } from "vitest";

import { CHAT_FILE_KEY_IN_TEXT, chatFileKeyHash, isUniqueChatFileKey, isUniqueChatFileKeyFor, newChatFileKey } from "./chat-file-key";
import { storageKeyOf } from "./storage-ref";

const HASH = "c".repeat(64);
const LEGACY = `agent-files/${HASH}`;

describe("chat-file keys", () => {
    it("gives every upload of the same bytes its own key", () => {
        const first = newChatFileKey(HASH);
        const second = newChatFileKey(HASH);

        expect(first).not.toBe(second);
        expect(isUniqueChatFileKeyFor(first, HASH)).toBe(true);
        expect(isUniqueChatFileKeyFor(first, "d".repeat(64))).toBe(false);
    });

    it("reads the hash of both the per-upload and the old content-addressed form", () => {
        expect(chatFileKeyHash(newChatFileKey(HASH))).toBe(HASH);
        expect(chatFileKeyHash(LEGACY)).toBe(HASH);
        expect(chatFileKeyHash(`agent-files/${HASH}/not-a-uuid`)).toBeUndefined();
        expect(chatFileKeyHash("uploads/u/x")).toBeUndefined();
    });

    it("treats only the per-upload form as unshared", () => {
        expect(isUniqueChatFileKey(newChatFileKey(HASH))).toBe(true);
        expect(isUniqueChatFileKey(LEGACY)).toBe(false);
    });

    it("finds both forms whole in text", () => {
        const key = newChatFileKey(HASH);

        expect(`see storage:${key} and storage:${LEGACY}.`.match(CHAT_FILE_KEY_IN_TEXT)).toStrictEqual([key, LEGACY]);
    });

    it("recovers both forms from an unsigned storage URL", () => {
        const key = newChatFileKey(HASH);

        expect(storageKeyOf(`https://api.test/${key}`, ["https://api.test"])).toBe(key);
        expect(storageKeyOf(`https://api.test/${LEGACY}`, ["https://api.test"])).toBe(LEGACY);
    });
});
