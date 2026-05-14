import { homedir } from 'os';
import { join } from 'path';
import type { AgentConfig } from './types.ts';

function getEnv(key: string, defaultValue?: string): string {
  const value = process.env[key] ?? defaultValue;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function getEnvInt(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (value === undefined) return defaultValue;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) throw new Error(`Invalid integer for ${key}: ${value}`);
  return parsed;
}

export function loadConfig(): AgentConfig {
  const dataDir = process.env.AGENT_DATA_DIR ?? join(homedir(), '.eztock-agent');

  return {
    agentId: getEnv('AGENT_ID', ''),
    organizationId: getEnv('AGENT_ORGANIZATION_ID', ''),
    branchId: getEnv('AGENT_BRANCH_ID', ''),
    pairingToken: getEnv('AGENT_PAIRING_TOKEN', ''),
    backendUrl: getEnv('AGENT_BACKEND_URL', 'https://api.eztock.com'),
    wsUrl: getEnv('AGENT_WS_URL', 'wss://api.eztock.com/ws/print-agent'),
    httpPort: getEnvInt('AGENT_HTTP_PORT', 9100),
    dataDir,
    logLevel: (process.env.AGENT_LOG_LEVEL as AgentConfig['logLevel']) ?? 'info',
  };
}
