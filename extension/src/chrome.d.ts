declare const __ORBIT_URL__: string;
declare const __LINKEDIN_URL__: string;

declare namespace chrome {
  namespace runtime {
    type MessageSender = { tab?: tabs.Tab; id?: string; url?: string };
    const onMessage: {
      addListener(
        callback: (message: unknown, sender: MessageSender, sendResponse: (response?: unknown) => void) => boolean | void,
      ): void;
    };
    function sendMessage(message: unknown): Promise<unknown>;
  }

  namespace storage {
    type StorageChange = { oldValue?: unknown; newValue?: unknown };
    const local: {
      get(keys: string | string[] | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
    };
    const onChanged: {
      addListener(callback: (changes: Record<string, StorageChange>, areaName: string) => void): void;
    };
  }

  namespace tabs {
    type Tab = { id?: number; url?: string; active: boolean; windowId: number; status?: string };
    type ChangeInfo = { url?: string; status?: string };
    function query(queryInfo: { active?: boolean; currentWindow?: boolean }): Promise<Tab[]>;
    function get(tabId: number): Promise<Tab>;
    function getCurrent(): Promise<Tab | undefined>;
    function create(createProperties: { url: string; active?: boolean }): Promise<Tab>;
    function sendMessage(tabId: number, message: unknown): Promise<unknown>;
    const onUpdated: { addListener(callback: (tabId: number, changeInfo: ChangeInfo, tab: Tab) => void): void };
    const onActivated: { addListener(callback: (activeInfo: { tabId: number; windowId: number }) => void): void };
    const onRemoved: { addListener(callback: (tabId: number) => void): void };
  }

  namespace action {
    function setBadgeText(details: { tabId?: number; text: string }): Promise<void>;
    function setBadgeBackgroundColor(details: { tabId?: number; color: string }): Promise<void>;
    function setTitle(details: { tabId?: number; title: string }): Promise<void>;
  }

  namespace sidePanel {
    function setPanelBehavior(behavior: { openPanelOnActionClick: boolean }): Promise<void>;
  }
}
