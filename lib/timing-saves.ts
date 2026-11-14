export type TimingValues = { due: string; reminder: number | null; duration: number };

export function timingSaves(initial: TimingValues) {
  let latest = 0;
  let confirmed = initial;
  let confirmedTicket = 0;
  let freshWhilePending: TimingValues | null = null;
  const inFlight = new Set<number>();
  const settleFresh = () => {
    if (inFlight.size > 0 || !freshWhilePending) return;
    confirmed = freshWhilePending;
    freshWhilePending = null;
  };
  return {
    start() {
      latest += 1;
      inFlight.add(latest);
      return latest;
    },
    pending() {
      return inFlight.size > 0;
    },
    observe(values: TimingValues) {
      if (inFlight.size === 0) confirmed = values;
      else freshWhilePending = values;
    },
    succeed(ticket: number, saved: TimingValues) {
      inFlight.delete(ticket);
      if (ticket >= confirmedTicket) {
        confirmed = saved;
        confirmedTicket = ticket;
        if (ticket === latest) freshWhilePending = null;
      }
      settleFresh();
      return ticket === latest ? saved : null;
    },
    fail(ticket: number) {
      inFlight.delete(ticket);
      const restore = ticket === latest ? (freshWhilePending ?? confirmed) : null;
      settleFresh();
      return restore;
    },
  };
}
