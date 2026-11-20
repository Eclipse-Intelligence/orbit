export const ADD_TASK_EVENT = "orbit:add-task";

export type AddTaskSeed = { title: string; description: string | null };

export function addTask(seed: AddTaskSeed) {
  const event = new CustomEvent<AddTaskSeed>(ADD_TASK_EVENT, { detail: seed, cancelable: true });
  return !window.dispatchEvent(event);
}
