import type { I18n } from "@lingui/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dynamicActivate, getCurrentLocale } from "./client";
import routerWithLingui from "./router-plugin";

vi.mock("./client", () => {
    return { DEFAULT_LOCALE: "en", dynamicActivate: vi.fn(), getCurrentLocale: vi.fn() };
});

interface FakeRouter {
    options: {
        dehydrate?: () => Promise<unknown>;
        hydrate?: (dehydrated: unknown) => Promise<void>;
    };
    state: { location: { pathname: string } };
}

const i18n = { loadAndActivate: vi.fn(), locale: "de" } as unknown as I18n;

const plugin = (pathname = "/chat") => {
    const router: FakeRouter = { options: {}, state: { location: { pathname } } };

    routerWithLingui(router as never, i18n);

    return router.options;
};

describe(routerWithLingui, () => {
    beforeEach(() => {
        vi.mocked(dynamicActivate).mockReset().mockResolvedValue(undefined);
        vi.mocked(getCurrentLocale).mockReset().mockReturnValue("fr");
        vi.mocked(i18n.loadAndActivate).mockReset();
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it("dehydrates the rendered locale, but none for the offline shell, which is rendered for nobody", async () => {
        vi.stubEnv("SSR", true);

        await expect(plugin("/chat").dehydrate?.()).resolves.toStrictEqual({ dehydratedI18n: { locale: "de" } });
        await expect(plugin("/offline-shell").dehydrate?.()).resolves.toStrictEqual({ dehydratedI18n: { locale: undefined } });
    });

    it("activates the dehydrated locale on hydrate", async () => {
        await plugin().hydrate?.({ dehydratedI18n: { locale: "de" } });

        expect(dynamicActivate).toHaveBeenCalledExactlyOnceWith(i18n, "de");
        expect(getCurrentLocale).not.toHaveBeenCalled();
    });

    it("activates the window's own locale when hydrating the offline shell", async () => {
        await plugin().hydrate?.({ dehydratedI18n: { locale: undefined } });

        expect(dynamicActivate).toHaveBeenCalledExactlyOnceWith(i18n, "fr");
    });

    it("falls back to the default catalog when the locale's catalog cannot load, then to empty messages", async () => {
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        vi.mocked(dynamicActivate).mockRejectedValueOnce(new TypeError("Failed to fetch"));

        await plugin().hydrate?.({ dehydratedI18n: {} });

        expect(dynamicActivate).toHaveBeenLastCalledWith(i18n, "en");
        expect(i18n.loadAndActivate).not.toHaveBeenCalled();

        vi.mocked(dynamicActivate).mockRejectedValue(new TypeError("Failed to fetch"));

        await plugin().hydrate?.({ dehydratedI18n: {} });

        expect(i18n.loadAndActivate).toHaveBeenCalledExactlyOnceWith({ locale: "fr", messages: {} });
    });
});
