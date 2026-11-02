import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { MIN_DEVICE_PROTOCOL } from "./constants";

describe("device protocol floor", () => {
    it("is the protocol the Rust host speaks now, so no current build is called outdated", () => {
        const host = readFileSync(join(import.meta.dirname, "../../../../packages/device-core/src/host.rs"), "utf8");

        expect(host).toContain(`pub const PROTOCOL_VERSION: u32 = ${MIN_DEVICE_PROTOCOL};`);
    });
});
