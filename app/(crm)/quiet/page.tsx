import { redirect } from "next/navigation";

export default function QuietPage() {
  redirect("/?quiet=true&sort=strength&order=asc");
}
