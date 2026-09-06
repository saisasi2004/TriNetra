/**
 * JSONL recorder.
 *
 * One sensing update per line. Deliberately boring format: greppable,
 * streamable, replayable, and readable by pandas in one line.
 *
 * Recordings contain occupancy patterns for a real household — when people
 * are home, when they sleep, when they leave. That is sensitive whether or
 * not it contains a camera frame. Treat the files accordingly; they are
 * written to a gitignored directory for exactly that reason.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export class Recorder {
  constructor(config, log) {
    this.config = config.record;
    this.log = log('recorder');
    this.stream = null;
    this.file = null;
    this.startedAt = null;
    this.lines = 0;
    this.bytes = 0;
  }

  async init() {
    await fsp.mkdir(this.config.dir, { recursive: true });
    if (this.config.enabled) await this.start();
  }

  async start(name) {
    if (this.stream) await this.stop();

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safe = (name ?? 'session').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);
    this.file = path.join(this.config.dir, `${stamp}_${safe}.jsonl`);

    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    this.stream = fs.createWriteStream(this.file, { flags: 'a' });
    this.startedAt = Date.now();
    this.lines = 0;
    this.bytes = 0;

    // Header line: everything a replay needs to reconstruct the context.
    this.#writeLine({
      type: 'header',
      version: 1,
      started_at: new Date().toISOString(),
      note: 'Contains occupancy and vital-sign data. Handle as personal data.',
    });

    this.log.info(`recording to ${this.file}`);
    return this.file;
  }

  write(update) {
    if (!this.stream) return;
    this.#writeLine(update);
  }

  #writeLine(obj) {
    const line = JSON.stringify(obj) + '\n';
    this.stream.write(line);
    this.lines++;
    this.bytes += line.length;
  }

  async stop() {
    if (!this.stream) return { recording: false };

    const result = {
      recording: false,
      file: this.file,
      lines: this.lines,
      bytes: this.bytes,
      duration_s: Math.round((Date.now() - this.startedAt) / 1000),
    };

    await new Promise((resolve) => this.stream.end(resolve));
    this.stream = null;
    this.log.info(`recording stopped: ${result.lines} lines, ${result.duration_s}s`);
    return result;
  }

  status() {
    return {
      enabled: true,
      recording: this.stream != null,
      file: this.file,
      lines: this.lines,
      bytes: this.bytes,
      duration_s: this.startedAt && this.stream
        ? Math.round((Date.now() - this.startedAt) / 1000)
        : 0,
    };
  }

  async list() {
    try {
      const files = await fsp.readdir(this.config.dir);
      const out = [];
      for (const f of files.filter((x) => x.endsWith('.jsonl'))) {
        const st = await fsp.stat(path.join(this.config.dir, f));
        out.push({ name: f, bytes: st.size, modified: st.mtime.toISOString() });
      }
      return out.sort((a, b) => b.modified.localeCompare(a.modified));
    } catch {
      return [];
    }
  }
}
