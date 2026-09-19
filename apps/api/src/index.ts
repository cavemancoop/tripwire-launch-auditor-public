import { buildServer } from './server';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';

const app = buildServer();

app
  .listen({ port, host })
  .then((address) => {
    // eslint-disable-next-line no-console
    console.log(`launch-auditor-api listening on ${address}`);
  })
  .catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
