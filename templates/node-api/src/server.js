import { createServer } from "node:http";
import { handler } from "./app.js";

const port = Number(process.env.PORT || 8080);
const server = createServer(handler);

server.listen(port, () => console.log(`__APP__ listening on :${port}`));

// Kubernetes sends SIGTERM before it stops a pod: finish open requests, then exit
process.on("SIGTERM", () => server.close(() => process.exit(0)));
