'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { createDownloadQueue } = require('../desktop/services/download-queue.cjs');
const { resourceKey } = require('../desktop/services/library.cjs');

const lesson = { id: 'lesson', title: '课件', format: 'pdf' };
const course = { id: 'course', title: '课程', group: '', lessons: [lesson] };
const key = resourceKey(course.id, lesson.id);

test('queues only valid, distinct lessons from the requested scan and runs them in order', { timeout: 3000 }, async () => {
  const historical = { ...course, id: 'archive' };
  const historyKey = resourceKey(historical.id, lesson.id);
  const data = { courses: [course], history: [{ time: 1, added: [historical] }], jobs: [] };
  const firstExport = Promise.withResolvers();
  const finished = Promise.withResolvers();
  const calls = [];
  const saved = [];
  const queue = createDownloadQueue({
    data,
    save: () => saved.push(data.jobs.map((job) => job.status)),
    async runExport(job) {
      calls.push(job.courseId);
      if (job.courseId === course.id) await firstExport.promise;
      return { missing: 0, pages: 1 };
    },
    onChange() {
      if (data.jobs.length === 2 && data.jobs.every((job) => job.status === 'complete')) finished.resolve();
    }
  });

  assert.throws(() => queue.enqueue([null]), /课件选择无效/);
  assert.equal(queue.enqueue([historyKey]), 0);
  assert.equal(queue.enqueue([key, key]), 1);
  assert.equal(queue.enqueue([key]), 0);
  assert.equal(queue.enqueue([historyKey, key], 1), 1);
  assert.deepEqual(calls, [course.id]);
  firstExport.resolve();
  await finished.promise;
  assert.deepEqual(calls, [course.id, historical.id]);
  assert.deepEqual(saved.at(-1), ['complete', 'complete']);
});

test('reports expired login and retries the same job after a failure', { timeout: 3000 }, async () => {
  const data = { courses: [course], history: [], jobs: [] };
  const failed = Promise.withResolvers();
  const finished = Promise.withResolvers();
  let expired = 0;
  const queue = createDownloadQueue({
    data,
    save() {},
    async runExport() {
      if (!expired) throw Object.assign(new Error('请登录'), { code: 'LOGIN_REQUIRED' });
      return { missing: 2, pages: 3 };
    },
    onChange() {
      const [job] = data.jobs;
      if (job.status === 'failed') failed.resolve(job);
      if (job.status === 'partial') finished.resolve(job);
    },
    onLoginRequired: () => { expired++; }
  });

  assert.equal(queue.enqueue([key]), 1);
  const job = await failed.promise;
  assert.equal(expired, 1);
  assert.equal(job.detail, '请登录');
  queue.retry(job.id);
  assert.equal(await finished.promise, job);
  assert.equal(data.jobs.length, 1);
  assert.equal(job.progress, 100);
  assert.equal(job.detail, '已导出 3 页，缺少 2 页');
});

test('pauses the current transfer and resumes the same export at its existing progress', { timeout: 3000 }, async () => {
  const data = { courses: [course], history: [], jobs: [] };
  const started = Promise.withResolvers();
  const finished = Promise.withResolvers();
  let exports = 0;
  const attempts = [];
  const queue = createDownloadQueue({
    data,
    save() {},
    async runExport(_job, update, control) {
      exports++;
      update('已读取 1 页', 40);
      await control.request((signal) => {
        attempts.push(signal);
        if (attempts.length > 1) return;
        started.resolve();
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      });
      return { missing: 0, pages: 2 };
    },
    onChange() {
      if (data.jobs[0]?.status === 'complete') finished.resolve();
    }
  });

  queue.enqueue([key]);
  await started.promise;
  const [job] = data.jobs;
  queue.pause(job.id);
  await nextTurn();
  assert.equal(job.status, 'paused');
  assert.equal(job.progress, 40);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].aborted, true);
  assert.equal(queue.enqueue([key]), 0);

  queue.resume(job.id);
  await finished.promise;
  assert.equal(exports, 1);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[1].aborted, false);
  assert.equal(job.progress, 100);
});

test('cancels a paused export and advances the queue after the export has stopped', { timeout: 3000 }, async () => {
  const secondLesson = { ...lesson, id: 'next' };
  const data = { courses: [{ ...course, lessons: [lesson, secondLesson] }], history: [], jobs: [] };
  const paused = Promise.withResolvers();
  const finished = Promise.withResolvers();
  const events = [];
  const queue = createDownloadQueue({
    data,
    save() {},
    async runExport(job, _update, control) {
      if (job.lesson.id === lesson.id) {
        queue.pause(job.id);
        paused.resolve();
        try { await control.checkpoint(); }
        finally { events.push('current stopped'); }
      }
      events.push('next started');
      return { missing: 0, pages: 1 };
    },
    onChange() {
      if (data.jobs[1]?.status === 'complete') finished.resolve();
    }
  });

  queue.enqueue([key, resourceKey(course.id, secondLesson.id)]);
  await paused.promise;
  const [current, next] = data.jobs;
  queue.cancel(next.id);
  assert.equal(next.status, 'queued');
  assert.deepEqual(events, []);

  queue.cancel(current.id);
  queue.resume(current.id);
  await finished.promise;
  assert.equal(current.status, 'cancelled');
  assert.equal(current.destination, undefined);
  assert.deepEqual(events, ['current stopped', 'next started']);
});
