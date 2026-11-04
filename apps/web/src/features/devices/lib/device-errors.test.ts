import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { clearConnectionErrors, clearDeviceErrors, clearServiceErrors, recordDeviceError, useDeviceErrors } from "./device-errors";

const read = () => renderHook(() => useDeviceErrors("d1")).result.current;

describe("device errors", () => {
    beforeEach(() => {
        clearDeviceErrors("d1");
    });

    it("drops only a repeat of the very same failure", () => {
        recordDeviceError("d1", "refused", { kind: "connection" });
        recordDeviceError("d1", "refused", { kind: "connection" });

        expect(read()).toHaveLength(1);
    });

    it("keeps a newer failure whose text matches but whose kind differs, and a clearing of one kind leaves the other", () => {
        recordDeviceError("d1", "Same words", { kind: "connection" });
        recordDeviceError("d1", "Same words", { kind: "service" });

        expect(read().map((error) => error.kind)).toEqual(["connection", "service"]);

        clearConnectionErrors("d1");

        expect(read().map((error) => error.kind)).toEqual(["service"]);
    });

    it("clears a refusal of the tool list and leaves what was said about reaching the server", () => {
        recordDeviceError("d1", "Permission denied", { kind: "connection" });
        recordDeviceError("d1", "Manifest refused", { kind: "service" });
        clearServiceErrors("d1");

        expect(read().map((error) => error.message)).toEqual(["Permission denied"]);
    });

    it("keeps a newer clock refusal of another size", () => {
        recordDeviceError("d1", "clock", { clockOffset: { direction: "behind", minutes: 10 } });
        recordDeviceError("d1", "clock", { clockOffset: { direction: "behind", minutes: 12 } });

        expect(read().at(-1)?.clockOffset?.minutes).toBe(12);
    });
});
