import { taskKind, type TaskKind } from "@/lib/crm/task-kind";
import PhoneIcon from "@/public/assets/images/_common/phone.svg";
import MailIcon from "@/public/assets/images/companies/sidebar/mail.svg";
import UsersIcon from "@/public/assets/images/companies/sidebar/users.svg";
import CircleIcon from "@/public/assets/images/tasks/circle.svg";

const ICONS: Record<TaskKind, typeof PhoneIcon> = {
  call: PhoneIcon,
  email: MailIcon,
  meeting: UsersIcon,
  todo: CircleIcon,
};

export default function TaskKindIcon({ title, className }: { title: string; className?: string }) {
  const Icon = ICONS[taskKind(title)];
  return <Icon aria-hidden className={className} />;
}
