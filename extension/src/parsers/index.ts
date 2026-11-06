import type { PageCompany, PagePerson } from "../../../lib/extension/protocol";
import { readCompany } from "./company";
import { readLead } from "./lead";
import { readProfile } from "./profile";
import { readPartner, readThread, type PageThread, type ThreadPartner } from "./thread";

export { parseWhen } from "./thread";
export { readCompany, readLead, readPartner, readProfile, readThread };
export type { PageThread, ThreadPartner };

export type ReadWhat = "profile" | "lead" | "company" | "thread-person" | "thread";

export type ReadResult =
  | { what: "profile" | "lead"; person: PagePerson }
  | { what: "company"; company: PageCompany }
  | { what: "thread-person"; partner: ThreadPartner }
  | { what: "thread"; thread: PageThread };

export function readPage(root: ParentNode, url: string, what: ReadWhat): ReadResult {
  switch (what) {
    case "profile":
      return { what, person: readProfile(root, url) };
    case "lead":
      return { what, person: readLead(root, url) };
    case "company":
      return { what, company: readCompany(root, url) };
    case "thread-person":
      return { what, partner: readPartner(root, url) };
    case "thread":
      return { what, thread: readThread(root, url) };
  }
}
