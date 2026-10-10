import { useRef } from "react";

const useToRef = <T>(value: T) => {
    const ref = useRef(value);

    ref.current = value;

    return ref;
};

export default useToRef;
