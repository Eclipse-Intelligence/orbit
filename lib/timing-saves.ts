export type TimingValues = { due: string; reminder: number | null; duration: number };

export function timingSaves(initial: TimingValues) {
  let latest = 0;
  let clock = 0;
  let confirmed = initial;
  let confirmedAt = 0;
  let confirmedTicket = 0;
  let fresh: { values: TimingValues; at: number } | null = null;
  const inFlight = new Set<number>();
  const newest = () => (fresh && fresh.at > confirmedAt ? fresh.values : confirmed);
  const settleFresh = () => {
    if (inFlight.size > 0 || !fresh) return;
    if (fresh.at > confirmedAt) {
      confirmed = fresh.values;
      confirmedAt = fresh.at;
    }
    fresh = null;
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
      clock += 1;
      if (inFlight.size === 0) {
        confirmed = values;
        confirmedAt = clock;
      } else fresh = { values, at: clock };
    },
    succeed(ticket: number, saved: TimingValues) {
      inFlight.delete(ticket);
      if (ticket >= confirmedTicket) {
        clock += 1;
        confirmed = saved;
        confirmedAt = clock;
        confirmedTicket = ticket;
      }
      settleFresh();
      return ticket === latest ? saved : null;
    },
    fail(ticket: number) {
      inFlight.delete(ticket);
      const restore = ticket === latest ? newest() : null;
      settleFresh();
      return restore;
    },
  };
}
