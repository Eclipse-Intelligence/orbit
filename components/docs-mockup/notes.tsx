import type { ReactNode } from "react";
import { PEOPLE } from "@/components/docs-mockup/data";
import {
  Bullet,
  Caret,
  Code,
  CodeBlock,
  Del,
  H2,
  Ins,
  List,
  Mention,
  NoteColumn,
  P,
  Quote,
  Strong,
  Tag,
  Task,
  Title,
  WikiLink,
  noteType,
} from "@/components/docs-mockup/editor";
import { Dot, NoteMeta } from "@/components/docs-mockup/panes";
import { AgentCursor, AgentInsertion, HumanCursor, PersonAvatar } from "@/components/docs-mockup/presence";
import { cn } from "@/lib/utils";

export type Q4Mode = "live" | "linking" | "diff" | "settled" | "before" | "phone" | "phone-linking";

function Changed({ children }: { children: ReactNode }) {
  return (
    <div className="relative">
      <span aria-hidden className="bg-success/70 absolute top-1 bottom-1 -left-5 w-[2px] rounded-full" />
      {children}
    </div>
  );
}

export function Q4Body({ mode, picker }: { mode: Q4Mode; picker?: ReactNode }) {
  const live = mode === "live" || mode === "phone";
  const diff = mode === "diff";
  const linking = mode === "linking" || mode === "phone-linking";
  const phone = mode === "phone" || mode === "phone-linking";
  const markHere = mode === "live";

  return (
    <NoteColumn className={cn(phone && "text-[16px]")}>
      <Title className={cn(phone && "text-[26px]")}>Q4 partner strategy</Title>
      {!phone && (
        <NoteMeta>
          <span className="flex items-center gap-1.5">
            <PersonAvatar person={PEOPLE.mark} size="xs" />
            Mark Ridgeon
          </span>
          <Dot />
          <span>Created 14 Oct</span>
          <Dot />
          <span>{diff ? "Version from 11:42 today" : "Edited just now"}</span>
          <Dot />
          <span className="tabular-nums">684 words</span>
        </NoteMeta>
      )}
      {phone && <div className="h-4" />}
      <P>
        Three partners carry Q4. Double down on the two that already send us pipeline, and give Helix one clear test. <Tag path="partners/q4" />
      </P>

      <H2>Where we are</H2>
      <List>
        <Bullet>
          <Strong>Acme</Strong> <Mention name="Acme" kind="company" /> signed the reseller pilot in September: 4 deals, £86k in pipeline.
          {linking ? (
            <span className="relative">
              {" "}Renewal plan in <span className={noteType.marker}>[[</span>
              <span className="text-foreground rounded-[3px] bg-white/[0.07] px-[1px]">Acme renewal</span>
              <Caret />
              {picker}
            </span>
          ) : (
            <> <Tag path="clients/acme" /></>
          )}
        </Bullet>
        <Bullet active={markHere}>
          <Strong>Northwind</Strong> is warm but waiting on legal. See <WikiLink active={markHere}>Northwind MSA redlines</WikiLink>.
          {markHere && <Caret />}
        </Bullet>
        <Bullet>
          <Strong>Helix Data</Strong> has made one intro. It needs a joint offer to move.
        </Bullet>
      </List>

      <H2>Risks</H2>
      <P>
        Northwind&apos;s legal review could slip into January. Priya owns the chase.
        {live && !phone && <HumanCursor person={PEOPLE.priya} />}
      </P>
      {diff ? (
        <Changed>
          <P>
            <Ins>Acme&apos;s renewal lands in January, so the pilot results need to be in their hands by </Ins>
            <Del>early December</Del> <Ins>12 December, with the case study signed off.</Ins>
          </P>
        </Changed>
      ) : live ? (
        <P className="mb-10">
          <AgentInsertion>Acme&apos;s renewal lands in January, so the pilot results need to be in their hands by 12 December, with the case study</AgentInsertion>
          <AgentCursor person={PEOPLE.assistant} />
        </P>
      ) : mode === "before" ? null : (
        <P>Acme&apos;s renewal lands in January, so the pilot results need to be in their hands by 12 December, with the case study signed off.</P>
      )}

      <Quote>Partner-sourced deals closed in 41 days on average in Q3, against 68 for cold outbound.</Quote>

      <H2>Q4 plan</H2>
      <List className="gap-1.5">
        <Task done>
          Agree the co-marketing calendar with <Mention name="Lena Ortiz" kind="contact" />
        </Task>
        {diff ? (
          <Changed>
            <Task done>
              Share revised pricing with Acme, see <WikiLink>Acme pricing notes</WikiLink>
            </Task>
          </Changed>
        ) : (
          <Task done={mode !== "before"}>
            Share revised pricing with Acme, see <WikiLink>Acme pricing notes</WikiLink>
          </Task>
        )}
        <Task>Joint webinar with Northwind, week of 17 Nov</Task>
        <Task>
          Partner one-pager for Helix, tracked as <Mention name="Helix joint offer" kind="deal" />
        </Task>
        <Task>
          Tag partner deals with <Code>source: partner</Code> so the board can filter them
        </Task>
      </List>
    </NoteColumn>
  );
}

export function AcmePricingBody() {
  return (
    <NoteColumn>
      <Title>Acme pricing notes</Title>
      <NoteMeta>
        <span className="flex items-center gap-1.5">
          <PersonAvatar person={PEOPLE.mark} size="xs" />
          Mark Ridgeon
        </span>
        <Dot />
        <span>Created 2 Oct</span>
        <Dot />
        <span>Edited yesterday</span>
      </NoteMeta>
      <P>
        Anchor the renewal to the reseller pilot, not to seat count. <Mention name="Acme" kind="company" /> cares about the partner margin more than the list
        price. <Tag path="clients/acme" />
      </P>
      <H2>Discount bands</H2>
      <CodeBlock language="text">
        {`50 seats and up     8%
100 seats and up   12%
Multi-year         +3%, capped at 15%`}
      </CodeBlock>
      <List>
        <Bullet>Nothing below 50 seats. Point them at the self-serve plan instead.</Bullet>
        <Bullet>
          Partner margin stays at 15% as agreed in <WikiLink>Partner tiers and margins</WikiLink>.
        </Bullet>
      </List>
      <H2>For the renewal call</H2>
      <P>
        Lead with the pilot numbers from <WikiLink>Q4 partner strategy</WikiLink>, then the multi-year option. Dana will ask about the cap, so have the
        Brightline comparison ready.
      </P>
    </NoteColumn>
  );
}

function Entry({ time, children, last }: { time: string; children: ReactNode; last?: boolean }) {
  return (
    <li className="relative grid grid-cols-[4.25rem_1fr] gap-x-2">
      <span className="text-faint relative pt-[0.32em] text-[13px] leading-[1.6] tabular-nums">
        {time}
        <span aria-hidden className={cn("absolute top-[0.95em] right-3 size-[5px] rounded-full", last ? "bg-soft" : "bg-[#3a3a3a]")} />
      </span>
      <div className={cn(noteType.body, "pb-4")}>{children}</div>
    </li>
  );
}

export function DailyBody() {
  return (
    <div className="relative mx-auto w-full max-w-[40em]">
      <p className="eyebrow-style text-subtle mb-3 text-[11px]">Daily note</p>
      <Title>Wednesday 29 October</Title>
      <div className="text-subtle mt-3 mb-8 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] leading-5">
        <span>2 meetings today:</span>
        <a href="#" className="text-soft hover:text-foreground underline decoration-white/15 underline-offset-[3px]">
          Acme partner sync, 10:00
        </a>
        <Dot />
        <a href="#" className="text-soft hover:text-foreground underline decoration-white/15 underline-offset-[3px]">
          Northwind legal, 14:00
        </a>
      </div>
      <ol aria-label="Entries" className="relative flex flex-col">
        <span aria-hidden className="absolute top-3 bottom-14 left-[calc(4.25rem-0.75rem+2px)] w-px bg-white/[0.06]" />
        <Entry time="08:42">Slept badly. Coffee first, inbox after.</Entry>
        <Entry time="09:15">
          Call with Priya. <Mention name="Northwind" kind="company" /> legal is slower than they said. Not our problem yet, but chase on Friday.
        </Entry>
        <Entry time="11:30">
          Small win: Acme&apos;s ops lead said the pilot &ldquo;saved her a whole Monday&rdquo;. That goes in the case study. <Tag path="wins" />
        </Entry>
        <Entry time="13:05">
          Third reschedule from Helix. Letting it go for a week before I say something I regret. <Tag path="vent" />
        </Entry>
        <Entry time="15:20">
          Idea: partner-sourced deals get their own board, so we stop guessing what the programme is worth. <WikiLink broken>Partner deals board</WikiLink>
        </Entry>
        <Entry time="16:48">
          <ul>
            <Task>Send Lena the co-marketing dates</Task>
            <Task done>Reply to Dana about the DPA</Task>
          </ul>
        </Entry>
        <li className="grid grid-cols-[4.25rem_1fr] gap-x-2">
          <span className="text-faint pt-[0.32em] text-[13px] leading-[1.6] tabular-nums">17:02</span>
          <div className={cn(noteType.body, "flex items-center gap-3")}>
            <span className="text-faint">
              <Caret />
              Jot something down
            </span>
          </div>
        </li>
      </ol>
      <p className="caption-style text-faint mt-6 pl-[4.75rem]">Enter adds a new entry with the time. Daily notes are always private.</p>
    </div>
  );
}
