import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { ArtifactExecutionInput, ArtifactExecutionResult, ArtifactExecutor } from "@office-agent/core";
import { summarizeText } from "@office-agent/core";
import PptxGenJS from "pptxgenjs";

export interface MarkdownExecutorOptions {
  artifactRootDir: string;
}

const execFileAsync = promisify(execFile);

export class DocMarkdownExecutor implements ArtifactExecutor {
  readonly kind = "doc_markdown" as const;

  constructor(private readonly options: MarkdownExecutorOptions) {}

  async execute(input: ArtifactExecutionInput): Promise<ArtifactExecutionResult> {
    const taskDir = await ensureTaskDir(this.options.artifactRootDir, input.taskId);
    const docxPath = join(taskDir, "document.docx");
    const documentPath = join(taskDir, "document.md");
    const outlinePath = join(taskDir, "document_outline.md");

    await Promise.all([
      writeDocxDocument(docxPath, input),
      writeFile(documentPath, renderDocument(input), "utf8"),
      writeFile(outlinePath, renderOutline(input), "utf8"),
    ]);

    return {
      executor: this.kind,
      artifacts: [
        { label: "document_docx", path: docxPath, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
        { label: "document", path: documentPath },
        { label: "outline", path: outlinePath },
      ],
      summary: summarizeText(`已生成 Word 文档 ${docxPath}，并附带 Markdown 文稿 ${documentPath} 与提纲 ${outlinePath}`, 180),
    };
  }
}

export class PptMarkdownExecutor implements ArtifactExecutor {
  readonly kind = "ppt_markdown" as const;

  constructor(private readonly options: MarkdownExecutorOptions) {}

  async execute(input: ArtifactExecutionInput): Promise<ArtifactExecutionResult> {
    const taskDir = await ensureTaskDir(this.options.artifactRootDir, input.taskId);
    const slidesPath = join(taskDir, "slides.md");
    const notesPath = join(taskDir, "speaker_notes.md");
    const pptxPath = join(taskDir, "presentation.pptx");

    await Promise.all([
      writeFile(slidesPath, renderSlides(input), "utf8"),
      writeFile(notesPath, renderSpeakerNotes(input), "utf8"),
      generatePptxFile(pptxPath, input),
    ]);

    return {
      executor: this.kind,
      artifacts: [
        { label: "presentation_pptx", path: pptxPath, mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
        { label: "slides", path: slidesPath },
        { label: "speaker_notes", path: notesPath },
      ],
      summary: summarizeText(`已生成 PPT 文件 ${pptxPath}，并附带 Markdown 文稿`, 180),
    };
  }
}

export class ImagePromptExecutor implements ArtifactExecutor {
  readonly kind = "image_prompt" as const;

  constructor(private readonly options: MarkdownExecutorOptions) {}

  async execute(input: ArtifactExecutionInput): Promise<ArtifactExecutionResult> {
    const taskDir = await ensureTaskDir(this.options.artifactRootDir, input.taskId);
    const promptPackPath = join(taskDir, "image_prompt_pack.md");
    const promptJsonPath = join(taskDir, "image_prompt_pack.json");
    const imageManifestPath = join(taskDir, "image_manifest.json");

    const promptPack = renderImagePromptPack(input);
    const imageResults = extractImageResults(input.providerMeta);
    const promptJson = JSON.stringify(
      {
        taskId: input.taskId,
        intent: input.intent,
        userInput: input.userInput,
        finalOutput: input.finalOutput,
        draftOutput: input.draftOutput,
        reviewOutput: input.reviewOutput ?? null,
        providerName: input.providerName ?? null,
        providerMeta: input.providerMeta ?? null,
        imageResults,
      },
      null,
      2,
    );

    const artifacts: ArtifactExecutionResult["artifacts"] = [
      { label: "image_prompt_pack", path: promptPackPath },
      { label: "image_prompt_json", path: promptJsonPath },
    ];

    await Promise.all([
      writeFile(promptPackPath, promptPack, "utf8"),
      writeFile(promptJsonPath, promptJson, "utf8"),
    ]);

    if (imageResults.length > 0) {
      await writeFile(imageManifestPath, JSON.stringify(imageResults, null, 2), "utf8");
      artifacts.push({ label: "image_manifest", path: imageManifestPath });
    }

    let downloadedCount = 0;
    for (const [index, image] of imageResults.entries()) {
      const local = await downloadImageArtifact(taskDir, index + 1, image);
      if (!local) {
        continue;
      }

      artifacts.push({
        label: `generated_image_${index + 1}`,
        path: local.path,
        mimeType: local.mimeType,
        sourceUrl: image.url,
      });
      downloadedCount += 1;
    }

    return {
      executor: this.kind,
      artifacts,
      summary: summarizeText(
        downloadedCount > 0
          ? `已生成并保存 ${downloadedCount} 张图片，产物位于 ${taskDir}`
          : `已生成图片任务提示词包，但当前未收到可下载图片，产物位于 ${taskDir}`,
        180,
      ),
    };
  }
}

export class VideoPlanExecutor implements ArtifactExecutor {
  readonly kind = "video_plan" as const;

