import createError, { HttpError } from "http-errors";
import express, { Request, Response, NextFunction } from "express";
import { init } from "greenlock-express";
import cookieParser from "cookie-parser";
import logger from "morgan";
import helmet from "helmet";

import indexRouter from "@/router/index";
import { allowOrigin, ipFilter } from "./middleware/reminderMiddleware";

const app = express();

app.use(logger("dev"));
app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(helmet());

app.use(ipFilter)
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
  init({
    packageRoot: __dirname,

    // contact for security and critical bug notices
    maintainerEmail: process.env.GREENLOCK_EMAIL || "",

    // where to look for configuration
    configDir: "./greenlock.d",

    // whether or not to run at cloudscale
    cluster: false,
  }).serve(app);
} else {
  app.listen(process.env.PORT || "3000");
}
