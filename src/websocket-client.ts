import type { AgentConfig, WsMessage, WsResponse, PrinterInfo, AgentStatus } from '../types.ts';
import { Logger } from '../logger.ts';

export type MessageHandler = (message: WsMessage) => void;

export class WebSocketClient {
  private ws: WebSocket | null = null;
  private config: AgentConfig;
  private logger: Logger;
  private handlers: MessageHandler[] = [];
  private reconnectTimer: Timer | null = null;
  private heartbeatTimer: Timer | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private isConnected = false;

  constructor(config: AgentConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    this.logger.info('Connecting to WebSocket:', this.config.wsUrl);

    try {
      this.ws = new WebSocket(this.config.wsUrl, [], {
        headers: {
          'X-Agent-Id': this.config.agentId,
          'X-Pairing-Token': this.config.pairingToken,
        },
      });

      this.ws.onopen = () => {
        this.logger.info('WebSocket connected');
        this.isConnected = true;
        this.reconnectDelay = 1000;
        this.startHeartbeat();
        this.emit({ type: 'status', status: this.buildStatus() });
      };

      this.ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data as string) as WsMessage;
          this.logger.debug('WS message received:', message.type);
          this.handlers.forEach(h => h(message));
        } catch (err) {
          this.logger.error('Failed to parse WS message:', err);
        }
      };

      this.ws.onclose = () => {
        this.logger.warn('WebSocket closed');
        this.isConnected = false;
        this.stopHeartbeat();
        this.scheduleReconnect();
      };

      this.ws.onerror = (err) => {
        this.logger.error('WebSocket error:', err);
        this.isConnected = false;
      };
    } catch (err) {
      this.logger.error('Failed to create WebSocket:', err);
      this.scheduleReconnect();
    }
  }

  disconnect(): void {
    this.stopHeartbeat();
    this.clearReconnect();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
  }

  send(message: WsResponse): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.logger.warn('Cannot send message, WebSocket not open');
      return false;
    }

    try {
      this.ws.send(JSON.stringify(message));
      return true;
    } catch (err) {
      this.logger.error('Failed to send WS message:', err);
      return false;
    }
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  getIsConnected(): boolean {
    return this.isConnected;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: 'pong' });
    }, 15000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    this.clearReconnect();
    this.logger.info(`Reconnecting in ${this.reconnectDelay}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
      this.connect();
    }, this.reconnectDelay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private emit(message: WsResponse): void {
    this.send(message);
  }

  private buildStatus(): AgentStatus {
    return {
      agentId: this.config.agentId,
      hostname: 'unknown',
      os: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux',
      version: '0.1.0',
      uptime: process.uptime(),
      printers: [],
      queueStats: { pending: 0, queued: 0, printing: 0, completed: 0, failed: 0 },
      isConnected: this.isConnected,
      lastHeartbeatAt: new Date().toISOString(),
    };
  }
}
