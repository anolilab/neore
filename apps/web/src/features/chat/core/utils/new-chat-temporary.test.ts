import { describe, expect, it } from "vitest";

import { newChatTemporaryFields } from "./new-chat-temporary";

describe(newChatTemporaryFields, () => {
    it("is temporary when the user's default is on and nothing was picked", () => {
        expect(newChatTemporaryFields(null, true)).toStrictEqual({ temporary: true });
        expect(newChatTemporaryFields(undefined, true)).toStrictEqual({ temporary: true });
    });

    it("is permanent when the default is off and nothing was picked", () => {
        expect(newChatTemporaryFields(undefined, false)).toBeUndefined();
    });

    it("lets an explicit pick beat the default, both ways", () => {
        expect(newChatTemporaryFields({ isTempChat: false }, true)).toBeUndefined();
        expect(newChatTemporaryFields({ isTempChat: true, retentionHours: 72 }, false)).toStrictEqual({ retentionHours: 72, temporary: true });
    });
});
