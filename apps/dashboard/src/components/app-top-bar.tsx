import * as React from "react";
import { Link } from "@tanstack/react-router";

import { cn } from "#/lib/utils";

type AppTopBarProps = {
  activeTab: "dashboard" | "playground";
  rightSlot?: React.ReactNode;
  sidebarToggle?: React.ReactNode;
};

const appTabs = [
  {
    href: "/playground",
    key: "playground",
    label: "Playground",
  },
  {
    href: "/",
    key: "dashboard",
    label: "Dashboard",
  },
] as const satisfies readonly {
  href: string;
  key: AppTopBarProps["activeTab"];
  label: string;
}[];

export function AppTopBar(props: AppTopBarProps) {
  return (
    <header>
      <div className="flex flex-col gap-3 px-4 py-2 md:flex-row md:items-center md:justify-between md:gap-5 ">
        <div className="flex min-w-0 items-center gap-3">
          <Link aria-label="Homepage" className="flex min-w-0 items-center gap-3" to="/">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-neutral-950 text-base font-medium text-base-white sm:text-sm">
              S
            </div>

            <div className="min-w-0">
              <p className="truncate text-base font-medium text-foreground sm:text-sm">
                Superobjective
              </p>
            </div>
          </Link>
        </div>

        <div className="flex items-center justify-between gap-3 md:justify-end">
          <nav aria-label="Primary" className="overflow-x-auto">
            <ul className="flex min-w-max items-center gap-7" role="list">
              {appTabs.map((tab) => {
                const isActive = props.activeTab === tab.key;

                return (
                  <li key={tab.key}>
                    <Link
                      aria-current={isActive ? "page" : undefined}
                      className={cn(
                        "flex text-base transition-colors sm:text-sm",
                        isActive
                          ? "text-foreground"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                      to={tab.href}
                    >
                      {tab.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
        </div>
      </div>
    </header>
  );
}
