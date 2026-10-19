"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  type SVGProps,
} from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Dialog, DialogContent } from "@/components/_ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/_ui/dropdown-menu";
import { Kbd } from "@/components/_ui/command";
import {
  QuickCompanyForm,
  QuickContactForm,
  QuickEmailForm,
  QuickOpportunityForm,
  QuickTaskForm,
  type QuickAddNotice,
} from "@/components/crm/quick-add-forms";
import { quickAddSetupAction, type QuickAddSetup } from "@/app/(crm)/quick-add";
import { useShortcut } from "@/components/shortcuts/shortcuts-provider";
import {
  QUICK_ADD_ITEMS,
  quickAddKindForKey,
  quickAddPrefill,
  type QuickAddKind,
  type QuickAddRecord,
} from "@/lib/crm/quick-add";
import { cn } from "@/lib/utils";
import PlusIcon from "@/public/assets/images/_common/plus.svg";
import BookClosedIcon from "@/public/assets/images/companies/sidebar/book-closed.svg";
import BuildingIcon from "@/public/assets/images/companies/sidebar/building.svg";
import ClipboardIcon from "@/public/assets/images/companies/sidebar/clipboard.svg";
import TargetIcon from "@/public/assets/images/companies/sidebar/target-05.svg";
import MailIcon from "@/public/assets/images/companies/sidebar/mail.svg";

const NOTICE_MS = 6_000;
const LIFT_GAP = 12;

const ICONS: Record<QuickAddKind, ComponentType<SVGProps<SVGSVGElement>>> = {
  task: TargetIcon,
  contact: BookClosedIcon,
  company: BuildingIcon,
  opportunity: ClipboardIcon,
  email: MailIcon,
};

type RecordSetter = Dispatch<SetStateAction<QuickAddRecord | null>>;

const RecordContext = createContext<{
  record: QuickAddRecord | null;
  setRecord: RecordSetter | null;
}>({ record: null, setRecord: null });

export function QuickAddProvider({ children }: { children: ReactNode }) {
  const [record, setRecord] = useState<QuickAddRecord | null>(null);
  return (
    <RecordContext.Provider value={{ record, setRecord }}>{children}</RecordContext.Provider>
  );
}

export function useQuickAddRecord(record: QuickAddRecord) {
  const { setRecord } = useContext(RecordContext);
  const key = JSON.stringify(record);
  useEffect(() => {
    if (!setRecord) return;
    setRecord(JSON.parse(key) as QuickAddRecord);
    return () =>
      setRecord((current) => (current && JSON.stringify(current) === key ? null : current));
  }, [key, setRecord]);
}

function modalOpen() {
  return [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].some(
    (node) =>
      node.getAttribute("data-state") === "open" &&
      !node.closest("[data-radix-popper-content-wrapper]"),
  );
}

function bottomLift() {
  let lift = 0;
  for (const node of document.querySelectorAll<HTMLElement>("[data-quick-add-avoid]")) {
    if (node.dataset.quickAddAvoid === "mobile" && window.matchMedia("(min-width: 48rem)").matches) {
      continue;
    }
    const rect = node.getBoundingClientRect();
    if (rect.height === 0 || rect.width === 0) continue;
    lift = Math.max(lift, window.innerHeight - rect.top + LIFT_GAP);
  }
  return Math.round(lift);
}

export function useScreenState() {
  const [covered, setCovered] = useState(false);
  const [lift, setLift] = useState(0);

  useEffect(() => {
    let frame = 0;
    const resize = new ResizeObserver(() => schedule());
    let watched: HTMLElement[] = [];

    function measure() {
      frame = 0;
      setCovered(modalOpen());
      const nodes = [...document.querySelectorAll<HTMLElement>("[data-quick-add-avoid]")];
      if (nodes.length !== watched.length || nodes.some((node, index) => node !== watched[index])) {
        resize.disconnect();
        for (const node of nodes) resize.observe(node);
        watched = nodes;
      }
      setLift(bottomLift());
    }

    function schedule() {
      if (!frame) frame = window.requestAnimationFrame(measure);
    }

    const mutations = new MutationObserver(schedule);
    mutations.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-state", "data-quick-add-avoid"],
    });
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      mutations.disconnect();
      resize.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, []);

  return { covered, lift };
}

