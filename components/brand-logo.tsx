import Image from "next/image";

interface BrandLogoProps {
  className?: string;
  priority?: boolean;
  size?: number;
}

export function BrandLogo({
  className,
  priority = false,
  size = 80,
}: BrandLogoProps) {
  return (
    <Image
      src="/brand/galaxy-brain-logo.png"
      alt="Galaxy Brain logo"
      width={size}
      height={size}
      priority={priority}
      className={className}
    />
  );
}
