import { createFileRoute } from "@tanstack/react-router";

import { DashboardLayout } from "../-dashboard";
import { getDashboardSnapshot } from "#/lib/dashboard.functions";

export const Route = createFileRoute("/_dashboard")({
  loader: async () => getDashboardSnapshot(),
  component: DashboardLayoutRoute,
});

function DashboardLayoutRoute() {
  return <DashboardLayout initialSnapshot={Route.useLoaderData()} />;
}
