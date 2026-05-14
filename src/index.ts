import { mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { hostname, platform } from 'os';

import { loadConfig, isHelpRequested, saveConfig } from './config.ts';
import { Logger } from './logger.ts';
import { initDatabase } from './queue/database.ts';
import { JobRepository } from './queue/job-repository.ts';
import { WebSocketClient } from './websocket-client.ts';
import { HttpServer } from './http-server.ts';
import { JobProcessor } from './job-processor.ts';
import type { AgentConfig, AgentStatus } from './types.ts';

const VERSION = '0.1.0';

function printHelp(): void {
  console.log(`
Eztock Print Agent v${VERSION}

Uso:
  eztock-print-agent [--config /ruta/.env] [--help]

Flags:
  --config <archivo>   Ruta al archivo .env de configuración
                       Default: ~/.eztock-agent/.env

Variables de entorno / archivo .env:
  AGENT_ID              ID único del agente
  AGENT_ORGANIZATION_ID ID de la organización
  AGENT_BRANCH_ID       ID de la sucursal
  AGENT_PAIRING_TOKEN   Token de emparejamiento
  AGENT_BACKEND_URL     URL del backend (default: https://api.eztock.com)
  AGENT_WS_URL          URL del WebSocket (default: wss://api.eztock.com/ws/print-agent)
  AGENT_HTTP_PORT       Puerto HTTP local (default: 9100)
  AGENT_DATA_DIR        Directorio de datos (default: ~/.eztock-agent)
  AGENT_LOG_LEVEL       Nivel de log: debug, info, warn, error (default: info)

API local (http://127.0.0.1:9100):
  GET  /            Información y estado del agente
  POST /configure   Configurar IDs del agente (sin tocar archivos)
  GET  /health      Health check
  GET  /status      Estado completo
  GET  /printers    Impresoras descubiertas
  GET  /jobs        Trabajos pendientes
  GET  /jobs/stats  Estadísticas de la cola

Configuración inicial:
  1. Crear archivo ~/.eztock-agent/.env con las variables requeridas
  2. O usar POST http://localhost:9100/configure con los datos
  3. Reiniciar el agente
`);
}

function isConfigured(config: AgentConfig): boolean {
  return config.agentId.length > 0 && config.organizationId.length > 0 && config.branchId.length > 0;
}

class PrintAgent {
  private config: AgentConfig;
  private logger: Logger;
  private jobRepo: JobRepository;
  private wsClient: WebSocketClient;
  private httpServer: HttpServer;
  private jobProcessor: JobProcessor;
  private cleanupTimer: Timer | null = null;

  constructor(config: AgentConfig) {
    this.config = config;
    this.logger = new Logger(this.config, 'Agent');
    this.jobRepo = new JobRepository();
    this.wsClient = new WebSocketClient(this.config, this.logger);
    this.jobProcessor = new JobProcessor(this.config, this.logger, this.jobRepo, this.wsClient);

    this.httpServer = new HttpServer(
      this.config,
      this.logger,
      this.jobRepo,
      () => this.getStatus(),
      () => this.jobProcessor.getPrinters(),
      (newConfig: Partial<AgentConfig>) => this.applyConfig(newConfig),
    );
  }

  async start(): Promise<void> {
    const configured = isConfigured(this.config);

    this.logger.info(`Eztock Print Agent v${VERSION} starting...`);
    this.logger.info('Data directory:', this.config.dataDir);

    if (!configured) {
      this.logger.warn('Agent not configured — missing AGENT_ID, AGENT_ORGANIZATION_ID, or AGENT_BRANCH_ID');
      this.logger.info('Configure via: POST http://127.0.0.1:' + this.config.httpPort + '/configure');
      this.logger.info('  or create ' + this.config.dataDir + '/.env');
    } else {
      this.logger.info('Agent ID:', this.config.agentId);
      this.logger.info('Organization:', this.config.organizationId);
      this.logger.info('Branch:', this.config.branchId);
    }

    // Ensure data directory exists
    if (!existsSync(this.config.dataDir)) {
      await mkdir(this.config.dataDir, { recursive: true });
    }

    // Initialize SQLite database
    initDatabase(this.config, this.logger);

    // Setup WebSocket message handler
    this.wsClient.onMessage((message) => this.handleWsMessage(message));

    // Connect to backend only if configured
    if (configured) {
      this.wsClient.connect();
    }

    // Start HTTP server (always, for /configure and status)
    this.httpServer.start();

    // Start job processor
    this.jobProcessor.start();

    // Start cleanup timer
    this.cleanupTimer = setInterval(() => this.cleanup(), 24 * 60 * 60 * 1000);

    // Graceful shutdown
    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());

    this.logger.info(configured ? 'Agent started successfully' : 'Agent started in unconfigured mode');
  }

  applyConfig(newConfig: Partial<AgentConfig>): void {
    this.logger.info('Applying new configuration...');

    if (newConfig.agentId) this.config.agentId = newConfig.agentId;
    if (newConfig.organizationId) this.config.organizationId = newConfig.organizationId;
    if (newConfig.branchId) this.config.branchId = newConfig.branchId;
    if (newConfig.pairingToken) this.config.pairingToken = newConfig.pairingToken;
    if (newConfig.backendUrl) this.config.backendUrl = newConfig.backendUrl;
    if (newConfig.wsUrl) this.config.wsUrl = newConfig.wsUrl;

    saveConfig(newConfig, this.config.dataDir);

    if (isConfigured(this.config) && !this.wsClient.getIsConnected()) {
      this.wsClient.connect();
    }
  }

  private getStatus(): AgentStatus {
    const osName = platform();
    return {
      agentId: this.config.agentId || '(not configured)',
      hostname: hostname(),
      os: osName === 'win32' ? 'windows' : osName === 'darwin' ? 'macos' : 'linux',
      version: VERSION,
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
        this.logger.info('Config update received');
        const update = message as { type: 'config:update'; config: Partial<AgentConfig> };
        if (update.config) {
          this.applyConfig(update.config);
        }
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

// Main entry point
async function main(): Promise<void> {
  if (isHelpRequested()) {
    printHelp();
    process.exit(0);
  }

  const config = await loadConfig();
  const agent = new PrintAgent(config);
  await agent.start();
}

main().catch((err) => {
  console.error('Failed to start agent:', err);
  process.exit(1);
});
