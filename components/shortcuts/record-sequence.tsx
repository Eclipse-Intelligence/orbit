"use client";

import { usePathname, useRouter } from "next/navigation";
import { readListSequence } from "@/components/shortcuts/keyboard-list";
import { useShortcut } from "@/components/shortcuts/shortcuts-provider";

export default function RecordSequence() {
  const pathname = usePathname();
  const router = useRouter();

  function step(delta: number) {
    const hrefs = readListSequence();
    const index = hrefs.indexOf(pathname);
    if (index < 0) return false;
    const next = hrefs[index + delta];
    if (next) router.push(next);
  }

  useShortcut("record-next", () => step(1));
  useShortcut("record-prev", () => step(-1));
  return null;
}
