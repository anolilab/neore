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

    it("replaces the component stack it attached before when the same error is caught again", () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        const original = new Error("again", { cause: "root cause" });
        const Again = (): never => {
            throw original;
        };

        for (let index = 0; index < 2; index += 1) {
            render(
                <ErrorBoundary fallback={(error: Error) => <p>{error.message}</p>}>
                    <Again />
                </ErrorBoundary>,
            ).unmount();
        }

        const link = original.cause as Error;

        expect(link.name).toBe("React ErrorBoundary Error");
        expect(link.stack).toContain("Again");
        expect(link.cause).toBe("root cause");
    });
});
