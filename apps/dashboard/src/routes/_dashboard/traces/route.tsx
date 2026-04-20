import { Outlet, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_dashboard/traces")({
  component: DashboardTracesLayoutRoute,
});

function DashboardTracesLayoutRoute() {
  return <Outlet />;
}
