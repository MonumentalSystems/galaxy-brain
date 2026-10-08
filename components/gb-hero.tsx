"use client";

import { motion } from "framer-motion";
import { ArrowRight, ArrowLeft, LogIn, Mail } from "lucide-react";
import { BrandLogo } from "@/components/brand-logo";
import { cn } from "@/lib/utils";
import { ParticleBg } from "@/components/particle-bg";

const HEADLINE = "Galaxy Brain";

const containerVariants = {
  hidden: {},
  visible: {
    transition: {
      staggerChildren: 0.12,
    },
  },
};

const wordVariants = {
  hidden: { opacity: 0, y: 40, filter: "blur(4px)" },
  visible: {
    opacity: 1,
    y: 0,
    filter: "blur(0px)",
    transition: {
      duration: 0.55,
      ease: [0.22, 1, 0.36, 1] as [number, number, number, number],
    },
  },
};

const fadeUp = {
  hidden: { opacity: 0, y: 20 },
  visible: (delay: number) => ({
    opacity: 1,
    y: 0,
    transition: {
      delay,
      duration: 0.6,
      ease: [0.22, 1, 0.36, 1] as [number, number, number, number],
    },
  }),
};

export function GbHero() {
  const words = HEADLINE.split(" ");

  return (
    <section
      className={cn(
        "relative flex min-h-[88svh] flex-col items-center justify-center overflow-hidden md:min-h-[86svh] lg:min-h-[82svh]",
        "px-5 py-16 text-center md:px-6 md:py-24"
      )}
    >
      {/* Particle background */}
      <ParticleBg className="absolute inset-0" />

      {/* Breadcrumb */}
      <motion.a
        href="https://monumentalsystems.com"
        custom={0.2}
        variants={fadeUp}
        initial="hidden"
        animate="visible"
        className={cn(
          "absolute top-6 left-6 z-20 inline-flex items-center gap-1.5",
          "text-sm text-muted-foreground transition-colors duration-200",
          "hover:text-galaxy",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-galaxy focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        )}
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
        Monumental Systems
      </motion.a>

      {/* Main content */}
      <div className="relative z-10 flex flex-col items-center gap-5 md:gap-8">
        <motion.div
          custom={0.15}
          variants={fadeUp}
          initial="hidden"
          animate="visible"
          className="relative"
        >
          <BrandLogo
            size={132}
            priority
            className="relative h-20 w-20 md:h-32 md:w-32"
          />
        </motion.div>

        {/* Headline */}
        <motion.h1
          className="font-display text-4xl font-bold leading-tight tracking-normal sm:text-5xl md:text-7xl lg:text-8xl"
          aria-label={HEADLINE}
          variants={containerVariants}
          initial="hidden"
          animate="visible"
        >
          {words.map((word, i) => (
            <motion.span
              key={i}
              variants={wordVariants}
              className="mr-[0.25em] inline-block last:mr-0 gradient-text"
            >
              {word}
            </motion.span>
          ))}
        </motion.h1>

        {/* Subtitle */}
        <motion.p
          custom={0.5}
          variants={fadeUp}
          initial="hidden"
          animate="visible"
          className="font-display text-xl italic text-galaxy sm:text-2xl md:text-3xl"
        >
          The universal mind.
        </motion.p>

        {/* Description */}
        <motion.p
          custom={0.75}
          variants={fadeUp}
          initial="hidden"
          animate="visible"
          className="max-w-2xl text-base leading-relaxed text-muted-foreground sm:text-lg md:text-xl"
        >
          A research workspace for people and agents: an infinite canvas joined to an electronic
          lab notebook. Use it in your own private workspace, or run it on your own server.
        </motion.p>

        {/* CTA buttons */}
        <motion.div
          custom={1.0}
          variants={fadeUp}
          initial="hidden"
          animate="visible"
          className="flex flex-col items-center gap-3 sm:flex-row sm:gap-4"
        >
          {/* Primary action */}
          <a
            href="/login"
            className={cn(
              "group inline-flex h-12 items-center gap-2 rounded-lg px-6",
              "bg-galaxy text-sm font-semibold text-white",
              "transition-all duration-200",
              "hover:bg-cyan hover:shadow-[0_0_24px_rgba(89,215,255,0.38)]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-galaxy",
              "focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            )}
          >
            <LogIn className="h-4 w-4" aria-hidden="true" />
            Open workspace
            <ArrowRight
              className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5"
              aria-hidden="true"
            />
          </a>

          {/* Secondary action */}
          <a
            href="mailto:info@monumentalsystems.com?subject=Galaxy%20Brain%20invite"
            className={cn(
              "inline-flex h-12 items-center gap-2 rounded-lg border",
              "border-foreground/20 px-6 text-sm font-semibold text-foreground",
              "transition-all duration-200",
              "hover:border-galaxy/40 hover:bg-galaxy/5",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/50",
              "focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            )}
          >
            <Mail className="h-4 w-4" aria-hidden="true" />
            Request an invite
          </a>
        </motion.div>

        {/* Galaxy brain tagline */}
        <motion.p
          custom={1.3}
          variants={fadeUp}
          initial="hidden"
          animate="visible"
          className="font-mono text-xs tracking-widest text-muted/50"
          aria-hidden="true"
        >
          GALAXY BRAIN / UNIVERSAL MIND
        </motion.p>
      </div>

      {/* Scroll indicator */}
      <motion.div
        custom={1.6}
        variants={fadeUp}
        initial="hidden"
        animate="visible"
        className="absolute bottom-8 left-1/2 hidden -translate-x-1/2 md:block"
        aria-hidden="true"
      >
        <div className="flex flex-col items-center gap-1.5">
          <span className="text-xs tracking-widest text-muted uppercase">
            scroll
          </span>
          <div className="h-8 w-px bg-gradient-to-b from-muted to-transparent" />
        </div>
      </motion.div>
    </section>
  );
}
