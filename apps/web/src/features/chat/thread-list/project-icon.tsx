import LucideIconByName from "@neore/ui/components/lucide-icon-by-name";
import { Folder } from "lucide-react";

import IconPlaceholder from "./icon-placeholder";

/**
 * A project's icon, a lucide name chosen at runtime. The first one loads the map of
 * every icon as one lazy chunk; a name lucide does not have shows the folder icon.
 */
const ProjectIcon = ({ color, name }: { color: string; name: string }) => (
    <LucideIconByName
        className="size-3"
        fallback={<IconPlaceholder />}
        name={name}
        notFound={<Folder className="size-3" style={{ color }} />}
        style={{ color }}
    />
);

export default ProjectIcon;
