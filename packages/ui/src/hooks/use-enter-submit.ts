import type { RefObject } from "react";
import { useRef } from "react";

const useEnterSubmit = (): {
    formRef: RefObject<HTMLFormElement>;
    onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
} => {
    const formRef = useRef<HTMLFormElement>(null);

    const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
        if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
            return;
        }

        formRef.current?.requestSubmit();
        event.preventDefault();
    };

    return {
        formRef: formRef as RefObject<HTMLFormElement>,
        onKeyDown: handleKeyDown,
    };
};

export default useEnterSubmit;
