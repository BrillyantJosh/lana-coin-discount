/**
 * A FINANCER'S COMPANY, AS A LINK — the admin pages' one way to show it.
 *
 * The company's name, then a small external-link icon and the host, all one
 * link to https://<host>/. The address comes ONLY from companyWebsiteUrl, from
 * the host Direct.Fund verified — never from the `website` Direct.Fund also
 * sends, nor from any other text. A host that is not a plain public name gives
 * no link at all: the name as plain text.
 *
 * Why so strict here of all places: this site keeps the session's signing key
 * in the browser, so a link that ran code instead of opening a page could take
 * it. The link opens a new tab with no opener and no referrer, and a click on
 * it does nothing else on the page (a batch row does not open or close under it).
 *
 * Which company, and from when, is src/lib/financerCompanies.ts.
 */
import { ExternalLink } from 'lucide-react';
import { COMPANY_LINK_REFERRER_POLICY, COMPANY_LINK_REL, companyWebsiteUrl, safeCompanyHost } from '@/lib/companyLink';
import { representativeText, type FinancerCompany } from '@/lib/financerCompanies';

export function CompanyLink({ company }: { company: FinancerCompany }) {
  const url = companyWebsiteUrl(company.host);
  if (!url) return <span>{company.name}</span>;
  return (
    <a
      href={url}
      target="_blank"
      rel={COMPANY_LINK_REL}
      referrerPolicy={COMPANY_LINK_REFERRER_POLICY}
      onClick={e => e.stopPropagation()}
      className="hover:underline"
    >
      {company.name}{' '}
      <span className="inline-flex items-baseline gap-0.5 font-mono text-[10px] font-normal text-muted-foreground">
        <ExternalLink aria-hidden="true" className="h-2.5 w-2.5 self-center" />
        {safeCompanyHost(company.host)}
      </span>
    </a>
  );
}

/**
 * Who financed it: the company, with the person after it (or under it) as its
 * representative — or, without a company for the row, the person exactly as before.
 */
export function FinancerName({ company, person, under = false }: { company: FinancerCompany | null; person: string; under?: boolean }) {
  if (!company) return <>{person}</>;
  return (
    <>
      <CompanyLink company={company} />{' '}
      <span className={`${under ? 'block' : 'ml-1'} text-[11px] font-normal text-muted-foreground`}>{representativeText(person)}</span>
    </>
  );
}
