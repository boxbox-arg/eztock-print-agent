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
  private onConfigure: (newConfig: Partial<AgentConfig>) => void;
  private needsRestart = false;

  constructor(
    config: AgentConfig,
    logger: Logger,
    jobRepo: JobRepository,
    getStatus: () => AgentStatus,
    getPrinters: () => PrinterInfo[],
    onConfigure: (newConfig: Partial<AgentConfig>) => void,
  ) {
    this.config = config;
    this.logger = logger;
    this.jobRepo = jobRepo;
    this.getStatus = getStatus;
    this.getPrinters = getPrinters;
    this.onConfigure = onConfigure;
  }

  get needsRestartFlag(): boolean {
    return this.needsRestart;
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

    if (req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    const isConfigured = this.config.agentId.length > 0 && this.config.organizationId.length > 0 && this.config.branchId.length > 0;

    try {
      // Root — first-run guide or status
      if (path === '/' && req.method === 'GET') {
        return this.rootPage(isConfigured);
      }

      // Configure endpoint
      if (path === '/configure' && req.method === 'POST') {
        return this.handleConfigure(req);
      }

      // JSON API endpoints
      const jsonHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Content-Type': 'application/json',
      };

      if (path === '/health' && req.method === 'GET') {
        return this.jsonResponse({ status: 'ok', uptime: process.uptime(), configured: isConfigured }, jsonHeaders);
      }

      if (path === '/status' && req.method === 'GET') {
        return this.jsonResponse(this.getStatus(), jsonHeaders);
      }

      if (path === '/printers' && req.method === 'GET') {
        return this.jsonResponse({ printers: this.getPrinters() }, jsonHeaders);
      }

      if (path === '/jobs' && req.method === 'GET') {
        const status = url.searchParams.get('status');
        let jobs: PrintJob[];
        if (status) {
          jobs = this.jobRepo.findByStatus(status as PrintJob['status']);
        } else {
          jobs = this.jobRepo.findPending(50);
        }
        return this.jsonResponse({ jobs }, jsonHeaders);
      }

      if (path === '/jobs/stats' && req.method === 'GET') {
        return this.jsonResponse(this.jobRepo.getStats(), jsonHeaders);
      }

      return this.jsonResponse({ error: 'Not found' }, jsonHeaders, 404);
    } catch (err) {
      this.logger.error('HTTP request error:', err);
      return new Response(JSON.stringify({ error: 'Internal server error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  private rootPage(configured: boolean): Response {
    const status = this.getStatus();
    const isOnline = status.isConnected;

    const statusColor = configured ? (isOnline ? '#16a34a' : '#dc2626') : '#ca8a04';

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Eztock Print Agent</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .card { background: #1e293b; border-radius: 12px; padding: 2rem; max-width: 600px; width: 100%; box-shadow: 0 25px 50px rgba(0,0,0,.4); }
    h1 { font-size: 1.5rem; margin-bottom: 1rem; color: #f8fafc; }
    .badge { display: inline-block; padding: 4px 10px; border-radius: 6px; font-size: .8rem; font-weight: 600; background: ${statusColor}; color: #fff; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: .75rem; margin-top: 1.5rem; }
    .label { font-size: .75rem; color: #94a3b8; text-transform: uppercase; letter-spacing: .05em; }
    .value { font-size: .9rem; font-family: 'SF Mono', 'Fira Code', monospace; word-break: break-all; }
    .section { margin-top: 1.5rem; padding-top: 1.5rem; border-top: 1px solid #334155; }
    code { background: #334155; padding: 2px 6px; border-radius: 4px; font-size: .85rem; }
    .endpoints { list-style: none; margin-top: .5rem; }
    .endpoints li { margin: .25rem 0; font-size: .85rem; }
    .endpoints li::before { content: '\\2192 '; color: #22c55e; }
    .note { margin-top: 1rem; padding: .75rem; background: #713f12; border-radius: 8px; font-size: .85rem; border: 1px solid #ca8a04; }
    .note.configured { background: #14532d; border-color: #16a34a; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Eztock Print Agent <span class="badge">${configured ? (isOnline ? 'ONLINE' : 'OFFLINE') : 'NO CONFIGURADO'}</span></h1>

    <div class="grid">
      <div><div class="label">Host</div><div class="value">${status.hostname}</div></div>
      <div><div class="label">OS</div><div class="value">${status.os}</div></div>
      <div><div class="label">Agent ID</div><div class="value">${status.agentId}</div></div>
      <div><div class="label">Uptime</div><div class="value">${Math.floor(status.uptime)}s</div></div>
      <div><div class="label">Printers</div><div class="value">${status.printers.length}</div></div>
      <div><div class="label">Queue</div><div class="value">${status.queueStats.pending + status.queueStats.queued + status.queueStats.printing} activos</div></div>
    </div>

    <div class="section">
    ${configured
      ? `<div class="note configured">Agente configurado y funcionando.</div>`
      : `<div class="note">
        <strong>Agente sin configurar.</strong> Para vincularlo al panel Eztock:<br><br>
        <strong>Opción 1 — Archivo .env:</strong><br>
        Crear <code>${this.config.dataDir}/.env</code> con:<br>
        <code>AGENT_ID=uuid</code><br>
        <code>AGENT_ORGANIZATION_ID=uuid</code><br>
        <code>AGENT_BRANCH_ID=uuid</code><br>
        <code>AGENT_PAIRING_TOKEN=token</code><br><br>
        <strong>Opción 2 — POST via API:</strong><br>
        <code>curl -X POST http://localhost:${this.config.httpPort}/configure -H 'Content-Type: application/json' -d '{...}'</code><br><br>
        Luego reiniciar el agente.
      </div>`
    }

      <ul class="endpoints">
        <li>GET /status — Estado completo JSON</li>
        <li>GET /printers — Impresoras</li>
        <li>GET /jobs — Trabajos</li>
        <li>GET /jobs/stats — Estadísticas</li>
        <li>GET /health — Health check</li>
      </ul>
    </div>
  </div>
</body>
</html>`;

    return new Response(html, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  private async handleConfigure(req: Request): Promise<Response> {
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const newConfig: Partial<AgentConfig> = {};

    if (typeof body.agentId === 'string') newConfig.agentId = body.agentId;
    if (typeof body.organizationId === 'string') newConfig.organizationId = body.organizationId;
    if (typeof body.branchId === 'string') newConfig.branchId = body.branchId;
    if (typeof body.pairingToken === 'string') newConfig.pairingToken = body.pairingToken;
    if (typeof body.backendUrl === 'string') newConfig.backendUrl = body.backendUrl;
    if (typeof body.wsUrl === 'string') newConfig.wsUrl = body.wsUrl;

    if (Object.keys(newConfig).length === 0) {
      return new Response(JSON.stringify({ error: 'No valid config fields provided', validFields: ['agentId', 'organizationId', 'branchId', 'pairingToken', 'backendUrl', 'wsUrl'] }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    this.logger.info('Configuration received via HTTP API');
    this.onConfigure(newConfig);
    this.needsRestart = true;

    return new Response(JSON.stringify({
      message: 'Configuración guardada. Reiniciar el agente para aplicar.',
      saved: Object.keys(newConfig),
    }), {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json',
      },
    });
  }

  private jsonResponse(data: unknown, headers: Record<string, string>, status = 200): Response {
    return new Response(JSON.stringify(data, null, 2), { status, headers });
  }
}
