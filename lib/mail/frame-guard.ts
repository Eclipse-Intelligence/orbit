export type FrameLoad = "first" | "restore" | "blocked";

export function createFrameGuard(maxRestores = 2) {
  let allowed = false;
  let awaitingLoad = false;
  let loads = 0;
  let restores = 0;

  return {
    fresh() {
      restores = 0;
      allowed = true;
      awaitingLoad = false;
      loads = 0;
    },
    hello(complete: boolean) {
      if (!allowed) return false;
      allowed = false;
      if (complete && loads === 0) loads = 1;
      return true;
    },
    load(): FrameLoad {
      loads += 1;
      if (loads <= 1) {
        if (awaitingLoad) {
          awaitingLoad = false;
          allowed = true;
        }
        return "first";
      }
      allowed = false;
      loads = 0;
      if (restores >= maxRestores) {
        awaitingLoad = false;
        return "blocked";
      }
      restores += 1;
      awaitingLoad = true;
      return "restore";
    },
  };
}
