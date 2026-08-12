// The public internal UI surface. Interaction and presentation primitives
// only — no workspace logic, native invocation, persistence, or topology.

export { ActionBar, type ActionBarProps } from './ActionBar';
export { Badge, type BadgeProps, type BadgeTone } from './Badge';
export { Confirm, type ConfirmProps, type ConfirmAction } from './Confirm';
export { ContextMenu, type ContextMenuProps, type ContextMenuItem } from './ContextMenu';
export { Icon, type IconProps } from './Icon';
export { IconButton, type IconButtonProps } from './IconButton';
export { Overlay, type OverlayProps } from './Overlay';
export { Pane, type PaneProps } from './Pane';
export { ResizableSeparator, type ResizableSeparatorProps } from './ResizableSeparator';
export { Tabs, type TabsProps, type TabItem } from './Tabs';
export { WorkbenchTree, type WorkbenchTreeProps, type TreeNode } from './WorkbenchTree';
