import app from './app'
import config from './config';
import { ensurePlatformProject } from './lib/platformProject';

async function main() {
  await ensurePlatformProject();

  app.listen(config.port, () => {
    console.log(`Listening on port ${config.port}...`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
