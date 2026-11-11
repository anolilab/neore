/**
 * The skill list keeps an open "Create skill" form mounted when its first load resolves to an empty list: switching to
 * the empty state must not remount the form and drop what was typed.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

// Stable across renders, as the real hooks are: the load effect depends on `t` and the actions, so a new identity per
// render would re-run it.
const state = vi.hoisted(() => {
    const deferred: { resolve?: (skills: unknown[]) => void } = {};

    return {
        count: async () => {
            return { canCreate: true, count: 0, isPremium: false, limit: null };
        },
        deferred,
        skillLoads: 0,
        skills: async () => {
            state.skillLoads += 1;

            return await new Promise<unknown[]>((resolve) => {
                deferred.resolve = resolve;
            });
        },
        t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values),
    };
});

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return {
                i18n: { _: (descriptor: { id: string }) => descriptor.id, locale: "en" },
                t: state.t,
            };
        },
    };
});

// `getSkills` stays pending until the test resolves it; every other action answers at once.
vi.mock("@tanstack/react-query", () => {
    return {
        useMutation: (options: { name?: string }) => {
            return {
                isPending: false,
                mutateAsync: options.name === "getSkills" ? state.skills : state.count,
            };
        },
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPCClient: () => {
            return {};
        },
        useLunoraActionOptions: (reference: { name?: string }) => {
            return { name: reference.name };
        },
    };
});

vi.mock("@neore/backend/api", () => {
    return {
        api: {
            skills: {
                functions: { getSkillCount: { name: "getSkillCount" }, getSkills: { name: "getSkills" } },
                io: { exportSkill: { name: "exportSkill" } },
            },
        },
    };
});

vi.mock("@/features/auth/lib/auth-ui-provider", () => {
    return {
        useAuth: () => {
            return {
                hooks: {
                    useActiveOrganization: () => {
                        return { data: null };
                    },
                    useSession: () => {
                        return { data: { user: { id: "user-1" } } };
                    },
                },
            };
        },
    };
});

vi.mock("@/features/billing/hooks/use-checkout", () => {
    return {
        default: () => {
            return { upgradeToast: vi.fn() };
        },
    };
});

// The form keeps its draft in its own state, as the real one does: a remount loses what was typed.
vi.mock("./skill-form-dialog", () => {
    const FormBody = () => {
        const [name, setName] = useState("");

        return (
            <div role="dialog">
                <input aria-label="Skill name" onChange={(event) => setName(event.target.value)} value={name} />
            </div>
        );
    };

    return {
        default: ({ open }: { open: boolean }) => (open ? <FormBody /> : null),
    };
});

vi.mock("./skill-builder-setup", () => {
    return {
        default: () => null,
        useBuilderSetupState: () => [null, vi.fn()],
    };
});

vi.mock("./skill-builder-dialog", () => {
    return { default: () => null };
});

vi.mock("./marketplace-skill-detail-dialog", () => {
    return { default: () => null };
});

vi.mock("./skill-empty-state", () => {
    return { default: () => <p>No skills yet</p> };
});

const { default: SkillList } = await import("./skill-list");

describe("SkillList", () => {
    it("keeps what was typed in an open create form when the first load resolves to no skills", async () => {
        render(<SkillList />);

        fireEvent.click(screen.getByRole("button", { name: "Add Skill" }));
        fireEvent.change(screen.getByRole("textbox", { name: "Skill name" }), { target: { value: "Release notes" } });

        await act(async () => {
            state.deferred.resolve?.([]);
        });

        expect(await screen.findByText("No skills yet")).toBeDefined();
        expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Skill name" }).value).toBe("Release notes");
        expect(state.skillLoads).toBe(1);
    });
});
