import { Injectable, NestMiddleware } from '@nestjs/common'
import { AsyncLocalStorage } from 'async_hooks'

type RequestMeta = { ip: string | null; userAgent: string | null }

const storage = new AsyncLocalStorage<RequestMeta>()

/**
 * Who and what made the current request. Audit log writers add this to every
 * entry, so the log shows the address and device behind each action.
 * Outside a request (scheduled jobs, scripts) both values are null.
 */
export function auditMeta(): { ipAddress: string | null; userAgent: string | null } {
  const meta = storage.getStore()
  return { ipAddress: meta?.ip ?? null, userAgent: meta?.userAgent ?? null }
}

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(
    req: { ip?: string; headers: Record<string, string | string[] | undefined> },
    _res: unknown,
    next: () => void,
  ) {
    const ua = req.headers['user-agent']
    storage.run(
      {
        // "trust proxy" is set in main.ts, so this is the real client address behind Render's proxy.
        ip: req.ip ? req.ip.slice(0, 64) : null,
        userAgent: (Array.isArray(ua) ? ua[0] : ua)?.slice(0, 300) ?? null,
      },
      next,
    )
  }
}
