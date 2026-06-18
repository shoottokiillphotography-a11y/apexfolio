import { getDb } from "./db.js";
import { startScheduler } from "./services/scheduler.js";

getDb();
startScheduler();
console.log("Portfolio tracker worker started.");
