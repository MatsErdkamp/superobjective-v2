import * as React from "react";
import { Outlet, useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import type {
  ComponentTraceLike,
  RunTraceLike,
  ToolCallTraceLike,
} from "@superobjective/cloudflare";

import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { AppTopBar } from "#/components/app-top-bar";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card";
import { Icon, type IconComponent } from "#/components/ui/icon";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { ScrollArea } from "#/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarSeparator,
  SidebarTrigger,
} from "#/components/ui/sidebar";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table";
import { Textarea } from "#/components/ui/textarea";
import type {
  DashboardActionResult,
  DashboardSnapshot,
  DashboardTraceResponse,
} from "#/lib/dashboard.functions";
import { cn } from "#/lib/utils";
import {
  getDashboardTrace,
  getDashboardSnapshot,
  runDashboardAction,
} from "#/lib/dashboard.functions";

import {
  Breadcrumb as UIBreadcrumb,
  BreadcrumbItem as UIBreadcrumbItem,
  BreadcrumbList as UIBreadcrumbList,
  BreadcrumbPage as UIBreadcrumbPage,
  BreadcrumbSeparator as UIBreadcrumbSeparator,
} from "#/components/ui/breadcrumb";
import { Collapsible, CollapsibleContent } from "#/components/ui/collapsible";

type RunMode = "agent-chat" | "triage-tool" | "support-flow" | "triage-rpc" | "trace-probe-agent";
type DashboardSection = "overview" | "traces" | "optimization" | "agents" | "playground";

type TraceViewMode = "list" | "detail";

type TraceWaterfallItem =
  | {
      id: string;
      kind: "run";
      label: string;
      subtitle: string;
      durationMs: number;
      durationLabel: string;
      offsetPercent: number;
      widthPercent: number;
      status: "ok" | "error";
      run: RunTraceLike;
    }
  | {
      id: string;
      kind: "component";
      label: string;
      subtitle: string;
      durationMs: number;
      durationLabel: string;
      offsetPercent: number;
      widthPercent: number;
      status: "ok" | "error";
      component: ComponentTraceLike;
      run: RunTraceLike;
    }
  | {
      id: string;
      kind: "tool-call";
      label: string;
      subtitle: string;
      durationMs: number;
      durationLabel: string;
      offsetPercent: number;
      widthPercent: number;
      status: "ok" | "error";
      toolCall: ToolCallTraceLike;
      run: RunTraceLike;
    };

type TraceWaterfallNode = {
  item: TraceWaterfallItem;
  children: TraceWaterfallNode[];
};

const modeCopy: Record<
  RunMode,
  {
    label: string;
    description: string;
  }
> = {
  "agent-chat": {
    label: "Agent chat",
    description:
      "Run the deployed support agent chat surface through `/agents/support/:sessionId`.",
  },
  "triage-tool": {
    label: "Agent tool",
    description: "Invoke the agent-hosted `triage_ticket` tool through the support agent surface.",
  },
  "support-flow": {
    label: "RPC flow",
    description: "Call `supportFlow` through the RPC surface and inspect the resulting trace.",
  },
  "triage-rpc": {
    label: "RPC triage",
    description: "Call the raw triage predict module through `support_rpc.triageTicket`.",
  },
  "trace-probe-agent": {
    label: "Trace probe agent",
    description:
      "Run the dedicated trace probe agent through `/agents/trace_probe/:sessionId` to force three sequential predict calls in one trace.",
  },
};

const sectionCopy: Record<
  DashboardSection,
  {
    label: string;
    description: string;
    icon: IconComponent;
  }
> = {
  overview: {
    label: "Overview",
    description: "Run live surfaces, check the current deployment, and inspect the selected agent.",
    icon: Icon.House,
  },
  traces: {
    label: "Traces",
    description: "Recent run traces captured by the coupled live runtime.",
    icon: Icon.Search,
  },
  optimization: {
    label: "Optimization",
    description: "Artifacts and optimization job history exposed from the runtime store.",
    icon: Icon.Magic,
  },
  agents: {
    label: "Agents",
    description: "Dedicated pages for deployed agent surfaces and their recent trace activity.",
    icon: Icon.Agent,
  },
  playground: {
    label: "Playground",
    description: "Interactive chat playground backed by deployed agent surfaces.",
    icon: Icon.Msg,
  },
};
const primarySectionKeys = [
  "overview",
  "traces",
  "optimization",
] as const satisfies readonly DashboardSection[];
type DashboardShellContextValue = {
  body: string;
  error: string | null;
  isPending: boolean;
  isTracePending: boolean;
  latestArtifact: DashboardSnapshot["artifacts"][number] | null;
  latestTrace: DashboardSnapshot["traces"][number] | null;
  mode: RunMode;
  selectedAgentName: string;
  result: DashboardActionResult | null;
  selectedAgent: DashboardSnapshot["surfaces"]["agents"][number] | null;
  selectedItemId: string;
  selectedTraceDetail: DashboardTraceResponse | null;
  selectedTraceId: string;
  sessionId: string;
  snapshot: DashboardSnapshot;
  subject: string;
  traceError: string | null;
  traceItems: TraceWaterfallItem[];
  openOverview: () => void;
  openOptimization: () => void;
  openAgent: (agentName: string) => void;
  openTraceDetail: (traceId: string) => void;
  openTraceList: () => void;
  onBodyChange: (value: string) => void;
  onModeChange: (value: RunMode) => void;
  onRun: () => void;
  onSelectItem: (value: string) => void;
  onSessionIdChange: (value: string) => void;
  onSubjectChange: (value: string) => void;
};

const DashboardShellContext = React.createContext<DashboardShellContextValue | null>(null);

function getSectionFromPathname(pathname: string): DashboardSection {
  if (pathname.startsWith("/playground")) {
    return "playground";
  }

  if (pathname.startsWith("/agents")) {
    return "agents";
  }

  if (pathname.startsWith("/optimization")) {
    return "optimization";
  }

  if (pathname.startsWith("/traces")) {
    return "traces";
  }

  return "overview";
}

export function useDashboardShell() {
  const value = React.useContext(DashboardShellContext);

  if (value == null) {
    throw new Error("Dashboard shell context is unavailable.");
  }

  return value;
}

