type TableFooterProps = {
  count: number;
  total: number;
};

export default function TableFooter({ count, total }: TableFooterProps) {
  const label =
    total > count
      ? `Showing ${count} of ${total} companies`
      : `${count} ${count === 1 ? "company" : "companies"}`;

  return (
    <div className="caption-style border-border flex shrink-0 items-center border-b px-4 py-3">
      <span className="text-foreground">{label}</span>
    </div>
  );
}
