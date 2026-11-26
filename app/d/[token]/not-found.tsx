export default function PublicDocNotFound() {
  return (
    <main className="bg-background flex min-h-dvh items-center justify-center px-4">
      <div className="flex max-w-[28em] flex-col items-center gap-2 text-center">
        <h2>Not found</h2>
        <p className="caption-style text-subtle">This page doesn&apos;t exist or isn&apos;t public.</p>
      </div>
    </main>
  );
}
