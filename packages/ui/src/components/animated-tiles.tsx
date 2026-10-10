"use client";

import { memo, useEffect, useRef } from "react";

import cn from "../utils/cn";

interface AnimatedTilesProps {
    className?: string;
    cols?: number;
    containerClassName?: string;
    /** Color for gradient tiles when no imageUrl is provided */
    gradientColor?: string;
    imageUrl?: string;
    rows?: number;
    tileSize?: number;
}

const defaultMaxOpacities = [
    [0, 0.2, 0.4, 0.6, 0.6, 0.4, 0.2, 0],
    [0.2, 0.4, 0.8, 1, 1, 0.6, 0.4, 0.2],
    [0.2, 0.4, 1, 1, 1, 0.8, 0.6, 0.2],
    [0.2, 0.6, 1, 1, 1, 1, 0.6, 0.2],
    [0.2, 0.6, 1, 1, 1, 1, 0.6, 0.2],
    [0.2, 0.6, 1, 1, 1, 1, 0.6, 0.2],
    [0.2, 0.4, 0.8, 1, 1, 0.8, 0.6, 0.2],
    [0.2, 0.4, 0.6, 0.8, 0.8, 0.6, 0.4, 0.1],
    [0.1, 0.2, 0.4, 0.4, 0.4, 0.4, 0.2, 0.1],
    [0, 0.2, 0.2, 0.2, 0.2, 0.2, 0.1, 0.1],
    [0, 0.1, 0.1, 0.1, 0.1, 0.1, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0],
];

const AnimatedTiles = memo(
    ({ className, cols = 8, containerClassName, gradientColor = "currentColor", imageUrl, rows = 12, tileSize = 50 }: AnimatedTilesProps) => {
        const tilesRef = useRef<HTMLDivElement>(null);

        useEffect(() => {
            if (!tilesRef.current) {
                return undefined;
            }

            const tiles: HTMLDivElement[] = [];

            tilesRef.current.replaceChildren();

            for (let row = 0; row < rows; row++) {
                for (let col = 0; col < cols; col++) {
                    const tile = document.createElement("div");

                    tile.style.width = `${tileSize}px`;
                    tile.style.height = `${tileSize}px`;

                    if (imageUrl) {
                        tile.style.backgroundImage = `url(${imageUrl})`;
                        tile.style.backgroundPosition = `${-col * tileSize}px ${-row * tileSize}px`;
                        tile.style.backgroundSize = `${cols * tileSize}px ${rows * tileSize}px`;
                    } else {
                        // Gradient mode - create a gradient pattern based on position
                        tile.style.backgroundColor = gradientColor;
                    }

                    tile.style.float = "left";
                    tiles.push(tile);
                    tilesRef.current.appendChild(tile);
                }
            }

            const animationFrames: number[] = [];
            const startTimes: number[] = [];

            for (const [i, tile] of tiles.entries()) {
                const row = Math.floor(i / cols);
                const col = i % cols;
                const maxOpacity = defaultMaxOpacities[row]?.[col] ?? 0;

                if (maxOpacity === 0) {
                    tile.style.opacity = "0";

                    continue;
                }

                const variance = 0.4;
                const minOpacity = Math.max(0, maxOpacity - variance);
                const duration = Math.random() * 0.25 + 0.75;

                startTimes[i] = Math.random() * duration;
                let startTime: number | null = null;

                const animate = (currentTime: number) => {
                    if (startTime === null) startTime = currentTime;

                    const elapsed = (currentTime - startTime) / 1000;
                    const progress = (elapsed + (startTimes[i] ?? 0)) % (duration * 2);
                    const normalizedProgress = (progress < duration ? progress : duration * 2 - progress) / duration;

                    const opacity = minOpacity + (maxOpacity - minOpacity) * normalizedProgress;

                    tile.style.opacity = Math.max(minOpacity, Math.min(maxOpacity, opacity)).toString();

                    animationFrames[i] = requestAnimationFrame(animate);
                };

                animationFrames[i] = requestAnimationFrame(animate);
            }

            return () => {
                animationFrames.forEach((frameId) => cancelAnimationFrame(frameId));
            };
        }, [rows, cols, tileSize, imageUrl, gradientColor]);

        return (
            <div className={cn("flex items-center justify-center", containerClassName)}>
                <div
                    className={cn("relative overflow-hidden", className)}
                    ref={tilesRef}
                    style={{
                        height: `${rows * tileSize}px`,
                        width: `${cols * tileSize}px`,
                    }}
                />
            </div>
        );
    },
);

export default AnimatedTiles;
