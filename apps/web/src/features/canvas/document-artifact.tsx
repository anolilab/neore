"use client";

/**
 * DocumentArtifact - Web app container.
 * Wires canvas state (open/active) and cRPC sheet content into the shared chat-ui component.
 */

import type { Id } from "@neore/backend/dataModel";
import DocumentArtifactUI from "@neore/chat-ui/chat/document-artifact";
import { useQuery } from "@tanstack/react-query";
import type { FC } from "react";
import { memo, useEffect, useRef } from "react";

import { useCanvasState } from "@/features/chat/core/stores/chat-ui-store";
import { trackEvent } from "@/lib/analytics";
import { useCRPC } from "@/lib/lunora/crpc";

import preloadCodemirrorEditor from "./canvas-preload";

interface DocumentArtifactProps {
    className?: string;
    documentId: string;
    kind: "code" | "design" | "image" | "sheet" | "text";
    language?: string;
    title: string;
    version: number;
}

const DocumentArtifact: FC<DocumentArtifactProps> = memo(({ className, documentId, kind, language, title, version }) => {
    const { activeDocumentId, openCanvas } = useCanvasState();
    const crpc = useCRPC();

    // Track artifact creation once (when first rendered at version 1)
    const trackedRef = useRef(false);

    useEffect(() => {
        if (version !== 1 || trackedRef.current) {
            return;
        }

        trackedRef.current = true;
        trackEvent("artifact_created", { kind });
    }, [version, kind]);

    const { data: document } = useQuery({
        ...crpc.agent.documents.getDocument.queryOptions({
            documentId: documentId as Id<"documents">,
        }),
        enabled: kind === "sheet",
    });

    return (
        <DocumentArtifactUI
            className={className}
            documentId={documentId}
            isActive={activeDocumentId === documentId}
            kind={kind}
            language={language}
            onOpen={openCanvas}
            onPreload={preloadCodemirrorEditor}
            sheetContent={kind === "sheet" ? document?.content : undefined}
            title={title}
            version={version}
        />
    );
});

DocumentArtifact.displayName = "DocumentArtifact";
export default DocumentArtifact;
