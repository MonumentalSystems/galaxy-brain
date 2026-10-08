"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  color: string;
  opacity: number;
}

interface ParticleBgProps {
  className?: string;
  colors?: string[];
}

// Electric blue palette (default)
const DEFAULT_COLORS = [
  "89, 215, 255",   // primary cyan-blue
  "89, 215, 255",   // primary cyan-blue (weighted)
  "123, 231, 255",  // light cyan
  "42, 140, 255",   // deep blue
  "226, 232, 240",  // foreground dim
];

const PARTICLE_COUNT = 60;
const CONNECTION_DISTANCE = 120;
const CONNECTION_DISTANCE_SQ = CONNECTION_DISTANCE * CONNECTION_DISTANCE;
const BASE_SPEED = 0.22;

function buildParticles(count: number, width: number, height: number, colors: string[]): Particle[] {
  return Array.from({ length: count }, () => {
    const angle = Math.random() * Math.PI * 2;
    const speed = BASE_SPEED * (0.5 + Math.random() * 0.8);
    return {
      x: Math.random() * width,
      y: Math.random() * height,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      radius: 1 + Math.random(),
      color: colors[Math.floor(Math.random() * colors.length)],
      opacity: 0.1 + Math.random() * 0.3,
    };
  });
}

export function ParticleBg({ className, colors }: ParticleBgProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const colorsRef = useRef(colors ?? DEFAULT_COLORS);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const palette = colorsRef.current;

    let animationId: number = 0;
    let particles: Particle[] = [];
    let resizeTimer: ReturnType<typeof setTimeout>;
    let isRunning = true;

    function resize() {
      if (!canvas) return;
      canvas.width = canvas.offsetWidth;
      canvas.height = canvas.offsetHeight;
      particles = buildParticles(PARTICLE_COUNT, canvas.width, canvas.height, palette);
    }

    function tick() {
      if (!canvas || !ctx || !isRunning) return;

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const w = canvas.width;
      const h = canvas.height;

      for (const p of particles) {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < -10) p.x = w + 10;
        else if (p.x > w + 10) p.x = -10;
        if (p.y < -10) p.y = h + 10;
        else if (p.y > h + 10) p.y = -10;
      }

      // Draw connection lines
      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const a = particles[i];
          const b = particles[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const distSq = dx * dx + dy * dy;

          if (distSq < CONNECTION_DISTANCE_SQ) {
            const dist = Math.sqrt(distSq);
            const lineOpacity = (1 - dist / CONNECTION_DISTANCE) * 0.07;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.strokeStyle = `rgba(${a.color}, ${lineOpacity})`;
            ctx.lineWidth = 0.5;
            ctx.stroke();
          }
        }
      }

      for (const p of particles) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${p.color}, ${p.opacity})`;
        ctx.fill();
      }

      animationId = requestAnimationFrame(tick);
    }

    const observer = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(resize, 150);
    });
    observer.observe(canvas);

    function handleVisibilityChange() {
      if (document.hidden) {
        isRunning = false;
        cancelAnimationFrame(animationId);
      } else {
        isRunning = true;
        animationId = requestAnimationFrame(tick);
      }
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);

    resize();

    if (prefersReduced) {
      tick();
      cancelAnimationFrame(animationId);
    } else {
      animationId = requestAnimationFrame(tick);
    }

    return () => {
      isRunning = false;
      cancelAnimationFrame(animationId);
      clearTimeout(resizeTimer);
      observer.disconnect();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={cn("pointer-events-none z-0", className)}
    />
  );
}
