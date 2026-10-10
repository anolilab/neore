import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@neore/ui/components/card";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { CheckCircle, XCircle } from "lucide-react";
import { useState } from "react";

import { requireSession } from "@/lib/auth/route-guard";
import { useCRPC } from "@/lib/lunora/crpc";
import { noteThreadShard } from "@/lib/lunora/shard-routing";

const InvitePage = () => {
    const { t } = useLingui();
    const inviteToken = Route.useParams({ select: ({ inviteToken: selected }) => selected });
    const crpc = useCRPC();
    const navigate = useNavigate();
    const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
    const [errorMessage, setErrorMessage] = useState<string>("");

    const acceptInviteMutation = useMutation(crpc.chat.sharing.acceptThreadInvite.mutationOptions());

    const handleAcceptInvite = async () => {
        try {
            const result = await acceptInviteMutation.mutateAsync({ inviteToken });

            // The thread lives on its owner's shard (`lib/lunora/shard-routing.ts`).
            noteThreadShard(result.threadId, result.ownerId);
            setStatus("success");
            // Redirect to the thread after a short delay
            setTimeout(() => {
                void navigate({ params: { threadId: result.threadId }, to: "/chat/$threadId" });
            }, 2000);
        } catch (error) {
            setStatus("error");
            setErrorMessage(error instanceof Error ? error.message : t`Failed to accept invite`);
        }
    };

    return (
        <div className="bg-background flex min-h-screen items-center justify-center">
            <Card className="w-full max-w-md">
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        {status === "loading" && t`Thread Invite`}
                        {status === "success" && <CheckCircle className="h-5 w-5 text-green-500" />}
                        {status === "error" && <XCircle className="h-5 w-5 text-red-500" />}
                        {status === "success" && t`Invite Accepted!`}
                        {status === "error" && t`Invite Error`}
                    </CardTitle>
                    <CardDescription>
                        {status === "loading" && t`You've been invited to join a thread. Click the button below to accept.`}
                        {status === "success" && t`You've successfully joined the thread. Redirecting...`}
                        {status === "error" && errorMessage}
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    {status === "loading" && (
                        <Button className="w-full" onClick={handleAcceptInvite}>
                            <Trans>Accept Invite</Trans>
                        </Button>
                    )}
                    {status === "success" && (
                        <div className="text-muted-foreground text-center text-sm">
                            <Trans>Redirecting to the thread...</Trans>
                        </div>
                    )}
                    {status === "error" && (
                        <Button className="w-full" onClick={() => globalThis.location.assign("/chat")} variant="outline">
                            <Trans>Go to Chat</Trans>
                        </Button>
                    )}
                </CardContent>
            </Card>
        </div>
    );
};

export const Route = createFileRoute("/(public)/invite/$inviteToken")({
    beforeLoad: async ({ context, params: _params }) => {
        // Check if user is authenticated
        requireSession(context);
    },
    component: InvitePage,
});
