import { createFileRoute } from "@tanstack/react-router";

import { DashboardTracesListView } from "../../-dashboard";

export const Route = createFileRoute("/_dashboard/traces/")({
  component: DashboardTracesListView,
});
