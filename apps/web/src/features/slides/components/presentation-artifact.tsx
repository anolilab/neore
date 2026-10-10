"use client";

/**
 * PresentationArtifact - Web app container.
 * Wires the presentation viewer store into the shared chat-ui component.
 */

import PresentationArtifactUI from "@neore/chat-ui/chat/presentation-artifact";
import type { FC } from "react";

import usePresentationViewerStore from "../hooks/use-presentation-viewer-store";

interface PresentationArtifactProps {
    className?: string;
    presentationId: string;
    slideCount: number;
    styleName?: string;
    title: string;
}

const PresentationArtifact: FC<PresentationArtifactProps> = ({ className, presentationId, slideCount, styleName, title }) => {
    const { openPresentation } = usePresentationViewerStore();

    return (
        <PresentationArtifactUI
            className={className}
            onOpen={openPresentation}
            presentationId={presentationId}
            slideCount={slideCount}
            styleName={styleName}
            title={title}
        />
    );
};

PresentationArtifact.displayName = "PresentationArtifact";
export default PresentationArtifact;
