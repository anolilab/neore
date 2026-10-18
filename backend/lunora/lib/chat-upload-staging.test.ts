import { describe, expect, it } from "vitest";

import { purposeOfStagingKey, stagingKeyFor, stagingPrefixFor, uploadStatePrefixFor } from "./chat-upload-staging";

const UPLOAD = "V1StGXR8_Z5jdHi6B-myT";

describe("staging keys", () => {
    it("spells a user id as one path segment, and refuses one that is not", () => {
        expect(stagingPrefixFor("user_1")).toBe("uploads/user_1/");
        expect(uploadStatePrefixFor("user_1")).toBe("upload-state/user_1/");

        for (const userId of ["", "a/b", "/", "uploads/x"]) {
            expect(() => stagingPrefixFor(userId)).toThrow("path segment");
            expect(() => uploadStatePrefixFor(userId)).toThrow("path segment");
            expect(() => stagingKeyFor(userId, UPLOAD)).toThrow("path segment");
        }
    });

    it("reads the purpose back from the key it was minted for", () => {
        expect(purposeOfStagingKey(stagingKeyFor("user_1", UPLOAD))).toBe("chat");
        expect(purposeOfStagingKey(stagingKeyFor("user_1", UPLOAD, "reference-media"))).toBe("reference-media");
    });
});
