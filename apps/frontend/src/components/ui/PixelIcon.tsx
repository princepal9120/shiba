import type { JSX, SVGProps } from "react";

export type PixelIconName =
  | "Memory"
  | "Email"
  | "Money"
  | "Texting"
  | "A computer"
  | "Sandboxes"
  | "Connectors"
  | "Overview"
  | "Activity"
  | "Agents"
  | "Skills"
  | "Finance"
  | "Admin"
  | "Users"
  | "Operations";

const PATHS: Record<PixelIconName, string> = {
  Memory:
    "M3 2h16l3 3v17H2V2h1zm3 1v7h12V3H6zm0 11v7h12v-7H6zm8-10h2v4h-2V4z",
  Email:
    "M2 5h20v15H2V5zm2 2v2h2v2h3v2h6v-2h3V9h2V7H4zm0 5v6h16v-6h-2v2h-3v2H9v-2H6v-2H4z",
  Money:
    "M3 4h18v3h2v13H1V7h2V4zm1 3v3h16V7H4zm0 6v4h5v-4H4zm9 0v2h6v-2h-6z",
  Texting:
    "M3 2h18v2h2v14h-9v2h-3v2H8v-4H1V4h2V2zm1 4v8h6v4h2v-4h8V6H4zm3 3h2v2H7V9zm4 0h2v2h-2V9zm4 0h2v2h-2V9z",
  "A computer":
    "M2 2h20v15h-8v3h5v2H5v-2h5v-3H2V2zm3 3v9h14V5H5z",
  Sandboxes:
    "M2 3h8v3h12v15H2V3zm2 5v10h16V8H4zm2 2h2v2h2v2H8v2H6v-2h2v-2H6v-2zm7 4h5v2h-5v-2z",
  Connectors:
    "M1 2h9v8H7v3h10v-3h-3V2h9v8h-4v5h-6v3h4v5H7v-5h4v-3H5v-5H1V2zm2 2v4h5V4H3zm13 0v4h5V4h-5zm-7 16v1h6v-1H9z",
  Overview:
    "M2 2h8v8H2V2zm2 2v4h4V4H4zm10-2h8v8h-8V2zm2 2v4h4V4h-4zM2 14h8v8H2v-8zm2 2v4h4v-4H4zm10-2h8v8h-8v-8zm2 2v4h4v-4h-4z",
  Activity:
    "M1 11h4V7h3V3h3v9h3v5h2v-6h7v2h-5v8h-5v-7H9V8H7v5H1v-2z",
  Agents:
    "M11 1h2v3h7v3h3v11h-3v3H4v-3H1V7h3V4h7V1zM6 6v13h12V6H6zm2 3h2v3H8V9zm6 0h2v3h-2V9zm-6 6h8v2H8v-2z",
  Skills:
    "M2 2h8v2h4V2h8v18h-8v2h-4v-2H2V2zm2 2v14h6V4H4zm10 0v14h6V4h-6z",
  Finance:
    "M10 2h4v2h4v2h4v4H2V6h4V4h4V2zM4 12h3v7H4v-7zm7 0h3v7h-3v-7zm7 0h3v7h-3v-7zM2 21h20v2H2v-2z",
  Admin:
    "M10 1h4v2h5v2h3v9h-2v4h-3v3h-3v2h-4v-2H7v-3H4v-4H2V5h3V3h5V1zm0 5H6v7h2v4h3v2h2v-2h3v-4h2V6h-4V4h-4v2z",
  Users:
    "M3 2h7v8H3V2zm2 2v4h3V4H5zm9-2h7v8h-7V2zm2 2v4h3V4h-3zM1 13h11v9H1v-9zm2 2v5h7v-5H3zm11-2h9v9h-9v-2h7v-5h-7v-2z",
  Operations:
    "M1 4h2v2h2V2h2v6H3V6H1V4zm9-1h13v2H10V3zm0 5h10v2H10V8zM1 16h2v2h2v-4h2v6H3v-2H1v-2zm9-1h13v2H10v-2zm0 5h10v2H10v-2z",
};

export interface PixelIconProps extends SVGProps<SVGSVGElement> {
  name: PixelIconName;
  size?: number;
  color?: string;
  className?: string;
}

export function PixelIcon({
  name,
  size = 20,
  color = "currentColor",
  className = "",
  ...props
}: PixelIconProps): JSX.Element {
  const path = PATHS[name] || PATHS.Overview;
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      fill={color}
      fillRule="evenodd"
      shapeRendering="crispEdges"
      aria-hidden="true"
      {...props}
    >
      <path d={path} />
    </svg>
  );
}

