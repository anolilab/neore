"use client";

import cn from "@ui/utils/cn";
import React from "react";

import { getIcon, isSvgIcon, spriteSheet } from "../../lib/provider-icons";

interface ProviderIconProps {
    className?: string;
    provider: string;
    providerIcon: string | null;
}

/**
 * The badge for a provider with no icon: its first two letters. They are drawn as generated content, not text: the badge
 * sits beside the model's name, often inside a control named after that name (the model picker's "Model: …"), and text
 * there would be visible content missing from the control's name (WCAG 2.5.3, axe `label-content-name-mismatch`).
 */
const InitialsBadge: React.FC<{ className?: string; initials: string }> = ({ className, initials }) => (
    <div aria-hidden="true" className={cn("bg-muted flex items-center justify-center rounded", className)}>
        <span className="text-muted-foreground text-xs font-medium before:content-[attr(data-initials)]" data-initials={initials} />
    </div>
);

export const ProviderIcon: React.FC<ProviderIconProps> = ({ className = "w-5 h-5", provider, providerIcon }) => {
    if (!providerIcon) {
        return <InitialsBadge className={className} initials={provider.slice(0, 2).toUpperCase()} />;
    }

    // Get the icon data from the provider registry
    const iconData = getIcon(providerIcon);

    if (iconData) {
        // Check if it's an SVG icon or base64 icon
        if (isSvgIcon(providerIcon)) {
            return (
                <div className={cn("flex items-center justify-center overflow-hidden rounded bg-white/50 p-0.5", className)}>
                    <svg className="h-full w-full">
                        <use href={iconData} />
                    </svg>
                </div>
            );
        }

        // Base64 icon - use img tag
        return (
            <div className={cn("flex items-center justify-center overflow-hidden rounded bg-white/50 p-0.5", className)}>
                <img alt={provider} className="h-full w-full object-contain" src={iconData} />
            </div>
        );
    }

    // Fallback to initials if no icon is found
    return <InitialsBadge className={className} initials={providerIcon.toUpperCase().slice(0, 2)} />;
};

// Component to inject the sprite sheet into the DOM
export const IconSpriteSheet: React.FC = () => {
    React.useEffect(() => {
        // Inject the sprite sheet into the DOM if it doesn't exist
        if (document.querySelector("#icon-sprite-sheet")) {
            return;
        }

        const spriteElement = document.createElement("div");

        spriteElement.id = "icon-sprite-sheet";
        spriteElement.innerHTML = spriteSheet;
        spriteElement.style.display = "none";

        document.body.appendChild(spriteElement);
    }, []);

    return null;
};
