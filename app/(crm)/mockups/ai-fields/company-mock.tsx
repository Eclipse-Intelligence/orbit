"use client";

import { useId } from "react";
import Button from "@/components/_ui/button";
import { NativeSelect } from "@/components/_ui/native-select";
import { lifecycleTagBase, RecordTag } from "@/components/beautifui/record-marks";
import DetailSection from "@/components/companies/detail/detail-section";
import { Detail, DetailList } from "@/components/crm/record-form";
import RecordLayout from "@/components/crm/record-layout";
import SectionHeader from "@/components/crm/section-header";
import type { Viewer } from "@/components/crm/viewer";
import RefreshIcon from "@/public/assets/images/mail/refresh.svg";
import { SourceList } from "./ai-cells";
import { NORTHLIGHT_GEO } from "./mock-data";

function AiDetail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="caption-style text-subtle leading-5">
        {label}
      </dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

function AiFields() {
  const typeId = useId();
  return (
    <DetailSection
      title="AI fields"
      action={
        <Button variant="ghost" size="sm">
          <RefreshIcon aria-hidden className="size-3" />
          Check again
        </Button>
      }
    >
      <dl className="grid grid-cols-[6em_1fr] gap-x-3 gap-y-3 text-[14px] leading-5">
        <AiDetail label="ICP fit">
          <span className="flex flex-col gap-0.5">
            <span>Strong fit, 3.6 of 4</span>
            <span className="caption-style text-subtle">3 sources · 3 Nov</span>
          </span>
        </AiDetail>
        <AiDetail label="Sells GEO">
          <span className="flex flex-col gap-1.5">
            <span>
              Yes <span className="caption-style text-subtle">{NORTHLIGHT_GEO.likely}% likely</span>
            </span>
            <span className="caption-style text-soft leading-[1.4]">{NORTHLIGHT_GEO.reason}</span>
            <details open className="caption-style text-subtle">
              <summary className="cursor-pointer rounded-sm outline-none select-none focus-visible:ring-2 focus-visible:ring-ring/60">3 sources · 3 Nov</summary>
              <div className="mt-1.5">
                <SourceList sources={NORTHLIGHT_GEO.sources} />
              </div>
            </details>
          </span>
        </AiDetail>
        <AiDetail label="Staff">
          <span className="flex flex-col gap-0.5">
            <span className="tabular-nums">9</span>
            <span className="caption-style text-subtle flex flex-wrap items-center gap-x-2">
              Set by you on 4 Nov, not checked again
              <Button variant="link" size="none" className="caption-style text-subtle">
                Use web answer
              </Button>
            </span>
          </span>
        </AiDetail>
        <AiDetail label="Agency type">
          <span className="flex flex-col gap-2">
            <label htmlFor={typeId} className="sr-only">
              Agency type
            </label>
            <NativeSelect id={typeId} defaultValue="SEO">
              <option>SEO</option>
              <option>PR</option>
              <option>Content</option>
              <option>Other</option>
              <option value="">Unknown</option>
            </NativeSelect>
            <span className="caption-style text-subtle">Web answer: SEO, 88% likely. Saving your own keeps it and stops checks.</span>
            <span className="flex justify-end gap-1">
              <Button variant="ghost" size="sm">
                Cancel
              </Button>
              <Button variant="secondary" size="sm">
                Save
              </Button>
            </span>
          </span>
        </AiDetail>
      </dl>
    </DetailSection>
  );
}

export default function CompanyMock({ viewer }: { viewer: Viewer }) {
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <SectionHeader
        title="Northlight SEO"
        viewer={viewer}
        list="companies"
        action={
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm">
              Archive
            </Button>
            <Button variant="primary" size="sm">
              Edit
            </Button>
          </div>
        }
      />
      <RecordLayout
        activityCount={2}
        summary={
          <div className="relative flex flex-col shadow-[inset_0_-1px_0_var(--line-strong)]">
            <div className="flex items-start gap-3 p-5">
              <span className="bg-muted flex size-[50px] shrink-0 items-center justify-center overflow-hidden rounded-[12.5px] shadow-[0px_6.25px_6.25px_0px_rgba(15,15,15,0.24),0px_0px_0px_1.563px_#232323]">
                <span aria-hidden className="h2-style text-soft">
                  N
                </span>
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-2 pt-1">
                <h2 className="truncate leading-6">Northlight SEO</h2>
                <span className="caption-style text-soft flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="underline decoration-white/35 underline-offset-[3px]">northlightseo.co.uk</span>
                  <span className="text-subtle">Updated 4 Nov 2026</span>
                </span>
                <span className="flex flex-wrap gap-1">
                  <RecordTag label="agency" />
                </span>
              </div>
            </div>
          </div>
        }
        details={
          <>
            <AiFields />
            <DetailSection title="Details">
              <DetailList>
                <Detail label="Domain">northlightseo.co.uk</Detail>
                <Detail label="Lifecycle">
                  <RecordTag label="Prospect" base={lifecycleTagBase("prospect")} />
                </Detail>
                <Detail label="Industry">Agency</Detail>
                <Detail label="Size">11-50</Detail>
                <Detail label="Owner">Mark Ridgeon</Detail>
              </DetailList>
            </DetailSection>
          </>
        }
        activity={
          <div className="flex flex-col gap-4 p-5">
            <h4 className="eyebrow-style font-normal">Activity</h4>
            <ul className="flex flex-col gap-3">
              {[
                { title: "Email from Priya Shah", when: "4 Nov" },
                { title: "Intro call with Priya Shah", when: "22 Oct" },
              ].map((item) => (
                <li key={item.title} className="flex items-center justify-between gap-3">
                  <span className="text-[14px] leading-5">{item.title}</span>
                  <span className="caption-style text-subtle shrink-0">{item.when}</span>
                </li>
              ))}
            </ul>
          </div>
        }
      />
    </section>
  );
}
