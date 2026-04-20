"use client";

import * as React from "react";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";

import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "#/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "#/components/ai-elements/message";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "#/components/ai-elements/prompt-input";
import { Badge } from "#/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "#/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select";
import { cn } from "#/lib/utils";
import type { DashboardSnapshot } from "#/lib/dashboard.functions";
import { runPlaygroundTurn, type PlaygroundTurnResult } from "#/lib/playground.functions";

type PlaygroundMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  traceId?: string;
};

function createPlaygroundSessionId(agentName: string) {
  return `${agentName}-${Math.random().toString(36).slice(2, 10)}`;
}

function buildUserMessage(value: string): PlaygroundMessage {
  return {
    id: crypto.randomUUID(),
    role: "user",
    text: value.trim(),
  };
}

function buildAssistantMessage(result: PlaygroundTurnResult): PlaygroundMessage {
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    text: result.message,
    traceId: result.traceId,
  };
}

export function PlaygroundChat(props: { initialSnapshot: DashboardSnapshot }) {
  const invokeTurn = useServerFn(runPlaygroundTurn);
  const initialAgents = React.useMemo(
    () => props.initialSnapshot.surfaces.agents.filter((agent) => agent.chatTarget != null),
    [props.initialSnapshot.surfaces.agents],
  );
  const [snapshot, setSnapshot] = React.useState(props.initialSnapshot);
  const [selectedAgentName, setSelectedAgentName] = React.useState(
    initialAgents.find((agent) => agent.name === "support")?.name ?? initialAgents[0]?.name ?? "",
  );
  const [sessionId, setSessionId] = React.useState(
    createPlaygroundSessionId(
      initialAgents.find((agent) => agent.name === "support")?.name ??
        initialAgents[0]?.name ??
        "session",
    ),
  );
  const [composerValue, setComposerValue] = React.useState("");
  const [messages, setMessages] = React.useState<PlaygroundMessage[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<"idle" | "submitted" | "error">("idle");

  React.useEffect(() => {
    setSnapshot(props.initialSnapshot);
  }, [props.initialSnapshot]);

  const chatAgents = React.useMemo(
    () => snapshot.surfaces.agents.filter((agent) => agent.chatTarget != null),
    [snapshot.surfaces.agents],
  );
  const selectedAgent =
    chatAgents.find((agent) => agent.name === selectedAgentName) ?? chatAgents[0] ?? null;

  React.useEffect(() => {
    if (selectedAgent == null) {
      return;
    }

    setSelectedAgentName(selectedAgent.name);
  }, [selectedAgent]);

  const submitMessage = React.useCallback(
    async (message: string) => {
      const trimmed = message.trim();

      if (trimmed.length === 0 || selectedAgent == null) {
        return;
      }

      setMessages((current) => [...current, buildUserMessage(trimmed)]);
      setComposerValue("");
      setError(null);
      setStatus("submitted");

      try {
        const result = await invokeTurn({
          data: {
            agentName: selectedAgent.name,
            sessionId,
            message: trimmed,
          },
        });

        setMessages((current) => [...current, buildAssistantMessage(result)]);
        setSnapshot(result.snapshot);
        setStatus("idle");
      } catch (caught) {
        setStatus("error");
        setError(caught instanceof Error ? caught.message : "The playground request failed.");
      }
    },
    [invokeTurn, selectedAgent, sessionId],
  );

  const handleSubmit = React.useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      await submitMessage(composerValue);
    },
    [composerValue, submitMessage],
  );

  if (chatAgents.length === 0) {
    return (
      <Card className="rounded-xl border-border bg-base-white shadow-none">
        <CardHeader>
          <CardTitle>Playground unavailable</CardTitle>
          <CardDescription>
            No deployed agents currently expose a chat target in this runtime snapshot.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <section className="flex h-full min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-base-white">
      {messages.length > 0 ? (
        <Conversation>
          <ConversationContent className="px-5 py-6 md:px-8">
            {messages.map((message) => (
              <Message key={message.id} from={message.role}>
                <MessageContent
                  className={cn(
                    "shadow-none",
                    message.role === "user"
                      ? "border-neutral-950 bg-neutral-950 text-base-white"
                      : "border-border/70 bg-base-white",
                  )}
                >
                  <MessageResponse
                    className={cn(message.role === "user" ? "text-base-white" : "text-foreground")}
                  >
                    {message.text}
                  </MessageResponse>

                  {message.traceId ? (
                    <div className="mt-3">
                      <Link
                        className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                        params={{ traceId: message.traceId }}
                        to="/traces/$traceId"
                      >
                        Open trace
                      </Link>
                    </div>
                  ) : null}
                </MessageContent>
              </Message>
            ))}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center px-4 py-8">
          <div className="w-full max-w-3xl">
            <PromptComposer
              composerValue={composerValue}
              error={error}
              onAgentChange={(value) => {
                setSelectedAgentName(value);
                setSessionId(createPlaygroundSessionId(value));
                setMessages([]);
                setError(null);
              }}
              onComposerChange={setComposerValue}
              onSubmit={handleSubmit}
              selectedAgentName={selectedAgentName}
              status={status}
              agents={chatAgents.map((agent) => agent.name)}
            />
          </div>
        </div>
      )}

      {messages.length > 0 ? (
        <div className="border-t border-border/70 px-4 py-4 md:px-6">
          <div className="mx-auto w-full max-w-3xl">
            <PromptComposer
              composerValue={composerValue}
              error={error}
              onAgentChange={(value) => {
                setSelectedAgentName(value);
                setSessionId(createPlaygroundSessionId(value));
                setMessages([]);
                setError(null);
              }}
              onComposerChange={setComposerValue}
              onSubmit={handleSubmit}
              selectedAgentName={selectedAgentName}
              status={status}
              agents={chatAgents.map((agent) => agent.name)}
            />
          </div>
        </div>
      ) : null}
    </section>
  );
}

function PromptComposer(props: {
  agents: string[];
  composerValue: string;
  error: string | null;
  onAgentChange: (value: string) => void;
  onComposerChange: (value: string) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void | Promise<void>;
  selectedAgentName: string;
  status: "idle" | "submitted" | "error";
}) {
  return (
    <PromptInput onSubmit={props.onSubmit}>
      <PromptInputBody>
        <PromptInputTextarea
          disabled={props.status === "submitted"}
          onChange={(event) => props.onComposerChange(event.target.value)}
          placeholder="Ask the agent anything..."
          value={props.composerValue}
        />
      </PromptInputBody>

      <PromptInputFooter>
        <PromptInputTools>
          <Select
            value={props.selectedAgentName}
            onValueChange={(value) => {
              if (value != null) {
                props.onAgentChange(value);
              }
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select agent" />
            </SelectTrigger>
            <SelectContent>
              {props.agents.map((agent) => (
                <SelectItem key={agent} value={agent}>
                  {agent}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {props.error ? <Badge variant="destructive">{props.error}</Badge> : null}
        </PromptInputTools>

        <PromptInputTools className="justify-end">
          <PromptInputSubmit
            disabled={props.composerValue.trim().length === 0}
            status={props.status === "submitted" ? "submitted" : "idle"}
          />
        </PromptInputTools>
      </PromptInputFooter>
    </PromptInput>
  );
}
