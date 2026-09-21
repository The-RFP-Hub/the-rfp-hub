"use client";

/**
 * A link to `#rule-roles` should show the rule, not a closed fold with the right id. The browser
 * scrolls to the `<details>`; this opens it, on arrival and on every hash change after.
 */
import { useEffect } from "react";

export function OpenRuleOnHash() {
  useEffect(() => {
    const open = () => {
      const id = window.location.hash.slice(1);
      if (!id) return;
      const target = document.getElementById(id);
      const fold = target?.closest("details");
      if (fold) fold.open = true;
      target?.scrollIntoView({ block: "start" });
    };
    open();
    window.addEventListener("hashchange", open);
    return () => window.removeEventListener("hashchange", open);
  }, []);
  return null;
}
