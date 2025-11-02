import createError, { HttpError } from "http-errors";
import express, { Request, Response, NextFunction } from "express";
import cookieParser from "cookie-parser";
import logger from "morgan";
import helmet from "helmet";
import fs from "fs";
import path from "path";
import https from "https";

import indexRouter from "@/router/index";
import { allowOrigin, ipFilter } from "./middleware/reminderMiddleware";

const app = express();

app.use(logger("dev"));
app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(helmet());

app.use(ipFilter);
app.use(allowOrigin);

app.use("/", indexRouter);

// catch 404 and forward to error handler
app.use((_req: Request, _res: Response, next: NextFunction) => {
  next(createError(404));
});

// error handler
app.use((err: HttpError, req: Request, res: Response, _next: NextFunction) => {
  if (req.app.get("env") === "development") {
    console.log(err);
  }

  // response error message
  res.status(err.status || 500);
  res.send({
    msg: "Error has occurred!!",
  });
});

if (process.env.NODE_ENV === "production") {
  let server: https.Server;
  const certPath = process.env.CERT_PATH || "";
  const loadCertificates = () => {
    return {
      key: fs.readFileSync(path.join(certPath, "privkey.pem")),
      cert: fs.readFileSync(path.join(certPath, "cert.pem")),
    };
  };
  const startServer = () => {
    const credentials = loadCertificates();

    if (server) {
      server.close(() => {
        console.log("旧サーバーをクローズしました");
        server = https.createServer(credentials, app);
        server.listen(Number(process.env.PORT || 3000), () => {
          console.log("新しい証明書でサーバーを再起動しました");
        });
      });
    } else {
      server = https.createServer(credentials, app);
      server.listen(Number(process.env.PORT || 3000), () => {
        console.log("サーバーを起動しました");
      });
    }
  };

  // 証明書ファイルを監視
  fs.watch(certPath, (_eventType, filename) => {
    if (filename === "cert.pem" || filename === "privkey.pem") {
      console.log("証明書の変更を検知しました。サーバーを再起動します...");
      setTimeout(startServer, 1000); // 少し待ってから再起動
    }
  });

  startServer();
} else {
  app.listen(process.env.PORT || "3000");
}
