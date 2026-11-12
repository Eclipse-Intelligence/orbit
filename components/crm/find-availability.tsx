"use client";

import { createContext, useContext, type ReactNode } from "react";

export type FindAvailability = { phone: boolean; email: boolean };

const FindAvailabilityContext = createContext<FindAvailability>({ phone: false, email: false });

export function FindAvailabilityProvider({ value, children }: { value: FindAvailability; children: ReactNode }) {
  return <FindAvailabilityContext.Provider value={value}>{children}</FindAvailabilityContext.Provider>;
}

export function useFindAvailability() {
  return useContext(FindAvailabilityContext);
}
