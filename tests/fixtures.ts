/**
 * A real 64x64 RGBA PNG: an opaque circle on a transparent field, i.e. the shape a
 * successful background removal produces. Only 223 bytes — flat colour compresses hard,
 * which is exactly why the cutout guard measures dimensions rather than byte length.
 */
export const CUTOUT_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAApklEQVR42u3aUQ2AMAxF0cmZfz14AQ0ktGvpuQkC3vlj21qSJEmK7dr7fvuNHP0LjC+Ht4KIHF4eInN8OYQT48sgnBx/HKHC+GMIlcanI1Qcn4ZQeXwKwmiADuNDEUYDdBofggBgMkDH8Z8iAAAAAAAAAAAAAAAAwA+R32EAjsUcijoadzEyGGD83aDbYe8DvBDxRsgrMe8EvRRNh1jdGzlakiSV7gFzyidhKkfs5AAAAABJRU5ErkJggg==';

/**
 * The 1x1 transparent PNG a background-removal agent hands back when it never actually
 * received the image. Captured from a live agent turn against the deployed Worker.
 */
export const PLACEHOLDER_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

interface JobRow {
  token: string;
  status: string;
  created_at: string;
  expires_at: string;
}

interface NoteRow {
  kind: string;
  note: string;
  updatedAt: string;
}

/**
 * Enough of D1 to exercise the ticket lifecycle and the notes beside it: these tests are
 * about state, not SQL. Shared because the asynchronous path spans both — the ticket is
 * issued by one request and settled by another, with the note as the only thing carrying
 * the reason between them.
 */
export function makeJobDb() {
  const rows = new Map<string, JobRow>();
  const notes = new Map<string, NoteRow>();

  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async run() {
              if (sql.startsWith('INSERT INTO bg_jobs')) {
                const [jobId, token, status, createdAt, expiresAt] = args as string[];
                rows.set(jobId, { token, status, created_at: createdAt, expires_at: expiresAt });
              } else if (sql.startsWith('UPDATE bg_jobs')) {
                const [status, jobId] = args as string[];
                const row = rows.get(jobId);
                // markInputFetched guards on the current status; honour that here so the
                // test can prove a late download cannot clobber a delivered result.
                const guard = sql.match(/AND status = '([a-z]+)'/)?.[1];
                if (row && (!guard || row.status === guard)) row.status = status;
              } else if (sql.startsWith('DELETE FROM bg_jobs')) {
                for (const [id, row] of rows) {
                  if (Date.parse(row.expires_at) < Date.parse(args[0] as string)) rows.delete(id);
                }
              } else if (sql.startsWith('INSERT INTO bg_job_notes')) {
                const [jobId, kind, note, updatedAt] = args as string[];
                notes.set(jobId, { kind, note, updatedAt });
              }
            },
            async first() {
              if (sql.includes('FROM bg_job_notes')) return notes.get(args[0] as string) ?? null;
              if (!sql.includes('FROM bg_jobs')) return null;
              const row = rows.get(args[0] as string);
              return row
                ? {
                    token: row.token,
                    status: row.status,
                    createdAt: row.created_at,
                    expiresAt: row.expires_at,
                  }
                : null;
            },
            async all() {
              return { results: [] };
            },
          };
        },
        async run() {
          // pruneJobTickets sweeps orphaned notes with no bound parameters.
          if (sql.startsWith('DELETE FROM bg_job_notes')) {
            for (const id of notes.keys()) if (!rows.has(id)) notes.delete(id);
          }
        },
        async first() {
          return null;
        },
        async all() {
          return { results: [] };
        },
      };
    },
    async batch() {
      return [];
    },
    async exec() {},
  } as unknown as D1Database;

  return { db, rows, notes };
}
