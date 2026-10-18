"use client";

import { useRef, useState, useSyncExternalStore } from "react";

type RecognitionResult = { isFinal: boolean; 0: { transcript: string } };
type RecognitionEvent = { resultIndex: number; results: ArrayLike<RecognitionResult> };
type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: RecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  start: () => void;
  stop: () => void;
};
type RecognitionConstructor = new () => Recognition;

function recognitionClass(): RecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const scope = window as unknown as { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

const noop = () => () => {};

export function useDictation(onFinal: (text: string) => void) {
  const supported = useSyncExternalStore(noop, () => recognitionClass() !== null, () => false);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const active = useRef<Recognition | null>(null);

  function start() {
    const Klass = recognitionClass();
    if (!Klass || active.current) return;
    const recognition = new Klass();
    recognition.lang = "en-GB";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = (event) => {
      let pending = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const text = result[0].transcript;
        if (result.isFinal) onFinal(text.trim());
        else pending += text;
      }
      setInterim(pending.trim());
    };
    recognition.onerror = (event) => {
      setError(event.error === "not-allowed" ? "Allow microphone access to dictate." : "Dictation stopped.");
    };
    recognition.onend = () => {
      active.current = null;
      setListening(false);
      setInterim("");
    };
    active.current = recognition;
    setError(null);
    setListening(true);
    recognition.start();
  }

  function stop() {
    active.current?.stop();
  }

  return { supported, listening, interim, error, start, stop, toggle: () => (active.current ? stop() : start()) };
}
