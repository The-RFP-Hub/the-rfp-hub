import { DIRECTORY, HOW_IT_WORKS } from "@/lib/links";
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Not found", robots: { index: false, follow: false } };

/**
 * The shell's own 404. Without this file an unmatched address got the framework's bare page: no
 * header, no footer, no way back in. A listing that is not published has its own state on the
 * listing page; this one is for everything else.
 */
export default function NotFound() {
  return (
    <section className="state empty">
      <h1 className="empty-title">There is nothing at this address.</h1>
      <p className="muted">
        The link may be old, or the page may have moved when the directory got its own address.
      </p>
      <p className="row">
        <Link className="button-primary" href={DIRECTORY}>
          Open the directory
        </Link>
        <Link href="/">Home</Link>
        <Link href={HOW_IT_WORKS}>How it works</Link>
      </p>
    </section>
  );
}
