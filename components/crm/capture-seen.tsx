"use client";

import { useEffect } from "react";
import { useCompaniesStore } from "@/stores/companies-store";

export default function CaptureSeen({ newestAt }: { newestAt: string | null }) {
  const setCaptureSeen = useCompaniesStore((state) => state.setCaptureSeen);
  useEffect(() => {
    setCaptureSeen(newestAt);
  }, [newestAt, setCaptureSeen]);
  return null;
}
