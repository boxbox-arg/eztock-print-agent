import { getDatabase } from './database.ts';
import type { PrintJob } from '../types.ts';

export interface CreateJobInput {
  id: string;
  backendJobId: string;
  printerId: string;
  documentType: string;
  title: string;
  content: Uint8Array;
  contentType: 'escpos' | 'pdf' | 'raw';
  copies: number;
  options: Record<string, unknown>;
  maxRetries: number;
}

export class JobRepository {
  create(input: CreateJobInput): PrintJob {
    const db = getDatabase();
    const now = new Date().toISOString();

    db.run(
      `INSERT INTO print_jobs (
        id, backend_job_id, printer_id, document_type, title,
        content, content_type, copies, options,
        status, retry_count, max_retries, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.id,
        input.backendJobId,
        input.printerId,
        input.documentType,
        input.title,
        input.content,
        input.contentType,
        input.copies,
        JSON.stringify(input.options),
        'pending',
        0,
        input.maxRetries,
        now,
        now,
      ]
    );

    return {
      id: input.id,
      backendJobId: input.backendJobId,
      printerId: input.printerId,
      documentType: input.documentType,
      title: input.title,
      content: input.content,
      contentType: input.contentType,
      copies: input.copies,
      options: input.options,
      status: 'pending',
      retryCount: 0,
      maxRetries: input.maxRetries,
      createdAt: now,
      updatedAt: now,
    };
  }

  findById(id: string): PrintJob | null {
    const db = getDatabase();
    const row = db.query('SELECT * FROM print_jobs WHERE id = ?').get(id) as Record<string, unknown> | null;
    return row ? this.mapRow(row) : null;
  }

  findByBackendJobId(backendJobId: string): PrintJob | null {
    const db = getDatabase();
    const row = db.query('SELECT * FROM print_jobs WHERE backend_job_id = ?').get(backendJobId) as Record<string, unknown> | null;
    return row ? this.mapRow(row) : null;
  }

  findPending(limit = 10): PrintJob[] {
    const db = getDatabase();
    const rows = db.query(
      'SELECT * FROM print_jobs WHERE status IN (?, ?) ORDER BY created_at ASC LIMIT ?'
    ).all('pending', 'queued', limit) as Record<string, unknown>[];
    return rows.map(r => this.mapRow(r));
  }

  findByStatus(status: PrintJob['status']): PrintJob[] {
    const db = getDatabase();
    const rows = db.query('SELECT * FROM print_jobs WHERE status = ? ORDER BY created_at ASC').all(status) as Record<string, unknown>[];
    return rows.map(r => this.mapRow(r));
  }

  updateStatus(id: string, status: PrintJob['status'], error?: string): void {
    const db = getDatabase();
    const now = new Date().toISOString();

    if (error) {
      db.run(
        'UPDATE print_jobs SET status = ?, last_error = ?, updated_at = ? WHERE id = ?',
        [status, error, now, id]
      );
    } else {
      db.run(
        'UPDATE print_jobs SET status = ?, updated_at = ? WHERE id = ?',
        [status, now, id]
      );
    }
  }

  incrementRetry(id: string, error: string): void {
    const db = getDatabase();
    const now = new Date().toISOString();
    db.run(
      'UPDATE print_jobs SET retry_count = retry_count + 1, last_error = ?, updated_at = ? WHERE id = ?',
      [error, now, id]
    );
  }

  deleteOldCompleted(days: number): number {
    const db = getDatabase();
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const result = db.run('DELETE FROM print_jobs WHERE status = ? AND updated_at < ?', ['completed', cutoff]);
    return result.changes;
  }

  deleteOldFailed(days: number): number {
    const db = getDatabase();
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const result = db.run('DELETE FROM print_jobs WHERE status = ? AND updated_at < ?', ['failed', cutoff]);
    return result.changes;
  }

  getStats(): { pending: number; queued: number; printing: number; completed: number; failed: number } {
    const db = getDatabase();
    const result = db.query(`
      SELECT 
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) as queued,
        SUM(CASE WHEN status = 'printing' THEN 1 ELSE 0 END) as printing,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM print_jobs
    `).get() as Record<string, number>;

    return {
      pending: Number(result.pending ?? 0),
      queued: Number(result.queued ?? 0),
      printing: Number(result.printing ?? 0),
      completed: Number(result.completed ?? 0),
      failed: Number(result.failed ?? 0),
    };
  }

  private mapRow(row: Record<string, unknown>): PrintJob {
    return {
      id: String(row.id),
      backendJobId: String(row.backend_job_id),
      printerId: String(row.printer_id),
      documentType: String(row.document_type),
      title: String(row.title),
      content: row.content as Uint8Array,
      contentType: String(row.content_type) as PrintJob['contentType'],
      copies: Number(row.copies ?? 1),
      options: JSON.parse(String(row.options ?? '{}')),
      status: String(row.status) as PrintJob['status'],
      retryCount: Number(row.retry_count ?? 0),
      maxRetries: Number(row.max_retries ?? 3),
      lastError: row.last_error ? String(row.last_error) : undefined,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }
}
