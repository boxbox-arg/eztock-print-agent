// Core types for the print agent

export interface AgentConfig {
  agentId: string;
  organizationId: string;
  branchId: string;
  pairingToken: string;
  backendUrl: string;
  wsUrl: string;
  httpPort: number;
  dataDir: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export interface PrinterInfo {
  id: string;
  name: string;
  systemName: string;
  driver: 'escpos' | 'pdf' | 'raw';
  connectionType: 'usb' | 'network' | 'bluetooth' | 'virtual';
  connectionConfig: {
    vendorId?: string;
    productId?: string;
    host?: string;
    port?: number;
    deviceUri?: string;
    serialPort?: string;
  };
  capabilities: PrinterCapabilities;
  status: 'online' | 'offline' | 'busy' | 'error';
  statusDetail?: string;
  isDefault: boolean;
}

export interface PrinterCapabilities {
  escpos?: {
    qr: boolean;
    barcode: boolean;
    image: boolean;
    cutter: boolean;
    cashDrawer: boolean;
    utf8: boolean;
    codepage: number;
    density: number[];
    paperWidths: number[];
  };
  pdf?: {
    color: boolean;
    duplex: boolean;
    maxDpi: number;
    paperSizes: string[];
  };
  supportedFormats: string[];
}

export interface PrintJob {
  id: string;
  printerId: string;
  documentType: string;
  title: string;
  content: Uint8Array;
  contentType: 'escpos' | 'pdf' | 'raw';
  copies: number;
  options: Record<string, unknown>;
  status: 'pending' | 'queued' | 'printing' | 'completed' | 'failed' | 'cancelled';
  retryCount: number;
  maxRetries: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  backendJobId: string;
}

export interface AgentStatus {
  agentId: string;
  hostname: string;
  os: 'windows' | 'linux' | 'macos';
  version: string;
  uptime: number;
  printers: PrinterInfo[];
  queueStats: {
    pending: number;
    queued: number;
    printing: number;
    completed: number;
    failed: number;
  };
  isConnected: boolean;
  lastHeartbeatAt: string;
}

export type WsMessage =
  | { type: 'job:print'; jobId: string; printerId: string; content: string; contentType: string; copies: number; options: Record<string, unknown> }
  | { type: 'job:cancel'; jobId: string }
  | { type: 'ping' }
  | { type: 'config:update'; config: Partial<AgentConfig> }
  | { type: 'printer:refresh' };

export type WsResponse =
  | { type: 'job:ack'; jobId: string; agentJobId: string; timestamp: string }
  | { type: 'job:started'; jobId: string; timestamp: string }
  | { type: 'job:completed'; jobId: string; status: 'completed' | 'failed'; duration: number; error?: string; timestamp: string }
  | { type: 'pong' }
  | { type: 'status'; status: AgentStatus }
  | { type: 'printers:list'; printers: PrinterInfo[] };

export interface SystemInfo {
  hostname: string;
  platform: 'win32' | 'linux' | 'darwin';
  arch: string;
  release: string;
  totalMemory: number;
  cpus: number;
}
