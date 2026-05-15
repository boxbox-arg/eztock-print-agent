import { type Server } from 'bun';
import type { AgentConfig, AgentStatus, PrinterInfo, PrintJob } from './types.ts';
import { Logger } from './logger.ts';
import { JobRepository } from './queue/job-repository.ts';
import { hostname } from 'os';
import { platform } from 'os';
import { saveConfig } from './config.ts';

export class HttpServer {
  private server: Server | null = null;
  private config: AgentConfig;
  private logger: Logger;
  private jobRepo: JobRepository;
  private getStatus: () => AgentStatus;
  private getPrinters: () => PrinterInfo[];
  private onConfigure: (newConfig: Partial<AgentConfig>) => void;
  private onRestartNeeded: () => void;
  private needsRestart = false;

  constructor(
    config: AgentConfig,
    logger: Logger,
    jobRepo: JobRepository,
    getStatus: () => AgentStatus,
    getPrinters: () => PrinterInfo[],
    onConfigure: (newConfig: Partial<AgentConfig>) => void,
    onRestartNeeded?: () => void,
  ) {
    this.config = config;
    this.logger = logger;
    this.jobRepo = jobRepo;
    this.getStatus = getStatus;
    this.getPrinters = getPrinters;
    this.onConfigure = onConfigure;
    this.onRestartNeeded = onRestartNeeded ?? (() => {});
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
      // Root — status page with pairing form
      if (path === '/' && req.method === 'GET') {
        return this.rootPage(isConfigured);
      }

      // Pair via browser (agent calls backend internally)
      if (path === '/pair' && req.method === 'POST') {
        return this.handlePair(req);
      }

      // Configure endpoint
      if (path === '/configure' && req.method === 'POST') {
        return this.handleConfigure(req);
      }

      // JSON API endpoints
      const jsonHeaders = {
        'Access-Control-Allow-Origin': '*',
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
    h1 { font-size: 1.5rem; margin-bottom: .25rem; color: #f8fafc; }
    .subtitle { font-size: .85rem; color: #94a3b8; margin-bottom: 1.5rem; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: .75rem; }
    .label { font-size: .75rem; color: #94a3b8; text-transform: uppercase; letter-spacing: .05em; }
    .value { font-size: .9rem; font-family: 'SF Mono', 'Fira Code', monospace; word-break: break-all; }
    .section { margin-top: 1.5rem; padding-top: 1.5rem; border-top: 1px solid #334155; }
    code { background: #334155; padding: 2px 6px; border-radius: 4px; font-size: .85rem; }

    .pair-form { display: flex; gap: .5rem; margin-top: .75rem; }
    .pair-input { flex: 1; background: #0f172a; border: 1px solid #475569; color: #e2e8f0; font-family: 'SF Mono', monospace; font-size: 1.25rem; text-align: center; letter-spacing: .3em; padding: .75rem; border-radius: 8px; outline: none; }
    .pair-input:focus { border-color: #3b82f6; }
    .pair-input::placeholder { font-size: .9rem; letter-spacing: 0; color: #64748b; }
    .btn { background: #3b82f6; color: #fff; border: none; padding: .75rem 1.5rem; border-radius: 8px; font-weight: 600; cursor: pointer; white-space: nowrap; }
    .btn:hover { background: #2563eb; }
    .btn:disabled { opacity: .5; cursor: not-allowed; }

    .msg { margin-top: .75rem; padding: .75rem; border-radius: 8px; font-size: .875rem; display: none; }
    .msg.success { display: block; background: #14532d; border: 1px solid #16a34a; color: #bbf7d0; }
    .msg.error { display: block; background: #450a0a; border: 1px solid #dc2626; color: #fecaca; }
    .msg.loading { display: block; background: #1e3a5f; border: 1px solid #3b82f6; color: #93c5fd; }

    .step { display: flex; align-items: flex-start; gap: .75rem; margin: .75rem 0; }
    .step-num { display: flex; align-items: center; justify-content: center; min-width: 28px; height: 28px; background: #334155; border-radius: 50%; font-size: .8rem; font-weight: 700; color: #94a3b8; }
    .step.active .step-num { background: #3b82f6; color: #fff; }
    .step.done .step-num { background: #16a34a; color: #fff; }
    .step p { font-size: .9rem; margin-top: 3px; }
  </style>
</head>
<body>
  <div class="card">
    ${configured ? this.renderConfigured(status) : this.renderUnconfigured()}
  </div>

  <script>
    async function doPair() {
      const input = document.getElementById('pair-code');
      const msg = document.getElementById('pair-msg');
      const btn = document.getElementById('pair-btn');
      const code = input.value.trim().toUpperCase();

      if (code.length !== 6) { input.focus(); return; }

      btn.disabled = true;
      msg.className = 'msg loading';
      msg.textContent = 'Vinculando agente...';

      try {
        const res = await fetch('/pair', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code }),
        });
        const data = await res.json();

        if (res.ok) {
          msg.className = 'msg success';
          msg.innerHTML = '<strong>✅ Vinculado correctamente.</strong> El agente ya está conectado.';
          btn.textContent = '✅ Vinculado';
        } else {
          msg.className = 'msg error';
          msg.textContent = '❌ ' + (data.error || 'Error al vincular');
          btn.disabled = false;
        }
      } catch (err) {
        msg.className = 'msg error';
        msg.textContent = '❌ Error de conexión con el agente local';
        btn.disabled = false;
      }
    }
  </script>
</body>
</html>`;

    return new Response(html, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  private renderConfigured(status: AgentStatus): string {
    const osColor = status.isConnected ? '#16a34a' : '#dc2626';
    return `
      <div style="display:flex;align-items:center;justify-content:space-between">
        <div>
          <h1>Eztock Print Agent</h1>
          <p class="subtitle">${status.hostname} — ${status.os}</p>
        </div>
        <span style="background:${osColor};color:#fff;padding:4px 12px;border-radius:6px;font-size:.8rem;font-weight:600">${status.isConnected ? 'ONLINE' : 'OFFLINE'}</span>
      </div>
      <div class="grid">
        <div><div class="label">Agent ID</div><div class="value">${status.agentId}</div></div>
        <div><div class="label">Uptime</div><div class="value">${Math.floor(status.uptime)}s</div></div>
        <div><div class="label">Printers</div><div class="value">${status.printers.length}</div></div>
        <div><div class="label">Queue</div><div class="value">${status.queueStats.pending + status.queueStats.queued + status.queueStats.printing} activos</div></div>
      </div>
      <div class="section">
        <p style="color:#16a34a;font-weight:600">✅ Agente configurado y funcionando.</p>
        <ul style="margin-top:.75rem;list-style:none">
          <li style="margin:.25rem 0;font-size:.85rem">→ GET /status — Estado completo</li>
          <li style="margin:.25rem 0;font-size:.85rem">→ GET /printers — Impresoras</li>
          <li style="margin:.25rem 0;font-size:.85rem">→ GET /health — Health check</li>
        </ul>
      </div>`;
  }

  private renderUnconfigured(): string {
    return `
      <h1>Eztock Print Agent</h1>
      <p class="subtitle">Agente sin configurar</p>

      <div class="section">
        <div class="step active">
          <div class="step-num">1</div>
          <div>
            <strong>Generá un código en el panel Eztock</strong>
            <p>En el navegador: Impresión → Agentes → Vincular agente</p>
          </div>
        </div>
        <div class="step">
          <div class="step-num">2</div>
          <div>
            <strong>Ingresá el código acá</strong>
            <p>Escribí el código de 6 caracteres y hacé clic en Vincular</p>
          </div>
        </div>
        <div class="step">
          <div class="step-num">3</div>
          <div>
            <strong>¡Listo!</strong>
            <p>El agente se conecta automáticamente</p>
          </div>
        </div>

        <div class="pair-form">
          <input id="pair-code" class="pair-input" type="text" maxlength="6" placeholder="Código" autocomplete="off" autocorrect="off" spellcheck="false">
          <button id="pair-btn" class="btn" onclick="doPair()">Vincular</button>
        </div>
        <div id="pair-msg" class="msg"></div>
      </div>

      <div class="section" style="margin-top:.75rem;padding-top:1rem">
        <p style="font-size:.8rem;color:#64748b">
          ¿No tenés un código? Abrí el panel Eztock en otra computadora,
          andá a Impresión → Agentes → "Vincular agente".
        </p>
        <details style="margin-top:.5rem">
          <summary style="font-size:.8rem;color:#64748b;cursor:pointer">Configuración manual</summary>
          <p style="margin-top:.5rem;font-size:.8rem;color:#94a3b8">
            Podés configurar el agente creando el archivo <code>${this.config.dataDir}/.env</code>
            con las variables del panel, o mediante
            <code>curl -X POST http://localhost:${this.config.httpPort}/configure ...</code>
          </p>
        </details>
      </div>`;
  }

  private async handlePair(req: Request): Promise<Response> {
    let body: { code?: string };
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: 'JSON inválido' }, { status: 400 });
    }

    const code = (body.code || '').trim().toUpperCase();
    if (code.length !== 6) {
      return Response.json({ error: 'El código debe tener 6 caracteres' }, { status: 400 });
    }

    this.logger.info(`Pairing via browser: code=${code}`);

    try {
      const backendUrl = this.config.backendUrl.replace(/\/+$/, '');
      const osName = platform() === 'win32' ? 'windows' : platform() === 'darwin' ? 'macos' : 'linux';

      const response = await fetch(`${backendUrl}/api/v1/printing/agents/claim-pairing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code,
          hostname: hostname(),
          os: osName,
          version: '0.1.0',
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        const msg = result.message || result.data?.message || `Error HTTP ${response.status}`;
        return Response.json({ error: msg }, { status: 400 });
      }

      const data = result.data || result;

      this.logger.info('Pairing successful, saving config...');

      saveConfig({
        agentId: data.agentId,
        organizationId: data.organizationId,
        branchId: data.branchId,
        pairingToken: data.pairingToken,
        backendUrl: this.config.backendUrl,
      }, this.config.dataDir);

      this.config.agentId = data.agentId;
      this.config.organizationId = data.organizationId;
      this.config.branchId = data.branchId;
      this.config.pairingToken = data.pairingToken;

      this.onConfigure({
        agentId: data.agentId,
        organizationId: data.organizationId,
        branchId: data.branchId,
        pairingToken: data.pairingToken,
      });

      return Response.json({ success: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error de conexión con el servidor';
      this.logger.error('Pairing failed:', { error: msg });
      return Response.json({ error: msg }, { status: 500 });
    }
  }

  private async handleConfigure(req: Request): Promise<Response> {
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const newConfig: Partial<AgentConfig> = {};

    if (typeof body.agentId === 'string') newConfig.agentId = body.agentId;
    if (typeof body.organizationId === 'string') newConfig.organizationId = body.organizationId;
    if (typeof body.branchId === 'string') newConfig.branchId = body.branchId;
    if (typeof body.pairingToken === 'string') newConfig.pairingToken = body.pairingToken;
    if (typeof body.backendUrl === 'string') newConfig.backendUrl = body.backendUrl;
    if (typeof body.wsUrl === 'string') newConfig.wsUrl = body.wsUrl;

    if (Object.keys(newConfig).length === 0) {
      return Response.json({
        error: 'No valid config fields provided',
        validFields: ['agentId', 'organizationId', 'branchId', 'pairingToken', 'backendUrl', 'wsUrl'],
      }, { status: 400 });
    }

    this.logger.info('Configuration received via HTTP API');
    this.onConfigure(newConfig);

    return Response.json({
      message: 'Configuración aplicada.',
      saved: Object.keys(newConfig),
    });
  }

  private jsonResponse(data: unknown, headers: Record<string, string>, status = 200): Response {
    return new Response(JSON.stringify(data, null, 2), { status, headers });
  }
}
