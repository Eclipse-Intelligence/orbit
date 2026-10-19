import type { MailSourceStatus } from "@/lib/mail/store";

function count(value: number) {
  return new Intl.NumberFormat("en-GB").format(value);
}

export default function MailMirrorStatus({ sources }: { sources: MailSourceStatus[] }) {
  if (sources.length === 0) return null;
  return (
    <section aria-label="Mail sync" className="flex max-w-[640px] flex-col gap-3">
      {sources.map((source) => {
        const total = Math.max(source.total, source.stored);
        const share = total > 0 ? Math.min(1, source.stored / total) : 1;
        const complete = source.folders.every((folder) => folder.state === "live");
        const paused = source.folders.find((folder) => folder.error?.startsWith("Paused"))?.error ?? null;
        return (
          <div key={source.email} className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-3">
              <span className="truncate text-[14px] leading-5">{source.email}</span>
              <span className="caption-style text-subtle shrink-0">
                {complete ? `${count(source.stored)} emails, up to date` : `${count(source.stored)} of ${count(total)} emails`}
              </span>
            </div>
            <div
              role="progressbar"
              aria-label={`Mail sync for ${source.email}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(share * 100)}
              className="h-1 overflow-hidden rounded-full bg-white/[0.06]"
            >
              <div className="bg-primary/70 h-full rounded-full" style={{ width: `${share * 100}%` }} />
            </div>
            {(source.lastError || paused) && (
              <p role="alert" className="caption-style text-danger">
                {source.lastError ?? paused}
              </p>
            )}
          </div>
        );
      })}
    </section>
  );
}
