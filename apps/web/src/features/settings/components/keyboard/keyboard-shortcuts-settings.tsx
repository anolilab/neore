"use client";

import { Field } from "@base-ui/react/field";
import { useLingui } from "@lingui/react/macro";
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

import { useKeyboardShortcuts } from "@/features/layout/hooks/use-ui-state";
import { useCRPC } from "@/lib/lunora/crpc";

const keyboardShortcutSchema = z.strictObject({
    escape: z.string().optional(),
    help: z.string().optional(),
    newChat: z.string().optional(),
    newTemporaryChat: z.string().optional(),
    search: z.string().optional(),
    sidebarLeft: z.string().optional(),
    sidebarRight: z.string().optional(),
});

type KeyboardShortcutForm = z.infer<typeof keyboardShortcutSchema>;

// Get default shortcuts for descriptions
const getDefaultShortcut = (key: string): string => {
    switch (key) {
        case "help": {
            return `ctrl+/`;
        }
        case "newChat": {
            return `ctrl+n`;
        }
        case "newTemporaryChat": {
            return `ctrl+shift+n`;
        }
        case "search": {
            return `ctrl+k`;
        }
        case "sidebarLeft": {
            return `ctrl+b`;
        }
        case "sidebarRight": {
            return `ctrl+shift+b`;
        }
        default: {
            return "";
        }
    }
};

const KeyboardShortcutsSettings: FC = () => {
    const { t } = useLingui();

    const shortcutLabels = {
        escape: t`Escape`,
        help: t`Help`,
        newChat: t`New Chat`,
        newTemporaryChat: t`New Temporary Chat`,
        search: t`Search`,
        sidebarLeft: t`Sidebar Left`,
        sidebarRight: t`Sidebar Right`,
    };

    const shortcutDescriptions = {
        escape: t`Close dialogs and menus`,
        help: t`Show help dialog (${formatShortcutForDisplay(getDefaultShortcut("help"))})`,
        newChat: t`Start a new chat (${formatShortcutForDisplay(getDefaultShortcut("newChat"))})`,
        newTemporaryChat: t`Start a new temporary chat (${formatShortcutForDisplay(getDefaultShortcut("newTemporaryChat"))})`,
        search: t`Open search (${formatShortcutForDisplay(getDefaultShortcut("search"))})`,
        sidebarLeft: t`Toggle left sidebar (${formatShortcutForDisplay(getDefaultShortcut("sidebarLeft"))})`,
        sidebarRight: t`Toggle right sidebar (${formatShortcutForDisplay(getDefaultShortcut("sidebarRight"))})`,
    };
    const { keyboardShortcuts, resetKeyboardShortcuts, setKeyboardShortcuts } = useKeyboardShortcuts();
    const crpc = useCRPC();

    const updateUserSettingsMutation = useMutation(crpc.auth.functions.updateUserSettings.mutationOptions());
    const [isRecording, setIsRecording] = useState<string | undefined>(undefined);
    const [pressedKeys, setPressedKeys] = useState<string[]>([]);

    const form = useAppForm({
        defaultValues: keyboardShortcuts,
        onSubmit: async ({ value }) => {
            try {
                await updateUserSettingsMutation.mutateAsync({
                    keyboardShortcuts: value,
                });

                setKeyboardShortcuts(value);

                toast.success(t`Keyboard shortcuts updated successfully`);
            } catch (error) {
                toast.error(t`Failed to update keyboard shortcuts`);

                throw error;
            }
        },
        validators: {
            onChange: ({ value }) => {
                const result = keyboardShortcutSchema.safeParse(value);

                if (!result.success) {
                    return { keyboardShortcuts: result.error.message };
                }

                return undefined;
            },
        },
    });

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

            // Use the utility function to convert the event to a shortcut string
            const shortcut = eventToShortcut(event);

            // Split for display purposes
            const keys = shortcut.split("+");

            setPressedKeys(keys);

            // Stop recording on key up
            const handleKeyUp = () => {
                form.setFieldValue(isRecording as keyof KeyboardShortcutForm, shortcut);

                setIsRecording(undefined);
                setPressedKeys([]);
            };

            document.addEventListener("keyup", handleKeyUp, { once: true, signal: controller.signal });
        };

        document.addEventListener("keydown", handleKeyDown, { signal: controller.signal });

        return () => {
            controller.abort();
        };
    }, [isRecording, form]);

    const startRecording = (field: string) => {
        setIsRecording(field);
        setPressedKeys([]);
    };

    const stopRecording = () => {
        setIsRecording(undefined);
        setPressedKeys([]);
    };

    const handleReset = useCallback(() => {
        resetKeyboardShortcuts();
        form.reset();

        toast.info(t`Keyboard shortcuts reset to defaults`);
    }, [resetKeyboardShortcuts, form, t]);

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
                                {Object.entries(shortcutLabels).map(([key, label]) => (
                                    <Field.Root className="space-y-2" key={key}>
                                        <div className="flex items-center justify-between">
                                            <div>
                                                <Label className="text-sm font-medium" htmlFor={key}>
                                                    {label}
                                                </Label>
                                                <p className="text-muted-foreground text-xs">
                                                    {shortcutDescriptions[key as keyof typeof shortcutDescriptions]}
                                                </p>
                                            </div>
                                            <form.AppField name={key as keyof KeyboardShortcutForm}>
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
                                                            disabled={!field.state.value}
                                                            onClick={() => {
                                                                form.setFieldValue(key as keyof KeyboardShortcutForm, "");
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
                                        {key !== "sidebarRight" && <Separator />}
                                    </Field.Root>
                                ))}
                            </div>
                        </CardContent>

                        <CardFooter>
                            <div className="flex gap-2">
                                <Button onClick={handleReset} type="button" variant="outline">
                                    {t`Reset to Defaults`}
                                </Button>
                                <Button disabled={form.state.isSubmitting} type="submit">
                                    {form.state.isSubmitting ? t`Saving...` : t`Save Shortcuts`}
                                </Button>
                            </div>
                        </CardFooter>
                    </form>
                </form.AppForm>
            </Card>
        </div>
    );
};

export default KeyboardShortcutsSettings;
