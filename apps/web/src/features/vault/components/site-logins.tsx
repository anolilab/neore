"use client";

import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { SIGN_IN_URL_MAX, SITE_LOGIN_CHANGED, SITE_LOGIN_SIGN_IN_PAGE_REFUSED } from "@neore/backend/vault/site-login-shape";
import { normalizeSiteOrigin } from "@neore/backend/vault/site-origin";
import { Button } from "@neore/ui/components/button";
import { Checkbox } from "@neore/ui/components/checkbox";
import ConfirmDialog from "@neore/ui/components/confirm-dialog";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import type { FetchQueryOptions, Mutation, QueryClient } from "@tanstack/react-query";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Pencil, Trash2 } from "lucide-react";
import type { FormEvent } from "react";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { useImpersonationState } from "@/features/admin/hooks/use-is-impersonating";
import { useAuthSession } from "@/features/auth/hooks/use-auth-session";
import { useCRPC } from "@/lib/lunora/crpc";

/** Bots one login may name; the server's `MAX_SITE_LOGIN_TEAMMATES`. */
const MAX_TEAMMATES = 20;

/** A saved login as this form last knew it: what an edit was opened from, or what its last save wrote. */
interface OpenedLogin {
    label: string;
    signInUrl: string;
    teammateIds: Id<"bots">[];
    /** The server's version of the login; a save of an older one is refused (`SITE_LOGIN_CHANGED`). */
    updatedAt: number;
    username: string;
}

interface LoginDraft {
    /** Set while editing a saved login; its site cannot change. */
    id?: Id<"savedSiteLogins">;
    label: string;
    /** Set with `id`. */
    opened?: OpenedLogin;
    password: string;
    /** The page with the login form; empty for none. */
    signInUrl: string;
    site: string;
    teammateIds: Id<"bots">[];
    username: string;
}

interface ListedLogin {
    id: Id<"savedSiteLogins">;
    label?: string;
    signInUrl?: string;
    site: string;
    teammateIds: Id<"bots">[];
    updatedAt: number;
    username: string;
}

const emptyDraft = (): LoginDraft => {
    return { label: "", password: "", signInUrl: "", site: "", teammateIds: [], username: "" };
};

/**
 * An edit of `login`. `savedHere` is the version a save from this form wrote, when the listed row may predate it; the
 * fields are the listed ones either way, as a save here writes what the form shows.
 */
const editDraft = (login: ListedLogin, savedHere?: number): LoginDraft => {
    const updatedAt = Math.max(login.updatedAt, savedHere ?? 0);
    const opened = { label: login.label ?? "", signInUrl: login.signInUrl ?? "", teammateIds: login.teammateIds, updatedAt, username: login.username };

    return {
        id: login.id,
        label: opened.label,
        opened,
        password: "",
        signInUrl: opened.signInUrl,
        site: login.site,
        teammateIds: opened.teammateIds,
        username: opened.username,
    };
};

/**
 * What the save sends: a trimmed draft, with an empty password meaning "keep the saved one". The teammate ids go
 * unfiltered: a bot missing from the cached list may be deleted, or new and not loaded here yet, and only the server
 * can tell. It keeps the caller's own existing bots and drops the rest.
 */
const saveArgs = (draft: LoginDraft) => {
    return {
        expectedUpdatedAt: draft.opened?.updatedAt,
        label: draft.label.trim() || undefined,
        loginId: draft.id,
        password: draft.password === "" ? undefined : draft.password,
        // Always sent, empty for none, so clearing the field removes the saved page.
        signInUrl: draft.signInUrl.trim(),
        site: draft.site.trim(),
        teammateIds: draft.teammateIds,
        username: draft.username.trim(),
    };
};

/** Whether two typed sites name the same login: the server keys a login by its normalised origin, not the text typed. */
const sameSite = (a: string, b: string): boolean => {
    const origin = normalizeSiteOrigin(a);

    return origin !== null && origin === normalizeSiteOrigin(b);
};

