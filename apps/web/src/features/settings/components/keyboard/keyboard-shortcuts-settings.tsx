"use client";

import { Field } from "@base-ui/react/field";
import { useLingui } from "@lingui/react/macro";
import { isValidShortcut } from "@neore/backend/auth/shortcut";
import { Button } from "@neore/ui/components/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@neore/ui/components/card";
import { useAppForm } from "@neore/ui/components/form";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { Separator } from "@neore/ui/components/separator";
import { eventToShortcut, formatShortcutForDisplay } from "@neore/ui/utils/keyboard-shortcuts";
import { useMutation } from "@tanstack/react-query";
import type { FC } from "react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import * as z from "zod";

import { findEffortConflicts } from "@/features/keyboard/lib/recorded-shortcut-converter";
import { useKeyboardShortcuts } from "@/features/layout/hooks/use-ui-state";
import type { KeyboardShortcuts } from "@/features/layout/stores/ui-state-store";
import { defaultKeyboardShortcuts, useUIStateStore } from "@/features/layout/stores/ui-state-store";
import { useCRPC } from "@/lib/lunora/crpc";

// Same rule the backend applies on save (`@neore/backend/auth/shortcut`); "" is a cleared binding.
const DUPLICATE_SHORTCUT_MESSAGE = "Already used by another action";
const shortcutValueSchema = z.string().refine(isValidShortcut, { error: "Not a valid shortcut" });

// Exactly the shortcuts this page edits. The store holds more (navigation, audio) that stay fixed.
// Strict, so a key added to the form without a schema entry fails instead of being saved unchecked.
// Two actions on one chord would both fire, so a chord may be bound once; modifier spelling and order do not matter.
const shortcutIdentity = (value: string): string => {
    const parts = value.toLowerCase().split("+");
    const key = parts.pop() ?? "";
    const modifiers = new Set(parts.map((modifier) => (modifier === "cmd" ? "meta" : modifier)));

    return [...[...modifiers].toSorted((a, b) => a.localeCompare(b)), key].join("+");
};

const keyboardShortcutSchema = z
    .strictObject({
        commandPalette: shortcutValueSchema,
        copyLastCodeBlock: shortcutValueSchema,
        decreaseEffort: shortcutValueSchema,
        escape: shortcutValueSchema,
        findInThread: shortcutValueSchema,
        focusSearch: shortcutValueSchema,
        help: shortcutValueSchema,
        increaseEffort: shortcutValueSchema,
        newChat: shortcutValueSchema,
        newTemporaryChat: shortcutValueSchema,
        openModelPicker: shortcutValueSchema,
        sidebarLeft: shortcutValueSchema,
        sidebarRight: shortcutValueSchema,
    })
    .check((context) => {
        const owners = new Map<string, string[]>();

        for (const [key, value] of Object.entries(context.value)) {
            if (!(value && isValidShortcut(value))) {
                continue;
            }

            const identity = shortcutIdentity(value);

            owners.set(identity, [...(owners.get(identity) ?? []), key]);
        }

        // A recorded Control chord also answers to Command on a Mac, so the effort commands are judged by what they register.
        // The fixed bindings (audio, list navigation) are not in the form but register at runtime, so they count too.
        const effortConflicts = Object.keys(findEffortConflicts({ ...useUIStateStore.getState().keyboardShortcuts, ...context.value }));
        const conflicting = new Set([...[...owners.values()].filter((keys) => keys.length > 1).flat(), ...effortConflicts]);

        for (const key of conflicting) {
            context.issues.push({ code: "custom", input: context.value, message: DUPLICATE_SHORTCUT_MESSAGE, path: [key] });
        }
    });

type KeyboardShortcutForm = z.infer<typeof keyboardShortcutSchema>;

const EDITABLE_SHORTCUT_KEYS = Object.keys(keyboardShortcutSchema.shape) as (keyof KeyboardShortcutForm)[];

const pickEditableShortcuts = (shortcuts: Partial<KeyboardShortcuts>): KeyboardShortcutForm =>
    Object.fromEntries(EDITABLE_SHORTCUT_KEYS.map((key) => [key, shortcuts[key] ?? ""])) as KeyboardShortcutForm;

const isDuplicate = (errors: unknown[] | undefined): boolean =>
    (errors ?? []).some((error) => (error as { message?: string } | undefined)?.message === DUPLICATE_SHORTCUT_MESSAGE);

const MODIFIER_KEYS = new Set(["Alt", "Control", "Meta", "Shift"]);

const saveStatus = (state: { canSubmit: boolean; isSubmitting: boolean }): "invalid" | "ready" | "saving" => {
    if (state.isSubmitting) {
        return "saving";
    }

    return state.canSubmit ? "ready" : "invalid";
};

const defaultShortcut = (key: keyof KeyboardShortcutForm): string => formatShortcutForDisplay(defaultKeyboardShortcuts[key] ?? "");

