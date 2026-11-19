"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import type { PadAiParse, PadReadBody } from "@/lib/crm/task-pad";
import { londonParts } from "@/lib/task-pad";

export const AI_READ_PATH = "/api/tasks/read";
const padAi: { available: boolean | null } = { available: null };

function readKey(value: string) {
  const now = londonParts(new Date());
  return `${now.year}-${now.month}-${now.day}T${now.hour}|${value}`;
}

export type PadAiAnswer = { text: string; value: PadAiParse };

type LatestRead = RefObject<(value: string) => Promise<PadAiParse | null>>;

export function usePadAiRead() {
  const [ai, setAi] = useState<PadAiAnswer | null>(null);
  const [readingTexts, setReadingTexts] = useState<{ id: number; text: string }[]>([]);
  const readIds = useRef(0);
  const aiReads = useRef(new Map<string, { promise: Promise<PadAiParse | null>; controller: AbortController }>());
  const answers = useRef(new Map<string, PadAiParse>());
  const latestRead: LatestRead = useRef<(value: string) => Promise<PadAiParse | null>>(async () => null);

  function readWithAi(value: string): Promise<PadAiParse | null> {
    const apply = (found: PadAiParse | null) => {
      if (found) setAi((current) => (current?.text === value && current.value === found ? current : { text: value, value: found }));
      return found;
    };
    if (padAi.available === false) return Promise.resolve(null);
    const key = readKey(value);
    const answered = answers.current.get(key);
    if (answered) return Promise.resolve(apply(answered));
    const known = aiReads.current.get(key);
    if (known) return known.promise.then(apply);
    const controller = new AbortController();
    readIds.current += 1;
    const id = readIds.current;
    setReadingTexts((current) => [...current, { id, text: value }]);
    const promise = fetch(AI_READ_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: value }),
      signal: controller.signal,
    })
      .then((response) => (response.ok ? (response.json() as Promise<PadReadBody>) : null))
      .catch(() => null)
      .then((body) => {
        if (aiReads.current.get(key)?.controller === controller) aiReads.current.delete(key);
        setReadingTexts((current) => current.filter((entry) => entry.id !== id));
        if (body?.available === false) padAi.available = false;
        const found = controller.signal.aborted ? null : (body?.value ?? null);
        if (found) answers.current.set(key, found);
        return found;
      });
    aiReads.current.set(key, { promise, controller });
    return promise.then(apply);
  }

  function forgetAiReads() {
    for (const read of aiReads.current.values()) read.controller.abort();
    aiReads.current.clear();
    answers.current.clear();
    setReadingTexts([]);
  }

  useEffect(() => {
    latestRead.current = readWithAi;
  });

  useEffect(() => {
    const reads = aiReads.current;
    return () => {
      for (const read of reads.values()) read.controller.abort();
      reads.clear();
    };
  }, []);

  return { ai, setAi, readingTexts, forgetAiReads, latestRead };
}

export function useReadWhenUnsure(latestRead: LatestRead, text: string, unsure: boolean) {
  useEffect(() => {
    if (!unsure || text.trim().length < 4 || padAi.available === false) return;
    const timer = window.setTimeout(() => void latestRead.current(text), 700);
    return () => window.clearTimeout(timer);
  }, [latestRead, text, unsure]);
}
