"use client";

import { Database, ScanSearch, KeyRound, LayoutDashboard, Puzzle } from "lucide-react";
import { ScrollReveal } from "@/components/scroll-reveal";

interface FeatureCard {
  icon: React.ReactNode;
  title: string;
  description: string;
}

const FEATURE_CARDS: FeatureCard[] = [
  {
    icon: <LayoutDashboard size={24} />,
    title: "An infinite canvas",
    description:
      "A writable canvas for notes, files, experiments, and structured views. Lay out what you’re working on the way you think about it, not the way a folder tree allows.",
  },
  {
    icon: <Database size={24} />,
    title: "An electronic lab notebook",
    description:
      "Structured notebook records stored on the server and scoped to your own workspace, so the record of an investigation lives next to the material it came from.",
  },
  {
    icon: <ScanSearch size={24} />,
    title: "Documents in, structure out",
    description:
      "PDFs and office documents are converted to clean, structured text, and an arXiv review workbench lets you read and annotate papers, redistributing only openly licensed PDFs.",
  },
  {
    icon: <KeyRound size={24} />,
    title: "Agents with their own keys",
    description:
      "Each agent gets an independently revocable Nostr key and signs every notebook request, bound to the exact address, method, and content. No shared tokens to leak.",
  },
  {
    icon: <Puzzle size={24} />,
    title: "Connected to the rest of the stack",
    description:
      "Search and edit HAM memories without leaving the canvas, render agent results as live Generous views, and let other apps connect with a single Nostr sign-in.",
  },
];

function FeatureCardUI({ card }: { card: FeatureCard }) {
  return (
    <article className="glass-card p-8 h-full flex flex-col gap-5">
      <div
        className="inline-flex items-center justify-center w-12 h-12 rounded-lg bg-galaxy/12 text-galaxy flex-shrink-0"
        aria-hidden="true"
      >
        {card.icon}
      </div>
      <h3 className="text-xl font-semibold text-foreground leading-snug">
        {card.title}
      </h3>
      <p className="text-muted-foreground leading-relaxed flex-1">
        {card.description}
      </p>
    </article>
  );
}

export function GbFeatures() {
  const topRow = FEATURE_CARDS.slice(0, 3);
  const bottomRow = FEATURE_CARDS.slice(3);

  return (
    <section
      id="features"
      className="bg-section-alt py-32"
      aria-labelledby="features-heading"
    >
      <div className="max-w-6xl mx-auto px-6">
        {/* Heading */}
        <ScrollReveal direction="up">
          <div className="text-center mb-16">
            <p className="font-mono text-galaxy text-xs uppercase tracking-widest mb-4">
              CAPABILITIES
            </p>
            <h2
              id="features-heading"
              className="font-display text-4xl md:text-5xl text-foreground"
            >
              What you can do in it
            </h2>
          </div>
        </ScrollReveal>

        {/* Top row: 3 cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-6">
          {topRow.map((card, index) => (
            <ScrollReveal
              key={card.title}
              direction="up"
              delay={0.1 + index * 0.08}
            >
              <FeatureCardUI card={card} />
            </ScrollReveal>
          ))}
        </div>

        {/* Bottom row: 2 cards, centered */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-4xl mx-auto">
          {bottomRow.map((card, index) => (
            <ScrollReveal
              key={card.title}
              direction="up"
              delay={0.34 + index * 0.08}
            >
              <FeatureCardUI card={card} />
            </ScrollReveal>
          ))}
        </div>
      </div>
    </section>
  );
}
