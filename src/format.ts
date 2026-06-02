import {
  readdirSync,
  mkdirSync,
  existsSync,
  writeFileSync,
  readFileSync,
} from "fs";
import { join, basename, extname } from "path";
import OpenAI from "openai";

// 실행:
// pnpm format
// 또는
// npx tsx --env-file=.env src/format.ts

const ROOT = new URL("..", import.meta.url).pathname;
const TRANSCRIPTS_DIR = join(ROOT, "transcripts");
const FORMATTED_DIR = join(ROOT, "formatted");

const MODEL = "gpt-5.4-mini";

const FORMAT_PROMPT = `
너는 한국어 강의 스크립트 교정/포맷팅 전문가다.

사용자가 제공하는 원문은 음성 인식으로 추출된 강의 스크립트다.
너의 임무는 원문의 의미와 내용을 절대 요약하거나 생략하지 않고, 읽기 좋은 마크다운 문서 형태로 정리하는 것이다.

반드시 지켜야 할 규칙:

1. 원문 내용 보존
- 원문 문장을 요약하지 마라.
- 원문 문장을 삭제하지 마라.
- 새로운 내용을 추가하지 마라.
- 강사의 말투, 어조, 흐름은 최대한 유지하라.
- 문맥상 명백한 음성 인식 오류만 자연스럽게 교정하라.
  예: 고지곳대로 → 곧이곧대로
  예: 복귀 → 복기
  예: 과수평가 → 과소평가
  예: 의뢰 위치 → 열위 위치
  예: 소외팅 → 소개팅
  예: 히로애락 → 희로애락
  예: 송착취 → 성착취
  예: 아니 말 → 아니마
  예: 아니무수 → 아니무스

2. 맞춤법/띄어쓰기/문장부호 교정
- 맞춤법, 띄어쓰기, 문장부호를 자연스럽게 고쳐라.
- 쉼표와 마침표를 적절히 추가하라.
- 질문형 문장은 물음표를 사용하라.
- 직접 발화나 예시는 큰따옴표를 사용해 자연스럽게 정리하라.
- 숫자와 단위는 한국어 문서에서 자연스럽게 읽히도록 정리하라.
  예: 2000만원 → 2,000만 원
  예: 20대초반 → 20대 초반

3. 줄바꿈 규칙
- 문장부호가 있다고 무조건 줄바꿈하지 마라.
- 문맥 단위로 자연스럽게 줄바꿈하라.
- 너무 긴 문단은 읽기 좋게 나누되, 문장을 삭제하거나 요약하지 마라.
- 한 문장마다 무조건 줄바꿈하지 말고, 강의 흐름에 맞게 적절히 문단을 구성하라.
- 짧은 강조 문장이나 질문은 단독 문단으로 분리해도 된다.

4. 제목/부제 규칙
- 문서 맨 위에는 제목이나 부제를 새로 추가하지 마라.
- 원문 첫 문장부터 바로 시작하라.
- 원문 맨 위에 제목처럼 보이는 ###, ##, # 문장이 있어도 제거하고 본문 첫 문장부터 시작하라.
- 단, 본문 중간에는 내용 전환이 분명한 지점에만 ## 부제를 추가할 수 있다.
- 원문에 이미 있는 ### 또는 ## 부제가 어색하면 더 자연스럽게 바꿔도 된다.
- 중간 부제는 내용을 요약하는 짧고 자연스러운 문장으로 작성하라.
- 부제를 너무 자주 넣지 마라.

5. 출력 형식
- 절대로 마크다운 코드블록 안에 넣지 마라.
- 설명, 요약, 코멘트 없이 교정된 본문만 출력하라.
- “아래는 정리한 버전입니다” 같은 안내 문구도 쓰지 마라.
- 최종 출력은 바로 .md 파일로 저장 가능한 마크다운 본문이어야 한다.

6. 주의
- 민감하거나 거친 표현이 있어도 원문에 있는 표현이면 임의로 순화하거나 삭제하지 마라.
- 다만 오타, 음성 인식 오류, 띄어쓰기 오류는 고쳐라.
- 원문의 논조나 주장 자체를 검열하거나 수정하지 마라.
- 원문에 없는 결론, 요약, 평가를 추가하지 마라.
`.trim();

if (!process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY가 설정되어 있지 않습니다.");
  process.exit(1);
}

if (!existsSync(TRANSCRIPTS_DIR)) {
  console.error(`transcripts 폴더가 없습니다: ${TRANSCRIPTS_DIR}`);
  process.exit(1);
}

if (!existsSync(FORMATTED_DIR)) {
  mkdirSync(FORMATTED_DIR, { recursive: true });
}

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const txtFiles = readdirSync(TRANSCRIPTS_DIR)
  .filter((f) => extname(f).toLowerCase() === ".txt")
  .sort((a, b) => a.localeCompare(b, "ko"));

if (txtFiles.length === 0) {
  console.log("처리할 TXT 파일이 없습니다.");
  process.exit(0);
}

console.log(`총 ${txtFiles.length}개 파일 포맷 시작\n`);

for (let i = 0; i < txtFiles.length; i++) {
  const file = txtFiles[i];
  const inputPath = join(TRANSCRIPTS_DIR, file);
  const outputName = basename(file, extname(file)) + ".md";
  const outputPath = join(FORMATTED_DIR, outputName);

  if (existsSync(outputPath)) {
    console.log(`[${i + 1}/${txtFiles.length}] ${file} ... 건너뜀 (이미 존재)`);
    continue;
  }

  process.stdout.write(`[${i + 1}/${txtFiles.length}] ${file} ... `);

  const transcript = readFileSync(inputPath, "utf-8").trim();

  if (!transcript) {
    writeFileSync(outputPath, "", "utf-8");
    console.log("완료 (빈 파일)");
    continue;
  }

  try {
    const response = await client.chat.completions.create({
      model: MODEL,
      messages: [
        {
          role: "developer",
          content: FORMAT_PROMPT,
        },
        {
          role: "user",
          content: transcript,
        },
      ],
    });

    const formatted = response.choices[0]?.message?.content?.trim() ?? "";

    if (!formatted) {
      throw new Error("모델 응답이 비어 있습니다.");
    }

    writeFileSync(outputPath, formatted + "\n", "utf-8");
    console.log("완료");
  } catch (err) {
    console.log("실패");
    console.error(`  파일: ${file}`);
    console.error(`  오류: ${(err as Error).message}`);
  }
}

console.log("\n모든 포맷 완료!");