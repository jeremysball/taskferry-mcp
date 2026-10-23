import net from 'node:net';
import path from 'node:path';
import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import type http from 'node:http';
import type { Listen } from './config.ts';
import { errorCode } from './errors.ts';

export type Listener = { close: () => Promise<void> };

const SOCKET_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const PROBE_TIMEOUT_MS = 1000;

// True when something is accepting connections on `socketPath`. An ECONNREFUSED probe means a
// socket file left behind by a dead process. A probe that hangs is treated as live, and any
// other error propagates, so the caller refuses instead of deleting a socket someone may use.
function socketIsLive(socketPath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const settle = (live: boolean, error?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(live);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => settle(true));
    socket.once('connect', () => settle(true));
    socket.once('error', (e: Error) => {
      const code = errorCode(e);
      if (code === 'ECONNREFUSED' || code === 'ENOENT') settle(false);
      else settle(false, e);
    });
  });
}

// Removes the socket file left by close. A non-socket file at the path is never touched.
function removeSocket(file: string) {
  try {
    if (lstatSync(file).isSocket()) unlinkSync(file);
  } catch {
    // Already gone, or unreadable: nothing safe to remove.
  }
}

function listening(server: http.Server, start: () => void) {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    start();
  });
}

function closeServer(server: http.Server) {
  return new Promise<void>((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

// Binds `server` to a unix socket only its owner can use, or to loopback TCP. A unix socket
// needs three things Node does not do itself: a private directory, mode 0600 on the socket,
// and a decision about a file already at the path. A dead socket is replaced; a live one and
// a non-socket file are refused.
export async function listenBridge(server: http.Server, listen: Listen): Promise<Listener> {
  if (listen.kind === 'tcp') {
    await listening(server, () => server.listen(listen.port, '127.0.0.1'));
    return { close: () => closeServer(server) };
  }

  const directory = path.dirname(listen.path);
  // The mode applies only to a directory this call creates. An existing directory keeps its
  // mode: forcing 0700 on a caller-supplied path could lock down something like a home dir.
  mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });

  if (existsSync(listen.path)) {
    if (!lstatSync(listen.path).isSocket()) {
      throw new Error(`${listen.path} exists and is not a socket`);
    }
    if (await socketIsLive(listen.path)) {
      throw new Error(`${listen.path} is already in use`);
    }
    unlinkSync(listen.path);
  }

  await listening(server, () => {
    const previous = process.umask(0o077);
    try {
      server.listen(listen.path);
    } finally {
      process.umask(previous);
    }
  });
  chmodSync(listen.path, SOCKET_MODE);

  return {
    close: async () => {
      await closeServer(server);
      removeSocket(listen.path);
    },
  };
}
