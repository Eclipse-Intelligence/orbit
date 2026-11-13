"use client";

import Button from "@/components/_ui/button";
import { askOrbit } from "@/components/assistant/ask-orbit";
import { useComposer } from "@/components/mail/compose-dock";
import { cn } from "@/lib/utils";
import { focusOnPage } from "@/stores/page-context-store";
import SparkleIcon from "@/public/assets/images/assistant/sparkle.svg";

export default function TaskAskButton({ taskId, variant, className }: { taskId: string; variant: "secondary" | "ghost"; className?: string }) {
  const composer = useComposer();

  function ask() {
    focusOnPage("task", taskId);
    if (!askOrbit("")) composer.showToast({ message: "Ask Orbit isn't available here.", tone: "alert" });
  }

  return (
    <Button variant={variant} size="md" onClick={ask} aria-haspopup="dialog" className={cn("hit", className)}>
      <SparkleIcon aria-hidden className="size-3.5" />
      Ask Orbit
    </Button>
  );
}
