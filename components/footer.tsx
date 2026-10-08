import { BrandLogo } from "@/components/brand-logo";

const TAGLINES = [
  "Your research, on your hardware, under your keys.",
];

interface FooterLink {
  label: string;
  href: string;
  external?: boolean;
}

interface FooterColumn {
  heading: string;
  links: FooterLink[];
}

const FOOTER_COLUMNS: FooterColumn[] = [
  {
    heading: "Monumental Systems",
    links: [
      { label: "Monumental Systems", href: "https://monumentalsystems.com", external: true },
      { label: "Generous", href: "https://www.generous.works", external: true },
      { label: "HAM", href: "https://ham.flobots.xyz", external: true },
      { label: "Rosetta", href: "https://rosetta.report", external: true },
    ],
  },
  {
    heading: "Workspace",
    links: [
      { label: "Open workspace", href: "/login" },
      { label: "Request an invite", href: "mailto:info@monumentalsystems.com?subject=Galaxy%20Brain%20invite" },
    ],
  },
  {
    heading: "Contact",
    links: [
      { label: "info@monumentalsystems.com", href: "mailto:info@monumentalsystems.com" },
    ],
  },
];

export function Footer() {
  return (
    <footer className="border-t border-card-border bg-void pt-16 pb-8" role="contentinfo">
      <div className="max-w-6xl mx-auto px-6">
        {/* Brand + columns */}
        <div className="grid grid-cols-2 gap-8 sm:grid-cols-4 mb-12">
          {/* Brand column */}
          <div className="col-span-2 sm:col-span-1">
            <div className="mb-3 flex items-center gap-3">
              <BrandLogo className="h-10 w-10 flex-shrink-0" size={40} />
              <p className="font-display text-lg font-bold gradient-text">
                Galaxy Brain
              </p>
            </div>
            <p className="text-sm text-muted leading-relaxed">
              A research workspace from Monumental Systems, hosted or self-hosted, in invite-only alpha.
            </p>
          </div>

          {/* Link columns */}
          {FOOTER_COLUMNS.map((column) => (
            <div key={column.heading}>
              <h3 className="text-sm font-semibold text-foreground mb-4">
                {column.heading}
              </h3>
              <ul className="flex flex-col gap-2.5">
                {column.links.map((link) => (
                  <li key={link.label}>
                    <a
                      href={link.href}
                      target={link.external ? "_blank" : undefined}
                      rel={link.external ? "noopener noreferrer" : undefined}
                      className="
                        text-sm text-muted transition-colors duration-150
                        hover:text-galaxy
                        focus-visible:outline-none focus-visible:underline
                      "
                    >
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* Divider */}
        <div className="border-t border-card-border mb-8" role="separator" />

        {/* Taglines */}
        <div className="flex flex-col items-center gap-2 mb-8 text-center">
          {TAGLINES.map((tagline) => (
            <p key={tagline} className="text-sm text-muted italic font-display">
              {tagline}
            </p>
          ))}
        </div>

        {/* Copyright */}
        <p className="text-center text-xs text-muted">
          &copy; {new Date().getFullYear()} Monumental Systems
        </p>
        <p className="mt-2 text-center text-xs text-muted">
          Brain artwork by{" "}
          <a
            href="https://pixabay.com/users/geralt-9301/"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 hover:text-galaxy"
          >
            Gerd Altmann
          </a>
        </p>
      </div>
    </footer>
  );
}
