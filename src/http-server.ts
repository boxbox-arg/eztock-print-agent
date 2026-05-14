import { type Server } from 'bun';
import type { AgentConfig, AgentStatus, PrinterInfo, PrintJob } from './types.ts';
import { Logger } from './logger.ts';
import { JobRepository } from './queue/job-repository.ts';

export class HttpServer {
  private server: Server | null = null;
  private config: AgentConfig;
  private logger: Logger;
  private jobRepo: JobRepository;
  private getStatus: () => AgentStatus;
  private getPrinters: () => PrinterInfo[];

  constructor(
    config: AgentConfig,
    logger: Logger,
    jobRepo: JobRepository,
    getStatus: () => AgentStatus,
    getPrinters: () => PrinterInfo[]
  ) {
    this.config = config;
    this.logger = logger;
    this.jobRepo = jobRepo;
    this.getStatus = getStatus;
    this.getPrinters = getPrinters;
  }

  start(): void {
    this.server = Bun.serve({
      port: this.config.httpPort,
      hostname: '127.0.0.1',
      fetch: (req: Request) => this.handleRequest(req),
    });

    this.logger.info(`HTTP server listening on http://127.0.0.1:${this.config.httpPort}`);
  }

  stop(): void {
    if (this.server) {
      this.server.stop();
      this.server = null;
      this.logger.info('HTTP server stopped');
    }
  }

  private handleRequest(req: Request): Response {
    const url = new URL(req.url);
    const path = url.pathname;

    this.logger.debug(`HTTP ${req.method} ${path}`);

    // CORS headers
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Type': 'application/json',
    };

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }

    try {
      if (path === '/health' && req.method === 'GET') {
        return this.jsonResponse({ status: 'ok', uptime: process.uptime() }, headers);
      }

      if (path === '/status' && req.method === 'GET') {
        return this.jsonResponse(this.getStatus(), headers);
      }

      if (path === '/printers' && req.method === 'GET') {
        return this.jsonResponse({ printers: this.getPrinters() }, headers);
      }

      if (path === '/jobs' && req.method === 'GET') {
        const status = url.searchParams.get('status');
        let jobs: PrintJob[];
        if (status) {
          jobs = this.jobRepo.findByStatus(status as PrintJob['status']);
        } else {
          jobs = this.jobRepo.findPending(50);
        }
        return this.jsonResponse({ jobs }, headers);
      }

      if (path === '/jobs/stats' && req.method === 'GET') {
        return this.jsonResponse(this.jobRepo.getStats(), headers);
      }

      return this.jsonResponse({ error: 'Not found' }, headers, 404);
    } catch (err) {
      this.logger.error('HTTP request error:', err);
      return this.jsonResponse({ error: 'Internal server error' }, headers, 500);
    }
  }

  private jsonResponse(data: unknown, headers: Record<string, string>, status = 200): Response {
    return new Response(JSON.stringify(data, null, 2), { status, headers });
  }
}
