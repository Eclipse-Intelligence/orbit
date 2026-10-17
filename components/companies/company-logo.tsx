import Asset from "@/components/_ui/asset";
import { Monogram } from "@/components/beautifui/record-marks";
import type { Company } from "@/lib/crm/types";
import { cn } from "@/lib/utils";

export function companyLogoSource(company: Pick<Company, "logoUrl" | "domain">, clientId: string | null) {
  if (company.logoUrl) return { src: company.logoUrl, hosted: false };
  if (clientId && company.domain) {
    const params = new URLSearchParams({ publicClientId: clientId, domain: company.domain, type: "icon", theme: "dark" });
    return { src: `https://logos.context.dev/?${params}`, hosted: true };
  }
  return null;
}

export default function CompanyLogo({
  company,
  clientId,
  sizes = "20px",
  className,
  fallback,
}: {
  company: Pick<Company, "logoUrl" | "domain" | "name">;
  clientId: string | null;
  sizes?: string;
  className?: string;
  fallback?: React.ReactNode;
}) {
  const source = companyLogoSource(company, clientId);
  if (!source) return fallback ?? <Monogram name={company.name} className={className} />;
  return (
    <Asset
      type="image"
      src={source.src}
      alt=""
      width={1}
      height={1}
      sizes={sizes}
      fit="contain"
      unoptimized
      className={cn(
        "size-5 shrink-0 overflow-hidden rounded-md outline-1 -outline-offset-1 outline-white/10",
        source.hosted ? "bg-secondary" : "bg-white",
        className,
      )}
    />
  );
}
