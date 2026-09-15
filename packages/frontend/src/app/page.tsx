"use client";

/**
 * THE FRONT DOOR IS A PITCH FOR THE INDEX. The index itself is one click away at `/directory`.
 *
 * Until now `/` was the directory table, which is the right first screen for somebody who already
 * knows what this site is and the wrong one for somebody arriving from a talk or a link: a table
 * says nothing about what it is a table OF. The landing says that in one line, proves the index is
 * alive with numbers derived from the open set, and offers the two doors — I'm looking, I publish.
 */
import { Landing } from "@/components/Landing";
import { NoScriptNotice } from "@/components/NoScriptNotice";

export default function HomePage() {
  return (
    <>
      <NoScriptNotice />
      <Landing />
    </>
  );
}
