import { useLingui } from "@lingui/react/macro";
import { Input } from "@neore/ui/components/input";
import { Kbd, KbdGroup } from "@neore/ui/components/kbd";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogPanel, DialogTitle } from "@neore/ui/components/responsive-dialog";
import { getPlatformModifierForEvents } from "@neore/ui/utils/keyboard-shortcuts";
import { Link } from "@tanstack/react-router";
import { useEffect, useId, useState } from "react";

import { useThreadListUIStore } from "@/features/chat/thread-list/stores/thread-list-ui-store";
import type { KeyboardShortcuts } from "@/features/layout/stores/ui-state-store";

import type { ShortcutGroupId } from "../lib/shortcut-sheet";
import { matchesShortcutQuery, resolveShortcuts, SHORTCUT_GROUP_ORDER } from "../lib/shortcut-sheet";

const isEditableTarget = (target: EventTarget | null): boolean =>
    target instanceof HTMLElement &&
    (target.isContentEditable || !!target.closest("input, textarea, select, [contenteditable], [data-composer-input], [role=textbox], [role=combobox]"));

// "?" opens the sheet from anywhere outside a text field. It sits on the window in the capture phase so the thread list's own "?" handler never sees the key and cannot toggle the sheet back shut.
const useQuestionMarkToggle = (): void => {
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent): void => {
            if (
                event.key !== "?" ||
                event.ctrlKey ||
                event.metaKey ||
                event.altKey ||
                event.isComposing ||
                event.repeat ||
                event.defaultPrevented ||
                isEditableTarget(event.target)
            ) {
                return;
            }

            if (isEditableTarget(document.activeElement)) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();
            useThreadListUIStore.getState().toggleShowKeyboardHelp();
        };

        globalThis.addEventListener("keydown", onKeyDown, { capture: true });

        return () => globalThis.removeEventListener("keydown", onKeyDown, { capture: true });
    }, []);
};

// Every shortcut grouped, with the user's current keys. Open state lives in the thread list UI store so the list's own toggle and the `help` shortcut share it.
const KeyboardShortcutsSheet = ({ shortcuts }: { shortcuts: Partial<KeyboardShortcuts> }) => {
    const { t } = useLingui();
    const open = useThreadListUIStore((state) => state.showKeyboardHelp);
    const setOpen = useThreadListUIStore((state) => state.setShowKeyboardHelp);
    const [query, setQuery] = useState("");
    const searchId = useId();

    useQuestionMarkToggle();

    const isMac = getPlatformModifierForEvents() === "cmd";

    const groupLabels: Record<ShortcutGroupId, string> = {
        chat: t`Chat`,
        composer: t`Composer`,
        navigation: t`Navigation`,
        threadList: t`Thread list`,
    };

    const labels: Record<string, string> = {
        audioRecord: t`Record audio`,
        commandPalette: t`Open command palette`,
        copyLastCodeBlock: t`Copy last code block`,
        decreaseEffort: t`Lower reasoning effort`,
        escape: t`Cancel or close`,
        findInThread: t`Find in thread`,
        firstItem: t`Go to first item`,
        focusSearch: t`Search threads`,
        help: t`Show keyboard shortcuts`,
        helpKey: t`Show keyboard shortcuts (outside text fields)`,
        increaseEffort: t`Raise reasoning effort`,
        lastItem: t`Go to last item`,
        listCancel: t`Leave selection or navigation`,
        listNavigate: t`Navigate threads`,
        listOpen: t`Open thread`,
        listSelectAll: t`Select all (in selection mode)`,
        newChat: t`New chat`,
        newTemporaryChat: t`New temporary chat`,
        nextItem: t`Next item`,
        openModelPicker: t`Open model picker`,
        prevItem: t`Previous item`,
        sidebarLeft: t`Toggle left sidebar`,
        sidebarRight: t`Toggle right sidebar`,
    };

    const resolved = resolveShortcuts(shortcuts, isMac);
    const sections = SHORTCUT_GROUP_ORDER.map((group) => {
        return {
            group,
            rows: resolved
                .filter((item) => item.entry.group === group)
                .map((item) => {
                    return { id: item.entry.id, keys: item.keys, label: labels[item.entry.id] ?? item.entry.id };
                })
                .filter((row) => matchesShortcutQuery(query, row.label, groupLabels[group], row.keys)),
        };
    }).filter((section) => section.rows.length > 0);

    return (
        <Dialog
            onOpenChange={(next) => {
                setOpen(next);

                if (!next) {
                    setQuery("");
                }
            }}
            open={open}
        >
            <DialogContent className="max-w-lg" data-testid="keyboard-shortcuts-sheet">
                <DialogHeader>
                    <DialogTitle>{t`Keyboard shortcuts`}</DialogTitle>
                    <DialogDescription>
                        {t`The keys you have set now.`}{" "}
                        <Link
                            className="text-primary underline-offset-4 hover:underline"
                            onClick={() => setOpen(false)}
                            to="/dashboard/settings/app/keyboard-shortcuts"
                        >
                            {t`Customize`}
                        </Link>
                    </DialogDescription>
                </DialogHeader>
                <DialogPanel>
                    <label className="sr-only" htmlFor={searchId}>
                        {t`Filter shortcuts`}
                    </label>
                    <Input
                        autoComplete="off"
                        id={searchId}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder={t`Filter shortcuts`}
                        type="search"
                        value={query}
                    />
                    <div className="mt-4 space-y-5">
                        {sections.map((section) => (
                            <section aria-labelledby={`${searchId}-${section.group}`} key={section.group}>
                                <h3 className="text-muted-foreground mb-2 text-xs font-semibold tracking-wide uppercase" id={`${searchId}-${section.group}`}>
                                    {groupLabels[section.group]}
                                </h3>
                                <dl className="space-y-1.5 text-sm">
                                    {section.rows.map((row) => (
                                        <div className="flex items-center justify-between gap-4" key={row.id}>
                                            <dt>{row.label}</dt>
                                            <dd>
                                                <KbdGroup>
                                                    {row.keys.map((key, index) => (
                                                        <Kbd key={`${key}-${row.keys.slice(0, index).join("")}`}>{key}</Kbd>
                                                    ))}
                                                </KbdGroup>
                                            </dd>
                                        </div>
                                    ))}
                                </dl>
                            </section>
                        ))}
                        <p aria-live="polite" className="text-muted-foreground text-sm" role="status">
                            {sections.length === 0 ? t`No shortcuts match "${query}".` : ""}
                        </p>
                    </div>
                </DialogPanel>
            </DialogContent>
        </Dialog>
    );
};

export default KeyboardShortcutsSheet;
