// @vitest-environment jsdom

/** Each variable row ends in a trash icon; the remove button needs a name. */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return {
                t: (strings: TemplateStringsArray | string, ...values: unknown[]) =>
                    typeof strings === "string" ? strings : String.raw({ raw: strings }, ...values),
            };
        },
    };
});

vi.mock("@/features/auth/lib/auth-ui-provider", () => {
    return {
        useAuth: () => {
            return {
                hooks: {
                    useSession: () => {
                        return { data: { user: { id: "u1" } } };
                    },
                },
            };
        },
    };
});

const { default: VariableDefinitions } = await import("./variable-definitions");

describe("VariableDefinitions", () => {
    it("names the remove button of every variable", () => {
        render(<VariableDefinitions onChange={() => {}} variables={[{ name: "topic" }, { name: "tone" }]} />);

        expect(screen.getAllByRole("button", { name: "Remove variable" })).toHaveLength(2);
    });
});
