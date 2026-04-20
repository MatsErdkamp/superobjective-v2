import { createFileRoute } from "@tanstack/react-router";

import { DashboardAgentView } from "../../-dashboard";

export const Route = createFileRoute("/_dashboard/agents/$agentName")({
  component: DashboardAgentView,
});
