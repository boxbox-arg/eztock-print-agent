import { JobRepository } from './queue/job-repository.ts';
import { printEscposTcp, printEscposSerial, printPdf } from './printers/drivers.ts';
import { discoverPrinters } from './printers/discovery.ts';
import type { AgentConfig, PrintJob, PrinterInfo, WsResponse } from './types.ts';
import { Logger } from './logger.ts';
import { WebSocketClient } from './websocket-client.ts';

export class JobProcessor {
  private config: AgentConfig;
  private logger: Logger;
  private jobRepo: JobRepository;
  private wsClient: WebSocketClient;
  private printers: Map<string, PrinterInfo> = new Map();
  private processing = false;
  private processTimer: Timer | null = null;

  constructor(config: AgentConfig, logger: Logger, jobRepo: JobRepository, wsClient: WebSocketClient) {
    this.config = config;
    this.logger = logger;
    this.jobRepo = jobRepo;
    this.wsClient = wsClient;
  }

  start(): void {
    this.logger.info('Starting job processor');
    this.refreshPrinters();
    this.processTimer = setInterval(() => this.processJobs(), 1000);
  }

  stop(): void {
    if (this.processTimer) {
      clearInterval(this.processTimer);
      this.processTimer = null;
    }
    this.processing = false;
  }

  async refreshPrinters(): Promise<void> {
    this.logger.info('Refreshing printer list');
    try {
      const discovered = await discoverPrinters(this.logger);
      this.printers.clear();
      for (const p of discovered) {
        this.printers.set(p.id, p);
      }
      this.logger.info(`Discovered ${discovered.length} printers`);
    } catch (err) {
      this.logger.error('Printer discovery failed:', err);
    }
  }

  getPrinters(): PrinterInfo[] {
    return Array.from(this.printers.values());
  }

  async handleNewJob(jobId: string, printerId: string, contentBase64: string, contentType: string, copies: number, options: Record<string, unknown>): Promise<void> {
    this.logger.info('Handling new job:', jobId);

    const existing = this.jobRepo.findByBackendJobId(jobId);
    if (existing) {
      this.logger.warn('Job already exists, skipping duplicate:', jobId);
      return;
    }

    const content = Buffer.from(contentBase64, 'base64');

    const agentJobId = `${this.config.agentId}-${Date.now()}-${jobId}`;

    this.jobRepo.create({
      id: agentJobId,
      backendJobId: jobId,
      printerId,
      documentType: String(options.documentType ?? 'unknown'),
      title: String(options.title ?? 'Untitled'),
      content: new Uint8Array(content),
      contentType: contentType as 'escpos' | 'pdf' | 'raw',
      copies,
      options,
      maxRetries: Number(options.maxRetries ?? 3),
    });

    this.wsClient.send({
      type: 'job:ack',
      jobId,
      agentJobId,
      timestamp: new Date().toISOString(),
    });

    // Trigger immediate processing
    this.processJobs();
  }

  private async processJobs(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      const jobs = this.jobRepo.findPending(5);

      for (const job of jobs) {
        await this.executeJob(job);
      }
    } finally {
      this.processing = false;
    }
  }

  private async executeJob(job: PrintJob): Promise<void> {
    this.logger.info('Executing job:', job.id, 'for printer:', job.printerId);

    const printer = this.printers.get(job.printerId);
    if (!printer) {
      this.logger.error('Printer not found:', job.printerId);
      await this.failJob(job, 'Printer not found');
      return;
    }

    // Mark as printing
    this.jobRepo.updateStatus(job.id, 'printing');

    this.wsClient.send({
      type: 'job:started',
      jobId: job.backendJobId,
      timestamp: new Date().toISOString(),
    });

    const startTime = Date.now();

    try {
      for (let i = 0; i < job.copies; i++) {
        await this.sendToPrinter(printer, job.content, job.contentType);
      }

      const duration = Date.now() - startTime;
      this.jobRepo.updateStatus(job.id, 'completed');

      this.wsClient.send({
        type: 'job:completed',
        jobId: job.backendJobId,
        status: 'completed',
        duration,
        timestamp: new Date().toISOString(),
      });

      this.logger.info('Job completed:', job.id, 'in', duration, 'ms');
    } catch (err) {
      const duration = Date.now() - startTime;
      const error = err instanceof Error ? err.message : String(err);
      this.logger.error('Job failed:', job.id, error);

      if (job.retryCount < job.maxRetries) {
        const backoff = this.calculateBackoff(job.retryCount);
        this.logger.info(`Retrying job ${job.id} in ${backoff}ms (attempt ${job.retryCount + 1}/${job.maxRetries})`);
        this.jobRepo.incrementRetry(job.id, error);
        this.jobRepo.updateStatus(job.id, 'pending');
        await new Promise(resolve => setTimeout(resolve, backoff));
      } else {
        await this.failJob(job, error);
      }
    }
  }

  private async sendToPrinter(printer: PrinterInfo, content: Uint8Array, contentType: string): Promise<void> {
    if (contentType === 'escpos' || (contentType === 'raw' && printer.driver === 'escpos')) {
      if (printer.connectionConfig.host && printer.connectionConfig.port) {
        await printEscposTcp(printer.connectionConfig.host, printer.connectionConfig.port, content, this.logger);
      } else if (printer.connectionConfig.serialPort) {
        await printEscposSerial(printer.connectionConfig.serialPort, content, this.logger);
      } else if (printer.connectionConfig.deviceUri) {
        // CUPS raw print for ESC/POS
        const { $ } = await import('bun');
        const tempFile = `/tmp/eztock-escpos-${Date.now()}.bin`;
        await Bun.write(tempFile, content);
        try {
          const result = await $`lp -d ${printer.systemName} -o raw ${tempFile}`.nothrow().quiet();
          if (result.exitCode !== 0) {
            throw new Error(`Raw ESC/POS print failed: ${result.stderr.toString()}`);
          }
        } finally {
          await $`rm -f ${tempFile}`.nothrow().quiet();
        }
      } else {
        throw new Error('No valid connection config for ESC/POS printer');
      }
    } else if (contentType === 'pdf' || printer.driver === 'pdf') {
      await printPdf(printer.systemName, content, this.logger);
    } else {
      throw new Error(`Unsupported content type: ${contentType}`);
    }
  }

  private async failJob(job: PrintJob, error: string): Promise<void> {
    this.jobRepo.updateStatus(job.id, 'failed', error);

    this.wsClient.send({
      type: 'job:completed',
      jobId: job.backendJobId,
      status: 'failed',
      duration: 0,
      error,
      timestamp: new Date().toISOString(),
    });
  }

  private calculateBackoff(retryCount: number): number {
    const delays = [0, 2000, 5000, 15000];
    return delays[Math.min(retryCount, delays.length - 1)];
  }
}
