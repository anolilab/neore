import { Trans } from "@lingui/react/macro";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@neore/ui/components/accordion";
import { Alert, AlertDescription, AlertTitle } from "@neore/ui/components/alert";
import { Button, buttonVariants } from "@neore/ui/components/button";
import { useQueryErrorResetBoundary } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import { AlertTriangleIcon } from "lucide-react";
import { useEffect } from "react";

const ErrorComponent = ({ error }: { error: Error }) => {
    const router = useRouter();
    // Narrow the from prop type for better TS performance
    const fromRoute: "/chat/$threadId" | "/dashboard" | "/auth/sign-in" = "/chat/$threadId";

    const queryClientErrorBoundary = useQueryErrorResetBoundary();

    useEffect(() => {
        queryClientErrorBoundary.reset();
    }, [queryClientErrorBoundary]);

    return (
        <div className="mt-8 flex items-center justify-center p-4">
            <div className="w-full max-w-md">
                <Alert variant="destructive">
                    <AlertTriangleIcon className="size-4" />
                    <AlertTitle>
                        <Trans>Oops! Something went wrong</Trans>
                    </AlertTitle>
                    <AlertDescription>
                        <Trans>We&apos;re sorry, but the website has encountered an unexpected issue</Trans>
                    </AlertDescription>
                </Alert>
                <div className="mt-4 space-y-4">
                    <Button
                        className="w-full"
                        onClick={() => {
                            router.invalidate();
                        }}
                    >
                        <Trans>Try again</Trans>
                    </Button>
                    {/* A link styled as a button: it navigates, so it keeps link semantics. */}
                    <Link className={buttonVariants({ className: "w-full", variant: "outline" })} from={fromRoute} to="/">
                        <Trans>Return to home</Trans>
                    </Link>
                    {import.meta.env.DEV ? (
                        <Accordion className="w-full">
                            <AccordionItem value="error-details">
                                <AccordionTrigger>
                                    <Trans>View error details</Trans>
                                </AccordionTrigger>
                                <AccordionContent>
                                    <div className="bg-muted rounded-md p-4">
                                        <h3 className="mb-2 font-semibold">
                                            <Trans>Error details:</Trans>
                                        </h3>
                                        <p className="mb-4 text-sm">{error.message}</p>
                                        <h3 className="mb-2 font-semibold">
                                            <Trans>Error trace:</Trans>
                                        </h3>
                                        <pre className="overflow-x-auto text-xs whitespace-pre-wrap">{error.stack}</pre>
                                    </div>
                                </AccordionContent>
                            </AccordionItem>
                        </Accordion>
                    ) : null}
                </div>
            </div>
        </div>
    );
};

export default ErrorComponent;
