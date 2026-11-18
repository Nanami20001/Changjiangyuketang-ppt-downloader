'use strict';

const fs = require('node:fs');
const path = require('node:path');
const list = (value) => Array.isArray(value) ? value : [];
const isActiveJob = (job) => ['queued', 'working', 'paused', 'saving'].includes(job.status);

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') console.error('读取课件库失败', error);
    return null;
  }
}

function resourceKey(courseId, lessonId) {
  return JSON.stringify([courseId, lessonId]);
}

function indexLessons(courses) {
  return new Map(courses.flatMap((course) => course.lessons.map((lesson) => [
    resourceKey(course.id, lesson.id), { lesson, courseId: course.id, courseTitle: course.title, group: course.group }
  ])));
}

function parseLegacy(value) {
  try { return JSON.parse(value) ?? {}; }
  catch { return {}; }
}

function migratedLesson(resource) {
  if (!resource?.resourceId) return null;
  const direct = ['pdf', 'ppt', 'pptx'].includes(resource.type) && typeof resource.url === 'string' && resource.url;
  return {
    id: String(resource.resourceId), title: resource.name || '未命名课件',
    format: direct ? resource.type : 'pdf', ...(direct ? { url: resource.url } : {})
  };
}

function migrate(legacy) {
  const oldCourses = parseLegacy(legacy.rcppt_cache_v1).courses ?? [];
  const courses = list(oldCourses).filter((course) => course?.classroomId).map((course) => ({
    id: String(course.classroomId), title: course.courseName || '未命名课程',
    group: course.className || '', teacher: '', lessons: list(course.resources).map(migratedLesson).filter(Boolean)
  }));
  const oldHistory = parseLegacy(legacy.rcppt_history_v1).items ?? [];
  const history = list(oldHistory).filter((entry) => Number.isFinite(entry?.ts)).slice(0, 100).map((entry) => {
    const added = new Map();
    for (const item of list(entry.files)) {
      const lesson = migratedLesson(item?.resource);
      if (!item?.classroomId || !lesson) continue;
      const id = String(item.classroomId);
      if (!added.has(id)) added.set(id, { id, title: item.courseName || '未命名课程', group: item.className || '', teacher: '', lessons: [] });
      added.get(id).lessons.push(lesson);
    }
    return { time: entry.ts, courseCount: added.size, added: [...added.values()], errors: [] };
  });
  return {
    courses, history, jobs: [], directory: legacy.directory,
    categorize: Boolean(parseLegacy(legacy.rcppt_settings).categorize)
  };
}

function openLibrary(folder) {
  const location = path.join(folder, 'course-library.json');
  const stored = readJson(location);
  const data = stored?.version === 1 ? stored : migrate(readJson(path.join(folder, 'downloader.json')) ?? {});
  for (const job of data.jobs) {
    if (isActiveJob(job)) {
      job.status = 'failed';
      job.detail = '软件在导出完成前关闭。';
    }
  }

  function save(changes) {
    const temporary = `${location}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ ...data, ...changes, version: 1 }), 'utf8');
    fs.renameSync(temporary, location);
    Object.assign(data, changes);
  }

  return { data, save, update: save };
}

function scanResult(previous, scanned) {
  const added = [];
  const updates = new Map(previous.map((course) => [course.id, course]));
  for (const course of scanned) {
    const known = new Set(updates.get(course.id)?.lessons.map((lesson) => lesson.id));
    const fresh = course.lessons.filter((lesson) => !known.has(lesson.id));
    if (fresh.length) added.push({ ...course, lessons: fresh });
    updates.set(course.id, course);
  }
  return { courses: [...updates.values()], added };
}

module.exports = { openLibrary, scanResult, resourceKey, indexLessons, isActiveJob };
