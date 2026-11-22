"use client";

import { useLingui } from "@lingui/react/macro";
import { DEFAULT_CHAT_MODEL } from "@neore/ai/constants";
import type { BotToolSelection } from "@neore/backend/bots/tool-selectors";
import type { ThreadPermissionMode } from "@neore/backend/chat/permission-mode";
import { DEFAULT_THREAD_PERMISSION_MODE, isThreadPermissionMode, THREAD_PERMISSION_MODES } from "@neore/backend/chat/permission-mode";
import type { Id } from "@neore/backend/dataModel";
import { Button } from "@neore/ui/components/button";
import ConfirmDialog from "@neore/ui/components/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogTitle } from "@neore/ui/components/dialog";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@neore/ui/components/select";
import { Switch } from "@neore/ui/components/switch";
import { Textarea } from "@neore/ui/components/textarea";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { FC, FormEvent } from "react";
import { useId, useRef, useState } from "react";
import { toast } from "sonner";

import ChangedByAdminMark from "@/features/admin/components/changed-by-admin-mark";
import { useImpersonating } from "@/features/admin/hooks/use-is-impersonating";
import PromptModelSelector from "@/features/prompts/components/prompt-model-selector";
import { BotToolSelectionFields, useToolCatalog } from "@/features/settings/components/chat/bot-tool-selection";
import { useCRPC } from "@/lib/lunora/crpc";

interface BotDraft {
    computerEnabled: boolean;
    description: string;
    instructions: string;
    model: string;
    name: string;
    permissionMode: ThreadPermissionMode;
    toolSelection: BotToolSelection | null;
}

const emptyDraft = (): BotDraft => {
    return {
        computerEnabled: false,
        description: "",
        instructions: "",
        model: DEFAULT_CHAT_MODEL,
        name: "",
        permissionMode: DEFAULT_THREAD_PERMISSION_MODE,
        toolSelection: null,
    };
};

/**
 * Codes with which the server refused a save outright: nothing was stored, unlike a lost or failed answer. Ours and the ones
 * Lunora answers before a handler writes (an input its validator rejects, a body too large, no session).
 */
const REFUSED_SAVE_CODES = new Set([
    "BAD_REQUEST",
    "FORBIDDEN",
    "INVALID_ARGUMENT",
    "NOT_FOUND",
    "PAYLOAD_TOO_LARGE",
    "TOO_MANY_REQUESTS",
    "UNAUTHORIZED",
    "UNPROCESSABLE",
    "VALIDATION_ERROR",
]);

/** How a tools save ended: stored, refused (with the server's reason), refused as made from an older pick, or not known. */
type ToolsSaveOutcome = { kind: "conflict" } | { kind: "refused"; reason: string } | { kind: "saved"; stored: BotToolSelection | null } | { kind: "unknown" };

/** Runs a tools save and sorts out how it ended; kept out of the component, whose compiler skips a try with conditionals. */
const runToolsSave = async (save: () => Promise<{ toolSelection: BotToolSelection | null }>): Promise<ToolsSaveOutcome> => {
    try {
        const { toolSelection } = await save();

        return { kind: "saved", stored: toolSelection };
    } catch (error: unknown) {
        const { code, message } = (typeof error === "object" && error !== null ? error : {}) as { code?: unknown; message?: unknown };

        if (code === "CONFLICT") {
            return { kind: "conflict" };
        }

        if (typeof code === "string" && REFUSED_SAVE_CODES.has(code)) {
            return { kind: "refused", reason: typeof message === "string" ? message : "" };
        }

        return { kind: "unknown" };
    }
};

/**
 * The bot's stored pick from a fresh read of the bots list: `undefined` when the read failed or the bot is gone, so a dialog
 * is never reset to a pick that is not known to be the stored one.
 */
const readStoredToolSelection = async (queryClient: QueryClient, queryKey: QueryKey, botId: string): Promise<BotToolSelection | null | undefined> => {
    const asked = Date.now();

    await queryClient.invalidateQueries({ queryKey });

    const state = queryClient.getQueryState<{ _id: string; toolSelection?: BotToolSelection }[]>(queryKey);

    if (state === undefined || state.dataUpdatedAt < asked || state.data === undefined) {
        return undefined;
    }

    const bot = state.data.find((row) => row._id === botId);

    return bot === undefined ? undefined : (bot.toolSelection ?? null);
};

