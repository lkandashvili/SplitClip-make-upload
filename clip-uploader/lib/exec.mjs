// Subprocess capture that does not rely on OS pipes.
//
// Why: piping a child's stdout can deadlock when ffprobe emits more than the
// pipe buffer, and some sandboxes forbid pipe creation outright. Redirecting to
// a temp file is boringly reliable and shows the child's real exit status.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let counter = 0;

export function capture(cmd, args, { timeoutMs = 60_000 } = {}) {
  const base = path.join(os.tmpdir(), `clip-uploader-${process.pid}-${counter++}-${Date.now()}`);
  const outFile = `${base}.out`;
  const errFile = `${base}.err`;

  let outFd;
  let errFd;
  try {
    outFd = fs.openSync(outFile, 'w');
    errFd = fs.openSync(errFile, 'w');

    const res = spawnSync(cmd, args, {
      stdio: ['ignore', outFd, errFd],
      timeout: timeoutMs,
      windowsHide: true,
    });

    const stdout = fs.readFileSync(outFile, 'utf8');
    const stderr = fs.readFileSync(errFile, 'utf8');

    return { status: res.status, stdout, stderr, error: res.error ?? null, signal: res.signal ?? null };
  } finally {
    for (const fd of [outFd, errFd]) {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch { /* already closed */ }
      }
    }
    for (const f of [outFile, errFile]) {
      try {
        fs.unlinkSync(f);
      } catch { /* best effort */ }
    }
  }
}
