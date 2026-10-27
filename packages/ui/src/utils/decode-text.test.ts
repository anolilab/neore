import { describe, expect, it } from "vitest";

import { decodeTextBytes } from "./decode-text";

describe(decodeTextBytes, () => {
    it("decodes UTF-16LE from its byte-order mark, without the mark", () => {
        expect(decodeTextBytes(new Uint8Array([0xff, 0xfe, 0x61, 0x00, 0x2c, 0x00, 0x62, 0x00]))).toBe("a,b");
    });

    it("decodes UTF-16BE from its byte-order mark", () => {
        expect(decodeTextBytes(new Uint8Array([0xfe, 0xff, 0x00, 0x61, 0x00, 0x2c, 0x00, 0x62]))).toBe("a,b");
    });

    it("decodes UTF-8, with or without a UTF-8 byte-order mark", () => {
        expect(decodeTextBytes(new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x2c, 0x62]))).toBe("a,b");
        expect(decodeTextBytes(new TextEncoder().encode("a,€"))).toBe("a,€");
    });
});
