import { useQuery } from "@tanstack/react-query";

import { useCRPC } from "@/lib/lunora/crpc";

/** Which plans can be bought yearly. Settings only, so it never joins first paint. */
export default function useBillingOptions() {
    const crpc = useCRPC();
    const { data } = useQuery(crpc.billing.checkout.getBillingOptions.queryOptions({}, { live: false }));

    return { yearly: { pro: data?.yearly.pro === true, team: data?.yearly.team === true } };
}
