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
/** Whether the server of a pipe is the signed ChatGPT desktop app of this user session. */
export type PipeCheck = (path: string) => Promise<boolean>;

const PIPE_ROOT = '\\\\.\\pipe\\';
const PIPE_NAME = /^codex-app-tools-[0-9a-f-]+$/i;
const MAX_FRAME = 32 * 1024 * 1024;

/** The app's tool pipe. Any process can create a pipe with such a name, so its server is checked. */
export async function findPipe(isApp: PipeCheck): Promise<string> {
  if (process.platform !== 'win32') {
    throw new AcbError(
      'UNAVAILABLE',
      'The ChatGPT desktop app runs on Windows: start this server with Windows Node.js',
    );
  }
  const candidates = (await readdir(PIPE_ROOT)).filter((name) => PIPE_NAME.test(name));
  if (!candidates.length) throw new AcbError('UNAVAILABLE', 'The ChatGPT desktop app is not running');
  for (const name of candidates) {
    if (await isApp(PIPE_ROOT + name)) return PIPE_ROOT + name;
  }
  throw new AcbError('UNAVAILABLE', 'No tool pipe belongs to the signed ChatGPT desktop app of this user session');
}

/**
 * One framed request/response exchange on a fresh connection to `path`, within `timeoutMs`.
 * A failure before the connection was made carries `notSent`; after it, the request may have
 * reached the app and the outcome is unknown.
 */
export function exchange(path: string, request: Json, timeoutMs: number): Promise<Json> {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(request));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length);
    let received = Buffer.alloc(0);
    let connected = false;
    let settled = false;
    const socket = connect(path);
    const settle = (error: AcbError | null, value?: Json) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value as Json);
    };
    const timer = setTimeout(
      () => settle(new AcbError('TIMEOUT', 'The desktop app did not answer in time')),
      timeoutMs,
    );
    socket.on('connect', () => {
      connected = true;
      socket.write(Buffer.concat([header, body]));
    });
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
    socket.on('error', (error: NodeJS.ErrnoException) => {
      const reason = error.code ?? error.message;
      settle(
        connected
          ? new AcbError('PROTOCOL', `The connection to the desktop app broke (${reason}); the outcome is unknown`)
          : new AcbError('UNAVAILABLE', `Cannot reach the desktop app (${reason})`, { notSent: true }),
      );
    });
    socket.on('close', () =>
      settle(new AcbError('PROTOCOL', 'The desktop app closed the connection without answering')),
    );
  });
}

/** A transport that finds the pipe once, and again when the app has restarted. */
export function pipeTransport(locate: () => Promise<string>, timeoutMs = 30_000): Transport {
  let pipe: string | undefined;
  return async (request) => {
    pipe ??= await locate();
    try {
      return await exchange(pipe, request, timeoutMs);
    } catch (error) {
      // Only a request that never left can be repeated on a fresh pipe.
      if (!(error instanceof AcbError && error.details.notSent)) throw error;
      pipe = await locate();
      return exchange(pipe, request, timeoutMs);
    }
  };
}
