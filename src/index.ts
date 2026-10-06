import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import worker from 'node:worker_threads';
import Express from 'express';
import Logger, { Level } from './Logger';
import compression, { filter as _filter } from 'compression';
import DevelopmentCORS from './DevelopmentCORS';
import { config } from 'dotenv';
import { join } from 'node:path';
const packageJSON = JSON.parse(readFileSync('./package.json', 'utf8'));

config();

global.console = new Logger(
  process.env.DEBUG ? Level.DEBUG : Level.INFO,
) as any;

function shouldCompress(req: Express.Request, res: Express.Response): boolean {
  if (req.headers['x-no-compression']) {
    return false;
  }
  return _filter(req, res);
}

const port: number =
  8100 + (!process.env.instance ? 0 : Number(process.env.instance));
const app = Express();

app.use(compression({ filter: shouldCompress }));

if (process.env.DEBUG) {
  app.use(DevelopmentCORS());
}

if (!existsSync(process.env.OUTPUT_PATH!)) mkdirSync(process.env.OUTPUT_PATH!);

app.all('/', async (req, res) => {
  res.status(200).json({ hello: 'world', version: packageJSON.version });
});

app.get('/:file', async (req, res) => {
  const inputPath = join(process.env.BASE_UPLOAD_PATH!, req.params.file);
  const outputPath = join(process.env.OUTPUT_PATH!, `${req.params.file}.webp`);
  if (existsSync(outputPath)) {
    console.debug(
      `Preview cached for ${req.params.file}, not generating another.`,
    );
    res.append('Content-Type', 'image/webp').sendFile(outputPath);
    return;
  }
  if (!existsSync(inputPath)) {
    console.debug('File does not exist. File: %s', req.params.file);
    res.status(404).end();
    return;
  }
  let thumbWorker = new worker.Worker('./dist/worker.js', {
    workerData: {
      file: req.params.file,
    },
  });
  thumbWorker.on('online', () => {
    console.debug(`Generating preview for ${req.params.file}...`);
  });
  thumbWorker.on('exit', (code) => {
    if (code === 0)
      console.debug(`Done generating preview for ${req.params.file}.`);
    else console.debug(`Unable to generate preview for ${req.params.file}`);
  });
  thumbWorker.on('message', (status: number) => {
    if (status !== 200) {
      res.status(status).end();
    } else {
      res.append('Content-Type', 'image/webp').sendFile(outputPath);
    }
  });
});

app.listen(port, () => {
  console.log(`Listening on port ${port}.`);
});
