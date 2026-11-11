import type { I18n } from "@lingui/core";
import { describe, expect, it, vi } from "vitest";

import { dynamicActivate } from "./client";

const slowCatalog = vi.hoisted(() => {
    const gate = { resolve: (): void => undefined };
    const promise = new Promise<void>((resolve) => {
        gate.resolve = resolve;
    });

    return { promise, resolve: () => gate.resolve() };
});

vi.mock(import("./server"), () => {
    return { default: vi.fn() };
});
vi.mock(import("@tanstack/react-start/server"), () => {
    return { getRequest: vi.fn() };
});
vi.mock("../../locales/de/messages.po?import", async () => {
    await slowCatalog.promise;

    return { messages: { greeting: "Hallo" } };
});
vi.mock("../../locales/fr/messages.po?import", () => {
    return { messages: { greeting: "Bonjour" } };
});

describe(dynamicActivate, () => {
    it("keeps the latest locale when an earlier catalog finishes loading after it", async () => {
        const i18n = { loadAndActivate: vi.fn() } as unknown as I18n;

        const first = dynamicActivate(i18n, "de");

        await dynamicActivate(i18n, "fr");

        slowCatalog.resolve();
        await first;

        expect(i18n.loadAndActivate).toHaveBeenCalledExactlyOnceWith({ locale: "fr", messages: { greeting: "Bonjour" } });
    });
});
