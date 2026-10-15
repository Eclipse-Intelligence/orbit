"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { Input } from "@/components/_ui/input";
import { SettingsCard, SettingsDisclosure } from "@/components/crm/settings-ui";
import { saveStagesAction } from "@/app/(crm)/settings/actions";
import type { PipelineStage } from "@/lib/crm/types";

export default function PipelineSettings({
  stages,
}: {
  stages: PipelineStage[];
}) {
  const router = useRouter();
  const [drafts, setDrafts] = useState(stages);
  const [stageSource, setStageSource] = useState(stages);
  if (stageSource !== stages) {
    setStageSource(stages);
    setDrafts(stages);
  }
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function edit(id: string, change: (stage: PipelineStage) => PipelineStage) {
    setMessage(null);
    setDrafts((current) =>
      current.map((item) => (item.id === id ? change(item) : item)),
    );
  }

  async function saveStages() {
    setPending(true);
    setError(null);
    setMessage(null);
    const result = await saveStagesAction(
      drafts.map((stage) => ({
        id: stage.id.startsWith("new-") ? undefined : stage.id,
        name: stage.name,
        probability: stage.probability,
        isWon: stage.isWon,
        isLost: stage.isLost,
      })),
    );
    setPending(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setMessage("Pipeline saved.");
    router.refresh();
  }

  function addStage() {
    setMessage(null);
    setDrafts((current) => {
      const next = {
        id: `new-${crypto.randomUUID()}`,
        pipelineId: current[0]?.pipelineId ?? "",
        name: "New stage",
        position: current.length,
        probability: 20,
        isWon: false,
        isLost: false,
      };
      const lostAt = current.findIndex((stage) => stage.isLost);
      if (lostAt < 0) return [...current, next];
      return [...current.slice(0, lostAt), next, ...current.slice(lostAt)];
    });
  }

  return (
    <SettingsCard
      id="pipeline"
      title="Stages"
      description="Keep one won stage and one lost stage. A stage with opportunities stays until those records move."
    >
      <div className="caption-style text-subtle hidden grid-cols-[1fr_90px_auto_auto_auto] gap-2 sm:grid">
        <span>Name</span>
        <span>Probability %</span>
      </div>
      <ul className="flex flex-col gap-2">
        {drafts.map((stage, index) => (
          <li
            key={stage.id}
            className="border-border grid gap-2 border-b pb-2 last:border-b-0 last:pb-0 sm:grid-cols-[1fr_90px_auto_auto_auto] sm:items-center sm:border-b-0 sm:pb-0"
          >
            <Input
              aria-label={`Stage ${index + 1} name`}
              value={stage.name}
              onChange={(event) =>
                edit(stage.id, (item) => ({
                  ...item,
                  name: event.target.value,
                }))
              }
            />
            <Input
              aria-label={`${stage.name} probability`}
              inputMode="numeric"
              value={String(stage.probability)}
              onChange={(event) =>
                edit(stage.id, (item) => ({
                  ...item,
                  probability: Number(event.target.value) || 0,
                }))
              }
            />
            <div className="flex items-center gap-4 sm:contents">
              <label className="caption-style flex items-center gap-2">
                <input
                  type="radio"
                  name="won-stage"
                  checked={stage.isWon}
                  onChange={() => {
                    setMessage(null);
                    setDrafts((current) =>
                      current.map((item) => ({
                        ...item,
                        isWon: item.id === stage.id,
                        isLost: item.id === stage.id ? false : item.isLost,
                        probability:
                          item.id === stage.id ? 100 : item.probability,
                      })),
                    );
                  }}
                />
                Won
              </label>
              <label className="caption-style flex items-center gap-2">
                <input
                  type="radio"
                  name="lost-stage"
                  checked={stage.isLost}
                  onChange={() => {
                    setMessage(null);
                    setDrafts((current) =>
                      current.map((item) => ({
                        ...item,
                        isLost: item.id === stage.id,
                        isWon: item.id === stage.id ? false : item.isWon,
                        probability:
                          item.id === stage.id ? 0 : item.probability,
                      })),
                    );
                  }}
                />
                Lost
              </label>
              <Button
                variant="ghost"
                size="sm"
                type="button"
                className="ml-auto sm:ml-0"
                aria-label={`Remove ${stage.name || `stage ${index + 1}`}`}
                disabled={
                  pending || drafts.length <= 2 || stage.isWon || stage.isLost
                }
                onClick={() => {
                  setMessage(null);
                  setDrafts((current) =>
                    current.filter((item) => item.id !== stage.id),
                  );
                }}
              >
                Remove
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="caption-style text-danger">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" type="button" onClick={addStage}>
          Add stage
        </Button>
        <Button
          variant="secondary"
          size="sm"
          type="button"
          onClick={saveStages}
          disabled={pending}
        >
          {pending ? "Saving…" : "Save pipeline"}
        </Button>
        <p role="status" className="caption-style text-subtle">
          {message}
        </p>
      </div>
      <SettingsDisclosure
        title="How stages work"
        summary="Limits, probabilities, and removing a stage."
      >
        <ul className="caption-style text-subtle flex list-disc flex-col gap-1.5 pl-4 leading-[1.4]">
          <li>
            A pipeline has 2 to 20 stages, each with its own name. New stages go
            before the lost stage.
          </li>
          <li>
            When an opportunity moves to a stage, it takes that stage&apos;s
            probability unless you set one yourself.
          </li>
          <li>The won stage is always 100% and the lost stage 0%.</li>
          <li>
            You can&apos;t remove the won or lost stage, or a stage that still
            has opportunities.
          </li>
        </ul>
      </SettingsDisclosure>
    </SettingsCard>
  );
}
