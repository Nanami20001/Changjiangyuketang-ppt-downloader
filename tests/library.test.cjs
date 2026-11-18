'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { openLibrary, scanResult, indexLessons, resourceKey } = require('../desktop/services/library.cjs');

const course = (id, titles) => ({
  id, title: `课程 ${id}`, group: '', teacher: '',
  lessons: titles.map((title, index) => ({ id: String(index + 1), title, format: 'pdf' }))
});

test('incremental scan keeps unscanned courses and distinguishes classrooms with the same lesson ID', () => {
  const prior = [course('one', ['原有课件']), course('two', ['读取失败前的课件'])];
  const next = scanResult(prior, [course('one', ['原课件改名', '新增课件']), course('three', ['同编号的新课件'])]);
  assert.deepEqual(next.added.map((entry) => [entry.id, entry.lessons.map((lesson) => lesson.title)]), [
    ['one', ['新增课件']], ['three', ['同编号的新课件']]
  ]);
  const lessons = indexLessons(next.courses);
  assert.equal(lessons.get(resourceKey('one', '1')).lesson.title, '原课件改名');
  assert.equal(lessons.get(resourceKey('two', '1')).lesson.title, '读取失败前的课件');
});

test('migrates previous desktop settings and history, retaining the source file', (context) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'rain-library-'));
  const legacyFile = path.join(folder, 'downloader.json');
  const newFile = path.join(folder, 'course-library.json');
  context.after(() => {
    for (const file of [legacyFile, newFile, `${newFile}.tmp`]) fs.rmSync(file, { force: true });
    fs.rmdirSync(folder);
  });
  const entry = { courseName: '旧课程', classroomId: 7, className: '一班' };
  const resource = { resourceId: 3, name: '旧课件', type: 'img' };
  fs.writeFileSync(legacyFile, JSON.stringify({
    directory: folder,
    rcppt_settings: JSON.stringify({ categorize: true }),
    rcppt_cache_v1: JSON.stringify({ courses: [{ ...entry, resources: [resource] }] }),
    rcppt_history_v1: JSON.stringify({ items: [{ ts: 1700000000000, files: [{ ...entry, resource }] }] })
  }));
  const { data, save, update } = openLibrary(folder);
  assert.equal(data.directory, folder);
  assert.equal(data.categorize, true);
  assert.equal(data.courses[0].lessons[0].title, '旧课件');
  assert.equal(data.history[0].added[0].lessons[0].format, 'pdf');
  update({ categorize: false });
  data.jobs.push({ status: 'working' });
  save();
  const reopened = openLibrary(folder).data;
  assert.equal(reopened.jobs[0].status, 'failed');
  assert.equal(reopened.categorize, false);
  assert.ok(fs.existsSync(legacyFile));
});

test('keeps in-memory preferences unchanged when saving fails', (context) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'rain-library-'));
  context.after(() => fs.rmdirSync(folder));
  const { data, update } = openLibrary(path.join(folder, 'missing'));
  assert.throws(() => update({ directory: folder, categorize: true }), { code: 'ENOENT' });
  assert.equal(data.categorize, false);
  assert.equal(data.directory, undefined);
});
