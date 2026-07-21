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
  Play: (p: IconProps) => <Icon {...p} d="M7 4.5v15l13-7.5L7 4.5Z" fill="currentColor" sw={0} />,
  Stop: (p: IconProps) => <Icon {...p} d={<rect x="5.5" y="5.5" width="13" height="13" rx="2.5" />} fill="currentColor" sw={0} />,
  Restart: (p: IconProps) => <Icon {...p} d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1M3.5 4v4h4" />,
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
  Trash: (p: IconProps) => (
    <Icon {...p} d="M4 7h16M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2m-9 0 1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13" />
  ),
  Broadcast: (p: IconProps) => (
    <Icon {...p} d="M5.2 9a8 8 0 0 1 0-2m13.6 2a8 8 0 0 0 0-2M7.5 11a5 5 0 0 1 0-4m9 4a5 5 0 0 0 0-4M10 13a2 2 0 1 0 4 0 2 2 0 0 0-4 0Zm2 2v6" />
  ),
  PanelLeft: (p: IconProps) => <Icon {...p} d="M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5Zm6 0v16" />,
  FolderOpen: (p: IconProps) => (
    <Icon {...p} d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2H3Zm0 0v10a2 2 0 0 0 2 2h13a2 2 0 0 0 1.9-1.4L22 11H6.5a2 2 0 0 0-1.9 1.4L3 17" />
  ),
  Sun: (p: IconProps) => (
    <Icon {...p} d="M12 4V2m0 20v-2m8-8h2M2 12h2m13.7-5.7 1.4-1.4M4.9 19.1l1.4-1.4m11.4 0 1.4 1.4M4.9 4.9l1.4 1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z" />
  ),
  Moon: (p: IconProps) => <Icon {...p} d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" />,
  Plus: (p: IconProps) => <Icon {...p} d="M12 5v14M5 12h14" />,
  Cpu: (p: IconProps) => <Icon {...p} d="M7 7h10v10H7zM4 9v6m16-6v6M9 4h6m-6 16h6M4 9h2m12 0h2M4 15h2m12 0h2" />,
  Stack: (p: IconProps) => <Icon {...p} d="m3 7 9-4 9 4-9 4-9-4Zm0 5 9 4 9-4M3 17l9 4 9-4" />,
  Globe: (p: IconProps) => (
    <Icon {...p} d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0 0c2.5 0 4.5-4 4.5-9S14.5 3 12 3 7.5 7 7.5 12s2 9 4.5 9Zm-9-9h18" />
  ),
  Activity: (p: IconProps) => <Icon {...p} d="M3 12h4l3-8 4 16 3-8h4" />,
  More: (p: IconProps) => <Icon {...p} d="M5 12h.01M12 12h.01M19 12h.01" sw={2.4} />,
  Refresh: (p: IconProps) => <Icon {...p} d="M21 12a9 9 0 1 1-2.7-6.4M21 4v5h-5" />,
  CollapseAll: (p: IconProps) => <Icon {...p} d="M8 4l4 4 4-4M8 20l4-4 4 4M4 12h16" />,
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
