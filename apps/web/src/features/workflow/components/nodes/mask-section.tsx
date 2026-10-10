import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@ui/components/button";
import { Paintbrush } from "lucide-react";
import { useState } from "react";

import MaskEditor from "./mask-editor";

interface MaskSectionProps {
    imageUrl: string | undefined;
    maskUrl: string | undefined;
    onMaskChange: (maskDataUrl: string) => void;
}

/**
 * Shared mask drawing UI: "Draw Mask" button, inline editor, and mask preview.
 * Used by inpaint-node and object-editor-node.
 */
const MaskSection = ({ imageUrl, maskUrl, onMaskChange }: MaskSectionProps) => {
    const [showEditor, setShowEditor] = useState(false);
    const { t } = useLingui();

    return (
        <>
            {/* Draw mask button - only available when there's an input image */}
            {imageUrl && !showEditor && (
                <Button className="nodrag mt-1.5 h-7 w-full gap-1.5 text-xs" onClick={() => setShowEditor(true)} size="sm" variant="outline">
                    <Paintbrush className="size-3" />
                    <Trans>Draw Mask</Trans>
                </Button>
            )}

            {/* Inline mask editor */}
            {showEditor && imageUrl && (
                <div className="nodrag nopan nowheel mt-2">
                    <MaskEditor
                        imageUrl={imageUrl}
                        onCancel={() => setShowEditor(false)}
                        onSave={(maskDataUrl) => {
                            onMaskChange(maskDataUrl);
                            setShowEditor(false);
                        }}
                    />
                </div>
            )}

            {/* Mask preview */}
            {maskUrl && !showEditor && (
                <div className="mt-1.5 overflow-hidden rounded border">
                    <img alt={t`Mask preview`} className="max-h-[80px] w-full object-contain opacity-60" src={maskUrl} />
                </div>
            )}
        </>
    );
};

export default MaskSection;
