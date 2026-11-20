import { migrate } from "./migrate";
import { claimJobs, processJob, simulatedProvider } from "./payouts";

const BATCH = Number(process.env.WORKER_BATCH ?? 10);
const IDLE_MS = Number(process.env.WORKER_IDLE_MS ?? 1000);
let running = true;

async function loop() {
  await migrate();
  const provider = simulatedProvider();
  console.log("payout worker started");
  while (running) {
    const jobs = await claimJobs(BATCH);
    if (jobs.length === 0) {
      await new Promise((r) => setTimeout(r, IDLE_MS));
      continue;
    }
    const results = await Promise.all(jobs.map((job) => processJob(job, provider)));
    console.log(`processed ${jobs.length} payouts:`, results.join(", "));
  }
}

process.on("SIGTERM", () => (running = false));
process.on("SIGINT", () => (running = false));

loop().catch((err) => {
  console.error("worker crashed", err);
  process.exit(1);
});
