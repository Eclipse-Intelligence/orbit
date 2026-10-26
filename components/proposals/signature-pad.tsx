"use client";

import { useEffect, useRef, useState, type PointerEvent } from "react";
import { cn } from "@/lib/utils";

export type SignatureMode = "type" | "draw";

const INK = "#17171b";

export default function SignaturePad({
  mode,
  onMode,
  typed,
  onTyped,
  placeholder,
  onImage,
  fontClass,
  fieldClass,
  describedBy,
}: {
  mode: SignatureMode;
  onMode: (mode: SignatureMode) => void;
  typed: string;
  onTyped: (value: string) => void;
  placeholder?: string;
  onImage: (image: string | null) => void;
  fontClass: string;
  fieldClass: string;
  describedBy?: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [inked, setInked] = useState(false);

  useEffect(() => {
    if (mode !== "draw") return;
    const element = canvas.current;
    if (!element) return;
    const ratio = window.devicePixelRatio || 1;
    const { width, height } = element.getBoundingClientRect();
    element.width = Math.round(width * ratio);
    element.height = Math.round(height * ratio);
    const context = element.getContext("2d");
    if (!context) return;
    context.scale(ratio, ratio);
    context.lineCap = "round";
    context.lineJoin = "round";
    context.lineWidth = 2.4;
    context.strokeStyle = INK;
  }, [mode]);

  function point(event: PointerEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function down(event: PointerEvent<HTMLCanvasElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    drawing.current = true;
    last.current = point(event);
    const context = event.currentTarget.getContext("2d");
    if (!context) return;
    context.beginPath();
    context.arc(last.current.x, last.current.y, 1.1, 0, Math.PI * 2);
    context.fillStyle = INK;
    context.fill();
  }

  function move(event: PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current || !last.current) return;
    const context = event.currentTarget.getContext("2d");
    if (!context) return;
    const next = point(event);
    const mid = { x: (last.current.x + next.x) / 2, y: (last.current.y + next.y) / 2 };
    context.beginPath();
    context.moveTo(last.current.x, last.current.y);
    context.quadraticCurveTo(last.current.x, last.current.y, mid.x, mid.y);
    context.lineTo(next.x, next.y);
    context.stroke();
    last.current = next;
  }

  function up() {
    if (!drawing.current) return;
    drawing.current = false;
    last.current = null;
    setInked(true);
    onImage(canvas.current?.toDataURL("image/png") ?? null);
  }

  function clear() {
    const element = canvas.current;
    const context = element?.getContext("2d");
    if (element && context) context.clearRect(0, 0, element.width, element.height);
    setInked(false);
    onImage(null);
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[14px] font-medium">Signature</span>
        <div role="group" aria-label="How to sign" className="bg-secondary flex rounded-full p-0.5 text-[13px]">
          {(["type", "draw"] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={mode === option}
              onClick={() => onMode(option)}
              className={cn(
                "focus-visible:ring-ring/60 rounded-full px-3 py-1 outline-none transition-colors duration-150 focus-visible:ring-2",
                mode === option ? "bg-card text-foreground shadow-[0_0_0_1px_rgba(0,0,0,0.06)]" : "text-subtle hover:text-foreground",
              )}
            >
              {option === "type" ? "Type" : "Draw"}
            </button>
          ))}
        </div>
      </div>
      {mode === "type" ? (
        <input
          className={cn(fieldClass, "h-16 text-[30px]", fontClass)}
          value={typed}
          onChange={(event) => onTyped(event.target.value)}
          placeholder={placeholder}
          aria-label="Type your name to sign"
          aria-describedby={describedBy}
          required
          maxLength={200}
        />
      ) : (
        <div className="relative">
          <canvas
            ref={canvas}
            aria-label="Draw your signature"
            aria-describedby={describedBy}
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={up}
            className="h-36 w-full cursor-crosshair touch-none rounded-xl bg-white shadow-[0_0_0_1px_var(--input)]"
          />
          {!inked && <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-[14px] text-[#8a8a90]">Sign here</span>}
          {inked && (
            <button type="button" onClick={clear} className="focus-visible:ring-ring/60 absolute top-2 right-2 rounded-full px-2.5 py-1 text-[12.5px] text-[#6b6b73] outline-none hover:text-[#17171b] focus-visible:ring-2">
              Clear
            </button>
          )}
        </div>
      )}
    </div>
  );
}
