import type { I18n } from "@lingui/core";
import { setupI18n } from "@lingui/core";
import { useLingui } from "@lingui/react";
import { act, within } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
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
        Wrap?: (properties: PropsWithChildren) => React.JSX.Element;
    };
    state: { location: { pathname: string } };
}

const i18n = { loadAndActivate: vi.fn(), locale: "de" } as unknown as I18n;

const plugin = (pathname = "/chat", instance = i18n) => {
    const router: FakeRouter = { options: {}, state: { location: { pathname } } };

    routerWithLingui(router as never, instance);

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

    it("dehydrates the rendered locale, and marks the offline shell, whose locale is the default one", async () => {
        vi.stubEnv("SSR", true);

        await expect(plugin("/chat").dehydrate?.()).resolves.toStrictEqual({ dehydratedI18n: { locale: "de" } });
        await expect(plugin("/offline-shell").dehydrate?.()).resolves.toStrictEqual({ dehydratedI18n: { locale: "de", shell: true } });
    });

    it("activates the dehydrated locale on hydrate", async () => {
        await plugin().hydrate?.({ dehydratedI18n: { locale: "de" } });

        expect(dynamicActivate).toHaveBeenCalledExactlyOnceWith(i18n, "de");
        expect(getCurrentLocale).not.toHaveBeenCalled();
    });

    it("activates the offline shell's own locale on hydrate, not yet the window's", async () => {
        await plugin("/chat").hydrate?.({ dehydratedI18n: { locale: "en", shell: true } });

        expect(dynamicActivate).toHaveBeenCalledExactlyOnceWith(i18n, "en");
    });

    // A first render in another locale than the markup's makes React discard the kept shell and render it again.
    it("hydrates the offline shell in the locale it was rendered in, then switches to the window's", async () => {
        vi.mocked(dynamicActivate).mockImplementation(async (instance, locale) => {
            instance.loadAndActivate({ locale, messages: {} });
        });

        const rendered: string[] = [];
        const Probe = () => {
            const { i18n: active } = useLingui();

            rendered.push(active.locale);

            return <span lang={active.locale}>{active.locale}</span>;
        };

        const server = setupI18n({ locale: "en", messages: { en: {} } });
        const { Wrap: ServerWrap } = plugin("/offline-shell", server);
        const container = document.createElement("div");

        container.innerHTML = renderToString(
            ServerWrap ? (
                <ServerWrap>
                    <Probe />
                </ServerWrap>
            ) : null,
        );
        rendered.length = 0;

        const client = setupI18n();
        const options = plugin("/chat/abc", client);
        const recoverable = vi.fn();

        await options.hydrate?.({ dehydratedI18n: { locale: "en", shell: true } });

        const ClientWrap = options.Wrap as NonNullable<FakeRouter["options"]["Wrap"]>;
        let root: ReturnType<typeof hydrateRoot> | undefined;

        await act(async () => {
            root = hydrateRoot(
                container,
                <ClientWrap>
                    <Probe />
                </ClientWrap>,
                { onRecoverableError: recoverable },
            );
        });

        expect(recoverable).not.toHaveBeenCalled();
        expect(rendered[0]).toBe("en");
        expect(vi.mocked(dynamicActivate).mock.calls.map(([, locale]) => locale)).toStrictEqual(["en", "fr"]);
        expect(within(container).getByText("fr").getAttribute("lang")).toBe("fr");

        act(() => root?.unmount());
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
