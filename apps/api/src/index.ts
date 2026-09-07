// Must run before anything that reads process.env (createApp -> db.ts's
// PrismaClient construction included), so this import stays first.
import 'dotenv/config';

import { createApp } from './app';

const app = createApp();
const port = process.env.PORT ? Number(process.env.PORT) : 4000;

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`api listening on http://localhost:${port}`);
});
