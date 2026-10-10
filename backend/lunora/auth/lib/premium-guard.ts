import { throwForbidden } from "../../lib/error-helpers";
import type { SessionUser } from "../functions";

const premiumGuard = (user: { plan?: SessionUser["plan"] }) => {
    if (!user.plan) {
        throwForbidden("Premium subscription required");
    }
};

export default premiumGuard;
