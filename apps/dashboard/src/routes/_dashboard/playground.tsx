import { createFileRoute } from "@tanstack/react-router";

import { PlaygroundChat } from "#/components/playground/playground-chat";
import { useDashboardShell } from "../-dashboard";

export const Route = createFileRoute("/_dashboard/playground")({
  component: DashboardPlaygroundRoute,
});

function DashboardPlaygroundRoute() {
  const shell = useDashboardShell();

  return <PlaygroundChat initialSnapshot={shell.snapshot} />;
}
