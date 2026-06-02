import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { basename, extname, isAbsolute, join, resolve } from "path";
import { spawn } from "child_process";
import { tmpdir } from "os";
import OpenAI from "openai";

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".mkv", ".avi", ".webm"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".m4a", ".wav", ".aac", ".flac", ".ogg"]);
const MAX_BYTES = 25 * 1024 * 1024;

function printUsage(): void {
  console.log("작업할 폴더 경로를 입력해주세요.");
  console.log("");
  console.log("예:");
  console.log("  pnpm run start /inha");
  console.log("  pnpm run start inha");
  console.log("");
  console.log("필요한 폴더 구조:");
  console.log("  {입력경로}/video  -> 원본 영상");
  console.log("  {입력경로}/audio  -> 변환된 오디오");
  console.log("  {입력경로}/text   -> 추출된 텍스트");
}

function resolveProjectPath(input: string): string {
  if (existsSync(input)) return resolve(input);

  if (isAbsolute(input)) {
    const projectRelative = resolve(process.cwd(), input.replace(/^\/+/, ""));
    if (existsSync(projectRelative)) return projectRelative;
  }

  return resolve(process.cwd(), input);
}

function listFiles(dir: string, extensions: Set<string>): string[] {
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((file) => extensions.has(extname(file).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, "ko"));
}

function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolveDone, reject) => {
    const proc = spawn(command, args);

    proc.stderr.on("data", () => {});
    proc.on("close", (code) => {
      if (code === 0) resolveDone();
      else reject(new Error(`${command} exited with code ${code}`));
    });
    proc.on("error", reject);
  });
}

function convertToMp3(inputPath: string, outputPath: string): Promise<void> {
  return runCommand("ffmpeg", [
    "-i",
    inputPath,
    "-vn",
    "-c:a",
    "libmp3lame",
    "-q:a",
    "0",
    "-y",
    outputPath,
  ]);
}

function getDuration(filePath: string): Promise<number> {
  return new Promise((resolveDone, reject) => {
    let out = "";
    const proc = spawn("ffprobe", [
      "-v",
      "quiet",
      "-print_format",
      "json",
      "-show_format",
      filePath,
    ]);

    proc.stdout.on("data", (data) => {
      out += data;
    });
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error("ffprobe failed"));

      const parsed = JSON.parse(out);
      const duration = Number.parseFloat(parsed.format?.duration);

      if (!Number.isFinite(duration)) {
        reject(new Error("오디오 길이를 확인할 수 없습니다."));
        return;
      }

      resolveDone(duration);
    });
    proc.on("error", reject);
  });
}

function splitSegment(
  inputPath: string,
  startSec: number,
  durationSec: number,
  outputPath: string
): Promise<void> {
  return runCommand("ffmpeg", [
    "-ss",
    String(startSec),
    "-t",
    String(durationSec),
    "-i",
    inputPath,
    "-c:a",
    "copy",
    "-y",
    outputPath,
  ]);
}

async function transcribeFile(client: OpenAI, inputPath: string): Promise<string> {
  const fileSize = statSync(inputPath).size;

  if (fileSize <= MAX_BYTES) {
    const response = await client.audio.transcriptions.create({
      file: createReadStream(inputPath),
      model: "whisper-1",
      language: "ko",
      response_format: "text",
    });

    return response as unknown as string;
  }

  const parts = Math.ceil(fileSize / MAX_BYTES);
  const duration = await getDuration(inputPath);
  const partDuration = duration / parts;
  const results: string[] = [];
  const tempFiles: string[] = [];

  process.stdout.write(`\n  -> ${parts}등분 분할 중 `);

  try {
    for (let part = 0; part < parts; part++) {
      const tempPath = join(tmpdir(), `transcribe_${process.pid}_${Date.now()}_${part}.mp3`);
      tempFiles.push(tempPath);

      await splitSegment(inputPath, part * partDuration, partDuration, tempPath);
      process.stdout.write(`[${part + 1}/${parts}] API전송중...`);

      const response = await client.audio.transcriptions.create({
        file: createReadStream(tempPath),
        model: "whisper-1",
        language: "ko",
        response_format: "text",
      });

      results.push((response as unknown as string).trim());
      process.stdout.write(" 완료 ");
    }
  } finally {
    for (const tempFile of tempFiles) {
      if (existsSync(tempFile)) unlinkSync(tempFile);
    }
  }

  return results.join("\n");
}

