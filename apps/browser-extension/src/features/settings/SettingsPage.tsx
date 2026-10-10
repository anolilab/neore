import { DEFAULT_CHAT_MODEL } from "@neore/ai/constants";
import { ModelPickerButton } from "@neore/chat-ui/model-picker/model-picker-button";
import { ArrowLeftIcon, KeyboardIcon, LogOutIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { clearAccessToken } from "@/lib/access-token";
import { APP_URL, LLM_GATEWAY_URL, LUNORA_URL } from "@/lib/env";
import { lunora } from "@/lib/lunora-client";
import { signOut as endSession, useSession } from "@/lib/session";
import { browserLanguage, updateSettings, useSettings } from "@/lib/settings";
import { firefoxBrowser, IS_FIREFOX } from "@/lib/target";
import { languageName } from "@/page-context/quick-prompts";

import { useModels } from "../models/use-models";

const TRANSLATE_LANGUAGES = ["ar", "de", "en", "es", "fr", "hi", "it", "ja", "ko", "nl", "pl", "pt", "ru", "sv", "tr", "uk", "zh"];

interface SettingsPageProps {
    onBack: () => void;
}

const sectionTitle = "text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400";

export function SettingsPage({ onBack }: SettingsPageProps) {
    const { data: session } = useSession();
    const settings = useSettings();
    const models = useModels();
    const [commands, setCommands] = useState<chrome.commands.Command[]>([]);
    const [isSigningOut, setIsSigningOut] = useState(false);
    const modelLabelId = useId();
    const languageId = useId();

    useEffect(() => {
        void chrome.commands.getAll().then(setCommands);
    }, []);

    const signOut = async () => {
        setIsSigningOut(true);

        try {
            await endSession();
        } finally {
            clearAccessToken();
            lunora.setAuthToken(null);
            setIsSigningOut(false);
        }
    };

    const uiLanguage = browserLanguage().split("-", 1)[0] ?? "en";
    const languages = TRANSLATE_LANGUAGES.includes(uiLanguage) ? TRANSLATE_LANGUAGES : [uiLanguage, ...TRANSLATE_LANGUAGES];

    return (
        <div className="flex h-full flex-col">
            <header className="flex shrink-0 items-center gap-2 border-b border-gray-200 px-3 py-2.5 dark:border-gray-800">
                <button
                    aria-label="Back"
                    className="flex size-7 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-700 focus-visible:ring-2 focus-visible:ring-gray-400 focus-visible:outline-none dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
                    onClick={onBack}
                    type="button"
                >
                    <ArrowLeftIcon aria-hidden="true" className="size-4" />
                </button>
                <h1 className="text-sm font-semibold text-gray-800 dark:text-gray-100">Settings</h1>
            </header>

            <main className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 py-4 text-sm text-gray-800 dark:text-gray-100">
                <section aria-labelledby="settings-account" className="flex flex-col gap-2">
                    <h2 className={sectionTitle} id="settings-account">
                        Account
                    </h2>
                    <p className="truncate">{session?.user.email}</p>
                    <button
                        className="flex w-fit items-center gap-1.5 rounded-md border border-gray-200 px-3 py-1.5 hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-gray-400 focus-visible:outline-none disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-800"
                        disabled={isSigningOut}
                        onClick={() => {
                            void signOut();
                        }}
                        type="button"
                    >
                        <LogOutIcon aria-hidden="true" className="size-4" />
                        {isSigningOut ? "Signing out…" : "Sign out"}
                    </button>
                </section>

                <section aria-labelledby="settings-chat" className="flex flex-col gap-3">
                    <h2 className={sectionTitle} id="settings-chat">
                        Chat
                    </h2>
                    <div className="flex flex-col gap-1.5">
                        <span id={modelLabelId}>Default model for new chats</span>
                        <div aria-labelledby={modelLabelId} role="group">
                            <ModelPickerButton
                                className="h-8 max-w-full text-xs"
                                modelId={settings?.defaultModelId ?? DEFAULT_CHAT_MODEL}
                                models={models}
                                onSelect={(defaultModelId) => {
                                    void updateSettings({ defaultModelId });
                                }}
                                size="sm"
                                variant="outline"
                            />
                        </div>
                    </div>
                    <label className="flex flex-col gap-1.5" htmlFor={languageId}>
                        <span>Translate selections into</span>
                        <select
                            className="h-8 rounded-md border border-gray-200 bg-white px-2 text-sm focus-visible:ring-2 focus-visible:ring-gray-400 focus-visible:outline-none dark:border-gray-700 dark:bg-gray-900"
                            id={languageId}
                            onChange={(event) => {
                                void updateSettings({ translateLanguage: event.target.value });
                            }}
                            value={settings?.translateLanguage ?? uiLanguage}
                        >
                            {languages.map((tag) => (
                                <option key={tag} value={tag}>
                                    {languageName(tag)}
                                </option>
                            ))}
                        </select>
                    </label>
                </section>

                <section aria-labelledby="settings-shortcuts" className="flex flex-col gap-2">
                    <h2 className={sectionTitle} id="settings-shortcuts">
                        Keyboard shortcuts
                    </h2>
                    <dl className="flex flex-col gap-1">
                        {commands
                            .filter((command) => command.description)
                            .map((command) => (
                                <div className="flex justify-between gap-2" key={command.name}>
                                    <dt>{command.description}</dt>
                                    <dd className="font-mono text-xs text-gray-600 dark:text-gray-400">{command.shortcut || "Not set"}</dd>
                                </div>
                            ))}
                    </dl>
                    <button
                        className="flex w-fit items-center gap-1.5 rounded-md px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-gray-400 focus-visible:outline-none dark:text-gray-400 dark:hover:bg-gray-800"
                        onClick={() => {
                            if (IS_FIREFOX) {
                                void firefoxBrowser()?.commands?.openShortcutSettings();
                            } else {
                                void chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
                            }
                        }}
                        type="button"
                    >
                        <KeyboardIcon aria-hidden="true" className="size-3.5" />
                        Change shortcuts
                    </button>
                </section>

                <section aria-labelledby="settings-connection" className="flex flex-col gap-2">
                    <h2 className={sectionTitle} id="settings-connection">
                        Connection
                    </h2>
                    <dl className="flex flex-col gap-1.5 text-xs">
                        {[
                            ["App", APP_URL],
                            ["Backend", LUNORA_URL],
                            ["LLM gateway", LLM_GATEWAY_URL],
                        ].map(([label, value]) => (
                            <div className="flex flex-col" key={label}>
                                <dt className="text-gray-500 dark:text-gray-400">{label}</dt>
                                <dd className="font-mono break-all">{value || "Not configured"}</dd>
                            </div>
                        ))}
                    </dl>
                </section>
            </main>
        </div>
    );
}
