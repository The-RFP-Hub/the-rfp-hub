"use client";

import Link from "next/link";
import {
  type ComponentProps,
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

const LEAVE_MESSAGE = "You have changes in this form. Leave this page?";

interface NavigationBlockerValue {
  blocked: boolean;
  setBlocked: (blocked: boolean) => void;
  confirmNavigation: () => boolean;
}

const NavigationBlockerContext = createContext<NavigationBlockerValue>({
  blocked: false,
  setBlocked: () => {},
  confirmNavigation: () => true,
});

export function NavigationBlockerProvider({ children }: { children: ReactNode }) {
  const [blocked, setBlocked] = useState(false);
  const confirmNavigation = useCallback(() => !blocked || window.confirm(LEAVE_MESSAGE), [blocked]);
  const value = useMemo(
    () => ({ blocked, setBlocked, confirmNavigation }),
    [blocked, confirmNavigation],
  );
  return (
    <NavigationBlockerContext.Provider value={value}>{children}</NavigationBlockerContext.Provider>
  );
}

export function useNavigationBlocker(): NavigationBlockerValue {
  return useContext(NavigationBlockerContext);
}

export function GuardedLink({ children, onNavigate, ...props }: ComponentProps<typeof Link>) {
  const { confirmNavigation } = useNavigationBlocker();
  return (
    <Link
      {...props}
      onNavigate={(event) => {
        onNavigate?.(event);
        if (!confirmNavigation()) event.preventDefault();
      }}
    >
      {children}
    </Link>
  );
}
