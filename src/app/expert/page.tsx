import { ExpertWorkbench } from "@/components/expert-workbench";
import { getDb } from "@/server/db/client";
import { listExpertCases } from "@/server/db/repositories";
import { runConsultationGraph } from "@/server/orchestration/graph";

// Node runtime (node:sqlite) + fresh read each load so newly-escalated cases
// (and status changes from the desk) show up immediately.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function loadQueue() {
  const db = getDb();
  let cases = listExpertCases(db);
  if (cases.length === 0) {
    // Seed one *real* escalated case by running the evidence-conflict gold case
    // through the actual orchestration graph — it persists CASE-2407 with a
    // genuine handoff package. Deterministic offline (provider: off).
    await runConsultationGraph(
      db,
      {
        projectId: "NP-EXPERT-2407",
        tenantId: "novapilot-demo",
        question: "SOP与外部文献存在冲突，如何处理这批FFPE RNA样本",
        locale: "zh",
        facts: { sampleCount: 8, dv200: 55, rnaInputNg: 20, material: "FFPE RNA" },
        now: new Date().toISOString(),
        traceId: "expert-seed",
      },
      { provider: "off" },
    );
    cases = listExpertCases(db);
  }
  return cases;
}

export default async function ExpertPage() {
  const cases = await loadQueue();
  return <ExpertWorkbench initialCases={cases} />;
}
