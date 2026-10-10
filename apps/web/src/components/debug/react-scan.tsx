"use client";

// react-scan must be imported before react
import { useEffect } from "react";
import { scan } from "react-scan";

const ReactScan = () => {
    useEffect(() => {
        scan({
            enabled: import.meta.env.DEV,
        });
    }, []);

    return <></>;
};

export default ReactScan;
