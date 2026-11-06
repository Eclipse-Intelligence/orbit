"use server";

import { getUserActor } from "@/lib/auth/user";
import { CrmError } from "@/lib/crm/errors";
import { decidePairing } from "@/lib/extension/pairing";

export async function decideExtensionAction(input: { code: string; name?: string; workspaceIds?: string[]; approve: boolean }): Promise<{ error?: string; status?: string }> {
  const user = await getUserActor();
  if (!user) return { error: "Sign in to Orbit first." };
  try {
    return { status: await decidePairing(user, input) };
  } catch (error) {
    return { error: error instanceof CrmError ? error.message : "Couldn't connect the extension. Try again." };
  }
}
