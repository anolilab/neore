"use client";

import { useLingui } from "@lingui/react/macro";
import { DEFAULT_CHAT_MODEL } from "@neore/ai/constants";
import type { Id } from "@neore/backend/dataModel";
import { Button } from "@neore/ui/components/button";
import ConfirmDialog from "@neore/ui/components/confirm-dialog";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { Switch } from "@neore/ui/components/switch";
import { Textarea } from "@neore/ui/components/textarea";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { FormEvent } from "react";
import { useId, useState } from "react";
import { toast } from "sonner";

import PromptModelSelector from "@/features/prompts/components/prompt-model-selector";
import { useCRPC } from "@/lib/lunora/crpc";

interface BotDraft {
    computerEnabled: boolean;
    description: string;
    instructions: string;
    model: string;
    name: string;
}

const emptyDraft = (): BotDraft => {
    return { computerEnabled: false, description: "", instructions: "", model: DEFAULT_CHAT_MODEL, name: "" };
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

    const botsQuery = crpc.bots.functions.listBots.queryOptions({});
    const { data: bots = [], isLoading } = useQuery(botsQuery);
    const createMutation = useMutation(crpc.bots.functions.createBot.mutationOptions());
    const deleteMutation = useMutation(crpc.bots.functions.deleteBot.mutationOptions());
    const chatMutation = useMutation(crpc.chat.functions.createThread.mutationOptions());

    const [draft, setDraft] = useState<BotDraft>(emptyDraft);
    const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);

    const canCreate = draft.name.trim().length > 0 && draft.instructions.trim().length > 0;

    const handleCreate = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        if (!canCreate) {
            return;
        }

        try {
            await createMutation.mutateAsync({
                computerEnabled: draft.computerEnabled,
                description: draft.description.trim() || undefined,
                instructions: draft.instructions.trim(),
                model: draft.model,
                name: draft.name.trim(),
            });
            setDraft(emptyDraft());
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
                    <Input id={nameId} maxLength={120} onChange={(event) => setDraft({ ...draft, name: event.target.value })} value={draft.name} />
                </div>
                <div className="space-y-2">
                    <Label htmlFor={descriptionId}>{t`Description`}</Label>
                    <Input
                        id={descriptionId}
                        maxLength={500}
                        onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                        value={draft.description}
                    />
                </div>
                <div className="space-y-2">
                    <Label htmlFor={instructionsId}>{t`Instructions`}</Label>
                    <Textarea
                        id={instructionsId}
                        maxLength={20_000}
                        onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
                        value={draft.instructions}
                    />
                </div>
                <div aria-labelledby={modelLabelId} className="space-y-2" role="group">
                    <Label id={modelLabelId}>{t`Model`}</Label>
                    <PromptModelSelector onChange={(model) => setDraft({ ...draft, model: model ?? DEFAULT_CHAT_MODEL })} value={draft.model} />
                </div>
                <div className="flex items-center justify-between gap-4">
                    <div>
                        <Label htmlFor={computerId}>{t`Computer`}</Label>
                        <p className="text-muted-foreground text-xs">{t`A sandbox the bot keeps between chats. Paused when idle, not billed while paused.`}</p>
                    </div>
                    <Switch
                        checked={draft.computerEnabled}
                        id={computerId}
                        onCheckedChange={(checked: boolean) => setDraft({ ...draft, computerEnabled: checked })}
                    />
                </div>
                <Button disabled={!canCreate || createMutation.isPending} type="submit">
                    {t`Create bot`}
                </Button>
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
                        <li className="flex items-center justify-between gap-4 py-3" key={bot._id}>
                            <div className="min-w-0">
                                <p className="truncate font-medium">{bot.name}</p>
                                {bot.description && <p className="text-muted-foreground truncate text-sm">{bot.description}</p>}
                                {bot.computerEnabled && <p className="text-muted-foreground text-xs">{t`Has a computer`}</p>}
                            </div>
                            <div className="flex shrink-0 gap-2">
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
