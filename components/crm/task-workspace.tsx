"use client";

import { createContext, useContext, type AnchorHTMLAttributes } from "react";
import Link from "next/link";
import { workspaceLink } from "@/lib/open-link";

export const HomeWorkspace = createContext<string | null>(null);
export const TaskWorkspace = createContext<string | null>(null);

export function useTaskRecordHref() {
  const home = useContext(HomeWorkspace);
  const task = useContext(TaskWorkspace);
  const elsewhere = Boolean(home && task && home !== task);
  return { elsewhere, href: (path: string) => (elsewhere && task ? workspaceLink(task, path, 2) : path) };
}

export function TaskRecordLink({ href, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const target = useTaskRecordHref();
  if (target.elsewhere) return <a href={target.href(href)} {...props} />;
  return <Link href={href} {...props} />;
}
