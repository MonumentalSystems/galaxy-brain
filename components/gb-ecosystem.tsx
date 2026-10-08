"use client";

import { ScrollReveal } from "@/components/scroll-reveal";
import { ExternalLink } from "lucide-react";

interface EcoLink {
  name: string;
  url: string;
  description: string;
  accentColor: string;
  borderColor: string;
}

const ECOSYSTEM_LINKS: EcoLink[] = [
  {
    name: "Monumental Systems",
    url: "https://monumentalsystems.com",
    description: "The independent research and engineering company behind Galaxy Brain, building systems for scalable science.",
    accentColor: "text-dia",
    borderColor: "hover:border-amber-500/40",
  },
  {
    name: "Generous",
    url: "https://www.generous.works",
    description: "The universal canvas for AI: describe what you need and watch it render as live, interactive components.",
    accentColor: "text-generous",
    borderColor: "hover:border-blue-500/40",
  },
  {
    name: "HAM",
    url: "https://ham.flobots.xyz",
    description: "Shared memory for collaborating agents, so decisions and findings outlast the chat window.",
    accentColor: "text-galaxy",
    borderColor: "hover:border-cyan-400/40",
  },
  {
    name: "Rosetta",
    url: "https://rosetta.report",
    description: "A map of mathematics that looks for the results that matter before the citations do.",
    accentColor: "text-galaxy",
    borderColor: "hover:border-cyan-400/40",
  },
];

export function GbEcosystem() {
  return (
    <section id="ecosystem" className="py-32" aria-labelledby="ecosystem-heading">
      <div className="max-w-5xl mx-auto px-6">
        {/* Heading */}
        <ScrollReveal direction="up">
          <div className="text-center mb-16">
            <p className="font-mono text-galaxy text-xs uppercase tracking-widest mb-4">
              PART OF SOMETHING BIGGER
            </p>
            <h2
              id="ecosystem-heading"
              className="font-display text-4xl md:text-5xl text-foreground mb-6"
            >
              From Monumental Systems
            </h2>
            <p className="text-muted-foreground text-lg max-w-2xl mx-auto leading-relaxed">
              Built alongside the rest of the stack, and designed to work together.
            </p>
          </div>
        </ScrollReveal>

        {/* Compact link cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {ECOSYSTEM_LINKS.map((link, index) => (
            <ScrollReveal
              key={link.name}
              direction="up"
              delay={0.1 + index * 0.08}
            >
              <a
                href={link.url}
                target={link.url.startsWith("http") ? "_blank" : undefined}
                rel={link.url.startsWith("http") ? "noopener noreferrer" : undefined}
                className={`
                  group flex items-start gap-4 p-6
                  rounded-lg border border-card-border
                  bg-glass-bg backdrop-blur-sm
                  transition-all duration-200
                  ${link.borderColor}
                  hover:bg-card
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-galaxy
                  focus-visible:ring-offset-2 focus-visible:ring-offset-background
                `}
              >
                <div className="flex-1 min-w-0">
                  <p className={`font-semibold text-foreground group-hover:${link.accentColor} transition-colors duration-200`}>
                    {link.name}
                  </p>
                  <p className="text-sm text-muted-foreground mt-1 leading-relaxed">
                    {link.description}
                  </p>
                </div>
                {link.url.startsWith("http") && (
                  <ExternalLink
                    size={16}
                    className="flex-shrink-0 mt-1 text-muted transition-colors duration-200 group-hover:text-galaxy"
                    aria-hidden="true"
                  />
                )}
              </a>
            </ScrollReveal>
          ))}
        </div>
      </div>
    </section>
  );
}
