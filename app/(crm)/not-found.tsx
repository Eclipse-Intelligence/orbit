import Button from "@/components/_ui/button";

export default function CrmNotFound() {
  return (
    <section className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
      <h1>Record not found</h1>
      <p className="text-muted-foreground max-w-[36em]">
        It may have been removed, or it belongs to another workspace.
      </p>
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="md" href="/">
          Companies
        </Button>
        <Button variant="secondary" size="md" href="/contacts">
          Contacts
        </Button>
      </div>
    </section>
  );
}
