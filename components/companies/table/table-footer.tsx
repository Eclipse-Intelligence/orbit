import Pager from "@/components/crm/pager";

type TableFooterProps = {
  page: number;
  count: number;
  total: number;
};

export default function TableFooter({ page, count, total }: TableFooterProps) {
  return (
    <Pager
      always
      className="border-b"
      page={page}
      count={count}
      total={total}
      noun={["company", "companies"]}
    />
  );
}
