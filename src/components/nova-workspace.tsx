"use client";

import { useState, useTransition } from "react";
import type {
  ConsultationResult,
  Locale,
  ProjectFacts,
  Scenario,
} from "@/domain/consultation-journey";
import { ConsultationThread } from "./consultation-thread";
import { DecisionCardPanel } from "./decision-card-panel";
import { ProjectRail } from "./project-rail";

interface NovaWorkspaceProps {
  initial: ConsultationResult;
}

async function postJson<T>(
  url: string,
  body: unknown,
  version: number,
  idempotencyKey = crypto.randomUUID(),
): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: "Bearer demo-research-session",
      "content-type": "application/json",
      "x-tenant-id": "novogene-demo",
      "x-idempotency-key": idempotencyKey,
      "if-match": `"v${version}"`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`请求失败：${response.status}`);
  return (await response.json()) as T;
}

export function NovaWorkspace({ initial }: NovaWorkspaceProps) {
  const [result, setResult] = useState(initial);
  const [facts, setFacts] = useState<ProjectFacts>(initial.project.facts);
  const [confirmedFacts, setConfirmedFacts] = useState<ProjectFacts>(initial.project.facts);
  const [scenario, setScenario] = useState<Scenario>("standard");
  const [locale, setLocale] = useState<Locale>("zh");
  const [isPending, startTransition] = useTransition();

  const scenarioQuestions: Record<Scenario, string> = {
    standard: "请基于已确认项目事实比较 FFPE RNA 建库路线和测序平台。",
    "missing-dv200": "我不知道 DV200，请提供条件性路径。",
    "evidence-conflict": "请核对当前 SOP 与外部文献是否冲突。",
    "non-standard": "这是非标准特殊样本，请评估风险。",
    "manual-escalation": "请转交人工专家复核。",
  };

  function requestConsultation(
    nextScenario: Scenario,
    nextLocale: Locale,
    nextFacts: ProjectFacts,
    question = scenarioQuestions[nextScenario],
  ) {
    return postJson<ConsultationResult>(
      "/api/consultations",
      { question, locale: nextLocale, facts: nextFacts },
      result.card.version,
    );
  }

  function run(nextScenario: Scenario, prompt?: string) {
    setScenario(nextScenario);
    const nextFacts =
      nextScenario === "missing-dv200"
        ? { ...confirmedFacts, dv200: undefined }
        : confirmedFacts;
    startTransition(async () => {
      setResult(
        await requestConsultation(nextScenario, locale, nextFacts, prompt),
      );
    });
  }

  function changeLocale(nextLocale: Locale) {
    setLocale(nextLocale);
    startTransition(async () => {
      setResult(
        await requestConsultation(scenario, nextLocale, confirmedFacts),
      );
    });
  }

  async function consent() {
    await postJson(
      "/api/consent",
      {
        projectId: result.project.id,
        granted: true,
        action: "request-quote",
      },
      result.card.version,
      `consent:${result.project.id}:request-quote:v${result.card.version}`,
    );
  }

  async function feedback(score: number) {
    await postJson(
      "/api/feedback",
      {
        projectId: result.project.id,
        score,
        reason: score <= 2 ? "citation" : undefined,
      },
      result.card.version,
      `feedback:${result.project.id}:${score}:v${result.card.version}`,
    );
  }

  async function requestExpertReview() {
    await postJson(
      "/api/consent",
      {
        projectId: result.project.id,
        granted: true,
        action: "book-expert",
      },
      result.card.version,
      `consent:${result.project.id}:book-expert:v${result.card.version}`,
    );
  }

  function confirmFacts() {
    const nextScenario =
      scenario === "evidence-conflict" || scenario === "manual-escalation"
        ? scenario
        : "standard";
    setScenario(nextScenario);
    startTransition(async () => {
      try {
        const nextResult = await requestConsultation(nextScenario, locale, facts);
        setResult(nextResult);
        setConfirmedFacts(facts);
      } catch {
        setConfirmedFacts(result.project.facts);
      }
    });
  }

  return (
    <div className="workspace">
      <ProjectRail
        facts={facts}
        confirmed={JSON.stringify(facts) === JSON.stringify(confirmedFacts)}
        onFactsChange={setFacts}
        onConfirm={confirmFacts}
      />
      <ConsultationThread
        result={result}
        locale={locale}
        scenario={scenario}
        isPending={isPending}
        onRun={run}
        onLocaleChange={changeLocale}
      />
      <DecisionCardPanel
        result={result}
        onConsent={consent}
        onExpertRequest={requestExpertReview}
        onFeedback={feedback}
      />
    </div>
  );
}
