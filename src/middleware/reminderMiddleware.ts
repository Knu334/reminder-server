import { NextFunction, Request, Response } from "express";
import { lookup } from "node:dns/promises";

export const allowOrigin = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const origin = req.headers.origin || "";

  if (
    origin === process.env.FRONTEND_ORIGIN ||
    /^https?:\/\/.*localhost:?\d*$/.test(origin)
  ) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header(
      "Access-Control-Allow-Headers",
      "X-Requested-With, X-HTTP-Method-Override, Content-Type, Accept"
    );
    res.header("Access-Control-Allow-Methods", "PUT, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Credentials", "true");
  }

  if ("OPTIONS" == req.method) {
    res.send(204); // 204: No Content
  } else {
    next();
  }
};

export const ipFilter = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const clientIp = req.ip;
  const targetIp = await lookup(process.env.ALLOW_DOMAIN || "");
  const localIp = await lookup("localhost");

  if (targetIp.address === clientIp || localIp.address === clientIp) {
    next();
  } else {
    res.status(403).send();
  }
};
