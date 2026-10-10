const truncate = (string_: string | null | undefined, length: number): string | null => {
    if (!string_ || string_.length <= length) {
        return string_ ?? null;
    }

    return `${string_.slice(0, length - 3)}...`;
};

export default truncate;
