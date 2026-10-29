import { notFound } from "next/navigation";
import { SCREENS, type Screen } from "@/components/docs-mockup/data";
import DocsMockup from "@/components/docs-mockup/screens";

export default async function DocsMockupPage({ params }: { params: Promise<{ screen: string }> }) {
  const { screen } = await params;
  if (!SCREENS.includes(screen as Screen)) notFound();
  return <DocsMockup screen={screen as Screen} />;
}
