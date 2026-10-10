import { describe, expect, it } from "vitest";

import { isAllowedPushEndpoint } from "./push-endpoint";

describe("isAllowedPushEndpoint", () => {
    it.each([
        "https://fcm.googleapis.com/fcm/send/abc",
        "https://android.googleapis.com/gcm/send/abc",
        "https://updates.push.services.mozilla.com/wpush/v2/abc",
        "https://wns2-par02p.notify.windows.com/w/?token=abc",
        "https://web.push.apple.com/QGx",
    ])("admits the browser push service %s", (endpoint) => {
        expect(isAllowedPushEndpoint(endpoint)).toBe(true);
    });

    it.each([
        // eslint-disable-next-line unicorn/prefer-https -- plain http to a real push host is the case under test
        "http://fcm.googleapis.com/fcm/send/abc",
        "https://localhost/push",
        "https://169.254.169.254/latest/meta-data",
        "https://evil.example/fcm.googleapis.com",
        "https://fcm.googleapis.com.evil.example/x",
        "https://user:pass@fcm.googleapis.com/x",
        "https://fcm.googleapis.com:8443/x",
        // Any other Google API behind the same domain is not a push service.
        "https://storage.googleapis.com/bucket/object",
        "https://www.googleapis.com/upload/drive/v3/files",
        "not a url",
    ])("refuses %s", (endpoint) => {
        expect(isAllowedPushEndpoint(endpoint)).toBe(false);
    });
});
