"use client";

import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

type Direction = "up" | "down" | "left" | "right";

interface ScrollRevealProps {
  children: React.ReactNode;
  className?: string;
  delay?: number;
  direction?: Direction;
}

const OFFSET = 40; // px to translate from

function getInitialTransform(direction: Direction): { x?: number; y?: number } {
  switch (direction) {
    case "up":    return { y:  OFFSET };
    case "down":  return { y: -OFFSET };
    case "left":  return { x:  OFFSET };
    case "right": return { x: -OFFSET };
  }
}

export function ScrollReveal({
  children,
  className,
  delay = 0,
  direction = "up",
}: ScrollRevealProps) {
  const initial = getInitialTransform(direction);

  return (
    <motion.div
      className={cn(className)}
      initial={{ opacity: 0, ...initial }}
      whileInView={{ opacity: 1, x: 0, y: 0 }}
      viewport={{ once: true, margin: "-100px" }}
      transition={{
        duration: 0.7,
        ease: "easeOut",
        delay,
      }}
    >
      {children}
    </motion.div>
  );
}
