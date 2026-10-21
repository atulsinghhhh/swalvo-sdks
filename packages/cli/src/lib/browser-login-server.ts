import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { CliError } from './errors.js';

export interface BrowserLoginResult {
  token: string;
  email: string;
}

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes to complete the browser step

/**
 * A one-shot local server for the browser login handshake.
 *
 * Binds to 127.0.0.1 only, never 0.0.0.0. This must not be reachable from
 * the network. It waits for the dashboard's /cli-auth page to relay the
 * user's existing session token back once they approve the login.
 *
 * Not a second auth system, just a relay. It reuses the Control API's JWT
 * session auth and hands the token to whichever CLI process is waiting.
 */
export function startBrowserLoginServer(): {
  port: Promise<number>;
  state: string;
  result: Promise<BrowserLoginResult>;
} {
  const state = randomBytes(16).toString('hex');
  let server: Server;

  const portPromise = new Promise<number>((resolvePort, rejectPort) => {
    server = createServer();
    server.on('error', rejectPort);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') resolvePort(address.port);
      else rejectPort(new Error('Could not determine local server port'));
    });
  });

  const result = new Promise<BrowserLoginResult>((resolveResult, rejectResult) => {
    const timeout = setTimeout(() => {
      server?.close();
      rejectResult(
        new CliError('auth', 'Timed out waiting for browser login.', {
          suggestion: 'Run `swalvo login` again',
        }),
      );
    }, LOGIN_TIMEOUT_MS);

    portPromise.then(() => {
      server.on('request', (req, res) => {
        // The dashboard origin might be a real remote host rather than
        // localhost, so CORS has to allow it. Fine: this server dies right
        // after the one exchange.
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
          res.writeHead(204).end();
          return;
        }

        if (req.method !== 'POST' || req.url !== '/callback') {
          res.writeHead(404).end();
          return;
        }

        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', () => {
          try {
            const parsed = JSON.parse(body) as { state?: string; token?: string; email?: string };
            if (parsed.state !== state || !parsed.token || !parsed.email) {
              res
                .writeHead(400, { 'Content-Type': 'application/json' })
                .end(JSON.stringify({ message: 'Invalid callback payload' }));
              return;
            }

            res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }));
            clearTimeout(timeout);
            server.close();
            resolveResult({ token: parsed.token, email: parsed.email });
          } catch {
            res
              .writeHead(400, { 'Content-Type': 'application/json' })
              .end(JSON.stringify({ message: 'Malformed request body' }));
          }
        });
      });
    });
  });

  return { port: portPromise, state, result };
}
