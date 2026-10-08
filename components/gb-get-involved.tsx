"use client";

import { Code, Users, Server, Mail, Globe } from "lucide-react";
import { GitHubIcon } from "@/components/github-icon";
import { ScrollReveal } from "@/components/scroll-reveal";

interface AudienceCard {
  icon: React.ReactNode;
  title: string;
  items: string[];
}

const AUDIENCE_CARDS: AudienceCard[] = [
  {
    icon: <Users size={24} />,
    title: "For researchers",
    items: [
      "Tell us what you're investigating and where your current tools lose the thread",
      "Bring the papers, formats, and sources you actually work with",
      "Try it on a real project with an invite",
    ],
  },
  {
    icon: <Code size={24} />,
    title: "For agent builders",
    items: [
      "Give an agent its own revocable key and let it write to the notebook",
      "Connect your app with a single Nostr sign-in",
      "Render results as live Generous views",
    ],
  },
  {
    icon: <Server size={24} />,
    title: "For teams",
    items: [
      "Run your own instance from the public source, or use a hosted workspace",
      "Keep your workspace, data, and identities under your control",
      "Connect it to shared agent memory through HAM",
    ],
  },
];

interface LinkButtonProps {
  href: string;
  icon: React.ReactNode;
  label: string;
  external?: boolean;
}

function LinkButton({ href, icon, label, external = false }: LinkButtonProps) {
  return (
    <a
      href={href}
      target={external ? "_blank" : undefined}
      rel={external ? "noopener noreferrer" : undefined}
      className="
        inline-flex items-center gap-2 px-5 py-2.5
        border border-card-border rounded-lg
        text-sm font-medium text-muted-foreground
        transition-all duration-200
        hover:border-galaxy hover:text-galaxy hover:bg-galaxy/5
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-galaxy focus-visible:ring-offset-2 focus-visible:ring-offset-background
      "
    >
      <span aria-hidden="true">{icon}</span>
      {label}
    </a>
  );
}

export function GbGetInvolved() {
  return (
    <section id="contribute" className="py-32" aria-labelledby="contribute-heading">
      <div className="max-w-6xl mx-auto px-6">
        {/* Heading */}
        <ScrollReveal direction="up">
          <div className="text-center mb-16">
            <p className="font-mono text-galaxy text-xs uppercase tracking-widest mb-4">
              WORK WITH US
            </p>
            <h2
              id="contribute-heading"
              className="font-display text-4xl md:text-5xl text-foreground mb-6"
            >
              Get in touch
            </h2>
            <p className="text-muted-foreground text-lg max-w-2xl mx-auto leading-relaxed">
              Galaxy Brain is shaped by the people using it for real research.
            </p>
          </div>
        </ScrollReveal>

        {/* Audience cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-12">
          {AUDIENCE_CARDS.map((card, index) => (
            <ScrollReveal
              key={card.title}
              direction="up"
              delay={0.1 + index * 0.1}
            >
              <article className="glass-card p-8 h-full flex flex-col gap-5">
                {/* Icon */}
                <div
                  className="inline-flex items-center justify-center w-12 h-12 rounded-lg bg-galaxy/12 text-galaxy flex-shrink-0"
                  aria-hidden="true"
                >
                  {card.icon}
                </div>

                {/* Title */}
                <h3 className="text-lg font-semibold text-foreground leading-snug">
                  {card.title}
                </h3>

                {/* Items */}
                <ul className="flex flex-col gap-2.5 flex-1">
                  {card.items.map((item) => (
                    <li key={item} className="flex items-start gap-2.5">
                      <span
                        className="mt-2 w-1.5 h-1.5 rounded-full bg-galaxy flex-shrink-0"
                        aria-hidden="true"
                      />
                      <span className="text-sm text-muted-foreground leading-relaxed">
                        {item}
                      </span>
                    </li>
                  ))}
                </ul>
              </article>
            </ScrollReveal>
          ))}
        </div>

        {/* Link buttons */}
        <ScrollReveal direction="up" delay={0.35}>
          <div className="flex flex-wrap justify-center gap-3">
            <LinkButton
              href="mailto:info@monumentalsystems.com?subject=Galaxy%20Brain%20invite"
              icon={<Mail size={16} />}
              label="Request an invite"
            />
            <LinkButton
              href="https://monumentalsystems.com"
              icon={<Globe size={16} />}
              label="Monumental Systems"
              external
            />
            <LinkButton
              href="https://github.com/MonumentalSystems/galaxy-brain"
              icon={<GitHubIcon className="h-4 w-4" />}
              label="Source on GitHub"
              external
            />
          </div>
        </ScrollReveal>
      </div>
    </section>
  );
}
