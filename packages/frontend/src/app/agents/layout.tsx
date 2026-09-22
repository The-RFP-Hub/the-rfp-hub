import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Agents",
  description:
    "Use RFP Hub from an AI agent: a prompt to paste into any agent, the MCP server, the funding-search skill and the public API.",
};

export default function AgentsLayout({ children }: { children: ReactNode }) {
  return children;
}
