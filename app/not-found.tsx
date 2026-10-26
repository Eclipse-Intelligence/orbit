import Button from "@/components/_ui/button";
import Logo from "@/public/assets/images/_common/logo.svg";

export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-5 px-6 text-center">
      <Logo aria-hidden className="size-10" />
      <h1>Page not found</h1>
      <Button variant="secondary" size="md" href="/mail">
        Go to Orbit
      </Button>
    </main>
  );
}
