import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useUIStateStore } from "../stores/ui-state-store";
import { useAppearanceSettings } from "./use-ui-state";

const mutate = vi.fn();

vi.mock("@/features/auth/hooks/use-user-settings", () => {
    return {
        useUpdateUserSettings: () => {
            return { mutate };
        },
        useUserSettings: () => {
            return { data: undefined };
        },
    };
});
vi.mock("@/features/auth/lib/auth-ui-provider", () => {
    return {
        useAuth: () => {
            return {
                hooks: {
                    useSession: () => {
                        return { data: { user: { id: "user-1" } } };
                    },
                },
            };
        },
    };
});

describe(useAppearanceSettings, () => {
    afterEach(() => {
        mutate.mockReset();
        act(() => useUIStateStore.getState().resetAppearance());
    });

    it("keeps `system` on this device: stored and marked explicit, never sent to the server", () => {
        const { result } = renderHook(() => useAppearanceSettings());

        act(() => result.current.setAccentColor("system"));

        expect(useUIStateStore.getState().appearance).toMatchObject({ accentColor: "system", explicit: { accentColor: true } });
        expect(mutate).not.toHaveBeenCalled();
    });

    it("syncs a preset and marks it explicit", () => {
        const { result } = renderHook(() => useAppearanceSettings());

        act(() => result.current.setAccentColor("teal"));

        expect(useUIStateStore.getState().appearance).toMatchObject({ accentColor: "teal", explicit: { accentColor: true } });
        expect(mutate).toHaveBeenCalledExactlyOnceWith({ accentColor: "teal" });
    });

    it("marks only the accent and the font explicit, keeping earlier marks", () => {
        const { result } = renderHook(() => useAppearanceSettings());

        act(() => result.current.setMainFont("serif"));
        act(() => result.current.setDensity("compact"));

        expect(useUIStateStore.getState().appearance.explicit).toStrictEqual({ mainFont: true });
        expect(mutate).toHaveBeenLastCalledWith({ density: "compact" });

        act(() => result.current.setAccentColor("system"));

        expect(useUIStateStore.getState().appearance.explicit).toStrictEqual({ accentColor: true, mainFont: true });
    });
});
