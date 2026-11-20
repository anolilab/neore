/**
 * `<SiteLogins>`: a typed password never outlasts its account, a save or a failed delete never discards edits it did
 * not send, an edit never drops a login's bots while the bot list is missing, the form stops at the server's limit, and
 * another account's cached logins and bots never show and are refetched. A list that failed to load says so and offers a
 * retry; it never passes for an empty one.
 */

import type { UseMutationOptions } from "@tanstack/react-query";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const SITE = "https://example.com";
const USERNAME_TEXT = /ada@example\.com/u;
const CHOSEN_BOTS_TEXT = /the bots you chose/u;
const OWN_CHATS_TEXT = /Your own chats only/u;

const harness = vi.hoisted(() => {
    return {
        bots: [] as { _id: string; name: string; userId: string }[],
        botsState: "loaded" as "failed" | "loaded" | "pending",
        deleteSiteLogin: vi.fn(),
        // Set while an admin acts as the signed-in user: the session's `impersonatedBy` mark.
        impersonatedBy: undefined as string | undefined,
        logins: [] as { hasPassword: true; id: string; site: string; teammateIds: string[]; updatedAt: number; username: string }[],
        loginsFailed: false,
        loginsPending: false,
        saveSiteLogin: vi.fn(),
        userId: "user-a" as string | undefined,
    };
});

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});

vi.mock("sonner", () => {
    return { toast: { error: vi.fn(), success: vi.fn() } };
});

