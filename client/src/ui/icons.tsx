/**
 * Icon set drawn on a 16px grid with a 1.5px stroke so it matches the
 * weight of Geist at UI sizes. Decorative by default (aria-hidden).
 */
import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 16, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const ArrowRight = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 8h10M9 4l4 4-4 4" />
  </Icon>
);

export const ArrowLeft = (p: IconProps) => (
  <Icon {...p}>
    <path d="M13 8H3M7 4 3 8l4 4" />
  </Icon>
);

export const Speaker = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2.5 6h2l3-2.5v9L4.5 10h-2z" />
    <path d="M10.5 5.5a3.5 3.5 0 0 1 0 5M12.5 3.5a6.3 6.3 0 0 1 0 9" />
  </Icon>
);

export const SpeakerOff = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2.5 6h2l3-2.5v9L4.5 10h-2z" />
    <path d="m10.5 6 3.5 4M14 6l-3.5 4" />
  </Icon>
);

export const Pause = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5.5 3.5v9M10.5 3.5v9" />
  </Icon>
);

export const Play = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4.5 3.2v9.6L12.5 8z" />
  </Icon>
);

export const Stop = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3.5" y="3.5" width="9" height="9" rx="1" />
  </Icon>
);

export const Copy = (p: IconProps) => (
  <Icon {...p}>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
    <path d="M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
  </Icon>
);

export const Check = (p: IconProps) => (
  <Icon {...p}>
    <path d="m3 8.5 3 3 7-7" />
  </Icon>
);

export const Share = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 2v8M5 5l3-3 3 3" />
    <path d="M4 8H3.5a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1H12" />
  </Icon>
);

export const Broadcast = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="1.25" fill="currentColor" stroke="none" />
    <path d="M5.2 10.8a4 4 0 0 1 0-5.6M10.8 5.2a4 4 0 0 1 0 5.6" />
    <path d="M3.1 12.9a7 7 0 0 1 0-9.8M12.9 3.1a7 7 0 0 1 0 9.8" />
  </Icon>
);

export const Headphones = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2.5 11V8a5.5 5.5 0 0 1 11 0v3" />
    <rect x="2.5" y="9.5" width="3" height="4" rx="1" />
    <rect x="10.5" y="9.5" width="3" height="4" rx="1" />
  </Icon>
);

export const Warning = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 2.5 14 13H2z" />
    <path d="M8 6.5v3" />
    <circle cx="8" cy="11.25" r=".4" fill="currentColor" />
  </Icon>
);
