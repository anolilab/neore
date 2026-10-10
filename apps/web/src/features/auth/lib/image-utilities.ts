const loadImage = async (file: File): Promise<HTMLImageElement> =>
    new Promise((resolve, reject) => {
        const image = new Image();
        const reader = new FileReader();

        reader.addEventListener("load", (e) => {
            image.src = e.target?.result as string;
        });

        image.addEventListener("load", () => {
            resolve(image);
        });
        image.addEventListener("error", (error) => {
            reject(error);
        });

        reader.readAsDataURL(file);
    });

export const resizeAndCropImage = async (file: File, name: string, size: number, extension: string): Promise<File> => {
    const image = await loadImage(file);

    const canvas = document.createElement("canvas");

    canvas.width = size;
    canvas.height = size;

    const context = canvas.getContext("2d");

    const minEdge = Math.min(image.width, image.height);

    const sx = (image.width - minEdge) / 2;
    const sy = (image.height - minEdge) / 2;
    const sWidth = minEdge;
    const sHeight = minEdge;

    context?.drawImage(image, sx, sy, sWidth, sHeight, 0, 0, size, size);

    const resizedImageBlob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, `image/${extension}`);
    });

    return new File([resizedImageBlob as BlobPart], `${name}.${extension}`, {
        type: `image/${extension}`,
    });
};

export const fileToBase64 = async (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
        const reader = new FileReader();

        reader.onloadend = () => {
            resolve(reader.result as string);
        };
        reader.addEventListener("error", reject);
        reader.readAsDataURL(file);
    });
