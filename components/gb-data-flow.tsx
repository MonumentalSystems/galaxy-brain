"use client";

import { useRef, useId } from "react";
import { motion, useInView } from "framer-motion";
import { Brain, Sparkles, Gamepad2 } from "lucide-react";
import { ScrollReveal } from "@/components/scroll-reveal";

interface FlowStep {
  id: number;
  label: string;
  sublabel: string;
  icon: React.ReactNode;
  color: string;
  textColor: string;
  borderColor: string;
  glowColor: string;
}

const STEPS: FlowStep[] = [
  {
    id: 1,
    label: "Galaxy Brain",
    sublabel: "where research is collected, structured, and recorded",
    icon: <Brain size={22} />,
    color: "bg-galaxy/12",
    textColor: "text-galaxy",
    borderColor: "border-cyan-400/40",
    glowColor: "#59D7FF",
  },
  {
    id: 3,
    label: "Generous",
    sublabel: "renders results as live, interactive views",
    icon: <Sparkles size={22} />,
    color: "bg-blue-500/10",
    textColor: "text-generous",
    borderColor: "border-blue-500/40",
    glowColor: "#4A78FF",
  },
  {
    id: 4,
    label: "Agents",
    sublabel: "work under their own keys, with shared memory through HAM",
    icon: <Gamepad2 size={22} />,
    color: "bg-cyan-500/10",
    textColor: "text-agents",
    borderColor: "border-cyan-500/40",
    glowColor: "#38C7FF",
  },
];

interface AnimatedConnectorProps {
  fromColor: string;
  toColor: string;
  index: number;
  isInView: boolean;
}

function AnimatedConnector({ fromColor, toColor, index, isInView }: AnimatedConnectorProps) {
  const uid = useId();
  const gradId = `grad-${uid}-${index}`;

  return (
    <div className="flex flex-col items-center h-16 relative" aria-hidden="true">
      <svg
        width="2"
        height="64"
        viewBox="0 0 2 64"
        fill="none"
        className="absolute top-0"
      >
        <defs>
          <linearGradient
            id={gradId}
            x1="0"
            y1="0"
            x2="0"
            y2="1"
            gradientUnits="objectBoundingBox"
          >
            <stop offset="0%" stopColor={fromColor} />
            <stop offset="100%" stopColor={toColor} />
          </linearGradient>
        </defs>
        {/* Track */}
        <line
          x1="1"
          y1="0"
          x2="1"
          y2="64"
          stroke="currentColor"
          strokeWidth="2"
          strokeOpacity="0.15"
        />
        {/* Animated fill */}
        <motion.line
          x1="1"
          y1="0"
          x2="1"
          y2="64"
          stroke={`url(#${gradId})`}
          strokeWidth="2"
          strokeLinecap="round"
          initial={{ pathLength: 0, opacity: 0 }}
          animate={
            isInView
              ? { pathLength: 1, opacity: 1 }
              : { pathLength: 0, opacity: 0 }
          }
          transition={{
            delay: 0.3 + index * 0.25,
            duration: 0.6,
            ease: "easeOut",
          }}
        />
      </svg>

      {/* Travelling dot */}
      <motion.div
        className="absolute w-1.5 h-1.5 rounded-full"
        style={{ background: fromColor }}
        initial={{ top: 0, opacity: 0 }}
        animate={
          isInView
            ? {
                top: [0, 56],
                opacity: [0, 1, 1, 0],
              }
            : { top: 0, opacity: 0 }
        }
        transition={{
          delay: 0.6 + index * 0.25,
          duration: 0.8,
          ease: "easeInOut",
        }}
      />
    </div>
  );
}

interface FlowStepCardProps {
  step: FlowStep;
  index: number;
  isInView: boolean;
}

function FlowStepCard({ step, index, isInView }: FlowStepCardProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 30 }}
      animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 30 }}
      transition={{
        delay: 0.15 + index * 0.2,
        type: "spring",
        stiffness: 70,
        damping: 18,
      }}
      className={`
        relative flex items-center gap-4 px-6 py-4
        rounded-lg border ${step.borderColor} ${step.color}
        w-full max-w-sm mx-auto
        backdrop-blur-sm
      `}
      style={{
        boxShadow: isInView
          ? `0 0 24px 0 ${step.glowColor}22`
          : "none",
      }}
    >
      <span className={`flex-shrink-0 ${step.textColor}`}>
        {step.icon}
      </span>
      <div>
        <p className={`font-semibold text-sm ${step.textColor}`}>
          {step.label}
        </p>
        {step.sublabel && (
          <p className="text-xs text-muted-foreground mt-0.5">{step.sublabel}</p>
        )}
      </div>
    </motion.div>
  );
}

export function GbDataFlow() {
  const sectionRef = useRef<HTMLDivElement>(null);
  const isInView = useInView(sectionRef, { once: true, margin: "0px 0px -80px 0px" });

  return (
    <section
      id="flow"
      className="py-32"
      aria-labelledby="flow-heading"
    >
      <div className="max-w-5xl mx-auto px-6">
        {/* Heading */}
        <ScrollReveal direction="up">
          <div className="text-center mb-20">
            <p className="font-mono text-galaxy text-xs uppercase tracking-widest mb-4">
              HOW IT FITS TOGETHER
            </p>
            <h2
              id="flow-heading"
              className="font-display text-4xl md:text-5xl text-foreground mb-6"
            >
              One identity, one stack
            </h2>
            <p className="text-muted-foreground text-lg max-w-2xl mx-auto leading-relaxed">
              Galaxy Brain is part of Monumental Systems&apos; stack for scalable science. The
              same Nostr key identifies a person across Galaxy Brain, HAM, and Hyades, so your
              identity and your work stay yours as they move between tools.
            </p>
          </div>
        </ScrollReveal>

        {/* Flow diagram */}
        <div ref={sectionRef} className="flex flex-col items-center">
          {STEPS.map((step, index) => (
            <div key={step.id} className="flex flex-col items-center w-full">
              <FlowStepCard
                step={step}
                index={index}
                isInView={isInView}
              />
              {index < STEPS.length - 1 && (
                <AnimatedConnector
                  fromColor={step.glowColor}
                  toColor={STEPS[index + 1].glowColor}
                  index={index}
                  isInView={isInView}
                />
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
