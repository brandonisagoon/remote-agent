import Arrow2Circlepath from "framework7-icons/react/esm/Arrow2Circlepath.js";
import ArrowClockwise from "framework7-icons/react/esm/ArrowClockwise.js";
import ArrowUpRight from "framework7-icons/react/esm/ArrowUpRight.js";
import ArrowUpRightSquare from "framework7-icons/react/esm/ArrowUpRightSquare.js";
import BubbleLeftBubbleRight from "framework7-icons/react/esm/BubbleLeftBubbleRight.js";
import CheckmarkCircle from "framework7-icons/react/esm/CheckmarkCircle.js";
import ChevronDown from "framework7-icons/react/esm/ChevronDown.js";
import ChevronLeft from "framework7-icons/react/esm/ChevronLeft.js";
import ChevronLeftSlashChevronRight from "framework7-icons/react/esm/ChevronLeftSlashChevronRight.js";
import ChevronRight from "framework7-icons/react/esm/ChevronRight.js";
import CubeBox from "framework7-icons/react/esm/CubeBox.js";
import Desktopcomputer from "framework7-icons/react/esm/Desktopcomputer.js";
import DocOnDoc from "framework7-icons/react/esm/DocOnDoc.js";
import ExclamationmarkCircle from "framework7-icons/react/esm/ExclamationmarkCircle.js";
import Eye from "framework7-icons/react/esm/Eye.js";
import EyeSlash from "framework7-icons/react/esm/EyeSlash.js";
import Folder from "framework7-icons/react/esm/Folder.js";
import GearAlt from "framework7-icons/react/esm/GearAlt.js";
import Keyboard from "framework7-icons/react/esm/Keyboard.js";
import Link from "framework7-icons/react/esm/Link.js";
import Plus from "framework7-icons/react/esm/Plus.js";
import SidebarLeft from "framework7-icons/react/esm/SidebarLeft.js";
import Trash from "framework7-icons/react/esm/Trash.js";
import TrayArrowDown from "framework7-icons/react/esm/TrayArrowDown.js";
import SquareArrowDown from "framework7-icons/react/esm/SquareArrowDown.js";
import WandStars from "framework7-icons/react/esm/WandStars.js";
import Xmark from "framework7-icons/react/esm/Xmark.js";

import { cn } from "../lib/utils.ts";

/* SVG components (not the ligature font): geometrically centered and sized
   like any other inline icon, avoiding font-baseline vertical drift. */
const ICONS = {
  chevron_down: ChevronDown,
  arrow_2_circlepath: Arrow2Circlepath,
  arrow_clockwise: ArrowClockwise,
  arrow_up_right: ArrowUpRight,
  arrow_up_right_square: ArrowUpRightSquare,
  bubble_left_bubble_right: BubbleLeftBubbleRight,
  checkmark_circle: CheckmarkCircle,
  chevron_left: ChevronLeft,
  chevron_left_slash_chevron_right: ChevronLeftSlashChevronRight,
  chevron_right: ChevronRight,
  cube_box: CubeBox,
  desktopcomputer: Desktopcomputer,
  doc_on_doc: DocOnDoc,
  exclamationmark_circle: ExclamationmarkCircle,
  eye: Eye,
  eye_slash: EyeSlash,
  folder: Folder,
  gear_alt: GearAlt,
  keyboard: Keyboard,
  link: Link,
  plus: Plus,
  sidebar_left: SidebarLeft,
  trash: Trash,
  tray_arrow_down: TrayArrowDown,
  square_arrow_down: SquareArrowDown,
  wand_stars: WandStars,
  xmark: Xmark,
} as const;

export type F7IconName = keyof typeof ICONS;

export function F7Icon({ name, className }: { name: F7IconName; className?: string }) {
  const Icon = ICONS[name];
  return <Icon aria-hidden="true" className={cn("size-4 shrink-0", className)} />;
}
