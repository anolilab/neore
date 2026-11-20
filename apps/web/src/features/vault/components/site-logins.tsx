"use client";

import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { Button } from "@neore/ui/components/button";
import { Checkbox } from "@neore/ui/components/checkbox";
import ConfirmDialog from "@neore/ui/components/confirm-dialog";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Pencil, Trash2 } from "lucide-react";
import type { FormEvent } from "react";
import { useId, useState } from "react";
import { toast } from "sonner";

import { useCRPC } from "@/lib/lunora/crpc";

interface LoginDraft {
    /** Set while editing a saved login; its site cannot change. */
    id?: Id<"savedSiteLogins">;
    label: string;
    password: string;
    site: string;
    teammateIds: Id<"bots">[];
    username: string;
}

const emptyDraft = (): LoginDraft => {
    return { label: "", password: "", site: "", teammateIds: [], username: "" };
};

/** What the save sends: a trimmed draft, with an empty password meaning "keep the saved one". */
const saveArgs = (draft: LoginDraft, botName: Map<string, string>) => {
    return {
        label: draft.label.trim() || undefined,
        loginId: draft.id,
        password: draft.password === "" ? undefined : draft.password,
        site: draft.site.trim(),
        // Only teammates that still exist: a deleted one is dropped on the next save.
        teammateIds: draft.teammateIds.filter((id) => botName.has(id)),
        username: draft.username.trim(),
    };
};

const errorText = (error: unknown, fallback: string): string => (error instanceof Error && error.message !== "" ? error.message : fallback);

/**
 * The user's saved site logins, for the agent's browser. The password is write-only: the list shows that one is set,
 * never what it is, and an edit with the field left empty keeps the saved one.
 */
const SiteLogins = () => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const queryClient = useQueryClient();
    const headingId = useId();
    const siteId = useId();
    const usernameId = useId();
    const passwordId = useId();
    const labelId = useId();
    const teammatesId = useId();

    const loginsQuery = crpc.vault.site_logins.listSiteLogins.queryOptions({});
    const { data: logins = [] } = useQuery(loginsQuery);
    const { data: bots = [] } = useQuery(crpc.bots.functions.listBots.queryOptions({}));
    const saveMutation = useMutation(crpc.vault.site_logins.saveSiteLogin.mutationOptions());
    const deleteMutation = useMutation(crpc.vault.site_logins.deleteSiteLogin.mutationOptions());

    const [draft, setDraft] = useState<LoginDraft>(emptyDraft);
    const [pendingDelete, setPendingDelete] = useState<{ id: Id<"savedSiteLogins">; site: string } | null>(null);

    const isEditing = draft.id !== undefined;
    const canSave = draft.site.trim() !== "" && draft.username.trim() !== "" && (isEditing || draft.password !== "");
    const botName = new Map(bots.map((bot) => [bot._id as string, bot.name]));

    const toggleTeammate = (botId: Id<"bots">, checked: boolean) => {
        setDraft((current) => {
            return { ...current, teammateIds: checked ? [...current.teammateIds, botId] : current.teammateIds.filter((id) => id !== botId) };
        });
    };

    const handleSave = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        if (!canSave) {
            return;
        }

        const args = saveArgs(draft, botName);
        const saved = isEditing ? t`Login updated` : t`Login saved`;
        const fallback = t`Could not save the login.`;

        try {
            await saveMutation.mutateAsync(args);
            setDraft(emptyDraft());
            await queryClient.invalidateQueries({ queryKey: loginsQuery.queryKey });
            toast.success(saved);
        } catch (error) {
            toast.error(errorText(error, fallback));
        }
    };

    const handleDelete = async () => {
        if (!pendingDelete) {
            return;
        }

        const { id } = pendingDelete;

        if (draft.id === id) {
            setDraft(emptyDraft());
        }

        try {
            await deleteMutation.mutateAsync({ loginId: id });
            await queryClient.invalidateQueries({ queryKey: loginsQuery.queryKey });
            toast.success(t`Login deleted`);
        } catch {
            toast.error(t`Could not delete the login.`);
        }

        setPendingDelete(null);
    };

    return (
        <section aria-labelledby={headingId} className="space-y-6">
            <div className="space-y-1">
                <h2 className="text-lg font-semibold" id={headingId}>{t`Site logins`}</h2>
                <p className="text-muted-foreground text-sm">
                    {t`Logins the agent's browser can sign in with. The password is typed into the site by the server; the AI never sees it.`}
                </p>
            </div>

            {logins.length > 0 && (
                <ul className="divide-border divide-y rounded-md border">
                    {logins.map((login) => {
                        const teammates = login.teammateIds.map((id) => botName.get(id)).filter((name): name is string => name !== undefined);

                        return (
                            <li className="flex items-center gap-3 p-3" key={login.id}>
                                <KeyRound aria-hidden="true" className="text-muted-foreground size-4 shrink-0" />
                                <div className="min-w-0 flex-1">
                                    <p className="truncate text-sm font-medium">{login.label ? `${login.label} · ${login.site}` : login.site}</p>
                                    <p className="text-muted-foreground truncate text-xs">
                                        {login.username} · {t`Password set`} ·{" "}
                                        {teammates.length > 0 ? t`Your chats and ${teammates.join(", ")}` : t`Your own chats only`}
                                    </p>
                                </div>
                                <Button
                                    aria-label={t`Edit login for ${login.site}`}
                                    onClick={() => {
                                        setDraft({
                                            id: login.id,
                                            label: login.label ?? "",
                                            password: "",
                                            site: login.site,
                                            teammateIds: login.teammateIds,
                                            username: login.username,
                                        });
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
                            </li>
                        );
                    })}
                </ul>
            )}

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
                        value={draft.site}
                    />
                </div>
                <div className="space-y-2">
                    <Label htmlFor={usernameId}>{t`Username or email`}</Label>
                    <Input
                        autoComplete="off"
                        id={usernameId}
                        maxLength={320}
                        onChange={(event) => setDraft({ ...draft, username: event.target.value })}
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
                        type="password"
                        value={draft.password}
                    />
                </div>
                <div className="space-y-2">
                    <Label htmlFor={labelId}>{t`Label (optional)`}</Label>
                    <Input id={labelId} maxLength={80} onChange={(event) => setDraft({ ...draft, label: event.target.value })} value={draft.label} />
                </div>
                {bots.length > 0 && (
                    <fieldset aria-describedby={teammatesId} className="space-y-2">
                        <legend className="text-sm font-medium">{t`Bots that may use it`}</legend>
                        <p className="text-muted-foreground text-xs" id={teammatesId}>
                            {t`Your own chats can always use it. A bot's chats can use it only when you tick that bot here. Shared, public, group and messenger chats never can.`}
                        </p>
                        {bots.map((bot) => (
                            <Label className="flex items-center gap-2 font-normal" key={bot._id}>
                                <Checkbox
                                    checked={draft.teammateIds.includes(bot._id as Id<"bots">)}
                                    onCheckedChange={(checked) => toggleTeammate(bot._id as Id<"bots">, checked)}
                                />
                                {bot.name}
                            </Label>
                        ))}
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

            <ConfirmDialog
                confirmLabel={t`Delete`}
                description={t`The agent can no longer sign in to ${pendingDelete?.site ?? ""} with it.`}
                loading={deleteMutation.isPending}
                onConfirm={handleDelete}
                onOpenChange={(open) => {
                    if (!open) {
                        setPendingDelete(null);
                    }
                }}
                open={pendingDelete !== null}
                title={t`Delete this login?`}
            />
        </section>
    );
};

export default SiteLogins;
