export const fieldClass =
  "flex w-full min-w-0 rounded-lg border border-transparent bg-surface-field px-3 text-[14px] text-foreground outline-none transition-[background-color,border-color] duration-150 ease-power3-out placeholder:text-subtle hover:bg-surface-raised focus-visible:border-ring/50 focus-visible:bg-surface-raised aria-invalid:border-danger disabled:cursor-not-allowed disabled:opacity-50";

export const inputClass = `${fieldClass} h-9 leading-none`;

export const selectClass = `${fieldClass} select-chevron h-9 cursor-pointer pr-8 leading-none`;

export const textareaClass = `${fieldClass} min-h-20 resize-y py-2 leading-5`;
