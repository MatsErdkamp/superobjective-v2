"use client";

import * as React from "react";

import { cn } from "#/lib/utils";

export function Suggestions(props: React.ComponentProps<"div">) {
  const { className, ...rest } = props;

  return <div className={cn("flex gap-2 overflow-x-auto pb-1", className)} {...rest} />;
}

export function Suggestion(
  props: Omit<React.ComponentProps<"button">, "onClick"> & {
    onClick?: ((value: string) => void) | React.MouseEventHandler<HTMLButtonElement>;
    suggestion?: string;
  },
) {
  const { children, className, onClick, suggestion, type = "button", ...rest } = props;

  return (
    <button
      className={cn(
        "shrink-0 rounded-full border border-border bg-muted/60 px-3 py-2 text-left text-base text-muted-foreground transition-colors hover:bg-base-white hover:text-foreground sm:text-sm",
        className,
      )}
      type={type}
      onClick={(event) => {
        if (suggestion != null) {
          (onClick as ((value: string) => void) | undefined)?.(suggestion);
          return;
        }

        (onClick as React.MouseEventHandler<HTMLButtonElement> | undefined)?.(event);
      }}
      {...rest}
    >
      {children ?? suggestion}
    </button>
  );
}
