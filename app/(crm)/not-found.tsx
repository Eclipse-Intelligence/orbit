import Button from "@/components/_ui/button";
import { getWorkspaceChoices } from "@/lib/auth/user";

export default async function CrmNotFound() {
  const workspaces = await getWorkspaceChoices();
  return (
    <section className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
      <h1>Record not found</h1>
      {workspaces.length > 1 && <p className="text-muted-foreground max-w-[36em]">It may be in another workspace.</p>}
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
