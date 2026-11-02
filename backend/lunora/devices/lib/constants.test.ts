import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { MIN_DEVICE_PROTOCOL } from "./constants";

const REPORTED = /pub const BACKEND_PROTOCOL_VERSION: u32 = (\d+);/;

describe("device protocol floor", () => {
    it("is at or below the protocol the desktop reports to the backend, so no current build is called outdated", () => {
        const envelope = readFileSync(join(import.meta.dirname, "../../../../packages/device-core/src/envelope.rs"), "utf8");
        const reported = Number(REPORTED.exec(envelope)?.[1]);

        expect(Number.isSafeInteger(reported)).toBe(true);
        expect(MIN_DEVICE_PROTOCOL).toBeLessThanOrEqual(reported);
    });
});
