import { dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))

/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: __dirname,
  images: {
    unoptimized: true,
  },
  async rewrites() {
    // Surfaces live in the same backend the ELN proxy fronts, so /api/surfaces
    // is an alias rather than a second route: same identity envelope, same
    // scope checks, same body limits. The alias exists because
    // /api/eln/surfaces reads as though surfaces belong to the notebook, and an
    // external caller should not have to know otherwise. Note /surfaces without
    // the /api prefix is the browser page and redirects to /login, which is a
    // confusing thing for an API client to land on.
    return [
      { source: "/api/surfaces", destination: "/api/eln/surfaces" },
      { source: "/api/surfaces/:path*", destination: "/api/eln/surfaces/:path*" },
    ]
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "same-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), geolocation=(), microphone=(self)",
          },
        ],
      },
    ]
  },
}

export default nextConfig
