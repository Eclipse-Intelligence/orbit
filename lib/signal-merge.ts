export const HOLD_POLL_MS = 500;

export type MergeOptions = {
  settleMs: number;
  maxWaitMs?: number;
  hold?: () => boolean;
};

export function createSignalMerge(options: MergeOptions, fire: () => void) {
  let settle: ReturnType<typeof setTimeout> | null = null;
  let ceiling: ReturnType<typeof setTimeout> | null = null;
  let polling: ReturnType<typeof setTimeout> | null = null;

  const clear = () => {
    if (settle) clearTimeout(settle);
    if (ceiling) clearTimeout(ceiling);
    if (polling) clearTimeout(polling);
    settle = null;
    ceiling = null;
    polling = null;
  };

  const flush = () => {
    if (settle) clearTimeout(settle);
    if (ceiling) clearTimeout(ceiling);
    settle = null;
    ceiling = null;
    if (options.hold?.()) {
      if (!polling) {
        polling = setTimeout(() => {
          polling = null;
          flush();
        }, HOLD_POLL_MS);
      }
      return;
    }
    if (polling) clearTimeout(polling);
    polling = null;
    fire();
  };

  const request = () => {
    if (settle) clearTimeout(settle);
    settle = setTimeout(flush, options.settleMs);
    if (options.maxWaitMs !== undefined && !ceiling) ceiling = setTimeout(flush, options.maxWaitMs);
  };

  return { request, cancel: clear };
}
