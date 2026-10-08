"use client";

import { ScrollReveal } from "@/components/scroll-reveal";

export function GbIntro() {
  return (
    <section
      id="about"
      className="pt-10 pb-20 md:pt-16 md:pb-24 lg:pt-20 lg:pb-28"
      aria-labelledby="about-heading"
    >
      <div className="max-w-3xl mx-auto px-6 text-center">
        {/* Eyebrow */}
        <p className="font-mono text-galaxy text-xs uppercase tracking-widest mb-4">
          WHAT IS GALAXY BRAIN?
        </p>

        {/* Title */}
        <ScrollReveal direction="up" delay={0.08}>
          <h2
            id="about-heading"
            className="font-display text-4xl md:text-5xl text-foreground mb-8 leading-tight"
          >
            A research workspace
          </h2>
        </ScrollReveal>

        {/* Body */}
        <div className="flex flex-col gap-6">
          <ScrollReveal direction="up" delay={0.16}>
            <p className="text-lg leading-relaxed text-muted-foreground">
              Galaxy Brain is a research workspace from Monumental Systems. It joins an
              infinite canvas to an electronic lab notebook, so the papers you&apos;re reading,
              the notes you&apos;re making, and the experiments you&apos;re running sit side by
              side. Every workspace is private to its owner, whether we host it or you run it
              on your own hardware.
            </p>
          </ScrollReveal>

          <ScrollReveal direction="up" delay={0.24}>
            <p className="text-lg leading-relaxed text-muted-foreground">
              Agents work in it too, under their own keys. Notes, documents, notebook records,
              and agent memory stay connected, so the next investigation starts where the last
              one ended instead of from a blank page.
            </p>
          </ScrollReveal>

          <ScrollReveal direction="up" delay={0.32}>
            <p className="text-xl italic leading-relaxed gradient-text">
              The name comes from internet culture: &ldquo;galaxy brain&rdquo; thinking that
              expands beyond conventional boundaries. The project matches the ambition.
            </p>
          </ScrollReveal>
        </div>
      </div>
    </section>
  );
}
