import type { Request, Response } from 'express';

export default async function handler(req: Request, res: Response) {
  const { default: app } = await import('../server/src/index.js');
  return app(req, res);
}
