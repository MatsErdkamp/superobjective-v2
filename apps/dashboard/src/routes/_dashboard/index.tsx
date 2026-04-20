import { createFileRoute } from "@tanstack/react-router";

import { DashboardOverviewView } from "../-dashboard";

export const Route = createFileRoute("/_dashboard/")({
  component: DashboardOverviewView,
});
