"use client";

/**
 * `/leaving/{id}?link=apply|source&reason=…` — see `components/LeavingNotice.tsx`.
 *
 * The id is the only thing this route takes from its path, and it is used for one thing: reading
 * the public listing it names. Everything the page shows about the destination comes from that
 * read.
 */
import { LeavingNotice } from "@/components/LeavingNotice";
import { useParams } from "next/navigation";

/**
 * Decoded like the detail page decodes its id, but a malformed escape (`%E0%A4%A`) is read as the
 * literal it is rather than thrown: the API's redirect always encodes the id, so a broken one was
 * typed or truncated by hand, and the honest answer to that is the page's own "isn't available"
 * state rather than the error boundary.
 */
function decodeLeavingId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export default function LeavingPage() {
  const params = useParams<{ id: string }>();
  return <LeavingNotice id={decodeLeavingId(String(params.id ?? ""))} />;
}