/**
 * Empties the form only if it still holds `submitted`. Edits made while that save was in flight were not sent, so they
 * stay; when the save created the login, they become an edit of it, so saving them again does not create a second one.
 * Either way they now edit the version just saved. The password just saved never stays: kept, it would be sent again
 * with the later edit. One typed since the submit stays.
 *
 * An edit is still the submitted one while it edits the same login. A new login has no id yet, so it is the submitted
 * one while its site names the same origin, as the server keys a login by it: a draft moved to another site, or one
 * that does not parse yet, stays a new login, without the password just saved for the other site. An edit of another
 * login opened meanwhile starts with no password, so one in it was typed there and stays.
 */
const afterSave =
    (submitted: LoginDraft, saved: { id: Id<"savedSiteLogins">; signInUrl?: string; updatedAt: number }) =>
    (current: LoginDraft): LoginDraft => {
        if (current === submitted) {
            return emptyDraft();
        }

        const sameDraft = submitted.id === undefined ? current.id === undefined && sameSite(current.site, submitted.site) : current.id === submitted.id;
        const password = current.password === submitted.password ? "" : current.password;

        if (!sameDraft) {
            return current.id !== undefined || password === current.password ? current : { ...current, password };
        }

        // The page as the server stored it (no fragment): an unchanged field takes it too, so a later conflict reload does
        // not read the submitted spelling as an edit made here.
        const storedPage = saved.signInUrl ?? "";
        const opened = {
            label: submitted.label.trim(),
            signInUrl: storedPage,
            teammateIds: submitted.teammateIds,
            updatedAt: saved.updatedAt,
            username: submitted.username.trim(),
        };
        const signInUrl = current.signInUrl === submitted.signInUrl ? storedPage : current.signInUrl;

        return { ...current, id: saved.id, opened, password, signInUrl };
    };

/** The `data.code` a refused save carries, if any. */
const refusalCode = (error: unknown): unknown => {
    const { data } = (typeof error === "object" && error !== null ? error : {}) as { data?: { code?: unknown } };

    return data?.code;
};

/** Whether a save was refused because the login changed after this form read it. */
const changedElsewhere = (error: unknown): boolean => refusalCode(error) === SITE_LOGIN_CHANGED;

/**
 * After a save of `submitted` was refused as stale: the edit, if the form still holds it, moved onto `fresh`, the login as
 * the server now has it (gone: the form empties). Username, label and sign-in page keep what the person changed since opening it, and
 * otherwise take the saved one. The bots are the saved ones, less any the person unticked: a bot removed elsewhere is
 * never written back, and none ticked here is added without being seen again. The password is never kept.
 */
const reloadAfterConflict =
    (submitted: LoginDraft, fresh: ListedLogin | undefined) =>
    (current: LoginDraft): LoginDraft => {
        if (current.id === undefined || current.id !== submitted.id) {
            return current;
        }

        if (fresh === undefined) {
            return emptyDraft();
        }

        const { opened } = current;
        const reloaded = editDraft(fresh);
        const unticked = new Set((opened?.teammateIds ?? []).filter((id) => !current.teammateIds.includes(id)));

        return {
            ...reloaded,
            label: opened !== undefined && current.label !== opened.label ? current.label : reloaded.label,
            signInUrl: opened !== undefined && current.signInUrl !== opened.signInUrl ? current.signInUrl : reloaded.signInUrl,
            teammateIds: reloaded.teammateIds.filter((id) => !unticked.has(id)),
            username: opened !== undefined && current.username !== opened.username ? current.username : reloaded.username,
        };
    };

/** Empties the form when it is editing the login `id`, which is gone. */
const clearIfEditing =
    (id: Id<"savedSiteLogins">) =>
    (current: LoginDraft): LoginDraft =>
        current.id === id ? emptyDraft() : current;

/** Keeps an edit of `submitted` that could not be reloaded, without the password its refused save carried. */
const dropPasswordIfEditing =
    (submitted: LoginDraft) =>
    (current: LoginDraft): LoginDraft =>
        current.id !== undefined && current.id === submitted.id ? { ...current, password: "" } : current;

type ListRead = { logins: ListedLogin[]; userId: string };

/** The list as the server has it now, or `undefined` when it could not be read. */
const readLoginsNow = async (queryClient: QueryClient, options: FetchQueryOptions<ListRead>): Promise<ListRead | undefined> => {
    try {
        return await queryClient.fetchQuery({ ...options, staleTime: 0 });
    } catch {
        return undefined;
    }
};