  constructor(private readonly options: MarkdownExecutorOptions) {}

  async execute(input: ArtifactExecutionInput): Promise<ArtifactExecutionResult> {
    const taskDir = await ensureTaskDir(this.options.artifactRootDir, input.taskId);
    const storyboardPath = join(taskDir, "video_storyboard.md");
    const scriptPath = join(taskDir, "video_script.md");
    const assetListPath = join(taskDir, "video_assets_checklist.md");

    await Promise.all([
      writeFile(storyboardPath, renderVideoStoryboard(input), "utf8"),
      writeFile(scriptPath, renderVideoScript(input), "utf8"),
      writeFile(assetListPath, renderVideoAssetsChecklist(input), "utf8"),
    ]);

    return {
      executor: this.kind,
      artifacts: [
        { label: "video_storyboard", path: storyboardPath },
        { label: "video_script", path: scriptPath },
        { label: "video_assets_checklist", path: assetListPath },
      ],
      summary: summarizeText(`已生成视频脚本、分镜和素材清单，产物位于 ${taskDir}`, 180),
    };
  }
}

async function ensureTaskDir(rootDir: string, taskId: string): Promise<string> {
  const taskDir = resolve(rootDir, taskId);
  await mkdir(taskDir, { recursive: true });
  return taskDir;
}

async function writeDocxDocument(outputPath: string, input: ArtifactExecutionInput): Promise<void> {
  const stagingDir = await mkdtemp(join(tmpdir(), "office-agent-docx-"));
  try {
    await Promise.all([
      mkdir(join(stagingDir, "_rels"), { recursive: true }),
      mkdir(join(stagingDir, "docProps"), { recursive: true }),
      mkdir(join(stagingDir, "word", "_rels"), { recursive: true }),
    ]);

    const now = new Date().toISOString();
    const plainText = buildDocxBodyText(input);

    await Promise.all([
      writeFile(join(stagingDir, "[Content_Types].xml"), buildContentTypesXml(), "utf8"),
      writeFile(join(stagingDir, "_rels", ".rels"), buildRootRelsXml(), "utf8"),
      writeFile(join(stagingDir, "docProps", "core.xml"), buildCorePropsXml(now), "utf8"),
      writeFile(join(stagingDir, "docProps", "app.xml"), buildAppPropsXml(), "utf8"),
      writeFile(join(stagingDir, "word", "document.xml"), buildDocumentXml(plainText), "utf8"),
      writeFile(join(stagingDir, "word", "styles.xml"), buildStylesXml(), "utf8"),
      writeFile(join(stagingDir, "word", "_rels", "document.xml.rels"), buildDocumentRelsXml(), "utf8"),
    ]);

    await execFileAsync("zip", ["-qr", outputPath, "."], { cwd: stagingDir });
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

function renderDocument(input: ArtifactExecutionInput): string {
  return [
    "# Document Draft",
    "",
    "## Original Request",
    input.userInput,
    "",
    "## Final Draft",
    input.finalOutput,
    "",
    "## Local Context",
    input.localContextSummary ?? "No local context.",
    "",
  ].join("\n");
}

function buildDocxBodyText(input: ArtifactExecutionInput): string {
  return [
    "文档初稿",
    "",
    input.finalOutput,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildContentTypesXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>',
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>',
    "</Types>",
  ].join("");
}

function buildRootRelsXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>',
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>',
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>',
    "</Relationships>",
  ].join("");
}

function buildDocumentRelsXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
    "</Relationships>",
  ].join("");
}

