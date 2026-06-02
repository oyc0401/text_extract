import { readdirSync, mkdirSync, existsSync } from "fs";
import { join, basename, extname } from "path";
import { spawn } from "child_process";

// 실행:
// pnpm convert
// npx tsx src/convert-to-mp3.ts

const ROOT = new URL("..", import.meta.url).pathname;
const VIDEOS_DIR = join(ROOT, "videos");
const AUDIO_DIR = join(ROOT, "audio");

if (!existsSync(AUDIO_DIR)) {
  mkdirSync(AUDIO_DIR, { recursive: true });
}

const mp4Files = readdirSync(VIDEOS_DIR).filter(
  (f) => extname(f).toLowerCase() === ".mp4"
);

if (mp4Files.length === 0) {
  console.log("변환할 MP4 파일이 없습니다.");
  process.exit(0);
}

console.log(`총 ${mp4Files.length}개 파일 변환 시작\n`);

function convertToMp3(inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-i", inputPath,
      "-vn",               // 영상 트랙 제거
      "-c:a", "libmp3lame",
      "-q:a", "0",         // VBR 최상급 품질 (0 = best)
      "-y",                // 덮어쓰기 허용
      outputPath,
    ]);

    ffmpeg.stderr.on("data", () => {}); // ffmpeg 진행 로그 무시

    ffmpeg.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}`));
    });

    ffmpeg.on("error", reject);
  });
}

for (let i = 0; i < mp4Files.length; i++) {
  const file = mp4Files[i];
  const inputPath = join(VIDEOS_DIR, file);
  const outputName = basename(file, extname(file)) + ".mp3";
  const outputPath = join(AUDIO_DIR, outputName);

  if (existsSync(outputPath)) {
    console.log(`[${i + 1}/${mp4Files.length}] ${file} ... 건너뜀 (이미 존재)`);
    continue;
  }

  process.stdout.write(`[${i + 1}/${mp4Files.length}] ${file} ... `);

  try {
    await convertToMp3(inputPath, outputPath);
    console.log("완료");
  } catch (err) {
    console.log("실패");
    console.error(`  오류: ${(err as Error).message}`);
  }
}

console.log("\n모든 변환 완료!");
