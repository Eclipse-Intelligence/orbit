export default function ProposalNotFound() {
  return (
    <main className="paper flex min-h-dvh items-center justify-center px-6">
      <div className="flex max-w-[28em] flex-col gap-3 text-center">
        <h1 className="doc-heading">This link isn&apos;t valid</h1>
        <p className="doc-body text-soft">Ask the sender for a new link.</p>
      </div>
    </main>
  );
}
