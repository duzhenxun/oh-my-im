import type { AgentType } from "./config.js";
import type { CommandKeywordsConfig, DashboardConfig, MonitorTarget } from "./dws-dashboard.js";

export type MonitorCommand = "open" | "stop" | "pause" | { type: "switch-agent"; agent: AgentType };

export interface MonitorCommandEvent {
  senderId: string;
  content?: string;
}

export interface MonitorCommandTarget extends MonitorTarget {}

export interface MonitorCommandResult {
  config: DashboardConfig;
  changed: boolean;
}

export function parseAgentControlCommand(
  content: string,
  keywords: CommandKeywordsConfig,
): "pause" | { type: "switch-agent"; agent: AgentType } | undefined {
  const normalizedContent = normalizeKeyword(content.trim());
  if (normalizedContent && (keywords.pause ?? []).map(normalizeKeyword).includes(normalizedContent)) return "pause";
  return parseAgentSwitch(content, keywords);
}

function parseAgentSwitch(
  content: string,
  keywords: CommandKeywordsConfig,
): { type: "switch-agent"; agent: AgentType } | undefined {
  const normalized = content.toLowerCase().replace(/[\s，。！!,.、:：;；_\-/\\]+/g, "");
  const matches: AgentType[] = [];
  const matchesKeyword = (keyword: string): boolean => {
    const normalizedKeyword = normalizeKeyword(keyword);
    // A bare model name is only a command when it is the whole message.
    // Otherwise bot replies such as "当前已切换到 Pi" would trigger again.
    return normalizedKeyword === "pi" || normalizedKeyword === "codex"
      ? normalized === normalizedKeyword
      : normalized.includes(normalizedKeyword);
  };
  if ((keywords.switchPi ?? []).some(matchesKeyword)) matches.push("pi");
  if ((keywords.switchCodex ?? []).some(matchesKeyword)) matches.push("codex");
  if (matches.length !== 1) return undefined;
  return { type: "switch-agent", agent: matches[0] };
}

function normalizeKeyword(value: string): string {
  return value.toLowerCase().replace(/[\s，。！!,.、:：;；_\-/\\]+/g, "");
}

export function parseMonitorCommand(
  event: MonitorCommandEvent,
  keywords: CommandKeywordsConfig,
): MonitorCommand | undefined {
  const rawContent = event.content?.trim();
  if (!rawContent) return undefined;
  const agentCommand = parseAgentControlCommand(rawContent, keywords);
  if (agentCommand === "pause") return "pause";
  if (agentCommand) return agentCommand;

  const content = rawContent.replace(/[\s-]+/g, "").toLowerCase();
  if ((keywords.monitorOpen ?? []).map(normalizeKeyword).includes(content)) return "open";
  if ((keywords.monitorStop ?? []).map(normalizeKeyword).includes(content)) return "stop";
  return undefined;
}

export function applyMonitorCommand(
  config: DashboardConfig,
  command: MonitorCommand,
  target: MonitorCommandTarget,
): MonitorCommandResult {
  if (typeof command === "object" && command.type === "switch-agent") {
    return { config: { ...config, agent: command.agent }, changed: config.agent !== command.agent };
  }
  const existing = config.targets.find((item) => item.groupId === target.groupId && item.senderId === target.senderId);
  if (command === "pause") return { config, changed: false };
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
