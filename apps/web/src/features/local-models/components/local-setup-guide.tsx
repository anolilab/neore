"use client";

import { useLingui } from "@lingui/react/macro";
import { LM_STUDIO_DEFAULT_BASE_URL, OLLAMA_DEFAULT_BASE_URL } from "@neore/ai/models";
import { Button } from "@neore/ui/components/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@neore/ui/components/tabs";
import { Check, Copy } from "lucide-react";
import type { FC } from "react";
import { useEffect, useId, useState } from "react";

import env from "@/lib/env";

import type { SetupOs } from "../lib/setup-commands";
import { buildOllamaOriginSteps, buildOllamaServeCommand, detectSetupOs, LM_STUDIO_SERVE_COMMAND } from "../lib/setup-commands";

const siteOrigin = (() => {
    try {
        return new URL(env.VITE_SITE_URL).origin;
    } catch {
        return "";
    }
})();

const CommandBlock: FC<{ command: string; label: string }> = ({ command, label }) => {
    const { t } = useLingui();
    const [isCopied, setIsCopied] = useState(false);

    useEffect(() => {
        if (!isCopied) {
            return undefined;
        }

        const timer = setTimeout(setIsCopied, 1500, false);

        return () => clearTimeout(timer);
    }, [isCopied]);

    return (
        <div className="bg-muted/60 flex items-start gap-2 rounded-md border p-2">
            <pre aria-label={label} className="min-w-0 flex-1 overflow-x-auto font-mono text-xs break-all whitespace-pre-wrap">
                {command}
            </pre>
            <Button
                aria-label={isCopied ? t`Copied` : t`Copy command: ${label}`}
                className="shrink-0"
                onClick={() => {
                    void navigator.clipboard.writeText(command).then(() => setIsCopied(true));
                }}
                size="icon-xs"
                type="button"
                variant="ghost"
            >
                {isCopied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            </Button>
        </div>
    );
};

/**
 * How to let this site talk to a model server on the user's own machine, and
 * what that path can and cannot do. Commands carry this page's real origin.
 */
const LocalSetupGuide: FC<{ defaultRuntime?: "lmstudio" | "ollama" }> = ({ defaultRuntime = "ollama" }) => {
    const { t } = useLingui();
    const headingId = useId();
    // SSR renders the configured site origin and macOS; the browser then fills in
    // what it actually is (a preview deployment has its own origin).
    const [origin, setOrigin] = useState(siteOrigin);
    const [os, setOs] = useState<SetupOs>("macos");

    useEffect(() => {
        setOrigin(globalThis.location.origin);
        setOs(detectSetupOs(globalThis.navigator.userAgent));
    }, []);

    const osLabels: Record<SetupOs, string> = { linux: t`Linux`, macos: t`macOS`, windows: t`Windows` };

    return (
        <section aria-labelledby={headingId} className="space-y-4 text-sm">
            <h4 className="font-medium" id={headingId}>
                {t`Set up a local model server`}
            </h4>

            <ul className="text-muted-foreground list-disc space-y-1 pl-5 text-xs">
                <li>{t`Your browser talks to the server on this computer directly — the prompt and reply never pass through our AI servers, and nothing is billed.`}</li>
                <li>{t`The finished text of each turn is saved to your chat history, like any other chat.`}</li>
                <li>{t`Text only: no web search, tools, or file and image input.`}</li>
                <li>{t`It works only in this browser, on this computer, while the server is running.`}</li>
            </ul>

            <Tabs defaultValue={defaultRuntime}>
                <TabsList aria-label={t`Model server`} className="w-full">
                    <TabsTrigger value="ollama">Ollama</TabsTrigger>
                    <TabsTrigger value="lmstudio">LM Studio</TabsTrigger>
                </TabsList>

                <TabsContent className="space-y-3 pt-2" value="ollama">
                    <p className="text-muted-foreground text-xs">
                        {t`Ollama only answers websites listed in OLLAMA_ORIGINS. Add this site, then restart Ollama:`}
                    </p>
                    <Tabs onValueChange={(value) => setOs(value as SetupOs)} value={os}>
                        <TabsList aria-label={t`Operating system`} className="w-full" variant="line">
                            {(["macos", "windows", "linux"] as const).map((key) => (
                                <TabsTrigger key={key} value={key}>
                                    {osLabels[key]}
                                </TabsTrigger>
                            ))}
                        </TabsList>
                        {(["macos", "windows", "linux"] as const).map((key) => (
                            <TabsContent className="space-y-2 pt-2" key={key} value={key}>
                                {buildOllamaOriginSteps(origin, key).map((step, index) => (
                                    <CommandBlock
                                        command={step.command}
                                        key={step.id}
                                        label={index === 0 ? t`Allow this site (${osLabels[key]})` : t`Restart Ollama (${osLabels[key]})`}
                                    />
                                ))}
                                {key === "windows" && <p className="text-muted-foreground text-xs">{t`Run these in PowerShell.`}</p>}
                                {key === "linux" && (
                                    <p className="text-muted-foreground text-xs">{t`For the systemd service the installer sets up. If you run ollama serve yourself instead:`}</p>
                                )}
                                {key === "linux" && <CommandBlock command={buildOllamaServeCommand(origin)} label={t`Start Ollama for this site`} />}
                            </TabsContent>
                        ))}
                    </Tabs>
                    <p className="text-muted-foreground text-xs">{t`Then download a model and use this base URL:`}</p>
                    <CommandBlock command="ollama pull llama3.2" label={t`Download a model`} />
                    <CommandBlock command={OLLAMA_DEFAULT_BASE_URL} label={t`Ollama base URL`} />
                </TabsContent>

                <TabsContent className="space-y-3 pt-2" value="lmstudio">
                    <ol className="text-muted-foreground list-decimal space-y-1 pl-5 text-xs">
                        <li>{t`Open the Developer tab and start the server.`}</li>
                        <li>{t`In the server settings, turn on "Enable CORS".`}</li>
                        <li>{t`Load a model, then use this base URL:`}</li>
                    </ol>
                    <CommandBlock command={LM_STUDIO_DEFAULT_BASE_URL} label={t`LM Studio base URL`} />
                    <p className="text-muted-foreground text-xs">{t`Or from a terminal:`}</p>
                    <CommandBlock command={LM_STUDIO_SERVE_COMMAND} label={t`Start LM Studio's server with CORS`} />
                </TabsContent>
            </Tabs>

            <div className="text-muted-foreground space-y-1 text-xs">
                <p className="text-foreground font-medium">{t`Browser notes`}</p>
                <ul className="list-disc space-y-1 pl-5">
                    <li>{t`Chrome and Edge may ask to allow this site to access devices on your local network. Choose Allow, or the requests fail.`}</li>
                    <li>{t`Firefox works too, and may ask the same question.`}</li>
                    <li>{t`Safari is not supported: it blocks a secure page from calling http://localhost.`}</li>
                    <li>{t`Brave: if requests fail, lower Shields for this site.`}</li>
                </ul>
            </div>
        </section>
    );
};

export default LocalSetupGuide;
