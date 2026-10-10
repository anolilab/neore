"use client";

import { useLingui } from "@lingui/react/macro";
import { Label } from "@neore/ui/components/label";
import type { FC } from "react";

import AperturePicker from "./aperture-picker";
import CameraPicker from "./camera-picker";
import FocalLengthPicker from "./focal-length-picker";
import LensPicker from "./lens-picker";
import type { CinemaSettings } from "./types";

interface CinemaStudioControlsProps {
    onChange: (value: CinemaSettings) => void;
    value: CinemaSettings;
}

const CinemaStudioControls: FC<CinemaStudioControlsProps> = ({ onChange, value }) => {
    const { t } = useLingui();

    return (
        <div className="space-y-4">
            <div>
                <Label>{t`Camera Type`}</Label>
                <p className="text-muted-foreground mb-2 text-xs">{t`Choose the camera system for your shot`}</p>
                <CameraPicker onChange={(camera) => onChange({ ...value, camera })} value={value.camera} />
            </div>

            <div>
                <Label>{t`Lens Type`}</Label>
                <p className="text-muted-foreground mb-2 text-xs">{t`Select the lens characteristics`}</p>
                <LensPicker onChange={(lens) => onChange({ ...value, lens })} value={value.lens} />
            </div>

            <div>
                <Label>{t`Focal Length`}</Label>
                <p className="text-muted-foreground mb-2 text-xs">{t`Set the focal length in millimeters`}</p>
                <FocalLengthPicker onChange={(focalLength) => onChange({ ...value, focalLength })} value={value.focalLength} />
            </div>

            <div>
                <Label>{t`Aperture`}</Label>
                <p className="text-muted-foreground mb-2 text-xs">{t`Control depth of field with aperture setting`}</p>
                <AperturePicker onChange={(aperture) => onChange({ ...value, aperture })} value={value.aperture} />
            </div>
        </div>
    );
};

export default CinemaStudioControls;
