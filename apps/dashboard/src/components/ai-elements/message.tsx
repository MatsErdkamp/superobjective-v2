"use client";

import * as React from "react";

import { Badge } from "#/components/ui/badge";
import { cn } from "#/lib/utils";

export function Message(
  props: React.ComponentProps<"article"> & {
    from: "assistant" | "user";
  },
) {
  const { children, className, from, ...rest } = props;

  return (
    <article
      className={cn("flex w-full", from === "user" ? "justify-end" : "justify-start", className)}
      {...rest}
    >
      <div
        className={cn(
          "flex max-w-3xl flex-col gap-2",
          from === "user" ? "items-end" : "items-start",
        )}
      >
        <Badge variant="secondary">{from === "user" ? "You" : "Agent"}</Badge>
        {children}
      </div>
    </article>
  );
}

export function MessageContent(props: React.ComponentProps<"div">) {
  const { className, ...rest } = props;

  return (
    <div
      className={cn(
        "w-full rounded-2xl border border-border bg-base-white px-4 py-3 shadow-[0_1px_0_rgba(0,0,0,0.03)]",
        className,
      )}
      {...rest}
    />
  );
}

export function MessageResponse(props: React.ComponentProps<"div">) {
  const { className, ...rest } = props;

  return (
    <div
      className={cn(
        "whitespace-pre-wrap break-words text-base text-foreground sm:text-sm",
        className,
      )}
      {...rest}
    />
  );
}

export function MessageToolbar(props: React.ComponentProps<"div">) {
  const { className, ...rest } = props;

  return <div className={cn("flex flex-wrap items-center gap-2 px-2", className)} {...rest} />;
}