vi.mock("@/features/auth/hooks/use-auth-session", () => {
    return {
        useAuthSession: () => {
            return {
                data: harness.userId ? { session: { impersonatedBy: harness.impersonatedBy }, user: { id: harness.userId } } : null,
                error: null,
                isPending: false,
            };
        },
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    // One object for every render, as the app's memoised `useCRPC` is.
    const crpc = {
        bots: {
            functions: {
                listBots: {
                    queryKey: () => ["bots"],
                    queryOptions: () => {
                        return {
                            queryFn: async () => {
                                if (harness.botsState === "pending") {
                                    return await new Promise(() => {});
                                }

                                if (harness.botsState === "failed") {
                                    throw new Error("bots unavailable");
                                }

                                return harness.bots;
                            },
                            queryKey: ["bots"],
                        };
                    },
                },
            },
        },
        vault: {
            site_logins: {
                deleteSiteLogin: {
                    // As the shim does: the call site's options apply on top.
                    mutationOptions: (overrides?: Partial<UseMutationOptions>) => {
                        return { mutationFn: harness.deleteSiteLogin, ...overrides };
                    },
                },
                listSiteLogins: {
                    queryKey: () => ["site-logins"],
                    queryOptions: () => {
                        // One key for every account, as in the app: a switch finds the last account's list cached.
                        return {
                            queryFn: async () => {
                                if (harness.loginsPending) {
                                    return await new Promise(() => {});
                                }

                                if (harness.loginsFailed) {
                                    throw new Error("logins unavailable");
                                }

                                return { logins: harness.logins, userId: harness.userId };
                            },
                            queryKey: ["site-logins"],
                        };
                    },
                },
                saveSiteLogin: {
                    // As the shim does: the call site's options apply on top.
                    mutationOptions: (overrides?: Partial<UseMutationOptions>) => {
                        return { mutationFn: harness.saveSiteLogin, ...overrides };
                    },
                },
            },
        },
    };

    return { useCRPC: () => crpc };
});

const { toast } = await import("sonner");
const { default: SiteLogins } = await import("./site-logins");

// Built at run time, so no secret-shaped literal sits in the source.
const PASSWORD = ["pw", crypto.randomUUID()].join("-");

const savedLogin = (teammateIds: string[] = []) => {
    return { hasPassword: true as const, id: "login-1", site: SITE, teammateIds, updatedAt: 1, username: "ada@example.com" };
};

const botsOf = (userId: string, count: number) =>
    Array.from({ length: count }, (_, index) => {
        return { _id: `bot-${index}`, name: `Bot ${index}`, userId };
    });

const mount = () => {
    // Fresh for 30 seconds, as in the app: a switch within that window finds the last account's lists still fresh.
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
    const tree = () => createElement(QueryClientProvider, { client: queryClient }, createElement(SiteLogins));
    const view = render(tree());

    return { queryClient, rerender: () => view.rerender(tree()) };
};

const passwordField = () => screen.getByLabelText("Password") as HTMLInputElement;

const valueOf = (label: string) => (screen.getByLabelText(label) as HTMLInputElement).value;

// A native button carries `disabled`; the checkbox is a `role="checkbox"` element marked `aria-disabled`.
const isDisabled = (element: Element | undefined) =>
    element !== undefined && ((element as HTMLButtonElement).disabled === true || element.getAttribute("aria-disabled") === "true");

afterEach(() => {
    harness.bots = [];
    harness.botsState = "loaded";
    harness.impersonatedBy = undefined;
    harness.logins = [];
    harness.loginsFailed = false;
    harness.loginsPending = false;
    harness.userId = "user-a";
    vi.clearAllMocks();
});

describe("SiteLogins", () => {
    it("drops a typed password when the account switches or signs out", async () => {
        const user = userEvent.setup();
        const view = mount();

        await user.type(passwordField(), PASSWORD);
        expect(passwordField().value).toBe(PASSWORD);

        harness.userId = "user-b";
        view.rerender();
        expect(passwordField().value).toBe("");

        harness.userId = undefined;
        view.rerender();
        expect(screen.queryByLabelText("Password")).toBeNull();
    });

    it("keeps no typed password in the mutation cache once a save settles", async () => {
        const user = userEvent.setup();

        harness.saveSiteLogin.mockResolvedValueOnce("login-1");
        const view = mount();
        const cachedPasswords = () =>
            view.queryClient
                .getMutationCache()
                .getAll()
                .filter((mutation) => (mutation.state.variables as { password?: string } | undefined)?.password === PASSWORD);

        await user.type(screen.getByLabelText("Site"), SITE);
        await user.type(screen.getByLabelText("Username or email"), "ada@example.com");
        await user.type(passwordField(), PASSWORD);
        await user.click(screen.getByRole("button", { name: "Save login" }));
        await waitFor(() => expect(toast.success).toHaveBeenCalledOnce());

        expect(cachedPasswords()).toHaveLength(0);
        expect(passwordField().value).toBe("");
    });

    it("does not report a save that ends after the account switched", async () => {
        const user = userEvent.setup();
        let finishSave: (value: string) => void = () => {};
        // eslint-disable-next-line unicorn/prefer-promise-with-resolvers
        const heldSave = new Promise<string>((resolve) => {
            finishSave = resolve;
        });

        harness.saveSiteLogin.mockReturnValueOnce(heldSave);
        const view = mount();

        await user.type(screen.getByLabelText("Site"), SITE);
        await user.type(screen.getByLabelText("Username or email"), "ada@example.com");
        await user.type(passwordField(), PASSWORD);
        await user.click(screen.getByRole("button", { name: "Save login" }));
        await waitFor(() => expect(harness.saveSiteLogin).toHaveBeenCalledOnce());

        harness.userId = "user-b";
        view.rerender();

        // The save's last step before its toast is the list refetch; once that has settled, the toast would have shown.
        const invalidate = vi.spyOn(view.queryClient, "invalidateQueries");
        const loginRefetches = () => invalidate.mock.results.filter((_, index) => invalidate.mock.calls[index]?.[0]?.queryKey?.[0] === "site-logins");

        finishSave("login-1");
        await waitFor(() => expect(loginRefetches()).toHaveLength(1));
        await Promise.all(loginRefetches().map(async (result) => await result.value));

        expect(toast.success).not.toHaveBeenCalled();
        expect(toast.error).not.toHaveBeenCalled();
    });

    it("keeps edits made while a save was in flight", async () => {
        const user = userEvent.setup();
        let finishSave: (value: string) => void = () => {};
        // The configured Node range predates `Promise.withResolvers`.
        // eslint-disable-next-line unicorn/prefer-promise-with-resolvers
        const heldSave = new Promise<string>((resolve) => {
            finishSave = resolve;
        });

        harness.saveSiteLogin.mockReturnValueOnce(heldSave).mockResolvedValue("login-1");
        mount();

        await user.type(screen.getByLabelText("Site"), SITE);
        await user.type(screen.getByLabelText("Username or email"), "ada@example.com");
        await user.type(passwordField(), PASSWORD);
        await user.click(screen.getByRole("button", { name: "Save login" }));
        await waitFor(() => expect(harness.saveSiteLogin).toHaveBeenCalledOnce());

        await user.type(screen.getByLabelText("Label (optional)"), "Work");
        // Still the same origin to the server, so still the login being saved.
        await user.type(screen.getByLabelText("Site"), "/");
        finishSave("login-1");

        await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Login saved"));
        expect(valueOf("Label (optional)")).toBe("Work");
        // The saved password is not kept to be sent again with the later edit.
        expect(passwordField().value).toBe("");

        // The kept edits now belong to the saved login: saving them again changes it rather than creating a second one.
        await user.click(screen.getByRole("button", { name: "Save changes" }));
        await waitFor(() => expect(harness.saveSiteLogin).toHaveBeenCalledTimes(2));
        expect(harness.saveSiteLogin.mock.calls[1]?.[0]).toMatchObject({ label: "Work", loginId: "login-1" });
        expect(harness.saveSiteLogin.mock.calls[1]?.[0]).toHaveProperty("password", undefined);
    });

    it("keeps a password typed while a save was in flight, and only that one", async () => {
        const user = userEvent.setup();
        let finishSave: (value: string) => void = () => {};
        // eslint-disable-next-line unicorn/prefer-promise-with-resolvers
        const heldSave = new Promise<string>((resolve) => {
            finishSave = resolve;
        });

        harness.saveSiteLogin.mockReturnValueOnce(heldSave).mockResolvedValue("login-1");
        mount();

        await user.type(screen.getByLabelText("Site"), SITE);
        await user.type(screen.getByLabelText("Username or email"), "ada@example.com");
        await user.type(passwordField(), PASSWORD);
        await user.click(screen.getByRole("button", { name: "Save login" }));
        await waitFor(() => expect(harness.saveSiteLogin).toHaveBeenCalledOnce());

        await user.type(passwordField(), "!");
        finishSave("login-1");

        await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Login saved"));
        expect(passwordField().value).toBe(`${PASSWORD}!`);

        await user.click(screen.getByRole("button", { name: "Save changes" }));
        await waitFor(() => expect(harness.saveSiteLogin).toHaveBeenCalledTimes(2));
        expect(harness.saveSiteLogin.mock.calls[1]?.[0]).toMatchObject({ loginId: "login-1", password: `${PASSWORD}!` });
    });

    it("offers no save, edit or delete while an admin impersonates the user, and still lists the logins", async () => {
        harness.impersonatedBy = "admin-1";
        harness.logins = [savedLogin()];
        mount();

        expect(await screen.findByText(USERNAME_TEXT)).toBeDefined();
        expect(screen.getByRole("status").textContent).toContain("while impersonating");
        expect(screen.queryByRole("button", { name: `Edit login for ${SITE}` })).toBeNull();
        expect(screen.queryByRole("button", { name: `Delete login for ${SITE}` })).toBeNull();
        expect(screen.queryByRole("button", { name: "Save login" })).toBeNull();
        expect(screen.queryByLabelText("Password")).toBeNull();
    });

    it("offers save, edit and delete to the user signed in as themselves", async () => {
        harness.logins = [savedLogin()];
        mount();

        expect(await screen.findByRole("button", { name: `Edit login for ${SITE}` })).toBeDefined();
        expect(screen.getByRole("button", { name: `Delete login for ${SITE}` })).toBeDefined();
        expect(screen.getByRole("button", { name: "Save login" })).toBeDefined();
        expect(screen.queryByText("while impersonating", { exact: false })).toBeNull();
    });

    it("keeps the open edit when its delete fails", async () => {
        const user = userEvent.setup();

        harness.logins = [savedLogin()];
        harness.deleteSiteLogin.mockRejectedValue(new Error("offline"));
        mount();

        await user.click(await screen.findByRole("button", { name: `Edit login for ${SITE}` }));
        await user.type(passwordField(), PASSWORD);
        await user.click(screen.getByRole("button", { name: `Delete login for ${SITE}` }));
        await user.click(await screen.findByRole("button", { name: "Delete" }));

        await waitFor(() => expect(harness.deleteSiteLogin).toHaveBeenCalledOnce());
        expect(passwordField().value).toBe(PASSWORD);
        expect(screen.getByRole("button", { name: "Save changes" })).toBeDefined();
    });

    it.each(["pending", "failed"] as const)("does not save an edit while the bot list is %s, which would drop the login's bots", async (state) => {
        const user = userEvent.setup();

        harness.botsState = state;
        harness.logins = [savedLogin(["bot-1"])];
        mount();

        await user.click(await screen.findByRole("button", { name: `Edit login for ${SITE}` }));

        expect(isDisabled(screen.getByRole("button", { name: "Save changes" }))).toBe(true);
    });

    it("stops ticking bots at the most a login may name", async () => {
        const user = userEvent.setup();

        harness.bots = botsOf("user-a", 21);
        mount();

        const boxes = await screen.findAllByRole("checkbox");

        for (const box of boxes.slice(0, 20)) {
            await user.click(box);
        }

        expect(isDisabled(boxes[20])).toBe(true);
        expect(screen.getByRole("status").textContent).toContain("at most 20 bots");
        expect(isDisabled(boxes[0])).toBe(false);
    });

    it("does not count a deleted bot toward the limit", async () => {
        const user = userEvent.setup();

        harness.bots = botsOf("user-a", 21);
        harness.logins = [savedLogin([...harness.bots.slice(0, 19).map((bot) => bot._id), "bot-deleted"])];
        mount();

        await user.click(await screen.findByRole("button", { name: `Edit login for ${SITE}` }));

        const boxes = screen.getAllByRole("checkbox");

        expect(isDisabled(boxes[19])).toBe(false);
        expect(screen.queryByRole("status")).toBeNull();
    });

    it("keeps a teammate the cached bot list has not seen yet on an edit of the label alone", async () => {
        const user = userEvent.setup();

        harness.bots = botsOf("user-a", 1);
        // A bot made in another session: the login already names it, the cached list does not have it yet.
        harness.logins = [savedLogin(["bot-0", "bot-new"])];
        harness.saveSiteLogin.mockResolvedValue("login-1");
        mount();

        await user.click(await screen.findByRole("button", { name: `Edit login for ${SITE}` }));
        await user.type(screen.getByLabelText("Label (optional)"), "Work");
        await user.click(screen.getByRole("button", { name: "Save changes" }));

        await waitFor(() => expect(harness.saveSiteLogin).toHaveBeenCalledOnce());
        expect(harness.saveSiteLogin.mock.calls[0]?.[0]).toMatchObject({ teammateIds: ["bot-0", "bot-new"] });
    });

    it("never shows the last account's cached logins or bots after a switch", async () => {
        harness.bots = botsOf("user-a", 1);
        harness.logins = [savedLogin(["bot-0"])];
        const view = mount();

        await screen.findByRole("button", { name: `Edit login for ${SITE}` });
        expect(screen.getByText("Bot 0")).toBeDefined();

        harness.userId = "user-b";
        harness.loginsPending = true;
        harness.botsState = "pending";
        view.rerender();

        expect(screen.queryByRole("button", { name: `Edit login for ${SITE}` })).toBeNull();
        expect(screen.queryByText(USERNAME_TEXT)).toBeNull();
        expect(screen.queryByText("Bot 0")).toBeNull();
    });

    it.each([0, 1])("fetches and shows the new account's logins and bots when a switch finds the last account's (%i bots) still fresh", async (count) => {
        harness.bots = botsOf("user-a", count);
        harness.logins = [savedLogin()];
        const view = mount();

        await screen.findByRole("button", { name: `Edit login for ${SITE}` });
        await waitFor(() => expect(view.queryClient.getQueryData(["bots"])).toHaveLength(count));

        harness.userId = "user-b";
        harness.bots = [{ _id: "bot-b", name: "Bot B", userId: "user-b" }];
        harness.logins = [{ ...savedLogin(["bot-b"]), id: "login-b", site: "https://b.example" }];
        view.rerender();

        expect(await screen.findByRole("button", { name: "Edit login for https://b.example" })).toBeDefined();
        expect(await screen.findByText("Bot B")).toBeDefined();
        expect(screen.queryByText("Bot 0")).toBeNull();
    });

    it("keeps a login's bots on a save while only the last account's empty bot list is cached", async () => {
        const user = userEvent.setup();
        const view = mount();

        await waitFor(() => expect(view.queryClient.getQueryData(["bots"])).toStrictEqual([]));

        harness.userId = "user-b";
        harness.botsState = "pending";
        harness.logins = [savedLogin(["bot-0"])];
        harness.saveSiteLogin.mockResolvedValue("login-1");
        view.rerender();

        await user.click(await screen.findByRole("button", { name: `Edit login for ${SITE}` }));
        await user.click(screen.getByRole("button", { name: "Save changes" }));

        await waitFor(() => expect(harness.saveSiteLogin).toHaveBeenCalledOnce());
        expect(harness.saveSiteLogin.mock.calls[0]?.[0]).toMatchObject({ teammateIds: ["bot-0"] });
    });

    it("calls a login whose bots were all deleted owner-only once the empty bot list was fetched for this user", async () => {
        harness.logins = [savedLogin(["bot-deleted"])];
        mount();

        expect(await screen.findByText(OWN_CHATS_TEXT)).toBeDefined();
        expect(screen.queryByText(CHOSEN_BOTS_TEXT)).toBeNull();
    });

    it("does not call a login owner-only from the last account's empty bot list right after a switch, and does once this user's loads", async () => {
        const view = mount();

        await waitFor(() => expect(view.queryClient.getQueryData(["bots"])).toStrictEqual([]));

        harness.userId = "user-b";
        harness.botsState = "pending";
        harness.logins = [savedLogin(["bot-0"])];
        view.rerender();

        expect(await screen.findByText(CHOSEN_BOTS_TEXT)).toBeDefined();
        expect(screen.queryByText(OWN_CHATS_TEXT)).toBeNull();

        harness.botsState = "loaded";
        await view.queryClient.refetchQueries({ queryKey: ["bots"] });

        expect(await screen.findByText(OWN_CHATS_TEXT)).toBeDefined();
    });

    it("shows a failed login list as an error with a retry, never as an empty list to add to", async () => {
        const user = userEvent.setup();

        harness.loginsFailed = true;
        harness.logins = [savedLogin()];
        mount();

        const alert = await screen.findByRole("alert");

        expect(alert.textContent).toContain("Your saved logins could not be loaded.");
        expect(screen.queryByRole("button", { name: "Save login" })).toBeNull();
        expect(screen.queryByLabelText("Password")).toBeNull();

        harness.loginsFailed = false;
        await user.click(screen.getByRole("button", { name: "Try again" }));

        expect(await screen.findByRole("button", { name: `Edit login for ${SITE}` })).toBeDefined();
        expect(screen.queryByRole("alert")).toBeNull();
    });

    it("says why an edit waits on a failed bot list, and saves it with its bots once the retry loads them", async () => {
        const user = userEvent.setup();

        harness.botsState = "failed";
        harness.logins = [savedLogin(["bot-0"])];
        harness.saveSiteLogin.mockResolvedValue("login-1");
        mount();

        await user.click(await screen.findByRole("button", { name: `Edit login for ${SITE}` }));
        const alert = await screen.findByRole("alert");

        expect(alert.textContent).toContain("Your bots could not be loaded.");
        // Its bots may still use it: the row does not call it owner-only while their names are missing.
        expect(screen.getByText(CHOSEN_BOTS_TEXT)).toBeDefined();
        expect(isDisabled(screen.getByRole("button", { name: "Save changes" }))).toBe(true);

        harness.botsState = "loaded";
        harness.bots = botsOf("user-a", 1);
        await user.click(screen.getByRole("button", { name: "Try again" }));

        expect(await screen.findByText("Bot 0")).toBeDefined();
        expect(screen.queryByRole("alert")).toBeNull();
        await user.click(screen.getByRole("button", { name: "Save changes" }));

        await waitFor(() => expect(harness.saveSiteLogin).toHaveBeenCalledOnce());
        expect(harness.saveSiteLogin.mock.calls[0]?.[0]).toMatchObject({ teammateIds: ["bot-0"] });
    });

    it("keeps an edit savable when a refetch fails but the user's own bots are still cached", async () => {
        const user = userEvent.setup();

        harness.bots = botsOf("user-a", 1);
        harness.logins = [savedLogin(["bot-0"])];
        harness.saveSiteLogin.mockResolvedValue("login-1");
        const view = mount();

        await user.click(await screen.findByRole("button", { name: `Edit login for ${SITE}` }));
        await screen.findByText("Bot 0");

        harness.botsState = "failed";
        await view.queryClient.refetchQueries({ queryKey: ["bots"] });

        await waitFor(() => expect(view.queryClient.getQueryState(["bots"])?.status).toBe("error"));
        expect(screen.queryByRole("alert")).toBeNull();
        await user.click(screen.getByRole("button", { name: "Save changes" }));

        await waitFor(() => expect(harness.saveSiteLogin).toHaveBeenCalledOnce());
        expect(harness.saveSiteLogin.mock.calls[0]?.[0]).toMatchObject({ teammateIds: ["bot-0"] });
    });
});
