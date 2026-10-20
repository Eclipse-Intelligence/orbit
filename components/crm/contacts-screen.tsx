"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import FilterMenu from "@/components/_common/filter-menu";
import Button from "@/components/_ui/button";
import { EntityChip, Monogram } from "@/components/beautifui/record-marks";
import BulkActions, {
  type BulkExtraAction,
  RowCheckbox,
  SelectAllCheckbox,
  SelectToggle,
} from "@/components/crm/bulk-bar";
import { ContactAdder } from "@/components/crm/inline-adders";
import FindDetailButton, { bulkFindSummary, findDetailsInBatches } from "@/components/crm/find-detail";
import { PresenceFilter, SortHeader, useListParams, type PresenceField } from "@/components/crm/list-controls";
import { RememberList } from "@/components/crm/list-memory";
import Pager from "@/components/crm/pager";
import RecordTransfer from "@/components/crm/record-transfer";
import SectionHeader from "@/components/crm/section-header";
import KeyboardList from "@/components/shortcuts/keyboard-list";
import ListSearch from "@/components/shortcuts/list-search";
import { CallLink, RecordList } from "@/components/crm/record-form";
import { ANY_TAG, RowTags, tagFilterOptions, useTagHref } from "@/components/crm/tags";
import type { Viewer } from "@/components/crm/viewer";
import {
  archiveContactsAction,
  exportSelectedContactsAction,
  unarchiveContactsAction,
} from "@/app/(crm)/bulk";
import { bulkAddTagAction, bulkRemoveTagAction } from "@/app/(crm)/tags";
import { useBulkSelection } from "@/hooks/use-bulk-selection";
import { companyHref, contactHref } from "@/lib/crm/hrefs";
import type { Recipient } from "@/lib/crm/personalise";
import type { Contact, ContactPresence, ContactSort, TagCount } from "@/lib/crm/types";
import { DEFAULT_CONTACT_SORT, defaultContactOrder, nextSort, type SortOrder } from "@/lib/sorting";
import type { ContactLookups } from "@/lib/enrichment/contacts";
import type { ContactField } from "@/lib/enrichment/providers";
import type { EnrichmentAvailability } from "@/lib/enrichment/settings";
import { KEYBOARD_ROW_CLASS } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";

const GRID_CLASS =
  "md:grid md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1fr)] md:gap-4";

const PRESENCE_FIELDS: PresenceField<ContactPresence>[] = [
  { key: "email", label: "Email", has: "Has email", missing: "No email" },
  { key: "phone", label: "Phone", has: "Has phone", missing: "No phone" },
  { key: "linkedin", label: "LinkedIn", has: "Has LinkedIn", missing: "No LinkedIn" },
  { key: "company", label: "Company", has: "Has company", missing: "No company" },
];

const MOBILE_SORTS: { value: string; label: string; sort: ContactSort; order: SortOrder }[] = [
  { value: "name:asc", label: "Name A to Z", sort: "name", order: "asc" },
  { value: "name:desc", label: "Name Z to A", sort: "name", order: "desc" },
  { value: "company:asc", label: "Company A to Z", sort: "company", order: "asc" },
  { value: "company:desc", label: "Company Z to A", sort: "company", order: "desc" },
  { value: "updated:desc", label: "Recently updated", sort: "updated", order: "desc" },
  { value: "created:desc", label: "Newest", sort: "created", order: "desc" },
];

type ContactListView = { sort: ContactSort; order: SortOrder; has: ContactPresence[]; missing: ContactPresence[] };

function recipientOf(contact: Contact): Recipient {
  return {
    id: contact.id,
    firstName: contact.firstName,
    lastName: contact.lastName,
    name: contact.name,
    email: contact.email,
    company: contact.companyName,
  };
}

