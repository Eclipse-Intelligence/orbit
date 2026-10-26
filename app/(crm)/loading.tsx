const ROW_WIDTHS = ["w-[38%]", "w-[52%]", "w-[44%]", "w-[60%]", "w-[34%]", "w-[48%]", "w-[56%]", "w-[40%]", "w-[50%]", "w-[36%]"];

export default function CrmLoading() {
  return (
    <section role="status" aria-label="Loading" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="border-border flex shrink-0 items-center gap-3 border-b px-3 py-2.5 sm:px-4 sm:py-[14px]">
        <div className="bg-muted h-[30px] w-[30px] shrink-0 rounded-lg lg:hidden" />
        <div className="bg-muted h-4 w-32 rounded-md" />
        <div className="ml-auto flex gap-2">
          <div className="bg-muted h-[30px] w-[30px] rounded-lg" />
          <div className="bg-muted h-[30px] w-[30px] rounded-lg" />
          <div className="bg-muted hidden h-[30px] w-28 rounded-lg sm:block" />
        </div>
      </div>
      <div className="border-border flex shrink-0 gap-2 border-b px-4 py-3">
        <div className="bg-muted h-7 w-20 rounded-full" />
        <div className="bg-muted h-7 w-24 rounded-full" />
        <div className="bg-muted h-7 w-16 rounded-full" />
      </div>
      <ul aria-hidden className="flex flex-col motion-safe:animate-pulse">
        {ROW_WIDTHS.map((width, index) => (
          <li key={index} className="border-border flex items-center gap-3 border-b px-4 py-3.5">
            <div className="bg-muted size-6 shrink-0 rounded-full" />
            <div className={`bg-muted h-3.5 rounded-md ${width}`} />
            <div className="bg-muted ml-auto hidden h-3.5 w-20 rounded-md sm:block" />
          </li>
        ))}
      </ul>
      <span className="sr-only">Loading</span>
    </section>
  );
}
