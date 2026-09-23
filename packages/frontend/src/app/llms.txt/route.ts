import { llmsTxt, resolveAgentOrigins } from "@/lib/agents";

export async function GET() {
  const origins = await resolveAgentOrigins();
  if (!origins) return new Response("The API is not configured.", { status: 500 });
  return new Response(llmsTxt(origins), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
