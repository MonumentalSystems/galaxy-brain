"use client";

import { ScrollReveal } from "@/components/scroll-reveal";

const WORKING_TODAY = [
  "Canvas and lab notebook in a private workspace for each invited person",
  "Self-hosting on your own server with Docker Compose",
  "Sign-in with a passkey or a Nostr signer",
  "Document conversion for PDFs and office files",
  "Agents with revocable keys and signed requests",
  "HAM memory search and editing, and live Generous views",
];

const NOT_OPEN_YET = [
  "Public sign-up",
  "Sharing and collaboration between workspaces",
  "A hosted plan you can sign up for without an invite",
];

export function GbStatus() {
  return (
    <section
      id="status"
      className="bg-section-alt py-32"
      aria-labelledby="status-heading"
    >
      <div className="max-w-5xl mx-auto px-6">
        {/* Heading */}
        <ScrollReveal direction="up">
          <div className="text-center mb-16">
            <p className="font-mono text-galaxy text-xs uppercase tracking-widest mb-4">
              WHERE WE ARE
            </p>
            <h2
              id="status-heading"
              className="font-display text-4xl md:text-5xl text-foreground mb-6"
            >
              Invite-only alpha
            </h2>
            <p className="text-muted-foreground text-lg max-w-2xl mx-auto leading-relaxed">
              Galaxy Brain runs as a multi-tenant service for a small, trusted group, and as a
              self-hosted deployment. Each invited person gets their own private workspace while
              we harden it in daily use.
            </p>
          </div>
        </ScrollReveal>

        {/* Two-column layout */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          {/* Current Focus */}
          <ScrollReveal direction="left" delay={0.2}>
            <div className="glass-card p-8">
              <h3 className="font-display text-xl font-semibold text-foreground mb-6">
                Working today
              </h3>
              <ul className="flex flex-col gap-3">
                {WORKING_TODAY.map((item) => (
                  <li key={item} className="flex items-start gap-3">
                    <span
                      className="mt-2 w-2 h-2 rounded-full bg-galaxy flex-shrink-0"
                      aria-hidden="true"
                    />
                    <span className="text-muted-foreground leading-relaxed">
                      {item}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </ScrollReveal>

          {/* What You Can Do */}
          <ScrollReveal direction="right" delay={0.2}>
            <div className="glass-card p-8">
              <h3 className="font-display text-xl font-semibold text-foreground mb-6">
                Not open yet
              </h3>
              <ul className="flex flex-col gap-3">
                {NOT_OPEN_YET.map((item) => (
                  <li key={item} className="flex items-start gap-3">
                    <span
                      className="mt-2 w-2 h-2 rounded-full bg-galaxy flex-shrink-0"
                      aria-hidden="true"
                    />
                    <span className="text-muted-foreground leading-relaxed">
                      {item}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </ScrollReveal>
        </div>

        {/* CTA line */}
        <ScrollReveal direction="up" delay={0.35}>
          <p className="text-center text-muted-foreground mt-12 text-lg">
            Want to try it on your own research?{" "}
            <a
              href="mailto:info@monumentalsystems.com?subject=Galaxy%20Brain%20invite"
              className="text-galaxy hover:text-violet-light transition-colors duration-200 underline underline-offset-4"
            >
              Request an invite
            </a>
            .
          </p>
        </ScrollReveal>
      </div>
    </section>
  );
}
