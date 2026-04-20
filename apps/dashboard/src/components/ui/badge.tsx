import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "#/lib/utils";

const badgeVariants = cva(
  "group/badge inline-flex h-7 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-md border border-transparent px-2.5 py-1 text-sm font-semibold whitespace-nowrap transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-4!",
  {
    variants: {
      variant: {
        default: "bg-primary/12 text-primary [a]:hover:bg-primary/18",
        secondary:
          "bg-blue-500/12 text-blue-700 dark:bg-blue-400/16 dark:text-blue-300 [a]:hover:bg-blue-500/18 dark:[a]:hover:bg-blue-400/22",
        destructive:
          "bg-destructive/12 text-destructive focus-visible:ring-destructive/20 dark:bg-destructive/18 dark:focus-visible:ring-destructive/40 [a]:hover:bg-destructive/18 dark:[a]:hover:bg-destructive/24",
        outline:
          "bg-foreground/6 text-foreground/72 [a]:hover:bg-foreground/10 [a]:hover:text-foreground",
        ghost: "bg-muted/80 text-muted-foreground hover:bg-muted",
        link: "bg-primary/10 text-primary hover:bg-primary/16",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Badge({
  className,
  variant = "default",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant }), className),
      },
      props,
    ),
    render,
    state: {
      slot: "badge",
      variant,
    },
  });
}

export { Badge, badgeVariants };
