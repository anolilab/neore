import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useShownWebhookSecrets } from "./use-shown-webhook-secrets";

describe("useShownWebhookSecrets", () => {
    it("keeps an uncopied secret when another trigger is rotated, until it is dismissed", () => {
        const { result } = renderHook(() => useShownWebhookSecrets());

        act(() => result.current.show({ id: "a", name: "A", secret: "secret-a" }));
        act(() => result.current.show({ id: "b", name: "B", secret: "secret-b" }));

        expect(result.current.secrets.map((entry) => entry.secret)).toEqual(["secret-a", "secret-b"]);

        act(() => result.current.dismiss("a"));
        expect(result.current.secrets.map((entry) => entry.id)).toEqual(["b"]);
    });

    it("replaces the entry of the same trigger when it is rotated again", () => {
        const { result } = renderHook(() => useShownWebhookSecrets());

        act(() => result.current.show({ id: "a", name: "A", secret: "old" }));
        act(() => result.current.show({ id: "a", name: "A", secret: "new" }));

        expect(result.current.secrets).toEqual([{ id: "a", name: "A", secret: "new" }]);
    });
});
