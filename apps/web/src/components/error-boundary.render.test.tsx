import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const captureException = vi.hoisted(() => vi.fn());

vi.mock("@/lib/analytics/posthog-client", () => {
    return {
        captureException,
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

    it("reports an error whose cause cannot be read, without the component stack", () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        captureException.mockClear();

        const hostile = new Error("hostile");

        Object.defineProperty(hostile, "cause", {
            get: () => {
                throw new Error("no cause for you");
            },
        });

        const HostileThrower = (): never => {
            throw hostile;
        };

        render(
            <ErrorBoundary fallback={(error: Error) => <p>{`Recovered: ${error.message}`}</p>}>
                <HostileThrower />
            </ErrorBoundary>,
        );

        expect(screen.getByText("Recovered: hostile")).toBeTruthy();
        expect(captureException).toHaveBeenCalledWith(hostile);
    });

    it("still renders its fallback, and warns, when reporting the error throws", () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const reportFailure = new Error("report failed");

        captureException.mockImplementationOnce(() => {
            throw reportFailure;
        });

        render(
            <ErrorBoundary fallback={(error: Error) => <p>{`Recovered: ${error.message}`}</p>}>
                <Thrower />
            </ErrorBoundary>,
        );

        expect(screen.getByText("Recovered: frozen")).toBeTruthy();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("Could not report a render error"), reportFailure);
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