export function DashboardLayout(props: { initialSnapshot: DashboardSnapshot }) {
  const { initialSnapshot } = props;
  const invokeAction = useServerFn(runDashboardAction);
  const fetchTraceDetail = useServerFn(getDashboardTrace);
  const pathname = useLocation({
    select: (location) => location.pathname,
  });
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  const section = getSectionFromPathname(pathname);
  const routeAgentName =
    section === "agents" && typeof params.agentName === "string" ? params.agentName : null;
  const traceViewMode: TraceViewMode = pathname.startsWith("/traces/") ? "detail" : "list";

  const [snapshot, setSnapshot] = React.useState<DashboardSnapshot>(initialSnapshot);
  const selectedTraceId =
    traceViewMode === "detail" && typeof params.traceId === "string"
      ? params.traceId
      : (snapshot.traces[0]?.runId ?? "");
  const [mode, setMode] = React.useState<RunMode>("trace-probe-agent");
  const [sessionId, setSessionId] = React.useState("trace-probe-session");
  const [subject, setSubject] = React.useState("Refund not received");
  const [body, setBody] = React.useState(
    "I returned my order two weeks ago and still have not received the refund. Can you check the refund status and tell me whether this needs a human?",
  );
  const [result, setResult] = React.useState<DashboardActionResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [selectedAgentName, setSelectedAgentName] = React.useState(
    initialSnapshot.surfaces.agents.find((agent) => agent.name === "trace_probe")?.name ??
      initialSnapshot.surfaces.agents[0]?.name ??
      "",
  );
  const [selectedTraceDetail, setSelectedTraceDetail] =
    React.useState<DashboardTraceResponse | null>(null);
  const [selectedWaterfallItemId, setSelectedWaterfallItemId] = React.useState<string>("");
  const [traceError, setTraceError] = React.useState<string | null>(null);
  const [isTracePending, setIsTracePending] = React.useState(false);
  const [isPending, startTransition] = React.useTransition();

  React.useEffect(() => {
    setSnapshot(initialSnapshot);
  }, [initialSnapshot]);

  React.useEffect(() => {
    if (snapshot.surfaces.agents.length === 0) {
      setSelectedAgentName("");
      return;
    }

    if (
      selectedAgentName.length === 0 ||
      snapshot.surfaces.agents.every((agent) => agent.name !== selectedAgentName)
    ) {
      setSelectedAgentName(snapshot.surfaces.agents[0].name);
    }
  }, [selectedAgentName, snapshot.surfaces.agents]);

  React.useEffect(() => {
    const preferredAgentName = mode === "trace-probe-agent" ? "trace_probe" : "support";
    const preferredAgent = snapshot.surfaces.agents.find(
      (agent) => agent.name === preferredAgentName,
    );

    if (preferredAgent != null && selectedAgentName !== preferredAgent.name) {
      setSelectedAgentName(preferredAgent.name);
    }
  }, [mode, selectedAgentName, snapshot.surfaces.agents]);

  React.useEffect(() => {
    if (
      routeAgentName != null &&
      routeAgentName !== selectedAgentName &&
      snapshot.surfaces.agents.some((agent) => agent.name === routeAgentName)
    ) {
      setSelectedAgentName(routeAgentName);
    }
  }, [routeAgentName, selectedAgentName, snapshot.surfaces.agents]);

  React.useEffect(() => {
    if (traceViewMode !== "detail" || selectedTraceId.length === 0) {
      setSelectedTraceDetail(null);
      setSelectedWaterfallItemId("");
      setTraceError(null);
      return;
    }

    let cancelled = false;

    async function loadTrace() {
      try {
        setIsTracePending(true);
        setTraceError(null);
        const next = await fetchTraceDetail({
          data: {
            runId: selectedTraceId,
          },
        });

        if (cancelled) {
          return;
        }

        setSelectedTraceDetail(next);
        setSelectedWaterfallItemId(`run:${next.summary.runId}`);
      } catch (caught) {
        if (cancelled) {
          return;
        }

        setTraceError(
          caught instanceof Error ? caught.message : "Failed to load the selected trace.",
        );
        setSelectedTraceDetail(null);
        setSelectedWaterfallItemId("");
      } finally {
        if (!cancelled) {
          setIsTracePending(false);
        }
      }
    }

    void loadTrace();

    return () => {
      cancelled = true;
    };
  }, [fetchTraceDetail, selectedTraceId, traceViewMode]);

  const refreshSnapshot = React.useCallback(() => {
    startTransition(async () => {
      try {
        setError(null);
        const next = await getDashboardSnapshot();
        setSnapshot(next);
      } catch (caught) {
        setError(
          caught instanceof Error ? caught.message : "Failed to refresh the dashboard snapshot.",
        );
      }
    });
  }, []);

  const openOverview = React.useCallback(() => {
    void navigate({ to: "/" });
  }, [navigate]);

  const openTraceList = React.useCallback(() => {
    void navigate({ to: "/traces" });
  }, [navigate]);

  const openTraceDetail = React.useCallback(
    (traceId: string) => {
      void navigate({
        to: "/traces/$traceId",
        params: {
          traceId,
        },
      });
    },
    [navigate],
  );

  const openOptimization = React.useCallback(() => {
    void navigate({ to: "/optimization" });
  }, [navigate]);

  const openAgent = React.useCallback(
    (agentName: string) => {
      setSelectedAgentName(agentName);
      void navigate({
        to: "/agents/$agentName",
        params: {
          agentName,
        },
      });
    },
    [navigate],
  );

  const runSelectedMode = React.useCallback(() => {
    startTransition(async () => {
      try {
        setError(null);
        const next = await invokeAction({
          data: {
            mode,
            sessionId,
            subject,
            body,
          },
        });
        setResult(next);
        setSnapshot(next.snapshot);
        if (next.traceId != null) {
          openTraceDetail(next.traceId);
        } else {
          openOverview();
        }
      } catch (caught) {
        setError(
          caught instanceof Error
            ? caught.message
            : "Failed to invoke the selected dashboard action.",
        );
      }
    });
  }, [body, invokeAction, mode, openOverview, openTraceDetail, sessionId, subject]);

  const effectiveAgentName = routeAgentName ?? selectedAgentName;
  const selectedAgent =
    snapshot.surfaces.agents.find((agent) => agent.name === effectiveAgentName) ?? null;
  const latestTrace = snapshot.traces[0] ?? null;
  const latestArtifact = snapshot.artifacts[0] ?? null;
  const activeSection = sectionCopy[section];
  const traceWaterfallItems = React.useMemo(
    () =>
      selectedTraceDetail == null
        ? []
        : buildTraceWaterfall(selectedTraceDetail.trace as RunTraceLike),
    [selectedTraceDetail],
  );
  const selectedTraceBreadcrumb =
    selectedTraceDetail?.summary.targetId ?? (selectedTraceId.slice(0, 12) || "Trace");
  const contextValue = React.useMemo<DashboardShellContextValue>(
    () => ({
      body,
      error,
      isPending,
      isTracePending,
      latestArtifact,
      latestTrace,
      mode,
      selectedAgentName: effectiveAgentName,
      result,
      selectedAgent,
      selectedItemId: selectedWaterfallItemId,
      selectedTraceDetail,
      selectedTraceId,
      sessionId,
      snapshot,
      subject,
      traceError,
      traceItems: traceWaterfallItems,
      openAgent,
      openOverview,
      openOptimization,
      openTraceDetail,
      openTraceList,
      onBodyChange: setBody,
      onModeChange: setMode,
      onRun: runSelectedMode,
      onSelectItem: setSelectedWaterfallItemId,
      onSessionIdChange: setSessionId,
      onSubjectChange: setSubject,
    }),
    [
      body,
      error,
      isPending,
      isTracePending,
      latestArtifact,
      latestTrace,
      mode,
      effectiveAgentName,
      openAgent,
      openOptimization,
      openOverview,
      openTraceDetail,
      openTraceList,
      result,
      runSelectedMode,
      selectedAgent,
      selectedTraceDetail,
      selectedTraceId,
      selectedWaterfallItemId,
      sessionId,
      snapshot,
      subject,
      traceError,
      traceWaterfallItems,
    ],
  );

  return (
    <DashboardShellContext.Provider value={contextValue}>
      <SidebarProvider className="isolate h-dvh min-h-dvh flex-col overflow-hidden bg-background md:[--app-topbar-height:4.5rem]">
        <AppTopBar activeTab={section === "playground" ? "playground" : "dashboard"} />

        {section === "playground" ? (
          <main className="flex min-h-0 flex-1 flex-col overflow-hidden px-4 py-4 lg:px-6">
            <Outlet />
          </main>
        ) : (
          <div className="flex min-h-0 flex-1 ">
            <Sidebar
              className="md:top-(--app-topbar-height)! md:h-[calc(100svh-var(--app-topbar-height))]!"
              variant="inset"
              collapsible="icon"
            >
              <SidebarContent>
                <SidebarGroup>
                  <SidebarTrigger />
                </SidebarGroup>

                <SidebarGroup>
                  <SidebarGroupLabel>Views</SidebarGroupLabel>
                  <SidebarGroupContent>
                    <SidebarMenu>
                      {primarySectionKeys.map((key) => {
                        const value = sectionCopy[key];
                        const Icon = value.icon;
                        const openSection =
                          key === "overview"
                            ? openOverview
                            : key === "traces"
                              ? openTraceList
                              : openOptimization;

                        return (
                          <SidebarMenuItem key={key}>
                            <SidebarMenuButton
                              type="button"
                              isActive={section === key}
                              tooltip={value.label}
                              onClick={openSection}
                            >
                              <Icon variant="outlineduo" />
                              <span>{value.label}</span>
                            </SidebarMenuButton>
                          </SidebarMenuItem>
                        );
                      })}
                    </SidebarMenu>
                  </SidebarGroupContent>
                </SidebarGroup>

                <SidebarSeparator />

                <SidebarGroup>
                  <SidebarGroupLabel>Agents</SidebarGroupLabel>
                  <SidebarGroupContent>
                    <SidebarMenu>
                      {snapshot.surfaces.agents.length === 0 ? (
                        <SidebarMenuItem>
                          <SidebarMenuButton type="button" disabled>
                            <Icon.Agent variant="outlineduo" />
                            <span>No agents deployed</span>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      ) : (
                        snapshot.surfaces.agents.map((agent) => (
                          <SidebarMenuItem key={agent.name}>
                            <SidebarMenuButton
                              type="button"
                              isActive={section === "agents" && effectiveAgentName === agent.name}
                              tooltip={agent.name}
                              onClick={() => openAgent(agent.name)}
                            >
                              <Icon.Agent variant="outlineduo" />
                              <span>{agent.name}</span>
                            </SidebarMenuButton>
                          </SidebarMenuItem>
                        ))
                      )}
                    </SidebarMenu>
                  </SidebarGroupContent>
                </SidebarGroup>
              </SidebarContent>
            </Sidebar>

            <SidebarInset className="min-h-0 overflow-hidden overscroll-none">
              <header className="border-b">
                <div className="flex flex-col gap-4 px-4 py-4 lg:flex-row lg:items-start lg:justify-between lg:px-6">
                  <div className="flex items-center gap-3">
                    {section === "traces" ? (
                      <>
                        {traceViewMode === "detail" ? (
                          <Button type="button" size="icon" variant="ghost" onClick={openTraceList}>
                            <span aria-hidden="true" className="text-base">
                              ←
                            </span>
                            <span className="sr-only">Back to traces</span>
                          </Button>
                        ) : null}
                        <UIBreadcrumb>
                          <UIBreadcrumbList>
                            <UIBreadcrumbItem>
                              {traceViewMode === "detail" ? (
                                <button
                                  type="button"
                                  className="text-lg font-semibold text-foreground transition-opacity hover:opacity-80"
                                  onClick={openTraceList}
                                >
                                  Traces
                                </button>
                              ) : (
                                <UIBreadcrumbPage>Traces</UIBreadcrumbPage>
                              )}
                            </UIBreadcrumbItem>
                            {traceViewMode === "detail" ? (
                              <>
                                <UIBreadcrumbSeparator />
                                <UIBreadcrumbItem>
                                  <UIBreadcrumbPage>{selectedTraceBreadcrumb}</UIBreadcrumbPage>
                                </UIBreadcrumbItem>
                              </>
                            ) : null}
                          </UIBreadcrumbList>
                        </UIBreadcrumb>
                      </>
                    ) : section === "agents" ? (
                      <UIBreadcrumb>
                        <UIBreadcrumbList>
                          <UIBreadcrumbItem>
                            <UIBreadcrumbPage>Agents</UIBreadcrumbPage>
                          </UIBreadcrumbItem>
                          <UIBreadcrumbSeparator />
                          <UIBreadcrumbItem>
                            <UIBreadcrumbPage>
                              {routeAgentName ?? selectedAgent?.name ?? "Unknown agent"}
                            </UIBreadcrumbPage>
                          </UIBreadcrumbItem>
                        </UIBreadcrumbList>
                      </UIBreadcrumb>
                    ) : (
                      <div className="space-y-1">
                        <h1 className="text-2xl font-semibold tracking-tight text-balance">
                          {activeSection.label}
                        </h1>
                        <p className="max-w-3xl text-sm text-muted-foreground text-pretty">
                          {activeSection.description}
                        </p>
                      </div>
                    )}
                  </div>

                  <div className="flex w-full flex-wrap items-center gap-2 lg:w-auto">
                    <Badge className="lg:hidden" variant="secondary">
                      {formatTimestamp(snapshot.generatedAt)}
                    </Badge>
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={isPending}
                      onClick={refreshSnapshot}
                    >
                      <Icon.Refresh variant="outline" />
                      Refresh
                    </Button>
                  </div>
                </div>
              </header>

              <div
                className={
                  section === "traces"
                    ? "flex flex-1 flex-col overflow-hidden"
                    : "flex flex-1 flex-col gap-6 overflow-y-auto px-4 py-6 lg:px-6"
                }
              >
                <Outlet />
              </div>
            </SidebarInset>
          </div>
        )}
      </SidebarProvider>
    </DashboardShellContext.Provider>
  );
}

