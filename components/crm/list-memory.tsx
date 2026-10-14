"use client";

import { useEffect, useSyncExternalStore } from "react";
import { useSearchParams } from "next/navigation";
import { listHref, listQuery, type RecordListKey } from "@/lib/crm/hrefs";

function storageKey(list: RecordListKey) {
  return `orbit:list:${list}`;
}

function readStored(list: RecordListKey) {
  try {
    return window.sessionStorage.getItem(storageKey(list));
  } catch {
    return null;
  }
}

function subscribe() {
  return () => {};
}

export function RememberList({ list }: { list: RecordListKey }) {
  const searchParams = useSearchParams();
  const query = listQuery(searchParams.toString());

  useEffect(() => {
    try {
      window.sessionStorage.setItem(storageKey(list), query);
    } catch {
      return;
    }
  }, [list, query]);

  return null;
}

export function useListHref(list: RecordListKey) {
  const stored = useSyncExternalStore(
    subscribe,
    () => readStored(list),
    () => null,
  );
  return listHref(list, stored);
}