const KeyboardShortcutsSettings: FC = () => {
    const { t } = useLingui();

    const shortcutLabels: Record<keyof KeyboardShortcutForm, string> = {
        commandPalette: t`Command Palette`,
        copyLastCodeBlock: t`Copy Last Code Block`,
        decreaseEffort: t`Decrease Reasoning Effort`,
        escape: t`Escape`,
        findInThread: t`Find in Thread`,
        focusSearch: t`Focus Search`,
        help: t`Help`,
        increaseEffort: t`Increase Reasoning Effort`,
        newChat: t`New Chat`,
        newTemporaryChat: t`New Temporary Chat`,
        openModelPicker: t`Open Model Picker`,
        sidebarLeft: t`Sidebar Left`,
        sidebarRight: t`Sidebar Right`,
    };

    const shortcutDescriptions: Record<keyof KeyboardShortcutForm, string> = {
        commandPalette: t`Open the command palette and global search (${defaultShortcut("commandPalette")})`,
        copyLastCodeBlock: t`Copy the last code block of the latest assistant reply (${defaultShortcut("copyLastCodeBlock")})`,
        decreaseEffort: t`Lower the composer's reasoning effort by one step. Not bound by default.`,
        escape: t`Close dialogs and menus`,
        findInThread: t`Search the open thread's messages and highlight the matches. Leave it unbound to keep the browser's find (${defaultShortcut("findInThread")})`,
        focusSearch: t`Open the thread list search and focus it (${defaultShortcut("focusSearch")})`,
        help: t`Show help dialog (${defaultShortcut("help")})`,
        increaseEffort: t`Raise the composer's reasoning effort by one step. Not bound by default.`,
        newChat: t`Start a new chat (${defaultShortcut("newChat")})`,
        newTemporaryChat: t`Start a new temporary chat (${defaultShortcut("newTemporaryChat")})`,
        openModelPicker: t`Open the model picker in the composer (${defaultShortcut("openModelPicker")})`,
        sidebarLeft: t`Toggle left sidebar (${defaultShortcut("sidebarLeft")})`,
        sidebarRight: t`Toggle right sidebar (${defaultShortcut("sidebarRight")})`,
    };
    const { keyboardShortcuts, resetKeyboardShortcuts, setKeyboardShortcuts } = useKeyboardShortcuts();
    const crpc = useCRPC();

    const { mutateAsync: updateUserSettings } = useMutation(crpc.auth.functions.updateUserSettings.mutationOptions());
    const [isRecording, setIsRecording] = useState<string | undefined>(undefined);
    const [pressedKeys, setPressedKeys] = useState<string[]>([]);
    // Reset and Save are one queue: neither starts while the other is in flight, so the last click is the last write.
    const [isResetting, setIsResetting] = useState(false);

    // The one save path: Save and Reset to Defaults both go through it.
    const saveShortcuts = useCallback(
        async (value: Partial<KeyboardShortcuts>, successMessage: string) => {
            try {
                await updateUserSettings({ keyboardShortcuts: value });

                setKeyboardShortcuts(value);

                toast.success(successMessage);
            } catch (error) {
                toast.error(t`Failed to update keyboard shortcuts`);

                throw error;
            }
        },
        [updateUserSettings, setKeyboardShortcuts, t],
    );

    const form = useAppForm({
        defaultValues: pickEditableShortcuts(keyboardShortcuts),
        onSubmit: async ({ value }) => {
            await saveShortcuts(value, t`Keyboard shortcuts updated successfully`);
        },
        validators: { onChange: keyboardShortcutSchema },
    });

    // A string, not `t`: a new function identity per render would tear down the recording listeners mid-press.
    const invalidShortcutMessage = t`That key combination cannot be used as a shortcut`;

    // Handle keyboard recording
    useEffect(() => {
        if (!isRecording) {
            return undefined;
        }

        // One controller for both listeners: the keyup handler is registered from
        // inside keydown, so a keydown that never gets its matching keyup would
        // otherwise leave a pending one-shot listener behind after recording stops.
        const controller = new AbortController();

        const handleKeyDown = (event: KeyboardEvent) => {
            event.preventDefault();
            event.stopPropagation();

            // A modifier on its own is not a shortcut; wait for the key it modifies.
            if (MODIFIER_KEYS.has(event.key)) {
                return;
            }

            // Use the utility function to convert the event to a shortcut string
            const shortcut = eventToShortcut(event);

            // Split for display purposes
            const keys = shortcut.split("+");

            setPressedKeys(keys);

            // Stop recording on key up
            const handleKeyUp = () => {
                // Keep a combination the backend would refuse out of the form, so Save never greys out unexplained.
                if (isValidShortcut(shortcut)) {
                    form.setFieldValue(isRecording as keyof KeyboardShortcutForm, shortcut);
                } else {
                    toast.error(invalidShortcutMessage);
                }

                setIsRecording(undefined);
                setPressedKeys([]);
            };

            document.addEventListener("keyup", handleKeyUp, { once: true, signal: controller.signal });
        };

        document.addEventListener("keydown", handleKeyDown, { signal: controller.signal });

        return () => {
            controller.abort();
        };
    }, [isRecording, form, invalidShortcutMessage]);

    const startRecording = (field: string) => {
        setIsRecording(field);
        setPressedKeys([]);
    };

    const stopRecording = () => {
        setIsRecording(undefined);
        setPressedKeys([]);
    };

    const handleReset = useCallback(async () => {
        if (isResetting || form.state.isSubmitting) {
            return;
        }

        const defaults = pickEditableShortcuts(defaultKeyboardShortcuts);

        // Ends a recording in progress, so a later key press cannot write into the form after the reset.
        setIsRecording(undefined);
        setPressedKeys([]);
        setIsResetting(true);

        try {
            // The server keeps its own copy, so it is saved first; on failure the previous bindings stay in place.
            // The whole default set goes, not just the form's keys: the server merges, so a fixed binding (audio,
            // list navigation) it already holds would otherwise survive a reset the local store has applied.
            await saveShortcuts(defaultKeyboardShortcuts, t`Keyboard shortcuts reset to defaults`);

            resetKeyboardShortcuts();
            form.reset(defaults);
        } catch {
            // `saveShortcuts` already told the user.
        } finally {
            setIsResetting(false);
        }
    }, [isResetting, resetKeyboardShortcuts, form, saveShortcuts, t]);

    return (
        <div className="space-y-6">
            <Card>
                <CardHeader className="pb-2">
                    <CardTitle className="text-muted-foreground text-[10px] font-semibold tracking-widest uppercase">{t`Keyboard Shortcuts`}</CardTitle>
                    <p className="text-muted-foreground mt-1 text-xs">
                        {t`Customize keyboard shortcuts for common actions. Click "Record" and press your desired key combination.`}
                    </p>
                </CardHeader>
                <form.AppForm>
                    <form
                        onSubmit={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            form.handleSubmit();
                        }}
                    >
                        <CardContent className="space-y-6">
                            <div className="space-y-4">
                                {EDITABLE_SHORTCUT_KEYS.map((key) => (
                                    <Field.Root className="space-y-2" key={key}>
                                        <div className="flex items-center justify-between">
                                            <div>
                                                <Label className="text-sm font-medium" htmlFor={key}>
                                                    {shortcutLabels[key]}
                                                </Label>
                                                <p className="text-muted-foreground text-xs">{shortcutDescriptions[key]}</p>
                                                <form.Subscribe selector={(state) => isDuplicate(state.fieldMeta[key]?.errors)}>
                                                    {(duplicate) =>
                                                        duplicate && (
                                                            <p className="text-destructive text-xs" role="alert">
                                                                {t`Another action already uses this key combination. Change or clear one of them to save.`}
                                                            </p>
                                                        )
                                                    }
                                                </form.Subscribe>
                                            </div>
                                            <form.AppField name={key}>
                                                {(field) => (
                                                    <div className="flex items-center gap-2">
                                                        <Input
                                                            className="w-32"
                                                            id={key}
                                                            placeholder={t`Not set`}
                                                            readOnly
                                                            value={
                                                                isRecording === key
                                                                    ? formatShortcutForDisplay(pressedKeys.join("+")) || t`Press keys...`
                                                                    : formatShortcutForDisplay(field.state.value || "") || t`Not set`
                                                            }
                                                        />
                                                        <Button
                                                            aria-label={`${isRecording === key ? t`Stop` : t`Record`} ${shortcutLabels[key]}`}
                                                            disabled={isResetting}
                                                            onClick={() => {
                                                                if (isRecording === key) {
                                                                    stopRecording();
                                                                } else {
                                                                    startRecording(key);
                                                                }
                                                            }}
                                                            size="sm"
                                                            type="button"
                                                            variant={isRecording === key ? "destructive" : "outline"}
                                                        >
                                                            {isRecording === key ? t`Stop` : t`Record`}
                                                        </Button>
                                                        <Button
                                                            aria-label={`${t`Clear`} ${shortcutLabels[key]}`}
                                                            disabled={!field.state.value}
                                                            onClick={() => {
                                                                form.setFieldValue(key, "");
                                                            }}
                                                            size="sm"
                                                            type="button"
                                                            variant="ghost"
                                                        >
                                                            {t`Clear`}
                                                        </Button>
                                                    </div>
                                                )}
                                            </form.AppField>
                                        </div>
                                        {key !== EDITABLE_SHORTCUT_KEYS.at(-1) && <Separator />}
                                    </Field.Root>
                                ))}
                            </div>
                        </CardContent>

                        <CardFooter>
                            <div className="flex gap-2">
                                <form.Subscribe selector={(state) => state.isSubmitting}>
                                    {(isSubmitting) => (
                                        <Button disabled={isSubmitting || isResetting} onClick={handleReset} type="button" variant="outline">
                                            {t`Reset to Defaults`}
                                        </Button>
                                    )}
                                </form.Subscribe>
                                <form.Subscribe selector={saveStatus}>
                                    {(status) => (
                                        <Button disabled={status !== "ready" || isResetting} type="submit">
                                            {status === "saving" ? t`Saving...` : t`Save Shortcuts`}
                                        </Button>
                                    )}
                                </form.Subscribe>
                            </div>
                        </CardFooter>
                    </form>
                </form.AppForm>
            </Card>
        </div>
    );
};

export default KeyboardShortcutsSettings;