export function DashboardOverviewView() {
  const shell = useDashboardShell();

  return (
    <OverviewSection
      body={shell.body}
      error={shell.error}
      isPending={shell.isPending}
      latestArtifact={shell.latestArtifact}
      latestTrace={shell.latestTrace}
      mode={shell.mode}
      result={shell.result}
      selectedAgent={shell.selectedAgent}
      sessionId={shell.sessionId}
      snapshot={shell.snapshot}
      subject={shell.subject}
      onBodyChange={shell.onBodyChange}
      onModeChange={shell.onModeChange}
      onRun={shell.onRun}
      onSessionIdChange={shell.onSessionIdChange}
      onSubjectChange={shell.onSubjectChange}
    />
  );
}

export function DashboardTracesListView() {
  const shell = useDashboardShell();

  return (
    <TracesSection
      isPending={shell.isTracePending}
      selectedItemId={shell.selectedItemId}
      selectedTraceDetail={shell.selectedTraceDetail}
      selectedTraceId={shell.selectedTraceId}
      traceViewMode="list"
      traceError={shell.traceError}
      traceItems={shell.traceItems}
      traces={shell.snapshot.traces}
      onOpenTrace={shell.openTraceDetail}
      onSelectItem={shell.onSelectItem}
      onSelectTrace={shell.openTraceDetail}
    />
  );
}

export function DashboardTraceDetailView() {
  const shell = useDashboardShell();

  return (
    <TracesSection
      isPending={shell.isTracePending}
      selectedItemId={shell.selectedItemId}
      selectedTraceDetail={shell.selectedTraceDetail}
      selectedTraceId={shell.selectedTraceId}
      traceViewMode="detail"
      traceError={shell.traceError}
      traceItems={shell.traceItems}
      traces={shell.snapshot.traces}
      onOpenTrace={shell.openTraceDetail}
      onSelectItem={shell.onSelectItem}
      onSelectTrace={shell.openTraceDetail}
    />
  );
}

export function DashboardOptimizationView() {
  const shell = useDashboardShell();

  return (
    <OptimizationSection
      artifacts={shell.snapshot.artifacts}
      optimizationJobs={shell.snapshot.optimizationJobs}
    />
  );
}

export function DashboardAgentView() {
  const shell = useDashboardShell();

  return (
    <AgentSection
      agent={shell.selectedAgent}
      agentName={shell.selectedAgentName}
      snapshot={shell.snapshot}
    />
  );
}

