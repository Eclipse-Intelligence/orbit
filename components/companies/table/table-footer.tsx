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
      page={page}
      count={count}
      total={total}
      noun={["company", "companies"]}
      className="border-b"
    />
  );
}
