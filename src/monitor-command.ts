import type { DashboardConfig, MonitorTarget } from "./dws-dashboard.js";

export const DU_ZHENXUN_OPEN_DINGTALK_ID = "DZyRu3o9aXvmiSh7BJa5S4EQiEiE";

export type MonitorCommand = "open" | "stop";

export interface MonitorCommandEvent {
  senderId: string;
  content?: string;
}

export interface MonitorCommandTarget extends MonitorTarget {}

export interface MonitorCommandResult {
  config: DashboardConfig;
  changed: boolean;
}

export function parseMonitorCommand(event: MonitorCommandEvent): MonitorCommand | undefined {
  if (event.senderId !== DU_ZHENXUN_OPEN_DINGTALK_ID) return undefined;
  const content = event.content?.replace(/\s+/g, "").toLowerCase();
  if (content === "打开ai" || content === "启动ai") return "open";
  if (content === "停止ai" || content === "关闭ai") return "stop";
  return undefined;
}

export function applyMonitorCommand(
  config: DashboardConfig,
  command: MonitorCommand,
  target: MonitorCommandTarget,
): MonitorCommandResult {
  const existing = config.targets.find((item) => item.groupId === target.groupId && item.senderId === target.senderId);
  if (command === "open") {
    if (existing) {
      if (existing.groupName === target.groupName && existing.senderName === target.senderName) return { config, changed: false };
      return {
        changed: true,
        config: {
          ...config,
          targets: config.targets.map((item) => item === existing ? { ...item, groupName: target.groupName, senderName: target.senderName } : item),
        },
      };
    }
    return { config: { ...config, targets: [...config.targets, target] }, changed: true };
  }

  if (!existing) return { config, changed: false };
  return {
    config: {
      ...config,
      targets: config.targets.filter((item) => item.groupId !== target.groupId || item.senderId !== target.senderId),
    },
    changed: true,
  };
}
