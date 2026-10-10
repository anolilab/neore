import { Folder } from "lucide-react";
import type { IconName } from "lucide-react/dynamic";
import { DynamicIcon, iconNames } from "lucide-react/dynamic";

import IconPlaceholder from "./icon-placeholder";

const KNOWN_ICON_NAMES = new Set<string>(iconNames);

/**
 * A project's icon, which is a lucide name chosen at runtime. It is loaded on
 * demand, and this module is itself lazy: `lucide-react/dynamic` carries an
 * import map of every icon (~190KB), which does not belong on the chat route.
 */
const ProjectIcon = ({ color, name }: { color: string; name: string }) => {
    if (!KNOWN_ICON_NAMES.has(name)) {
        return <Folder className="size-3" style={{ color }} />;
    }

    return <DynamicIcon className="size-3" fallback={IconPlaceholder} name={name as IconName} style={{ color }} />;
};

export default ProjectIcon;
