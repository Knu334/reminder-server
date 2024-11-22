import { Reminder } from "@/types/types";
import fs from "fs";

const file = process.env.STORAGE_FILE || "./reminders.txt";

export const getReminders = (key: string): Reminder[] => {
  const json = fs.readFileSync(file);
  const reminders: { [key: string]: Reminder[] } = JSON.parse(json.toString());
  return reminders[key];
};

export const setReminders = (key: string, reminders: Reminder[]) => {
  const json = fs.readFileSync(file);
  const storage: { [key: string]: Reminder[] } = JSON.parse(json.toString());
  storage[key] = reminders;
  fs.writeFileSync(file, JSON.stringify(storage));
};
