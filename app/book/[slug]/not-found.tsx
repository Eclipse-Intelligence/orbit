import { Aurora } from "@/components/booking/booking-background";

export default function BookingNotFound() {
  return (
    <main className="relative flex min-h-dvh items-center justify-center px-5 py-10">
      <div aria-hidden className="fixed inset-0 -z-10">
        <Aurora />
        <div className="absolute inset-0 bg-black/40" />
      </div>
      <section className="flex w-full max-w-[26em] flex-col items-center gap-3 rounded-[28px] border border-white/10 bg-[#0b0b10]/72 px-8 py-10 text-center shadow-[0px_24px_80px_0px_rgba(0,0,0,0.55),inset_0px_1px_0px_0px_rgba(255,255,255,0.08)] backdrop-blur-2xl">
        <h1 className="text-[22px] leading-tight font-semibold">This booking page isn&apos;t available</h1>
        <p className="text-soft max-w-[22em] text-[14px] leading-[1.5] text-pretty">
          The link may be wrong, or the page has been switched off. Check with the person who sent it to you.
        </p>
      </section>
    </main>
  );
}
