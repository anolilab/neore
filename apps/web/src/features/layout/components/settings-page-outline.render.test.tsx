/**
 * The settings pages' heading outline (WCAG 1.3.1 / 2.4.6 / 2.4.10): one `h1`
 * per page, card titles as `h2`, nested cards and in-card sub-headings one
 * level deeper, and no skipped level — on the dashboard pages and in the
 * settings dialog, which renders the same components one level further down.
 */

import { Card, CardContent, CardHeader, CardTitle } from "@neore/ui/components/card";
import { HeadingLevelProvider } from "@neore/ui/components/heading";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

// The unit-test transform does not compile Lingui macros (vi.mock is hoisted).
vi.mock("@lingui/core/macro", () => {
    return {
        msg: (strings: TemplateStringsArray) => {
            return { id: strings.join("") };
        },
    };
});

vi.mock("@lingui/react/macro", () => {
    return {
        Trans: ({ children }: { children: ReactNode }) => children,
        useLingui: () => {
            return {
                i18n: { _: (descriptor: { id: string }) => descriptor.id, locale: "en" },
                t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values),
            };
        },
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    const query = (data: unknown) => {
        return {
            queryOptions: () => {
                return { queryFn: async () => data, queryKey: [JSON.stringify(data)] };
            },
        };
    };

    return {
        useCRPC: () => {
            return {
                auth: {
                    functions: {
                        getAIUserPreferences: query({ enablePlanner: true }),
                        updateAIUserPreferences: {
                            mutationOptions: () => {
                                return { mutationFn: async () => null };
                            },
                        },
                    },
                },
                gdpr: {
                    functions: {
                        getDataAccessSummary: query({
                            dataSummary: { files: 1, gdprRequests: 0, hasSettings: true, prompts: 2 },
                            profile: { createdAt: 0, email: "a@example.com", emailVerified: true, name: "A" },
                        }),
                    },
                },
            };
        },
    };
});

const { default: SettingsCard } = await import("@/components/settings/settings-card");
const { default: AgentSettings } = await import("@/features/settings/components/chat/agent-settings");
const { default: DataAccess } = await import("@/features/settings/components/privacy/data-access");
const { default: SettingsPageOutline } = await import("./settings-page-outline");

const mount = (node: ReactNode) => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    return render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
};

/** Every heading in document order, as `h<level> <text>`. */
const outline = (): string[] => screen.queryAllByRole("heading").map((heading) => `${heading.tagName.toLowerCase()} ${heading.textContent?.trim() ?? ""}`);

/** No heading goes more than one level deeper than the one before it. */
const expectNoSkippedLevel = (headings: string[], startLevel: number) => {
    let previous = startLevel - 1;

    for (const heading of headings) {
        const level = Number(heading[1]);

        expect(level, `"${heading}" after h${previous}`).toBeLessThanOrEqual(previous + 1);

        previous = level;
    }
};

describe(SettingsPageOutline, () => {
    it("gives a settings page one h1 and its cards h2 titles, a nested card h3", () => {
        mount(
            <SettingsPageOutline pathname="/dashboard/settings/app/customization">
                <SettingsCard description="How it looks" title="Appearance" />
                <SettingsCard title="Advanced">
                    <Card>
                        <CardHeader>
                            <CardTitle>Experimental</CardTitle>
                        </CardHeader>
                    </Card>
                </SettingsCard>
            </SettingsPageOutline>,
        );

        expect(screen.getAllByRole("heading", { level: 1 }).map((heading) => heading.textContent)).toStrictEqual(["Customization"]);
        expect(outline()).toStrictEqual(["h1 Customization", "h2 Appearance", "h2 Advanced", "h3 Experimental"]);
    });

    it("keeps the agent page's own title and puts its cards under it", async () => {
        mount(
            <SettingsPageOutline pathname="/dashboard/settings/chat/agent">
                <AgentSettings />
            </SettingsPageOutline>,
        );

        await screen.findByRole("heading", { name: "Agent Modules" });

        const headings = outline();

        expect(headings).toStrictEqual(["h1 Agent", "h2 Agent Capabilities", "h3 Agent Modules", "h3 Automation", "h3 Token Cost Impact"]);
        expectNoSkippedLevel(headings, 1);
    });

    it("puts the headings inside a card's content under its title", async () => {
        mount(
            <SettingsPageOutline pathname="/dashboard/settings/privacy">
                <DataAccess />
            </SettingsPageOutline>,
        );

        await screen.findByRole("heading", { name: "Profile Information" });

        expect(outline()).toStrictEqual(["h1 Privacy & Data", "h2 Data Access Summary", "h3 Profile Information", "h3 Data Summary"]);
    });

    it("adds nothing off the settings tree: a card title stays a div", () => {
        mount(
            <SettingsPageOutline pathname="/dashboard">
                <SettingsCard title="Recent" />
            </SettingsPageOutline>,
        );

        expect(outline()).toStrictEqual([]);
        expect(screen.getByText("Recent").tagName).toBe("DIV");
    });

    it("leaves a page without a name of its own (the OAuth callback) to its own h1", () => {
        mount(
            <SettingsPageOutline pathname="/dashboard/settings/connectors/callback">
                <h1>Connecting...</h1>
            </SettingsPageOutline>,
        );

        expect(outline()).toStrictEqual(["h1 Connecting..."]);
    });
});

describe("the settings dialog's outline", () => {
    it("renders the same components one level down, under the tab's h2", async () => {
        mount(
            <>
                <h2>Agent</h2>
                <HeadingLevelProvider level={3}>
                    <AgentSettings />
                </HeadingLevelProvider>
            </>,
        );

        await screen.findByRole("heading", { name: "Agent Modules" });

        const headings = outline();

        expect(headings.slice(0, 3)).toStrictEqual(["h2 Agent", "h3 Agent Capabilities", "h4 Agent Modules"]);
        expectNoSkippedLevel(headings, 2);
    });
});

describe("cards outside any outline", () => {
    it("render as before: no heading at all", () => {
        mount(
            <Card>
                <CardContent>
                    <CardTitle>Plain</CardTitle>
                </CardContent>
            </Card>,
        );

        expect(outline()).toStrictEqual([]);
    });
});
