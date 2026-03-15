import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const nextBinPath = require.resolve('next/dist/bin/next');

function pad(value, length = 2) {
  return String(value).padStart(length, '0');
}

function formatTimestamp(date = new Date()) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(
    date.getMilliseconds(),
    3,
  )}`;
}

function createTimestampingWriter(stream) {
  let buffer = '';

  const flushLine = (line, newline = '') => {
    stream.write(`[${formatTimestamp()}] ${line}${newline}`);
  };

  return (chunk) => {
    buffer += chunk.toString('utf8');

    let index = 0;
    let lineStart = 0;

    while (index < buffer.length) {
      const char = buffer[index];

      if (char === '\n' || char === '\r') {
        const line = buffer.slice(lineStart, index);

        if (char === '\r' && buffer[index + 1] === '\n') {
          flushLine(line, '\r\n');
          index += 2;
        } else {
          flushLine(line, char);
          index += 1;
        }

        lineStart = index;
        continue;
      }

      index += 1;
    }

    buffer = buffer.slice(lineStart);
  };
}

const child = spawn(process.execPath, [nextBinPath, 'dev'], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ['inherit', 'pipe', 'pipe'],
});

const writeStdout = createTimestampingWriter(process.stdout);
const writeStderr = createTimestampingWriter(process.stderr);

child.stdout.on('data', writeStdout);
child.stderr.on('data', writeStderr);

const forwardSignal = (signal) => {
  if (!child.killed) {
    child.kill(signal);
  }
};

process.on('SIGINT', () => forwardSignal('SIGINT'));
process.on('SIGTERM', () => forwardSignal('SIGTERM'));

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});
