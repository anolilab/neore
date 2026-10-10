"use client";

import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@neore/ui/components/responsive-dialog";
import { AlertCircle } from "lucide-react";
import type { FC } from "react";

import type { MessengerPlatformId } from "./messenger-platform-card";

interface MessengerSetupDialogProps {
    isOpen: boolean;
    isPending: boolean;
    onClose: () => void;
    onConfirm: () => void;
    platform: MessengerPlatformId;
}

interface SetupInstructions {
    note: MessageDescriptor;
    steps: MessageDescriptor[];
    title: MessageDescriptor;
}

const SETUP_INSTRUCTIONS: Record<MessengerPlatformId, SetupInstructions> = {
    discord: {
        note: msg`Each Discord channel creates a separate thread in Neore Chat. The AI will auto-respond in the channel.`,
        steps: [
            msg`Go to Settings > API Keys and add your Discord Bot Token and Public Key under "Messenger Bot Keys".`,
            msg`Create a Discord Application at discord.com/developers/applications.`,
            msg`After activating the connection here, you'll get a webhook URL to set as the Interactions Endpoint URL in your Discord App settings.`,
        ],
        title: msg`Connect Discord`,
    },
    feishu: {
        note: msg`An Encrypt Key is required: Feishu only signs events when one is set, and unsigned events are refused.`,
        steps: [
            msg`Create a custom app at open.feishu.cn/app (or open.larksuite.com/app for Lark) and enable its Bot feature.`,
            msg`Grant the im:message and im:message:send_as_bot permissions, then under Events & Callbacks set an Encrypt Key and note the Verification Token.`,
            msg`In Settings > API Keys add the App ID, App Secret, Verification Token and Encrypt Key under "Messenger Bot Keys". For Lark, also set the Feishu domain key to "lark".`,
            msg`After activating the connection here, paste the webhook URL as the event Request URL, subscribe to "Receive messages" (im.message.receive_v1) and publish a new app version.`,
        ],
        title: msg`Connect Feishu / Lark`,
    },
    line: {
        note: msg`Replies use the free reply token when the answer is quick, and fall back to a push message (which counts against your LINE quota) when it is not.`,
        steps: [
            msg`Create a Messaging API channel in the LINE Developers Console (developers.line.biz/console).`,
            msg`Copy the Channel secret (Basic settings) and issue a long-lived Channel access token (Messaging API tab).`,
            msg`In Settings > API Keys add both under "Messenger Bot Keys".`,
            msg`After activating the connection here, paste the webhook URL as the Webhook URL, turn on "Use webhook", and turn off the auto-reply messages in the LINE Official Account Manager.`,
        ],
        title: msg`Connect LINE`,
    },
    slack: {
        note: msg`Slack threads are preserved — replies in a Slack thread stay in the same Neore Chat thread.`,
        steps: [
            msg`Go to Settings > API Keys and add your Slack Bot Token and Signing Secret under "Messenger Bot Keys".`,
            msg`Create a Slack App at api.slack.com/apps with Events API enabled.`,
            msg`After activating the connection here, you'll get a webhook URL to set as the Request URL in your Slack App's Event Subscriptions.`,
        ],
        title: msg`Connect Slack`,
    },
    teams: {
        note: msg`New Azure Bots are single-tenant: set the Teams Tenant ID key, or replies cannot authenticate.`,
        steps: [
            msg`Create an Azure Bot resource in the Azure portal and note its Microsoft App ID, a client secret (App password) and, for single-tenant bots, the Tenant ID.`,
            msg`In Settings > API Keys add the App ID, App password and Tenant ID under "Messenger Bot Keys".`,
            msg`After activating the connection here, paste the webhook URL as the bot's Messaging endpoint, then add the Microsoft Teams channel to the bot.`,
            msg`Install the bot in Teams (via a Teams app manifest or the Developer Portal) and send it a message.`,
        ],
        title: msg`Connect Microsoft Teams`,
    },
    telegram: {
        note: msg`Messages sent to your bot will create new threads tagged with "telegram". The AI will auto-respond on Telegram.`,
        steps: [
            msg`Go to Settings > API Keys and add your Telegram Bot Token and Webhook Secret under "Messenger Bot Keys".`,
            msg`Create a bot via @BotFather on Telegram if you haven't already.`,
            msg`After activating the connection here, you'll get a webhook URL to register with BotFather using /setwebhook.`,
        ],
        title: msg`Connect Telegram`,
    },
    wechat: {
        note: msg`Beta. Only safe mode is supported, because in plaintext mode WeChat's signature does not cover the message body. Replies use the customer-service API, which needs a verified Service Account (the sandbox test account also works) and is open for 48 hours after the user's last message.`,
        steps: [
            msg`In the WeChat Official Account admin (mp.weixin.qq.com), open Settings and Development > Basic configuration and note the AppID and AppSecret.`,
            msg`Choose a Token, generate an EncodingAESKey, and set the message encryption mode to "Safe mode".`,
            msg`In Settings > API Keys add the AppID, AppSecret, Token and EncodingAESKey under "Messenger Bot Keys".`,
            msg`After activating the connection here, paste the webhook URL as the server URL and enable the server configuration.`,
        ],
        title: msg`Connect WeChat Official Account`,
    },
    whatsapp: {
        note: msg`WhatsApp only allows free-form replies within 24 hours of the customer's last message. A reply that would land later is not sent; the thread shows why.`,
        steps: [
            msg`Create a Meta app with the WhatsApp product at developers.facebook.com and add a business phone number.`,
            msg`Copy the Phone number ID, a permanent (System User) access token, and the App Secret (App settings > Basic). Choose any Verify token.`,
            msg`In Settings > API Keys add all four under "Messenger Bot Keys".`,
            msg`After activating the connection here, paste the webhook URL as the Callback URL with the same Verify token, then subscribe to the "messages" webhook field.`,
        ],
        title: msg`Connect WhatsApp`,
    },
};

