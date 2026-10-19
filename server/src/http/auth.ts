import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';

/**
 * Two roles, deliberately not one.
 *
 * The agent files proposals. A reviewer decides them. If the same credential could do
 * both, a compromised agent would simply approve its own work and the audit log would
 * record a human decision that never happened — the log would be precise about a lie.
 *
 * Identity comes from the token. Nothing an HTTP caller puts in a request body is ever
 * treated as who they are.
 */
export type Role = 'agent' | 'reviewer';

export type Caller = { role: Role; actor: string };

/**
 * The caller is stashed on the request under a private symbol rather than by augmenting
 * Express's global types, which would loosen `req.params` everywhere else.
 */
const CALLER = Symbol('interlock.caller');

export function callerOf(req: Request): Caller {
  const caller = (req as Request & { [CALLER]?: Caller })[CALLER];
  if (!caller) throw new Error('callerOf used on a route that is not behind requireRole');
  return caller;
}

function constantTimeEquals(a: string, b: string): boolean {
  // Not a cryptographic concern at this scale, but comparing lengths first and never
  // short-circuiting on the first differing byte costs nothing.
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function resolveCaller(header: string | undefined): Caller | undefined {
  if (!header) return undefined;
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : header.trim();
  if (token.length === 0) return undefined;

  if (config.auth.reviewerToken && constantTimeEquals(token, config.auth.reviewerToken)) {
    return { role: 'reviewer', actor: config.auth.reviewerName };
  }
  if (config.auth.agentToken && constantTimeEquals(token, config.auth.agentToken)) {
    return { role: 'agent', actor: 'agent' };
  }
  return undefined;
}

/** Rejects anyone whose token does not carry one of the listed roles. */
export function requireRole(...allowed: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const caller = resolveCaller(req.header('authorization'));
    if (!caller) {
      res.status(401).json({
        error: 'unauthenticated',
        detail: 'Send Authorization: Bearer <token>. The demo tokens are in the README.',
      });
      return;
    }
    if (!allowed.includes(caller.role)) {
      res.status(403).json({
        error: 'forbidden',
        detail: `This endpoint is for ${allowed.join(' or ')}; your token is ${caller.role}. An agent cannot decide its own proposals.`,
      });
      return;
    }
    (req as Request & { [CALLER]?: Caller })[CALLER] = caller;
    next();
  };
}
