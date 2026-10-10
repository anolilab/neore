import { throwForbidden } from "../../lib/error-helpers";

// Helper function to check role authorization
const roleGuard = (role: "admin", user: { isAdmin?: boolean; role?: string | null } | null): void => {
    if (!user) {
        throwForbidden("Access denied");
    }

    if (role === "admin" && !user.isAdmin) {
        throwForbidden("Admin access required");
    }
};

export default roleGuard;
