import type { ComponentProps } from "react";

export function GitHubIcon(props: ComponentProps<"svg">) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3.28-.36 6.72-1.61 6.72-7.25A5.65 5.65 0 0 0 19.22 3.3 5.27 5.27 0 0 0 19.13 1S17.95.65 15 2.48a13.38 13.38 0 0 0-7 0C5.05.65 3.87 1 3.87 1a5.27 5.27 0 0 0-.09 2.3A5.65 5.65 0 0 0 2.27 7.25c0 5.63 3.44 6.88 6.72 7.25A4.8 4.8 0 0 0 8 18v4" />
      <path d="M8 19c-3 .92-3-2-4.2-2.4" />
    </svg>
  );
}