const errorText = (error: unknown, fallback: string): string => (error instanceof Error && error.message !== "" ? error.message : fallback);

const SiteLoginsForm = ({ userId }: { userId: string }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const queryClient = useQueryClient();
    const headingId = useId();
    const siteId = useId();
    const signInUrlId = useId();
    const signInUrlHintId = useId();
    const usernameId = useId();
    const passwordId = useId();
    const labelId = useId();
    const teammatesId = useId();
    // The server refuses a save or delete to an admin acting as this account. Until the session shows whose it is, the
    // controls are withheld without a reason, so an ordinary user never reads one (as the API key card does).
    const impersonation = useImpersonationState();
    const canWrite = impersonation === "self";

    const loginsQuery = crpc.vault.site_logins.listSiteLogins.queryOptions({});
    const { data: loginList, isError: loginListFailed, isFetching: loginsFetching, refetch: refetchLogins } = useQuery(loginsQuery);
    const {
        data: botListData,
        dataUpdatedAt: botsUpdatedAt,
        isError: botListFailed,
        isFetching: botsFetching,
        refetch: refetchBots,
    } = useQuery(crpc.bots.functions.listBots.queryOptions({}));
    const botList = botListData ?? [];
    // The query keys carry no user: right after an account switch they can still hold the last account's lists, even
    // fresh ones. Show only what is this user's, and refetch below.
    const logins = loginList?.userId === userId ? loginList.logins : [];
    const bots = botList.filter((bot) => bot.userId === userId);
    // A failed refetch keeps the cached list, and that still counts: what matters is whose it is.
    const botsLoaded = botListData !== undefined && bots.length === botList.length;
    const holdsAnotherAccountsLogins = loginList !== undefined && loginList.userId !== userId;
    // A list that failed is not an empty one: say so, and offer no form that could act on it.
    const loginsFailed = loginListFailed && loginList?.userId !== userId;
    const holdsAnotherAccountsBots = botListData !== undefined && !botsLoaded;

    useEffect(() => {
        if (holdsAnotherAccountsLogins) {
            void queryClient.invalidateQueries({ queryKey: crpc.vault.site_logins.listSiteLogins.queryKey({}) });
        }
    }, [crpc, holdsAnotherAccountsLogins, queryClient]);

    useEffect(() => {
        if (holdsAnotherAccountsBots) {
            void queryClient.invalidateQueries({ queryKey: crpc.bots.functions.listBots.queryKey({}) });
        }
    }, [crpc, holdsAnotherAccountsBots, queryClient]);

    // The form mounts once per account (`key={userId}`), so a bot list written before it mounted may be the last account's.
    const [mountedAt] = useState(() => Date.now());

    // An empty bot list names no user: one cached when the form mounts may be the last account's, and so may one a fetch
    // still in flight from before the switch brings back. Both are fetched again for this user.
    useEffect(() => {
        const queryKey = crpc.bots.functions.listBots.queryKey({});
        const state = queryClient.getQueryState<unknown[]>(queryKey);

        if (state?.data?.length === 0 || state?.fetchStatus === "fetching") {
            void queryClient.invalidateQueries({ queryKey });
        }
    }, [crpc, queryClient]);

    // A non-empty list names its user. An empty one counts only once fetched after this form mounted: then this user has
    // no bots, and a login still naming some (all deleted) is for their own chats only.
    const knownBots = botsLoaded && (bots.length > 0 || botsUpdatedAt > mountedAt);
    // Offline, the default network mode pauses a write and sends it on reconnect, by then perhaps under another account
    // with the typed password still in it. These fail at once instead. The mutation cache would also keep the password for
    // five minutes after the save settles: `gcTime: 0` and the removal on settle drop it, as Lunora's own hook does for a
    // `v.sensitive` argument.
    const saveMutation = useMutation(
        crpc.vault.site_logins.saveSiteLogin.mutationOptions(
            {
                gcTime: 0,
                networkMode: "always",
                onSettled: (_data: unknown, _error: unknown, variables: unknown) => {
                    const cache = queryClient.getMutationCache();
                    const settled = cache.findAll({ predicate: (entry: Mutation) => entry.state.variables === variables });

                    for (const mutation of settled) {
                        cache.remove(mutation);
                    }
                },
                retry: 0,
            },
            { onlineOnly: true },
        ),
    );
    const deleteMutation = useMutation(crpc.vault.site_logins.deleteSiteLogin.mutationOptions({ networkMode: "always", retry: 0 }, { onlineOnly: true }));
    // A save or delete that ends after an account switch (this form unmounts) does not report to the next account.
    const mounted = useRef(true);
    // The version each save here wrote: the live list may not show it yet, and an edit opened from the older one would be
    // refused as changed elsewhere. A newer version in the list (another tab) still wins.
    const savedVersions = useRef(new Map<Id<"savedSiteLogins">, number>());

    useEffect(() => {
        mounted.current = true;

        return () => {
            mounted.current = false;
        };
    }, []);

    const [draft, setDraft] = useState<LoginDraft>(emptyDraft);
    const [pendingDelete, setPendingDelete] = useState<{ id: Id<"savedSiteLogins">; site: string } | null>(null);

    const isEditing = draft.id !== undefined;
    // An edit waits for the bot list: saved without it, the login's teammates could not be shown or kept as they are.
    const canSave = draft.site.trim() !== "" && draft.username.trim() !== "" && (isEditing ? botsLoaded : draft.password !== "");
    const botName = new Map(bots.map((bot) => [bot._id as string, bot.name]));
    // A deleted bot has no checkbox and the save drops it, so it does not count toward the limit.
    const atTeammateLimit = (knownBots ? draft.teammateIds.filter((id) => botName.has(id)) : draft.teammateIds).length >= MAX_TEAMMATES;

    const toggleTeammate = (botId: Id<"bots">, checked: boolean) => {
        setDraft((current) => {
            return { ...current, teammateIds: checked ? [...current.teammateIds, botId] : current.teammateIds.filter((id) => id !== botId) };
        });
    };

    // The login changed elsewhere since this edit opened it: read it again from the server and move the edit onto it. A
    // one-shot read: the live list answers from its subscription, which may not have the other tab's change yet.
    const reloadLogin = async (submitted: LoginDraft) => {
        const changed = t`This login was changed elsewhere and has been reloaded. Your username, label and sign-in page edits are kept; check its bots, type the password again if you were changing it, and save again.`;
        const read = await readLoginsNow(queryClient, crpc.vault.site_logins.listSiteLogins.queryOptions({}, { live: false }));

        if (!mounted.current) {
            return;
        }

        if (read === undefined || read.userId !== userId) {
            // Not reloaded: the edit stays, without the password, and its next save is refused again.
            setDraft(dropPasswordIfEditing(submitted));
            toast.error(t`This login was changed elsewhere. Reload the page to see it before saving again.`);

            return;
        }

        setDraft(
            reloadAfterConflict(
                submitted,
                read.logins.find((login) => login.id === submitted.id),
            ),
        );
        toast.error(changed);
    };

    const handleSave = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        if (!canSave) {
            return;
        }

        const submitted = draft;
        const args = saveArgs(submitted);
        const saved = isEditing ? t`Login updated` : t`Login saved`;
        const fallback = t`Could not save the login.`;

        // `reset` after each outcome: the hook would otherwise keep the call, password included, until the next save.
        try {
            const written = await saveMutation.mutateAsync(args);

            saveMutation.reset();
            savedVersions.current.set(written.id, written.updatedAt);
            setDraft(afterSave(submitted, written));
            await queryClient.invalidateQueries({ queryKey: loginsQuery.queryKey });

            if (mounted.current) {
                toast.success(saved);
            }
        } catch (error) {
            saveMutation.reset();

            if (changedElsewhere(error)) {
                await reloadLogin(submitted);

                return;
            }

            if (mounted.current) {
                toast.error(
                    refusalCode(error) === SITE_LOGIN_SIGN_IN_PAGE_REFUSED
                        ? t`The sign-in page must be an https:// address on the same site, with no username or password in it.`
                        : errorText(error, fallback),
                );
            }
        }
    };

    const handleDelete = async () => {
        if (!pendingDelete) {
            return;
        }

        const { id } = pendingDelete;

        try {
            await deleteMutation.mutateAsync({ loginId: id });
            // Only once it is gone: a failed delete keeps the edit open.
            setDraft(clearIfEditing(id));
            await queryClient.invalidateQueries({ queryKey: loginsQuery.queryKey });

            if (mounted.current) {
                toast.success(t`Login deleted`);
            }
        } catch {
            if (mounted.current) {
                toast.error(t`Could not delete the login.`);
            }
        }

        setPendingDelete(null);
    };

    return (
        <section aria-labelledby={headingId} className="space-y-6">
            <div className="space-y-1">
                <h2 className="text-lg font-semibold" id={headingId}>{t`Site logins`}</h2>
                <p className="text-muted-foreground text-sm">
                    {t`Logins saved for the agent's browser. Signing in with them comes in a later update: the server will type the password into the site, and the AI never sees it.`}
                </p>
            </div>

            {loginsFailed && (
                <div className="flex flex-wrap items-center gap-3" role="alert">
                    <p className="text-destructive text-sm">{t`Your saved logins could not be loaded.`}</p>
                    <Button
                        disabled={loginsFetching}
                        onClick={() => {
                            void refetchLogins();
                        }}
                        size="sm"
                        variant="outline"
                    >
                        {t`Try again`}
                    </Button>
                </div>
            )}

            {impersonation === "impersonating" && (
                <p className="text-muted-foreground text-sm" role="status">{t`Site logins can't be saved, changed or deleted while impersonating.`}</p>
            )}

            {logins.length > 0 && (
                <ul className="divide-border divide-y rounded-md border">
                    {logins.map((login) => {
                        const teammates = login.teammateIds.map((id) => botName.get(id)).filter((name): name is string => name !== undefined);
                        // Until this user's bots load, a login naming bots cannot be called owner-only.
                        let access = t`Your own chats only`;

                        if (teammates.length > 0) {
                            access = t`Your chats and ${teammates.join(", ")}`;
                        } else if (!knownBots && login.teammateIds.length > 0) {
                            access = t`Your chats and the bots you chose`;
                        }

                        return (
                            <li className="flex items-center gap-3 p-3" key={login.id}>
                                <KeyRound aria-hidden="true" className="text-muted-foreground size-4 shrink-0" />
                                <div className="min-w-0 flex-1">
                                    <p className="truncate text-sm font-medium">{login.label ? `${login.label} · ${login.site}` : login.site}</p>
                                    <p className="text-muted-foreground truncate text-xs">
                                        {login.username} · {t`Password set`} · {access}
                                    </p>
                                    {login.signInUrl && <p className="text-muted-foreground truncate text-xs">{t`Sign-in page: ${login.signInUrl}`}</p>}
                                </div>
                                {canWrite && (
                                    <>
                                        <Button
                                            aria-label={t`Edit login for ${login.site}`}
                                            onClick={() => {
                                                setDraft(editDraft(login, savedVersions.current.get(login.id)));
                                            }}
                                            size="icon"
                                            variant="ghost"
                                        >
                                            <Pencil aria-hidden="true" className="size-4" />
                                        </Button>
                                        <Button
                                            aria-label={t`Delete login for ${login.site}`}
                                            onClick={() => setPendingDelete({ id: login.id, site: login.site })}
                                            size="icon"
                                            variant="ghost"
                                        >
                                            <Trash2 aria-hidden="true" className="size-4" />
                                        </Button>
                                    </>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}

            {!loginsFailed && canWrite && (
                <form className="grid max-w-xl gap-4" onSubmit={handleSave}>
                    <h3 className="text-base font-medium">{isEditing ? t`Edit login` : t`New login`}</h3>
                    <div className="space-y-2">
                        <Label htmlFor={siteId}>{t`Site`}</Label>
                        <Input
                            disabled={isEditing}
                            id={siteId}
                            inputMode="url"
                            onChange={(event) => setDraft({ ...draft, site: event.target.value })}
                            placeholder="https://example.com"
                            required
                            value={draft.site}
                        />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor={signInUrlId}>{t`Sign-in page (optional)`}</Label>
                        <Input
                            aria-describedby={signInUrlHintId}
                            id={signInUrlId}
                            inputMode="url"
                            maxLength={SIGN_IN_URL_MAX}
                            onChange={(event) => setDraft({ ...draft, signInUrl: event.target.value })}
                            placeholder="https://example.com/login"
                            value={draft.signInUrl}
                        />
                        <p className="text-muted-foreground text-xs" id={signInUrlHintId}>
                            {t`The page with the login form. Leave empty to start at the site's front page.`}
                        </p>
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor={usernameId}>{t`Username or email`}</Label>
                        <Input
                            autoComplete="off"
                            id={usernameId}
                            maxLength={320}
                            onChange={(event) => setDraft({ ...draft, username: event.target.value })}
                            required
                            value={draft.username}
                        />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor={passwordId}>{t`Password`}</Label>
                        <Input
                            autoComplete="new-password"
                            id={passwordId}
                            maxLength={1024}
                            onChange={(event) => setDraft({ ...draft, password: event.target.value })}
                            placeholder={isEditing ? t`Leave empty to keep the saved password` : undefined}
                            required={!isEditing}
                            type="password"
                            value={draft.password}
                        />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor={labelId}>{t`Label (optional)`}</Label>
                        <Input id={labelId} maxLength={80} onChange={(event) => setDraft({ ...draft, label: event.target.value })} value={draft.label} />
                    </div>
                    {botListFailed && !botsLoaded && (
                        <div className="flex flex-wrap items-center gap-3" role="alert">
                            <p className="text-destructive text-sm">
                                {t`Your bots could not be loaded. Changes to a saved login can be saved once they load, so its bots are kept.`}
                            </p>
                            <Button
                                disabled={botsFetching}
                                onClick={() => {
                                    void refetchBots();
                                }}
                                size="sm"
                                type="button"
                                variant="outline"
                            >
                                {t`Try again`}
                            </Button>
                        </div>
                    )}
                    {bots.length > 0 && (
                        <fieldset aria-describedby={teammatesId} className="space-y-2">
                            <legend className="text-sm font-medium">{t`Bots that may use it`}</legend>
                            <p className="text-muted-foreground text-xs" id={teammatesId}>
                                {t`Your own chats can always use it. A bot's chats can use it only when you tick that bot here. Shared, public, group and messenger chats never can.`}
                            </p>
                            {atTeammateLimit && (
                                <p className="text-muted-foreground text-xs" role="status">{t`A login can name at most ${MAX_TEAMMATES} bots.`}</p>
                            )}
                            {bots.map((bot) => {
                                const checked = draft.teammateIds.includes(bot._id as Id<"bots">);

                                return (
                                    <Label className="flex items-center gap-2 font-normal" key={bot._id}>
                                        <Checkbox
                                            checked={checked}
                                            disabled={!checked && atTeammateLimit}
                                            onCheckedChange={(next) => toggleTeammate(bot._id as Id<"bots">, next)}
                                        />
                                        {bot.name}
                                    </Label>
                                );
                            })}
                        </fieldset>
                    )}
                    <div className="flex gap-2">
                        <Button disabled={!canSave || saveMutation.isPending} type="submit">
                            {isEditing ? t`Save changes` : t`Save login`}
                        </Button>
                        {isEditing && (
                            <Button onClick={() => setDraft(emptyDraft())} type="button" variant="outline">
                                {t`Cancel`}
                            </Button>
                        )}
                    </div>
                </form>
            )}

            <ConfirmDialog
                confirmLabel={t`Delete`}
                description={t`The agent's browser won't be able to use it to sign in to ${pendingDelete?.site ?? ""}.`}
                loading={deleteMutation.isPending}
                onConfirm={handleDelete}
                onOpenChange={(open) => {
                    if (!open) {
                        setPendingDelete(null);
                    }
                }}
                open={pendingDelete !== null && canWrite}
                title={t`Delete this login?`}
            />
        </section>
    );
};

/**
 * The user's saved site logins, for the agent's browser. The password is write-only: the list shows that one is set,
 * never what it is, and an edit with the field left empty keeps the saved one. The form lives as long as the signed-in
 * user: an account switch starts a fresh one and sign-out removes it, so a typed password never outlasts its account.
 */
const SiteLogins = () => {
    const { data: session } = useAuthSession();
    const userId = session?.user.id;

    return userId ? <SiteLoginsForm key={userId} userId={userId} /> : null;
};

export default SiteLogins;
