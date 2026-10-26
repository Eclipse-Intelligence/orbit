import Button from "@/components/_ui/button";
import Logo from "@/public/assets/images/_common/logo.svg";

export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-5 px-6 text-center">
      <Logo aria-hidden className="size-10" />
      <div className="flex flex-col gap-2">
        <h1>This page doesn&apos;t exist</h1>
        <p className="text-subtle max-w-[32em]">The link may be out of date, or the page has moved.</p>
      </div>
      <Button variant="secondary" size="md" href="/mail">
        Go to Orbit
      </Button>
    </main>
  );
}
