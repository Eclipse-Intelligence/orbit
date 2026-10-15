"use client";

import { useEffect } from "react";
import { reloadIfStaleDeploy } from "@/lib/stale-deploy";

export default function StaleDeployReload() {
  useEffect(() => {
    function handleRejection(event: PromiseRejectionEvent) {
      if (reloadIfStaleDeploy(event.reason)) event.preventDefault();
    }

    window.addEventListener("unhandledrejection", handleRejection);
    return () => window.removeEventListener("unhandledrejection", handleRejection);
  }, []);

  return null;
}