export default function QuickAdd({ viewerId }: { viewerId: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const { record } = useContext(RecordContext);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [kind, setKind] = useState<QuickAddKind>("task");
  const [setup, setSetup] = useState<QuickAddSetup | null>(null);
  const [notice, setNotice] = useState<(QuickAddNotice & { id: number }) | null>(null);
  const [opening, setOpening] = useState(0);
  const choosing = useRef(false);
  const { covered, lift } = useScreenState();

  const loadSetup = useCallback(() => {
    quickAddSetupAction().then(setSetup, () => undefined);
  }, []);

  const start = useCallback(
    (next: QuickAddKind) => {
      choosing.current = true;
      setMenuOpen(false);
      setNotice(null);
      setOpening((count) => count + 1);
      setKind(next);
      setDialogOpen(true);
      loadSetup();
    },
    [loadSetup],
  );

  useShortcut("quick-add", () => setMenuOpen((open) => !open));
  useShortcut("create-task", () => start("task"));
  useShortcut("create-contact", () => start("contact"));
  useShortcut("create-company", () => start("company"));
  useShortcut("create-opportunity", () => start("opportunity"));
  useShortcut("create-email", () => start("email"));

  useEffect(() => {
    if (menuOpen) loadSetup();
  }, [menuOpen, loadSetup]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  function done(next: QuickAddNotice) {
    setDialogOpen(false);
    setNotice({ ...next, id: Date.now() });
    router.refresh();
  }

  const prefill = quickAddPrefill(pathname, record, kind);
  const formProps = { prefill, setup, viewerId, onDone: done };

  return (
    <>
      <div
        style={{ "--quick-add-lift": `${lift}px` } as CSSProperties}
        className={cn(
          "pointer-events-none fixed right-[calc(env(safe-area-inset-right)+1rem)] bottom-[max(calc(env(safe-area-inset-bottom)+1rem),var(--quick-add-lift))] z-40 flex flex-col items-end gap-2 transition-[bottom] duration-200 ease-power3-out",
          covered && "invisible",
        )}
      >
        {notice && (
          <div
            key={notice.id}
            role="status"
            className="border-line-strong bg-popover shadow-overlay caption-style animate-in fade-in-0 slide-in-from-bottom-1 ease-power3-out pointer-events-auto flex max-w-[min(22em,calc(100vw-2rem))] items-center gap-2 rounded-xl border py-2 pr-2 pl-3 duration-200"
          >
            <span className="text-foreground min-w-0">{notice.message}</span>
            {notice.href && (
              <>
                <span aria-hidden className="text-faint">
                  ·
                </span>
                <Link
                  href={notice.href}
                  onClick={() => setNotice(null)}
                  className="text-foreground shrink-0 underline underline-offset-2 hover:text-soft"
                >
                  {notice.link ?? "Open"}
                </Link>
              </>
            )}
          </div>
        )}
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Quick add"
              aria-keyshortcuts="q"
              title="Quick add (Q). Or press C then T, C, O, P or M"
              className="bg-primary text-primary-foreground focus-visible:ring-ring/60 ease-power3-out pointer-events-auto flex size-12 cursor-pointer items-center justify-center rounded-full shadow-[0px_8px_24px_0px_rgba(0,0,0,0.45),0px_0px_0px_1px_#0e0e0e,inset_0px_4px_6px_0px_rgba(255,255,255,0.2),inset_0px_0px_0px_1px_rgba(255,255,255,0.15),inset_0px_-8px_14px_0px_rgba(0,0,0,0.15)] transition-[background-color,transform] duration-150 outline-none hover:bg-[#4b30ff] focus-visible:ring-2 active:scale-95 data-[state=open]:rotate-45"
            >
              <PlusIcon aria-hidden className="size-5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="top"
            align="end"
            sideOffset={8}
            collisionPadding={16}
            className="min-w-[200px]"
            onKeyDown={(event) => {
              if (event.metaKey || event.ctrlKey || event.altKey) return;
              const next = quickAddKindForKey(event.key);
              if (!next) return;
              event.preventDefault();
              start(next);
            }}
            onCloseAutoFocus={(event) => {
              if (choosing.current) event.preventDefault();
              choosing.current = false;
            }}
          >
            {QUICK_ADD_ITEMS.map((item) => {
              const Icon = ICONS[item.kind];
              return (
                <DropdownMenuItem
                  key={item.kind}
                  aria-keyshortcuts={item.key}
                  onSelect={() => start(item.kind)}
                >
                  <Icon aria-hidden className="text-subtle size-3.5 shrink-0" />
                  <span className="flex-1">{item.label}</span>
                  <Kbd aria-hidden className="uppercase">
                    {item.key}
                  </Kbd>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className={kind === "email" ? "max-w-[640px]" : "max-w-[440px]"} aria-describedby={undefined}>
          {kind === "task" && <QuickTaskForm key={opening} {...formProps} />}
          {kind === "contact" && <QuickContactForm key={opening} {...formProps} />}
          {kind === "company" && <QuickCompanyForm key={opening} {...formProps} />}
          {kind === "opportunity" && <QuickOpportunityForm key={opening} {...formProps} />}
          {kind === "email" && <QuickEmailForm key={opening} {...formProps} />}
        </DialogContent>
      </Dialog>
    </>
  );
}
