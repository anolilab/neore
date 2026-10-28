"use client";

import { useLingui } from "@lingui/react/macro";
import { buildMcpClientConfig } from "@neore/backend/public-api/mcp-client-config";
import { Button } from "@neore/ui/components/button";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useId } from "react";

import env from "@/lib/env";

import useCopyToClipboard from "./use-copy-to-clipboard";

interface CopyBlockProperties {
    copyLabel: string;
    text: string;
    title: string;
}

const CopyBlock = ({ copyLabel, text, title }: CopyBlockProperties) => {
    const { t } = useLingui();
    const { copied, copy } = useCopyToClipboard();

    return (
        <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium">{title}</span>

                <Button aria-label={copyLabel} onClick={() => copy(text)} size="sm" type="button" variant="ghost">
                    {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
                    {copied ? t`Copied` : t`Copy`}
                </Button>

                <span aria-live="polite" className="sr-only" role="status">
                    {copied ? t`Copied` : ""}
                </span>
            </div>

            <pre className="bg-muted overflow-x-auto rounded-md p-3 font-mono text-xs break-all whitespace-pre-wrap">{text}</pre>
        </div>
    );
};

interface McpConfigSnippetProperties {
    apiKey: string;
}

/** What to paste into an MCP client to use the key just created. Shown with the key, because the key is not shown again. */
const McpConfigSnippet = ({ apiKey }: McpConfigSnippetProperties) => {
    const { t } = useLingui();
    const headingId = useId();
    const config = buildMcpClientConfig(env.VITE_LUNORA_URL, apiKey);

    return (
        <section aria-labelledby={headingId} className="space-y-3">
            <div className="space-y-1">
                <h3 className="text-sm font-semibold" id={headingId}>
                    {t`Use it from an MCP client`}
                </h3>

                <p className="text-muted-foreground text-xs">
                    {t`Claude Code and other MCP clients can reach your account with this key. They only see the tools its permissions allow.`}
                </p>
            </div>

            <CopyBlock copyLabel={t`Copy the Claude Code command`} text={config.claudeCommand} title={t`Claude Code`} />

            <CopyBlock copyLabel={t`Copy the JSON configuration`} text={config.json} title={t`Other clients (JSON)`} />
        </section>
    );
};

export default McpConfigSnippet;
