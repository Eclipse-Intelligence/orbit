import type { LiveEvent } from "@/lib/docs/live/protocol";

export type ChannelStatus = "joining" | "joined" | "closed";

export type ChannelHandlers = {
  message: (event: LiveEvent, payload: unknown) => void;
  status: (status: ChannelStatus) => void;
};

export type LiveChannel = {
  send: (event: LiveEvent, payload: unknown) => boolean;
  close: () => void;
};

export type LiveTransport = {
  open: (topic: string, handlers: ChannelHandlers) => LiveChannel;
};

type Member = { id: number; handlers: ChannelHandlers; joined: boolean };

export function memoryHub(options: { manual?: boolean } = {}) {
  const topics = new Map<string, Set<Member>>();
  const queue: (() => void)[] = [];
  const blocked = new Set<number>();
  let nextId = 1;
  let draining = false;

  function schedule(task: () => void) {
    queue.push(task);
    if (options.manual || draining) return;
    draining = true;
    queueMicrotask(() => {
      flush();
      draining = false;
    });
  }

  function flush() {
    let guard = 0;
    while (queue.length > 0 && guard < 100_000) {
      queue.shift()!();
      guard += 1;
    }
  }

  function transport(): LiveTransport & { id: number } {
    const id = nextId++;
    return {
      id,
      open(topic, handlers) {
        const member: Member = { id, handlers, joined: false };
        const members = topics.get(topic) ?? new Set<Member>();
        topics.set(topic, members);
        members.add(member);
        handlers.status("joining");
        schedule(() => {
          if (!members.has(member) || blocked.has(id)) return;
          member.joined = true;
          handlers.status("joined");
        });
        return {
          send(event, payload) {
            if (!member.joined || blocked.has(id)) return false;
            const copy = JSON.parse(JSON.stringify(payload)) as unknown;
            for (const other of members) {
              if (other === member) continue;
              schedule(() => {
                if (other.joined && members.has(other) && !blocked.has(other.id)) other.handlers.message(event, copy);
              });
            }
            return true;
          },
          close() {
            members.delete(member);
            member.joined = false;
          },
        };
      },
    };
  }

  function publish(topic: string, event: LiveEvent, payload: unknown) {
    const members = topics.get(topic);
    if (!members) return;
    const copy = JSON.parse(JSON.stringify(payload)) as unknown;
    for (const member of members) {
      schedule(() => {
        if (member.joined && !blocked.has(member.id)) member.handlers.message(event, copy);
      });
    }
  }

  function disconnect(id: number) {
    blocked.add(id);
    for (const members of topics.values()) {
      for (const member of members) {
        if (member.id === id && member.joined) {
          member.joined = false;
          member.handlers.status("closed");
        }
      }
    }
  }

  function reconnect(id: number) {
    blocked.delete(id);
    for (const members of topics.values()) {
      for (const member of members) {
        if (member.id === id && !member.joined) {
          schedule(() => {
            member.joined = true;
            member.handlers.status("joined");
          });
        }
      }
    }
  }

  return { transport, publish, flush, disconnect, reconnect, pending: () => queue.length };
}
