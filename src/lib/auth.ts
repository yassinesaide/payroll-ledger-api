import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { HttpError } from "./errors";

const SECRET = process.env.JWT_SECRET ?? "dev-secret-change-me";

export function issueToken(userId: string): string {
  return jwt.sign({ sub: userId }, SECRET, { expiresIn: "1h", algorithm: "HS256" });
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  try {
    const payload = jwt.verify(token, SECRET, { algorithms: ["HS256"] }) as jwt.JwtPayload;
    if (!payload.sub) throw new Error("missing subject");
    req.userId = payload.sub;
    next();
  } catch {
    next(new HttpError(401, "unauthorized", "Missing or invalid bearer token"));
  }
}
