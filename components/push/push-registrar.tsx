"use client";

import { useEffect } from "react";
import { refreshPush, registerServiceWorker } from "@/components/push/push-client";

export default function PushRegistrar() {
  useEffect(() => {
    void registerServiceWorker().then(() => refreshPush());
  }, []);
  return null;
}
