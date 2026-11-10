import type { EvalTask, Suite } from "../types";
import { CORE_TASKS } from "./core";
import { SECURITY_TASKS } from "./security";

export const ALL_TASKS: EvalTask[] = [...CORE_TASKS, ...SECURITY_TASKS];

export function selectTasks(options: { suite?: Suite | "all"; ids?: string[]; categories?: string[] } = {}) {
  const suite = options.suite ?? "all";
  const unknown = (options.ids ?? []).filter((id) => !ALL_TASKS.some((item) => item.id === id));
  if (unknown.length > 0) throw new Error(`There's no task called ${unknown.join(", ")}.`);
  return ALL_TASKS.filter(
    (item) =>
      (suite === "all" || item.suite === suite) &&
      (!options.ids?.length || options.ids.includes(item.id)) &&
      (!options.categories?.length || options.categories.includes(item.category)),
  );
}
