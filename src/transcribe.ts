import { readdirSync, mkdirSync, existsSync, writeFileSync, statSync, createReadStream, unlinkSync } from "fs";
import { join, basename, extname } from "path";
import { spawn } from "child_process";
import { tmpdir } from "os";
import OpenAI from "openai";

// 실행:
// pnpm transcribe
// npx tsx src/transcribe.ts

const ROOT = new URL("..", import.meta.url).pathname;
const AUDIO_DIR = join(ROOT, "audio");
const TRANSCRIPTS_DIR = join(ROOT, "transcripts");
const MAX_BYTES = 25 * 1024 * 1024;

if (!existsSync(TRANSCRIPTS_DIR)) {
  mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
}

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function getDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    let out = "";
    const proc = spawn("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_format", filePath]);
    proc.stdout.on("data", (d) => (out += d));
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error("ffprobe failed"));
      resolve(parseFloat(JSON.parse(out).format.duration));
    });
    proc.on("error", reject);
  });
}

function splitSegment(inputPath: string, startSec: number, durationSec: number, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", ["-ss", String(startSec), "-t", String(durationSec), "-i", inputPath, "-c:a", "copy", "-y", outputPath]);
    proc.stderr.on("data", () => {});
    proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
    proc.on("error", reject);
  });
}

async function transcribeFile(inputPath: string): Promise<string> {
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

  process.stdout.write(`\n  → ${parts}등분 분할 중 `);

  for (let p = 0; p < parts; p++) {
    const tempPath = join(tmpdir(), `whisper_part_${Date.now()}_${p}.mp3`);
    tempFiles.push(tempPath);

    await splitSegment(inputPath, p * partDuration, partDuration, tempPath);
    process.stdout.write(`[${p + 1}/${parts}] 분할완료 → API전송중...`);

    const response = await client.audio.transcriptions.create({
      file: createReadStream(tempPath),
      model: "whisper-1",
      language: "ko",
      response_format: "text",
    });
    process.stdout.write(` 완료 `);
    results.push((response as unknown as string).trim());
  }

  for (const f of tempFiles) unlinkSync(f);

  return results.join("\n");
}

const mp3Files = readdirSync(AUDIO_DIR).filter(
  (f) => extname(f).toLowerCase() === ".mp3"
);

if (mp3Files.length === 0) {
  console.log("변환할 MP3 파일이 없습니다.");
  process.exit(0);
}

console.log(`총 ${mp3Files.length}개 파일 변환 시작\n`);

for (let i = 0; i < mp3Files.length; i++) {
  const file = mp3Files[i];
  const inputPath = join(AUDIO_DIR, file);
  const outputName = basename(file, extname(file)) + ".txt";
  const outputPath = join(TRANSCRIPTS_DIR, outputName);

  if (existsSync(outputPath)) {
    console.log(`[${i + 1}/${mp3Files.length}] ${file} ... 건너뜀 (이미 존재)`);
    continue;
  }

  process.stdout.write(`[${i + 1}/${mp3Files.length}] ${file} ... `);

  try {
    const text = await transcribeFile(inputPath);
    writeFileSync(outputPath, text, "utf-8");
    console.log("완료");
  } catch (err) {
    console.log("실패");
    console.error(`  오류: ${(err as Error).message}`);
  }
}

console.log("\n모든 변환 완료!");
