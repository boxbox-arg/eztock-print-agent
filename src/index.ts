import { mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { hostname, platform } from 'os';

import { loadConfig } from './config.ts';
import { Logger } from './logger.ts';
import { initDatabase } from './queue/database.ts';
import { JobRepository } from './queue/job-repository.ts';
import { WebSocketClient } from './websocket-client.ts';
import { HttpServer } from './http-server.ts';
import { JobProcessor } from './job-processor.ts';
import type { AgentConfig, AgentStatus } from './types.ts';

class PrintAgent {
  private config: AgentConfig;
  private logger: Logger;
  private jobRepo: JobRepository;
  private wsClient: WebSocketClient;
  private httpServer: HttpServer;
  private jobProcessor: JobProcessor;
  private cleanupTimer: Timer | null = null;

  constructor() {
    this.config = loadConfig();
    this.logger = new Logger(this.config, 'Agent');
    this.jobRepo = new JobRepository();
    this.wsClient = new WebSocketClient(this.config, this.logger);
    this.jobProcessor = new JobProcessor(this.config, this.logger, this.jobRepo, this.wsClient);

    this.httpServer = new HttpServer(
      this.config,
      this.logger,
      this.jobRepo,
      () => this.getStatus(),
      () => this.jobProcessor.getPrinters()
    );
  }

  async start(): Promise<void> {
    this.logger.info('Starting Eztock Print Agent v0.1.0');
    this.logger.info('Agent ID:', this.config.agentId);
    this.logger.info('Organization:', this.config.organizationId);
    this.logger.info('Branch:', this.config.branchId);

    // Ensure data directory exists
    if (!existsSync(this.config.dataDir)) {
      await mkdir(this.config.dataDir, { recursive: true });
    }

    // Initialize SQLite database
    initDatabase(this.config, this.logger);

    // Setup WebSocket message handler
    this.wsClient.onMessage((message) => this.handleWsMessage(message));

    // Connect to backend
    this.wsClient.connect();

    // Start HTTP server
    this.httpServer.start();

    // Start job processor
    this.jobProcessor.start();

    // Start cleanup timer
    this.cleanupTimer = setInterval(() => this.cleanup(), 24 * 60 * 60 * 1000); // Daily

    // Graceful shutdown
    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());

    this.logger.info('Agent started successfully');
  }

  private getStatus(): AgentStatus {
    const osName = platform();
    return {
      agentId: this.config.agentId,
      hostname: hostname(),
      os: osName === 'win32' ? 'windows' : osName === 'darwin' ? 'macos' : 'linux',
      version: '0.1.0',
      uptime: process.uptime(),
      printers: this.jobProcessor.getPrinters(),
      queueStats: this.jobRepo.getStats(),
      isConnected: this.wsClient.getIsConnected(),
      lastHeartbeatAt: new Date().toISOString(),
    };
  }

  private handleWsMessage(message: { type: string; [key: string]: unknown }): void {
    switch (message.type) {
      case 'job:print': {
        const { jobId, printerId, content, contentType, copies, options } = message as {
          jobId: string;
          printerId: string;
          content: string;
          contentType: string;
          copies: number;
          options: Record<string, unknown>;
        };
        this.jobProcessor.handleNewJob(jobId, printerId, content, contentType, copies, options);
        break;
      }

      case 'job:cancel': {
        const { jobId } = message as { jobId: string };
        this.logger.info('Cancel requested for job:', jobId);
        const job = this.jobRepo.findByBackendJobId(jobId);
        if (job && job.status !== 'completed' && job.status !== 'failed') {
          this.jobRepo.updateStatus(job.id, 'cancelled');
        }
        break;
      }

      case 'printer:refresh': {
        this.jobProcessor.refreshPrinters();
        break;
      }

      case 'ping': {
        this.wsClient.send({ type: 'pong' });
        break;
      }

      case 'config:update': {
        this.logger.info('Config update received (not implemented yet)');
        break;
      }

      default:
        this.logger.warn('Unknown WS message type:', message.type);
    }
  }

  private cleanup(): void {
    this.logger.info('Running daily cleanup');
    const completedDeleted = this.jobRepo.deleteOldCompleted(90);
    const failedDeleted = this.jobRepo.deleteOldFailed(180);
    this.logger.info(`Cleanup complete. Deleted ${completedDeleted} completed, ${failedDeleted} failed jobs.`);
  }

  private shutdown(): void {
    this.logger.info('Shutting down agent...');
    this.httpServer.stop();
    this.jobProcessor.stop();
    this.wsClient.disconnect();
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    this.logger.info('Agent stopped');
    process.exit(0);
  }
}

// Start the agent
const agent = new PrintAgent();
agent.start().catch((err) => {
  console.error('Failed to start agent:', err);
  process.exit(1);
});
