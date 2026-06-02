# Video to Text

영상 파일에서 음성만 뽑아 오디오 파일로 만들고, 그 오디오를 텍스트 파일로 변환하는 스크립트입니다.

동영상 파일을 다운로드해야 한다면 Chrome 확장 프로그램인 [Video DownloadHelper](https://chromewebstore.google.com/detail/video-downloadhelper/lmjnegcaeklhafolokijcfjliaokphfk)를 추천합니다.

사용량을 다 썼다고 나오면 확장 프로그램을 지웠다가 다시 설치하면 됩니다.

예를 들어 `inha/video` 폴더에 영상을 넣고 실행하면:

```text
inha/video/강의.mp4
  -> inha/audio/강의.mp3
  -> inha/text/강의.txt
```

## 준비물

처음 한 번만 설치하면 됩니다.

### 1. Node.js 설치

Node.js가 필요합니다.

이미 설치되어 있는지 확인:

```bash
node -v
```

버전이 나오면 설치되어 있는 것입니다.

설치가 안 되어 있으면 아래 사이트에서 LTS 버전을 설치하세요.

https://nodejs.org

### 2. pnpm 설치

이 프로젝트는 `pnpm`으로 실행합니다.

설치되어 있는지 확인:

```bash
pnpm -v
```

설치가 안 되어 있으면:

```bash
npm install -g pnpm
```

### 3. ffmpeg 설치

영상에서 오디오를 뽑기 위해 `ffmpeg`가 필요합니다.

설치되어 있는지 확인:

```bash
ffmpeg -version
```

Mac에서 설치:

```bash
brew install ffmpeg
```

Windows는 아래 사이트에서 설치할 수 있습니다.

https://ffmpeg.org/download.html

### 4. OpenAI API Key 준비

오디오를 텍스트로 바꾸기 위해 OpenAI API Key가 필요합니다.

프로젝트 폴더에 `.env` 파일을 만들고 아래처럼 적습니다.

```text
OPENAI_API_KEY=여기에_본인_API_KEY_붙여넣기
```

예:

```text
OPENAI_API_KEY=sk-...
```

주의: `.env` 파일은 GitHub에 올리면 안 됩니다.

## 설치 방법

GitHub에서 프로젝트를 받은 뒤, 프로젝트 폴더 안에서 아래 명령어를 실행합니다.

```bash
pnpm install
```

이 명령어는 필요한 프로그램 패키지를 설치합니다.

## 폴더 구조

작업할 폴더를 하나 만들고, 그 안에 `video` 폴더를 만듭니다.

예를 들어 `inha`라는 작업 폴더를 쓴다면:

```text
inha/
  video/
    강의1.mp4
    강의2.mp4
```

실행 후에는 자동으로 아래처럼 만들어집니다.

```text
inha/
  video/
    강의1.mp4
    강의2.mp4
  audio/
    강의1.mp3
    강의2.mp3
  text/
    강의1.txt
    강의2.txt
```

## 실행 방법

프로젝트 폴더에서 실행합니다.

```bash
pnpm run start inha
```

또는 이렇게 써도 됩니다.

```bash
pnpm run start /inha
```

이 프로젝트에서는 `/inha`도 현재 프로젝트 안의 `inha` 폴더로 처리합니다.

## 경로를 안 넣었을 때

아래처럼 실행하면:

```bash
pnpm run start
```

작업할 폴더 경로를 입력하라는 안내 메시지가 나옵니다.

```text
작업할 폴더 경로를 입력해주세요.

예:
  pnpm run start /inha
  pnpm run start inha
```

## 지원하는 파일 형식

영상 파일:

```text
.mp4, .mov, .m4v, .mkv, .avi, .webm
```

오디오 파일:

```text
.mp3, .m4a, .wav, .aac, .flac, .ogg
```

## 이미 만든 파일은 건너뜁니다

이미 `audio` 폴더에 같은 이름의 `.mp3` 파일이 있으면 다시 만들지 않습니다.

이미 `text` 폴더에 같은 이름의 `.txt` 파일이 있으면 다시 텍스트 추출을 하지 않습니다.

예:

```text
inha/video/강의.mp4
inha/audio/강의.mp3
inha/text/강의.txt
```

이 상태에서 다시 실행하면 `강의.mp3`, `강의.txt`는 건너뜁니다.

## 오디오만 있어도 됩니다

영상 파일 없이 이미 오디오 파일만 있는 경우에도 사용할 수 있습니다.

```text
inha/
  audio/
    강의.mp3
```

실행:

```bash
pnpm run start inha
```

결과:

```text
inha/
  audio/
    강의.mp3
  text/
    강의.txt
```

## 자주 나는 오류

### OPENAI_API_KEY 환경변수가 없습니다.

`.env` 파일이 없거나, `.env` 안에 API Key가 없다는 뜻입니다.

프로젝트 폴더에 `.env` 파일을 만들고 아래처럼 넣어주세요.

```text
OPENAI_API_KEY=sk-...
```

### ffmpeg exited with code ...

`ffmpeg` 설치가 안 되어 있거나, 영상 파일을 읽지 못한 경우입니다.

먼저 확인:

```bash
ffmpeg -version
```

버전이 나오지 않으면 `ffmpeg`를 설치해야 합니다.

### video 또는 audio 폴더가 필요합니다.

입력한 작업 폴더 안에 `video` 폴더도 없고 `audio` 폴더도 없다는 뜻입니다.

예:

```text
inha/
  video/
```

또는:

```text
inha/
  audio/
```

둘 중 하나는 있어야 합니다.

## 전체 사용 예시

처음 한 번:

```bash
pnpm install
```

작업 폴더 만들기:

```text
inha/
  video/
    sample.mp4
```

실행:

```bash
pnpm run start inha
```

결과 확인:

```text
inha/
  audio/
    sample.mp3
  text/
    sample.txt
```
