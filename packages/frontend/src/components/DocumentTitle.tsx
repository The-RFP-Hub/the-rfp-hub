"use client";

import { useEffect } from "react";

/** Replace an id-based server fallback once a client-fetched record supplies its public title. */
export function DocumentTitle({ title, fallback }: { title?: string | null; fallback: string }) {
  const resolved = title?.trim() || fallback;

  useEffect(() => {
    document.title = `${resolved} | RFP Hub`;
  }, [resolved]);

  return null;
}
