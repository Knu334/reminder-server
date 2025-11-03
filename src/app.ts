import createError, { HttpError } from "http-errors";
import express, { Request, Response, NextFunction } from "express";
import cookieParser from "cookie-parser";
import logger from "morgan";
import helmet from "helmet";
import fs from "fs";
import path from "path";
import https from "https";
import chokidar from "chokidar";

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
  let restarting = false;
  const certPath = process.env.CERT_PATH || "";
  const loadCertificates = (): https.ServerOptions => {
    return {
      key: fs.readFileSync(path.join(certPath, "privkey.pem")),
      cert: fs.readFileSync(path.join(certPath, "cert.pem")),
    };
  };
  const startServer = () => {
    if (restarting) {
      console.log("サーバー再起動中のため、再度のリロード要求を無視します");
      return;
    }
    restarting = true;
    const credentials = loadCertificates();

    if (server) {
      server.close(() => {
        console.log("旧サーバーをクローズしました");
        server = https.createServer(credentials, app);
        server.listen(Number(process.env.PORT || 3000), () => {
          console.log("新しい証明書でサーバーを再起動しました");
          restarting = false;
        });
      });
    } else {
      server = https.createServer(credentials, app);
      server.listen(Number(process.env.PORT || 3000), () => {
        console.log("サーバーを起動しました");
        restarting = false;
      });
    }
  };

  if (certPath && fs.existsSync(certPath)) {
    const watcher = chokidar.watch(
      [path.join(certPath, "cert.pem"), path.join(certPath, "privkey.pem")],
      {
        usePolling: true,
        interval: 1000,
        awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
      }
    );

    watcher.on("change", (p) => {
      console.log(`${p} が変更されました。証明書を再読み込みします`);
      setTimeout(startServer, 1000);
    });

    watcher.on("error", (err) => {
      console.error("証明書監視中にエラーが発生しました:", err);
    });
  }

  startServer();
} else {
  app.listen(process.env.PORT || "3000");
}
