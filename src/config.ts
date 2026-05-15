import { homedir } from 'os';
import { join } from 'path';
import { existsSync } from 'fs';
import type { AgentConfig } from './types.ts';

// CLI flags
const args = process.argv.slice(2);
const configFlagIndex = args.findIndex(a => a === '--config');
const configPath = configFlagIndex >= 0 ? args[configFlagIndex + 1] : undefined;
const isHelp = args.includes('--help') || args.includes('-h');

export function isHelpRequested(): boolean {
  return isHelp;
}

function parseEnvLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const eqIdx = trimmed.indexOf('=');
  if (eqIdx < 1) return null;
  const key = trimmed.substring(0, eqIdx).trim();
  const value = trimmed.substring(eqIdx + 1).trim();
  return [key, value];
}

async function readEnvFile(path: string): Promise<Record<string, string>> {
  try {
    if (!existsSync(path)) return {};
    const text = await Bun.file(path).text();
    const result: Record<string, string> = {};
    for (const line of text.split('\n')) {
      const parsed = parseEnvLine(line);
      if (parsed) {
        result[parsed[0]] = parsed[1];
      }
    }
    return result;
  } catch {
    return {};
  }
}

export async function loadConfig(): Promise<AgentConfig> {
  const dataDir = process.env.AGENT_DATA_DIR ?? join(homedir(), '.eztock-agent');
  const resolvedConfigPath = configPath ?? join(dataDir, '.env');

  // Load from .env file (process env vars take priority)
  const fileEnv = await readEnvFile(resolvedConfigPath);

  function getEnv(key: string, defaultValue?: string): string {
    const value = process.env[key] ?? fileEnv[key] ?? defaultValue ?? '';
    return value;
  }

  function getEnvInt(key: string, defaultValue: number): number {
    const value = process.env[key] ?? fileEnv[key];
    if (value === undefined) return defaultValue;
    const parsed = parseInt(value, 10);
    if (isNaN(parsed)) return defaultValue;
    return parsed;
  }

  const rawBackendUrl = getEnv('AGENT_BACKEND_URL', 'https://api.eztock.com')
  const rawWsUrl = process.env.AGENT_WS_URL ?? fileEnv.AGENT_WS_URL

  // Derive WS URL from backend URL if not explicitly set
  const wsUrl = rawWsUrl || rawBackendUrl
    .replace(/^http:/, 'ws:')
    .replace(/^https:/, 'wss:')
    .replace(/\/+$/, '') + '/ws/print-agent'

  return {
    agentId: getEnv('AGENT_ID'),
    organizationId: getEnv('AGENT_ORGANIZATION_ID'),
    branchId: getEnv('AGENT_BRANCH_ID'),
    pairingToken: getEnv('AGENT_PAIRING_TOKEN'),
    backendUrl: rawBackendUrl,
    wsUrl,
    httpPort: getEnvInt('AGENT_HTTP_PORT', 9100),
    dataDir,
    logLevel: (process.env.AGENT_LOG_LEVEL ?? fileEnv.AGENT_LOG_LEVEL ?? 'info') as AgentConfig['logLevel'],
  };
}

export function saveConfig(config: Partial<AgentConfig>, dataDir: string): void {
  const path = join(dataDir, '.env');
  let content = '';
  if (config.agentId) content += `AGENT_ID=${config.agentId}\n`;
  if (config.organizationId) content += `AGENT_ORGANIZATION_ID=${config.organizationId}\n`;
  if (config.branchId) content += `AGENT_BRANCH_ID=${config.branchId}\n`;
  if (config.pairingToken) content += `AGENT_PAIRING_TOKEN=${config.pairingToken}\n`;
  if (config.backendUrl) content += `AGENT_BACKEND_URL=${config.backendUrl}\n`;
  if (config.wsUrl) content += `AGENT_WS_URL=${config.wsUrl}\n`;
  if (config.httpPort) content += `AGENT_HTTP_PORT=${config.httpPort}\n`;
  if (config.logLevel) content += `AGENT_LOG_LEVEL=${config.logLevel}\n`;
  Bun.write(path, content);
}
