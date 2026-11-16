/**
 * `<SignInRedirect>`: a signed-out visitor is sent to sign-in with the page they
 * were on, query and hash included, encoded as `redirectTo`.
 */

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
    return { navigate: vi.fn() };
});

vi.mock("@tanstack/react-router", () => {
    return {
        useNavigate: () => harness.navigate,
    };
});

const { default: SignInRedirect } = await import("./sign-in-redirect");

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

describe("SignInRedirect", () => {
    it("sends the visitor to sign-in, replacing this entry, with the page's path, query and hash as redirectTo", async () => {
        vi.stubGlobal("location", { hash: "#latest", pathname: "/chat/abc", search: "?model=gpt&x=1" });

        render(<SignInRedirect>Loading</SignInRedirect>);

        await waitFor(() => {
            expect(harness.navigate).toHaveBeenCalledTimes(1);
        });
        expect(harness.navigate).toHaveBeenCalledWith({
            href: `/auth/sign-in?redirectTo=${encodeURIComponent("/chat/abc?model=gpt&x=1#latest")}`,
            replace: true,
        });
    });

    it("keeps the loading state on screen until the navigation lands", async () => {
        vi.stubGlobal("location", { hash: "", pathname: "/dashboard", search: "" });

        render(<SignInRedirect>Loading</SignInRedirect>);

        expect(screen.getByText("Loading")).toBeTruthy();
        await waitFor(() => {
            expect(harness.navigate).toHaveBeenCalled();
        });
    });
});