const WEBHOOK_HINTS: Record<MessengerPlatformId, MessageDescriptor> = {
    discord: msg`Paste as the Interactions Endpoint URL in your Discord application.`,
    feishu: msg`Paste as the Request URL under Events & Callbacks in your Feishu/Lark app.`,
    line: msg`Paste as the Webhook URL on the Messaging API tab of your LINE channel.`,
    slack: msg`Paste as the Request URL under Event Subscriptions in your Slack app.`,
    teams: msg`Paste as the Messaging endpoint in your Azure Bot's configuration.`,
    telegram: msg`Register it with Telegram's setWebhook, passing your webhook secret as secret_token.`,
    wechat: msg`Paste as the server URL (Basic configuration) of your Official Account, in safe mode.`,
    whatsapp: msg`Paste as the Callback URL in your Meta app's WhatsApp webhook configuration.`,
};

/** Where the webhook URL goes on the platform's side. */
export const webhookHint = (platform: MessengerPlatformId): MessageDescriptor => WEBHOOK_HINTS[platform];

const MessengerSetupDialog: FC<MessengerSetupDialogProps> = ({ isOpen, isPending, onClose, onConfirm, platform }) => {
    const { i18n, t } = useLingui();
    const instructions = SETUP_INSTRUCTIONS[platform];

    return (
        <Dialog onOpenChange={(open) => !open && onClose()} open={isOpen}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>{i18n._(instructions.title)}</DialogTitle>
                    <DialogDescription>{t`Follow these steps to connect your ${platform} account.`}</DialogDescription>
                </DialogHeader>

                <div className="space-y-4 py-4">
                    <ol className="space-y-3 text-sm">
                        {instructions.steps.map((step, index) => (
                            <li className="flex gap-3" key={step.id}>
                                <span
                                    aria-hidden="true"
                                    className="bg-primary text-primary-foreground flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-medium"
                                >
                                    {index + 1}
                                </span>
                                <span className="text-muted-foreground pt-0.5">{i18n._(step)}</span>
                            </li>
                        ))}
                    </ol>

                    <div className="flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800 dark:border-blue-800 dark:bg-blue-950/50 dark:text-blue-300">
                        <AlertCircle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                        <p>{i18n._(instructions.note)}</p>
                    </div>
                </div>

                <DialogFooter>
                    <Button onClick={onClose} variant="outline">
                        {t`Cancel`}
                    </Button>
                    <Button disabled={isPending} onClick={onConfirm}>
                        {isPending ? t`Activating...` : t`Activate Connection`}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};

export default MessengerSetupDialog;
