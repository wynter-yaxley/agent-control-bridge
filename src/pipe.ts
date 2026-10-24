import { readdir } from 'node:fs/promises';
import { connect } from 'node:net';
import { AcbError } from './errors.ts';

/**
 * Transport to the ChatGPT desktop app's tool pipe `\\.\pipe\codex-app-tools-<uuid>`: one
 * JSON-RPC request per connection, each message framed by a 4-byte little-endian length.
 */

export type Json = Record<string, unknown>;
/** Sends one JSON-RPC request to the app and resolves with its response. */
export type Transport = (request: Json) => Promise<Json>;

const PIPE_ROOT = '\\\\.\\pipe\\';
const PIPE_NAME = /^codex-app-tools-[0-9a-f-]+$/i;
const MAX_FRAME = 32 * 1024 * 1024;

/** The app's tool pipe. The app runs one instance per user session, so one pipe is expected. */
export async function findPipe(): Promise<string> {
  if (process.platform !== 'win32') {
    throw new AcbError(
      'UNAVAILABLE',
      'The ChatGPT desktop app runs on Windows: start this server with Windows Node.js',
    );
  }
  const name = (await readdir(PIPE_ROOT)).find((entry) => PIPE_NAME.test(entry));
  if (!name) throw new AcbError('UNAVAILABLE', 'The ChatGPT desktop app is not running');
  return PIPE_ROOT + name;
}

/** One framed request/response exchange on a fresh connection to `path`. */
export function exchange(path: string, request: Json, timeoutMs: number): Promise<Json> {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(request));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length);
    let received = Buffer.alloc(0);
    let settled = false;
    const socket = connect(path);
    const settle = (error: AcbError | null, value?: Json) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value as Json);
    };
    socket.setTimeout(timeoutMs, () => settle(new AcbError('TIMEOUT', 'The desktop app did not answer in time')));
    socket.on('connect', () => socket.write(Buffer.concat([header, body])));
    socket.on('data', (chunk) => {
      received = Buffer.concat([received, chunk]);
      if (received.length < 4) return;
      const length = received.readUInt32LE(0);
      if (length > MAX_FRAME) return settle(new AcbError('PROTOCOL', 'The desktop app sent an oversized message'));
      if (received.length < 4 + length) return;
      try {
        settle(null, JSON.parse(received.subarray(4, 4 + length).toString('utf8')));
      } catch {
        settle(new AcbError('PROTOCOL', 'The desktop app sent invalid JSON'));
      }
    });
    socket.on('error', (error: NodeJS.ErrnoException) =>
      settle(
        new AcbError('UNAVAILABLE', `Cannot reach the desktop app (${error.code ?? error.message})`, { connect: true }),
      ),
    );
    socket.on('close', () =>
      settle(new AcbError('PROTOCOL', 'The desktop app closed the connection without answering')),
    );
  });
}

/** A transport that finds the pipe once and finds it again after the app restarts. */
export function pipeTransport(timeoutMs = 30_000, locate: () => Promise<string> = findPipe): Transport {
  let pipe: string | undefined;
  return async (request) => {
    pipe ??= await locate();
    try {
      return await exchange(pipe, request, timeoutMs);
    } catch (error) {
      // Nothing was sent when the connection failed, so one retry on a fresh pipe is safe.
      if (!(error instanceof AcbError && error.details.connect)) throw error;
      pipe = await locate();
      return exchange(pipe, request, timeoutMs);
    }
  };
}
