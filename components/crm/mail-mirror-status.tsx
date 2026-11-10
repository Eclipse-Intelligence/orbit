import type { MailSourceStatus } from "@/lib/mail/store";

function count(value: number) {
  return new Intl.NumberFormat("en-GB").format(value);
}

export default function MailMirrorProgress({ source }: { source: MailSourceStatus }) {
  const total = Math.max(source.total, source.stored);
  const share = total > 0 ? Math.min(1, source.stored / total) : 1;
  const complete = source.folders.every((folder) => folder.state === "live");
  const paused = source.folders.find((folder) => folder.error?.startsWith("Paused"))?.error ?? null;
  return (
    <div className="flex flex-col gap-1.5">
      <span className="caption-style text-subtle">
        {complete ? `${count(source.stored)} emails, up to date` : `${count(source.stored)} of ${count(total)} emails`}
      </span>
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
      {paused && (
        <p role="alert" className="caption-style text-danger">
          {paused}
        </p>
      )}
    </div>
  );
}
