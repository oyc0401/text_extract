(async () => {
  /******************************************************************
   * 과제/허가된 테스트 스트림 전용 HLS 다운로더
   *
   * 지원:
   * - 비암호화 HLS VOD
   * - 표준 HLS AES-128, KEYFORMAT identity
   * - MPEG-TS segment 병합 후 .ts 저장
   *
   * 미지원:
   * - DRM
   * - SAMPLE-AES
   * - FairPlay/Widevine/PlayReady
   * - 쿠키/인증 우회
   * - CORS 우회
   *
   * 사용법:
   * 1. 페이지에서 영상 재생
   * 2. 콘솔에 붙여넣기
   ******************************************************************/

  const Mode = {
    Video: "video",
    Audio: "audio",
    All: "all",
  };

  const mode = Mode.Audio;
  const getSafeFilenameFromPageTitle = () => {
    const fallback = "hls-assignment-download";
    const rawTitle = document.title || fallback;
    const title = rawTitle.split(/\s+from\s+/i)[0] || fallback;
    const safeTitle = title
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[\\/:*?"<>|]/g, "")
      .replace(/\.+$/g, "")
      .trim();

    return safeTitle || fallback;
  };

  const OUTPUT_BASENAME = getSafeFilenameFromPageTitle();

  const decodeEscapedUrlText = (url) => {
    return url
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
        String.fromCharCode(parseInt(hex, 16))
      )
      .replace(/\\\//g, "/");
  };

  const normalizeUrl = (url) => {
    return new URL(decodeEscapedUrlText(url), location.href).href;
  };

  const toAbs = (url, base = location.href) => {
    try {
      return new URL(decodeEscapedUrlText(url), base).href;
    } catch {
      return null;
    }
  };

  const findM3U8Candidates = () => {
    const found = new Set();

    // 1. 이미 로드된 리소스에서 찾기
    for (const entry of performance.getEntriesByType("resource")) {
      if (/\.m3u8(\?|#|$)/i.test(entry.name)) {
        found.add(entry.name);
      }
    }

    // 2. video/source 태그에서 찾기
    document.querySelectorAll("video[src], source[src]").forEach((el) => {
      const url = toAbs(el.getAttribute("src"));

      if (url && /\.m3u8(\?|#|$)/i.test(url)) {
        found.add(url);
      }
    });

    // 3. inline script 문자열에서 찾기
    const regex =
      /(?:(?:https?:)?\/\/[^\s"'<>]+|\/[^\s"'<>]+|\.{1,2}\/[^\s"'<>]+|[A-Za-z0-9._~!$&'()*+,;=:@/-]+)\.m3u8(?:\?[^\s"'<>]*)?/gi;

    for (const script of document.scripts) {
      for (const match of (script.textContent || "").matchAll(regex)) {
        const url = toAbs(match[0]);

        if (url) {
          found.add(url);
        }
      }
    }

    return [...found];
  };

  const fetchText = async (url) => {
    const safeUrl = normalizeUrl(url);

    const res = await fetch(safeUrl);

    if (!res.ok) {
      throw new Error(`fetch 실패: ${res.status} ${res.statusText} ${safeUrl}`);
    }

    return await res.text();
  };

  const fetchBytes = async (url) => {
    const safeUrl = normalizeUrl(url);

    const res = await fetch(safeUrl);

    if (!res.ok) {
      throw new Error(`fetch 실패: ${res.status} ${res.statusText} ${safeUrl}`);
    }

    return new Uint8Array(await res.arrayBuffer());
  };

  const parseAttrList = (text) => {
    const attrs = {};
    const regex = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi;

    for (const match of text.matchAll(regex)) {
      const key = match[1];
      let value = match[2];

      if (value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
      }

      attrs[key] = value;
    }

    return attrs;
  };

  const hexToBytes = (hex) => {
    const clean = hex.replace(/^0x/i, "");

    if (clean.length !== 32) {
      throw new Error(`IV는 16바이트, 즉 32자리 hex여야 합니다: ${hex}`);
    }

    const out = new Uint8Array(16);

    for (let i = 0; i < 16; i++) {
      out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    }

    return out;
  };

  const sequenceToIv = (sequenceNumber) => {
    const iv = new Uint8Array(16);
    let n = BigInt(sequenceNumber);

    for (let i = 15; i >= 0; i--) {
      iv[i] = Number(n & 0xffn);
      n >>= 8n;
    }

    return iv;
  };

  const concatUint8Arrays = (chunks) => {
    const total = chunks.reduce((sum, arr) => sum + arr.byteLength, 0);
    const merged = new Uint8Array(total);

    let offset = 0;

    for (const arr of chunks) {
      merged.set(arr, offset);
      offset += arr.byteLength;
    }

    return merged;
  };

  const parseM3U8 = (text, baseUrl) => {
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines[0] !== "#EXTM3U") {
      throw new Error("유효한 m3u8이 아닙니다. 첫 줄이 #EXTM3U가 아닙니다.");
    }

    const isMaster = lines.some((line) => line.startsWith("#EXT-X-STREAM-INF"));

    const uris = lines
      .filter((line) => !line.startsWith("#"))
      .map((line) => toAbs(line, baseUrl))
      .filter(Boolean);

    let mediaSequence = 0;
    let segmentSequence = 0;
    let currentKey = null;
    let map = null;
    const audioRenditions = [];
    const segments = [];

    for (const line of lines) {
      if (line.startsWith("#EXT-X-MEDIA:")) {
        const attrs = parseAttrList(line.slice("#EXT-X-MEDIA:".length));

        if (attrs.TYPE === "AUDIO" && attrs.URI) {
          audioRenditions.push({
            uri: normalizeUrl(toAbs(attrs.URI, baseUrl)),
            groupId: attrs["GROUP-ID"] || "",
            name: attrs.NAME || "",
            isDefault: attrs.DEFAULT === "YES",
            autoselect: attrs.AUTOSELECT === "YES",
          });
        }

        continue;
      }

      if (line.startsWith("#EXT-X-MAP:")) {
        const attrs = parseAttrList(line.slice("#EXT-X-MAP:".length));

        if (!attrs.URI) {
          throw new Error("#EXT-X-MAP에 URI가 없습니다.");
        }

        map = {
          uri: normalizeUrl(toAbs(attrs.URI, baseUrl)),
        };

        continue;
      }

      if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
        mediaSequence = Number(line.split(":")[1]);
        segmentSequence = mediaSequence;
        continue;
      }

      if (line.startsWith("#EXT-X-KEY:")) {
        const attrs = parseAttrList(line.slice("#EXT-X-KEY:".length));
        const method = attrs.METHOD;

        if (method === "NONE") {
          currentKey = null;
          continue;
        }

        if (method !== "AES-128") {
          throw new Error(
            `지원하지 않는 암호화 METHOD입니다: ${method}. 이 스크립트는 AES-128만 지원합니다.`
          );
        }

        if (attrs.KEYFORMAT && attrs.KEYFORMAT !== "identity") {
          throw new Error(
            `지원하지 않는 KEYFORMAT입니다: ${attrs.KEYFORMAT}. identity만 지원합니다.`
          );
        }

        if (!attrs.URI) {
          throw new Error("#EXT-X-KEY에 URI가 없습니다.");
        }

        currentKey = {
          method,
          uri: normalizeUrl(toAbs(attrs.URI, baseUrl)),
          iv: attrs.IV ? hexToBytes(attrs.IV) : null,
        };

        continue;
      }

      if (!line.startsWith("#")) {
        const url = toAbs(line, baseUrl);

        if (url) {
          segments.push({
            url,
            sequence: segmentSequence,
            key: currentKey
              ? {
                  ...currentKey,
                  iv: currentKey.iv || sequenceToIv(segmentSequence),
                }
              : null,
          });

          segmentSequence++;
        }
      }
    }

    return {
      lines,
      isMaster,
      uris,
      map,
      audioRenditions,
      segments,
    };
  };

  const pickAudioRendition = (parsed) => {
    return (
      parsed.audioRenditions.find((item) => item.isDefault) ||
      parsed.audioRenditions.find((item) => item.autoselect) ||
      parsed.audioRenditions[0]
    );
  };

  const choosePlaylists = async (playlistUrl, playlistText) => {
    const fallbackType = /[?&]st=audio(?:&|$)/i.test(playlistUrl)
      ? "audio"
      : "video";
    const parsed = parseM3U8(playlistText, playlistUrl);

    if (!parsed.isMaster) {
      if (mode === Mode.Audio && fallbackType !== "audio") {
        throw new Error(
          "mode=Mode.Audio인데 선택된 m3u8이 master playlist도 audio playlist도 아닙니다. master playlist.m3u8에서 실행하세요."
        );
      }

      if (mode === Mode.All) {
        throw new Error(
          "mode=Mode.All은 master playlist가 필요합니다. playlist.m3u8에서 실행하세요."
        );
      }

      console.log(`${fallbackType} media playlist 감지됨:`, playlistUrl);
      return [{
        type: fallbackType,
        url: playlistUrl,
      }];
    }

    if (mode === Mode.Audio) {
      const audio = pickAudioRendition(parsed);

      if (!audio) {
        throw new Error("master playlist 안에서 audio playlist URI를 찾지 못했습니다.");
      }

      console.log("master playlist 감지됨. audio playlist 선택:", audio.uri);

      return [{
        type: "audio",
        url: audio.uri,
      }];
    }

    if (!parsed.uris.length) {
      throw new Error("master playlist 안에서 variant playlist URI를 찾지 못했습니다.");
    }

    // 과제용 단순 구현: 첫 번째 variant 선택
    // 더 고급 구현은 BANDWIDTH/RESOLUTION을 파싱해서 선택하면 됨.
    const variantUrl = parsed.uris[0];

    if (mode === Mode.All) {
      const audio = pickAudioRendition(parsed);

      if (!audio) {
        throw new Error("mode=Mode.All인데 master playlist 안에서 audio playlist URI를 찾지 못했습니다.");
      }

      console.log("master playlist 감지됨. video/audio playlist 선택:", variantUrl, audio.uri);

      return [
        {
          type: "video",
          url: normalizeUrl(variantUrl),
        },
        {
          type: "audio",
          url: audio.uri,
        },
      ];
    }

    console.log("master playlist 감지됨. video playlist 선택:", variantUrl);

    return [{
      type: "video",
      url: normalizeUrl(variantUrl),
    }];
  };

  const keyCache = new Map();

  const getCryptoKey = async (keyUri) => {
    if (keyCache.has(keyUri)) {
      return keyCache.get(keyUri);
    }

    const rawKey = await fetchBytes(keyUri);

    if (rawKey.byteLength !== 16) {
      throw new Error(
        `AES-128 key는 16바이트여야 합니다. 실제 크기: ${rawKey.byteLength} bytes`
      );
    }

    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      rawKey,
      { name: "AES-CBC" },
      false,
      ["decrypt"]
    );

    keyCache.set(keyUri, cryptoKey);

    return cryptoKey;
  };

  const decryptSegment = async (encryptedBytes, keyInfo) => {
    const cryptoKey = await getCryptoKey(keyInfo.uri);

    const decrypted = await crypto.subtle.decrypt(
      {
        name: "AES-CBC",
        iv: keyInfo.iv,
      },
      cryptoKey,
      encryptedBytes
    );

    return new Uint8Array(decrypted);
  };

  const saveBlob = (bytes, filename, type) => {
    const blob = new Blob([bytes], { type });
    const objectUrl = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();

    setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
  };

  const candidates = findM3U8Candidates();

  if (!candidates.length) {
    console.log("m3u8 후보를 찾지 못했습니다. 영상을 재생한 뒤 다시 실행하세요.");
    return;
  }

  console.table(candidates.map((url, index) => ({ index, url })));

  const initialCandidate =
    candidates.find((url) => /playlist\.m3u8(?:[?#]|$)/i.test(url)) ||
    candidates.find((url) => /[?&]st=audio(?:&|$)/i.test(url)) ||
    candidates[0];
  const firstAllowed = normalizeUrl(initialCandidate);

  console.log("선택된 m3u8:", firstAllowed);

  const initialText = await fetchText(firstAllowed);
  const selectedPlaylists = await choosePlaylists(firstAllowed, initialText);

  for (const selectedPlaylist of selectedPlaylists) {
    const mediaPlaylistUrl = selectedPlaylist.url;

    const mediaText =
      mediaPlaylistUrl === firstAllowed
        ? initialText
        : await fetchText(mediaPlaylistUrl);

    const media = parseM3U8(mediaText, mediaPlaylistUrl);

    if (media.isMaster) {
      throw new Error("variant를 선택했는데도 master playlist입니다. 중첩 구조를 확인하세요.");
    }

    const segmentEntries = media.segments;

    if (!segmentEntries.length) {
      throw new Error("media segment URI를 찾지 못했습니다.");
    }

    const encryptedCount = segmentEntries.filter((seg) => seg.key).length;
    const isFragmentedMp4 = Boolean(media.map);
    const outputExtension =
      selectedPlaylist.type === "audio" && isFragmentedMp4
        ? ".m4a"
        : isFragmentedMp4
          ? ".mp4"
          : ".ts";
    const outputMime =
      selectedPlaylist.type === "audio" && isFragmentedMp4
        ? "audio/mp4"
        : isFragmentedMp4
          ? "video/mp4"
          : "video/mp2t";
    const outputSuffix = mode === Mode.All ? `.${selectedPlaylist.type}` : "";
    const outputFilename = `${OUTPUT_BASENAME}${outputSuffix}${outputExtension}`;

    console.log(
      `${selectedPlaylist.type} ${isFragmentedMp4 ? "fMP4" : "MPEG-TS"} segment ${segmentEntries.length}개 다운로드 시작, 암호화 segment ${encryptedCount}개`
    );

    const chunks = [];

    if (media.map) {
      console.log("fMP4 init segment 다운로드:", media.map.uri);
      chunks.push(await fetchBytes(media.map.uri));
    }

    for (let i = 0; i < segmentEntries.length; i++) {
      const segment = segmentEntries[i];

      console.log(
        `[${i + 1}/${segmentEntries.length}]`,
        segment.key ? "AES-128 복호화" : "비암호화",
        segment.url
      );

      const bytes = await fetchBytes(segment.url);
      const output = segment.key ? await decryptSegment(bytes, segment.key) : bytes;

      chunks.push(output);
    }

    console.log(`${isFragmentedMp4 ? "fMP4" : "TS"} 세그먼트 병합 중...`);
    const merged = concatUint8Arrays(chunks);

    console.log("저장 시작:", outputFilename, `${merged.byteLength} bytes`);
    saveBlob(merged, outputFilename, outputMime);
  }

  console.log("완료");
})();
