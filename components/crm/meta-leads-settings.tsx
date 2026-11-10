"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import CopyButton from "@/components/_ui/copy-button";
import HoldButton from "@/components/_ui/hold-button";
import { Input } from "@/components/_ui/input";
import { SettingsCard } from "@/components/crm/settings-ui";
import { linkMetaPageAction, unlinkMetaPageAction, type MetaLeadActionState } from "@/app/(crm)/settings/actions";
import { formatWhen } from "@/lib/companies";
import type { MetaLeadSettingsView } from "@/lib/crm/meta-leads";
import { cn, GENERIC_ERROR } from "@/lib/utils";

function Status({ on, children }: { on: boolean; children: ReactNode }) {
  return (
    <span className="flex items-center gap-1.5">
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", on ? "bg-success" : "bg-faint")} />
      {children}
    </span>
  );
}

function leadCount(count: number) {
  return count === 1 ? "1 lead" : `${count.toLocaleString("en-GB")} leads`;
}

export default function MetaLeadsSettings({ view, canAdmin }: { view: MetaLeadSettingsView; canAdmin: boolean }) {
  const router = useRouter();
  const [pageId, setPageId] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<MetaLeadActionState>({});

  async function run(kind: string, action: () => Promise<MetaLeadActionState>) {
    setPending(kind);
    setOutcome({});
    const result = await action().catch((): MetaLeadActionState => ({ error: GENERIC_ERROR }));
    setPending(null);
    setOutcome(result);
    if (!result.error) {
      if (kind === "add") setPageId("");
      router.refresh();
    }
  }

  function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pageId.trim()) return;
    void run("add", () => linkMetaPageAction(pageId));
  }

  return (
    <SettingsCard
      id="meta-leads"
      title="Meta lead ads"
      description={
        <span className="flex flex-col gap-1.5">
          <span>Each Facebook or Instagram lead form submission becomes a contact.</span>
          {view.configured ? <Status on>Set up</Status> : <Status on={false}>{view.setupMessage}</Status>}
        </span>
      }
    >
      {canAdmin && (
        <div className="flex flex-col gap-1.5">
          <span className="caption-style text-subtle">Callback URL</span>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <code className="ui-style text-soft min-w-0 flex-1 wrap-anywhere">{view.endpoint}</code>
            <CopyButton text={view.endpoint} className="self-start sm:self-auto" />
          </div>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <h4 className="text-foreground leading-5">Pages</h4>
        {view.pages.length === 0 ? (
          <p className="caption-style text-subtle">No Pages linked.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {view.pages.map((page) => (
              <li key={page.id} className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="ui-style text-foreground wrap-anywhere">{page.pageName ?? `Page ${page.pageId}`}</span>
                  <span className="caption-style text-subtle wrap-anywhere">
                    {[page.pageName ? page.pageId : null, leadCount(page.leads), page.lastRunAt ? `Checked ${formatWhen(page.lastRunAt)}` : "Not checked yet"]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                  {page.lastError && (
                    <span className="caption-style text-danger" role="alert">
                      {page.lastError}
                    </span>
                  )}
                </span>
                {canAdmin && (
                  <HoldButton className="self-start sm:self-auto" disabled={pending !== null} onConfirm={() => void run(`remove:${page.id}`, () => unlinkMetaPageAction(page.id))}>
                    Hold to remove<span className="sr-only"> {page.pageName ?? page.pageId}</span>
                  </HoldButton>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {canAdmin ? (
        <form className="flex flex-col gap-2 sm:flex-row sm:items-end" onSubmit={add}>
          <label className="flex min-w-0 flex-1 flex-col gap-1.5" htmlFor="meta-page-id">
            <span className="caption-style text-subtle">Facebook Page ID</span>
            <Input
              id="meta-page-id"
              inputMode="numeric"
              autoComplete="off"
              value={pageId}
              maxLength={40}
              onChange={(event) => setPageId(event.target.value)}
              placeholder="123456789012345"
            />
          </label>
          <Button variant="primary" size="sm" type="submit" className="self-start sm:self-auto" disabled={pending !== null || !pageId.trim()}>
            {pending === "add" ? "Adding…" : "Add"}
          </Button>
        </form>
      ) : (
        <p className="caption-style text-subtle">Only owners and admins can change Meta lead ads.</p>
      )}

      {outcome.error && (
        <p role="alert" className="caption-style text-danger">
          {outcome.error}
        </p>
      )}
      {outcome.message && (
        <p role="status" className="caption-style text-soft">
          {outcome.message}
        </p>
      )}

      {view.unlinked.length > 0 && (
        <div className="flex flex-col gap-2">
          <h4 className="text-foreground leading-5">Pages that aren&apos;t linked</h4>
          <ul className="flex flex-col gap-2">
            {view.unlinked.map((page) => (
              <li key={page.pageId} className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <span className="caption-style text-soft wrap-anywhere">
                  {[`Page ${page.pageId}`, leadCount(page.leads), page.lastAt ? `Last ${formatWhen(page.lastAt)}` : null].filter(Boolean).join(" · ")}
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  type="button"
                  className="self-start sm:self-auto"
                  disabled={pending !== null}
                  onClick={() => void run(`link:${page.pageId}`, () => linkMetaPageAction(page.pageId))}
                >
                  Link<span className="sr-only"> Page {page.pageId}</span>
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </SettingsCard>
  );
}
