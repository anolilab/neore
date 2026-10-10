"use client";

import { Plural, useLingui } from "@lingui/react/macro";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@neore/ui/components/card";
import Discord from "@neore/ui/icons/discord";
import Line from "@neore/ui/icons/line";
import Slack from "@neore/ui/icons/slack";
import Telegram from "@neore/ui/icons/telegram";
import WeChat from "@neore/ui/icons/wechat";
import WhatsApp from "@neore/ui/icons/whatsapp";
import { AlertCircle, MessageCircle, Send, Users } from "lucide-react";
import type { FC } from "react";

import { useMessengerConnections } from "./hooks/use-messenger-connections";
import type { MessengerPlatformId } from "./messenger-platform-card";
import MessengerPlatformCard from "./messenger-platform-card";

interface PlatformDef {
    beta?: boolean;
    description: string;
    icon: FC<{ className?: string }>;
    iconColor: string;
    id: MessengerPlatformId;
    name: string;
}

const MessengerPage: FC = () => {
    const { t } = useLingui();
    const { data: connections, isLoading } = useMessengerConnections();

    const platforms: PlatformDef[] = [
        {
            description: t`Send messages to the AI bot via Telegram. Conversations appear as threads in your chat list.`,
            icon: Telegram,
            iconColor: "bg-[#0088cc]",
            id: "telegram",
            name: "Telegram",
        },
        {
            description: t`Connect Slack to send messages and @mentions to the AI. Threads are preserved across platforms.`,
            icon: Slack,
            iconColor: "bg-[#4A154B]",
            id: "slack",
            name: "Slack",
        },
        {
            description: t`Chat with the AI bot in Discord channels. Each channel maps to a separate thread.`,
            icon: Discord,
            iconColor: "bg-[#5865F2]",
            id: "discord",
            name: "Discord",
        },
        {
            description: t`Answer WhatsApp messages through your WhatsApp Business number (Meta Cloud API). Replies follow WhatsApp's 24-hour rule.`,
            icon: WhatsApp,
            iconColor: "bg-[#25D366]",
            id: "whatsapp",
            name: "WhatsApp",
        },
        {
            description: t`Connect a LINE Official Account through the Messaging API. Each chat or group becomes its own thread.`,
            icon: Line,
            iconColor: "bg-[#06C755]",
            id: "line",
            name: "LINE",
        },
        {
            description: t`Chat with the AI from a Feishu or Lark custom app bot, in direct messages or groups.`,
            icon: Send,
            iconColor: "bg-[#3370FF]",
            id: "feishu",
            name: "Feishu / Lark",
        },
        {
            description: t`Talk to the AI from Microsoft Teams through an Azure Bot. Each Teams conversation maps to a thread.`,
            icon: Users,
            iconColor: "bg-[#5059C9]",
            id: "teams",
            name: "Microsoft Teams",
        },
        {
            beta: true,
            description: t`Answer messages to a WeChat Official Account (safe mode). Beta: not yet tested against a live account.`,
            icon: WeChat,
            iconColor: "bg-[#07C160]",
            id: "wechat",
            name: "WeChat",
        },
    ];

    const getConnectionForPlatform = (platform: string) => connections?.find((c) => c.platform === platform);

    const activeCount = connections?.filter((c) => c.status === "active").length ?? 0;

    return (
        <div className="space-y-6">
            <Card>
                <CardHeader className="pb-4">
                    <div className="flex items-center gap-2">
                        <MessageCircle aria-hidden="true" className="size-5" />
                        <div>
                            <CardTitle className="text-muted-foreground text-[10px] font-semibold tracking-widest uppercase">{t`Messenger Integration`}</CardTitle>
                            <CardDescription className="text-muted-foreground mt-1 text-xs">
                                {t`Connect your messenger platforms to chat with AI directly from Telegram, Slack, Discord, WhatsApp, LINE, Feishu/Lark, Microsoft Teams or WeChat. Messages appear in your thread list with the platform tag.`}
                            </CardDescription>
                        </div>
                    </div>
                </CardHeader>
                <CardContent className="space-y-4">
                    {/* Info banner */}
                    <div className="flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800 dark:border-blue-800 dark:bg-blue-950/50 dark:text-blue-300">
                        <AlertCircle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                        <div>
                            <p>
                                {t`Connect your messenger accounts to send messages to the AI from your favorite chat apps. The AI will auto-respond on the platform, and all conversations are synced to your thread list.`}
                            </p>
                        </div>
                    </div>

                    {/* Connected summary */}
                    {!isLoading && activeCount > 0 && (
                        <div className="rounded-lg border bg-green-50 p-3 dark:bg-green-950/30">
                            <p className="text-sm font-medium text-green-800 dark:text-green-300">
                                <Plural one="You have # messenger connected" other="You have # messengers connected" value={activeCount} />
                            </p>
                        </div>
                    )}

                    {/* Platform cards */}
                    {isLoading ? (
                        <div className="text-muted-foreground py-8 text-center text-sm">{t`Loading messenger connections...`}</div>
                    ) : (
                        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                            {platforms.map((platform) => (
                                <MessengerPlatformCard
                                    beta={platform.beta}
                                    connection={getConnectionForPlatform(platform.id)}
                                    description={platform.description}
                                    icon={platform.icon}
                                    iconColor={platform.iconColor}
                                    key={platform.id}
                                    name={platform.name}
                                    platform={platform.id}
                                />
                            ))}
                        </div>
                    )}
                </CardContent>
            </Card>
        </div>
    );
};

export default MessengerPage;
