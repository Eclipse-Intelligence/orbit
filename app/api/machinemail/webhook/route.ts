import { after } from "next/server";
import { startAgentMailJob } from "@/lib/agent-mail/jobs";
import { receiveAgentMail } from "@/lib/agent-mail/receive";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const NO_STORE = { "cache-control": "no-store" };

function background(work: () => Promise<void>) {
  const guarded = () => work().catch((error) => console.error("Agent mail job failed", error instanceof Error ? error.name : "unknown"));
  try {
    after(guarded);
  } catch {
    void guarded();
  }
}

export async function POST(request: Request) {
  try {
    const raw = await request.text();
    const result = await receiveAgentMail(request.headers, raw);
    const job = result.job;
    if (job) background(() => startAgentMailJob(job));
    return Response.json(result.body, { status: result.status, headers: NO_STORE });
  } catch (error) {
    console.error("Agent mail webhook failed", error instanceof Error ? error.name : "unknown");
    return Response.json({ error: "Something went wrong." }, { status: 500, headers: NO_STORE });
  }
}
