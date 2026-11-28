// eslint-disable-next-line testing-library/no-manual-cleanup -- vitest runs without globals, so nothing else cleans up between tests
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import PageInstallButton from "./page-install-button";

const state = vi.hoisted(() => {
    return { canInstall: true, install: vi.fn(async () => undefined), pageWindows: false };
});

const useInstallAppMock = vi.hoisted(() => vi.fn());

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});

vi.mock("@/features/download/lib/use-install-app", () => {
    return { useInstallApp: useInstallAppMock };
});

vi.mock("@/lib/native/use-native-capability", () => {
    return { useNativeCapability: () => state.pageWindows };
});

afterEach(() => {
    cleanup();
    state.canInstall = true;
    state.pageWindows = false;
    state.install.mockClear();
    useInstallAppMock.mockReset();
});

describe("the page install button", () => {
    it("offers the install for this page's own manifest, and starts it on click", () => {
        useInstallAppMock.mockImplementation(() => {
            return { canInstall: state.canInstall, install: state.install, installed: false };
        });

        render(<PageInstallButton pageId="page_1" />);

        expect(useInstallAppMock).toHaveBeenCalledWith("/page-manifest/page_1");
        fireEvent.click(screen.getByRole("button", { name: "Install this page" }));
        expect(state.install).toHaveBeenCalledTimes(1);
    });

    it("is absent when the browser has no prompt for this page's manifest", () => {
        state.canInstall = false;
        useInstallAppMock.mockImplementation(() => {
            return { canInstall: state.canInstall, install: state.install, installed: false };
        });

        render(<PageInstallButton pageId="page_1" />);

        expect(screen.queryByRole("button", { name: "Install this page" })).toBeNull();
    });

    it("is absent in the desktop shell with page windows, which opens the page in its own window instead", () => {
        state.pageWindows = true;
        useInstallAppMock.mockImplementation(() => {
            return { canInstall: true, install: state.install, installed: false };
        });

        render(<PageInstallButton pageId="page_1" />);

        expect(screen.queryByRole("button", { name: "Install this page" })).toBeNull();
    });
});
