import { createFileRoute } from "@tanstack/react-router";

import { DashboardOptimizationView } from "../-dashboard";

export const Route = createFileRoute("/_dashboard/optimization")({
  component: DashboardOptimizationView,
});
