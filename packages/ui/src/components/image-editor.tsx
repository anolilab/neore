import { useLingui } from "@lingui/react/macro";
import { Crop, Download, RotateCcw, RotateCw, X, ZoomIn, ZoomOut } from "lucide-react";
import React, { useCallback, useRef, useState } from "react";

import { Button } from "./button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./dialog";
import { Input } from "./input";

interface ImageEditorProperties {
    isOpen: boolean;
    onClose: () => void;
    onSave: (file: File) => void;
    originalFile: File | null;
}

interface CropArea {
    height: number;
    width: number;
    x: number;
    y: number;
}

const ImageEditor: React.FC<ImageEditorProperties> = ({ isOpen, onClose, onSave, originalFile }) => {
    const { t } = useLingui();
    const [rotation, setRotation] = useState(0);
    const [scale, setScale] = useState(1);
    const [cropArea, setCropArea] = useState<CropArea | null>(null);
    const [isCropping, setIsCropping] = useState(false);
    const [isDragging, setIsDragging] = useState(false);
    const [dragStart, setDragStart] = useState({ x: 0, y: 0 });

    const canvasReference = useRef<HTMLCanvasElement>(null);
    const imageReference = useRef<HTMLImageElement>(null);

    // Bumped once the decoded image has been handed to `imageReference`, so the
    // draw effect below re-runs for the new bitmap.
    const [loadedImageToken, setLoadedImageToken] = useState(0);

    // Load and process image when file changes
    React.useEffect(() => {
        if (!(originalFile && isOpen)) {
            return undefined;
        }

        const reader = new FileReader();
        const img = new Image();

        const handleImageLoad = () => {
            if (!imageReference.current) {
                return;
            }

            imageReference.current.src = img.src;
            setLoadedImageToken((token) => token + 1);
        };

        const handleReaderLoad = (e: ProgressEvent<FileReader>) => {
            img.addEventListener("load", handleImageLoad);
            img.src = e.target?.result as string;
        };

        reader.addEventListener("load", handleReaderLoad);
        reader.readAsDataURL(originalFile);

        return () => {
            reader.removeEventListener("load", handleReaderLoad);
            img.removeEventListener("load", handleImageLoad);
        };
    }, [originalFile, isOpen]);

    const drawImage = useCallback(() => {
        const canvas = canvasReference.current;
        const image = imageReference.current;

        if (!canvas || !image) {
            return;
        }

        const context = canvas.getContext("2d");

        if (!context) {
            return;
        }

        // Clear canvas
        context.clearRect(0, 0, canvas.width, canvas.height);

        // Save context
        context.save();

        // Move to center
        context.translate(canvas.width / 2, canvas.height / 2);

        // Apply transformations
        context.rotate((rotation * Math.PI) / 180);
        context.scale(scale, scale);

        // Draw image centered
        const imgWidth = image.naturalWidth;
        const imgHeight = image.naturalHeight;

        context.drawImage(image, -imgWidth / 2, -imgHeight / 2, imgWidth, imgHeight);

        // Draw crop overlay if cropping
        if (isCropping && cropArea) {
            context.restore();
            context.save();

            // Semi-transparent overlay
            context.fillStyle = "rgba(0, 0, 0, 0.5)";
            context.fillRect(0, 0, canvas.width, canvas.height);

            // Clear crop area
            context.globalCompositeOperation = "destination-out";
            context.fillRect(cropArea.x, cropArea.y, cropArea.width, cropArea.height);

            // Crop border
            context.globalCompositeOperation = "source-over";
            context.strokeStyle = "#fff";
            context.lineWidth = 2;
            context.strokeRect(cropArea.x, cropArea.y, cropArea.width, cropArea.height);
        }

        context.restore();
    }, [rotation, scale, isCropping, cropArea]);

    React.useEffect(() => {
        drawImage();
    }, [drawImage, loadedImageToken]);

    const handleMouseDown = (e: React.MouseEvent) => {
        if (!isCropping) {
            return;
        }

        const rect = canvasReference.current?.getBoundingClientRect();

        if (!rect) {
            return;
        }

        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        setIsDragging(true);
        setDragStart({ x, y });
        setCropArea({ height: 0, width: 0, x, y });
    };

    const handleMouseMove = (e: React.MouseEvent) => {
        if (!isDragging || !isCropping) {
            return;
        }

        const rect = canvasReference.current?.getBoundingClientRect();

        if (!rect) {
            return;
        }

        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        setCropArea((previous) => {
            if (!previous) {
                return null;
            }

            return {
                height: Math.abs(y - dragStart.y),
                width: Math.abs(x - dragStart.x),
                x: Math.min(dragStart.x, x),
                y: Math.min(dragStart.y, y),
            };
        });
    };

    const handleMouseUp = () => {
        setIsDragging(false);
    };

    const rotateLeft = () => setRotation((previous) => previous - 90);
    const rotateRight = () => setRotation((previous) => previous + 90);
    const zoomIn = () => setScale((previous) => Math.min(previous + 0.1, 3));
    const zoomOut = () => setScale((previous) => Math.max(previous - 0.1, 0.1));
    const resetTransform = () => {
        setRotation(0);
        setScale(1);
        setCropArea(null);
        setIsCropping(false);
    };

    const toggleCrop = () => {
        setIsCropping(!isCropping);

        if (!isCropping) {
            setCropArea(null);
        }
    };

    const applyCrop = () => {
        if (!cropArea || !canvasReference.current) {
            return;
        }

        const canvas = canvasReference.current;
        const temporaryCanvas = document.createElement("canvas");
        const temporaryContext = temporaryCanvas.getContext("2d");

        if (!temporaryContext) {
            return;
        }

        temporaryCanvas.width = cropArea.width;
        temporaryCanvas.height = cropArea.height;

        // Draw the cropped portion
        temporaryContext.drawImage(canvas, cropArea.x, cropArea.y, cropArea.width, cropArea.height, 0, 0, cropArea.width, cropArea.height);

        // Convert to blob and create new file
        temporaryCanvas.toBlob((blob) => {
            if (!(blob && originalFile)) {
                return;
            }

            const newFile = new File([blob], originalFile.name, {
                lastModified: Date.now(),
                type: originalFile.type,
            });

            onSave(newFile);
            onClose();
        }, originalFile?.type || "image/png");
    };

    const saveImage = () => {
        if (!canvasReference.current || !originalFile) {
            return;
        }

        canvasReference.current.toBlob((blob) => {
            if (!blob) {
                return;
            }

            const newFile = new File([blob], originalFile.name, {
                lastModified: Date.now(),
                type: originalFile.type,
            });

            onSave(newFile);
            onClose();
        }, originalFile.type || "image/png");
    };

    const scaleLabel = scale.toFixed(1);

    return (
        <Dialog onOpenChange={onClose} open={isOpen}>
            <DialogContent className="max-h-[90vh] max-w-4xl overflow-hidden">
                <DialogHeader>
                    <DialogTitle className="flex items-center justify-between">
                        <span>{t`Edit Image`}</span>
                        <Button aria-label={t`Close`} onClick={onClose} size="sm" variant="ghost">
                            <X aria-hidden="true" className="h-4 w-4" />
                        </Button>
                    </DialogTitle>
                </DialogHeader>

                <div className="flex flex-col gap-4">
                    {/* Image Canvas */}
                    <div className="relative flex min-h-[400px] items-center justify-center overflow-hidden rounded-lg bg-gray-100">
                        <canvas
                            className="max-h-[400px] max-w-full cursor-crosshair"
                            height={600}
                            onMouseDown={handleMouseDown}
                            onMouseLeave={handleMouseUp}
                            onMouseMove={handleMouseMove}
                            onMouseUp={handleMouseUp}
                            ref={canvasReference}
                            width={800}
                        />
                        <img alt={t`Original`} className="hidden" crossOrigin="anonymous" ref={imageReference} />
                    </div>

                    {/* Controls */}
                    <div className="flex flex-col gap-4">
                        {/* Toolbar */}
                        <div className="flex flex-wrap items-center gap-2">
                            <Button className="flex items-center gap-2" onClick={rotateLeft} size="sm" variant="outline">
                                <RotateCcw className="h-4 w-4" />
                                {t`Rotate Left`}
                            </Button>
                            <Button className="flex items-center gap-2" onClick={rotateRight} size="sm" variant="outline">
                                <RotateCw className="h-4 w-4" />
                                {t`Rotate Right`}
                            </Button>
                            <Button className="flex items-center gap-2" onClick={zoomOut} size="sm" variant="outline">
                                <ZoomOut className="h-4 w-4" />
                                {t`Zoom Out`}
                            </Button>
                            <Button className="flex items-center gap-2" onClick={zoomIn} size="sm" variant="outline">
                                <ZoomIn className="h-4 w-4" />
                                {t`Zoom In`}
                            </Button>
                            <Button className="flex items-center gap-2" onClick={toggleCrop} size="sm" variant={isCropping ? "default" : "outline"}>
                                <Crop className="h-4 w-4" />
                                {t`Crop`}
                            </Button>
                            <Button onClick={resetTransform} size="sm" variant="outline">
                                {t`Reset`}
                            </Button>
                        </div>

                        {/* Manual Controls */}
                        <div className="grid grid-cols-2 gap-4">
                            <div className="space-y-2">
                                <label className="text-sm font-medium" htmlFor="image-editor-rotation">
                                    {t`Rotation: ${rotation}°`}
                                </label>
                                <Input
                                    className="w-full"
                                    id="image-editor-rotation"
                                    max={180}
                                    min={-180}
                                    onChange={(e) => setRotation(Number(e.target.value))}
                                    step={1}
                                    type="number"
                                    value={rotation}
                                />
                            </div>
                            <div className="space-y-2">
                                <label className="text-sm font-medium" htmlFor="image-editor-scale">
                                    {t`Scale: ${scaleLabel}x`}
                                </label>
                                <Input
                                    className="w-full"
                                    id="image-editor-scale"
                                    max={3}
                                    min={0.1}
                                    onChange={(e) => setScale(Number(e.target.value))}
                                    step={0.1}
                                    type="number"
                                    value={scale}
                                />
                            </div>
                        </div>

                        {/* Action Buttons */}
                        <div className="flex items-center justify-end gap-2">
                            {isCropping && cropArea && (
                                <Button className="flex items-center gap-2" onClick={applyCrop}>
                                    <Crop className="h-4 w-4" />
                                    {t`Apply Crop`}
                                </Button>
                            )}
                            <Button className="flex items-center gap-2" onClick={saveImage}>
                                <Download className="h-4 w-4" />
                                {t`Save Image`}
                            </Button>
                        </div>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
};

export default ImageEditor;
