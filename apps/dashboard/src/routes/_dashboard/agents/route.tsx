import { Outlet, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_dashboard/agents")({
  component: DashboardAgentsLayoutRoute,
});

function DashboardAgentsLayoutRoute() {
  return <Outlet />;
}