export default function ContactsScreen({
  viewer,
  contacts,
  total,
  page,
  query,
  tag,
  tags,
  mailboxConnected,
  enrichment,
  view,
}: {
  viewer: Viewer;
  contacts: Contact[];
  total: number;
  page: number;
  query: string;
  tag: string;
  tags: TagCount[];
  mailboxConnected: boolean;
  enrichment: { available: EnrichmentAvailability; lookups: ContactLookups };
  view: ContactListView;
}) {
  const router = useRouter();
  const tagHref = useTagHref();
  const replaceParams = useListParams();
  const selection = useBulkSelection(
    contacts.map((contact) => contact.id),
    `${page}|${query}|${tag}|${view.sort}|${view.order}|${view.has.join()}|${view.missing.join()}`,
  );
  const sortBy = (column: ContactSort) =>
    replaceParams(nextSort(column, view, { sort: DEFAULT_CONTACT_SORT, order: defaultContactOrder }));
  const direction = (column: ContactSort) => (view.sort === column ? view.order : null);
  const filtering = view.has.length + view.missing.length > 0;
  const tagOptions = tagFilterOptions(tags, "contact", tag || undefined);
  const finders: BulkExtraAction[] = (["email", "linkedin", "phone"] as ContactField[])
    .filter((field) => enrichment.available[field])
    .map((field) => ({
      key: `find-${field}`,
      label: field === "email" ? "Find emails" : field === "linkedin" ? "Find LinkedIn" : "Find phones",
      title: field === "email" ? "Find missing work emails" : field === "linkedin" ? "Find missing LinkedIn profiles" : "Find missing phone numbers",
      ...(field === "phone"
        ? {
            confirm: (ids: string[]) => ({
              title: `Find phone numbers for ${ids.length} ${ids.length === 1 ? "person" : "people"}?`,
              description: `Enrow charges 40 credits for each number it finds, roughly $0.35 to $0.68 each, so up to ${ids.length * 40} credits. Nothing is charged when no number is found, and people who already have a phone are skipped.`,
              action: "Find phones",
            }),
          }
        : {}),
      run: async (ids, progress) => {
        const results = await findDetailsInBatches(ids, field, (done, found) =>
          progress(`Searching ${done}/${ids.length} · ${found} found`),
        );
        return bulkFindSummary(results, field);
      },
    }));

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <RememberList list="contacts" />
      <SectionHeader
        title="Contacts"
        viewer={viewer}
        action={
          <div className="flex items-center gap-1">
            <RecordTransfer resource="contacts" />
            <Button
              variant="primary"
              size="sm"
              data-shortcut="add-record"
              title="Add contact (C then C)"
              onClick={() => {
                const input = document.getElementById("inline-add-contact");
                input?.scrollIntoView({ block: "center" });
                input?.focus();
              }}
            >
              Add contact
            </Button>
          </div>
        }
      />
      <div className="flex items-center justify-between gap-2 px-4 py-4">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <ListSearch noun="contacts" />
          {tagOptions.length > 1 && (
            <FilterMenu
              label="Tag"
              shortcut="filter"
              value={tag || ANY_TAG}
              options={tagOptions}
              onChange={(value) =>
                router.replace(tagHref(value === ANY_TAG ? null : value), { scroll: false })
              }
            />
          )}
          <FilterMenu
            label="Sort"
            className="md:hidden"
            value={`${view.sort}:${view.order}`}
            options={MOBILE_SORTS.map(({ value, label }) => ({ value, label }))}
            onChange={(value) => {
              const chosen = MOBILE_SORTS.find((option) => option.value === value);
              if (!chosen) return;
              replaceParams({
                sort: chosen.sort === DEFAULT_CONTACT_SORT ? null : chosen.sort,
                order: chosen.order === defaultContactOrder(chosen.sort) ? null : chosen.order,
              });
            }}
          />
          <PresenceFilter
            fields={PRESENCE_FIELDS}
            shortcut={tagOptions.length > 1 ? undefined : "filter"}
            has={view.has}
            missing={view.missing}
            onChange={(has, missing) => replaceParams({ has: has.join(",") || null, missing: missing.join(",") || null })}
          />
        </div>
        <SelectToggle selection={selection} />
      </div>
      <p className="caption-style text-subtle px-4 pb-2">
        {total} {total === 1 ? "person" : "people"}
      </p>
      <KeyboardList sequence className="flex min-h-0 flex-1 flex-col">
      <RecordList
        count={contacts.length}
        footer={<ContactAdder />}
        empty={
          page > 1
            ? "No contacts on this page."
            : tag || query || filtering
              ? "No contacts match the current filters."
              : "No contacts yet. Add the person you need to speak with."
        }
      >
        <li
          className={cn(
            "caption-style text-subtle border-border group hidden border-b px-2.5 py-2",
            GRID_CLASS,
          )}
        >
          <span className="flex items-center gap-2.5">
            <span className="flex size-5 shrink-0 items-center justify-center">
              <SelectAllCheckbox
                selection={selection}
                label="Select all contacts on this page"
              />
            </span>
            <SortHeader label="Name" direction={direction("name")} onSort={() => sortBy("name")} />
          </span>
          <span>
            <SortHeader label="Company" direction={direction("company")} onSort={() => sortBy("company")} />
          </span>
          <span aria-hidden>Email</span>
          <span aria-hidden>Phone</span>
        </li>
        {contacts.map((contact) => (
          <ContactRow
            key={contact.id}
            contact={contact}
            selected={selection.isSelected(contact.id)}
            findEmail={enrichment.available.email}
            emailLookup={enrichment.lookups[contact.id]?.email}
            findPhone={enrichment.available.phone}
            phoneLookup={enrichment.lookups[contact.id]?.phone}
            revealed={selection.revealed}
            selecting={selection.selecting}
            onToggle={(range) => selection.toggle(contact.id, range)}
          />
        ))}
      </RecordList>
      </KeyboardList>
      <BulkActions
        selection={selection}
        noun={["contact", "contacts"]}
        archive={archiveContactsAction}
        unarchive={unarchiveContactsAction}
        exportRows={exportSelectedContactsAction}
        exportName="contacts"
        emailLabel="Email"
        recipients={(ids) =>
          contacts
            .filter((contact) => ids.includes(contact.id))
            .map(recipientOf)
        }
        mailboxConnected={mailboxConnected}
        extraActions={finders}
        tagging={{
          tags,
          selectedTags: (ids) => [
            ...new Set(
              contacts
                .filter((contact) => ids.includes(contact.id))
                .flatMap((contact) => contact.tags),
            ),
          ],
          add: (ids, name) => bulkAddTagAction("contact", ids, name),
          remove: (ids, name) => bulkRemoveTagAction("contact", ids, name),
        }}
      />
      <Pager
        page={page}
        count={contacts.length}
        total={total}
        noun={["person", "people"]}
      />
    </section>
  );
}

