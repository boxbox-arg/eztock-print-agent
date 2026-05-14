import { Database } from 'bun:sqlite';
import { join } from 'path';
import type { AgentConfig } from '../types.ts';
import { Logger } from '../logger.ts';

let db: Database | null = null;

export function getDatabase(): Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase first.');
  }
  return db;
}

export function initDatabase(config: AgentConfig, logger: Logger): Database {
  const dbPath = join(config.dataDir, 'agent.db');
  logger.info('Initializing SQLite database at', dbPath);

  db = new Database(dbPath);
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA foreign_keys = ON');

  createTables(db, logger);

  return db;
}

function createTables(db: Database, logger: Logger): void {
  logger.debug('Creating database tables if not exist');

  db.run(`
    CREATE TABLE IF NOT EXISTS print_jobs (
      id TEXT PRIMARY KEY,
      backend_job_id TEXT NOT NULL UNIQUE,
      printer_id TEXT NOT NULL,
      document_type TEXT NOT NULL,
      title TEXT NOT NULL,
      content BLOB NOT NULL,
      content_type TEXT NOT NULL,
      copies INTEGER DEFAULT 1,
      options TEXT DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      retry_count INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 3,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON print_jobs(status, created_at)
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_jobs_backend ON print_jobs(backend_job_id)
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS printer_cache (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      system_name TEXT NOT NULL,
      driver TEXT NOT NULL,
      connection_type TEXT NOT NULL,
      connection_config TEXT DEFAULT '{}',
      capabilities TEXT DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'offline',
      status_detail TEXT,
      is_default INTEGER DEFAULT 0,
      discovered_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS agent_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
}
