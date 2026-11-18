'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { nativeImage } = require('electron');
const { PDFDocument } = require('pdf-lib');
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PPT_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0]);

function safeName(value) {
  const name = String(value).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim().slice(0, 104).replace(/[. ]+$/, '') || '课件';
  return /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name) ? `_${name}` : name;
}

async function writeDownload(bytes, job, preferences, control) {
  await control.checkpoint();
  await fs.mkdir(preferences.directory, { recursive: true });
  const root = await fs.realpath(preferences.directory);
  let folder = root;
  if (preferences.categorize) {
    const name = job.group ? `${job.courseTitle}（${job.group}）` : job.courseTitle;
    folder = path.join(root, safeName(name));
    await fs.mkdir(folder, { recursive: true });
    if (path.dirname(await fs.realpath(folder)) !== root) throw new Error('课程文件夹指向保存位置之外');
  }
  const stem = safeName(job.lesson.title.replace(/\.(pdf|pptx?)$/i, ''));
  const temporaryFolder = await fs.mkdtemp(path.join(folder, '.rain-export-'));
  const temporaryFile = path.join(temporaryFolder, 'document');
  try {
    await control.checkpoint();
    await fs.writeFile(temporaryFile, bytes, { signal: control.signal });
    // Once publishing starts, the final file can become visible at any time.
    await control.beginSave();
    for (let serial = 1; ; serial++) {
      const suffix = serial > 1 ? ` (${serial})` : '';
      const destination = path.join(folder, `${stem}${suffix}.${job.lesson.format}`);
      try {
        await fs.link(temporaryFile, destination).catch((error) => {
          if (!['EPERM', 'ENOTSUP', 'EACCES'].includes(error.code)) throw error;
          return fs.copyFile(temporaryFile, destination, constants.COPYFILE_EXCL);
        });
        return destination;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
  } finally {
    await fs.unlink(temporaryFile).catch(() => {});
    await fs.rmdir(temporaryFolder).catch(() => {});
  }
}

async function buildPdf(api, covers, update, control) {
  const document = await PDFDocument.create();
  const images = new Array(covers.length);
  let next = 0;
  let finished = 0;

  async function fetchPage() {
    while (!control.signal.aborted && next < covers.length) {
      const index = next++;
      try {
        const download = (signal) => api.attachment(covers[index], signal);
        const bytes = await control.request(download).catch(() => control.request(download));
        if (bytes[0] === 0xff && bytes[1] === 0xd8) {
          images[index] = await document.embedJpg(bytes);
        } else if (bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
          images[index] = await document.embedPng(bytes);
        } else {
          const image = nativeImage.createFromBuffer(bytes);
          if (!image.isEmpty()) images[index] = await document.embedPng(image.toPNG());
        }
      } catch (error) {
        if (control.signal.aborted) return;
        console.warn('课件图片读取失败', index + 1, error.name);
      }
      finished++;
      update(`正在读取页面 · ${finished} / ${covers.length}`, Math.round(8 + 79 * finished / covers.length));
    }
  }

  await Promise.all(Array.from({ length: Math.min(4, covers.length) }, () => fetchPage()));
  await control.checkpoint();
  for (const image of images) {
    if (!image) continue;
    const scale = Math.min(1, 1440 / Math.max(image.width, image.height));
    const [width, height] = [image.width * scale, image.height * scale];
    document.addPage([width, height]).drawImage(image, { x: 0, y: 0, width, height });
  }
  const count = document.getPageCount();
  if (!count) throw new Error('课件页面读取失败，请稍后重试。');
  update('正在生成 PDF', 92);
  return { bytes: await document.save(), missing: covers.length - count, pages: count };
}

async function exportLesson(api, job, preferences, update, control) {
  const { lesson } = job;
  let output;
  if (lesson.url) {
    update('正在下载文件', 15);
    const bytes = await control.request((signal) => api.attachment(lesson.url, signal));
    const signature = bytes.subarray(0, 8);
    const valid = {
      pdf: signature.toString().startsWith('%PDF-'),
      pptx: signature[0] === 0x50 && signature[1] === 0x4b,
      ppt: signature.subarray(0, PPT_SIGNATURE.length).equals(PPT_SIGNATURE)
    };
    if (!valid[lesson.format]) throw new Error('服务器未返回可用的课件文件。');
    output = { bytes, missing: 0 };
  } else {
    update('正在获取课件页面', 6);
    const covers = await control.request((signal) => api.slides(job.courseId, lesson.id, signal));
    if (!covers.length) throw new Error('这堂课没有可导出的页面。');
    output = await buildPdf(api, covers, update, control);
  }

  update('正在保存到电脑', 97);
  const destination = await writeDownload(output.bytes, job, preferences, control);
  return { destination, missing: output.missing, pages: output.pages };
}

module.exports = { exportLesson };
