"use client";

import type { ReactNode } from "react";
import CommandMenu from "@/components/companies/command-menu/command-menu";
import Profile from "@/components/companies/profile/profile";
import { AttentionProvider } from "@/components/crm/attention";
import QuickAdd, { QuickAddProvider } from "@/components/crm/quick-add";
import TaskReminders from "@/components/crm/task-reminders";
import AssistantDock from "@/components/assistant/assistant-dock";
import { ComposerProvider } from "@/components/mail/compose-dock";
import PushRegistrar from "@/components/push/push-registrar";
import ShortcutsHelp from "@/components/shortcuts/shortcuts-help";
import type { Viewer } from "@/components/crm/viewer";
import type { UnreadBrief } from "@/lib/learning/nightly";
import type { Notification } from "@/lib/workflows/store";

export default function CrmChrome({
  viewer,
  notifications,
  teamUnread = 0,
  brief = null,
  multi,
  children,
}: {
  viewer: Viewer;
  multi: boolean;
  notifications?: Notification[];
  teamUnread?: number;
  brief?: UnreadBrief | null;
  children: ReactNode;
}) {
  return (
    <AttentionProvider notifications={notifications} teamUnread={teamUnread}>
      <QuickAddProvider>
        <ComposerProvider>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {children}
          <Profile viewer={viewer} />
          <CommandMenu multi={multi} />
          <QuickAdd viewerId={viewer.id} />
          <TaskReminders />
          <ShortcutsHelp />
          <AssistantDock brief={brief} workspaceName={viewer.workspaceName} workspaceId={viewer.workspaceId} />
          <PushRegistrar workspaceId={viewer.workspaceId} />
        </div>
        </ComposerProvider>
      </QuickAddProvider>
    </AttentionProvider>
  );
}
