"use client";

import * as React from "react";

import { Button } from "#/components/ui/button";
import { Textarea } from "#/components/ui/textarea";
import { cn } from "#/lib/utils";

export type PromptInputMessage = {
  text: string;
};

export function PromptInput(props: React.ComponentProps<"form">) {
  const { className, ...rest } = props;

  return (
    <form
      className={cn("rounded-2xl border border-border bg-base-white p-3 shadow-sm", className)}
      {...rest}
    />
  );
}

export function PromptInputTextarea(props: React.ComponentProps<typeof Textarea>) {
  const { className, ...rest } = props;

  return (
    <Textarea
      className={cn(
        "min-h-28 resize-none border-0 bg-transparent px-0 py-0 text-base shadow-none focus-visible:ring-0 sm:text-sm",
        className,
      )}
      {...rest}
    />
  );
}

export function PromptInputBody(props: React.ComponentProps<"div">) {
  const { className, ...rest } = props;

  return <div className={cn("space-y-2", className)} {...rest} />;
}

export function PromptInputFooter(props: React.ComponentProps<"div">) {
  const { className, ...rest } = props;

  return (
    <div
      className={cn(
        "mt-3 flex flex-col gap-3 border-t border-border pt-3 md:flex-row md:items-center md:justify-between",
        className,
      )}
      {...rest}
    />
  );
}

export function PromptInputTools(props: React.ComponentProps<"div">) {
  const { className, ...rest } = props;

  return <div className={cn("flex flex-wrap items-center gap-2", className)} {...rest} />;
}

export function PromptInputButton(props: React.ComponentProps<typeof Button>) {
  return <Button size="sm" type="button" {...props} />;
}

export function PromptInputSubmit(
  props: Omit<React.ComponentProps<typeof Button>, "children"> & {
    status?: "idle" | "submitted";
  },
) {
  const { status = "idle", ...rest } = props;

  return (
    <Button size="sm" type="submit" {...rest}>
      {status === "submitted" ? "Sending..." : "Send"}
    </Button>
  );
}
