"use client";

import { useDirection } from "@base-ui/react/direction-provider";
import { useLingui } from "@lingui/react/macro";
import { Button } from "@ui/components/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@ui/components/dialog";
import { Input } from "@ui/components/input";
import { Kbd, KbdGroup } from "@ui/components/kbd";
import { Separator } from "@ui/components/separator";
import { SearchIcon, XIcon } from "lucide-react";
import * as React from "react";

const SHORTCUT_KEY = "/";

const APPLE_PLATFORM_REGEX = /Mac|iPhone|iPad|iPod/;

interface ShortcutGroup {
    shortcuts: {
        description: string;
        keys: string[];
    }[];
    title: string;
}

const matchesQuery = (shortcut: ShortcutGroup["shortcuts"][number], query: string): boolean =>
    shortcut.description.toLowerCase().includes(query) || shortcut.keys.some((key) => key.toLowerCase().includes(query));

interface DataGridKeyboardShortcutsProps {
    enableSearch?: boolean;
}

const DataGridKeyboardShortcuts = React.memo(DataGridKeyboardShortcutsImpl, (prev, next) => prev.enableSearch === next.enableSearch);

function DataGridKeyboardShortcutsImpl({ enableSearch = false }: DataGridKeyboardShortcutsProps) {
    const { t } = useLingui();
    const direction = useDirection();
    const [open, setOpen] = React.useState(false);
    const [input, setInput] = React.useState("");
    const inputRef = React.useRef<HTMLInputElement>(null);

    const isMac = typeof navigator === "undefined" ? false : APPLE_PLATFORM_REGEX.test(navigator.userAgent);

    const moduleKey = isMac ? "⌘" : "Ctrl";
    const clickKey = t`Click`;
    const doubleClickKey = t`Double Click`;

    const onOpenChange = React.useCallback((isOpen: boolean) => {
        setOpen(isOpen);

        if (!isOpen) {
            setInput("");
        }
    }, []);

    const onOpenAutoFocus = React.useCallback((event: Event) => {
        event.preventDefault();
        inputRef.current?.focus();
    }, []);

    const onInputChange = React.useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
        setInput(event.target.value);
    }, []);

    const shortcutGroups: ShortcutGroup[] = React.useMemo(
        () => [
            {
                shortcuts: [
                    {
                        description: t`Navigate between cells`,
                        keys: ["↑", "↓", "←", "→"],
                    },
                    {
                        description: t`Move to next cell`,
                        keys: ["Tab"],
                    },
                    {
                        description: t`Move to previous cell`,
                        keys: ["Shift", "Tab"],
                    },
                    {
                        description: t`Move to first column`,
                        keys: ["Home"],
                    },
                    {
                        description: t`Move to last column`,
                        keys: ["End"],
                    },
                    {
                        description: t`Move to first row (same column)`,
                        keys: [moduleKey, "↑"],
                    },
                    {
                        description: t`Move to last row (same column)`,
                        keys: [moduleKey, "↓"],
                    },
                    {
                        description: t`Move to first column (same row)`,
                        keys: [moduleKey, "←"],
                    },
                    {
                        description: t`Move to last column (same row)`,
                        keys: [moduleKey, "→"],
                    },
                    {
                        description: t`Move to first cell`,
                        keys: [moduleKey, "Home"],
                    },
                    {
                        description: t`Move to last cell`,
                        keys: [moduleKey, "End"],
                    },
                    {
                        description: t`Move up one page`,
                        keys: ["PgUp"],
                    },
                    {
                        description: t`Move down one page`,
                        keys: ["PgDn"],
                    },
                    {
                        description: t`Scroll up one page`,
                        keys: ["⌥", "↑"],
                    },
                    {
                        description: t`Scroll down one page`,
                        keys: ["⌥", "↓"],
                    },
                    {
                        description: t`Scroll left one page of columns`,
                        keys: ["⌥", "PgUp"],
                    },
                    {
                        description: t`Scroll right one page of columns`,
                        keys: ["⌥", "PgDn"],
                    },
                ],
                title: t`Navigation`,
            },
            {
                shortcuts: [
                    {
                        description: t`Extend selection`,
                        keys: ["Shift", "↑↓←→"],
                    },
                    {
                        description: t`Select to top of table`,
                        keys: [moduleKey, "Shift", "↑"],
                    },
                    {
                        description: t`Select to bottom of table`,
                        keys: [moduleKey, "Shift", "↓"],
                    },
                    {
                        description: t`Select to first column`,
                        keys: [moduleKey, "Shift", "←"],
                    },
                    {
                        description: t`Select to last column`,
                        keys: [moduleKey, "Shift", "→"],
                    },
                    {
                        description: t`Select all cells`,
                        keys: [moduleKey, "A"],
                    },
                    {
                        description: t`Toggle cell selection`,
                        keys: [moduleKey, clickKey],
                    },
                    {
                        description: t`Select range`,
                        keys: ["Shift", clickKey],
                    },
                    {
                        description: t`Clear selection`,
                        keys: ["Esc"],
                    },
                ],
                title: t`Selection`,
            },
            {
                shortcuts: [
                    {
                        description: t`Start editing cell`,
                        keys: ["Enter"],
                    },
                    {
                        description: t`Start editing cell`,
                        keys: ["F2"],
                    },
                    {
                        description: t`Start editing cell`,
                        keys: [doubleClickKey],
                    },
                    {
                        description: t`Insert row below`,
                        keys: ["Shift", "Enter"],
                    },
                    {
                        description: t`Copy selected cells`,
                        keys: [moduleKey, "C"],
                    },
                    {
                        description: t`Cut selected cells`,
                        keys: [moduleKey, "X"],
                    },
                    {
                        description: t`Paste cells`,
                        keys: [moduleKey, "V"],
                    },
                    {
                        description: t`Clear selected cells`,
                        keys: ["Delete"],
                    },
                    {
                        description: t`Clear selected cells`,
                        keys: ["Backspace"],
                    },
                    {
                        description: t`Delete selected rows`,
                        keys: [moduleKey, "Backspace"],
                    },
                ],
                title: t`Editing`,
            },
            ...(enableSearch
                ? [
                      {
                          shortcuts: [
                              {
                                  description: t`Open search`,
                                  keys: [moduleKey, "F"],
                              },
                              {
                                  description: t`Next match`,
                                  keys: ["Enter"],
                              },
                              {
                                  description: t`Previous match`,
                                  keys: ["Shift", "Enter"],
                              },
                              {
                                  description: t`Close search`,
                                  keys: ["Esc"],
                              },
                          ],
                          title: t`Search`,
                      },
                  ]
                : []),
            {
                shortcuts: [
                    {
                        description: t`Toggle the filter menu`,
                        keys: [moduleKey, "Shift", "F"],
                    },
                    {
                        description: t`Remove filter (when focused)`,
                        keys: ["Backspace"],
                    },
                    {
                        description: t`Remove filter (when focused)`,
                        keys: ["Delete"],
                    },
                ],
                title: t`Filtering`,
            },
            {
                shortcuts: [
                    {
                        description: t`Toggle the sort menu`,
                        keys: [moduleKey, "Shift", "S"],
                    },
                    {
                        description: t`Remove sort (when focused)`,
                        keys: ["Backspace"],
                    },
                    {
                        description: t`Remove sort (when focused)`,
                        keys: ["Delete"],
                    },
                ],
                title: t`Sorting`,
            },
            {
                shortcuts: [
                    {
                        description: t`Show keyboard shortcuts`,
                        keys: [moduleKey, "/"],
                    },
                ],
                title: t`General`,
            },
        ],
        [moduleKey, enableSearch, t, clickKey, doubleClickKey],
    );

    const filteredGroups = React.useMemo(() => {
        if (!input.trim()) {
            return shortcutGroups;
        }

        const query = input.toLowerCase();

        return shortcutGroups
            .map((group) => {
                return {
                    ...group,
                    shortcuts: group.shortcuts.filter((shortcut) => matchesQuery(shortcut, query)),
                };
            })
            .filter((group) => group.shortcuts.length > 0);
    }, [shortcutGroups, input]);

    React.useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (!((event.ctrlKey || event.metaKey) && event.key === SHORTCUT_KEY)) {
                return;
            }

            event.preventDefault();
            setOpen(true);
        };

        globalThis.addEventListener("keydown", onKeyDown);

        return () => {
            globalThis.removeEventListener("keydown", onKeyDown);
        };
    }, []);

    return (
        <Dialog onOpenChange={onOpenChange} open={open}>
            <DialogContent className="max-w-2xl px-0" dir={direction} onOpenAutoFocus={onOpenAutoFocus} showCloseButton={false}>
                <DialogClose aria-label={t`Close`} className="absolute end-6 top-6" render={<Button className="size-6" size="icon" variant="ghost" />}>
                    <XIcon aria-hidden="true" />
                </DialogClose>
                <DialogHeader className="px-6">
                    <DialogTitle>{t`Keyboard shortcuts`}</DialogTitle>
                    <DialogDescription className="sr-only">
                        {t`Use these keyboard shortcuts to navigate and interact with the data grid more efficiently.`}
                    </DialogDescription>
                </DialogHeader>
                <div className="px-6">
                    <div className="relative">
                        <SearchIcon className="text-muted-foreground absolute start-3 top-1/2 size-3.5 -translate-y-1/2" />
                        <Input className="h-8 ps-8" onChange={onInputChange} placeholder={t`Search shortcuts...`} ref={inputRef} value={input} />
                    </div>
                </div>
                <Separator className="mx-auto data-[orientation=horizontal]:w-[calc(100%-(--spacing(12)))]" />
                <div className="h-[40vh] overflow-y-auto px-6">
                    {filteredGroups.length === 0 ? (
                        <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                            <div className="bg-muted text-foreground flex size-10 shrink-0 items-center justify-center rounded-lg">
                                <SearchIcon className="pointer-events-none size-6" />
                            </div>
                            <div className="flex flex-col gap-1">
                                <div className="text-lg font-medium tracking-tight">{t`No shortcuts found`}</div>
                                <p className="text-muted-foreground text-sm">{t`Try searching for a different term.`}</p>
                            </div>
                        </div>
                    ) : (
                        <div className="flex flex-col gap-6">
                            {filteredGroups.map((shortcutGroup) => (
                                <div className="flex flex-col gap-2" key={shortcutGroup.title}>
                                    <h3 className="text-foreground text-sm font-semibold">{shortcutGroup.title}</h3>
                                    <div className="divide-border divide-y rounded-md border">
                                        {shortcutGroup.shortcuts.map((shortcut) => (
                                            <ShortcutCard
                                                description={shortcut.description}
                                                key={`${shortcut.description}:${shortcut.keys.join("+")}`}
                                                keys={shortcut.keys}
                                            />
                                        ))}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </DialogContent>
        </Dialog>
    );
}

const ShortcutCard = ({ description, keys }: ShortcutGroup["shortcuts"][number]) => (
    <div className="flex items-center gap-4 px-3 py-2">
        <span className="flex-1 text-sm">{description}</span>
        <KbdGroup className="shrink-0">
            {keys.map((key, index) => (
                <React.Fragment key={key}>
                    {index > 0 && <span className="text-muted-foreground text-xs">+</span>}
                    <Kbd>{key}</Kbd>
                </React.Fragment>
            ))}
        </KbdGroup>
    </div>
);

export default DataGridKeyboardShortcuts;
