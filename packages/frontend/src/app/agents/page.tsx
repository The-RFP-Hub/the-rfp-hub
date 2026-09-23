import { AgentsGuide } from "@/components/AgentsGuide";
import { resolveAgentOrigins } from "@/lib/agents";

export default async function AgentsPage() {
  const origins = await resolveAgentOrigins();
  return origins ? <AgentsGuide {...origins} /> : null;
}
