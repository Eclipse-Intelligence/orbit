"use client";

import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { DocsContext } from "@/components/docs/use-docs";
import type { ChatPerson, ChatTyping } from "@/lib/chat/types";

const SEND_GAP_MS = 3_000;
const SHOWN_MS = 6_000;

type Typer = { name: string; at: number };

export function useTyping(conversationId: string, viewer: ChatPerson, members: Map<string, string> | null) {
  const live = useContext(DocsContext)?.seed?.live ?? null;
  const [typers, setTypers] = useState<Record<string, Typer>>({});
  const channel = useRef<{ send: (typing: ChatTyping) => boolean; close: () => void } | null>(null);
  const sent = useRef({ typing: false, at: 0 });
  const allowed = useRef(members);
  useEffect(() => {
    allowed.current = members;
  });

  useEffect(() => {
    if (!live) return;
    let stopped = false;
    void import("@/lib/docs/live/client")
      .then((module) =>
        module.openChatTyping(live, conversationId, (typing) => {
          if (typing.user.id === viewer.id) return;
          const name = allowed.current?.get(typing.user.id);
          if (!name) return;
          setTypers((current) => {
            const next = { ...current };
            if (typing.typing) next[typing.user.id] = { name, at: Date.now() };
            else delete next[typing.user.id];
            return next;
          });
        }),
      )
      .then((opened) => {
        if (stopped) opened.close();
        else channel.current = opened;
      })
      .catch(() => undefined);
    return () => {
      stopped = true;
      channel.current?.close();
      channel.current = null;
      sent.current = { typing: false, at: 0 };
      setTypers({});
    };
  }, [live, conversationId, viewer.id]);

  useEffect(() => {
    if (Object.keys(typers).length === 0) return;
    const timer = window.setInterval(() => {
      setTypers((current) => {
        const fresh = Object.entries(current).filter(([, typer]) => Date.now() - typer.at < SHOWN_MS);
        return fresh.length === Object.keys(current).length ? current : Object.fromEntries(fresh);
      });
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [typers]);

  const send = useCallback(
    (typing: boolean) => {
      const now = Date.now();
      if (typing && sent.current.typing && now - sent.current.at < SEND_GAP_MS) return;
      if (!typing && !sent.current.typing) return;
      sent.current = { typing, at: now };
      channel.current?.send({ conversationId, user: { id: viewer.id, name: viewer.name }, typing });
    },
    [conversationId, viewer.id, viewer.name],
  );

  const stopped = useCallback((userId: string | null) => {
    if (!userId) return;
    setTypers((current) => {
      if (!(userId in current)) return current;
      const next = { ...current };
      delete next[userId];
      return next;
    });
  }, []);

  const names = Object.values(typers).map((typer) => typer.name.split(/\s+/)[0] || typer.name);
  return { names, send, stopped };
}