function buildCorePropsXml(timestamp: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    "<dc:title>Office Agent Document</dc:title>",
    "<dc:creator>iai claw</dc:creator>",
    `<dcterms:created xsi:type="dcterms:W3CDTF">${timestamp}</dcterms:created>`,
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${timestamp}</dcterms:modified>`,
    "</cp:coreProperties>",
  ].join("");
}

function buildAppPropsXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">',
    "<Application>iai claw</Application>",
    "</Properties>",
  ].join("");
}

function buildStylesXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>',
    "</w:styles>",
  ].join("");
}

function buildDocumentXml(content: string): string {
  const paragraphs = content
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .map((line) => buildWordParagraph(line))
    .join("");

  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:document xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:w10="urn:schemas-microsoft-com:office:word" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" mc:Ignorable="w14 wp14">',
    "<w:body>",
    paragraphs,
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>',
    "</w:body>",
    "</w:document>",
  ].join("");
}

function buildWordParagraph(line: string): string {
  if (!line) {
    return "<w:p/>";
  }
  return `<w:p><w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:p>`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function renderOutline(input: ArtifactExecutionInput): string {
  return [
    "# Document Outline",
    "",
    "## Draft",
    input.draftOutput,
    "",
    "## Review Notes",
    input.reviewOutput ?? "No review notes.",
    "",
  ].join("\n");
}

function renderSlides(input: ArtifactExecutionInput): string {
  return [
    "# Slides Draft",
    "",
    "## Deck Goal",
    input.userInput,
    "",
    "## Slide Content",
    input.finalOutput,
    "",
  ].join("\n");
}

function renderSpeakerNotes(input: ArtifactExecutionInput): string {
  return [
    "# Speaker Notes",
    "",
    "## Draft Notes",
    input.draftOutput,
    "",
    "## Review Notes",
    input.reviewOutput ?? "No review notes.",
    "",
    "## Local Context",
    input.localContextSummary ?? "No local context.",
    "",
  ].join("\n");
}

async function generatePptxFile(outputPath: string, input: ArtifactExecutionInput): Promise<void> {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.title = input.userInput.slice(0, 100);

  const slides = parseMarkdownSlides(input.finalOutput);

  if (slides.length === 0) {
    const titleSlide = pptx.addSlide();
    titleSlide.addText(input.userInput.slice(0, 120), {
      x: 0.5, y: 1.5, w: 12, h: 2,
      fontSize: 28, bold: true, align: "center", color: "333333",
    });
    titleSlide.addText(summarizeText(input.finalOutput, 400), {
      x: 0.5, y: 4, w: 12, h: 3,
      fontSize: 16, color: "666666", align: "left", valign: "top",
    });
  } else {
    for (const slide of slides) {
      const s = pptx.addSlide();
      if (slide.title) {
        s.addText(slide.title, {
          x: 0.5, y: 0.3, w: 12, h: 1,
          fontSize: 24, bold: true, color: "333333",
        });
      }
      if (slide.bullets.length > 0) {
        s.addText(
          slide.bullets.map((b) => ({ text: b, options: { bullet: true, fontSize: 16 } })),
          { x: 0.5, y: 1.5, w: 12, h: 5.5, color: "444444", valign: "top" },
        );
      } else if (slide.body) {
        s.addText(slide.body, {
          x: 0.5, y: 1.5, w: 12, h: 5.5,
          fontSize: 16, color: "444444", valign: "top",
        });
      }
    }
  }

  await pptx.writeFile({ fileName: outputPath });
}

interface ParsedSlide {
  title: string;
  body: string;
  bullets: string[];
}

function parseMarkdownSlides(markdown: string): ParsedSlide[] {
  const slides: ParsedSlide[] = [];
  const sections = markdown.split(/^#{1,2}\s+/m).filter((s) => s.trim());

  for (const section of sections) {
    const lines = section.split("\n");
    const title = lines[0]?.trim() ?? "";
    const bodyLines = lines.slice(1).filter((l) => l.trim());
    const bullets: string[] = [];
    const plainLines: string[] = [];

    for (const line of bodyLines) {
      const bulletMatch = line.match(/^\s*[-*+]\s+(.+)/);
      if (bulletMatch) {
        bullets.push(bulletMatch[1].trim());
      } else if (/^\s*\d+\.\s+/.test(line)) {
        bullets.push(line.replace(/^\s*\d+\.\s+/, "").trim());
      } else {
        plainLines.push(line.trim());
      }
    }

    slides.push({
      title,
      body: plainLines.join("\n"),
      bullets,
    });
  }

  return slides;
}

function renderImagePromptPack(input: ArtifactExecutionInput): string {
  return [
    "# Image Prompt Pack",
    "",
    "## User Goal",
    input.userInput,
    "",
    "## Final Prompt",
    input.finalOutput,
    "",
    "## Draft Notes",
    input.draftOutput,
    "",
    "## Review Notes",
    input.reviewOutput ?? "No review notes.",
    "",
    "## Suggested Delivery",
    "- 主图 1 张",
    "- 备选风格 2 版",
    "- 可直接复制到豆包图像模式",
    "",
  ].join("\n");
}

function renderVideoStoryboard(input: ArtifactExecutionInput): string {
  return [
    "# Video Storyboard",
    "",
    "## User Goal",
    input.userInput,
    "",
    "## Storyboard",
    input.finalOutput,
    "",
  ].join("\n");
}

function renderVideoScript(input: ArtifactExecutionInput): string {
  return [
    "# Video Script",
    "",
    "## Final Script",
    input.finalOutput,
    "",
    "## Draft Notes",
    input.draftOutput,
    "",
    "## Review Notes",
    input.reviewOutput ?? "No review notes.",
    "",
  ].join("\n");
}

function renderVideoAssetsChecklist(input: ArtifactExecutionInput): string {
  return [
    "# Video Assets Checklist",
    "",
    "## Required Assets",
    "- 封面图",
    "- 口播文案",
    "- 分镜镜头表",
    "- 背景音乐建议",
    "- 字幕关键词",
    "",
    "## Context Notes",
    input.localContextSummary ?? "No local context.",
    "",
  ].join("\n");
}

interface ImageResultRecord {
  url: string;
  width?: number;
  height?: number;
  mimeType?: string;
}

function extractImageResults(providerMeta: Record<string, unknown> | undefined): ImageResultRecord[] {
  if (!providerMeta) {
    return [];
  }

  const rawItems = providerMeta.imageResults;
  if (!Array.isArray(rawItems)) {
    return [];
  }

  return rawItems.flatMap((item) => {
    if (typeof item === "string" && item.startsWith("http")) {
      return [{ url: item }];
    }

    if (!item || typeof item !== "object") {
      return [];
    }

    const url = typeof (item as Record<string, unknown>).url === "string" ? ((item as Record<string, unknown>).url as string) : "";
    if (!url.startsWith("http")) {
      return [];
    }

    const width =
      typeof (item as Record<string, unknown>).width === "number" ? ((item as Record<string, unknown>).width as number) : undefined;
    const height =
      typeof (item as Record<string, unknown>).height === "number" ? ((item as Record<string, unknown>).height as number) : undefined;
    const mimeType =
      typeof (item as Record<string, unknown>).mimeType === "string"
        ? ((item as Record<string, unknown>).mimeType as string)
        : undefined;

    return [{ url, width, height, mimeType }];
  });
}

async function downloadImageArtifact(
  taskDir: string,
  index: number,
  image: ImageResultRecord,
): Promise<{ path: string; mimeType?: string } | null> {
  const response = await fetch(image.url).catch(() => null);
  if (!response?.ok) {
    return null;
  }

  const mimeType = response.headers.get("content-type") ?? image.mimeType ?? undefined;
  const extension = inferImageExtension(image.url, mimeType);
  const filePath = join(taskDir, `generated_${String(index).padStart(2, "0")}${extension}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(filePath, buffer);
  return {
    path: filePath,
    mimeType: mimeType ?? undefined,
  };
}

function inferImageExtension(url: string, mimeType: string | undefined): string {
  if (mimeType) {
    if (mimeType.includes("png")) {
      return ".png";
    }
    if (mimeType.includes("webp")) {
      return ".webp";
    }
    if (mimeType.includes("gif")) {
      return ".gif";
    }
    if (mimeType.includes("bmp")) {
      return ".bmp";
    }
    if (mimeType.includes("tiff")) {
      return ".tiff";
    }
    if (mimeType.includes("jpeg") || mimeType.includes("jpg")) {
      return ".jpg";
    }
  }

  const pathname = safeUrlPathname(url);
  const explicitExt = extname(pathname);
  if (explicitExt) {
    return explicitExt;
  }

  return ".jpg";
}

function safeUrlPathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}