function ContactRow({
  contact,
  selected,
  findEmail,
  emailLookup,
  findPhone,
  phoneLookup,
  revealed,
  selecting,
  onToggle,
}: {
  contact: Contact;
  selected: boolean;
  findEmail: boolean;
  emailLookup?: ContactLookups[string]["email"];
  findPhone: boolean;
  phoneLookup?: ContactLookups[string]["phone"];
  revealed: boolean;
  selecting: boolean;
  onToggle: (range: boolean) => void;
}) {
  const company =
    contact.companyName && contact.companyId ? (
      <span className="relative z-10 min-w-0">
        <EntityChip
          name={contact.companyName}
          href={companyHref(contact.companyId)}
        />
      </span>
    ) : null;
  return (
    <li
      data-selected={selected}
      data-list-row=""
      data-row-href={contactHref(contact.id)}
      className={cn(
        KEYBOARD_ROW_CLASS,
        "border-border group relative flex min-h-12 items-center gap-3 border-b px-2.5 py-2 transition-colors duration-150 hover:bg-white/3 data-[selected=true]:bg-white/5",
        GRID_CLASS,
      )}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2.5">
        <span className="relative flex size-5 shrink-0 items-center justify-center">
          <Monogram
            name={contact.name}
            className={cn(
              "transition-opacity duration-150 group-focus-within:opacity-0 [@media(hover:hover)]:group-hover:opacity-0",
              revealed && "opacity-0",
            )}
          />
          <RowCheckbox
            checked={selected}
            label={`Select ${contact.name}`}
            revealed={revealed}
            onToggle={onToggle}
            className="absolute z-10"
          />
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <Link
            href={contactHref(contact.id)}
            onClick={(event) => {
              if (!selecting) return;
              event.preventDefault();
              onToggle(event.shiftKey);
            }}
            className="truncate text-[14px] leading-5 after:absolute after:inset-0"
          >
            {contact.name}
          </Link>
          <span className="caption-style text-subtle truncate">
            {contact.jobTitle || "No title"}
          </span>
          <RowTags tags={contact.tags} className="mt-0.5" />
        </span>
      </span>
      <span className="hidden min-w-0 md:block">
        {company ?? <span className="caption-style text-subtle"><span aria-hidden>·</span><span className="sr-only">None</span></span>}
      </span>
      <span className="hidden min-w-0 md:block">
        {contact.email ? (
          <a
            href={`mailto:${contact.email}`}
            className="relative z-10 block truncate text-[14px] leading-5 hover:underline"
          >
            {contact.email}
          </a>
        ) : findEmail ? (
          <FindDetailButton contactId={contact.id} field="email" lookup={emailLookup} className="-ml-1" />
        ) : (
          <span className="caption-style text-subtle"><span aria-hidden>·</span><span className="sr-only">None</span></span>
        )}
      </span>
      <span className="hidden min-w-0 items-center gap-1 md:flex">
        {contact.phone ? (
          <>
            <span className="truncate text-[14px] leading-5">
              {contact.phone}
            </span>
            <span className="relative z-10">
              <CallLink phone={contact.phone} />
            </span>
          </>
        ) : findPhone ? (
          <FindDetailButton contactId={contact.id} field="phone" lookup={phoneLookup} className="-ml-1" />
        ) : (
          <span className="caption-style text-subtle"><span aria-hidden>·</span><span className="sr-only">None</span></span>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-1 md:hidden">
        <span className="relative z-10">
          <CallLink phone={contact.phone} />
        </span>
        {company}
      </span>
    </li>
  );
}
