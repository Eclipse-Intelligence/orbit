export type TimingValues = { due: string; reminder: number | null; duration: number };

export function timingSaves(initial: TimingValues) {
  let latest = 0;
  let confirmed = initial;
  let confirmedTicket = 0;
  const inFlight = new Set<number>();
  return {
    start() {
      latest += 1;
      inFlight.add(latest);
      return latest;
    },
    pending() {
      return inFlight.size > 0;
    },
    confirm(values: TimingValues) {
      if (inFlight.size === 0) confirmed = values;
    },
    succeed(ticket: number, saved: TimingValues) {
      inFlight.delete(ticket);
      if (ticket >= confirmedTicket) {
        confirmed = saved;
        confirmedTicket = ticket;
      }
      return ticket === latest ? saved : null;
    },
    fail(ticket: number) {
      inFlight.delete(ticket);
      return ticket === latest ? confirmed : null;
    },
  };
}
