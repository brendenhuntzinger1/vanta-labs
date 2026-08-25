export type McpJsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: McpJsonValue }
  | McpJsonValue[];

export interface McpContextRecord {
  id: string;
  name: string;
  payload: McpJsonValue;
  metadata: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface McpTrafficEvent {
  id: string;
  contextId: string | null;
  transport: "http" | "websocket";
  direction: "request" | "response" | "event";
  route: string;
  payload: McpJsonValue;
  timestamp: string;
}

export interface CreateMcpContextInput {
  name: string;
  payload?: McpJsonValue;
  metadata?: Record<string, string>;
}

export interface UpdateMcpContextInput {
  name?: string;
  payload?: McpJsonValue;
  metadata?: Record<string, string>;
}

export interface CreateMcpTrafficEventInput {
  contextId?: string | null;
  transport?: McpTrafficEvent["transport"];
  direction: McpTrafficEvent["direction"];
  route: string;
  payload: McpJsonValue;
}
