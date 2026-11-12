import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const captureException = vi.hoisted(() => vi.fn());

vi.mock("@/lib/analytics/posthog-client", () => {
    return {
        getPostHog: () => {
            return { captureException };
        },
    };
});
vi.mock("@/lib/toast", () => {
    return { showError: vi.fn() };
});

const { ErrorBoundary } = await import("./error-boundary");

const frozenError = Object.freeze(new Error("frozen"));

const Thrower = (): never => {
    throw frozenError;
};

describe(ErrorBoundary, () => {
    it("renders its fallback and reports a frozen error it cannot attach the component stack to", () => {
        vi.spyOn(console, "error").mockImplementation(() => {});

        render(
            <ErrorBoundary fallback={(error: Error) => <p>{`Recovered: ${error.message}`}</p>}>
                <Thrower />
            </ErrorBoundary>,
        );

        expect(screen.getByText("Recovered: frozen")).toBeTruthy();
        expect(captureException).toHaveBeenCalledWith(frozenError);
    });
});
