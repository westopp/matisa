import type { CSSProperties, ReactNode } from "react"

// Stroke icons, 1.6px on a 24px grid — lifted from the design bundle.

interface IconProps {
  readonly size?: number
  readonly sw?: number
  readonly fill?: string
  readonly style?: CSSProperties
}

interface BaseProps extends IconProps {
  readonly d: string | ReactNode
}

const Icon = ({ d, size = 16, sw = 1.6, fill = "none", style }: BaseProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill={fill}
    stroke="currentColor"
    strokeWidth={sw}
    strokeLinecap="round"
    strokeLinejoin="round"
    style={style}
  >
    {typeof d === "string" ? <path d={d} /> : d}
  </svg>
)

export const Icons = {
  Search: (p: IconProps) => <Icon {...p} d="M10.5 18a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15Zm5.3-2.3 5 5" />,
  ChevronDown: (p: IconProps) => <Icon {...p} d="M6 9l6 6 6-6" />,
  ChevronRight: (p: IconProps) => <Icon {...p} d="M9 6l6 6-6 6" />,
  ArrowDownCircle: (p: IconProps) => <Icon {...p} d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 8v8m-3.5-3.5L12 16l3.5-3.5" />,
  /** Clear the terminal. Lucide's `list-x`: lines with an X taken to them. It
   *  shares its vocabulary with `Logs` below — same lines, same grid — so what
   *  it acts ON is legible, which an eraser or a bin never made clear. */
  Eraser: (p: IconProps) => (
    <Icon
      {...p}
      d={
        <>
          <path d="M11 12H3" />
          <path d="M16 6H3" />
          <path d="M16 18H3" />
          <path d="m17 10 4 4" />
          <path d="m21 10-4 4" />
        </>
      }
    />
  ),
  Play: (p: IconProps) => <Icon {...p} d="M7 4.5v15l13-7.5L7 4.5Z" fill="currentColor" sw={0} />,
  Stop: (p: IconProps) => <Icon {...p} d={<rect x="5.5" y="5.5" width="13" height="13" rx="2.5" />} fill="currentColor" sw={0} />,
  Restart: (p: IconProps) => <Icon {...p} d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1M3.5 4v4h4" />,
  /** Reset a failure back to rest. Deliberately the MIRROR of Restart — the two
   *  sit close together on a broken project and must not be the same picture:
   *  one runs the thing again, this one only forgets that it broke. */
  Reset: (p: IconProps) => <Icon {...p} d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1M20.5 4v4h-4" />,
  Folder: (p: IconProps) => <Icon {...p} d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />,
  Compass: (p: IconProps) => (
    <Icon {...p} d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm3.5-12.5-2.1 5.4-5.4 2.1 2.1-5.4 5.4-2.1Z" />
  ),
  Copy: (p: IconProps) => <Icon {...p} d="M8 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2Zm-2-4h10a2 2 0 0 1 2 2" />,
  Code: (p: IconProps) => <Icon {...p} d="m9 8-5 4 5 4m6-8 5 4-5 4M14 4l-4 16" />,
  Terminal: (p: IconProps) => <Icon {...p} d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6Zm3 4 3 2-3 2m4 0h5" />,
  X: (p: IconProps) => <Icon {...p} d="M6 6l12 12M18 6 6 18" />,
  Check: (p: IconProps) => <Icon {...p} d="M5 12.5 10 17.5 19 6.5" />,
  Image: (p: IconProps) => (
    <Icon {...p} d="M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5Zm2 11 4-4 3.5 3.5L16 12l3 3M9 9.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z" />
  ),
  XCircle: (p: IconProps) => <Icon {...p} d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm-3-12 6 6m0-6-6 6" />,
  /** The failure glyph. A triangle reads as "something is wrong" at a glance and
   *  at any size — which a dot cannot, since a dot is already how every settled
   *  state is drawn. */
  Alert: (p: IconProps) => (
    <Icon
      {...p}
      d={
        <>
          <path d="M10.3 3.9 1.9 18.4A2 2 0 0 0 3.6 21.4h16.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
          <path d="M12 9.4v4.4" />
          <path d="M12 17.4h.01" />
        </>
      }
    />
  ),
  Eye: (p: IconProps) => <Icon {...p} d={<><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" /><circle cx="12" cy="12" r="3" /></>} />,
  EyeOff: (p: IconProps) => <Icon {...p} d="M4 4l16 16M9.9 5.2A9.6 9.6 0 0 1 12 5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-2.4 3M6.2 7.3A15.5 15.5 0 0 0 2.5 11.5S6 18 12 18a9.2 9.2 0 0 0 3.3-.6M9.5 9.6a3 3 0 0 0 4.2 4.2" />,
  Trash: (p: IconProps) => (
    <Icon {...p} d="M4 7h16M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2m-9 0 1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13" />
  ),
  Broadcast: (p: IconProps) => (
    <Icon {...p} d="M5.2 9a8 8 0 0 1 0-2m13.6 2a8 8 0 0 0 0-2M7.5 11a5 5 0 0 1 0-4m9 4a5 5 0 0 0 0-4M10 13a2 2 0 1 0 4 0 2 2 0 0 0-4 0Zm2 2v6" />
  ),
  PanelLeft: (p: IconProps) => <Icon {...p} d="M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5Zm6 0v16" />,
  PanelRight: (p: IconProps) => <Icon {...p} d="M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5Zm12 0v16" />,
  FolderOpen: (p: IconProps) => (
    <Icon {...p} d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2H3Zm0 0v10a2 2 0 0 0 2 2h13a2 2 0 0 0 1.9-1.4L22 11H6.5a2 2 0 0 0-1.9 1.4L3 17" />
  ),
  Sun: (p: IconProps) => (
    <Icon {...p} d="M12 4V2m0 20v-2m8-8h2M2 12h2m13.7-5.7 1.4-1.4M4.9 19.1l1.4-1.4m11.4 0 1.4 1.4M4.9 4.9l1.4 1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z" />
  ),
  Moon: (p: IconProps) => <Icon {...p} d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" />,
  Plus: (p: IconProps) => <Icon {...p} d="M12 5v14M5 12h14" />,
  FolderPlus: (p: IconProps) => (
    <Icon {...p} d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Zm9 4v6m-3-3h6" />
  ),
  Power: (p: IconProps) => <Icon {...p} d="M12 3v9M6.6 6.6a7.5 7.5 0 1 0 10.8 0" />,
  /** Force-kill. Lucide's `skull`, in two weights off one outline.
   *
   *  `filled` is the live state: the same silhouette flooded with colour, with
   *  the sockets and nose punched back out by `evenodd` rather than painted in
   *  a background colour — a knockout stays a hole on any surface the button
   *  sits on. The sockets are a hair wider than the stroke version's because a
   *  2px hole in a solid shape closes up at this size, while the same circle
   *  drawn as a ring does not. */
  Skull: ({ filled = false, ...p }: IconProps & { readonly filled?: boolean }) =>
    filled ? (
      <Icon
        {...p}
        fill="currentColor"
        sw={0}
        d={
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M15 22a1 1 0 0 0 1-1v-1a2 2 0 0 0 1.56-3.25 8 8 0 1 0-11.12 0A2 2 0 0 0 8 20v1a1 1 0 0 0 1 1zM12.5 17l-.5-1-.5 1h1zM16.35 12a1.35 1.35 0 1 1-2.7 0 1.35 1.35 0 0 1 2.7 0zM10.35 12a1.35 1.35 0 1 1-2.7 0 1.35 1.35 0 0 1 2.7 0z"
          />
        }
      />
    ) : (
      <Icon
        {...p}
        d={
          <>
            <path d="m12.5 17-.5-1-.5 1h1z" />
            <path d="M15 22a1 1 0 0 0 1-1v-1a2 2 0 0 0 1.56-3.25 8 8 0 1 0-11.12 0A2 2 0 0 0 8 20v1a1 1 0 0 0 1 1z" />
            <circle cx="15" cy="12" r="1" />
            <circle cx="9" cy="12" r="1" />
          </>
        }
      />
    ),
  Logs: (p: IconProps) => <Icon {...p} d="M4 6h16M4 10h10M4 14h16M4 18h7" />,
  /** Back to the full board — four tiles, which is what the board looks like. */
  Grid: (p: IconProps) => (
    <Icon
      {...p}
      d="M4 5.5A1.5 1.5 0 0 1 5.5 4h4A1.5 1.5 0 0 1 11 5.5v4A1.5 1.5 0 0 1 9.5 11h-4A1.5 1.5 0 0 1 4 9.5v-4Zm9 0A1.5 1.5 0 0 1 14.5 4h4A1.5 1.5 0 0 1 20 5.5v4a1.5 1.5 0 0 1-1.5 1.5h-4A1.5 1.5 0 0 1 13 9.5v-4Zm-9 9A1.5 1.5 0 0 1 5.5 13h4a1.5 1.5 0 0 1 1.5 1.5v4A1.5 1.5 0 0 1 9.5 20h-4A1.5 1.5 0 0 1 4 18.5v-4Zm9 0A1.5 1.5 0 0 1 14.5 13h4a1.5 1.5 0 0 1 1.5 1.5v4a1.5 1.5 0 0 1-1.5 1.5h-4a1.5 1.5 0 0 1-1.5-1.5v-4Z"
    />
  ),
  Cpu: (p: IconProps) => <Icon {...p} d="M7 7h10v10H7zM4 9v6m16-6v6M9 4h6m-6 16h6M4 9h2m12 0h2M4 15h2m12 0h2" />,
  Stack: (p: IconProps) => <Icon {...p} d="m3 7 9-4 9 4-9 4-9-4Zm0 5 9 4 9-4M3 17l9 4 9-4" />,
  Globe: (p: IconProps) => (
    <Icon {...p} d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0 0c2.5 0 4.5-4 4.5-9S14.5 3 12 3 7.5 7 7.5 12s2 9 4.5 9Zm-9-9h18" />
  ),
  Activity: (p: IconProps) => <Icon {...p} d="M3 12h4l3-8 4 16 3-8h4" />,
  More: (p: IconProps) => <Icon {...p} d="M5 12h.01M12 12h.01M19 12h.01" sw={2.4} />,
  Refresh: (p: IconProps) => <Icon {...p} d="M21 12a9 9 0 1 1-2.7-6.4M21 4v5h-5" />,
  CollapseAll: (p: IconProps) => <Icon {...p} d="M8 4l4 4 4-4M8 20l4-4 4 4M4 12h16" />,
  /** Show only this one — brackets closing in on a single subject. Distinct
   *  from CollapseAll, which shuts everything including what you are looking at. */
  Focus: (p: IconProps) => (
    <Icon {...p} d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8m8 0h2.5A1.5 1.5 0 0 1 20 5.5V8m0 8v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16m10.5-4a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z" />
  ),
  ExpandAll: (p: IconProps) => <Icon {...p} d="M8 9l4-4 4 4M8 15l4 4 4-4M4 12h16" />,
  Maximize: (p: IconProps) => <Icon {...p} d="M4 9V5a1 1 0 0 1 1-1h4M20 15v4a1 1 0 0 1-1 1h-4M15 4h4a1 1 0 0 1 1 1v4M9 20H5a1 1 0 0 1-1-1v-4" />,
  Minimize: (p: IconProps) => <Icon {...p} d="M9 4v4a1 1 0 0 1-1 1H4m16 0h-4a1 1 0 0 1-1-1V4M4 15h4a1 1 0 0 1 1 1v4m6 0v-4a1 1 0 0 1 1-1h4" />,
  Docker: (p: IconProps) => <Icon {...p} d="M4 11h16a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5Zm2-3h3v3H6V8Zm4 0h3v3h-3V8Zm4 0h3v3h-3V8Zm-4-4h3v3h-3V4Z" />,
  Key: (p: IconProps) => <Icon {...p} d="M15 7a4 4 0 1 1-3.4 6.1L9 15.7V18H6.5v2.5H4V18l5.6-5.6A4 4 0 0 1 15 7Zm1.2 2.8h.01" />,
  Edit: (p: IconProps) => <Icon {...p} d="M4 20h4l10-10a2.8 2.8 0 0 0-4-4L4 16v4Zm9-13 4 4" />,
  Grip: (p: IconProps) => (
    <Icon
      {...p}
      sw={0}
      d={
        <g fill="currentColor" stroke="none">
          <circle cx="9" cy="6" r="1.3" />
          <circle cx="15" cy="6" r="1.3" />
          <circle cx="9" cy="12" r="1.3" />
          <circle cx="15" cy="12" r="1.3" />
          <circle cx="9" cy="18" r="1.3" />
          <circle cx="15" cy="18" r="1.3" />
        </g>
      }
    />
  )
}
