import { describe, expect, it } from "vitest";

import { runNotificationChannel } from "./run-notification";

describe("runNotificationChannel", () => {
    it("announces only a finished run in a hidden tab", () => {
        expect(runNotificationChannel({ browserPermission: "granted", documentHidden: false, native: false })).toBe("none");
        expect(runNotificationChannel({ browserPermission: "granted", documentHidden: true, native: false })).toBe("browser");
    });

    it("uses the native shell instead of the browser API when running inside it", () => {
        expect(runNotificationChannel({ browserPermission: "denied", documentHidden: true, native: true })).toBe("native");
    });

    it("stays silent unless the browser has granted permission", () => {
        for (const browserPermission of ["default", "denied", "unsupported"] as const) {
            expect(runNotificationChannel({ browserPermission, documentHidden: true, native: false })).toBe("none");
        }
    });
});
