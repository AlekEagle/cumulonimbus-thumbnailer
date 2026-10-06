import { execFile } from 'child_process';
import worker from 'worker_threads';
import { fileTypeFromFile } from 'file-type';
import puppeteer, { Browser } from 'puppeteer';
import { unlink, chmod } from 'fs/promises';
import { config } from 'dotenv';
import { join } from 'node:path';

// Configure us some environment variables
config();

let timeout: ReturnType<typeof setTimeout> | null = null;

function restartTimeout(browser: Browser | null) {
  if (timeout !== null) clearTimeout(timeout);
  timeout = setTimeout(() => {
    if (browser !== null) browser.close();
    worker.parentPort!.postMessage(408);
    process.exit(1);
  }, 15e3);
}

function execFileP(
  cmd: string,
  args: string[],
  timeoutMs?: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      { timeout: timeoutMs },
      (error, stdout, stderr) => {
        if (error) return reject(error);
        resolve({ stdout, stderr });
      },
    );
    // If the process fails to even spawn, make sure it can't linger.
    child.on('error', reject);
  });
}

// Test if file has a video stream or image stream
async function hasVideoOrImageStream(file: string): Promise<boolean> {
  try {
    const { stdout } = await execFileP('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=codec_type',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      file,
    ]);
    return stdout.trim() === 'video';
  } catch {
    return false;
  }
}

// Test if file has an audio stream
async function hasAudioStream(file: string): Promise<boolean> {
  try {
    const { stdout } = await execFileP('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'a:0',
      '-show_entries',
      'stream=codec_type',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      file,
    ]);
    return stdout.trim() === 'audio';
  } catch {
    return false;
  }
}

// This is a worker thread, so we can't run it as the main thread
if (worker.isMainThread) throw new Error("can't be ran as main thread");
(async function () {
  const inputPath = join(process.env.BASE_UPLOAD_PATH!, worker.workerData.file);
  const outputPath = join(
    process.env.OUTPUT_PATH!,
    `${worker.workerData.file}.webp`,
  );
  try {
    let a = await fileTypeFromFile(
      join(process.env.BASE_UPLOAD_PATH!, worker.workerData.file),
    );
    if (a === undefined && !worker.workerData.file.match(/\.html?$/)) {
      worker.parentPort!.postMessage(415);
      process.exit(0);
    }
    if (worker.workerData.file.match(/\.html?$/)) {
      const browser = await puppeteer.launch(),
        page = await browser.newPage();
      page.setViewport({ width: 256, height: 256 });
      restartTimeout(browser);
      await page.goto(
        `file://${join(process.env.BASE_UPLOAD_PATH!, worker.workerData.file)}`,
        {
          waitUntil: 'networkidle2',
        },
      );
      await page.screenshot({
        path: outputPath,
      });
      restartTimeout(browser);
      await chmod(outputPath, 0o666);
      worker.parentPort!.postMessage(200);
      process.exit(0);
    } else if (
      await hasVideoOrImageStream(
        join(process.env.BASE_UPLOAD_PATH!, worker.workerData.file),
      )
    ) {
      restartTimeout(null);
      await execFileP(
        'ffmpeg',
        [
          '-i',
          join(process.env.BASE_UPLOAD_PATH!, worker.workerData.file),
          '-vf',
          'scale=256:256:force_original_aspect_ratio=1,format=rgba,pad=256:256:(ow-iw)/2:(oh-ih)/2:color=#00000000',
          '-vframes',
          '1',
          outputPath,
        ],
        15000, // bounded, in line with the 15s worker restart timeout
      );
      worker.parentPort!.postMessage(200);
      process.exit(0);
    } else if (a!.mime === 'application/pdf') {
      restartTimeout(null);
      await execFileP(
        'pdftoppm',
        [
          '-singlefile',
          '-png',
          '-x',
          '0',
          '-y',
          '0',
          '-W',
          '256',
          '-H',
          '256',
          '-scale-to',
          '256',
          join(process.env.BASE_UPLOAD_PATH!, worker.workerData.file),
          `/tmp/${worker.workerData.file}`,
        ],
        15000,
      );
      restartTimeout(null);
      await execFileP(
        'ffmpeg',
        [
          '-i',
          join('/tmp', `${worker.workerData.file}.png`),
          '-vf',
          'scale=256:256:force_original_aspect_ratio=1,format=rgba,pad=256:256:(ow-iw)/2:(oh-ih)/2:color=#00000000',
          '-vframes',
          '1',
          outputPath,
        ],
        15000,
      );
      await unlink(join('/tmp', `${worker.workerData.file}.png`));
      worker.parentPort!.postMessage(200);
      process.exit(0);
    } else if (a!.mime.startsWith('font')) {
      const browser = await puppeteer.launch(),
        page = await browser.newPage();
      page.setViewport({ width: 256, height: 256 });
      restartTimeout(browser);
      await page.goto(
        `file://${join(process.cwd(), 'font-renderer.html')}?font=${
          worker.workerData.file
        }`,
        {
          waitUntil: 'load',
        },
      );
      restartTimeout(browser);
      await page.screenshot({
        path: outputPath,
      });
      worker.parentPort!.postMessage(200);
      process.exit(0);
    } else if (
      await hasAudioStream(
        join(process.env.BASE_UPLOAD_PATH!, worker.workerData.file),
      )
    ) {
      restartTimeout(null);
      await execFileP(
        'ffmpeg',
        [
          '-i',
          join(process.env.BASE_UPLOAD_PATH!, worker.workerData.file),
          '-filter_complex',
          'showwavespic=256x256',
          '-frames:v',
          '1',
          outputPath,
        ],
        15000,
      );
      worker.parentPort!.postMessage(200);
      process.exit(0);
    } else {
      worker.parentPort!.postMessage(415);
      process.exit(0);
    }
  } catch (e) {
    worker.parentPort!.postMessage(500);
    console.error(e);
    process.exit(0);
  }
})();
