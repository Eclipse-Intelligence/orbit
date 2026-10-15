"use client";

import { useState, useSyncExternalStore, type CSSProperties } from "react";
import { cn } from "@/lib/utils";

const REDUCED = "(prefers-reduced-motion: reduce)";

function subscribe(onChange: () => void) {
  const query = window.matchMedia(REDUCED);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function useReducedMotion() {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(REDUCED).matches,
    () => null,
  );
}

export function Aurora({ className }: { className?: string }) {
  return (
    <div aria-hidden className={cn("absolute inset-0 overflow-hidden bg-[#07070c]", className)}>
      <div className="animate-aurora-a absolute -top-[30%] -left-[20%] size-[85vmax] rounded-full bg-[radial-gradient(closest-side,rgba(88,64,255,0.75),transparent)] blur-3xl motion-reduce:animate-none" />
      <div className="animate-aurora-b absolute -right-[25%] -bottom-[35%] size-[90vmax] rounded-full bg-[radial-gradient(closest-side,rgba(22,200,158,0.45),transparent)] blur-3xl motion-reduce:animate-none" />
      <div className="animate-aurora-c absolute top-[10%] left-[25%] size-[60vmax] rounded-full bg-[radial-gradient(closest-side,rgba(219,61,170,0.42),transparent)] blur-3xl motion-reduce:animate-none" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(255,255,255,0.06),transparent_60%)]" />
    </div>
  );
}

function Still({ src }: { src: string }) {
  return (
    <div
      aria-hidden
      style={{ "--poster": `url("${src}")` } as CSSProperties}
      className="absolute inset-0 bg-(image:--poster) bg-cover bg-center"
    />
  );
}

export default function BookingBackground({
  videoUrl,
  posterUrl,
}: {
  videoUrl: string | null;
  posterUrl: string | null;
}) {
  const reduced = useReducedMotion();
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const playVideo = Boolean(videoUrl) && !failed && reduced === false;

  return (
    <div aria-hidden className="fixed inset-0 -z-10 overflow-hidden bg-[#07070c]">
      {posterUrl ? <Still src={posterUrl} /> : <Aurora />}
      {playVideo && (
        <video
          key={videoUrl}
          src={videoUrl!}
          autoPlay
          muted
          loop
          playsInline
          preload="auto"
          poster={posterUrl ?? undefined}
          disablePictureInPicture
          disableRemotePlayback
          onPlaying={() => setReady(true)}
          onError={() => setFailed(true)}
          className={cn(
            "absolute inset-0 size-full object-cover transition-opacity duration-700 ease-power2-out",
            ready ? "opacity-100" : "opacity-0",
          )}
        />
      )}
      <div className="absolute inset-0 bg-black/25" />
      <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(0,0,0,0)_35%,rgba(0,0,0,0.45)_100%)] max-lg:bg-[linear-gradient(180deg,rgba(0,0,0,0)_0%,rgba(0,0,0,0.55)_45%)]" />
    </div>
  );
}
