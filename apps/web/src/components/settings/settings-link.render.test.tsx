// @vitest-environment jsdom

import { fireEvent, render, renderHook, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useSettingsRequest } from "@/features/settings/lib/settings-request";

import SettingsLink, { useOpenSettings } from "./settings-link";

const navigate = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", () => {
    return {
        Link: ({ children, onClick }: ComponentProps<"a">) => (
            <a
                href="/chat?settings=true"
                onClick={(event) => {
                    onClick?.(event);
                    event.preventDefault();
                }}
            >
                {children}
            </a>
        ),
        useNavigate: () => navigate,
    };
});

beforeEach(() => {
    useSettingsRequest.setState({ request: undefined });
    navigate.mockClear();
});

describe(SettingsLink, () => {
    it("asks the open modal for its tab on every click, so a link to the tab the URL already names still switches to it", () => {
        render(<SettingsLink tab="chat-models">Models</SettingsLink>);

        fireEvent.click(screen.getByRole("link", { name: "Models" }));
        const first = useSettingsRequest.getState().request;

        fireEvent.click(screen.getByRole("link", { name: "Models" }));
        const second = useSettingsRequest.getState().request;

        expect(first?.tab).toBe("chat-models");
        expect(second?.tab).toBe("chat-models");
        expect(second?.id).toBeGreaterThan(first?.id ?? 0);
    });

    it("leaves the modal alone for a click that opens a new browser tab", () => {
        render(<SettingsLink tab="chat-models">Models</SettingsLink>);

        fireEvent.click(screen.getByRole("link", { name: "Models" }), { metaKey: true });

        expect(useSettingsRequest.getState().request).toBeUndefined();
    });
});

describe(useOpenSettings, () => {
    it("asks the modal for the tab and its anchor as it navigates", () => {
        const { result } = renderHook(() => useOpenSettings());

        result.current("auth-organizations", { anchor: "invites" });

        expect(useSettingsRequest.getState().request).toMatchObject({ anchor: "invites", tab: "auth-organizations" });
        expect(navigate).toHaveBeenCalledTimes(1);
    });
});
