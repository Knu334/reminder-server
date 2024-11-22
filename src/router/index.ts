import { getReminders, setReminders } from "@/util/reminderUtils";
import express, { Request, Response, Router } from "express";

const router: Router = express.Router();

router.put("/reminders", (req: Request, res: Response) => {
  const { key, reminders } = req.body;
  setReminders(key, reminders);
  res.status(200).send();
});

router.post("/reminders", (req: Request, res: Response) => {
  const { key } = req.body;
  res.status(200).send(getReminders(key));
});

export default router as Router;
