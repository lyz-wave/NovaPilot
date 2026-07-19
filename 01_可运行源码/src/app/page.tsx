import { NovaWorkspace } from "@/components/nova-workspace";
import { runConsultationJourney } from "@/domain/consultation-journey";

export default function ConsultationPage() {
  const initial = runConsultationJourney({
    scenario: "standard",
    locale: "zh",
    facts: { sampleCount: 24, dv200: 62, rnaInputNg: 20, material: "FFPE RNA" },
  });

  return <NovaWorkspace initial={initial} />;
}