async function convertVideos(videoDir: string, audioDir: string): Promise<void> {
  const videoFiles = listFiles(videoDir, VIDEO_EXTENSIONS);

  if (videoFiles.length === 0) {
    console.log("video 폴더에 변환할 영상 파일이 없습니다.");
    return;
  }

  mkdirSync(audioDir, { recursive: true });
  console.log(`영상 -> 오디오 변환: 총 ${videoFiles.length}개\n`);

  for (let i = 0; i < videoFiles.length; i++) {
    const file = videoFiles[i];
    const inputPath = join(videoDir, file);
    const outputPath = join(audioDir, `${basename(file, extname(file))}.mp3`);

    if (existsSync(outputPath)) {
      console.log(`[${i + 1}/${videoFiles.length}] ${file} ... 건너뜀 (이미 존재)`);
      continue;
    }

    process.stdout.write(`[${i + 1}/${videoFiles.length}] ${file} ... `);

    try {
      await convertToMp3(inputPath, outputPath);
      console.log("완료");
    } catch (err) {
      console.log("실패");
      console.error(`  오류: ${(err as Error).message}`);
    }
  }

  console.log("");
}

async function transcribeAudios(audioDir: string, textDir: string): Promise<void> {
  const audioFiles = listFiles(audioDir, AUDIO_EXTENSIONS);

  if (audioFiles.length === 0) {
    console.log("audio 폴더에 텍스트로 변환할 오디오 파일이 없습니다.");
    return;
  }

  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY 환경변수가 없습니다.");
    process.exit(1);
  }

  mkdirSync(textDir, { recursive: true });

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  console.log(`오디오 -> 텍스트 추출: 총 ${audioFiles.length}개\n`);

  for (let i = 0; i < audioFiles.length; i++) {
    const file = audioFiles[i];
    const inputPath = join(audioDir, file);
    const outputPath = join(textDir, `${basename(file, extname(file))}.txt`);

    if (existsSync(outputPath)) {
      console.log(`[${i + 1}/${audioFiles.length}] ${file} ... 건너뜀 (이미 존재)`);
      continue;
    }

    process.stdout.write(`[${i + 1}/${audioFiles.length}] ${file} ... `);

    try {
      const text = await transcribeFile(client, inputPath);
      writeFileSync(outputPath, text.trim() + "\n", "utf-8");
      console.log("완료");
    } catch (err) {
      console.log("실패");
      console.error(`  오류: ${(err as Error).message}`);
    }
  }
}

const inputPath = process.argv[2];

if (!inputPath) {
  printUsage();
  process.exit(1);
}

const rootDir = resolveProjectPath(inputPath);
const videoDir = join(rootDir, "video");
const audioDir = join(rootDir, "audio");
const textDir = join(rootDir, "text");

if (!existsSync(rootDir)) {
  console.error(`입력한 폴더를 찾을 수 없습니다: ${rootDir}`);
  process.exit(1);
}

if (!existsSync(videoDir) && !existsSync(audioDir)) {
  console.error("video 또는 audio 폴더가 필요합니다.");
  console.error(`확인한 경로: ${rootDir}`);
  process.exit(1);
}

console.log(`작업 폴더: ${rootDir}`);
console.log("");

await convertVideos(videoDir, audioDir);
await transcribeAudios(audioDir, textDir);

console.log("\n모든 작업 완료!");
