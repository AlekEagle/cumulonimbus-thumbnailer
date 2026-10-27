import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import worker from 'node:worker_threads';
import Express from 'express';
import Logger, { Level } from './Logger';
import compression, { filter as _filter } from 'compression';
import DevelopmentCORS from './DevelopmentCORS';
import { config } from 'dotenv';
import { join, resolve, dirname } from 'node:path';
const packageJSON = JSON.parse(readFileSync('./package.json', 'utf8'));

const SAFE_NAME = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9]+)*$/;

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

const activeWorkers: Set<worker.Worker> = new Set();

const port: number =
  8100 + (!process.env.INSTANCE ? 0 : Number(process.env.INSTANCE));
const app = Express();

app.use(compression({ filter: shouldCompress }));

if (process.env.DEBUG) {
  app.use(DevelopmentCORS());
}

if (!existsSync(process.env.OUTPUT_PATH!)) mkdirSync(process.env.OUTPUT_PATH!);

app.all('/', async (_, res) => {
  res.status(200).json({ hello: 'world', version: packageJSON.version });
});

const base = resolve(process.env.BASE_UPLOAD_PATH!);

app.get('/:file', async (req, res) => {
  if (activeWorkers.size >= Number(process.env.MAX_WORKERS ?? 50)) {
    res.status(429).end();
    return;
  }
  const inputPath = join(base, req.params.file);
  if (!SAFE_NAME.test(req.params.file) || dirname(inputPath) !== base) {
    res.status(400).end();
    return;
  }
  const outputPath = join(process.env.OUTPUT_PATH!, `${req.params.file}.webp`);
  if (existsSync(outputPath)) {
    console.debug(
      `Preview cached for ${req.params.file}, not generating another.`,
    );
    res.append('Content-Type', 'image/webp').status(200).sendFile(outputPath);
    return;
  }
  if (!existsSync(inputPath)) {
    console.debug('File does not exist. File: %s', req.params.file);
    res.status(404).end();
    return;
  }
  let thumbWorker = new worker.Worker('./dist/worker.js', {
    workerData: {
      inputPath,
      outputPath,
    },
  });
  activeWorkers.add(thumbWorker);
  thumbWorker.on('online', () => {
    console.debug(`Generating preview for ${req.params.file}...`);
  });
  thumbWorker.on('exit', (code) => {
    activeWorkers.delete(thumbWorker);
    if (code === 0)
      console.debug(`Done generating preview for ${req.params.file}.`);
    else console.debug(`Unable to generate preview for ${req.params.file}`);
  });
  thumbWorker.on('message', (status: number) => {
    if (status !== 200) {
      res.status(status).end();
    } else {
      res.append('Content-Type', 'image/webp').status(201).sendFile(outputPath);
    }
  });
});

app.listen(port, process.env.HOST ?? '127.0.0.1', () => {
  console.log(`Listening on port ${port}.`);
});