function OverviewSection(props: {
  body: string;
  error: string | null;
  isPending: boolean;
  latestArtifact: DashboardSnapshot["artifacts"][number] | null;
  latestTrace: DashboardSnapshot["traces"][number] | null;
  mode: RunMode;
  result: DashboardActionResult | null;
  selectedAgent: DashboardSnapshot["surfaces"]["agents"][number] | null;
  sessionId: string;
  snapshot: DashboardSnapshot;
  subject: string;
  onBodyChange: (value: string) => void;
  onModeChange: (value: RunMode) => void;
  onRun: () => void;
  onSessionIdChange: (value: string) => void;
  onSubjectChange: (value: string) => void;
}) {
  return (
    <>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Agents"
          value={String(props.snapshot.counts.agents)}
          detail={`${props.snapshot.surfaces.agents.length} configured agent surfaces`}
        />
        <MetricCard
          label="Traces"
          value={String(props.snapshot.counts.traces)}
          detail={
            props.latestTrace
              ? `Latest target: ${props.latestTrace.targetId}`
              : "No traces captured yet"
          }
        />
        <MetricCard
          label="Artifacts"
          value={String(props.snapshot.counts.artifacts)}
          detail={
            props.latestArtifact
              ? `${props.latestArtifact.optimizerId} using ${props.latestArtifact.metricName}`
              : "No compiled artifacts recorded"
          }
        />
        <MetricCard
          label="Programs"
          value={String(props.snapshot.counts.programs)}
          detail={`${props.snapshot.counts.activeArtifacts} active artifacts attached`}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(320px,0.85fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Run a live surface call</CardTitle>
            <CardDescription>
              This issues a real request through the Worker-bound runtime and then refreshes the
              shared trace snapshot.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="mode">Surface</Label>
                <Select
                  value={props.mode}
                  onValueChange={(value) => props.onModeChange(value as RunMode)}
                >
                  <SelectTrigger id="mode">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(modeCopy).map(([value, copy]) => (
                      <SelectItem key={value} value={value}>
                        {copy.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-sm text-muted-foreground text-pretty">
                  {modeCopy[props.mode].description}
                </p>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="sessionId">Session ID</Label>
                  <Input
                    id="sessionId"
                    value={props.sessionId}
                    onChange={(event) => props.onSessionIdChange(event.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="subject">Subject</Label>
                  <Input
                    id="subject"
                    value={props.subject}
                    onChange={(event) => props.onSubjectChange(event.target.value)}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="body">Body</Label>
                <Textarea
                  id="body"
                  value={props.body}
                  onChange={(event) => props.onBodyChange(event.target.value)}
                />
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" disabled={props.isPending} onClick={props.onRun}>
                  Run live call
                </Button>
                {props.result?.traceId ? (
                  <Badge variant="secondary">{props.result.traceId}</Badge>
                ) : null}
                {props.error ? <Badge variant="destructive">{props.error}</Badge> : null}
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Runtime summary</CardTitle>
              <CardDescription>
                High-signal details for the runtime this dashboard is coupled to.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-3 text-sm">
                <DescriptionRow label="Runtime" value={props.snapshot.deployment.runtime} />
                <DescriptionRow
                  label="Surfaces"
                  value={`${props.snapshot.counts.agents} agents, ${props.snapshot.counts.rpc} RPC, ${props.snapshot.counts.mcp} MCP`}
                />
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Selected agent</CardTitle>
              <CardDescription>
                Agent details from the deployed Superobjective project graph.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {props.selectedAgent ? (
                <div className="space-y-4">
                  <div className="space-y-1">
                    <p className="text-base font-medium">{props.selectedAgent.name}</p>
                    <p className="text-sm text-muted-foreground text-pretty">
                      {props.selectedAgent.description ?? "No description provided."}
                    </p>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {props.selectedAgent.chatTarget ? (
                      <Badge variant="secondary">Chat enabled</Badge>
                    ) : null}
                    {(props.selectedAgent.tools ?? []).map((tool) => (
                      <Badge key={tool} variant="secondary">
                        {tool}
                      </Badge>
                    ))}
                  </div>
                </div>
              ) : (
                <EmptyState
                  label="No agent selected"
                  body="Deploy an agent surface to populate this section."
                />
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(320px,0.9fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Recent traces</CardTitle>
            <CardDescription>Latest whole-run traces captured by the live runtime.</CardDescription>
          </CardHeader>
          <CardContent>
            <TraceTable traces={props.snapshot.traces.slice(0, 8)} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Last action payload</CardTitle>
            <CardDescription>
              Response body from the latest action triggered in this dashboard.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <JsonPanel value={props.result?.payload ?? { status: "No action run yet." }} />
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function AgentSection(props: {
  agent: DashboardSnapshot["surfaces"]["agents"][number] | null;
  agentName: string;
  snapshot: DashboardSnapshot;
}) {
  if (props.agent == null) {
    return (
      <EmptyState
        label="Agent not found"
        body={
          props.agentName.length > 0
            ? `No deployed agent named "${props.agentName}" is available in this runtime snapshot.`
            : "Choose a deployed agent from the sidebar."
        }
      />
    );
  }

  const agentTraces = props.snapshot.traces.filter(
    (trace) => trace.targetKind === "agent" && trace.targetId === props.agent?.name,
  );
  const latestAgentTrace = agentTraces[0] ?? null;

  return (
    <>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Agent"
          value={props.agent.name}
          detail={props.agent.description ?? "No description provided"}
        />
        <MetricCard
          label="Recent traces"
          value={String(agentTraces.length)}
          detail={
            latestAgentTrace
              ? `Latest run ${formatTimestamp(latestAgentTrace.startedAt)}`
              : "No traces recorded for this agent yet"
          }
        />
        <MetricCard
          label="Tools"
          value={String((props.agent.tools ?? []).length)}
          detail={
            (props.agent.tools ?? []).length > 0
              ? (props.agent.tools ?? []).join(", ")
              : "No tools configured"
          }
        />
        <MetricCard
          label="Chat"
          value={props.agent.chatTarget ? "Enabled" : "Disabled"}
          detail={
            props.agent.chatTarget
              ? "Chat target exposed for this agent surface"
              : "This surface does not expose chat"
          }
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.05fr)_minmax(320px,0.95fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Agent profile</CardTitle>
            <CardDescription>
              Deployed capabilities and surface metadata for this agent.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-6">
              <div className="space-y-2">
                <p className="text-xl font-semibold tracking-tight">{props.agent.name}</p>
                <p className="text-sm text-muted-foreground text-pretty">
                  {props.agent.description ?? "No description provided."}
                </p>
              </div>

              <dl className="grid gap-3 text-sm">
                <DescriptionRow
                  label="Chat target"
                  value={props.agent.chatTarget ?? "Not exposed"}
                  mono={props.agent.chatTarget != null}
                />
                <DescriptionRow
                  label="Tool count"
                  value={String((props.agent.tools ?? []).length)}
                  valueClassName="tabular-nums"
                />
              </dl>

              <div className="space-y-3">
                <p className="text-sm font-medium">Tools</p>
                {(props.agent.tools ?? []).length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {(props.agent.tools ?? []).map((tool) => (
                      <Badge key={tool} variant="secondary">
                        {tool}
                      </Badge>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No tools configured.</p>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Latest trace</CardTitle>
            <CardDescription>
              Most recent run recorded for this specific agent surface.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {latestAgentTrace ? (
              <dl className="grid gap-3 text-sm">
                <DescriptionRow label="Run ID" value={latestAgentTrace.runId} mono />
                <DescriptionRow
                  label="Started"
                  value={formatTimestamp(latestAgentTrace.startedAt)}
                  valueClassName="tabular-nums"
                />
                <DescriptionRow label="Preview" value={latestAgentTrace.outputPreview} />
              </dl>
            ) : (
              <EmptyState
                label="No trace data"
                body="Run this agent through one of the live surfaces to populate recent activity."
              />
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Agent traces</CardTitle>
          <CardDescription>Whole-run traces filtered to this agent surface.</CardDescription>
        </CardHeader>
        <CardContent>
          <TraceTable traces={agentTraces} />
        </CardContent>
      </Card>
    </>
  );
}

function TracesSection(props: {
  isPending: boolean;
  selectedItemId: string;
  selectedTraceDetail: DashboardTraceResponse | null;
  selectedTraceId: string;
  traceViewMode: TraceViewMode;
  traceError: string | null;
  traceItems: TraceWaterfallItem[];
  traces: DashboardSnapshot["traces"];
  onOpenTrace: (value: string) => void;
  onSelectItem: (value: string) => void;
  onSelectTrace: (value: string) => void;
}) {
  if (props.traces.length === 0) {
    return (
      <EmptyState
        label="No traces yet"
        body="Run one of the live surfaces to seed the shared trace store."
      />
    );
  }

  const selectedItem =
    props.traceItems.find((item) => item.id === props.selectedItemId) ??
    props.traceItems[0] ??
    null;
  const traceTree = React.useMemo(
    () => buildTraceWaterfallTree(props.traceItems),
    [props.traceItems],
  );
  const expandableItemIds = React.useMemo(
    () => collectExpandableTraceItemIds(traceTree),
    [traceTree],
  );
  const [expandedItems, setExpandedItems] = React.useState<Record<string, boolean>>({});

  React.useEffect(() => {
    setExpandedItems(Object.fromEntries(expandableItemIds.map((itemId) => [itemId, true])));
  }, [props.selectedTraceId, expandableItemIds]);

  const toggleExpandedItem = React.useCallback((itemId: string) => {
    setExpandedItems((current) => ({
      ...current,
      [itemId]: !(current[itemId] ?? true),
    }));
  }, []);

  if (props.traceViewMode === "list") {
    return <TraceListView traces={props.traces} onOpenTrace={props.onOpenTrace} />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1.2fr)_minmax(360px,0.8fr)]">
        <div className="min-h-0 border-b lg:border-r lg:border-b-0">
          {props.traceError ? (
            <div className="p-4">
              <EmptyState label="Trace unavailable" body={props.traceError} />
            </div>
          ) : props.isPending ? (
            <div className="p-4">
              <EmptyState
                label="Loading trace"
                body="Fetching the selected trace from the live runtime."
              />
            </div>
          ) : props.selectedTraceDetail == null ? (
            <div className="p-4">
              <EmptyState label="No trace selected" body="Pick a trace to load the waterfall." />
            </div>
          ) : (
            <div className="flex h-full flex-col">
              <div className="min-h-0 flex-1">
                <ScrollArea>
                  <TraceWaterfallTree
                    activeItemId={selectedItem?.id ?? null}
                    expandedItems={expandedItems}
                    nodes={traceTree}
                    onSelectItem={props.onSelectItem}
                    onToggleItem={toggleExpandedItem}
                  />
                </ScrollArea>
              </div>
            </div>
          )}
        </div>

        <div className="min-h-0">
          <TraceDetailPane
            item={selectedItem}
            trace={props.selectedTraceDetail?.trace as RunTraceLike | undefined}
          />
        </div>
      </div>
    </div>
  );
}

function TraceListView(props: {
  traces: DashboardSnapshot["traces"];
  onOpenTrace: (value: string) => void;
}) {
  const [workflowQuery, setWorkflowQuery] = React.useState("");
  const [flowQuery, setFlowQuery] = React.useState("");
  const filteredTraces = props.traces.filter((trace) => {
    const workflowMatch =
      workflowQuery.trim().length === 0 ||
      trace.targetId.toLowerCase().includes(workflowQuery.trim().toLowerCase()) ||
      trace.targetKind.toLowerCase().includes(workflowQuery.trim().toLowerCase());
    const flowMatch =
      flowQuery.trim().length === 0 ||
      trace.runId.toLowerCase().includes(flowQuery.trim().toLowerCase()) ||
      trace.outputPreview.toLowerCase().includes(flowQuery.trim().toLowerCase());

    return workflowMatch && flowMatch;
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b px-4 py-4 lg:px-6">
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-end">
          <div className="space-y-2">
            <Label htmlFor="traceWorkflowSearch">Workflow</Label>
            <Input
              id="traceWorkflowSearch"
              placeholder="Search workflow"
              value={workflowQuery}
              onChange={(event) => setWorkflowQuery(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="traceFlowSearch">Flow</Label>
            <Input
              id="traceFlowSearch"
              placeholder="Search run or preview"
              value={flowQuery}
              onChange={(event) => setFlowQuery(event.target.value)}
            />
          </div>

          <p className="text-sm text-muted-foreground lg:justify-self-end">
            {filteredTraces.length} of {props.traces.length} traces
          </p>
        </div>
      </div>

      <div className="border-b px-4 py-3 lg:px-6">
        <div className="grid grid-cols-[minmax(0,1.05fr)_minmax(0,1.45fr)_56px_56px_88px] items-center gap-3 text-xs text-foreground/75 sm:grid-cols-[minmax(0,1.15fr)_minmax(0,1.55fr)_72px_72px_104px] sm:gap-4 sm:text-sm lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1.6fr)_96px_96px_128px]">
          <p>Workflow</p>
          <p>Flow</p>
          <p className="text-right">Handoffs</p>
          <p className="text-right">Tools</p>
          <p className="text-right">Execution time</p>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {filteredTraces.length === 0 ? (
          <div className="p-4 lg:p-6">
            <EmptyState
              label="No matching traces"
              body="Adjust the filters or run another live surface call."
            />
          </div>
        ) : (
          <ul role="list" className="divide-y">
            {filteredTraces.map((trace) => (
              <li key={trace.runId}>
                <button
                  type="button"
                  className="w-full px-4 py-3 text-left text-sm text-muted-foreground transition-colors hover:bg-muted/35 lg:px-6"
                  onClick={() => props.onOpenTrace(trace.runId)}
                >
                  <div className="grid grid-cols-[minmax(0,1.05fr)_minmax(0,1.45fr)_56px_56px_88px] items-center gap-3 sm:grid-cols-[minmax(0,1.15fr)_minmax(0,1.55fr)_72px_72px_104px] sm:gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1.6fr)_96px_96px_128px]">
                    <div className="flex min-w-0 items-center gap-3">
                      <span
                        className="size-2.5 shrink-0 rounded-full sm:size-3"
                        style={{ backgroundColor: getTraceKindColor(trace.targetKind) }}
                      />
                      <p className="truncate text-sm font-normal text-muted-foreground">
                        {formatTraceWorkflowLabel(trace)}
                      </p>
                    </div>

                    <p className="truncate text-sm font-normal text-muted-foreground">
                      {trace.targetId}
                    </p>

                    <div className="text-sm text-muted-foreground lg:text-right">
                      <span className="tabular-nums">{Math.max(0, trace.componentCount - 1)}</span>
                    </div>

                    <div className="text-sm text-muted-foreground lg:text-right">
                      <span className="tabular-nums">{trace.toolCallCount}</span>
                    </div>

                    <div className="text-sm text-muted-foreground lg:text-right">
                      <span className="tabular-nums">{formatDuration(trace.durationMs)}</span>
                    </div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </ScrollArea>
    </div>
  );
}

function TraceWaterfallTree(props: {
  activeItemId: string | null;
  expandedItems: Record<string, boolean>;
  nodes: TraceWaterfallNode[];
  onSelectItem: (itemId: string) => void;
  onToggleItem: (itemId: string) => void;
}) {
  if (props.nodes.length === 0) {
    return null;
  }

  return (
    <div className="divide-y">
      {props.nodes.map((node) => (
        <TraceWaterfallNodeRow
          key={node.item.id}
          activeItemId={props.activeItemId}
          depth={0}
          expandedItems={props.expandedItems}
          node={node}
          onSelectItem={props.onSelectItem}
          onToggleItem={props.onToggleItem}
        />
      ))}
    </div>
  );
}

function TraceWaterfallNodeRow(props: {
  activeItemId: string | null;
  depth: number;
  expandedItems: Record<string, boolean>;
  node: TraceWaterfallNode;
  onSelectItem: (itemId: string) => void;
  onToggleItem: (itemId: string) => void;
}) {
  const { item, children } = props.node;
  const hasChildren = children.length > 0;
  const isExpanded = hasChildren ? (props.expandedItems[item.id] ?? true) : true;

  return (
    <Collapsible open={isExpanded}>
      <TraceWaterfallRow
        depth={props.depth}
        hasChildren={hasChildren}
        isActive={props.activeItemId === item.id}
        isExpanded={isExpanded}
        item={item}
        onSelect={() => props.onSelectItem(item.id)}
        onToggle={hasChildren ? () => props.onToggleItem(item.id) : undefined}
      />
      {hasChildren ? (
        <CollapsibleContent>
          <div className="divide-y">
            {children.map((child) => (
              <TraceWaterfallNodeRow
                key={child.item.id}
                activeItemId={props.activeItemId}
                depth={props.depth + 1}
                expandedItems={props.expandedItems}
                node={child}
                onSelectItem={props.onSelectItem}
                onToggleItem={props.onToggleItem}
              />
            ))}
          </div>
        </CollapsibleContent>
      ) : null}
    </Collapsible>
  );
}

function TraceWaterfallRow(props: {
  depth: number;
  hasChildren: boolean;
  isActive: boolean;
  isExpanded: boolean;
  item: TraceWaterfallItem;
  onSelect: () => void;
  onToggle?: () => void;
}) {
  const tracePartStyle = getTracePartStyle(props.item);
  const TracePartIcon = getTracePartIcon(props.item);
  const indentStyle = props.depth === 0 ? undefined : { paddingLeft: `${props.depth * 1.5}rem` };

  return (
    <div>
      <div className={props.isActive ? "bg-neutral-25" : "transition-colors hover:bg-muted/40"}>
        <div className="flex items-stretch">
          <div className="flex w-10 shrink-0 items-center justify-center">
            {props.hasChildren ? (
              <button
                type="button"
                aria-label={props.isExpanded ? "Collapse trace group" : "Expand trace group"}
                className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                onClick={props.onToggle}
              >
                {props.isExpanded ? (
                  <Icon.ChevronDown className="size-4" />
                ) : (
                  <Icon.ChevronRight className="size-4" />
                )}
              </button>
            ) : (
              <span className="size-7" />
            )}
          </div>

          <button
            type="button"
            className="min-w-0 flex-1 px-4 py-4 text-left"
            onClick={props.onSelect}
          >
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_96px_minmax(220px,0.45fr)] lg:items-center">
              <div className="flex min-w-0 items-center gap-3" style={indentStyle}>
                <span
                  className="flex size-6 shrink-0 items-center justify-center rounded-md"
                  style={{
                    backgroundColor:
                      props.item.status === "error"
                        ? "color-mix(in oklab, var(--destructive) 12%, var(--background))"
                        : `color-mix(in oklab, ${tracePartStyle.fill} 12%, var(--background))`,
                    color:
                      props.item.status === "error" ? "var(--destructive)" : tracePartStyle.fill,
                  }}
                >
                  <TracePartIcon className="size-3.5" variant="outline" />
                </span>
                <div className="flex min-w-0 items-center overflow-hidden">
                  <p className="truncate text-base font-medium">{props.item.label}</p>
                </div>
              </div>

              <p className="text-right text-sm text-muted-foreground tabular-nums">
                {props.item.durationLabel}
              </p>

              <div className="w-full">
                <TraceBar
                  offsetPercent={props.item.offsetPercent}
                  status={props.item.status}
                  widthPercent={props.item.widthPercent}
                  style={tracePartStyle}
                />
              </div>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}

function TraceBar(props: {
  offsetPercent: number;
  status: "ok" | "error";
  widthPercent: number;
  style: {
    fill: string;
    track: string;
  };
}) {
  return (
    <div className="h-3 rounded-sm bg-neutral-50 p-0.5">
      <div className="relative h-full w-full rounded-sm">
        <div
          className={
            props.status === "error"
              ? "absolute inset-y-0 rounded-[4px] bg-destructive/70"
              : "absolute inset-y-0 rounded-[4px]"
          }
          style={{
            left: `${props.offsetPercent}%`,
            width: `${props.widthPercent}%`,
            ...(props.status === "error" ? {} : { backgroundColor: props.style.fill }),
          }}
        />
      </div>
    </div>
  );
}

function TraceDetailPane(props: { item: TraceWaterfallItem | null; trace?: RunTraceLike }) {
  if (props.trace == null || props.item == null) {
    return (
      <div className="p-4">
        <EmptyState label="No trace content" body="Select a trace row to inspect its details." />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border/70 px-5 py-5">
        <div className="space-y-3">
          <div className="space-y-1">
            <h3 className="text-[1.375rem] font-semibold tracking-tight text-balance">
              {props.item.label}
            </h3>
            <p className="text-sm text-muted-foreground text-pretty">{props.item.subtitle}</p>
          </div>

          <div className="flex flex-wrap gap-2">
            <TraceMetaBadge
              tone={props.item.status === "error" ? "error" : "kind"}
              style={props.item.status === "error" ? undefined : getTracePartBadgeStyle(props.item)}
              value={
                props.item.kind === "run"
                  ? "Run details"
                  : props.item.kind === "tool-call"
                    ? "Tool call details"
                    : "Component details"
              }
            />
            <TraceMetaBadge value={props.item.durationLabel} tabular />
            <TraceMetaBadge
              value={
                props.item.kind === "run"
                  ? abbreviateIdentifier(props.trace.runId)
                  : props.item.kind === "tool-call"
                    ? abbreviateIdentifier(
                        `${props.item.toolCall.toolName}:${props.item.toolCall.startedAt ?? "pending"}`,
                      )
                    : abbreviateIdentifier(props.item.component.componentId)
              }
              mono
            />
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1">
        <ScrollArea>
          <div className="space-y-8 px-5 py-5">
            <section className="space-y-4">
              <h4 className="text-[0.95rem] font-semibold tracking-tight">Properties</h4>
              <dl className="divide-y divide-border/60 border-y border-border/60">
                <DescriptionRow label="Run ID" value={props.trace.runId} mono />
                <DescriptionRow
                  label="Started"
                  value={formatTimestamp(props.trace.startedAt)}
                  valueClassName="tabular-nums"
                />
                <DescriptionRow
                  label="Duration"
                  value={props.item.durationLabel}
                  valueClassName="tabular-nums"
                />
                <DescriptionRow
                  label="Components"
                  value={String(props.trace.components.length)}
                  valueClassName="tabular-nums"
                />
                <DescriptionRow
                  label="Model calls"
                  value={String(props.trace.modelCalls.length)}
                  valueClassName="tabular-nums"
                />
                <DescriptionRow
                  label="Tool calls"
                  value={String(props.trace.toolCalls.length)}
                  valueClassName="tabular-nums"
                />
              </dl>
            </section>

            {props.item.kind === "component" ? (
              <ComponentTracePanel component={props.item.component} trace={props.trace} />
            ) : props.item.kind === "tool-call" ? (
              <ToolCallPanel toolCall={props.item.toolCall} />
            ) : (
              <RunTracePanel trace={props.trace} />
            )}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}

function TraceMetaBadge(props: {
  value: string;
  mono?: boolean;
  tabular?: boolean;
  tone?: "default" | "accent" | "error" | "kind";
  style?: React.CSSProperties;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-3 py-1.5 text-sm text-muted-foreground",
        props.tone === "accent" &&
          "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900/70 dark:bg-sky-950/40 dark:text-sky-200",
        props.tone === "kind" && "border-transparent",
        props.tone === "error" &&
          "border-destructive/20 bg-destructive/8 text-destructive dark:border-destructive/30 dark:bg-destructive/15",
        props.mono && "font-mono text-[0.8125rem]",
        props.tabular && "tabular-nums",
      )}
      style={props.style}
    >
      {props.value}
    </span>
  );
}

function RunTracePanel(props: { trace: RunTraceLike }) {
  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <h4 className="text-[0.95rem] font-semibold tracking-tight">Input</h4>
        <JsonPanel value={props.trace.input} />
      </section>

      <section className="space-y-4">
        <h4 className="text-[0.95rem] font-semibold tracking-tight">Output</h4>
        <JsonPanel value={props.trace.output ?? { status: "No output recorded." }} />
      </section>

      <section className="space-y-4">
        <h4 className="text-[0.95rem] font-semibold tracking-tight">Calls</h4>
        <div className="space-y-5">
          <CallSummaryList
            items={props.trace.modelCalls.map((call, index) => ({
              id: `model:${index}`,
              label: `${call.provider} / ${call.model}`,
              secondary:
                call.latencyMs == null
                  ? "Model call"
                  : `${formatDuration(call.latencyMs)} · model call`,
            }))}
            title="Model calls"
          />
          <CallSummaryList
            items={props.trace.toolCalls.map((call, index) => ({
              id: `tool:${index}`,
              label: call.toolName,
              secondary:
                call.latencyMs == null
                  ? "Tool call"
                  : `${formatMeasuredDuration(call.latencyMs)} · tool call`,
            }))}
            title="Tool calls"
          />
        </div>
      </section>

      <section className="space-y-4">
        <h4 className="text-[0.95rem] font-semibold tracking-tight">Model call details</h4>
        {props.trace.modelCalls.length === 0 ? (
          <p className="text-sm text-muted-foreground">No model calls recorded.</p>
        ) : (
          <div className="space-y-5">
            {props.trace.modelCalls.map((call, index) => (
              <ModelCallPanel key={`model-call:${index}`} call={call} index={index} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function ComponentTracePanel(props: { component: ComponentTraceLike; trace: RunTraceLike }) {
  const promptMessages = props.component.prompt?.messages ?? [];

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <h4 className="text-[0.95rem] font-semibold tracking-tight">Component</h4>
        <dl className="divide-y divide-border/60 border-y border-border/60">
          <DescriptionRow label="Component ID" value={props.component.componentId} mono />
          <DescriptionRow label="Kind" value={props.component.componentKind} />
          <DescriptionRow
            label="Candidate"
            value={
              props.component.candidate == null
                ? "No candidate override"
                : `${props.component.candidate.paths.length} paths · ${props.component.candidate.hash}`
            }
            mono={props.component.candidate != null}
          />
          <DescriptionRow
            label="Prompt messages"
            value={String(promptMessages.length)}
            valueClassName="tabular-nums"
          />
        </dl>
      </section>

      <section className="space-y-4">
        <h4 className="text-[0.95rem] font-semibold tracking-tight">Input</h4>
        <JsonPanel value={props.component.input} />
      </section>

      <section className="space-y-4">
        <h4 className="text-[0.95rem] font-semibold tracking-tight">Output</h4>
        <JsonPanel value={props.component.output ?? { status: "No output recorded." }} />
      </section>

      {promptMessages.length > 0 ? (
        <section className="space-y-4">
          <h4 className="text-[0.95rem] font-semibold tracking-tight">Prompt</h4>
          <div className="space-y-3">
            {promptMessages.map((message, index) => (
              <div
                key={`${message.role}:${index}`}
                className="rounded-2xl border border-border/70 bg-background/70 p-4"
              >
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary">{message.role}</Badge>
                    {"name" in message &&
                    typeof message.name === "string" &&
                    message.name.length > 0 ? (
                      <Badge variant="secondary">{message.name}</Badge>
                    ) : null}
                  </div>
                  <pre className="overflow-x-auto font-mono text-[0.8125rem] leading-6 text-muted-foreground whitespace-pre-wrap break-words">
                    {formatUnknown(message.content)}
                  </pre>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {props.component.prompt?.outputJsonSchema != null ? (
        <section className="space-y-4">
          <h4 className="text-[0.95rem] font-semibold tracking-tight">Structured output schema</h4>
          <JsonPanel value={props.component.prompt.outputJsonSchema} />
        </section>
      ) : null}

      {props.component.stdout.length > 0 || props.component.stderr?.length ? (
        <section className="space-y-4">
          <h4 className="text-[0.95rem] font-semibold tracking-tight">Logs</h4>
          <JsonPanel
            value={{
              stdout: props.component.stdout,
              stderr: props.component.stderr ?? "",
            }}
          />
        </section>
      ) : null}

      <section className="space-y-4">
        <h4 className="text-[0.95rem] font-semibold tracking-tight">Run context</h4>
        <dl className="divide-y divide-border/60 border-y border-border/60">
          <DescriptionRow
            label="Model calls"
            value={String(props.trace.modelCalls.length)}
            valueClassName="tabular-nums"
          />
          <DescriptionRow
            label="Tool calls"
            value={String(props.trace.toolCalls.length)}
            valueClassName="tabular-nums"
          />
        </dl>
      </section>
    </div>
  );
}

function ToolCallPanel(props: { toolCall: ToolCallTraceLike }) {
  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h4 className="text-base font-medium">Tool call</h4>
        <dl className="grid gap-3 text-sm">
          <DescriptionRow label="Tool" value={props.toolCall.toolName} />
          <DescriptionRow
            label="Duration"
            value={formatMeasuredDuration(props.toolCall.latencyMs)}
          />
          <DescriptionRow
            label="Started"
            value={
              props.toolCall.startedAt == null ? "n/a" : formatTimestamp(props.toolCall.startedAt)
            }
          />
          <DescriptionRow
            label="Status"
            value={props.toolCall.error == null ? "Completed" : "Error"}
          />
        </dl>
      </section>

      <section className="space-y-3">
        <h4 className="text-base font-medium">Input</h4>
        <JsonPanel value={props.toolCall.input} />
      </section>

      <section className="space-y-3">
        <h4 className="text-base font-medium">Output</h4>
        <JsonPanel
          value={
            props.toolCall.error == null
              ? (props.toolCall.output ?? { status: "No output recorded." })
              : {
                  error: props.toolCall.error,
                }
          }
        />
      </section>

      {props.toolCall.metadata != null ? (
        <section className="space-y-3">
          <h4 className="text-base font-medium">Metadata</h4>
          <JsonPanel value={props.toolCall.metadata} />
        </section>
      ) : null}
    </div>
  );
}

function ModelCallPanel(props: { call: RunTraceLike["modelCalls"][number]; index: number }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border/70 bg-background/80">
      <div className="border-b border-border/60 bg-muted/20 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-medium">
            Model call {props.index + 1}: {props.call.provider} / {props.call.model}
          </p>
          {props.call.finishReason ? <Badge>{props.call.finishReason}</Badge> : null}
        </div>
      </div>

      <div className="space-y-5 px-4 py-4">
        <dl className="divide-y divide-border/60 border-y border-border/60">
          <DescriptionRow
            label="Latency"
            value={props.call.latencyMs == null ? "n/a" : formatDuration(props.call.latencyMs)}
            valueClassName="tabular-nums"
          />
          <DescriptionRow
            label="Prompt messages"
            value={String(props.call.messages.length)}
            valueClassName="tabular-nums"
          />
          <DescriptionRow
            label="Tokens"
            value={formatTokenUsage(props.call.tokenUsage)}
            valueClassName="tabular-nums"
          />
          <DescriptionRow
            label="Structured schema"
            value={props.call.outputJsonSchema == null ? "Not recorded" : "Recorded"}
          />
        </dl>

        <div className="space-y-4">
          <p className="text-[0.95rem] font-semibold tracking-tight">Prompt messages</p>
          <JsonPanel value={props.call.messages} />
        </div>

        {props.call.outputJsonSchema != null ? (
          <div className="space-y-4">
            <p className="text-[0.95rem] font-semibold tracking-tight">Output schema</p>
            <JsonPanel value={props.call.outputJsonSchema} />
          </div>
        ) : null}

        {props.call.rawResponse !== undefined ? (
          <div className="space-y-4">
            <p className="text-[0.95rem] font-semibold tracking-tight">Raw response</p>
            <JsonPanel value={props.call.rawResponse} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function CallSummaryList(props: {
  items: Array<{
    id: string;
    label: string;
    secondary: string;
  }>;
  title: string;
}) {
  if (props.items.length === 0) {
    return (
      <div className="space-y-2">
        <p className="text-[0.95rem] font-semibold tracking-tight">{props.title}</p>
        <p className="text-sm text-muted-foreground">None recorded.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-[0.95rem] font-semibold tracking-tight">{props.title}</p>
      <ul
        role="list"
        className="overflow-hidden rounded-2xl border border-border/70 bg-background/80"
      >
        {props.items.map((item) => (
          <li
            key={item.id}
            className="space-y-1 border-t border-border/60 px-4 py-3 first:border-t-0"
          >
            <p className="text-sm font-medium">{item.label}</p>
            <p className="text-sm text-muted-foreground">{item.secondary}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function OptimizationSection(props: {
  artifacts: DashboardSnapshot["artifacts"];
  optimizationJobs: DashboardSnapshot["optimizationJobs"];
}) {
  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Optimization jobs</CardTitle>
          <CardDescription>
            Aggregated optimization runs inferred from artifact history.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <OptimizationJobsTable jobs={props.optimizationJobs} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Compiled artifacts</CardTitle>
          <CardDescription>
            Artifact history attached to deployed Superobjective targets.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ArtifactTable artifacts={props.artifacts} />
        </CardContent>
      </Card>
    </div>
  );
}

function MetricCard(props: { label: string; value: string; detail: string }) {
  return (
    <Card size="sm">
      <CardContent>
        <div className="space-y-2">
          <p className="truncate text-sm text-muted-foreground">{props.label}</p>
          <p className="text-3xl font-semibold tracking-tight tabular-nums">{props.value}</p>
          <p className="text-sm text-muted-foreground text-pretty">{props.detail}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function DescriptionRow(props: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  valueClassName?: string;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] items-start gap-4 py-3 sm:gap-6">
      <dt className="text-sm text-muted-foreground">{props.label}</dt>
      <dd
        className={cn(
          "min-w-0 text-right text-sm font-medium text-pretty text-foreground",
          props.mono && "font-mono text-[0.8125rem]",
          props.valueClassName,
        )}
      >
        {props.value}
      </dd>
    </div>
  );
}

function TraceTable(props: { traces: DashboardSnapshot["traces"] }) {
  if (props.traces.length === 0) {
    return (
      <EmptyState
        label="No traces yet"
        body="Run one of the live surfaces to seed the shared trace store."
      />
    );
  }

  return (
    <ScrollArea>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Target</TableHead>
            <TableHead>Started</TableHead>
            <TableHead>Counts</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Preview</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {props.traces.map((trace) => (
            <TableRow key={trace.runId}>
              <TableCell>
                <div className="space-y-1">
                  <p className="font-medium">{trace.targetId}</p>
                  <p className="text-sm text-muted-foreground">
                    {trace.targetKind} · {trace.runId}
                  </p>
                </div>
              </TableCell>
              <TableCell>{formatTimestamp(trace.startedAt)}</TableCell>
              <TableCell>
                {trace.componentCount} components · {trace.modelCallCount} model ·{" "}
                {trace.toolCallCount} tool
              </TableCell>
              <TableCell>
                <StatusBadge status={trace.error ? "error" : "ok"}>
                  {trace.error ?? "OK"}
                </StatusBadge>
              </TableCell>
              <TableCell>
                <div className="space-y-1 text-sm text-muted-foreground">
                  <p>
                    <span className="font-medium text-foreground">In:</span> {trace.inputPreview}
                  </p>
                  <p>
                    <span className="font-medium text-foreground">Out:</span> {trace.outputPreview}
                  </p>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </ScrollArea>
  );
}

function OptimizationJobsTable(props: { jobs: DashboardSnapshot["optimizationJobs"] }) {
  if (props.jobs.length === 0) {
    return (
      <EmptyState
        label="No optimization jobs"
        body="Optimization jobs appear once compiled artifacts are written to the shared store."
      />
    );
  }

  return (
    <ScrollArea>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Target</TableHead>
            <TableHead>Optimizer</TableHead>
            <TableHead>Artifacts</TableHead>
            <TableHead>Best scores</TableHead>
            <TableHead>Latest artifact</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {props.jobs.map((job) => (
            <TableRow key={job.jobId}>
              <TableCell>
                <div className="space-y-1">
                  <p className="font-medium">{job.targetId}</p>
                  <p className="text-sm text-muted-foreground">{job.targetKind}</p>
                </div>
              </TableCell>
              <TableCell>{job.optimizerId}</TableCell>
              <TableCell>{job.artifactCount}</TableCell>
              <TableCell>
                train {formatScore(job.bestTrainScore)} · val {formatScore(job.bestValScore)}
              </TableCell>
              <TableCell>
                <div className="space-y-1">
                  <p className="font-medium">{job.latestArtifactId}</p>
                  <p className="text-sm text-muted-foreground">
                    {formatTimestamp(job.latestCreatedAt)}
                  </p>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </ScrollArea>
  );
}

function ArtifactTable(props: { artifacts: DashboardSnapshot["artifacts"] }) {
  if (props.artifacts.length === 0) {
    return (
      <EmptyState
        label="No artifacts recorded"
        body="Compile a module and write the result to the shared artifact store to populate this table."
      />
    );
  }

  return (
    <ScrollArea>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Artifact</TableHead>
            <TableHead>Target</TableHead>
            <TableHead>Metric</TableHead>
            <TableHead>Scores</TableHead>
            <TableHead>Frontier</TableHead>
            <TableHead>Created</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {props.artifacts.map((artifact) => (
            <TableRow key={artifact.id}>
              <TableCell>
                <div className="space-y-1">
                  <p className="font-medium">{artifact.id}</p>
                  <p className="text-sm text-muted-foreground">{artifact.optimizerId}</p>
                </div>
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap items-center gap-2">
                  <span>{artifact.targetId}</span>
                  <Badge variant="secondary">{artifact.targetKind}</Badge>
                  {artifact.isActive ? <Badge>active</Badge> : null}
                </div>
              </TableCell>
              <TableCell>{artifact.metricName}</TableCell>
              <TableCell>
                train {formatScore(artifact.trainScore)} · val {formatScore(artifact.valScore)}
              </TableCell>
              <TableCell>{artifact.frontierSize}</TableCell>
              <TableCell>{formatTimestamp(artifact.createdAt)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </ScrollArea>
  );
}

function JsonPanel(props: { value: unknown }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border/70 bg-background/80">
      <div className="max-h-[32rem]">
        <ScrollArea>
          <pre className="overflow-x-auto px-4 py-4 font-mono text-[0.8125rem] leading-6 text-muted-foreground">
            {JSON.stringify(props.value, null, 2)}
          </pre>
        </ScrollArea>
      </div>
    </div>
  );
}

function EmptyState(props: { label: string; body: string }) {
  return (
    <div className="rounded-lg border border-dashed p-6">
      <div className="space-y-2 text-center">
        <p className="font-medium">{props.label}</p>
        <p className="text-sm text-muted-foreground text-pretty">{props.body}</p>
      </div>
    </div>
  );
}

function StatusBadge(props: { status: "ok" | "error"; children: React.ReactNode }) {
  return (
    <Badge variant={props.status === "ok" ? "secondary" : "destructive"}>{props.children}</Badge>
  );
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function abbreviateIdentifier(value: string, maxLength = 30): string {
  if (value.length <= maxLength) {
    return value;
  }

  const visibleChars = Math.max(6, Math.floor((maxLength - 1) / 2));
  return `${value.slice(0, visibleChars)}…${value.slice(-visibleChars)}`;
}

function formatScore(value: number | null | undefined): string {
  return value == null ? "n/a" : value.toFixed(2);
}

function formatTokenUsage(
  value:
    | {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
      }
    | undefined,
): string {
  if (value == null) {
    return "n/a";
  }

  const parts = [
    value.inputTokens != null ? `in ${value.inputTokens}` : null,
    value.outputTokens != null ? `out ${value.outputTokens}` : null,
    value.totalTokens != null ? `total ${value.totalTokens}` : null,
  ].filter((part): part is string => part != null);

  return parts.length > 0 ? parts.join(" · ") : "n/a";
}

function formatTraceWorkflowLabel(trace: DashboardSnapshot["traces"][number]): string {
  switch (trace.targetKind) {
    case "agent":
      return "Agent trace";
    case "rpc":
      return "RPC trace";
    case "predict":
      return "Predict trace";
    case "program":
      return "Program trace";
    case "mcp":
      return "MCP trace";
    default:
      return "Trace";
  }
}

function formatDuration(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) {
    return "0 ms";
  }

  return `${Math.max(0, Math.round(value)).toLocaleString("en-US")} ms`;
}

function formatMeasuredDuration(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) {
    return "0 ms";
  }

  if (value <= 0) {
    return "<1 ms";
  }

  return formatDuration(value);
}

function formatUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value == null) {
    return "";
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function getTracePartKey(item: TraceWaterfallItem): string {
  if (item.kind === "run") {
    return item.run.targetKind;
  }

  if (item.kind === "tool-call") {
    return "tool";
  }

  return item.component.componentKind;
}

function getTracePartIcon(
  item: TraceWaterfallItem,
): React.ComponentType<React.ComponentProps<typeof Icon.Agent>> {
  switch (getTracePartKey(item)) {
    case "predict":
      return Icon.Sparkle;
    case "tool":
      return Icon.Wrench;
    case "program":
      return Icon.Globe;
    case "agent":
      return Icon.Agent;
    case "rpc":
      return Icon.Message;
    case "mcp":
      return Icon.Terminal;
    case "adapter":
      return Icon.Gear3;
    default:
      return Icon.Link;
  }
}

function getTraceKindColor(kind: string): string {
  switch (kind) {
    case "predict":
      return "var(--brand-purple)";
    case "tool":
      return "var(--brand-green)";
    case "program":
      return "var(--brand-cyan)";
    case "agent":
      return "var(--brand-blue)";
    case "rpc":
      return "var(--brand-orange)";
    case "mcp":
      return "var(--brand-pink)";
    case "adapter":
      return "var(--brand-yellow)";
    default:
      return "var(--brand-teal)";
  }
}

function getTracePartFillColor(item: TraceWaterfallItem): string {
  return getTraceKindColor(getTracePartKey(item));
}

function getTracePartStyle(item: TraceWaterfallItem): {
  fill: string;
  track: string;
} {
  const fill = getTracePartFillColor(item);

  return {
    fill,
    track: `color-mix(in oklab, ${fill} 18%, var(--background))`,
  };
}

function getTracePartBadgeStyle(item: TraceWaterfallItem): React.CSSProperties {
  const fill = getTracePartFillColor(item);

  return {
    backgroundColor: `color-mix(in oklab, ${fill} 12%, var(--background))`,
    color: `color-mix(in oklab, ${fill} 76%, var(--foreground))`,
  };
}

function buildTraceWaterfallTree(items: TraceWaterfallItem[]): TraceWaterfallNode[] {
  if (items.length === 0) {
    return [];
  }

  const nodesById = new Map<string, TraceWaterfallNode>();
  const componentNodesByComponentId = new Map<string, TraceWaterfallNode>();

  for (const item of items) {
    const node: TraceWaterfallNode = {
      item,
      children: [],
    };

    nodesById.set(item.id, node);

    if (item.kind === "component") {
      componentNodesByComponentId.set(item.component.componentId, node);
    }
  }

  const rootItem = items[0];
  const rootNode = nodesById.get(rootItem.id);

  if (rootNode == null) {
    return [];
  }

  for (const item of items.slice(1)) {
    const parentId = getTraceWaterfallParentId({
      componentNodesByComponentId,
      items,
      item,
      rootId: rootItem.id,
    });
    const parentNode = nodesById.get(parentId) ?? rootNode;
    const childNode = nodesById.get(item.id);

    if (childNode == null) {
      continue;
    }

    parentNode.children.push(childNode);
  }

  for (const node of nodesById.values()) {
    node.children.sort(
      (left, right) =>
        Date.parse(getTraceWaterfallItemStartedAt(left.item)) -
        Date.parse(getTraceWaterfallItemStartedAt(right.item)),
    );
  }

  return [rootNode];
}

function collectExpandableTraceItemIds(nodes: TraceWaterfallNode[]): string[] {
  const ids: string[] = [];

  function visit(node: TraceWaterfallNode) {
    if (node.children.length > 0) {
      ids.push(node.item.id);
    }

    for (const child of node.children) {
      visit(child);
    }
  }

  for (const node of nodes) {
    visit(node);
  }

  return ids;
}

function getTraceWaterfallParentId(args: {
  componentNodesByComponentId: Map<string, TraceWaterfallNode>;
  item: TraceWaterfallItem;
  items: TraceWaterfallItem[];
  rootId: string;
}): string {
  const { componentNodesByComponentId, item, items, rootId } = args;

  if (item.kind === "tool-call") {
    const callerComponentId = getToolCallerComponentId(item.toolCall);

    if (callerComponentId != null) {
      const callerNode = componentNodesByComponentId.get(callerComponentId);

      if (callerNode != null) {
        return callerNode.item.id;
      }
    }

    return rootId;
  }

  if (item.kind === "component") {
    return findNearestContainingComponentItem(item, items)?.id ?? rootId;
  }

  return rootId;
}

function findNearestContainingComponentItem(
  item: Extract<TraceWaterfallItem, { kind: "component" }>,
  items: TraceWaterfallItem[],
): Extract<TraceWaterfallItem, { kind: "component" }> | null {
  const itemStartedAt = Date.parse(item.component.startedAt);
  const itemEndedAt = Date.parse(item.component.endedAt ?? item.component.startedAt);

  let nearestParent: Extract<TraceWaterfallItem, { kind: "component" }> | null = null;
  let nearestParentDuration = Number.POSITIVE_INFINITY;

  for (const candidate of items) {
    if (candidate.kind !== "component" || candidate.id === item.id) {
      continue;
    }

    const candidateStartedAt = Date.parse(candidate.component.startedAt);
    const candidateEndedAt = Date.parse(
      candidate.component.endedAt ?? candidate.component.startedAt,
    );

    if (candidateStartedAt <= itemStartedAt && candidateEndedAt >= itemEndedAt) {
      const candidateDuration = Math.max(0, candidateEndedAt - candidateStartedAt);

      if (candidateDuration < nearestParentDuration) {
        nearestParent = candidate;
        nearestParentDuration = candidateDuration;
      }
    }
  }

  return nearestParent;
}

function getTraceWaterfallItemStartedAt(item: TraceWaterfallItem): string {
  if (item.kind === "run") {
    return item.run.startedAt;
  }

  if (item.kind === "tool-call") {
    return item.toolCall.startedAt ?? item.run.startedAt;
  }

  return item.component.startedAt;
}

function getToolCallerComponentId(toolCall: ToolCallTraceLike): string | null {
  const value = toolCall.metadata?.callerComponentId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function buildTraceWaterfall(trace: RunTraceLike): TraceWaterfallItem[] {
  const runDurationMs = getDurationMs(trace.startedAt, trace.endedAt);
  const totalDurationMs = Math.max(runDurationMs, 1);
  const components = [...trace.components].sort(
    (left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt),
  );

  const items: TraceWaterfallItem[] = [
    {
      id: `run:${trace.runId}`,
      kind: "run",
      label: trace.targetId,
      subtitle: `${trace.targetKind} · ${trace.runId}`,
      durationMs: runDurationMs,
      durationLabel: formatDuration(runDurationMs),
      offsetPercent: 0,
      widthPercent: 100,
      status: trace.error == null ? "ok" : "error",
      run: trace,
    },
  ];

  const timelineEntries = [
    ...components
      .filter((component) => !isRootTraceComponent(trace, component))
      .map((component) => ({
        type: "component" as const,
        startedAt: component.startedAt,
        component,
      })),
    ...trace.toolCalls.map((toolCall, index) => ({
      type: "tool-call" as const,
      startedAt: toolCall.startedAt ?? trace.startedAt,
      toolCall,
      index,
    })),
  ].sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt));

  for (const entry of timelineEntries) {
    if (entry.type === "component") {
      const rawDurationMs = getDurationMs(entry.component.startedAt, entry.component.endedAt);
      const durationMs = Math.max(rawDurationMs, 1);
      const offsetMs = Math.max(
        0,
        Date.parse(entry.component.startedAt) - Date.parse(trace.startedAt),
      );

      items.push({
        id: `component:${entry.component.componentId}:${entry.component.startedAt}`,
        kind: "component",
        label: entry.component.componentId,
        subtitle: entry.component.componentKind,
        durationMs: rawDurationMs,
        durationLabel: formatMeasuredDuration(rawDurationMs),
        offsetPercent: clampPercent((offsetMs / totalDurationMs) * 100),
        widthPercent: Math.max(clampPercent((durationMs / totalDurationMs) * 100), 3),
        status: entry.component.error == null ? "ok" : "error",
        component: entry.component,
        run: trace,
      });
      continue;
    }

    const startedAt = entry.toolCall.startedAt ?? trace.startedAt;
    const rawDurationMs =
      getDurationMs(startedAt, entry.toolCall.endedAt) || entry.toolCall.latencyMs || 0;
    const durationMs = Math.max(rawDurationMs, 1);
    const offsetMs = Math.max(0, Date.parse(startedAt) - Date.parse(trace.startedAt));

    items.push({
      id: `tool:${entry.index}:${entry.toolCall.toolName}:${startedAt}`,
      kind: "tool-call",
      label: entry.toolCall.toolName,
      subtitle: "tool call",
      durationMs: rawDurationMs,
      durationLabel: formatMeasuredDuration(rawDurationMs),
      offsetPercent: clampPercent((offsetMs / totalDurationMs) * 100),
      widthPercent: Math.max(clampPercent((durationMs / totalDurationMs) * 100), 1.5),
      status: entry.toolCall.error == null ? "ok" : "error",
      toolCall: entry.toolCall,
      run: trace,
    });
  }

  return items;
}

function isRootTraceComponent(trace: RunTraceLike, component: ComponentTraceLike): boolean {
  return (
    trace.targetKind === component.componentKind &&
    trace.targetId === component.componentId &&
    trace.startedAt === component.startedAt &&
    trace.endedAt === component.endedAt
  );
}

function getDurationMs(startedAt: string, endedAt?: string): number {
  if (endedAt == null) {
    return 0;
  }

  return Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}
