"use client";

import * as React from "react";

import { Button } from "#/components/ui/button";
import { cn } from "#/lib/utils";

type ConversationContextValue = {
  scrollToBottom: () => void;
  containerRef: React.RefObject<HTMLDivElement | null>;
  showScrollButton: boolean;
  setShowScrollButton: React.Dispatch<React.SetStateAction<boolean>>;
};

const ConversationContext = React.createContext<ConversationContextValue | null>(null);

function useConversation() {
  const value = React.useContext(ConversationContext);

  if (value == null) {
    throw new Error("Conversation components must be used within Conversation.");
  }

  return value;
}

export function Conversation(props: React.ComponentProps<"section">) {
  const { children, className, ...rest } = props;
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const [showScrollButton, setShowScrollButton] = React.useState(false);

  const scrollToBottom = React.useCallback(() => {
    const element = containerRef.current;

    if (element == null) {
      return;
    }

    element.scrollTo({
      top: element.scrollHeight,
      behavior: "smooth",
    });
  }, []);

  const contextValue = React.useMemo(
    () => ({
      containerRef,
      scrollToBottom,
      setShowScrollButton,
      showScrollButton,
    }),
    [scrollToBottom, showScrollButton],
  );

  return (
    <ConversationContext.Provider value={contextValue}>
      <section
        className={cn("relative flex min-h-0 flex-1 flex-col overflow-hidden", className)}
        {...rest}
      >
        {children}
      </section>
    </ConversationContext.Provider>
  );
}

export function ConversationContent(props: React.ComponentProps<"div">) {
  const { children, className, onScroll, ...rest } = props;
  const { containerRef, setShowScrollButton } = useConversation();

  React.useEffect(() => {
    const element = containerRef.current;

    if (element == null) {
      return;
    }

    element.scrollTop = element.scrollHeight;
  }, [children, containerRef]);

  return (
    <div
      ref={containerRef}
      className={cn(
        "flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-5 lg:px-6",
        className,
      )}
      onScroll={(event) => {
        const element = event.currentTarget;
        const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;

        setShowScrollButton(distanceFromBottom > 96);
        onScroll?.(event);
      }}
      {...rest}
    >
      {children}
    </div>
  );
}

export function ConversationEmptyState(
  props: React.ComponentProps<"div"> & {
    description?: string;
    icon?: React.ReactNode;
    title?: string;
  },
) {
  const { children, className, description, icon, title, ...rest } = props;

  return (
    <div
      className={cn(
        "flex min-h-full flex-1 items-center justify-center rounded-xl border border-dashed border-border bg-muted/35 px-6 py-10 text-center",
        className,
      )}
      {...rest}
    >
      {children ?? (
        <div className="space-y-3">
          {icon == null ? null : (
            <div className="mx-auto flex size-10 items-center justify-center rounded-full border border-border bg-base-white text-muted-foreground">
              {icon}
            </div>
          )}
          {title == null ? null : <p className="text-lg font-medium text-foreground">{title}</p>}
          {description == null ? null : (
            <p className="max-w-xl text-base text-muted-foreground text-pretty sm:text-sm">
              {description}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function ConversationScrollButton(props: React.ComponentProps<typeof Button>) {
  const { className, children = "Jump to latest", ...rest } = props;
  const { scrollToBottom, showScrollButton } = useConversation();

  if (!showScrollButton) {
    return null;
  }

  return (
    <Button
      className={cn("absolute right-4 bottom-4 shadow-sm", className)}
      size="sm"
      type="button"
      variant="outline"
      onClick={scrollToBottom}
      {...rest}
    >
      {children}
    </Button>
  );
}
