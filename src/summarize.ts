import {
  readdirSync,
  mkdirSync,
  existsSync,
  writeFileSync,
  createReadStream,
  statSync,
} from "fs";
import { join, basename, extname } from "path";
import OpenAI from "openai";

// 실행:
// pnpm summarize
// 또는
// npx tsx src/summarize.ts

const ROOT = new URL("..", import.meta.url).pathname;
const TRANSCRIPTS_DIR = join(ROOT, "transcripts");
const SUMMARIES_DIR = join(ROOT, "summaries");

const MODEL = "gpt-5.5";

if (!process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY 환경변수가 없습니다.");
  process.exit(1);
}

if (!existsSync(TRANSCRIPTS_DIR)) {
  console.error(`transcripts 폴더가 없습니다: ${TRANSCRIPTS_DIR}`);
  process.exit(1);
}

if (!existsSync(SUMMARIES_DIR)) {
  mkdirSync(SUMMARIES_DIR, { recursive: true });
}

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const txtFiles = readdirSync(TRANSCRIPTS_DIR)
  .filter((file) => extname(file).toLowerCase() === ".txt")
  .sort();

if (txtFiles.length === 0) {
  console.log("요약할 TXT 파일이 없습니다.");
  process.exit(0);
}

console.log(`총 ${txtFiles.length}개 파일 요약 시작\n`);

for (let i = 0; i < txtFiles.length; i++) {
  const file = txtFiles[i];

  const inputPath = join(TRANSCRIPTS_DIR, file);
  const outputName = basename(file, extname(file)) + ".md";
  const outputPath = join(SUMMARIES_DIR, outputName);

  if (existsSync(outputPath)) {
    console.log(`[${i + 1}/${txtFiles.length}] ${file} ... 건너뜀 (이미 존재)`);
    continue;
  }

  const fileSize = statSync(inputPath).size;
  const fileSizeKB = (fileSize / 1024).toFixed(1);

  process.stdout.write(
    `[${i + 1}/${txtFiles.length}] ${file} (${fileSizeKB}KB) ... `
  );

  try {
    const uploadedFile = await client.files.create({
      file: createReadStream(inputPath),
      purpose: "user_data",
    });

    const response = await client.responses.create({
      model: MODEL,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: [
                "당신은 발표문과 강의 스크립트를 자연스러운 에세이로 변환하는 전문 에디터입니다.",
                "단순 요약이 아니라, 발표자가 자신의 생각을 글로 정리한 것처럼 1인칭 에세이로 재구성합니다.",
                "발표문의 문제의식, 주장, 논리 전개, 감정선, 핵심 메시지는 최대한 보존합니다.",
                "다만 발표문 특유의 반복, 말실수, 군더더기, 어색한 구어체는 자연스러운 문어체로 정리합니다.",
                "출력은 반드시 한국어 마크다운으로 작성합니다.",
                "문체는 발표자가 독자에게 직접 이야기하듯이 자연스럽고 설득력 있게 작성합니다.",
                "원문에 없는 새로운 주장, 사례, 정보는 과도하게 추가하지 않습니다.",
              ].join("\n")
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "input_file",
              file_id: uploadedFile.id,
            },
            {
              type: "input_text",
              text: [
                "첨부한 TXT 파일은 발표문 또는 강의 스크립트입니다.",
                "",
                "이 발표문을 바탕으로, 발표자가 직접 작성한 에세이처럼 자연스럽게 변환해주세요.",
                "",
                "## 핵심 목표",
                "- 요약이 아니라 발표문을 에세이로 변환",
                "- 발표자가 자신의 생각을 글로 정리한 듯한 1인칭 에세이로 작성",
                "- 제3자가 분석하거나 요약하는 문체가 아니라, 발표자가 직접 말하는 문체 사용",
                "- 예: '이 발표문은 ~을 말한다'가 아니라 '저는 이 글에서 ~을 말하고 싶습니다'처럼 작성",
                "- 발표문의 주장, 문제의식, 논리 흐름, 감정선, 결론은 원문에 충실하게 유지",
                "- 구어체 발표문을 자연스러운 문어체 에세이로 다듬기",
                "",
                "## 작성 조건",
                "- 반드시 한국어 마크다운 형식으로 작성",
                "- bullet point 중심 정리 금지",
                "- 문단 중심의 에세이 형식으로 작성",
                "- 소제목을 적절히 사용",
                "- 발표자가 독자에게 직접 설명하는 듯한 자연스러운 흐름으로 작성",
                "- 원문의 핵심 표현과 관점을 최대한 살릴 것",
                "- 원문에 없는 새로운 주장이나 사례를 과도하게 지어내지 말 것",
                "- 다만 이해를 돕기 위한 자연스러운 연결 문장과 해석은 추가 가능",
                "- 반복되는 말, 말실수, 어색한 구어체 중복은 정리할 것",
                "- 발표 상황에서만 필요한 표현은 글의 흐름에 맞게 자연스럽게 바꿀 것",
                "",
                "## 문체 지침",
                "- 1인칭 화자 사용: '저는', '제가', '우리는', '여러분은'",
                "- 발표자가 직접 독자에게 말하는 듯한 친근한 문체",
                "- 너무 딱딱한 논문체 금지",
                "- 너무 짧은 요약문 금지",
                "- 발표문의 감정선과 설득 흐름을 살릴 것",
                "- '이 발표문에서는', '발표자는', '핵심은'처럼 제3자가 분석하는 표현을 최소화할 것",
                "- 발표자가 직접 자신의 생각을 정리하는 글처럼 작성할 것",
                "",
                "## 출력 구조 예시",
                "# 발표 내용을 반영한 자연스러운 제목",
                "",
                "## 문제의식",
                "## 제가 이 이야기를 꺼내는 이유",
                "## 핵심 주장과 논리의 흐름",
                "## 우리가 놓치기 쉬운 관점",
                "## 이 내용을 어떻게 이해해야 하는가",
                "## 마무리하며",
                "",
                "위 구조는 예시입니다.",
                "실제 제목과 소제목은 발표문 내용에 맞게 자연스럽게 바꿔도 됩니다.",
                "",
                "## 중요한 금지 사항",
                "- 제3자 요약문처럼 쓰지 말 것",
                "- 보고서처럼 쓰지 말 것",
                "- 항목 나열식 정리로 끝내지 말 것",
                "- 원문과 반대되는 해석을 추가하지 말 것",
                "- 원문에 없는 외부 지식이나 사례를 중심 내용처럼 추가하지 말 것",
              ].join("\n")
            },
          ],
        },
      ],
    });

    const summary = response.output_text.trim();

    if (!summary) {
      throw new Error("모델 응답이 비어 있습니다.");
    }

    writeFileSync(outputPath, summary + "\n", "utf-8");

    console.log("완료");
  } catch (err) {
    console.log("실패");

    if (err instanceof Error) {
      console.error(`  오류: ${err.message}`);
    } else {
      console.error("  알 수 없는 오류:", err);
    }
  }
}

console.log("\n모든 요약 완료!");