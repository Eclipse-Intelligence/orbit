"use server";

import { getUserActor } from "@/lib/auth/user";
import { getClickUpPicker, type ClickUpPicker } from "@/lib/crm/clickup";
import { listPipeline } from "@/lib/crm/opportunities";
import { listTags } from "@/lib/crm/tags";
import type { PipelineStage, TagCount } from "@/lib/crm/types";

export type QuickAddSetup = {
  stages: PipelineStage[];
  clickup: ClickUpPicker | null;
  tags: TagCount[];
};

export async function quickAddSetupAction(): Promise<QuickAddSetup> {
  const user = await getUserActor();
  if (!user) return { stages: [], clickup: null, tags: [] };
  const [pipeline, clickup, tags] = await Promise.all([
    listPipeline(user),
    getClickUpPicker(user).catch(() => null),
    listTags(user),
  ]);
  return { stages: pipeline.stages, clickup, tags };
}