/** The bots list with one bot's tool selection replaced by the one the server stored (`null`: every tool, stored as none). */
const withStoredSelection = <T extends { _id: string; toolSelection?: BotToolSelection }>(
    bots: T[] | undefined,
    botId: string,
    stored: BotToolSelection | null,
): T[] | undefined => bots?.map((bot) => (bot._id === botId ? { ...bot, toolSelection: stored ?? undefined } : bot));

interface PermissionModeSelectProps {
    "aria-describedby"?: string;
    "aria-label"?: string;
    disabled?: boolean;
    id?: string;
    onChange: (mode: ThreadPermissionMode) => void;
    value: ThreadPermissionMode;
}

/** The three modes a bot's new chats can start in, in the backend's order. */
const PermissionModeSelect: FC<PermissionModeSelectProps> = ({ onChange, value, ...trigger }) => {
    const { t } = useLingui();
    const labels: Record<ThreadPermissionMode, string> = {
        auto: t`Auto`,
        full: t`Full access`,
        supervised: t`Supervised`,
    };

    return (
        <Select
            disabled={trigger.disabled}
            onValueChange={(next: string | null) => {
                if (isThreadPermissionMode(next)) {
                    onChange(next);
                }
            }}
            value={value}
        >
            <SelectTrigger aria-describedby={trigger["aria-describedby"]} aria-label={trigger["aria-label"]} id={trigger.id}>
                <SelectValue>{(selected: string | null) => (isThreadPermissionMode(selected) ? labels[selected] : labels.auto)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
                {THREAD_PERMISSION_MODES.map((mode) => (
                    <SelectItem key={mode} value={mode}>
                        {labels[mode]}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
};

/**
 * Bots: a named persona with its own memory and, optionally, its own computer.
 * Chatting with a bot opens a new thread that runs as that bot.
 */
const BotsSettings = () => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const nameId = useId();
    const descriptionId = useId();
    const instructionsId = useId();
    const computerId = useId();
    const modelLabelId = useId();
    const modeId = useId();
    const modeDescriptionId = useId();

    const botsQuery = crpc.bots.functions.listBots.queryOptions({});
    const { data: bots = [], isLoading } = useQuery(botsQuery);
    const createMutation = useMutation(crpc.bots.functions.createBot.mutationOptions());
    const deleteMutation = useMutation(crpc.bots.functions.deleteBot.mutationOptions());
    const updateMutation = useMutation(crpc.bots.functions.updateBot.mutationOptions());
    const keepMutation = useMutation(crpc.bots.functions.keepBotInstructions.mutationOptions());
    const chatMutation = useMutation(crpc.chat.functions.createThread.mutationOptions());
    // The server refuses a mode change from an admin acting as the owner; held off too while the session is not read yet.
    const impersonating = useImpersonating();

    const [draft, setDraft] = useState<BotDraft>(emptyDraft);
    // Bumped on each create, so the next bot's tool fields start fresh instead of bringing back the last bot's lists.
    const [createdCount, setCreatedCount] = useState(0);
    // A tool typed into a list but not added (an unknown name, a full list): the save is refused until it is added or cleared.
    const [createToolsPending, setCreateToolsPending] = useState(false);
    const [editToolsPending, setEditToolsPending] = useState(false);
    const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);
    // The tools dialog edits a copy: the bot's stored selection changes only once the server took the save.
    // `opened`: the stored pick the copy was made from, sent with the save so a pick saved elsewhere since is never overwritten.
    // `touched`: the person changed the copy or typed into it; `revision` remounts the fields when the copy is replaced.
    const [editingTools, setEditingTools] = useState<{
        id: string;
        name: string;
        opened: BotToolSelection | null;
        revision: number;
        selection: BotToolSelection | null;
        touched: boolean;
    } | null>(null);
    // Counts each opening of the tools dialog: a save closes only the dialog it was started from, never one reopened since.
    const toolsDialogSession = useRef(0);
    const toolCatalog = useToolCatalog();

    const canCreate = draft.name.trim().length > 0 && draft.instructions.trim().length > 0;
    // The create sends the draft as it was when clicked and then clears the form: a change made meanwhile would be lost.
    const creating = createMutation.isPending;

    const handleCreate = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        if (!canCreate) {
            return;
        }

        if (createToolsPending) {
            toast.error(t`A tool you typed was not added. Add it or clear the field first.`);

            return;
        }

        try {
            await createMutation.mutateAsync({
                computerEnabled: draft.computerEnabled,
                description: draft.description.trim() || undefined,
                instructions: draft.instructions.trim(),
                model: draft.model,
                name: draft.name.trim(),
                // Auto is stored as nothing: a bot with no mode runs exactly as one set to auto.
                ...(draft.permissionMode !== DEFAULT_THREAD_PERMISSION_MODE && { permissionMode: draft.permissionMode }),
                ...(draft.toolSelection !== null && { toolSelection: draft.toolSelection }),
            });
            setDraft(emptyDraft());
            setCreatedCount((count) => count + 1);
            setCreateToolsPending(false);
            await queryClient.invalidateQueries({ queryKey: botsQuery.queryKey });
            toast.success(t`Bot created`);
        } catch {
            toast.error(t`Could not create the bot.`);
        }
    };

    const handleChat = async (bot: { _id: string; model: string; name: string }) => {
        try {
            const threadId = await chatMutation.mutateAsync({ botId: bot._id, model: bot.model, title: bot.name });

            await navigate({ params: { threadId }, to: "/chat/$threadId" });
        } catch {
            toast.error(t`Could not start a chat with this bot.`);
        }
    };

    const handleModeChange = async (botId: string, permissionMode: ThreadPermissionMode) => {
        try {
            await updateMutation.mutateAsync({ botId: botId as Id<"bots">, patch: { permissionMode } });
            await queryClient.invalidateQueries({ queryKey: botsQuery.queryKey });
            toast.success(t`New chats with this bot start in the chosen mode`);
        } catch {
            toast.error(t`Could not change the bot's permission mode.`);
        }
    };

    const handleToolsSave = async () => {
        if (!editingTools) {
            return;
        }

        if (editToolsPending) {
            toast.error(t`A tool you typed was not added. Add it or clear the field first.`);

            return;
        }

        // Nothing changed: nothing to write, so a copy read before a save in another tab cannot put the old pick back.
        if (!editingTools.touched) {
            setEditingTools(null);

            return;
        }

        const session = toolsDialogSession.current;
        const { id: savedId, opened, selection: saved } = editingTools;
        const outcome = await runToolsSave(
            async () => await updateMutation.mutateAsync({ botId: savedId as Id<"bots">, expectedToolSelection: opened, patch: { toolSelection: saved } }),
        );

        if (outcome.kind === "conflict") {
            // Saved elsewhere since this copy was read: the copy is replaced by the stored pick, to be changed again from there,
            // unless it was edited again while the save was out (`saved` is replaced by each edit).
            const current = await readStoredToolSelection(queryClient, botsQuery.queryKey, savedId);

            if (current === undefined) {
                toast.error(t`This bot's tools were changed elsewhere. Close this dialog and open it again to see them.`);

                return;
            }

            if (toolsDialogSession.current === session) {
                setEditToolsPending(false);
                setEditingTools((open) =>
                    open !== null && open.selection === saved
                        ? { ...open, opened: current, revision: open.revision + 1, selection: current, touched: false }
                        : open,
                );
            }

            toast.error(t`This bot's tools were changed elsewhere. They are shown as saved now; make your change again.`);

            return;
        }

        if (outcome.kind === "refused") {
            // Refused outright: nothing was stored, and the server's reason says what to change.
            toast.error(t`Could not save the bot's tools. Its tools are unchanged.`, outcome.reason === "" ? undefined : { description: outcome.reason });

            return;
        }

        if (outcome.kind === "unknown") {
            // The answer was lost or failed, so whether the save landed is not known: the pick stays in the dialog and the list is
            // read again. Saving once more is refused as a conflict if it did land, and then shows the stored pick.
            toast.error(t`Could not confirm that the bot's tools were saved. Check them and try again.`);
            void queryClient.invalidateQueries({ queryKey: botsQuery.queryKey });

            return;
        }

        const { stored } = outcome;

        // The list takes the stored pick before the dialog closes, so a reopen before the server's push starts from it, never from the old one.
        // A read already in flight is dropped first: it left before the save and would put the old pick back.
        await queryClient.cancelQueries({ queryKey: botsQuery.queryKey });
        queryClient.setQueryData<typeof bots>(botsQuery.queryKey, (current) => withStoredSelection(current, savedId, stored));

        // Settled as soon as the save landed, before the server's push: a reopened copy must not be saved back meanwhile.
        if (toolsDialogSession.current === session) {
            setEditingTools(null);
        } else {
            // Reopened meanwhile: an untouched copy of this bot was read before this save landed, so it takes the saved pick
            // rather than writing the old one back on its own save.
            setEditingTools((current) =>
                current?.id === savedId && !current.touched ? { ...current, opened: stored, revision: current.revision + 1, selection: stored } : current,
            );
        }

        // No refetch: while the list is subscribed, a refetch is answered from the subscription's copy, read before this save,
        // until the server's push brings the stored row; it would put the old pick back meanwhile.
        toast.success(t`The bot's tools were saved`);
    };

    const handleDelete = async () => {
        if (!pendingDelete) {
            return;
        }

        try {
            await deleteMutation.mutateAsync({ botId: pendingDelete.id as Id<"bots"> });
            await queryClient.invalidateQueries({ queryKey: botsQuery.queryKey });
            toast.success(t`Bot deleted`);
        } catch {
            toast.error(t`Could not delete the bot.`);
        } finally {
            setPendingDelete(null);
        }
    };

    return (
        <section className="space-y-8">
            <form className="space-y-4" onSubmit={handleCreate}>
                <h2 className="text-lg font-semibold">{t`New bot`}</h2>
                <div className="space-y-2">
                    <Label htmlFor={nameId}>{t`Name`}</Label>
                    <Input
                        disabled={creating}
                        id={nameId}
                        maxLength={120}
                        onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                        value={draft.name}
                    />
                </div>
                <div className="space-y-2">
                    <Label htmlFor={descriptionId}>{t`Description`}</Label>
                    <Input
                        disabled={creating}
                        id={descriptionId}
                        maxLength={500}
                        onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                        value={draft.description}
                    />
                </div>
                <div className="space-y-2">
                    <Label htmlFor={instructionsId}>{t`Instructions`}</Label>
                    <Textarea
                        disabled={creating}
                        id={instructionsId}
                        maxLength={20_000}
                        onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
                        value={draft.instructions}
                    />
                </div>
                <div aria-labelledby={modelLabelId} className="space-y-2" role="group">
                    <Label id={modelLabelId}>{t`Model`}</Label>
                    <PromptModelSelector
                        disabled={creating}
                        onChange={(model) => setDraft({ ...draft, model: model ?? DEFAULT_CHAT_MODEL })}
                        value={draft.model}
                    />
                </div>
                <div className="space-y-2">
                    <Label htmlFor={modeId}>{t`Permission mode`}</Label>
                    <p className="text-muted-foreground text-xs" id={modeDescriptionId}>
                        {t`The mode each new chat with this bot starts in. You can still change it per chat. Scheduled runs use it only when it asks more.`}
                    </p>
                    <PermissionModeSelect
                        aria-describedby={modeDescriptionId}
                        disabled={impersonating || creating}
                        id={modeId}
                        onChange={(permissionMode) => setDraft({ ...draft, permissionMode })}
                        value={draft.permissionMode}
                    />
                </div>
                <BotToolSelectionFields
                    catalog={toolCatalog}
                    disabled={impersonating || creating}
                    key={createdCount}
                    onChange={(toolSelection) => setDraft({ ...draft, toolSelection })}
                    onPendingChange={setCreateToolsPending}
                    value={draft.toolSelection}
                />
                <div className="flex items-center justify-between gap-4">
                    <div>
                        <Label htmlFor={computerId}>{t`Computer`}</Label>
                        <p className="text-muted-foreground text-xs">{t`A sandbox the bot keeps between chats. Paused when idle, not billed while paused.`}</p>
                    </div>
                    <Switch
                        checked={draft.computerEnabled}
                        disabled={creating}
                        id={computerId}
                        onCheckedChange={(checked: boolean) => setDraft({ ...draft, computerEnabled: checked })}
                    />
                </div>
                <Button disabled={!canCreate || creating} type="submit">
                    {creating ? t`Creating bot…` : t`Create bot`}
                </Button>
                <p className="sr-only" role="status">
                    {creating && t`Creating bot…`}
                </p>
            </form>

            <div className="space-y-3">
                <h2 className="text-lg font-semibold">{t`Your bots`}</h2>
                {isLoading && (
                    <p className="text-muted-foreground text-sm" role="status">
                        {t`Loading…`}
                    </p>
                )}
                {!isLoading && bots.length === 0 && <p className="text-muted-foreground text-sm">{t`No bots yet.`}</p>}
                <ul className="divide-border divide-y">
                    {bots.map((bot) => (
                        <li className="flex flex-wrap items-center justify-between gap-4 py-3" key={bot._id}>
                            <div className="min-w-0">
                                <p className="truncate font-medium">{bot.name}</p>
                                {bot.description && <p className="text-muted-foreground truncate text-sm">{bot.description}</p>}
                                {bot.computerEnabled && <p className="text-muted-foreground text-xs">{t`Has a computer`}</p>}
                                {bot.toolSelection && <p className="text-muted-foreground text-xs">{t`Custom tools`}</p>}
                                {bot.instructionsByImpersonator && (
                                    <ChangedByAdminMark
                                        fieldLabel={t`Name and instructions of ${bot.name}`}
                                        onKeep={async () => await keepMutation.mutateAsync({ botId: bot._id as Id<"bots"> })}
                                    />
                                )}
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                                <PermissionModeSelect
                                    aria-label={t`Permission mode for ${bot.name}`}
                                    disabled={impersonating || updateMutation.isPending}
                                    onChange={(permissionMode) => handleModeChange(bot._id, permissionMode)}
                                    value={bot.permissionMode ?? DEFAULT_THREAD_PERMISSION_MODE}
                                />
                                <Button
                                    aria-label={t`Tools for ${bot.name}`}
                                    disabled={impersonating}
                                    onClick={() => {
                                        toolsDialogSession.current += 1;
                                        setEditToolsPending(false);
                                        setEditingTools({
                                            id: bot._id,
                                            name: bot.name,
                                            opened: bot.toolSelection ?? null,
                                            revision: 0,
                                            selection: bot.toolSelection ?? null,
                                            touched: false,
                                        });
                                    }}
                                    size="sm"
                                    type="button"
                                    variant="outline"
                                >
                                    {t`Tools`}
                                </Button>
                                <Button onClick={() => handleChat(bot)} size="sm" type="button" variant="outline">
                                    {t`Chat`}
                                </Button>
                                <Button
                                    aria-label={t`Delete ${bot.name}`}
                                    onClick={() => setPendingDelete({ id: bot._id, name: bot.name })}
                                    size="sm"
                                    type="button"
                                    variant="ghost"
                                >
                                    {t`Delete`}
                                </Button>
                            </div>
                        </li>
                    ))}
                </ul>
            </div>

            <Dialog
                onOpenChange={(open: boolean) => {
                    if (!open) {
                        setEditingTools(null);
                    }
                }}
                open={editingTools !== null}
            >
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{t`Tools for ${editingTools?.name ?? ""}`}</DialogTitle>
                        <DialogDescription>{t`Every chat and scheduled run of this bot gets only these tools. Your tool permissions still apply.`}</DialogDescription>
                    </DialogHeader>
                    <DialogPanel>
                        {editingTools && (
                            <BotToolSelectionFields
                                catalog={toolCatalog}
                                disabled={updateMutation.isPending}
                                key={editingTools.revision}
                                onChange={(selection) => setEditingTools({ ...editingTools, selection, touched: true })}
                                onPendingChange={(pending) => {
                                    setEditToolsPending(pending);

                                    if (pending) {
                                        setEditingTools((current) => current && { ...current, touched: true });
                                    }
                                }}
                                value={editingTools.selection}
                            />
                        )}
                    </DialogPanel>
                    <DialogFooter>
                        <Button onClick={() => setEditingTools(null)} type="button" variant="outline">
                            {t`Cancel`}
                        </Button>
                        <Button disabled={updateMutation.isPending} onClick={handleToolsSave} type="button">
                            {updateMutation.isPending ? t`Saving tools…` : t`Save tools`}
                        </Button>
                        <p className="sr-only" role="status">
                            {updateMutation.isPending && t`Saving tools…`}
                        </p>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <ConfirmDialog
                confirmLabel={t`Delete`}
                description={t`The bot and its computer are removed. Its chats stay, as plain chats.`}
                loading={deleteMutation.isPending}
                onConfirm={handleDelete}
                onOpenChange={(open) => {
                    if (!open) {
                        setPendingDelete(null);
                    }
                }}
                open={pendingDelete !== null}
                title={t`Delete ${pendingDelete?.name ?? ""}?`}
            />
        </section>
    );
};

export default BotsSettings;
