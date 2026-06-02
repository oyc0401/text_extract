import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "path";
import { spawn } from "child_process";
import { tmpdir } from "os";
import OpenAI from "openai";

const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".m4v",
  ".mkv",
  ".avi",
  ".webm",
  ".ts",
]);
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
  console.log("  {입력경로}/video/...영상파일");
  console.log("  {입력경로}/audio/...mp3");
  console.log("  {입력경로}/text/...txt");
}

function resolveProjectPath(input: string): string {
  if (existsSync(input)) return resolve(input);

  if (isAbsolute(input)) {
    const projectRelative = resolve(process.cwd(), input.replace(/^\/+/, ""));
    if (existsSync(projectRelative)) return projectRelative;
  }

  return resolve(process.cwd(), input);
}

type MediaFile = {
  inputPath: string;
  relativePath: string;
};

type WorkspacePaths = {
  projectRoot: string;
  videoRoot: string;
  videoInputRoot: string;
  audioDir: string;
  textDir: string;
};

function listFilesRecursive(rootDir: string, extensions: Set<string>): MediaFile[] {
  if (!existsSync(rootDir)) return [];

  const results: MediaFile[] = [];
  const entries = readdirSync(rootDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name === ".DS_Store") continue;

    const entryPath = join(rootDir, entry.name);

    if (entry.isDirectory()) {
      results.push(...listFilesRecursive(entryPath, extensions));
      continue;
    }

    if (!entry.isFile()) continue;
    if (!extensions.has(extname(entry.name).toLowerCase())) continue;

    results.push({
      inputPath: entryPath,
      relativePath: relative(rootDir, entryPath),
    });
  }

  return results.sort((a, b) => a.relativePath.localeCompare(b.relativePath, "ko"));
}

function replaceExtension(filePath: string, nextExtension: string): string {
  return join(
    dirname(filePath),
    `${basename(filePath, extname(filePath))}${nextExtension}`
  );
}

function formatDisplayPath(filePath: string): string {
  const relativePath = relative(process.cwd(), filePath);

  if (!relativePath.startsWith("..") && !isAbsolute(relativePath)) {
    return relativePath;
  }

  return filePath;
}

function deriveWorkspacePaths(inputRoot: string): WorkspacePaths {
  let current = inputRoot;

  while (true) {
    if (basename(current).toLowerCase() === "video") {
      const projectRoot = dirname(current);

      return {
        projectRoot,
        videoRoot: current,
        videoInputRoot: inputRoot,
        audioDir: join(projectRoot, "audio"),
        textDir: join(projectRoot, "text"),
      };
    }

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const videoDir = join(inputRoot, "video");

  return {
    projectRoot: inputRoot,
    videoRoot: existsSync(videoDir) ? videoDir : inputRoot,
    videoInputRoot: existsSync(videoDir) ? videoDir : inputRoot,
    audioDir: join(inputRoot, "audio"),
    textDir: join(inputRoot, "text"),
  };
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

async function convertVideos(
  videoRoot: string,
  videoInputRoot: string,
  outputRoot: string
): Promise<void> {
  const videoFiles = listFilesRecursive(videoInputRoot, VIDEO_EXTENSIONS);

  if (videoFiles.length === 0) {
    console.log("변환할 영상 파일이 없습니다.");
    return;
  }

  console.log(`영상 -> 오디오 변환: 총 ${videoFiles.length}개\n`);

  for (let i = 0; i < videoFiles.length; i++) {
    const file = videoFiles[i];
    const outputRelativePath = replaceExtension(
      relative(videoRoot, file.inputPath),
      ".mp3"
    );
    const outputPath = join(outputRoot, outputRelativePath);

    if (existsSync(outputPath)) {
      console.log(
        `[${i + 1}/${videoFiles.length}] ${file.relativePath} ... 건너뜀 (이미 존재: ${formatDisplayPath(outputPath)})`
      );
      continue;
    }

    mkdirSync(dirname(outputPath), { recursive: true });
    process.stdout.write(`[${i + 1}/${videoFiles.length}] ${file.relativePath} ... `);

    try {
      await convertToMp3(file.inputPath, outputPath);
      console.log(`완료 -> ${formatDisplayPath(outputPath)}`);
    } catch (err) {
      console.log("실패");
      console.error(`  오류: ${(err as Error).message}`);
    }
  }

  console.log("");
}

async function transcribeAudios(audioRoot: string, textRoot: string): Promise<void> {
  const audioFiles = listFilesRecursive(audioRoot, AUDIO_EXTENSIONS);

  if (audioFiles.length === 0) {
    console.log("텍스트로 변환할 오디오 파일이 없습니다.");
    return;
  }

  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY 환경변수가 없습니다.");
    process.exit(1);
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  console.log(`오디오 -> 텍스트 추출: 총 ${audioFiles.length}개\n`);

  for (let i = 0; i < audioFiles.length; i++) {
    const file = audioFiles[i];
    const outputRelativePath = replaceExtension(file.relativePath, ".txt");
    const outputPath = join(textRoot, outputRelativePath);

    mkdirSync(dirname(outputPath), { recursive: true });

    if (existsSync(outputPath)) {
      console.log(
        `[${i + 1}/${audioFiles.length}] ${file.relativePath} ... 건너뜀 (이미 존재: ${formatDisplayPath(outputPath)})`
      );
      continue;
    }

    process.stdout.write(`[${i + 1}/${audioFiles.length}] ${file.relativePath} ... `);

    try {
      const text = await transcribeFile(client, file.inputPath);
      writeFileSync(outputPath, text.trim() + "\n", "utf-8");
      console.log(`완료 -> ${formatDisplayPath(outputPath)}`);
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
const workspace = deriveWorkspacePaths(rootDir);

if (!existsSync(rootDir)) {
  console.error(`입력한 폴더를 찾을 수 없습니다: ${rootDir}`);
  process.exit(1);
}

const hasVideoFiles = listFilesRecursive(workspace.videoInputRoot, VIDEO_EXTENSIONS).length > 0;

if (!hasVideoFiles && !existsSync(workspace.audioDir)) {
  console.error("입력한 폴더 안에 영상 파일이 없고, 변환된 audio 폴더도 없습니다.");
  console.error(`확인한 경로: ${rootDir}`);
  process.exit(1);
}

console.log(`작업 폴더: ${workspace.projectRoot}`);
console.log(`영상 기준: ${formatDisplayPath(workspace.videoRoot)}`);
console.log(`영상 입력: ${formatDisplayPath(workspace.videoInputRoot)}`);
console.log(`오디오 출력: ${formatDisplayPath(workspace.audioDir)}`);
console.log(`텍스트 출력: ${formatDisplayPath(workspace.textDir)}`);
console.log("");

await convertVideos(workspace.videoRoot, workspace.videoInputRoot, workspace.audioDir);
await transcribeAudios(workspace.audioDir, workspace.textDir);

console.log("\n모든 작업 완료!");
