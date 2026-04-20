import { createFileRoute } from "@tanstack/react-router";

import { DashboardTraceDetailView } from "../../-dashboard";

export const Route = createFileRoute("/_dashboard/traces/$traceId")({
  component: DashboardTraceDetailView,
});
