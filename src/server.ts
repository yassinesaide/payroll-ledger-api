import { createApp } from "./app";
import { migrate } from "./migrate";

const port = Number(process.env.PORT ?? 3000);

migrate()
  .then(() => {
    createApp().listen(port, () => console.log(`payroll-ledger-api listening on :${port}`));
  })
  .catch((err) => {
    console.error("startup failed", err);
    process.exit(1);
  });
