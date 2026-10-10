"use client";

/**
 * ChatError - Inline error display component for chat errors
 *
 * Displays error messages with retry functionality following AI SDK patterns.
 * Shows a dismissable error banner with a retry button when errors occur.
 */

import { Trans, useLingui } from "@lingui/react/macro";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@neore/ui/components/alert";
import { Button } from "@neore/ui/components/button";
import cn from "@neore/ui/utils/cn";
import { AlertCircle, RefreshCw, X } from "lucide-react";
import type { FC } from "react";

import { useChatError } from "@/features/chat/core/context/chat-context";
import { ErrorUtilities, RateLimitError } from "@/lib/errors";

interface ChatErrorProps {
    className?: string;
}

/**
 * Inline chat error display component
 * Shows an error message with retry and dismiss actions.
 */
const ChatError: FC<ChatErrorProps> = ({ className }) => {
    const { clearError, error, regenerate } = useChatError();
    const { i18n, t } = useLingui();

    if (!error) {
        return null;
    }

    const userMessage = ErrorUtilities.getUserMessage(error, i18n);
    const isRetryable = ErrorUtilities.isRetryable(error);
    const isRateLimited = error instanceof RateLimitError;
    const retryMinutes = isRateLimited ? error.getRetryAfterMinutes() : 0;

    const handleRetry = async () => {
        await regenerate();
    };

    return (
        <Alert aria-live="polite" className={cn("animate-in fade-in slide-in-from-bottom-2 duration-200", className)} variant="destructive">
            <AlertCircle className="size-4" />
            <AlertTitle>
                <Trans>An error occurred</Trans>
            </AlertTitle>
            <AlertDescription>{userMessage}</AlertDescription>
            <AlertAction className="flex items-center gap-2">
                {isRetryable && !isRateLimited && (
                    <Button className="h-6 gap-1.5 text-xs" onClick={handleRetry} size="sm" variant="outline">
                        <RefreshCw className="size-3" />
                        <Trans>Retry</Trans>
                    </Button>
                )}

                {isRateLimited && (
                    <span className="text-muted-foreground text-xs">
                        <Trans>Try again in {retryMinutes}m</Trans>
                    </span>
                )}

                <Button aria-label={t`Dismiss error`} className="size-6" onClick={clearError} size="icon" variant="ghost">
                    <X className="size-3" />
                </Button>
            </AlertAction>
        </Alert>
    );
};

export default ChatError;
