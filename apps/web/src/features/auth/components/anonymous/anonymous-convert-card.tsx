"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Card, CardContent } from "@neore/ui/components/card";
import cn from "@neore/ui/utils/cn";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRight, Shield } from "lucide-react";
import type { FC } from "react";

import useIsAnonymous from "@/features/auth/hooks/use-is-anonymous";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";

interface AnonymousConvertCardProperties {
    classNames?: {
        button?: string;
        card?: string;
        content?: string;
        description?: string;
        header?: string;
        title?: string;
    };
}

const AnonymousConvertCard: FC<AnonymousConvertCardProperties> = ({ classNames }) => {
    const { isAnonymous } = useIsAnonymous();
    const { basePath, viewPaths } = useAuth();
    const navigate = useNavigate({ from: "/chat/$threadId" as "/chat/$threadId" | "/dashboard" });
    const { t } = useLingui();

    if (!isAnonymous) {
        return null;
    }

    return (
        <Card className={cn("border-sidebar-accent", classNames?.card)}>
            <CardContent className={cn("p-3", classNames?.content)}>
                <div className="flex items-center gap-2">
                    <Shield className="text-sidebar-accent h-4 w-4" />
                    <div className="min-w-0 flex-1">
                        <p className={cn("text-sidebar-foreground text-xs font-medium", classNames?.title)}>{t`Guest Account`}</p>
                        <p className={cn("text-sidebar-muted-foreground text-xs", classNames?.description)}>{t`Convert to save your data`}</p>
                    </div>
                    <Button
                        className={cn("h-6 px-2 text-xs", classNames?.button)}
                        onClick={() => navigate({ to: `${basePath}/${viewPaths.CONVERT_ACCOUNT}` })}
                        size="sm"
                        variant="default"
                    >
                        {t`Convert`}
                        <ArrowRight className="ml-1 h-3 w-3" />
                    </Button>
                </div>
            </CardContent>
        </Card>
    );
};

export default AnonymousConvertCard;
