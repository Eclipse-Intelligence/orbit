import { clockTime, fullTime } from "@/lib/chat/format";
import type { ChatMessage } from "@/lib/chat/types";
import ArchiveIcon from "@/public/assets/images/chat/archive.svg";

function shortName(name: string) {
  return name.trim().split(/\s+/)[0] || name;
}

export default function SystemLine({ message }: { message: ChatMessage }) {
  const archive = /^(un)?archived this room$/.test(message.body);
  return (
    <div data-chat-event={message.id} className="flex items-start gap-3 px-5 py-1 max-md:px-3.5">
      <span aria-hidden className="text-subtle flex h-[18px] w-7 shrink-0 items-center justify-end">
        {archive && <ArchiveIcon className="size-3" />}
      </span>
      <p className="caption-style text-subtle min-w-0 flex-1 [overflow-wrap:anywhere]">
        {shortName(message.author.name)} {message.body}
        <span aria-hidden> · </span>
        <time dateTime={message.createdAt} title={fullTime(message.createdAt)} className="tabular-nums">
          {clockTime(message.createdAt)}
        </time>
      </p>
    </div>
  );
}
